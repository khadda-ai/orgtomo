// Ticket runner. Interprets spec/stages.yaml: which stage a ticket is in, who
// works next, which gates decide, when a human must act, when to loop back
// and when to stop. The Lead agent asks `next` and follows the answer.
import fs from 'node:fs';
import path from 'node:path';
import { layout } from './paths.js';
import { loadSpec, loopMax, approvalStages, org as getOrg, isProduction, buildOrg } from './config.js';
import { runGates } from './gates.js';
import { listEvidence } from './evidence.js';
import { observe } from './learning.js';
import { validateContract } from './schema.js';
import { redactInside } from './mask.js';
import { parseRef } from './metadata.js';
import { exists, readJson, writeJson, writeText, readText, appendLine, nowIso, fail, formatFrontmatter, listFiles } from './util.js';

const TICKET_KEY = /^[A-Z][A-Z0-9_]*-[0-9]+$/;

export const stagesOf = (root) => loadSpec(root, 'stages').stages;
const stageDef = (root, id) => stagesOf(root).find((s) => s.id === id) || fail(`Unknown stage "${id}".`);
const agentOn = (cfg, name) => cfg.agents.agents[name]?.enabled !== false;

export function loadTicket(root, key) {
  const f = layout(root).ticketState(key);
  return exists(f) ? readJson(f) : fail(`No ticket ${key}. Open it with: orgtomo ticket open ${key}`, 'NO_TICKET');
}
export const listTickets = (root) => {
  const dir = layout(root).ticketsState;
  return exists(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f))) : [];
};
/** Tickets that are being worked on, with their current stage. */
export const activeStages = (root) => listTickets(root).filter((t) => t.status === 'running').map((t) => ({ key: t.key, stage: t.stage }));

function save(root, t, event) {
  if (event) t.history.push({ at: nowIso(), ...event });
  t.updated_at = nowIso();
  writeJson(layout(root).ticketState(t.key), t);
  renderStatus(root, t);
  return t;
}

function readContract(root, key, output) {
  const f = path.join(layout(root).ticketDir(key), `${output}.json`);
  if (!exists(f)) return null;
  try { return JSON.parse(readText(f)); } catch (e) { return { __invalid_json: e.message }; }
}

// ------------------------------------------------------------------ open

/** Create a ticket. The tracker content arrives with importTicket. */
export function openTicket(root, cfg, { key, lite = false }) {
  if (!TICKET_KEY.test(key || '')) fail(`"${key}" does not look like a ticket key (ABC-123).`);
  if (exists(layout(root).ticketState(key))) fail(`Ticket ${key} is already open. See: orgtomo status ${key}`);
  const t = { key, title: '', type: null, path: 'full', lite_requested: Boolean(lite), status: 'running', stage: 'open', loops: 0, stages: {}, await: null, handoff: null, created_at: nowIso(), history: [] };
  fs.mkdirSync(path.join(layout(root).ticketDir(key), 'work'), { recursive: true });
  return save(root, t, { event: 'opened' });
}

/**
 * Store the ticket as read from the tracker. The engine writes the files so
 * that real addresses and numbers are redacted before anything reaches the vault.
 */
export function importTicket(root, cfg, key, data, { actor } = {}) {
  const t = loadTicket(root, key);
  if (t.stage !== 'open') fail(`Ticket ${key} was already imported.`);
  const clean = JSON.parse(redactInside(JSON.stringify({ ...data, key }), cfg.safety));
  const errors = validateContract(clean, 'ticket');
  if (errors.length) fail(`The ticket data is not valid:\n- ${errors.join('\n- ')}`, 'BAD_CONTRACT');
  const dir = layout(root).ticketDir(key);
  writeJson(path.join(dir, '00-ticket.json'), clean);
  writeText(path.join(dir, '00-ticket.md'), `${formatFrontmatter({ type: 'ticket', ticket: key, kind: clean.type, source: clean.source.tool, fetched_at: clean.source.fetched_at })}# ${key}: ${clean.title}\n\n${clean.description}\n\n## Acceptance criteria (as written in the tracker)\n\n${clean.acceptance_criteria.map((a) => `- **${a.id}** ${a.text}`).join('\n') || '_None written. The Analyst derives them and marks them as derived._'}\n\n${clean.comments_summary ? `## Comments\n\n${clean.comments_summary}\n` : ''}`);
  t.title = clean.title;
  t.type = clean.type;
  t.stages.open = { status: 'done', attempts: 1, by: actor || null, at: nowIso() };
  t.stage = 'understand';
  return save(root, t, { event: 'imported', type: clean.type });
}

// ------------------------------------------------------------------ next

/**
 * What should happen now. The Lead follows this literally.
 * @returns {object} instruction
 */
export function next(root, cfg, key) {
  const t = loadTicket(root, key);
  const base = { ticket: key, title: t.title, status: t.status, stage: t.stage, path: t.path, loops: t.loops, loop_max: loopMax(cfg) };
  const dirRel = `vault/tickets/${key}`;
  if (t.status === 'done') return { ...base, do: [], say: 'This ticket is done.' };
  if (t.status === 'hold') return { ...base, do: [{ who: 'human', action: `/orgtomo:resume ${key}` }], say: 'On hold. Nothing runs until the human resumes it.' };
  if (t.status === 'escalated') {
    return { ...base, do: [{ who: 'human', action: `/orgtomo:resume ${key} <what to do differently>` }], say: `Stopped after ${t.loops} loop(s). Read ${dirRel}/escalation.md to the human in full. Do not continue on your own.` };
  }
  if (t.status === 'awaiting_human') {
    const a = t.await || {};
    const map = {
      approval: { action: `/orgtomo:approve ${key}  or  /orgtomo:reject ${key} <reason>`, say: `Stage "${a.stage}" passed its gates and waits for the human's approval. Summarise ${dirRel}/${stageDef(root, a.stage).output}.md for the human, then stop.` },
      question: { action: `/orgtomo:answer ${key} <question id> <answer>`, say: `The Analyst has blocking questions. Ask the human exactly these, then stop: ${(a.details || []).join(' | ')}` },
      not_reproduced: { action: `/orgtomo:answer ${key} repro <more detail or decision>`, say: 'The bug could not be reproduced. Tell the human what was tried (02-repro.md) and ask for more detail. Do not plan a fix for something that was not reproduced.' },
      deploy: { action: `/orgtomo:deployed ${a.org} ${key}`, say: a.problem ? `The parity check on ${a.org} failed: ${a.problem}. Show the human the parity report; they fix the deploy and confirm again.` : `Deploy pack for ${a.org} is ready at ${dirRel}/07-deploy-pack/${a.org}/. The human deploys with their tool and then confirms. Orgtomo does not deploy to ${a.org}.` },
    };
    const m = map[a.kind] || { action: '', say: 'Waiting for the human.' };
    return { ...base, awaiting: a.kind, do: [{ who: 'human', action: m.action }], say: m.say };
  }
  if (t.stage === 'open') {
    return { ...base, do: [{ who: 'lead', action: `Read ${key} with your tracker tools, then run: orgtomo ticket import ${key} --json '<ticket contract JSON>'`, contract: 'ticket' }], say: 'Import the ticket exactly as written. Do not add or interpret.' };
  }
  if (t.stage === 'handoff') return { ...base, ...nextHandoff(root, cfg, t) };

  const def = stageDef(root, t.stage);
  const st = t.stages[t.stage] || { status: 'pending', attempts: 0 };
  const light = t.path === 'lite' && def.lite === 'light';
  if (st.status === 'awaiting_lead') {
    return { ...base, do: [{ who: 'lead', action: `Re-check one claim of ${def.output}.json yourself (run its proof again with an orgtomo org command), then: orgtomo verify ${key} ${t.stage} --claim <C#> --evidence <new E#> --result match|mismatch` }], say: 'Gates passed. Now verify: do not trust the report, check one fact against the org or the Brain.' };
  }
  const steps = [];
  if (t.stage === 'close') {
    if (agentOn(cfg, 'coach') && cfg.features.self_learning?.enabled !== false && !t.stages.close?.retro_done) {
      steps.push({ who: 'coach', action: 'spawn', outputs: [`${dirRel}/09-retro.md`, `${dirRel}/09-retro.json`], then: `orgtomo learn propose ${key}` });
    }
    if (agentOn(cfg, 'cartographer')) steps.push({ who: 'cartographer', action: 'spawn', note: `Refresh the Org Brain for what this ticket changed: orgtomo brain sync ${cfg.pipeline.brain_base}`, optional: true });
  }
  for (const b of def.before || []) {
    if (!agentOn(cfg, b)) continue;
    if (b === 'baseline' && !validBaseline(root, key)) steps.push({ who: 'baseline', action: 'spawn', outputs: [`${dirRel}/00-baseline.md`, `${dirRel}/00-baseline.json`], then: `orgtomo baseline check ${key}` });
  }
  if (!agentOn(cfg, def.owner)) steps.push({ who: 'lead', action: `orgtomo submit ${key} ${t.stage}`, note: `${def.owner} is switched off; this stage is skipped.` });
  else {
    steps.push({
      who: def.owner, action: 'spawn', mode: light ? 'light' : 'full', attempt: (st.attempts || 0) + 1,
      inputs: inputsFor(root, key),
      outputs: [`${dirRel}/${def.output}.md`, `${dirRel}/${def.output}.json`], contract: def.contract,
      then: `orgtomo submit ${key} ${t.stage}`,
      redo: ['gates_failed', 'rejected'].includes(st.status) ? `Previous attempt failed. Give the agent ${dirRel}/verify-${t.stage}.md and have it fix exactly those points.` : undefined,
    });
  }
  return { ...base, mode: light ? 'light' : 'full', do: steps, say: `Stage "${t.stage}". Spawn the agents in this order, one at a time. Include the ticket key ${key} in every prompt.` };
}

function inputsFor(root, key) {
  const dir = layout(root).ticketDir(key);
  return listFiles(dir).filter((f) => /^(0\d-[a-z-]+\.(md|json)|updates\.md|context-pack\.md|verify-[a-z]+\.md)$/.test(f)).map((f) => `vault/tickets/${key}/${f}`);
}
const validBaseline = (root, key) => {
  const c = readContract(root, key, '00-baseline');
  return Boolean(c) && !c.__invalid_json && validateContract(c, 'baseline').length === 0;
};

// ------------------------------------------------------------------ submit

function ctxFor(root, cfg, t, def, output) {
  const dir = layout(root).ticketDir(t.key);
  return {
    root, cfg, key: t.key, ticket: t, def, output, dir,
    contract: readContract(root, t.key, output),
    evidence: listEvidence(root, t.key),
    read: (name) => { const c = readContract(root, t.key, name); return c && !c.__invalid_json ? c : null; },
  };
}

function writeGateReport(root, t, stage, results, extra = '') {
  const lines = results.map((r) => `### ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  (${r.type})\n\n${r.why}\n${r.details.map((d) => `\n- ${d}`).join('')}\n`);
  writeText(path.join(layout(root).ticketDir(t.key), `verify-${stage}.md`), `${formatFrontmatter({ type: 'gate-report', ticket: t.key, stage, passed: results.every((r) => r.ok), at: nowIso(), attempt: t.stages[stage]?.attempts || 1 })}# Gate report: ${stage}\n\n${extra}${lines.join('\n')}`);
}

/**
 * An agent says its stage output is complete. The engine runs the gates.
 * @returns {{passed: boolean, failed?: object[], next: string}}
 */
export function submit(root, cfg, key, stageId, { actor } = {}) {
  const t = loadTicket(root, key);
  if (t.status !== 'running') fail(`Ticket ${key} is ${t.status}. Nothing can be submitted now.`, 'NOT_RUNNING');
  if (t.stage !== stageId) fail(`Ticket ${key} is in stage "${t.stage}", not "${stageId}".`, 'WRONG_STAGE');
  if (stageId === 'handoff') return submitRetest(root, cfg, t, { actor });
  const def = stageDef(root, stageId);
  const off = !agentOn(cfg, def.owner);
  if (!off && actor && actor !== def.owner && actor !== 'human') fail(`Stage "${stageId}" is submitted by the ${def.owner}, not by "${actor}".`, 'WRONG_ACTOR');
  const st = (t.stages[stageId] ||= { status: 'pending', attempts: 0 });
  if (['awaiting_lead', 'awaiting_approval', 'done'].includes(st.status)) fail(`Stage "${stageId}" was already submitted and passed its gates.`);
  st.attempts = (st.attempts || 0) + 1;
  st.submitted_at = nowIso();
  if (off) { st.status = 'done'; st.skipped = `${def.owner} is off`; return finishStage(root, cfg, t, def); }

  const ctx = ctxFor(root, cfg, t, def, def.output);
  if (ctx.contract?.__invalid_json) ctx.contract = null;
  const results = runGates(ctx, def.gates || []);
  writeGateReport(root, t, stageId, results);
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const needsHuman = failed.find((r) => r.needs_human);
  if (needsHuman && failed.every((r) => r.needs_human)) {
    st.status = 'awaiting_answer';
    st.attempts -= 1;
    t.status = 'awaiting_human';
    t.await = { kind: needsHuman.needs_human, stage: stageId, details: needsHuman.details, since: nowIso() };
    save(root, t, { event: 'needs_human', stage: stageId, kind: needsHuman.needs_human });
    return { passed: false, awaiting: needsHuman.needs_human, next: `Stop. Ask the human: ${needsHuman.details.join(' | ')}` };
  }
  if (failed.length) {
    st.status = 'gates_failed';
    for (const r of failed) {
      observe(root, { ticket: key, stage: stageId, agent: def.owner, kind: 'mistake', source: 'gate', signature: `gate:${r.id}`, fact: `Gate ${r.id} failed at ${stageId} (attempt ${st.attempts}): ${r.details.slice(0, 3).join('; ')}` });
    }
    const max = Number(cfg.pipeline.attempts?.max ?? 2);
    if (st.attempts >= max) {
      escalate(root, cfg, t, `Stage "${stageId}" failed its gates ${st.attempts} time(s): ${failed.map((r) => r.id).join(', ')}.`);
      return { passed: false, failed, escalated: true, next: `Stop. Read vault/tickets/${key}/escalation.md to the human.` };
    }
    save(root, t, { event: 'gates_failed', stage: stageId, gates: failed.map((r) => r.id) });
    return { passed: false, failed, next: `Gates failed. Fix exactly what vault/tickets/${key}/verify-${stageId}.md lists, then submit again (attempt ${st.attempts + 1} of ${max}).` };
  }
  if (st.attempts === 1) observe(root, { ticket: key, stage: stageId, agent: def.owner, kind: 'good', source: 'gate', signature: `first-pass:${stageId}`, fact: `All ${results.length} gates of ${stageId} passed on the first attempt.` });
  if (stageId === 'review') {
    for (const f of (ctx.contract.findings || []).filter((x) => x.severity !== 'minor')) {
      observe(root, { ticket: key, stage: 'review', agent: cfg.agents.agents[f.agent] ? f.agent : 'builder', kind: 'mistake', source: 'reviewer', signature: `review:${f.severity}`, fact: `Reviewer finding (${f.severity})${f.component ? ` on ${f.component}` : ''}: ${f.text}`, evidence: f.proof });
    }
  }
  const lite = t.path === 'lite';
  if (def.lead_verify && !(lite && stageId !== 'build')) {
    st.status = 'awaiting_lead';
    save(root, t, { event: 'gates_passed', stage: stageId });
    return { passed: true, next: `Gates passed. The Lead now re-checks one claim: orgtomo next ${key}` };
  }
  return afterVerified(root, cfg, t, def);
}

/** The Lead re-checked one claim against fresh evidence. */
export function leadVerify(root, cfg, key, stageId, { claim, evidence, result, note, actor } = {}) {
  const t = loadTicket(root, key);
  const def = stageDef(root, stageId);
  const st = t.stages[stageId];
  if (t.stage !== stageId || st?.status !== 'awaiting_lead') fail(`Stage "${stageId}" of ${key} is not waiting for the Lead's check.`);
  if (actor && !['lead', 'human'].includes(actor)) fail('Only the Lead verifies a stage.', 'WRONG_ACTOR');
  if (!['match', 'mismatch'].includes(result)) fail('--result must be match or mismatch.');
  const contract = readContract(root, key, def.output);
  const claims = contract?.claims || [];
  if (claims.length && !claims.some((c) => c.id === claim)) fail(`Claim "${claim}" is not in ${def.output}.json. Claims: ${claims.map((c) => c.id).join(', ')}`);
  const e = listEvidence(root, key).find((x) => x.id === evidence);
  if (!e) fail(`Evidence ${evidence} is not in the ledger. Run the check with an orgtomo command so it is recorded.`);
  if (e.at < st.submitted_at) fail(`Evidence ${evidence} is older than the submission. The check must be done again, now.`);
  if (actor === 'lead' && e.actor !== 'lead') fail(`Evidence ${evidence} was produced by "${e.actor}". The Lead must run the check itself.`);
  st.lead_check = { claim, evidence, result, note: note || '', at: nowIso() };
  if (result === 'mismatch') {
    st.status = 'gates_failed';
    observe(root, { ticket: key, stage: stageId, agent: def.owner, kind: 'mistake', source: 'lead', signature: `lead:mismatch:${stageId}`, fact: `Lead re-checked claim ${claim} of ${stageId} and the org did not match the report. ${note || ''}`.trim(), evidence: [evidence] });
    appendLine(path.join(layout(root).ticketDir(key), `verify-${stageId}.md`), `\n## Lead check: MISMATCH\n\nClaim ${claim} did not hold against ${evidence}. ${note || ''}\n`);
    if (st.attempts >= Number(cfg.pipeline.attempts?.max ?? 2)) { escalate(root, cfg, t, `The Lead's check of "${stageId}" found a claim that does not match the org (claim ${claim}).`); return { ok: false, escalated: true }; }
    save(root, t, { event: 'lead_mismatch', stage: stageId, claim });
    return { ok: false, next: `Send the stage back to the ${def.owner} with the mismatch: orgtomo next ${key}` };
  }
  appendLine(path.join(layout(root).ticketDir(key), `verify-${stageId}.md`), `\n## Lead check: match\n\nClaim ${claim} re-checked against ${evidence}. ${note || ''}\n`);
  return { ok: true, ...afterVerified(root, cfg, t, def) };
}

function afterVerified(root, cfg, t, def) {
  const st = t.stages[def.id];
  if (approvalStages(cfg).includes(def.id) && !verdictFails(root, t, def)) {
    st.status = 'awaiting_approval';
    t.status = 'awaiting_human';
    t.await = { kind: 'approval', stage: def.id, since: nowIso() };
    save(root, t, { event: 'awaiting_approval', stage: def.id });
    return { passed: true, awaiting: 'approval', next: `Stop. Summarise the result for the human and ask for /orgtomo:approve ${t.key}` };
  }
  st.status = 'done';
  return finishStage(root, cfg, t, def);
}

function verdictFails(root, t, def) {
  if (!def.on_verdict) return false;
  const c = readContract(root, t.key, def.output);
  return c && c[def.on_verdict.field] === def.on_verdict.fail_value;
}

/** A stage is complete: loop back on a failing verdict, otherwise move on. */
function finishStage(root, cfg, t, def) {
  const key = t.key;
  if (verdictFails(root, t, def)) {
    const c = readContract(root, key, def.output);
    const reasons = (c.failures || c.findings || []).map((f) => f.why || f.text).slice(0, 5);
    t.loops += 1;
    const blamed = def.id === 'review' ? (c.findings || []).map((f) => f.agent).find(Boolean) || 'builder' : (c.failures || [])[0]?.suspected_stage === 'plan' ? 'planner' : 'builder';
    observe(root, { ticket: key, stage: def.id, agent: blamed, kind: 'mistake', source: def.id === 'review' ? 'reviewer' : 'engine', signature: `loop:${def.id}`, fact: `${def.id} sent the ticket back to ${def.on_verdict.goto} (loop ${t.loops}): ${reasons.join('; ')}`, evidence: (c.failures || c.findings || []).flatMap((f) => f.proof || []).slice(0, 5) });
    if (t.loops > loopMax(cfg)) {
      escalate(root, cfg, t, `${def.id} failed after ${t.loops - 1} full loop(s) (limit ${loopMax(cfg)}).`);
      return { passed: true, verdict: 'fail', escalated: true, next: `Stop. Read vault/tickets/${key}/escalation.md to the human.` };
    }
    const ids = stagesOf(root).map((s) => s.id);
    for (const id of ids.slice(ids.indexOf(def.on_verdict.goto), ids.indexOf(def.id) + 1)) {
      if (t.stages[id]) t.stages[id] = { status: 'pending', attempts: 0, previous_rounds: (t.stages[id].previous_rounds || 0) + 1 };
    }
    t.stage = def.on_verdict.goto;
    appendLine(path.join(layout(root).ticketDir(key), 'updates.md'), `\n## ${nowIso().slice(0, 16)} loop ${t.loops}: back to ${def.on_verdict.goto}\n\n${def.id} did not pass. Reasons:\n${reasons.map((r) => `- ${r}`).join('\n')}\n\nThe previous outputs stay in place as reference; the ${def.on_verdict.goto} stage must address every reason above.\n`);
    save(root, t, { event: 'loop', from: def.id, to: def.on_verdict.goto, loop: t.loops });
    return { passed: true, verdict: 'fail', loop: t.loops, next: `Back to ${def.on_verdict.goto} (loop ${t.loops} of ${loopMax(cfg)}): orgtomo next ${key}` };
  }
  if (def.id === 'understand') decidePath(root, cfg, t);
  const ids = stagesOf(root).map((s) => s.id);
  t.stage = ids[ids.indexOf(def.id) + 1];
  if (t.stage === 'handoff') return enterHandoff(root, cfg, t);
  if (t.stage === 'done') {
    t.status = 'done';
    if (t.loops === 0) observe(root, { ticket: key, stage: 'done', agent: 'lead', kind: 'good', source: 'engine', signature: 'clean-ticket', fact: `Ticket ${key} finished with no loop back.` });
    save(root, t, { event: 'done' });
    return { passed: true, done: true, next: 'Ticket is done.' };
  }
  save(root, t, { event: 'stage_done', stage: def.id });
  return { passed: true, next: `orgtomo next ${key}` };
}

/** The lite path is decided by facts in the Analyst's contract, never by wish. */
function decidePath(root, cfg, t) {
  const u = readContract(root, t.key, '01-understanding');
  const lite = cfg.pipeline.lite || {};
  const types = (u?.affected || []).map((a) => parseRef(a.component).type);
  const ok = cfg.features.lite_path && lite.enabled !== false && u?.lite_candidate === true && u.risk === 'low'
    && types.length > 0 && types.length <= Number(lite.max_components ?? 3) && types.every((x) => (lite.allowed_types || []).includes(x));
  t.path = ok ? 'lite' : 'full';
  t.history.push({ at: nowIso(), event: 'path', path: t.path, why: ok ? 'low risk, small, allowed component types' : 'does not meet every lite condition' });
}

function escalate(root, cfg, t, reason) {
  const dir = layout(root).ticketDir(t.key);
  const reports = listFiles(dir).filter((f) => /^verify-.*\.md$/.test(f));
  const rounds = t.history.filter((h) => ['gates_failed', 'loop', 'lead_mismatch'].includes(h.event));
  writeText(path.join(dir, 'escalation.md'), `${formatFrontmatter({ type: 'escalation', ticket: t.key, stage: t.stage, loops: t.loops, at: nowIso() })}# ${t.key} stopped: a human decision is needed\n\n**Why it stopped:** ${reason}\n\n**Where:** stage "${t.stage}", after ${t.loops} loop(s).\n\n## What happened, in order\n\n${rounds.map((h) => `- ${h.at.slice(0, 16)} ${h.event}${h.stage ? ` at ${h.stage}` : ''}${h.gates ? `: ${h.gates.join(', ')}` : ''}${h.from ? `: ${h.from} -> ${h.to}` : ''}`).join('\n') || '- (no earlier failures recorded)'}\n\n## Read these\n\n${reports.map((f) => `- [[tickets/${t.key}/${f.replace(/\.md$/, '')}]]`).join('\n')}\n- [[tickets/${t.key}/updates]]\n\n## Your options\n\n- \`/orgtomo:resume ${t.key} <direction>\` to give a direction and let the team try again from the plan\n- \`/orgtomo:hold ${t.key}\` to park the ticket\n- take the ticket over yourself\n`);
  t.status = 'escalated';
  t.await = { kind: 'escalation', reason, since: nowIso() };
  observe(root, { ticket: t.key, stage: t.stage, agent: 'lead', kind: 'mistake', source: 'engine', signature: `escalated:${t.stage}`, fact: `Ticket stopped at ${t.stage}: ${reason}` });
  save(root, t, { event: 'escalated', reason });
}

// ------------------------------------------------------------------ handoff

function enterHandoff(root, cfg, t) {
  t.handoff = { index: 0, targets: (cfg.pipeline.targets || []).map((x) => ({ org: x.org, tool: x.tool, retest: Boolean(x.retest) && !isProduction(getOrg(cfg, x.org)), status: 'pending' })) };
  if (!t.handoff.targets.length) { t.stage = 'close'; save(root, t, { event: 'no_targets' }); return { passed: true, next: `orgtomo next ${t.key}` }; }
  save(root, t, { event: 'handoff_started' });
  return { passed: true, next: `orgtomo handoff pack ${t.key}` };
}

function nextHandoff(root, cfg, t) {
  const target = t.handoff.targets[t.handoff.index];
  const key = t.key;
  if (target.status === 'pending') return { do: [{ who: 'lead', action: `orgtomo handoff pack ${key}` }], say: `Build the deploy pack for ${target.org}.` };
  if (target.status === 'deployed') return { do: [{ who: 'lead', action: `orgtomo handoff parity ${key}` }], say: `The human deployed to ${target.org}. Check that the org matches the build (read-only).` };
  if (target.status === 'parity_ok') {
    return { do: [{ who: 'tester', action: 'spawn', org: target.org, outputs: [`vault/tickets/${key}/05-qa-${target.org}.md`, `vault/tickets/${key}/05-qa-${target.org}.json`], contract: 'qa', then: `orgtomo submit ${key} handoff` }], say: `Retest in ${target.org} with the same tests as 05-qa.` };
  }
  return { do: [], say: 'Waiting.' };
}

/** Called by the deploy pack builder once the pack exists. */
export function markPackReady(root, cfg, key) {
  const t = loadTicket(root, key);
  const target = t.handoff?.targets[t.handoff.index] || fail(`Ticket ${key} is not in handoff.`);
  target.status = 'pack_ready';
  t.status = 'awaiting_human';
  t.await = { kind: 'deploy', org: target.org, since: nowIso() };
  return save(root, t, { event: 'pack_ready', org: target.org });
}

/** Record the result of a parity check on the current target. */
export function recordParity(root, cfg, key, result) {
  const t = loadTicket(root, key);
  const target = t.handoff?.targets[t.handoff.index] || fail(`Ticket ${key} is not in handoff.`);
  if (target.status !== 'deployed') fail(`The human has not confirmed the deploy to ${target.org} yet.`);
  if (!result.ok) {
    t.status = 'awaiting_human';
    t.await = { kind: 'deploy', org: target.org, problem: result.rows.filter((r) => !['same', 'check_manually'].includes(r.status)).map((r) => `${r.ref} ${r.status}`).join(', '), since: nowIso() };
    target.status = 'pack_ready';
    observe(root, { ticket: key, stage: 'handoff', agent: 'lead', kind: 'mistake', source: 'engine', signature: `parity:${target.tool}`, fact: `After the human deploy, ${target.org} did not match the build: ${t.await.problem}`, evidence: [result.evidence] });
    save(root, t, { event: 'parity_failed', org: target.org });
    return { ok: false, next: `Stop. Show the human the differences; they redeploy and run /orgtomo:deployed ${target.org} ${key} again.` };
  }
  target.parity = result.evidence;
  if (target.retest) { target.status = 'parity_ok'; save(root, t, { event: 'parity_ok', org: target.org }); return { ok: true, next: `orgtomo next ${key}` }; }
  return { ok: true, ...advanceTarget(root, cfg, t) };
}

function advanceTarget(root, cfg, t) {
  t.handoff.targets[t.handoff.index].status = 'verified';
  t.handoff.index += 1;
  if (t.handoff.index >= t.handoff.targets.length) { t.stage = 'close'; save(root, t, { event: 'handoff_done' }); return { next: `orgtomo next ${t.key}` }; }
  save(root, t, { event: 'target_verified' });
  return { next: `orgtomo handoff pack ${t.key}` };
}

function submitRetest(root, cfg, t, { actor }) {
  const target = t.handoff.targets[t.handoff.index];
  if (target.status !== 'parity_ok') fail(`Nothing to submit for ${target.org} now.`);
  if (actor && !['tester', 'human'].includes(actor)) fail('The retest is submitted by the Tester.', 'WRONG_ACTOR');
  const def = { id: 'handoff', contract: 'qa', output: `05-qa-${target.org}` };
  const ctx = ctxFor(root, cfg, t, def, def.output);
  if (ctx.contract?.__invalid_json) ctx.contract = null;
  const results = runGates(ctx, ['contract', 'evidence', 'assertion-referee', 'data-safe']);
  const wrongOrg = ctx.contract && ctx.contract.org !== target.org ? [{ id: 'org', type: 'org-check', ok: false, details: [`the retest must run in ${target.org}, the contract says ${ctx.contract.org}`], why: 'Retest runs in the target org.' }] : [];
  const all = [...results, ...wrongOrg];
  writeGateReport(root, t, `handoff-${target.org}`, all);
  const failed = all.filter((r) => !r.ok);
  if (failed.length) { save(root, t, { event: 'gates_failed', stage: `handoff-${target.org}`, gates: failed.map((r) => r.id) }); return { passed: false, failed, next: `Fix what verify-handoff-${target.org}.md lists and submit again.` }; }
  if (ctx.contract.verdict !== 'pass') {
    escalate(root, cfg, t, `The retest in ${target.org} failed after the human deploy. The change is live in ${target.org}; a human decides what happens next.`);
    return { passed: true, verdict: 'fail', escalated: true, next: `Stop. Read vault/tickets/${t.key}/escalation.md to the human.` };
  }
  return { passed: true, ...advanceTarget(root, cfg, t) };
}

// ------------------------------------------------------------------ human

function approvalLog(root, rec) {
  appendLine(path.join(layout(root).state, 'approvals.jsonl'), JSON.stringify({ at: nowIso(), ...rec }));
}

export const human = {
  approve(root, cfg, key, { note = '', source = 'terminal' } = {}) {
    const t = loadTicket(root, key);
    if (t.status !== 'awaiting_human' || t.await?.kind !== 'approval') fail(`Nothing on ${key} is waiting for approval (status: ${t.status}${t.await ? `, waiting for: ${t.await.kind}` : ''}).`);
    const def = stageDef(root, t.await.stage);
    t.stages[def.id].status = 'done';
    t.stages[def.id].approved = { at: nowIso(), note, source };
    t.status = 'running';
    t.await = null;
    approvalLog(root, { key, verb: 'approve', stage: def.id, note, source });
    t.history.push({ at: nowIso(), event: 'approved', stage: def.id, source });
    return { approved: def.id, ...finishStage(root, cfg, t, def) };
  },
  reject(root, cfg, key, { note = '', source = 'terminal' } = {}) {
    const t = loadTicket(root, key);
    if (t.status !== 'awaiting_human' || t.await?.kind !== 'approval') fail(`Nothing on ${key} is waiting for approval.`);
    if (!note.trim()) fail('Say why you reject it, so the team can fix exactly that.');
    const def = stageDef(root, t.await.stage);
    t.stages[def.id] = { ...t.stages[def.id], status: 'rejected', attempts: 0 };
    t.status = 'running';
    t.await = null;
    approvalLog(root, { key, verb: 'reject', stage: def.id, note, source });
    observe(root, { ticket: key, stage: def.id, agent: def.owner, kind: 'mistake', source: 'human', signature: `human:reject:${def.id}`, fact: `The human rejected ${def.id}: ${note}` });
    appendLine(path.join(layout(root).ticketDir(key), 'updates.md'), `\n## ${nowIso().slice(0, 16)} human rejected ${def.id}\n\n${note}\n`);
    appendLine(path.join(layout(root).ticketDir(key), `verify-${def.id}.md`), `\n## Human: REJECTED\n\n${note}\n`);
    save(root, t, { event: 'rejected', stage: def.id });
    return { rejected: def.id, next: `orgtomo next ${key}` };
  },
  hold(root, cfg, key, { note = '' } = {}) {
    const t = loadTicket(root, key);
    if (['done', 'hold'].includes(t.status)) fail(`Ticket ${key} is ${t.status}.`);
    t.held = { status: t.status, await: t.await };
    t.status = 'hold';
    save(root, t, { event: 'hold', note });
    return { hold: true };
  },
  resume(root, cfg, key, { note = '', source = 'terminal' } = {}) {
    const t = loadTicket(root, key);
    if (t.status === 'hold') {
      t.status = t.held?.status || 'running'; t.await = t.held?.await || null; delete t.held;
      save(root, t, { event: 'resumed' });
      return { resumed: true, next: `orgtomo next ${key}` };
    }
    if (t.status !== 'escalated') fail(`Ticket ${key} is ${t.status}; there is nothing to resume.`);
    if (!note.trim()) fail('Give a direction: what should the team do differently?');
    approvalLog(root, { key, verb: 'resume', stage: t.stage, note, source });
    observe(root, { ticket: key, stage: t.stage, agent: 'lead', kind: 'feedback', source: 'human', signature: 'human:direction', fact: `After the stop the human directed: ${note}` });
    appendLine(path.join(layout(root).ticketDir(key), 'updates.md'), `\n## ${nowIso().slice(0, 16)} human direction after the stop\n\n${note}\n`);
    if (t.stage !== 'handoff') {
      const back = ['build', 'test', 'review'].includes(t.stage) ? 'plan' : t.stage;
      const ids = stagesOf(root).map((s) => s.id);
      for (const id of ids.slice(ids.indexOf(back))) if (t.stages[id]) t.stages[id] = { status: 'pending', attempts: 0 };
      t.stage = back;
    }
    t.loops = 0; t.status = 'running'; t.await = null;
    save(root, t, { event: 'resumed_with_direction' });
    return { resumed: true, next: `orgtomo next ${key}` };
  },
  answer(root, cfg, key, { id = '', note = '', source = 'terminal' } = {}) {
    const t = loadTicket(root, key);
    if (t.status !== 'awaiting_human' || !['question', 'not_reproduced'].includes(t.await?.kind)) fail(`Ticket ${key} is not waiting for an answer.`);
    if (!note.trim()) fail('The answer is empty.');
    appendLine(path.join(layout(root).ticketDir(key), 'updates.md'), `\n## ${nowIso().slice(0, 16)} human answer${id ? ` to ${id}` : ''}\n\n${redactInside(note, cfg.safety)}\n`);
    approvalLog(root, { key, verb: 'answer', stage: t.await.stage, note: id, source });
    t.stages[t.await.stage].status = 'pending';
    t.status = 'running'; t.await = null;
    save(root, t, { event: 'answered', id });
    return { answered: true, next: `orgtomo next ${key}` };
  },
  deployed(root, cfg, key, { org, source = 'terminal' } = {}) {
    const t = loadTicket(root, key);
    if (t.status !== 'awaiting_human' || t.await?.kind !== 'deploy') fail(`Ticket ${key} is not waiting for a deploy.`);
    if (org !== t.await.org) fail(`Ticket ${key} is waiting for the deploy to "${t.await.org}", not "${org}".`);
    t.handoff.targets[t.handoff.index].status = 'deployed';
    t.handoff.targets[t.handoff.index].deployed_at = nowIso();
    t.status = 'running'; t.await = null;
    approvalLog(root, { key, verb: 'deployed', org, source });
    save(root, t, { event: 'deployed', org });
    return { deployed: org, next: `orgtomo handoff parity ${key}` };
  },
  feedback(root, cfg, key, { kind, agent, note = '' } = {}) {
    if (!['good', 'bad'].includes(kind)) fail('Feedback is "good" or "bad", then the agent, then what you saw.');
    if (!cfg.agents.agents[agent]) fail(`Unknown agent "${agent}". Agents: ${Object.keys(cfg.agents.agents).join(', ')}`);
    if (!note.trim()) fail('Say what was good or bad.');
    const t = key ? loadTicket(root, key) : null;
    return observe(root, { ticket: key || null, stage: t?.stage, agent, kind: kind === 'good' ? 'good' : 'mistake', source: 'human', signature: `human:feedback:${kind}`, fact: `Human feedback (${kind}) for ${agent}: ${redactInside(note, cfg.safety)}` });
  },
};

// ------------------------------------------------------------------ status

function renderStatus(root, t) {
  const stages = stagesOf(root).filter((s) => !['done'].includes(s.id));
  const rows = stages.map((s) => {
    const st = t.stages[s.id];
    const mark = t.stage === s.id && t.status !== 'done' ? 'now' : st?.status === 'done' ? 'done' : '';
    return `| ${s.id} | ${s.owner || 'human'} | ${st?.status || ''} | ${st?.attempts || ''} | ${mark} |`;
  });
  const hand = t.handoff ? `\n## Handoff\n\n| Org | Tool | Status |\n|---|---|---|\n${t.handoff.targets.map((x) => `| ${x.org} | ${x.tool} | ${x.status} |`).join('\n')}\n` : '';
  writeText(path.join(layout(root).ticketDir(t.key), 'status.md'), `${formatFrontmatter({ type: 'ticket-status', ticket: t.key, title: t.title, kind: t.type, status: t.status, stage: t.stage, path: t.path, loops: t.loops, waiting_for: t.await?.kind, updated: t.updated_at })}# ${t.key} ${t.title}\n\n**Status:** ${t.status}${t.await ? ` (waiting for: ${t.await.kind})` : ''}  \n**Stage:** ${t.stage}  \n**Path:** ${t.path}  \n**Loops:** ${t.loops}\n\n| Stage | Owner | State | Attempts | |\n|---|---|---|---|---|\n${rows.join('\n')}\n${hand}\n## Timeline\n\n${t.history.slice(-40).map((h) => `- ${h.at.slice(0, 16).replace('T', ' ')} ${h.event}${h.stage ? ` (${h.stage})` : ''}${h.org ? ` (${h.org})` : ''}`).join('\n')}\n`);
}

/** Compact status for the CLI, the UI and the session banner. */
export function summary(t) {
  return { key: t.key, title: t.title, type: t.type, status: t.status, stage: t.stage, path: t.path, loops: t.loops, waiting_for: t.await?.kind || null, waiting_detail: t.await?.org || t.await?.stage || null, updated_at: t.updated_at };
}
export { buildOrg };

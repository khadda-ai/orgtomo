// Claude Code hook entry point. One process per hook event; the event arrives
// as JSON on stdin (see docs/ARCHITECTURE.md for the events used and why).
//
//   SessionStart          tell the session what is going on in this workspace
//   UserPromptExpansion   human-only actions (/orgtomo:approve ...) are recorded
//   UserPromptSubmit      here, by the engine, never by the model
//   PreToolUse            policy, write, data and MCP guards; stage gate on spawns
//   SubagentStart/Stop    an agent may not finish without submitting its stage
//   Stop                  the Lead keeps going until a human gate
//
// Guards fail closed: if this code throws while judging a tool call, the call
// is denied.
import fs from 'node:fs';
import path from 'node:path';
import { findWorkspace, layout } from './paths.js';
import { loadConfig, validateConfig, setConfigValue, org as getOrg, isProduction, EFFORTS } from './config.js';
import { checkBash } from './guards/policy.js';
import { checkWrite } from './guards/write.js';
import { checkMcp, checkWebFetch, orgForHost } from './guards/mcp.js';
import { scanNew, describeFindings } from './guards/data.js';
import { analyze, base } from './shell.js';
import { human, listTickets, loadTicket, next, stagesOf, activeStages, summary } from './ticket.js';
import { setLessonStatus, proposeLessons, observe } from './learning.js';
import { setPerson, confirmProposal, removePerson } from './people.js';
import { confirmLink, plan as meetingPlan } from './meetings.js';
import { recordCanary } from './canary.js';
import { restore, browserLoginUrl } from './org.js';
import { answerQuestion } from './discover.js';
import { sync } from './sync.js';
import { exists, readText, readJson, writeJson, readJsonl, appendLine, nowIso, now, OrgtomoError } from './util.js';

const READ_ONLY = new Set(['cat', 'head', 'tail', 'less', 'grep', 'rg', 'ls', 'find', 'wc', 'stat', 'diff', 'jq', 'cd', 'pwd', 'echo', 'sort', 'uniq', 'cut', 'tree', 'file', 'true']);
const TICKET_RE = /\b[A-Z][A-Z0-9_]*-[0-9]+\b/g;
const FEATURE_ALIASES = {
  lite: ['features', 'lite_path'], learning: ['features', 'self_learning.enabled'], meetings: ['features', 'meetings.enabled'], people: ['features', 'people_profiles.enabled'],
  'flow-generator': ['features', 'sf_skills.flow_generator'], telemetry: ['features', 'sf_skills.telemetry'], transcripts: ['features', 'meetings.store_transcripts'],
  chrome: ['safety', 'browser.claude_in_chrome'], baseline: ['agents', 'agents.baseline.enabled'], scribe: ['agents', 'agents.scribe.enabled'], coach: ['agents', 'agents.coach.enabled'], notetaker: ['agents', 'agents.notetaker.enabled'],
};

/** Normalise the agent a hook fired in to an Orgtomo actor name. */
export function actorOf(input, cfg) {
  const raw = String(input.agent_type || '').replace(/^orgtomo:/, '');
  if (!raw) return 'lead'; // the main thread is treated like the Lead: it delegates
  if (raw === 'tomo-lead') return 'lead';
  return cfg.agents.agents[raw] ? raw : 'unknown';
}

const pre = (decision, reason, extra = {}) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason, ...extra } });
const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Handle one hook event.
 * @param {object} input parsed hook JSON
 * @returns {object|null} JSON to print, or null for "no opinion"
 */
export function handle(input) {
  const root = findWorkspace(input.cwd || process.cwd());
  if (!root) return null; // not an Orgtomo workspace: stay out of the way
  const event = input.hook_event_name;
  const cfg = loadConfig(root);
  const problems = validateConfig(cfg).errors;
  const guardsOff = process.env.ORGTOMO_GUARDS === 'off';
  try {
    switch (event) {
      case 'SessionStart': forgetStaleAgents(root); return context(event, banner(root, cfg, problems, guardsOff));
      case 'UserPromptExpansion': return humanVerb(root, cfg, input, String(input.command_name || '').replace(/^\/?(orgtomo:)?/, ''), String(input.command_args || ''), event);
      case 'UserPromptSubmit': {
        const m = /^\s*\/orgtomo:([a-z-]+)\s*([\s\S]*)$/.exec(String(input.prompt || ''));
        return m ? humanVerb(root, cfg, input, m[1], m[2], event) : null;
      }
      case 'PreToolUse': return preToolUse(root, cfg, input, { problems, guardsOff });
      case 'SubagentStart': return subagentStart(root, cfg, input);
      case 'SubagentStop': return subagentStop(root, cfg, input);
      case 'Stop': return stop(root, cfg, input);
      default: return null;
    }
  } catch (e) {
    if (event === 'PreToolUse') return pre('deny', `Orgtomo guard: ${e instanceof OrgtomoError ? e.message : `internal error, denied to be safe (${e.message})`}`);
    if (e instanceof OrgtomoError && (event === 'UserPromptExpansion' || event === 'UserPromptSubmit')) return { decision: 'block', reason: `Orgtomo: ${e.message}` };
    return null;
  }
}

// ------------------------------------------------------------------ banner

function banner(root, cfg, problems, guardsOff) {
  const lines = ['# Orgtomo workspace'];
  if (problems.length) lines.push(`CONFIGURATION PROBLEMS (fix before working):\n- ${problems.join('\n- ')}`);
  if (guardsOff) lines.push('NOTE: ORGTOMO_GUARDS=off. Only the production and protected-state rules are active.');
  const tickets = listTickets(root).filter((t) => t.status !== 'done').map(summary);
  lines.push(tickets.length
    ? `Open tickets:\n${tickets.map((t) => `- ${t.key} "${t.title}": ${t.status}, stage ${t.stage}${t.blocked_reason ? `, BLOCKED: ${t.blocked_reason}` : t.waiting_for ? `, waiting for ${t.waiting_for}` : ''}, loops ${t.loops}`).join('\n')}`
    : 'No open tickets. The human starts one with /orgtomo:ticket <KEY>.');
  const orgs = Object.entries(cfg.orgs.orgs || {}).map(([n, o]) => `${n} (${o.role})`).join(', ');
  lines.push(`Orgs: ${orgs}. Build org: ${cfg.pipeline.build_org}. Production is read-only and masked.`);
  lines.push('Always ask the engine what to do: `orgtomo next <KEY>`. Never decide the order of work yourself. Human actions (/orgtomo:approve, reject, deployed, answer ...) are recorded by the engine when the human types them; you cannot perform them.');
  lines.push('If a tool, a login or an org is broken, do not retry in a loop and do not work around it: `orgtomo block <KEY> --reason "<exact message and what would fix it>"`, tell the human, and stop.');
  const mp = meetingPlan(root, cfg);
  if (mp.enabled) lines.push(`Meetings are on (${mp.provider}). Before ticket work, have the notetaker bring in meetings since ${mp.since}: \`orgtomo meetings plan\`.`);
  return lines.join('\n\n');
}

// ------------------------------------------------------------------ human verbs

function oncePerPrompt(root, input, verb, args) {
  const file = path.join(layout(root).state, 'human-verbs.jsonl');
  const id = input.prompt_id || `${input.session_id}:${verb}:${args}`;
  const seen = readJsonl(file).slice(-200).some((r) => r.id === id && r.verb === verb && (input.prompt_id || now() - new Date(r.at) < 10_000));
  if (!seen) appendLine(file, JSON.stringify({ id, verb, args, at: nowIso(), event: input.hook_event_name }));
  return !seen;
}

function soleAwaiting(root, kinds) {
  const list = listTickets(root).filter((t) => (t.status === 'awaiting_human' && kinds.includes(t.await?.kind)) || (kinds.includes('escalation') && t.status === 'escalated') || (kinds.includes('hold') && t.status === 'hold') || (kinds.includes('blocked') && t.status === 'blocked'));
  return list.length === 1 ? list[0].key : null;
}

function humanVerb(root, cfg, input, verb, argText, event) {
  const HUMAN = ['approve', 'reject', 'hold', 'resume', 'answer', 'deployed', 'feedback', 'lessons', 'models', 'features', 'autonomy', 'people', 'meetings', 'canary', 'ping', 'rule', 'restore', 'discover'];
  if (!HUMAN.includes(verb)) return null;
  const words = argText.trim().split(/\s+/).filter(Boolean);
  if (verb === 'discover' && words[0] !== 'answer') return null;
  if (verb === 'lessons' && !['approve', 'retire'].includes(words[0])) return null;
  if (verb === 'people' && !['set', 'confirm', 'reject', 'remove'].includes(words[0])) return null;
  if (verb === 'meetings' && !['confirm', 'reject'].includes(words[0])) return null;
  if (verb === 'models' && words.length < 2) return null;
  if (verb === 'features' && words.length < 2) return null;
  if (!oncePerPrompt(root, input, verb, argText)) return null;

  const source = `claude-code:${event}`;
  const keyAt = words.findIndex((w) => /^[A-Z][A-Z0-9_]*-[0-9]+$/.test(w));
  const key = keyAt >= 0 ? words[keyAt] : null;
  const rest = (skip) => words.filter((_, i) => i !== keyAt).slice(skip).join(' ');
  let result;
  let resync = false;
  switch (verb) {
    case 'ping': result = { pong: true, delivered_by: event }; writeJson(path.join(layout(root).state, 'hook-selftest.json'), { at: nowIso(), event, fields: Object.keys(input) }); break;
    case 'approve': result = human.approve(root, cfg, key || soleAwaiting(root, ['approval']) || needKey(), { note: rest(0), source }); break;
    case 'reject': result = human.reject(root, cfg, key || soleAwaiting(root, ['approval']) || needKey(), { note: rest(0), source }); break;
    case 'restore': result = restore(root, cfg, { key: key || needKey(), source }); break;
    case 'hold': result = human.hold(root, cfg, key || needKey(), { note: rest(0) }); break;
    case 'resume': result = human.resume(root, cfg, key || soleAwaiting(root, ['escalation', 'hold', 'blocked']) || needKey(), { note: rest(0), source }); break;
    case 'discover': { // /orgtomo:discover answer <org> <Q id> <answer>
      const o = getOrg(cfg, words[1] || needArg('org'));
      result = answerQuestion(root, cfg, o.name, words[2] || needArg('question id'), words.slice(3).join(' '));
      break;
    }
    case 'answer': {
      const k = key || soleAwaiting(root, ['question', 'not_reproduced']) || needKey();
      const others = words.filter((_, i) => i !== keyAt);
      const hasId = /^(Q\d+|repro)$/i.test(others[0] || '');
      result = human.answer(root, cfg, k, { id: hasId ? others[0] : '', note: others.slice(hasId ? 1 : 0).join(' '), source });
      break;
    }
    case 'deployed': {
      const orgName = words.find((w, i) => i !== keyAt && cfg.orgs.orgs?.[w]);
      const k = key || soleAwaiting(root, ['deploy']) || needKey();
      result = human.deployed(root, cfg, k, { org: orgName || loadTicket(root, k).await?.org, source });
      break;
    }
    case 'feedback': {
      const others = words.filter((_, i) => i !== keyAt);
      result = human.feedback(root, cfg, key, { kind: others[0], agent: others[1], note: others.slice(2).join(' ') });
      break;
    }
    case 'rule': { // /orgtomo:rule <agent> <rule text>: a lesson stated by the human applies at once
      const agent = words[0];
      const text = words.slice(1).join(' ');
      if (!cfg.agents.agents[agent] || text.length < 15) throw new OrgtomoError('Use: /orgtomo:rule <agent> <the rule, one clear sentence>');
      const o = observe(root, { agent, kind: 'feedback', source: 'human', signature: 'human:rule', fact: `The human stated a rule for ${agent}: ${text}` });
      result = proposeLessons(root, cfg, [{ agent, type: 'avoid', rule: text, why: 'Stated directly by the human.', observations: [o.id] }], { by: 'human' })[0];
      resync = true;
      break;
    }
    case 'lessons': result = setLessonStatus(root, words[1] || needArg('lesson id'), words[0] === 'approve' ? 'approved' : 'retired'); resync = true; break;
    case 'models': {
      const w = words[0] === 'set' ? words.slice(1) : words;
      const [agent, model, effort] = w;
      if (!cfg.agents.agents[agent]) throw new OrgtomoError(`Unknown agent "${agent}". Agents: ${Object.keys(cfg.agents.agents).join(', ')}`);
      const isEffort = (x) => EFFORTS.includes(x);
      if (model && !isEffort(model)) setConfigValue(root, 'agents', `agents.${agent}.model`, model);
      const eff = isEffort(model) ? model : effort;
      if (eff) setConfigValue(root, 'agents', `agents.${agent}.effort`, eff);
      result = { agent, ...loadConfig(root).agents.agents[agent] };
      resync = true;
      break;
    }
    case 'features': {
      const alias = FEATURE_ALIASES[words[0]];
      if (!alias || !['on', 'off'].includes(words[1])) throw new OrgtomoError(`Use: /orgtomo:features <${Object.keys(FEATURE_ALIASES).join('|')}> on|off`);
      setConfigValue(root, alias[0], alias[1], words[1] === 'on');
      result = { [words[0]]: words[1] };
      resync = true;
      break;
    }
    case 'autonomy': setConfigValue(root, 'pipeline', 'autonomy', words[0]); result = { autonomy: words[0] }; break;
    case 'people': {
      if (words[0] === 'confirm' || words[0] === 'reject') { result = confirmProposal(root, cfg, words[1], { accept: words[0] === 'confirm', as: words[2] === 'avoid' ? 'avoid' : 'prefers' }); break; }
      const pairs = argText.replace(/^\s*(set|remove)\s+/, '');
      if (words[0] === 'remove') { result = removePerson(root, cfg, pairs.trim()); break; }
      const m = /^(.+?)\s+((?:[a-z_]+=).*)$/s.exec(pairs);
      if (!m) throw new OrgtomoError('Use: /orgtomo:people set <Name> role="..." side=client salesforce_knowledge=basic detail_level=short prefers="...;..."');
      const fields = {};
      for (const kv of m[2].matchAll(/([a-z_]+)=("([^"]*)"|\S+)/g)) {
        const v = kv[3] ?? kv[2];
        fields[kv[1]] = ['prefers', 'avoid', 'aliases', 'channels'].includes(kv[1]) ? v.split(';').map((x) => x.trim()).filter(Boolean) : v;
      }
      result = setPerson(root, cfg, m[1].trim(), fields);
      break;
    }
    case 'meetings': result = confirmLink(root, cfg, words[1] || needArg('link id'), words[0] === 'confirm'); break;
    case 'canary': {
      const o = getOrg(cfg, words[0] || needArg('org'));
      if (isProduction(o)) throw new OrgtomoError('Production has no canary: nothing is ever written there.');
      if (!['blocked', 'enabled'].includes(words[1])) throw new OrgtomoError('Use: /orgtomo:canary <org> blocked|enabled (what Setup > Deliverability shows)');
      result = recordCanary(root, o.name, words[1], 'human', 'stated by the human');
      break;
    }
    default: return null;
  }
  if (resync) { try { sync(root, loadConfig(root)); } catch { /* reported by doctor */ } }
  const follow = result?.next ? ` Next: \`${result.next}\`.` : '';
  return context(event, `[Orgtomo engine] The human's /orgtomo:${verb} was recorded by the engine: ${JSON.stringify(result)}.${follow} Do not repeat or simulate this action; continue from the engine's state.`);
}
const needKey = () => { throw new OrgtomoError('Which ticket? Add the ticket key, for example /orgtomo:approve ABC-123.'); };
const needArg = (what) => { throw new OrgtomoError(`Missing ${what}.`); };

// ------------------------------------------------------------------ PreToolUse

function preToolUse(root, cfg, input, { problems, guardsOff }) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const agent = actorOf(input, cfg);
  const ctx = { cfg, root, agent, guardsOff, stages: stagesOf(root), activeStages: activeStages(root), scratch: input.scratchpad_dir, cwd: input.cwd };
  if (problems.length && ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task'].includes(tool) && !guardsOff) {
    if (!(tool === 'Bash' && /^\s*orgtomo\s+(doctor|status|sync)\b/.test(ti.command || ''))) return pre('deny', `Orgtomo configuration is invalid; nothing runs until it is fixed:\n- ${problems.join('\n- ')}`);
  }
  if (agent === 'unknown' && !guardsOff && tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob') {
    return pre('deny', `Agent "${input.agent_type}" is not an Orgtomo agent. In this workspace only the Orgtomo team works; run other agents in another folder.`);
  }

  if (tool === 'Bash') {
    const cmd = String(ti.command || '');
    const r = checkBash(cmd, ctx);
    if (r.decision === 'deny') return pre('deny', `Orgtomo policy: ${r.reason}`);
    if (r.orgtomo) {
      const others = analyze(cmd).segments.map((s) => base(s.argv[0])).filter((n) => n && n !== 'orgtomo' && !READ_ONLY.has(n));
      if (others.length) return pre('deny', `Orgtomo policy: run orgtomo commands on their own (found "${others[0]}" in the same command).`);
      return pre('allow', 'Orgtomo engine command', { updatedInput: { ...ti, command: `export ORGTOMO_ACTOR=${shq(agent)} ORGTOMO_SESSION=${shq(input.session_id || '')}; ${cmd}` } });
    }
    return null;
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const file = ti.file_path || ti.notebook_path || '';
    const r = checkWrite(file, ctx);
    if (r.decision === 'deny') return pre('deny', `Orgtomo write guard: ${r.reason}`);
    if (!guardsOff) {
      const text = [ti.content, ti.new_string, ti.new_source, ...(ti.edits || []).map((e) => e.new_string)].filter(Boolean).join('\n');
      // An address that is already in the file being edited is not new data; only new ones are stopped.
      const abs = path.resolve(root, file);
      const before = exists(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size < 2_000_000 ? readText(abs) : '';
      const hits = scanNew(text, before, cfg.safety);
      if (hits.length) return pre('deny', `Orgtomo data guard: ${describeFindings(hits)}`);
    }
    return null;
  }
  if (tool.startsWith('mcp__')) {
    const r = checkMcp(tool, ti, ctx);
    if (r.decision === 'deny') return pre('deny', `Orgtomo MCP guard: ${r.reason}`);
    const login = guardsOff ? null : browserSignIn(root, cfg, tool, ti);
    return login ? pre('allow', 'Orgtomo opened the page through a one-time sign-in link for this sandbox.', { updatedInput: { ...ti, url: login } }) : null;
  }
  if (tool === 'WebFetch' && !guardsOff) {
    const r = checkWebFetch(String(ti.url || ''), cfg);
    return r.decision === 'deny' ? pre('deny', `Orgtomo docs guard: ${r.reason}`) : null;
  }
  if ((tool === 'Agent' || tool === 'Task') && !guardsOff) return spawnGate(root, cfg, ti);
  return null;
}

const sessionsFile = (root) => path.join(layout(root).state, 'browser-sessions.json');

/** Ask for a fresh sign-in the next time the agent browser opens a page of this org. */
export function requestBrowserSignIn(root, orgName) {
  const all = readJson(sessionsFile(root), {});
  all[orgName] = { ...(all[orgName] || {}), pending: true, asked_at: nowIso() };
  writeJson(sessionsFile(root), all);
  return all[orgName];
}
export const browserSessions = (root) => readJson(sessionsFile(root), {});

/**
 * Sign the agent browser in without a password or passkey. When the agent
 * opens a sandbox page and the browser has no recent session there, the page
 * is opened through a one-time link made from the CLI's own login. The agent
 * asked for a normal sandbox URL and never chooses the link itself.
 * @returns {string|null} the URL to open instead, or null to leave the call alone
 */
function browserSignIn(root, cfg, tool, ti) {
  if (cfg.safety.browser?.login !== 'frontdoor' || !/__browser_navigate$/.test(tool) || tool.startsWith('mcp__claude-in-chrome__')) return null;
  let u;
  try { u = new URL(ti.url); } catch { return null; }
  const orgName = orgForHost(cfg, u.hostname);
  if (!orgName) return null;
  const all = readJson(sessionsFile(root), {});
  const s = all[orgName];
  const maxAge = Number(cfg.safety.browser?.session_minutes ?? 60) * 60_000;
  if (s && !s.pending && s.at && now() - new Date(s.at) < maxAge) return null;
  try {
    const target = `${u.pathname}${u.search}`;
    const url = browserLoginUrl(root, cfg, orgName, target === '/' ? '' : target);
    all[orgName] = { at: nowIso(), pending: false };
    writeJson(sessionsFile(root), all);
    return url;
  } catch (e) {
    all[orgName] = { ...(s || {}), pending: true, last_error: String(e.message || e).slice(0, 300), error_at: nowIso() };
    writeJson(sessionsFile(root), all);
    return null;
  }
}

/** Stage gate: an agent is spawned only when the engine says it is its turn. */
function spawnGate(root, cfg, ti) {
  const who = String(ti.subagent_type || '').replace(/^orgtomo:/, '');
  const def = cfg.agents.agents[who];
  if (!def) return pre('deny', `Orgtomo stage gate: "${who || 'unnamed agent'}" is not an Orgtomo agent. Spawn only the agents that \`orgtomo next <KEY>\` names.`);
  if (def.enabled === false) return pre('deny', `Orgtomo stage gate: the ${who} is switched off (agents.yaml).`);
  if (who === 'notetaker') return cfg.features.meetings?.enabled ? null : pre('deny', 'Orgtomo stage gate: the meetings feature is off.');
  if (['cartographer', 'scribe'].includes(who)) return null; // support work that changes no org and no source
  const keys = [...new Set(String(ti.prompt || '').match(TICKET_RE) || [])].filter((k) => listTickets(root).some((t) => t.key === k));
  if (keys.length !== 1) return pre('deny', `Orgtomo stage gate: name exactly one open ticket key in the prompt for the ${who} (found ${keys.length}).`);
  const n = next(root, cfg, keys[0]);
  const allowed = (n.do || []).filter((s) => s.action === 'spawn').map((s) => s.who);
  if (!allowed.includes(who)) {
    return pre('deny', `Orgtomo stage gate: ${keys[0]} is at stage "${n.stage}" (${n.status}). It is not the ${who}'s turn. ${n.say} Allowed now: ${allowed.join(', ') || 'no agent; ' + (n.do?.[0]?.action || 'wait for the human')}.`);
  }
  if (allowed[0] !== who && !(n.do || []).find((s) => s.who === allowed[0])?.optional) return pre('deny', `Orgtomo stage gate: spawn the ${allowed[0]} first; the ${who} comes after.`);
  return null;
}

// ------------------------------------------------------------------ subagents and stop

const runningFile = (root) => path.join(layout(root).state, 'agents-running.json');

/** Entries left behind by sessions that ended without a clean stop. */
function forgetStaleAgents(root) {
  const all = readJson(runningFile(root), {});
  const keep = Object.fromEntries(Object.entries(all).filter(([, v]) => v?.at && now() - new Date(v.at) < 12 * 3_600_000));
  if (Object.keys(keep).length !== Object.keys(all).length) writeJson(runningFile(root), keep);
}

function subagentStart(root, cfg, input) {
  const all = readJson(runningFile(root), {});
  all[input.agent_id || input.agent_type] = { agent: actorOf(input, cfg), at: nowIso() };
  writeJson(runningFile(root), all);
  return null;
}

function subagentStop(root, cfg, input) {
  const agent = actorOf(input, cfg);
  const all = readJson(runningFile(root), {});
  const started = all[input.agent_id || input.agent_type]?.at || '';
  delete all[input.agent_id || input.agent_type];
  writeJson(runningFile(root), all);
  if (input.stop_hook_active || process.env.ORGTOMO_GUARDS === 'off') return null;
  const owned = stagesOf(root).filter((s) => s.owner === agent).map((s) => s.id);
  if (!owned.length) return null;
  for (const t of listTickets(root).filter((x) => x.status === 'running' && owned.includes(x.stage))) {
    const st = t.stages[t.stage];
    const submitted = st?.submitted_at && st.submitted_at >= started;
    if (!submitted) {
      return { decision: 'block', reason: `You have not submitted your work for ${t.key}. Write both output files, then run: orgtomo submit ${t.key} ${t.stage}. If a tool, a login or an org is broken, do not submit a half result: run orgtomo block ${t.key} --reason "<exact message and what would fix it>" and stop. If information is missing, write the open question in your output and submit; the gates route it to the human.` };
    }
    if (st.status === 'gates_failed' && st.attempts < Number(cfg.pipeline.attempts?.max ?? 2)) {
      return { decision: 'block', reason: `Your submission for ${t.key} failed its gates. Read vault/tickets/${t.key}/verify-${t.stage}.md, fix exactly those points, and submit again.` };
    }
  }
  return null;
}

function stop(root, cfg, input) {
  if (input.stop_hook_active || process.env.ORGTOMO_GUARDS === 'off' || cfg.pipeline.keep_going === false) return null;
  if (String(input.agent_type || '') !== 'tomo-lead') return null;
  for (const t of listTickets(root).filter((x) => x.status === 'running')) {
    const n = next(root, cfg, t.key);
    const step = (n.do || [])[0];
    if (step && step.who !== 'human') return { decision: 'block', reason: `${t.key} is not at a human gate yet. Continue: run \`orgtomo next ${t.key}\` and do what it says (${step.who}: ${step.action}).` };
  }
  return null;
}

/** Read stdin, handle, print. Used by engine/hook.js. */
export async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  let out;
  try { out = handle(input); } catch (e) {
    out = input.hook_event_name === 'PreToolUse' ? pre('deny', `Orgtomo guard: internal error, denied to be safe (${e.message})`) : null;
  }
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

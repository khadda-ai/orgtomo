#!/usr/bin/env node
// Orgtomo command line. Agents call it through Bash; humans call it in a
// terminal. Output is JSON so that agents read facts, not prose.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, requireWorkspace, layout } from './lib/paths.js';
import { requireConfig, loadConfig, setConfigValue, org as getOrg, EFFORTS } from './lib/config.js';
import * as T from './lib/ticket.js';
import * as O from './lib/org.js';
import * as B from './lib/brain.js';
import * as L from './lib/learning.js';
import * as P from './lib/people.js';
import * as M from './lib/meetings.js';
import { addEvidence, listEvidence, readEvidencePayload } from './lib/evidence.js';
import { buildPack } from './lib/deploypack.js';
import { sync } from './lib/sync.js';
import { doctor } from './lib/doctor.js';
import { setup, wizard } from './lib/setup.js';
import { validateContract } from './lib/schema.js';
import { recordCanary } from './lib/canary.js';
import { checkWebFetch } from './lib/guards/mcp.js';
import { scanText, describeFindings } from './lib/guards/data.js';
import { exists, readJson, readText, sha256File, fail, OrgtomoError } from './lib/util.js';

const argv = process.argv.slice(2);
const actor = process.env.ORGTOMO_ACTOR || null;

/** Split argv into positionals and --flags (repeatable flags become arrays). */
function parseArgs(args) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const v = inline !== undefined ? inline : args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true;
      opt[k] = k in opt ? [].concat(opt[k], v) : v;
    } else pos.push(a);
  }
  return { pos, opt };
}
const list = (v) => (v === undefined || v === true ? [] : [].concat(v));
const print = (v) => process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);

function requireHuman(what) {
  if (actor || process.env.CLAUDECODE || !process.stdin.isTTY) {
    fail(`"${what}" is a human action. Type the matching /orgtomo: command in Claude Code, use the UI, or run it yourself in a terminal.`, 'HUMAN_ONLY');
  }
}
const need = (v, what) => (v === undefined || v === true || v === '' ? fail(`Missing ${what}.`) : v);
const ticketOf = (root, key) => (key ? T.loadTicket(root, key) : null);

async function run() {
  const [cmd, sub, ...rest] = argv;
  const { pos, opt } = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help') return print(readText(path.join(PLUGIN_ROOT, 'docs', 'COMMANDS.md')));
  if (cmd === 'version' || cmd === '--version') return print(readJson(path.join(PLUGIN_ROOT, 'package.json')).version);

  if (cmd === 'setup') {
    requireHuman('orgtomo setup');
    const all = parseArgs([sub, ...rest].filter(Boolean));
    const root = path.resolve(all.pos[0] || '.');
    const fresh = !exists(path.join(root, 'orgtomo.config'));
    const answers = fresh && !all.opt.yes ? await wizard() : undefined;
    return print(setup(root, { answers }));
  }
  const root = requireWorkspace();
  if (cmd === 'doctor') return print(doctor(root, { orgs: argv.includes('--orgs') }));
  const cfg = cmd === 'config' || cmd === 'sync' ? loadConfig(root) : requireConfig(root);

  switch (cmd) {
    case 'start': {
      requireHuman('orgtomo start');
      const r = spawnSync('claude', ['--agent', 'tomo-lead', ...argv.slice(1)], { stdio: 'inherit', cwd: root });
      if (r.error) fail('Could not start Claude Code ("claude" not found on PATH).');
      return process.exit(r.status ?? 0);
    }
    case 'ui': {
      requireHuman('orgtomo ui');
      const { startUi } = await import('./lib/ui-server.js');
      return startUi(root, { port: Number(parseArgs(argv.slice(1)).opt.port || 4310) });
    }
    case 'sync': return print(sync(root, requireConfig(root)));
    case 'status': return print(sub ? { ...T.summary(T.loadTicket(root, sub)), next: T.next(root, cfg, sub) } : T.listTickets(root).map(T.summary));
    case 'next': return print(T.next(root, cfg, need(sub, 'ticket key')));
    case 'submit': return print(T.submit(root, cfg, need(sub, 'ticket key'), need(pos[0], 'stage'), { actor }));
    case 'verify': return print(T.leadVerify(root, cfg, need(sub, 'ticket key'), need(pos[0], 'stage'), { claim: opt.claim, evidence: need(opt.evidence, '--evidence'), result: opt.result, note: opt.note === true ? '' : opt.note, actor }));
    case 'ticket': {
      const key = need(pos[0], 'ticket key');
      if (sub === 'open') return print({ ...T.summary(T.openTicket(root, cfg, { key, lite: Boolean(opt.lite) })), next: `orgtomo next ${key}` });
      if (sub === 'import') {
        const data = opt.file ? readJson(path.resolve(root, opt.file)) : JSON.parse(need(opt.json, '--json or --file'));
        return print({ ...T.summary(T.importTicket(root, cfg, key, data, { actor })), next: `orgtomo brain pack ${key}  then  orgtomo next ${key}` });
      }
      break;
    }
    case 'baseline': {
      const key = need(pos[0], 'ticket key');
      const c = readJson(path.join(layout(root).ticketDir(key), '00-baseline.json'), null) || fail('00-baseline.json not found.');
      const errors = validateContract(c, 'baseline');
      const ev = listEvidence(root, key);
      for (const b of c.backups) if (b.status === 'backed_up' && !ev.some((e) => e.id === b.evidence && e.kind === 'backup')) errors.push(`${b.ref}: ${b.evidence || 'no evidence'} is not a backup in the ledger`);
      for (const t of c.tests) if (t.evidence && !ev.some((e) => e.id === t.evidence && e.kind === 'apex-test')) errors.push(`${t.name}: ${t.evidence} is not a test run in the ledger`);
      return print(errors.length ? { ok: false, errors } : { ok: true, next: `orgtomo next ${key}` });
    }
    case 'evidence': {
      const key = need(pos[0], 'ticket key');
      T.loadTicket(root, key);
      if (sub === 'list') return print(listEvidence(root, key).map(({ id, kind, org, actor: a, at, ok, summary }) => ({ id, kind, org, actor: a, at, ok, summary })));
      if (sub === 'show') return print(readEvidencePayload(root, key, need(pos[1], 'evidence id')));
      if (sub === 'brain') {
        const ref = need(pos[1], 'component (Type:Name)');
        const orgName = opt.org || (exists(path.join(layout(root).orgVault(cfg.pipeline.build_org), '_index.json')) ? cfg.pipeline.build_org : cfg.pipeline.brain_base);
        const fact = B.brainFact(root, cfg, orgName, ref);
        if (!fact.fresh) fail(`The Brain fact for ${ref} is out of date (the source changed after the Brain was built). Run: orgtomo brain build ${orgName}`, 'STALE');
        return print({ evidence: addEvidence(root, key, { kind: 'brain', org: orgName, actor, command: `brain ${ref}`, summary: `${ref} as recorded in the Org Brain of ${orgName} (fresh)`, payload: fact }).id, fact });
      }
      if (sub === 'doc') {
        const url = need(opt.url, '--url');
        const quote = String(need(opt.quote, '--quote'));
        const g = checkWebFetch(url, cfg);
        if (g.decision === 'deny') fail(g.reason, 'NOT_OFFICIAL');
        let verified = 'unreachable';
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
          const text = (await res.text()).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').toLowerCase();
          verified = text.includes(quote.replace(/\s+/g, ' ').toLowerCase());
        } catch { /* offline or blocked: recorded as unreachable */ }
        const e = addEvidence(root, key, { kind: 'doc', actor, command: url, summary: `Official doc: ${new URL(url).hostname}${verified === true ? ' (quote found on the page)' : verified === false ? ' (quote NOT found in the page source; a human should open the link)' : ' (page could not be fetched; a human should open the link)'}`, payload: { url, quote, quote_verified: verified } });
        return print({ evidence: e.id, quote_verified: verified });
      }
      if (sub === 'file') {
        const p = path.resolve(root, need(opt.path, '--path'));
        if (!exists(p)) fail(`File not found: ${opt.path}`);
        const kind = opt.kind === 'browser' ? 'browser' : opt.kind === 'analyzer' ? 'analyzer' : 'file';
        const small = fs.statSync(p).size < 300_000 && !/\.(png|jpe?g|gif|pdf|webm|zip)$/i.test(p);
        if (small) { const hits = scanText(readText(p), cfg.safety); if (hits.length) fail(`Data guard: ${describeFindings(hits)}`, 'DATA_GUARD'); }
        const e = addEvidence(root, key, { kind, org: opt.org || null, actor, command: path.relative(root, p), summary: `${kind === 'browser' ? 'Browser capture' : 'File'} recorded by ${actor || 'human'}: ${opt.note === true || !opt.note ? path.basename(p) : opt.note}`, payload: { file: path.relative(root, p), file_sha256: sha256File(p), captured_by_agent: Boolean(actor) } });
        return print({ evidence: e.id });
      }
      break;
    }
    case 'org': {
      const key = opt.ticket && opt.ticket !== true ? opt.ticket : null;
      if (sub === 'info') return print(O.info(root, cfg, need(pos[0], 'org')));
      if (sub === 'verify') return print(O.verifyOrg(root, cfg, need(pos[0], 'org')));
      if (sub === 'query') return print(O.query(root, cfg, { org: need(pos[0], 'org'), soql: need(pos[1], 'SOQL'), key, tooling: Boolean(opt.tooling), actor }));
      if (sub === 'retrieve') return print(O.retrieve(root, cfg, { org: need(pos[0], 'org'), refs: pos.slice(1), outDir: path.join(layout(root).state, 'tmp', 'retrieve', pos[0], String(Date.now())), key, actor }));
      if (sub === 'backup') return print(O.backup(root, cfg, { key: need(pos[0], 'ticket key'), refs: pos.slice(1), actor }));
      if (sub === 'deploy') {
        if (actor && !['builder', 'human'].includes(actor)) fail('Only the Builder deploys to the build org.', 'WRONG_ACTOR');
        return print(O.deploy(root, cfg, { key: need(pos[0], 'ticket key'), paths: pos.slice(1), checkOnly: Boolean(opt.check), tests: list(opt.test), actor, ticket: ticketOf(root, pos[0]) }));
      }
      if (sub === 'apex-run') return print(O.apexRun(root, cfg, { org: need(pos[0], 'org'), file: need(opt.file, '--file'), key, actor }));
      if (sub === 'test') return print(O.apexTest(root, cfg, { org: need(pos[0], 'org'), classes: list(opt.class), tests: list(opt.test), key, actor }));
      if (sub === 'canary') return print(O.canary(root, cfg, need(pos[0], 'org')));
      break;
    }
    case 'brain': {
      if (sub === 'build') return print(B.buildBrain(root, cfg, pos[0] || cfg.pipeline.brain_base));
      if (sub === 'status') return print((pos[0] ? [pos[0]] : Object.keys(cfg.orgs.orgs)).map((o) => B.brainStatus(root, cfg, o)));
      if (sub === 'search') return print(B.search(root, cfg, need(pos[0], 'org'), pos.slice(1)));
      if (sub === 'fact') return print(B.brainFact(root, cfg, need(pos[0], 'org'), need(pos[1], 'component')));
      if (sub === 'drift') return print(B.drift(root, cfg, need(pos[0], 'base org'), need(pos[1], 'other org')));
      if (sub === 'pack') {
        const key = need(pos[0], 'ticket key');
        const dir = layout(root).ticketDir(key);
        const tk = readJson(path.join(dir, '00-ticket.json'), {});
        const u = readJson(path.join(dir, '01-understanding.json'), {});
        const words = [...pos.slice(1), ...String(tk.title || '').split(/[^A-Za-z0-9_]+/)].filter((w) => w.length > 3);
        return print(B.contextPack(root, cfg, key, { terms: words, refs: (u.affected || []).map((a) => a.component) }));
      }
      if (sub === 'retrieve') {
        const o = getOrg(cfg, pos[0] || cfg.pipeline.brain_base);
        const dir = path.join(root, cfg.pipeline.source_dir || 'source', o.name);
        const types = [...(cfg.pipeline.brain?.types || []), ...(cfg.pipeline.brain?.standard_objects || []).map((x) => `CustomObject:${x}`)];
        const r = O.runSf(['project', 'retrieve', 'start', '--target-org', o.alias, ...types.flatMap((t) => ['--metadata', t]), '--wait', '60'], { cwd: dir });
        if (!r.ok) fail(`Retrieve from "${o.name}" failed: ${r.message}`, 'SF_ERROR');
        return print({ org: o.name, files: (r.result?.files || []).length, dir: path.relative(root, dir), next: `orgtomo brain build ${o.name}` });
      }
      break;
    }
    case 'handoff': {
      const key = need(pos[0], 'ticket key');
      if (sub === 'pack') return print(buildPack(root, cfg, key));
      if (sub === 'parity') {
        const t = T.loadTicket(root, key);
        const target = t.handoff?.targets[t.handoff.index] || fail(`Ticket ${key} is not in handoff.`);
        if (target.status !== 'deployed') fail(`The human has not confirmed the deploy to ${target.org} yet (/orgtomo:deployed ${target.org} ${key}).`);
        const build = readJson(path.join(layout(root).ticketDir(key), '04-build.json'));
        const result = O.parity(root, cfg, { key, org: target.org, components: build.components, actor });
        return print({ ...result, ...T.recordParity(root, cfg, key, result) });
      }
      break;
    }
    case 'learn': {
      if (sub === 'list') return print(L.listLessons(root));
      if (sub === 'patterns') return print(L.patterns(root));
      if (sub === 'observations') return print(L.listObservations(root, pos[0] ? { ticket: pos[0] } : {}));
      if (sub === 'propose') {
        const key = need(pos[0], 'ticket key');
        if (actor && !['coach', 'human'].includes(actor)) fail('Lessons are proposed by the Coach.', 'WRONG_ACTOR');
        const retro = readJson(path.join(layout(root).ticketDir(key), '09-retro.json'), null) || fail('09-retro.json not found.');
        const errors = validateContract(retro, 'retro');
        if (errors.length) fail(`09-retro.json is not valid:\n- ${errors.join('\n- ')}`, 'BAD_CONTRACT');
        const known = new Set(L.listObservations(root).map((o) => o.id));
        const unknown = [...retro.went_well, ...retro.went_wrong, ...retro.lessons].flatMap((x) => x.observations).filter((id) => !known.has(id));
        if (unknown.length) fail(`These are not recorded observations: ${[...new Set(unknown)].join(', ')}. A retro may cite only what the engine recorded.`, 'NO_EVIDENCE');
        const stored = L.proposeLessons(root, cfg, retro.lessons, { by: 'coach' });
        const t = T.loadTicket(root, key);
        (t.stages.close ||= { status: 'pending', attempts: 0 }).retro_done = true;
        fs.writeFileSync(layout(root).ticketState(key), JSON.stringify(t, null, 2) + '\n');
        sync(root, cfg);
        return print({ stored: stored.map((l) => ({ id: l.id, agent: l.agent, status: l.status, approved_by: l.approved_by })), next: `orgtomo next ${key}` });
      }
      break;
    }
    case 'people': {
      if (sub === 'list') return print({ enabled: P.enabled(cfg), people: P.listPeople(root), proposals: P.listProposals(root) });
      if (sub === 'show') return print(P.findPerson(root, pos.join(' ')) || fail(`No profile for "${pos.join(' ')}".`));
      if (sub === 'brief') return print(P.audienceBrief(root, cfg, pos));
      if (sub === 'propose') return print(P.proposeProfileNote(root, cfg, { person: need(opt.person, '--person'), note: need(opt.note, '--note'), basis: need(opt.basis, '--basis'), actor }));
      break;
    }
    case 'meetings': {
      if (sub === 'plan') return print(M.plan(root, cfg));
      if (sub === 'list') return print(M.listMeetings(root));
      if (sub === 'pending') return print(M.pendingLinks(root));
      if (sub === 'ingest') return print(M.ingest(root, cfg, opt.file ? readJson(path.resolve(root, opt.file)) : JSON.parse(need(opt.json, '--file or --json')), { actor }));
      break;
    }
    case 'config': if (sub === 'show') return print(cfg); break;
    case 'models': if (!sub || sub === 'list') return print(Object.fromEntries(Object.entries(cfg.agents.agents).map(([n, d]) => [n, `${d.model} / ${d.effort}${d.enabled === false ? ' (off)' : ''}`]))); break;
    case 'human': {
      requireHuman(`orgtomo human ${sub}`);
      const key = pos.find((p) => /^[A-Z][A-Z0-9_]*-\d+$/.test(p));
      const others = pos.filter((p) => p !== key);
      const note = others.join(' ');
      const src = { source: 'terminal' };
      if (sub === 'approve') return print(T.human.approve(root, cfg, need(key, 'ticket key'), { note, ...src }));
      if (sub === 'reject') return print(T.human.reject(root, cfg, need(key, 'ticket key'), { note, ...src }));
      if (sub === 'hold') return print(T.human.hold(root, cfg, need(key, 'ticket key'), { note }));
      if (sub === 'resume') return print(T.human.resume(root, cfg, need(key, 'ticket key'), { note, ...src }));
      if (sub === 'answer') return print(T.human.answer(root, cfg, need(key, 'ticket key'), { id: /^(Q\d+|repro)$/i.test(others[0] || '') ? others[0] : '', note: others.slice(/^(Q\d+|repro)$/i.test(others[0] || '') ? 1 : 0).join(' '), ...src }));
      if (sub === 'deployed') return print(T.human.deployed(root, cfg, need(key, 'ticket key'), { org: others[0], ...src }));
      if (sub === 'feedback') return print(T.human.feedback(root, cfg, key, { kind: others[0], agent: others[1], note: others.slice(2).join(' ') }));
      if (sub === 'restore') return print(O.restore(root, cfg, { key: need(key, 'ticket key') }));
      if (sub === 'canary') return print(recordCanary(root, getOrg(cfg, need(others[0], 'org')).name, need(others[1], 'blocked|enabled'), 'human', 'stated by the human'));
      if (sub === 'lesson') { const r = L.setLessonStatus(root, need(others[1], 'lesson id'), others[0] === 'approve' ? 'approved' : 'retired'); sync(root, cfg); return print(r); }
      if (sub === 'model') {
        const [agent, model, effort] = others;
        if (model && !EFFORTS.includes(model)) setConfigValue(root, 'agents', `agents.${agent}.model`, model);
        const eff = EFFORTS.includes(model) ? model : effort;
        if (eff) setConfigValue(root, 'agents', `agents.${agent}.effort`, eff);
        return print(sync(root, loadConfig(root)));
      }
      break;
    }
    default: break;
  }
  fail(`Unknown command: orgtomo ${[cmd, sub].filter(Boolean).join(' ')}. See: orgtomo help`);
}

run().catch((e) => {
  if (e instanceof OrgtomoError) { process.stderr.write(`${JSON.stringify({ error: e.message, code: e.code })}\n`); process.exit(2); }
  process.stderr.write(`${e.stack || e}\n`);
  process.exit(1);
});

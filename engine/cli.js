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
import * as D from './lib/discover.js';
import * as L from './lib/learning.js';
import * as P from './lib/people.js';
import * as M from './lib/meetings.js';
import { addEvidence, listEvidence, readEvidencePayload } from './lib/evidence.js';
import { buildPack } from './lib/deploypack.js';
import { sync } from './lib/sync.js';
import { doctor } from './lib/doctor.js';
import { setup, wizard } from './lib/setup.js';
import { validateContract, describeContract } from './lib/schema.js';
import { recordCanary } from './lib/canary.js';
import { checkWebFetch } from './lib/guards/mcp.js';
import { scanText, describeFindings } from './lib/guards/data.js';
import { requestBrowserSignIn, browserSessions } from './lib/hook.js';
import { loadCatalogue, refreshModels, modelOptions } from './lib/models.js';
import { obsidianStatus, obsidianInstall } from './lib/obsidian.js';
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

/** JSON from --file <path>, from standard input (--file -) or from --json <text>. */
function readInputJson(root, opt) {
  if (opt.file !== undefined) {
    const f = need(opt.file, 'a path after --file (use "-" to read standard input)');
    const abs = path.resolve(root, String(f));
    const text = f === '-' ? fs.readFileSync(0, 'utf8') : exists(abs) ? readText(abs) : fail(`File not found: ${f}`, 'NOT_FOUND');
    try { return JSON.parse(text); } catch (e) { return fail(`${f === '-' ? 'Standard input' : f} is not valid JSON: ${e.message}`, 'BAD_JSON'); }
  }
  const raw = need(opt.json, 'the input: --file <path>, --file - (standard input) or --json <text>');
  try { return JSON.parse(raw); } catch (e) { return fail(`--json is not valid JSON: ${e.message}`, 'BAD_JSON'); }
}

const TOOL_TROUBLE = ['SF_ERROR', 'ORG_UNREACHABLE', 'NO_SF', 'ORG_CHANGED'];
/**
 * Run an engine command on behalf of a ticket. When it fails for a reason the
 * agent cannot fix (the CLI broke, the org did not answer), count it; the
 * second failure in a row blocks the ticket instead of letting agents retry.
 */
function forTicket(root, cfg, key, label, fn) {
  if (!key) return fn();
  try {
    const out = fn();
    T.noteToolSuccess(root, key, label);
    return out;
  } catch (e) {
    if (e instanceof OrgtomoError && TOOL_TROUBLE.includes(e.code)) {
      const blocked = T.noteToolFailure(root, cfg, key, label, e);
      if (blocked) throw new OrgtomoError(`${e.message} This failed twice, so ticket ${key} is now blocked. Tell the human; do not retry.`, 'BLOCKED');
    }
    throw e;
  }
}

function brainRetrieve(root, cfg, orgName, types) {
  const o = getOrg(cfg, orgName);
  const dir = path.join(root, cfg.pipeline.source_dir || 'source', o.name);
  const r = O.runSf(['project', 'retrieve', 'start', '--target-org', o.alias, ...types.flatMap((t) => ['--metadata', t]), '--wait', '60'], { cwd: dir });
  if (!r.ok) fail(`Retrieve from "${o.name}" failed: ${r.message}`, 'SF_ERROR');
  return { org: o.name, files: (r.result?.files || []).length, dir: path.relative(root, dir) };
}
const brainTypes = (cfg) => [...(cfg.pipeline.brain?.types || []), ...(cfg.pipeline.brain?.standard_objects || []).map((x) => `CustomObject:${x}`)];

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
    const out = setup(root, { answers });
    if (answers?.extras?.obsidian) out.obsidian = obsidianInstall(root);
    return print(out);
  }
  if (cmd === 'contract') {
    if (sub === 'show') return print(describeContract(need(pos[0], 'contract name (ticket, understanding, repro, plan, build, qa, review, baseline, comms, retro)')));
    fail('Use: orgtomo contract show <name>');
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
    case 'block': return print(T.block(root, cfg, need(sub, 'ticket key'), { reason: [need(opt.reason, '--reason "<what failed and what would fix it>"'), ...pos].join(' '), actor, source: actor ? 'agent' : 'human' }));
    case 'ticket': {
      const key = need(pos[0], 'ticket key');
      if (sub === 'open') return print({ ...T.summary(T.openTicket(root, cfg, { key, lite: Boolean(opt.lite) })), next: `orgtomo next ${key}` });
      if (sub === 'import') {
        const data = readInputJson(root, opt);
        return print({ ...T.summary(T.importTicket(root, cfg, key, data, { actor })), next: `orgtomo brain pack ${key}  then  orgtomo next ${key}` });
      }
      break;
    }
    case 'baseline': {
      const key = need(pos[0], 'ticket key');
      const dir = layout(root).ticketDir(key);
      const c = readJson(path.join(dir, '00-baseline.json'), null) || fail('00-baseline.json not found.');
      const errors = validateContract(c, 'baseline');
      if (errors.length) return print({ ok: false, errors });
      const ev = listEvidence(root, key);
      for (const b of c.backups) if (b.status === 'backed_up' && !ev.some((e) => e.id === b.evidence && e.kind === 'backup')) errors.push(`${b.ref}: ${b.evidence || 'no evidence'} is not a backup in the ledger`);
      for (const t of c.tests) if (t.evidence && !ev.some((e) => e.id === t.evidence && e.kind === 'apex-test')) errors.push(`${t.name}: ${t.evidence} is not a test run in the ledger`);
      const plan = readJson(path.join(dir, '03-plan.json'), {});
      for (const cls of plan.regression_tests || []) if (!c.tests.some((t) => t.name.startsWith(`${cls}.`))) errors.push(`${cls} is named in the plan's regression_tests and was not run`);
      const failed = c.backups.filter((b) => b.status === 'failed');
      if (failed.length) return print({ ok: false, errors, backup_failed: failed.map((b) => b.ref), next: `A backup that fails is not yours to fix. Run: orgtomo block ${key} --reason "Backup failed for ${failed.map((b) => b.ref).join(', ')}: <the exact message>"` });
      return print(errors.length ? { ok: false, errors } : { ok: true, next: `orgtomo next ${key}` });
    }
    case 'evidence': {
      const key = need(pos[0], 'ticket key');
      T.loadTicket(root, key);
      if (sub === 'list') return print(listEvidence(root, key).map(({ id, kind, org, actor: a, at, ok, summary }) => ({ id, kind, org, actor: a, at, ok, summary })));
      if (sub === 'show') return print(readEvidencePayload(root, key, need(pos[1], 'evidence id')));
      if (sub === 'brain') {
        const ref = need(pos[1], 'component (Type:Name)');
        const orgName = opt.org && opt.org !== true ? opt.org : B.packOrg(root, cfg);
        const fact = B.brainFact(root, cfg, orgName, ref);
        if (!fact.fresh) fail(`The Brain fact for ${ref} is out of date (the source changed after the Brain was built). Run: orgtomo brain build ${orgName}`, 'STALE');
        return print({ evidence: addEvidence(root, key, { kind: 'brain', org: orgName, actor, command: `brain ${ref}`, summary: `${ref} as recorded in the Org Brain of ${orgName} (fresh)`, payload: fact }).id, fact });
      }
      if (sub === 'doc') {
        const url = String(need(opt.url, '--url'));
        const quote = String(need(opt.quote, '--quote'));
        const g = checkWebFetch(url, cfg);
        if (g.decision === 'deny') fail(g.reason, 'NOT_OFFICIAL');
        let verified = 'unreachable';
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
          const raw = await res.text();
          const flat = (s) => s.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').toLowerCase();
          const wanted = flat(quote);
          // Many documentation pages are built in the browser, so the text may sit in the page source rather than in the visible markup: look in both.
          verified = flat(raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).includes(wanted) || flat(raw).includes(wanted);
        } catch { /* offline or blocked: recorded as unreachable */ }
        const e = addEvidence(root, key, { kind: 'doc', actor, command: url, summary: `Official doc: ${new URL(url).hostname}${verified === true ? ' (quote found on the page)' : verified === false ? ' (quote NOT found in the page source; a human should open the link)' : ' (page could not be fetched; a human should open the link)'}`, payload: { url, quote, quote_verified: verified }, meta: { quote_verified: verified } });
        return print({ evidence: e.id, quote_verified: verified, note: verified === true ? undefined : 'The engine could not confirm this quote. The citation is recorded as unconfirmed and the human is told at the next approval.' });
      }
      if (sub === 'file') {
        const p = path.resolve(root, String(need(opt.path, '--path')));
        if (!exists(p)) fail(`File not found: ${opt.path}`, 'NOT_FOUND');
        const kind = opt.kind === 'browser' ? 'browser' : opt.kind === 'analyzer' ? 'analyzer' : 'file';
        const small = fs.statSync(p).size < 300_000 && !/\.(png|jpe?g|gif|pdf|webm|zip)$/i.test(p);
        if (small) { const hits = scanText(readText(p), cfg.safety); if (hits.length) fail(`Data guard: ${describeFindings(hits)}`, 'DATA_GUARD'); }
        const e = addEvidence(root, key, { kind, org: opt.org && opt.org !== true ? opt.org : null, actor, command: path.relative(root, p), summary: `${kind === 'browser' ? 'Browser capture' : 'File'} recorded by ${actor || 'human'}: ${opt.note === true || !opt.note ? path.basename(p) : opt.note}`, payload: { file: path.relative(root, p), file_sha256: sha256File(p), captured_by_agent: Boolean(actor) } });
        return print({ evidence: e.id });
      }
      break;
    }
    case 'org': {
      const key = opt.ticket && opt.ticket !== true ? opt.ticket : null;
      if (sub === 'info') return print(O.info(root, cfg, need(pos[0], 'org')));
      if (sub === 'verify') return print(O.verifyOrg(root, cfg, need(pos[0], 'org')));
      if (sub === 'query') return print(O.query(root, cfg, { org: need(pos[0], 'org'), soql: need(pos[1], 'SOQL'), key, tooling: Boolean(opt.tooling), actor }));
      if (sub === 'retrieve') return print(forTicket(root, cfg, key, 'org retrieve', () => O.retrieve(root, cfg, { org: need(pos[0], 'org'), refs: pos.slice(1), outDir: path.join(layout(root).state, 'tmp', 'retrieve', pos[0], String(Date.now())), key, actor })));
      if (sub === 'backup') { const k = need(pos[0], 'ticket key'); return print(forTicket(root, cfg, k, 'org backup', () => O.backup(root, cfg, { key: k, refs: pos.slice(1), actor }))); }
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
      if (sub === 'object') return print(B.objectView(root, cfg, need(pos[0], 'org'), need(pos[1], 'object')));
      if (sub === 'tests') return print(B.testsFor(root, cfg, need(pos[0], 'org'), pos.slice(1).length ? pos.slice(1) : fail('Name at least one component (Type:Name).')));
      if (sub === 'drift') return print(B.drift(root, cfg, need(pos[0], 'base org'), need(pos[1], 'other org')));
      if (sub === 'pack') {
        const key = need(pos[0], 'ticket key');
        const dir = layout(root).ticketDir(key);
        const tk = readJson(path.join(dir, '00-ticket.json'), {});
        const u = readJson(path.join(dir, '01-understanding.json'), {});
        return print(B.contextPack(root, cfg, key, { terms: B.packTerms(tk, pos.slice(1)), refs: (u.affected || []).map((a) => a.component) }));
      }
      if (sub === 'retrieve') { const name = pos[0] || cfg.pipeline.brain_base; return print({ ...brainRetrieve(root, cfg, name, brainTypes(cfg)), next: `orgtomo brain build ${name}` }); }
      if (sub === 'sync') { // retrieve, then build: one command for "bring the Brain up to date"
        const name = pos[0] || cfg.pipeline.brain_base;
        const got = brainRetrieve(root, cfg, name, brainTypes(cfg));
        return print({ retrieved: got.files, ...B.buildBrain(root, cfg, name) });
      }
      break;
    }
    case 'discover': {
      if (!sub || sub === 'status') return print(D.discoverStatus(root, cfg, pos[0]));
      const name = need(pos[0], 'org');
      if (sub === 'run') {
        let retrieved = null;
        if (opt.retrieve) { retrieved = brainRetrieve(root, cfg, name, D.discoverTypes(cfg)).files; B.buildBrain(root, cfg, name); }
        else if (!B.brainStatus(root, cfg, name).exists) fail(`No Org Brain for "${name}" yet. Run: orgtomo discover run ${name} --retrieve`, 'NO_BRAIN');
        let counts = null;
        let counts_note;
        // Counts are totals per object, never record values. They are optional: discovery works without them.
        if (!opt['no-counts']) { try { counts = O.recordCounts(root, cfg, name); } catch (e) { counts_note = `Record counts were not read: ${e.message}`; } }
        return print({ retrieved, counts_note, ...D.runDiscovery(root, cfg, name, { counts }) });
      }
      if (sub === 'next') return print(D.nextDomain(root, cfg, name));
      if (sub === 'check') return print(D.checkProcessNote(root, cfg, name, need(pos[1], 'domain (the slug shown by: orgtomo discover status)')));
      break;
    }
    case 'browser': {
      const b = cfg.safety.browser || {};
      if (!sub || sub === 'status') return print({ provider: b.provider, login: b.login || 'manual', session_minutes: Number(b.session_minutes ?? 60), claude_in_chrome: b.claude_in_chrome === true, sessions: browserSessions(root) });
      if (sub === 'login') {
        const o = getOrg(cfg, need(pos[0], 'org'));
        if (o.role === 'production') fail('Production is never opened in the agent browser.', 'PRODUCTION');
        if (b.login !== 'frontdoor') return print({ org: o.name, login: b.login || 'manual', say: 'Sign-in by one-time link is off (safety.yaml: browser.login). Ask the human to sign in to the agent browser, or block the ticket.' });
        requestBrowserSignIn(root, o.name);
        return print({ org: o.name, say: 'The next page you open in this org goes through a fresh one-time sign-in link. Open the page again. If you still land on a login page, do not try anything else: block the ticket with the reason "browser login".' });
      }
      break;
    }
    case 'obsidian': {
      if (!sub || sub === 'status') return print(obsidianStatus(root));
      if (sub === 'install') { requireHuman('orgtomo obsidian install'); return print(obsidianInstall(root)); }
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
        const result = forTicket(root, cfg, key, 'handoff parity', () => O.parity(root, cfg, { key, org: target.org, components: build.components, actor }));
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
      if (sub === 'ingest') return print(M.ingest(root, cfg, readInputJson(root, opt), { actor }));
      break;
    }
    case 'config': if (sub === 'show') return print(cfg); break;
    case 'models': {
      const cat = loadCatalogue(root);
      if (!sub || sub === 'list') return print({ agents: Object.fromEntries(Object.entries(cfg.agents.agents).map(([n, d]) => [n, `${d.model} / ${d.effort}${d.enabled === false ? ' (off)' : ''}`])), catalogue: { source: cat.source, fetched_at: cat.fetched_at || cat.updated, aliases: cat.aliases } });
      if (sub === 'catalogue') return print({ source: cat.source, fetched_at: cat.fetched_at || cat.updated, options: modelOptions(cat) });
      if (sub === 'refresh') { requireHuman('orgtomo models refresh'); return print(await refreshModels(root)); }
      break;
    }
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
      if (sub === 'org-changed') return print(O.verifyOrg(root, cfg, getOrg(cfg, need(others[0], 'org')).name, { accept: true }));
      if (sub === 'discover-answer') return print(D.answerQuestion(root, cfg, getOrg(cfg, need(others[0], 'org')).name, need(others[1], 'question id'), others.slice(2).join(' ')));
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
  // Anything else is a defect in the engine. Say so in one line; the stack is for whoever debugs it.
  process.stderr.write(`${JSON.stringify({ error: `Internal error: ${e.message}`, code: 'INTERNAL', hint: 'Run again with ORGTOMO_DEBUG=1 to see where it happened, and report it.' })}\n`);
  if (process.env.ORGTOMO_DEBUG) process.stderr.write(`${e.stack || e}\n`);
  process.exit(1);
});

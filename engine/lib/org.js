// Org access layer. Every call to a Salesforce org made by the engine goes
// through here, so the org rules live in one place:
//   - production: read-only, masked, never written
//   - metadata is deployed by agents only to the build org, after a backup
//   - data is written only where allowed, after the data guard and e-mail gate
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { org as getOrg, isProduction, canWriteData, canWriteMetadata, buildOrg } from './config.js';
import { layout, rel } from './paths.js';
import { addEvidence, listEvidence } from './evidence.js';
import { maskRecords, redactInside } from './mask.js';
import { scanText, describeFindings } from './guards/data.js';
import { emailGate, recordCanary } from './canary.js';
import { exists, readJson, writeJson, readText, writeText, listFiles, sha256File, nowIso, fail, uniq } from './util.js';
import { refFromPath, parseRef, sourceGlobsFor } from './metadata.js';

/** Run the Salesforce CLI and return its parsed JSON result. */
export function runSf(args, { cwd } = {}) {
  const bin = process.env.ORGTOMO_SF_BIN || 'sf';
  const res = spawnSync(bin, [...args, '--json'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SF_DISABLE_TELEMETRY: 'true', SFDX_AUTO_DEPLOY: '' } });
  if (res.error) fail(`Could not run the Salesforce CLI ("${bin}"): ${res.error.message}. Is it installed and on PATH?`, 'NO_SF');
  let json;
  try { json = JSON.parse(res.stdout); } catch { json = null; }
  if (!json) return { ok: false, status: res.status ?? 1, message: (res.stderr || res.stdout || '').trim().slice(0, 2000), result: null };
  return { ok: json.status === 0 && res.status === 0, status: json.status, message: json.message || '', name: json.name, result: json.result ?? null };
}

const verifiedFile = (root) => path.join(layout(root).state, 'orgs-verified.json');

/**
 * Ask the org itself whether it is a sandbox. Stored and reused; a write to an
 * org whose own answer is "not a sandbox" is refused whatever orgs.yaml says.
 */
export function verifyOrg(root, cfg, orgName) {
  const o = getOrg(cfg, orgName);
  const r = runSf(['data', 'query', '--target-org', o.alias, '--query', 'SELECT Id, IsSandbox, OrganizationType, InstanceName FROM Organization LIMIT 1']);
  if (!r.ok) fail(`Could not reach "${orgName}" (${o.alias}): ${r.message}`, 'ORG_UNREACHABLE');
  const rec = r.result?.records?.[0] || {};
  const all = readJson(verifiedFile(root), {});
  all[orgName] = { alias: o.alias, org_id: rec.Id, is_sandbox: rec.IsSandbox === true, type: rec.OrganizationType, checked_at: nowIso() };
  writeJson(verifiedFile(root), all);
  if (!all[orgName].is_sandbox && !isProduction(o)) {
    fail(`"${orgName}" reports IsSandbox = false but orgs.yaml gives it role "${o.role}". Treat it as production: set role: production. No write was made.`, 'ROLE_MISMATCH');
  }
  return all[orgName];
}
export const orgVerified = (root, orgName) => readJson(verifiedFile(root), {})[orgName];

function assertWritable(root, cfg, o, what) {
  if (isProduction(o)) fail(`"${o.name}" is production. Orgtomo never writes ${what} to production.`, 'PRODUCTION');
  const v = orgVerified(root, o.name) || verifyOrg(root, cfg, o.name);
  if (!v.is_sandbox) fail(`"${o.name}" is not a sandbox according to the org itself. No ${what} is written there.`, 'PRODUCTION');
}

/** Read-only SOQL. Results are masked before they are returned or stored. */
export function query(root, cfg, { org: orgName, soql, key, tooling = false, actor }) {
  const o = getOrg(cfg, orgName);
  const q = String(soql || '').trim();
  if (!/^select\s/i.test(q) || /;/.test(q)) fail('Only a single SELECT statement is allowed.', 'NOT_SELECT');
  if (!/\blimit\s+\d+/i.test(q) && !/\bcount\s*\(/i.test(q)) fail('Add a LIMIT (reads are bounded on purpose).', 'NO_LIMIT');
  const args = ['data', 'query', '--target-org', o.alias, '--query', q];
  if (tooling) args.push('--use-tooling-api');
  const r = runSf(args);
  if (!r.ok) fail(`Query failed on "${orgName}": ${r.message}`, 'SF_ERROR');
  const mask = isProduction(o) || cfg.safety.mask?.mask_sandbox_reads !== false;
  const records = mask && !tooling ? maskRecords(r.result.records, cfg.safety) : (r.result.records || []).map(({ attributes, ...rest }) => rest);
  const out = { org: orgName, total: r.result.totalSize, masked: mask && !tooling, records };
  if (key) out.evidence = addEvidence(root, key, { kind: 'soql', org: orgName, actor, command: q, summary: `${out.total} row(s) from ${orgName}`, payload: out, meta: { tooling } }).id;
  return out;
}

/** Sanitised org facts. Never returns a token. */
export function info(root, cfg, orgName) {
  const o = getOrg(cfg, orgName);
  const v = verifyOrg(root, cfg, orgName);
  return { name: orgName, alias: o.alias, role: o.role, is_sandbox: v.is_sandbox, type: v.type, org_id: v.org_id, host: o.host || null };
}

/** Retrieve metadata (read-only) into a folder. refs: ["ApexClass:Foo", ...] */
export function retrieve(root, cfg, { org: orgName, refs, outDir, key, actor, kind = 'retrieve' }) {
  const o = getOrg(cfg, orgName);
  if (!refs?.length) fail('Nothing to retrieve.');
  fs.mkdirSync(outDir, { recursive: true });
  const args = ['project', 'retrieve', 'start', '--target-org', o.alias, '--output-dir', outDir];
  for (const ref of refs) args.push('--metadata', ref);
  const projectDir = sfdxProjectDir(root, cfg);
  const r = runSf(args, { cwd: projectDir });
  if (!r.ok) fail(`Retrieve from "${orgName}" failed: ${r.message}`, 'SF_ERROR');
  const files = listFiles(outDir).map((f) => ({ file: f, sha256: sha256File(path.join(outDir, f)) }));
  const found = uniq(files.map((f) => refFromPath(f.file)).filter(Boolean));
  const out = { org: orgName, requested: refs, found, missing: refs.filter((x) => !found.includes(x)), dir: rel(root, outDir), files };
  if (key) out.evidence = addEvidence(root, key, { kind, org: orgName, actor, command: `retrieve ${refs.join(' ')}`, summary: `${found.length}/${refs.length} component(s) retrieved from ${orgName}`, payload: out }).id;
  return out;
}

/** Folder that holds sfdx-project.json for the build org source. */
export function sfdxProjectDir(root, cfg) {
  const dir = path.join(root, cfg.pipeline.source_dir || 'source', cfg.pipeline.build_org);
  return exists(path.join(dir, 'sfdx-project.json')) ? dir : root;
}

/** Back up the current org version of components before they are changed. */
export function backup(root, cfg, { key, refs, actor }) {
  const o = buildOrg(cfg);
  const outDir = path.join(layout(root).ticketDir(key), 'backup', o.name);
  const done = new Set(listEvidence(root, key).filter((e) => e.kind === 'backup').flatMap((e) => e.meta.refs || []));
  const todo = refs.filter((r) => !done.has(r));
  if (!todo.length) return { org: o.name, backed_up: [], new: [], note: 'All components already have a backup.' };
  const r = retrieve(root, cfg, { org: o.name, refs: todo, outDir, key: null });
  const ev = addEvidence(root, key, {
    kind: 'backup', org: o.name, actor, command: `backup ${todo.join(' ')}`,
    summary: `Backup of ${r.found.length} existing component(s); ${r.missing.length} do not exist yet`,
    payload: r, meta: { refs: todo, found: r.found, missing: r.missing },
  });
  return { org: o.name, backed_up: r.found, new: r.missing, evidence: ev.id, dir: r.dir };
}

/** Deploy to the build org. Refuses without a backup of every existing component. */
export function deploy(root, cfg, { key, paths, checkOnly = false, tests = [], actor, ticket }) {
  const o = buildOrg(cfg);
  if (!canWriteMetadata(o)) fail(`"${o.name}" does not accept metadata from agents.`, 'NOT_BUILD_ORG');
  assertWritable(root, cfg, o, 'metadata');
  if (!ticket || ticket.stage !== 'build') fail('Deploys to the build org happen only while the ticket is in the build stage.', 'WRONG_STAGE');
  if (!paths?.length) fail('Give the source paths to deploy.');
  const srcRoot = path.join(cfg.pipeline.source_dir || 'source', o.name);
  const files = [];
  for (const p of paths) {
    const abs = path.resolve(root, p);
    const r = rel(root, abs);
    if (!r.startsWith(srcRoot + '/') && r !== srcRoot) fail(`Only files under ${srcRoot}/ can be deployed (got ${p}).`);
    if (!exists(abs)) fail(`Path not found: ${p}`);
    if (fs.statSync(abs).isDirectory()) files.push(...listFiles(abs).map((f) => `${r}/${f}`)); else files.push(r);
  }
  const refs = uniq(files.map((f) => refFromPath(f)).filter(Boolean));
  const backedUp = new Set(listEvidence(root, key).filter((e) => e.kind === 'backup').flatMap((e) => e.meta.refs || []));
  const missing = refs.filter((r) => !backedUp.has(r));
  if (missing.length) fail(`Backup first. No backup recorded for: ${missing.join(', ')}. Run: orgtomo org backup ${key} ${missing.map((m) => `"${m}"`).join(' ')}`, 'NO_BACKUP');
  const dataHits = files.flatMap((f) => scanText(readText(path.join(root, f)), cfg.safety));
  if (dataHits.length) fail(`Data guard: ${describeFindings(dataHits)}`, 'DATA_GUARD');

  const args = ['project', 'deploy', 'start', '--target-org', o.alias, '--wait', '30'];
  for (const p of paths) args.push('--source-dir', path.resolve(root, p));
  if (checkOnly) args.push('--dry-run');
  if (tests.length) { args.push('--test-level', 'RunSpecifiedTests'); for (const t of tests) args.push('--tests', t); }
  const r = runSf(args, { cwd: sfdxProjectDir(root, cfg) });
  const failures = (r.result?.details?.componentFailures || r.result?.files?.filter?.((f) => f.state === 'Failed') || []).map((f) => ({ name: f.fullName, type: f.componentType || f.type, problem: f.problem || f.error }));
  const ev = addEvidence(root, key, {
    kind: 'deploy', org: o.name, actor, ok: r.ok, command: `deploy ${paths.join(' ')}${checkOnly ? ' (check only)' : ''}`,
    summary: r.ok ? `${checkOnly ? 'Check-only deploy' : 'Deploy'} of ${refs.length} component(s) to ${o.name} succeeded` : `Deploy to ${o.name} failed: ${failures.length} failure(s)`,
    payload: { refs, failures, message: r.message, status: r.result?.status, tests },
    meta: { check_only: checkOnly, refs, files: files.map((f) => ({ file: f, sha256: sha256File(path.join(root, f)) })) },
  });
  return { ok: r.ok, org: o.name, check_only: checkOnly, components: refs, failures, message: r.ok ? undefined : r.message, evidence: ev.id };
}

/** Run anonymous Apex from a file in an org where test data is allowed. */
export function apexRun(root, cfg, { org: orgName, file, key, actor }) {
  const o = getOrg(cfg, orgName);
  if (!canWriteData(o)) fail(`Agents may not run Apex in "${orgName}" (role ${o.role}).`, 'NO_DATA_WRITE');
  assertWritable(root, cfg, o, 'data');
  const abs = path.resolve(root, file);
  if (!exists(abs)) fail(`File not found: ${file}`);
  const code = readText(abs);
  const hits = scanText(code, cfg.safety);
  if (hits.length) fail(`Data guard: ${describeFindings(hits)}`, 'DATA_GUARD');
  const gate = emailGate(root, cfg, o);
  if (!gate.ok) fail(gate.reason, 'EMAIL_GATE');
  const r = runSf(['apex', 'run', '--target-org', o.alias, '--file', abs]);
  const res = r.result || {};
  const debug = redactInside(String(res.logs || '').split('\n').filter((l) => /USER_DEBUG|EXCEPTION_THROWN|FATAL_ERROR|DML_BEGIN|SOQL_EXECUTE_BEGIN/.test(l)).slice(0, 400).join('\n'), cfg.safety);
  const ok = r.ok && res.success !== false && res.compiled !== false;
  const out = { ok, org: orgName, compiled: res.compiled, success: res.success, problem: res.compileProblem || res.exceptionMessage || (r.ok ? null : r.message), debug };
  if (key) out.evidence = addEvidence(root, key, { kind: 'apex-run', org: orgName, actor, ok, command: `apex run ${rel(root, abs)}`, summary: ok ? `Anonymous Apex ran on ${orgName}` : `Anonymous Apex failed on ${orgName}`, payload: { ...out, code_sha256: sha256File(abs) } }).id;
  return out;
}

/** Run Apex tests and record per-method outcomes. */
export function apexTest(root, cfg, { org: orgName, classes = [], tests = [], key, actor }) {
  const o = getOrg(cfg, orgName);
  if (isProduction(o)) fail('Tests are never started in production by Orgtomo.', 'PRODUCTION');
  if (!classes.length && !tests.length) fail('Name the test classes (--class) or methods (--test). Running every test in the org is a human decision.');
  const args = ['apex', 'run', 'test', '--target-org', o.alias, '--result-format', 'json', '--code-coverage', '--wait', '30'];
  for (const c of classes) args.push('--class-names', c);
  for (const t of tests) args.push('--tests', t);
  const r = runSf(args);
  const res = r.result || {};
  const methods = (res.tests || []).map((t) => ({ name: `${t.ApexClass?.Name || t.apexClass?.name || ''}.${t.MethodName || t.methodName}`, outcome: /pass/i.test(t.Outcome || t.outcome) ? 'pass' : 'fail', message: redactInside(t.Message || t.message || '', cfg.safety) || undefined }));
  const ok = methods.length > 0 && methods.every((m) => m.outcome === 'pass');
  const out = { ok, org: orgName, summary: { ran: methods.length, passed: methods.filter((m) => m.outcome === 'pass').length, failed: methods.filter((m) => m.outcome === 'fail').length, coverage: res.summary?.testRunCoverage ?? null }, methods, problem: methods.length ? undefined : r.message };
  if (key) out.evidence = addEvidence(root, key, { kind: 'apex-test', org: orgName, actor, ok, command: `apex test ${[...classes, ...tests].join(' ')}`, summary: `${out.summary.passed}/${out.summary.ran} test method(s) passed on ${orgName}`, payload: out }).id;
  return out;
}

/** Probe whether the org can send e-mail right now. */
export function canary(root, cfg, orgName) {
  const o = getOrg(cfg, orgName);
  if (isProduction(o)) fail('The canary is never run in production.', 'PRODUCTION');
  const file = path.join(layout(root).state, 'tmp', 'canary.apex');
  writeText(file, [
    '// Orgtomo e-mail canary. Changes nothing: it only asks whether single e-mail could be sent.',
    'try { Messaging.reserveSingleEmailCapacity(1); System.debug(LoggingLevel.ERROR, \'ORGTOMO_CANARY:ENABLED\'); }',
    'catch (Exception e) { System.debug(LoggingLevel.ERROR, \'ORGTOMO_CANARY:BLOCKED:\' + e.getTypeName()); }',
  ].join('\n') + '\n');
  const r = runSf(['apex', 'run', '--target-org', o.alias, '--file', file]);
  const logs = String(r.result?.logs || '');
  const status = /ORGTOMO_CANARY:BLOCKED/.test(logs) ? 'blocked' : /ORGTOMO_CANARY:ENABLED/.test(logs) ? 'enabled' : 'unknown';
  return { org: orgName, ...recordCanary(root, orgName, status, 'probe', status === 'unknown' ? (r.message || 'no canary marker in the log').slice(0, 300) : '') };
}

/** Compare components in a target org with the built source. Read-only. */
export function parity(root, cfg, { key, org: orgName, components, actor }) {
  const o = getOrg(cfg, orgName);
  const outDir = path.join(layout(root).state, 'tmp', 'parity', key, orgName);
  fs.rmSync(outDir, { recursive: true, force: true });
  const live = components.filter((c) => c.change !== 'delete');
  const r = live.length ? retrieve(root, cfg, { org: o.name, refs: live.map((c) => c.ref), outDir, key: null }) : { found: [], files: [] };
  const rows = [];
  for (const c of components) {
    if (c.change === 'delete') { rows.push({ ref: c.ref, status: 'check_manually', note: 'Deletion: confirm in the org that it is gone.' }); continue; }
    if (!r.found.includes(c.ref)) { rows.push({ ref: c.ref, status: 'missing', note: `Not found in ${orgName}.` }); continue; }
    const { name } = parseRef(c.ref);
    const mine = sourceFilesOf(root, c.path);
    const theirs = r.files.filter((f) => refFromPath(f.file) === c.ref);
    const diffs = [];
    for (const m of mine) {
      const t = theirs.find((x) => path.basename(x.file) === path.basename(m.file));
      if (!t) diffs.push(`${path.basename(m.file)}: not in ${orgName}`);
      else if (normalise(readText(path.join(root, m.file))) !== normalise(readText(path.join(outDir, t.file)))) diffs.push(`${path.basename(m.file)}: content differs`);
    }
    rows.push({ ref: c.ref, status: diffs.length ? 'different' : 'same', note: diffs.join('; ') || undefined, name });
  }
  const ok = rows.every((x) => x.status === 'same' || x.status === 'check_manually');
  const ev = addEvidence(root, key, { kind: 'parity', org: orgName, actor, ok, command: `parity ${orgName}`, summary: ok ? `${orgName} matches the build for ${rows.length} component(s)` : `${orgName} differs from the build`, payload: { rows } });
  return { ok, org: orgName, rows, evidence: ev.id };
}

/**
 * Put the backed-up versions back into the build org (human action).
 * Components the ticket created are not deleted; they are listed for the human.
 */
export function restore(root, cfg, { key, source = 'terminal' }) {
  const o = buildOrg(cfg);
  assertWritable(root, cfg, o, 'metadata');
  const bdir = path.join(layout(root).ticketDir(key), 'backup', o.name);
  if (!exists(bdir)) fail(`Ticket ${key} has no backup for ${o.name}.`, 'NO_BACKUP');
  const srcRoot = path.join(root, cfg.pipeline.source_dir || 'source', o.name);
  const srcFiles = listFiles(srcRoot, { ignore: ['node_modules', '.git', '.sf', '.sfdx'] });
  const restored = [];
  const unplaced = [];
  for (const f of listFiles(bdir)) {
    const ref = refFromPath(f);
    const target = ref && srcFiles.find((x) => refFromPath(x) === ref && path.basename(x) === path.basename(f));
    if (!target) { unplaced.push(f); continue; }
    fs.copyFileSync(path.join(bdir, f), path.join(srcRoot, target));
    restored.push(path.join(srcRoot, target));
  }
  if (!restored.length) fail('None of the backed-up files could be matched to a source file.', 'NO_MATCH');
  const args = ['project', 'deploy', 'start', '--target-org', o.alias, '--wait', '30'];
  for (const p of restored.filter((x) => !x.endsWith('-meta.xml') || !restored.includes(x.replace(/-meta\.xml$/, '')))) args.push('--source-dir', p);
  const r = runSf(args, { cwd: sfdxProjectDir(root, cfg) });
  const refs = uniq(restored.map((x) => refFromPath(rel(root, x))));
  const build = readJson(path.join(layout(root).ticketDir(key), '04-build.json'), { components: [] });
  const created = build.components.filter((c) => c.change === 'new').map((c) => c.ref);
  const ev = addEvidence(root, key, { kind: 'deploy', org: o.name, actor: 'human', ok: r.ok, command: `restore ${refs.join(' ')}`, summary: r.ok ? `Restored ${refs.length} component(s) in ${o.name} from the backup` : `Restore to ${o.name} failed`, payload: { refs, message: r.message, unplaced, created }, meta: { restore: true, refs, source } });
  return { ok: r.ok, org: o.name, restored: refs, not_matched: unplaced, created_by_ticket_still_in_org: created, message: r.ok ? undefined : r.message, evidence: ev.id };
}

const normalise = (s) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim();
function sourceFilesOf(root, p) {
  const abs = path.resolve(root, p);
  if (!exists(abs)) return [];
  if (fs.statSync(abs).isDirectory()) return listFiles(abs).map((f) => ({ file: `${rel(root, abs)}/${f}` }));
  const meta = `${abs}-meta.xml`;
  return [{ file: rel(root, abs) }, ...(exists(meta) ? [{ file: rel(root, meta) }] : [])];
}
export { sourceGlobsFor };

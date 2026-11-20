// What 0.2.0 added or fixed. Each test names the failure it guards against.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorkspace, writeOut, cleanup, fakeState, intakeOf, SELF_REVIEW, HERE } from './helpers.mjs';
import * as T from '../engine/lib/ticket.js';
import * as O from '../engine/lib/org.js';
import * as B from '../engine/lib/brain.js';
import * as D from '../engine/lib/discover.js';
import { handle, requestBrowserSignIn } from '../engine/lib/hook.js';
import { addEvidence } from '../engine/lib/evidence.js';
import { checkBash } from '../engine/lib/guards/policy.js';
import { checkWrite } from '../engine/lib/guards/write.js';
import { scanText, maskAddress, emailAllowed } from '../engine/lib/guards/data.js';
import { redactInside } from '../engine/lib/mask.js';
import { analyze } from '../engine/lib/shell.js';
import { newFindings } from '../engine/lib/backups.js';
import { describeContract } from '../engine/lib/schema.js';
import { loadConfig, validateConfig, setConfigValue } from '../engine/lib/config.js';
import { loadCatalogue, effortsFor, resolveModel, refreshModels, modelOptions } from '../engine/lib/models.js';
import { renderStagePage } from '../engine/lib/pages.js';
import { renderMcp } from '../engine/lib/sync.js';
import { doctor } from '../engine/lib/doctor.js';
import { buildPack } from '../engine/lib/deploypack.js';

const cli = (root, args, { env = {}, input } = {}) => spawnSync('node', [path.join(HERE, '..', 'engine', 'cli.js'), ...args], { encoding: 'utf8', cwd: root, input, env: { ...process.env, ORGTOMO_WORKSPACE: root, ...env } });
const ticketJson = (extra = {}) => ({ title: 'Escalation reason wrong for medium cases', type: 'bug', description: 'Medium cases get Auto. The field is Escalation_Reason__c.', acceptance_criteria: [{ id: 'AC1', text: 'Only High gets Auto.' }], source: { tool: 'test', fetched_at: '2026-11-19T10:00:00Z' }, ...extra });
/** Put a ticket straight into a stage, for tests that are about one stage only. */
function ticketAt(ws, key, stage) {
  T.openTicket(ws.root, ws.cfg, { key });
  T.importTicket(ws.root, ws.cfg, key, ticketJson());
  const f = ws.L.ticketState(key);
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), stage }));
}

test('a retrieve goes through a staging folder inside the sfdx project, as the real CLI demands', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    const project = path.join(root, 'source', 'dev');
    // The stand-in CLI refuses exactly what the real one refuses, with the same error names.
    const outside = O.runSf(['project', 'retrieve', 'start', '--target-org', 't-dev', '--output-dir', path.join(root, 'vault', 'x'), '--metadata', 'ApexClass:CaseService'], { cwd: project });
    assert.equal(outside.ok, false);
    assert.equal(outside.name, 'OutputDirOutsideProjectError');
    const inPackage = O.runSf(['project', 'retrieve', 'start', '--target-org', 't-dev', '--output-dir', 'force-app/tmp', '--metadata', 'ApexClass:CaseService'], { cwd: project });
    assert.equal(inPackage.name, 'RetrieveTargetDirOverlapsPackageError');

    T.openTicket(root, cfg, { key: 'RET-1' });
    const bk = O.backup(root, cfg, { key: 'RET-1', refs: ['ApexClass:CaseService'], actor: 'baseline' });
    assert.deepEqual(bk.backed_up, ['ApexClass:CaseService']);
    assert.ok(fs.existsSync(path.join(ws.L.ticketDir('RET-1'), 'backup/dev/classes/CaseService.cls')), 'the backup lands in the ticket folder');
    assert.ok(!fs.existsSync(path.join(project, '.orgtomo-tmp')), 'the staging folder is removed');
    const got = O.retrieve(root, cfg, { org: 'uat', refs: ['ApexClass:CaseService'], outDir: path.join(root, '.orgtomo', 'state', 'tmp', 'r1'), key: null });
    assert.deepEqual(got.found, ['ApexClass:CaseService'], 'a retrieve from another org works the same way');
    // leftovers in a staging folder never become components of the Brain
    fs.mkdirSync(path.join(project, '.orgtomo-tmp', 'old', 'classes'), { recursive: true });
    fs.writeFileSync(path.join(project, '.orgtomo-tmp', 'old', 'classes', 'Ghost.cls'), 'public class Ghost {}');
    assert.ok(!B.scanSource(root, project).has('ApexClass:Ghost'));
  } finally { cleanup(ws); }
});

test('the data guard stops new addresses, not text the component already had', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    const cls = 'source/dev/force-app/main/default/classes/CaseService.cls';
    // product text that is already in the org: an example address in a comment
    for (const f of [path.join(root, cls), path.join(ws.orgDirs['t-dev'], 'classes/CaseService.cls')]) fs.appendFileSync(f, '// Example: write to helpdesk@product.example\n');
    ticketAt(ws, 'DAT-1', 'build');
    O.backup(root, cfg, { key: 'DAT-1', refs: ['ApexClass:CaseService'], actor: 'builder' });
    assert.equal(scanText(fs.readFileSync(path.join(root, cls), 'utf8'), cfg.safety).length, 1, 'a plain scan sees the old address');
    assert.equal(newFindings(root, cfg, 'DAT-1', path.join(root, cls)).length, 0, 'compared with the backup it is not new');
    assert.equal(O.deploy(root, cfg, { key: 'DAT-1', paths: [cls], actor: 'builder', ticket: T.loadTicket(root, 'DAT-1') }).ok, true);
    fs.appendFileSync(path.join(root, cls), '// ask jane.roe@client.org\n');
    assert.throws(() => O.deploy(root, cfg, { key: 'DAT-1', paths: [cls], actor: 'builder', ticket: T.loadTicket(root, 'DAT-1') }), /Data guard/);
    // the Write tool: editing a file keeps what it had and refuses what is new
    const hook = (content) => handle({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Write', agent_type: 'builder', tool_input: { file_path: path.join(root, cls), content } })?.hookSpecificOutput?.permissionDecision || 'none';
    fs.writeFileSync(path.join(root, cls), 'public class CaseService { /* helpdesk@product.example */ }\n');
    assert.equal(hook('public with sharing class CaseService { /* helpdesk@product.example */ }\n'), 'none');
    assert.equal(hook('public class CaseService { /* someone.else@client.org */ }\n'), 'deny');
  } finally { cleanup(ws); }
});

test('blocked: a broken tool stops the ticket with a reason instead of pushing agents on', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    ticketAt(ws, 'BLK-1', 'build');
    const stop = () => handle({ hook_event_name: 'Stop', cwd: root, agent_type: 'tomo-lead' });
    assert.equal(stop().decision, 'block', 'a running ticket keeps the Lead going');
    assert.throws(() => T.block(root, cfg, 'BLK-1', { reason: 'short' }), /Give the reason/);
    T.block(root, cfg, 'BLK-1', { reason: 'Backup failed: the CLI refused the output folder. Ask jane.roe@client.org.', actor: 'baseline' });
    const t = T.loadTicket(root, 'BLK-1');
    assert.equal(t.status, 'blocked');
    assert.ok(!t.await.reason.includes('jane.roe@client.org'), 'the reason is redacted');
    const n = T.next(root, cfg, 'BLK-1');
    assert.equal(n.awaiting, 'blocked');
    assert.equal(n.do[0].who, 'human');
    assert.equal(stop(), null, 'nothing pushes the Lead while the ticket is blocked');
    assert.equal(T.summary(t).blocked_reason, t.await.reason);
    assert.throws(() => T.submit(root, cfg, 'BLK-1', 'build', { actor: 'builder' }), /blocked/);
    T.human.resume(root, cfg, 'BLK-1', { note: 'Updated the CLI.' });
    assert.equal(T.loadTicket(root, 'BLK-1').status, 'running');

    // the engine blocks by itself when the same command fails twice for a reason no agent can fix
    assert.equal(T.noteToolFailure(root, cfg, 'BLK-1', 'org backup', new Error('CLI refused')), null);
    assert.equal(T.noteToolFailure(root, cfg, 'BLK-1', 'org backup', new Error('CLI refused')).blocked, true);
    T.human.resume(root, cfg, 'BLK-1', {});

    // a baseline that says "backup failed" is valid, and it leads to a block, not to the Builder
    writeOut(ws, 'BLK-1', '00-baseline', { key: 'BLK-1', backups: [{ ref: 'ApexClass:CaseService', status: 'failed', reason: 'the CLI refused' }], tests: [] });
    assert.deepEqual(T.baselineState(root, 'BLK-1'), { status: 'failed', failed: ['ApexClass:CaseService'] });
    assert.match(T.next(root, cfg, 'BLK-1').do[0].action, /orgtomo block BLK-1/);
    const check = JSON.parse(cli(root, ['baseline', 'check', 'BLK-1']).stdout);
    assert.equal(check.ok, false);
    assert.deepEqual(check.backup_failed, ['ApexClass:CaseService']);
  } finally { cleanup(ws); }
});

test('the Lead can import any ticket text: standard input, quoted here-document', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    const lead = (cmd) => checkBash(cmd, { cfg, root, agent: 'lead' });
    const body = JSON.stringify(ticketJson({ description: "The rule doesn't check `CC_emails__c` and $(nothing) runs." }));
    const quoted = `orgtomo ticket import IMP-1 --file - <<'ORGTOMO_TICKET'\n${body}\nORGTOMO_TICKET`;
    assert.equal(analyze(quoted).segments.length, 1, 'the body is input, not commands');
    assert.equal(lead(quoted).decision, 'allow');
    assert.equal(lead(`orgtomo ticket import IMP-1 --file - <<EOF\n{"t":"$(whoami)"}\nEOF`).decision, 'deny', 'an unquoted here-document is expanded by the shell');
    assert.equal(checkBash(`python3 - <<'PY'\nimport subprocess\nsubprocess.run("sf data query -o t-prod")\nPY`, { cfg, root, agent: 'tester' }).decision, 'deny', 'a script on standard input may not reach Salesforce');

    T.openTicket(root, cfg, { key: 'IMP-1' });
    const next = T.next(root, cfg, 'IMP-1');
    assert.match(next.do[0].action, /--file - <<'ORGTOMO_TICKET'/);
    assert.ok('source' in next.do[0].contract_shape.fields, 'the Lead is shown every required field');
    const imp = cli(root, ['ticket', 'import', 'IMP-1', '--file', '-'], { input: body, env: { ORGTOMO_ACTOR: 'lead' } });
    assert.equal(JSON.parse(imp.stdout).stage, 'understand');
    assert.match(fs.readFileSync(path.join(ws.L.ticketDir('IMP-1'), '00-ticket.md'), 'utf8'), /doesn't check `CC_emails__c`/);

    // bad input gives one line of JSON, never a stack trace
    T.openTicket(root, cfg, { key: 'IMP-2' });
    for (const [args, code] of [[['ticket', 'import', 'IMP-2', '--file'], 'ERROR'], [['ticket', 'import', 'IMP-2', '--file', 'nope.json'], 'NOT_FOUND'], [['meetings', 'ingest', '--file'], 'ERROR'], [['ticket', 'import', 'IMP-2', '--json', '{bad'], 'BAD_JSON']]) {
      const r = cli(root, args);
      assert.equal(JSON.parse(r.stderr.trim()).code, code, args.join(' '));
      assert.ok(!/\n\s+at /.test(r.stderr), `no stack trace for: ${args.join(' ')}`);
    }
    assert.ok('source' in JSON.parse(cli(root, ['contract', 'show', 'ticket']).stdout).fields);
    assert.ok(describeContract('understanding').fields['intake (optional)']);
  } finally { cleanup(ws); }
});

test('masking keeps the shape of an address and misses no broken one', () => {
  const safety = { allowed_emails: ['tester@example.com'], allowed_phones: [] };
  assert.equal(maskAddress('john.smith@.dept.uni.edu'), 'j***.s***@.d***.u***.edu');
  assert.equal(maskAddress('x.@y.edu'), 'x***.@y***.edu', 'the dot before the @ stays visible');
  for (const broken of ['someone@.dept.example.edu', 'tester@example..com', '.tester@example.com', 'tester.@example.com', 'te..ster@example.com']) {
    assert.equal(scanText(`cc: ${broken}`, safety).length, 1, `seen as an address: ${broken}`);
  }
  const text = redactInside('Customer wrote from maria.lopez@.iae.example.ar yesterday.', safety);
  assert.ok(!text.includes('maria') && !text.includes('lopez') && text.includes('@.i***'), text);
  assert.equal(scanText(text, safety).length, 0, 'a masked address is not flagged again');
  // broken variants of an allowed address are a setting, off by default
  assert.equal(emailAllowed('.tester@example.com', safety), false);
  const shapes = { ...safety, allowed_email_shapes: true };
  for (const v of ['.tester@example.com', 'tester.@example.com', 'tester@.example.com', 'tester@example..com']) assert.equal(emailAllowed(v, shapes), true, v);
  assert.equal(emailAllowed('.other@example.com', shapes), false, 'only variants of an allowed address');
  assert.equal(emailAllowed('other@example.com', shapes), false);
});

test('a shell command that writes a file follows the same ownership rules as the Write tool', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    ticketAt(ws, 'SHW-1', 'build');
    const ctx = (agent) => ({ cfg, root, agent, stages: T.stagesOf(root), activeStages: T.activeStages(root) });
    const sh = (cmd, agent) => checkBash(cmd, ctx(agent)).decision;
    assert.equal(sh(`echo '{"verdict":"pass"}' > vault/tickets/SHW-1/05-qa.json`, 'lead'), 'deny', 'the Lead writes nothing, through any tool');
    assert.equal(sh(`printf x > source/dev/force-app/main/default/classes/Foo.cls`, 'lead'), 'deny');
    assert.equal(sh('cp /tmp/x.cls source/dev/force-app/main/default/classes/Foo.cls', 'tester'), 'deny', 'only the Builder changes source');
    assert.equal(sh('cp /tmp/x.cls source/dev/force-app/main/default/classes/Foo.cls', 'builder'), 'allow');
    assert.equal(sh("sed -i '' 's/FAIL/PASS/' vault/tickets/SHW-1/verify-plan.md", 'tester'), 'deny', 'gate reports are the engine\'s');
    assert.equal(sh('tee vault/learning/Lessons.md', 'analyst'), 'deny');
    assert.equal(sh('rm vault/tickets/SHW-1/03-plan.json', 'tester'), 'deny', 'another agent\'s output');
    assert.equal(sh('cd vault/tickets/SHW-1 && echo done > 03-plan.json', 'tester'), 'deny', 'a cd does not hide the target');
    assert.equal(sh('echo note > vault/tickets/SHW-1/work/notes.txt', 'tester'), 'allow');
    assert.equal(sh('echo x > /dev/null 2>&1', 'tester'), 'allow');
    assert.equal(sh('echo "mail jane.roe@client.org" > vault/tickets/SHW-1/work/notes.txt', 'tester'), 'deny', 'the data guard reads what is written');
    assert.equal(checkWrite(path.join(root, 'vault/tickets/SHW-1/01-understanding.html'), ctx('analyst')).decision, 'deny', 'stage pages are built by the engine');
  } finally { cleanup(ws); }
});

test('the sandbox check expires and notices an alias that now points to another org', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    const v = O.verifyOrg(root, cfg, 'dev');
    assert.equal(v.is_sandbox, true);
    assert.ok(O.orgVerifiedFresh(root, cfg, 'dev'));
    process.env.ORGTOMO_NOW = new Date(Date.now() + 13 * 3_600_000).toISOString();
    assert.equal(O.orgVerifiedFresh(root, cfg, 'dev'), null, 'after 12 hours the org is asked again');
    delete process.env.ORGTOMO_NOW;
    fakeState(ws, { org_ids: { 't-dev': '00D000000000999AAA' } });
    assert.throws(() => O.verifyOrg(root, cfg, 'dev'), /different org than before/);
    assert.equal(O.orgVerified(root, 'dev').org_id, v.org_id, 'the old answer stays until a human confirms');
    assert.equal(O.verifyOrg(root, cfg, 'dev', { accept: true }).org_id, '00D000000000999AAA');
    fakeState(ws, { unreachable: ['t-dev'] });
    assert.throws(() => O.verifyOrg(root, cfg, 'dev'), /Log in again yourself: sf org login web --alias t-dev/);
  } finally { delete process.env.ORGTOMO_NOW; cleanup(ws); }
});

test('the context pack finds what the ticket names, and says why', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    B.buildBrain(root, cfg, 'dev');
    const tk = ticketJson({ title: 'Validation rule accepts wrong case values', description: 'See Escalation_Reason__c and Require_Reason.' });
    const terms = B.packTerms(tk);
    assert.ok(terms.includes('Escalation_Reason__c') && terms.includes('Require_Reason'), 'API names come from the description too');
    const hits = B.search(root, cfg, 'dev', terms);
    assert.deepEqual(hits.slice(0, 2).map((h) => h.ref).sort(), ['CustomField:Case.Escalation_Reason__c', 'ValidationRule:Case.Require_Reason'], 'a name after the dot is an exact match');
    assert.ok(hits[0].exact && hits[0].why[0].startsWith('exact name'));
    T.openTicket(root, cfg, { key: 'PCK-1' });
    T.importTicket(root, cfg, 'PCK-1', tk);
    B.contextPack(root, cfg, 'PCK-1', { terms });
    const pack = () => fs.readFileSync(path.join(ws.L.ticketDir('PCK-1'), 'context-pack.md'), 'utf8');
    assert.match(pack(), /ValidationRule:Case\.Require_Reason`[^\n]*\n\s+matched: exact name "require_reason"/);
    assert.match(pack(), /orgs\/dev\/objects\/Case\|Case: everything about this object/);
    // after the Analyst names components, the pack is rebuilt around them
    const ev = addEvidence(root, 'PCK-1', { kind: 'brain', org: 'dev', actor: 'analyst', summary: 'fact', payload: {} }).id;
    writeOut(ws, 'PCK-1', '01-understanding', { key: 'PCK-1', summary_plain: 'A plain explanation that is long enough to be accepted by the contract.', summary_technical: 'A technical explanation that is long enough to be accepted by the contract.', acceptance_criteria: [{ id: 'AC1', text: 'works', source: 'ticket' }], examples: [{ title: 't', given: 'g', when: 'w', then: 't', input: 'Medium', today: 'Auto', expected: 'empty' }], affected: [{ component: 'ApexTrigger:CaseTrigger', why: 'runs first', proof: [ev] }], open_questions: [], risk: 'low', lite_candidate: false, intake: intakeOf(ev), one_line: 'Only urgent cases should be marked.', claims: [{ id: 'C1', text: 'CaseTrigger exists in the build org.', proof: [ev] }] });
    assert.equal(T.submit(root, cfg, 'PCK-1', 'understand', { actor: 'analyst' }).passed, true);
    const html = fs.readFileSync(path.join(ws.L.ticketDir('PCK-1'), '01-understanding.html'), 'utf8');
    assert.ok(html.includes('Only urgent cases should be marked.') && html.includes('<code>Medium</code>') && html.includes('Checked against the system'), 'the engine builds the page for the human');
    assert.equal(renderStagePage(root, cfg, 'PCK-1', 'plan'), null);
    T.leadVerify(root, cfg, 'PCK-1', 'understand', { claim: 'C1', evidence: addEvidence(root, 'PCK-1', { kind: 'brain', org: 'dev', actor: 'lead', summary: 'recheck', payload: {} }).id, result: 'match', actor: 'lead' });
    assert.match(pack(), /ApexTrigger:CaseTrigger`[^\n]*\n\s+matched: named by the Analyst/);
  } finally { cleanup(ws); }
});

test('the Brain: sync in one command, hub pages, tests per component', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    const out = JSON.parse(cli(root, ['brain', 'sync', 'dev']).stdout);
    assert.equal(out.components, 8);
    const hub = fs.readFileSync(path.join(ws.L.orgVault('dev'), 'objects', 'Case.md'), 'utf8');
    assert.match(hub, /type: object-hub/);
    assert.match(hub, /What runs when a record is saved/);
    assert.match(hub, /'object == "Case"'/);
    assert.deepEqual(B.testsFor(root, cfg, 'dev', ['ApexClass:CaseService']).tests, ['CaseServiceTest']);
    assert.deepEqual(B.testsFor(root, cfg, 'dev', ['ValidationRule:Case.Require_Reason']).tests, ['CaseServiceTest'], 'a rule on an object is covered by the tests that touch the object');
    const view = B.objectView(root, cfg, 'dev', 'Case');
    assert.ok(view.counts.Flow === 1 && view.has_automation && view.tests.includes('CaseServiceTest'));
    assert.equal(JSON.parse(cli(root, ['brain', 'object', 'dev', 'Case']).stdout).object, 'Case');
    // process metadata is read without knowing its schema
    const dir = path.join(root, 'source/dev/force-app/main/default/approvalProcesses');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Case.Refund_Approval.approvalProcess-meta.xml'), '<?xml version="1.0"?><ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active><label>Refund approval</label><approvalStep><name>Manager</name></approvalStep><approvalStep><name>Finance</name></approvalStep></ApprovalProcess>');
    B.buildBrain(root, cfg, 'dev');
    const fact = B.brainFact(root, cfg, 'dev', 'ApprovalProcess:Case.Refund_Approval');
    assert.deepEqual([fact.facts.object, fact.facts.active, fact.facts.label, fact.facts.parts.approvalStep], ['Case', 'true', 'Refund approval', 2]);
    assert.match(fs.readFileSync(path.join(ws.L.orgVault('dev'), 'facts', '_automation', 'Case.md'), 'utf8'), /Also configured on this object[\s\S]*Refund_Approval/);
  } finally { cleanup(ws); }
});

test('gates: intake, a control for every zero, named regression tests, self-review', () => {
  const ws = makeWorkspace({ overrides: {} });
  const { root, cfg } = ws;
  try {
    B.buildBrain(root, cfg, 'dev');
    T.openTicket(root, cfg, { key: 'GAT-1' });
    T.importTicket(root, cfg, 'GAT-1', ticketJson());
    fakeState(ws, { queries: { NoSuchValue: [] } });
    const some = O.query(root, cfg, { org: 'dev', soql: 'SELECT Id FROM Case LIMIT 5', key: 'GAT-1', actor: 'analyst' }).evidence;
    const none = O.query(root, cfg, { org: 'dev', soql: "SELECT Id FROM Case WHERE Status = 'NoSuchValue' LIMIT 5", key: 'GAT-1', actor: 'analyst' }).evidence;
    const u = (extra) => ({ key: 'GAT-1', summary_plain: 'A plain explanation that is long enough to be accepted by the contract.', summary_technical: 'A technical explanation that is long enough to be accepted by the contract.', acceptance_criteria: [{ id: 'AC1', text: 'works', source: 'ticket' }], examples: [{ title: 't', given: 'g', when: 'w', then: 't' }], affected: [{ component: 'ApexClass:CaseService', why: 'rule', proof: [some] }], open_questions: [], risk: 'low', lite_candidate: false, claims: [{ id: 'C1', text: 'No case in dev has that status value today.', proof: [none] }], ...extra });
    const why = (r, id) => (r.failed || []).find((f) => f.id === id)?.details.join(' | ') || '';
    writeOut(ws, 'GAT-1', '01-understanding', u({ intake: intakeOf(some, { size: { count: 0, population: 'Cases with the status NoSuchValue in dev', proof: [none] } }) }));
    let r = T.submit(root, cfg, 'GAT-1', 'understand', { actor: 'analyst' });
    assert.match(why(r, 'evidence'), /claim C1 rests on a query that returned no rows/);
    assert.match(why(r, 'intake-check'), /size\.count is 0: add a control/);
    T.human.resume; // (no-op: the ticket is still running after one failed attempt)
    writeOut(ws, 'GAT-1', '01-understanding', u({ claims: [{ id: 'C1', text: 'No case in dev has that status value today.', proof: [none, some], basis: 'inferred' }] }));
    r = T.submit(root, cfg, 'GAT-1', 'understand', { actor: 'analyst' });
    assert.equal(why(r, 'intake-check').startsWith('intake is missing'), true);
    assert.match(why(r, 'evidence'), /marked inferred: say in confirm_by/);
    assert.ok(!/returned no rows/.test(why(r, 'evidence')), 'the control settles the zero');
  } finally { cleanup(ws); }
});

test('the plan names its regression tests and records its self-review; unconfirmed documentation is shown to the human', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    B.buildBrain(root, cfg, 'dev');
    ticketAt(ws, 'PLN-1', 'plan');
    const ev = addEvidence(root, 'PLN-1', { kind: 'brain', org: 'dev', actor: 'analyst', summary: 'fact', payload: {} }).id;
    writeOut(ws, 'PLN-1', '01-understanding', { acceptance_criteria: [{ id: 'AC1', text: 'works', source: 'ticket' }] });
    const doc = addEvidence(root, 'PLN-1', { kind: 'doc', actor: 'planner', command: 'https://help.salesforce.com/s/articleView?id=x', summary: 'Official doc', payload: { url: 'https://help.salesforce.com/s/articleView?id=x', quote: 'q', quote_verified: false }, meta: { quote_verified: false } }).id;
    const plan = (extra) => ({ key: 'PLN-1', approach: 'Tighten the priority condition inside CaseService.applyEscalation only.', components: [{ ref: 'ApexClass:CaseService', change: 'modify', what: 'limit the rule', why: 'Needed for AC1', proof: [ev] }], order: ['ApexClass:CaseService'], tests: [{ id: 'T1', covers: ['AC1'], kind: 'apex', description: 'rule holds' }], manual_steps: [], risks: [], docs: [doc], rollback: 'Redeploy the backed up class.', claims: [], ...extra });
    writeOut(ws, 'PLN-1', '03-plan', plan({}));
    let r = T.submit(root, cfg, 'PLN-1', 'plan', { actor: 'planner' });
    const why = (id) => r.failed.find((f) => f.id === id)?.details.join(' | ') || '';
    assert.match(why('plan-grounding'), /1 existing test class\(es\) touch what this plan changes/);
    assert.match(why('self-review'), /self_review is missing/);
    writeOut(ws, 'PLN-1', '03-plan', plan({ regression_tests: ['CaseServiceTest'], self_review: SELF_REVIEW, data_changes: [{ org: 'uat', what: 'Clear the reason on Medium cases that were stamped by mistake', records: 'open Cases with Priority Medium and reason Auto', reversible: true }] }));
    r = T.submit(root, cfg, 'PLN-1', 'plan', { actor: 'planner' });
    assert.equal(r.passed, true, JSON.stringify(r.failed));
    assert.deepEqual(T.unverifiedDocs(root, 'PLN-1', 'plan'), [{ id: doc, url: 'https://help.salesforce.com/s/articleView?id=x' }]);
    T.leadVerify(root, cfg, 'PLN-1', 'plan', { claim: 'C1', evidence: addEvidence(root, 'PLN-1', { kind: 'brain', org: 'dev', actor: 'lead', summary: 'recheck', payload: {} }).id, result: 'match', actor: 'lead' });
    assert.match(T.next(root, cfg, 'PLN-1').say, /could not confirm 1 official-documentation quote/);
    // the baseline must run what the plan named
    writeOut(ws, 'PLN-1', '00-baseline', { key: 'PLN-1', backups: [], tests: [] });
    assert.match(JSON.parse(cli(root, ['baseline', 'check', 'PLN-1']).stdout).errors.join(' '), /CaseServiceTest is named in the plan's regression_tests and was not run/);
    // a strict workspace refuses unconfirmed documentation outright
    setConfigValue(root, 'safety', 'docs.require_verified', true);
    const t = T.loadTicket(root, 'PLN-1'); t.status = 'running'; t.await = null; t.stages.plan = { status: 'pending', attempts: 0 }; fs.writeFileSync(ws.L.ticketState('PLN-1'), JSON.stringify(t));
    r = T.submit(root, loadConfig(root), 'PLN-1', 'plan', { actor: 'planner' });
    assert.match(why('evidence'), /could not be confirmed by fetching the page/);
  } finally { cleanup(ws); }
});

test('the agent browser is signed in by the engine, sandboxes only', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    const nav = (url, tool = 'mcp__playwright__browser_navigate') => handle({ hook_event_name: 'PreToolUse', cwd: root, tool_name: tool, agent_type: 'tester', tool_input: { url } });
    const first = nav('https://testco--dev.sandbox.lightning.force.com/lightning/r/Case/500000000000001AAA/view');
    assert.equal(first.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(first.hookSpecificOutput.updatedInput.url, /frontdoor\.jsp\?otp=.*startURL=%2Flightning%2Fr%2FCase/);
    assert.equal(nav('https://testco--dev.sandbox.lightning.force.com/lightning/o/Case/list'), null, 'one sign-in per session window');
    requestBrowserSignIn(root, 'dev');
    assert.match(nav('https://testco--dev.sandbox.my.salesforce.com/').hookSpecificOutput.updatedInput.url, /frontdoor/);
    assert.equal(nav('https://testco.my.salesforce.com/').hookSpecificOutput.permissionDecision, 'deny', 'production is never opened');
    assert.throws(() => O.browserLoginUrl(root, cfg, 'prod'), /never opens production/);
    assert.equal(JSON.parse(cli(root, ['browser', 'login', 'dev'], { env: { ORGTOMO_ACTOR: 'tester' } }).stdout).org, 'dev');
    assert.equal(JSON.parse(cli(root, ['browser', 'login', 'prod']).stderr).code, 'PRODUCTION');
    // Claude in Chrome is fenced the same way, and never gets a sign-in link
    setConfigValue(root, 'safety', 'browser.claude_in_chrome', true);
    const chrome = (url) => handle({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'mcp__claude-in-chrome__navigate', agent_type: 'tester', tool_input: { url } });
    assert.equal(chrome('testco.my.salesforce.com/lightning').hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(chrome('https://testco--dev.sandbox.my.salesforce.com/'), null);
    // with sign-in set to manual nothing is rewritten
    setConfigValue(root, 'safety', 'browser.login', 'manual');
    requestBrowserSignIn(root, 'dev');
    assert.equal(nav('https://testco--dev.sandbox.my.salesforce.com/'), null);
    // the browser server: pinned version, production origins blocked, optional attach to a running browser
    const args = renderMcp(root, loadConfig(root)).mcpServers.playwright.args;
    assert.match(args[0], /^@playwright\/mcp@\d+\.\d+\.\d+$/);
    assert.match(args[args.indexOf('--blocked-origins') + 1], /https:\/\/testco\.my\.salesforce\.com;https:\/\/testco\.lightning\.force\.com/);
    setConfigValue(root, 'safety', 'browser.provider', 'playwright-extension');
    const ext = renderMcp(root, loadConfig(root)).mcpServers.playwright.args;
    assert.ok(ext.includes('--extension') && !ext.includes('--user-data-dir'));
    assert.throws(() => setConfigValue(root, 'safety', 'browser.provider', 'netscape'), /browser\.provider must be/);
  } finally { cleanup(ws); }
});

test('business discovery: areas and questions from the engine, process notes checked statement by statement', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    const run = JSON.parse(cli(root, ['discover', 'run', 'uat', '--retrieve']).stdout);
    assert.ok(run.domains.some((d) => d.slug === 'service'), JSON.stringify(run.domains));
    assert.equal(run.counted, true);
    const dir = path.join(ws.L.orgVault('uat'), 'business');
    assert.match(fs.readFileSync(path.join(dir, 'domains', 'service.md'), 'utf8'), /\[\[orgs\/uat\/objects\/Case\|Case\]\] \| 42 \|/);
    const q = D.discoverState(root, 'uat').questions;
    assert.ok(q.some((x) => x.signature === 'purpose:service'));
    const id = q.find((x) => x.signature === 'purpose:service').id;
    // only the human answers, and the answer survives the next run
    assert.equal(JSON.parse(cli(root, ['discover', 'answer', 'uat', id, 'x'], { env: { ORGTOMO_ACTOR: 'cartographer' } }).stderr).code, 'ERROR');
    assert.equal(checkBash(`orgtomo discover answer uat ${id} support`, { cfg, root, agent: 'cartographer' }).decision, 'deny');
    D.answerQuestion(root, cfg, 'uat', id, 'Customer support. Owned by the support team; ask jane.roe@client.org.');
    D.runDiscovery(root, cfg, 'uat');
    const kept = D.discoverState(root, 'uat').questions.find((x) => x.id === id);
    assert.ok(kept.status === 'answered' && !kept.answer.includes('jane.roe@client.org'));
    // the Cartographer writes one note; every statement is linked, or marked
    const next = D.nextDomain(root, cfg, 'uat');
    assert.equal(next.write, `vault/orgs/uat/business/processes/${next.slug}.md`);
    const ctx = (agent) => ({ cfg, root, agent, stages: T.stagesOf(root), activeStages: [] });
    assert.equal(checkWrite(path.join(root, next.write), ctx('cartographer')).decision, 'allow');
    assert.equal(checkWrite(path.join(root, next.write), ctx('analyst')).decision, 'deny');
    assert.equal(checkWrite(path.join(dir, 'Overview.md'), ctx('cartographer')).decision, 'deny', 'generated pages stay generated');
    fs.mkdirSync(path.join(dir, 'processes'), { recursive: true });
    const note = (lines) => fs.writeFileSync(path.join(root, next.write), `---\ntype: process\ndomain: ${next.domain}\norg: uat\n---\n# ${next.domain}\n\n## How a record moves\n\n${lines.join('\n')}\n`);
    const fact = '[[orgs/uat/facts/Flow/Case_AfterSave_Notify_Owner|Case_AfterSave_Notify_Owner]]';
    note(['1. A case is created.', `2. The owner is told by ${fact}.`, '3. Agents pick cases by hand. (inferred)', '4. Whether a case may be closed without a note. (ask)', `5. The reason is checked by [[orgs/uat/objects/Case|Case]] rules.`]);
    let chk = D.checkProcessNote(root, cfg, 'uat', next.slug);
    assert.equal(chk.ok, false);
    assert.match(chk.problems.join(' '), /no fact link and no \(inferred\) or \(ask\) mark: "1\. A case is created\."/);
    note([`1. A case is created through the page that shows ${fact}. (inferred)`, `2. The owner is told by ${fact}.`, '3. Agents pick cases by hand. (inferred)', '4. Whether a case may be closed without a note. (ask)', `5. The reason is checked by [[orgs/uat/objects/Case|Case]] rules.`]);
    chk = D.checkProcessNote(root, cfg, 'uat', next.slug);
    assert.deepEqual([chk.ok, chk.statements.total, chk.statements.linked, chk.statements.marked], [true, 5, 3, 2]);
    assert.notEqual(D.nextDomain(root, cfg, 'uat').slug, next.slug, 'the next run takes the next area');
    assert.ok(doctor(root).checks.some((c) => c.id === 'discover:uat'));
  } finally { cleanup(ws); }
});

test('models: an alias and its version are one model; effort follows the model; the list can be refreshed', async () => {
  const ws = makeWorkspace();
  const { root } = ws;
  try {
    const cat = loadCatalogue(root);
    assert.equal(cat.source, 'shipped');
    assert.equal(resolveModel(cat, 'opus'), cat.aliases.opus);
    assert.ok(!effortsFor(cat, 'claude-sonnet-4-6').includes('xhigh') && effortsFor(cat, 'opus').includes('xhigh'));
    assert.ok(modelOptions(cat).some((o) => o.value === 'opus' && /always the latest/.test(o.label)));
    assert.throws(() => setConfigValue(root, 'agents', 'agents.reviewer.model', cat.aliases.opus), /run on the same model/, 'builder is on the opus alias');
    setConfigValue(root, 'agents', 'agents.tester.model', 'claude-sonnet-4-6');
    setConfigValue(root, 'agents', 'agents.tester.effort', 'xhigh');
    assert.match(validateConfig(loadConfig(root)).warnings.join(' '), /tester uses effort "xhigh", which claude-sonnet-4-6 does not offer/);

    assert.equal((await refreshModels(root, { apiKey: '' })).refreshed, false);
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url: String(url), headers: init.headers }); return { ok: true, json: async () => ({ data: [{ id: 'claude-next-9', display_name: 'Claude Next 9', capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: false } } } }], has_more: false }) }; };
    const got = await refreshModels(root, { apiKey: 'test-key', fetchImpl });
    assert.deepEqual([got.refreshed, got.models], [true, 1]);
    assert.match(calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/models\?limit=100$/);
    assert.equal(calls[0].headers['x-api-key'], 'test-key');
    const fresh = loadCatalogue(root);
    assert.equal(fresh.source, 'api');
    assert.deepEqual(effortsFor(fresh, 'claude-next-9'), ['low', 'high']);
    assert.equal((await refreshModels(root, { apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401 }) })).refreshed, false);
  } finally { cleanup(ws); }
});

test('doctor --orgs proves a real retrieve, and says where plugins and telemetry stand', () => {
  const ws = makeWorkspace();
  const { root } = ws;
  try {
    const ok = doctor(root, { orgs: true });
    assert.equal(ok.checks.find((c) => c.id === 'retrieve').level, 'ok');
    assert.ok(!ok.checks.some((c) => c.id === 'plugins'), 'nothing is said about plugins when none is recorded');
    fs.mkdirSync(path.join(process.env.ORGTOMO_CLAUDE_HOME, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(process.env.ORGTOMO_CLAUDE_HOME, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'orgtomo@orgtomo': [{ scope: 'user' }], 'salesforce-development@orgtomo': [{ scope: 'user' }] } }));
    const d = doctor(root);
    assert.equal(d.checks.find((c) => c.id === 'plugins').level, 'warn');
    assert.match(d.checks.find((c) => c.id === 'telemetry').fix, /telemetry off/);
    assert.match(d.checks.find((c) => c.id === 'default-org').fix, /Run in the folder source\/dev/);
    fakeState(ws, { unreachable: ['t-dev'] });
    const bad = doctor(root, { orgs: true });
    assert.equal(bad.ok, false);
    assert.match(bad.checks.find((c) => c.id === 'org:dev').message, /inactive organization.*Log in again yourself/);
  } finally { cleanup(ws); }
});

test('after a human deploy: an inactive flow is reported, and the pack carries the after-deploy and data-change lists', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    ticketAt(ws, 'AFT-1', 'handoff');
    const flow = 'source/dev/force-app/main/default/flows/Case_AfterSave_Notify_Owner.flow-meta.xml';
    const comps = [{ ref: 'Flow:Case_AfterSave_Notify_Owner', path: flow, change: 'modify' }];
    fakeState(ws, { queries: { 'FROM Flow': [{ Definition: { DeveloperName: 'Case_AfterSave_Notify_Owner' }, VersionNumber: 4, Status: 'Draft' }] } });
    const par = O.parity(root, cfg, { key: 'AFT-1', org: 'uat', components: comps });
    assert.equal(par.ok, true, 'the content matches');
    assert.match(par.warnings[0], /newest version in uat \(v4\) is Draft, not Active/);
    writeOut(ws, 'AFT-1', '04-build', { key: 'AFT-1', components: comps, deviations: [], deploy: { org: 'dev', evidence: 'E001' }, unit_tests_added: [], claims: [] });
    writeOut(ws, 'AFT-1', '03-plan', { manual_steps: [], rollback: 'Redeploy the backup.', data_changes: [{ org: 'uat', what: 'Clear the reason on Medium cases stamped by mistake', records: 'open Cases, Priority Medium, reason Auto' }] });
    const t = T.loadTicket(root, 'AFT-1'); t.handoff = { index: 0, targets: [{ org: 'uat', tool: 'blue-canvas', retest: true, status: 'pending' }] }; fs.writeFileSync(ws.L.ticketState('AFT-1'), JSON.stringify(t));
    const pack = buildPack(root, cfg, 'AFT-1');
    assert.match(fs.readFileSync(path.join(root, pack.dir, 'AFTER-DEPLOY.md'), 'utf8'), /active on the version you just deployed.*`Case_AfterSave_Notify_Owner`/);
    const data = fs.readFileSync(path.join(root, pack.dir, 'DATA-CHANGES.md'), 'utf8');
    for (const part of ['Pre-check', 'Snapshot', 'Dry run', 'Commit', 'Read-back', 'Rollback']) assert.ok(data.includes(`- [ ] ${part}`), part);
  } finally { cleanup(ws); }
});

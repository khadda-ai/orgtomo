// The runner under stress: bad outputs, honest failures, loops, the stop,
// blocking questions, the lite path and the Lead catching a false claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, writeOut, cleanup, intakeOf, SELF_REVIEW } from './helpers.mjs';
import * as T from '../engine/lib/ticket.js';
import * as O from '../engine/lib/org.js';
import * as B from '../engine/lib/brain.js';
import * as L from '../engine/lib/learning.js';
import { addEvidence } from '../engine/lib/evidence.js';

const ticket = (type = 'bug') => ({ title: 'Escalation reason wrong for medium cases', type, description: 'Medium cases get Auto.', acceptance_criteria: [{ id: 'AC1', text: 'Only High gets Auto.' }], source: { tool: 'test', fetched_at: '2026-11-19T10:00:00Z' } });
const understanding = (key, ev, extra = {}) => ({
  key, summary_plain: 'Non urgent cases are wrongly marked as automatically escalated today.', summary_technical: 'CaseService.applyEscalation stamps Escalation_Reason__c for the wrong priorities.',
  acceptance_criteria: [{ id: 'AC1', text: 'Only High gets Auto.', source: 'ticket' }], examples: [{ title: 'Medium', given: 'a Medium case', when: 'saved', then: 'no reason' }],
  affected: [{ component: 'ApexClass:CaseService', why: 'holds the rule', proof: [ev] }], open_questions: [], risk: 'medium', lite_candidate: false,
  intake: intakeOf(ev), claims: [{ id: 'C1', text: 'CaseService is present in the build org source.', proof: [ev] }], ...extra,
});
function start(key, type) {
  const ws = makeWorkspace();
  B.buildBrain(ws.root, ws.cfg, 'dev');
  T.openTicket(ws.root, ws.cfg, { key });
  T.importTicket(ws.root, ws.cfg, key, ticket(type));
  const ev = addEvidence(ws.root, key, { kind: 'brain', org: 'dev', actor: 'analyst', summary: 'fact', payload: {} }).id;
  return { ws, ev };
}
const leadOk = (ws, key, stage) => T.leadVerify(ws.root, ws.cfg, key, stage, { claim: 'C1', evidence: addEvidence(ws.root, key, { kind: 'brain', org: 'dev', actor: 'lead', summary: 'recheck', payload: {} }).id, result: 'match', actor: 'lead' });

test('guessing language and unproven claims fail the evidence gate', () => {
  const { ws, ev } = start('GUE-1');
  try {
    writeOut(ws, 'GUE-1', '01-understanding', understanding('GUE-1', ev, { claims: [{ id: 'C1', text: 'The trigger probably runs after insert as well.', proof: ['E099'] }] }));
    const r = T.submit(ws.root, ws.cfg, 'GUE-1', 'understand', { actor: 'analyst' });
    assert.equal(r.passed, false);
    const details = r.failed.find((f) => f.id === 'evidence').details.join(' ');
    assert.match(details, /E099 is cited but is not in the evidence ledger/);
    assert.match(details, /guessing language \("probably"\)/);
    assert.ok(L.listObservations(ws.root, { ticket: 'GUE-1' }).some((o) => o.signature === 'gate:evidence' && o.agent === 'analyst'));
    assert.ok(fs.readFileSync(path.join(ws.L.ticketDir('GUE-1'), 'verify-understand.md'), 'utf8').includes('FAIL  evidence'));
  } finally { cleanup(ws); }
});

test('only the owner submits a stage; a second bad attempt stops the ticket', () => {
  const { ws, ev } = start('OWN-1');
  try {
    writeOut(ws, 'OWN-1', '01-understanding', { key: 'OWN-1' });
    assert.throws(() => T.submit(ws.root, ws.cfg, 'OWN-1', 'understand', { actor: 'builder' }), /submitted by the analyst/);
    assert.throws(() => T.submit(ws.root, ws.cfg, 'OWN-1', 'plan', { actor: 'planner' }), /is in stage "understand"/);
    assert.equal(T.submit(ws.root, ws.cfg, 'OWN-1', 'understand', { actor: 'analyst' }).passed, false);
    const r = T.submit(ws.root, ws.cfg, 'OWN-1', 'understand', { actor: 'analyst' });
    assert.equal(r.escalated, true);
    assert.equal(T.loadTicket(ws.root, 'OWN-1').status, 'escalated');
    assert.ok(fs.existsSync(path.join(ws.L.ticketDir('OWN-1'), 'escalation.md')));
    assert.match(T.next(ws.root, ws.cfg, 'OWN-1').say, /escalation\.md/);
    void ev;
  } finally { cleanup(ws); }
});

test('a blocking question goes to the human instead of being guessed', () => {
  const { ws, ev } = start('ASK-1');
  try {
    writeOut(ws, 'ASK-1', '01-understanding', understanding('ASK-1', ev, { open_questions: [{ id: 'Q1', text: 'Should closed cases be included?', blocking: true }] }));
    const r = T.submit(ws.root, ws.cfg, 'ASK-1', 'understand', { actor: 'analyst' });
    assert.equal(r.awaiting, 'question');
    assert.equal(T.next(ws.root, ws.cfg, 'ASK-1').awaiting, 'question');
    assert.equal(L.listObservations(ws.root, { ticket: 'ASK-1' }).filter((o) => o.kind === 'mistake').length, 0, 'asking is not a mistake');
    T.human.answer(ws.root, ws.cfg, 'ASK-1', { id: 'Q1', note: 'No, open cases only. Ask sam@client.org if unsure.' });
    const updates = fs.readFileSync(path.join(ws.L.ticketDir('ASK-1'), 'updates.md'), 'utf8');
    assert.ok(updates.includes('open cases only') && !updates.includes('sam@client.org'));
    assert.equal(T.next(ws.root, ws.cfg, 'ASK-1').do[0].who, 'analyst');
  } finally { cleanup(ws); }
});

test('the Lead catches a claim that does not match the org', () => {
  const { ws, ev } = start('MIS-1');
  try {
    writeOut(ws, 'MIS-1', '01-understanding', understanding('MIS-1', ev));
    assert.equal(T.submit(ws.root, ws.cfg, 'MIS-1', 'understand', { actor: 'analyst' }).passed, true);
    const old = ev;
    assert.throws(() => T.leadVerify(ws.root, ws.cfg, 'MIS-1', 'understand', { claim: 'C1', evidence: old, result: 'match', actor: 'lead' }), /older than the submission|produced by/);
    const mine = addEvidence(ws.root, 'MIS-1', { kind: 'brain', org: 'dev', actor: 'analyst', summary: 'x', payload: {} }).id;
    assert.throws(() => T.leadVerify(ws.root, ws.cfg, 'MIS-1', 'understand', { claim: 'C1', evidence: mine, result: 'match', actor: 'lead' }), /The Lead must run the check itself/);
    assert.throws(() => T.leadVerify(ws.root, ws.cfg, 'MIS-1', 'understand', { claim: 'C1', evidence: mine, result: 'match', actor: 'analyst' }), /Only the Lead/);
    const lead = addEvidence(ws.root, 'MIS-1', { kind: 'soql', org: 'dev', actor: 'lead', summary: 'recheck', payload: {} }).id;
    const r = T.leadVerify(ws.root, ws.cfg, 'MIS-1', 'understand', { claim: 'C1', evidence: lead, result: 'mismatch', note: 'class is not there', actor: 'lead' });
    assert.equal(r.ok, false);
    assert.ok(L.listObservations(ws.root).some((o) => o.signature === 'lead:mismatch:understand'));
    assert.equal(T.next(ws.root, ws.cfg, 'MIS-1').do[0].who, 'analyst');
  } finally { cleanup(ws); }
});

test('an unreproduced bug stops; planning never starts on an assumption', () => {
  const { ws, ev } = start('REP-1');
  try {
    writeOut(ws, 'REP-1', '01-understanding', understanding('REP-1', ev));
    T.submit(ws.root, ws.cfg, 'REP-1', 'understand', { actor: 'analyst' });
    leadOk(ws, 'REP-1', 'understand');
    const q = O.query(ws.root, ws.cfg, { org: 'dev', soql: 'SELECT Id FROM Case LIMIT 1', key: 'REP-1', actor: 'reproducer' }).evidence;
    const repro = { key: 'REP-1', mode: 'bug', reproduced: false, org: 'dev', could_not_reproduce_reason: 'Medium cases stayed empty in three attempts.',
      steps: [{ n: 1, action: 'Insert Medium case', expected: 'Auto per the report', actual: 'Empty', proof: [q] }], data_used: [], before_state: { text: 'Medium cases keep an empty reason in dev.', proof: [q] }, claims: [] };
    writeOut(ws, 'REP-1', '02-repro', repro);
    assert.equal(T.submit(ws.root, ws.cfg, 'REP-1', 'repro', { actor: 'reproducer' }).awaiting, 'not_reproduced');
    assert.throws(() => T.submit(ws.root, ws.cfg, 'REP-1', 'plan', { actor: 'planner' }), /awaiting_human/);
    T.human.answer(ws.root, ws.cfg, 'REP-1', { id: 'repro', note: 'It happens only for the Support record type.' });
    // a "reproduction" proven only by reading metadata is refused
    const brainOnly = addEvidence(ws.root, 'REP-1', { kind: 'brain', org: 'dev', actor: 'reproducer', summary: 'read the class', payload: {} }).id;
    writeOut(ws, 'REP-1', '02-repro', { ...repro, reproduced: true, could_not_reproduce_reason: undefined, steps: [{ ...repro.steps[0], proof: [brainOnly] }], root_cause: { text: 'The class has the wrong condition in it.', proof: [brainOnly] } });
    const r = T.submit(ws.root, ws.cfg, 'REP-1', 'repro', { actor: 'reproducer' });
    assert.match(r.failed.find((f) => f.id === 'repro-proof').details.join(' '), /Reading code is not a reproduction/);
  } finally { cleanup(ws); }
});

test('the lite path is decided by facts, and still verifies the build', () => {
  const ws = makeWorkspace();
  try {
    const src = path.join(ws.root, 'source/dev/force-app/main/default/labels');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'CustomLabels.labels-meta.xml'), '<?xml version="1.0"?><CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata"><labels><fullName>Greeting</fullName><value>Hi</value></labels></CustomLabels>');
    B.buildBrain(ws.root, ws.cfg, 'dev');
    for (const [key, comp, expect] of [['LIT-1', 'CustomLabels:CustomLabels', 'lite'], ['LIT-2', 'ApexClass:CaseService', 'full']]) {
      T.openTicket(ws.root, ws.cfg, { key, lite: true });
      T.importTicket(ws.root, ws.cfg, key, ticket('config'));
      const ev = addEvidence(ws.root, key, { kind: 'brain', org: 'dev', actor: 'analyst', summary: 'fact', payload: {} }).id;
      writeOut(ws, key, '01-understanding', understanding(key, ev, { risk: 'low', lite_candidate: true, affected: [{ component: comp, why: 'text change', proof: [ev] }] }));
      assert.equal(T.submit(ws.root, ws.cfg, key, 'understand', { actor: 'analyst' }).passed, true);
      if (T.loadTicket(ws.root, key).stages.understand.status === 'awaiting_lead') leadOk(ws, key, 'understand');
      assert.equal(T.loadTicket(ws.root, key).path, expect, `${key} claims lite; engine says ${expect}`);
    }
    assert.equal(T.next(ws.root, ws.cfg, 'LIT-1').mode, 'light');
    assert.deepEqual(T.stagesOf(ws.root).find((s) => s.id === 'repro').gates, ['contract', 'evidence', 'repro-proof', 'data-safe'], 'gates are the same on both paths');
  } finally { cleanup(ws); }
});

/** Drive a ticket to the test stage quickly, then let QA fail repeatedly. */
test('a failing test loops back to plan, at most loop.max times, then stops with a full report', () => {
  const { ws, ev } = start('LOO-1', 'feature');
  const { root, cfg } = ws;
  const key = 'LOO-1';
  try {
    const paths = ['source/dev/force-app/main/default/classes/CaseService.cls'];
    const round = (n) => {
      if (n === 0) {
        writeOut(ws, key, '01-understanding', understanding(key, ev)); T.submit(root, cfg, key, 'understand', { actor: 'analyst' }); leadOk(ws, key, 'understand');
        const q = O.query(root, cfg, { org: 'dev', soql: 'SELECT Id FROM Case LIMIT 1', key, actor: 'reproducer' }).evidence;
        writeOut(ws, key, '02-repro', { key, mode: 'feature', reproduced: 'not_applicable', org: 'dev', steps: [{ n: 1, action: 'Read current cases', expected: 'n/a', actual: 'n/a', proof: [q] }], data_used: [], before_state: { text: 'Today every High case gets Auto and nothing else is set.', proof: [q] }, claims: [] });
        T.submit(root, cfg, key, 'repro', { actor: 'reproducer' }); leadOk(ws, key, 'repro');
      }
      writeOut(ws, key, '03-plan', { key, approach: `Round ${n}: adjust CaseService.applyEscalation to the requested rule and cover it with tests.`, components: [{ ref: 'ApexClass:CaseService', change: 'modify', what: 'change rule', why: 'Needed for AC1' }], order: ['ApexClass:CaseService'], tests: [{ id: 'T1', covers: ['AC1'], kind: 'apex', description: 'rule holds' }], manual_steps: [], risks: [], rollback: 'Redeploy the backup of CaseService.', regression_tests: ['CaseServiceTest'], self_review: SELF_REVIEW, claims: [] });
      assert.equal(T.submit(root, cfg, key, 'plan', { actor: 'planner' }).passed, true);
      leadOk(ws, key, 'plan'); T.human.approve(root, cfg, key, {});
      const bk = O.backup(root, cfg, { key, refs: ['ApexClass:CaseService'], actor: 'baseline' });
      writeOut(ws, key, '00-baseline', { key, backups: [{ ref: 'ApexClass:CaseService', status: 'backed_up', evidence: bk.evidence || 'E003' }], tests: [] });
      const f = path.join(root, paths[0]);
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('public static void applyEscalation', `// ${new Date().toISOString().slice(0, 10)} | ${key} | Orgtomo | round ${n}\n    public static void applyEscalation`));
      const dep = O.deploy(root, cfg, { key, paths, actor: 'builder', ticket: T.loadTicket(root, key) });
      writeOut(ws, key, '04-build', { key, components: [{ ref: 'ApexClass:CaseService', path: paths[0], change: 'modify' }], deviations: [], deploy: { org: 'dev', evidence: dep.evidence }, unit_tests_added: [], claims: [{ id: 'C1', text: 'CaseService was deployed to dev.', proof: [dep.evidence] }] });
      const b = T.submit(root, cfg, key, 'build', { actor: 'builder' });
      assert.equal(b.passed, true, JSON.stringify(b.failed));
      leadOk(ws, key, 'build');
      const tr = O.apexTest(root, cfg, { org: 'dev', classes: ['CaseServiceTest'], key, actor: 'tester' });
      writeOut(ws, key, '05-qa', { key, org: 'dev', results: [{ test: 'T1', covers: ['AC1'], outcome: 'fail', proof: [tr.evidence] }], regression: [], repro_rerun: { outcome: 'not_applicable', proof: [] }, bulk: { tested: false, records: 0 }, verdict: 'fail', failures: [{ test: 'T1', why: 'Medium cases still get the reason Auto after the change.', suspected_stage: 'plan', proof: [tr.evidence] }], claims: [{ id: 'C1', text: 'Test T1 failed in dev after the deploy.', proof: [tr.evidence] }] });
      const s = T.submit(root, cfg, key, 'test', { actor: 'tester' });
      assert.equal(s.passed, true, 'an honest failing report passes its gates: ' + JSON.stringify(s.failed));
      return leadOk(ws, key, 'test');
    };
    let r = round(0);
    assert.equal(r.loop, 1);
    assert.equal(T.loadTicket(root, key).stage, 'plan');
    assert.ok(fs.readFileSync(path.join(ws.L.ticketDir(key), 'updates.md'), 'utf8').includes('loop 1: back to plan'));
    r = round(1);
    assert.equal(r.loop, 2);
    r = round(2);
    assert.equal(r.escalated, true, 'third failure with loop.max 2 stops the ticket');
    const t = T.loadTicket(root, key);
    assert.equal(t.status, 'escalated');
    const esc = fs.readFileSync(path.join(ws.L.ticketDir(key), 'escalation.md'), 'utf8');
    assert.match(esc, /a human decision is needed/);
    assert.ok(L.listObservations(root, { ticket: key }).filter((o) => o.signature === 'loop:test' && o.agent === 'planner').length === 3);
    assert.throws(() => T.human.resume(root, cfg, key, { note: '' }), /Give a direction/);
    T.human.resume(root, cfg, key, { note: 'Use a custom metadata list of priorities instead.' });
    assert.equal(T.loadTicket(root, key).stage, 'plan');
    assert.equal(T.loadTicket(root, key).loops, 0);
  } finally { cleanup(ws); }
});

test('build gates: scope, backup, naming, comments, forbidden patterns, stale deploy', () => {
  const { ws, ev } = start('BLD-1', 'feature');
  const { root, cfg } = ws;
  const key = 'BLD-1';
  try {
    writeOut(ws, key, '01-understanding', understanding(key, ev)); T.submit(root, cfg, key, 'understand', { actor: 'analyst' }); leadOk(ws, key, 'understand');
    const q = O.query(root, cfg, { org: 'dev', soql: 'SELECT Id FROM Case LIMIT 1', key, actor: 'reproducer' }).evidence;
    writeOut(ws, key, '02-repro', { key, mode: 'feature', reproduced: 'not_applicable', org: 'dev', steps: [{ n: 1, action: 'Read', expected: 'n/a', actual: 'n/a', proof: [q] }], data_used: [], before_state: { text: 'There is no routing class in the org today.', proof: [q] }, claims: [] });
    T.submit(root, cfg, key, 'repro', { actor: 'reproducer' }); leadOk(ws, key, 'repro');
    const plan = { key, approach: 'Add a routing class next to CaseService and call it from the existing service method.', components: [{ ref: 'ApexClass:caseRouter', change: 'new', what: 'routing logic', why: 'Needed for AC1' }, { ref: 'ApexClass:Missing', change: 'modify', what: 'x change', why: 'Needed for AC1' }, { ref: 'ApexClass:CaseService', change: 'new', what: 'x change', why: 'Needed for AC1' }], order: ['ApexClass:caseRouter'], tests: [{ id: 'T1', covers: ['AC2'], kind: 'apex', description: 'routing works' }], manual_steps: [], risks: [], rollback: 'Delete the new class again.', regression_tests: ['CaseServiceTest'], self_review: SELF_REVIEW, claims: [] };
    writeOut(ws, key, '03-plan', plan);
    let r = T.submit(root, cfg, key, 'plan', { actor: 'planner' });
    const why = Object.fromEntries(r.failed.map((f) => [f.id, f.details.join(' | ')]));
    assert.match(why['plan-grounding'], /ApexClass:Missing is to be modified but is not in the Org Brain/);
    assert.match(why['plan-grounding'], /ApexClass:CaseService is marked new but already exists/);
    assert.match(why['plan-coverage'], /AC1 is not covered/);
    assert.match(why['naming-plan'], /caseRouter/);
    writeOut(ws, key, '03-plan', { ...plan, components: [{ ref: 'ApexClass:CaseRoutingService', change: 'new', what: 'routing logic', why: 'Needed for AC1' }, { ref: 'ApexClass:CaseService', change: 'modify', what: 'call the router', why: 'Needed for AC1' }], order: ['ApexClass:CaseRoutingService', 'ApexClass:CaseService'], tests: [{ id: 'T1', covers: ['AC1'], kind: 'apex', description: 'routing works' }] });
    r = T.submit(root, cfg, key, 'plan', { actor: 'planner' });
    assert.equal(r.passed, true, JSON.stringify(r.failed));
    leadOk(ws, key, 'plan'); T.human.approve(root, cfg, key, {});

    const dir = path.join(root, 'source/dev/force-app/main/default/classes');
    fs.writeFileSync(path.join(dir, 'CaseRoutingService.cls'), "public class CaseRoutingService {\n\tpublic static Id queue() { System.debug('x'); return '00G5g000004XyZAEA0'; }\n}\n");
    fs.writeFileSync(path.join(dir, 'CaseRoutingService.cls-meta.xml'), '<?xml version="1.0"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>');
    fs.appendFileSync(path.join(dir, 'CaseService.cls'), '// touched\n');
    const p = (n) => `source/dev/force-app/main/default/classes/${n}.cls`;
    assert.throws(() => O.deploy(root, cfg, { key, paths: [p('CaseRoutingService'), p('CaseService')], actor: 'builder', ticket: T.loadTicket(root, key) }), /Backup first/);
    O.backup(root, cfg, { key, refs: ['ApexClass:CaseRoutingService', 'ApexClass:CaseService'], actor: 'builder' });
    const dep = O.deploy(root, cfg, { key, paths: [p('CaseRoutingService'), p('CaseService')], actor: 'builder', ticket: T.loadTicket(root, key) });
    fs.appendFileSync(path.join(dir, 'CaseService.cls'), '// edited after deploy\n');
    writeOut(ws, key, '00-baseline', { key, backups: [], tests: [] });
    writeOut(ws, key, '04-build', { key, components: [{ ref: 'ApexClass:CaseRoutingService', path: p('CaseRoutingService'), change: 'new' }, { ref: 'ApexClass:CaseService', path: p('CaseService'), change: 'modify' }, { ref: 'ApexTrigger:CaseTrigger', path: 'source/dev/force-app/main/default/triggers/CaseTrigger.trigger', change: 'modify' }], deviations: [], deploy: { org: 'dev', evidence: dep.evidence }, unit_tests_added: [], claims: [] });
    r = T.submit(root, cfg, key, 'build', { actor: 'builder' });
    const b = Object.fromEntries(r.failed.map((f) => [f.id, f.details.join(' | ')]));
    assert.match(b['scope-check'], /ApexTrigger:CaseTrigger was built but is not in the plan/);
    assert.match(b['backup-check'], /ApexTrigger:CaseTrigger was changed without a recorded backup/);
    assert.match(b['comment-lint'], /CaseRoutingService: header comment is missing @description/);
    assert.match(b['comment-lint'], /CaseService: no change line for BLD-1/);
    assert.match(b['format-lint'], /tab indentation/);
    assert.match(b['format-lint'], /no sharing declaration/);
    assert.match(b['forbidden-lint'], /hard-coded-id/);
    assert.match(b['forbidden-lint'], /system-debug/);
    assert.match(b['deploy-check'], /changed after deploy/);
    assert.throws(() => O.deploy(root, cfg, { key, paths: ['source/uat/force-app/main/default/classes/CaseService.cls'], actor: 'builder', ticket: T.loadTicket(root, key) }), /Only files under source\/dev/);
    // restore puts the backed-up version back in source and in the org; what the ticket created is reported, not deleted
    const original = fs.readFileSync(path.join(ws.L.ticketDir(key), 'backup/dev/classes/CaseService.cls'), 'utf8');
    assert.notEqual(fs.readFileSync(path.join(ws.orgDirs['t-dev'], 'classes/CaseService.cls'), 'utf8'), original);
    const back = O.restore(root, cfg, { key });
    assert.equal(back.ok, true);
    assert.deepEqual(back.restored, ['ApexClass:CaseService']);
    assert.deepEqual(back.created_by_ticket_still_in_org, ['ApexClass:CaseRoutingService']);
    assert.equal(fs.readFileSync(path.join(ws.orgDirs['t-dev'], 'classes/CaseService.cls'), 'utf8'), original);
    assert.equal(fs.readFileSync(path.join(dir, 'CaseService.cls'), 'utf8'), original);
  } finally { cleanup(ws); }
});

test('production: reads are masked and bounded; every write path refuses', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    const r = O.query(root, cfg, { org: 'prod', soql: 'SELECT Id, Subject, SuppliedEmail FROM Case LIMIT 5' });
    assert.equal(r.masked, true);
    assert.ok(!JSON.stringify(r).includes('real.person@client.org'));
    assert.throws(() => O.query(root, cfg, { org: 'prod', soql: 'SELECT Id FROM Case' }), /LIMIT/);
    assert.throws(() => O.query(root, cfg, { org: 'prod', soql: "UPDATE Case SET Status = 'x'" }), /SELECT/);
    assert.throws(() => O.query(root, cfg, { org: 'prod', soql: 'SELECT Id FROM Case LIMIT 1; DROP' }), /single SELECT/);
    fs.writeFileSync(path.join(root, 'x.apex'), "System.debug('x');");
    assert.throws(() => O.apexRun(root, cfg, { org: 'prod', file: 'x.apex' }), /may not run Apex in "prod"/);
    assert.throws(() => O.apexTest(root, cfg, { org: 'prod', classes: ['X'] }), /never started in production/);
    assert.throws(() => O.canary(root, cfg, 'prod'), /never run in production/);
    // an org that orgs.yaml calls a sandbox but that answers IsSandbox = false is refused
    const s = JSON.parse(fs.readFileSync(ws.stateFile, 'utf8')); s.production.push('t-uat'); fs.writeFileSync(ws.stateFile, JSON.stringify(s));
    assert.throws(() => O.verifyOrg(root, cfg, 'uat'), /reports IsSandbox = false/);
    assert.throws(() => O.apexRun(root, cfg, { org: 'uat', file: 'x.apex' }), /IsSandbox = false|not a sandbox/);
  } finally { cleanup(ws); }
});

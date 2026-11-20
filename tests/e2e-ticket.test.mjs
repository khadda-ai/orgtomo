// One ticket from "open" to "done" with no network: every gate, the Lead's
// check, two human approvals, two human deploys, parity, retest and learning.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, writeOut, copyDir, cleanup } from './helpers.mjs';
import * as T from '../engine/lib/ticket.js';
import * as O from '../engine/lib/org.js';
import * as B from '../engine/lib/brain.js';
import * as L from '../engine/lib/learning.js';
import { addEvidence, listEvidence } from '../engine/lib/evidence.js';
import { buildPack } from '../engine/lib/deploypack.js';

const KEY = 'ABC-12';

test('a bug ticket runs from open to done', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    assert.equal(B.buildBrain(root, cfg, 'uat').components, 8);
    B.buildBrain(root, cfg, 'dev');

    // open + import: a real address in the ticket text never reaches the vault
    T.openTicket(root, cfg, { key: KEY });
    T.importTicket(root, cfg, KEY, {
      title: 'Escalated cases get reason Auto even for Medium priority', type: 'bug',
      description: 'Reported by jane.roe@client.org: medium cases are stamped Auto.',
      acceptance_criteria: [{ id: 'AC1', text: 'Only High priority cases get reason Auto.' }],
      source: { tool: 'mcp__atlassian__getJiraIssue', fetched_at: '2026-11-19T10:00:00Z' },
    }, { actor: 'lead' });
    const stored = fs.readFileSync(path.join(ws.L.ticketDir(KEY), '00-ticket.json'), 'utf8');
    assert.ok(!stored.includes('jane.roe@client.org'), 'address redacted');
    assert.equal(T.next(root, cfg, KEY).do[0].who, 'analyst');
    B.contextPack(root, cfg, KEY, { terms: ['Escalation', 'Case'] });

    // understand
    const e1 = O.query(root, cfg, { org: 'dev', soql: 'SELECT Id, Subject, SuppliedEmail FROM Case LIMIT 5', key: KEY, actor: 'analyst' });
    assert.ok(!JSON.stringify(e1.records).includes('real.person@client.org'), 'sandbox read is masked');
    const understanding = {
      key: KEY, summary_plain: 'Cases that are not urgent are being marked as automatically escalated. Only urgent cases should be.',
      summary_technical: 'CaseService.applyEscalation sets Escalation_Reason__c to Auto; the condition must be limited to Priority High.',
      acceptance_criteria: [{ id: 'AC1', text: 'Only High priority cases get reason Auto.', source: 'ticket' }],
      examples: [{ title: 'Medium case', given: 'a Medium priority case', when: 'it is saved', then: 'the reason stays empty' }],
      affected: [{ component: 'ApexClass:CaseService', why: 'holds the escalation rule', proof: [e1.evidence] }],
      open_questions: [], risk: 'medium', lite_candidate: false,
      claims: [{ id: 'C1', text: 'The Case object in dev has cases with a Subject and a status.', proof: [e1.evidence] }],
    };
    writeOut(ws, KEY, '01-understanding', understanding);
    let r = T.submit(root, cfg, KEY, 'understand', { actor: 'analyst' });
    assert.equal(r.passed, true, JSON.stringify(r.failed));
    const lead1 = O.query(root, cfg, { org: 'dev', soql: 'SELECT Id, Subject FROM Case LIMIT 5', key: KEY, actor: 'lead' });
    r = T.leadVerify(root, cfg, KEY, 'understand', { claim: 'C1', evidence: lead1.evidence, result: 'match', actor: 'lead' });
    assert.equal(T.loadTicket(root, KEY).stage, 'repro');
    assert.equal(T.loadTicket(root, KEY).path, 'full');

    // repro: data proof from the build org, after the e-mail canary
    assert.equal(O.canary(root, cfg, 'dev').status, 'blocked');
    fs.writeFileSync(path.join(ws.L.ticketDir(KEY), 'work', 'repro.apex'), "insert new Case(Subject = 'Orgtomo repro medium case', Priority = 'Medium');\n");
    const run = O.apexRun(root, cfg, { org: 'dev', file: `vault/tickets/${KEY}/work/repro.apex`, key: KEY, actor: 'reproducer' });
    const q2 = O.query(root, cfg, { org: 'dev', soql: "SELECT Id, Escalation_Reason__c FROM Case WHERE Subject = 'Orgtomo repro medium case' LIMIT 1", key: KEY, actor: 'reproducer' });
    writeOut(ws, KEY, '02-repro', {
      key: KEY, mode: 'bug', reproduced: true, org: 'dev',
      steps: [{ n: 1, action: 'Insert a Medium priority case', expected: 'Reason stays empty', actual: 'Reason is Auto', proof: [run.evidence, q2.evidence] }],
      data_used: [{ object: 'Case', created_by_ticket: true }],
      before_state: { text: 'Medium priority case is stamped with reason Auto on insert.', proof: [q2.evidence] },
      root_cause: { text: 'The trigger calls applyEscalation for every case and the priority check is wrong.', proof: [q2.evidence] },
      claims: [{ id: 'C1', text: 'A Medium priority case inserted in dev gets reason Auto.', proof: [q2.evidence] }],
    });
    r = T.submit(root, cfg, KEY, 'repro', { actor: 'reproducer' });
    assert.equal(r.passed, true, JSON.stringify(r.failed));
    const lead2 = O.query(root, cfg, { org: 'dev', soql: "SELECT Id FROM Case WHERE Subject = 'Orgtomo repro medium case' LIMIT 1", key: KEY, actor: 'lead' });
    T.leadVerify(root, cfg, KEY, 'repro', { claim: 'C1', evidence: lead2.evidence, result: 'match', actor: 'lead' });

    // plan: grounded in the Brain, then human approval
    const fact = addEvidence(root, KEY, { kind: 'brain', org: 'dev', actor: 'planner', summary: 'CaseService in Brain', payload: B.brainFact(root, cfg, 'dev', 'ApexClass:CaseService') });
    writeOut(ws, KEY, '03-plan', {
      key: KEY, approach: 'Tighten the priority condition inside CaseService.applyEscalation and extend the existing test class.',
      components: [{ ref: 'ApexClass:CaseService', change: 'modify', what: 'limit the rule to High priority', why: 'Needed for AC1', proof: [fact.id] }, { ref: 'ApexClass:CaseServiceTest', change: 'modify', what: 'add a Medium priority test', why: 'Needed for AC1' }],
      order: ['ApexClass:CaseService', 'ApexClass:CaseServiceTest'],
      tests: [{ id: 'T1', covers: ['AC1'], kind: 'apex', description: 'Medium case keeps an empty reason; High case gets Auto' }],
      manual_steps: [], risks: [{ text: 'Other callers of applyEscalation', mitigation: 'Brain shows only CaseTrigger and one flow action' }],
      rollback: 'Redeploy the backed up CaseService and CaseServiceTest.', claims: [{ id: 'C1', text: 'CaseService exists in dev and is used by CaseTrigger.', proof: [fact.id] }],
    });
    r = T.submit(root, cfg, KEY, 'plan', { actor: 'planner' });
    assert.equal(r.passed, true, JSON.stringify(r.failed));
    const lead3 = addEvidence(root, KEY, { kind: 'brain', org: 'dev', actor: 'lead', summary: 'recheck', payload: {} });
    r = T.leadVerify(root, cfg, KEY, 'plan', { claim: 'C1', evidence: lead3.id, result: 'match', actor: 'lead' });
    assert.equal(r.awaiting, 'approval');
    assert.throws(() => T.submit(root, cfg, KEY, 'build', { actor: 'builder' }), /awaiting_human/);
    T.human.approve(root, cfg, KEY, { note: 'ok' });
    assert.equal(T.loadTicket(root, KEY).stage, 'build');

    // build: baseline first, backup enforced, lint gates on the changed lines
    assert.equal(T.next(root, cfg, KEY).do[0].who, 'baseline');
    const bk = O.backup(root, cfg, { key: KEY, refs: ['ApexClass:CaseService', 'ApexClass:CaseServiceTest'], actor: 'baseline' });
    const baseTest = O.apexTest(root, cfg, { org: 'dev', classes: ['CaseServiceTest'], key: KEY, actor: 'baseline' });
    writeOut(ws, KEY, '00-baseline', { key: KEY, backups: bk.backed_up.map((ref) => ({ ref, status: 'backed_up', evidence: bk.evidence })), tests: [{ name: 'CaseServiceTest.appliesEscalationInBulk', outcome: 'pass', evidence: baseTest.evidence }] });
    const cls = path.join(root, 'source/dev/force-app/main/default/classes/CaseService.cls');
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(cls, fs.readFileSync(cls, 'utf8').replace("if (c.Priority == 'High' && c.Escalation_Reason__c == null) {", `// ${day} | ${KEY} | Orgtomo | Only High priority cases are stamped\n            if (c.Priority == 'High' && c.Escalation_Reason__c == null && !c.IsClosed) {`));
    const tcls = path.join(root, 'source/dev/force-app/main/default/classes/CaseServiceTest.cls');
    fs.writeFileSync(tcls, fs.readFileSync(tcls, 'utf8').replace('@IsTest\nprivate class', `// ${day} | ${KEY} | Orgtomo | Added the Medium priority case\n@IsTest\nprivate class`));
    const paths = ['source/dev/force-app/main/default/classes/CaseService.cls', 'source/dev/force-app/main/default/classes/CaseServiceTest.cls'];
    const dep = O.deploy(root, cfg, { key: KEY, paths, actor: 'builder', ticket: T.loadTicket(root, KEY) });
    assert.equal(dep.ok, true);
    writeOut(ws, KEY, '04-build', {
      key: KEY, components: [{ ref: 'ApexClass:CaseService', path: paths[0], change: 'modify' }, { ref: 'ApexClass:CaseServiceTest', path: paths[1], change: 'modify' }],
      deviations: [], deploy: { org: 'dev', evidence: dep.evidence }, unit_tests_added: ['CaseServiceTest'],
      claims: [{ id: 'C1', text: 'Both classes were deployed to dev without failures.', proof: [dep.evidence] }],
    });
    r = T.submit(root, cfg, KEY, 'build', { actor: 'builder' });
    assert.equal(r.passed, true, JSON.stringify(r.failed));
    const lead4 = addEvidence(root, KEY, { kind: 'retrieve', org: 'dev', actor: 'lead', summary: 'recheck deploy', payload: {} });
    T.leadVerify(root, cfg, KEY, 'build', { claim: 'C1', evidence: lead4.id, result: 'match', actor: 'lead' });

    // test
    const tr = O.apexTest(root, cfg, { org: 'dev', classes: ['CaseServiceTest'], key: KEY, actor: 'tester' });
    const rr = O.query(root, cfg, { org: 'dev', soql: "SELECT Id, Escalation_Reason__c FROM Case WHERE Subject = 'Orgtomo retest medium case' LIMIT 1", key: KEY, actor: 'tester' });
    const qa = (org, proof, rerun) => ({
      key: KEY, org, results: [{ test: 'T1', covers: ['AC1'], outcome: 'pass', proof }],
      regression: [{ name: 'CaseServiceTest.appliesEscalationInBulk', outcome: 'pass', evidence: proof[0] }],
      repro_rerun: { outcome: 'fixed', proof: rerun }, bulk: { tested: true, records: 200, proof }, verdict: 'pass', failures: [],
      claims: [{ id: 'C1', text: 'CaseServiceTest passes in the org after the change.', proof }],
    });
    writeOut(ws, KEY, '05-qa', qa('dev', [tr.evidence], [rr.evidence]));
    r = T.submit(root, cfg, KEY, 'test', { actor: 'tester' });
    assert.equal(r.passed, true, JSON.stringify(r.failed));
    const lead5 = O.apexTest(root, cfg, { org: 'dev', classes: ['CaseServiceTest'], key: KEY, actor: 'lead' });
    T.leadVerify(root, cfg, KEY, 'test', { claim: 'C1', evidence: lead5.evidence, result: 'match', actor: 'lead' });

    // review: human approval guards the deploy pack
    assert.throws(() => buildPack(root, cfg, KEY), /not in handoff/);
    writeOut(ws, KEY, '06-review', {
      key: KEY, verdict: 'approve',
      rubric: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11'].map((id) => ({ id, result: 'pass', proof: [tr.evidence] })),
      findings: [], claims: [{ id: 'C1', text: 'The change is limited to the two planned classes.', proof: [dep.evidence] }],
    });
    r = T.submit(root, cfg, KEY, 'review', { actor: 'reviewer' });
    assert.equal(r.awaiting, 'approval', JSON.stringify(r));
    T.human.approve(root, cfg, KEY, {});
    assert.equal(T.loadTicket(root, KEY).stage, 'handoff');

    // handoff: uat (human deploy, parity, retest) then prod (parity only)
    const pack = buildPack(root, cfg, KEY);
    assert.equal(pack.org, 'uat');
    assert.ok(fs.existsSync(path.join(root, pack.dir, 'package.xml')));
    assert.ok(fs.readFileSync(path.join(root, pack.dir, 'INSTRUCTIONS.md'), 'utf8').includes('Deployment Request'));
    assert.equal(T.loadTicket(root, KEY).await.kind, 'deploy');
    T.human.deployed(root, cfg, KEY, { org: 'uat' });
    let par = O.parity(root, cfg, { key: KEY, org: 'uat', components: JSON.parse(fs.readFileSync(path.join(ws.L.ticketDir(KEY), '04-build.json'))).components });
    assert.equal(par.ok, false, 'parity fails while the human has not really deployed');
    r = T.recordParity(root, cfg, KEY, par);
    assert.equal(T.loadTicket(root, KEY).await.problem.includes('different'), true);
    copyDir(path.join(root, pack.dir, 'force-app/main/default'), ws.orgDirs['t-uat']);
    T.human.deployed(root, cfg, KEY, { org: 'uat' });
    par = O.parity(root, cfg, { key: KEY, org: 'uat', components: JSON.parse(fs.readFileSync(path.join(ws.L.ticketDir(KEY), '04-build.json'))).components });
    assert.equal(par.ok, true);
    T.recordParity(root, cfg, KEY, par);
    assert.equal(O.canary(root, cfg, 'uat').status, 'blocked');
    const utr = O.apexTest(root, cfg, { org: 'uat', classes: ['CaseServiceTest'], key: KEY, actor: 'tester' });
    writeOut(ws, KEY, '05-qa-uat', qa('uat', [utr.evidence], [utr.evidence]));
    r = T.submit(root, cfg, KEY, 'handoff', { actor: 'tester' });
    assert.equal(r.passed, true, JSON.stringify(r.failed));
    const pack2 = buildPack(root, cfg, KEY);
    assert.equal(pack2.org, 'prod');
    copyDir(path.join(root, pack2.dir, 'force-app/main/default'), ws.orgDirs['t-prod']);
    T.human.deployed(root, cfg, KEY, { org: 'prod' });
    par = O.parity(root, cfg, { key: KEY, org: 'prod', components: JSON.parse(fs.readFileSync(path.join(ws.L.ticketDir(KEY), '04-build.json'))).components });
    T.recordParity(root, cfg, KEY, par);
    assert.equal(T.loadTicket(root, KEY).stage, 'close');

    // close: evidence-backed retro, drafts only
    const obs = L.listObservations(root, { ticket: KEY });
    assert.ok(obs.some((o) => o.kind === 'good'));
    assert.ok(obs.some((o) => o.signature === 'parity:blue-canvas'));
    writeOut(ws, KEY, '08-comms', { key: KEY, never_posted: true, drafts: [{ channel: 'tracker', audience: ['Reporter'], level: 'non_technical', text: 'Fixed: only urgent cases are now marked as automatically escalated. Verified in UAT.' }] });
    r = T.submit(root, cfg, KEY, 'close', { actor: 'scribe' });
    assert.equal(r.done, true, JSON.stringify(r));
    assert.equal(T.loadTicket(root, KEY).status, 'done');
    assert.ok(listEvidence(root, KEY).length > 12);
    assert.ok(fs.readFileSync(path.join(ws.L.ticketDir(KEY), 'status.md'), 'utf8').includes('done'));
  } finally { cleanup(ws); }
});

// Org Brain, self-learning, people profiles, meeting notes, sync and the CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorkspace, cleanup, HERE } from './helpers.mjs';
import * as B from '../engine/lib/brain.js';
import * as L from '../engine/lib/learning.js';
import * as P from '../engine/lib/people.js';
import * as M from '../engine/lib/meetings.js';
import * as T from '../engine/lib/ticket.js';
import { sync, renderAgent, renderMcp } from '../engine/lib/sync.js';
import { doctor } from '../engine/lib/doctor.js';
import { loadConfig, setConfigValue } from '../engine/lib/config.js';
import { parseFrontmatter } from '../engine/lib/util.js';

test('Org Brain: facts, links, save order, staleness, drift, context pack', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    const r = B.buildBrain(root, cfg, 'uat');
    assert.deepEqual(r.by_type, { ApexClass: 2, ApexTrigger: 1, CustomField: 1, Flow: 1, LightningComponentBundle: 1, PermissionSet: 1, ValidationRule: 1 });
    const idx = JSON.parse(fs.readFileSync(path.join(root, 'vault/orgs/uat/_index.json'), 'utf8'));
    const svc = idx.components['ApexClass:CaseService'];
    assert.deepEqual(svc.used_by, ['ApexClass:CaseServiceTest', 'ApexTrigger:CaseTrigger', 'Flow:Case_AfterSave_Notify_Owner', 'LightningComponentBundle:caseSummary', 'PermissionSet:Support_Agent']);
    assert.ok(svc.deps.includes('CustomField:Case.Escalation_Reason__c'));
    assert.equal(svc.facts.sharing, 'with sharing');
    assert.equal(idx.components['Flow:Case_AfterSave_Notify_Owner'].facts.trigger_type, 'RecordAfterSave');
    assert.deepEqual(idx.components['ApexTrigger:CaseTrigger'].facts.events, ['before insert', 'before update']);
    const note = fs.readFileSync(path.join(root, 'vault/orgs/uat/facts/ApexClass/CaseService.md'), 'utf8');
    assert.equal(parseFrontmatter(note).data.sha256, svc.sha256);
    assert.match(note, /\[\[orgs\/uat\/facts\/ApexTrigger\/CaseTrigger\|CaseTrigger\]\]/);
    const auto = fs.readFileSync(path.join(root, 'vault/orgs/uat/facts/_automation/Case.md'), 'utf8');
    assert.ok(auto.indexOf('Before triggers') < auto.indexOf('Validation rules') && auto.indexOf('Validation rules') < auto.indexOf('After-save record-triggered flows'));
    const canvas = JSON.parse(fs.readFileSync(path.join(root, 'vault/orgs/uat/maps/Case.canvas'), 'utf8'));
    assert.ok(canvas.nodes.length >= 5 && canvas.edges.every((e) => canvas.nodes.some((n) => n.id === e.fromNode) && canvas.nodes.some((n) => n.id === e.toNode)));
    assert.ok(fs.existsSync(path.join(root, 'vault/orgs/uat/Components.base')));

    assert.deepEqual(B.brainStatus(root, cfg, 'uat').stale, []);
    assert.equal(B.buildBrain(root, cfg, 'uat').changed.length, 0, 'second build changes nothing');
    const cls = path.join(root, 'source/uat/force-app/main/default/classes/CaseService.cls');
    fs.appendFileSync(cls, '// changed in the org\n');
    assert.deepEqual(B.brainStatus(root, cfg, 'uat').stale, ['ApexClass:CaseService']);
    assert.equal(B.brainFact(root, cfg, 'uat', 'ApexClass:CaseService').fresh, false);
    assert.throws(() => B.brainFact(root, cfg, 'uat', 'ApexClass:Nope'), /not in the Org Brain/);
    assert.deepEqual(B.buildBrain(root, cfg, 'uat').changed, ['ApexClass:CaseService']);
    assert.match(fs.readFileSync(path.join(root, 'vault/log.md'), 'utf8'), /1 changed/);

    B.buildBrain(root, cfg, 'dev');
    const d = B.drift(root, cfg, 'uat', 'dev');
    assert.equal(d.different, 1);
    assert.ok(B.search(root, cfg, 'uat', ['escalation'])[0].ref.includes('Escalation'));
    T.openTicket(root, cfg, { key: 'CTX-1' });
    const pack = B.contextPack(root, cfg, 'CTX-1', { terms: ['CaseTrigger'] });
    assert.ok(pack.matched >= 1 && pack.nearby >= 1);
    assert.match(fs.readFileSync(path.join(root, 'vault/tickets/CTX-1/context-pack.md'), 'utf8'), /What runs on Case/);
  } finally { cleanup(ws); }
});

test('self-learning: only recorded facts become lessons, and recurrence is tracked', () => {
  const ws = makeWorkspace();
  const { root, cfg } = ws;
  try {
    const o1 = L.observe(root, { ticket: 'A-1', stage: 'build', agent: 'builder', kind: 'mistake', source: 'gate', signature: 'gate:comment-lint', fact: 'Gate comment-lint failed: no change line' });
    assert.throws(() => L.proposeLessons(root, cfg, [{ agent: 'builder', type: 'avoid', rule: 'Always add the change line.', why: 'x'.repeat(12), observations: ['O-9999'] }]), /unknown observation/);
    let [l] = L.proposeLessons(root, cfg, [{ agent: 'builder', type: 'avoid', rule: 'Add the change line with the ticket key to every modified Apex file.', why: 'The comment gate rejected the build.', observations: [o1.id] }]);
    assert.equal(l.status, 'proposed', 'one observation is not enough to apply by itself');
    assert.equal(L.lessonsFor(root, 'builder').length, 0);
    const o2 = L.observe(root, { ticket: 'A-2', stage: 'build', agent: 'builder', kind: 'mistake', source: 'gate', signature: 'gate:comment-lint', fact: 'Gate comment-lint failed again' });
    [l] = L.proposeLessons(root, cfg, [{ agent: 'builder', type: 'avoid', rule: 'add the change line with the ticket key to every modified apex file', why: 'Happened twice.', observations: [o2.id] }]);
    assert.equal(l.status, 'approved');
    assert.equal(l.approved_by, 'auto');
    assert.equal(L.listLessons(root).length, 1, 'same rule is merged, not duplicated');
    assert.deepEqual(l.tickets, ['A-1', 'A-2']);
    L.observe(root, { ticket: 'A-3', stage: 'build', agent: 'builder', kind: 'mistake', source: 'gate', signature: 'gate:comment-lint', fact: 'and again' });
    assert.equal(L.listLessons(root)[0].recurrences, 1, 'the mistake came back after the lesson');
    L.observe(root, { ticket: 'A-3', stage: 'build', agent: 'tester', kind: 'mistake', source: 'gate', signature: 'gate:comment-lint', fact: 'other agent' });
    assert.equal(L.listLessons(root)[0].recurrences, 1);
    sync(root, cfg);
    const skill = fs.readFileSync(path.join(root, '.claude/skills/lessons-builder/SKILL.md'), 'utf8');
    assert.match(skill, /Add the change line/);
    assert.match(skill, /happened again 1 time/);
    assert.match(fs.readFileSync(path.join(root, '.claude/skills/lessons-tester/SKILL.md'), 'utf8'), /No lessons yet/);
    assert.match(fs.readFileSync(path.join(root, 'vault/learning/Lessons.md'), 'utf8'), /L-0001/);
    assert.match(fs.readFileSync(path.join(root, 'vault/learning/lessons/L-0001.md'), 'utf8'), /O-0001/);
    assert.equal(L.patterns(root)[0].count, 3);
    L.setLessonStatus(root, 'L-0001', 'retired');
    assert.equal(L.lessonsFor(root, 'builder').length, 0);
  } finally { cleanup(ws); }
});

test('people profiles: off by default, schema-bound, agents only propose', () => {
  const ws = makeWorkspace();
  const { root } = ws;
  try {
    assert.throws(() => P.setPerson(root, ws.cfg, 'Dana Lee', { side: 'client' }), /switched off/);
    assert.equal(P.audienceBrief(root, ws.cfg, ['Dana Lee']).enabled, false);
    const cfg = setConfigValue(root, 'features', 'people_profiles.enabled', true);
    P.setPerson(root, cfg, 'Dana Lee', { side: 'client', role: 'Support lead', salesforce_knowledge: 'basic', detail_level: 'short', prefers: ['plain words'], aliases: ['Dana'] });
    assert.throws(() => P.setPerson(root, cfg, 'Dana Lee', { mood: 'grumpy' }), /unknown field/);
    assert.throws(() => P.setPerson(root, cfg, 'Dana Lee', { salesforce_knowledge: 'guru' }), /must be one of/);
    assert.equal(P.findPerson(root, 'dana').name, 'Dana Lee');
    const p = P.proposeProfileNote(root, cfg, { person: 'Dana Lee', note: 'Asked for updates without technical terms', basis: 'meeting m-1', actor: 'notetaker' });
    assert.deepEqual(P.findPerson(root, 'Dana Lee').prefers, ['plain words'], 'a proposal changes nothing until confirmed');
    P.confirmProposal(root, cfg, p.id);
    assert.equal(P.findPerson(root, 'Dana Lee').prefers.length, 2);
    const brief = P.audienceBrief(root, cfg, ['Dana', 'Unknown Person']);
    assert.equal(brief.people.length, 1);
    assert.deepEqual(brief.unknown, ['Unknown Person']);
    assert.match(fs.readFileSync(path.join(root, 'vault/people/dana-lee.md'), 'utf8'), /confirmed P-0001 \(meeting m-1\)/);
    P.removePerson(root, cfg, 'Dana Lee');
    assert.ok(!fs.existsSync(path.join(root, 'vault/people/dana-lee.md')));
  } finally { cleanup(ws); }
});

test('meetings: explicit links attach, inferred links wait, addresses are redacted', () => {
  const ws = makeWorkspace();
  const { root } = ws;
  try {
    const meeting = { meeting_id: 'm-1', title: 'Support sync about ABC-12', date: '2026-11-18', provider: 'file', attendees: ['Dana Lee', 'Sam Roe'],
      summary: 'The team agreed that ABC-12 ships without the bulk screen. Contact pat@client.org for the priority list.',
      decisions: [{ text: 'ABC-12 ships without the bulk update screen.', said_by: 'Dana Lee', tickets: ['ABC-12'] }], action_items: [{ text: 'Confirm priorities', owner: 'Sam Roe' }],
      ticket_links: [{ key: 'ABC-12', basis: 'explicit', update: 'Decided: ships without the bulk update screen.' }, { key: 'ABC-40', basis: 'inferred', update: 'The routing discussion may change the queue used here.', reason: 'same queue' }] };
    assert.throws(() => M.ingest(root, ws.cfg, meeting), /switched off/);
    let cfg = setConfigValue(root, 'features', 'meetings.enabled', true);
    cfg = setConfigValue(root, 'features', 'meetings.provider', 'file');
    assert.equal(M.plan(root, cfg).provider, 'file');
    assert.throws(() => M.ingest(root, cfg, { ...meeting, ticket_links: [{ key: 'ZZZ-9', basis: 'explicit', update: 'Something about it here.' }] }), /does not appear in the meeting/);
    const r = M.ingest(root, cfg, meeting, { actor: 'notetaker' });
    assert.deepEqual(r.attached, ['ABC-12']);
    assert.equal(r.waiting_for_confirmation.length, 1);
    const note = fs.readFileSync(path.join(root, 'vault/meetings', `${r.stored}.md`), 'utf8');
    assert.ok(!note.includes('pat@client.org'));
    assert.match(fs.readFileSync(path.join(root, 'vault/tickets/ABC-12/updates.md'), 'utf8'), /ships without the bulk update screen/);
    assert.ok(!fs.existsSync(path.join(root, 'vault/tickets/ABC-40/updates.md')));
    M.confirmLink(root, cfg, r.waiting_for_confirmation[0], true);
    assert.match(fs.readFileSync(path.join(root, 'vault/tickets/ABC-40/updates.md'), 'utf8'), /routing discussion/);
    assert.deepEqual(M.plan(root, cfg).known_ids, ['m-1']);
    T.openTicket(root, cfg, { key: 'ABC-12' });
    assert.ok(T.next(root, cfg, 'ABC-12'));
    const mcp = renderMcp(root, setConfigValue(root, 'features', 'meetings.provider', 'granola'));
    assert.equal(mcp.mcpServers.granola.url, 'https://mcp.granola.ai/mcp');
  } finally { cleanup(ws); }
});

test('sync generates agents from configuration, and only what is switched on', () => {
  const ws = makeWorkspace();
  const { root } = ws;
  try {
    let cfg = loadConfig(root);
    const lead = fs.readFileSync(path.join(root, '.claude/agents/tomo-lead.md'), 'utf8');
    assert.match(lead, /^---\nname: tomo-lead\n/);
    assert.match(lead, /tools: Agent\(analyst, reproducer, planner, builder, tester, reviewer, cartographer, baseline, scribe, coach\), Read, Grep, Glob, Bash, mcp__atlassian__getJiraIssue/);
    assert.ok(!/\bWrite\b/.test(lead.split('---')[1]), 'the Lead has no Write tool');
    assert.match(lead, /model: sonnet\neffort: medium/);
    assert.ok(!lead.includes('{{'), 'no unfilled placeholder');
    const builder = fs.readFileSync(path.join(root, '.claude/agents/builder.md'), 'utf8');
    assert.match(builder, /execute_metadata_action/);
    assert.match(builder, /- org-naming\n  - org-comments\n  - org-format\n  - org-standards\n  - lessons-builder/);
    assert.ok(!fs.existsSync(path.join(root, '.claude/agents/notetaker.md')));
    const tester = fs.readFileSync(path.join(root, '.claude/agents/tester.md'), 'utf8');
    assert.ok(!tester.includes('browser_evaluate') && tester.includes('mcp__playwright__browser_snapshot'));
    for (const f of fs.readdirSync(path.join(root, '.claude/agents'))) assert.ok(!fs.readFileSync(path.join(root, '.claude/agents', f), 'utf8').includes('{{'), f);
    assert.match(fs.readFileSync(path.join(root, '.claude/skills/org-naming/SKILL.md'), 'utf8'), /Apex class/);
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
    assert.deepEqual([settings.env.DO_NOT_TRACK, settings.env.SF_DISABLE_TELEMETRY, settings.env.SF_PLUGIN_SKILLS_FIRST], ['true', 'true', 'enforce']);
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['atlassian', 'playwright']);
    assert.ok(mcp.mcpServers.playwright.args.includes('--user-data-dir'));

    cfg = setConfigValue(root, 'features', 'sf_skills.flow_generator', false);
    cfg = setConfigValue(root, 'features', 'sf_skills.telemetry', true);
    cfg = setConfigValue(root, 'agents', 'agents.scribe.enabled', false);
    cfg = setConfigValue(root, 'features', 'meetings.enabled', true);
    cfg = setConfigValue(root, 'agents', 'agents.planner.effort', 'max');
    const r = sync(root, cfg);
    assert.ok(r.removed.includes('.claude/agents/scribe.md'));
    assert.ok(!fs.readFileSync(path.join(root, '.claude/agents/builder.md'), 'utf8').includes('execute_metadata_action'));
    assert.ok(fs.existsSync(path.join(root, '.claude/agents/notetaker.md')));
    assert.match(fs.readFileSync(path.join(root, '.claude/agents/planner.md'), 'utf8'), /effort: max/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).env.DO_NOT_TRACK, undefined);
    assert.deepEqual(sync(root, cfg).written, [], 'sync is idempotent');
    assert.throws(() => setConfigValue(root, 'agents', 'agents.builder.model', 'gpt-x'), /not valid/);
    assert.throws(() => setConfigValue(root, 'agents', 'agents.tester.enabled', false), /core agent/);
    assert.match(fs.readFileSync(path.join(root, 'orgtomo.config/agents.yaml'), 'utf8'), /# One line per agent/, 'comments survive edits');
    assert.equal(renderAgent(cfg, 'reviewer').includes('model: fable'), true);
    const d = doctor(root);
    assert.equal(d.ok, true, JSON.stringify(d.checks.filter((c) => c.level === 'fail')));
    assert.ok(d.checks.some((c) => c.id === 'brain' && c.level === 'warn'));
  } finally { cleanup(ws); }
});

test('the CLI: JSON out, errors as JSON, human verbs closed to agents', () => {
  const ws = makeWorkspace();
  const { root } = ws;
  try {
    const cli = (args, env = {}) => spawnSync('node', [path.join(HERE, '..', 'engine', 'cli.js'), ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, ORGTOMO_WORKSPACE: root, ...env } });
    assert.equal(JSON.parse(cli(['brain', 'build', 'uat']).stdout).components, 8);
    assert.equal(JSON.parse(cli(['ticket', 'open', 'CLI-1']).stdout).stage, 'open');
    const imp = cli(['ticket', 'import', 'CLI-1', '--json', JSON.stringify({ title: 'CLI ticket', type: 'config', description: 'x', acceptance_criteria: [], source: { tool: 'test', fetched_at: '2026-11-19T10:00:00Z' } })], { ORGTOMO_ACTOR: 'lead' });
    assert.equal(JSON.parse(imp.stdout).stage, 'understand');
    assert.equal(JSON.parse(cli(['next', 'CLI-1']).stdout).do[0].who, 'analyst');
    const q = JSON.parse(cli(['org', 'query', 'prod', 'SELECT Id, SuppliedEmail FROM Case LIMIT 2', '--ticket', 'CLI-1'], { ORGTOMO_ACTOR: 'analyst' }).stdout);
    assert.equal(q.masked, true);
    assert.equal(JSON.parse(cli(['evidence', 'list', 'CLI-1']).stdout)[0].actor, 'analyst');
    assert.equal(JSON.parse(cli(['evidence', 'brain', 'CLI-1', 'ApexClass:CaseService', '--org', 'uat'], { ORGTOMO_ACTOR: 'planner' }).stdout).evidence, 'E002');
    const doc = cli(['evidence', 'doc', 'CLI-1', '--url', 'https://stackoverflow.example/q/1', '--quote', 'x']);
    assert.equal(doc.status, 2);
    assert.equal(JSON.parse(doc.stderr).code, 'NOT_OFFICIAL');
    const h = cli(['human', 'approve', 'CLI-1'], { ORGTOMO_ACTOR: 'lead' });
    assert.equal(JSON.parse(h.stderr).code, 'HUMAN_ONLY');
    assert.equal(JSON.parse(cli(['human', 'approve', 'CLI-1']).stderr).code, 'HUMAN_ONLY', 'no terminal, no human');
    assert.equal(JSON.parse(cli(['org', 'deploy', 'CLI-1', 'source/dev/force-app'], { ORGTOMO_ACTOR: 'tester' }).stderr).code, 'WRONG_ACTOR');
    assert.equal(JSON.parse(cli(['submit', 'CLI-1', 'understand'], { ORGTOMO_ACTOR: 'builder' }).stderr).code, 'WRONG_ACTOR');
    assert.match(cli(['help']).stdout, /Command reference/);
    assert.equal(JSON.parse(cli(['doctor']).stdout).ok, true);
    assert.equal(JSON.parse(cli(['models']).stdout).agents.reviewer, 'fable / high');
    assert.equal(cli(['nonsense']).status, 2);
  } finally { cleanup(ws); }
});

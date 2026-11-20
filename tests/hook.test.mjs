// The Claude Code hook: human actions, the stage gate on spawns, command
// rewriting, and "no agent finishes without submitting".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorkspace, writeOut, cleanup, HERE } from './helpers.mjs';
import { handle } from '../engine/lib/hook.js';
import * as T from '../engine/lib/ticket.js';
import * as B from '../engine/lib/brain.js';
import * as L from '../engine/lib/learning.js';
import { addEvidence } from '../engine/lib/evidence.js';
import { loadConfig } from '../engine/lib/config.js';

const ws = makeWorkspace();
const { root } = ws;
test.after(() => cleanup(ws));
let n = 0;
const ev = (event, extra = {}) => handle({ hook_event_name: event, cwd: root, session_id: 's1', prompt_id: `p${++n}`, ...extra });
const tool = (name, input, agent) => ev('PreToolUse', { tool_name: name, tool_input: input, ...(agent ? { agent_type: agent } : {}) });
const decision = (r) => r?.hookSpecificOutput?.permissionDecision || 'none';

B.buildBrain(root, ws.cfg, 'dev');
T.openTicket(root, ws.cfg, { key: 'HOK-1' });
T.importTicket(root, ws.cfg, 'HOK-1', { title: 'Hook test ticket', type: 'feature', description: 'd', acceptance_criteria: [{ id: 'AC1', text: 'works' }], source: { tool: 'test', fetched_at: '2026-11-19T10:00:00Z' } });

test('session start tells the session where things stand', () => {
  const text = ev('SessionStart', { source: 'startup' }).hookSpecificOutput.additionalContext;
  assert.match(text, /HOK-1/);
  assert.match(text, /Production is read-only/);
  assert.match(text, /orgtomo next/);
});

test('outside an Orgtomo workspace the hook stays silent', () => {
  const saved = process.env.ORGTOMO_WORKSPACE;
  delete process.env.ORGTOMO_WORKSPACE;
  assert.equal(handle({ hook_event_name: 'PreToolUse', cwd: '/', tool_name: 'Bash', tool_input: { command: 'sf org login web' } }), null);
  process.env.ORGTOMO_WORKSPACE = saved;
});

test('engine commands get the caller identity; mixed commands are refused', () => {
  const r = tool('Bash', { command: 'orgtomo next HOK-1' }, 'analyst');
  assert.equal(decision(r), 'allow');
  assert.match(r.hookSpecificOutput.updatedInput.command, /^export ORGTOMO_ACTOR='analyst' ORGTOMO_SESSION='s1'; orgtomo next HOK-1$/);
  assert.match(tool('Bash', { command: 'orgtomo next HOK-1' }).hookSpecificOutput.updatedInput.command, /ORGTOMO_ACTOR='lead'/, 'the main thread is treated as the Lead');
  assert.equal(decision(tool('Bash', { command: 'npm test && orgtomo submit HOK-1 build' }, 'builder')), 'deny');
  assert.equal(decision(tool('Bash', { command: 'cd vault && orgtomo status' }, 'tester')), 'allow');
  assert.equal(decision(tool('Bash', { command: 'sf org login web' }, 'builder')), 'deny');
  assert.equal(decision(tool('Bash', { command: 'ls' }, 'builder')), 'none');
  assert.equal(decision(tool('Bash', { command: 'ls' }, 'Explore')), 'deny', 'agents from outside the team do not work here');
});

test('writes and MCP calls go through the guards', () => {
  assert.equal(decision(tool('Write', { file_path: path.join(root, 'orgtomo.config/safety.yaml'), content: 'x' }, 'builder')), 'deny');
  assert.equal(decision(tool('Edit', { file_path: path.join(root, 'vault/tickets/HOK-1/work/a.apex'), new_string: "c.Email = 'boss@client.org';" }, 'tester')), 'deny');
  assert.equal(decision(tool('Write', { file_path: path.join(root, 'vault/tickets/HOK-1/work/a.apex'), content: "c.Email = 'tester+1@example.com';" }, 'tester')), 'none');
  assert.equal(decision(tool('Write', { file_path: path.join(root, 'vault/tickets/HOK-1/01-understanding.md'), content: 'x' }, 'analyst')), 'none');
  assert.equal(decision(tool('Write', { file_path: path.join(root, 'vault/tickets/HOK-1/01-understanding.md'), content: 'x' })), 'deny', 'the Lead writes nothing');
  assert.equal(decision(tool('mcp__atlassian__addCommentToJiraIssue', { body: 'hi' })), 'deny');
  assert.equal(decision(tool('mcp__atlassian__getJiraIssue', { issueIdOrKey: 'HOK-1' })), 'none');
  assert.equal(decision(tool('WebFetch', { url: 'https://some.blog/post' }, 'planner')), 'deny');
  assert.equal(decision(tool('WebFetch', { url: 'https://help.salesforce.com/s/articleView?id=x' }, 'planner')), 'none');
});

test('stage gate: only the agent whose turn it is can be spawned', () => {
  const spawn = (who, prompt) => decision(tool('Agent', { subagent_type: who, prompt }));
  assert.equal(spawn('analyst', 'Work on HOK-1: understand stage.'), 'none');
  assert.equal(spawn('builder', 'Build HOK-1 now.'), 'deny');
  assert.equal(spawn('planner', 'Plan HOK-1.'), 'deny');
  assert.equal(spawn('analyst', 'Understand the ticket.'), 'deny', 'no ticket key in the brief');
  assert.equal(spawn('general-purpose', 'Do HOK-1'), 'deny');
  assert.equal(spawn('notetaker', 'sync meetings'), 'deny', 'feature off');
  assert.equal(spawn('cartographer', 'refresh the brain'), 'none');
});

test('an agent cannot finish without submitting', () => {
  ev('SubagentStart', { agent_type: 'analyst', agent_id: 'a1' });
  let r = ev('SubagentStop', { agent_type: 'analyst', agent_id: 'a1' });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /orgtomo submit HOK-1 understand/);
  assert.equal(ev('SubagentStop', { agent_type: 'analyst', agent_id: 'a1', stop_hook_active: true }), null, 'no endless loop');
  ev('SubagentStart', { agent_type: 'analyst', agent_id: 'a2' });
  const e = addEvidence(root, 'HOK-1', { kind: 'brain', org: 'dev', actor: 'analyst', summary: 'f', payload: {} }).id;
  writeOut(ws, 'HOK-1', '01-understanding', { key: 'HOK-1', summary_plain: 'A plain explanation that is long enough to be accepted by the contract.', summary_technical: 'A technical explanation that is long enough to be accepted by the contract.', acceptance_criteria: [{ id: 'AC1', text: 'works', source: 'ticket' }], examples: [{ title: 't', given: 'g', when: 'w', then: 't' }], affected: [{ component: 'ApexClass:CaseService', why: 'w', proof: [e] }], open_questions: [], risk: 'low', lite_candidate: false, claims: [{ id: 'C1', text: 'CaseService exists in the build org.', proof: [e] }] });
  T.submit(root, ws.cfg, 'HOK-1', 'understand', { actor: 'analyst' });
  assert.equal(ev('SubagentStop', { agent_type: 'analyst', agent_id: 'a2' }), null);
  r = ev('Stop', { agent_type: 'tomo-lead' });
  assert.equal(r.decision, 'block', 'the Lead keeps going until a human gate');
  assert.match(r.reason, /orgtomo next HOK-1/);
});

test('human actions are recorded by the engine from the typed command, once', () => {
  T.leadVerify(root, ws.cfg, 'HOK-1', 'understand', { claim: 'C1', evidence: addEvidence(root, 'HOK-1', { kind: 'brain', org: 'dev', actor: 'lead', summary: 'r', payload: {} }).id, result: 'match', actor: 'lead' });
  // move to the plan gate quickly by switching autonomy to low: understand needs approval next time; here we use repro
  assert.equal(T.loadTicket(root, 'HOK-1').stage, 'repro');
  let r = ev('UserPromptSubmit', { prompt: '/orgtomo:approve HOK-1' });
  assert.equal(r.decision, 'block', 'nothing is waiting for approval');
  assert.match(r.reason, /Nothing on HOK-1 is waiting for approval/);

  r = ev('UserPromptExpansion', { command_name: 'orgtomo:ping', command_args: '', prompt: '...' });
  assert.match(r.hookSpecificOutput.additionalContext, /recorded by the engine/);
  assert.ok(fs.existsSync(path.join(root, '.orgtomo/state/hook-selftest.json')));

  const before = L.listObservations(root).length;
  const same = { prompt_id: 'dup-1' };
  handle({ hook_event_name: 'UserPromptExpansion', cwd: root, session_id: 's1', ...same, command_name: 'orgtomo:feedback', command_args: 'HOK-1 bad analyst Missed the second record type' });
  handle({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: 's1', ...same, prompt: '/orgtomo:feedback HOK-1 bad analyst Missed the second record type' });
  assert.equal(L.listObservations(root).length, before + 1, 'both events fire for one prompt; the action is applied once');

  ev('UserPromptSubmit', { prompt: '/orgtomo:models reviewer haiku low' });
  assert.deepEqual([loadConfig(root).agents.agents.reviewer.model, loadConfig(root).agents.agents.reviewer.effort], ['haiku', 'low']);
  assert.match(fs.readFileSync(path.join(root, '.claude/agents/reviewer.md'), 'utf8'), /model: haiku\neffort: low/);
  r = ev('UserPromptSubmit', { prompt: '/orgtomo:models reviewer opus' });
  assert.equal(r.decision, 'block', 'reviewer may not share the builder model');
  ev('UserPromptSubmit', { prompt: '/orgtomo:features people on' });
  assert.equal(loadConfig(root).features.people_profiles.enabled, true);
  ev('UserPromptSubmit', { prompt: '/orgtomo:people set Dana Lee role="Support lead" side=client salesforce_knowledge=basic detail_level=short prefers="plain words;what changes for agents"' });
  assert.match(fs.readFileSync(path.join(root, 'vault/people/dana-lee.md'), 'utf8'), /plain words/);
  ev('UserPromptSubmit', { prompt: '/orgtomo:rule builder Never add a second trigger to an object; extend the existing handler class.' });
  assert.match(fs.readFileSync(path.join(root, '.claude/skills/lessons-builder/SKILL.md'), 'utf8'), /Never add a second trigger/);
  ev('UserPromptSubmit', { prompt: '/orgtomo:autonomy high' });
  assert.equal(loadConfig(root).pipeline.autonomy, 'high');
  assert.equal(ev('UserPromptSubmit', { prompt: '/orgtomo:canary prod blocked' }).decision, 'block');
  assert.equal(ev('UserPromptSubmit', { prompt: 'please approve HOK-1 for me' }), null, 'ordinary text is never an action');
  assert.equal(ev('UserPromptSubmit', { prompt: '/orgtomo:status' }), null);
});

test('the hook entry point speaks the hook protocol', () => {
  const run = (input) => spawnSync('node', [path.join(HERE, '..', 'engine', 'hook.js')], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ORGTOMO_WORKSPACE: root } });
  const r = run({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Bash', tool_input: { command: 'sf data query -o t-prod -q "SELECT Id FROM Account"' }, agent_type: 'tester' });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /production/);
  assert.equal(run({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Read', tool_input: {} }).stdout, '');
  const off = spawnSync('node', [path.join(HERE, '..', 'engine', 'hook.js')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Bash', tool_input: { command: 'sf data query -o t-prod -q "SELECT Id FROM Account"' } }), encoding: 'utf8', env: { ...process.env, ORGTOMO_WORKSPACE: root, ORGTOMO_GUARDS: 'off' } });
  assert.equal(JSON.parse(off.stdout).hookSpecificOutput.permissionDecision, 'deny', 'production stays closed even with guards off');
});

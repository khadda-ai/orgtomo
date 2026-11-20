// The local control panel: token and host checks, state, and human actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeWorkspace, writeOut, cleanup } from './helpers.mjs';
import { createHandler } from '../engine/lib/ui-server.js';
import * as T from '../engine/lib/ticket.js';
import * as B from '../engine/lib/brain.js';
import { addEvidence } from '../engine/lib/evidence.js';
import { loadConfig, setConfigValue } from '../engine/lib/config.js';

test('control panel API', async () => {
  const ws = makeWorkspace();
  const { root } = ws;
  const port = 4391;
  const token = 'test-token-0123456789';
  const server = http.createServer(createHandler(root, token, port));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const call = async (p, { body, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: body ? 'POST' : 'GET', headers: { 'x-orgtomo-token': token, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null), type: res.headers.get('content-type') };
  };
  try {
    assert.equal((await call('/api/state', { headers: { 'x-orgtomo-token': 'wrong' } })).status, 401);
    assert.equal((await call('/api/state', { headers: { 'x-orgtomo-token': '' } })).status, 401);
    assert.equal((await call('/api/action', { body: { verb: 'sync' }, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.match((await call('/')).type, /text\/html/);
    assert.equal((await call('/../package.json')).status, 404);
    assert.equal((await call('/%2e%2e/%2e%2e/package.json')).status, 404);

    B.buildBrain(root, ws.cfg, 'dev');
    const cfg = setConfigValue(root, 'pipeline', 'autonomy', 'low');
    T.openTicket(root, cfg, { key: 'UI-1' });
    T.importTicket(root, cfg, 'UI-1', { title: 'UI ticket', type: 'feature', description: 'd', acceptance_criteria: [{ id: 'AC1', text: 'works' }], source: { tool: 'test', fetched_at: '2026-11-19T10:00:00Z' } });
    const e = addEvidence(root, 'UI-1', { kind: 'brain', org: 'dev', actor: 'analyst', summary: 'f', payload: {} }).id;
    writeOut(ws, 'UI-1', '01-understanding', { key: 'UI-1', summary_plain: 'A plain explanation that is long enough to be accepted by the contract.', summary_technical: 'A technical explanation that is long enough to be accepted by the contract.', acceptance_criteria: [{ id: 'AC1', text: 'works', source: 'ticket' }], examples: [{ title: 't', given: 'g', when: 'w', then: 't' }], affected: [{ component: 'ApexClass:CaseService', why: 'w', proof: [e] }], open_questions: [], risk: 'low', lite_candidate: false, claims: [{ id: 'C1', text: 'CaseService exists in the build org.', proof: [e] }] });
    T.submit(root, cfg, 'UI-1', 'understand', { actor: 'analyst' });
    T.leadVerify(root, cfg, 'UI-1', 'understand', { claim: 'C1', evidence: addEvidence(root, 'UI-1', { kind: 'brain', org: 'dev', actor: 'lead', summary: 'r', payload: {} }).id, result: 'match', actor: 'lead' });

    const state = (await call('/api/state')).json;
    assert.equal(state.tickets[0].waiting_for, 'approval');
    assert.equal(state.orgs.find((o) => o.name === 'prod').role, 'production');
    assert.ok(!JSON.stringify(state).includes('accessToken'));
    const detail = (await call('/api/ticket/UI-1')).json;
    assert.equal(detail.next.awaiting, 'approval');
    assert.ok(detail.reports.some((r) => r.name === 'verify-understand.md'));

    assert.equal((await call('/api/action', { body: { verb: 'reject', key: 'UI-1', note: '' } })).status, 400, 'a rejection needs a reason');
    assert.equal((await call('/api/action', { body: { verb: 'approve', key: 'UI-1' } })).json.ok, true);
    assert.equal(T.loadTicket(root, 'UI-1').stage, 'repro');
    assert.match(fs.readFileSync(path.join(root, '.orgtomo/state/approvals.jsonl'), 'utf8'), /"source":"ui"/);

    assert.equal((await call('/api/action', { body: { verb: 'config', file: 'agents', path: 'agents.tester.model', value: 'haiku' } })).json.ok, true);
    assert.equal(loadConfig(root).agents.agents.tester.model, 'haiku');
    assert.match(fs.readFileSync(path.join(root, '.claude/agents/tester.md'), 'utf8'), /model: haiku/);
    const bad = await call('/api/action', { body: { verb: 'config', file: 'orgs', path: 'orgs.prod.data_write', value: true } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Production is read-only/);
    assert.equal((await call('/api/action', { body: { verb: 'canary', org: 'prod', status: 'blocked' } })).status, 400);
    assert.equal((await call('/api/action', { body: { verb: 'config', file: 'safety', path: 'allowed_emails', value: ['*'] } })).status, 400);
    assert.equal((await call('/api/doctor')).json.ok, true);
  } finally { server.close(); cleanup(ws); }
});

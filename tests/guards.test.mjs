// Adversarial tests for the guards: every case here is something an agent
// could try, by mistake or on purpose, and must not get through.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, cleanup } from './helpers.mjs';
import { checkBash } from '../engine/lib/guards/policy.js';
import { checkWrite } from '../engine/lib/guards/write.js';
import { checkMcp, checkWebFetch, checkBrowserUrl } from '../engine/lib/guards/mcp.js';
import { scanText } from '../engine/lib/guards/data.js';
import { maskRecords } from '../engine/lib/mask.js';
import { recordCanary } from '../engine/lib/canary.js';
import { stagesOf } from '../engine/lib/ticket.js';
import { validateConfig, loadConfig } from '../engine/lib/config.js';

const ws = makeWorkspace();
const { root, cfg } = ws;
test.after(() => cleanup(ws));
const bash = (cmd, agent = 'builder') => checkBash(cmd, { cfg, root, agent });
const denied = (cmd, agent) => assert.equal(bash(cmd, agent).decision, 'deny', `should be denied: ${cmd}`);
const allowed = (cmd, agent) => { const r = bash(cmd, agent); assert.equal(r.decision, 'allow', `should be allowed: ${cmd} (${r.reason})`); };

test('production is unreachable with the raw CLI, however it is spelled', () => {
  for (const cmd of [
    'sf data query --target-org t-prod --query "SELECT Id FROM Account LIMIT 1"',
    'sf data query -o t-prod -q "SELECT Id FROM Account"',
    'sf data query --target-org=t-prod -q "SELECT Id FROM Account"',
    'cd source && sf project retrieve start --target-org t-prod --metadata ApexClass',
    'sf apex run --target-org t-prod --file x.apex',
    'bash -c "sf data query -o t-prod -q \\"SELECT Id FROM Account\\""',
    'FOO=1 sf project deploy start --target-org t-prod --source-dir force-app',
    'npx sf data query -o t-prod -q "SELECT Id FROM Account"',
    '/usr/local/bin/sf data delete record -o t-prod --sobject Account --record-id 001000000000001',
    'sf data query -o prod -q "SELECT Id FROM Account LIMIT 1"',
  ]) denied(cmd);
});

test('the org must be named literally; no defaults, variables or indirection', () => {
  denied('sf data create record --sobject Account --values "Name=X"');
  denied('sf apex run --target-org $ORG --file x.apex');
  denied('sf apex run --target-org "$(cat alias.txt)" --file x.apex');
  denied('ORG=t-prod; sf apex run --target-org `echo $ORG` --file x.apex');
  denied('eval "sf org list"');
  denied('echo t-dev | xargs sf apex run --file x.apex --target-org');
  denied('SF_TARGET_ORG=t-prod sf apex run --file x.apex');
  denied('export SF_TARGET_ORG=t-prod');
  denied('sf config set target-org t-prod');
  denied('sf alias set t-dev=someone@prod.example.com');
  denied('sf data query -u t-dev -q "SELECT Id FROM Account"');
  denied('sf apex run -o unknown-org --file x.apex');
});

test('logins, tokens, raw deploys and raw API are human or engine only', () => {
  for (const cmd of ['sf org login web --alias x', 'sf org display --target-org t-dev', 'sf org display -o t-dev --verbose', 'sf org open -o t-dev', 'sf org list auth',
    'sf project deploy start --target-org t-dev --source-dir force-app', 'sf project deploy validate -o t-uat --manifest package.xml', 'sf project deploy quick -o t-uat --job-id 0Af',
    'sf api request rest /services/data/v62.0/sobjects/Account -o t-dev', 'sf data export tree -o t-dev -q "SELECT Id FROM Account"', 'sf project delete source -o t-dev -m ApexClass:X',
    'sf plugins install foo', 'sf force:source:push -o t-dev', 'curl https://testco--dev.sandbox.my.salesforce.com/services/data/v62.0/query?q=x -H "Authorization: Bearer x"',
    'git push origin main']) denied(cmd);
});

test('data writes need the data guard and the e-mail canary', () => {
  const apex = path.join(root, 'vault', 'tickets', 'X-1', 'work');
  fs.mkdirSync(apex, { recursive: true });
  fs.writeFileSync(path.join(apex, 'ok.apex'), "insert new Contact(LastName = 'Orgtomo Test Person', Email = 'tester+1@example.com');");
  fs.writeFileSync(path.join(apex, 'bad.apex'), "insert new Contact(LastName = 'Real', Email = 'ceo@bigclient.com');");
  denied('sf apex run --target-org t-dev --file vault/tickets/X-1/work/ok.apex'); // no canary yet
  recordCanary(root, 'dev', 'blocked', 'probe');
  allowed('sf apex run --target-org t-dev --file vault/tickets/X-1/work/ok.apex');
  denied('sf apex run --target-org t-dev --file vault/tickets/X-1/work/bad.apex');
  denied('sf apex run --target-org t-dev'); // stdin
  denied('sf data create record -o t-dev --sobject Contact --values "LastName=X Email=someone@client.org"');
  denied('sf data create record -o t-dev --sobject Contact --values "LastName=X Phone=4155552671"');
  allowed('sf data create record -o t-dev --sobject Contact --values "LastName=Orgtomo Email=tester+2@example.com"');
  recordCanary(root, 'dev', 'enabled', 'probe');
  denied('sf apex run --target-org t-dev --file vault/tickets/X-1/work/ok.apex'); // org can send mail
  recordCanary(root, 'dev', 'blocked', 'probe');
});

test('sandbox reads are masked through the engine; local and test commands pass', () => {
  denied('sf data query --target-org t-dev --query "SELECT Email FROM Contact LIMIT 5"');
  allowed('sf apex run test --target-org t-dev --class-names CaseServiceTest --result-format json');
  allowed('sf project retrieve start --target-org t-dev --metadata ApexClass:CaseService');
  allowed('sf apex generate class --name FooService --output-dir source/dev/force-app/main/default/classes');
  allowed('sf org list');
  allowed('ls -la && cat vault/log.md | head -5');
  denied('sf lightning dev app -o t-dev'); // unknown: fail closed
});

test('human actions and engine identity cannot be taken by an agent', () => {
  for (const cmd of ['orgtomo human approve ABC-1', 'node engine/cli.js human approve ABC-1', 'cd x && orgtomo human reject ABC-1 no', 'orgtomo ui', 'orgtomo setup --yes',
    'ORGTOMO_ACTOR=lead orgtomo verify ABC-1 plan --claim C1 --evidence E001 --result match', 'export ORGTOMO_GUARDS=off', 'ORGTOMO_GUARDS=off sf org list',
    'orgtomo config set agents.reviewer.model opus', 'orgtomo lessons approve L-0001', 'bash -c "orgtomo human approve ABC-1"', 'eval "orgtomo human approve ABC-1"']) denied(cmd);
  const r = bash('orgtomo next ABC-1');
  assert.equal(r.decision, 'allow');
  assert.equal(r.orgtomo, true);
});

test('protected state cannot be written through the shell', () => {
  for (const cmd of ['echo "{}" > .orgtomo/state/tickets/ABC-1.json', 'rm -rf .orgtomo', 'sed -i s/blocked/allowlist_only/ orgtomo.config/safety.yaml', 'cp /tmp/x orgtomo.config/orgs.yaml',
    'python3 -c "open(\'.orgtomo/state/approvals.jsonl\',\'a\').write(\'x\')"', 'tee vault/tickets/ABC-1/evidence/index.json < /tmp/e.json', 'mv vault/tickets/ABC-1/backup /tmp/b',
    'echo x >> .claude/agents/builder.md', 'cat x > .mcp.json', 'rm -rf vault', 'find .orgtomo -name "*.json" -delete']) denied(cmd);
  allowed('cat orgtomo.config/safety.yaml');
  allowed('ls .orgtomo/state/tickets');
  allowed('jq .stage .orgtomo/state/tickets/ABC-1.json');
});

test('the Lead only reads and asks the engine', () => {
  denied('npm install', 'lead');
  denied('node script.js', 'lead');
  denied('sf apex run test --target-org t-dev --class-names X', 'lead');
  allowed('orgtomo next ABC-1', 'lead');
  allowed('cat vault/tickets/ABC-1/03-plan.md', 'lead');
});

test('scripts that reach Salesforce are refused', () => {
  fs.writeFileSync(path.join(root, 'sneaky.sh'), '#!/bin/bash\nsf data query -o t-prod -q "SELECT Id FROM Account"\n');
  fs.writeFileSync(path.join(root, 'sneaky.py'), 'import subprocess\nsubprocess.run(["sf","data","query","-o","t-prod"])\nfrom simple_salesforce import Salesforce\n');
  fs.writeFileSync(path.join(root, 'fine.py'), 'print("hello")\n');
  denied('bash sneaky.sh');
  denied('python3 sneaky.py');
  allowed('python3 fine.py');
});

test('write guard: each file has one owner', () => {
  const ctx = (agent, stages = []) => ({ cfg, root, agent, stages: stagesOf(root), activeStages: stages });
  const w = (file, agent, stages) => checkWrite(file, ctx(agent, stages)).decision;
  assert.equal(w('orgtomo.config/safety.yaml', 'builder'), 'deny');
  assert.equal(w('.orgtomo/state/tickets/ABC-1.json', 'builder'), 'deny');
  assert.equal(w('.claude/agents/reviewer.md', 'builder'), 'deny');
  assert.equal(w('vault/tickets/ABC-1/evidence/E001.json', 'tester'), 'deny');
  assert.equal(w('vault/tickets/ABC-1/backup/dev/classes/A.cls', 'builder'), 'deny');
  assert.equal(w('/etc/hosts', 'builder'), 'deny');
  assert.equal(w('/opt/outside.txt', 'builder'), 'deny');
  assert.equal(w('source/dev/force-app/main/default/classes/A.cls', 'builder'), 'deny', 'no ticket in build stage');
  assert.equal(w('source/dev/force-app/main/default/classes/A.cls', 'builder', [{ key: 'ABC-1', stage: 'build' }]), 'allow');
  assert.equal(w('source/dev/force-app/main/default/classes/A.cls', 'tester', [{ key: 'ABC-1', stage: 'build' }]), 'deny');
  assert.equal(w('source/uat/force-app/main/default/classes/A.cls', 'builder', [{ key: 'ABC-1', stage: 'build' }]), 'deny');
  assert.equal(w('vault/tickets/ABC-1/05-qa.json', 'tester'), 'allow');
  assert.equal(w('vault/tickets/ABC-1/05-qa-uat.json', 'tester'), 'allow');
  assert.equal(w('vault/tickets/ABC-1/05-qa.json', 'builder'), 'deny');
  assert.equal(w('vault/tickets/ABC-1/06-review.md', 'builder'), 'deny');
  assert.equal(w('vault/tickets/ABC-1/work/setup.apex', 'tester'), 'allow');
  assert.equal(w('vault/tickets/ABC-1/status.md', 'tester'), 'deny');
  assert.equal(w('vault/orgs/uat/facts/ApexClass/CaseService.md', 'cartographer'), 'deny');
  assert.equal(w('vault/orgs/uat/understanding/case-escalation.md', 'cartographer'), 'allow');
  assert.equal(w('vault/orgs/uat/understanding/case-escalation.md', 'analyst'), 'deny');
  assert.equal(w('vault/learning/Lessons.md', 'coach'), 'deny');
  assert.equal(w('vault/people/someone.md', 'scribe'), 'deny');
  assert.equal(w('vault/tickets/ABC-1/01-understanding.md', 'lead'), 'deny');
  assert.equal(w('work/meetings/m1.json', 'notetaker'), 'allow');
});

test('MCP guard: deny by default, tracker read-only, browser fenced', () => {
  const m = (tool, input, agent) => checkMcp(tool, input, { cfg, root, agent }).decision;
  assert.equal(m('mcp__atlassian__getJiraIssue', {}, 'lead'), 'allow');
  assert.equal(m('mcp__atlassian__addCommentToJiraIssue', {}, 'lead'), 'deny');
  assert.equal(m('mcp__atlassian__editJiraIssue', {}, 'scribe'), 'deny');
  assert.equal(m('mcp__atlassian__getJiraIssue', {}, 'builder'), 'deny');
  assert.equal(m('mcp__slack__slack_send_message', {}, 'scribe'), 'deny');
  assert.equal(m('mcp__playwright__browser_navigate', { url: 'https://testco--dev.sandbox.lightning.force.com/lightning/r/Case/500/view' }, 'reproducer'), 'allow');
  assert.equal(m('mcp__playwright__browser_navigate', { url: 'https://testco.my.salesforce.com/' }, 'reproducer'), 'deny');
  assert.equal(m('mcp__playwright__browser_navigate', { url: 'https://testco.lightning.force.com/lightning/page/home' }, 'tester'), 'deny');
  assert.equal(m('mcp__playwright__browser_navigate', { url: 'https://example.org/' }, 'reproducer'), 'deny');
  assert.equal(m('mcp__playwright__browser_navigate', { url: 'https://testco--dev.sandbox.my.salesforce.com/secur/logout.jsp' }, 'reproducer'), 'deny');
  assert.equal(m('mcp__playwright__browser_navigate', { url: 'https://testco--dev.sandbox.lightning.force.com/' }, 'builder'), 'deny');
  assert.equal(m('mcp__playwright__browser_evaluate', { function: '() => 1' }, 'reproducer'), 'deny');
  assert.equal(m('mcp__playwright__browser_run_code_unsafe', {}, 'tester'), 'deny');
  assert.equal(m('mcp__playwright__browser_type', { text: 'vip@client.org' }, 'tester'), 'deny');
  assert.equal(m('mcp__playwright__browser_type', { text: 'tester+9@example.com' }, 'tester'), 'allow');
  assert.equal(m('mcp__claude-in-chrome__navigate', { url: 'https://x.y' }, 'reproducer'), 'deny');
  assert.equal(m('mcp__granola__get_meetings', {}, 'notetaker'), 'deny', 'meetings feature is off');
  assert.equal(m('mcp__plugin_salesforce-development_salesforce-lsp__validate_soql', {}, 'builder'), 'allow');
  assert.equal(m('mcp__plugin_salesforce-development_salesforce-metadata-experts__execute_metadata_action', {}, 'builder'), 'deny', 'default org not proven to be the build org');
  fs.mkdirSync(path.join(root, '.sf'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sf', 'config.json'), JSON.stringify({ 'target-org': 't-dev' }));
  assert.equal(m('mcp__plugin_salesforce-development_salesforce-metadata-experts__execute_metadata_action', {}, 'builder'), 'allow');
  assert.equal(m('mcp__plugin_salesforce-development_salesforce-metadata-experts__execute_metadata_action', {}, 'planner'), 'deny');
  assert.equal(checkWebFetch('https://developer.salesforce.com/docs/x', cfg).decision, 'allow');
  assert.equal(checkWebFetch('https://random-blog.example/apex-tips', cfg).decision, 'deny');
  assert.equal(checkBrowserUrl('http://testco--dev.sandbox.my.salesforce.com/', cfg).decision, 'deny');
});

test('data guard and masking', () => {
  const s = cfg.safety;
  assert.deepEqual(scanText('mail tester+a@example.com and TESTER+B@EXAMPLE.COM', s), []);
  assert.equal(scanText('mail a.b@client.co.uk', s).length, 1);
  assert.equal(scanText('call (415) 555-2671', s).length, 1);
  assert.equal(scanText('call +44 20 7946 0958', s).length, 1);
  assert.deepEqual(scanText('call +1 555 555 0100', s), []);
  assert.deepEqual(scanText('2026-11-19T10:00:00.000Z id 0031g00000AbCdEFGH version 62.0 amount 1234567890123', s), []);
  const [rec] = maskRecords([{ Id: '003', Email: 'x@y.com', Phone: '415-555-2671', LastName: 'Smith', Status: 'New', Owner: { Name: 'Jo Bloggs', Email: 'tester+1@example.com' } }], s);
  assert.equal(rec.Id, '003');
  assert.equal(rec.Status, 'New');
  assert.ok(!JSON.stringify(rec).includes('x@y.com') && !JSON.stringify(rec).includes('Smith') && !JSON.stringify(rec).includes('415-555'));
  assert.equal(rec.Owner.Email, 'tester+1@example.com', 'allow-listed values stay readable');
});

test('configuration cannot make production writable or weaken core rules', () => {
  const c = loadConfig(root);
  c.orgs.orgs.prod.data_write = true;
  assert.ok(validateConfig(c).errors.some((e) => /production/i.test(e)));
  const c2 = loadConfig(root); c2.orgs.orgs.uat.metadata_write = true;
  assert.ok(validateConfig(c2).errors.length);
  const c3 = loadConfig(root); c3.safety.allowed_emails = ['*'];
  assert.ok(validateConfig(c3).errors.length);
  const c4 = loadConfig(root); c4.agents.agents.reviewer.model = c4.agents.agents.builder.model;
  assert.ok(validateConfig(c4).errors.some((e) => /reviewer/i.test(e)));
  const c5 = loadConfig(root); c5.agents.agents.tester.enabled = false;
  assert.ok(validateConfig(c5).errors.some((e) => /core agent/.test(e)));
  const c6 = loadConfig(root); c6.pipeline.loop.max = 9;
  assert.ok(validateConfig(c6).warnings.some((w) => /hard cap/.test(w)));
});

#!/usr/bin/env node
// A stand-in for the Salesforce CLI used by the offline tests. It keeps each
// "org" as a folder of source-format metadata and answers the few commands the
// engine uses with the same JSON shape as the real CLI.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('@salesforce/cli/0.0.0 fake'); process.exit(0); }
const state = JSON.parse(fs.readFileSync(process.env.FAKE_SF_STATE, 'utf8'));
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const flags = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const alias = flag('--target-org');
const orgDir = state.orgs[alias];
const out = (result, status = 0, message) => { console.log(JSON.stringify({ status, result, message })); process.exit(status ? 1 : 0); };
const walk = (d, rel = '') => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`])) : []);
const log = (line) => fs.appendFileSync(process.env.FAKE_SF_STATE + '.log', `${args.join(' ')}${line ? ` # ${line}` : ''}\n`);
log('');
if (!orgDir) out(null, 1, `No authorization found for ${alias}`);
const topic = args.filter((a) => !a.startsWith('-')).slice(0, 3).join(' ');

if (topic.startsWith('data query')) {
  const q = flag('--query');
  if (/FROM Organization/i.test(q)) out({ totalSize: 1, records: [{ attributes: { type: 'Organization' }, Id: '00D000000000001AAA', IsSandbox: !state.production.includes(alias), OrganizationType: 'Enterprise Edition', InstanceName: 'FAKE1' }] });
  const hit = Object.entries(state.queries || {}).find(([k]) => q.includes(k));
  const records = hit ? hit[1] : [{ attributes: { type: 'Case' }, Id: '500000000000001AAA', Subject: 'Printer issue', SuppliedEmail: 'real.person@client.org', Status: 'New' }];
  out({ totalSize: records.length, records });
}
if (topic.startsWith('project retrieve start')) {
  const refs = flags('--metadata');
  const dest = flag('--output-dir') || path.join(process.cwd(), 'force-app', 'main', 'default');
  const match = (file) => refs.some((r) => {
    const [type, name] = r.split(':');
    const folder = { ApexClass: 'classes/', ApexTrigger: 'triggers/', Flow: 'flows/', LightningComponentBundle: 'lwc/', PermissionSet: 'permissionsets/', CustomObject: 'objects/', CustomField: 'objects/', ValidationRule: 'objects/', CustomLabels: 'labels/' }[type];
    if (!folder || !file.startsWith(folder)) return false;
    if (!name) return type !== 'CustomField' && type !== 'ValidationRule';
    if (type === 'CustomField') { const [o, f] = name.split('.'); return file === `objects/${o}/fields/${f}.field-meta.xml`; }
    if (type === 'ValidationRule') { const [o, f] = name.split('.'); return file === `objects/${o}/validationRules/${f}.validationRule-meta.xml`; }
    if (type === 'CustomObject') return file.startsWith(`objects/${name}/`);
    return file.startsWith(`${folder}${name}.`) || file.startsWith(`${folder}${name}/`);
  });
  const files = walk(orgDir).filter(match);
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true }); fs.copyFileSync(path.join(orgDir, f), path.join(dest, f)); }
  out({ files: files.map((f) => ({ filePath: f, state: 'Created' })) });
}
if (topic.startsWith('project deploy start')) {
  if (state.deploy_fails) out({ status: 'Failed', details: { componentFailures: [{ fullName: 'CaseService', componentType: 'ApexClass', problem: 'Variable does not exist: foo' }] } }, 1, 'Deploy failed.');
  const copied = [];
  for (const src of flags('--source-dir')) {
    const list = fs.statSync(src).isDirectory() ? walk(src).map((f) => path.join(src, f)) : [src, `${src}-meta.xml`].filter((f) => fs.existsSync(f));
    for (const f of list) {
      const i = f.indexOf('/main/default/');
      const inner = i >= 0 ? f.slice(i + '/main/default/'.length) : path.relative(src, f);
      if (!args.includes('--dry-run')) { fs.mkdirSync(path.dirname(path.join(orgDir, inner)), { recursive: true }); fs.copyFileSync(f, path.join(orgDir, inner)); }
      copied.push(inner);
    }
  }
  out({ status: 'Succeeded', files: copied.map((f) => ({ filePath: f, state: 'Changed' })) });
}
if (topic.startsWith('apex run test')) {
  const classes = flags('--class-names');
  const tests = classes.flatMap((c) => [{ ApexClass: { Name: c }, MethodName: 'appliesEscalationInBulk', Outcome: (state.failing_tests || []).includes(c) ? 'Fail' : 'Pass', Message: (state.failing_tests || []).includes(c) ? 'Assertion Failed' : null }]);
  out({ summary: { testRunCoverage: '91%' }, tests });
}
if (topic.startsWith('apex run')) {
  const code = fs.readFileSync(flag('--file'), 'utf8');
  const logs = /reserveSingleEmailCapacity/.test(code)
    ? (state.email_enabled ? '12:00:00.1 (1)|USER_DEBUG|[2]|ERROR|ORGTOMO_CANARY:ENABLED' : '12:00:00.1 (1)|USER_DEBUG|[3]|ERROR|ORGTOMO_CANARY:BLOCKED:System.NoAccessException')
    : '12:00:00.1 (1)|USER_DEBUG|[1]|DEBUG|ran ok';
  out({ success: true, compiled: true, logs });
}
out(null, 1, `fake sf: unsupported command: ${args.join(' ')}`);

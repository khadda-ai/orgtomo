// Setup: creates a workspace. Nothing here talks to an org.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { SPEC_DIR, layout } from './paths.js';
import { loadConfig, loadDefault, validateConfig, CONFIG_FILES, ROLES, DEPLOY_TOOLS } from './config.js';
import { stringify } from './yaml.js';
import { initVault } from './brain.js';
import { sync } from './sync.js';
import { exists, readText, writeText, writeJson } from './util.js';

/**
 * Create orgtomo.config/, the vault and the source folders.
 * Existing files are never overwritten.
 * @param {string} root target folder
 * @param {{answers?: object}} opts answers: values collected by the wizard
 */
export function setup(root, { answers } = {}) {
  const L = layout(root);
  const created = [];
  for (const name of CONFIG_FILES) {
    const target = path.join(L.config, `${name}.yaml`);
    if (exists(target)) continue;
    let text = readText(path.join(SPEC_DIR, 'defaults', `${name}.yaml`));
    if (answers?.[name]) text = `${text.split('\n').filter((l) => l.startsWith('#')).join('\n')}\n${stringify(answers[name])}`;
    writeText(target, text);
    created.push(`orgtomo.config/${name}.yaml`);
  }
  const cfg = loadConfig(root);
  for (const name of Object.keys(cfg.orgs.orgs || {})) {
    const dir = path.join(root, cfg.pipeline.source_dir || 'source', name);
    if (!exists(path.join(dir, 'sfdx-project.json'))) {
      writeJson(path.join(dir, 'sfdx-project.json'), { packageDirectories: [{ path: 'force-app', default: true }], namespace: '', sfdcLoginUrl: 'https://login.salesforce.com', ...(cfg.pipeline.api_version ? { sourceApiVersion: String(cfg.pipeline.api_version) } : {}) });
      fs.mkdirSync(path.join(dir, 'force-app', 'main', 'default'), { recursive: true });
      created.push(`${cfg.pipeline.source_dir || 'source'}/${name}/`);
    }
  }
  initVault(root, cfg);
  const gi = path.join(root, '.gitignore');
  if (!exists(gi)) writeText(gi, '# Orgtomo workspace: keep org data and engine state out of git\n.orgtomo/\n.sf/\n.sfdx/\nnode_modules/\n');
  const { errors, warnings } = validateConfig(cfg);
  const synced = errors.length ? null : sync(root, cfg);
  return { workspace: root, created, errors, warnings, synced: synced ? synced.written.length : 0 };
}

/** Ask the questions a first-time user needs, in the terminal. */
export async function wizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def = '') => (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def;
  const pick = async (q, options, def) => { for (;;) { const a = await ask(`${q} (${options.join(' / ')})`, def); if (options.includes(a)) return a; console.log(`  Please type one of: ${options.join(', ')}`); } };
  console.log('\nOrgtomo setup. Nothing is sent anywhere; this only writes configuration files.\n');
  const company = await ask('Company or project name', 'My Company');
  const orgs = {};
  console.log('\nAdd your Salesforce orgs. Leave the name empty when you are done.');
  console.log('Roles: build = your dev sandbox (agents build here), test = UAT/QA (you deploy, agents retest), production = read-only.\n');
  for (;;) {
    const name = (await ask('Org name (short, lowercase, e.g. dev)', '')).toLowerCase();
    if (!name) { if (Object.keys(orgs).length) break; console.log('  At least one org is needed.'); continue; }
    const alias = await ask('  sf CLI alias of this org (see: sf org list)', name);
    const role = await pick('  Role', ROLES, Object.values(orgs).some((o) => o.role === 'build') ? 'test' : 'build');
    const host = role === 'production' ? '' : await ask('  My Domain host for the browser, e.g. acme--dev.sandbox.my.salesforce.com (empty = no browser)', '');
    orgs[name] = { alias, role, host, ...(role === 'production' ? {} : { data_write: true }) };
  }
  const names = Object.keys(orgs);
  const build = names.find((n) => orgs[n].role === 'build') || names[0];
  const base = names.find((n) => orgs[n].role === 'test') || build;
  const targets = [];
  for (const n of names.filter((x) => x !== build)) {
    const tool = await pick(`How do you deploy to "${n}"?`, DEPLOY_TOOLS, 'blue-canvas');
    targets.push({ org: n, tool, retest: orgs[n].role === 'test' });
  }
  console.log('\nTest data safety. Only these may ever appear in test records, scripts and browser input.');
  const emails = (await ask('Allowed test e-mail addresses, comma separated (globs allowed, e.g. you+*@example.com)', 'tester+*@example.com')).split(',').map((x) => x.trim()).filter(Boolean);
  const phones = (await ask('Allowed test phone numbers, comma separated', '+15555550100')).split(',').map((x) => x.trim()).filter(Boolean);
  const meet = await pick('\nMeeting notes: bring decisions from meetings into tickets?', ['off', 'granola', 'zoom', 'google-meet', 'file'], 'off');
  const people = await pick('People profiles: tailor drafts to each reader?', ['off', 'on'], 'off');
  rl.close();
  const d = (name) => loadDefaultRaw(name);
  return {
    orgs: { company, orgs },
    pipeline: { ...d('pipeline'), build_org: build, brain_base: base, drift_check: names.filter((n) => orgs[n].role === 'production'), targets },
    safety: { ...d('safety'), allowed_emails: emails, allowed_phones: phones },
    features: { ...d('features'), meetings: { ...d('features').meetings, enabled: meet !== 'off', provider: meet === 'off' ? 'granola' : meet }, people_profiles: { enabled: people === 'on' } },
  };
}
const loadDefaultRaw = (name) => JSON.parse(JSON.stringify(loadDefault(name)));

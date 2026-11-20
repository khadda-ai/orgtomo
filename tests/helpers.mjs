// Shared test helpers: a throwaway workspace wired to the stand-in Salesforce CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from '../engine/lib/setup.js';
import { loadConfig } from '../engine/lib/config.js';
import { layout } from '../engine/lib/paths.js';
import { stringify } from '../engine/lib/yaml.js';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ORG = path.join(HERE, 'fixtures', 'org');

export function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
    else fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
}

/**
 * Create a workspace with three orgs (dev = build, uat = test, prod = production),
 * each backed by a folder that the stand-in CLI treats as the org.
 */
export function makeWorkspace({ overrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtomo-test-'));
  const orgs = {};
  for (const name of ['dev', 'uat', 'prod']) { orgs[`t-${name}`] = path.join(root, '_orgs', name); copyDir(FIXTURE_ORG, orgs[`t-${name}`]); }
  const stateFile = path.join(root, '_orgs', 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ orgs, production: ['t-prod'], queries: {}, failing_tests: [] }));
  process.env.ORGTOMO_SF_BIN = path.join(HERE, 'fixtures', 'fake-sf.mjs');
  process.env.FAKE_SF_STATE = stateFile;
  process.env.ORGTOMO_WORKSPACE = root;
  delete process.env.ORGTOMO_NOW;
  const cfgDir = path.join(root, 'orgtomo.config');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'orgs.yaml'), stringify({
    company: 'Test Co',
    orgs: {
      dev: { alias: 't-dev', role: 'build', host: 'testco--dev.sandbox.my.salesforce.com', data_write: true },
      uat: { alias: 't-uat', role: 'test', host: 'testco--uat.sandbox.my.salesforce.com', data_write: true },
      prod: { alias: 't-prod', role: 'production', host: 'testco.my.salesforce.com' },
    },
  }));
  for (const [file, value] of Object.entries(overrides)) fs.writeFileSync(path.join(cfgDir, `${file}.yaml`), stringify(value));
  setup(root);
  for (const name of ['dev', 'uat']) copyDir(FIXTURE_ORG, path.join(root, 'source', name, 'force-app', 'main', 'default'));
  fs.writeFileSync(path.join(root, 'source', 'dev', 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '62.0' }));
  return { root, cfg: loadConfig(root), L: layout(root), stateFile, orgDirs: orgs };
}

export const fakeState = (ws, patch) => fs.writeFileSync(ws.stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(ws.stateFile, 'utf8')), ...patch }));
export const writeOut = (ws, key, name, contract, md) => {
  const dir = ws.L.ticketDir(key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(contract, null, 2));
  fs.writeFileSync(path.join(dir, `${name}.md`), md || `# ${name}\n\nThis file explains the result of the stage for a human reader in enough words to be useful.\n`);
};
export const cleanup = (ws) => fs.rmSync(ws.root, { recursive: true, force: true });

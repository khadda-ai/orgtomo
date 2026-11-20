// Doctor: a health check a human can read. It changes nothing in an org.
// With --orgs it also proves that the things a ticket will need really work:
// each org answers, and a real retrieve from the build org succeeds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, layout } from './paths.js';
import { loadConfig, validateConfig, orgNames, org as getOrg, canWriteData, isProduction, loopMax, approvalStages, sameModel } from './config.js';
import { renderAgent, agentFileName } from './sync.js';
import { brainStatus, scanSource } from './brain.js';
import { readCanary } from './canary.js';
import { verifyOrg, retrieve } from './org.js';
import { allowedBrowserHosts, sfDefaultOrg } from './guards/mcp.js';
import { discoverState } from './discover.js';
import { loadCatalogue } from './models.js';
import { obsidianStatus } from './obsidian.js';
import { exists, readText, readJson } from './util.js';

const claudeHome = () => process.env.ORGTOMO_CLAUDE_HOME || path.join(os.homedir(), '.claude');
const sfHome = () => process.env.ORGTOMO_SF_HOME || path.join(os.homedir(), '.sf');

/** Where the three plugins are installed, as Claude Code records it. */
export function pluginScopes() {
  const all = readJson(path.join(claudeHome(), 'plugins', 'installed_plugins.json'), null)?.plugins || {};
  const out = {};
  for (const [id, entries] of Object.entries(all)) {
    const name = id.split('@')[0];
    if (!id.endsWith('@orgtomo') || !['orgtomo', 'salesforce-development', 'salesforce-code-quality'].includes(name)) continue;
    out[name] = [...new Set((entries || []).map((e) => e.scope))];
  }
  return out;
}

/**
 * @param {string} root
 * @param {{orgs?: boolean}} opts orgs: also contact every org (needs the sf CLI and network)
 * @returns {{ok: boolean, checks: {id: string, level: 'ok'|'warn'|'fail'|'info', message: string, fix?: string}[]}}
 */
export function doctor(root, { orgs = false } = {}) {
  const checks = [];
  const add = (id, level, message, fix) => checks.push({ id, level, message, ...(fix ? { fix } : {}) });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20 ? 'ok' : 'fail', `Node.js ${process.versions.node}`, major >= 20 ? undefined : 'Install Node.js 20 or newer.');

  const cfg = loadConfig(root);
  const { errors, warnings } = validateConfig(cfg);
  if (errors.length) { for (const e of errors) add('config', 'fail', e, 'Edit the file under orgtomo.config/ or use the UI.'); return { ok: false, checks }; }
  add('config', 'ok', `Configuration is valid: ${orgNames(cfg).length} org(s), build org "${cfg.pipeline.build_org}", Brain base "${cfg.pipeline.brain_base}".`);
  for (const w of warnings) add('config', 'warn', w);
  add('rules', 'info', `Loop limit ${loopMax(cfg)} (hard cap 3). Human approval after: ${approvalStages(cfg).join(', ')}. E-mail mode: ${cfg.safety.email_mode}. Test addresses allowed: ${(cfg.safety.allowed_emails || []).length}, test phone numbers allowed: ${(cfg.safety.allowed_phones || []).length}.`);

  const sf = spawnSync(process.env.ORGTOMO_SF_BIN || 'sf', ['--version'], { encoding: 'utf8' });
  add('sf-cli', sf.status === 0 ? 'ok' : 'fail', sf.status === 0 ? `Salesforce CLI: ${sf.stdout.trim().split('\n')[0]}` : 'Salesforce CLI (sf) not found.', sf.status === 0 ? undefined : 'Install the Salesforce CLI and log in to each org with its alias.');

  const stale = [];
  for (const [name, def] of Object.entries(cfg.agents.agents)) {
    if (def.enabled === false || (name === 'notetaker' && !cfg.features.meetings?.enabled)) continue;
    const f = path.join(layout(root).claude, 'agents', `${agentFileName(name)}.md`);
    let want;
    try { want = renderAgent(cfg, name); } catch { continue; }
    if (!exists(f) || readText(f) !== want) stale.push(name);
  }
  add('generated', stale.length ? 'warn' : 'ok', stale.length ? `Agent files are out of date: ${stale.join(', ')}.` : 'Generated agent files match the configuration.', stale.length ? 'Run: orgtomo sync' : undefined);

  const b = brainStatus(root, cfg, cfg.pipeline.brain_base);
  if (!b.exists) add('brain', 'warn', `No Org Brain for "${cfg.pipeline.brain_base}" yet.`, `Run: orgtomo brain sync ${cfg.pipeline.brain_base}`);
  else add('brain', b.stale.length ? 'warn' : 'ok', `Org Brain of "${b.org}": ${b.components} component(s), built ${b.built_at.slice(0, 10)}${b.stale.length ? `, ${b.stale.length} out of date` : ''}.`, b.stale.length ? `Run: orgtomo brain build ${b.org}` : undefined);
  const studied = orgNames(cfg).map((n) => discoverState(root, n)).filter(Boolean);
  if (studied.length) for (const s of studied) add(`discover:${s.org}`, 'info', `Business discovery of "${s.org}": ${s.domains.length} domain(s), ${s.domains.filter((d) => d.note_status === 'checked').length} with a checked process note, ${s.questions.filter((q) => q.status === 'open').length} question(s) waiting for you.`);
  else add('discover', 'info', 'No business discovery yet. It is optional.', `Run: orgtomo discover run ${cfg.pipeline.discover?.org || cfg.pipeline.brain_base} --retrieve`);

  const canary = readCanary(root);
  for (const name of orgNames(cfg)) {
    const o = getOrg(cfg, name);
    if (isProduction(o)) { add(`org:${name}`, 'info', `${name}: production. Read-only, masked, never written.`); continue; }
    if (canWriteData(o) && cfg.safety.email_mode === 'blocked') {
      const c = canary[name];
      add(`canary:${name}`, c?.status === 'blocked' ? 'ok' : 'warn', c ? `${name}: e-mail canary says "${c.status}" (${c.source}, ${c.at.slice(0, 16)}).` : `${name}: no e-mail canary yet; agents cannot write test data there.`, c?.status === 'blocked' ? undefined : `Run: orgtomo org canary ${name}`);
    }
    if (orgs) {
      try { const v = verifyOrg(root, cfg, name); add(`org:${name}`, 'ok', `${name}: reachable, IsSandbox = ${v.is_sandbox}, type ${v.type}.`); }
      catch (e) { add(`org:${name}`, 'fail', e.message, e.code === 'ORG_CHANGED' ? `If this is expected, confirm it: orgtomo human org-changed ${name}` : `Check the login of alias "${o.alias}": sf org list`); }
    }
  }
  if (orgs) for (const name of orgNames(cfg).filter((n) => isProduction(getOrg(cfg, n)))) {
    try { const v = verifyOrg(root, cfg, name); add(`org:${name}`, 'ok', `${name}: reachable (read-only), IsSandbox = ${v.is_sandbox}.`); } catch (e) { add(`org:${name}`, 'warn', e.message); }
  }
  if (orgs) retrieveProbe(root, cfg, add);

  if (cfg.features.sf_skills?.flow_generator) {
    const want = getOrg(cfg, cfg.pipeline.build_org).alias;
    const have = sfDefaultOrg(root, cfg);
    const where = `${cfg.pipeline.source_dir || 'source'}/${cfg.pipeline.build_org}`;
    add('default-org', have === want ? 'ok' : 'warn', have === want ? `Flow generator: the project default org is "${want}".` : `Flow generator is on, but the project default org is "${have ?? 'not set'}" (expected "${want}"). The generator is refused until it is set.`, have === want ? undefined : `Run in the folder ${where} (it holds sfdx-project.json): sf config set target-org ${want}`);
  }

  const br = cfg.safety.browser || {};
  if (['playwright', 'playwright-extension'].includes(br.provider)) {
    const hosts = allowedBrowserHosts(cfg);
    add('browser', hosts.length ? 'ok' : 'warn', hosts.length ? `Browser fence: ${hosts.filter((h) => h.endsWith('.my.salesforce.com')).join(', ')} (and their Lightning, Setup and site domains). Sign-in: ${br.login === 'frontdoor' ? 'one-time link from the CLI session, renewed when older than ' + Number(br.session_minutes ?? 60) + ' minutes' : 'by the human, in the agent browser'}${br.provider === 'playwright-extension' ? '; attached to your own running browser' : ''}.` : 'No sandbox host configured; the browser is closed for agents.', hosts.length ? undefined : 'Add host: to your sandboxes in orgs.yaml.');
  }
  const st = readJson(path.join(layout(root).state, 'hook-selftest.json'), null);
  add('hooks', st ? 'ok' : 'warn', st ? `Hooks deliver human commands (last self-test ${st.at.slice(0, 16)} via ${st.event}).` : 'Hooks not confirmed yet in this workspace.', st ? undefined : 'In Claude Code type /orgtomo:ping once. If nothing is recorded, the plugin is not enabled in this folder.');

  const scopes = pluginScopes();
  const everywhere = Object.entries(scopes).filter(([, s]) => s.includes('user')).map(([n]) => n);
  if (Object.keys(scopes).length) add('plugins', everywhere.length ? 'warn' : 'ok', everywhere.length ? `Installed for every folder on this computer: ${everywhere.join(', ')}. Their skills and hooks then load in all your projects, not only here.` : `Plugins are installed for this project only: ${Object.keys(scopes).join(', ')}.`, everywhere.length ? 'See docs/SETUP.md, "Install the plugins": install them with --scope project in this folder and remove the user-wide copies.' : undefined);

  const lock = readJson(path.join(PLUGIN_ROOT, 'sf-skills.lock'), null);
  if (lock) add('sf-skills', 'info', `Salesforce skills pinned to ${lock.sha.slice(0, 8)} (${lock.verified}). Flow generator ${cfg.features.sf_skills?.flow_generator ? 'on, build org only' : 'off'}.`);
  const consent = readJson(path.join(sfHome(), 'telemetry', 'telemetry-config.json'), null);
  const machine = consent?.enabled === false ? 'off' : 'on (its default)';
  if (cfg.features.sf_skills?.telemetry) add('telemetry', 'info', 'Salesforce plugin telemetry: allowed in this workspace (features.yaml).');
  else add('telemetry', everywhere.includes('salesforce-development') && machine !== 'off' ? 'warn' : 'ok', `Salesforce plugin telemetry: off inside this workspace (set by Orgtomo through the environment). Outside this workspace the plugin's own setting applies, and that is ${machine}.`, everywhere.includes('salesforce-development') && machine !== 'off' ? 'To switch it off for the whole computer, type in Claude Code: /salesforce-development:telemetry off' : undefined);

  const a = cfg.agents;
  add('reviewer', !sameModel(a.agents.reviewer.model, a.agents.builder.model) ? 'ok' : 'warn', `Builder on ${a.agents.builder.model}, Reviewer on ${a.agents.reviewer.model}.`);
  const cat = loadCatalogue(root);
  add('models', 'info', `Model list: ${cat.source === 'api' ? `from your account, read ${String(cat.fetched_at).slice(0, 10)}` : `shipped with this release (${cat.updated})`}; ${cat.models.length} model(s).`, cat.source === 'api' ? undefined : 'Optional: orgtomo models refresh (needs ANTHROPIC_API_KEY)');
  const ob = obsidianStatus(root);
  add('obsidian', 'info', ob.installed ? `Obsidian is installed${ob.vault_opened_before ? ' and this vault has been opened in it' : '; this vault has not been opened in it yet'}.` : 'Obsidian is not installed. It is optional: the control panel shows the Org Brain too.', ob.installed && !ob.vault_opened_before ? 'Open Obsidian, choose "Open folder as vault" and pick the vault folder.' : undefined);
  return { ok: !checks.some((c) => c.level === 'fail'), checks };
}

/**
 * Retrieve one real component from the build org, the same way a backup does.
 * A health check that only asks "are you there" misses a CLI that answers
 * but cannot do the one thing every ticket needs first.
 */
function retrieveProbe(root, cfg, add) {
  const build = cfg.pipeline.build_org;
  const dir = path.join(root, cfg.pipeline.source_dir || 'source', build);
  const sample = exists(dir) ? [...scanSource(root, dir).values()].find((c) => c.type === 'ApexClass') || [...scanSource(root, dir).values()][0] : null;
  if (!sample) { add('retrieve', 'info', `No metadata in ${cfg.pipeline.source_dir || 'source'}/${build} yet, so the retrieve test was skipped.`, `Run: orgtomo brain sync ${build}`); return; }
  const out = path.join(layout(root).state, 'tmp', 'doctor', String(Date.now()));
  try {
    const r = retrieve(root, cfg, { org: build, refs: [sample.ref], outDir: out, key: null });
    add('retrieve', r.found.includes(sample.ref) ? 'ok' : 'warn', r.found.includes(sample.ref) ? `Retrieve from ${build} works (${sample.ref}, ${r.files.length} file(s)). Backups will work the same way.` : `The retrieve from ${build} ran but did not return ${sample.ref}.`);
  } catch (e) {
    add('retrieve', 'fail', `A retrieve from ${build} failed: ${e.message}`, 'Backups, verification and the parity check all use this. Fix it before starting a ticket.');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

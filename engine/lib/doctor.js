// Doctor: a health check a human can read. It changes nothing.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, layout } from './paths.js';
import { loadConfig, validateConfig, orgNames, org as getOrg, canWriteData, isProduction, loopMax, approvalStages } from './config.js';
import { renderAgent, agentFileName } from './sync.js';
import { brainStatus } from './brain.js';
import { readCanary } from './canary.js';
import { verifyOrg } from './org.js';
import { allowedBrowserHosts } from './guards/mcp.js';
import { exists, readText, readJson } from './util.js';

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
  add('rules', 'info', `Loop limit ${loopMax(cfg)} (hard cap 3). Human approval after: ${approvalStages(cfg).join(', ')}. E-mail mode: ${cfg.safety.email_mode}.`);

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
  if (!b.exists) add('brain', 'warn', `No Org Brain for "${cfg.pipeline.brain_base}" yet.`, `Run: orgtomo brain retrieve ${cfg.pipeline.brain_base}  then  orgtomo brain build ${cfg.pipeline.brain_base}`);
  else add('brain', b.stale.length ? 'warn' : 'ok', `Org Brain of "${b.org}": ${b.components} component(s), built ${b.built_at.slice(0, 10)}${b.stale.length ? `, ${b.stale.length} out of date` : ''}.`, b.stale.length ? `Run: orgtomo brain build ${b.org}` : undefined);

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
      catch (e) { add(`org:${name}`, 'fail', e.message); }
    }
  }
  if (orgs) for (const name of orgNames(cfg).filter((n) => isProduction(getOrg(cfg, n)))) {
    try { const v = verifyOrg(root, cfg, name); add(`org:${name}`, 'ok', `${name}: reachable (read-only), IsSandbox = ${v.is_sandbox}.`); } catch (e) { add(`org:${name}`, 'warn', e.message); }
  }
  if (cfg.safety.browser?.provider === 'playwright') {
    const hosts = allowedBrowserHosts(cfg);
    add('browser', hosts.length ? 'ok' : 'warn', hosts.length ? `Browser fence: ${hosts.filter((h) => h.endsWith('.my.salesforce.com')).join(', ')} (and their Lightning, Setup and site domains).` : 'No sandbox host configured; the browser is closed for agents.', hosts.length ? undefined : 'Add host: to your sandboxes in orgs.yaml.');
  }
  const st = readJson(path.join(layout(root).state, 'hook-selftest.json'), null);
  add('hooks', st ? 'ok' : 'warn', st ? `Hooks deliver human commands (last self-test ${st.at.slice(0, 16)} via ${st.event}).` : 'Hooks not confirmed yet in this workspace.', st ? undefined : 'In Claude Code type /orgtomo:ping once. If nothing is recorded, the plugin is not enabled in this folder.');
  const lock = readJson(path.join(PLUGIN_ROOT, 'sf-skills.lock'), null);
  if (lock) add('sf-skills', 'info', `Salesforce skills pinned to ${lock.sha.slice(0, 8)} (${lock.verified}). Telemetry ${cfg.features.sf_skills?.telemetry ? 'on' : 'off'}; Flow generator ${cfg.features.sf_skills?.flow_generator ? 'on, build org only' : 'off'}.`);
  const a = cfg.agents;
  add('reviewer', a.agents.reviewer.model !== a.agents.builder.model ? 'ok' : 'warn', `Builder on ${a.agents.builder.model}, Reviewer on ${a.agents.reviewer.model}.`);
  return { ok: !checks.some((c) => c.level === 'fail'), checks };
}

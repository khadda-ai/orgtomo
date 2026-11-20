// MCP guard: an agent may call an MCP tool only when a capability grants it.
// Also holds the browser fence and the rule that trackers are read-only.
import path from 'node:path';
import { matchGlob, exists, readJson, getPath } from '../util.js';
import { orgNames, org, isProduction, buildOrg } from '../config.js';
import { scanText, describeFindings } from './data.js';

const deny = (reason) => ({ decision: 'deny', reason });
const ALLOW = { decision: 'allow' };

/** Tools an agent holds through its capabilities (patterns allowed). */
export function grantedTools(cfg, agent) {
  const caps = cfg.capabilities;
  const grant = caps.grants?.[agent];
  if (!grant) return [];
  const tools = [];
  for (const capName of grant.capabilities || []) {
    const cap = caps.capabilities?.[capName];
    if (!cap) continue;
    if (cap.feature && getPath(cfg.features, cap.feature) !== true) continue;
    if (capName === 'meetings.read' && !cfg.features.meetings?.enabled) continue;
    tools.push(...(cap.tools || []));
    if (capName === 'meetings.read' && cfg.features.meetings?.store_transcripts) tools.push(...(cap.transcript_tools || []));
  }
  return tools;
}
const neverTools = (cfg) => Object.values(cfg.capabilities.capabilities || {}).flatMap((c) => c.never || []);

/** Hosts an agent's browser may open: the non-production orgs' domains. */
export function allowedBrowserHosts(cfg) {
  const hosts = [];
  for (const name of orgNames(cfg)) {
    const o = org(cfg, name);
    if (!o.host || isProduction(o)) continue;
    const h = String(o.host).replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    hosts.push(h);
    const stem = h.replace(/\.(my\.salesforce\.com|lightning\.force\.com|my\.salesforce-setup\.com|my\.site\.com)$/, '');
    if (stem !== h) hosts.push(`${stem}.my.salesforce.com`, `${stem}.lightning.force.com`, `${stem}.my.salesforce-setup.com`, `${stem}.my.site.com`);
  }
  return [...new Set(hosts)];
}
export function productionHosts(cfg) {
  return orgNames(cfg).map((n) => org(cfg, n)).filter((o) => isProduction(o) && o.host)
    .map((o) => String(o.host).replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase().replace(/\.(my\.salesforce\.com|lightning\.force\.com)$/, ''));
}

/** @param {string} url */
export function checkBrowserUrl(url, cfg) {
  if (/^about:blank$/i.test(url)) return ALLOW;
  let u;
  try { u = new URL(url); } catch { return deny(`Not a valid URL: ${url}`); }
  if (u.protocol !== 'https:') return deny('The browser opens https pages of your configured sandboxes only.');
  const host = u.hostname.toLowerCase();
  if (productionHosts(cfg).some((stem) => host === stem || host.startsWith(`${stem}.`))) return deny('Production is never opened in the agent browser.');
  if (!allowedBrowserHosts(cfg).includes(host)) {
    return deny(`"${host}" is not a configured sandbox host. Add the org's My Domain host to orgs.yaml (host:) if this is one of your sandboxes.`);
  }
  const target = u.pathname + u.search;
  const blocked = (cfg.safety.browser?.deny_path_patterns || []).find((g) => matchGlob(g, u.pathname) || matchGlob(g, target));
  if (blocked) return deny(`This page is on the browser deny list (${blocked}).`);
  return ALLOW;
}

/** The project-level default org of the sf CLI, if it can be read. */
export function sfDefaultOrg(root, cfg) {
  for (const dir of [root, path.join(root, cfg.pipeline.source_dir || 'source', cfg.pipeline.build_org)]) {
    const f = path.join(dir, '.sf', 'config.json');
    if (exists(f)) { const v = readJson(f, {})['target-org']; if (v) return v; }
  }
  return null;
}

/**
 * @param {string} tool full tool name, e.g. mcp__playwright__browser_navigate
 * @param {object} input tool input
 * @param {{cfg: object, root: string, agent: string, guardsOff?: boolean}} ctx
 */
export function checkMcp(tool, input, ctx) {
  const { cfg, agent, root } = ctx;
  const short = tool.split('__').pop();
  // Rules that hold even with guards off: browser fence against production.
  if (/browser_navigate$/.test(short) && input?.url) {
    const r = checkBrowserUrl(input.url, cfg);
    if (r.decision === 'deny') return r;
  }
  if (ctx.guardsOff) return ALLOW;
  if (neverTools(cfg).some((g) => matchGlob(g, tool))) return deny(`"${short}" is on the never list: it is not granted to any agent.`);
  if (tool.startsWith('mcp__claude-in-chrome__')) {
    if (!cfg.safety.browser?.claude_in_chrome) return deny('Claude in Chrome is off. It is opt-in (safety.yaml), runs only in a separate Chrome profile, and its results are never evidence.');
    if (!['reproducer', 'tester'].includes(agent)) return deny('Only the Reproducer and the Tester may use Claude in Chrome.');
    return ALLOW;
  }
  const granted = grantedTools(cfg, agent);
  if (!granted.some((g) => matchGlob(g, tool))) {
    return deny(`"${tool}" is not granted to "${agent}". Tools come from capabilities.yaml; a tool that no capability lists is denied. Trackers are read-only: comments are drafted, never posted.`);
  }
  if (/execute_metadata_action$/.test(short)) {
    const want = buildOrg(cfg).alias;
    const have = sfDefaultOrg(root, cfg);
    if (have !== want) return deny(`The Flow generator runs only against the build org. The project default org is "${have ?? 'not set'}", expected "${want}". The human sets it once with: sf config set target-org ${want}`);
  }
  if (/browser_(type|fill_form|select_option|press_key)$/.test(short)) {
    const findings = scanText(JSON.stringify(input || {}), cfg.safety);
    if (findings.length) return deny(`Data guard: ${describeFindings(findings)}`);
  }
  return ALLOW;
}

/** WebFetch is limited to official documentation hosts. */
export function checkWebFetch(url, cfg) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return deny(`Not a valid URL: ${url}`); }
  const ok = (cfg.safety.official_doc_hosts || []).some((h) => host === h || host.endsWith(`.${h}`));
  return ok ? ALLOW : deny(`"${host}" is not an accepted documentation source. Accepted hosts are listed in safety.yaml (official_doc_hosts).`);
}

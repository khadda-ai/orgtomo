// Loads and validates the workspace configuration. Defaults come from
// spec/defaults; the workspace overrides them. orgs.yaml is never merged with
// defaults because your orgs are yours alone.
import path from 'node:path';
import { parse, parseDocument } from './yaml.js';
import { exists, readText, writeText, merge, fail } from './util.js';
import { SPEC_DIR, layout } from './paths.js';

export const CONFIG_FILES = ['orgs', 'pipeline', 'safety', 'agents', 'features', 'conventions', 'capabilities'];
export const MODELS = ['sonnet', 'opus', 'haiku', 'fable', 'inherit'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const ROLES = ['build', 'test', 'reference', 'production'];
export const DEPLOY_TOOLS = ['blue-canvas', 'change-set', 'git-cli', 'generic'];
export const LOOP_HARD_CAP = 3;

const readYaml = (file) => (exists(file) ? parse(readText(file)) || {} : undefined);
export const loadDefault = (name) => readYaml(path.join(SPEC_DIR, 'defaults', `${name}.yaml`));

/**
 * Load the whole configuration of a workspace.
 * @param {string} root workspace root
 */
export function loadConfig(root) {
  const dir = layout(root).config;
  const cfg = {};
  for (const name of CONFIG_FILES) {
    const own = readYaml(path.join(dir, `${name}.yaml`));
    cfg[name] = name === 'orgs' ? own || { orgs: {} } : merge(loadDefault(name), own);
  }
  return cfg;
}

/** Stage machine, gate catalogue and rubric; a workspace copy wins over the shipped one. */
export function loadSpec(root, name) {
  const own = root && path.join(layout(root).config, `${name}.yaml`);
  return readYaml(own && exists(own) ? own : path.join(SPEC_DIR, `${name}.yaml`));
}

export const orgNames = (cfg) => Object.keys(cfg.orgs.orgs || {});
export const org = (cfg, name) => {
  const o = cfg.orgs.orgs?.[name];
  return o ? { name, ...o } : fail(`Unknown org "${name}". Known orgs: ${orgNames(cfg).join(', ') || '(none)'}.`, 'UNKNOWN_ORG');
};
export const orgByAlias = (cfg, alias) => {
  const name = orgNames(cfg).find((n) => cfg.orgs.orgs[n].alias === alias || n === alias);
  return name ? org(cfg, name) : null;
};
export const buildOrg = (cfg) => org(cfg, cfg.pipeline.build_org);
export const isProduction = (o) => o.role === 'production';
/** Agents may create test data here. Never true for production. */
export const canWriteData = (o) => !isProduction(o) && (o.role === 'build' || o.role === 'test') && o.data_write !== false;
/** Agents may deploy metadata here. Only the build org. */
export const canWriteMetadata = (o) => o.role === 'build';

/** Loop limit after applying the hard cap. */
export const loopMax = (cfg) => Math.max(0, Math.min(Number(cfg.pipeline.loop?.max ?? 2), LOOP_HARD_CAP));
/** Stages that need a human approval. Review is always included. */
export const approvalStages = (cfg) => [...new Set([...(cfg.pipeline.approvals?.[cfg.pipeline.autonomy] || []), 'review'])];

export const validModel = (m) => MODELS.includes(m) || /^claude-[a-z0-9.-]+$/.test(String(m));

/**
 * Check a configuration. Returns { errors, warnings }; errors stop the engine.
 */
export function validateConfig(cfg) {
  const errors = [];
  const warnings = [];
  const orgs = cfg.orgs.orgs || {};
  if (!Object.keys(orgs).length) errors.push('orgs.yaml: no orgs defined.');
  for (const [name, o] of Object.entries(orgs)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) errors.push(`orgs.yaml: org name "${name}" must be lowercase letters, digits, - or _.`);
    if (!o.alias) errors.push(`orgs.yaml: ${name} has no sf CLI alias.`);
    if (!ROLES.includes(o.role)) errors.push(`orgs.yaml: ${name}.role must be one of ${ROLES.join(', ')}.`);
    if (o.role === 'production' && (o.data_write === true || o.metadata_write === true)) {
      errors.push(`orgs.yaml: ${name} is production. Production is read-only and cannot be made writable.`);
    }
    if (o.role !== 'build' && o.metadata_write === true) errors.push(`orgs.yaml: ${name}: only the build org accepts metadata from agents; other orgs are deployed by a human.`);
  }
  const p = cfg.pipeline;
  if (!orgs[p.build_org]) errors.push(`pipeline.yaml: build_org "${p.build_org}" is not in orgs.yaml.`);
  else if (orgs[p.build_org].role !== 'build') errors.push(`pipeline.yaml: build_org "${p.build_org}" must have role build.`);
  if (!orgs[p.brain_base]) errors.push(`pipeline.yaml: brain_base "${p.brain_base}" is not in orgs.yaml.`);
  for (const t of p.targets || []) {
    if (!orgs[t.org]) errors.push(`pipeline.yaml: target "${t.org}" is not in orgs.yaml.`);
    if (!DEPLOY_TOOLS.includes(t.tool)) errors.push(`pipeline.yaml: target ${t.org}: tool must be one of ${DEPLOY_TOOLS.join(', ')}.`);
    if (orgs[t.org]?.role === 'production' && t.retest) warnings.push(`pipeline.yaml: target ${t.org} is production; retest is ignored there (read-only parity check only).`);
  }
  if (Number(p.loop?.max) > LOOP_HARD_CAP) warnings.push(`pipeline.yaml: loop.max ${p.loop.max} is above the hard cap; ${LOOP_HARD_CAP} is used.`);
  if (!['low', 'medium', 'high'].includes(p.autonomy)) errors.push('pipeline.yaml: autonomy must be low, medium or high.');

  const s = cfg.safety;
  if (!['blocked', 'allowlist_only'].includes(s.email_mode)) errors.push('safety.yaml: email_mode must be blocked or allowlist_only.');
  if (!(s.allowed_emails || []).length && !(s.allowed_email_domains || []).length) warnings.push('safety.yaml: no allowed e-mail addresses; agents cannot create any record that has an e-mail.');
  if ((s.allowed_emails || []).some((e) => e === '*' || e === '*@*')) errors.push('safety.yaml: an allow-all e-mail pattern defeats the data guard.');

  const a = cfg.agents.agents || {};
  for (const [name, def] of Object.entries(a)) {
    if (!validModel(def.model)) errors.push(`agents.yaml: ${name}.model "${def.model}" is not valid (${MODELS.join(', ')} or a full claude-... id).`);
    if (!EFFORTS.includes(def.effort)) errors.push(`agents.yaml: ${name}.effort "${def.effort}" must be one of ${EFFORTS.join(', ')}.`);
    if (def.core && def.enabled === false) errors.push(`agents.yaml: ${name} is a core agent and cannot be turned off.`);
  }
  if (cfg.agents.rules?.reviewer_differs_from_builder && a.reviewer && a.builder && a.reviewer.model === a.builder.model && a.reviewer.model !== 'inherit') {
    errors.push(`agents.yaml: reviewer and builder both use "${a.builder.model}". Pick different models or turn rules.reviewer_differs_from_builder off.`);
  }
  for (const [kind, pattern] of Object.entries(flatPatterns(cfg.conventions.naming || {}))) {
    try { new RegExp(pattern); } catch { errors.push(`conventions.yaml: naming.${kind} is not a valid pattern.`); }
  }
  for (const f of cfg.conventions.forbidden || []) {
    try { new RegExp(f.pattern); } catch { errors.push(`conventions.yaml: forbidden.${f.id} is not a valid pattern.`); }
  }
  const m = cfg.features.meetings || {};
  if (m.enabled && !['granola', 'zoom', 'google-meet', 'file'].includes(m.provider)) errors.push('features.yaml: meetings.provider must be granola, zoom, google-meet or file.');
  return { errors, warnings };
}

function flatPatterns(naming, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(naming)) {
    if (v && typeof v === 'object') flatPatterns(v, `${prefix}${k}.`, out);
    else if (typeof v === 'string' && v) out[prefix + k] = v;
  }
  return out;
}

/** Load config and stop with a readable message if it is invalid. */
export function requireConfig(root) {
  const cfg = loadConfig(root);
  const { errors } = validateConfig(cfg);
  if (errors.length) fail(`Configuration problems:\n- ${errors.join('\n- ')}`, 'BAD_CONFIG');
  return cfg;
}

/**
 * Change one value in a workspace config file, keeping its comments.
 * The change is validated before it is written.
 */
export function setConfigValue(root, file, dotted, value) {
  if (!CONFIG_FILES.includes(file)) fail(`Unknown config file "${file}".`);
  const target = path.join(layout(root).config, `${file}.yaml`);
  const source = exists(target) ? readText(target) : readText(path.join(SPEC_DIR, 'defaults', `${file}.yaml`));
  const doc = parseDocument(source);
  doc.setIn(dotted.split('.'), value);
  const next = String(doc);
  const cfg = loadConfig(root);
  cfg[file] = file === 'orgs' ? parse(next) : merge(loadDefault(file), parse(next));
  const { errors } = validateConfig(cfg);
  if (errors.length) fail(`Not saved:\n- ${errors.join('\n- ')}`, 'BAD_CONFIG');
  writeText(target, next);
  return cfg;
}

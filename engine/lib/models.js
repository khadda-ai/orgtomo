// Model catalogue: which models an agent can run on, what each alias means
// today, and which effort levels each model accepts.
//
// Two sources, best first:
//   1. the Models API of your own account (orgtomo models refresh, needs ANTHROPIC_API_KEY)
//   2. the list shipped with this release (spec/models.json)
// Nothing here is needed for agents to run: agents.yaml accepts any alias or
// full model id. The catalogue only makes the choice visible and checked.
import path from 'node:path';
import { SPEC_DIR, layout } from './paths.js';
import { exists, readJson, writeJson, nowIso } from './util.js';

export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALIAS_ENV = { sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL', opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL', haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL' };

export const shippedCatalogue = () => ({ ...readJson(path.join(SPEC_DIR, 'models.json')), source: 'shipped' });
const cacheFile = (root) => path.join(layout(root).state, 'models.json');

/** The catalogue a workspace uses: its refreshed copy when there is one, else the shipped list. */
export function loadCatalogue(root) {
  const shipped = shippedCatalogue();
  const cached = root && exists(cacheFile(root)) ? readJson(cacheFile(root), null) : null;
  const cat = cached?.models?.length ? { ...shipped, ...cached } : shipped;
  // Claude Code lets these variables say what an alias means; show the same thing.
  const aliases = { ...cat.aliases };
  for (const [alias, name] of Object.entries(ALIAS_ENV)) if (process.env[name]) aliases[alias] = process.env[name];
  return { ...cat, aliases };
}

/** Full model id behind an alias; a full id is returned as it is. */
export const resolveModel = (cat, value) => cat.aliases?.[value] || value;

/** Effort levels a model accepts, or every level when the catalogue does not know the model. */
export function effortsFor(cat, value) {
  const m = (cat.models || []).find((x) => x.id === resolveModel(cat, value));
  return m?.efforts?.length ? m.efforts : cat.efforts || EFFORT_ORDER;
}

/** Choices for a model picker: aliases first, then pinned versions. */
export function modelOptions(cat) {
  const name = (id) => (cat.models || []).find((m) => m.id === id)?.name || id;
  const aliases = Object.entries(cat.aliases || {}).map(([alias, id]) => ({ value: alias, label: `${name(id)} · ${alias} (always the latest)`, group: 'alias', efforts: effortsFor(cat, alias) }));
  const pinned = (cat.models || []).map((m) => ({ value: m.id, label: `${m.name} · ${m.id} (this version)`, group: 'pinned', efforts: m.efforts?.length ? m.efforts : cat.efforts }));
  return [...aliases, ...pinned, { value: 'inherit', label: 'inherit · same as the session', group: 'other', efforts: cat.efforts || EFFORT_ORDER }];
}

/** Effort levels from a Models API capability tree: { effort: { supported, low: { supported }, ... } }. */
function effortsOf(capabilities) {
  const e = capabilities?.effort;
  if (!e || e.supported === false) return [];
  return EFFORT_ORDER.filter((level) => e[level]?.supported === true);
}

/**
 * Ask the Models API which models this account can use and store the answer.
 * A plain HTTPS request is used on purpose: the plugin runs from a git
 * checkout with no installed packages, so it cannot depend on an SDK.
 * @returns {Promise<object>} what was stored, or why nothing was
 */
export async function refreshModels(root, { apiKey = process.env.ANTHROPIC_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) return { refreshed: false, source: 'shipped', reason: 'ANTHROPIC_API_KEY is not set, so the list shipped with this release stays in use. A Claude subscription login cannot be used for this request.' };
  const models = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const url = new URL('https://api.anthropic.com/v1/models');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after_id', after);
    const res = await fetchImpl(url, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { refreshed: false, source: 'shipped', reason: `The Models API answered ${res.status}. The shipped list stays in use.` };
    const body = await res.json();
    const data = Array.isArray(body) ? body : body.data || [];
    for (const m of data) if (m?.id) models.push({ id: m.id, name: m.display_name || m.id, efforts: effortsOf(m.capabilities) });
    if (!body.has_more || !body.last_id || !data.length) break;
    after = body.last_id;
  }
  if (!models.length) return { refreshed: false, source: 'shipped', reason: 'The Models API returned no models. The shipped list stays in use.' };
  const stored = { source: 'api', fetched_at: nowIso(), models };
  writeJson(cacheFile(root), stored);
  return { refreshed: true, source: 'api', models: models.length, fetched_at: stored.fetched_at };
}

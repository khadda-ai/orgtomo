// E-mail canary state. In "blocked" mode no data may be written to an org
// until a recent check showed that the org cannot send e-mail.
import path from 'node:path';
import { layout } from './paths.js';
import { readJson, writeJson, now, nowIso } from './util.js';

const file = (root) => path.join(layout(root).state, 'canary.json');

export const readCanary = (root) => readJson(file(root), {});

/** Record a canary result. status: blocked | enabled | unknown. source: probe | human. */
export function recordCanary(root, orgName, status, source, detail = '') {
  const all = readCanary(root);
  all[orgName] = { status, source, detail, at: nowIso() };
  writeJson(file(root), all);
  return all[orgName];
}

/**
 * May data be written to this org right now, as far as e-mail is concerned?
 * @returns {{ok: boolean, reason?: string}}
 */
export function emailGate(root, cfg, o) {
  if (cfg.safety.email_mode === 'allowlist_only') return { ok: true };
  const c = readCanary(root)[o.name];
  const maxAge = Number(cfg.safety.canary_max_age_minutes ?? 30) * 60_000;
  if (!c) return { ok: false, reason: `E-mail safety: no canary result for "${o.name}". Run: orgtomo org canary ${o.name}` };
  if (c.status !== 'blocked') {
    return { ok: false, reason: `E-mail safety: "${o.name}" can send e-mail (canary: ${c.status}). Set Deliverability to "No access" or "System email only" in that sandbox, or ask the human to switch email_mode to allowlist_only.` };
  }
  if (now() - new Date(c.at) > maxAge) return { ok: false, reason: `E-mail safety: the canary for "${o.name}" is older than ${cfg.safety.canary_max_age_minutes} minutes. Run: orgtomo org canary ${o.name}` };
  return { ok: true };
}

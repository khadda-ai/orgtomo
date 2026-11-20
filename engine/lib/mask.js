// Masks query results before they are shown to an agent or stored as evidence.
import { matchAny } from './util.js';
import { maskValue, scanText } from './guards/data.js';

/**
 * Mask records returned by a SOQL query.
 * - fields whose name matches safety.mask.field_patterns are masked
 * - any other string that contains an address or number outside the allow list is masked
 * - safety.mask.keep_fields and nulls are left alone
 */
export function maskRecords(records, safety) {
  const patterns = safety.mask?.field_patterns || [];
  const keep = new Set(safety.mask?.keep_fields || []);
  const one = (rec) => {
    const out = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'attributes') { out[k] = { type: v?.type }; continue; }
      if (v && typeof v === 'object') { out[k] = Array.isArray(v.records) ? { ...v, records: v.records.map(one) } : one(v); continue; }
      if (v == null || keep.has(k) || typeof v === 'boolean' || typeof v === 'number') { out[k] = v; continue; }
      if (matchAny(patterns, k, { nocase: true })) { out[k] = maskValue(v, safety); continue; }
      out[k] = typeof v === 'string' && scanText(v, safety).length ? redactInside(v, safety) : v;
    }
    return out;
  };
  return (records || []).map(one);
}

/**
 * Redact addresses and numbers inside every string of a result, whatever the
 * field is called. Used for Tooling API rows, where field names say nothing.
 */
export function redactDeep(value, safety) {
  if (typeof value === 'string') return scanText(value, safety).length ? redactInside(value, safety) : value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, safety));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'attributes').map(([k, v]) => [k, redactDeep(v, safety)]));
  return value;
}

/** Replace every disallowed address or number inside a longer text. */
export function redactInside(text, safety) {
  let out = String(text);
  for (const f of scanText(out, safety)) out = out.split(f.value).join(maskValue(f.value, safety));
  return out;
}

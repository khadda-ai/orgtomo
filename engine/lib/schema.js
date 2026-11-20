// A small JSON Schema validator covering the keywords the Orgtomo contracts
// use: type, enum, const, required, properties, additionalProperties, items,
// minItems, maxItems, minLength, pattern, minimum, maximum and local $ref.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, exists } from './util.js';

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec', 'schemas');
const cache = new Map();

/** Load spec/schemas/<name>.schema.json (cached). */
export function loadSchema(name, dir = SCHEMA_DIR) {
  const file = path.join(dir, `${name}.schema.json`);
  if (!cache.has(file)) {
    if (!exists(file)) throw new Error(`Unknown contract "${name}"`);
    cache.set(file, readJson(file));
  }
  return cache.get(file);
}

function resolveRef(ref, dir) {
  const [id, pointer = ''] = ref.split('#');
  let node = loadSchema(id, dir);
  for (const part of pointer.split('/').filter(Boolean)) node = node?.[part];
  if (!node) throw new Error(`Cannot resolve $ref ${ref}`);
  return node;
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

/**
 * Validate a value. Returns a list of human-readable errors (empty = valid).
 * @param {unknown} value
 * @param {object} schema
 */
export function validate(value, schema, { dir = SCHEMA_DIR, at = '$' } = {}) {
  const errors = [];
  const check = (v, s, p) => {
    if (s.$ref) return check(v, resolveRef(s.$ref, dir), p);
    if (s.const !== undefined && v !== s.const) errors.push(`${p}: must be ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.includes(v)) errors.push(`${p}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    if (s.type) {
      const t = typeOf(v);
      const ok = s.type === t || (s.type === 'number' && (t === 'integer' || t === 'number'));
      if (!ok) { errors.push(`${p}: expected ${s.type}, got ${t}`); return; }
    }
    if (typeof v === 'string') {
      if (s.minLength !== undefined && v.trim().length < s.minLength) errors.push(`${p}: too short (min ${s.minLength} characters)`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${p}: "${v}" does not match ${s.pattern}`);
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${p}: must be >= ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${p}: must be <= ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${p}: needs at least ${s.minItems} item(s)`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${p}: at most ${s.maxItems} item(s)`);
      if (s.items) v.forEach((item, i) => check(item, s.items, `${p}[${i}]`));
    }
    if (typeOf(v) === 'object') {
      for (const key of s.required || []) if (v[key] === undefined) errors.push(`${p}.${key}: required`);
      for (const [key, val] of Object.entries(v)) {
        if (s.properties?.[key]) check(val, s.properties[key], `${p}.${key}`);
        else if (s.additionalProperties === false) errors.push(`${p}.${key}: unknown field`);
      }
    }
  };
  check(value, schema, at);
  return errors;
}

/** Validate against a named contract. */
export const validateContract = (value, name) => validate(value, loadSchema(name));

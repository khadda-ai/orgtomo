// Small, dependency-free helpers shared by the whole engine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const exists = (p) => fs.existsSync(p);
export const readText = (p) => fs.readFileSync(p, 'utf8');
export const readJson = (p, fallback) => {
  if (!exists(p)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`File not found: ${p}`);
  }
  return JSON.parse(readText(p));
};
export function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
export const writeJson = (p, value) => writeText(p, JSON.stringify(value, null, 2) + '\n');
export function appendLine(p, line) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, line.endsWith('\n') ? line : line + '\n');
}
export const readJsonl = (p) => (exists(p) ? readText(p).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Recursively list files under dir (relative paths, forward slashes). */
export function listFiles(dir, { ignore = ['node_modules', '.git'] } = {}) {
  const out = [];
  const walk = (d, rel) => {
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (ignore.includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const sha256File = (p) => sha256(fs.readFileSync(p));

/** Current time. Tests pin it with ORGTOMO_NOW. */
export const now = () => (process.env.ORGTOMO_NOW ? new Date(process.env.ORGTOMO_NOW) : new Date());
export const nowIso = () => now().toISOString();
export const today = () => nowIso().slice(0, 10);

export const slug = (s) =>
  String(s).normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').toLowerCase().slice(0, 80) || 'untitled';

/** Convert a glob (`*`, `**`, `?`) to an anchored RegExp. Case-insensitive on request. */
export function globToRegex(glob, { nocase = false } = {}) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, nocase ? 'i' : '');
}
export const matchGlob = (glob, value, opts) => globToRegex(glob, opts).test(value);
export const matchAny = (globs, value, opts) => (globs || []).some((g) => matchGlob(g, value, opts));

/** Split a Markdown note into { data, body } using simple `key: value` frontmatter. */
export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const raw = line.slice(i + 1).trim();
    let value = raw;
    if (raw.startsWith('[') || raw.startsWith('{') || raw.startsWith('"')) {
      try { value = JSON.parse(raw); } catch { /* keep raw text */ }
    } else if (raw === 'true' || raw === 'false') value = raw === 'true';
    data[line.slice(0, i).trim()] = value;
  }
  return { data, body: text.slice(m[0].length) };
}
/** Obsidian-friendly frontmatter: scalars plain, arrays and objects as JSON flow. */
export function formatFrontmatter(data) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : needsQuote(v) ? JSON.stringify(String(v)) : v}`);
  return `---\n${lines.join('\n')}\n---\n`;
}
const needsQuote = (v) => typeof v === 'string' && (/[:#\[\]{}]|^\s|\s$|^[-?!&*|>'"%@`]/.test(v) || v === '');

export const uniq = (arr) => [...new Set(arr)];
export const pad = (n, width = 3) => String(n).padStart(width, '0');

/** Get a.b.c from an object. */
export const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
export function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
  return obj;
}
/** Deep merge: objects merge, everything else (arrays included) is replaced. */
export function merge(base, over) {
  if (over === undefined) return base;
  if (!isObj(base) || !isObj(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Error whose message is safe to show to an agent or a human as-is. */
export class OrgtomoError extends Error {
  constructor(message, code = 'ERROR') {
    super(message);
    this.code = code;
  }
}
export const fail = (message, code) => { throw new OrgtomoError(message, code); };

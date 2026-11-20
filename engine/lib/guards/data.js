// Data guard: finds e-mail addresses and phone numbers that are not on the
// allow list. Used on commands, files, browser input, agent outputs.
import { matchGlob } from '../util.js';

// Anything shaped like an address, including broken ones (a dot at the start or
// end of either side, two dots in a row). A broken address can still be a real
// person's address with a typo, so it is treated as an address: when unsure, mask.
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const WELL_FORMED = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const PHONE_FORMATTED = /(?<![\w.+-])(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g;
const PHONE_PLUS = /(?<![\w.])\+\d[\d\s().-]{7,17}\d(?!\w)/g;
const PHONE_KEYED = /(?:phone|mobile|fax|cell|tel)\w*["']?\s*[:=,]\s*["']?(\d[\d\s().-]{8,16}\d)/gi;

const digits = (s) => s.replace(/\D/g, '');
const tidy = (part) => part.replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');

/** True when the text is an address with no stray dots. */
export const wellFormed = (email) => WELL_FORMED.test(email);

/** The address with stray dots removed: ".a..b.@.c.com" -> "a.b@c.com". */
export function normalizeAddress(email) {
  const at = email.lastIndexOf('@');
  return `${tidy(email.slice(0, at))}@${tidy(email.slice(at + 1))}`;
}

const listed = (e, safety) => {
  if ((safety.allowed_emails || []).some((g) => matchGlob(String(g).toLowerCase(), e))) return true;
  const domain = e.split('@')[1];
  return (safety.allowed_email_domains || []).some((d) => String(d).toLowerCase() === domain);
};

/**
 * Is this address allowed in test data?
 * With safety.allowed_email_shapes on, a broken variant of an allowed address
 * (extra dots only) is allowed too, so that validation bugs can be tested.
 * @param {string} email
 */
export function emailAllowed(email, safety) {
  const e = email.toLowerCase();
  if (listed(e, safety)) return true;
  return safety.allowed_email_shapes === true && !wellFormed(e) && listed(normalizeAddress(e), safety);
}
export const phoneAllowed = (phone, safety) => (safety.allowed_phones || []).some((p) => digits(String(p)) === digits(phone));

/**
 * Scan text. Returns findings for every address or number outside the allow list.
 * @param {string} text
 * @param {object} safety safety.yaml content
 * @returns {{type:'email'|'phone', value:string}[]}
 */
export function scanText(text, safety) {
  const found = new Map();
  if (!text) return [];
  const t = String(text);
  for (const m of t.matchAll(ADDRESS)) {
    const v = m[0];
    if (/\.(png|jpe?g|gif|svg|js|css|cls|xml|json|md)$/i.test(v)) continue; // retina file names like logo@2x.png
    if (!emailAllowed(v, safety)) found.set(`e:${v.toLowerCase()}`, { type: 'email', value: v });
  }
  const phones = [...t.matchAll(PHONE_FORMATTED), ...t.matchAll(PHONE_PLUS)].map((m) => m[0]);
  for (const m of t.matchAll(PHONE_KEYED)) phones.push(m[1]);
  for (const p of phones) {
    const d = digits(p);
    if (d.length < 10 || d.length > 15) continue;
    if (!phoneAllowed(p, safety)) found.set(`p:${d}`, { type: 'phone', value: p.trim() });
  }
  return [...found.values()];
}

/** Findings in `text` whose values do not already appear in `existing` text. */
export function scanNew(text, existing, safety) {
  const hits = scanText(text, safety);
  if (!hits.length || !existing) return hits;
  const before = new Set(scanText(existing, safety).map((f) => `${f.type}:${f.value.toLowerCase()}`));
  return hits.filter((f) => !before.has(`${f.type}:${f.value.toLowerCase()}`));
}

/**
 * Hide who an address belongs to but keep its shape: every label keeps its
 * first character, every dot and the @ stay where they were, and the last
 * label of the domain is kept. "john.smith@.dept.uni.edu" -> "j***.s***@.d***.u***.edu".
 * The shape matters: a ticket about a misplaced dot is unreadable without it.
 */
export function maskAddress(email) {
  const at = email.lastIndexOf('@');
  const hide = (label) => (label ? `${label[0]}***` : '');
  const local = email.slice(0, at).split('.').map(hide).join('.');
  const labels = email.slice(at + 1).split('.');
  const lastReal = labels.length - 1;
  const domain = labels.map((l, i) => (i === lastReal ? l : hide(l))).join('.');
  return `${local}@${domain}`;
}

/** One readable sentence for a deny message. Values are partly hidden so the message itself leaks nothing. */
export function describeFindings(findings) {
  const hide = (f) => (f.type === 'email' ? maskAddress(f.value) : f.value.replace(/\d(?=(?:\D*\d){2})/g, '*'));
  return `${findings.length} value(s) outside the allow list: ${findings.slice(0, 5).map((f) => `${f.type} ${hide(f)}`).join(', ')}. `
    + 'Use only the test addresses and numbers from safety.yaml, or redact real ones (j***@c***.com).';
}

/** Mask one value for display or storage. */
export function maskValue(value, safety) {
  if (typeof value !== 'string') return value == null ? value : '***';
  const whole = value.match(ADDRESS);
  if (whole && whole[0] === value) return emailAllowed(value, safety) ? value : maskAddress(value);
  const d = digits(value);
  if (d.length >= 10 && d.length <= 15 && /^[+\d\s().-]+$/.test(value)) return phoneAllowed(value, safety) ? value : `***${d.slice(-2)}`;
  return value.length <= 1 ? '*' : `${value[0]}***`;
}

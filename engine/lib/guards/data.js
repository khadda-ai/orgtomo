// Data guard: finds e-mail addresses and phone numbers that are not on the
// allow list. Used on commands, files, browser input, agent outputs.
import { matchGlob } from '../util.js';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE_FORMATTED = /(?<![\w.+-])(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g;
const PHONE_PLUS = /(?<![\w.])\+\d[\d\s().-]{7,17}\d(?!\w)/g;
const PHONE_KEYED = /(?:phone|mobile|fax|cell|tel)\w*["']?\s*[:=,]\s*["']?(\d[\d\s().-]{8,16}\d)/gi;

const digits = (s) => s.replace(/\D/g, '');

/** @param {string} email */
export function emailAllowed(email, safety) {
  const e = email.toLowerCase();
  if ((safety.allowed_emails || []).some((g) => matchGlob(String(g).toLowerCase(), e))) return true;
  const domain = e.split('@')[1];
  return (safety.allowed_email_domains || []).some((d) => String(d).toLowerCase() === domain);
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
  for (const m of t.matchAll(EMAIL)) {
    const v = m[0].replace(/[.]+$/, '');
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

/** One readable sentence for a deny message. Values are partly hidden so the message itself leaks nothing. */
export function describeFindings(findings) {
  const hide = (f) => (f.type === 'email' ? f.value.replace(/^(.).*(@.).*(\..+)$/, '$1***$2***$3') : f.value.replace(/\d(?=(?:\D*\d){2})/g, '*'));
  return `${findings.length} value(s) outside the allow list: ${findings.slice(0, 5).map((f) => `${f.type} ${hide(f)}`).join(', ')}. `
    + 'Use only the test addresses and numbers from safety.yaml, or redact real ones (j***@c***.com).';
}

/** Mask one value for display or storage. */
export function maskValue(value, safety) {
  if (typeof value !== 'string') return value == null ? value : '***';
  if (EMAIL.test(value)) { EMAIL.lastIndex = 0; return emailAllowed(value, safety) ? value : value.replace(/^(.)[^@]*@(.)[^.]*(\..+)$/, '$1***@$2***$3'); }
  EMAIL.lastIndex = 0;
  const d = digits(value);
  if (d.length >= 10 && d.length <= 15 && /^[+\d\s().-]+$/.test(value)) return phoneAllowed(value, safety) ? value : `***${d.slice(-2)}`;
  return value.length <= 1 ? '*' : `${value[0]}***`;
}

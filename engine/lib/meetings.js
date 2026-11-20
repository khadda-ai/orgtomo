// Meeting notes. The Notetaker agent reads meetings through whatever provider
// is configured (Granola, Zoom, Google Meet export, or files dropped in the
// inbox) and hands the engine one contract per meeting. The engine stores the
// note in the vault and attaches updates to tickets:
//   - explicit links (the ticket key is literally in the meeting) attach at once
//   - inferred links wait for the human to confirm
import path from 'node:path';
import { layout } from './paths.js';
import { validateContract } from './schema.js';
import { redactInside } from './mask.js';
import { proposeProfileNote, enabled as peopleOn } from './people.js';
import { exists, readJson, writeJson, writeText, appendLine, nowIso, slug, fail, formatFrontmatter, pad, now } from './util.js';

const file = (root) => path.join(layout(root).state, 'meetings.json');
const load = (root) => readJson(file(root), { meetings: {}, pending: [], last_sync: null });
export const enabled = (cfg) => cfg.features.meetings?.enabled === true;

export const listMeetings = (root) => Object.values(load(root).meetings).sort((a, b) => b.date.localeCompare(a.date));
export const pendingLinks = (root) => load(root).pending.filter((p) => p.status === 'pending');

/** What the Notetaker should do now. */
export function plan(root, cfg) {
  if (!enabled(cfg)) return { enabled: false };
  const db = load(root);
  const days = Number(cfg.features.meetings.lookback_days ?? 2);
  const since = db.last_sync ? db.last_sync.slice(0, 10) : new Date(now() - days * 86_400_000).toISOString().slice(0, 10);
  return { enabled: true, provider: cfg.features.meetings.provider, since, known_ids: Object.keys(db.meetings), inbox: 'vault/meetings/inbox/', store_transcripts: cfg.features.meetings.store_transcripts === true };
}

/**
 * Store one meeting.
 * @param {object} m meeting contract (spec/schemas/meeting.schema.json)
 */
export function ingest(root, cfg, m, { actor } = {}) {
  if (!enabled(cfg)) fail('The meetings feature is switched off (features.yaml: meetings.enabled).', 'FEATURE_OFF');
  const clean = JSON.parse(redactInside(JSON.stringify(m), cfg.safety));
  const errors = validateContract(clean, 'meeting');
  if (errors.length) fail(`Meeting not stored:\n- ${errors.join('\n- ')}`, 'BAD_CONTRACT');
  const db = load(root);
  const haystack = [clean.title, clean.summary, ...clean.decisions.map((d) => d.text), ...clean.action_items.map((a) => a.text)].join('\n');
  const noteName = `${clean.date.slice(0, 10)}-${slug(clean.title)}`;
  const attached = [];
  const waiting = [];
  for (const link of clean.ticket_links) {
    const literal = new RegExp(`\\b${String(link.key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack); // the key is text to find, never a pattern
    if (link.basis === 'explicit' && !literal) fail(`Link to ${link.key} is marked explicit, but "${link.key}" does not appear in the meeting title, summary, decisions or action items. Mark it inferred.`, 'NOT_EXPLICIT');
    if (link.basis === 'explicit') { attach(root, link.key, clean, link.update, noteName); attached.push(link.key); }
    else if (!db.pending.some((p) => p.meeting_id === clean.meeting_id && p.key === link.key)) {
      const rec = { id: `M-${pad(db.pending.length + 1, 4)}`, meeting_id: clean.meeting_id, note: noteName, title: clean.title, date: clean.date, key: link.key, update: link.update, reason: link.reason || '', status: 'pending' };
      db.pending.push(rec); waiting.push(rec.id);
    }
  }
  if (peopleOn(cfg)) for (const n of clean.profile_notes || []) proposeProfileNote(root, cfg, { person: n.person, note: n.note, basis: `meeting ${clean.meeting_id}`, actor });
  db.meetings[clean.meeting_id] = { meeting_id: clean.meeting_id, title: clean.title, date: clean.date, provider: clean.provider, note: noteName, tickets: attached, attendees: clean.attendees };
  db.last_sync = nowIso();
  writeJson(file(root), db);
  writeText(path.join(layout(root).vault, 'meetings', `${noteName}.md`), `${formatFrontmatter({ type: 'meeting', meeting_id: clean.meeting_id, date: clean.date, provider: clean.provider, attendees: clean.attendees, tickets: attached, url: clean.url })}# ${clean.title}\n\n${clean.summary}\n\n## Decisions\n\n${clean.decisions.map((d) => `- ${d.text}${d.said_by ? ` (${d.said_by})` : ''}${(d.tickets || []).map((k) => ` [[tickets/${k}/status|${k}]]`).join('')}`).join('\n') || '_None recorded._'}\n\n## Action items\n\n${clean.action_items.map((a) => `- [ ] ${a.text}${a.owner ? ` (${a.owner})` : ''}${(a.tickets || []).map((k) => ` [[tickets/${k}/status|${k}]]`).join('')}`).join('\n') || '_None recorded._'}\n\n## Tickets\n\n${attached.map((k) => `- [[tickets/${k}/status|${k}]] (named in the meeting)`).join('\n')}${waiting.length ? `\n- ${waiting.length} possible link(s) wait for confirmation` : ''}\n`);
  return { stored: noteName, attached, waiting_for_confirmation: waiting };
}

function attach(root, key, meeting, update, noteName) {
  const dir = layout(root).ticketDir(key);
  appendLine(path.join(dir, 'updates.md'), `\n## ${meeting.date.slice(0, 10)} meeting: ${meeting.title}\n\n${update}\n\nSource: [[meetings/${noteName}]]\n`);
}

/** Human confirms or rejects an inferred link. */
export function confirmLink(root, cfg, id, accept = true) {
  const db = load(root);
  const p = db.pending.find((x) => x.id === id && x.status === 'pending') || fail(`No pending meeting link ${id}.`);
  p.status = accept ? 'accepted' : 'rejected';
  if (accept) {
    attach(root, p.key, { date: p.date, title: p.title }, p.update, p.note);
    const m = db.meetings[p.meeting_id];
    if (m && !m.tickets.includes(p.key)) m.tickets.push(p.key);
  }
  writeJson(file(root), db);
  return p;
}

/** Updates attached to a ticket, if any. */
export const ticketUpdates = (root, key) => {
  const f = path.join(layout(root).ticketDir(key), 'updates.md');
  return exists(f) ? f : null;
};

// People profiles: how each colleague or client likes to be written to.
// Only work-communication facts are stored (role, level of Salesforce
// knowledge, preferred detail). The schema has no free-form personal fields.
// Agents may only propose; a profile changes when the human sets or confirms it.
import fs from 'node:fs';
import path from 'node:path';
import { layout } from './paths.js';
import { validateContract } from './schema.js';
import { exists, readJson, writeJson, writeText, nowIso, slug, fail, formatFrontmatter, pad } from './util.js';

const file = (root) => path.join(layout(root).state, 'people.json');
const load = (root) => readJson(file(root), { people: {}, proposals: [] });
export const enabled = (cfg) => cfg.features.people_profiles?.enabled === true;
const requireOn = (cfg) => enabled(cfg) || fail('People profiles are switched off (features.yaml: people_profiles.enabled).', 'FEATURE_OFF');

export const listPeople = (root) => Object.values(load(root).people);
export const listProposals = (root) => load(root).proposals.filter((p) => p.status === 'pending');

/** Find a person by name or alias (case-insensitive). */
export function findPerson(root, name) {
  const n = String(name).trim().toLowerCase();
  return listPeople(root).find((p) => p.name.toLowerCase() === n || (p.aliases || []).some((a) => a.toLowerCase() === n)) || null;
}

/** Human sets or updates a profile. `fields` is a partial person object. */
export function setPerson(root, cfg, name, fields, { source = 'human' } = {}) {
  requireOn(cfg);
  const db = load(root);
  const id = slug(name);
  const next = { ...(db.people[id] || { name: name.trim(), side: 'internal' }), ...fields, name: (db.people[id]?.name || name).trim() };
  const { updated_at, sources, ...shape } = next;
  const errors = validateContract(shape, 'person');
  if (errors.length) fail(`Profile not saved:\n- ${errors.join('\n- ')}`, 'BAD_CONTRACT');
  db.people[id] = { ...shape, updated_at: nowIso(), sources: [...new Set([...(sources || []), source])] };
  writeJson(file(root), db);
  renderPeople(root);
  return db.people[id];
}

export function removePerson(root, cfg, name) {
  const db = load(root);
  const id = slug(name);
  if (!db.people[id]) fail(`No profile for "${name}".`);
  delete db.people[id];
  writeJson(file(root), db);
  const note = path.join(layout(root).vault, 'people', `${id}.md`);
  if (exists(note)) fs.rmSync(note);
  renderPeople(root);
  return { removed: name };
}

/** An agent noticed something (for example in a meeting). It waits for the human. */
export function proposeProfileNote(root, cfg, { person, note, basis, actor }) {
  requireOn(cfg);
  if (!note || note.trim().length < 5) fail('The note is empty.');
  if (!basis) fail('Say where this was observed (meeting id or ticket key).');
  const db = load(root);
  const rec = { id: `P-${pad(db.proposals.length + 1, 4)}`, person: person.trim(), note: note.trim(), basis, by: actor || 'agent', at: nowIso(), status: 'pending' };
  db.proposals.push(rec);
  writeJson(file(root), db);
  return rec;
}

/** Human accepts a proposal: the note is added to "prefers" (or "avoid"). */
export function confirmProposal(root, cfg, id, { as = 'prefers', accept = true } = {}) {
  const db = load(root);
  const p = db.proposals.find((x) => x.id === id && x.status === 'pending') || fail(`No pending proposal ${id}.`);
  p.status = accept ? 'accepted' : 'rejected';
  writeJson(file(root), db);
  if (!accept) return p;
  const cur = findPerson(root, p.person);
  setPerson(root, cfg, p.person, { [as]: [...new Set([...(cur?.[as] || []), p.note])] }, { source: `confirmed ${p.id} (${p.basis})` });
  return p;
}

/** What the Scribe needs for a set of recipients. Unknown names come back as such. */
export function audienceBrief(root, cfg, names) {
  if (!enabled(cfg)) return { enabled: false, people: [], unknown: names };
  const people = names.map((n) => findPerson(root, n)).filter(Boolean);
  return { enabled: true, people, unknown: names.filter((n) => !findPerson(root, n)) };
}

function renderPeople(root) {
  const dir = path.join(layout(root).vault, 'people');
  const people = listPeople(root);
  for (const p of people) {
    writeText(path.join(dir, `${slug(p.name)}.md`), `${formatFrontmatter({ type: 'person', name: p.name, side: p.side, role: p.role, company: p.company, salesforce_knowledge: p.salesforce_knowledge, detail_level: p.detail_level, language: p.language, aliases: p.aliases, updated: p.updated_at })}# ${p.name}\n\n${p.role ? `**Role:** ${p.role}${p.company ? `, ${p.company}` : ''}  \n` : ''}**Side:** ${p.side}  \n**Salesforce knowledge:** ${p.salesforce_knowledge || 'not set'}  \n**Detail level:** ${p.detail_level || 'not set'}\n\n## Write to them like this\n\n${(p.prefers || []).map((x) => `- ${x}`).join('\n') || '_Nothing recorded yet._'}\n\n## Avoid\n\n${(p.avoid || []).map((x) => `- ${x}`).join('\n') || '_Nothing recorded yet._'}\n\n## Where this comes from\n\n${(p.sources || []).map((x) => `- ${x}`).join('\n')}\n`);
  }
  writeText(path.join(dir, 'People.md'), `${formatFrontmatter({ type: 'people-index', updated: nowIso() })}# People\n\nWork-communication profiles used to tailor drafts. Nothing personal is stored here.\n\n| Name | Side | Role | Salesforce knowledge | Detail |\n|---|---|---|---|---|\n${people.map((p) => `| [[people/${slug(p.name)}\\|${p.name}]] | ${p.side} | ${p.role || ''} | ${p.salesforce_knowledge || ''} | ${p.detail_level || ''} |`).join('\n')}\n`);
}

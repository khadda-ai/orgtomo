// Self-learning. Two layers, both evidence-based:
//   observations  facts the engine itself recorded (a gate failed, a human
//                 rejected a plan, a reviewer finding with proof, a clean run)
//   lessons       short rules for one agent, each citing observations
// Agents never write here directly. A lesson reaches an agent only after it is
// approved (by the human, or automatically when enough observations back it).
import path from 'node:path';
import { layout } from './paths.js';
import { readJsonl, appendLine, readJson, writeJson, writeText, nowIso, pad, fail, uniq, formatFrontmatter } from './util.js';

const dir = (root) => path.join(layout(root).state, 'learning');
const obsFile = (root) => path.join(dir(root), 'observations.jsonl');
const lessonsFile = (root) => path.join(dir(root), 'lessons.json');

export const listObservations = (root, filter = {}) =>
  readJsonl(obsFile(root)).filter((o) => Object.entries(filter).every(([k, v]) => v === undefined || o[k] === v));
export const listLessons = (root) => readJson(lessonsFile(root), []);

/**
 * Record an observation. Called only by the engine.
 * @param {string} root
 * @param {{ticket?: string, stage?: string, agent: string, kind: 'mistake'|'good'|'feedback', source: 'gate'|'lead'|'human'|'reviewer'|'engine', signature: string, fact: string, evidence?: string[]}} o
 */
export function observe(root, o) {
  const id = `O-${pad(readJsonl(obsFile(root)).length + 1, 4)}`;
  const rec = { id, at: nowIso(), ticket: o.ticket || null, stage: o.stage || null, agent: o.agent, kind: o.kind, source: o.source, signature: o.signature, fact: o.fact, evidence: o.evidence || [] };
  appendLine(obsFile(root), JSON.stringify(rec));
  if (o.kind === 'mistake') {
    const lessons = listLessons(root);
    let changed = false;
    for (const l of lessons) {
      if (l.status === 'approved' && l.agent === o.agent && l.type === 'avoid' && l.signatures.includes(o.signature) && !l.observations.includes(id)) {
        l.recurrences = (l.recurrences || 0) + 1;
        (l.recurred_in ||= []).push(id);
        changed = true;
      }
    }
    if (changed) writeJson(lessonsFile(root), lessons);
  }
  return rec;
}

/** Group mistakes by agent and signature: what keeps happening. */
export function patterns(root) {
  const map = new Map();
  for (const o of listObservations(root)) {
    const k = `${o.agent}|${o.signature}|${o.kind}`;
    const p = map.get(k) || { agent: o.agent, signature: o.signature, kind: o.kind, count: 0, tickets: [], observations: [], last: o.at };
    p.count++; p.observations.push(o.id); if (o.ticket) p.tickets = uniq([...p.tickets, o.ticket]); p.last = o.at;
    map.set(k, p);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Add lessons proposed by the Coach (or stated by the human).
 * Each must cite existing observations. Returns the stored lessons.
 */
export function proposeLessons(root, cfg, proposals, { by = 'coach' } = {}) {
  const all = listObservations(root);
  const byId = new Map(all.map((o) => [o.id, o]));
  const lessons = listLessons(root);
  const min = Number(cfg.features.self_learning?.auto_apply_min_observations ?? 2);
  const stored = [];
  for (const p of proposals) {
    const obs = p.observations.map((id) => byId.get(id) || fail(`Lesson cites unknown observation ${id}.`, 'NO_EVIDENCE'));
    if (!cfg.agents.agents[p.agent]) fail(`Lesson names unknown agent "${p.agent}".`);
    const signatures = uniq(obs.map((o) => o.signature));
    const support = all.filter((o) => signatures.includes(o.signature) && o.agent === p.agent).length;
    const humanSaid = by === 'human' || obs.some((o) => o.source === 'human');
    let lesson = lessons.find((l) => l.agent === p.agent && norm(l.rule) === norm(p.rule));
    if (lesson) {
      lesson.observations = uniq([...lesson.observations, ...p.observations]);
      lesson.signatures = uniq([...lesson.signatures, ...signatures]);
    } else {
      lesson = { id: `L-${pad(lessons.length + 1, 4)}`, agent: p.agent, type: p.type, rule: p.rule.trim(), why: p.why.trim(), observations: uniq(p.observations), signatures, status: 'proposed', proposed_by: by, created_at: nowIso(), recurrences: 0 };
      lessons.push(lesson);
    }
    if (lesson.status === 'proposed' && (humanSaid || support >= min)) {
      lesson.status = 'approved';
      lesson.approved_by = humanSaid ? 'human' : 'auto';
      lesson.approved_at = nowIso();
    }
    lesson.tickets = uniq(lesson.observations.map((id) => byId.get(id)?.ticket).filter(Boolean));
    stored.push(lesson);
  }
  writeJson(lessonsFile(root), lessons);
  renderLearning(root);
  return stored;
}

/** Human decision on a lesson. status: approved | retired */
export function setLessonStatus(root, id, status) {
  const lessons = listLessons(root);
  const l = lessons.find((x) => x.id === id) || fail(`No lesson ${id}.`);
  l.status = status;
  if (status === 'approved') { l.approved_by = 'human'; l.approved_at = nowIso(); }
  if (status === 'retired') l.retired_at = nowIso();
  writeJson(lessonsFile(root), lessons);
  renderLearning(root);
  return l;
}

export const lessonsFor = (root, agent) => listLessons(root).filter((l) => l.agent === agent && l.status === 'approved');

/** Write the learning notes into the vault so they can be read in Obsidian. */
export function renderLearning(root) {
  const vault = path.join(layout(root).vault, 'learning');
  const lessons = listLessons(root);
  const obs = listObservations(root);
  const link = (t) => (t ? `[[tickets/${t}/status|${t}]]` : '');
  const rows = lessons.map((l) => `| [[learning/lessons/${l.id}\\|${l.id}]] | ${l.agent} | ${l.type} | ${l.rule.replace(/\|/g, '/')} | ${l.status}${l.approved_by ? ` (${l.approved_by})` : ''} | ${l.observations.length} | ${l.recurrences || 0} |`);
  writeText(path.join(vault, 'Lessons.md'), `${formatFrontmatter({ type: 'learning-index', updated: nowIso() })}# Lessons\n\nEvery lesson cites observations the engine recorded. "Repeated after" counts how often the same mistake happened after the lesson was applied; a number above 0 means the lesson needs to be sharper.\n\n| Lesson | Agent | Type | Rule | Status | Observations | Repeated after |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
  for (const l of lessons) {
    const cited = l.observations.map((id) => obs.find((o) => o.id === id)).filter(Boolean);
    writeText(path.join(vault, 'lessons', `${l.id}.md`), `${formatFrontmatter({ type: 'lesson', id: l.id, agent: l.agent, kind: l.type, status: l.status, approved_by: l.approved_by, recurrences: l.recurrences || 0, tickets: l.tickets || [] })}# ${l.id}: ${l.rule}\n\n**Agent:** ${l.agent}  \n**Why:** ${l.why}\n\n## Evidence\n\n${cited.map((o) => `- ${o.id} (${o.at.slice(0, 10)}, ${o.source}) ${link(o.ticket)} ${o.stage || ''}: ${o.fact}`).join('\n')}\n`);
  }
  const byTicket = new Map();
  for (const o of obs) { const k = o.ticket || '_general'; byTicket.set(k, [...(byTicket.get(k) || []), o]); }
  for (const [t, list] of byTicket) {
    writeText(path.join(vault, 'observations', `${t}.md`), `${formatFrontmatter({ type: 'observations', ticket: t, mistakes: list.filter((o) => o.kind === 'mistake').length, good: list.filter((o) => o.kind === 'good').length })}# Observations ${t === '_general' ? '' : link(t)}\n\n| Id | When | Agent | Stage | Kind | Source | Fact |\n|---|---|---|---|---|---|---|\n${list.map((o) => `| ${o.id} | ${o.at.slice(0, 16).replace('T', ' ')} | ${o.agent} | ${o.stage || ''} | ${o.kind} | ${o.source} | ${o.fact.replace(/\|/g, '/').replace(/\n/g, ' ')} |`).join('\n')}\n`);
  }
}

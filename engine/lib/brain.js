// Org Brain: a map of an org, generated from its metadata and stored as an
// Obsidian vault. Facts are generated, never hand-written, and each fact note
// carries the hash of the source it came from, so staleness can be detected.
//
//   vault/orgs/<org>/facts/<Type>/<Name>.md     one note per component
//   vault/orgs/<org>/facts/_automation/<Object>.md   everything that runs on an object
//   vault/orgs/<org>/maps/<Object>.canvas       the same as a JSON Canvas map
//   vault/orgs/<org>/_index.json                machine index (components, hashes, links)
//   vault/orgs/<org>/understanding/             notes written by the Cartographer
import fs from 'node:fs';
import path from 'node:path';
import { layout, rel } from './paths.js';
import { org as getOrg } from './config.js';
import { refFromPath, parseRef } from './metadata.js';
import { parseXml, kids, val, findAll } from './xml.js';
import { lessonsFor } from './learning.js';
import { exists, readText, writeText, readJson, writeJson, listFiles, sha256, sha256File, nowIso, today, appendLine, formatFrontmatter, uniq, fail } from './util.js';

const noteRel = (orgName, ref) => { const { type, name } = parseRef(ref); return `orgs/${orgName}/facts/${type}/${name.replace(/\//g, '_')}`; };
const link = (orgName, ref) => `[[${noteRel(orgName, ref)}|${parseRef(ref).name}]]`;

// ------------------------------------------------------------------ parsing

/** Read every known component under a source folder. */
export function scanSource(root, sourceDir) {
  const files = listFiles(sourceDir, { ignore: ['node_modules', '.git', '.sf', '.sfdx'] });
  const comps = new Map();
  for (const f of files) {
    const ref = refFromPath(f);
    if (!ref) continue;
    const c = comps.get(ref) || { ref, ...parseRef(ref), files: [] };
    c.files.push(f);
    comps.set(ref, c);
  }
  for (const c of comps.values()) {
    c.files.sort();
    c.path = rel(root, path.join(sourceDir, c.type.endsWith('Bundle') ? path.dirname(c.files[0]) : c.files.find((f) => !f.endsWith('-meta.xml') || c.files.length === 1) || c.files[0]));
    c.sha256 = sha256(c.files.map((f) => sha256File(path.join(sourceDir, f))).join('|'));
  }
  return comps;
}

const read = (sourceDir, c, test) => { const f = c.files.find(test); return f ? readText(path.join(sourceDir, f)) : ''; };

function parseComponent(sourceDir, c, known) {
  const facts = {};
  const deps = new Set();
  const addObj = (o) => { if (o) deps.add(`CustomObject:${o}`); };
  const addField = (o, f) => { if (o && f && known.has(`CustomField:${o}.${f}`)) deps.add(`CustomField:${o}.${f}`); };
  if (c.type === 'ApexClass' || c.type === 'ApexTrigger') {
    const src = read(sourceDir, c, (f) => /\.(cls|trigger)$/.test(f));
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    facts.lines = src.split('\n').length;
    if (c.type === 'ApexTrigger') {
      const m = /trigger\s+\w+\s+on\s+(\w+)\s*\(([^)]*)\)/i.exec(code);
      if (m) { facts.object = m[1]; facts.events = m[2].split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); addObj(m[1]); }
    } else {
      facts.sharing = /\b(with sharing|without sharing|inherited sharing)\b/.exec(code)?.[1] || 'not declared';
      facts.is_test = /@isTest/i.test(src);
      facts.implements = uniq([...code.matchAll(/\b(Database\.Batchable|Queueable|Schedulable|Database\.AllowsCallouts|Database\.Stateful)\b/g)].map((m) => m[1]));
      facts.annotations = uniq([...src.matchAll(/@(AuraEnabled|InvocableMethod|future|TestSetup|RestResource|HttpGet|HttpPost)\b/gi)].map((m) => `@${m[1]}`));
      facts.methods = uniq([...code.matchAll(/\b(?:public|global)\s+(?:static\s+)?(?:override\s+)?[\w<>,.\s\[\]]+?\s+(\w+)\s*\(/g)].map((m) => m[1])).filter((n) => n !== c.name).slice(0, 40);
    }
    facts.soql_objects = uniq([...code.matchAll(/\bFROM\s+(\w+)/gi)].map((m) => m[1]));
    facts.dml = uniq([...code.matchAll(/\b(insert|update|upsert|delete|undelete|merge)\s+[\w.\[]/gi)].map((m) => m[1].toLowerCase()).concat(/Database\.(insert|update|upsert|delete)/i.test(code) ? ['Database.*'] : []));
    facts.soql_in_loop_suspect = /\bfor\s*\([^)]*\)\s*\{[^}]*\[\s*SELECT/i.test(code);
    for (const o of facts.soql_objects) if (known.has(`CustomObject:${o}`)) addObj(o);
    const idents = new Set(code.match(/\b[A-Za-z_]\w*\b/g) || []);
    for (const k of known) {
      const { type, name } = parseRef(k);
      if (type === 'ApexClass' && name !== c.name && idents.has(name)) deps.add(k);
      if (type === 'CustomObject' && name.includes('__') && idents.has(name)) deps.add(k);
      if (type === 'CustomField') { const [o, f] = name.split('.'); if (f.includes('__') && idents.has(f) && (deps.has(`CustomObject:${o}`) || facts.object === o || facts.soql_objects.includes(o))) deps.add(k); }
    }
  } else if (c.type === 'Flow') {
    const x = parseXml(read(sourceDir, c, (f) => f.endsWith('.flow-meta.xml')));
    const start = kids(x, 'start')[0];
    Object.assign(facts, {
      label: val(x, 'label'), process_type: val(x, 'processType'), status: val(x, 'status'), description: (val(x, 'description') || '').slice(0, 400),
      object: val(start, 'object'), trigger_type: val(start, 'triggerType'), record_trigger: val(start, 'recordTriggerType'), trigger_order: val(x, 'triggerOrder'),
    });
    const kinds = ['decisions', 'recordLookups', 'recordUpdates', 'recordCreates', 'recordDeletes', 'assignments', 'loops', 'actionCalls', 'subflows', 'screens'];
    facts.elements = Object.fromEntries(kinds.map((k) => [k, kids(x, k).length]).filter(([, n]) => n));
    addObj(facts.object);
    for (const k of ['recordLookups', 'recordUpdates', 'recordCreates', 'recordDeletes']) for (const el of kids(x, k)) { const o = val(el, 'object'); if (o && known.has(`CustomObject:${o}`)) addObj(o); for (const f of findAll(el, 'field')) addField(o || facts.object, f.text); }
    for (const a of kids(x, 'actionCalls')) if (val(a, 'actionType') === 'apex') deps.add(`ApexClass:${val(a, 'actionName')}`);
    for (const s of kids(x, 'subflows')) deps.add(`Flow:${val(s, 'flowName')}`);
    facts.apex_actions = kids(x, 'actionCalls').filter((a) => val(a, 'actionType') === 'apex').map((a) => val(a, 'actionName'));
    for (const m of read(sourceDir, c, (f) => f.endsWith('.flow-meta.xml')).matchAll(/\$Record(?:__Prior)?\.(\w+)/g)) addField(facts.object, m[1]);
  } else if (c.type === 'CustomObject') {
    const x = parseXml(read(sourceDir, c, (f) => f.endsWith('.object-meta.xml')));
    Object.assign(facts, { label: val(x, 'label'), sharing_model: val(x, 'sharingModel'), external_sharing_model: val(x, 'externalSharingModel'), deployment_status: val(x, 'deploymentStatus') });
  } else if (c.type === 'CustomField') {
    const x = parseXml(read(sourceDir, c, () => true));
    const [o] = c.name.split('.');
    Object.assign(facts, { object: o, label: val(x, 'label'), field_type: val(x, 'type'), required: val(x, 'required'), reference_to: val(x, 'referenceTo'), formula: (val(x, 'formula') || '').slice(0, 500) || undefined, unique: val(x, 'unique'), external_id: val(x, 'externalId'), picklist_values: findAll(x, 'fullName').map((n) => n.text).filter((n) => n !== val(x, 'fullName')).slice(0, 60) });
    if (!facts.picklist_values.length) delete facts.picklist_values;
    addObj(o);
    if (facts.reference_to && known.has(`CustomObject:${facts.reference_to}`)) addObj(facts.reference_to);
  } else if (c.type === 'ValidationRule') {
    const x = parseXml(read(sourceDir, c, () => true));
    const [o] = c.name.split('.');
    Object.assign(facts, { object: o, active: val(x, 'active'), formula: (val(x, 'errorConditionFormula') || '').slice(0, 1500), message: val(x, 'errorMessage'), error_field: val(x, 'errorDisplayField') });
    addObj(o);
    for (const t of new Set(facts.formula.match(/\b\w+__c\b/g) || [])) addField(o, t);
  } else if (c.type === 'RecordType') {
    const x = parseXml(read(sourceDir, c, () => true));
    Object.assign(facts, { object: c.name.split('.')[0], label: val(x, 'label'), active: val(x, 'active') });
    addObj(facts.object);
  } else if (c.type === 'LightningComponentBundle') {
    const js = c.files.filter((f) => f.endsWith('.js')).map((f) => readText(path.join(sourceDir, f))).join('\n');
    facts.files = c.files.map((f) => path.basename(f));
    facts.apex_methods = uniq([...js.matchAll(/@salesforce\/apex\/([\w.]+)/g)].map((m) => m[1]));
    for (const m of facts.apex_methods) deps.add(`ApexClass:${m.split('.')[0]}`);
    for (const m of js.matchAll(/@salesforce\/schema\/(\w+)(?:\.(\w+))?/g)) { if (known.has(`CustomObject:${m[1]}`)) addObj(m[1]); addField(m[1], m[2]); }
    const meta = read(sourceDir, c, (f) => f.endsWith('.js-meta.xml'));
    if (meta) { const x = parseXml(meta); facts.exposed = val(x, 'isExposed'); facts.targets = findAll(x, 'target').map((n) => n.text); }
  } else if (c.type === 'PermissionSet' || c.type === 'Profile') {
    const x = parseXml(read(sourceDir, c, () => true));
    Object.assign(facts, { label: val(x, 'label'), object_permissions: kids(x, 'objectPermissions').length, field_permissions: kids(x, 'fieldPermissions').length, class_accesses: kids(x, 'classAccesses').length });
    for (const a of kids(x, 'classAccesses')) if (val(a, 'enabled') === 'true') deps.add(`ApexClass:${val(a, 'apexClass')}`);
  }
  for (const [k, v] of Object.entries(facts)) if (v === undefined || v === null || (Array.isArray(v) && !v.length)) delete facts[k];
  return { facts, deps: [...deps].filter((d) => d !== c.ref && known.has(d)).sort() };
}

// ------------------------------------------------------------------ build

const AUTOMATION_GROUPS = [
  ['Before-save record-triggered flows', (c) => c.type === 'Flow' && c.facts.trigger_type === 'RecordBeforeSave'],
  ['Before triggers', (c) => c.type === 'ApexTrigger' && (c.facts.events || []).some((e) => e.startsWith('before'))],
  ['Validation rules', (c) => c.type === 'ValidationRule'],
  ['After triggers', (c) => c.type === 'ApexTrigger' && (c.facts.events || []).some((e) => e.startsWith('after'))],
  ['After-save record-triggered flows', (c) => c.type === 'Flow' && c.facts.trigger_type === 'RecordAfterSave'],
  ['Other flows on this object (scheduled, screen, autolaunched)', (c) => c.type === 'Flow' && !['RecordBeforeSave', 'RecordAfterSave'].includes(c.facts.trigger_type)],
];

function factNote(orgName, c, usedBy) {
  const scalar = Object.entries(c.facts).filter(([, v]) => typeof v !== 'object');
  const lists = Object.entries(c.facts).filter(([, v]) => typeof v === 'object');
  const fm = formatFrontmatter({ type: c.type, api_name: c.name, org: orgName, object: c.facts.object, source: c.path, sha256: c.sha256, tags: ['orgtomo/fact'] });
  return `${fm}# ${c.name}\n\n> Generated from metadata by Orgtomo. Do not edit: the next sync overwrites it. Interpretation belongs in \`understanding/\`.\n\n| Fact | Value |\n|---|---|\n| Type | ${c.type} |\n${scalar.map(([k, v]) => `| ${k.replace(/_/g, ' ')} | ${String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n')}\n${lists.map(([k, v]) => `\n**${k.replace(/_/g, ' ')}:** ${Array.isArray(v) ? v.join(', ') : Object.entries(v).map(([a, b]) => `${a} ${b}`).join(', ')}`).join('\n')}\n\n## Uses\n\n${c.deps.map((d) => `- ${link(orgName, d)} (${parseRef(d).type})`).join('\n') || '_Nothing found by static analysis._'}\n\n## Used by\n\n${usedBy.map((d) => `- ${link(orgName, d)} (${parseRef(d).type})`).join('\n') || '_Nothing found by static analysis._'}\n`;
}

function automationNote(orgName, object, comps) {
  const sections = AUTOMATION_GROUPS.map(([title, test]) => {
    const list = comps.filter(test).sort((a, b) => Number(a.facts.trigger_order || 9999) - Number(b.facts.trigger_order || 9999) || a.name.localeCompare(b.name));
    return `## ${title}\n\n${list.map((c) => `- ${link(orgName, c.ref)}${c.facts.status ? ` (${c.facts.status})` : ''}${c.facts.active ? ` (active: ${c.facts.active})` : ''}${c.facts.trigger_order ? `, trigger order ${c.facts.trigger_order}` : ''}${c.facts.events ? `: ${c.facts.events.join(', ')}` : ''}`).join('\n') || '_None._'}`;
  });
  return `${formatFrontmatter({ type: 'automation-map', object, org: orgName, tags: ['orgtomo/fact'] })}# What runs on ${object}\n\n> Generated. The groups follow the order Salesforce documents for a record save (Apex Developer Guide, "Triggers and Order of Execution"). Inside a group the order is not guaranteed unless a flow trigger order is set. Workflow rules, processes, assignment and escalation rules are not listed here unless they were retrieved.\n\n${sections.join('\n\n')}\n`;
}

function automationCanvas(orgName, object, comps, byRef) {
  const objRef = `CustomObject:${object}`;
  const nodes = [byRef.has(objRef)
    ? { id: 'obj', type: 'file', file: `${noteRel(orgName, objRef)}.md`, x: 0, y: 0, width: 280, height: 90, color: '5' }
    : { id: 'obj', type: 'text', text: `# ${object}`, x: 0, y: 0, width: 280, height: 90, color: '5' }];
  const edges = [];
  let col = 0;
  for (const [title, test] of AUTOMATION_GROUPS) {
    const list = comps.filter(test);
    if (!list.length) continue;
    col += 1;
    nodes.push({ id: `g${col}`, type: 'text', text: `**${title}**`, x: col * 360, y: -80, width: 300, height: 60 });
    list.forEach((c, i) => {
      const id = `n${col}_${i}`;
      nodes.push({ id, type: 'file', file: `${noteRel(orgName, c.ref)}.md`, x: col * 360, y: i * 110, width: 300, height: 90 });
      edges.push({ id: `e${id}`, fromNode: 'obj', fromSide: 'right', toNode: id, toSide: 'left' });
      c.deps.filter((d) => parseRef(d).type === 'ApexClass' && byRef.has(d)).slice(0, 4).forEach((d, j) => {
        const cid = `${id}_c${j}`;
        nodes.push({ id: cid, type: 'file', file: `${noteRel(orgName, d)}.md`, x: (AUTOMATION_GROUPS.length + 1) * 360 + j * 40, y: nodes.length * 14, width: 260, height: 70, color: '4' });
        edges.push({ id: `e${cid}`, fromNode: id, fromSide: 'right', toNode: cid, toSide: 'left', label: 'calls' });
      });
    });
  }
  return JSON.stringify({ nodes, edges }, null, 2) + '\n';
}

/**
 * Build or refresh the Brain of one org from its retrieved source.
 * Only notes whose content changed are rewritten; changes go to vault/log.md.
 */
export function buildBrain(root, cfg, orgName, { sourceDir } = {}) {
  getOrg(cfg, orgName);
  const dir = sourceDir || path.join(root, cfg.pipeline.source_dir || 'source', orgName);
  if (!exists(dir)) fail(`No source folder for "${orgName}" at ${rel(root, dir)}. Retrieve the org's metadata there first (orgtomo brain retrieve ${orgName}).`, 'NO_SOURCE');
  const comps = scanSource(root, dir);
  const known = new Set(comps.keys());
  for (const c of comps.values()) Object.assign(c, parseComponent(dir, c, known));
  for (const c of comps.values()) { const o = c.facts.object; if (o && !known.has(`CustomObject:${o}`)) c.standard_object = o; }
  const usedBy = new Map();
  for (const c of comps.values()) for (const d of c.deps) usedBy.set(d, [...(usedBy.get(d) || []), c.ref]);

  const L = layout(root);
  const orgDir = L.orgVault(orgName);
  const prev = readJson(path.join(orgDir, '_index.json'), { components: {} });
  const changes = { added: [], changed: [], removed: [] };
  const index = { org: orgName, built_at: nowIso(), source: rel(root, dir), components: {} };
  for (const c of [...comps.values()].sort((a, b) => a.ref.localeCompare(b.ref))) {
    const ub = (usedBy.get(c.ref) || []).sort();
    index.components[c.ref] = { type: c.type, name: c.name, path: c.path, sha256: c.sha256, note: `${noteRel(orgName, c.ref)}.md`, object: c.facts.object, deps: c.deps, used_by: ub, facts: c.facts };
    const before = prev.components[c.ref];
    if (!before) changes.added.push(c.ref); else if (before.sha256 !== c.sha256) changes.changed.push(c.ref);
    const file = path.join(L.vault, `${noteRel(orgName, c.ref)}.md`);
    const text = factNote(orgName, c, ub);
    if (!exists(file) || readText(file) !== text) writeText(file, text);
  }
  for (const ref of Object.keys(prev.components)) {
    if (!index.components[ref]) { changes.removed.push(ref); fs.rmSync(path.join(L.vault, prev.components[ref].note), { force: true }); }
  }
  const objects = uniq([...comps.values()].map((c) => c.facts.object).filter(Boolean)).sort();
  const withAutomation = [];
  for (const o of objects) {
    const list = [...comps.values()].filter((c) => c.facts.object === o && ['Flow', 'ApexTrigger', 'ValidationRule'].includes(c.type));
    if (!list.length) continue;
    withAutomation.push(o);
    writeText(path.join(orgDir, 'facts', '_automation', `${o}.md`), automationNote(orgName, o, list));
    writeText(path.join(orgDir, 'maps', `${o}.canvas`), automationCanvas(orgName, o, list, comps));
  }
  index.objects_with_automation = withAutomation;
  writeJson(path.join(orgDir, '_index.json'), index);

  const counts = {};
  for (const c of comps.values()) counts[c.type] = (counts[c.type] || 0) + 1;
  writeText(path.join(orgDir, 'Overview.md'), `${formatFrontmatter({ type: 'org-overview', org: orgName, role: getOrg(cfg, orgName).role, built: index.built_at, components: comps.size })}# ${orgName}: overview\n\nGenerated ${index.built_at.slice(0, 16).replace('T', ' ')} from \`${index.source}\`.\n\n| Type | Count |\n|---|---|\n${Object.entries(counts).sort().map(([t, n]) => `| ${t} | ${n} |`).join('\n')}\n\n## Objects with automation\n\n${withAutomation.map((o) => `- [[orgs/${orgName}/facts/_automation/${o}|${o}]] ([[orgs/${orgName}/maps/${o}.canvas|map]])`).join('\n') || '_None found._'}\n\n## Understanding\n\nNotes written by the Cartographer live in [[orgs/${orgName}/understanding/README|understanding]]. They explain; the fact notes prove.\n`);
  writeText(path.join(orgDir, 'Components.base'), `filters:\n  and:\n    - file.inFolder("orgs/${orgName}/facts")\nviews:\n  - type: table\n    name: "All components"\n    groupBy:\n      property: note.type\n      direction: ASC\n    order:\n      - file.name\n      - note.type\n      - note.object\n      - note.source\n`);
  const u = path.join(orgDir, 'understanding', 'README.md');
  if (!exists(u)) writeText(u, `# Understanding of ${orgName}\n\nThe Cartographer writes here: how business processes work in this org, in plain language, with links to the fact notes that prove each statement. A statement without a link to a fact is not allowed.\n`);
  const total = changes.added.length + changes.changed.length + changes.removed.length;
  if (total) appendLine(path.join(L.vault, 'log.md'), `- ${today()} Brain of **${orgName}**: ${changes.added.length} added, ${changes.changed.length} changed, ${changes.removed.length} removed${total <= 12 ? ` (${[...changes.added, ...changes.changed, ...changes.removed].map((r) => parseRef(r).name).join(', ')})` : ''}`);
  return { org: orgName, components: comps.size, by_type: counts, ...changes, objects_with_automation: withAutomation.length };
}

/** Is the Brain present and does it still match the source files? */
export function brainStatus(root, cfg, orgName) {
  const index = readJson(path.join(layout(root).orgVault(orgName), '_index.json'), null);
  if (!index) return { org: orgName, exists: false };
  const dir = path.join(root, index.source);
  const stale = [];
  if (exists(dir)) {
    const now = scanSource(root, dir);
    for (const [ref, c] of Object.entries(index.components)) if (!now.has(ref) || now.get(ref).sha256 !== c.sha256) stale.push(ref);
    for (const ref of now.keys()) if (!index.components[ref]) stale.push(ref);
  }
  return { org: orgName, exists: true, built_at: index.built_at, components: Object.keys(index.components).length, stale };
}

/** One fact with a freshness check, for use as evidence. */
export function brainFact(root, cfg, orgName, ref) {
  const index = readJson(path.join(layout(root).orgVault(orgName), '_index.json'), null) || fail(`No Org Brain for "${orgName}".`, 'NO_BRAIN');
  const c = index.components[ref] || fail(`${ref} is not in the Org Brain of "${orgName}". Check the exact API name.`, 'NOT_IN_BRAIN');
  const now = scanSource(root, path.join(root, index.source)).get(ref);
  const fresh = Boolean(now) && now.sha256 === c.sha256;
  return { org: orgName, ref, fresh, built_at: index.built_at, ...c };
}

/** Search the index by words (API names, labels, objects). */
export function search(root, cfg, orgName, terms) {
  const index = readJson(path.join(layout(root).orgVault(orgName), '_index.json'), null) || fail(`No Org Brain for "${orgName}".`, 'NO_BRAIN');
  const words = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 2);
  const hits = [];
  for (const [ref, c] of Object.entries(index.components)) {
    const hay = `${c.name} ${c.facts.label || ''} ${c.object || ''}`.toLowerCase();
    const score = words.reduce((n, w) => n + (hay.includes(w) ? (c.name.toLowerCase() === w ? 3 : 1) : 0), 0);
    if (score) hits.push({ ref, score, type: c.type, object: c.object, path: c.path, note: c.note });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 60);
}

/** Write the context pack of a ticket: the slice of the Brain it needs. */
export function contextPack(root, cfg, key, { terms = [], refs = [] } = {}) {
  const orgName = exists(path.join(layout(root).orgVault(cfg.pipeline.build_org), '_index.json')) ? cfg.pipeline.build_org : cfg.pipeline.brain_base;
  const index = readJson(path.join(layout(root).orgVault(orgName), '_index.json'), null) || fail(`No Org Brain yet. Build it first: orgtomo brain build ${cfg.pipeline.brain_base}`, 'NO_BRAIN');
  const seeds = uniq([...refs.filter((r) => index.components[r]), ...search(root, cfg, orgName, terms).slice(0, 15).map((h) => h.ref)]);
  const ring = uniq(seeds.flatMap((r) => [...index.components[r].deps, ...index.components[r].used_by])).filter((r) => !seeds.includes(r)).slice(0, 40);
  const objects = uniq([...seeds, ...ring].map((r) => index.components[r]?.object).filter(Boolean));
  const line = (r) => { const c = index.components[r]; const f = c.facts; const bits = [f.trigger_type, f.field_type, f.sharing, f.status, f.active && `active ${f.active}`, f.events?.join('/')].filter(Boolean); return `- ${link(orgName, r)} \`${r}\`${bits.length ? ` (${bits.join(', ')})` : ''}  \n  source: \`${c.path}\``; };
  const dir = layout(root).ticketDir(key);
  const agents = Object.keys(cfg.agents.agents);
  const lessonCount = agents.reduce((n, a) => n + lessonsFor(root, a).length, 0);
  writeText(path.join(dir, 'context-pack.md'), `${formatFrontmatter({ type: 'context-pack', ticket: key, org: orgName, brain_built: index.built_at, at: nowIso() })}# Context pack for ${key}\n\nFrom the Org Brain of **${orgName}** (built ${index.built_at.slice(0, 10)}). This is a starting map, not proof: cite a fact only after \`orgtomo evidence brain ${key} <Type:Name>\` confirms it is fresh, or after checking the org.\n\n## Components that match the ticket\n\n${seeds.map(line).join('\n') || '_No match by name. Search with: orgtomo brain search <words>_'}\n\n## One step away (used by, or using, the above)\n\n${ring.map(line).join('\n') || '_None._'}\n\n## Everything that runs on the objects involved\n\n${objects.filter((o) => (index.objects_with_automation || []).includes(o)).map((o) => `- [[orgs/${orgName}/facts/_automation/${o}|What runs on ${o}]]`).join('\n') || '_No automation recorded on these objects._'}\n\n## Also read\n\n${exists(path.join(dir, 'updates.md')) ? `- [[tickets/${key}/updates]] (meeting decisions, human answers, loop reasons)\n` : ''}- Your lessons skill (${lessonCount} approved lesson(s) across the team)\n`);
  return { ticket: key, org: orgName, matched: seeds.length, nearby: ring.length, file: `vault/tickets/${key}/context-pack.md` };
}

/** Compare the Brain of two orgs. */
export function drift(root, cfg, baseName, otherName) {
  const a = readJson(path.join(layout(root).orgVault(baseName), '_index.json'), null) || fail(`No Org Brain for "${baseName}".`, 'NO_BRAIN');
  const b = readJson(path.join(layout(root).orgVault(otherName), '_index.json'), null) || fail(`No Org Brain for "${otherName}". Retrieve and build it first.`, 'NO_BRAIN');
  const onlyBase = Object.keys(a.components).filter((r) => !b.components[r]);
  const onlyOther = Object.keys(b.components).filter((r) => !a.components[r]);
  const different = Object.keys(a.components).filter((r) => b.components[r] && b.components[r].sha256 !== a.components[r].sha256);
  const list = (refs) => refs.slice(0, 300).map((r) => `- \`${r}\``).join('\n') || '_None._';
  writeText(path.join(layout(root).orgVault(otherName), `drift-vs-${baseName}.md`), `${formatFrontmatter({ type: 'drift', base: baseName, org: otherName, at: nowIso(), different: different.length, only_base: onlyBase.length, only_other: onlyOther.length })}# Drift: ${otherName} compared with ${baseName}\n\nA difference is not automatically a problem: work in progress lives in ${baseName} first. Differences that nobody can explain are the ones to look at.\n\n## Different content (${different.length})\n\n${list(different)}\n\n## Only in ${baseName} (${onlyBase.length})\n\n${list(onlyBase)}\n\n## Only in ${otherName} (${onlyOther.length})\n\n${list(onlyOther)}\n`);
  return { base: baseName, org: otherName, different: different.length, only_base: onlyBase.length, only_other: onlyOther.length, file: `vault/orgs/${otherName}/drift-vs-${baseName}.md` };
}

/** Create the vault skeleton (safe to run again). */
export function initVault(root, cfg) {
  const v = layout(root).vault;
  const put = (f, text) => { if (!exists(path.join(v, f))) writeText(path.join(v, f), text); };
  put('Home.md', `# ${cfg.orgs.company || 'Company'}: Orgtomo vault\n\nOpen this folder as a vault in Obsidian.\n\n- **Orgs**: ${Object.keys(cfg.orgs.orgs || {}).map((o) => `[[orgs/${o}/Overview|${o}]]`).join(', ')}\n- **Tickets**: [[Tickets.base]]\n- **Learning**: [[learning/Lessons|Lessons]]\n- **People**: [[people/People|People]]\n- **Meetings**: folder \`meetings/\`\n- **Log**: [[log]]\n\nFact notes are generated from metadata and are overwritten on every sync. Write your own notes anywhere outside \`orgs/*/facts\`.\n`);
  put('log.md', '# Log\n\nWhat changed in the Org Brain, newest at the bottom.\n\n');
  put('Tickets.base', 'filters:\n  and:\n    - file.inFolder("tickets")\n    - \'type == "ticket-status"\'\nviews:\n  - type: table\n    name: "Tickets"\n    order:\n      - note.ticket\n      - note.title\n      - note.status\n      - note.stage\n      - note.waiting_for\n      - note.loops\n      - note.updated\n');
  put('learning/Lessons.md', '# Lessons\n\n_No lessons yet._\n');
  put('people/People.md', '# People\n\n_No profiles yet. The feature is switched on in features.yaml._\n');
  put('meetings/inbox/README.md', '# Meeting inbox\n\nDrop exported notes or transcripts here (Markdown or text) when your meeting tool has no connector. The Notetaker reads them on the next run.\n');
  put('decisions/README.md', '# Decisions\n\nYour own architecture and process decisions. Agents read this folder; they do not write here.\n');
  return { vault: rel(root, v) };
}

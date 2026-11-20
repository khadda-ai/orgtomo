// Org Brain: a map of an org, generated from its metadata and stored as an
// Obsidian vault. Facts are generated, never hand-written, and each fact note
// carries the hash of the source it came from, so staleness can be detected.
//
//   vault/orgs/<org>/facts/<Type>/<Name>.md     one note per component
//   vault/orgs/<org>/facts/_automation/<Object>.md   everything that runs on an object
//   vault/orgs/<org>/maps/<Object>.canvas       the same as a JSON Canvas map
//   vault/orgs/<org>/objects/<Object>.md        hub: one page per object that links everything about it
//   vault/orgs/<org>/_index.json                machine index (components, hashes, links)
//   vault/orgs/<org>/understanding/             notes written by the Cartographer
import fs from 'node:fs';
import path from 'node:path';
import { layout, rel } from './paths.js';
import { org as getOrg } from './config.js';
import { refFromPath, parseRef } from './metadata.js';
import { parseXml, kids, val, findAll } from './xml.js';
import { lessonsFor } from './learning.js';
import { redactInside } from './mask.js';
import { exists, readText, writeText, readJson, writeJson, listFiles, sha256, sha256File, nowIso, today, appendLine, formatFrontmatter, parseFrontmatter, uniq, fail, SOURCE_IGNORE } from './util.js';

const noteRel = (orgName, ref) => { const { type, name } = parseRef(ref); return `orgs/${orgName}/facts/${type}/${name.replace(/\//g, '_')}`; };
const link = (orgName, ref) => `[[${noteRel(orgName, ref)}|${parseRef(ref).name}]]`;

// ------------------------------------------------------------------ parsing

/** Read every known component under a source folder. */
export function scanSource(root, sourceDir) {
  const files = listFiles(sourceDir, { ignore: SOURCE_IGNORE });
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

/** Types read with the generic reader: process, access and app metadata. */
const GENERIC_TYPES = new Set(['ApprovalProcess', 'AssignmentRules', 'AutoResponseRules', 'EscalationRules', 'Workflow', 'PathAssistant', 'Queue', 'Group', 'Role', 'PermissionSetGroup',
  'QuickAction', 'FlexiPage', 'Layout', 'CustomApplication', 'CustomTab', 'CustomMetadata', 'NamedCredential', 'InstalledPackage', 'DuplicateRule', 'EntitlementProcess', 'ConnectedApp']);
/** Types whose file is named after the object they belong to. */
const NAMED_AFTER_OBJECT = new Set(['AssignmentRules', 'AutoResponseRules', 'EscalationRules', 'Workflow']);
/** Process metadata listed on the automation note of its object, without a claim about order. */
const PROCESS_TYPES = ['ApprovalProcess', 'AssignmentRules', 'AutoResponseRules', 'EscalationRules', 'Workflow', 'PathAssistant', 'DuplicateRule', 'EntitlementProcess'];
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Facts from any metadata file without knowing its schema: single text
 * children become values, repeated text children become lists, and repeated
 * structured children are counted. Nothing here depends on an element name.
 */
function genericFacts(x, safety) {
  const facts = {};
  const groups = new Map();
  for (const ch of x.children) groups.set(ch.name, [...(groups.get(ch.name) || []), ch]);
  const parts = {};
  const clean = (t) => (safety ? redactInside(t, safety) : t);
  for (const [name, list] of groups) {
    const leaf = list.every((n) => !n.children.length);
    if (leaf && list.length === 1) { if (list[0].text && list[0].text.length <= 300) facts[snake(name)] = clean(list[0].text); }
    else if (leaf) facts[snake(name)] = list.map((n) => clean(n.text)).filter(Boolean).slice(0, 60);
    else parts[name] = list.length;
  }
  if (Object.keys(parts).length) facts.parts = parts;
  return facts;
}

function parseComponent(sourceDir, c, known, { safety, standardObjects = [] } = {}) {
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
  else if (GENERIC_TYPES.has(c.type)) {
    const text = read(sourceDir, c, (f) => f.endsWith('-meta.xml'));
    if (text) Object.assign(facts, genericFacts(parseXml(text), safety));
    // Which object this belongs to: said by the file itself, or by how Salesforce names the file.
    // Custom metadata records are named "Type.Record"; the part before the dot is not an object.
    const cand = c.type === 'CustomMetadata' ? null : facts.entity_name || facts.sobject_type || facts.target_object
      || (NAMED_AFTER_OBJECT.has(c.type) ? c.name : c.type === 'Layout' ? c.name.split('-')[0] : c.name.includes('.') ? c.name.split('.')[0] : null);
    const looksLikeObject = typeof cand === 'string' && (known.has(`CustomObject:${cand}`) || standardObjects.includes(cand) || /__(c|mdt|e|b|x)$/.test(cand) || /^[A-Z][A-Za-z0-9]+$/.test(cand));
    if (looksLikeObject) { facts.object = cand; addObj(cand); }
    else delete facts.object;
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
  return `${fm}# ${c.name}\n\n> Generated from metadata by Orgtomo. Do not edit: the next sync overwrites it. Interpretation belongs in \`understanding/\`.\n\n| Fact | Value |\n|---|---|\n| Type | ${c.type} |\n${scalar.map(([k, v]) => `| ${k.replace(/_/g, ' ')} | ${String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n')}\n${lists.map(([k, v]) => `\n**${k.replace(/_/g, ' ')}:** ${Array.isArray(v) ? v.join(', ') : Object.entries(v).map(([a, b]) => `${a} ${b}`).join(', ')}`).join('\n')}\n\n## Uses\n\n${c.deps.map((d) => `- ${link(orgName, d)} (${parseRef(d).type})`).join('\n') || '_Nothing found by static analysis._'}\n\n## Used by\n\n${usedBy.map((d) => `- ${link(orgName, d)} (${parseRef(d).type})`).join('\n') || '_Nothing found by static analysis._'}\n`;
}

function automationNote(orgName, object, comps, extras = []) {
  const also = extras.length
    ? `\n\n## Also configured on this object\n\nProcess metadata that takes part in what happens to a record. It is listed here without a claim about order.\n\n${extras.sort((a, b) => a.ref.localeCompare(b.ref)).map((c) => `- ${link(orgName, c.ref)} (${c.type})${c.facts.active ? `, active: ${c.facts.active}` : ''}`).join('\n')}`
    : '';
  const sections = AUTOMATION_GROUPS.map(([title, test]) => {
    const list = comps.filter(test).sort((a, b) => Number(a.facts.trigger_order || 9999) - Number(b.facts.trigger_order || 9999) || a.name.localeCompare(b.name));
    return `## ${title}\n\n${list.map((c) => `- ${link(orgName, c.ref)}${c.facts.status ? ` (${c.facts.status})` : ''}${c.facts.active ? ` (active: ${c.facts.active})` : ''}${c.facts.trigger_order ? `, trigger order ${c.facts.trigger_order}` : ''}${c.facts.events ? `: ${c.facts.events.join(', ')}` : ''}`).join('\n') || '_None._'}`;
  });
  return `${formatFrontmatter({ type: 'automation-map', object, org: orgName, tags: ['orgtomo/fact'] })}# What runs on ${object}\n\n> Generated. The groups follow the order Salesforce documents for a record save (Apex Developer Guide, "Triggers and Order of Execution"). Inside a group the order is not guaranteed unless a flow trigger order is set. Workflow rules, processes, assignment and escalation rules are not listed here unless they were retrieved.\n\n${sections.join('\n\n')}${also}\n`;
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
  const standardObjects = cfg.pipeline.brain?.standard_objects || [];
  for (const c of comps.values()) Object.assign(c, parseComponent(dir, c, known, { safety: cfg.safety, standardObjects }));
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
  // An object is part of the map when something of substance sits on it. A page layout or a list view alone
  // does not make it one: every standard object has those, used or not.
  const THIN = new Set(['Layout', 'FlexiPage', 'QuickAction', 'ListView', 'CompactLayout', 'WebLink', 'FieldSet', 'CustomTab']);
  const objects = uniq([...comps.values()].flatMap((c) => (c.type === 'CustomObject' ? [c.name] : c.facts.object && !THIN.has(c.type) ? [c.facts.object] : []))).sort();
  const withAutomation = [];
  for (const o of objects) {
    const list = [...comps.values()].filter((c) => c.facts.object === o && ['Flow', 'ApexTrigger', 'ValidationRule'].includes(c.type));
    const extras = [...comps.values()].filter((c) => c.facts.object === o && PROCESS_TYPES.includes(c.type));
    if (!list.length && !extras.length) continue;
    withAutomation.push(o);
    writeText(path.join(orgDir, 'facts', '_automation', `${o}.md`), automationNote(orgName, o, list, extras));
    writeText(path.join(orgDir, 'maps', `${o}.canvas`), automationCanvas(orgName, o, list, comps));
  }
  index.objects_with_automation = withAutomation;
  index.objects = objects;
  writeJson(path.join(orgDir, '_index.json'), index);
  writeHubs(root, orgName, index);

  const counts = {};
  for (const c of comps.values()) counts[c.type] = (counts[c.type] || 0) + 1;
  writeText(path.join(orgDir, 'Overview.md'), `${formatFrontmatter({ type: 'org-overview', org: orgName, role: getOrg(cfg, orgName).role, built: index.built_at, components: comps.size })}# ${orgName}: overview\n\nGenerated ${index.built_at.slice(0, 16).replace('T', ' ')} from \`${index.source}\`.\n\n| Type | Count |\n|---|---|\n${Object.entries(counts).sort().map(([t, n]) => `| ${t} | ${n} |`).join('\n')}\n\n## Objects\n\nOne hub page per object links its fields, automation, tests, tickets and notes. ${objects.length} object(s): ${objects.slice(0, 80).map((o) => `[[orgs/${orgName}/objects/${o}|${o}]]`).join(', ')}${objects.length > 80 ? ', ...' : ''}\n\n## Objects with automation\n\n${withAutomation.map((o) => `- [[orgs/${orgName}/facts/_automation/${o}|${o}]] ([[orgs/${orgName}/maps/${o}.canvas|map]])`).join('\n') || '_None found._'}\n\n## Understanding\n\nNotes written by the Cartographer live in [[orgs/${orgName}/understanding/README|understanding]]. They explain; the fact notes prove.\n`);
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

const STOP_WORDS = new Set(['this', 'that', 'with', 'from', 'when', 'then', 'than', 'have', 'does', 'should', 'would', 'could', 'into', 'also', 'only', 'each', 'some', 'such', 'very', 'just',
  'been', 'were', 'they', 'them', 'their', 'there', 'which', 'while', 'where', 'what', 'will', 'must', 'need', 'needs', 'make', 'made', 'using', 'used', 'after', 'before', 'about', 'again', 'still']);

/** Names in free text that look like API names (they contain an underscore): Escalation_Reason__c, Case_AfterSave_Notify_Owner, Require_Reason. */
export const apiNames = (text) => uniq(String(text || '').match(/\b[A-Za-z][A-Za-z0-9]*(?:_+[A-Za-z0-9]+)+\b/g) || []);

/**
 * Search terms for a ticket: API names written anywhere in the ticket first,
 * then the meaningful words of the title.
 */
export function packTerms(ticket, extra = []) {
  const text = `${ticket.title || ''}\n${ticket.description || ''}\n${(ticket.acceptance_criteria || []).map((a) => a.text).join('\n')}`;
  const words = String(ticket.title || '').split(/[^A-Za-z0-9_]+/).filter((w) => w.length > 3 && !STOP_WORDS.has(w.toLowerCase()));
  return uniq([...extra, ...apiNames(text), ...words]);
}

/**
 * Search the index by words (API names, labels, objects).
 * An exact API name always ranks first. That includes the part after the dot:
 * a field, validation rule or record type is stored as "Object.Name", and
 * tickets name it without the object. Other words count by how rare they are
 * in this org: a word that matches one component says more than a word that
 * matches fifty. Every hit says why it matched.
 */
export function search(root, cfg, orgName, terms, { limit = 60 } = {}) {
  const index = readJson(path.join(layout(root).orgVault(orgName), '_index.json'), null) || fail(`No Org Brain for "${orgName}".`, 'NO_BRAIN');
  const words = uniq(terms.map((t) => String(t).toLowerCase()).filter((t) => t.length > 2));
  const entries = Object.entries(index.components).map(([ref, c]) => ({ ref, c, name: c.name.toLowerCase(), leaf: c.name.split('.').pop().toLowerCase(), hay: `${c.name} ${c.facts.label || ''} ${c.object || ''}`.toLowerCase() }));
  const total = entries.length || 1;
  const frequency = new Map(words.map((w) => [w, entries.reduce((n, e) => n + (e.hay.includes(w) ? 1 : 0), 0)]));
  const hits = [];
  for (const e of entries) {
    let score = 0;
    const why = [];
    for (const w of words) {
      if (!e.hay.includes(w)) continue;
      const exact = e.name === w || e.leaf === w;
      const rarity = Math.log(1 + total / frequency.get(w));
      score += exact ? 20 + rarity : rarity;
      why.push(exact ? `exact name "${w}"` : `"${w}"`);
    }
    if (score) hits.push({ ref: e.ref, score: Math.round(score * 100) / 100, exact: why.some((w) => w.startsWith('exact')), why, type: e.c.type, object: e.c.object, path: e.c.path, note: e.c.note });
  }
  return hits.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref)).slice(0, limit);
}

/**
 * Existing Apex test classes that exercise the given components.
 * For a class: its own tests. For anything that belongs to an object (a flow,
 * a validation rule, a field, a trigger): every test class that queries the
 * object, depends on it, or is named after it.
 */
export function testsFor(root, cfg, orgName, refs) {
  const index = readJson(path.join(layout(root).orgVault(orgName), '_index.json'), null) || fail(`No Org Brain for "${orgName}".`, 'NO_BRAIN');
  const comps = index.components;
  const tests = Object.values(comps).filter((c) => c.type === 'ApexClass' && c.facts.is_test);
  const by = {};
  for (const ref of refs) {
    const c = comps[ref];
    const { type, name } = parseRef(ref);
    const names = new Set();
    if (type === 'ApexClass') {
      for (const u of c?.used_by || []) if (comps[u]?.facts?.is_test) names.add(comps[u].name);
      if (comps[`ApexClass:${name}Test`]) names.add(`${name}Test`);
    } else {
      const object = c?.object || (type === 'CustomObject' ? name : name.includes('.') ? name.split('.')[0] : null);
      if (object) {
        const stem = object.replace(/__c$/, '').toLowerCase();
        for (const t of tests) if ((t.facts.soql_objects || []).includes(object) || (t.deps || []).includes(`CustomObject:${object}`) || t.name.toLowerCase().startsWith(stem)) names.add(t.name);
      }
    }
    by[ref] = [...names].sort();
  }
  return { org: orgName, tests: uniq(Object.values(by).flat()).sort(), by_component: by };
}

/** Org whose Brain a ticket works from: the build org when it has one, else the base. */
export const packOrg = (root, cfg) => (exists(path.join(layout(root).orgVault(cfg.pipeline.build_org), '_index.json')) ? cfg.pipeline.build_org : cfg.pipeline.brain_base);

/** Write the context pack of a ticket: the slice of the Brain it needs. */
export function contextPack(root, cfg, key, { terms = [], refs = [] } = {}) {
  const orgName = packOrg(root, cfg);
  const index = readJson(path.join(layout(root).orgVault(orgName), '_index.json'), null) || fail(`No Org Brain yet. Build it first: orgtomo brain build ${cfg.pipeline.brain_base}`, 'NO_BRAIN');
  const found = search(root, cfg, orgName, terms);
  const why = new Map(found.map((h) => [h.ref, h.why.join(', ')]));
  const named = refs.filter((r) => index.components[r]);
  for (const r of named) why.set(r, 'named by the Analyst');
  // Components the Analyst named and exact API names always make the pack; the rest fills up to 15 by rank.
  const seeds = uniq([...named, ...found.filter((h) => h.exact).map((h) => h.ref), ...found.slice(0, 15).map((h) => h.ref)]).slice(0, 40);
  const ring = uniq(seeds.flatMap((r) => [...index.components[r].deps, ...index.components[r].used_by])).filter((r) => !seeds.includes(r)).slice(0, 40);
  const objects = uniq([...seeds, ...ring].map((r) => index.components[r]?.object).filter(Boolean));
  const line = (r, reason) => { const c = index.components[r]; const f = c.facts; const bits = [f.trigger_type, f.field_type, f.sharing, f.status, f.active && `active ${f.active}`, f.events?.join('/')].filter(Boolean); return `- ${link(orgName, r)} \`${r}\`${bits.length ? ` (${bits.join(', ')})` : ''}${reason ? `  \n  matched: ${reason}` : ''}  \n  source: \`${c.path}\``; };
  const dir = layout(root).ticketDir(key);
  const agents = Object.keys(cfg.agents.agents);
  const lessonCount = agents.reduce((n, a) => n + lessonsFor(root, a).length, 0);
  const orgDir = layout(root).orgVault(orgName);
  const hubs = objects.filter((o) => exists(path.join(orgDir, 'objects', `${o}.md`))).map((o) => `- [[orgs/${orgName}/objects/${o}|${o}: everything about this object]]`);
  const processes = exists(path.join(orgDir, 'business', 'processes')) ? listFiles(path.join(orgDir, 'business', 'processes')).filter((f) => f.endsWith('.md')).map((f) => `- [[orgs/${orgName}/business/processes/${f.replace(/\.md$/, '')}]]`) : [];
  writeText(path.join(dir, 'context-pack.md'), `${formatFrontmatter({ type: 'context-pack', ticket: key, org: orgName, brain_built: index.built_at, at: nowIso() })}# Context pack for ${key}\n\nFrom the Org Brain of **${orgName}** (built ${index.built_at.slice(0, 10)}). This is a starting map, not proof: cite a fact only after \`orgtomo evidence brain ${key} <Type:Name>\` confirms it is fresh, or after checking the org.\n\n## Components that match the ticket\n\n${seeds.map((r) => line(r, why.get(r))).join('\n') || '_No match by name. Search with: orgtomo brain search <words>_'}\n\n## One step away (used by, or using, the above)\n\n${ring.map((r) => line(r)).join('\n') || '_None._'}\n\n## Everything that runs on the objects involved\n\n${objects.filter((o) => (index.objects_with_automation || []).includes(o)).map((o) => `- [[orgs/${orgName}/facts/_automation/${o}|What runs on ${o}]]`).join('\n') || '_No automation recorded on these objects._'}\n\n## The objects involved\n\n${hubs.join('\n') || '_No hub pages yet. They appear after the next Brain build._'}\n${processes.length ? `\n## How the business uses this org\n\n${processes.join('\n')}\n` : ''}\n## Also read\n\n${exists(path.join(dir, 'updates.md')) ? `- [[tickets/${key}/updates]] (meeting decisions, human answers, loop reasons)\n` : ''}- Your lessons skill (${lessonCount} approved lesson(s) across the team)\n`);
  return { ticket: key, org: orgName, matched: seeds.length, nearby: ring.length, file: `vault/tickets/${key}/context-pack.md` };
}

/** One object with everything the index knows about it (for the control panel and the hub page). */
export function objectView(root, cfg, orgName, object) {
  const index = readJson(path.join(layout(root).orgVault(orgName), '_index.json'), null) || fail(`No Org Brain for "${orgName}".`, 'NO_BRAIN');
  const all = Object.entries(index.components).filter(([, c]) => c.object === object || (c.type === 'CustomObject' && c.name === object)).map(([ref, c]) => ({ ref, ...c }));
  const byType = {};
  for (const c of all) (byType[c.type] ||= []).push({ ref: c.ref, name: c.name, status: c.facts.status, active: c.facts.active, trigger_type: c.facts.trigger_type, field_type: c.facts.field_type });
  const tests = testsFor(root, cfg, orgName, [`CustomObject:${object}`]).tests;
  return { org: orgName, object, counts: Object.fromEntries(Object.entries(byType).map(([t, l]) => [t, l.length])), components: byType, tests, tickets: ticketsTouching(root, index, object), has_automation: (index.objects_with_automation || []).includes(object) };
}

/** Tickets whose understanding or build names a component of this object. */
function ticketsTouching(root, index, object) {
  const dir = layout(root).tickets;
  if (!exists(dir)) return [];
  const out = [];
  for (const key of fs.readdirSync(dir)) {
    const refs = [];
    for (const [file, pick] of [['01-understanding.json', (j) => (j.affected || []).map((a) => a.component)], ['04-build.json', (j) => (j.components || []).map((c) => c.ref)]]) {
      const f = path.join(dir, key, file);
      if (exists(f)) { try { refs.push(...pick(JSON.parse(readText(f)))); } catch { /* unfinished file */ } }
    }
    if (refs.some((r) => index.components[r]?.object === object || r === `CustomObject:${object}`)) out.push(key);
  }
  return out.sort();
}

/** One hub page per object: the place a person or an agent starts from. */
function writeHubs(root, orgName, index) {
  const L = layout(root);
  const orgDir = L.orgVault(orgName);
  const notes = exists(path.join(orgDir, 'understanding')) ? listFiles(path.join(orgDir, 'understanding')).filter((f) => f.endsWith('.md') && f !== 'README.md') : [];
  const covers = notes.map((f) => ({ f, covers: [].concat(parseFrontmatter(readText(path.join(orgDir, 'understanding', f))).data.covers || []) }));
  const tests = Object.values(index.components).filter((c) => c.type === 'ApexClass' && c.facts.is_test);
  // hub pages of objects that are no longer part of the map go away with them
  const hubDir = path.join(orgDir, 'objects');
  if (exists(hubDir)) for (const f of fs.readdirSync(hubDir)) if (f.endsWith('.md') && !(index.objects || []).includes(f.slice(0, -3))) fs.rmSync(path.join(hubDir, f), { force: true });
  for (const o of index.objects || []) {
    const mine = Object.values(index.components).filter((c) => c.object === o);
    const counts = {};
    for (const c of mine) counts[c.type] = (counts[c.type] || 0) + 1;
    const stem = o.replace(/__c$/, '').toLowerCase();
    const myTests = tests.filter((t) => (t.facts.soql_objects || []).includes(o) || (t.deps || []).includes(`CustomObject:${o}`) || t.name.toLowerCase().startsWith(stem)).map((t) => t.name).sort();
    const touching = ticketsTouching(root, index, o);
    const about = covers.filter((n) => n.covers.includes(o)).map((n) => `- [[orgs/${orgName}/understanding/${n.f.replace(/\.md$/, '')}]]`);
    const start = [
      index.components[`CustomObject:${o}`] ? `- ${link(orgName, `CustomObject:${o}`)}: the object itself` : null,
      (index.objects_with_automation || []).includes(o) ? `- [[orgs/${orgName}/facts/_automation/${o}|What runs when a record is saved]] ([[orgs/${orgName}/maps/${o}.canvas|as a map]])` : null,
    ].filter(Boolean);
    writeText(path.join(orgDir, 'objects', `${o}.md`), `${formatFrontmatter({ type: 'object-hub', object: o, org: orgName, components: mine.length, tags: ['orgtomo/hub'] })}# ${o}\n\n> Generated. One page per object: start here. The next Brain build overwrites it; write your own notes in \`understanding/\`.\n\n| What | Count |\n|---|---|\n${Object.entries(counts).sort().map(([t, n]) => `| ${t} | ${n} |`).join('\n') || '| (nothing parsed) | 0 |'}\n\n## Start here\n\n${start.join('\n') || '_No object file and no automation were retrieved for this object._'}\n\n## Everything on this object\n\n\`\`\`base\nfilters:\n  and:\n    - file.inFolder("orgs/${orgName}/facts")\n    - 'object == "${o}"'\nviews:\n  - type: table\n    name: "On ${o}"\n    groupBy:\n      property: note.type\n      direction: ASC\n    order:\n      - file.name\n      - note.type\n      - note.source\n\`\`\`\n\n## Tests that touch it (${myTests.length})\n\n${myTests.slice(0, 80).map((t) => `- ${index.components[`ApexClass:${t}`] ? link(orgName, `ApexClass:${t}`) : t}`).join('\n') || '_None found by static analysis._'}\n\n## Tickets that touched it\n\n${touching.map((k) => `- [[tickets/${k}/status|${k}]]`).join('\n') || '_None yet._'}\n\n## What we understand about it\n\n${about.join('\n') || '_No understanding note covers this object yet._'}\n`);
  }
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

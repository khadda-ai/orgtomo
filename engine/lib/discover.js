// Business discovery: what does this company use the org for?
//
// The engine does the part that needs no judgement: it reads the Org Brain,
// groups the objects into domains, describes each object's life cycle and
// automation, and writes down the questions that only a person can answer.
// The Cartographer then writes one process note per domain, where every
// statement links to a fact or is marked as inferred or as a question.
//
// Metadata shows what the system does. It does not show why the business
// wants it that way. That is why the last step is always a person.
//
//   vault/orgs/<org>/business/Overview.md          generated
//   vault/orgs/<org>/business/domains/<slug>.md    generated, one per domain
//   vault/orgs/<org>/business/Questions.md         generated, answers added by the human
//   vault/orgs/<org>/business/processes/<slug>.md  written by the Cartographer
import path from 'node:path';
import { layout } from './paths.js';
import { org as getOrg } from './config.js';
import { redactInside } from './mask.js';
import { exists, readJson, writeJson, readText, writeText, nowIso, slug, uniq, fail, formatFrontmatter, parseFrontmatter } from './util.js';

const PROCESS_TYPES = ['ApprovalProcess', 'AssignmentRules', 'AutoResponseRules', 'EscalationRules', 'Workflow', 'PathAssistant', 'DuplicateRule', 'EntitlementProcess'];
/**
 * Standard objects that belong together, most specific area first. An object
 * that points to objects of several areas goes to the first one in this list,
 * so "Customers" (which almost everything points to) comes late on purpose.
 */
const SEEDS = {
  'Service': ['Case', 'Entitlement', 'ServiceContract', 'WorkOrder', 'Solution', 'Knowledge__kav'],
  'Sales': ['Lead', 'Opportunity', 'OpportunityLineItem', 'Quote', 'QuoteLineItem', 'Contract', 'Order', 'OrderItem'],
  'Products and pricing': ['Product2', 'Pricebook2', 'PricebookEntry'],
  'Marketing': ['Campaign', 'CampaignMember'],
  'Customers': ['Account', 'Contact'],
  'Activities': ['Task', 'Event'],
};

export const businessDir = (root, orgName) => path.join(layout(root).orgVault(orgName), 'business');
const stateFile = (root, orgName) => path.join(layout(root).state, 'discover', `${orgName}.json`);
export const discoverState = (root, orgName) => readJson(stateFile(root, orgName), null);

/** Metadata types a discovery run retrieves: the Brain's own types plus process, access and app metadata. */
export function discoverTypes(cfg) {
  const b = cfg.pipeline.brain || {};
  return uniq([...(b.types || []), ...(b.standard_objects || []).map((x) => `CustomObject:${x}`), ...(cfg.pipeline.discover?.types || [])]);
}

const link = (orgName, c) => `[[orgs/${orgName}/facts/${c.type}/${c.name.replace(/\//g, '_')}|${c.name}]]`;
const hub = (orgName, o) => `[[orgs/${orgName}/objects/${o}|${o}]]`;

function objectInfo(index, o, counts) {
  const mine = Object.values(index.components).filter((c) => c.object === o);
  const of = (type) => mine.filter((c) => c.type === type);
  const flows = of('Flow');
  const active = (c) => c.facts.status === 'Active' || c.facts.active === 'true';
  return {
    name: o,
    records: counts && o in counts ? counts[o] : null,
    record_types: of('RecordType').map((c) => ({ name: c.name.split('.').pop(), active: c.facts.active !== 'false' })),
    lifecycle: of('CustomField').filter((c) => c.facts.picklist_values && /status|stage|phase|state|step/i.test(c.name)).map((c) => ({ field: c.name.split('.').pop(), values: c.facts.picklist_values.slice(0, 15) })),
    flows: { active: flows.filter(active).map((c) => c.name), inactive: flows.filter((c) => !active(c)).map((c) => c.name), unordered_after_save: flows.filter((c) => active(c) && c.facts.trigger_type === 'RecordAfterSave' && !c.facts.trigger_order).map((c) => c.name) },
    triggers: of('ApexTrigger').map((c) => c.name),
    validation_rules: { active: of('ValidationRule').filter(active).length, inactive: of('ValidationRule').filter((c) => !active(c)).length },
    process: Object.fromEntries(PROCESS_TYPES.map((t) => [t, of(t).map((c) => c.name)]).filter(([, l]) => l.length)),
    fields: of('CustomField').length,
  };
}

/**
 * Put every object into exactly one area.
 * Apps are a weak signal here: one company often has many apps that show the
 * same objects, and one note per app would say the same thing many times. So
 * an object is placed by what it is (a known standard object, a package's
 * object) or by what it points to (its lookup fields); apps only break ties
 * for what is left, and are listed on the area's page for orientation.
 */
function domainsOf(index) {
  const objects = index.objects || [];
  const comps = Object.values(index.components);
  const place = new Map();
  for (const o of objects) {
    const ns = /^([A-Za-z0-9]+)__\w+__(c|mdt|e|b|x)$/.exec(o)?.[1];
    const seed = Object.entries(SEEDS).find(([, list]) => list.includes(o))?.[0];
    if (ns) place.set(o, `Package ${ns}`); else if (seed) place.set(o, seed);
  }
  const pointsTo = new Map();
  for (const c of comps) if (c.type === 'CustomField' && c.object && typeof c.facts.reference_to === 'string') pointsTo.set(c.object, [...(pointsTo.get(c.object) || []), c.facts.reference_to]);
  const rank = (area) => { const i = Object.keys(SEEDS).indexOf(area); return i < 0 ? 50 : i; };
  for (let pass = 0; pass < 3; pass++) {
    for (const o of objects) {
      if (place.has(o)) continue;
      const areas = (pointsTo.get(o) || []).map((t) => place.get(t)).filter(Boolean).sort((x, y) => rank(x) - rank(y));
      if (areas.length) place.set(o, areas[0]);
    }
  }
  const apps = comps.filter((c) => c.type === 'CustomApplication').map((app) => ({ name: app.facts.label || app.name, standard: app.name.startsWith('standard__'), objects: [].concat(app.facts.tabs || []).map((t) => String(t).replace(/^standard-/, '')).filter((o) => objects.includes(o)) }));
  for (const o of objects) {
    if (place.has(o)) continue;
    const own = apps.filter((x) => !x.standard && x.objects.length >= 2 && x.objects.includes(o)).sort((x, y) => x.objects.length - y.objects.length)[0];
    place.set(o, own ? own.name : /__mdt$/.test(o) ? 'Configuration records' : /__c$/.test(o) ? 'Other custom objects' : 'Other standard objects');
  }
  const areas = new Map();
  for (const [o, area] of place) areas.set(area, [...(areas.get(area) || []), o]);
  return [...areas.entries()].map(([name, list]) => ({
    name, slug: slug(name), objects: list.sort(),
    apps: apps.map((x) => ({ name: x.name, shared: x.objects.filter((o) => list.includes(o)).length })).filter((x) => x.shared).sort((x, y) => y.shared - x.shared).slice(0, 6).map((x) => x.name),
  })).sort((x, y) => y.objects.length - x.objects.length || x.name.localeCompare(y.name));
}

function questionsFor(domains, info, index, counts) {
  const q = [];
  const ask = (signature, text, why) => q.push({ signature, text, why });
  for (const d of domains.slice(0, 8)) ask(`purpose:${d.slug}`, `In one or two sentences: what does the business use "${d.name}" for, and which team owns it?`, `${d.objects.length} object(s): ${d.objects.slice(0, 6).join(', ')}${d.objects.length > 6 ? ', ...' : ''}`);
  for (const o of Object.values(info)) {
    const automation = o.flows.active.length + o.triggers.length + o.validation_rules.active;
    if (counts && o.records === 0 && automation > 0) ask(`unused:${o.name}`, `${o.name} has automation but the org reports no records. Is it still in use?`, `${o.flows.active.length} active flow(s), ${o.triggers.length} trigger(s), ${o.validation_rules.active} active validation rule(s), 0 records`);
  }
  for (const o of Object.values(info).filter((x) => x.flows.inactive.length).sort((a, b) => b.flows.inactive.length - a.flows.inactive.length).slice(0, 6)) {
    ask(`inactive-flows:${o.name}`, `${o.name} has ${o.flows.inactive.length} flow(s) that are not active. Are they retired, or waiting to be switched on?`, o.flows.inactive.slice(0, 6).join(', '));
  }
  for (const o of Object.values(info).filter((x) => x.flows.unordered_after_save.length > 1).slice(0, 6)) {
    ask(`order:${o.name}`, `${o.name} has ${o.flows.unordered_after_save.length} active after-save flows with no trigger order. Does the order between them matter to the business?`, o.flows.unordered_after_save.slice(0, 6).join(', '));
  }
  for (const p of Object.values(index.components).filter((c) => c.type === 'InstalledPackage').slice(0, 10)) ask(`package:${p.name}`, `What is the installed package "${p.name}" used for here?`, `InstalledPackage:${p.name}`);
  return q;
}

/**
 * Build the business skeleton of an org from its Brain. No AI, no org call.
 * @param {{counts?: Record<string, number>|null}} opts approximate record counts per object, when they were read
 */
export function runDiscovery(root, cfg, orgName, { counts = null } = {}) {
  getOrg(cfg, orgName);
  const index = readJson(path.join(layout(root).orgVault(orgName), '_index.json'), null) || fail(`No Org Brain for "${orgName}". Run: orgtomo discover run ${orgName} --retrieve`, 'NO_BRAIN');
  const before = discoverState(root, orgName) || { questions: [], domains: [] };
  const domains = domainsOf(index);
  const info = Object.fromEntries((index.objects || []).map((o) => [o, objectInfo(index, o, counts)]));
  const dir = businessDir(root, orgName);

  const old = new Map(before.questions.map((x) => [x.signature, x]));
  const questions = questionsFor(domains, info, index, counts).map((x, i) => {
    const kept = old.get(x.signature);
    return { id: kept?.id || `Q${i + 1}`, ...x, status: kept?.status || 'open', answer: kept?.answer || '', answered_at: kept?.answered_at || null };
  });
  // Ids stay stable for answered questions; new ones get the next free numbers.
  const used = new Set();
  let n = 0;
  for (const x of questions) { if (old.has(x.signature) && !used.has(x.id)) { used.add(x.id); continue; } do { n += 1; } while (used.has(`Q${n}`) || before.questions.some((b) => b.id === `Q${n}`)); x.id = `Q${n}`; used.add(x.id); }

  const prior = new Map(before.domains.map((d) => [d.slug, d]));
  const state = {
    org: orgName, built_at: nowIso(), brain_built: index.built_at, counted: Boolean(counts),
    domains: domains.map((d) => ({ ...d, note: `vault/orgs/${orgName}/business/processes/${d.slug}.md`, note_status: exists(path.join(dir, 'processes', `${d.slug}.md`)) ? prior.get(d.slug)?.note_status || 'draft' : 'missing', statements: prior.get(d.slug)?.statements || null })),
    questions,
  };
  writeJson(stateFile(root, orgName), state);

  const comps = Object.values(index.components);
  const names = (type) => comps.filter((c) => c.type === type).map((c) => c.name);
  const num = (v) => (v === null || v === undefined ? (counts ? 'none reported' : 'not counted') : String(v));
  for (const d of domains) {
    const rows = d.objects.map((o) => { const x = info[o]; return `| ${hub(orgName, o)} | ${num(x.records)} | ${x.fields} | ${x.record_types.map((r) => r.name).join(', ') || ''} | ${x.flows.active.length} active, ${x.flows.inactive.length} not active | ${x.triggers.length} | ${x.validation_rules.active} | ${Object.entries(x.process).map(([t, l]) => `${t} ${l.length}`).join(', ')} |`; });
    const life = d.objects.flatMap((o) => info[o].lifecycle.map((l) => `- **${o}.${l.field}**: ${l.values.join(' → ')}`));
    writeText(path.join(dir, 'domains', `${d.slug}.md`), `${formatFrontmatter({ type: 'business-domain', domain: d.name, org: orgName, objects: d.objects.length, tags: ['orgtomo/business'] })}# ${d.name}\n\n> Generated from the Org Brain. It lists what exists; it does not explain why. The process note explains: [[orgs/${orgName}/business/processes/${d.slug}|how ${d.name} works]].\n\n| Object | Records | Custom fields | Record types | Flows | Triggers | Active validation rules | Process metadata |\n|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n## Apps that show these objects\n\n${d.apps.length ? d.apps.join(', ') : '_None of the retrieved apps lists them._'}\n\n## Steps a record goes through\n\nPicklists whose name says status, stage, phase, state or step. The order is the order in the metadata; the real path between the values is for the process note to establish.\n\n${life.join('\n') || '_No such picklist found on these objects._'}\n`);
  }
  writeText(path.join(dir, 'Overview.md'), `${formatFrontmatter({ type: 'business-overview', org: orgName, built: state.built_at, domains: domains.length, tags: ['orgtomo/business'] })}# How ${cfg.orgs.company || 'this company'} uses ${orgName}\n\nGenerated ${state.built_at.slice(0, 16).replace('T', ' ')} from the Org Brain${counts ? ', with approximate record counts from the org' : ' (record counts were not read)'}.\n\nThis page and the domain pages state what exists. The **process notes** say how the business works, each statement linked to a fact. The **questions** are the part only a person can answer.\n\n## Domains\n\n| Domain | Objects | Process note |\n|---|---|---|\n${state.domains.map((d) => `| [[orgs/${orgName}/business/domains/${d.slug}|${d.name}]] | ${d.objects.length} | ${d.note_status === 'missing' ? 'not written yet' : `[[orgs/${orgName}/business/processes/${d.slug}|${d.note_status}]]`} |`).join('\n')}\n\n## Other systems this org talks to\n\n- Installed packages: ${names('InstalledPackage').join(', ') || 'none retrieved'}\n- Named credentials: ${names('NamedCredential').join(', ') || 'none retrieved'}\n- Connected apps: ${names('ConnectedApp').join(', ') || 'none retrieved'}\n\n## Who works in it\n\n- Roles: ${names('Role').length} · Queues: ${names('Queue').length} · Permission sets: ${names('PermissionSet').length} · Permission set groups: ${names('PermissionSetGroup').length}\n\n## Open questions\n\n${questions.filter((x) => x.status === 'open').length} open, ${questions.filter((x) => x.status === 'answered').length} answered: [[orgs/${orgName}/business/Questions|Questions]]\n`);
  renderQuestions(root, orgName, state);
  return { org: orgName, domains: state.domains.map((d) => ({ name: d.name, slug: d.slug, objects: d.objects.length, note_status: d.note_status })), questions: { open: questions.filter((x) => x.status === 'open').length, answered: questions.filter((x) => x.status === 'answered').length }, counted: state.counted, files: `vault/orgs/${orgName}/business/`, next: `orgtomo discover next ${orgName}` };
}

function renderQuestions(root, orgName, state) {
  const row = (x) => `### ${x.id} ${x.status === 'answered' ? '(answered)' : ''}\n\n${x.text}\n\n_Why this is asked:_ ${x.why}\n\n${x.status === 'answered' ? `**Answer** (${x.answered_at.slice(0, 10)}): ${x.answer}` : `Answer with: \`/orgtomo:discover answer ${orgName} ${x.id} <your answer>\``}\n`;
  writeText(path.join(businessDir(root, orgName), 'Questions.md'), `${formatFrontmatter({ type: 'business-questions', org: orgName, open: state.questions.filter((x) => x.status === 'open').length, tags: ['orgtomo/business'] })}# Questions about how ${orgName} is used\n\nMetadata shows what the system does. These are the things it cannot show. Your answers are stored here and given to the Cartographer.\n\n${state.questions.map(row).join('\n') || '_No questions._'}\n`);
}

/** Record the human's answer to a discovery question. */
export function answerQuestion(root, cfg, orgName, id, text) {
  const state = discoverState(root, orgName) || fail(`No discovery has been run for "${orgName}".`, 'NO_DISCOVERY');
  const q = state.questions.find((x) => x.id.toLowerCase() === String(id).toLowerCase()) || fail(`No question ${id}. Questions: ${state.questions.map((x) => x.id).join(', ')}`);
  if (!String(text || '').trim()) fail('The answer is empty.');
  q.answer = redactInside(String(text).trim(), cfg.safety);
  q.status = 'answered';
  q.answered_at = nowIso();
  writeJson(stateFile(root, orgName), state);
  renderQuestions(root, orgName, state);
  return { answered: q.id, open: state.questions.filter((x) => x.status === 'open').length };
}

/** The next domain that has no checked process note, with what the Cartographer needs to write it. */
export function nextDomain(root, cfg, orgName) {
  const state = discoverState(root, orgName) || fail(`No discovery has been run for "${orgName}". Run: orgtomo discover run ${orgName}`, 'NO_DISCOVERY');
  const d = state.domains.find((x) => x.note_status !== 'checked');
  if (!d) return { org: orgName, done: true, say: 'Every domain has a checked process note.' };
  return {
    org: orgName, domain: d.name, slug: d.slug, objects: d.objects,
    read: [`vault/orgs/${orgName}/business/domains/${d.slug}.md`, `vault/orgs/${orgName}/business/Questions.md`, ...d.objects.slice(0, 12).map((o) => `vault/orgs/${orgName}/objects/${o}.md`)],
    write: d.note,
    then: `orgtomo discover check ${orgName} ${d.slug}`,
    remaining: state.domains.filter((x) => x.note_status !== 'checked').length,
    say: `Write the process note for "${d.name}". One domain per run. Every statement links to a fact or hub note, or ends with (inferred) or (ask).`,
  };
}

/**
 * Check a process note: it must be about this domain and every statement must
 * either link to a fact or hub note of this org, or say openly that it is
 * inferred or still a question.
 */
export function checkProcessNote(root, cfg, orgName, domainSlug) {
  const state = discoverState(root, orgName) || fail(`No discovery has been run for "${orgName}".`, 'NO_DISCOVERY');
  const d = state.domains.find((x) => x.slug === domainSlug) || fail(`No domain "${domainSlug}". Domains: ${state.domains.map((x) => x.slug).join(', ')}`);
  const file = path.join(businessDir(root, orgName), 'processes', `${d.slug}.md`);
  if (!exists(file)) fail(`${d.note} does not exist yet.`, 'NOT_FOUND');
  const { data, body } = parseFrontmatter(readText(file));
  const problems = [];
  if (data.type !== 'process') problems.push('frontmatter: type must be "process"');
  if (data.domain !== d.name) problems.push(`frontmatter: domain must be "${d.name}"`);
  const statements = body.split('\n').filter((l) => /^\s*(-|\d+\.)\s+\S/.test(l));
  const linked = statements.filter((l) => l.includes(`[[orgs/${orgName}/facts/`) || l.includes(`[[orgs/${orgName}/objects/`));
  const marked = statements.filter((l) => !linked.includes(l) && /\((inferred|ask)\)\s*$/i.test(l.trim()));
  const bare = statements.filter((l) => !linked.includes(l) && !marked.includes(l));
  if (statements.length < 5) problems.push(`only ${statements.length} statement(s): a process note needs at least 5 list items that say what happens`);
  for (const l of bare.slice(0, 12)) problems.push(`no fact link and no (inferred) or (ask) mark: "${l.trim().slice(0, 90)}"`);
  if (bare.length > 12) problems.push(`and ${bare.length - 12} more statement(s) without a link or a mark`);
  d.statements = { total: statements.length, linked: linked.length, marked: marked.length };
  d.note_status = problems.length ? 'draft' : 'checked';
  d.checked_at = nowIso();
  writeJson(stateFile(root, orgName), state);
  return problems.length ? { ok: false, domain: d.name, problems, next: `Fix these in ${d.note} and check again.` } : { ok: true, domain: d.name, statements: d.statements, next: `orgtomo discover next ${orgName}` };
}

/** Status of every org that has a discovery, for the CLI and the control panel. */
export function discoverStatus(root, cfg, orgName) {
  const names = orgName ? [orgName] : Object.keys(cfg.orgs.orgs || {});
  return names.map((n) => {
    const s = discoverState(root, n);
    return s ? { org: n, built_at: s.built_at, counted: s.counted, domains: s.domains.map((d) => ({ name: d.name, slug: d.slug, objects: d.objects.length, note_status: d.note_status, statements: d.statements })), questions: s.questions.map(({ id, text, why, status, answer }) => ({ id, text, why, status, answer })) } : { org: n, built_at: null };
  });
}

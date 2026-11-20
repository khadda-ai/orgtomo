// Gate implementations. A gate receives the stage context and returns
// { ok, details[], needs_human? }. Gates never trust prose: they read the
// contract JSON, the evidence ledger, the source files and the Org Brain index.
import fs from 'node:fs';
import path from 'node:path';
import { validateContract } from './schema.js';
import { scanText, describeFindings } from './guards/data.js';
import { exists, readText, readJson, listFiles, sha256File, matchGlob } from './util.js';
import { parseRef, refFromPath } from './metadata.js';
import { parseXml, kids, val } from './xml.js';
import { buildOrg, isProduction, org as getOrg, loadSpec } from './config.js';
import { listObservations } from './learning.js';
import { layout } from './paths.js';

const pass = (details = []) => ({ ok: true, details });
const failG = (details, extra = {}) => ({ ok: false, details: [].concat(details), ...extra });

const HEDGES = /\b(probably|presumably|maybe|perhaps|might be|may be|should be fine|i (think|assume|guess|believe|suspect)|seems? to|appears? to|not sure|as far as i know|most likely|likely|i did not check|unverified|assum(e|ed|ing|ption))\b/i;

/** Every string in a contract that sits under a key named proof / evidence / docs. */
function collectProof(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectProof(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (['proof', 'docs'].includes(k) && Array.isArray(v)) out.push(...v);
      else if (k === 'evidence' && typeof v === 'string') out.push(v);
      else collectProof(v, out);
    }
  }
  return out;
}
const texts = (node, out = []) => {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => texts(n, out));
  return out;
};
const ev = (ctx, id) => ctx.evidence.find((e) => e.id === id);
const brainIndex = (ctx, orgName) => readJson(path.join(layout(ctx.root).orgVault(orgName), '_index.json'), null);

/** Lines of a file that are new compared with its backup (all lines when there is none). */
function changedLines(ctx, comp) {
  const abs = path.resolve(ctx.root, comp.path);
  if (!exists(abs) || fs.statSync(abs).isDirectory()) return [];
  const lines = readText(abs).split('\n');
  const bdir = path.join(ctx.dir, 'backup', buildOrg(ctx.cfg).name);
  const old = exists(bdir) ? listFiles(bdir).find((f) => refFromPath(f) === comp.ref && path.basename(f) === path.basename(abs)) : null;
  if (comp.change === 'new' || !old) return lines.map((text, i) => ({ n: i + 1, text }));
  const before = new Set(readText(path.join(bdir, old)).split('\n').map((l) => l.trim()));
  return lines.map((text, i) => ({ n: i + 1, text })).filter((l) => !before.has(l.text.trim()));
}
const filesOf = (ctx, comp) => {
  const abs = path.resolve(ctx.root, comp.path);
  if (!exists(abs)) return [];
  return fs.statSync(abs).isDirectory() ? listFiles(abs).map((f) => path.join(abs, f)) : [abs];
};
const backupFile = (ctx, comp, name) => {
  const bdir = path.join(ctx.dir, 'backup', buildOrg(ctx.cfg).name);
  const f = exists(bdir) ? listFiles(bdir).find((x) => refFromPath(x) === comp.ref && path.basename(x) === name) : null;
  return f ? path.join(bdir, f) : null;
};

export const GATES = {
  contract(ctx) {
    if (!ctx.contract) return failG(`${ctx.output}.json is missing. Write the contract file next to ${ctx.output}.md.`);
    const errors = validateContract(ctx.contract, ctx.def.contract);
    if (ctx.contract.key && ctx.contract.key !== ctx.key) errors.push(`key is "${ctx.contract.key}" but this ticket is ${ctx.key}`);
    const md = path.join(ctx.dir, `${ctx.output}.md`);
    if (!exists(md) || readText(md).trim().length < 80) errors.push(`${ctx.output}.md is missing or too short to be useful to a human`);
    return errors.length ? failG(errors) : pass();
  },

  evidence(ctx) {
    const problems = [];
    for (const id of new Set(collectProof(ctx.contract))) if (!ev(ctx, id)) problems.push(`${id} is cited but is not in the evidence ledger`);
    for (const c of ctx.contract.claims || []) {
      const bad = c.proof.map((id) => ev(ctx, id)).filter((e) => e && e.ok === false);
      if (bad.length) problems.push(`claim ${c.id} cites failed evidence ${bad.map((e) => e.id).join(', ')}`);
    }
    for (const t of texts(ctx.contract)) {
      const m = HEDGES.exec(t);
      if (m) problems.push(`guessing language ("${m[0]}") in: "${t.slice(Math.max(0, m.index - 30), m.index + 40).trim()}". State only what the evidence shows, or raise an open question.`);
    }
    return problems.length ? failG(problems) : pass([`${new Set(collectProof(ctx.contract)).size} evidence reference(s) verified`]);
  },

  noBlockingQuestions(ctx) {
    const open = (ctx.contract.open_questions || []).filter((q) => q.blocking && !q.answer);
    if (!open.length) return pass();
    return failG(open.map((q) => `${q.id}: ${q.text}`), { needs_human: 'question' });
  },

  reproProof(ctx) {
    const c = ctx.contract;
    const exec = ['soql', 'apex-run', 'apex-test', 'browser'];
    const kindsOf = (ids) => ids.map((id) => ev(ctx, id)).filter(Boolean);
    if (c.mode === 'bug') {
      if (c.reproduced !== true) {
        return failG([`The bug was not reproduced${c.could_not_reproduce_reason ? `: ${c.could_not_reproduce_reason}` : ''}. Work does not continue on an assumption.`], { needs_human: 'not_reproduced' });
      }
      const problems = [];
      for (const s of c.steps) {
        const es = kindsOf(s.proof);
        if (!es.some((e) => exec.includes(e.kind))) problems.push(`step ${s.n} has no execution proof (needs one of: ${exec.join(', ')}). Reading code is not a reproduction.`);
      }
      const all = c.steps.flatMap((s) => kindsOf(s.proof));
      if (!all.some((e) => exec.includes(e.kind) && e.org && !isProduction(getOrg(ctx.cfg, e.org)))) problems.push('no step was executed in a non-production org');
      if (!c.root_cause) problems.push('root_cause is missing: a reproduced bug needs a proven cause before planning');
      return problems.length ? failG(problems) : pass();
    }
    const es = kindsOf(c.before_state.proof);
    return es.some((e) => ['soql', 'brain', 'retrieve', 'browser', 'describe', 'apex-run'].includes(e.kind)) ? pass() : failG('before_state needs proof from the org or the Org Brain.');
  },

  dataSafe(ctx) {
    const files = [`${ctx.output}.md`, `${ctx.output}.json`].map((f) => path.join(ctx.dir, f)).filter(exists);
    for (const c of ctx.contract?.components || []) files.push(...filesOf(ctx, c));
    const work = path.join(ctx.dir, 'work');
    if (exists(work)) files.push(...listFiles(work).map((f) => path.join(work, f)));
    const problems = [];
    for (const f of files) {
      if (fs.statSync(f).size > 2_000_000 || /\.(png|jpe?g|gif|pdf|zip)$/i.test(f)) continue;
      const hits = scanText(readText(f), ctx.cfg.safety);
      if (hits.length) problems.push(`${path.relative(ctx.root, f)}: ${describeFindings(hits)}`);
    }
    return problems.length ? failG(problems) : pass([`${files.length} file(s) scanned`]);
  },

  planGrounding(ctx) {
    const b = buildOrg(ctx.cfg).name;
    const index = brainIndex(ctx, b) || brainIndex(ctx, ctx.cfg.pipeline.brain_base);
    if (!index) return failG(`No Org Brain index found for "${b}" or "${ctx.cfg.pipeline.brain_base}". Build it first: orgtomo brain build ${ctx.cfg.pipeline.brain_base}`);
    const problems = [];
    for (const c of ctx.contract.components) {
      const known = Boolean(index.components[c.ref]);
      const proven = (c.proof || []).map((id) => ev(ctx, id)).some((e) => e && e.ok && ['retrieve', 'soql', 'describe', 'brain', 'backup'].includes(e.kind));
      if (c.change !== 'new' && !known && !proven) problems.push(`${c.ref} is to be ${c.change === 'modify' ? 'modified' : 'deleted'} but is not in the Org Brain and has no org proof. Does it exist? Is the name exact?`);
      if (c.change === 'new' && known) problems.push(`${c.ref} is marked new but already exists (${index.components[c.ref].path}).`);
    }
    for (const id of ctx.contract.docs || []) { const e = ev(ctx, id); if (e && e.kind !== 'doc') problems.push(`${id} is listed under docs but is ${e.kind} evidence`); }
    const unordered = ctx.contract.components.map((c) => c.ref).filter((r) => !ctx.contract.order.includes(r));
    if (unordered.length) problems.push(`order does not include: ${unordered.join(', ')}`);
    return problems.length ? failG(problems) : pass();
  },

  planCoverage(ctx) {
    const u = ctx.read('01-understanding');
    if (!u) return failG('01-understanding.json not found.');
    const acs = u.acceptance_criteria.map((a) => a.id);
    const covered = new Set(ctx.contract.tests.flatMap((t) => t.covers));
    const problems = acs.filter((a) => !covered.has(a)).map((a) => `${a} is not covered by any planned test`);
    for (const c of covered) if (!acs.includes(c)) problems.push(`a test covers ${c}, which is not an acceptance criterion`);
    return problems.length ? failG(problems) : pass();
  },

  namingPlan(ctx) {
    const problems = ctx.contract.components.filter((c) => c.change === 'new').map((c) => nameProblem(ctx.cfg, c.ref)).filter(Boolean);
    return problems.length ? failG(problems) : pass();
  },

  scopeCheck(ctx) {
    const plan = ctx.read('03-plan');
    if (!plan) return failG('03-plan.json not found.');
    const planned = new Set(plan.components.map((c) => c.ref));
    const built = new Set(ctx.contract.components.map((c) => c.ref));
    const declared = new Set(ctx.contract.deviations.map((d) => d.ref));
    const problems = [];
    for (const r of built) if (!planned.has(r) && !declared.has(r)) problems.push(`${r} was built but is not in the plan and not declared as a deviation`);
    for (const r of planned) if (!built.has(r) && !declared.has(r)) problems.push(`${r} is in the plan but was not built and not declared as a deviation`);
    for (const c of ctx.contract.components) {
      if (c.change !== 'delete' && !exists(path.resolve(ctx.root, c.path))) problems.push(`${c.ref}: path ${c.path} does not exist`);
      else if (c.change !== 'delete' && refFromPath(c.path) && refFromPath(c.path) !== c.ref && !filesOf(ctx, c).some((f) => refFromPath(f) === c.ref)) problems.push(`${c.ref}: path ${c.path} belongs to ${refFromPath(c.path)}`);
    }
    return problems.length ? failG(problems) : pass(declared.size ? [`${declared.size} declared deviation(s) for the Lead to read`] : []);
  },

  backupCheck(ctx) {
    const backups = ctx.evidence.filter((e) => e.kind === 'backup');
    const refs = new Set(backups.flatMap((e) => e.meta.refs || []));
    const problems = ctx.contract.components.filter((c) => c.change !== 'new' && !refs.has(c.ref)).map((c) => `${c.ref} was changed without a recorded backup`);
    const deployEv = ev(ctx, ctx.contract.deploy.evidence);
    if (deployEv) for (const b of backups) if (b.at > deployEv.at && (b.meta.refs || []).some((r) => ctx.contract.components.some((c) => c.ref === r && c.change !== 'new'))) problems.push(`backup ${b.id} was taken after the deploy ${deployEv.id}; it holds the changed version, not the original`);
    return problems.length ? failG(problems) : pass();
  },

  namingLint(ctx) {
    const problems = [];
    const rules = ctx.cfg.conventions.naming || {};
    for (const c of ctx.contract.components) {
      if (c.change === 'new') { const p = nameProblem(ctx.cfg, c.ref); if (p) problems.push(p); }
      const { type } = parseRef(c.ref);
      if (type === 'Flow' && c.change !== 'delete' && rules.flow_element) {
        const file = filesOf(ctx, c).find((f) => f.endsWith('.flow-meta.xml'));
        if (!file) continue;
        const old = backupFile(ctx, c, path.basename(file));
        const oldNames = new Set(old ? flowElements(readText(old)).map((e) => e.name) : []);
        for (const e of flowElements(readText(file))) {
          const pattern = rules.flow_element[e.kind];
          if (pattern && !oldNames.has(e.name) && !new RegExp(pattern).test(e.name)) problems.push(`${c.ref}: ${e.kind} element "${e.name}" does not match ${pattern}`);
        }
      }
    }
    return problems.length ? failG(problems) : pass();
  },

  commentLint(ctx) {
    const rules = ctx.cfg.conventions.comments || {};
    const problems = [];
    for (const c of ctx.contract.components) {
      if (c.change === 'delete') continue;
      const { type } = parseRef(c.ref);
      for (const file of filesOf(ctx, c)) {
        if (/\.(cls|trigger)$/.test(file)) {
          const text = readText(file);
          if (c.change === 'new' && rules.class_header_required) {
            const header = /^\s*\/\*\*[\s\S]*?\*\//.exec(text)?.[0] || '';
            for (const tag of rules.class_header_tags || []) if (!header.includes(tag)) problems.push(`${c.ref}: header comment is missing ${tag}`);
          }
          if (c.change === 'modify' && rules.change_line_required && rules.change_line) {
            const re = changeLineRegex(rules.change_line, ctx.key);
            if (!changedLines(ctx, c).some((l) => re.test(l.text))) problems.push(`${c.ref}: no change line for ${ctx.key} (expected the form: ${rules.change_line})`);
          }
        }
        if (type === 'Flow' && file.endsWith('.flow-meta.xml') && rules.flow_description_required) {
          if (!(val(parseXml(readText(file)), 'description') || '').trim()) problems.push(`${c.ref}: the Flow has no description`);
        }
      }
    }
    return problems.length ? failG(problems) : pass();
  },

  formatLint(ctx) {
    const f = ctx.cfg.conventions.format || {};
    const problems = [];
    for (const c of ctx.contract.components) {
      if (c.change === 'delete') continue;
      for (const file of filesOf(ctx, c).filter((x) => /\.(cls|trigger)$/.test(x))) {
        const lines = changedLines(ctx, { ...c, path: file });
        const long = f.max_line ? lines.filter((l) => l.text.length > f.max_line) : [];
        if (long.length) problems.push(`${c.ref}: ${long.length} line(s) longer than ${f.max_line} (first: line ${long[0].n})`);
        if (f.indent_style === 'space' && lines.some((l) => /^\t/.test(l.text))) problems.push(`${c.ref}: tab indentation found; this org uses ${f.indent} spaces`);
        if (f.indent_style === 'tab' && lines.some((l) => /^ {2,}\S/.test(l.text))) problems.push(`${c.ref}: space indentation found; this org uses tabs`);
        if (c.change === 'new' && f.indent_style === 'space' && f.indent) {
          const off = lines.find((l) => { const m = /^( +)\S/.exec(l.text); return m && !/^\s*\*/.test(l.text) && m[1].length % f.indent !== 0; });
          if (off) problems.push(`${c.ref}: line ${off.n} is not indented in steps of ${f.indent}`);
        }
        if (c.change === 'new' && file.endsWith('.cls') && f.sharing_default) {
          const text = readText(file);
          const isTest = /@isTest/i.test(text);
          if (!isTest && /\bclass\s+\w+/.test(text) && !/\b(with sharing|without sharing|inherited sharing)\b/.test(text) && !/\b(interface|enum)\s+\w+/.test(text.split('{')[0])) problems.push(`${c.ref}: no sharing declaration (default here is "${f.sharing_default}")`);
        }
      }
    }
    return problems.length ? failG(problems) : pass();
  },

  forbiddenLint(ctx) {
    const problems = [];
    const declared = new Set((ctx.contract.deviations || []).map((d) => d.ref));
    for (const c of ctx.contract.components) {
      if (c.change === 'delete') continue;
      for (const file of filesOf(ctx, c)) {
        const name = path.basename(file);
        for (const rule of ctx.cfg.conventions.forbidden || []) {
          if (!String(rule.files || '*').split(',').some((g) => matchGlob(g.trim(), name))) continue;
          if (rule.except && String(rule.except).split(',').some((g) => matchGlob(g.trim(), name))) continue;
          if (rule.id === 'without-sharing' && declared.has(c.ref)) continue;
          const re = new RegExp(rule.pattern);
          const hit = changedLines(ctx, { ...c, path: file }).find((l) => re.test(l.text) && !/^\s*(\/\/|\*)/.test(l.text));
          if (hit) problems.push(`${c.ref} line ${hit.n}: ${rule.id}. ${rule.why}`);
        }
      }
    }
    return problems.length ? failG(problems) : pass();
  },

  deployCheck(ctx) {
    const e = ev(ctx, ctx.contract.deploy.evidence);
    const b = buildOrg(ctx.cfg).name;
    if (!e || e.kind !== 'deploy') return failG(`${ctx.contract.deploy.evidence} is not deploy evidence. Deploy with: orgtomo org deploy ${ctx.key} <paths>`);
    const problems = [];
    if (!e.ok) problems.push(`deploy ${e.id} failed`);
    if (e.meta.check_only) problems.push(`deploy ${e.id} was check-only; the change is not in ${b}`);
    if (e.org !== b) problems.push(`deploy ${e.id} went to ${e.org}, not the build org ${b}`);
    const deployed = new Map((e.meta.files || []).map((f) => [f.file, f.sha256]));
    for (const c of ctx.contract.components.filter((x) => x.change !== 'delete')) {
      if (!(e.meta.refs || []).includes(c.ref)) problems.push(`${c.ref} was not part of deploy ${e.id}`);
      for (const file of filesOf(ctx, c)) {
        const r = path.relative(ctx.root, file).split(path.sep).join('/');
        if (deployed.has(r) && deployed.get(r) !== sha256File(file)) problems.push(`${r} changed after deploy ${e.id}; deploy again so the org matches the files`);
      }
    }
    return problems.length ? failG(problems) : pass();
  },

  assertionReferee(ctx) {
    const u = ctx.read('01-understanding');
    if (!u) return failG('01-understanding.json not found.');
    const c = ctx.contract;
    const problems = [];
    const bad = c.results.filter((r) => r.outcome !== 'pass');
    if (c.verdict === 'pass') {
      if (bad.length) problems.push(`verdict is pass but ${bad.length} result(s) are not pass: ${bad.map((r) => r.test).join(', ')}`);
      for (const a of u.acceptance_criteria) if (!c.results.some((r) => r.covers.includes(a.id) && r.outcome === 'pass')) problems.push(`${a.id} has no passing result`);
      if (c.failures.length) problems.push('verdict is pass but failures are listed');
    } else {
      if (!c.failures.length) problems.push('verdict is fail but no failure is described');
      if (!bad.length && c.repro_rerun.outcome !== 'still_failing' && !c.regression.some((r) => r.outcome === 'fail')) problems.push('verdict is fail but every result passed');
    }
    for (const r of c.results) {
      for (const id of r.proof) {
        const e = ev(ctx, id);
        if (e && r.outcome === 'pass' && e.ok === false) problems.push(`${r.test} is marked pass but its proof ${id} records a failure`);
        if (e && e.org && c.org && e.org !== c.org) problems.push(`${r.test}: proof ${id} is from ${e.org}, not ${c.org}`);
      }
    }
    return problems.length ? failG(problems) : pass();
  },

  rerun(ctx) {
    const repro = ctx.read('02-repro');
    const c = ctx.contract;
    if (!repro || repro.mode !== 'bug') return pass(['not a bug ticket']);
    const problems = [];
    if (c.repro_rerun.outcome === 'not_applicable') problems.push('this is a bug ticket: the reproduction must be executed again after the build');
    const build = ctx.read('04-build');
    const deployEv = build && ev(ctx, build.deploy.evidence);
    const proofs = c.repro_rerun.proof.map((id) => ev(ctx, id)).filter(Boolean);
    if (!proofs.length) problems.push('repro_rerun has no proof');
    if (deployEv && proofs.some((e) => e.at <= deployEv.at)) problems.push('repro_rerun proof is older than the deploy; run the scenario again on the new build');
    if (c.repro_rerun.outcome === 'still_failing' && c.verdict !== 'fail') problems.push('the bug still reproduces, so the verdict must be fail');
    return problems.length ? failG(problems) : pass();
  },

  noRegression(ctx) {
    const base = ctx.read('00-baseline');
    if (!base) {
      return ctx.cfg.agents.agents.baseline?.enabled === false ? pass(['skipped: Baseline agent is off']) : failG('00-baseline.json not found, so regression cannot be judged.');
    }
    const after = new Map(ctx.contract.regression.map((r) => [r.name, r.outcome]));
    const problems = [];
    for (const t of base.tests.filter((x) => x.outcome === 'pass')) {
      if (!after.has(t.name)) problems.push(`${t.name} passed before the change and was not run again`);
      else if (after.get(t.name) !== 'pass' && ctx.contract.verdict === 'pass') problems.push(`${t.name} passed before the change and fails now, but the verdict is pass`);
    }
    return problems.length ? failG(problems) : pass();
  },

  testQuality(ctx) {
    const build = ctx.read('04-build');
    const plan = ctx.read('03-plan');
    if (!build) return failG('04-build.json not found.');
    const problems = [];
    const src = path.join(ctx.root, ctx.cfg.pipeline.source_dir || 'source', buildOrg(ctx.cfg).name);
    const all = exists(src) ? listFiles(src) : [];
    for (const name of build.unit_tests_added) {
      const f = all.find((x) => x.endsWith(`/classes/${name}.cls`));
      if (!f) { problems.push(`test class ${name} not found in source`); continue; }
      const text = readText(path.join(src, f));
      if (!/@isTest/i.test(text)) problems.push(`${name}: not annotated @IsTest`);
      if (!/\bAssert\.\w+\(|System\.assert(Equals|NotEquals)?\(/.test(text)) problems.push(`${name}: no assertions`);
      if (/SeeAllData\s*=\s*true/i.test(text)) problems.push(`${name}: uses SeeAllData=true`);
    }
    const automation = (plan?.components || []).some((c) => ['ApexTrigger', 'ApexClass', 'Flow'].includes(parseRef(c.ref).type) && c.change !== 'delete');
    if (automation && ctx.contract.verdict === 'pass') {
      if (!ctx.contract.bulk.tested || ctx.contract.bulk.records < 200) problems.push('automation changed: a bulk test with at least 200 records is required');
      else if (!(ctx.contract.bulk.proof || []).length) problems.push('bulk test has no proof');
    }
    return problems.length ? failG(problems) : pass();
  },

  reviewRubric(ctx) {
    const rubric = loadSpec(ctx.root, 'review-rubric').items;
    const required = rubric.filter((i) => ctx.ticket.path !== 'lite' || i.core);
    const c = ctx.contract;
    const problems = [];
    for (const item of required) {
      const a = c.rubric.find((r) => r.id === item.id);
      if (!a) problems.push(`rubric item ${item.id} is not answered`);
      else if (a.result !== 'na' && !(a.proof || []).length && !(a.note || '').trim()) problems.push(`rubric item ${item.id} has neither proof nor a note`);
    }
    const failed = c.rubric.filter((r) => r.result === 'fail');
    const serious = c.findings.filter((f) => f.severity !== 'minor');
    if (c.verdict === 'approve' && (failed.length || serious.length)) problems.push(`verdict is approve but there are ${failed.length} failed rubric item(s) and ${serious.length} blocker/major finding(s)`);
    if (c.verdict === 'changes' && !failed.length && !c.findings.length) problems.push('verdict is changes but nothing is reported as wrong');
    return problems.length ? failG(problems) : pass();
  },

  reviewerIndependence(ctx) {
    const a = ctx.cfg.agents;
    if (!a.rules?.reviewer_differs_from_builder) return pass(['rule is off']);
    return a.agents.reviewer.model !== a.agents.builder.model ? pass() : failG(`Reviewer and Builder both run on "${a.agents.builder.model}".`);
  },

  commsSafe(ctx) {
    const hits = scanText(JSON.stringify(ctx.contract), ctx.cfg.safety);
    const problems = hits.length ? [describeFindings(hits)] : [];
    if (ctx.contract.never_posted !== true) problems.push('drafts must be marked never_posted: true');
    return problems.length ? failG(problems) : pass();
  },

  lessonsEvidence(ctx) {
    const known = new Set(listObservations(ctx.root).map((o) => o.id));
    const cited = [...ctx.contract.went_well, ...ctx.contract.went_wrong, ...ctx.contract.lessons].flatMap((x) => x.observations);
    const problems = cited.filter((id) => !known.has(id)).map((id) => `${id} is not a recorded observation`);
    return problems.length ? failG(problems) : pass();
  },
};

/** Turn the change-line template from conventions.yaml into a RegExp for one ticket. */
export function changeLineRegex(template, key) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const map = { '{date}': '\\d{4}-\\d{2}-\\d{2}', '{ticket}': esc(key), '{author}': '.+?', '{what}': '.+' };
  return new RegExp(template.split(/(\{date\}|\{ticket\}|\{author\}|\{what\})/).map((part) => map[part] ?? esc(part)).join(''));
}

/** Name of a new component against conventions.yaml; returns a problem string or null. */
export function nameProblem(cfg, ref) {
  const n = cfg.conventions.naming || {};
  const { type, name } = parseRef(ref);
  const leaf = name.split('.').pop();
  const rule = {
    ApexClass: /Test$/.test(leaf) ? n.apex_test : n.apex_class,
    ApexTrigger: n.apex_trigger,
    Flow: n.flow,
    CustomField: n.custom_field,
    CustomObject: /__(mdt|e|x|b)$/.test(leaf) ? null : n.custom_object,
    LightningComponentBundle: n.lwc,
  }[type];
  if (!rule) return null;
  return new RegExp(rule).test(leaf) ? null : `${ref}: name "${leaf}" does not match the ${type} rule ${rule}`;
}

/** Named elements of a Flow file with their element kind. */
export function flowElements(xml) {
  const root = parseXml(xml);
  const kinds = ['decisions', 'recordLookups', 'recordUpdates', 'recordCreates', 'recordDeletes', 'assignments', 'loops', 'actionCalls', 'subflows', 'screens'];
  return kinds.flatMap((kind) => kids(root, kind).map((el) => ({ kind, name: val(el, 'name') }))).filter((e) => e.name);
}

/**
 * Run the gates of a stage.
 * @returns {{id: string, type: string, ok: boolean, details: string[], needs_human?: string, why: string}[]}
 */
export function runGates(ctx, gateIds) {
  const catalogue = loadSpec(ctx.root, 'gates').gates;
  const results = [];
  let contractOk = true;
  for (const id of gateIds) {
    const g = catalogue[id];
    if (!g || !GATES[g.impl]) { results.push({ id, type: g?.type || '?', ok: false, details: [`gate "${id}" is not defined`], why: '' }); continue; }
    if (!contractOk) { results.push({ id, type: g.type, ok: false, details: ['not run: the contract is invalid'], why: g.why, skipped: true }); continue; }
    let r;
    try { r = GATES[g.impl](ctx); } catch (e) { r = { ok: false, details: [`gate crashed: ${e.message}`] }; }
    if (id === 'contract' && !r.ok) contractOk = false;
    results.push({ id, type: g.type, why: g.why, ...r });
  }
  return results;
}

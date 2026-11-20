#!/usr/bin/env node
// Repository self-check: everything that refers to something else by name
// must point at something that exists. Run by CI and by `npm run check`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../engine/lib/yaml.js';
import { GATES } from '../engine/lib/gates.js';
import { loadDefault, validateConfig, CONFIG_FILES } from '../engine/lib/config.js';
import { listFiles, readText } from '../engine/lib/util.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const ok = (cond, msg) => { if (!cond) problems.push(msg); };
const yaml = (f) => parse(readText(path.join(root, f)));
const exists = (f) => fs.existsSync(path.join(root, f));

const stages = yaml('spec/stages.yaml').stages;
const gates = yaml('spec/gates.yaml').gates;
const agents = loadDefault('agents').agents;
const caps = loadDefault('capabilities');

for (const [id, g] of Object.entries(gates)) ok(typeof GATES[g.impl] === 'function', `gate "${id}": no implementation "${g.impl}" in engine/lib/gates.js`);
for (const s of stages) {
  for (const g of s.gates || []) ok(gates[g], `stage "${s.id}": unknown gate "${g}"`);
  if (s.contract) ok(exists(`spec/schemas/${s.contract}.schema.json`), `stage "${s.id}": missing contract schema "${s.contract}"`);
  for (const a of [s.owner, ...(s.before || []), ...(s.after || [])].filter(Boolean)) ok(agents[a], `stage "${s.id}": unknown agent "${a}"`);
  if (s.on_verdict) ok(stages.some((x) => x.id === s.on_verdict.goto), `stage "${s.id}": on_verdict.goto "${s.on_verdict.goto}" is not a stage`);
}
for (const f of listFiles(path.join(root, 'spec/schemas'))) { try { JSON.parse(readText(path.join(root, 'spec/schemas', f))); } catch (e) { problems.push(`spec/schemas/${f}: ${e.message}`); } }

const skills = fs.readdirSync(path.join(root, 'skills-src'));
for (const name of Object.keys(agents)) {
  ok(exists(`agents-src/${name}.md`), `agent "${name}": no template in agents-src/`);
  ok(caps.grants[name], `agent "${name}": no grant in capabilities.yaml`);
  if (!exists(`agents-src/${name}.md`)) continue;
  const text = readText(path.join(root, 'agents-src', `${name}.md`));
  const head = parse(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] || '') || {};
  ok(head.description, `agents-src/${name}.md: no description`);
  for (const s of head.skills || []) ok(skills.includes(s), `agents-src/${name}.md: unknown skill "${s}"`);
}
for (const [name, g] of Object.entries(caps.grants)) for (const c of g.capabilities || []) ok(caps.capabilities[c], `grant "${name}": unknown capability "${c}"`);
for (const s of skills) {
  const f = `skills-src/${s}/SKILL.md`;
  ok(exists(f), `${f} is missing`);
  if (exists(f)) ok(new RegExp(`^---\\nname: ${s}\\n`).test(readText(path.join(root, f))), `${f}: frontmatter name must be "${s}"`);
}
for (const f of fs.readdirSync(path.join(root, 'commands'))) ok(/^---\ndescription: .+/.test(readText(path.join(root, 'commands', f))), `commands/${f}: no description`);

const cfg = Object.fromEntries(CONFIG_FILES.map((n) => [n, loadDefault(n)]));
const { errors } = validateConfig(cfg);
for (const e of errors) problems.push(`spec/defaults: ${e}`);

for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json', 'sf-skills.lock', 'package.json']) { try { JSON.parse(readText(path.join(root, f))); } catch (e) { problems.push(`${f}: ${e.message}`); } }
const pkg = JSON.parse(readText(path.join(root, 'package.json')));
const plugin = JSON.parse(readText(path.join(root, '.claude-plugin/plugin.json')));
const market = JSON.parse(readText(path.join(root, '.claude-plugin/marketplace.json')));
const lock = JSON.parse(readText(path.join(root, 'sf-skills.lock')));
ok(pkg.version === plugin.version, `version mismatch: package.json ${pkg.version}, plugin.json ${plugin.version}`);
ok(readText(path.join(root, 'CHANGELOG.md')).includes(`## [${pkg.version}]`), `CHANGELOG.md has no entry for ${pkg.version}`);
for (const p of market.plugins.filter((x) => typeof x.source === 'object')) ok(p.source.sha === lock.sha, `marketplace.json: ${p.name} is pinned to ${p.source.sha}, sf-skills.lock says ${lock.sha}`);

// Nothing that identifies a machine or a person belongs in the repository.
const banned = [/\/Users\/[A-Za-z]/, /\/home\/[a-z]+\//, /C:\\Users\\/];
const extra = (process.env.ORGTOMO_FORBIDDEN_STRINGS || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
for (const f of listFiles(root, { ignore: ['node_modules', '.git', 'vendor'] })) {
  if (/\.(png|jpg|gif|ico)$/.test(f)) continue;
  const text = readText(path.join(root, f));
  for (const re of [...banned, ...extra]) if (re.test(text) && f !== 'scripts/check.mjs') problems.push(`${f}: contains ${re}`);
}

if (problems.length) { console.error(`${problems.length} problem(s):\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log(`ok: ${stages.length} stages, ${Object.keys(gates).length} gates, ${Object.keys(agents).length} agents, ${skills.length} skills, ${fs.readdirSync(path.join(root, 'commands')).length} commands`);

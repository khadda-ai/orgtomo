// Deploy pack: everything a human needs to move one ticket to the next org
// with their own tool. Orgtomo never deploys to a target org itself.
import fs from 'node:fs';
import path from 'node:path';
import { layout, rel } from './paths.js';
import { org as getOrg, buildOrg, isProduction } from './config.js';
import { packageXml, parseRef } from './metadata.js';
import { loadTicket, markPackReady } from './ticket.js';
import { exists, readJson, writeJson, writeText, readText, listFiles, fail, formatFrontmatter, nowIso } from './util.js';

function apiVersion(root, cfg) {
  if (cfg.pipeline.api_version) return String(cfg.pipeline.api_version);
  const f = path.join(root, cfg.pipeline.source_dir || 'source', cfg.pipeline.build_org, 'sfdx-project.json');
  const v = exists(f) ? readJson(f).sourceApiVersion : null;
  return v || fail('No API version known. Set sourceApiVersion in the build org\'s sfdx-project.json or api_version in pipeline.yaml.', 'NO_API_VERSION');
}

const TOOL_STEPS = {
  'blue-canvas': (t) => [
    `In Blue Canvas, confirm that the ${t.build} org shows the components listed in CHECKLIST.md as changed.`,
    `Create a Deployment Request from ${t.build} to ${t.org}.`,
    'Select exactly the components in CHECKLIST.md. Nothing more, nothing less.',
    `Validate the request${t.tests.length ? ' with the tests listed below' : ''}.`,
    'Do the manual steps marked "before deploy", deploy, then do the steps marked "after deploy".',
  ],
  'change-set': (t) => [
    `Change sets travel over a deployment connection. Create the outbound change set in the org that holds this change and is connected to ${t.org}.`,
    'Add exactly the components in CHECKLIST.md. Review any dependency the wizard suggests against the list before adding it.',
    `Upload it to ${t.org}.`,
    `In ${t.org}: Inbound Change Sets, Validate${t.tests.length ? ' with "Run specified tests" and the tests listed below' : ''}, then Deploy.`,
    'Change sets cannot delete components. Deletions listed in CHECKLIST.md are done by hand.',
  ],
  'git-cli': (t) => [
    'Commit the contents of this folder\'s force-app/ to your repository the way your team does.',
    `Validate: \`sf project deploy validate --manifest package.xml --target-org ${t.alias}${t.tests.length ? ` --test-level RunSpecifiedTests ${t.tests.map((x) => `--tests ${x}`).join(' ')}` : ''}\``,
    `Deploy the validated job: \`sf project deploy quick --job-id <id from the validate step> --target-org ${t.alias}\``,
    'Run these commands from this folder; it contains a minimal sfdx-project.json.',
  ],
  generic: (t) => [
    `Move exactly the components in CHECKLIST.md to ${t.org} with your deployment tool.`,
    `Validate first${t.tests.length ? ', running the tests listed below' : ''}, then deploy.`,
  ],
};

/**
 * Build the pack for the current handoff target of a ticket.
 * @returns {{org: string, dir: string, components: number}}
 */
export function buildPack(root, cfg, key) {
  const t = loadTicket(root, key);
  if (t.stage !== 'handoff' || !t.handoff) fail(`Ticket ${key} is not in handoff. A deploy pack exists only after review is approved.`, 'WRONG_STAGE');
  const target = t.handoff.targets[t.handoff.index];
  const o = getOrg(cfg, target.org);
  const dir = layout(root).ticketDir(key);
  const build = readJson(path.join(dir, '04-build.json'));
  const plan = readJson(path.join(dir, '03-plan.json'), { manual_steps: [], rollback: '' });
  const qa = readJson(path.join(dir, '05-qa.json'), { results: [] });
  const out = path.join(dir, '07-deploy-pack', target.org);
  fs.rmSync(out, { recursive: true, force: true });

  const live = build.components.filter((c) => c.change !== 'delete');
  const gone = build.components.filter((c) => c.change === 'delete');
  for (const c of live) {
    const abs = path.resolve(root, c.path);
    const files = fs.statSync(abs).isDirectory() ? listFiles(abs).map((f) => path.join(abs, f)) : [abs, `${abs}-meta.xml`].filter(exists);
    for (const f of files) {
      const r = rel(root, f);
      const i = r.indexOf('/main/default/');
      const inner = i >= 0 ? r.slice(i + '/main/default/'.length) : r.split('/').slice(3).join('/');
      writeText(path.join(out, 'force-app', 'main', 'default', inner), readText(f));
    }
  }
  const version = apiVersion(root, cfg);
  writeText(path.join(out, 'package.xml'), packageXml(live.map((c) => c.ref), version));
  if (gone.length) writeText(path.join(out, 'destructiveChanges.xml'), packageXml(gone.map((c) => c.ref), version));
  writeJson(path.join(out, 'sfdx-project.json'), { packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: version });

  const tests = build.unit_tests_added || [];
  const info = { build: buildOrg(cfg).name, org: target.org, alias: o.alias, tests };
  const steps = (TOOL_STEPS[target.tool] || TOOL_STEPS.generic)(info);
  const manual = (when) => plan.manual_steps.filter((m) => m.when === when).map((m) => `- [ ] ${m.text}`).join('\n') || '_None._';
  writeText(path.join(out, 'INSTRUCTIONS.md'), `${formatFrontmatter({ type: 'deploy-instructions', ticket: key, org: target.org, tool: target.tool, at: nowIso() })}# Deploy ${key} to ${target.org} (${target.tool})\n\nYou deploy; Orgtomo does not touch ${target.org}${isProduction(o) ? ' (production: read-only for Orgtomo, always)' : ''}.\n\n## Steps\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n${steps.length + 1}. When the deploy is finished, type in Claude Code: \`/orgtomo:deployed ${target.org} ${key}\`. Orgtomo then compares ${target.org} with the build, read-only${target.retest ? ', and retests there' : ''}.\n\n## Tests to run with the deploy\n\n${tests.map((x) => `- ${x}`).join('\n') || '_No Apex tests were added by this ticket. Follow your org\'s rule for the test level._'}\n${isProduction(o) ? '\nProduction deploys that run specified tests need 75% coverage on each class and trigger in the deployment.\n' : ''}\n## Before you deploy\n\n- [ ] Take your tool's own backup or snapshot of the components in ${target.org}.\n- [ ] Read the manual steps in CHECKLIST.md.\n\n## If something goes wrong\n\n${plan.rollback || 'See the plan.'}\n\nThe versions that were in ${info.build} before this ticket are in \`vault/tickets/${key}/backup/${info.build}/\`.\n`);
  writeText(path.join(out, 'CHECKLIST.md'), `${formatFrontmatter({ type: 'deploy-checklist', ticket: key, org: target.org })}# ${key}: what goes to ${target.org}\n\n## Components (${build.components.length})\n\n| | Type | Name | Change |\n|---|---|---|---|\n${build.components.map((c) => `| [ ] | ${parseRef(c.ref).type} | ${parseRef(c.ref).name} | ${c.change} |`).join('\n')}\n\n## Manual steps before deploy\n\n${manual('pre')}\n\n## Manual steps after deploy\n\n${manual('post')}\n${gone.length ? `\n## Deletions\n\n${gone.map((c) => `- [ ] ${c.ref}`).join('\n')}\n\nSee destructiveChanges.xml. Delete only after the rest is deployed and verified.\n` : ''}\n## What was tested in ${info.build}\n\n${qa.results.map((r) => `- ${r.test}: ${r.outcome}`).join('\n') || '_See 05-qa.md._'}\n`);
  markPackReady(root, cfg, key);
  return { org: target.org, tool: target.tool, dir: rel(root, out), components: build.components.length, next: `Stop. Tell the human the pack is ready and that they confirm with /orgtomo:deployed ${target.org} ${key}` };
}

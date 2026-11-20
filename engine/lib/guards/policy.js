// Policy guard for shell commands. Decides allow or deny for one Bash call.
// Rules are deny-by-default for anything that talks to Salesforce.
import fs from 'node:fs';
import path from 'node:path';
import { analyze, base, flag, flags, topic } from '../shell.js';
import { orgByAlias, isProduction, canWriteData } from '../config.js';
import { scanText, describeFindings } from './data.js';
import { emailGate } from '../canary.js';
import { matchGlob, exists, readText } from '../util.js';

const READ_ONLY = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'rg', 'ls', 'find', 'wc', 'stat', 'diff', 'jq', 'sha256sum', 'shasum',
  'md5sum', 'file', 'tree', 'pwd', 'echo', 'printf', 'date', 'which', 'cd', 'sort', 'uniq', 'cut', 'awk', 'tr', 'test', '[', 'true', 'false', 'basename', 'dirname', 'realpath', 'column', 'nl']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun', 'php']);
const PROTECTED_FRAGMENTS = ['orgtomo.config', '.orgtomo', '.claude/', '.claude ', '.mcp.json', '/evidence/', '/backup/', 'evidence/index.json'];
const SF_API_HOSTS = /https?:\/\/[^\s'"]*\.(salesforce\.com|force\.com|salesforce-setup\.com|site\.com|cloudforce\.com|database\.com)\b/i;
const HUMAN_VERBS = [
  ['human'], ['ui'], ['setup'], ['start'], ['config', 'set'], ['models', 'set'], ['features', 'set'], ['lessons', 'approve'], ['lessons', 'retire'],
  ['people', 'set'], ['people', 'confirm'], ['people', 'remove'], ['meetings', 'confirm'], ['meetings', 'reject'], ['org', 'restore'], ['style', 'set'],
];

const deny = (reason) => ({ decision: 'deny', reason });
const allow = (extra = {}) => ({ decision: 'allow', ...extra });

/**
 * @param {string} command the Bash command
 * @param {{cfg: object, root: string, agent: string, guardsOff?: boolean}} ctx
 * @returns {{decision:'allow'|'deny', reason?:string, orgtomo?:boolean}}
 */
export function checkBash(command, ctx) {
  const { cfg, root, agent } = ctx;
  const a = analyze(command);
  const mentionsSf = /(^|[\s;&|("'`/])(sf|sfdx)(\s|$)/.test(command);
  if (a.problems.length && mentionsSf) return deny(`The command could not be parsed safely (${a.problems[0]}). Write the sf command plainly.`);
  if (a.dynamic && mentionsSf) return deny('Salesforce CLI commands may not be built with eval, backticks, $(...) or piped into a shell. Write the command and the org alias literally.');
  if (a.dynamic && /\borgtomo\b/.test(command)) return deny('orgtomo commands may not be wrapped in eval, backticks or $(...).');

  for (const file of a.scripts || []) {
    const r = checkScriptFile(file, root, ctx);
    if (r) return r;
  }

  let usesOrgtomo = false;
  for (const seg of a.segments) {
    const name = base(seg.argv[0]);
    if (!name) continue;
    if ('ORGTOMO_ACTOR' in seg.env || 'ORGTOMO_HUMAN' in seg.env || 'ORGTOMO_GUARDS' in seg.env || 'ORGTOMO_SF_BIN' in seg.env) {
      return deny('Orgtomo identity and guard variables are set by the engine, never by a command.');
    }
    if (name === 'export' || name === 'declare' || name === 'set') {
      if (/ORGTOMO_|^SF_|SFDX_/.test(seg.argv.slice(1).join(' '))) return deny('Changing ORGTOMO_*, SF_* or SFDX_* variables is not allowed.');
    }
    if (Object.keys(seg.env).some((k) => /^(SF_TARGET_ORG|SFDX_DEFAULTUSERNAME|SF_ACCESS_TOKEN|SFDX_ACCESS_TOKEN|SFDX_AUTO_DEPLOY|HOME)$/.test(k))) {
      return deny('Setting the default org, tokens, auto-deploy or HOME for a command is not allowed.');
    }

    // Production and protected state hold even when the other guards are switched off.
    if (name === 'sf' || name === 'sfdx') {
      const r = checkSf(seg, ctx);
      if (r.decision === 'deny') return r;
      if (agent === 'lead' && !ctx.guardsOff) return deny('The Lead does not run the Salesforce CLI. Use the orgtomo org commands to verify, and hand work to the right agent.');
      continue;
    }
    const prot = protectedWrite(seg, cfg);
    if (prot) return deny(prot);
    if (ctx.guardsOff) continue;

    if (name === 'orgtomo' || (INTERPRETERS.has(name) && seg.argv.some((t) => /engine\/cli\.js$/.test(t)))) {
      const verb = seg.argv.filter((t) => !t.startsWith('-') && !/cli\.js$/.test(t)).slice(1);
      if (HUMAN_VERBS.some((h) => h.every((w, i) => verb[i] === w))) {
        return deny(`"orgtomo ${verb.slice(0, 2).join(' ')}" is a human action. The human does it with the matching /orgtomo: command, the UI, or their own terminal.`);
      }
      usesOrgtomo = true;
      continue;
    }
    if (INTERPRETERS.has(name)) {
      const inline = flag(seg.argv, '-e', '-c', '--eval', '-p');
      if (inline !== undefined && /\b(sf|sfdx)\b|salesforce|jsforce/i.test(inline)) {
        return deny('Inline scripts may not call Salesforce. Use the orgtomo org commands.');
      }
      const file = seg.argv.slice(1).find((t) => !t.startsWith('-'));
      const r = file && inline === undefined ? checkScriptFile(file, root, ctx) : null;
      if (r) return r;
    }
    if (['curl', 'wget', 'http', 'https', 'httpie', 'nc', 'ncat'].includes(name) && SF_API_HOSTS.test(seg.raw) && !officialDoc(seg.raw, cfg)) {
      return deny('Direct calls to Salesforce hosts are not allowed. Use the orgtomo org commands; they apply the org rules and record evidence.');
    }
    if (name === 'git') {
      const sub = seg.argv.slice(1).find((t) => !t.startsWith('-'));
      if (sub === 'push') return deny('Pushing is a human step.');
      if (sub === 'remote' && /\b(add|set-url|remove|rename)\b/.test(seg.raw)) return deny('Changing git remotes is a human step.');
    }
    if (name === 'rm' && /(^|\s)-[a-zA-Z]*r/.test(seg.raw)) {
      const targets = seg.argv.slice(1).filter((t) => !t.startsWith('-'));
      if (targets.some((t) => ['/', '~', '.', '..', '*', 'vault', 'source', './vault', './source'].includes(t.replace(/\/+$/, '') || '/'))) {
        return deny('Recursive delete of the workspace, vault or source folder is not allowed.');
      }
    }
    if (agent === 'lead' && !READ_ONLY.has(name)) {
      return deny(`The Lead delegates and verifies; it does not run "${name}". Use orgtomo commands or read-only shell commands, and hand work to the right agent.`);
    }
  }
  return allow({ orgtomo: usesOrgtomo });
}

const officialDoc = (text, cfg) => (cfg.safety.official_doc_hosts || []).some((h) => text.includes(`//${h}/`) || text.includes(`//${h} `) || text.endsWith(`//${h}`));

/** A segment that mentions protected state must be a pure read. */
function protectedWrite(seg, cfg) {
  const text = ` ${seg.raw} `;
  const fragments = [...PROTECTED_FRAGMENTS];
  const segment = /vault\/tickets\/[^\s'"]*\/(evidence|backup)(\/|[\s'"]|$)/.exec(text)?.[0];
  const hit = segment || fragments.find((f) => text.includes(f)) || seg.redirects.find((r) => (cfg.safety.protected_paths || []).some((g) => matchGlob(g, r.replace(/^\.\//, ''))));
  if (!hit) return null;
  const name = base(seg.argv[0]);
  const redirectsThere = seg.redirects.some((r) => fragments.some((f) => ` ${r} `.includes(f) || `${r}/`.includes(f)) || (cfg.safety.protected_paths || []).some((g) => matchGlob(g, r.replace(/^\.\//, ''))));
  if (name === 'orgtomo') return null;
  if (READ_ONLY.has(name) && !redirectsThere && !(name === 'find' && /-(delete|exec|execdir|ok)\b/.test(seg.raw)) && !(name === 'awk' && />/.test(seg.raw))) return null;
  return `Configuration, engine state, evidence, backups and generated agent files are written only by the engine or the human (blocked: "${name}" touching ${String(hit).trim()}).`;
}

function checkScriptFile(file, root, ctx) {
  const p = path.resolve(root, file);
  if (!exists(p) || fs.statSync(p).size > 200_000) return null;
  const text = readText(p);
  if (/\.(sh|bash|zsh)$/.test(file) || text.startsWith('#!/bin/sh') || text.startsWith('#!/bin/bash') || text.startsWith('#!/usr/bin/env bash')) {
    const r = checkBash(text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), ctx);
    return r.decision === 'deny' ? deny(`Script ${file}: ${r.reason}`) : null;
  }
  if (/\b(sf|sfdx)\s+(data|org|project|apex|api)\b|jsforce|simple_salesforce|\.salesforce\.com/.test(text)) {
    return deny(`Script ${file} talks to Salesforce directly. Scripts may not do that; use the orgtomo org commands.`);
  }
  return null;
}

// ---------------------------------------------------------------- sf rules

const LOCAL_ONLY = [
  ['apex', 'generate'], ['lightning', 'generate'], ['project', 'generate'], ['schema', 'generate'], ['static-resource', 'generate'], ['visualforce', 'generate'],
  ['analytics', 'generate'], ['flexipage', 'generate'], ['code-analyzer'], ['scanner'], ['project', 'convert'], ['help'], ['version'], ['commands'], ['which'], ['search'], ['doctor'], ['template'],
];
const ALWAYS_DENY = [
  [['org', 'login'], 'Logging in to an org is a human step.'],
  [['org', 'logout'], 'Logging out of an org is a human step.'],
  [['org', 'delete'], 'Deleting an org is a human step.'],
  [['org', 'create'], 'Creating an org is a human step.'],
  [['org', 'refresh'], 'Refreshing a sandbox is a human step.'],
  [['org', 'resume'], 'Org creation is a human step.'],
  [['org', 'display'], 'sf org display prints an access token. Use "orgtomo org info <org>".'],
  [['org', 'open'], 'Opening an org prints a login URL. The human signs in to the browser profile once; agents use the browser capability.'],
  [['org', 'generate'], 'Generating passwords is a human step.'],
  [['org', 'auth'], 'Auth commands are human-only.'],
  [['config'], 'Changing the CLI configuration (default org) is a human step.'],
  [['alias'], 'Changing aliases is a human step.'],
  [['plugins'], 'Installing CLI plugins is a human step.'],
  [['update'], 'Updating the CLI is a human step.'],
  [['api', 'request'], 'Raw API requests bypass the org rules. Use the orgtomo org commands.'],
  [['project', 'deploy', 'start'], 'Deploys go through "orgtomo org deploy" (backup first, build org only). Target orgs are deployed by a human.'],
  [['project', 'deploy', 'validate'], 'Use "orgtomo org deploy --check" for a check-only deploy to the build org.'],
  [['project', 'deploy', 'quick'], 'Deploys go through "orgtomo org deploy".'],
  [['project', 'deploy', 'resume'], 'Deploys go through "orgtomo org deploy".'],
  [['project', 'deploy', 'cancel'], 'Cancelling a deploy is a human step.'],
  [['project', 'deploy', 'pipeline'], 'Pipeline deploys are a human step.'],
  [['project', 'delete'], 'Destructive changes are prepared in the deploy pack and executed by a human.'],
  [['data', 'export'], 'Mass export is not allowed. Use "orgtomo org query" for a bounded, masked read.'],
  [['data', 'delete', 'bulk'], 'Bulk delete is not allowed.'],
  [['package'], 'Packaging commands are human-only.'],
  [['agent'], 'Agentforce commands are outside Orgtomo for now.'],
  [['force'], 'Legacy force:* commands are not supported. Use the current sf commands.'],
];
const startsWith = (words, prefix) => prefix.every((w, i) => words[i] === w);

function checkSf(seg, ctx) {
  const { cfg, root } = ctx;
  const argv = seg.argv;
  const words = topic(argv).flatMap((w) => w.split(':'));
  if (argv.slice(1).some((t) => /[$`]/.test(t))) return deny('sf commands may not contain variables or substitutions. Write every value literally, including the org alias.');
  if (seg.viaXargs) return deny('sf may not be run through xargs.');
  if (!words.length) return allow();
  for (const [prefix, why] of ALWAYS_DENY) if (startsWith(words, prefix)) return deny(why);
  if (flag(argv, '-u', '--targetusername', '--target-dev-hub', '-v') !== undefined) return deny('Use --target-org <alias> with an alias from orgs.yaml.');
  if (LOCAL_ONLY.some((p) => startsWith(words, p))) return allow();
  if (startsWith(words, ['org', 'list']) && words.length === 2 && !argv.includes('--verbose')) return allow();

  const alias = flag(argv, '--target-org', '-o');
  if (!alias) return deny('State the org explicitly with --target-org <alias>. Orgtomo never relies on a default org.');
  const o = orgByAlias(cfg, alias);
  if (!o) return deny(`Org "${alias}" is not in orgs.yaml. Only configured orgs may be used.`);
  if (isProduction(o)) {
    return deny(`"${o.name}" is production. It is read-only and reachable only through "orgtomo org query ${o.name} ..." and "orgtomo org retrieve ${o.name} ..." (masked, recorded).`);
  }
  if (ctx.guardsOff) return allow();

  const is = (...p) => startsWith(words, p);
  // Reads
  if (is('data', 'query') || is('data', 'search') || is('data', 'get')) {
    if (cfg.safety.mask?.mask_sandbox_reads !== false) return deny(`Sandbox reads are masked. Use: orgtomo org query ${o.name} "<SOQL>" --ticket <KEY>`);
    return allow();
  }
  if (is('project', 'retrieve') || is('project', 'deploy', 'report') || is('project', 'deploy', 'preview') || is('org', 'list') || is('sobject') || is('schema')
    || is('apex', 'get') || is('apex', 'list') || is('apex', 'tail') || is('data', 'resume') || is('limits') || is('org', 'list', 'metadata')) return allow();
  if (is('apex', 'run', 'test') || is('apex', 'test') || is('logic', 'run', 'test') || is('flow', 'run', 'test')) return allow();

  // Writes to data
  const dataWrite = is('apex', 'run') || is('data', 'create') || is('data', 'update') || is('data', 'upsert') || is('data', 'import') || is('data', 'delete', 'record')
    || is('org', 'assign');
  if (dataWrite) {
    if (!canWriteData(o)) return deny(`Agents may not write data in "${o.name}" (role ${o.role}).`);
    if (is('apex', 'run') && flag(argv, '--file', '-f') === undefined) return deny('Anonymous Apex must come from a file (--file) so it can be checked. No stdin.');
    const files = flags(argv, '--file', '-f', '--files', '--plan', '-p', '--sobject-tree-files');
    let text = argv.join(' ');
    for (const f of files) {
      const p = path.resolve(root, f);
      if (!exists(p)) return deny(`File not found: ${f}`);
      text += '\n' + readText(p);
    }
    const findings = scanText(text, cfg.safety);
    if (findings.length) return deny(`Data guard: ${describeFindings(findings)}`);
    const gate = emailGate(root, cfg, o);
    if (!gate.ok) return deny(gate.reason);
    return allow();
  }
  const extra = (cfg.safety.sf_allow_extra || []).some((g) => matchGlob(g, `sf ${words.join(' ')}`) || matchGlob(g, `sf ${words.join(' ')} *`));
  if (extra) return allow();
  return deny(`"sf ${words.join(' ')}" is not on the allowed list for agents. If it is safe for your build org, add it to safety.yaml under sf_allow_extra.`);
}

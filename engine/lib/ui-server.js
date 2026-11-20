// Local control panel. Binds to 127.0.0.1 only and requires a token that is
// printed in the terminal where the human started it. It is the human's
// surface: agents are refused "orgtomo ui" and never see the token.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PLUGIN_ROOT, layout } from './paths.js';
import { loadConfig, validateConfig, setConfigValue, loopMax, approvalStages, MODELS, EFFORTS, org as getOrg, isProduction } from './config.js';
import * as T from './ticket.js';
import * as L from './learning.js';
import * as P from './people.js';
import * as M from './meetings.js';
import { brainStatus, search as brainSearch, brainFact, objectView } from './brain.js';
import { discoverStatus, answerQuestion } from './discover.js';
import { loadCatalogue, modelOptions, refreshModels } from './models.js';
import { obsidianStatus } from './obsidian.js';
import { listEvidence } from './evidence.js';
import { readCanary, recordCanary } from './canary.js';
import { doctor } from './doctor.js';
import { sync } from './sync.js';
import { exists, readText, readJson, listFiles, OrgtomoError } from './util.js';

const UI_DIR = path.join(PLUGIN_ROOT, 'engine', 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

/** Everything the UI shows on load. */
export function uiState(root) {
  const cfg = loadConfig(root);
  const { errors, warnings } = validateConfig(cfg);
  const cat = loadCatalogue(root);
  const orgs = Object.entries(cfg.orgs.orgs || {}).map(([name, o]) => ({ name, alias: o.alias, role: o.role, host: o.host || '', canary: readCanary(root)[name] || null }));
  return {
    company: cfg.orgs.company, errors, warnings, orgs,
    pipeline: { build_org: cfg.pipeline.build_org, brain_base: cfg.pipeline.brain_base, targets: cfg.pipeline.targets, autonomy: cfg.pipeline.autonomy, loop_max: loopMax(cfg), approvals: errors.length ? [] : approvalStages(cfg), lite: cfg.pipeline.lite },
    agents: cfg.agents.agents, agent_rules: cfg.agents.rules, models: MODELS, efforts: EFFORTS,
    model_options: modelOptions(cat), model_catalogue: { source: cat.source, at: cat.fetched_at || cat.updated },
    features: cfg.features, safety: { email_mode: cfg.safety.email_mode, allowed_emails: cfg.safety.allowed_emails, allowed_email_domains: cfg.safety.allowed_email_domains, allowed_phones: cfg.safety.allowed_phones, canary_max_age_minutes: cfg.safety.canary_max_age_minutes, mask_sandbox_reads: cfg.safety.mask?.mask_sandbox_reads !== false, claude_in_chrome: cfg.safety.browser?.claude_in_chrome === true, browser_login: cfg.safety.browser?.login || 'manual', browser_provider: cfg.safety.browser?.provider || 'none', allowed_email_shapes: cfg.safety.allowed_email_shapes === true },
    discover: errors.length ? [] : discoverStatus(root, cfg), obsidian: obsidianStatus(root),
    tickets: T.listTickets(root).map(T.summary).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))),
    stages: T.stagesOf(root).map((s) => ({ id: s.id, owner: s.owner || 'human' })),
    brain: errors.length ? [] : Object.keys(cfg.orgs.orgs || {}).map((o) => brainStatus(root, cfg, o)),
    lessons: L.listLessons(root), patterns: L.patterns(root).slice(0, 30), observations: L.listObservations(root).slice(-60).reverse(),
    people: { enabled: P.enabled(cfg), list: P.listPeople(root), proposals: P.listProposals(root) },
    meetings: { enabled: M.enabled(cfg), list: M.listMeetings(root).slice(0, 30), pending: M.pendingLinks(root) },
  };
}

function ticketDetail(root, key) {
  const cfg = loadConfig(root);
  const t = T.loadTicket(root, key);
  const dir = layout(root).ticketDir(key);
  const files = exists(dir) ? listFiles(dir).filter((f) => !f.startsWith('evidence/') && !f.startsWith('backup/') && !f.startsWith('07-deploy-pack/')) : [];
  const reports = files.filter((f) => /^(verify-.*|escalation|updates)\.md$/.test(f)).map((f) => ({ name: f, text: readText(path.join(dir, f)).replace(/^---\n[\s\S]*?\n---\n/, '') }));
  const understanding = readJson(path.join(dir, '01-understanding.json'), null);
  return { ticket: t, next: T.next(root, cfg, key), reports, files, understanding, understanding_page: exists(path.join(dir, '01-understanding.html')) ? `vault/tickets/${key}/01-understanding.html` : null, evidence: listEvidence(root, key).map(({ id, kind, org, actor, at, ok, summary }) => ({ id, kind, org, actor, at, ok, summary })) };
}

function act(root, body) {
  const cfg = loadConfig(root);
  const src = { source: 'ui' };
  switch (body.verb) {
    case 'approve': return T.human.approve(root, cfg, body.key, { note: body.note || '', ...src });
    case 'reject': return T.human.reject(root, cfg, body.key, { note: body.note || '', ...src });
    case 'hold': return T.human.hold(root, cfg, body.key, {});
    case 'resume': return T.human.resume(root, cfg, body.key, { note: body.note || '', ...src });
    case 'answer': return T.human.answer(root, cfg, body.key, { id: body.id || '', note: body.note || '', ...src });
    case 'deployed': return T.human.deployed(root, cfg, body.key, { org: body.org, ...src });
    case 'feedback': return T.human.feedback(root, cfg, body.key || null, { kind: body.kind, agent: body.agent, note: body.note || '' });
    case 'config': { const next = setConfigValue(root, body.file, body.path, body.value); return { saved: true, sync: sync(root, next).written.length }; }
    case 'lesson': { const r = L.setLessonStatus(root, body.id, body.status); sync(root, cfg); return r; }
    case 'person': return P.setPerson(root, cfg, body.name, body.fields || {});
    case 'person-remove': return P.removePerson(root, cfg, body.name);
    case 'proposal': return P.confirmProposal(root, cfg, body.id, { accept: body.accept !== false, as: body.as === 'avoid' ? 'avoid' : 'prefers' });
    case 'meeting-link': return M.confirmLink(root, cfg, body.id, body.accept !== false);
    case 'canary': { const o = getOrg(cfg, body.org); if (isProduction(o)) throw new OrgtomoError('Production has no canary.'); return recordCanary(root, o.name, body.status, 'human', 'set in the UI'); }
    case 'discover-answer': return answerQuestion(root, cfg, getOrg(cfg, body.org).name, body.id, body.note || '');
    case 'sync': return sync(root, cfg);
    default: throw new OrgtomoError(`Unknown action "${body.verb}".`);
  }
}

/** Create the HTTP handler (exported for tests). */
export function createHandler(root, token, port) {
  return async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const host = String(req.headers.host || '');
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return send(403, { error: 'Bad host.' });
    if (!url.pathname.startsWith('/api/')) {
      const file = path.join(UI_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\])+/, ''));
      if (!file.startsWith(UI_DIR) || !exists(file) || fs.statSync(file).isDirectory()) return send(404, 'Not found', 'text/plain');
      return send(200, readText(file), TYPES[path.extname(file)] || 'text/plain');
    }
    const given = Buffer.from(String(req.headers['x-orgtomo-token'] || ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(401, { error: 'Open the link printed in your terminal; it carries the access token.' });
    if (req.method === 'POST' && req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin)) return send(403, { error: 'Bad origin.' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, uiState(root));
      if (req.method === 'GET' && url.pathname === '/api/doctor') return send(200, doctor(root, { orgs: url.searchParams.get('orgs') === '1' }));
      if (req.method === 'GET' && url.pathname.startsWith('/api/ticket/')) return send(200, ticketDetail(root, decodeURIComponent(url.pathname.slice('/api/ticket/'.length))));
      if (req.method === 'GET' && url.pathname.startsWith('/api/brain/')) {
        const cfg = loadConfig(root);
        const orgName = getOrg(cfg, url.searchParams.get('org') || '').name;
        const what = url.pathname.slice('/api/brain/'.length);
        if (what === 'search') return send(200, brainSearch(root, cfg, orgName, String(url.searchParams.get('q') || '').split(/\s+/).filter(Boolean), { limit: 40 }));
        if (what === 'component') return send(200, brainFact(root, cfg, orgName, url.searchParams.get('ref') || ''));
        if (what === 'object') return send(200, objectView(root, cfg, orgName, url.searchParams.get('name') || ''));
        return send(404, { error: 'Not found.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        let raw = '';
        for await (const c of req) { raw += c; if (raw.length > 200_000) return send(413, { error: 'Too large.' }); }
        const body = JSON.parse(raw || '{}');
        // The one action that goes to the network: asking the account which models it can use.
        if (body.verb === 'models-refresh') return send(200, { ok: true, result: await refreshModels(root) });
        return send(200, { ok: true, result: act(root, body) });
      }
      return send(404, { error: 'Not found.' });
    } catch (e) {
      return send(e instanceof OrgtomoError ? 400 : 500, { error: e.message });
    }
  };
}

/** Start the panel and print its address. */
export function startUi(root, { port = 4310 } = {}) {
  const token = crypto.randomBytes(18).toString('hex');
  const server = http.createServer(createHandler(root, token, port));
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Try: orgtomo ui --port ${port + 1}` : e.message); process.exit(1); });
  server.listen(port, '127.0.0.1', () => {
    console.log(`\nOrgtomo control panel for ${root}\n\n  http://127.0.0.1:${port}/#t=${token}\n\nOnly this computer can reach it. Keep this terminal open; press Ctrl+C to stop.\n`);
  });
  return server;
}

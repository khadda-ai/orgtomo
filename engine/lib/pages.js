// Stage pages: a stage contract shown as a page a person can read quickly.
// The engine builds the page from the contract, so the page can never say
// something the contract does not. Pages are plain HTML with inline styles and
// no script, so they open anywhere, including straight from the vault folder.
import path from 'node:path';
import { layout } from './paths.js';
import { redactInside } from './mask.js';
import { exists, readJson, writeText, nowIso } from './util.js';

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const p = (v) => String(v ?? '').split(/\n{2,}/).map((x) => `<p>${esc(x).replace(/\n/g, '<br>')}</p>`).join('');
const table = (heads, rows) => (rows.length ? `<div class="scroll"><table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="muted">None.</p>');
const pill = (text, kind = '') => `<span class="pill ${kind}">${esc(text)}</span>`;

const STYLE = `:root{--bg:#f7f8fb;--card:#fff;--ink:#23262f;--head:#10254f;--muted:#667089;--line:#dde2ee;--accent:#3b6fe0;--good:#17734a;--good-bg:#e2f5eb;--bad:#b4231a;--bad-bg:#fdecea;--warn:#8f5600;--warn-bg:#fff2d9}
@media (prefers-color-scheme:dark){:root{--bg:#0d1424;--card:#141d33;--ink:#d5dae6;--head:#e4ebff;--muted:#98a3be;--line:#27345a;--accent:#82a6ff;--good:#70dba4;--good-bg:#11342a;--bad:#ff9c92;--bad-bg:#3a1a1a;--warn:#ffc670;--warn-bg:#382a11}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:920px;margin:0 auto;padding:28px 16px 64px;display:flex;flex-direction:column;gap:18px}
h1,h2,h3{color:var(--head);margin:0;line-height:1.25}h1{font-size:26px}h2{font-size:18px}h3{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
p{margin:0 0 8px}section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:10px;min-width:0}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.two>div{border-left:3px solid var(--line);padding-left:12px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
code{background:var(--bg);padding:1px 5px;border-radius:4px}pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;margin:0}
.pill{font-size:11.5px;font-weight:600;border-radius:6px;padding:2px 8px;background:var(--bg);color:var(--muted);white-space:nowrap}
.pill.good{background:var(--good-bg);color:var(--good)}.pill.bad{background:var(--bad-bg);color:var(--bad)}.pill.warn{background:var(--warn-bg);color:var(--warn)}
.muted{color:var(--muted)}.lede{font-size:17px}.q{border-left:3px solid var(--warn);padding-left:12px}`;

/** HTML of the understanding page. `u` is the contract, `t` the imported ticket. */
export function understandingHtml(key, u, t = {}) {
  const ex = (u.examples || []).map((e) => [
    `<strong>${esc(e.title)}</strong>${e.covers?.length ? `<br>${e.covers.map((c) => pill(c)).join(' ')}` : ''}`,
    e.input ? `<code>${esc(e.input)}</code>` : `${esc(e.given)}<br><span class="muted">when</span> ${esc(e.when)}`,
    e.today ? esc(e.today) : '<span class="muted">not stated</span>',
    esc(e.expected || e.then),
  ]);
  const ac = (u.acceptance_criteria || []).map((a) => [`<strong>${esc(a.id)}</strong>`, esc(a.text), pill(a.source, a.source === 'ticket' ? 'good' : '')]);
  const affected = (u.affected || []).map((a) => [`<code>${esc(a.component)}</code>`, esc(a.why), (a.proof || []).map((x) => `<code>${esc(x)}</code>`).join(' ')]);
  const qs = (u.open_questions || []).map((q) => `<div class="q"><strong>${esc(q.id)}</strong> ${q.blocking ? pill('blocking', 'warn') : pill('not blocking')}<p>${esc(q.text)}</p>${q.answer ? `<p><span class="muted">Answer:</span> ${esc(q.answer)}</p>` : `<p class="muted">Answer with: /orgtomo:answer ${esc(key)} ${esc(q.id)} &lt;your answer&gt;</p>`}</div>`).join('');
  const i = u.intake;
  const state = (v) => pill(String(v), v === 'exists' ? 'good' : v === 'missing' || v === 'differs' ? 'bad' : '');
  const intake = i ? `<section><h2>Checked against the system</h2>
<div class="two"><div><h3>Seen today</h3>${p(i.restated.observed)}</div><div><h3>Expected</h3>${p(i.restated.expected)}</div></div>
<p><span class="muted">What has to change:</span> <code>${esc(i.restated.change_target)}</code></p>
<h3>Names the ticket uses</h3>${table(['Name', 'Kind', 'Where it was checked', 'Proof'], i.identifiers.map((d) => [`<code>${esc(d.name)}</code>${d.note ? `<br><span class="muted">${esc(d.note)}</span>` : ''}`, esc(d.kind), Object.entries(d.orgs || {}).map(([o, v]) => `${esc(o)} ${state(v)}`).join(' '), (d.proof || []).map((x) => `<code>${esc(x)}</code>`).join(' ')]))}
${i.size ? `<p><span class="muted">How many records this is about:</span> <strong>${esc(i.size.count)}</strong> (${esc(i.size.population)}${i.size.org ? `, counted in ${esc(i.size.org)}` : ''})</p>` : ''}
<p><span class="muted">The assumption everything rests on:</span> ${esc(i.key_assumption.text)} ${pill(i.key_assumption.held === true ? 'holds' : i.key_assumption.held === false ? 'does not hold' : 'not tested', i.key_assumption.held === true ? 'good' : i.key_assumption.held === false ? 'bad' : 'warn')}</p>
${i.recommendation ? `<p><span class="muted">Recommendation:</span> ${esc(i.recommendation)}</p>` : ''}</section>` : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(key)}: understanding</title><style>${STYLE}</style></head>
<body><main>
<header><h3>${esc(key)} ${pill(t.type || 'ticket')} ${pill(`risk: ${u.risk}`, u.risk === 'high' ? 'bad' : u.risk === 'medium' ? 'warn' : 'good')}</h3><h1>${esc(t.title || key)}</h1>
<p class="lede">${esc(u.one_line || u.summary_plain.split(/(?<=[.!?])\s/)[0])}</p></header>
<section><h2>In plain words</h2>${p(u.summary_plain)}
${u.today || u.wanted ? `<div class="two"><div><h3>Today</h3>${p(u.today || '')}</div><div><h3>Wanted</h3>${p(u.wanted || '')}</div></div>` : ''}</section>
<section><h2>Examples</h2>${table(['Example', 'Input or situation', 'Today', 'Expected'], ex)}</section>
<section><h2>Acceptance criteria</h2>${table(['Id', 'Criterion', 'From'], ac)}</section>
${qs ? `<section><h2>Questions for you</h2>${qs}</section>` : ''}
${intake}
<section><h2>For a developer</h2>${p(u.summary_technical)}${table(['Component', 'Why it matters', 'Proof'], affected)}</section>
${u.diagram ? `<section><h2>Diagram</h2><p class="muted">Mermaid source. It draws itself in Obsidian and on GitHub.</p><pre>${esc(u.diagram)}</pre></section>` : ''}
<p class="muted">Built by the engine from 01-understanding.json on ${esc(nowIso().slice(0, 16).replace('T', ' '))} UTC. The contract is the record; this page only shows it.</p>
</main></body></html>
`;
}

/**
 * Write the page of a stage next to its contract. Only "understand" has one today.
 * @returns {string|null} workspace-relative path of the page
 */
export function renderStagePage(root, cfg, key, stageId) {
  if (stageId !== 'understand') return null;
  const dir = layout(root).ticketDir(key);
  const file = path.join(dir, '01-understanding.json');
  if (!exists(file)) return null;
  const clean = (v) => JSON.parse(redactInside(JSON.stringify(v), cfg.safety));
  const u = clean(readJson(file));
  const t = clean(readJson(path.join(dir, '00-ticket.json'), {}));
  writeText(path.join(dir, '01-understanding.html'), understandingHtml(key, u, t));
  return `vault/tickets/${key}/01-understanding.html`;
}

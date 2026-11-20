// Orgtomo control panel. No framework: a small element helper and one render
// function per section. All text is set with textContent, never innerHTML.
(() => {
  const m = /[#&]t=([0-9a-f]+)/.exec(location.hash);
  if (m) { try { sessionStorage.setItem('orgtomo-token', m[1]); } catch { /* private mode */ } window.__t = m[1]; location.hash = '#/overview'; }
  const token = window.__t || (() => { try { return sessionStorage.getItem('orgtomo-token'); } catch { return null; } })() || '';
  let S = null;

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'value') el[k] = v; else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const toast = (text, err) => { const t = document.getElementById('toast'); t.textContent = text; t.className = `show${err ? ' err' : ''}`; clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, err ? 6000 : 2200); };
  const api = async (path, body) => {
    const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'x-orgtomo-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  };
  const act = async (body, done = 'Saved') => { try { const r = await api('/api/action', body); toast(done); await load(); return r; } catch (e) { toast(e.message, true); return null; } };
  const setCfg = (file, path, value, done) => act({ verb: 'config', file, path, value }, done);
  const when = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');
  const pill = (text, kind = '') => h('span', { class: `pill ${kind}` }, text);
  const statusPill = (t) => pill(t.status === 'awaiting_human' ? `waiting: ${t.waiting_for}` : t.status, { done: 'good', escalated: 'bad', awaiting_human: 'warn', hold: 'plain' }[t.status] || '');
  const table = (heads, rows, empty = 'Nothing here yet.') => (rows.length ? h('table', {}, h('thead', {}, h('tr', {}, heads.map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))) : h('p', { class: 'muted' }, empty));
  const head = (title, sub, ...right) => h('div', { class: 'head' }, h('div', {}, h('h1', {}, title), sub && h('p', {}, sub)), h('div', { class: 'row' }, right));
  const card = (title, ...kids) => h('section', { class: 'card' }, title && h('h2', {}, title), kids);
  const sw = (checked, onchange, disabled, label) => h('label', { class: 'switch', title: label }, h('input', { type: 'checkbox', checked, disabled, 'aria-label': label, onchange: (e) => onchange(e.target.checked) }), h('span'));
  const toggle = (title, desc, checked, onchange, disabled) => h('div', { class: 'card toggle' }, h('div', {}, h('h3', {}, title), h('p', {}, desc)), sw(checked, onchange, disabled, title));
  const select = (options, value, onchange, label) => h('select', { 'aria-label': label, onchange: (e) => onchange(e.target.value) }, options.map((o) => h('option', { value: o, selected: o === value }, o)));
  const ask = (text, required) => { const v = window.prompt(text); if (v === null) return null; if (required && !v.trim()) { toast('A reason is required.', true); return null; } return v.trim(); };

  // ---------------------------------------------------------------- sections

  const waitingCard = (t) => {
    const key = t.key;
    const kinds = {
      approval: () => [h('p', {}, `Stage “${t.waiting_detail}” passed its gates and the Lead’s check. Read the result, then decide.`), h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => act({ verb: 'approve', key }, 'Approved') }, 'Approve'),
        h('button', { class: 'danger', onclick: () => { const note = ask('Why do you reject it? The agent gets exactly this text.', true); if (note) act({ verb: 'reject', key, note }, 'Rejected'); } }, 'Reject…'),
        h('a', { href: `#/ticket/${key}` }, 'Open ticket'))],
      deploy: () => [h('p', {}, `The deploy pack for “${t.waiting_detail}” is ready in vault/tickets/${key}/07-deploy-pack/${t.waiting_detail}/. Deploy with your tool, then confirm.`), h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => act({ verb: 'deployed', key, org: t.waiting_detail }, 'Recorded. The team now checks parity.') }, `I deployed to ${t.waiting_detail}`), h('a', { href: `#/ticket/${key}` }, 'Open ticket'))],
      question: () => [h('p', {}, 'The Analyst has a blocking question. Open the ticket to read and answer it.'), h('a', { href: `#/ticket/${key}` }, 'Open ticket')],
      not_reproduced: () => [h('p', {}, 'The bug could not be reproduced. Open the ticket to see what was tried and add detail.'), h('a', { href: `#/ticket/${key}` }, 'Open ticket')],
    };
    const stopped = t.status === 'escalated';
    return h('section', { class: `card wait${stopped ? ' stop' : ''}` }, h('div', { class: 'row' }, h('h2', {}, `${key}  ${t.title || ''}`), statusPill(t)),
      stopped ? [h('p', {}, 'The team stopped after the allowed number of attempts. Read the report, then give a direction.'), h('div', { class: 'row' }, h('a', { href: `#/ticket/${key}` }, 'Read the report'))] : (kinds[t.waiting_for] || (() => []))());
  };

  const views = {
    overview() {
      const open = S.tickets.filter((t) => t.status !== 'done');
      const waiting = open.filter((t) => t.status === 'awaiting_human' || t.status === 'escalated');
      const base = S.brain.find((b) => b.org === S.pipeline.brain_base) || {};
      return [head('Overview', `${S.company || ''}: build in ${S.pipeline.build_org}, then ${S.pipeline.targets.map((x) => x.org).join(' → ') || 'no targets'}`),
        h('div', { class: 'grid g4' },
          h('div', { class: 'card stat' }, h('b', {}, open.length), h('span', {}, 'open tickets')),
          h('div', { class: 'card stat' }, h('b', {}, waiting.length), h('span', {}, 'waiting for you')),
          h('div', { class: 'card stat' }, h('b', {}, S.lessons.filter((l) => l.status === 'approved').length), h('span', {}, 'lessons in use')),
          h('div', { class: 'card stat' }, h('b', {}, base.exists ? base.components : '0'), h('span', {}, base.exists ? `components in the Org Brain${base.stale.length ? `, ${base.stale.length} out of date` : ''}` : 'Org Brain not built yet'))),
        waiting.length ? h('div', {}, h('h2', { style: 'margin:22px 0 10px' }, 'Waiting for you'), waiting.map(waitingCard)) : null,
        card('Tickets', table(['Ticket', 'Title', 'Stage', 'Status', 'Path', 'Loops', 'Updated'], S.tickets.map((t) => [h('a', { href: `#/ticket/${t.key}` }, t.key), t.title || '', t.stage, statusPill(t), t.path, t.loops, h('span', { class: 'muted nowrap' }, when(t.updated_at))]), 'No tickets yet. In Claude Code type /orgtomo:ticket <KEY>.'))];
    },

    async ticket(key) {
      const d = await api(`/api/ticket/${encodeURIComponent(key)}`);
      const t = d.ticket;
      const sum = S.tickets.find((x) => x.key === key) || {};
      const cls = (s) => (t.status === 'escalated' && t.stage === s.id ? 'stop' : t.stage === s.id && t.status !== 'done' ? 'now' : t.stages[s.id]?.status === 'done' || t.status === 'done' ? 'done' : '');
      const note = h('textarea', { placeholder: 'Your answer or direction', 'aria-label': 'Your answer or direction' });
      const actions = [];
      if (t.status === 'awaiting_human' && t.await.kind === 'approval') actions.push(h('button', { class: 'primary', onclick: () => act({ verb: 'approve', key }, 'Approved') }, `Approve ${t.await.stage}`), h('button', { class: 'danger', onclick: () => { const n = ask('Why do you reject it?', true); if (n) act({ verb: 'reject', key, note: n }, 'Rejected'); } }, 'Reject…'));
      if (t.status === 'awaiting_human' && t.await.kind === 'deploy') actions.push(h('button', { class: 'primary', onclick: () => act({ verb: 'deployed', key, org: t.await.org }, 'Recorded') }, `I deployed to ${t.await.org}`));
      if (t.status === 'awaiting_human' && ['question', 'not_reproduced'].includes(t.await.kind)) actions.push(h('div', { class: 'grow' }, note), h('button', { class: 'primary', onclick: () => act({ verb: 'answer', key, note: note.value }, 'Answer recorded') }, 'Send answer'));
      if (t.status === 'escalated') actions.push(h('div', { class: 'grow' }, note), h('button', { class: 'primary', onclick: () => act({ verb: 'resume', key, note: note.value }, 'The team continues from the plan') }, 'Continue with this direction'));
      if (t.status === 'hold') actions.push(h('button', { class: 'primary', onclick: () => act({ verb: 'resume', key }, 'Resumed') }, 'Resume'));
      else if (t.status !== 'done') actions.push(h('button', { onclick: () => act({ verb: 'hold', key }, 'On hold') }, 'Put on hold'));
      return [head(`${key}  ${t.title || ''}`, `${t.type || ''} · path ${t.path} · loops ${t.loops} of ${d.next.loop_max}`, statusPill(sum.key ? sum : { status: t.status, waiting_for: t.await?.kind })),
        h('div', { class: 'stages' }, S.stages.filter((s) => s.id !== 'done').map((s) => h('div', { class: `stage ${cls(s)}` }, h('b', {}, s.id), h('small', {}, `${s.owner}${t.stages[s.id]?.attempts > 1 ? ` · ${t.stages[s.id].attempts} attempts` : ''}`)))),
        card('What happens now', h('p', {}, d.next.say || ''), t.await?.details ? h('ul', {}, t.await.details.map((x) => h('li', {}, x))) : null, h('div', { class: 'row', style: 'margin-top:12px' }, actions)),
        t.handoff ? card('Handoff', table(['Org', 'Tool', 'Status'], t.handoff.targets.map((x) => [x.org, x.tool, pill(x.status, x.status === 'verified' ? 'good' : '')]))) : null,
        card('Gate reports and updates', d.reports.length ? d.reports.map((r) => h('details', {}, h('summary', {}, r.name), h('pre', {}, r.text))) : h('p', { class: 'muted' }, 'No reports yet.')),
        card(`Evidence (${d.evidence.length})`, table(['Id', 'Kind', 'Org', 'By', 'When', 'What'], d.evidence.map((e) => [h('code', {}, e.id), e.kind, e.org || '', e.actor, h('span', { class: 'nowrap muted' }, when(e.at)), h('span', {}, e.ok ? '' : pill('failed', 'bad'), ' ', e.summary)]))),
        card('Give feedback', h('p', { class: 'muted' }, 'Recorded as evidence for lessons. Say what you saw, not how you feel about it.'), (() => {
          const agent = select(Object.keys(S.agents), 'builder', () => {}, 'Agent'); const text = h('input', { type: 'text', placeholder: 'What did the agent do well or badly?', 'aria-label': 'Feedback' });
          const send = (kind) => act({ verb: 'feedback', key, kind, agent: agent.value, note: text.value }, 'Feedback recorded');
          return h('div', { class: 'row', style: 'margin-top:10px' }, h('div', { style: 'width:150px' }, agent), h('div', { class: 'grow' }, text), h('button', { onclick: () => send('good') }, 'Good'), h('button', { onclick: () => send('bad') }, 'Bad'));
        })())];
    },

    agents() {
      const roles = { lead: 'Delegates, verifies, reports', analyst: 'Understanding, criteria, examples', reproducer: 'Data-proof reproduction', planner: 'Design and test plan', builder: 'Implements in the build org', tester: 'Tests and retests', reviewer: 'Independent final review', cartographer: 'Org Brain keeper', baseline: 'Backups and before-state', scribe: 'Drafts messages', coach: 'Lessons from evidence', notetaker: 'Meeting notes' };
      return [head('Agents', 'Model and effort per agent. Changes apply from the next Claude Code session.'),
        S.agent_rules.reviewer_differs_from_builder ? null : h('div', { class: 'banner warn' }, 'The rule “Reviewer differs from Builder” is off.'),
        card(null, table(['Agent', 'Does', 'Model', 'Effort', 'On'], Object.entries(S.agents).map(([name, a]) => [h('strong', {}, name), h('span', { class: 'muted' }, roles[name] || ''),
          select([...new Set([...S.models, a.model])], a.model, (v) => setCfg('agents', `agents.${name}.model`, v, `${name}: ${v}`), `${name} model`),
          select(S.efforts, a.effort, (v) => setCfg('agents', `agents.${name}.effort`, v, `${name}: ${v}`), `${name} effort`),
          sw(a.enabled !== false, (v) => setCfg('agents', `agents.${name}.enabled`, v), a.core, `${name} on`)]))),
        toggle('Reviewer runs on a different model from the Builder', 'A second model catches what the first one misses. Recommended on.', S.agent_rules.reviewer_differs_from_builder, (v) => setCfg('agents', 'rules.reviewer_differs_from_builder', v))];
    },

    safety() {
      const listEditor = (title, hint, items, path) => {
        const input = h('input', { type: 'text', placeholder: hint, 'aria-label': title });
        const add = () => { if (input.value.trim()) setCfg('safety', path, [...items, input.value.trim()]); };
        return card(title, h('div', { class: 'chips' }, items.length ? items.map((x) => h('span', { class: 'chip' }, x, h('button', { title: `Remove ${x}`, onclick: () => setCfg('safety', path, items.filter((y) => y !== x)) }, '×'))) : h('span', { class: 'muted' }, 'None')),
          h('div', { class: 'row', style: 'margin-top:12px' }, h('div', { class: 'grow' }, input), h('button', { onclick: add }, 'Add')));
      };
      return [head('Safety', 'Production is read-only and masked. That rule has no switch.'),
        card('Orgs', table(['Org', 'Alias', 'Role', 'What agents may do', 'E-mail check'], S.orgs.map((o) => [h('strong', {}, o.name), h('code', {}, o.alias), pill(o.role, o.role === 'production' ? 'bad' : o.role === 'build' ? 'good' : ''),
          { production: 'Read only, masked', build: 'Build, deploy, test data', test: 'Retest with test data; humans deploy', reference: 'Read only' }[o.role],
          o.role === 'production' ? h('span', { class: 'muted' }, 'not applicable') : h('div', { class: 'row' }, pill(o.canary ? o.canary.status : 'not checked', o.canary?.status === 'blocked' ? 'good' : 'warn'),
            h('button', { class: 'small', title: 'Setup > Deliverability shows No access or System email only', onclick: () => act({ verb: 'canary', org: o.name, status: 'blocked' }) }, 'Mail is off'), h('button', { class: 'small', onclick: () => act({ verb: 'canary', org: o.name, status: 'enabled' }) }, 'Mail is on'))])),
        h('p', { class: 'muted', style: 'margin-top:10px' }, 'Orgs are edited in orgtomo.config/orgs.yaml. The first write to a sandbox asks the org itself whether it is one.')),
        h('div', { class: 'grid g2' },
          card('E-mail mode', h('div', { class: 'field' }, select(['blocked', 'allowlist_only'], S.safety.email_mode, (v) => setCfg('safety', 'email_mode', v), 'E-mail mode')),
            h('p', { class: 'muted', style: 'margin-top:8px' }, S.safety.email_mode === 'blocked' ? 'Agents write test data only while the sandbox cannot send e-mail.' : 'Sandbox may send e-mail; only the allowed addresses may ever appear in data.')),
          card('How often to stop for you', h('div', { class: 'field' }, h('label', {}, 'Autonomy'), select(['low', 'medium', 'high'], S.pipeline.autonomy, (v) => setCfg('pipeline', 'autonomy', v), 'Autonomy')),
            h('div', { class: 'field' }, h('label', {}, 'Loops before the team stops (hard cap 3)'), select(['0', '1', '2', '3'], String(S.pipeline.loop_max), (v) => setCfg('pipeline', 'loop.max', Number(v)), 'Loop limit')),
            h('p', { class: 'muted', style: 'margin-top:8px' }, `Approval after: ${S.pipeline.approvals.join(', ')}`))),
        h('div', { class: 'grid g2' }, listEditor('Allowed test e-mail addresses', 'you+*@example.com', S.safety.allowed_emails || [], 'allowed_emails'), listEditor('Allowed test phone numbers', '+15555550100', S.safety.allowed_phones || [], 'allowed_phones')),
        toggle('Mask sandbox reads', 'Sandboxes often hold copies of real customer data. Keep this on unless your sandbox data is synthetic.', S.safety.mask_sandbox_reads, (v) => setCfg('safety', 'mask.mask_sandbox_reads', v))];
    },

    features() {
      const f = S.features;
      return [head('Features', 'Everything optional has a switch here.'),
        h('div', { class: 'grid g2' },
          toggle('Lite path', 'Small, low-risk configuration changes take a lighter reproduction and review. Gates and safety stay the same.', f.lite_path, (v) => setCfg('features', 'lite_path', v)),
          toggle('Self-learning', 'Record real mistakes and good results, and turn them into lessons for each agent.', f.self_learning.enabled, (v) => setCfg('features', 'self_learning.enabled', v)),
          toggle('Salesforce Flow generator', 'Creates new flows through a Salesforce-hosted service. Build org only.', f.sf_skills.flow_generator, (v) => setCfg('features', 'sf_skills.flow_generator', v)),
          toggle('Salesforce plugin telemetry', 'Usage telemetry of the Salesforce skills plugin. Off by default.', f.sf_skills.telemetry, (v) => setCfg('features', 'sf_skills.telemetry', v)),
          toggle('People profiles', 'Fit drafts to each reader: role, Salesforce knowledge, level of detail.', f.people_profiles.enabled, (v) => setCfg('features', 'people_profiles.enabled', v)),
          toggle('Claude in Chrome', 'Opt-in, in a separate Chrome profile only. What it sees is never accepted as evidence.', S.safety.claude_in_chrome, (v) => setCfg('safety', 'browser.claude_in_chrome', v))),
        card('Meeting notes', h('div', { class: 'toggle' }, h('div', {}, h('p', {}, 'Bring decisions from meetings into the vault and attach them to the tickets they name.')), sw(f.meetings.enabled, (v) => setCfg('features', 'meetings.enabled', v), false, 'Meeting notes')),
          h('div', { class: 'grid g2', style: 'margin-top:14px' }, h('div', {}, h('label', {}, 'Where your meetings are'), select(['granola', 'zoom', 'google-meet', 'file'], f.meetings.provider, (v) => setCfg('features', 'meetings.provider', v), 'Provider')),
            h('div', { class: 'toggle' }, h('div', {}, h('h3', {}, 'Read transcripts'), h('p', {}, 'Off: notes and decisions only.')), sw(f.meetings.store_transcripts, (v) => setCfg('features', 'meetings.store_transcripts', v), false, 'Read transcripts'))),
          h('p', { class: 'muted', style: 'margin-top:10px' }, 'Zoom and Google Meet: add your connector’s tools under meetings.read in capabilities.yaml, or drop exported notes into vault/meetings/inbox/ and choose “file”.'))];
    },

    brain() {
      return [head('Org Brain', 'The map of each org, generated from metadata. Open the vault folder in Obsidian to browse it.'),
        card(null, table(['Org', 'Status', 'Components', 'Built', 'Out of date'], S.brain.map((b) => [h('strong', {}, b.org), b.exists ? pill('built', b.stale.length ? 'warn' : 'good') : pill('not built', 'plain'), b.components ?? '', when(b.built_at), b.exists ? b.stale.length : '']))),
        card('Build or refresh', h('p', {}, 'In Claude Code: ', h('code', {}, `/orgtomo:brain build ${S.pipeline.brain_base}`), '   or in a terminal:'), h('pre', { style: 'margin-top:10px' }, `orgtomo brain retrieve ${S.pipeline.brain_base}\norgtomo brain build ${S.pipeline.brain_base}`))];
    },

    learning() {
      const lessonRow = (l) => [h('code', {}, l.id), l.agent, pill(l.type === 'avoid' ? 'do not repeat' : 'keep doing', l.type === 'avoid' ? 'warn' : 'good'), l.rule, pill(`${l.status}${l.approved_by ? ` · ${l.approved_by}` : ''}`, l.status === 'approved' ? 'good' : l.status === 'retired' ? 'plain' : 'warn'), l.observations.length,
        l.recurrences ? pill(`${l.recurrences}×`, 'bad') : '0', h('div', { class: 'row' }, l.status !== 'approved' && h('button', { class: 'small primary', onclick: () => act({ verb: 'lesson', id: l.id, status: 'approved' }, 'Lesson applied') }, 'Apply'), l.status !== 'retired' && h('button', { class: 'small', onclick: () => act({ verb: 'lesson', id: l.id, status: 'retired' }, 'Lesson retired') }, 'Retire'))];
      return [head('Learning', 'Only things that really happened are recorded. Every lesson cites its evidence.'),
        card('Lessons', table(['Id', 'Agent', 'Kind', 'Rule', 'Status', 'Evidence', 'Repeated after', ''], S.lessons.map(lessonRow), 'No lessons yet. They appear after real tickets.')),
        card('What keeps happening', table(['Agent', 'What', 'Kind', 'Times', 'Tickets'], S.patterns.map((p) => [p.agent, h('code', {}, p.signature), pill(p.kind, p.kind === 'mistake' ? 'warn' : p.kind === 'good' ? 'good' : ''), p.count, p.tickets.join(', ')]))),
        card('Recent observations', table(['Id', 'When', 'Ticket', 'Agent', 'Source', 'Fact'], S.observations.map((o) => [h('code', {}, o.id), h('span', { class: 'nowrap muted' }, when(o.at)), o.ticket ? h('a', { href: `#/ticket/${o.ticket}` }, o.ticket) : '', o.agent, o.source, o.fact])))];
    },

    people() {
      if (!S.people.enabled) return [head('People', 'Reader profiles for tailored drafts.'), toggle('People profiles are off', 'Turn on to store role, Salesforce knowledge and preferred level of detail for colleagues and clients. Nothing personal is stored.', false, (v) => setCfg('features', 'people_profiles.enabled', v))];
      const f = { name: h('input', { type: 'text', 'aria-label': 'Name' }), role: h('input', { type: 'text', 'aria-label': 'Role' }), company: h('input', { type: 'text', 'aria-label': 'Company' }), side: select(['internal', 'client', 'partner'], 'internal', () => {}, 'Side'), sk: select(['none', 'basic', 'admin', 'developer', 'architect'], 'basic', () => {}, 'Salesforce knowledge'), dl: select(['short', 'medium', 'detailed'], 'medium', () => {}, 'Detail level'), prefers: h('input', { type: 'text', placeholder: 'separate with ;', 'aria-label': 'Prefers' }), avoid: h('input', { type: 'text', placeholder: 'separate with ;', 'aria-label': 'Avoid' }) };
      const split = (v) => v.split(';').map((x) => x.trim()).filter(Boolean);
      const save = () => act({ verb: 'person', name: f.name.value, fields: { role: f.role.value || undefined, company: f.company.value || undefined, side: f.side.value, salesforce_knowledge: f.sk.value, detail_level: f.dl.value, prefers: split(f.prefers.value), avoid: split(f.avoid.value) } }, 'Profile saved');
      const field = (label, el) => h('div', {}, h('label', {}, label), el);
      return [head('People', 'How each reader likes to be written to. Work communication only.'),
        S.people.proposals.length ? card('Suggested by the team (from meetings)', table(['Person', 'Note', 'Seen in', ''], S.people.proposals.map((p) => [p.person, p.note, p.basis, h('div', { class: 'row' }, h('button', { class: 'small primary', onclick: () => act({ verb: 'proposal', id: p.id }) }, 'Add to “prefers”'), h('button', { class: 'small', onclick: () => act({ verb: 'proposal', id: p.id, as: 'avoid' }) }, 'Add to “avoid”'), h('button', { class: 'small', onclick: () => act({ verb: 'proposal', id: p.id, accept: false }) }, 'Dismiss'))]))) : null,
        card('Profiles', table(['Name', 'Side', 'Role', 'Salesforce', 'Detail', 'Prefers', ''], S.people.list.map((p) => [h('strong', {}, p.name), p.side, [p.role, p.company].filter(Boolean).join(', '), p.salesforce_knowledge || '', p.detail_level || '', (p.prefers || []).join('; '), h('button', { class: 'small danger', onclick: () => { if (window.confirm(`Remove the profile of ${p.name}?`)) act({ verb: 'person-remove', name: p.name }); } }, 'Remove')]), 'No profiles yet.')),
        card('Add or update a profile', h('div', { class: 'grid g3' }, field('Name', f.name), field('Role', f.role), field('Company', f.company), field('Side', f.side), field('Salesforce knowledge', f.sk), field('Detail level', f.dl)), h('div', { class: 'grid g2', style: 'margin-top:12px' }, field('Prefers', f.prefers), field('Avoid', f.avoid)), h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'primary', onclick: save }, 'Save profile')))];
    },

    meetings() {
      if (!S.meetings.enabled) return [head('Meetings', 'Decisions from meetings, attached to tickets.'), toggle('Meeting notes are off', 'Turn on and choose where your meetings live under Features.', false, (v) => setCfg('features', 'meetings.enabled', v))];
      return [head('Meetings', 'Notes are brought in when a session starts, or with /orgtomo:meetings.'),
        S.meetings.pending.length ? card('Does this meeting concern this ticket?', table(['Meeting', 'Ticket', 'Update', 'Why suggested', ''], S.meetings.pending.map((p) => [`${p.date.slice(0, 10)} ${p.title}`, h('code', {}, p.key), p.update, p.reason, h('div', { class: 'row' }, h('button', { class: 'small primary', onclick: () => act({ verb: 'meeting-link', id: p.id }, 'Attached to the ticket') }, 'Yes, attach'), h('button', { class: 'small', onclick: () => act({ verb: 'meeting-link', id: p.id, accept: false }) }, 'No'))]))) : null,
        card('Stored meetings', table(['Date', 'Title', 'From', 'Tickets'], S.meetings.list.map((x) => [x.date.slice(0, 10), x.title, x.provider, x.tickets.map((k) => h('a', { href: `#/ticket/${k}`, style: 'margin-right:8px' }, k))]), 'No meetings stored yet.'))];
    },

    async health() {
      const d = await api('/api/doctor');
      const kind = { ok: 'good', warn: 'warn', fail: 'bad', info: 'plain' };
      return [head('Health', 'What is working and what needs attention.', h('button', { onclick: async () => { toast('Contacting orgs…'); const r = await api('/api/doctor?orgs=1').catch((e) => { toast(e.message, true); }); if (r) { document.getElementById('main').replaceChildren(...[head('Health', 'Including a live check of every org.'), card(null, table(['', 'Check', 'Fix'], r.checks.map((c) => [pill(c.level, kind[c.level]), c.message, c.fix ? h('code', {}, c.fix) : ''])))]); } } }, 'Also check the orgs'), h('button', { onclick: () => act({ verb: 'sync' }, 'Regenerated') }, 'Regenerate agent files')),
        card(null, table(['', 'Check', 'Fix'], d.checks.map((c) => [pill(c.level, kind[c.level]), c.message, c.fix ? h('code', {}, c.fix) : ''])))];
    },
  };

  // ---------------------------------------------------------------- shell

  const NAV = [['overview', 'Overview'], ['agents', 'Agents'], ['safety', 'Safety'], ['features', 'Features'], ['brain', 'Org Brain'], ['learning', 'Learning'], ['people', 'People'], ['meetings', 'Meetings'], ['health', 'Health']];
  async function render() {
    const [, section = 'overview', arg] = location.hash.split('/');
    const view = views[section] ? section : 'overview';
    const counts = { overview: S.tickets.filter((t) => t.status === 'awaiting_human' || t.status === 'escalated').length, learning: S.lessons.filter((l) => l.status === 'proposed').length, people: S.people.proposals.length, meetings: S.meetings.pending.length };
    document.getElementById('nav').replaceChildren(...NAV.map(([id, label]) => h('a', { href: `#/${id}`, class: id === view || (view === 'ticket' && id === 'overview') ? 'on' : '', 'aria-current': id === view ? 'page' : null }, label, counts[id] ? h('span', { class: 'count' }, counts[id]) : null)));
    document.getElementById('company').textContent = S.company || '';
    document.getElementById('foot').textContent = `Build: ${S.pipeline.build_org} · Brain: ${S.pipeline.brain_base}`;
    const main = document.getElementById('main');
    try {
      const body = await views[view](arg && decodeURIComponent(arg));
      const banners = [S.errors.length && h('div', { class: 'banner bad' }, h('strong', {}, 'Configuration problems. Nothing runs until they are fixed.'), h('ul', {}, S.errors.map((e) => h('li', {}, e)))), ...S.warnings.map((w) => h('div', { class: 'banner warn' }, w))];
      main.replaceChildren(...banners.filter(Boolean), ...body.flat(Infinity).filter(Boolean));
    } catch (e) { main.replaceChildren(h('div', { class: 'banner bad' }, e.message)); }
  }
  async function load() {
    try { S = await api('/api/state'); await render(); } catch (e) { document.getElementById('main').replaceChildren(h('div', { class: 'pad' }, h('div', { class: 'banner bad' }, e.message))); }
  }
  window.addEventListener('hashchange', () => S && render());
  load();
})();

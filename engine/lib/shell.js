// Shell command analysis for the policy guard. It does not execute anything.
// The goal is to see every simple command inside a compound line and to
// notice constructs that hide what will really run.

const WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'nice', 'stdbuf', 'npx', 'pnpm', 'yarn', 'bunx']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

/**
 * Split a command line into simple commands.
 * @param {string} command
 * @returns {{ segments: {argv: string[], env: Record<string,string>, redirects: string[], raw: string}[], dynamic: boolean, problems: string[] }}
 */
export function analyze(command, depth = 0) {
  const result = { segments: [], dynamic: false, problems: [], scripts: [], heredocs: [], text: command };
  if (depth > 3) { result.problems.push('nested shells too deep'); return result; }
  const pre = stripHeredocs(command);
  result.heredocs = pre.heredocs;
  result.problems.push(...pre.problems);
  result.text = pre.text;
  command = pre.text;
  if (/`|\$\(|<\(|>\(/.test(stripSingleQuoted(command))) result.dynamic = true;
  // An unquoted here-document is expanded by the shell, so substitutions inside it run.
  if (pre.heredocs.some((h) => !h.quoted && /`|\$\(/.test(h.body))) result.dynamic = true;
  if (pre.heredocs.length) result.heredoc = true;

  let argv = [];
  let redirects = [];
  let cur = '';
  let has = false;
  let rawStart = 0;
  const pushTok = () => { if (has) { argv.push(cur); cur = ''; has = false; } };
  const endSeg = (i) => {
    pushTok();
    if (argv.length) result.segments.push(finish(argv, redirects, command.slice(rawStart, i).trim(), result, depth));
    argv = []; redirects = []; rawStart = i + 1;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && i + 1 < command.length) { cur += command[++i]; has = true; continue; }
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      if (j < 0) { result.problems.push('unterminated quote'); break; }
      cur += command.slice(i + 1, j); has = true; i = j; continue;
    }
    if (c === '"') {
      let j = i + 1; let s = '';
      while (j < command.length && command[j] !== '"') { if (command[j] === '\\' && j + 1 < command.length) j++; s += command[j++]; }
      if (j >= command.length) { result.problems.push('unterminated quote'); break; }
      cur += s; has = true; i = j; continue;
    }
    if (c === '\n' || c === ';') { endSeg(i); continue; }
    if (c === '&' || c === '|') {
      if (command[i + 1] === c) { endSeg(i); i++; rawStart = i + 1; continue; }
      if (c === '&' && (command[i + 1] === '>' || command[i - 1] === '>')) { cur += c; has = true; continue; }
      endSeg(i); continue;
    }
    if (c === '>' || c === '<') {
      pushTok();
      let j = i; while (command[j] === '>' || command[j] === '<' || command[j] === '&') j++;
      const op = command.slice(i, j);
      while (command[j] === ' ') j++;
      let k = j; let target = '';
      while (k < command.length && !/[\s;&|]/.test(command[k])) target += command[k++];
      if (op.startsWith('>')) redirects.push(target.replace(/^['"]|['"]$/g, ''));
      i = k - 1; continue;
    }
    if (/\s/.test(c)) { pushTok(); continue; }
    cur += c; has = true;
  }
  endSeg(command.length);
  return result;
}

function finish(argv, redirects, raw, result, depth) {
  const env = {};
  let a = [...argv];
  for (;;) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(a[0] || '');
    if (m) { env[m[1]] = m[2]; a.shift(); continue; }
    if (WRAPPERS.has(base(a[0]))) {
      a.shift();
      while (a[0]?.startsWith('-')) a.shift();
      continue;
    }
    break;
  }
  const name = base(a[0]);
  if (SHELLS.has(name)) {
    const ci = a.findIndex((t) => /^-[a-z]*c[a-z]*$/.test(t));
    if (ci >= 0 && a[ci + 1]) {
      const inner = analyze(a[ci + 1], depth + 1);
      result.segments.push(...inner.segments);
      result.problems.push(...inner.problems);
      result.dynamic ||= inner.dynamic;
      result.scripts.push(...inner.scripts);
    } else if (a.length === 1) result.dynamic = true; // a bare shell reads commands from stdin
    else (result.scripts ||= []).push(a.find((t, i) => i > 0 && !t.startsWith('-')));
  }
  if (name === 'eval' || name === 'source' || name === '.') result.dynamic = true;
  if (name === 'xargs' || name === 'watch' || name === 'timeout') {
    let rest = a.slice(1);
    while (rest[0]?.startsWith('-') || /^\d+[smh]?$/.test(rest[0] || '')) rest.shift();
    if (rest.length) result.segments.push({ argv: rest, env: {}, redirects: [], raw: rest.join(' '), viaXargs: name === 'xargs' });
  }
  return { argv: a, env, redirects, raw };
}

export const base = (p) => (p || '').split('/').pop();
const stripSingleQuoted = (s) => s.replace(/'[^']*'/g, "''");
/** Same length as the input, with everything inside quotes replaced by spaces. */
const blankQuoted = (s) => s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + (m.length > 1 ? m[0] : ''));

/**
 * Take here-document bodies out of a command. A body is input for the command
 * on the line above it; it is never a command itself. A quoted delimiter
 * (<<'EOF') means the shell passes the body through untouched.
 * @returns {{text: string, heredocs: {tag: string, quoted: boolean, body: string}[], problems: string[]}}
 */
export function stripHeredocs(command) {
  const lines = String(command).split('\n');
  const out = [];
  const heredocs = [];
  const problems = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    // Only an operator outside quotes starts a here-document. The delimiter may itself be quoted.
    const blank = blankQuoted(lines[i]);
    const real = [...lines[i].matchAll(/(?<!<)<<(?!<)(-?)\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/g)]
      .filter((m) => blank.slice(m.index, m.index + 2) === '<<');
    for (const m of real) {
      const tag = m[2] || m[3] || m[4];
      const body = [];
      let closed = false;
      while (++i < lines.length) {
        if ((m[1] ? lines[i].replace(/^\t+/, '') : lines[i]) === tag) { closed = true; break; }
        body.push(lines[i]);
      }
      if (!closed) problems.push('unterminated here-document');
      heredocs.push({ tag, quoted: Boolean(m[2] || m[3]), body: body.join('\n') });
    }
  }
  return { text: out.join('\n'), heredocs, problems };
}

/** Read `--flag value`, `--flag=value` or `-f value` from argv. Returns undefined when absent. */
export function flag(argv, ...names) {
  for (let i = 0; i < argv.length; i++) {
    for (const n of names) {
      if (argv[i] === n) return argv[i + 1] ?? '';
      if (argv[i].startsWith(n + '=')) return argv[i].slice(n.length + 1);
    }
  }
  return undefined;
}
/** All values of a repeatable flag. */
export function flags(argv, ...names) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    for (const n of names) {
      if (argv[i] === n) {
        let j = i + 1;
        while (j < argv.length && !argv[j].startsWith('-')) out.push(argv[j++]);
      } else if (argv[i].startsWith(n + '=')) out.push(argv[i].slice(n.length + 1));
    }
  }
  return out;
}
/** Leading words before the first flag: `sf data query -q x` -> ['data','query']. */
export const topic = (argv) => {
  const out = [];
  for (const t of argv.slice(1)) { if (t.startsWith('-')) break; out.push(t); }
  return out;
};

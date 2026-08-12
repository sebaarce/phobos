'use strict';
/*
 * Phobos enforcement hooks — shared helpers (SPEC §7.2.2, §7.5).
 * Plain CommonJS with ZERO dependencies: these scripts run standalone via
 * `node` inside arbitrary user repos (.cjs keeps them immune to the host
 * repo's "type": "module").
 */
const fs = require('fs');
const path = require('path');

/** Read the whole stdin and parse it as JSON. Rejects on malformed input. */
function readStdinJson() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('el payload de stdin no es JSON válido: ' + err.message));
      }
    });
    process.stdin.on('error', reject);
  });
}

/**
 * Append one JSON line to <projectDir>/.claude/audit/<YYYY-MM-DD>.jsonl.
 * Never throws: auditing must not break the hook that called it.
 */
function auditWrite(projectDir, entry) {
  try {
    const dir = path.join(projectDir, '.claude', 'audit');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const file = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.jsonl';
    fs.appendFileSync(path.join(dir, file), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* intentionally swallowed */
  }
}

function truncate(text, max) {
  const s = String(text == null ? '' : text);
  const n = typeof max === 'number' ? max : 200;
  return s.length > n ? s.slice(0, n) : s;
}

const INDIRECTION_PREFIXES = new Set(['command', 'env', 'nice', 'nohup', 'time']);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*/;

/**
 * SPEC §7.2.2 normalization pipeline for Bash commands:
 * 1. trim + collapse repeated whitespace
 * 2. strip indirection prefixes (\, command, env, nice, nohup, time) and
 *    leading VAR=val assignments (collected into `assignments`)
 * 3. split into segments on ; && || | & and newlines
 * 4. extract write targets: > / >> redirections, tee, sed -i, -o/--output,
 *    cp/mv/install/rsync destination
 * Splitting is quote-blind on purpose: over-splitting quoted strings can only
 * produce MORE segments to test, never fewer (deny-safe).
 */
function normalizeCommand(rawCommand) {
  const assignments = [];
  const collapsed = String(rawCommand == null ? '' : rawCommand)
    .trim()
    .replace(/[ \t]+/g, ' ');
  const pieces = collapsed
    .split(/\s*(?:\|\||&&|;|\||&|\r?\n|\r)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const segments = [];
  for (const piece of pieces) {
    const stripped = stripIndirection(piece, assignments);
    if (stripped.length > 0) segments.push(stripped);
  }
  const writeTargets = [];
  for (const seg of segments) {
    for (const t of extractWriteTargets(seg)) writeTargets.push(t);
  }
  return { segments, writeTargets, assignments };
}

function stripIndirection(segment, assignments) {
  let seg = segment;
  for (;;) {
    if (seg.startsWith('\\')) {
      seg = seg.slice(1);
      continue;
    }
    const assignment = ASSIGNMENT_RE.exec(seg);
    if (assignment) {
      assignments.push(assignment[0]);
      seg = seg.slice(assignment[0].length).trim();
      continue;
    }
    const spaceIdx = seg.indexOf(' ');
    const first = (spaceIdx === -1 ? seg : seg.slice(0, spaceIdx)).toLowerCase();
    if (spaceIdx !== -1 && INDIRECTION_PREFIXES.has(first)) {
      seg = seg.slice(spaceIdx + 1).trim();
      continue;
    }
    return seg;
  }
}

function stripQuotes(token) {
  return token.replace(/^['"]+|['"]+$/g, '');
}

function extractWriteTargets(segment) {
  const targets = [];
  const redirection = />{1,2}\s*([^\s;|&<>]+)/g;
  let m;
  while ((m = redirection.exec(segment)) !== null) {
    const target = stripQuotes(m[1]);
    // `>&2`-style fd duplication is not a file write.
    if (target && !target.startsWith('&')) targets.push(target);
  }
  const tokens = segment.split(' ').filter(Boolean);
  const cmd = (tokens[0] || '').toLowerCase();
  if (cmd === 'tee') {
    for (const t of tokens.slice(1)) {
      if (!t.startsWith('-') && !t.startsWith('>')) targets.push(stripQuotes(t));
    }
  }
  if (cmd === 'sed' && tokens.some((t) => /^(-i|--in-place)/.test(t))) {
    // First non-flag argument is the sed script; the rest are edited files.
    const nonFlags = tokens.slice(1).filter((t) => !t.startsWith('-') && !t.startsWith('>'));
    for (const t of nonFlags.slice(1)) {
      const clean = stripQuotes(t);
      if (clean) targets.push(clean);
    }
  }
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-o' || t === '--output') {
      const next = tokens[i + 1];
      if (next && !next.startsWith('-')) targets.push(stripQuotes(next));
    } else if (t.startsWith('--output=')) {
      const value = stripQuotes(t.slice('--output='.length));
      if (value) targets.push(value);
    }
  }
  if (cmd === 'cp' || cmd === 'mv' || cmd === 'install' || cmd === 'rsync') {
    const nonFlags = tokens.slice(1).filter((t) => !t.startsWith('-') && !t.startsWith('>'));
    if (nonFlags.length >= 2) targets.push(stripQuotes(nonFlags[nonFlags.length - 1]));
  }
  return targets;
}

/**
 * Glob semantics fixed by SPEC §7.3: `**` crosses '/', `*` does not, dotfiles
 * ARE matched, backslashes normalize to '/', case-insensitive on win32.
 */
function globToRegExp(pattern) {
  let p = String(pattern).replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  let source = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 3;
        } else {
          source += '.*';
          i += 2;
        }
      } else {
        source += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      source += '[^/]';
      i += 1;
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp('^' + source + '$', process.platform === 'win32' ? 'i' : '');
}

function globMatch(pattern, filePath) {
  let f = String(filePath == null ? '' : filePath).replace(/\\/g, '/');
  if (f.startsWith('./')) f = f.slice(2);
  return globToRegExp(pattern).test(f);
}

/** Make an absolute path relative to projectDir when it lives inside it. */
function toProjectRelative(projectDir, filePath) {
  let f = String(filePath == null ? '' : filePath).replace(/\\/g, '/');
  let root = String(projectDir == null ? '' : projectDir).replace(/\\/g, '/');
  if (root && !root.endsWith('/')) root += '/';
  const insensitive = process.platform === 'win32';
  const fCmp = insensitive ? f.toLowerCase() : f;
  const rootCmp = insensitive ? root.toLowerCase() : root;
  if (root && fCmp.startsWith(rootCmp)) return f.slice(root.length);
  if (f.startsWith('./')) return f.slice(2);
  return f;
}

module.exports = {
  readStdinJson,
  auditWrite,
  truncate,
  normalizeCommand,
  globMatch,
  globToRegExp,
  toProjectRelative,
};
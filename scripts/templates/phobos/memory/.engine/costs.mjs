#!/usr/bin/env node
// Generates vault/memory/tasks/<slug>/costs.md from `opencode stats` output.
//
// Strategy:
//   1. Validate slug.
//   2. Read README.md → extract `Opened-At`.
//   3. Run `opencode stats --project '' --days 1 --models`, parse the ASCII output.
//   4. Read .opencode/agent/*.md frontmatter to map agent→model for per-agent attribution.
//   5. Write costs.md. If `opencode stats` fails or parses to nothing, write the fallback.
//
// Usage:
//   node vault/memory/.engine/costs.mjs <slug>
//   node vault/memory/.engine/costs.mjs <slug> --json   # print parsed data instead of writing
//
// Exit codes:
//   0 = costs.md written (real or fallback).
//   1 = invalid slug / README missing / wrote nothing.
//
// Read-only of agent files + the README; the only write is costs.md inside the task dir.

import { readFile, readdir, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const AGENT_DIR = join(PROJECT_ROOT, '.opencode', 'agent');
const TASKS_DIR = join(PROJECT_ROOT, 'vault', 'memory', 'tasks');

const SLUG_RE = /^[a-zA-Z0-9_-]{3,60}$/;
const KNOWN_AGENTS = ['phobos', 'researcher', 'planner', 'programmer', 'tester', 'archivist'];

function parseArgs(argv) {
  const args = { slug: null, json: false };
  for (const a of argv) {
    if (a === '--json') args.json = true;
    else if (!args.slug && !a.startsWith('--')) args.slug = a;
  }
  return args;
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

function isoNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function diffDuration(openedAt, closedAt) {
  try {
    const a = new Date(openedAt.replace(' ', 'T'));
    const b = new Date(closedAt.replace(' ', 'T'));
    const ms = b.getTime() - a.getTime();
    if (!Number.isFinite(ms) || ms < 0) return '?';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  } catch { return '?'; }
}

// Strip ANSI color codes that opencode may emit even with non-TTY stdout.
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

async function readOpenedAt(slug) {
  const readmePath = join(TASKS_DIR, slug, 'README.md');
  if (!await fileExists(readmePath)) return null;
  const raw = await readFile(readmePath, 'utf-8');
  const m = raw.match(/^\*\*Opened-At:\*\*\s*(.+)$/m);
  if (m) return m[1].trim();
  // Fallback: try plain `Opened:` if archivist didn't write Opened-At yet.
  const m2 = raw.match(/^\*\*Opened:\*\*\s*(.+)$/m);
  return m2 ? m2[1].trim() + ' 00:00:00' : null;
}

async function readAgentModels() {
  const map = {};
  if (!await fileExists(AGENT_DIR)) return map;
  for (const agent of KNOWN_AGENTS) {
    const p = join(AGENT_DIR, `${agent}.md`);
    if (!await fileExists(p)) continue;
    try {
      const raw = await readFile(p, 'utf-8');
      const m = raw.match(/^model:\s*(.+)$/m);
      if (m) map[agent] = m[1].trim();
    } catch {}
  }
  return map;
}

function runStats(cmd) {
  // shell:true so Windows resolves opencode.cmd / opencode.exe via PATH the same way
  // a user terminal would. The command is a constant — no injection surface.
  const r = spawnSync(cmd, { encoding: 'utf-8', timeout: 15000, shell: true });
  if (r.error || r.status !== 0) {
    return { ok: false, stderr: (r.stderr || '') + (r.error ? `\n${r.error.message}` : '') };
  }
  return { ok: true, stdout: stripAnsi(r.stdout || '') };
}

function runOpencodeStats() {
  // Step 1: try filtered to current project (the natural per-task scope).
  const filtered = runStats('opencode stats --project "" --days 1 --models');
  if (!filtered.ok) return { ...filtered, scope: 'none' };

  // If the filtered result shows 0 sessions, opencode couldn't bind the cwd to a
  // tracked project. Fall back to global stats and let the report annotate the scope.
  const parsedFiltered = parseStats(filtered.stdout);
  const filteredSessions = Number((parsedFiltered.overview.sessions || '0').replace(/[^\d.]/g, ''));
  if (filteredSessions > 0) {
    return { ok: true, stdout: filtered.stdout, scope: 'project' };
  }

  const global = runStats('opencode stats --days 1 --models');
  if (!global.ok) return { ...global, scope: 'none' };
  return { ok: true, stdout: global.stdout, scope: 'global' };
}

// Parse the ASCII table output from `opencode stats --models`. The format is
// brittle (depends on opencode's CLI presentation) — we look for known labels
// per line and extract the trailing value, ignoring borders.
function parseStats(raw) {
  const out = {
    overview: {},      // Sessions / Messages / Days
    aggregate: {},     // Total Cost / Input / Output / Cache Read / Cache Write / etc.
    models: [],        // [{ id, messages, input, output, cacheRead, cacheWrite, cost }]
  };
  const lines = raw.split(/\r?\n/);

  // Strip leading `│` and trailing `│ ` and the column padding.
  function unbox(line) {
    return line.replace(/^[│|]\s?/, '').replace(/\s*[│|]\s*$/, '').trimEnd();
  }
  function valueOf(line) {
    // After the label, the value sits at the right edge before the box border.
    const inner = unbox(line);
    const m = inner.match(/\s{2,}(\S+)$/);
    return m ? m[1] : null;
  }
  function labelOf(line) {
    const inner = unbox(line);
    const m = inner.match(/^(.+?)\s{2,}\S+$/);
    return m ? m[1].trim() : null;
  }

  let section = null;       // 'OVERVIEW' | 'COST & TOKENS' | 'BY MODEL' | null
  let currentModel = null;  // model block being filled

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) { continue; }
    if (/^[┌├└─]+/.test(line) || /^[│|][\s─]+[│|]?$/.test(line)) {
      // border or separator — flush current model if we were building one
      continue;
    }
    // Detect section titles inside box (e.g. │       OVERVIEW       │)
    const titleMatch = unbox(line).trim();
    if (/^OVERVIEW$/i.test(titleMatch))      { section = 'OVERVIEW'; currentModel = null; continue; }
    if (/^COST\s*&\s*TOKENS$/i.test(titleMatch)) { section = 'AGG'; currentModel = null; continue; }
    if (/^MODEL\s*USAGE$/i.test(titleMatch)) { section = 'MODELS'; currentModel = null; continue; }
    if (/^BY\s*MODEL$/i.test(titleMatch))    { section = 'MODELS'; currentModel = null; continue; }
    if (/^TOOL\s*USAGE$/i.test(titleMatch))  { section = 'TOOLS'; currentModel = null; continue; }

    if (section === 'OVERVIEW') {
      const label = labelOf(line), val = valueOf(line);
      if (!label || !val) continue;
      if (/sessions/i.test(label)) out.overview.sessions = val;
      else if (/messages/i.test(label)) out.overview.messages = val;
      else if (/days/i.test(label)) out.overview.days = val;
    } else if (section === 'AGG') {
      const label = labelOf(line), val = valueOf(line);
      if (!label || !val) continue;
      if (/total\s*cost/i.test(label)) out.aggregate.totalCost = val;
      else if (/avg\s*cost\/day/i.test(label)) out.aggregate.avgCostPerDay = val;
      else if (/^input$/i.test(label)) out.aggregate.input = val;
      else if (/^output$/i.test(label)) out.aggregate.output = val;
      else if (/cache\s*read/i.test(label)) out.aggregate.cacheRead = val;
      else if (/cache\s*write/i.test(label)) out.aggregate.cacheWrite = val;
    } else if (section === 'MODELS' || section === 'TOOLS') {
      if (section === 'TOOLS') continue;
      const inner = unbox(line);
      // Metric line: has `<label>   <value>` pattern (label + 2+ spaces + value).
      // Model header line: usually a bare model id, no trailing metric value.
      const hasMetricShape = /\S\s{2,}\S+\s*$/.test(inner);
      if (!hasMetricShape) {
        // Treat as a new model block header.
        currentModel = { id: inner.trim(), messages: null, input: null, output: null, cacheRead: null, cacheWrite: null, cost: null };
        out.models.push(currentModel);
      } else if (currentModel) {
        const label = labelOf(line), val = valueOf(line);
        if (!label || !val) continue;
        if (/messages/i.test(label)) currentModel.messages = val;
        else if (/input\s*tokens/i.test(label)) currentModel.input = val;
        else if (/output\s*tokens/i.test(label)) currentModel.output = val;
        else if (/cache\s*read/i.test(label)) currentModel.cacheRead = val;
        else if (/cache\s*write/i.test(label)) currentModel.cacheWrite = val;
        else if (/^cost$/i.test(label)) currentModel.cost = val;
      }
    }
  }

  // Discard empty model rows (e.g., model placeholders with 0 messages).
  out.models = out.models.filter(m => m.id && (m.messages || m.cost || m.input));
  return out;
}

// Heuristic per-agent attribution. Multiple agents can share a model; in that
// case we split the model's cost evenly across the agents using it.
function attributeByAgent(modelStats, agentMap) {
  const byModel = {};
  for (const m of modelStats) byModel[m.id] = m;

  // Count how many agents use each model.
  const usersOfModel = {};
  for (const [agent, model] of Object.entries(agentMap)) {
    if (!usersOfModel[model]) usersOfModel[model] = [];
    usersOfModel[model].push(agent);
  }

  const rows = [];
  for (const agent of KNOWN_AGENTS) {
    const model = agentMap[agent];
    if (!model) { rows.push({ agent, model: '(no asignado)', cost: '—', note: '' }); continue; }
    const stats = byModel[model];
    if (!stats) {
      rows.push({ agent, model, cost: '—', note: '(modelo no apareció en stats)' });
      continue;
    }
    const sharedWith = (usersOfModel[model] || []).filter(a => a !== agent);
    const note = sharedWith.length ? `(compartido con ${sharedWith.join(', ')})` : '';
    rows.push({ agent, model, cost: stats.cost || '—', note });
  }
  return rows;
}

function cacheHealth(modelStats) {
  const caching = [];
  const noCache = [];
  for (const m of modelStats) {
    const cr = (m.cacheRead || '0').replace(/[^\d.]/g, '');
    if (Number(cr) > 0) caching.push(m.id);
    else noCache.push(m.id);
  }
  return { caching, noCache };
}

function md(s) { return s == null || s === '' ? '—' : s; }

function renderRealReport({ slug, openedAt, closedAt, duration, stats, agentRows, cache, scope }) {
  const lines = [];
  const scopeLabel = scope === 'project'
    ? 'project, last 24h'
    : 'GLOBAL (all projects), last 24h — could not isolate to current project';
  lines.push(`# Cost report — ${slug}`);
  lines.push('');
  lines.push('## Window');
  lines.push(`- **Opened:** ${md(openedAt)}`);
  lines.push(`- **Closed:** ${closedAt}`);
  lines.push(`- **Duration:** ${duration}`);
  if (scope === 'global') {
    lines.push('- ⚠️ **Scope:** estos números son **globales del día** (todos los proyectos), no específicos de esta task. `opencode stats --project ""` devolvió 0 sesiones; usá la ventana de tiempo arriba para correlacionar manualmente contra el dashboard.');
  }
  lines.push('');
  lines.push(`## Aggregate (${scopeLabel})`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total cost | ${md(stats.aggregate.totalCost)} |`);
  lines.push(`| Sessions | ${md(stats.overview.sessions)} |`);
  lines.push(`| Messages | ${md(stats.overview.messages)} |`);
  lines.push(`| Input tokens | ${md(stats.aggregate.input)} |`);
  lines.push(`| Output tokens | ${md(stats.aggregate.output)} |`);
  lines.push(`| Cache read | ${md(stats.aggregate.cacheRead)} |`);
  lines.push(`| Cache write | ${md(stats.aggregate.cacheWrite)} |`);
  lines.push('');
  lines.push('## Per-model breakdown');
  lines.push('');
  if (stats.models.length === 0) {
    lines.push('_No per-model data was reported by `opencode stats --models`._');
  } else {
    lines.push('| Model | Msgs | Input | Output | Cache read | Cache write | Cost |');
    lines.push('|-------|------|-------|--------|------------|-------------|------|');
    for (const m of stats.models) {
      lines.push(`| ${m.id} | ${md(m.messages)} | ${md(m.input)} | ${md(m.output)} | ${md(m.cacheRead)} | ${md(m.cacheWrite)} | ${md(m.cost)} |`);
    }
  }
  lines.push('');
  lines.push('## Per-agent attribution (by configured model)');
  lines.push('');
  lines.push('| Agent | Model | Cost (shared) | Note |');
  lines.push('|-------|-------|---------------|------|');
  for (const r of agentRows) {
    lines.push(`| @${r.agent} | ${r.model} | ${r.cost} | ${r.note} |`);
  }
  lines.push('');
  lines.push('> ⚠️ La columna Cost suma todo el uso del modelo. Si dos agentes comparten el mismo modelo (ver columna Note), el costo no se divide automáticamente — usá `opencode export <sessionID>` para detalle por sesión.');
  lines.push('');
  lines.push('## Cache health');
  lines.push('');
  if (cache.caching.length) lines.push(`- ✅ **Cacheando** (cache read > 0): ${cache.caching.join(', ')}`);
  else lines.push('- ✅ **Cacheando** (cache read > 0): _ninguno_');
  if (cache.noCache.length) lines.push(`- ⚠️ **Sin cache** (cache read = 0, modelo caro a precio full): ${cache.noCache.join(', ')}`);
  else lines.push('- ⚠️ **Sin cache** (cache read = 0): _ninguno_');
  lines.push('');
  lines.push('## Source');
  lines.push('');
  lines.push('- **Command:** `opencode stats --project \'\' --days 1 --models`');
  lines.push('- **Note:** los totales son agregados del día completo del proyecto; la ventana `Opened`/`Closed` es informativa para correlación manual.');
  lines.push('- **Authoritative reference:** dashboard de OpenCode.');
  lines.push('');
  lines.push(`## Updated ${todayISO()}`);
  lines.push('');
  lines.push(`<!-- Traceability: costs.md generated by costs.mjs at ${isoNow()} -->`);
  lines.push('');
  return lines.join('\n');
}

function renderFallback({ slug, openedAt, closedAt, reason }) {
  return [
    `# Cost report — ${slug}`,
    '',
    '## Window',
    `- **Opened:** ${md(openedAt)}`,
    `- **Closed:** ${closedAt}`,
    '',
    '## Aggregate',
    '',
    '⚠️ **Error al estimar — `opencode stats` no respondió o devolvió output inesperado.**',
    '',
    'Para los números reales, consultá el dashboard de OpenCode filtrando por la ventana de tiempo de arriba.',
    '',
    '## Source',
    '',
    '- **Attempted:** `opencode stats --project \'\' --days 1 --models`',
    `- **Failure reason:** ${reason}`,
    '- **Authoritative reference:** dashboard de OpenCode.',
    '',
    `## Updated ${todayISO()}`,
    '',
    `<!-- Traceability: costs.md generated by costs.mjs at ${isoNow()} (fallback mode — stats unavailable) -->`,
    '',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slug) {
    console.error('Usage: node vault/memory/.engine/costs.mjs <slug> [--json]');
    process.exit(1);
  }
  if (!SLUG_RE.test(args.slug)) {
    console.error(`Invalid slug "${args.slug}". Expected ^[a-zA-Z0-9_-]{3,60}$.`);
    process.exit(1);
  }
  const slug = args.slug;
  const taskDir = join(TASKS_DIR, slug);
  if (!await fileExists(taskDir)) {
    console.error(`Task dir not found: vault/memory/tasks/${slug}/`);
    process.exit(1);
  }

  const openedAt = await readOpenedAt(slug);
  const closedAt = isoNow();
  const duration = openedAt ? diffDuration(openedAt, closedAt) : '?';
  const agentMap = await readAgentModels();

  const stats = runOpencodeStats();

  if (args.json) {
    console.log(JSON.stringify({ slug, openedAt, closedAt, duration, agentMap, stats }, null, 2));
    return;
  }

  const targetPath = join(taskDir, 'costs.md');
  let report, mode;

  if (!stats.ok) {
    report = renderFallback({ slug, openedAt, closedAt, reason: `command failed: ${stats.stderr.trim().slice(0, 200) || '(no stderr)'}` });
    mode = 'fallback';
  } else {
    const parsed = parseStats(stats.stdout);
    const hasSomething =
      Object.keys(parsed.overview).length > 0 ||
      Object.keys(parsed.aggregate).length > 0 ||
      parsed.models.length > 0;

    if (!hasSomething) {
      report = renderFallback({ slug, openedAt, closedAt, reason: 'parsed output produced no recognizable sections' });
      mode = 'fallback';
    } else {
      const agentRows = attributeByAgent(parsed.models, agentMap);
      const cache = cacheHealth(parsed.models);
      report = renderRealReport({ slug, openedAt, closedAt, duration, stats: parsed, agentRows, cache, scope: stats.scope });
      mode = stats.scope === 'global' ? 'real-global' : 'real';
    }
  }

  await writeFile(targetPath, report, 'utf-8');
  console.log(`costs.md written (${mode}): vault/memory/tasks/${slug}/costs.md`);
}

main().catch((err) => {
  console.error('costs.mjs error:', err?.message || err);
  process.exit(1);
});

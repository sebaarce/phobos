#!/usr/bin/env node
// Overview del vault de Phobos — lista tareas + insights + wiki + glossary
// con métricas básicas (cantidades, fechas, estados).
//
// Read-only, no consulta Qdrant — solo filesystem.
//
// Uso:
//   node vault/memory/.engine/launcher.mjs list                   # overview
//   node vault/memory/.engine/launcher.mjs list --tasks 10        # más tareas
//   node vault/memory/.engine/launcher.mjs list --json            # output JSON
//   node vault/memory/.engine/launcher.mjs list --section insights  # solo una sección

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseProjectFlag(argv) {
  const idx = argv.indexOf('--project');
  if (idx >= 0 && argv[idx + 1]) {
    const p = resolvePath(argv[idx + 1]);
    argv.splice(idx, 2);
    return p;
  }
  return null;
}

// `process.argv.slice(2)` se parsea de nuevo en parseArgs() abajo. Acá hacemos
// una pasada temprana solo para extraer --project; el resto queda intacto.
const _argv = process.argv.slice(2);
const PROJECT_ROOT = parseProjectFlag(_argv) || join(__dirname, '..', '..', '..');
// Reemplazo argv original (sin --project) para que parseArgs() abajo lo lea bien.
process.argv = [process.argv[0], process.argv[1], ..._argv];

const VAULT = {
  tasks:    join(PROJECT_ROOT, 'vault/memory/tasks'),
  insights: join(PROJECT_ROOT, 'vault/memory/insights'),
  wiki:     join(PROJECT_ROOT, 'vault/memory/wiki'),
  glossary: join(PROJECT_ROOT, 'vault/memory/glossary'),
};

const COLOR = process.stdout.isTTY;
const c = (code, s) => COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim    = (s) => c('2', s);
const bold   = (s) => c('1', s);
const cyan   = (s) => c('36', s);
const green  = (s) => c('32', s);
const yellow = (s) => c('33', s);
const orange = (s) => c('38;5;208', s);

function parseArgs(argv) {
  const args = { tasksLimit: 5, json: false, section: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tasks')    args.tasksLimit = parseInt(argv[++i], 10) || 5;
    else if (a === '--json')    args.json = true;
    else if (a === '--section') args.section = argv[++i];
  }
  return args;
}

function fmtDate(d) {
  if (!d) return '?';
  try { return new Date(d).toISOString().slice(0, 10); }
  catch { return '?'; }
}

async function safeReaddir(dir) {
  if (!existsSync(dir)) return [];
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function listTasks() {
  const entries = await safeReaddir(VAULT.tasks);
  const tasks = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const slug = e.name;
    const taskDir = join(VAULT.tasks, slug);
    const readmePath = join(taskDir, 'README.md');
    const conclusionPath = join(taskDir, 'conclusion.md');

    let state = 'unknown';
    let goal = '';
    let opened = null;
    let closed = null;

    try {
      const readme = await readFile(readmePath, 'utf-8');
      const stateMatch = readme.match(/^\*\*(?:Estado|Status):\*\*\s*(.+)$/m);
      if (stateMatch) state = stateMatch[1].trim();
      const goalMatch = readme.match(/^\*\*(?:Objetivo|Goal):\*\*\s*(.+)$/m);
      if (goalMatch) goal = goalMatch[1].trim();
      const openMatch = readme.match(/^\*\*(?:Inicio|Opened):\*\*\s*(.+)$/m);
      if (openMatch) opened = openMatch[1].trim();
    } catch {}

    if (existsSync(conclusionPath)) {
      try {
        const s = await stat(conclusionPath);
        closed = s.mtime;
      } catch {}
    }

    tasks.push({ slug, state, goal, opened, closed });
  }
  // Orden: cerradas más recientes primero, abiertas al final
  tasks.sort((a, b) => {
    if (a.closed && b.closed) return b.closed - a.closed;
    if (a.closed) return -1;
    if (b.closed) return 1;
    return 0;
  });
  return tasks;
}

async function listSection(dir) {
  const entries = await safeReaddir(dir);
  const items = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const full = join(dir, e.name);
    let mtime = null;
    let firstLine = '';
    try {
      const s = await stat(full);
      mtime = s.mtime;
      const content = await readFile(full, 'utf-8');
      const m = content.match(/^#\s+(.+)$/m);
      if (m) firstLine = m[1].trim();
    } catch {}
    items.push({ name: e.name, title: firstLine, mtime });
  }
  // Orden: más reciente primero
  items.sort((a, b) => {
    if (a.mtime && b.mtime) return b.mtime - a.mtime;
    if (a.mtime) return -1;
    if (b.mtime) return 1;
    return 0;
  });
  return items;
}

function renderHeader(stats) {
  const tasksTotal = stats.tasks.length;
  const tasksClosed = stats.tasks.filter(t => t.closed).length;
  const tasksOpen = tasksTotal - tasksClosed;

  console.log('');
  console.log('  ' + bold(orange('╭─ Vault Overview ────────────────────────────────────────────╮')));
  console.log('  ' + orange('│ ') + dim('Tareas:    ')
    + cyan(tasksTotal + ' totales')
    + dim(' · ')
    + green(tasksClosed + ' closed')
    + dim(' · ')
    + yellow(tasksOpen + ' abiertas')
    + ' '.repeat(Math.max(0, 33 - String(tasksTotal).length - String(tasksClosed).length - String(tasksOpen).length))
    + orange(' │'));
  console.log('  ' + orange('│ ') + dim('Insights:  ') + cyan(pad(String(stats.insights.length), 4))
    + dim(' archivo' + (stats.insights.length === 1 ? '' : 's'))
    + ' '.repeat(40)
    + orange('│'));
  console.log('  ' + orange('│ ') + dim('Wiki:      ') + cyan(pad(String(stats.wiki.length), 4))
    + dim(' archivo' + (stats.wiki.length === 1 ? '' : 's'))
    + ' '.repeat(40)
    + orange('│'));
  console.log('  ' + orange('│ ') + dim('Glossary:  ') + cyan(pad(String(stats.glossary.length), 4))
    + dim(' archivo' + (stats.glossary.length === 1 ? '' : 's'))
    + ' '.repeat(40)
    + orange('│'));
  console.log('  ' + bold(orange('╰─────────────────────────────────────────────────────────────╯')));
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function renderTasksSection(tasks, limit) {
  if (tasks.length === 0) {
    console.log('  ' + dim('  (sin tareas)'));
    return;
  }
  console.log('');
  console.log('  ' + bold('Tasks ') + dim(`(últimas ${Math.min(limit, tasks.length)} de ${tasks.length})`));
  const slice = tasks.slice(0, limit);
  const maxSlug = Math.max(...slice.map(t => t.slug.length));
  for (const t of slice) {
    const slug = pad(t.slug, maxSlug);
    const date = t.closed ? fmtDate(t.closed) : (t.opened || '----------');
    const stateColor = t.state === 'done' ? green
                    : t.state === 'in_progress' ? yellow
                    : t.state === 'abandoned' ? dim
                    : t.state === 'partial' ? yellow
                    : dim;
    const state = stateColor(pad(t.state, 12));
    const goal = t.goal ? dim(' · ' + t.goal.slice(0, 50) + (t.goal.length > 50 ? '…' : '')) : '';
    console.log('  · ' + cyan(slug) + '  ' + dim(date) + '  ' + state + goal);
  }
}

function renderItemsSection(label, items, limit = 10) {
  if (items.length === 0) return;
  console.log('');
  console.log('  ' + bold(label) + dim(` (${items.length} archivo${items.length === 1 ? '' : 's'})`));
  for (const i of items.slice(0, limit)) {
    const name = i.name.replace(/\.md$/, '');
    const date = i.mtime ? dim(' ' + fmtDate(i.mtime)) : '';
    const title = i.title && i.title !== name ? dim(' · ' + i.title.slice(0, 50)) : '';
    console.log('  · ' + cyan(name) + date + title);
  }
  if (items.length > limit) {
    console.log('  ' + dim(`  … y ${items.length - limit} más`));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const stats = {
    tasks:    await listTasks(),
    insights: await listSection(VAULT.insights),
    wiki:     await listSection(VAULT.wiki),
    glossary: await listSection(VAULT.glossary),
  };

  if (args.json) {
    console.log(JSON.stringify({
      tasks: stats.tasks.map(t => ({ ...t, closed: t.closed?.toISOString?.() || null })),
      insights: stats.insights.map(i => ({ ...i, mtime: i.mtime?.toISOString?.() || null })),
      wiki:     stats.wiki.map(i => ({ ...i, mtime: i.mtime?.toISOString?.() || null })),
      glossary: stats.glossary.map(i => ({ ...i, mtime: i.mtime?.toISOString?.() || null })),
    }, null, 2));
    return;
  }

  if (args.section) {
    const sec = stats[args.section];
    if (!sec) {
      console.error(`Sección desconocida: ${args.section}. Válidas: tasks, insights, wiki, glossary.`);
      process.exit(2);
    }
    if (args.section === 'tasks') {
      renderTasksSection(sec, args.tasksLimit);
    } else {
      renderItemsSection(args.section.charAt(0).toUpperCase() + args.section.slice(1), sec, 50);
    }
    return;
  }

  renderHeader(stats);
  renderTasksSection(stats.tasks, args.tasksLimit);
  renderItemsSection('Insights', stats.insights);
  renderItemsSection('Wiki', stats.wiki);
  renderItemsSection('Glossary', stats.glossary);
  console.log('');
}

main().catch(err => {
  console.error('[memory] fatal:', err.message || err);
  process.exit(1);
});

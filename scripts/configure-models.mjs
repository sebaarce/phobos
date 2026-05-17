#!/usr/bin/env node
/**
 * phobos — Configurador interactivo de modelos para los agentes Phobos.
 *
 * Fuente de verdad: `opencode models` (lista en tiempo real lo que OpenCode tiene
 * disponible) + auth.json para providers configurados. Nada hardcodeado.
 *
 * Uso:
 *   node scripts/configure-models.mjs
 *   npm run models
 *   npx github:sebaarce/phobos   (canónico — sin instalación)
 *   npx phobos                  (solo si hiciste npm link local)
 *
 * Requiere: OpenCode CLI en PATH + Node >= 18. Sin dependencias externas.
 */

import { readFile, writeFile, readdir, access, mkdir } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import readlineSync from 'node:readline';
import { stdin, stdout, cwd, env, exit, platform } from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, 'templates');

const AGENTS_DIR = '.opencode/agent';
const AGENTS = ['phobos', 'researcher', 'planner', 'programmer', 'tester', 'archivist'];

// Habilitar keypress events para TUI
readlineSync.emitKeypressEvents(stdin);

// ═══════════════════════════════════════════════════════════════════
// Bootstrap — archivos que deben existir en el proyecto
// ═══════════════════════════════════════════════════════════════════

const BOOTSTRAP_GROUPS = {
  agentes: [
    'opencode/agent/phobos.md',
    'opencode/agent/researcher.md',
    'opencode/agent/planner.md',
    'opencode/agent/programmer.md',
    'opencode/agent/tester.md',
    'opencode/agent/archivist.md',
    'opencode/agent/README.md',
  ],
  comandos: [
    'opencode/command/adapt-agents.md',
    'opencode/command/models-wizard.md',
    'opencode/command/reindex-memory.md',
  ],
  vault: [
    'vault/SCHEMA.md',
    'vault/TASKS.md',
    'vault/README.md',
    'vault/sources/.gitkeep',
    'vault/memory/tasks/.gitkeep',
    'vault/memory/insights/.gitkeep',
    'vault/memory/wiki/.gitkeep',
    'vault/memory/glossary/.gitkeep',
  ],
};

// Mapeo src (relativo a TEMPLATES_DIR) → dst (relativo a cwd)
function srcToDst(srcPath) {
  // 'opencode/agent/phobos.md' → '.opencode/agent/phobos.md'
  // 'vault/SCHEMA.md' → 'vault/SCHEMA.md'
  if (srcPath.startsWith('opencode/')) return '.' + srcPath;
  return srcPath;
}

// Rol de cada agente (solo descriptivo para UI — los weights están en PROFILE_WEIGHTS).
const AGENT_PROFILES = {
  phobos:     { role: 'orquestación' },
  planner:    { role: 'razonamiento' },
  programmer: { role: 'código' },
  researcher: { role: 'lectura rápida' },
  tester:     { role: 'tests, barato' },
  archivist:  { role: 'prosa, distilar' },
};

// readline para inputs de texto (filtros, manual paste). Para yes/no y menús usamos TUI.
const rl = readline.createInterface({ input: stdin, output: stdout });

// ═══════════════════════════════════════════════════════════════════
// TUI helpers — selección con cursor + Enter
// ═══════════════════════════════════════════════════════════════════

// Sentinel para cancelar el wizard actual (Esc) y volver al menú principal.
// Distinto a Ctrl+C que sale del proceso completo.
const WIZARD_CANCELLED = Symbol('WIZARD_CANCELLED');

const HINT_SELECT = '  ↑/↓ navegar  ·  Enter confirmar  ·  Esc volver al menú  ·  Ctrl+C salir';
const HINT_MULTI  = '  ↑/↓ navegar  ·  Space marcar  ·  Enter confirmar  ·  Esc volver al menú  ·  Ctrl+C salir';

function tuiSelect(prompt, options, defaultIdx = 0) {
  return new Promise((resolve, reject) => {
    let selected = defaultIdx;
    const N = options.length;
    const isTTY = stdin.isTTY && stdout.isTTY;

    if (!isTTY) {
      // Fallback no-TTY: solo imprimir y devolver el default
      console.log(prompt);
      options.forEach((o, i) => console.log(`  ${i === selected ? '●' : '○'} ${o}`));
      console.log(dim(`  (no TTY — default: ${options[selected]})`));
      return resolve({ index: selected, value: options[selected] });
    }

    const fmt = (i, sel) => {
      const marker = i === sel ? cyan('●') : ' ';
      const text = i === sel ? cyan(options[i]) : options[i];
      return `  ${marker} ${text}`;
    };

    console.log(prompt);
    for (let i = 0; i < N; i++) console.log(fmt(i, selected));
    console.log(dim(HINT_SELECT));

    const rerender = () => {
      // Subir N+1 líneas (N opciones + 1 línea de hint)
      stdout.write(`\x1b[${N + 1}A`);
      for (let i = 0; i < N; i++) {
        stdout.write('\r\x1b[K' + fmt(i, selected) + '\n');
      }
      stdout.write('\r\x1b[K' + dim(HINT_SELECT) + '\n');
    };

    rl.pause();
    stdin.setRawMode(true);
    stdin.resume();

    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        selected = (selected - 1 + N) % N;
        rerender();
      } else if (key.name === 'down' || key.name === 'j') {
        selected = (selected + 1) % N;
        rerender();
      } else if (key.name === 'return') {
        cleanup();
        // Limpiar la línea de hint para no dejar basura
        stdout.write('\x1b[1A\r\x1b[K\n');
        resolve({ index: selected, value: options[selected] });
      } else if (key.name === 'escape') {
        cleanup();
        stdout.write('\x1b[1A\r\x1b[K\n');
        reject(WIZARD_CANCELLED);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        console.log('\n(salida)');
        exit(0);
      } else if (/^[1-9]$/.test(str || '')) {
        const n = parseInt(str, 10) - 1;
        if (n < N) {
          selected = n;
          rerender();
        }
      }
    };

    function cleanup() {
      stdin.setRawMode(false);
      stdin.removeListener('keypress', onKey);
      rl.resume();
    }

    stdin.on('keypress', onKey);
  });
}

async function tuiYesNo(prompt, defaultYes = false) {
  const { value } = await tuiSelect(prompt, ['Sí', 'No'], defaultYes ? 0 : 1);
  return value === 'Sí';
}

function tuiMultiSelect(prompt, options, defaultChecked = []) {
  return new Promise((resolve, reject) => {
    let cursor = 0;
    const checked = new Set(defaultChecked);
    const N = options.length;
    const isTTY = stdin.isTTY && stdout.isTTY;

    if (!isTTY) {
      console.log(prompt);
      options.forEach((o) => console.log(`  ${checked.has(o.value) ? '☑' : '☐'} ${o.label}`));
      console.log(dim(`  (no TTY — selección: ${Array.from(checked).join(', ') || 'ninguna'})`));
      return resolve(Array.from(checked));
    }

    const fmt = (i) => {
      const isCursor = i === cursor;
      const isChecked = checked.has(options[i].value);
      // Checkbox Unicode con check verde cuando marcado
      const box = isChecked ? green('☑') : dim('☐');
      let label = options[i].label;
      if (isChecked) {
        label = green(label);
      } else if (isCursor) {
        label = cyan(label);
      }
      const arrow = isCursor ? cyan('›') : ' ';
      return '  ' + arrow + ' ' + box + ' ' + label;
    };

    console.log(prompt);
    for (let i = 0; i < N; i++) console.log(fmt(i));
    console.log(dim(HINT_MULTI));

    const rerender = () => {
      stdout.write(`\x1b[${N + 1}A`);
      for (let i = 0; i < N; i++) {
        stdout.write('\r\x1b[K' + fmt(i) + '\n');
      }
      stdout.write('\r\x1b[K' + dim(HINT_MULTI) + '\n');
    };

    rl.pause();
    stdin.setRawMode(true);
    stdin.resume();

    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        cursor = (cursor - 1 + N) % N;
        rerender();
      } else if (key.name === 'down' || key.name === 'j') {
        cursor = (cursor + 1) % N;
        rerender();
      } else if (key.name === 'space' || str === ' ') {
        const val = options[cursor].value;
        if (checked.has(val)) checked.delete(val);
        else checked.add(val);
        rerender();
      } else if (key.name === 'return') {
        cleanup();
        stdout.write('\x1b[1A\r\x1b[K\n');
        resolve(Array.from(checked));
      } else if (key.name === 'escape') {
        cleanup();
        stdout.write('\x1b[1A\r\x1b[K\n');
        reject(WIZARD_CANCELLED);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        console.log('\n(salida)');
        exit(0);
      }
    };

    function cleanup() {
      stdin.setRawMode(false);
      stdin.removeListener('keypress', onKey);
      rl.resume();
    }

    stdin.on('keypress', onKey);
  });
}

function runChild(cmd, args, label) {
  return new Promise((resolve) => {
    console.log('\n' + cyan('▸ ') + bold(label));
    console.log(dim('  ejecutando: ' + cmd + ' ' + args.join(' ')) + '\n');
    const proc = spawn(cmd, args, { stdio: 'inherit', shell: true });
    proc.on('close', (code) => {
      if (code === 0) {
        console.log(green('\n  ✓ ' + label + ' completado.\n'));
      } else {
        console.log(yellow('\n  ⚠ ' + label + ' terminó con código ' + code + '\n'));
      }
      resolve(code);
    });
    proc.on('error', (err) => {
      console.log(yellow('\n  ⚠ Error ejecutando ' + cmd + ': ' + err.message + '\n'));
      resolve(1);
    });
  });
}

async function installObsidianSkills() {
  // Instalación per-proyecto vía Skills CLI (npx skills add).
  // El ecosistema instala cada skill individualmente en .agents/skills/<skill>/SKILL.md
  // que es donde OpenCode realmente auto-descubre los SKILL.md.

  console.log('\n' + cyan('▸ ') + bold('Instalar obsidian-skills (per-proyecto vía Skills CLI)'));
  console.log(dim('  destino: .agents/skills/<skill>/  (en este proyecto)'));
  console.log(dim('  fuente:  github.com/kepano/obsidian-skills'));
  console.log('');

  const skillsToInstall = [
    { id: 'obsidian-markdown',  desc: 'wikilinks, callouts, embeds, properties' },
    { id: 'obsidian-bases',     desc: 'archivos .base (filtros, fórmulas, vistas)' },
    { id: 'json-canvas',        desc: '.canvas (diagramas con nodos/edges)' },
    { id: 'obsidian-cli',       desc: 'queries al vault desde CLI' },
    { id: 'defuddle',           desc: 'extraer markdown limpio de URLs' },
  ];

  // Submenu: instalar todas o elegir
  const { index } = await tuiSelect(
    '¿Cuáles instalar?',
    [
      `Las 5 ${dim('(obsidian-markdown, obsidian-bases, json-canvas, obsidian-cli, defuddle)')}`,
      'Elegir cuáles (multi-select)',
      'Cancelar',
    ],
    0,
  );

  if (index === 2) {
    console.log(dim('  ⊘ saltado.\n'));
    return;
  }

  let selected;
  if (index === 0) {
    selected = skillsToInstall.map(s => s.id);
  } else {
    const picks = await tuiMultiSelect(
      '\nMarcá las que querés instalar:',
      skillsToInstall.map(s => ({ value: s.id, label: s.id + '  ' + dim('— ' + s.desc) })),
      ['obsidian-markdown', 'obsidian-bases', 'json-canvas'],
    );
    selected = picks;
  }

  if (selected.length === 0) {
    console.log(dim('\n  ⊘ ninguna seleccionada.\n'));
    return;
  }

  console.log(dim('\n  Instalando ' + selected.length + ' skill(s)...'));

  for (const skill of selected) {
    const pkg = `kepano/obsidian-skills@${skill}`;
    await runChild('npx', ['skills', 'add', pkg, '-y'], `Instalar ${skill}`);
  }

  console.log(dim('\n  OpenCode auto-descubrirá los SKILL.md al reiniciar.'));
  console.log(dim('  Verificá con:  ') + cyan('opencode debug skill'));
  console.log(dim('  Tip: si no querés commitear las skills, agregá a .gitignore:'));
  console.log(dim('    echo ".agents/skills/" >> .gitignore\n'));
}

async function installImpeccable() {
  // Impeccable — skill de diseño (pbakaus/impeccable).
  // Layout del repo: .opencode/skills/impeccable/{SKILL.md, reference/, scripts/}
  // No es publicable vía `npx skills add` (el repo tiene un solo skill en path no-estándar).
  // Estrategia: git clone shallow + copy del subdirectorio, sin requerir git config global.

  console.log('\n' + cyan('▸ ') + bold('Instalar Impeccable (skill de diseño per-proyecto)'));
  console.log(dim('  destino: .opencode/skills/impeccable/  (en este proyecto)'));
  console.log(dim('  fuente:  github.com/pbakaus/impeccable'));
  console.log(dim('  qué hace: vocabulario + 27 anti-patterns + workflows de auditoría de UI.'));
  console.log('');

  const { index } = await tuiSelect(
    '¿Instalar impeccable en este proyecto?',
    [
      `Sí, instalar  ${dim('(git clone + copy a .opencode/skills/impeccable/)')}`,
      'Cancelar',
    ],
    0,
  );

  if (index === 1) {
    console.log(dim('  ⊘ saltado.\n'));
    return;
  }

  const dest = '.opencode/skills/impeccable';
  if (await fileExists(dest)) {
    const { index: overwriteIdx } = await tuiSelect(
      `Ya existe ${dest}. ¿Sobrescribir?`,
      ['Sobrescribir (borra el existente y reinstala)', 'Cancelar'],
      1,
    );
    if (overwriteIdx === 1) {
      console.log(dim('  ⊘ saltado.\n'));
      return;
    }
  }

  // Asegurar que .opencode/skills/ exista
  await mkdir('.opencode/skills', { recursive: true }).catch(() => {});

  // Step 1: git clone shallow a tmp
  const tmpDir = '.tmp-impeccable-' + Date.now();
  const cloneCode = await runChild(
    'git',
    ['clone', '--depth', '1', 'https://github.com/pbakaus/impeccable.git', tmpDir],
    'Clonar impeccable (shallow)',
  );
  if (cloneCode !== 0) {
    console.log(yellow('  ⚠ Falló el git clone. Verificá que git esté en PATH y haya internet.\n'));
    return;
  }

  // Step 2: copiar .opencode/skills/impeccable/ del tmp al destino
  const src = join(tmpDir, '.opencode', 'skills', 'impeccable');
  if (!await fileExists(src)) {
    console.log(yellow(`  ⚠ El repo clonado no tiene ${src}. Quizás el upstream cambió.\n`));
    await rmrf(tmpDir);
    return;
  }

  // Borrar destino previo (si overwrite fue confirmado arriba)
  if (await fileExists(dest)) await rmrf(dest);

  // Copia recursiva multiplataforma vía spawn
  const copyCmd = platform === 'win32'
    ? { cmd: 'xcopy', args: [src.replace(/\//g, '\\'), dest.replace(/\//g, '\\'), '/E', '/I', '/Y', '/Q'] }
    : { cmd: 'cp', args: ['-r', src, dest] };

  const copyCode = await runChild(copyCmd.cmd, copyCmd.args, 'Copiar .opencode/skills/impeccable/');
  await rmrf(tmpDir);

  if (copyCode !== 0) {
    console.log(yellow('  ⚠ Falló la copia. Revisá permisos.\n'));
    return;
  }

  console.log(green('\n  ✓ Impeccable instalado en ') + cyan(dest));
  console.log(dim('\n  OpenCode auto-descubrirá la skill al reiniciar.'));
  console.log(dim('  Verificá con:  ') + cyan('opencode debug skill'));
  console.log(dim('  Tip CLI extra (sin instalar):  ') + cyan('npx impeccable detect src/'));
  console.log(dim('  Tip: si no querés commitear la skill, agregá a .gitignore:'));
  console.log(dim('    echo ".opencode/skills/impeccable/" >> .gitignore\n'));
}

// Helper rmrf multiplataforma sin dependencias (Node 16.14+ tiene fs.rm)
async function rmrf(path) {
  try {
    const { rm } = await import('node:fs/promises');
    await rm(path, { recursive: true, force: true });
  } catch {
    // Fallback al CLI del SO
    const cmd = platform === 'win32'
      ? { cmd: 'cmd', args: ['/c', 'rmdir', '/S', '/Q', path.replace(/\//g, '\\')] }
      : { cmd: 'rm', args: ['-rf', path] };
    await new Promise((resolve) => {
      const p = spawn(cmd.cmd, cmd.args, { stdio: 'ignore', shell: true });
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }
}

// Copia recursiva multiplataforma (Node 16.7+ tiene fs.cp con {recursive:true})
async function copyDirRecursive(src, dst) {
  const { cp } = await import('node:fs/promises');
  await cp(src, dst, { recursive: true });
}

// Tamaño total de un directorio en bytes. Si no existe, devuelve 0.
async function getDirSize(dirPath) {
  if (!await fileExists(dirPath)) return 0;
  const { stat } = await import('node:fs/promises');
  let total = 0;
  async function walk(p) {
    try {
      const s = await stat(p);
      if (s.isDirectory()) {
        const entries = await readdir(p);
        for (const entry of entries) {
          await walk(join(p, entry));
        }
      } else if (s.isFile()) {
        total += s.size;
      }
    } catch {}
  }
  await walk(dirPath);
  return total;
}

// Formato humano (B, KB, MB, GB).
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Lee la lista de collections de Qdrant via REST. Vacío si no se puede.
async function listQdrantCollections() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const r = await fetch(`${QDRANT_URL}/collections`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    const j = await r.json();
    return j?.result?.collections?.map(c => c.name) || [];
  } catch {
    return [];
  }
}

// Para cada collection, lee detalles (count, dims, distance).
async function listQdrantCollectionsDetailed() {
  const names = await listQdrantCollections();
  const detailed = [];
  for (const name of names) {
    try {
      const r = await fetch(`${QDRANT_URL}/collections/${encodeURIComponent(name)}`);
      if (!r.ok) {
        detailed.push({ name, points: 0, dims: 0, distance: '?', status: '?' });
        continue;
      }
      const j = await r.json();
      const result = j?.result || {};
      detailed.push({
        name,
        points: result.points_count ?? 0,
        dims: result.config?.params?.vectors?.size ?? 0,
        distance: result.config?.params?.vectors?.distance ?? '?',
        status: result.status ?? '?',
      });
    } catch {
      detailed.push({ name, points: 0, dims: 0, distance: '?', status: '?' });
    }
  }
  return detailed;
}

// Devuelve hasta N points de una collection (con payload completo).
async function getCollectionSamples(name, limit = 3) {
  try {
    const r = await fetch(`${QDRANT_URL}/collections/${encodeURIComponent(name)}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit, with_payload: true, with_vector: false }),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return j?.result?.points || [];
  } catch {
    return [];
  }
}

// Detecta si el researcher.md del proyecto tiene las reglas RAG (pre-flight
// search + Previous insights). Si no las tiene, el researcher NUNCA va a
// consultar el engine, sin importar que Qdrant esté corriendo.
async function detectResearcherHasRAG() {
  try {
    const content = await readFile('.opencode/agent/researcher.md', 'utf-8');
    return /Pre-flight:\s*semantic\s*search/i.test(content)
      || /vault\/memory\/\.engine\/search\.mjs/.test(content);
  } catch {
    return false;
  }
}

// Devuelve la fecha en la que Memory se instaló en este proyecto.
// Usamos el mtime del config.json o del .index-state.json (lo que exista primero).
async function getMemoryInstalledAt() {
  const { stat } = await import('node:fs/promises');
  const candidates = [
    'vault/memory/.engine/.index-state.json',
    'vault/memory/.engine/config.json',
  ];
  for (const p of candidates) {
    try {
      const s = await stat(p);
      return s.mtime;
    } catch {}
  }
  return null;
}

// Recorre vault/memory/tasks/ y reporta cuántas tareas tienen evidencia de uso
// del memory engine (Previous insights en research.md, conclusion cerrada).
// Cada tarea incluye el `closedAt` (mtime de conclusion.md) para poder
// clasificarla como pre/post-instalación de Memory.
async function checkTaskMemoryUsage() {
  const { stat } = await import('node:fs/promises');
  const tasksDir = 'vault/memory/tasks';
  const out = { total: 0, closed: 0, withPreviousInsights: 0, tasks: [] };
  if (!await fileExists(tasksDir)) return out;

  let entries = [];
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const slug = e.name;
    const dir = join(tasksDir, slug);
    const conclusionPath = join(dir, 'conclusion.md');
    const hasConclusion = await fileExists(conclusionPath);
    const researchPath = join(dir, 'research.md');
    const hasResearch = await fileExists(researchPath);
    let hasPreviousInsights = false;
    let closedAt = null;
    let researchAt = null;

    if (hasResearch) {
      try {
        const content = await readFile(researchPath, 'utf-8');
        if (/##\s*Previous\s*insights/i.test(content)) {
          const section = content.split(/##\s*Previous\s*insights/i)[1] || '';
          const head = section.split(/\n##\s/)[0] || '';
          hasPreviousInsights = /\[\[[^\]]+\]\]/.test(head) || /similarity\s+[\d.]+/i.test(head);
        }
      } catch {}
      try {
        const s = await stat(researchPath);
        researchAt = s.mtime;
      } catch {}
    }
    if (hasConclusion) {
      try {
        const s = await stat(conclusionPath);
        closedAt = s.mtime;
      } catch {}
    }

    out.tasks.push({ slug, hasConclusion, hasResearch, hasPreviousInsights, closedAt, researchAt });
    out.total++;
    if (hasConclusion) out.closed++;
    if (hasPreviousInsights) out.withPreviousInsights++;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// Utilidades
// ═══════════════════════════════════════════════════════════════════

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function color(c, s) { return process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s; }
const green = (s) => color('32', s);
const yellow = (s) => color('33', s);
const cyan = (s) => color('36', s);
const magenta = (s) => color('35', s);
const red = (s) => color('31', s);
const dim = (s) => color('2', s);
const bold = (s) => color('1', s);
// Naranja "true" via ANSI 256-color (208 = bright orange). Soportado en
// todos los terminales modernos: Windows Terminal, iTerm2, gnome-terminal.
const orange = (s) => color('38;5;208', s);

// ═══════════════════════════════════════════════════════════════════
// Header ASCII
// ═══════════════════════════════════════════════════════════════════

function clearScreen() {
  // ESC[2J clears, ESC[H moves cursor to (0,0). Funciona en Windows Terminal, iTerm2, gnome-terminal.
  // Fallback console.clear() para entornos exóticos.
  if (stdout.isTTY) {
    stdout.write('\x1b[2J\x1b[3J\x1b[H');
  } else {
    console.clear();
  }
}

function printHeader() {
  const lines = [
    '██████╗ ██╗  ██╗ ██████╗ ██████╗  ██████╗ ███████╗',
    '██╔══██╗██║  ██║██╔═══██╗██╔══██╗██╔═══██╗██╔════╝',
    '██████╔╝███████║██║   ██║██████╔╝██║   ██║███████╗',
    '██╔═══╝ ██╔══██║██║   ██║██╔══██╗██║   ██║╚════██║',
    '██║     ██║  ██║╚██████╔╝██████╔╝╚██████╔╝███████║',
    '╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝ ╚══════╝',
  ];
  console.log('');
  for (const l of lines) console.log('  ' + orange(l));
  console.log('');
  console.log('  ' + dim('Orquestador SDD para OpenCode'));
  console.log('');
}

function printUpdateBanner() {
  const lines = [
    '██╗   ██╗██████╗ ██████╗  █████╗ ████████╗███████╗',
    '██║   ██║██╔══██╗██╔══██╗██╔══██╗╚══██╔══╝██╔════╝',
    '██║   ██║██████╔╝██║  ██║███████║   ██║   █████╗  ',
    '██║   ██║██╔═══╝ ██║  ██║██╔══██║   ██║   ██╔══╝  ',
    '╚██████╔╝██║     ██████╔╝██║  ██║   ██║   ███████╗',
    ' ╚═════╝ ╚═╝     ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝',
  ];
  console.log('');
  for (const l of lines) console.log('  ' + orange(l));
  console.log('');
  console.log('  ' + dim('Update — revisa templates ↻ diferentes / ⚠ faltantes'));
  console.log('');
}

function printModelsBanner() {
  const lines = [
    '███╗   ███╗ ██████╗ ██████╗ ███████╗██╗     ███████╗',
    '████╗ ████║██╔═══██╗██╔══██╗██╔════╝██║     ██╔════╝',
    '██╔████╔██║██║   ██║██║  ██║█████╗  ██║     ███████╗',
    '██║╚██╔╝██║██║   ██║██║  ██║██╔══╝  ██║     ╚════██║',
    '██║ ╚═╝ ██║╚██████╔╝██████╔╝███████╗███████╗███████║',
    '╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝╚══════╝',
  ];
  console.log('');
  for (const l of lines) console.log('  ' + orange(l));
  console.log('');
  console.log('  ' + dim('Models — asigná un modelo a cada agente'));
  console.log('');
}

function printToolsBanner() {
  const lines = [
    '████████╗ ██████╗  ██████╗ ██╗     ███████╗',
    '╚══██╔══╝██╔═══██╗██╔═══██╗██║     ██╔════╝',
    '   ██║   ██║   ██║██║   ██║██║     ███████╗',
    '   ██║   ██║   ██║██║   ██║██║     ╚════██║',
    '   ██║   ╚██████╔╝╚██████╔╝███████╗███████║',
    '   ╚═╝    ╚═════╝  ╚═════╝ ╚══════╝╚══════╝',
  ];
  console.log('');
  for (const l of lines) console.log('  ' + orange(l));
  console.log('');
  console.log('  ' + dim('Tools — autoskills, obsidian, impeccable, opencode'));
  console.log('');
}

function printMemoryBanner() {
  const lines = [
    '███╗   ███╗███████╗███╗   ███╗ ██████╗ ██████╗ ██╗   ██╗',
    '████╗ ████║██╔════╝████╗ ████║██╔═══██╗██╔══██╗╚██╗ ██╔╝',
    '██╔████╔██║█████╗  ██╔████╔██║██║   ██║██████╔╝ ╚████╔╝ ',
    '██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║██║   ██║██╔══██╗  ╚██╔╝  ',
    '██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║╚██████╔╝██║  ██║   ██║   ',
    '╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ',
  ];
  console.log('');
  for (const l of lines) console.log('  ' + orange(l));
  console.log('');
  console.log('  ' + dim('Memory — RAG sobre el vault con @xenova/transformers + Qdrant'));
  console.log('  ' + dim('Dashboard Qdrant: ') + cyan('http://localhost:6333/dashboard'));
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════
// Panel — caja con título y líneas de contenido
// ═══════════════════════════════════════════════════════════════════

function visibleLen(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function panel(title, lines) {
  const titleW = visibleLen(title);
  const contentW = lines.length ? Math.max(...lines.map(visibleLen)) : 0;
  const innerW = Math.max(contentW + 4, titleW + 6);

  const dashesAfter = Math.max(1, innerW - titleW - 3);
  const top    = '╭─ ' + title + ' ' + '─'.repeat(dashesAfter) + '╮';
  const bottom = '╰' + '─'.repeat(innerW) + '╯';
  const blank  = '│' + ' '.repeat(innerW) + '│';

  console.log('  ' + cyan(top));
  console.log('  ' + cyan(blank));
  for (const line of lines) {
    if (line === '') {
      console.log('  ' + cyan(blank));
    } else {
      const padding = innerW - 2 - visibleLen(line);
      console.log('  ' + cyan('│') + '  ' + line + ' '.repeat(Math.max(0, padding)) + cyan('│'));
    }
  }
  console.log('  ' + cyan(blank));
  console.log('  ' + cyan(bottom));
}

// ═══════════════════════════════════════════════════════════════════
// Progress bar
// ═══════════════════════════════════════════════════════════════════

function drawProgress(label, current, total, width = 24) {
  const pct = current / total;
  const filled = Math.round(pct * width);
  const bar = green('█'.repeat(filled)) + dim('░'.repeat(width - filled));
  const percent = Math.round(pct * 100).toString().padStart(3);
  stdout.write(`\r  [${bar}] ${percent}%  ${label} ${dim('(' + current + '/' + total + ')')}`);
  if (current === total) stdout.write('\n');
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function tryExec(cmd, timeoutMs = 15000) {
  try {
    const out = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      shell: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, out: stripAnsi(out).trim() };
  } catch (err) {
    return { ok: false, err: err.message || String(err) };
  }
}

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

function parseModelsList(output) {
  return output.split('\n')
    .map(l => l.trim())
    .filter(l => l && /^[a-z][a-z0-9_-]*\/[a-z0-9._-]+$/i.test(l));
}

function getProvider(id) {
  const slash = id.indexOf('/');
  return slash >= 0 ? id.substring(0, slash) : '(sin provider)';
}

function groupByProvider(models) {
  const groups = {};
  for (const id of models) {
    const p = getProvider(id);
    if (!groups[p]) groups[p] = [];
    groups[p].push(id);
  }
  for (const p of Object.keys(groups)) groups[p].sort();
  return groups;
}

// Clasificación heurística — tiers MUTUAMENTE EXCLUYENTES (un modelo es top, mid, low, o code).
// El orden de evaluación importa: primero top, después code, después low, finalmente mid como default.
function classifyModel(id) {
  const tags = new Set();
  // Trabajar con la parte después del / (sin provider) para que las regex sean simples
  const name = id.toLowerCase().includes('/')
    ? id.toLowerCase().split('/').slice(1).join('/')
    : id.toLowerCase();

  // Top tier — modelos más capaces
  if (/opus|big-pickle/.test(name)) tags.add('top');
  else if (/-pro($|-)/.test(name)) tags.add('top');
  else if (/^gpt-?5\.5/.test(name)) tags.add('top');

  // Code tier — especialización en código
  if (/codex|grok-code/.test(name)) tags.add('code');

  // Low tier — barato y rápido
  if (/haiku|nano|mini|flash|small|free|light/.test(name)) tags.add('low');

  // Mid tier — base balanced (solo si NO es top/code/low)
  if (!tags.has('top') && !tags.has('code') && !tags.has('low')) {
    if (/sonnet|^gpt-?5(?:$|\.\d|\b)|^gpt-?4\.1|^gpt-?4o(?!-mini)|gemini[-.\d]+pro/.test(name)) {
      tags.add('mid');
    }
  }

  // Familia conocida — para preferir sobre modelos misteriosos
  if (/claude|sonnet|opus|haiku|gpt|gemini/.test(name)) tags.add('known');

  return tags;
}

// Cada agente tiene weights explícitos por tag. Más claro que prefer-order.
const PROFILE_WEIGHTS = {
  phobos:     { top: 100, mid:  60, low: -40, known: 15 },
  planner:    { top: 100, mid:  30, low: -40, known: 15 },
  programmer: { code: 100, mid:  60, top:  30, known: 15 },
  researcher: { low: 100, mid:  40, top: -40, code: 10, known: 15 },
  tester:     { low: 100, mid:  20, top: -50, known: 15 },
  archivist:  { mid: 100, top:  60, low: -40, known: 15 },
};

function scoreModel(agent, modelId) {
  const tags = classifyModel(modelId);
  const weights = PROFILE_WEIGHTS[agent] || {};
  let score = 0;
  for (const [tag, w] of Object.entries(weights)) {
    if (tags.has(tag)) score += w;
  }
  // Penalización suave para modelos sin family conocida (evita picks raros tipo "big-pickle")
  if (!tags.has('known')) score -= 20;
  return score;
}

function recommendForAgent(agent, allModels) {
  let best = null;
  let bestScore = -Infinity;
  for (const id of allModels) {
    const s = scoreModel(agent, id);
    // Tie-breaker: ante igual score, preferí el ID lex-mayor (típicamente versión más nueva)
    if (s > bestScore || (s === bestScore && best !== null && id > best)) {
      bestScore = s;
      best = id;
    }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════════
// Detección
// ═══════════════════════════════════════════════════════════════════

async function detect() {
  const detected = { models: new Map(), providers: new Set(), notes: [] };

  const v = tryExec('opencode --version', 8000);
  if (!v.ok) {
    console.log('');
    console.log('  ' + yellow('✗ No detecté el CLI de OpenCode en tu PATH.'));
    console.log('');
    console.log('  ' + dim('phobos necesita el CLI de OpenCode para'));
    console.log('  ' + dim('descubrir providers y modelos disponibles.'));
    console.log('');
    console.log('  Instalá OpenCode y volvé a correr:  ' + cyan('npx github:sebaarce/phobos'));
    console.log('  ' + dim('→ ') + cyan('https://opencode.ai'));
    console.log('');
    rl.close();
    exit(1);
  }

  // Auth file → providers (lectura silenciosa, no exponemos el path)
  const authPaths = [
    join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
    join(homedir(), '.config', 'opencode', 'auth.json'),
    platform === 'win32' && env.APPDATA ? join(env.APPDATA, 'opencode', 'auth.json') : null,
    platform === 'win32' && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'opencode', 'auth.json') : null,
  ].filter(Boolean);

  for (const path of authPaths) {
    if (await fileExists(path)) {
      try {
        const data = JSON.parse(await readFile(path, 'utf-8'));
        const providers = Object.keys(data || {});
        for (const p of providers) detected.providers.add(p);
      } catch {
        // silencioso — si falla, seguimos con lo que tengamos
      }
    }
  }

  // opencode models — listado canónico (silencioso)
  const allR = tryExec('opencode models', 20000);
  if (allR.ok && allR.out) {
    const ids = parseModelsList(allR.out);
    for (const id of ids) {
      detected.models.set(id, 'opencode models');
      detected.providers.add(getProvider(id));
    }
  } else {
    detected.notes.push('opencode models no devolvió nada — posible problema de auth');
  }

  // opencode models <provider> — por si algún provider tiene modelos no incluidos en el default
  for (const provider of detected.providers) {
    const r = tryExec(`opencode models ${provider}`, 12000);
    if (r.ok && r.out) {
      const ids = parseModelsList(r.out);
      for (const id of ids) {
        if (!detected.models.has(id)) {
          detected.models.set(id, `opencode models ${provider}`);
        }
      }
    }
  }

  return detected;
}

// ═══════════════════════════════════════════════════════════════════
// Lectura/escritura de agentes
// ═══════════════════════════════════════════════════════════════════

async function readCurrentModels(agentDir) {
  const result = {};
  for (const agent of AGENTS) {
    const filepath = join(agentDir, `${agent}.md`);
    try {
      const content = await readFile(filepath, 'utf-8');
      const match = content.match(/^model:\s*(.+)$/m);
      result[agent] = match ? match[1].trim() : '(no detectado)';
    } catch (err) {
      result[agent] = `(error: ${err.code || err.message})`;
    }
  }
  return result;
}

async function writeModel(agentDir, agent, newModel) {
  const filepath = join(agentDir, `${agent}.md`);
  const content = await readFile(filepath, 'utf-8');
  if (!/^model:\s*.+$/m.test(content)) {
    throw new Error(`No encontré línea 'model:' en ${filepath}`);
  }
  const updated = content.replace(/^model:\s*.+$/m, `model: ${newModel}`);
  await writeFile(filepath, updated);
}

// ═══════════════════════════════════════════════════════════════════
// UI — resumen, paste manual, picker con filtros
// ═══════════════════════════════════════════════════════════════════

function summarizeDetection(detected) {
  if (detected.models.size === 0) {
    console.log(yellow('\n  ⚠ No se detectaron modelos.\n'));
    if (detected.notes.length > 0) {
      for (const n of detected.notes) console.log(dim('  · ' + n));
    }
    return;
  }

  const grouped = groupByProvider(Array.from(detected.models.keys()));
  const providers = Object.entries(grouped).sort();
  const wProvider = Math.max(...providers.map(([p]) => p.length));

  const lines = [
    bold('Providers conectados'),
    ...providers.map(([provider, ids]) =>
      cyan(' ▸ ') + pad(provider, wProvider) + '    ' + green(ids.length + ' modelos')
    ),
    '',
    bold('Total disponible') + '    ' + bold(green(detected.models.size + ' modelos')),
  ];

  console.log('');
  panel('Detección', lines);

  if (detected.notes.length > 0) {
    console.log(dim('\n  Notas:'));
    for (const n of detected.notes) console.log(dim('    · ' + n));
  }
}

async function getFinalModelList(detected) {
  let list = Array.from(detected.models.keys());

  if (list.length === 0) {
    console.log(yellow('\n⚠ No se detectaron modelos automáticamente.'));
    console.log('  Pegá los IDs disponibles, uno por línea (desde el selector de OpenCode).');
    console.log(dim('  Línea vacía + ENTER para terminar.\n'));
    while (true) {
      const line = (await rl.question('  > ')).trim();
      if (!line) break;
      list.push(line);
    }
    if (list.length === 0) {
      console.log(yellow('Lista vacía — no se puede continuar.'));
      return null;
    }
    return list;
  }

  const wantsManual = await tuiYesNo('\n¿Querés especificar manualmente el proveedor y modelo para los agentes?', false);
  if (wantsManual) {
    console.log(dim('\n  Pegá uno por línea (formato: ' + cyan('provider/modelo') + dim('), vacío para terminar.\n')));
    while (true) {
      const line = (await rl.question('  > ')).trim();
      if (!line) break;
      if (!list.includes(line)) list.push(line);
    }
  }

  return list;
}

function showCurrentStatus(current) {
  const wAgent = Math.max(...AGENTS.map(a => a.length));
  const wRole = Math.max(...AGENTS.map(a => AGENT_PROFILES[a].role.length));
  const wModel = Math.max(...AGENTS.map(a => (current[a] || '').length));

  const lines = AGENTS.map(agent => {
    const role = AGENT_PROFILES[agent].role;
    const model = current[agent];
    return bold(pad(agent, wAgent)) + '  ' + dim(pad(role, wRole)) + '  ' + green(pad(model, wModel));
  });

  console.log('');
  panel('Configuración actual', lines);
  console.log('');
}

function agentHeaderBlock(idx, total, agent, role, currentModel, suggestedModel) {
  const stepTag = `[${idx + 1}/${total}]`;
  const agentSpaced = agent.toUpperCase().split('').join(' ');

  const isSameAsCurrent = suggestedModel && currentModel === suggestedModel;

  // Líneas visibles (para cálculo de ancho)
  const visibleL1 = `${stepTag}   ${agentSpaced}`;
  const visibleL2 = `· ${role}`;
  const visibleL3 = `Modelo actual:    ${currentModel}`;
  const visibleL4 = suggestedModel
    ? `Modelo sugerido:  ${suggestedModel}${isSameAsCurrent ? '  (igual)' : ''}`
    : '';
  const innerW = Math.max(
    54,
    Math.max(visibleL1.length, visibleL2.length, visibleL3.length, visibleL4.length) + 4,
  );

  const top    = '┏' + '━'.repeat(innerW) + '┓';
  const bottom = '┗' + '━'.repeat(innerW) + '┛';
  const blank  = '┃' + ' '.repeat(innerW) + '┃';

  // Estilo de líneas
  const styledL1 = dim(stepTag) + '   ' + bold(cyan(agentSpaced));
  const styledL2 = cyan('·') + ' ' + bold(role);
  const styledL3 = dim('Modelo actual:    ') + currentModel;
  const styledL4 = suggestedModel
    ? dim('Modelo sugerido:  ') + (isSameAsCurrent
        ? dim(suggestedModel + '  (igual)')
        : yellow(suggestedModel))
    : null;

  function row(visible, styled) {
    const padding = innerW - 2 - visible.length;
    return cyan('┃') + '  ' + styled + ' '.repeat(Math.max(0, padding)) + cyan('┃');
  }

  const lines = [
    '',
    '  ' + cyan(top),
    '  ' + cyan(blank),
    '  ' + row(visibleL1, styledL1),
    '  ' + row(visibleL2, styledL2),
    '  ' + cyan(blank),
    '  ' + row(visibleL3, styledL3),
  ];
  if (styledL4) lines.push('  ' + row(visibleL4, styledL4));
  lines.push('  ' + cyan(blank));
  lines.push('  ' + cyan(bottom));

  return lines.join('\n');
}

async function pickFromList(allModels, promptHeader, current) {
  let filter = '';
  let cursorIdx = 0;
  let linesPrinted = 0;

  function buildRows() {
    const matches = filter
      ? allModels.filter(m => m.toLowerCase().includes(filter.toLowerCase()))
      : allModels;
    const grouped = groupByProvider(matches);
    const rows = [];

    for (const [provider, ids] of Object.entries(grouped).sort()) {
      rows.push({ type: 'group', label: '  ─── ' + provider + '/ ───' });
      for (const id of ids) {
        const short = id.includes('/') ? id.split('/').slice(1).join('/') : id;
        rows.push({ type: 'option', id, label: short });
      }
    }

    if (matches.length === 0) {
      rows.push({ type: 'note', label: yellow('  ⚠ Sin matches para "' + filter + '"') });
    }

    rows.push({ type: 'sep' });
    rows.push({ type: 'action', key: 'filter', label: 'Cambiar filtro' });
    rows.push({ type: 'action', key: 'manual',  label: 'Otro (escribir ID manualmente)' });
    rows.push({ type: 'action', key: 'keep',    label: 'Dejar como está' });

    return rows;
  }

  function nextSelectable(rows, from, dir) {
    let i = from + dir;
    while (i >= 0 && i < rows.length) {
      const r = rows[i];
      if (r.type === 'option' || r.type === 'action') return i;
      i += dir;
    }
    return from;
  }

  function ensureValidCursor(rows) {
    const r = rows[cursorIdx];
    if (r && (r.type === 'option' || r.type === 'action')) return;
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i];
      if (x.type === 'option' || x.type === 'action') {
        cursorIdx = i;
        return;
      }
    }
  }

  function render(firstTime) {
    const rows = buildRows();
    ensureValidCursor(rows);

    if (!firstTime && linesPrinted > 0) {
      stdout.write(`\x1b[${linesPrinted}A\x1b[J`);
    }

    let count = 0;
    function out(s) {
      stdout.write(s + '\n');
      count += (s.match(/\n/g) || []).length + 1;
    }

    // Header (multi-línea OK)
    out(promptHeader);
    if (filter) out('   ' + dim('filtro activo: "' + filter + '"'));
    out('');

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const isCursor = i === cursorIdx;
      if (r.type === 'group') {
        out(dim(r.label));
      } else if (r.type === 'sep') {
        out('');
      } else if (r.type === 'note') {
        out(r.label);
      } else if (r.type === 'option') {
        const marker = isCursor ? cyan('●') : ' ';
        const isCurrent = r.id === current;
        let text = r.label + (isCurrent ? dim('   (actual)') : '');
        if (isCursor) text = cyan(r.label) + (isCurrent ? dim('   (actual)') : '');
        out('      ' + marker + ' ' + text);
      } else if (r.type === 'action') {
        const marker = isCursor ? cyan('●') : ' ';
        let label = r.label;
        if (r.key === 'keep') label = r.label + dim(' (' + current + ')');
        if (isCursor) label = cyan(label);
        out('      ' + marker + ' ' + label);
      }
    }

    out('');
    out('  ' + dim('↑/↓ navegar  ·  Enter elegir  ·  / filtrar  ·  Esc o 0 dejar  ·  Ctrl+C salir'));

    linesPrinted = count;
  }

  return new Promise((resolve) => {
    if (!stdin.isTTY || !stdout.isTTY) {
      console.log('\n' + promptHeader);
      console.log(dim('  (no TTY — manteniendo: ' + current + ')'));
      return resolve(current);
    }

    rl.pause();
    stdin.setRawMode(true);
    stdin.resume();

    function teardown() {
      stdin.setRawMode(false);
      stdin.removeListener('keypress', onKey);
      rl.resume();
    }

    async function handleFilter() {
      teardown();
      stdout.write('\n');
      filter = (await rl.question('  Filtro (vacío = limpiar): ')).trim();
      cursorIdx = 0;
      linesPrinted = 0;
      rl.pause();
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', onKey);
      render(true);
    }

    async function handleManual() {
      teardown();
      stdout.write('\n');
      const custom = (await rl.question('  ID exacto del modelo: ')).trim();
      stdout.write('\n');
      resolve(custom || current);
    }

    const onKey = (str, key) => {
      if (!key) return;
      const rows = buildRows();

      if (key.name === 'up' || key.name === 'k') {
        cursorIdx = nextSelectable(rows, cursorIdx, -1);
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        cursorIdx = nextSelectable(rows, cursorIdx, +1);
        render();
      } else if (key.name === 'pageup') {
        for (let n = 0; n < 8; n++) {
          const prev = nextSelectable(rows, cursorIdx, -1);
          if (prev === cursorIdx) break;
          cursorIdx = prev;
        }
        render();
      } else if (key.name === 'pagedown') {
        for (let n = 0; n < 8; n++) {
          const next = nextSelectable(rows, cursorIdx, +1);
          if (next === cursorIdx) break;
          cursorIdx = next;
        }
        render();
      } else if (key.name === 'return') {
        const r = rows[cursorIdx];
        if (!r) return;
        if (r.type === 'option') {
          teardown();
          stdout.write('\n');
          resolve(r.id);
        } else if (r.type === 'action') {
          if (r.key === 'filter') return handleFilter();
          if (r.key === 'manual') return handleManual();
          if (r.key === 'keep') {
            teardown();
            stdout.write('\n');
            resolve(current);
          }
        }
      } else if (str === '/') {
        return handleFilter();
      } else if (key.name === 'escape' || str === '0') {
        teardown();
        stdout.write('\n');
        resolve(current);
      } else if (key.ctrl && key.name === 'c') {
        teardown();
        stdout.write('\n' + dim('(cancelado)') + '\n');
        exit(0);
      }
    };

    stdin.on('keypress', onKey);
    render(true);
  });
}

// ═══════════════════════════════════════════════════════════════════
// Modos de asignación
// ═══════════════════════════════════════════════════════════════════

function renderSuggestionPanel(recommended, current) {
  const wAgent = Math.max(...AGENTS.map(a => a.length));
  const wRole  = Math.max(...AGENTS.map(a => AGENT_PROFILES[a].role.length));
  const wModel = Math.max(...AGENTS.map(a => (recommended[a] || '').length));

  const lines = AGENTS.map(a => {
    const cur = current[a];
    const rec = recommended[a];
    const changed = cur !== rec;
    const modelCol = changed ? yellow(pad(rec, wModel)) : green(pad(rec, wModel));
    const marker = changed ? yellow('↻ cambia') : dim('· actual');
    return (
      bold(pad(a, wAgent)) + '  ' +
      dim(pad(AGENT_PROFILES[a].role, wRole)) + '  ' +
      modelCol + '  ' +
      marker
    );
  });

  // Resumen de providers usados en la sugerencia
  const providersUsed = {};
  for (const a of AGENTS) {
    const p = getProvider(recommended[a]);
    providersUsed[p] = (providersUsed[p] || 0) + 1;
  }
  const providersList = Object.entries(providersUsed)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => cyan(p) + dim(' (' + n + ')'))
    .join(dim(' · '));
  const providerLabel = Object.keys(providersUsed).length > 1 ? 'Proveedores' : 'Proveedor';
  lines.push('');
  lines.push(dim(providerLabel + ':  ') + providersList);

  panel('Sugerencia automática', lines);
}

// chooseMode — Step 3 del wizard. Recibe `history` mutable: cada sub-decisión
// agrega una línea al historial superior y limpia la pantalla en el siguiente sub-step.
async function chooseMode(history, allModels, current) {
  const detectedProviders = Array.from(new Set(allModels.map(m => getProvider(m)))).sort();
  const hasMultipleProviders = detectedProviders.length > 1;

  // OpenCode usa un solo proveedor por sesión — siempre elegimos uno (no hay opción "todos")
  let providerFilter = detectedProviders[0];

  // Helper: si ya existe una entry con ese label, la reemplaza; si no, la agrega.
  function setHistoryEntry(label, value) {
    const existing = history.findIndex(h => h.label === label);
    if (existing >= 0) history[existing] = { label, value };
    else history.push({ label, value });
  }

  // Helper: quita todas las entries posteriores a (e incluyendo) un label.
  // Útil cuando volvemos al sub-step A desde "Cambiar proveedor".
  function trimHistoryFrom(label) {
    const idx = history.findIndex(h => h.label === label);
    if (idx >= 0) history.splice(idx);
  }

  while (true) {
    // ─── Sub-step 3a: elegir provider (si hay múltiples) ─────────────
    if (hasMultipleProviders) {
      // Si venimos de un loop ("Cambiar proveedor"), borrar entries posteriores
      trimHistoryFrom('Estrategia');

      renderWizardStep(printModelsBanner, history, '[3/4] Asignar modelo · elegir proveedor');

      const providerOptions = detectedProviders.map(p => {
        const count = allModels.filter(m => getProvider(m) === p).length;
        return `${p} (${count} modelos)`;
      });

      const defaultIdx = Math.max(0, detectedProviders.indexOf(providerFilter));

      const { index: provIdx } = await tuiSelect(
        '\n¿Qué proveedor usamos?',
        providerOptions,
        defaultIdx,
      );

      providerFilter = detectedProviders[provIdx];
      const count = allModels.filter(m => getProvider(m) === providerFilter).length;
      setHistoryEntry('Provider', `${providerFilter} (${count} modelos)`);
    } else {
      // Solo un provider — registramos sin preguntar
      const count = allModels.filter(m => getProvider(m) === providerFilter).length;
      setHistoryEntry('Provider', `${providerFilter} (${count} modelos) — único disponible`);
    }

    // ─── Sub-step 3b: mostrar sugerencia + elegir estrategia ─────────
    renderWizardStep(printModelsBanner, history, '[3/4] Asignar modelo · elegir estrategia');

    const modelsScope = allModels.filter(m => getProvider(m) === providerFilter);

    const recommended = Object.fromEntries(
      AGENTS.map(a => [a, recommendForAgent(a, modelsScope)])
    );

    console.log('');
    renderSuggestionPanel(recommended, current);

    const modeOptions = [
      'Aplicar la sugerencia automática',
      'Asignar el MISMO modelo a todos (preset uniforme)',
      'Custom — agente por agente (con filtros)',
    ];
    if (hasMultipleProviders) {
      modeOptions.push('Cambiar proveedor de la sugerencia');
    }
    modeOptions.push('Cancelar y salir');

    const { index } = await tuiSelect(
      '\n¿Cómo asignamos los modelos?',
      modeOptions,
      0,
    );

    if (index === 0) {
      setHistoryEntry('Estrategia', 'Aplicar sugerencia automática');
      return recommended;
    }

    if (index === 1) {
      setHistoryEntry('Estrategia', 'Mismo modelo para TODOS los agentes');
      renderWizardStep(printModelsBanner, history, '[3/4] Asignar modelo · elegir modelo uniforme');
      const uniformPrompt = '  ' + bold(cyan('Modelo para TODOS los agentes')) + '\n   ' + dim('actual:  ' + current.phobos);
      const m = await pickFromList(modelsScope, uniformPrompt, current.phobos);
      setHistoryEntry('Modelo uniforme', m);
      return Object.fromEntries(AGENTS.map(a => [a, m]));
    }

    if (index === 2) {
      setHistoryEntry('Estrategia', 'Custom — agente por agente');
      const target = {};
      for (let i = 0; i < AGENTS.length; i++) {
        const agent = AGENTS[i];
        renderWizardStep(
          printModelsBanner,
          history,
          `[3/4] Asignar modelo · agente ${i + 1}/${AGENTS.length}: ${agent}`,
        );
        const prompt = agentHeaderBlock(
          i, AGENTS.length, agent,
          AGENT_PROFILES[agent].role,
          current[agent],
          recommended[agent],
        );
        target[agent] = await pickFromList(modelsScope, prompt, current[agent]);
        setHistoryEntry(`  · ${agent}`, target[agent]);
      }
      return target;
    }

    // "Cambiar proveedor" — solo si hay múltiples; loop back al sub-step 3a
    if (hasMultipleProviders && index === 3) {
      continue;
    }

    // Cancelar y salir
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Diff + aplicar
// ═══════════════════════════════════════════════════════════════════

function printDiff(current, target) {
  const wAgent = Math.max(...AGENTS.map(a => a.length));
  const wCur   = Math.max(...AGENTS.map(a => (current[a] || '').length));
  const wTgt   = Math.max(...AGENTS.map(a => (target[a]  || '').length));

  let any = false;
  const lines = AGENTS.map(agent => {
    const cur = current[agent];
    const tgt = target[agent];
    const changed = cur !== tgt;
    if (changed) any = true;
    return (
      bold(pad(agent, wAgent)) + '  ' +
      dim(pad(cur, wCur)) + '  ' +
      (changed ? cyan('→') : dim('=')) + '  ' +
      (changed ? yellow(pad(tgt, wTgt)) : dim(pad(tgt, wTgt))) + '  ' +
      (changed ? yellow('↻ cambio') : dim('· igual'))
    );
  });

  console.log('');
  panel('Resumen de cambios', lines);
  return any;
}

async function applyChanges(agentDir, current, target) {
  let changed = 0;
  for (const agent of AGENTS) {
    if (current[agent] !== target[agent]) {
      try {
        await writeModel(agentDir, agent, target[agent]);
        changed++;
      } catch (err) {
        console.error(`  ${yellow('✗')} ${agent}: ${err.message}`);
      }
    }
  }
  console.log(green(`\n✓ ${changed} agente(s) actualizado(s).`));
  if (changed > 0) {
    console.log(dim('\nSi OpenCode está abierto, cambiá de agente (Tab) y volvé para recargar.'));
  }
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// Bootstrap — chequeo y creación del scaffold
// ═══════════════════════════════════════════════════════════════════

async function findMissing() {
  const missing = { agentes: [], comandos: [], vault: [], gitignore: false };
  for (const [group, files] of Object.entries(BOOTSTRAP_GROUPS)) {
    for (const src of files) {
      const dst = srcToDst(src);
      if (!await fileExists(join(cwd(), dst))) missing[group].push(src);
    }
  }
  // .gitignore — opcional, no se sobreescribe si existe
  if (!await fileExists(join(cwd(), '.gitignore'))) {
    missing.gitignore = await fileExists(join(TEMPLATES_DIR, '.gitignore'));
  }
  return missing;
}

function summarizeMissing(missing) {
  const counts = {
    agentes: missing.agentes.length,
    comandos: missing.comandos.length,
    vault: missing.vault.length,
    gitignore: missing.gitignore ? 1 : 0,
  };
  const total = counts.agentes + counts.comandos + counts.vault + counts.gitignore;
  return { counts, total };
}

async function bootstrap(missing) {
  console.log(bold('\n  Bootstrap iniciado.\n'));

  const groupLabels = {
    agentes:  'Creando agentes      ',
    comandos: 'Creando comandos     ',
    vault:    'Creando estructura de memory',
  };

  for (const group of ['agentes', 'comandos', 'vault']) {
    const files = missing[group];
    if (files.length === 0) continue;
    for (let i = 0; i < files.length; i++) {
      const src = join(TEMPLATES_DIR, files[i]);
      const dst = join(cwd(), srcToDst(files[i]));
      await mkdir(dirname(dst), { recursive: true });
      const content = await readFile(src, 'utf-8');
      await writeFile(dst, content);
      drawProgress(groupLabels[group], i + 1, files.length);
    }
  }

  if (missing.gitignore) {
    const src = join(TEMPLATES_DIR, '.gitignore');
    const dst = join(cwd(), '.gitignore');
    const content = await readFile(src, 'utf-8');
    await writeFile(dst, content);
    console.log(`  ${green('✓')} .gitignore creado`);
  }

  console.log(green('\n  ✓ Bootstrap completo.\n'));
}

// ═══════════════════════════════════════════════════════════════════
// Update flow — compara local vs template, preserva model:
// ═══════════════════════════════════════════════════════════════════

const TRACKED_AGENT_FILES = [
  // Agents
  { src: 'opencode/agent/phobos.md',     dst: '.opencode/agent/phobos.md',     ignoreModel: true  },
  { src: 'opencode/agent/researcher.md', dst: '.opencode/agent/researcher.md', ignoreModel: true  },
  { src: 'opencode/agent/planner.md',    dst: '.opencode/agent/planner.md',    ignoreModel: true  },
  { src: 'opencode/agent/programmer.md', dst: '.opencode/agent/programmer.md', ignoreModel: true  },
  { src: 'opencode/agent/tester.md',     dst: '.opencode/agent/tester.md',     ignoreModel: true  },
  { src: 'opencode/agent/archivist.md',  dst: '.opencode/agent/archivist.md',  ignoreModel: true  },
  { src: 'opencode/agent/README.md',     dst: '.opencode/agent/README.md',     ignoreModel: false },
  // Slash commands
  { src: 'opencode/command/adapt-agents.md',   dst: '.opencode/command/adapt-agents.md',   ignoreModel: false },
  { src: 'opencode/command/models-wizard.md',  dst: '.opencode/command/models-wizard.md',  ignoreModel: false },
  { src: 'opencode/command/reindex-memory.md', dst: '.opencode/command/reindex-memory.md', ignoreModel: false },
];

function normalizeIgnoringModel(content) {
  return content.replace(/^model:\s*.+$/m, 'model: <PRESERVED>');
}

async function scanForUpdates() {
  const result = { outdated: [], missing: [], inSync: [] };

  for (const f of TRACKED_AGENT_FILES) {
    const templatePath = join(TEMPLATES_DIR, f.src);
    const localPath = join(cwd(), f.dst);

    if (!await fileExists(templatePath)) continue;

    if (!await fileExists(localPath)) {
      result.missing.push({ ...f, templatePath, localPath });
      continue;
    }

    const tmpl = await readFile(templatePath, 'utf-8');
    const local = await readFile(localPath, 'utf-8');

    const tmplCmp = f.ignoreModel ? normalizeIgnoringModel(tmpl) : tmpl;
    const localCmp = f.ignoreModel ? normalizeIgnoringModel(local) : local;

    if (tmplCmp === localCmp) {
      result.inSync.push({ ...f, localPath });
    } else {
      result.outdated.push({ ...f, templatePath, localPath });
    }
  }

  return result;
}

async function applyUpdate(file, { preserveLocalModel = true } = {}) {
  const tmpl = await readFile(file.templatePath, 'utf-8');
  let content = tmpl;

  if (file.ignoreModel && preserveLocalModel) {
    const local = await readFile(file.localPath, 'utf-8');
    const m = local.match(/^model:\s*(.+)$/m);
    if (m) {
      content = tmpl.replace(/^model:\s*.+$/m, `model: ${m[1].trim()}`);
    }
  }
  // Si preserveLocalModel=false, dejamos el modelo del template intacto.

  await writeFile(file.localPath, content);
}

async function getTemplateModel(file) {
  try {
    const tmpl = await readFile(file.templatePath, 'utf-8');
    const m = tmpl.match(/^model:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function copyTemplateFile(file) {
  const content = await readFile(file.templatePath, 'utf-8');
  await mkdir(dirname(file.localPath), { recursive: true });
  await writeFile(file.localPath, content);
}

function showUpdateStatus(updates) {
  const lines = [];
  for (const f of updates.outdated) {
    lines.push(yellow('↻ ') + bold(pad(basename(f.dst), 16)) + dim('  diferente del template'));
  }
  for (const m of updates.missing) {
    lines.push(red('⚠ ') + bold(pad(basename(m.dst), 16)) + red('  no existe — se creará'));
  }
  for (const s of updates.inSync) {
    lines.push(green('✓ ') + dim(pad(basename(s.dst), 16)) + dim('  sincronizado'));
  }
  console.log('');
  panel('Estado de agentes vs template', lines);
}

function showAgentDiff(file) {
  console.log(dim('\n  Diff (local ← → template). El campo ') + cyan('model:') + dim(' se preserva al actualizar.\n'));
  const r = tryExec(`git --no-pager diff --no-index --color=always -- "${file.localPath}" "${file.templatePath}"`, 8000);
  if (r.ok && r.out) {
    console.log(r.out);
  } else if (r.err && /^\s*$/.test(r.err)) {
    console.log(dim('  (no se pudo mostrar diff)'));
  } else {
    // git diff exits 1 cuando hay diferencias; igual el output viene por stdout
    console.log(r.err || '');
  }
}

// runUpdateWizard — Step 4 cuando se eligió "Revisar uno por uno".
// Recibe `history` mutable: cada archivo procesado agrega una línea al historial
// superior y limpia la pantalla en el siguiente archivo.
async function runUpdateWizard(history, updates) {
  for (let i = 0; i < updates.outdated.length; i++) {
    const f = updates.outdated[i];
    const fileName = basename(f.dst);

    // Leer modelos para mostrar la diferencia si la hay
    const localContent = await readFile(f.localPath, 'utf-8');
    const localModelMatch = localContent.match(/^model:\s*(.+)$/m);
    const localModel = localModelMatch ? localModelMatch[1].trim() : '(sin model)';
    const templateModel = await getTemplateModel(f);
    const modelsDiffer = f.ignoreModel && templateModel && localModel !== templateModel;

    while (true) {
      renderWizardStep(
        printUpdateBanner,
        history,
        `[4/4] Aplicar · archivo ${i + 1}/${updates.outdated.length}: ${fileName}`,
      );

      const options = [
        `Actualizar y preservar mi modelo  ${dim('(' + localModel + ')')}`,
      ];
      if (modelsDiffer) {
        options.push(`Actualizar y usar el modelo del template  ${dim('(' + templateModel + ')')}`);
      }
      options.push('Ver diff antes de decidir');
      options.push('Saltar este');

      const { index } = await tuiSelect(
        '\n' + bold(fileName) + dim('  — tiene cambios respecto al template'),
        options,
        0,
      );

      const idxPreserve = 0;
      const idxAcceptTemplate = modelsDiffer ? 1 : -1;
      const idxDiff = modelsDiffer ? 2 : 1;
      const idxSkip = modelsDiffer ? 3 : 2;

      if (index === idxPreserve) {
        await applyUpdate(f, { preserveLocalModel: true });
        history.push({
          label: `  · ${fileName}`,
          value: `actualizado, modelo preservado (${localModel})`,
        });
        break;
      } else if (index === idxAcceptTemplate) {
        await applyUpdate(f, { preserveLocalModel: false });
        history.push({
          label: `  · ${fileName}`,
          value: `actualizado, modelo del template (${templateModel})`,
        });
        break;
      } else if (index === idxDiff) {
        // Mostrar diff inline y volver a preguntar (no se agrega al history)
        showAgentDiff(f);
        console.log('');
        console.log(dim('  Presioná Enter para volver a la pregunta...'));
        await new Promise((resolve) => {
          const onKey = (str, key) => {
            if (key && (key.name === 'return' || key.name === 'space' || key.name === 'escape')) {
              stdin.removeListener('keypress', onKey);
              try { stdin.setRawMode(false); } catch {}
              resolve();
            }
          };
          try { stdin.setRawMode(true); } catch {}
          stdin.resume();
          stdin.on('keypress', onKey);
        });
        // loop back: el siguiente iteración del while re-renderiza desde cero
      } else if (index === idxSkip) {
        history.push({
          label: `  · ${fileName}`,
          value: 'saltado, sin cambios',
        });
        break;
      }
    }
  }

  // Archivos faltantes — preguntar al final
  if (updates.missing.length > 0) {
    renderWizardStep(
      printUpdateBanner,
      history,
      `[4/4] Aplicar · archivos faltantes (${updates.missing.length})`,
    );

    const create = await tuiYesNo(
      `\n¿Crear los ${updates.missing.length} archivos faltantes (${updates.missing.map(m => basename(m.dst)).join(', ')})?`,
      true,
    );
    if (create) {
      for (const m of updates.missing) {
        await copyTemplateFile(m);
        history.push({
          label: `  · ${basename(m.dst)}`,
          value: 'creado desde template',
        });
      }
    } else {
      history.push({
        label: '  · faltantes',
        value: `${updates.missing.length} no creado${updates.missing.length > 1 ? 's' : ''} (saltados por el usuario)`,
      });
    }
  }
}

async function backupAgents(filesToBackup) {
  // filesToBackup: array de paths relativos al cwd (ej: '.opencode/agent/phobos.md')
  // Si está vacío, no hace nada.
  if (!filesToBackup || filesToBackup.length === 0) {
    console.log(dim('\n  ⊘ Backup omitido — no hay archivos que vayan a modificarse.'));
    return;
  }

  const now = new Date();
  const ts =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');

  const backupRel = `.opencode/agent_backup/phobos/${ts}`;
  const backupDir = join(cwd(), backupRel);
  await mkdir(backupDir, { recursive: true });

  let copied = 0;
  const names = [];

  for (const relPath of filesToBackup) {
    const filename = basename(relPath);
    const src = join(cwd(), relPath);
    const dst = join(backupDir, filename);
    if (await fileExists(src)) {
      const content = await readFile(src, 'utf-8');
      await writeFile(dst, content);
      copied++;
      names.push(filename);
    }
  }

  console.log(green(`\n  ✓ Backup creado: `) + cyan(backupRel + '/'));
  console.log(dim(`    ${copied} archivo(s) copiados: ${names.join(', ')}`));
}

async function runUpdateAll(updates) {
  for (const f of updates.outdated) {
    await applyUpdate(f);
    console.log(green('  ✓ ' + basename(f.dst) + ' actualizado.'));
  }
  for (const m of updates.missing) {
    await copyTemplateFile(m);
    console.log(green('  ✓ ' + basename(m.dst) + ' creado.'));
  }
}

async function ensureUpdated() {
  const updates = await scanForUpdates();
  const nothingToDo = updates.outdated.length === 0 && updates.missing.length === 0;

  if (nothingToDo) {
    console.log(dim('\n  ✓ Agentes sincronizados con la última versión del template.'));
    return;
  }

  showUpdateStatus(updates);

  const totalOutdated = updates.outdated.length;
  const totalMissing = updates.missing.length;
  const totalToTouch = totalOutdated + totalMissing;
  const detail = [
    totalOutdated > 0 ? `${totalOutdated} ↻ diferente${totalOutdated > 1 ? 's' : ''}` : null,
    totalMissing > 0 ? `${totalMissing} ⚠ faltante${totalMissing > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' + ');

  const { index } = await tuiSelect(
    '\n¿Qué hacés con las actualizaciones?',
    [
      'Revisar uno por uno (Recomendado)',
      `Aplicar todas las actualizaciones pendientes  ${dim('(' + detail + ', preserva mis modelos)')}`,
      'Saltar — no actualizar nada',
    ],
    0,
  );

  if (index === 2) {
    console.log(dim('\n  ⊘ Actualización saltada.'));
    return;
  }

  // Antes de hacer cualquier cambio, ofrecer backup — solo de los archivos que van a cambiar
  // (outdated). Los inSync no se tocan; los missing no existen aún, no hay nada que respaldar.
  const filesToBackup = updates.outdated.map(f => f.dst);

  if (filesToBackup.length > 0) {
    const names = filesToBackup.map(p => basename(p)).join(', ');
    const wantsBackup = await tuiYesNo(
      `\n¿Querés hacer un backup de ${filesToBackup.length} archivo${filesToBackup.length > 1 ? 's' : ''} antes de actualizar? ${dim('(' + names + ')')}`,
      true,
    );
    if (wantsBackup) {
      await backupAgents(filesToBackup);
    }
  } else {
    console.log(dim('\n  (sin archivos modificables — no se ofrece backup)'));
  }

  if (index === 0) {
    await runUpdateWizard(updates);
  } else if (index === 1) {
    await runUpdateAll(updates);
  }
}

async function ensureBootstrap() {
  const missing = await findMissing();
  const { total } = summarizeMissing(missing);

  if (total === 0) return true;

  const confirm = await tuiYesNo('\n¿Querés instalar los agentes en este proyecto?', true);
  if (!confirm) {
    return false;
  }

  await bootstrap(missing);
  return true;
}

function showHappyGoodbye() {
  console.log('');
  console.log(dim('         ┏━━━━━━━━━━━┓'));
  console.log(dim('         ┃           ┃'));
  console.log(dim('         ┃  ') + green('·     ·') + dim('  ┃'));
  console.log(dim('         ┃           ┃'));
  console.log(dim('         ┃   ') + green('\\___/') + dim('   ┃'));
  console.log(dim('         ┃           ┃'));
  console.log(dim('         ┗━━━━━━━━━━━┛'));
  console.log('');
  console.log('   ' + bold(green('¡Listo!')) + '  Buen vuelo con Phobos.');
  console.log(dim('   Configurá nuevos modelos cuando quieras con:  ') + cyan('npx github:sebaarce/phobos'));
  console.log('');
}

function showSadGoodbye() {
  console.log('');
  console.log(dim('         ┏━━━━━━━━━━━┓'));
  console.log(dim('         ┃           ┃'));
  console.log(dim('         ┃  ') + yellow('·     ·') + dim('  ┃'));
  console.log(dim('         ┃           ┃'));
  console.log(dim('         ┃    ') + yellow('___') + dim('    ┃'));
  console.log(dim('         ┃   ') + yellow('/') + dim('   ') + yellow('\\') + dim('   ┃'));
  console.log(dim('         ┃           ┃'));
  console.log(dim('         ┗━━━━━━━━━━━┛'));
  console.log('');
  console.log(dim('   Phobos no se instaló en este proyecto.'));
  console.log(dim('   Volvé cuando quieras con:  ') + cyan('npx github:sebaarce/phobos'));
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════
// Acciones — cada una es una "pantalla" del wizard
// ═══════════════════════════════════════════════════════════════════

// renderWizardStep — clear + banner + historial compacto + header del paso actual.
// Llamar al INICIO de cada step grande. Las preguntas/info del step se acumulan
// debajo del header hasta que se llama de nuevo (clear + nuevo header).
//
// history: array de { label, value } — el resumen de respuestas ya completadas.
// stepHeader: string con el header del paso actual (ej: "[2/4] Definir lista de modelos").
function renderWizardStep(bannerFn, history, stepHeader) {
  clearScreen();
  bannerFn();

  if (history.length > 0) {
    const wLabel = Math.max(...history.map(h => visibleLen(h.label)));
    for (const item of history) {
      const padded = item.label + ' '.repeat(Math.max(0, wLabel - visibleLen(item.label)));
      console.log('  ' + green('✓') + ' ' + padded + '   ' + dim(item.value));
    }
    console.log('');
    console.log(dim('  ─────────────────────────────────────────────────────'));
    console.log('');
  }

  if (stepHeader) {
    console.log('  ' + bold(cyan(stepHeader)));
    console.log('');
  }
}

async function actionUpdateAgents() {
  const history = [];

  // ─── Step 1/4: Detectar archivos diferentes y faltantes ────────────
  renderWizardStep(printUpdateBanner, history, '[1/4] Detectando estado de templates...');
  const updates = await scanForUpdates();
  const totalOutdated = updates.outdated.length;
  const totalMissing = updates.missing.length;
  const totalInSync = updates.inSync.length;
  const nothingToDo = totalOutdated === 0 && totalMissing === 0;

  showUpdateStatus(updates);

  history.push({
    label: 'Detección',
    value: nothingToDo
      ? `Todo al día (${totalInSync} archivo${totalInSync > 1 ? 's' : ''} sincronizados)`
      : [
          totalOutdated > 0 ? `${totalOutdated} ↻ diferente${totalOutdated > 1 ? 's' : ''}` : null,
          totalMissing > 0 ? `${totalMissing} ⚠ faltante${totalMissing > 1 ? 's' : ''}` : null,
          totalInSync > 0 ? `${totalInSync} ✓ al día` : null,
        ].filter(Boolean).join(', '),
  });

  if (nothingToDo) {
    renderWizardStep(printUpdateBanner, history, '');
    console.log('  ' + green('✓ Agentes sincronizados con la última versión del template.'));
    console.log('  ' + dim('No hay nada que actualizar.'));
    await pressEnterToContinue();
    return;
  }

  // ─── Step 2/4: Elegir estrategia ───────────────────────────────────
  renderWizardStep(printUpdateBanner, history, '[2/4] Elegir estrategia de actualización');

  const detail = [
    totalOutdated > 0 ? `${totalOutdated} ↻ diferente${totalOutdated > 1 ? 's' : ''}` : null,
    totalMissing > 0 ? `${totalMissing} ⚠ faltante${totalMissing > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' + ');

  const { index } = await tuiSelect(
    '\n¿Qué hacés con las actualizaciones?',
    [
      'Revisar uno por uno (Recomendado)',
      `Aplicar todas las actualizaciones pendientes  ${dim('(' + detail + ', preserva mis modelos)')}`,
      'Saltar — no actualizar nada',
    ],
    0,
  );

  if (index === 2) {
    history.push({ label: 'Estrategia', value: 'Saltar — sin cambios' });
    renderWizardStep(printUpdateBanner, history, '');
    console.log('  ' + dim('⊘ Actualización saltada.'));
    await pressEnterToContinue();
    return;
  }

  const strategyLabel = index === 0 ? 'Revisar uno por uno' : 'Aplicar todas (preserva modelos)';
  history.push({ label: 'Estrategia', value: strategyLabel });

  // ─── Step 3/4: Backup previo ───────────────────────────────────────
  renderWizardStep(printUpdateBanner, history, '[3/4] Backup previo a la actualización');

  const filesToBackup = updates.outdated.map(f => f.dst);
  let backupApplied = false;

  if (filesToBackup.length > 0) {
    const names = filesToBackup.map(p => basename(p)).join(', ');
    const wantsBackup = await tuiYesNo(
      `\n¿Querés hacer un backup de ${filesToBackup.length} archivo${filesToBackup.length > 1 ? 's' : ''} antes de actualizar? ${dim('(' + names + ')')}`,
      true,
    );
    if (wantsBackup) {
      await backupAgents(filesToBackup);
      backupApplied = true;
    }
    history.push({
      label: 'Backup',
      value: backupApplied
        ? `${filesToBackup.length} archivo${filesToBackup.length > 1 ? 's respaldados' : ' respaldado'} en .opencode/agent_backup/`
        : 'Saltado por el usuario',
    });
  } else {
    history.push({
      label: 'Backup',
      value: 'No aplica (sin archivos modificables — solo faltantes)',
    });
  }

  // ─── Step 4/4: Aplicar cambios ─────────────────────────────────────
  if (index === 0) {
    // Modo "Revisar uno por uno" — runUpdateWizard hace su propio renderWizardStep
    // por cada archivo y va agregando entries al history.
    await runUpdateWizard(history, updates);
  } else {
    // Modo "Aplicar todas" — un solo render + ejecución en bloque
    renderWizardStep(printUpdateBanner, history, '[4/4] Aplicar todas las actualizaciones');
    await runUpdateAll(updates);
    history.push({
      label: 'Aplicado',
      value: `${totalOutdated + totalMissing} archivo${(totalOutdated + totalMissing) > 1 ? 's' : ''} actualizado${(totalOutdated + totalMissing) > 1 ? 's' : ''}`,
    });
  }

  // ─── Pantalla final con resumen completo ───────────────────────────
  renderWizardStep(printUpdateBanner, history, '');
  console.log('  ' + green('Wizard de actualización completado.'));
  await pressEnterToContinue();
}

async function actionSetModels(agentDir) {
  const history = [];

  // ─── Step 1/4: Detectar providers ──────────────────────────────────
  renderWizardStep(printModelsBanner, history, '[1/4] Detectando providers conectados...');
  const detected = await detect();

  if (detected.providers.size === 0) {
    console.log('  ' + yellow('✗ No detecté proveedores conectados en OpenCode.'));
    console.log('');
    console.log('  ' + dim('Para configurar modelos necesitás al menos un proveedor conectado.'));
    console.log('');
    console.log('  ' + bold('Para conectar uno:'));
    console.log('    ' + dim('1.') + ' Iniciá OpenCode con  ' + cyan('opencode'));
    console.log('    ' + dim('2.') + ' Agregá un proveedor con  ' + cyan('/connect'));
    console.log('');
    await pressEnterToContinue();
    return;
  }

  summarizeDetection(detected);
  history.push({
    label: 'Detección',
    value: `${detected.providers.size} provider${detected.providers.size > 1 ? 's' : ''}, ${detected.models.size} modelos`,
  });

  // ─── Step 2/4: Definir lista de modelos a asignar ──────────────────
  renderWizardStep(printModelsBanner, history, '[2/4] Definir lista de modelos a asignar');
  const allModels = await getFinalModelList(detected);
  if (!allModels || allModels.length === 0) {
    console.log('\n  ' + yellow('Lista vacía — no se puede continuar.'));
    await pressEnterToContinue();
    return;
  }
  history.push({
    label: 'Lista de modelos',
    value: `${allModels.length} modelo${allModels.length > 1 ? 's' : ''} disponibles`,
  });

  // ─── Step 3/4: Asignar modelo a cada agente ────────────────────────
  //   (chooseMode hace su propio renderWizardStep antes de cada sub-pregunta
  //    y va agregando entries al historial: Provider, Estrategia, y por agente
  //    si se eligió custom)
  const current = await readCurrentModels(agentDir);
  const target = await chooseMode(history, allModels, current);
  if (!target) {
    history.push({ label: 'Asignación', value: 'Cancelado por el usuario' });
    renderWizardStep(printModelsBanner, history, '');
    console.log('  ' + yellow('Wizard cancelado — sin cambios aplicados.'));
    await pressEnterToContinue();
    return;
  }
  const agentsToChange = AGENTS.filter(a => current[a] !== target[a]);

  // ─── Step 4/4: Aplicar cambios ─────────────────────────────────────
  renderWizardStep(printModelsBanner, history, '[4/4] Aplicar cambios');
  const hasChanges = printDiff(current, target);

  if (hasChanges) {
    const confirm = await tuiYesNo('\n¿Aplicar los cambios?', false);
    if (confirm) {
      await applyChanges(agentDir, current, target);
      history.push({
        label: 'Aplicado',
        value: `${agentsToChange.length} cambio${agentsToChange.length > 1 ? 's' : ''} persistido${agentsToChange.length > 1 ? 's' : ''} en .opencode/agent/`,
      });
    } else {
      history.push({ label: 'Aplicado', value: 'Cancelado por el usuario, ningún archivo modificado' });
    }
  } else {
    console.log('\n  ' + dim('✓ Los modelos ya están configurados — no hay cambios que aplicar.'));
    history.push({ label: 'Aplicado', value: 'Sin cambios (ya estaba al día)' });
  }

  // ─── Pantalla final con resumen completo ───────────────────────────
  renderWizardStep(printModelsBanner, history, '');
  console.log('  ' + green('Wizard completado.'));
  await pressEnterToContinue();
}

async function actionInstallTools() {
  while (true) {
    clearScreen();
    printToolsBanner();
    panel('Instalar herramientas', [
      'Cada acción ejecuta un comando externo y vuelve a este menú al terminar.',
      dim('Elegí una opción con ↑/↓ y Enter.'),
    ]);

    const { index } = await tuiSelect(
      '\n¿Qué querés hacer?',
      [
        'npx autoskills           ' + dim('— skills del proyecto en ./skills/'),
        'Instalar obsidian-skills ' + dim('— vault/notes en formato Obsidian'),
        'Instalar impeccable      ' + dim('— skill de diseño/UI (vocab + anti-patterns)'),
        'Abrir OpenCode           ' + dim('— lanzar el TUI'),
        dim('← Volver al menú principal'),
      ],
      0,
    );

    if (index === 4) return; // volver

    rl.pause();
    if (index === 0) {
      await runChild('npx', ['autoskills'], 'Generar skills/ del proyecto');
    } else if (index === 1) {
      await installObsidianSkills();
    } else if (index === 2) {
      await installImpeccable();
    } else if (index === 3) {
      await runChild('opencode', [], 'Abrir OpenCode');
      // Si se abrió OpenCode, el usuario probablemente quiera salir del wizard
      showHappyGoodbye();
      finalizeAndExit(0);
      return;
    }

    await pressEnterToContinue();
  }
}

// ═══════════════════════════════════════════════════════════════════
// Memory installer — Qdrant GLOBAL en ~/.phobos/ + collection per project
// ═══════════════════════════════════════════════════════════════════

// Engine files que se copian al proyecto destino. El docker-compose y el
// storage de Qdrant ya NO se copian al proyecto — viven globales en ~/.phobos/.
const MEMORY_ENGINE_FILES = [
  // src (relativo a TEMPLATES_DIR) → dst (relativo al cwd del proyecto)
  { src: 'phobos/memory/.engine/config.json',         dst: 'vault/memory/.engine/config.json' },
  { src: 'phobos/memory/.engine/embed.mjs',           dst: 'vault/memory/.engine/embed.mjs' },
  { src: 'phobos/memory/.engine/chunk.mjs',           dst: 'vault/memory/.engine/chunk.mjs' },
  { src: 'phobos/memory/.engine/qdrant-client.mjs',   dst: 'vault/memory/.engine/qdrant-client.mjs' },
  { src: 'phobos/memory/.engine/index-vault.mjs',     dst: 'vault/memory/.engine/index-vault.mjs' },
  { src: 'phobos/memory/.engine/search.mjs',          dst: 'vault/memory/.engine/search.mjs' },
  { src: 'phobos/memory/.engine/README.md',           dst: 'vault/memory/.engine/README.md' },
];

// Path global donde vive la instancia compartida de Qdrant.
const PHOBOS_HOME = join(homedir(), '.phobos');
const QDRANT_COMPOSE_GLOBAL = join(PHOBOS_HOME, 'docker-compose.qdrant.yml');
const QDRANT_URL = 'http://localhost:6333';
const QDRANT_CONTAINER = 'phobos-qdrant';

function checkCommand(cmd) {
  // Run with shell:true so PATH resolution works on Windows.
  const r = tryExec(platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, 3000);
  return r.ok && r.out.trim().length > 0;
}

async function readPackageJson() {
  try {
    const raw = await readFile(join(cwd(), 'package.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function detectPackageManager() {
  if (await fileExists('pnpm-lock.yaml')) return 'pnpm';
  if (await fileExists('yarn.lock')) return 'yarn';
  if (await fileExists('bun.lockb') || await fileExists('bun.lock')) return 'bun';
  return 'npm';
}

// Detecta stacks que históricamente requieren --legacy-peer-deps con NPM v7+
// (conflictos de peer dependencies habituales).
async function detectProblematicStack() {
  const pkg = await readPackageJson();
  if (!pkg) return [];
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const indicators = [
    { stack: 'NestJS',       test: () => Object.keys(allDeps).some(k => k.startsWith('@nestjs/')) },
    { stack: 'Angular',      test: () => Object.keys(allDeps).some(k => k.startsWith('@angular/')) },
    { stack: 'Next.js',      test: () => 'next' in allDeps },
    { stack: 'React Native', test: () => 'react-native' in allDeps },
  ];
  return indicators.filter(i => i.test()).map(i => i.stack);
}

// Lee el .npmrc del proyecto y devuelve true si tiene legacy-peer-deps habilitado.
async function checkNpmrcHasLegacyPeerDeps() {
  try {
    const content = await readFile(join(cwd(), '.npmrc'), 'utf-8');
    return /^\s*legacy-peer-deps\s*=\s*true/im.test(content);
  } catch {
    return false;
  }
}

// Persiste legacy-peer-deps=true en el .npmrc del proyecto (idempotente).
async function addLegacyPeerDepsToNpmrc() {
  const npmrcPath = join(cwd(), '.npmrc');
  let existing = '';
  try {
    existing = await readFile(npmrcPath, 'utf-8');
  } catch {}
  if (/^\s*legacy-peer-deps\s*=\s*true/im.test(existing)) {
    return { added: false, reason: 'ya estaba' };
  }
  const snippet = '# Phobos Memory installer — NestJS/Angular peer-deps fix\nlegacy-peer-deps=true\n';
  const content = existing.trim()
    ? existing.trim() + '\n\n' + snippet
    : snippet;
  await writeFile(npmrcPath, content);
  return { added: true };
}

// Verifica si los paquetes de Memory están realmente presentes en node_modules.
// Lo usamos como segunda señal después del install — pnpm/npm pueden retornar
// exit code != 0 por warnings o por descargas parciales pero igual dejar los
// paquetes utilizables.
async function verifyMemoryDepsInstalled() {
  const required = ['@xenova/transformers', '@qdrant/js-client-rest'];
  const missing = [];
  for (const dep of required) {
    const pjPath = join(cwd(), 'node_modules', dep, 'package.json');
    if (!await fileExists(pjPath)) missing.push(dep);
  }
  return { ok: missing.length === 0, missing };
}

// Ejecuta el comando de install hasta que tenga éxito o el usuario cancele.
// Detecta errores comunes (ERESOLVE de NPM) y ofrece flags específicas
// (--legacy-peer-deps, --force) en el menú de reintento.
async function installMemoryDepsWithRetry(pm, depList, initialFlags = []) {
  let currentPm = pm;
  let extraFlags = [...initialFlags];

  const installCmdFor = (m) => m === 'yarn' ? 'add'
                              : m === 'pnpm' ? 'add'
                              : m === 'bun' ? 'add'
                              : 'install';

  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) {
      console.log('');
      const flagsStr = extraFlags.length ? ' ' + extraFlags.join(' ') : '';
      console.log(dim(`  Reintento ${attempt - 1}/4 con ${currentPm}${flagsStr}...`));
    }

    const installCmd = installCmdFor(currentPm);
    const args = [installCmd, ...depList, ...extraFlags];
    const label = `Instalar deps (${currentPm}${extraFlags.length ? ' ' + extraFlags.join(' ') : ''})`;

    rl.pause();
    const exitCode = await runChild(currentPm, args, label);

    const verify = await verifyMemoryDepsInstalled();

    if (verify.ok) {
      if (exitCode !== 0) {
        console.log('');
        console.log(yellow(`  ⚠ ${currentPm} retornó exit code ${exitCode} pero los paquetes están en node_modules.`));
        console.log(dim('    Probablemente warnings de subdependencias deprecadas o de scripts opcionales.'));
        console.log(dim('    Continuamos — los paquetes principales están utilizables.'));
      }
      return { ok: true, exitCode, usedFlags: [...extraFlags], usedPm: currentPm };
    }

    // Falló y faltan paquetes
    console.log('');
    console.log(red(`  ✗ Faltan paquetes en node_modules: ${verify.missing.join(', ')}`));
    console.log(dim('    Exit code de ' + currentPm + ': ' + exitCode));
    console.log('');
    console.log('  ' + bold('Causas comunes:'));
    console.log('    ' + dim('· ') + yellow('Conflicto de peer dependencies (npm error ERESOLVE)') + dim(' — típico en proyectos NestJS/Angular.'));
    console.log('    ' + dim('  Fix: usar ') + cyan('--legacy-peer-deps') + dim(' (NPM lo sugiere en su propio output).'));
    console.log('    ' + dim('· Red/firewall bloqueando descarga de binarios nativos (onnxruntime).'));
    console.log('    ' + dim('· Antivirus interceptando archivos durante la descarga.'));
    console.log('    ' + dim('· Mirror de npm/pnpm temporal con problemas.'));
    console.log('    ' + dim('· Espacio en disco insuficiente (los paquetes pesan ~50-80 MB).'));
    console.log('');

    // Opciones del menú dependen del package manager actual.
    let options, handlers;
    if (currentPm === 'npm') {
      options = [
        'Reintentar con npm ' + green('--legacy-peer-deps') + dim('  (recomendado para ERESOLVE)'),
        'Reintentar con npm ' + yellow('--force') + dim('  (más agresivo, último recurso)'),
        'Reintentar con npm (sin flags adicionales)',
        'Cancelar instalación de Memory',
      ];
      handlers = [
        () => { extraFlags = ['--legacy-peer-deps']; },
        () => { extraFlags = ['--force']; },
        () => { extraFlags = []; },
        null, // cancel
      ];
    } else {
      options = [
        `Reintentar con ${currentPm} (sin cambios)`,
        'Cambiar a npm + ' + green('--legacy-peer-deps') + dim('  (recomendado para ERESOLVE)'),
        'Cambiar a npm (sin flags)',
        'Cancelar instalación de Memory',
      ];
      handlers = [
        () => { extraFlags = []; },
        () => { currentPm = 'npm'; extraFlags = ['--legacy-peer-deps']; },
        () => { currentPm = 'npm'; extraFlags = []; },
        null,
      ];
    }

    const choice = await tuiSelect('\n¿Qué hacés?', options, 0);
    const handler = handlers[choice.index];
    if (!handler) {
      return { ok: false, exitCode, missing: verify.missing };
    }
    handler();
  }

  return { ok: false, exitCode: -1, missing: ['(retries exhausted)'] };
}

// Convierte el nombre del proyecto en un slug válido para Qdrant collection name.
// Qdrant acepta: alfanumérico + `_` + `-`. Caso edge: si el basename quedara vacío,
// usamos un fallback derivado del path completo.
function projectCollectionSlug() {
  const base = basename(cwd()).toLowerCase();
  let slug = base.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) {
    // Edge case: proyectos con nombres exóticos. Hash corto del path.
    slug = 'project-' + Buffer.from(cwd()).toString('hex').slice(0, 8);
  }
  return `phobos-vault-${slug}`;
}

// Chequea si los agentes researcher.md y archivist.md del proyecto tienen
// las reglas de soporte de Memory (pre-flight search en researcher, trigger
// reindex en archivist). Si ambos las tienen, Memory va a funcionar
// automáticamente. Si no, el engine se instala pero los agentes viejos no la
// usan — el usuario debe correr "Actualizar agentes" primero.
async function detectAgentsHaveMemorySupport() {
  const researcherPath = join(cwd(), '.opencode/agent/researcher.md');
  const archivistPath = join(cwd(), '.opencode/agent/archivist.md');

  let researcherOK = false;
  let archivistOK = false;

  try {
    const r = await readFile(researcherPath, 'utf-8');
    researcherOK = /Pre-flight:\s*semantic\s*search/i.test(r)
      || /vault\/memory\/\.engine\/search\.mjs/.test(r);
  } catch {}

  try {
    const a = await readFile(archivistPath, 'utf-8');
    archivistOK = /Trigger\s*semantic\s*re-?index/i.test(a)
      || /vault\/memory\/\.engine\/index-vault\.mjs/.test(a);
  } catch {}

  return { researcherOK, archivistOK };
}

// Estado de Qdrant global. Devuelve { containerRunning, healthy }.
async function detectQdrantStatus() {
  const ps = tryExec(
    `docker ps --filter name=${QDRANT_CONTAINER} --filter status=running --format "{{.Names}}"`,
    4000,
  );
  const containerRunning = ps.ok && ps.out.trim() === QDRANT_CONTAINER;

  let healthy = false;
  if (containerRunning) {
    // Intenta el endpoint /healthz con timeout corto. fetch global (Node 18+).
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const r = await fetch(`${QDRANT_URL}/healthz`, { signal: controller.signal });
      clearTimeout(timer);
      healthy = r.ok;
    } catch {
      healthy = false;
    }
  }

  return { containerRunning, healthy };
}

// Asegura que ~/.phobos/ exista y tenga el docker-compose.qdrant.yml copiado.
// Idempotente: si ya existen, no los toca.
async function ensurePhobosHome() {
  await mkdir(PHOBOS_HOME, { recursive: true });
  await mkdir(join(PHOBOS_HOME, 'qdrant-storage'), { recursive: true });

  if (!await fileExists(QDRANT_COMPOSE_GLOBAL)) {
    const srcPath = join(TEMPLATES_DIR, 'phobos/memory/docker-compose.qdrant.yml');
    if (!await fileExists(srcPath)) {
      throw new Error(`Template no encontrado: ${srcPath}`);
    }
    const content = await readFile(srcPath, 'utf-8');
    await writeFile(QDRANT_COMPOSE_GLOBAL, content);
    return { created: true };
  }
  return { created: false };
}

// Copia el engine al proyecto + reescribe config.json con el collection slug
// específico de este proyecto. Esto es lo que hace que cada proyecto tenga su
// propia "memoria" dentro de la instancia global de Qdrant.
async function copyMemoryEngineToProject(collectionName) {
  for (const file of MEMORY_ENGINE_FILES) {
    const srcPath = join(TEMPLATES_DIR, file.src);
    const dstPath = join(cwd(), file.dst);
    if (!await fileExists(srcPath)) {
      console.log(yellow(`  ⚠ template no encontrado: ${file.src}`));
      continue;
    }
    await mkdir(dirname(dstPath), { recursive: true });
    let content = await readFile(srcPath, 'utf-8');

    // Para config.json — substituir el collection name por el slug del proyecto.
    if (basename(file.src) === 'config.json') {
      const parsed = JSON.parse(content);
      parsed.qdrant.collection = collectionName;
      content = JSON.stringify(parsed, null, 2) + '\n';
    }

    await writeFile(dstPath, content);
    console.log(dim('  · ') + cyan(file.dst));
  }
}

async function appendGitignoreSnippet() {
  const snippetPath = join(TEMPLATES_DIR, 'phobos/memory/.gitignore.snippet');
  if (!await fileExists(snippetPath)) return;
  const snippet = await readFile(snippetPath, 'utf-8');
  const gitignorePath = join(cwd(), '.gitignore');
  let existing = '';
  try { existing = await readFile(gitignorePath, 'utf-8'); } catch {}
  if (existing.includes('vault/memory/.engine/.index-state.json')) {
    console.log(dim('  · .gitignore ya tiene la entrada de memory.'));
    return;
  }
  const joined = (existing.trim() + '\n\n' + snippet.trim() + '\n').replace(/^\s+/, '');
  await writeFile(gitignorePath, joined);
  console.log(dim('  · .gitignore actualizado con .index-state.json'));
}

// Router de la opción "Memory (RAG)" del menú principal.
// - Si Memory NO está instalada → corre el wizard de instalación.
// - Si Memory SÍ está instalada → muestra un submenú con: Re-indexar,
//   Reset Qdrant, Re-instalar engine, Volver.
async function actionMemory() {
  const installed = await fileExists('vault/memory/.engine/config.json');
  if (!installed) {
    return actionInstallMemory();
  }

  while (true) {
    clearScreen();
    printMemoryBanner();

    const qdrant = await detectQdrantStatus();
    const collectionName = projectCollectionSlug();
    const collections = qdrant.healthy ? await listQdrantCollections() : [];

    panel('Memory (RAG) — submenú', [
      'Memory ya está instalada en este proyecto.',
      'Collection de este proyecto: ' + cyan(collectionName),
      'Qdrant global: ' + (qdrant.healthy
        ? green('✓ corriendo')
        : (qdrant.containerRunning ? yellow('⚠ arrancando') : yellow('no corriendo'))),
      qdrant.healthy ? `Collections en Qdrant: ${collections.length} ${dim('(' + (collections.slice(0,3).join(', ') || 'ninguna') + (collections.length > 3 ? ', …' : '') + ')')}` : '',
    ].filter(Boolean));

    let choice;
    try {
      choice = await tuiSelect(
        '\n¿Qué querés hacer?',
        [
          'Inspect Qdrant ' + dim('(estado, collections, samples, sanity de agentes — read-only)'),
          'Re-indexar este proyecto (--force, vuelve a vectorizar todo)',
          'Reset Qdrant global ' + dim('(destructivo · borra storage de TODOS los proyectos · backup opcional)'),
          'Re-instalar engine en este proyecto ' + dim('(sobreescribe vault/memory/.engine/ con templates frescos)'),
          dim('← Volver al menú principal'),
        ],
        0,
      );
    } catch (err) {
      if (err === WIZARD_CANCELLED) return; // Esc en submenú = volver al menú principal
      throw err;
    }

    if (choice.index === 4) return;
    if (choice.index === 0) {
      await runAction(() => actionInspectQdrant());
    } else if (choice.index === 1) {
      await runAction(() => actionMemoryReindexForce());
    } else if (choice.index === 2) {
      await runAction(() => actionResetQdrant());
    } else if (choice.index === 3) {
      await runAction(() => actionInstallMemory());
    }
  }
}

async function actionInspectQdrant() {
  clearScreen();
  printMemoryBanner();

  panel('Inspect Qdrant — estado del engine', [
    'Pantalla read-only. No modifica nada — solo lee el estado actual.',
  ]);

  // ── 1. Healthcheck ────────────────────────────────────────────────
  const status = await detectQdrantStatus();
  console.log('');
  console.log('  ' + bold('Qdrant'));
  if (!status.healthy) {
    console.log('  ' + red('  ✗ no está corriendo o no responde'));
    console.log('  ' + dim('    Levantalo con: ') + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} up -d`));
    await pressEnterToContinue();
    return;
  }
  console.log('  ' + green('  ✓ healthy en ') + cyan(QDRANT_URL));
  console.log('  ' + dim('    Dashboard: ') + cyan(QDRANT_URL + '/dashboard'));

  // ── 2. Collections en la instancia ───────────────────────────────
  console.log('');
  console.log('  ' + bold('Collections en la instancia global'));
  const collections = await listQdrantCollectionsDetailed();
  const mySlug = projectCollectionSlug();

  if (collections.length === 0) {
    console.log('  ' + dim('  (ninguna — instalá Memory en algún proyecto y se va a crear)'));
  } else {
    const maxName = Math.max(...collections.map(c => c.name.length));
    for (const c of collections) {
      const isMine = c.name === mySlug;
      const marker = isMine ? green('  ← este proyecto') : '';
      const nameLabel = isMine ? cyan(pad(c.name, maxName)) : pad(c.name, maxName);
      console.log('  · ' + nameLabel + '  '
        + dim(c.points + ' pts · ' + c.dims + 'd · ' + c.distance + ' · ' + c.status)
        + marker);
    }
  }

  // ── 3. Detalle de la collection del proyecto ──────────────────────
  console.log('');
  console.log('  ' + bold('Tu collection: ') + cyan(mySlug));
  const mine = collections.find(c => c.name === mySlug);
  if (!mine) {
    console.log('  ' + yellow('  ⚠ La collection todavía no existe.'));
    console.log('  ' + dim('    Corré: ') + cyan('node vault/memory/.engine/index-vault.mjs'));
  } else if (mine.points === 0) {
    console.log('  ' + yellow('  ⚠ Existe pero está vacía (0 points).'));
    console.log('  ' + dim('    El archivist nunca indexó, o se reseteó. Corré: ') + cyan('node vault/memory/.engine/index-vault.mjs --force'));
  } else {
    console.log('  ' + dim('  Points totales: ') + cyan(mine.points));
    console.log('  ' + dim('  Dimensiones:    ') + cyan(mine.dims + 'd, ' + mine.distance));

    const samples = await getCollectionSamples(mySlug, 5);
    if (samples.length > 0) {
      console.log('  ' + dim('  Muestras (primeros ' + samples.length + ' chunks):'));
      for (const p of samples) {
        const path = p.payload?.filePath || '(sin filePath)';
        const section = p.payload?.sectionTitle ? '  § ' + p.payload.sectionTitle : '';
        const updatedAt = p.payload?.updatedAt ? '  [' + p.payload.updatedAt.slice(0, 19).replace('T', ' ') + ']' : '';
        console.log('    · ' + cyan(path) + dim(section) + dim(updatedAt));
      }
    }
  }

  // ── 4. Sanity de agentes — diagnóstico accionable ─────────────────
  console.log('');
  console.log('  ' + bold('Sanity de agentes — uso de Memory en tareas'));
  const usage = await checkTaskMemoryUsage();
  const researcherHasRAG = await detectResearcherHasRAG();
  const installedAt = await getMemoryInstalledAt();

  const fmtDate = (d) => d ? d.toISOString().slice(0, 19).replace('T', ' ') : '?';

  console.log('  ' + dim('  researcher.md tiene reglas RAG: ')
    + (researcherHasRAG ? green('✓') : red('✗ — falta sección "Pre-flight: semantic search"')));
  console.log('  ' + dim('  Memory instalada en proyecto:   ')
    + (installedAt ? cyan(fmtDate(installedAt)) : dim('(no detectada)')));

  if (usage.total === 0) {
    console.log('  ' + dim('  (sin tareas en vault/memory/tasks/ todavía)'));
  } else {
    // Clasificación correcta: usamos el mtime de RESEARCH.md (no de conclusion.md)
    // para determinar si el researcher corrió pre o post-Memory. El research.md
    // no se regenera al cerrar la tarea — si fue escrito antes del install, es
    // histórico aunque el cierre sea posterior.
    const closedTasks = usage.tasks.filter(t => t.hasConclusion);
    const historicalResearch = [];        // research.md generado antes del install
    const postInstall = [];                // research.md generado después del install
    const closedButPreResearch = [];      // cerradas post-install pero con research pre-install
    if (installedAt) {
      for (const t of closedTasks) {
        if (!t.researchAt) {
          // No hay research.md → no aplica al sanity check
          historicalResearch.push(t);
        } else if (t.researchAt < installedAt) {
          historicalResearch.push(t);
          if (t.closedAt && t.closedAt >= installedAt) {
            closedButPreResearch.push(t);
          }
        } else {
          postInstall.push(t);
        }
      }
    } else {
      postInstall.push(...closedTasks);
    }
    const postWithInsights = postInstall.filter(t => t.hasPreviousInsights).length;

    console.log('');
    console.log('  ' + dim('  Tareas totales:                            ') + cyan(usage.total));
    console.log('  ' + dim('  Cerradas:                                  ') + cyan(closedTasks.length + '/' + usage.total));
    if (historicalResearch.length > 0) {
      console.log('  ' + dim('  Pre-Memory (research generado antes):      ')
        + dim(historicalResearch.length + ' tarea(s) — no aplican al flujo RAG'));
    }
    console.log('  ' + dim('  Post-Memory (research generado después):   ') + cyan(postInstall.length));
    if (postInstall.length > 0) {
      const ratio = postWithInsights + '/' + postInstall.length;
      const color = postWithInsights === postInstall.length ? green
                  : postWithInsights > 0 ? yellow
                  : red;
      console.log('  ' + dim('    Con Previous insights:                   ') + color(ratio));
    }

    // Última tarea cerrada post-Memory
    if (postInstall.length > 0) {
      const last = postInstall[postInstall.length - 1];
      console.log('');
      console.log('  ' + dim('  Última tarea cerrada post-Memory: ') + cyan(last.slug));
      console.log('  ' + dim('    research.md generado el:         ') + cyan(fmtDate(last.researchAt)));
      console.log('  ' + dim('    Previous insights presente:      ')
        + (last.hasPreviousInsights ? green('✓') : yellow('✗')));
    }

    // ── Diagnóstico accionable ─────────────────────────────────────
    console.log('');
    console.log('  ' + bold('Diagnóstico'));

    if (!researcherHasRAG) {
      console.log('  ' + red('  ✗ El researcher.md de este proyecto no tiene la regla RAG.'));
      console.log('  ' + dim('    El researcher NUNCA va a consultar el engine en este estado.'));
      console.log('  ' + dim('    Solución:'));
      console.log('    ' + cyan('    npx github:sebaarce/phobos') + dim('  → "Actualizar agentes" → aplicar'));
      console.log('  ' + dim('    Después reiniciá OpenCode para que tome el prompt nuevo.'));
    } else if (postInstall.length === 0 && closedButPreResearch.length > 0) {
      // ESCENARIO ESPECÍFICO: tareas cerradas post-install pero research.md pre-install
      console.log('  ' + yellow('  ⚠ Las tareas cerradas después de instalar Memory tienen su research.md'));
      console.log('  ' + yellow('    generado ANTES del install. Esos research.md NO se regeneran al cerrar.'));
      console.log('');
      console.log('  ' + dim('    Detalle de la(s) tarea(s) afectada(s):'));
      for (const t of closedButPreResearch.slice(-3)) {
        console.log('  ' + dim('      · ') + cyan(t.slug));
        console.log('  ' + dim('        research.md:     ') + fmtDate(t.researchAt) + dim('  (pre-Memory)'));
        console.log('  ' + dim('        conclusion.md:   ') + fmtDate(t.closedAt) + dim('  (post-Memory)'));
      }
      console.log('');
      console.log('  ' + bold('Esto es normal') + dim(' — el flujo RAG funciona desde el ') + bold('OPEN') + dim(' de una tarea.'));
      console.log('  ' + dim('    Para validar, hacé esto:'));
      console.log('  ' + dim('      1. Abrí una tarea ') + bold('nueva') + dim(' en Phobos (Open task, no Resume).'));
      console.log('  ' + dim('      2. Dejá que el researcher escriba research.md desde cero.'));
      console.log('  ' + dim('      3. Cuando termine, volvé a Inspect.'));
      console.log('  ' + dim('      4. Verificá que "Post-Memory" suba a 1 y "Con Previous insights" sea 1/1.'));
    } else if (postInstall.length === 0) {
      console.log('  ' + yellow('  ⚠ Sin tareas con research.md generado después de instalar Memory.'));
      console.log('  ' + dim('    Probá abrir una tarea NUEVA y dejar que corra el pipeline completo.'));
    } else if (postWithInsights === postInstall.length) {
      console.log('  ' + green('  ✓ Todo OK. ') + dim('Researcher consulta el engine en cada tarea post-Memory.'));
    } else if (postWithInsights === 0) {
      console.log('  ' + yellow('  ⚠ researcher.md tiene reglas RAG, pero ninguna tarea post-Memory las usó.'));
      console.log('  ' + dim('    Causa más probable: OpenCode todavía tiene el prompt viejo cacheado.'));
      console.log('  ' + dim('    Solución:'));
      console.log('  ' + dim('      1. Cerrar OpenCode completamente (no solo el tab).'));
      console.log('  ' + dim('      2. Volver a abrirlo.'));
      console.log('  ' + dim('      3. Crear una tarea nueva de prueba (Open task, no Resume).'));
      console.log('  ' + dim('      4. Volver a Inspect Qdrant y verificar.'));
      console.log('  ' + dim('    Si persiste: el researcher puede estar fallando silenciosamente al correr'));
      console.log('  ' + dim('    search.mjs (ej: por permisos). Revisá los logs de la sesión hija.'));
    } else {
      console.log('  ' + yellow('  ⚠ Uso mixto: algunas tareas post-Memory tienen Previous insights, otras no.'));
      console.log('  ' + dim('    Puede ser intermitente — chequeá las que faltan, capaz fallaron por Qdrant down momentáneo.'));
    }
  }

  // ── 5. Cómo probar manualmente ───────────────────────────────────
  console.log('');
  console.log('  ' + bold('Cómo probar end-to-end manualmente'));
  console.log('  ' + dim('  Query semántica desde terminal:'));
  console.log('    ' + cyan('node vault/memory/.engine/search.mjs "<tu query>"'));
  console.log('  ' + dim('  Activity en vivo (logs del container):'));
  console.log('    ' + cyan('docker logs -f phobos-qdrant'));
  console.log('  ' + dim('  Buscás líneas "POST /collections/.../points/search" o "/points" (upsert).'));

  console.log('');
  await pressEnterToContinue();
}

async function actionMemoryReindexForce() {
  const history = [];
  renderWizardStep(printMemoryBanner, history, '[1/1] Re-indexar este proyecto (--force)');

  const qdrant = await detectQdrantStatus();
  if (!qdrant.healthy) {
    console.log(yellow('  ⚠ Qdrant no está corriendo. Levantalo y reintentá:'));
    console.log('    ' + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} up -d`));
    await pressEnterToContinue();
    return;
  }

  rl.pause();
  const code = await runChild(
    'node',
    ['vault/memory/.engine/index-vault.mjs', '--force'],
    'index-vault.mjs --force',
  );
  history.push({
    label: 'Re-indexación',
    value: code === 0 ? 'OK — todos los archivos re-vectorizados' : `Falló (exit ${code})`,
  });

  renderWizardStep(printMemoryBanner, history, '');
  console.log(code === 0 ? green('  ✓ Re-index completo.') : red('  ✗ Re-index falló.'));
  await pressEnterToContinue();
}

async function actionResetQdrant() {
  const history = [];

  // ─── Step 1/5: Leer estado actual y mostrar warning ──────────────────
  renderWizardStep(printMemoryBanner, history, '[1/5] Reset Qdrant — leer estado y advertir');

  const status = await detectQdrantStatus();
  const storageDir = join(PHOBOS_HOME, 'qdrant-storage');
  const storageSize = await getDirSize(storageDir);
  const collections = status.healthy ? await listQdrantCollections() : [];

  console.log('  ' + dim('Container status: ') + (
    status.healthy ? green('✓ corriendo')
    : status.containerRunning ? yellow('⚠ arrancando')
    : dim('no corriendo')
  ));
  console.log('  ' + dim('Storage path:     ') + cyan(storageDir));
  console.log('  ' + dim('Storage size:     ') + cyan(formatBytes(storageSize)));
  console.log('  ' + dim('Collections:      ') + (
    collections.length > 0
      ? cyan(collections.join(', '))
      : dim('(ninguna detectada o Qdrant no responde)')
  ));

  console.log('');
  console.log('  ' + bold(yellow('⚠  ATENCIÓN — operación destructiva')));
  console.log('');
  console.log('  Si confirmás, este wizard va a:');
  console.log('    ' + dim('1.') + ' Bajar y remover el contenedor ' + cyan(QDRANT_CONTAINER) + '.');
  console.log('    ' + dim('2.') + ' Opcionalmente hacer backup del storage actual.');
  console.log('    ' + dim('3.') + ' Borrar ' + cyan(storageDir) + dim(' (vectores de ') + bold('TODOS') + dim(' los proyectos con Memory en esta máquina).'));
  console.log('    ' + dim('4.') + ' Borrar ' + cyan(QDRANT_COMPOSE_GLOBAL) + dim(' y regenerar desde template fresco.'));
  console.log('    ' + dim('5.') + ' Levantar Qdrant limpio.');
  console.log('    ' + dim('6.') + ' Re-indexar el vault de ' + bold('ESTE') + ' proyecto desde cero.');
  console.log('');
  console.log('  ' + yellow('NOTA: '));
  console.log('  ' + dim('  Si tenés OTROS proyectos con Phobos en esta máquina, sus vectores también se borran.'));
  console.log('  ' + dim('  Los archivos del engine (vault/memory/.engine/) de esos proyectos no se tocan,'));
  console.log('  ' + dim('  pero cada proyecto tendrá que correr ') + cyan('/reindex-memory') + dim(' para volver a aparecer en Qdrant.'));

  const confirm = await tuiYesNo('\n¿Continuar con el reset?', false);
  if (!confirm) {
    history.push({ label: 'Reset', value: 'Cancelado por el usuario' });
    renderWizardStep(printMemoryBanner, history, '');
    console.log('  ' + dim('⊘ Reset cancelado. Nada se modificó.'));
    await pressEnterToContinue();
    return;
  }
  history.push({
    label: 'Estado previo',
    value: `${collections.length} collections, ${formatBytes(storageSize)} en storage`,
  });

  // ─── Step 2/5: Backup opcional ──────────────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[2/5] Backup opcional del storage actual');

  let backupDone = false;
  let backupPath = '';

  if (storageSize > 0) {
    const wantBackup = await tuiYesNo(
      `¿Hacer backup de ${cyan(formatBytes(storageSize))} antes de borrar?`,
      true,
    );
    if (wantBackup) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      backupPath = join(PHOBOS_HOME, `qdrant-storage-backup-${ts}`);

      // Antes de copiar, bajar Qdrant para evitar archivos en uso
      console.log(dim('\n  Bajando Qdrant para evitar archivos en uso...'));
      rl.pause();
      await runChild('docker', ['compose', '-f', QDRANT_COMPOSE_GLOBAL, 'down'], 'docker compose down');

      console.log(dim('  Copiando ' + storageDir + ' → ' + backupPath));
      console.log(dim('  (esto puede tardar según el tamaño...)'));

      try {
        await copyDirRecursive(storageDir, backupPath);
        backupDone = true;
        console.log(green('  ✓ Backup completado.'));
      } catch (err) {
        console.log(yellow('  ⚠ Backup falló: ' + (err.message || err)));
        const continueWithoutBackup = await tuiYesNo('¿Continuar igual con el reset (sin backup)?', false);
        if (!continueWithoutBackup) {
          history.push({ label: 'Backup', value: 'Falló — wizard abortado para no perder datos' });
          renderWizardStep(printMemoryBanner, history, '');
          console.log(yellow('  Reset abortado. Datos intactos.'));
          await pressEnterToContinue();
          return;
        }
      }
    }
  } else {
    console.log(dim('  Storage vacío o inexistente — no hay nada que respaldar.'));
  }
  history.push({
    label: 'Backup',
    value: backupDone
      ? 'Guardado en ' + basename(backupPath)
      : (storageSize === 0 ? 'No aplica (storage vacío)' : 'Saltado por el usuario'),
  });

  // ─── Step 3/5: Bajar + remover contenedor ───────────────────────────
  renderWizardStep(printMemoryBanner, history, '[3/5] Bajar y remover contenedor');

  rl.pause();
  await runChild('docker', ['compose', '-f', QDRANT_COMPOSE_GLOBAL, 'down'], 'docker compose down');
  // Force remove por si quedó orfanado del compose viejo
  await runChild('docker', ['rm', '-f', QDRANT_CONTAINER], 'docker rm phobos-qdrant');
  history.push({ label: 'Container', value: 'bajado y eliminado' });

  // ─── Step 4/5: Borrar storage + compose ─────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[4/5] Borrar storage y compose viejos');

  if (await fileExists(storageDir)) {
    await rmrf(storageDir);
    console.log(dim('  · ') + cyan(storageDir) + dim(' borrado'));
  }
  if (await fileExists(QDRANT_COMPOSE_GLOBAL)) {
    const { rm } = await import('node:fs/promises');
    await rm(QDRANT_COMPOSE_GLOBAL, { force: true });
    console.log(dim('  · ') + cyan(QDRANT_COMPOSE_GLOBAL) + dim(' borrado'));
  }
  history.push({ label: 'Limpieza', value: 'storage + compose eliminados' });

  // ─── Step 5/5: Regenerar, levantar, re-indexar ──────────────────────
  renderWizardStep(printMemoryBanner, history, '[5/5] Regenerar Qdrant limpio y re-indexar este proyecto');

  const homeResult = await ensurePhobosHome();
  console.log('  ' + dim('docker-compose.qdrant.yml regenerado desde template ') + (homeResult.created ? green('✓') : dim('(ya existía)')));

  rl.pause();
  const upCode = await runChild(
    'docker',
    ['compose', '-f', QDRANT_COMPOSE_GLOBAL, 'up', '-d', '--force-recreate'],
    'docker compose up -d --force-recreate',
  );
  if (upCode !== 0) {
    history.push({ label: 'Levantar Qdrant', value: 'Falló — revisá Docker' });
    renderWizardStep(printMemoryBanner, history, '');
    console.log(red('  ✗ Qdrant no arrancó. Revisá Docker Desktop esté corriendo.'));
    if (backupDone) {
      console.log(dim('  Tu backup está intacto en: ') + cyan(backupPath));
      console.log(dim('  Para restaurarlo manualmente:'));
      console.log('    ' + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} down`));
      console.log('    ' + cyan(`mv ${backupPath} ${storageDir}`));
      console.log('    ' + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} up -d`));
    }
    await pressEnterToContinue();
    return;
  }
  history.push({ label: 'Levantar Qdrant', value: 'OK · limpio · sin auth' });

  console.log(dim('\n  Esperando 5s a que Qdrant esté listo...'));
  await new Promise(r => setTimeout(r, 5000));

  rl.pause();
  const indexCode = await runChild(
    'node',
    ['vault/memory/.engine/index-vault.mjs', '--force'],
    'index-vault.mjs --force',
  );
  history.push({
    label: 'Re-indexación',
    value: indexCode === 0
      ? `Vault del proyecto re-indexado en collection ${projectCollectionSlug()}`
      : `Falló (exit ${indexCode}) — corré manualmente con node vault/memory/.engine/index-vault.mjs --force`,
  });

  // ─── Pantalla final ─────────────────────────────────────────────────
  renderWizardStep(printMemoryBanner, history, '');
  console.log('  ' + green('Reset completado.'));
  console.log('');
  console.log('  ' + dim('Tu collection en Qdrant: ') + cyan(projectCollectionSlug()));
  if (backupDone) {
    console.log('  ' + dim('Backup del storage anterior: ') + cyan(backupPath));
    console.log('  ' + dim('  → si querés restaurarlo en el futuro: parar Qdrant, mv backup encima de qdrant-storage/, levantar.'));
  }
  console.log('  ' + dim('Otros proyectos con Memory: corré ') + cyan('/reindex-memory') + dim(' en cada uno para que vuelvan a aparecer en Qdrant.'));
  await pressEnterToContinue();
}

async function actionInstallMemory() {
  const history = [];

  // ─── Step 1/6: Verificar prerequisitos ──────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[1/6] Verificar prerequisitos');

  const dockerOK = checkCommand('docker');
  const nodeOK = checkCommand('node');
  const pkg = await readPackageJson();

  console.log('  ' + (dockerOK ? green('✓') : red('✗')) + ' docker');
  console.log('  ' + (nodeOK ? green('✓') : red('✗')) + ' node');
  console.log('  ' + (pkg ? green('✓') : red('✗')) + ' package.json (proyecto Node)');

  if (!dockerOK || !nodeOK || !pkg) {
    console.log('');
    if (!dockerOK) console.log('  ' + yellow('Docker es necesario para correr Qdrant local. Instalalo desde docker.com/get-started'));
    if (!nodeOK) console.log('  ' + yellow('Node es necesario para el engine de embeddings.'));
    if (!pkg) console.log('  ' + yellow('El proyecto destino debe tener package.json (Node/TS). Memory no aplica a otros stacks.'));
    history.push({ label: 'Prerequisitos', value: 'Faltantes — wizard cancelado' });
    renderWizardStep(printMemoryBanner, history, '');
    console.log('  ' + yellow('No se puede continuar. Resolvé los prerequisitos y reintentá.'));
    await pressEnterToContinue();
    return;
  }

  history.push({ label: 'Prerequisitos', value: 'docker ✓, node ✓, package.json ✓' });

  // ─── Step 2/6: Detección de Qdrant global + package manager ─────────
  renderWizardStep(printMemoryBanner, history, '[2/6] Detectar Qdrant global y package manager');

  const qdrant = await detectQdrantStatus();
  const pm = await detectPackageManager();
  const collectionName = projectCollectionSlug();
  const agentSupport = await detectAgentsHaveMemorySupport();
  const agentsReady = agentSupport.researcherOK && agentSupport.archivistOK;
  const problemStacks = await detectProblematicStack();
  const npmrcHasFlag = await checkNpmrcHasLegacyPeerDeps();

  console.log('  ' + dim('Qdrant global: ') + (
    qdrant.containerRunning && qdrant.healthy ? green('✓ corriendo y healthy en ' + QDRANT_URL)
    : qdrant.containerRunning ? yellow('⚠ contenedor up pero sin responder a /healthz aún')
    : dim('— no está corriendo (se levantará en el paso 5)')
  ));
  console.log('  ' + dim('Package manager: ') + cyan(pm));
  console.log('  ' + dim('Stack detectado: ')
    + (problemStacks.length > 0
        ? yellow(problemStacks.join(', ') + ' — suele requerir --legacy-peer-deps')
        : dim('sin stacks con issues conocidos de peer-deps')));
  if (problemStacks.length > 0 && npmrcHasFlag) {
    console.log('  ' + dim('  .npmrc del proyecto ya tiene ') + green('legacy-peer-deps=true') + dim(' ✓'));
  }
  console.log('  ' + dim('Collection name: ') + cyan(collectionName));
  console.log('  ' + dim('Global compose: ') + cyan(QDRANT_COMPOSE_GLOBAL));
  console.log('  ' + dim('Agentes preparados para Memory: ')
    + (agentsReady
        ? green('✓ researcher y archivist tienen reglas RAG')
        : yellow('⚠ alguno está outdated — ver advertencia abajo')));

  if (!agentsReady) {
    console.log('');
    console.log('  ' + yellow('Advertencia — agentes outdated:'));
    if (!agentSupport.researcherOK) {
      console.log('  ' + dim('  · researcher.md NO tiene la regla "Pre-flight: semantic search"'));
    }
    if (!agentSupport.archivistOK) {
      console.log('  ' + dim('  · archivist.md NO tiene la regla "Trigger semantic re-index"'));
    }
    console.log('');
    console.log('  ' + dim('  Memory se va a instalar igual y los scripts'));
    console.log('  ' + dim('    node vault/memory/.engine/search.mjs "<query>"'));
    console.log('  ' + dim('    node vault/memory/.engine/index-vault.mjs --incremental'));
    console.log('  ' + dim('  van a funcionar correctamente desde la terminal.'));
    console.log('');
    console.log('  ' + dim('  PERO los agentes viejos no van a invocarlos automáticamente.'));
    console.log('  ' + dim('  Para que Phobos use Memory en su flujo normal de tareas:'));
    console.log('  ' + dim('    1. Cancelá este wizard (Esc o "No").'));
    console.log('  ' + dim('    2. Volvé al menú principal → ') + cyan('"Actualizar agentes"'));
    console.log('  ' + dim('    3. Aplicá las actualizaciones (preservan tus modelos).'));
    console.log('  ' + dim('    4. Volvé a entrar a "Memory (RAG)".'));
  }

  history.push({
    label: 'Estado inicial',
    value: `Qdrant ${qdrant.healthy ? 'corriendo' : 'no corriendo'} · pm=${pm} · agentes ${agentsReady ? 'OK' : 'outdated'}`,
  });

  const proceedPrompt = agentsReady
    ? '\n¿Continuar con la instalación de Memory en este proyecto?'
    : '\n¿Continuar igualmente (los agentes seguirán sin invocar Memory hasta que los actualices)?';

  const proceed = await tuiYesNo(proceedPrompt, agentsReady);
  if (!proceed) {
    history.push({
      label: 'Confirmación',
      value: agentsReady ? 'Cancelado por el usuario' : 'Cancelado — primero actualizar agentes',
    });
    renderWizardStep(printMemoryBanner, history, '');
    if (!agentsReady) {
      console.log('  ' + dim('  Volvé al menú principal y elegí "Actualizar agentes" primero.'));
      console.log('  ' + dim('  Cuando los templates queden sincronizados, reintentá Memory.'));
    } else {
      console.log('  ' + dim('  ⊘ Instalación saltada.'));
    }
    await pressEnterToContinue();
    return;
  }

  // ─── Step 3/6: Instalar dependencias npm ────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[3/6] Instalar dependencias del proyecto');

  const depsRaw = await readFile(join(TEMPLATES_DIR, 'phobos/memory/package-deps.json'), 'utf-8');
  const depsJson = JSON.parse(depsRaw);
  const depList = Object.entries(depsJson.dependencies).map(([n, v]) => `${n}@${v}`);
  console.log('  Instalando: ' + cyan(depList.join(', ')));
  console.log(dim('  (paquetes incluyen binarios nativos onnxruntime ~50-80 MB)'));

  // Pre-check: si las deps ya estaban instaladas (re-run del wizard), saltamos
  const preCheck = await verifyMemoryDepsInstalled();
  let installSummary;
  let usedLegacyPeerDeps = false;

  if (preCheck.ok) {
    console.log('');
    console.log('  ' + green('✓ Ambos paquetes ya están en node_modules — salteando install.'));
    installSummary = `Ya instalados (reusados de instalación previa)`;
  } else {
    // Si detectamos stack problemático + npm + sin flag persistida → preguntar
    // si arrancar el install con --legacy-peer-deps desde el primer intento.
    let initialFlags = [];
    if (problemStacks.length > 0 && pm === 'npm' && !npmrcHasFlag) {
      console.log('');
      console.log('  ' + yellow('⚠ Detecté ') + bold(problemStacks.join(', '))
        + yellow(' en el proyecto.'));
      console.log('  ' + dim('   Estos stacks suelen tener conflictos de peer dependencies (ERESOLVE)'));
      console.log('  ' + dim('   en NPM v7+. La flag ') + cyan('--legacy-peer-deps')
        + dim(' soluciona esto sin tocar tu árbol de deps.'));
      console.log('');

      const stackChoice = await tuiSelect(
        '¿Cómo arrancar el install?',
        [
          'npm install ' + green('--legacy-peer-deps') + dim('  (recomendado para ' + problemStacks[0] + ')'),
          'npm install (sin flags — puede fallar si hay conflictos preexistentes)',
        ],
        0,
      );
      if (stackChoice.index === 0) {
        initialFlags = ['--legacy-peer-deps'];
        usedLegacyPeerDeps = true;
      }
    } else if (npmrcHasFlag) {
      // El .npmrc ya tiene la flag — npm la va a aplicar automáticamente
      usedLegacyPeerDeps = true;
    }

    const result = await installMemoryDepsWithRetry(pm, depList, initialFlags);
    if (!result.ok) {
      history.push({ label: 'Dependencias', value: `Falló — faltan: ${result.missing.join(', ')}` });
      renderWizardStep(printMemoryBanner, history, '');
      console.log('  ' + red('✗ No se pudieron instalar las dependencias.'));
      console.log('');
      console.log('  ' + dim('  Probá manualmente:'));
      console.log('    ' + cyan(`${pm} ${pm === 'npm' ? 'install' : 'add'} ${depList.join(' ')}${problemStacks.length > 0 ? ' --legacy-peer-deps' : ''}`));
      console.log('  ' + dim('  Cuando estén instaladas, volvé a entrar a "Memory (RAG)".'));
      await pressEnterToContinue();
      return;
    }
    // Detectar si el install terminó usando --legacy-peer-deps (por initialFlags
    // o porque el usuario la eligió en el retry menu)
    if (result.usedFlags && result.usedFlags.includes('--legacy-peer-deps')) {
      usedLegacyPeerDeps = true;
    }
    const flagsApplied = result.usedFlags?.length ? ' ' + result.usedFlags.join(' ') : '';
    const pmApplied = result.usedPm || pm;
    installSummary = result.exitCode === 0
      ? `${depList.length} paquetes instalados con ${pmApplied}${flagsApplied}`
      : `${depList.length} paquetes instalados (exit ${result.exitCode}, warnings ignorados)`;
  }
  history.push({ label: 'Dependencias', value: installSummary });

  // Si usamos --legacy-peer-deps (manual o desde retry) y .npmrc no lo tiene,
  // ofrecer persistirla para que futuros installs no fallen.
  if (usedLegacyPeerDeps && !npmrcHasFlag && pm === 'npm') {
    console.log('');
    console.log('  ' + dim('Tu instalación necesitó ') + cyan('--legacy-peer-deps') + dim('.'));
    console.log('  ' + dim('Para que futuros ') + cyan('npm install') + dim(' no fallen por el mismo motivo,'));
    console.log('  ' + dim('te conviene persistir la flag en el ') + cyan('.npmrc') + dim(' del proyecto.'));
    console.log('');
    const persist = await tuiYesNo(
      `¿Agregar ${cyan('legacy-peer-deps=true')} al ${cyan('.npmrc')} del proyecto?`,
      true,
    );
    if (persist) {
      const r = await addLegacyPeerDepsToNpmrc();
      if (r.added) {
        console.log('  ' + green('✓ .npmrc actualizado'));
        history.push({ label: '.npmrc', value: 'legacy-peer-deps=true agregado al .npmrc' });
      } else {
        console.log('  ' + dim('  · .npmrc ya tenía la flag — no se modificó'));
      }
    } else {
      console.log('  ' + dim('  · saltado. Vas a tener que pasar --legacy-peer-deps en futuros installs.'));
    }
  }

  // ─── Step 4/6: Copiar engine al proyecto ────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[4/6] Copiar engine al proyecto');

  await copyMemoryEngineToProject(collectionName);
  await appendGitignoreSnippet();
  history.push({
    label: 'Engine',
    value: `${MEMORY_ENGINE_FILES.length} archivos en vault/memory/.engine/ · collection=${collectionName}`,
  });

  // ─── Step 5/6: Preparar Qdrant GLOBAL ───────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[5/6] Preparar Qdrant global en ~/.phobos/');

  const homeResult = await ensurePhobosHome();
  console.log('  ' + dim('~/.phobos/ ') + (homeResult.created ? green('creado') : dim('ya existía')));
  console.log('  ' + dim('docker-compose.qdrant.yml: ') + cyan(QDRANT_COMPOSE_GLOBAL));

  if (qdrant.containerRunning && qdrant.healthy) {
    console.log('  ' + green('✓ Qdrant ya está corriendo — reutilizando instancia global.'));
    history.push({ label: 'Qdrant global', value: 'Ya corriendo, reutilizado' });
  } else {
    console.log('');
    console.log('  ' + dim('Levantando Qdrant global con docker compose...'));
    rl.pause();
    const composeCode = await runChild(
      'docker',
      ['compose', '-f', QDRANT_COMPOSE_GLOBAL, 'up', '-d'],
      'docker compose up -d (qdrant global)',
    );
    if (composeCode !== 0) {
      history.push({ label: 'Qdrant global', value: 'Falló el docker compose' });
      renderWizardStep(printMemoryBanner, history, '');
      console.log('  ' + yellow('Engine instalado, pero Qdrant no arrancó.'));
      console.log('  ' + dim('  Arrancá Docker Desktop y corré manualmente:'));
      console.log('    ' + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} up -d`));
      console.log('  ' + dim('Después, indexá con:'));
      console.log('    ' + cyan('node vault/memory/.engine/index-vault.mjs'));
      await pressEnterToContinue();
      return;
    }
    history.push({ label: 'Qdrant global', value: 'Levantado en ' + QDRANT_URL });

    console.log(dim('\n  Esperando a que Qdrant esté listo (5s)...'));
    await new Promise(r => setTimeout(r, 5000));
  }

  // ─── Step 6/6: Indexación inicial ───────────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[6/6] Indexación inicial del vault');

  rl.pause();
  const indexCode = await runChild(
    'node',
    ['vault/memory/.engine/index-vault.mjs'],
    'index-vault.mjs (full)',
  );
  if (indexCode !== 0) {
    history.push({ label: 'Indexación', value: 'Falló — corré manualmente cuando puedas' });
  } else {
    history.push({ label: 'Indexación', value: `Vault indexado en collection ${collectionName}` });
  }

  // ─── Pantalla final ─────────────────────────────────────────────────
  renderWizardStep(printMemoryBanner, history, '');
  console.log('  ' + green('Memory engine instalado y conectado a Qdrant global.'));
  console.log('');
  console.log('  ' + dim('Tu collection en Qdrant: ') + cyan(collectionName));
  console.log('  ' + dim('Otros proyectos con Phobos van a tener su propia collection en la misma instancia.'));
  console.log('');
  console.log('  ' + dim('Comandos útiles:'));
  console.log('    ' + cyan('node vault/memory/.engine/search.mjs "<query>"'));
  console.log('    ' + cyan('node vault/memory/.engine/index-vault.mjs --incremental'));
  console.log('    ' + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} down`) + dim('  (parar Qdrant global)'));
  console.log('    ' + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} up -d`) + dim('  (levantar Qdrant global)'));
  console.log('');
  console.log('  ' + dim('Dashboard Qdrant: ') + cyan('http://localhost:6333/dashboard'));
  await pressEnterToContinue();
}

async function pressEnterToContinue() {
  console.log('');
  console.log(dim('  Presioná Enter o Esc para volver al menú...'));
  await new Promise((resolve) => {
    const onKey = (str, key) => {
      if (!key) return;
      // Enter, Space, Esc, o Ctrl+C — todos liberan (la acción ya terminó).
      if (key.name === 'return' || key.name === 'space' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        stdin.removeListener('keypress', onKey);
        try { stdin.setRawMode(false); } catch {}
        resolve();
      }
    };
    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    stdin.on('keypress', onKey);
  });
}

// ═══════════════════════════════════════════════════════════════════
// Menu principal — stack-based con clear screen entre niveles
// ═══════════════════════════════════════════════════════════════════

function renderMainMenuHeader(agentDir, installState) {
  clearScreen();
  printHeader();

  const projectName = basename(cwd()) || cwd();
  const agentsStatus = installState.agentsInstalled
    ? green(`✓ instalados (${installState.agentCount})`)
    : yellow('⚠ faltantes');
  const vaultStatus = installState.vaultPresent
    ? green('✓ presente')
    : dim('— no creado');
  const updatesStatus = installState.pendingUpdates > 0
    ? yellow(`↻ ${installState.pendingUpdates} pendiente${installState.pendingUpdates > 1 ? 's' : ''}`)
    : green('✓ al día');
  let memoryStatus;
  if (!installState.memoryInstalled) {
    memoryStatus = dim('— no instalado');
  } else if (installState.qdrantRunning === true) {
    memoryStatus = green('✓ instalado') + dim('  ·  Qdrant global: ') + green('✓ corriendo');
  } else if (installState.qdrantRunning === false) {
    memoryStatus = green('✓ instalado') + dim('  ·  Qdrant global: ') + yellow('⚠ no corriendo');
  } else {
    memoryStatus = green('✓ instalado');
  }

  console.log('  ' + dim('Proyecto:') + ' ' + cyan(projectName));
  console.log('  ' + dim('Agentes: ') + agentsStatus
    + dim('  ·  vault: ') + vaultStatus
    + dim('  ·  templates: ') + updatesStatus);
  console.log('  ' + dim('Memory:  ') + memoryStatus);
  console.log('');
}

async function getMainMenuState(agentDir) {
  let agentsInstalled = false;
  let agentCount = 0;
  try {
    const files = await readdir(agentDir);
    const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'README.md');
    agentCount = mdFiles.length;
    agentsInstalled = agentCount >= 1;
  } catch {}

  const vaultPresent = await fileExists('vault');

  let pendingUpdates = 0;
  try {
    const updates = await scanForUpdates();
    pendingUpdates = updates.outdated.length + updates.missing.length;
  } catch {}

  const memoryInstalled = await fileExists('vault/memory/.engine/config.json');

  // Qdrant global state — solo chequeamos si memory está instalada para no
  // gastar un docker ps innecesario en cada render del menú principal.
  let qdrantRunning = null;
  if (memoryInstalled) {
    try {
      const s = await detectQdrantStatus();
      qdrantRunning = s.containerRunning && s.healthy;
    } catch {
      qdrantRunning = false;
    }
  }

  return { agentsInstalled, agentCount, vaultPresent, pendingUpdates, memoryInstalled, qdrantRunning };
}

// Envuelve una acción del wizard de forma que si el usuario apreta Esc
// dentro del flujo, capturamos el sentinel WIZARD_CANCELLED y volvemos
// al menú principal en lugar de propagar el reject.
async function runAction(actionFn) {
  try {
    await actionFn();
  } catch (err) {
    if (err === WIZARD_CANCELLED) {
      // Volvemos al menú principal silenciosamente.
      return;
    }
    throw err;
  }
}

async function runMainMenu(agentDir) {
  while (true) {
    const state = await getMainMenuState(agentDir);
    renderMainMenuHeader(agentDir, state);

    const updateLabel = state.pendingUpdates > 0
      ? 'Actualizar agentes      ' + dim(`(${state.pendingUpdates} pendiente${state.pendingUpdates > 1 ? 's' : ''})`)
      : 'Actualizar agentes      ' + dim('(al día)');

    const memoryLabel = state.memoryInstalled
      ? 'Memory (RAG)            ' + dim('(instalado · reindex / reset / re-instalar)')
      : 'Memory (RAG)            ' + dim('(instalar engine de búsqueda semántica)');

    // En el menú principal Esc no tiene sentido (no hay "menú padre"),
    // pero si el usuario lo apreta, lo tratamos como "no acción" — solo re-rendereamos.
    let choice;
    try {
      choice = await tuiSelect(
        '\n¿Qué querés hacer?',
        [
          updateLabel,
          'Setear modelos de agentes',
          'Instalar herramientas',
          memoryLabel,
          dim('Salir'),
        ],
        0,
      );
    } catch (err) {
      if (err === WIZARD_CANCELLED) continue; // re-renderizar menú
      throw err;
    }

    const { index } = choice;
    if (index === 0) {
      await runAction(() => actionUpdateAgents());
    } else if (index === 1) {
      await runAction(() => actionSetModels(agentDir));
    } else if (index === 2) {
      await runAction(() => actionInstallTools());
    } else if (index === 3) {
      await runAction(() => actionMemory());
    } else if (index === 4) {
      clearScreen();
      showHappyGoodbye();
      finalizeAndExit(0);
      return;
    }
  }
}

async function main() {
  clearScreen();
  printHeader();

  // Verificar que tenemos templates accesibles
  if (!await fileExists(TEMPLATES_DIR)) {
    console.error(yellow(`✗ No encontré templates en ${TEMPLATES_DIR}`));
    console.error('  El paquete está mal instalado. Reinstalá con: cd <repo> && npm link');
    finalizeAndExit(1);
    return;
  }

  const agentDir = resolve(cwd(), AGENTS_DIR);
  const phobosPath = join(agentDir, 'phobos.md');
  const isExistingInstall = await fileExists(phobosPath);

  if (!isExistingInstall) {
    // Primera instalación — bootstrap obligatorio antes del menú
    const bootstrapped = await ensureBootstrap();
    if (!bootstrapped) {
      showSadGoodbye();
      finalizeAndExit(0);
      return;
    }
  }

  try {
    await readdir(agentDir);
  } catch {
    console.error(yellow(`\n✗ No encontré ${AGENTS_DIR} en ${cwd()}`));
    console.error('  Algo salió mal con el bootstrap. Verificá los permisos de escritura.');
    finalizeAndExit(1);
    return;
  }

  // Entrar al menú principal — loop hasta que el usuario elija Salir
  await runMainMenu(agentDir);
}

// Cleanup robusto: stdin puede quedar en raw mode o "flowing" después de
// los child processes con stdio: 'inherit', lo cual mantiene a Node vivo
// (especialmente en Windows con shell: true).
// Forzamos cierre limpio + exit duro como red de seguridad.
function finalizeAndExit(code = 0) {
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(false);
    }
  } catch {}
  try { stdin.removeAllListeners('keypress'); } catch {}
  try { stdin.removeAllListeners('data'); } catch {}
  try { rl.close(); } catch {}
  try { stdin.pause(); } catch {}
  try { stdin.unref(); } catch {}
  // Flush stdout/stderr y salir. En Windows con stdio: 'inherit' previo,
  // los handles a veces quedan pegados — process.exit() es la única salida segura.
  if (stdout.write('')) {
    exit(code);
  } else {
    stdout.once('drain', () => exit(code));
    // Fallback duro: 200ms y mata el proceso pase lo que pase.
    setTimeout(() => exit(code), 200).unref();
  }
}

main().catch((err) => {
  if (err === WIZARD_CANCELLED) {
    // Esc llegó hasta el tope — no debería pasar (runAction lo captura), pero por las dudas
    // salimos limpio sin error.
    finalizeAndExit(0);
    return;
  }
  if (err && (err.code === 'ERR_USE_AFTER_CLOSE' || /readline was closed/i.test(err.message || ''))) {
    console.log('\n(input cerrado — cancelado)');
    exit(0);
  }
  console.error('\n✗ Error inesperado:', err && err.message ? err.message : err);
  rl.close();
  exit(1);
});

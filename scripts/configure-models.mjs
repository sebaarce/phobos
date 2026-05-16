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

function tuiSelect(prompt, options, defaultIdx = 0) {
  return new Promise((resolve) => {
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
    console.log(dim('  ↑/↓ para navegar, Enter para confirmar, Ctrl+C para cancelar'));

    const rerender = () => {
      // Subir N+1 líneas (N opciones + 1 línea de hint)
      stdout.write(`\x1b[${N + 1}A`);
      for (let i = 0; i < N; i++) {
        stdout.write('\r\x1b[K' + fmt(i, selected) + '\n');
      }
      stdout.write('\r\x1b[K' + dim('  ↑/↓ para navegar, Enter para confirmar, Ctrl+C para cancelar') + '\n');
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
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        console.log('\n(cancelado)');
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
  return new Promise((resolve) => {
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
    console.log(dim('  ↑/↓ navegar  ·  Space marcar  ·  Enter confirmar  ·  Ctrl+C cancelar'));

    const rerender = () => {
      stdout.write(`\x1b[${N + 1}A`);
      for (let i = 0; i < N; i++) {
        stdout.write('\r\x1b[K' + fmt(i) + '\n');
      }
      stdout.write('\r\x1b[K' + dim('  ↑/↓ navegar  ·  Space marcar  ·  Enter confirmar  ·  Ctrl+C cancelar') + '\n');
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
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        console.log('\n(cancelado)');
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
  for (const l of lines) console.log('  ' + cyan(l));
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
  for (const l of lines) console.log('  ' + cyan(l));
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
  for (const l of lines) console.log('  ' + cyan(l));
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
  for (const l of lines) console.log('  ' + cyan(l));
  console.log('');
  console.log('  ' + dim('Tools — autoskills, obsidian, impeccable, opencode'));
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
  console.log('\n' + dim('  [2/4]'));

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

async function chooseMode(allModels, current) {
  console.log('\n' + dim('  [3/4]'));

  const detectedProviders = Array.from(new Set(allModels.map(m => getProvider(m)))).sort();
  const hasMultipleProviders = detectedProviders.length > 1;

  // OpenCode usa un solo proveedor por sesión — siempre elegimos uno (no hay opción "todos")
  let providerFilter = detectedProviders[0];

  while (true) {
    // Paso A: elegir provider (solo si hay más de uno)
    if (hasMultipleProviders) {
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
    }

    // Paso B: calcular y mostrar la sugerencia filtrada al provider elegido
    const modelsScope = allModels.filter(m => getProvider(m) === providerFilter);

    const recommended = Object.fromEntries(
      AGENTS.map(a => [a, recommendForAgent(a, modelsScope)])
    );

    console.log('');
    renderSuggestionPanel(recommended, current);

    // Paso C: elegir modo de asignación
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

    if (index === 0) return recommended;

    if (index === 1) {
      const uniformPrompt = '  ' + bold(cyan('Modelo para TODOS los agentes')) + '\n   ' + dim('actual:  ' + current.phobos);
      const m = await pickFromList(modelsScope, uniformPrompt, current.phobos);
      return Object.fromEntries(AGENTS.map(a => [a, m]));
    }

    if (index === 2) {
      const target = {};
      for (let i = 0; i < AGENTS.length; i++) {
        const agent = AGENTS[i];
        const prompt = agentHeaderBlock(
          i, AGENTS.length, agent,
          AGENT_PROFILES[agent].role,
          current[agent],
          recommended[agent],
        );
        target[agent] = await pickFromList(modelsScope, prompt, current[agent]);
      }
      return target;
    }

    // "Cambiar proveedor" — solo si hay múltiples; loop back al paso A
    if (hasMultipleProviders && index === 3) {
      continue;
    }

    // Cancelar
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Diff + aplicar
// ═══════════════════════════════════════════════════════════════════

function printDiff(current, target) {
  console.log('\n' + dim('  [4/4]'));

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
  { src: 'opencode/agent/phobos.md',     dst: '.opencode/agent/phobos.md',     ignoreModel: true  },
  { src: 'opencode/agent/researcher.md', dst: '.opencode/agent/researcher.md', ignoreModel: true  },
  { src: 'opencode/agent/planner.md',    dst: '.opencode/agent/planner.md',    ignoreModel: true  },
  { src: 'opencode/agent/programmer.md', dst: '.opencode/agent/programmer.md', ignoreModel: true  },
  { src: 'opencode/agent/tester.md',     dst: '.opencode/agent/tester.md',     ignoreModel: true  },
  { src: 'opencode/agent/archivist.md',  dst: '.opencode/agent/archivist.md',  ignoreModel: true  },
  { src: 'opencode/agent/README.md',     dst: '.opencode/agent/README.md',     ignoreModel: false },
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

async function runUpdateWizard(updates) {
  console.log('\n' + dim('  Revisión de actualizaciones — agente por agente.'));

  for (let i = 0; i < updates.outdated.length; i++) {
    const f = updates.outdated[i];
    const label = `[${i + 1}/${updates.outdated.length}] ${basename(f.dst)}`;

    // Leer modelos para mostrar la diferencia si la hay
    const localContent = await readFile(f.localPath, 'utf-8');
    const localModelMatch = localContent.match(/^model:\s*(.+)$/m);
    const localModel = localModelMatch ? localModelMatch[1].trim() : '(sin model)';
    const templateModel = await getTemplateModel(f);
    const modelsDiffer = f.ignoreModel && templateModel && localModel !== templateModel;

    while (true) {
      const options = [
        `Actualizar y preservar mi modelo  ${dim('(' + localModel + ')')}`,
      ];
      if (modelsDiffer) {
        options.push(`Actualizar y usar el modelo del template  ${dim('(' + templateModel + ')')}`);
      }
      options.push('Ver diff antes de decidir');
      options.push('Saltar este');

      const { index } = await tuiSelect(
        '\n' + bold(label) + dim('  — tiene cambios respecto al template'),
        options,
        0,
      );

      // Resolver acción según índices dinámicos
      const idxPreserve = 0;
      const idxAcceptTemplate = modelsDiffer ? 1 : -1;
      const idxDiff = modelsDiffer ? 2 : 1;
      const idxSkip = modelsDiffer ? 3 : 2;

      if (index === idxPreserve) {
        await applyUpdate(f, { preserveLocalModel: true });
        console.log(green('  ✓ ' + basename(f.dst) + ' actualizado.') + dim(' (modelo preservado: ' + localModel + ')'));
        break;
      } else if (index === idxAcceptTemplate) {
        await applyUpdate(f, { preserveLocalModel: false });
        console.log(green('  ✓ ' + basename(f.dst) + ' actualizado.') + dim(' (modelo cambiado a: ' + templateModel + ')'));
        break;
      } else if (index === idxDiff) {
        showAgentDiff(f);
        // loop back para volver a preguntar
      } else if (index === idxSkip) {
        console.log(dim('  ⊘ ' + basename(f.dst) + ' sin tocar.'));
        break;
      }
    }
  }

  if (updates.missing.length > 0) {
    console.log('');
    const create = await tuiYesNo(
      `¿Crear los ${updates.missing.length} archivos faltantes (${updates.missing.map(m => basename(m.dst)).join(', ')})?`,
      true,
    );
    if (create) {
      for (const m of updates.missing) {
        await copyTemplateFile(m);
        console.log(green('  ✓ ' + basename(m.dst) + ' creado.'));
      }
    } else {
      console.log(dim('  ⊘ archivos faltantes no creados.'));
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

async function actionUpdateAgents() {
  clearScreen();
  printUpdateBanner();
  await ensureUpdated();
  await pressEnterToContinue();
}

async function actionSetModels(agentDir) {
  clearScreen();
  printModelsBanner();

  const current = await readCurrentModels(agentDir);

  // Paso 1: detectar
  const detected = await detect();

  if (detected.providers.size === 0) {
    console.log('');
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

  // Paso 2: lista final
  const allModels = await getFinalModelList(detected);
  if (!allModels || allModels.length === 0) {
    console.log('\nCancelado.');
    await pressEnterToContinue();
    return;
  }

  // Paso 3: asignar
  const target = await chooseMode(allModels, current);
  if (!target) {
    console.log('\nCancelado.');
    await pressEnterToContinue();
    return;
  }

  // Paso 4: diff y aplicar
  const hasChanges = printDiff(current, target);

  if (hasChanges) {
    const confirm = await tuiYesNo('\n¿Aplicar los cambios?', false);
    if (confirm) {
      await applyChanges(agentDir, current, target);
    } else {
      console.log('\nCancelado. Ningún archivo modificado.');
    }
  } else {
    console.log('\n' + dim('  ✓ Los modelos ya están configurados — no hay cambios que aplicar.'));
  }

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

async function pressEnterToContinue() {
  console.log('');
  console.log(dim('  Presioná Enter para volver al menú...'));
  await new Promise((resolve) => {
    const onKey = (str, key) => {
      if (key && (key.name === 'return' || key.name === 'space' || (key.ctrl && key.name === 'c'))) {
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

  console.log('  ' + dim('Proyecto:') + ' ' + cyan(projectName));
  console.log('  ' + dim('Agentes: ') + agentsStatus
    + dim('  ·  vault: ') + vaultStatus
    + dim('  ·  templates: ') + updatesStatus);
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

  return { agentsInstalled, agentCount, vaultPresent, pendingUpdates };
}

async function runMainMenu(agentDir) {
  while (true) {
    const state = await getMainMenuState(agentDir);
    renderMainMenuHeader(agentDir, state);

    const updateLabel = state.pendingUpdates > 0
      ? 'Actualizar agentes      ' + dim(`(${state.pendingUpdates} pendiente${state.pendingUpdates > 1 ? 's' : ''})`)
      : 'Actualizar agentes      ' + dim('(al día)');

    const { index } = await tuiSelect(
      '\n¿Qué querés hacer?',
      [
        updateLabel,
        'Setear modelos de agentes',
        'Instalar herramientas',
        dim('Salir'),
      ],
      0,
    );

    if (index === 0) {
      await actionUpdateAgents();
    } else if (index === 1) {
      await actionSetModels(agentDir);
    } else if (index === 2) {
      await actionInstallTools();
    } else if (index === 3) {
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
  if (err.code === 'ERR_USE_AFTER_CLOSE' || /readline was closed/i.test(err.message || '')) {
    console.log('\n(input cerrado — cancelado)');
    exit(0);
  }
  console.error('\n✗ Error inesperado:', err.message);
  rl.close();
  exit(1);
});

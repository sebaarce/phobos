// Uninstall de Memory (RAG/Qdrant).
//
// Tres niveles:
//   1. Per-proyecto      → borra vault/memory/.engine/* y limpia .gitignore.
//                           Mantiene global (otros proyectos siguen andando).
//   2. Solo global       → borra ~/.phobos/{memory-engine, qdrant-storage,
//                           docker-compose.qdrant.yml} + para+borra container.
//                           Mantiene archivos del proyecto (quedan orphan).
//   3. Completo          → 1 + 2. Si ~/.phobos queda vacío, rompe el junction.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { rl } from '../runtime.mjs';
import { cyan, dim, yellow, red, green, bold } from '../colors.mjs';
import { tuiSelect, tuiYesNo } from '../tui.mjs';
import { printMemoryBanner, renderWizardStep } from '../banners.mjs';
import { pressEnterToContinue } from '../exit.mjs';
import { fileExists, rmrf, safeWriteFile, getDirSize, formatBytes } from '../fs-utils.mjs';
import { runChild } from '../child.mjs';
import { breakJunctionIfEmpty } from '../storage.mjs';
import {
  PHOBOS_HOME,
  QDRANT_COMPOSE_GLOBAL,
  QDRANT_STORAGE_DIR,
  QDRANT_CONTAINER,
  MEMORY_ENGINE_GLOBAL,
  CODEGRAPH_GLOBAL,
} from '../globals.mjs';
import { detectQdrantStatus } from './engine.mjs';

// ═══════════════════════════════════════════════════════════════════
// Per-proyecto: vault/memory/.engine/*
// ═══════════════════════════════════════════════════════════════════

const PROJECT_FILES_TO_DELETE = [
  'vault/memory/.engine/config.json',
  'vault/memory/.engine/launcher.mjs',
  'vault/memory/.engine/.index-state.json',
];

const PROJECT_DIRS_TO_DELETE = [
  'vault/memory/.engine/node_modules', // legacy
  'vault/memory/.engine', // si queda vacío
];

async function uninstallProjectFiles() {
  const removed = [];
  for (const f of PROJECT_FILES_TO_DELETE) {
    if (await fileExists(f)) {
      await rmrf(f);
      removed.push(f);
    }
  }
  for (const d of PROJECT_DIRS_TO_DELETE) {
    if (await fileExists(d)) {
      await rmrf(d);
      removed.push(d + '/');
    }
  }
  return removed;
}

// Quita las líneas que Phobos agregó al .gitignore para Memory.
async function cleanGitignoreEntries() {
  const gitignorePath = join(cwd(), '.gitignore');
  if (!await fileExists(gitignorePath)) return { cleaned: false };
  const content = await readFile(gitignorePath, 'utf-8');

  // Patrones a remover (con comentarios contextuales si están).
  const patterns = [
    /^# Phobos memory engine.*$\r?\n/gm,
    /^# Defensa: si quedó algún node_modules legacy.*$\r?\n/gm,
    /^vault\/memory\/\.engine\/\.index-state\.json\r?\n/gm,
    /^vault\/memory\/\.engine\/node_modules\/\r?\n/gm,
  ];
  let cleaned = content;
  for (const p of patterns) {
    cleaned = cleaned.replace(p, '');
  }
  // Colapsar saltos de línea triples a doble
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  if (cleaned === content) return { cleaned: false };
  await safeWriteFile('.gitignore', cleaned);
  return { cleaned: true };
}

// ═══════════════════════════════════════════════════════════════════
// Global: ~/.phobos/{memory-engine,qdrant-storage,docker-compose...}
// ═══════════════════════════════════════════════════════════════════

async function stopAndRemoveQdrant() {
  const status = await detectQdrantStatus();
  if (!status.containerRunning) {
    // El container puede no estar corriendo pero existir parado.
    await runChild('docker', ['rm', '-f', QDRANT_CONTAINER], `docker rm -f ${QDRANT_CONTAINER}`).catch(() => {});
    return { wasRunning: false };
  }
  // compose down (limpio, también remueve el container)
  await runChild('docker', ['compose', '-f', QDRANT_COMPOSE_GLOBAL, 'down'], 'docker compose down').catch(() => {});
  return { wasRunning: true };
}

async function uninstallGlobalFiles() {
  const removed = [];
  // Container Qdrant
  const stop = await stopAndRemoveQdrant();
  removed.push('docker container ' + QDRANT_CONTAINER + (stop.wasRunning ? ' (estaba corriendo)' : ''));

  // Compose
  if (await fileExists(QDRANT_COMPOSE_GLOBAL)) {
    await rmrf(QDRANT_COMPOSE_GLOBAL);
    removed.push(QDRANT_COMPOSE_GLOBAL);
  }
  // qdrant-storage (vectores de TODOS los proyectos)
  if (await fileExists(QDRANT_STORAGE_DIR)) {
    await rmrf(QDRANT_STORAGE_DIR);
    removed.push(QDRANT_STORAGE_DIR + '/');
  }
  // memory-engine (deps + scripts)
  if (await fileExists(MEMORY_ENGINE_GLOBAL)) {
    await rmrf(MEMORY_ENGINE_GLOBAL);
    removed.push(MEMORY_ENGINE_GLOBAL + '/');
  }
  return removed;
}

// ═══════════════════════════════════════════════════════════════════
// Pre-flight: calcula qué se va a borrar (sin borrar nada todavía)
// ═══════════════════════════════════════════════════════════════════

async function previewProjectFiles() {
  const items = [];
  for (const f of PROJECT_FILES_TO_DELETE) {
    if (await fileExists(f)) items.push({ path: f, type: 'file' });
  }
  for (const d of PROJECT_DIRS_TO_DELETE) {
    if (await fileExists(d)) {
      const size = await getDirSize(d);
      items.push({ path: d + '/', type: 'dir', size });
    }
  }
  return items;
}

async function previewGlobalFiles() {
  const items = [];
  if (await fileExists(QDRANT_COMPOSE_GLOBAL)) {
    items.push({ path: QDRANT_COMPOSE_GLOBAL, type: 'file' });
  }
  if (await fileExists(QDRANT_STORAGE_DIR)) {
    items.push({ path: QDRANT_STORAGE_DIR + '/', type: 'dir', size: await getDirSize(QDRANT_STORAGE_DIR) });
  }
  if (await fileExists(MEMORY_ENGINE_GLOBAL)) {
    items.push({ path: MEMORY_ENGINE_GLOBAL + '/', type: 'dir', size: await getDirSize(MEMORY_ENGINE_GLOBAL) });
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════════
// Entry point del wizard de uninstall
// ═══════════════════════════════════════════════════════════════════

export async function actionUninstallMemory() {
  const history = [];

  // ── Step 1: Elegir nivel ─────────────────────────────────────────
  renderWizardStep(printMemoryBanner, history, 'Desinstalar Memory — elegí qué borrar');

  const projectItems = await previewProjectFiles();
  const globalItems = await previewGlobalFiles();

  if (projectItems.length === 0 && globalItems.length === 0) {
    console.log('  ' + dim('  ℹ No detecté nada de Memory para desinstalar (ni global ni en este proyecto).'));
    await pressEnterToContinue();
    return;
  }

  const projectSize = projectItems.reduce((s, i) => s + (i.size || 0), 0);
  const globalSize = globalItems.reduce((s, i) => s + (i.size || 0), 0);

  console.log('  ' + dim('Detectado en este proyecto:'));
  if (projectItems.length === 0) {
    console.log('    ' + dim('(nada)'));
  } else {
    for (const i of projectItems) {
      const sizeLabel = i.size != null ? dim(' · ' + formatBytes(i.size)) : '';
      console.log('    ' + cyan(i.path) + sizeLabel);
    }
  }
  console.log('');
  console.log('  ' + dim('Detectado global:'));
  if (globalItems.length === 0) {
    console.log('    ' + dim('(nada)'));
  } else {
    for (const i of globalItems) {
      const sizeLabel = i.size != null ? dim(' · ' + formatBytes(i.size)) : '';
      console.log('    ' + cyan(i.path) + sizeLabel);
    }
    console.log('    ' + yellow('⚠ ') + dim('borrar global ELIMINA las collections de TODOS los proyectos.'));
  }
  console.log('');

  const options = [];
  const handlers = [];
  if (projectItems.length > 0) {
    options.push(`Solo per-proyecto ${dim('(' + formatBytes(projectSize) + ')')}`);
    handlers.push('project');
  }
  if (globalItems.length > 0) {
    options.push(`Solo global ${dim('(' + formatBytes(globalSize) + ' · destruye vectores)')}`);
    handlers.push('global');
  }
  if (projectItems.length > 0 && globalItems.length > 0) {
    options.push(`Completo ${dim('(per-proyecto + global + romper junction si queda vacío · ' + formatBytes(projectSize + globalSize) + ')')}`);
    handlers.push('complete');
  }
  options.push('Cancelar');
  handlers.push('cancel');

  let choice;
  try {
    choice = await tuiSelect('\n¿Qué nivel de desinstalación?', options, options.length - 1);
  } catch {
    return;
  }

  const level = handlers[choice.index];
  if (level === 'cancel') {
    console.log(dim('  ⊘ Cancelado.\n'));
    await pressEnterToContinue();
    return;
  }

  // ── Step 2: Confirmación final ────────────────────────────────────
  let confirmMsg;
  if (level === 'project') confirmMsg = '¿Confirmás borrar SOLO los archivos de este proyecto?';
  else if (level === 'global') confirmMsg = yellow('⚠ Esto destruye los vectores de TODOS los proyectos. ¿Confirmás?');
  else confirmMsg = yellow('⚠ Esto borra todo (proyecto + global + container Qdrant). ¿Confirmás?');

  const confirm = await tuiYesNo('\n' + confirmMsg, false);
  if (!confirm) {
    console.log(dim('  ⊘ Cancelado.\n'));
    await pressEnterToContinue();
    return;
  }

  // ── Step 3: Ejecutar ──────────────────────────────────────────────
  console.log('');
  if (level === 'project' || level === 'complete') {
    console.log(cyan('▸ Borrando archivos del proyecto...'));
    const removed = await uninstallProjectFiles();
    for (const r of removed) console.log(green('  ✓ ') + dim('borrado: ') + r);
    const gi = await cleanGitignoreEntries();
    if (gi.cleaned) console.log(green('  ✓ ') + dim('.gitignore: removí entradas de Memory'));
  }
  if (level === 'global' || level === 'complete') {
    console.log('');
    console.log(cyan('▸ Borrando archivos globales (y container Qdrant)...'));
    const removed = await uninstallGlobalFiles();
    for (const r of removed) console.log(green('  ✓ ') + dim('borrado: ') + r);
  }

  // ── Step 4: Romper junction si "completo" y ~/.phobos queda vacío ─
  if (level === 'complete') {
    console.log('');
    const r = await breakJunctionIfEmpty(PHOBOS_HOME);
    if (r.broken) {
      console.log(green('  ✓ ') + dim('Junction roto: ') + cyan(PHOBOS_HOME) + dim(' (apuntaba a ') + r.target + dim(')'));
    } else if (r.reason === 'target-not-empty') {
      console.log(yellow('  ⚠ Mantengo el junction ') + cyan(PHOBOS_HOME) + dim(' — todavía hay contenido:'));
      for (const name of r.remaining.slice(0, 5)) {
        console.log('      ' + dim(name));
      }
      if (r.remaining.length > 5) {
        console.log('      ' + dim('  … y ' + (r.remaining.length - 5) + ' más'));
      }
      // Si quedó CodeGraph adentro, dar hint
      if (r.remaining.includes('codegraph')) {
        console.log('  ' + dim('  Tip: para llegar a estado virgen, después corré "Desinstalar CodeGraph (Completo)".'));
      }
    }
    // Si no es link, no había junction — no hay nada que romper.
  }

  console.log('');
  console.log(green('  ✓ Memory desinstalada.'));
  console.log('');
  await pressEnterToContinue();
}

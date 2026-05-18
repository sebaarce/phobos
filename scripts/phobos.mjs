#!/usr/bin/env node
/**
 * phobos — CLI del sistema Phobos para OpenCode.
 *
 * Entry point del wizard interactivo: bootstrap inicial, actualización de
 * agentes, configuración de modelos por agente, instalación de herramientas
 * externas (autoskills, obsidian-skills, impeccable), y setup completo del
 * memory engine (Qdrant local + @xenova/transformers + collection per project).
 *
 * El código está modularizado bajo scripts/lib/ — este archivo es solo el
 * entry: main(), runMainMenu(), y el header del menú principal.
 *
 * Uso:
 *   node scripts/phobos.mjs
 *   npm run phobos
 *   npx github:sebaarce/phobos   (canónico — sin instalación)
 *   npx phobos                  (solo si hiciste npm link local)
 *
 * Requiere: OpenCode CLI en PATH + Node >= 18. Sin dependencias externas.
 */

import { readdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { cwd, stdin, stdout, exit } from 'node:process';

import { AGENTS_DIR, TEMPLATES_DIR, rl } from './lib/runtime.mjs';
import { fileExists } from './lib/fs-utils.mjs';
import { yellow, cyan, green, dim } from './lib/colors.mjs';
import { clearScreen } from './lib/tui.mjs';
import { printHeader, showHappyGoodbye, showSadGoodbye } from './lib/banners.mjs';
import { WIZARD_CANCELLED, finalizeAndExit, runAction } from './lib/exit.mjs';
import { tuiSelect } from './lib/tui.mjs';
import { ensureBootstrap } from './lib/bootstrap.mjs';
import { scanForUpdates, actionUpdateAgents } from './lib/update.mjs';
import { actionSetModels, actionViewModels } from './lib/models.mjs';
import { actionInstallTools } from './lib/tools.mjs';
import { actionMemory } from './lib/memory/index.mjs';
import { detectQdrantStatus } from './lib/memory/engine.mjs';

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
          'Ver configuración de modelos',
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
      await runAction(() => actionViewModels(agentDir));
    } else if (index === 2) {
      await runAction(() => actionSetModels(agentDir));
    } else if (index === 3) {
      await runAction(() => actionInstallTools());
    } else if (index === 4) {
      await runAction(() => actionMemory());
    } else if (index === 5) {
      clearScreen();
      showHappyGoodbye();
      finalizeAndExit(0);
      return;
    }
  }
}

// Red de seguridad: en raw mode Node intercepta Ctrl+C como keypress en vez
// de SIGINT, así que cada TUI lo maneja a mano. Si por algún motivo un
// listener no llegó a desregistrarse (zombie tras Esc en un sub-wizard),
// este handler global garantiza que Ctrl+C siempre cierre limpio.
process.on('SIGINT', () => {
  console.log('\n' + dim('(salida)'));
  finalizeAndExit(130);
});

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

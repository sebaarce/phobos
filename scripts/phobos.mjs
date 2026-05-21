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

import { TEMPLATES_DIR, rl } from './lib/runtime.mjs';
import { fileExists } from './lib/fs-utils.mjs';
import { yellow, cyan, green, dim, bold } from './lib/colors.mjs';
import { clearScreen } from './lib/tui.mjs';
import { printHeader, showHappyGoodbye, showSadGoodbye } from './lib/banners.mjs';
import { WIZARD_CANCELLED, finalizeAndExit, runAction } from './lib/exit.mjs';
import { tuiSelect } from './lib/tui.mjs';
import { ensureBootstrap } from './lib/bootstrap.mjs';
import { scanForUpdates, actionUpdateAgents, actionUpdateAgentsMultiIDE } from './lib/update.mjs';
import { actionSetModels, actionViewModels } from './lib/models.mjs';
import { actionInstallTools, actionCodeGraph, detectCodeGraphStatus } from './lib/tools.mjs';
import { runChild } from './lib/child.mjs';
import { actionMemory } from './lib/memory/index.mjs';
import { detectQdrantStatus } from './lib/memory/engine.mjs';
import { OpencodeAdapter } from './lib/adapters/opencode.mjs';
import { ClaudeAdapter } from './lib/adapters/claude.mjs';

// ═══════════════════════════════════════════════════════════════════
// Menu principal — stack-based con clear screen entre niveles
// ═══════════════════════════════════════════════════════════════════

function renderMainMenuHeader(agentDir, installState) {
  clearScreen();
  printHeader();

  const projectName = basename(cwd()) || cwd();

  // IDEs instalados: una línea por cada uno con su agentDir + count.
  // Si solo hay uno, queda igual de compacto que antes. Si hay dos,
  // el usuario ve ambos reflejados (OpenCode y Claude Code).
  const ideLines = installState.installedIDEs.length === 0
    ? [dim('  IDEs:    ') + yellow('⚠ ninguno instalado')]
    : installState.installedIDEs.map(ide => {
        const count = green(`${ide.agentCount}`);
        return '  ' + dim('IDE:     ') + cyan(ide.displayName)
          + dim('  ·  ') + dim(ide.agentDir + '/') + dim(' → ') + count + dim(' agentes');
      });

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

  // CodeGraph status — paralelo a Memory en el header.
  let codeGraphStatus;
  const cg = installState.codeGraph || {};
  if (!cg.pkgInstalled) {
    codeGraphStatus = dim('— no instalado');
  } else if (!cg.dbBuilt) {
    codeGraphStatus = yellow('⚠ paquete instalado · falta indexar');
  } else {
    // dbBuilt: mostrar size + frescura del índice.
    const sizeLabel = cg.sizeMB != null ? ` · DB ${cg.sizeMB} MB` : '';
    let freshness = '';
    if (cg.lastIndexedAt) {
      const ageMs = Date.now() - cg.lastIndexedAt.getTime();
      const ageH = ageMs / (1000 * 60 * 60);
      if (ageH < 24)       freshness = '  ·  ' + green('indexado hace < 1 día');
      else if (ageH < 168) freshness = '  ·  ' + dim(`indexado hace ${Math.round(ageH / 24)} días`);
      else                 freshness = '  ·  ' + yellow(`indexado hace ${Math.round(ageH / 24)} días`);
    }
    codeGraphStatus = green('✓ instalado') + dim(sizeLabel) + freshness;
  }

  console.log('  ' + dim('Proyecto:') + ' ' + cyan(projectName));
  for (const line of ideLines) console.log(line);
  console.log('  ' + dim('Vault:   ') + vaultStatus
    + dim('  ·  templates (' + installState.activeIDE + '): ') + updatesStatus);
  console.log('  ' + dim('Memory:  ') + memoryStatus);
  console.log('  ' + dim('CodeGraph: ') + codeGraphStatus);
  console.log('');
}

async function getMainMenuState(agentDir, adapter) {
  // Multi-IDE: detectamos TODOS los adapters que tienen Phobos instalado en
  // este proyecto y devolvemos info por cada uno (no solo el "activo").
  // Esto permite que el header refleje, ej., que tanto OpenCode como Claude
  // están instalados side-by-side.
  //
  // Contamos SOLO los 6 agentes de Phobos (phobos, researcher, planner,
  // programmer, tester, archivist). Si lo dejamos como "todos los .md del
  // dir", contaríamos también agentes de Claude/OpenCode que el usuario
  // pueda tener al lado de Phobos (ej: .claude/agents/ con 6 phobos + 6 user).
  const PHOBOS_AGENTS = ['phobos', 'researcher', 'planner', 'programmer', 'tester', 'archivist'];
  const all = await detectAllInstalledAdapters();
  const installedIDEs = [];
  for (const a of all) {
    let agentCount = 0;
    try {
      const files = await readdir(resolve(cwd(), a.agentDir));
      const present = new Set(files.filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')));
      agentCount = PHOBOS_AGENTS.filter(n => present.has(n)).length;
    } catch {}
    installedIDEs.push({ id: a.id, displayName: a.displayName, agentDir: a.agentDir, agentCount });
  }

  const vaultPresent = await fileExists('vault');

  let pendingUpdates = 0;
  try {
    const updates = await scanForUpdates(adapter);
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

  // CodeGraph: chequeo barato (file existence + stat), no invoca el binario.
  let codeGraph = null;
  try {
    codeGraph = await detectCodeGraphStatus();
  } catch {
    codeGraph = { pkgInstalled: false, dbBuilt: false };
  }

  return {
    installedIDEs,
    activeIDE: adapter.displayName,
    vaultPresent,
    pendingUpdates,
    memoryInstalled,
    qdrantRunning,
    codeGraph,
  };
}

async function runMainMenu(agentDir, adapter) {
  while (true) {
    const state = await getMainMenuState(agentDir, adapter);
    renderMainMenuHeader(agentDir, state);

    const updateLabel = state.pendingUpdates > 0
      ? 'Actualizar agentes      ' + dim(`(${state.pendingUpdates} pendiente${state.pendingUpdates > 1 ? 's' : ''})`)
      : 'Actualizar agentes      ' + dim('(al día)');

    const memoryLabel = state.memoryInstalled
      ? 'Memory (RAG)            ' + dim('(instalado · reindex / reset / re-instalar)')
      : 'Memory (RAG)            ' + dim('(instalar engine de búsqueda semántica)');

    // CodeGraph label — paralelo a Memory.
    const cg = state.codeGraph || {};
    let codeGraphLabel;
    if (!cg.pkgInstalled) {
      codeGraphLabel = 'CodeGraph               ' + dim('(instalar índice semántico del código)');
    } else if (!cg.dbBuilt) {
      codeGraphLabel = 'CodeGraph               ' + dim('(paquete instalado · falta indexar)');
    } else {
      codeGraphLabel = 'CodeGraph               ' + dim('(instalado · re-indexar / re-instalar)');
    }

    // "Instalar Phobos para..." — entry point del wizard. Lista todos los IDE
    // soportados, marca cuáles ya están instalados, y permite agregar soporte
    // a uno nuevo. Va primero porque es la acción "raíz" del wizard.
    // El parenthetical refleja TODOS los IDEs instalados (multi-IDE aware).
    const installedNames = state.installedIDEs.map(i => i.displayName).join(', ');
    const installLabel = 'Instalar Phobos para...  '
      + dim(`(instalado: ${installedNames || 'ninguno'})`);

    // "Abrir TUI" — lanza la TUI del IDE con Phobos. Si hay más de un IDE
    // instalado, el parenthetical lo refleja y `actionOpenTUI` pregunta cuál.
    const installedTUIs = await detectAllInstalledAdapters();
    const tuiNames = installedTUIs.map(a => a.displayName).join(' o ');
    const tuiLabel = 'Abrir TUI                ' + dim(`(${tuiNames || adapter.displayName})`);

    // En el menú principal Esc no tiene sentido (no hay "menú padre"),
    // pero si el usuario lo apreta, lo tratamos como "no acción" — solo re-rendereamos.
    let choice;
    try {
      choice = await tuiSelect(
        '\n¿Qué querés hacer?',
        [
          installLabel,
          updateLabel,
          'Ver configuración de modelos',
          'Setear modelos de agentes',
          'Instalar herramientas',
          memoryLabel,
          codeGraphLabel,
          tuiLabel,
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
      await runAction(() => actionInstallPhobos(adapter));
    } else if (index === 1) {
      // Actualizar agentes — el orchestrator multi-IDE muestra summary por
      // cada IDE instalado (al día / X pendientes) y ofrece: aplicar pendientes,
      // forzar resync (multi-select de IDEs), o saltar.
      const targets = await detectAllInstalledAdapters();
      await runAction(() => actionUpdateAgentsMultiIDE(targets));
    } else if (index === 2) {
      const target = await pickAdapterFor('Ver configuración de modelos', adapter);
      if (target) await runAction(() => actionViewModels(target));
    } else if (index === 3) {
      const target = await pickAdapterFor('Setear modelos de agentes', adapter);
      if (target) await runAction(() => actionSetModels(target));
    } else if (index === 4) {
      await runAction(() => actionInstallTools(adapter));
    } else if (index === 5) {
      await runAction(() => actionMemory(adapter));
    } else if (index === 6) {
      await runAction(() => actionCodeGraph(adapter));
    } else if (index === 7) {
      // Abrir TUI — al volver del child (TUI cerrada) salimos del wizard:
      // el usuario ya consumió la sesión, no tiene sentido reaparecer el menú.
      const launched = await actionOpenTUI(adapter);
      if (launched) {
        showHappyGoodbye();
        finalizeAndExit(0);
        return;
      }
      // launched=false → el usuario canceló el sub-prompt de "qué TUI" — volvemos al menú.
    } else if (index === 8) {
      clearScreen();
      showHappyGoodbye();
      finalizeAndExit(0);
      return;
    }
  }
}

// Acción "Instalar Phobos para..." — entry point del wizard, bootstrap-equivalente.
// Muestra todos los IDE soportados (con su estado actual: instalado / disponible /
// próximamente) y permite:
//   - Re-confirmar / re-bootstrappear el IDE ya instalado (caso raro, lo redirige
//     a "Actualizar agentes" que es más específico).
//   - Hacer bootstrap de un IDE nuevo en el mismo proyecto.
//   - Ver el mensaje "próximamente" si el target es stub.
//
// "Bootstrap" = crear .<ide>/agent/, .<ide>/command/, y vault/ desde los templates.
async function actionInstallPhobos(currentAdapter) {
  clearScreen();
  printHeader();
  console.log('');
  console.log('  ' + cyan('▸ ') + bold('Instalar Phobos para...'));
  console.log(dim('  Bootstrap crea los archivos del IDE elegido + la estructura del vault'));
  console.log(dim('  (`.<ide>/agent/`, `.<ide>/command/`, `vault/memory/`, etc.).'));
  console.log('');

  // Listamos TODOS los adapters conocidos para que el usuario tenga visibilidad
  // completa del estado (qué está instalado, qué falta, qué está en roadmap).
  const allAdapters = [
    new OpencodeAdapter(),
    new ClaudeAdapter(),
  ];

  // Multi-IDE aware: detectamos quiénes están instalados (no solo "el actual").
  // Si chequeáramos solo currentAdapter.id, Claude se marcaría "disponible" aunque
  // ya esté instalado side-by-side con OpenCode.
  const installedIds = new Set(
    (await detectAllInstalledAdapters()).map(a => a.id),
  );

  const options = allAdapters.map(a => {
    let suffix;
    if (installedIds.has(a.id)) {
      suffix = dim('   (ya instalado)');
    } else if (!a.isImplemented) {
      suffix = dim('   (próximamente)');
    } else {
      suffix = dim('   (disponible — bootstrap)');
    }
    return `${a.displayName}${suffix}`;
  });
  options.push(dim('← Volver al menú principal'));

  let choice;
  try {
    choice = await tuiSelect('\n¿Para qué IDE?', options, allAdapters.length);
  } catch (err) {
    if (err === WIZARD_CANCELLED) return;
    throw err;
  }

  const { index } = choice;
  if (index === allAdapters.length) return; // "Volver"

  const target = allAdapters[index];

  // Caso 1: ya está instalado (cualquiera de los IDEs detectados — no solo el "actual").
  if (installedIds.has(target.id)) {
    console.log('');
    console.log('  ' + green('✓ ') + target.displayName + ' ya está instalado en este proyecto.');
    console.log('');
    console.log(dim('  Si querés refrescar los templates (.md) a la última versión, usá'));
    console.log(dim('  "Actualizar agentes" en el menú principal. Esa acción detecta diffs entre'));
    console.log(dim('  los templates del repo y los archivos locales, y aplica updates selectivos.'));
    console.log('');
    return;
  }

  // Caso 2: no instalado, stub (no implementado)
  if (!target.isImplemented) {
    clearScreen();
    printHeader();
    console.log('');
    console.log('  ' + cyan('▸ ') + 'Phobos para ' + target.displayName);
    console.log('');
    console.log('  ' + yellow('Próximamente — en desarrollo.'));
    console.log('');
    console.log(dim('  La integración con ' + target.displayName + ' está en la roadmap pero todavía no'));
    console.log(dim('  está implementada. Tu instalación de ' + currentAdapter.displayName + ' sigue intacta.'));
    console.log('');
    return;
  }

  // Caso 3: no instalado, implementado → bootstrap del target en este proyecto.
  // ensureBootstrap detecta qué falta para `target` y pregunta confirmación
  // antes de crear los archivos en .<target.id>/agent/, .<target.id>/command/
  // y vault/ (este último compartido entre IDEs).
  console.log('');
  console.log('  ' + cyan('▸ ') + 'Bootstrap de Phobos para ' + bold(target.displayName));
  console.log('');
  const ok = await ensureBootstrap(target);
  if (ok) {
    console.log('');
    console.log('  ' + green('✓ ') + target.displayName + ' instalado.');
    if (target.id === 'claude') {
      console.log('');
      console.log(dim('  Para usar Phobos en este proyecto, ejecutá:'));
      console.log('    ' + cyan('claude --agent phobos'));
    }
    console.log('');
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

// Selección de target IDE. Para cada adapter implementado, instancia y devuelve.
// Para stubs (isImplemented = false), muestra "próximamente, en desarrollo" y
// devuelve null para que main() cierre limpio.
async function selectTarget() {
  // Adapters disponibles. Orden = orden en que aparecen en el menú.
  // Para agregar un IDE nuevo: importar el adapter y agregarlo a esta lista.
  const adapters = [
    new OpencodeAdapter(),
    new ClaudeAdapter(),
  ];

  const options = adapters.map(a => {
    const suffix = a.isImplemented ? '' : dim('   (próximamente)');
    return `Instalar para ${a.displayName}${suffix}`;
  });
  options.push(dim('Salir'));

  let choice;
  try {
    choice = await tuiSelect(
      '\n¿Para qué IDE configurás Phobos?',
      options,
      0,
    );
  } catch (err) {
    if (err === WIZARD_CANCELLED) return null;
    throw err;
  }

  const { index } = choice;
  if (index === adapters.length) return null; // "Salir"

  const adapter = adapters[index];
  if (!adapter.isImplemented) {
    clearScreen();
    printHeader();
    console.log('');
    console.log('  ' + cyan('▸ ') + 'Phobos para ' + adapter.displayName);
    console.log('');
    console.log('  ' + yellow('Próximamente — en desarrollo.'));
    console.log('');
    console.log(dim('  La integración con ' + adapter.displayName + ' está en la roadmap pero todavía no'));
    console.log(dim('  está implementada. Por ahora solo soportamos OpenCode.'));
    console.log('');
    console.log(dim('  Cuando esté lista, este wizard te va a permitir bootstrappear el mismo'));
    console.log(dim('  flow SDD (Researcher / Planner / Programmer / Tester / Archivist) pero'));
    console.log(dim('  contra ' + adapter.displayName + ' en lugar de OpenCode.'));
    console.log('');
    return null;
  }

  return adapter;
}

// Auto-detección: chequea cuál IDE ya está bootstrapped en este proyecto.
// Devuelve el adapter correspondiente, o null si nada está instalado.
//
// Política para múltiples instalaciones simultáneas (futuro): si hay más de
// un IDE instalado, devolver el primero según orden de prioridad (OpenCode > Claude).
// El menú "Instalar para otro IDE" permite agregar el segundo target.
async function detectInstalledAdapter() {
  const installed = await detectAllInstalledAdapters();
  return installed[0] || null;
}

// Variante: devuelve TODOS los IDEs que tengan Phobos instalado en este
// proyecto (no solo el primero). Útil para "Abrir TUI" cuando el usuario
// tiene OpenCode y Claude Code conviviendo: el menú le pregunta cuál abrir.
async function detectAllInstalledAdapters() {
  const candidates = [new OpencodeAdapter(), new ClaudeAdapter()];
  const installed = [];
  for (const adapter of candidates) {
    if (!adapter.isImplemented) continue;
    try {
      const phobosPath = join(resolve(cwd(), adapter.agentDir), 'phobos.md');
      if (await fileExists(phobosPath)) installed.push(adapter);
    } catch {
      // adapter mal implementado, salteamos.
    }
  }
  return installed;
}

// Pregunta al usuario qué IDE configurar/inspeccionar cuando hay más de uno
// instalado en el proyecto. Si hay solo uno, lo devuelve directo sin prompt.
// Usado por las acciones cuyo estado depende del IDE (modelos, ver config),
// porque .opencode/agent/ y .claude/agents/ tienen frontmatter distinto y
// confundirlos sería un sin-sentido para el usuario.
//
// Devuelve el adapter elegido, o null si el usuario canceló.
async function pickAdapterFor(actionTitle, defaultAdapter) {
  const installed = await detectAllInstalledAdapters();
  if (installed.length <= 1) {
    return installed[0] || defaultAdapter;
  }
  clearScreen();
  printHeader();
  console.log('');
  console.log('  ' + cyan('▸ ') + bold(actionTitle));
  console.log(dim('  Tenés Phobos instalado en más de un IDE — elegí cuál querés configurar.'));
  console.log('');
  const defaultIdx = Math.max(0, installed.findIndex(a => a.id === defaultAdapter.id));
  const options = installed.map(a => a.displayName);
  options.push(dim('← Volver'));
  let choice;
  try {
    choice = await tuiSelect('\n¿Qué IDE?', options, defaultIdx);
  } catch (err) {
    if (err === WIZARD_CANCELLED) return null;
    throw err;
  }
  if (choice.index === installed.length) return null;
  return installed[choice.index];
}

// Abre la TUI del IDE elegido con Phobos como agente primario. Si hay más de
// un IDE instalado, pregunta cuál. Devuelve true si se ejecutó (el caller
// debería cerrar el wizard después — la TUI reemplaza la atención del usuario).
async function actionOpenTUI(currentAdapter) {
  const installed = await detectAllInstalledAdapters();
  if (installed.length === 0) {
    // Defensivo — el main menu solo se renderiza con un adapter activo.
    installed.push(currentAdapter);
  }

  let target = installed[0];
  if (installed.length > 1) {
    clearScreen();
    printHeader();
    console.log('');
    console.log('  ' + cyan('▸ ') + bold('Abrir TUI'));
    console.log('');
    const options = installed.map(a => a.displayName);
    options.push(dim('← Volver'));
    let choice;
    try {
      choice = await tuiSelect('\n¿Qué TUI abrir?', options, 0);
    } catch (err) {
      if (err === WIZARD_CANCELLED) return false;
      throw err;
    }
    if (choice.index === installed.length) return false;
    target = installed[choice.index];
  }

  const { bin, args } = target.launchCommand();
  rl.pause();
  await runChild(bin, args, 'Abrir ' + target.displayName);
  return true;
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

  // Auto-detect: ¿hay una instalación previa de algún IDE en este proyecto?
  let adapter = await detectInstalledAdapter();

  if (!adapter) {
    // Nada instalado — primer arranque. Acá SÍ pedimos al usuario qué IDE.
    adapter = await selectTarget();
    if (!adapter) {
      finalizeAndExit(0);
      return;
    }

    // Bootstrap para el target elegido — ensureBootstrap recibe el adapter
    // y usa adapter.bootstrapFiles() para saber qué copiar.
    const bootstrapped = await ensureBootstrap(adapter);
    if (!bootstrapped) {
      showSadGoodbye();
      finalizeAndExit(0);
      return;
    }
  }
  // Caso "ya hay instalación": directo al menú principal con el adapter
  // detectado. No mostramos selectTarget — operaciones del menú son
  // auto-detect / IDE-agnostic o trabajan sobre lo que ya está instalado.

  const agentDir = resolve(cwd(), adapter.agentDir);

  try {
    await readdir(agentDir);
  } catch {
    console.error(yellow(`\n✗ No encontré ${adapter.agentDir} en ${cwd()}`));
    console.error('  Algo salió mal con el bootstrap. Verificá los permisos de escritura.');
    finalizeAndExit(1);
    return;
  }

  // Entrar al menú principal — loop hasta que el usuario elija Salir
  await runMainMenu(agentDir, adapter);
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

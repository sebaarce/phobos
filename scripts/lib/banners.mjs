// Banners ASCII + renderWizardStep (header del wizard con historial).
import { orange, dim, cyan, green, yellow, bold, visibleLen } from './colors.mjs';
import { clearScreen } from './tui.mjs';
import { PKG_VERSION } from './runtime.mjs';

// ═══════════════════════════════════════════════════════════════════
// Header ASCII
// ═══════════════════════════════════════════════════════════════════

export function printHeader() {
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
  console.log('  ' + dim('Orquestador SDD para OpenCode')
    + dim('  ·  ') + cyan('v' + PKG_VERSION));
  console.log('');
}

export function printUpdateBanner() {
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

export function printModelsBanner() {
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

export function printToolsBanner() {
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

export function printMemoryBanner() {
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

// renderWizardStep — clear + banner + historial compacto + header del paso actual.
// Llamar al INICIO de cada step grande. Las preguntas/info del step se acumulan
// debajo del header hasta que se llama de nuevo (clear + nuevo header).
//
// history: array de { label, value } — el resumen de respuestas ya completadas.
// stepHeader: string con el header del paso actual (ej: "[2/4] Definir lista de modelos").
export function renderWizardStep(bannerFn, history, stepHeader) {
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

export function showHappyGoodbye() {
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

export function showSadGoodbye() {
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

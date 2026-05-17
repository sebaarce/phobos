// Memory router — actionMemory (entrada del menú) + actionMemoryReindexForce.
import { rl } from '../runtime.mjs';
import { fileExists } from '../fs-utils.mjs';
import { cyan, dim, yellow, red, green, bold } from '../colors.mjs';
import { tuiSelect, panel, clearScreen } from '../tui.mjs';
import { runChildCaptured } from '../child.mjs';
import { printMemoryBanner, renderWizardStep } from '../banners.mjs';
import { pressEnterToContinue, runAction, WIZARD_CANCELLED } from '../exit.mjs';
import {
  QDRANT_COMPOSE_GLOBAL,
  detectQdrantStatus,
  listQdrantCollections,
} from './engine.mjs';
import { verifyMemoryDepsInstalled } from './deps.mjs';
import { getProjectActiveCollection } from './collection.mjs';
import { actionInspectQdrant, diagnoseMemoryFailure } from './inspect.mjs';
import { actionInstallMemory } from './install.mjs';
import { actionResetQdrant } from './reset.mjs';

// Router de la opción "Memory (RAG)" del menú principal.
// - Si Memory NO está instalada → corre el wizard de instalación.
// - Si Memory SÍ está instalada → muestra un submenú con: Re-indexar,
//   Reset Qdrant, Re-instalar engine, Volver.
export async function actionMemory() {
  const installed = await fileExists('vault/memory/.engine/config.json');
  if (!installed) {
    return actionInstallMemory();
  }

  while (true) {
    clearScreen();
    printMemoryBanner();

    const qdrant = await detectQdrantStatus();
    const collectionName = await getProjectActiveCollection();
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

export async function actionMemoryReindexForce() {
  const history = [];
  renderWizardStep(printMemoryBanner, history, '[1/1] Re-indexar este proyecto (--force)');

  const qdrant = await detectQdrantStatus();
  if (!qdrant.healthy) {
    console.log(yellow('  ⚠ Qdrant no está corriendo. Levantalo y reintentá:'));
    console.log('    ' + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} up -d`));
    await pressEnterToContinue();
    return;
  }

  // Pre-check: ¿están las deps?
  const deps = await verifyMemoryDepsInstalled();
  if (!deps.ok) {
    history.push({ label: 'Re-indexación', value: 'Abortado — faltan deps en node_modules' });
    renderWizardStep(printMemoryBanner, history, '');
    console.log(red('  ✗ Faltan dependencias en node_modules: ') + cyan(deps.missing.join(', ')));
    console.log('');
    console.log('  ' + dim('  La instalación previa de Memory no completó (probable ERESOLVE).'));
    console.log('  ' + dim('  Solución:'));
    console.log('    ' + cyan('  npm install --legacy-peer-deps @xenova/transformers @qdrant/js-client-rest'));
    console.log('  ' + dim('  Después volvé a este submenú y reintentá.'));
    await pressEnterToContinue();
    return;
  }

  rl.pause();
  const result = await runChildCaptured(
    'node',
    ['vault/memory/.engine/index-vault.mjs', '--force'],
    'index-vault.mjs --force',
  );

  if (result.code === 0) {
    history.push({ label: 'Re-indexación', value: 'OK — todos los archivos re-vectorizados' });
    renderWizardStep(printMemoryBanner, history, '');
    console.log(green('  ✓ Re-index completo.'));
    await pressEnterToContinue();
    return;
  }

  // Falló — diagnóstico
  history.push({ label: 'Re-indexación', value: `Falló (exit ${result.code})` });
  renderWizardStep(printMemoryBanner, history, '');
  console.log(red('  ✗ Re-index falló (exit ' + result.code + ').'));
  console.log('');

  const fullOutput = result.stderr + '\n' + result.stdout;
  const allLines = fullOutput.split('\n').filter(l => l.length > 0);

  // Si encontramos una línea con "Cannot find" la priorizamos en el tail.
  const importantIdx = allLines.findIndex(l => /Cannot find (module|package)|MODULE_NOT_FOUND|fatal:/i.test(l));
  let tailLines;
  if (importantIdx >= 0) {
    // Mostrar 3 líneas antes y 12 después del error (cubre el stack relevante)
    const start = Math.max(0, importantIdx - 3);
    const end = Math.min(allLines.length, importantIdx + 13);
    tailLines = allLines.slice(start, end);
  } else {
    tailLines = allLines.slice(-15);
  }

  console.log('  ' + bold('Output relevante:'));
  if (tailLines.length === 0) {
    console.log('    ' + dim('(sin output capturado)'));
  } else {
    for (const line of tailLines) {
      console.log('    ' + dim(line));
    }
  }

  console.log('');
  const diagnosis = diagnoseMemoryFailure(fullOutput);
  if (diagnosis) {
    console.log('  ' + bold(yellow('💡 Diagnóstico: ')) + diagnosis.hint);
    for (const step of diagnosis.steps) {
      console.log('  ' + dim('    ' + step));
    }
  } else {
    console.log('  ' + dim('  No reconozco el error. Probá manualmente para ver más detalle:'));
    console.log('    ' + cyan('node vault/memory/.engine/index-vault.mjs --force'));
  }

  await pressEnterToContinue();
}

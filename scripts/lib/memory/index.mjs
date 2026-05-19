// Memory router — actionMemory (entrada del menú) + actionMemoryReindexForce + actionSetCollection.
import { readFile } from 'node:fs/promises';
import { rl } from '../runtime.mjs';
import { fileExists, safeWriteFile } from '../fs-utils.mjs';
import { cyan, dim, yellow, red, green, bold, pad } from '../colors.mjs';
import { tuiSelect, tuiYesNo, panel, clearScreen } from '../tui.mjs';
import { runChildCaptured } from '../child.mjs';
import { printMemoryBanner, renderWizardStep } from '../banners.mjs';
import { pressEnterToContinue, runAction, WIZARD_CANCELLED } from '../exit.mjs';
import {
  QDRANT_COMPOSE_GLOBAL,
  QDRANT_URL,
  detectQdrantStatus,
  listQdrantCollections,
  listQdrantCollectionsDetailed,
} from './engine.mjs';
import { verifyMemoryDepsInstalled } from './deps.mjs';
import { getProjectActiveCollection } from './collection.mjs';
import { actionInspectQdrant, diagnoseMemoryFailure } from './inspect.mjs';
import { actionInstallMemory } from './install.mjs';
import { actionResetQdrant } from './reset.mjs';

const CONFIG_PATH = 'vault/memory/.engine/config.json';

// Lee config.json del proyecto, cambia qdrant.collection al nuevo nombre,
// y lo escribe de vuelta preservando indentación / otros campos.
async function updateConfigCollection(newCollectionName) {
  const raw = await readFile(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed.qdrant) parsed.qdrant = {};
  parsed.qdrant.collection = newCollectionName;
  // safeWriteFile valida sandbox (cwd) + rechaza symlinks.
  await safeWriteFile(CONFIG_PATH, JSON.stringify(parsed, null, 2) + '\n');
}

// Borra una collection de Qdrant via REST API. Devuelve true si ok.
async function deleteQdrantCollection(name) {
  try {
    const r = await fetch(`${QDRANT_URL}/collections/${encodeURIComponent(name)}`, { method: 'DELETE' });
    return r.ok;
  } catch {
    return false;
  }
}

// Router de la opción "Memory (RAG)" del menú principal.
// - Si Memory NO está instalada → corre el wizard de instalación.
// - Si Memory SÍ está instalada → muestra un submenú con: Re-indexar,
//   Reset Qdrant, Re-instalar engine, Volver.
// `adapter` opcional: las acciones de Memory son mayormente IDE-agnostic
// (Qdrant, vault/, scripts del engine). Solo lo necesitan los checkers que
// leen agentes (`detectResearcherHasRAG`, `detectAgentsHaveMemorySupport`) y
// los install/update paths que tocan `.opencode/agent/` (o `.claude/agents/`).
// Lo pasamos para que esos dependientes lo reciban; sin adapter, fallbackean
// a `.opencode/agent/` por compatibilidad.
export async function actionMemory(adapter) {
  const installed = await fileExists('vault/memory/.engine/config.json');
  if (!installed) {
    return actionInstallMemory(adapter);
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
          'Set / Rename Collection ' + dim('(cambiar a qué collection apunta este proyecto)'),
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

    if (choice.index === 5) return;
    if (choice.index === 0) {
      await runAction(() => actionInspectQdrant(adapter));
    } else if (choice.index === 1) {
      await runAction(() => actionMemoryReindexForce());
    } else if (choice.index === 2) {
      await runAction(() => actionSetCollection());
    } else if (choice.index === 3) {
      await runAction(() => actionResetQdrant());
    } else if (choice.index === 4) {
      await runAction(() => actionInstallMemory(adapter));
    }
  }
}

// Wizard para cambiar la collection a la que apunta este proyecto.
// Solo modifica vault/memory/.engine/config.json — los prompts del agente
// (researcher.md, archivist.md) son agnósticos al nombre porque consultan
// el config en runtime via search.mjs / index-vault.mjs.
export async function actionSetCollection() {
  clearScreen();
  printMemoryBanner();

  panel('Set / Rename Collection', [
    'Cambia la collection de Qdrant a la que apunta este proyecto.',
    'Solo modifica vault/memory/.engine/config.json — los prompts NO se tocan.',
  ]);

  const current = await getProjectActiveCollection();
  const qdrant = await detectQdrantStatus();

  console.log('');
  console.log('  ' + bold('Estado actual'));
  console.log('  ' + dim('  config.json apunta a: ') + cyan(current));

  if (!qdrant.healthy) {
    console.log('  ' + yellow('  ⚠ Qdrant no responde — no puedo listar collections disponibles.'));
    console.log('  ' + dim('  Levantá Qdrant y reintentá:'));
    console.log('    ' + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} up -d`));
    await pressEnterToContinue();
    return;
  }

  const existing = await listQdrantCollectionsDetailed();

  console.log('');
  console.log('  ' + bold('Collections disponibles en Qdrant'));
  if (existing.length === 0) {
    console.log('  ' + dim('  (ninguna)'));
  } else {
    const maxName = Math.max(...existing.map(c => c.name.length));
    for (const c of existing) {
      const isCurrent = c.name === current;
      const marker = isCurrent ? green('  ← actual') : '';
      const nameLabel = isCurrent ? cyan(pad(c.name, maxName)) : pad(c.name, maxName);
      console.log('  · ' + nameLabel + '  ' + dim(c.points + ' pts · ' + c.dims + 'd') + marker);
    }
  }
  console.log('');

  let choice;
  try {
    choice = await tuiSelect(
      '¿Qué querés hacer?',
      [
        'Renombrar mi collection ' + dim('(cambia config + crea nueva en Qdrant + re-indexa)'),
        'Apuntar a una collection existente ' + dim('(elige de la lista de arriba)'),
        dim('← Volver al submenú Memory'),
      ],
      0,
    );
  } catch (err) {
    if (err === WIZARD_CANCELLED) return;
    throw err;
  }

  if (choice.index === 2) return;

  if (choice.index === 0) {
    // ─── Renombrar ─────────────────────────────────────────────────
    rl.resume();
    console.log('');
    const inputRaw = (await rl.question('  Nombre nuevo (sin prefijo "phobos-vault-"): ')).trim();
    rl.pause();

    const newSlug = inputRaw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!newSlug) {
      console.log(yellow('  ⚠ Nombre inválido. Cancelando.'));
      await pressEnterToContinue();
      return;
    }
    const newFullName = `phobos-vault-${newSlug}`;

    if (newFullName === current) {
      console.log(yellow('  Es el mismo nombre actual — nada que cambiar.'));
      await pressEnterToContinue();
      return;
    }

    if (existing.some(c => c.name === newFullName)) {
      console.log('');
      console.log(yellow(`  La collection "${newFullName}" ya existe en Qdrant.`));
      const useExisting = await tuiYesNo('¿Apuntar a esa collection existente en lugar de crear una nueva?', false);
      if (useExisting) {
        await updateConfigCollection(newFullName);
        console.log(green(`  ✓ config.json actualizado. Ahora apunta a "${newFullName}".`));
        await pressEnterToContinue();
        return;
      }
      console.log(dim('  Cancelado — elegí otro nombre o "Apuntar a existente".'));
      await pressEnterToContinue();
      return;
    }

    // OK: nombre nuevo válido y no existe en Qdrant
    console.log('');
    console.log(dim('  Pasos a ejecutar:'));
    console.log(dim('    1. Actualizar vault/memory/.engine/config.json → ') + cyan(`"${newFullName}"`));
    console.log(dim('    2. Re-indexar el vault con --force (crea la collection nueva con tus chunks).'));
    console.log(dim('    3. (Opcional) Borrar la collection vieja ') + cyan(`"${current}"`) + dim(' de Qdrant.'));
    console.log('');

    const confirm = await tuiYesNo('¿Continuar?', true);
    if (!confirm) {
      console.log(dim('  Cancelado.'));
      await pressEnterToContinue();
      return;
    }

    await updateConfigCollection(newFullName);
    console.log(green('  ✓ config.json actualizado.'));

    rl.pause();
    const r = await runChildCaptured(
      'node',
      ['vault/memory/.engine/index-vault.mjs', '--force'],
      'index-vault.mjs --force (crea collection nueva)',
    );
    if (r.code !== 0) {
      console.log('');
      console.log(red('  ✗ Re-index falló. La collection nueva podría no haberse creado correctamente.'));
      console.log(dim('  El config.json YA quedó apuntando a "') + newFullName + dim('". Si querés revertir:'));
      console.log('    ' + cyan(`Edit vault/memory/.engine/config.json → "collection": "${current}"`));
      const diag = diagnoseMemoryFailure(r.stderr + '\n' + r.stdout);
      if (diag) {
        console.log('');
        console.log('  ' + bold(yellow('💡 Diagnóstico: ')) + diag.hint);
        for (const step of diag.steps) console.log('  ' + dim('    ' + step));
      }
      await pressEnterToContinue();
      return;
    }
    console.log(green(`  ✓ Re-index completo en collection "${newFullName}".`));

    console.log('');
    const deleteOld = await tuiYesNo(`¿Borrar la collection vieja "${current}" de Qdrant?`, false);
    if (deleteOld) {
      const ok = await deleteQdrantCollection(current);
      console.log(ok
        ? green(`  ✓ Collection vieja "${current}" eliminada.`)
        : yellow('  ⚠ No se pudo eliminar (sigue ahí, podés borrarla manualmente desde el dashboard).'));
    } else {
      console.log(dim('  Collection vieja "' + current + '" sigue intacta en Qdrant.'));
    }

    await pressEnterToContinue();
    return;
  }

  if (choice.index === 1) {
    // ─── Apuntar a una collection existente ─────────────────────────
    const others = existing.filter(c => c.name !== current);
    if (others.length === 0) {
      console.log(yellow('  No hay otras collections en Qdrant (solo tenés la actual).'));
      console.log(dim('  Usá "Renombrar mi collection" si querés crear una nueva.'));
      await pressEnterToContinue();
      return;
    }

    const opts = others.map(c =>
      c.name + dim('  (' + c.points + ' pts · ' + c.dims + 'd)')
    );
    opts.push(dim('← Cancelar'));

    let sel;
    try {
      sel = await tuiSelect('\n¿A cuál apuntar?', opts, 0);
    } catch (err) {
      if (err === WIZARD_CANCELLED) return;
      throw err;
    }
    if (sel.index === opts.length - 1) return;

    const targetName = others[sel.index].name;
    await updateConfigCollection(targetName);
    console.log('');
    console.log(green(`  ✓ config.json actualizado. Ahora apunta a "${targetName}".`));

    console.log('');
    const reindex = await tuiYesNo(
      'El vault local va a indexarse en la collection elegida (los chunks viejos de esa collection se sobreescriben si tienen el mismo ID). ¿Re-indexar ahora?',
      false,
    );
    if (reindex) {
      rl.pause();
      const r = await runChildCaptured(
        'node',
        ['vault/memory/.engine/index-vault.mjs', '--force'],
        'index-vault.mjs --force',
      );
      if (r.code !== 0) {
        console.log(red('  ✗ Re-index falló. Revisá el output arriba.'));
      } else {
        console.log(green('  ✓ Re-index completo.'));
      }
    }

    await pressEnterToContinue();
    return;
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

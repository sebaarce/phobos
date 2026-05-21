// Update flow — compara local vs template, preserva model:
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { cwd, stdin } from 'node:process';
import { TEMPLATES_DIR } from './runtime.mjs';
import { fileExists, tryExec, safeWriteFile } from './fs-utils.mjs';
import { green, yellow, red, cyan, dim, bold } from './colors.mjs';
import { pad } from './colors.mjs';
import { panel, tuiSelect, tuiYesNo, tuiMultiSelect, clearScreen } from './tui.mjs';
import { printUpdateBanner, renderWizardStep } from './banners.mjs';
import { pressEnterToContinue } from './exit.mjs';

// Nota: la lista de archivos trackeados ya NO vive acá. Cada IDEAdapter
// declara sus propios archivos vía adapter.trackedFiles(). Esto permite
// que el mismo flow de "Actualizar agentes" sirva para OpenCode, Claude Code,
// o cualquier IDE futuro — solo cambia el adapter que se le pasa.

export function normalizeIgnoringModel(content) {
  return content.replace(/^model:\s*.+$/m, 'model: <PRESERVED>');
}

// `force=true` salta el chequeo de diff y trata TODOS los archivos trackeados
// como outdated. Es el modo "resync" que el usuario invoca cuando hizo edits
// locales que quiere descartar para volver al estado del template.
export async function scanForUpdates(adapter, { force = false } = {}) {
  if (!adapter) {
    throw new Error('scanForUpdates requires an adapter (IDEAdapter instance).');
  }
  const result = { outdated: [], missing: [], inSync: [] };
  const tracked = adapter.trackedFiles();

  for (const f of tracked) {
    const templatePath = join(TEMPLATES_DIR, f.src);
    const localPath = join(cwd(), f.dst);

    if (!await fileExists(templatePath)) continue;

    if (!await fileExists(localPath)) {
      result.missing.push({ ...f, templatePath, localPath });
      continue;
    }

    // Modo force: skip diff check, treat as outdated.
    if (force) {
      result.outdated.push({ ...f, templatePath, localPath });
      continue;
    }

    // Leer template y aplicar transform si corresponde (ej: Claude target lee
    // de templates de OpenCode y los transforma).
    const tmplRaw = await readFile(templatePath, 'utf-8');
    const tmpl = await applyTransform(tmplRaw, f, adapter);
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

// Aplica el transform del adapter si el archivo lo declara.
// Devuelve el contenido transformado (o el original si no hay transform).
async function applyTransform(content, file, adapter) {
  if (!file.transform || !adapter) return content;
  const fnName = `transform${file.transform.charAt(0).toUpperCase()}${file.transform.slice(1)}`;
  if (typeof adapter[fnName] !== 'function') return content;
  const agentName = file.dst.split(/[\\/]/).pop().replace(/\.md$/, '');
  return adapter[fnName](content, agentName);
}

export async function applyUpdate(file, { preserveLocalModel = true, adapter = null } = {}) {
  const tmpl = await readFile(file.templatePath, 'utf-8');
  let content = await applyTransform(tmpl, file, adapter);

  if (file.ignoreModel && preserveLocalModel) {
    const local = await readFile(file.localPath, 'utf-8');
    const m = local.match(/^model:\s*(.+)$/m);
    if (m) {
      content = content.replace(/^model:\s*.+$/m, `model: ${m[1].trim()}`);
    }
  }
  // Si preserveLocalModel=false, dejamos el modelo del template intacto.

  await safeWriteFile(file.localPath, content);
}

export async function getTemplateModel(file) {
  try {
    const tmpl = await readFile(file.templatePath, 'utf-8');
    const m = tmpl.match(/^model:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

export async function copyTemplateFile(file, { adapter = null } = {}) {
  const tmpl = await readFile(file.templatePath, 'utf-8');
  const content = await applyTransform(tmpl, file, adapter);
  // safeWriteFile crea el dirname y valida path/symlinks.
  await safeWriteFile(file.localPath, content);
}

export function showUpdateStatus(updates) {
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

export function showAgentDiff(file) {
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
// `adapter` permite aplicar el transform del IDE target al template antes de escribirlo.
export async function runUpdateWizard(history, updates, adapter = null) {
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
        await applyUpdate(f, { preserveLocalModel: true, adapter });
        history.push({
          label: `  · ${fileName}`,
          value: `actualizado, modelo preservado (${localModel})`,
        });
        break;
      } else if (index === idxAcceptTemplate) {
        await applyUpdate(f, { preserveLocalModel: false, adapter });
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
        await copyTemplateFile(m, { adapter });
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

export async function backupAgents(filesToBackup, backupBase = '.opencode/agent_backup/phobos') {
  // filesToBackup: array de paths relativos al cwd (ej: '.opencode/agent/phobos.md')
  // backupBase: directorio base donde se crea el subdirectorio <ts>/ con la copia.
  //   Default: '.opencode/agent_backup/phobos' (OpenCode). Para Claude el caller
  //   pasa '.claude/agents_backup/phobos'.
  // Si está vacío, no hace nada. Devuelve { backupRel, count } cuando crea backup;
  // null cuando no había archivos que copiar (para que el caller pueda decidir
  // si mostrar info al usuario).
  if (!filesToBackup || filesToBackup.length === 0) {
    console.log(dim('\n  ⊘ Backup omitido — no hay archivos que vayan a modificarse.'));
    return null;
  }

  const now = new Date();
  const ts =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');

  const backupRel = `${backupBase}/${ts}`;
  const backupDir = join(cwd(), backupRel);
  await mkdir(backupDir, { recursive: true });

  let copied = 0;
  const names = [];

  for (const relPath of filesToBackup) {
    const filename = basename(relPath);
    const src = join(cwd(), relPath);
    // backupDir es relativo a cwd → safeWriteFile valida sandbox + symlinks.
    const dstRel = join(backupRel, filename);
    if (await fileExists(src)) {
      const content = await readFile(src, 'utf-8');
      await safeWriteFile(dstRel, content);
      copied++;
      names.push(filename);
    }
  }

  console.log(green(`\n  ✓ Backup creado: `) + cyan(backupRel + '/'));
  console.log(dim(`    ${copied} archivo(s) copiados: ${names.join(', ')}`));
  return { backupRel, count: copied, files: names };
}

export async function runUpdateAll(updates, adapter = null) {
  for (const f of updates.outdated) {
    await applyUpdate(f, { adapter });
    console.log(green('  ✓ ' + basename(f.dst) + ' actualizado.'));
  }
  for (const m of updates.missing) {
    await copyTemplateFile(m, { adapter });
    console.log(green('  ✓ ' + basename(m.dst) + ' creado.'));
  }
}

export async function ensureUpdated(adapter) {
  const updates = await scanForUpdates(adapter);
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
  // El backup va al folder específico del adapter (.opencode/agent_backup/ o .claude/agents_backup/).
  const filesToBackup = updates.outdated.map(f => f.dst);
  const backupBase = adapter && typeof adapter.backupBaseDir === 'function'
    ? adapter.backupBaseDir()
    : undefined;

  if (filesToBackup.length > 0) {
    const names = filesToBackup.map(p => basename(p)).join(', ');
    const wantsBackup = await tuiYesNo(
      `\n¿Querés hacer un backup de ${filesToBackup.length} archivo${filesToBackup.length > 1 ? 's' : ''} antes de actualizar? ${dim('(' + names + ')')}`,
      true,
    );
    if (wantsBackup) {
      await backupAgents(filesToBackup, backupBase);
    }
  } else {
    console.log(dim('\n  (sin archivos modificables — no se ofrece backup)'));
  }

  if (index === 0) {
    await runUpdateWizard([], updates, adapter);
  } else if (index === 1) {
    await runUpdateAll(updates, adapter);
  }
}

// `force=true` activa modo resync — re-aplica todos los tracked files
// aunque ya estén sincronizados. Útil para revertir edits locales.
export async function actionUpdateAgents(adapter, { force = false } = {}) {
  if (!adapter) {
    throw new Error('actionUpdateAgents requires an adapter (IDEAdapter instance).');
  }
  const history = [];

  // ─── Step 1/4: Detectar archivos diferentes y faltantes ────────────
  renderWizardStep(printUpdateBanner, history, force
    ? '[1/4] Resync — re-aplicando todos los archivos trackeados...'
    : '[1/4] Detectando estado de templates...');
  const updates = await scanForUpdates(adapter, { force });
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
  // En modo force (resync) skip-eamos la pregunta "revisar uno por uno vs
  // aplicar todas" — el user ya eligió "forzar resync" en el orchestrator,
  // implica re-aplicar todo en bloque.
  let strategyIndex;
  if (force) {
    strategyIndex = 1; // "Aplicar todas"
    history.push({ label: 'Estrategia', value: 'Forzar resync (re-aplica todos los archivos)' });
  } else {
    renderWizardStep(printUpdateBanner, history, '[2/4] Elegir estrategia de actualización');

    const detail = [
      totalOutdated > 0 ? `${totalOutdated} ↻ diferente${totalOutdated > 1 ? 's' : ''}` : null,
      totalMissing > 0 ? `${totalMissing} ⚠ faltante${totalMissing > 1 ? 's' : ''}` : null,
    ].filter(Boolean).join(' + ');

    const choice = await tuiSelect(
      '\n¿Qué hacés con las actualizaciones?',
      [
        'Revisar uno por uno (Recomendado)',
        `Aplicar todas las actualizaciones pendientes  ${dim('(' + detail + ', preserva mis modelos)')}`,
        'Saltar — no actualizar nada',
      ],
      0,
    );
    strategyIndex = choice.index;

    if (strategyIndex === 2) {
      history.push({ label: 'Estrategia', value: 'Saltar — sin cambios' });
      renderWizardStep(printUpdateBanner, history, '');
      console.log('  ' + dim('⊘ Actualización saltada.'));
      await pressEnterToContinue();
      return;
    }

    const strategyLabel = strategyIndex === 0 ? 'Revisar uno por uno' : 'Aplicar todas (preserva modelos)';
    history.push({ label: 'Estrategia', value: strategyLabel });
  }

  // ─── Step 3/4: Backup previo ───────────────────────────────────────
  // El backup va al folder específico del adapter (.opencode/agent_backup/
  // para OpenCode, .claude/agents_backup/ para Claude). El display string del
  // history refleja el path real, no hardcodea OpenCode.
  renderWizardStep(printUpdateBanner, history, '[3/4] Backup previo a la actualización');

  const filesToBackup = updates.outdated.map(f => f.dst);
  const backupBase = typeof adapter.backupBaseDir === 'function'
    ? adapter.backupBaseDir()
    : undefined;
  let backupApplied = false;

  if (filesToBackup.length > 0) {
    const names = filesToBackup.map(p => basename(p)).join(', ');
    const wantsBackup = await tuiYesNo(
      `\n¿Querés hacer un backup de ${filesToBackup.length} archivo${filesToBackup.length > 1 ? 's' : ''} antes de actualizar? ${dim('(' + names + ')')}`,
      true,
    );
    if (wantsBackup) {
      await backupAgents(filesToBackup, backupBase);
      backupApplied = true;
    }
    history.push({
      label: 'Backup',
      value: backupApplied
        ? `${filesToBackup.length} archivo${filesToBackup.length > 1 ? 's respaldados' : ' respaldado'} en ${backupBase || '.opencode/agent_backup/phobos'}/`
        : 'Saltado por el usuario',
    });
  } else {
    history.push({
      label: 'Backup',
      value: 'No aplica (sin archivos modificables — solo faltantes)',
    });
  }

  // ─── Step 4/4: Aplicar cambios ─────────────────────────────────────
  if (strategyIndex === 0) {
    // Modo "Revisar uno por uno" — runUpdateWizard hace su propio renderWizardStep
    // por cada archivo y va agregando entries al history.
    await runUpdateWizard(history, updates, adapter);
  } else {
    // Modo "Aplicar todas" — un solo render + ejecución en bloque.
    // En modo force, "todas" significa TODOS los tracked files (porque scan los
    // metió todos en outdated). En modo normal, solo los pendientes reales.
    renderWizardStep(printUpdateBanner, history, force
      ? '[4/4] Aplicar resync — re-aplicando todos los archivos'
      : '[4/4] Aplicar todas las actualizaciones');
    await runUpdateAll(updates, adapter);
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

// ═══════════════════════════════════════════════════════════════════
// Multi-IDE orchestrator — pre-flight summary + dispatch per adapter
// ═══════════════════════════════════════════════════════════════════

// Llama a scanForUpdates por cada IDE instalado. Devuelve un array con
// `{ adapter, updates }` listo para renderizar el summary.
async function getMultiIDEStatus(adapters) {
  const out = [];
  for (const adapter of adapters) {
    const updates = await scanForUpdates(adapter);
    out.push({ adapter, updates });
  }
  return out;
}

// Orchestrator de "Actualizar agentes" cuando hay 1 o más IDEs instalados.
// Es el entry point que phobos.mjs llama desde el menú principal.
//
// Flow:
//   1. Scan multi-IDE (cheap — solo lee archivos).
//   2. Renderiza summary: cada IDE con su status (al día / X pendientes).
//   3. Menú: aplicar pendientes / forzar resync (multi-select) / saltar.
//   4. Dispatch a actionUpdateAgents por cada IDE elegido.
export async function actionUpdateAgentsMultiIDE(adapters) {
  if (!adapters || adapters.length === 0) {
    console.log(dim('\n  No hay IDEs instalados para actualizar.'));
    await pressEnterToContinue();
    return;
  }

  // ─── Step 1: scan multi-IDE ────────────────────────────────────────
  clearScreen();
  printUpdateBanner();
  console.log('');
  console.log('  ' + cyan('▸ ') + bold('Detectando estado de templates en cada IDE...'));
  console.log('');

  const statuses = await getMultiIDEStatus(adapters);

  // ─── Step 2: render summary ────────────────────────────────────────
  const summaryLines = [];
  let totalPending = 0;
  for (const { adapter, updates } of statuses) {
    const out = updates.outdated.length;
    const miss = updates.missing.length;
    const sync = updates.inSync.length;
    totalPending += out + miss;

    let status;
    if (out === 0 && miss === 0) {
      status = green(`✓ al día (${sync} archivo${sync !== 1 ? 's' : ''} sincronizados)`);
    } else {
      const parts = [];
      if (out > 0) parts.push(yellow(`${out} ↻ diferente${out > 1 ? 's' : ''}`));
      if (miss > 0) parts.push(yellow(`${miss} ⚠ faltante${miss > 1 ? 's' : ''}`));
      status = parts.join(' + ') + dim(` (${sync} en sync)`);
    }
    summaryLines.push(cyan(' · ') + bold(adapter.displayName.padEnd(13)) + ' → ' + status);
  }
  panel('Estado por IDE', summaryLines);
  console.log('');

  // ─── Step 3: menu ──────────────────────────────────────────────────
  const options = [];
  const handlers = [];

  if (totalPending > 0) {
    options.push(`Aplicar updates pendientes  ${dim(`(${totalPending} archivo${totalPending > 1 ? 's' : ''} en total — solo IDEs con cambios)`)}`);
    handlers.push('apply-pending');
  }

  options.push(`Forzar resync  ${dim('(re-aplica TODOS los archivos — elegís qué IDEs)')}`);
  handlers.push('force-resync');

  options.push(dim('Saltar — volver al menú'));
  handlers.push('cancel');

  let action;
  try {
    const choice = await tuiSelect('\n¿Qué querés hacer?', options, 0);
    action = handlers[choice.index];
  } catch {
    return; // Esc = cancel
  }

  if (action === 'cancel') return;

  // ─── Step 4: dispatch ──────────────────────────────────────────────
  if (action === 'apply-pending') {
    // Solo procesamos IDEs que tengan algo pendiente.
    const toProcess = statuses.filter(s =>
      s.updates.outdated.length + s.updates.missing.length > 0
    );
    for (let i = 0; i < toProcess.length; i++) {
      const { adapter } = toProcess[i];
      if (toProcess.length > 1) {
        clearScreen();
        printUpdateBanner();
        console.log('  ' + cyan('▸ ') + bold(`Actualizar agentes — ${adapter.displayName}  (${i + 1}/${toProcess.length})`));
        console.log('');
      }
      await actionUpdateAgents(adapter);
    }
    return;
  }

  if (action === 'force-resync') {
    // Multi-select de IDEs (default: todos marcados).
    let chosenIds;
    if (adapters.length === 1) {
      // Single-IDE: confirmamos sin multi-select.
      const confirm = await tuiYesNo(
        `\n¿Forzar resync de ${adapters[0].displayName}? ${dim('(re-aplica todos los archivos sobre los locales)')}`,
        true,
      );
      if (!confirm) return;
      chosenIds = [adapters[0].id];
    } else {
      console.log('');
      console.log('  ' + bold('Forzar resync — ¿qué IDEs?'));
      console.log(dim('  Espacio para marcar/desmarcar, Enter para confirmar.'));
      const options = adapters.map(a => ({ label: a.displayName, value: a.id }));
      const defaultChecked = adapters.map(a => a.id);
      try {
        chosenIds = await tuiMultiSelect('\nResync:', options, defaultChecked);
      } catch {
        return; // Esc
      }
      if (chosenIds.length === 0) {
        console.log(dim('\n  ⊘ Nada seleccionado — cancelado.'));
        await pressEnterToContinue();
        return;
      }
    }

    const toProcess = statuses.filter(s => chosenIds.includes(s.adapter.id));
    for (let i = 0; i < toProcess.length; i++) {
      const { adapter } = toProcess[i];
      if (toProcess.length > 1) {
        clearScreen();
        printUpdateBanner();
        console.log('  ' + cyan('▸ ') + bold(`Resync — ${adapter.displayName}  (${i + 1}/${toProcess.length})`));
        console.log('');
      }
      await actionUpdateAgents(adapter, { force: true });
    }
  }
}

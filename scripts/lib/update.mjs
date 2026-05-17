// Update flow — compara local vs template, preserva model:
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { cwd, stdin } from 'node:process';
import { TEMPLATES_DIR } from './runtime.mjs';
import { fileExists, tryExec } from './fs-utils.mjs';
import { green, yellow, red, cyan, dim, bold } from './colors.mjs';
import { pad } from './colors.mjs';
import { panel, tuiSelect, tuiYesNo } from './tui.mjs';
import { printUpdateBanner, renderWizardStep } from './banners.mjs';
import { pressEnterToContinue } from './exit.mjs';

export const TRACKED_AGENT_FILES = [
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
  { src: 'opencode/command/list-memory.md',    dst: '.opencode/command/list-memory.md',    ignoreModel: false },
];

export function normalizeIgnoringModel(content) {
  return content.replace(/^model:\s*.+$/m, 'model: <PRESERVED>');
}

export async function scanForUpdates() {
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

export async function applyUpdate(file, { preserveLocalModel = true } = {}) {
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

export async function getTemplateModel(file) {
  try {
    const tmpl = await readFile(file.templatePath, 'utf-8');
    const m = tmpl.match(/^model:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

export async function copyTemplateFile(file) {
  const content = await readFile(file.templatePath, 'utf-8');
  await mkdir(dirname(file.localPath), { recursive: true });
  await writeFile(file.localPath, content);
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
export async function runUpdateWizard(history, updates) {
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

export async function backupAgents(filesToBackup) {
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

export async function runUpdateAll(updates) {
  for (const f of updates.outdated) {
    await applyUpdate(f);
    console.log(green('  ✓ ' + basename(f.dst) + ' actualizado.'));
  }
  for (const m of updates.missing) {
    await copyTemplateFile(m);
    console.log(green('  ✓ ' + basename(m.dst) + ' creado.'));
  }
}

export async function ensureUpdated() {
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

export async function actionUpdateAgents() {
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

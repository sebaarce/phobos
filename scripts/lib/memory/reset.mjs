// Reset Qdrant global — destructivo, con backup opcional.
import { join, basename } from 'node:path';
import { rl } from '../runtime.mjs';
import { fileExists, rmrf, copyDirRecursive, getDirSize, formatBytes } from '../fs-utils.mjs';
import { cyan, dim, yellow, red, green, bold } from '../colors.mjs';
import { tuiYesNo } from '../tui.mjs';
import { runChild } from '../child.mjs';
import { printMemoryBanner, renderWizardStep } from '../banners.mjs';
import { pressEnterToContinue } from '../exit.mjs';
import {
  PHOBOS_HOME,
  QDRANT_COMPOSE_GLOBAL,
  QDRANT_CONTAINER,
  detectQdrantStatus,
  listQdrantCollections,
  ensurePhobosHome,
  detectStaleStoragePath,
} from './engine.mjs';
import { getProjectActiveCollection } from './collection.mjs';

export async function actionResetQdrant() {
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

  // Detectar también la carpeta stale del template viejo (`.qdrant_storage`)
  // — usuarios que corrieron install antes del fix de naming tienen sus datos ahí.
  const stale = await detectStaleStoragePath();
  const dirsToBackup = [];
  if (await fileExists(storageDir)) {
    dirsToBackup.push({ path: storageDir, size: storageSize, isStale: false });
  }
  if (stale.oldDirExists && stale.oldDir !== storageDir) {
    const staleSize = await getDirSize(stale.oldDir);
    if (staleSize > 0) {
      dirsToBackup.push({ path: stale.oldDir, size: staleSize, isStale: true });
    }
  }

  const totalSize = dirsToBackup.reduce((sum, d) => sum + d.size, 0);
  const backups = [];   // [{ src, dst, ok }]
  let backupDone = false;

  if (totalSize > 0) {
    console.log('');
    if (dirsToBackup.length > 1) {
      console.log('  ' + bold('Carpetas a respaldar:'));
      for (const d of dirsToBackup) {
        const tag = d.isStale ? yellow(' [stale del template viejo]') : '';
        console.log('    · ' + cyan(d.path) + dim(' (' + formatBytes(d.size) + ')') + tag);
      }
    }
    const wantBackup = await tuiYesNo(
      `¿Hacer backup de ${cyan(formatBytes(totalSize))} antes de borrar?`,
      true,
    );
    if (wantBackup) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

      // Antes de copiar, bajar Qdrant para evitar archivos en uso
      console.log(dim('\n  Bajando Qdrant para evitar archivos en uso...'));
      rl.pause();
      await runChild('docker', ['compose', '-f', QDRANT_COMPOSE_GLOBAL, 'down'], 'docker compose down');

      // Backup de cada carpeta presente (sufijo distintivo si es stale)
      for (const d of dirsToBackup) {
        const suffix = d.isStale ? '-stale' : '';
        const dst = join(PHOBOS_HOME, `qdrant-storage-backup-${ts}${suffix}`);
        console.log(dim('  Copiando ' + d.path + ' → ' + dst));
        try {
          await copyDirRecursive(d.path, dst);
          backups.push({ src: d.path, dst, ok: true });
          console.log(green('  ✓ Backup OK'));
        } catch (err) {
          backups.push({ src: d.path, dst, ok: false, err: err.message || String(err) });
          console.log(yellow('  ⚠ Backup falló para ' + d.path + ': ' + (err.message || err)));
        }
      }

      const anyOk = backups.some(b => b.ok);
      const anyFail = backups.some(b => !b.ok);

      if (anyFail && !anyOk) {
        const continueWithoutBackup = await tuiYesNo('Ningún backup tuvo éxito. ¿Continuar igual con el reset (sin backup)?', false);
        if (!continueWithoutBackup) {
          history.push({ label: 'Backup', value: 'Todos fallaron — wizard abortado' });
          renderWizardStep(printMemoryBanner, history, '');
          console.log(yellow('  Reset abortado. Datos intactos.'));
          await pressEnterToContinue();
          return;
        }
      } else if (anyFail) {
        const continueAnyway = await tuiYesNo(
          `Algunos backups fallaron (${backups.filter(b => !b.ok).length}/${backups.length}). ¿Continuar?`,
          false,
        );
        if (!continueAnyway) {
          history.push({ label: 'Backup', value: 'Parcial — wizard abortado por elección del usuario' });
          renderWizardStep(printMemoryBanner, history, '');
          console.log(yellow('  Reset abortado.'));
          await pressEnterToContinue();
          return;
        }
      }
      backupDone = anyOk;
    }
  } else {
    console.log(dim('  Sin carpetas de storage con contenido — no hay nada que respaldar.'));
  }

  // Para el resto del wizard, `backupPath` se mantiene como el path del backup
  // principal (qdrant-storage) si existe; si solo hay backup del stale, ese.
  const backupPath = backups.find(b => b.ok && !b.dst.endsWith('-stale'))?.dst
                  || backups.find(b => b.ok)?.dst
                  || '';

  history.push({
    label: 'Backup',
    value: !backupDone
      ? (totalSize === 0 ? 'No aplica (sin contenido)' : 'Saltado o falló')
      : backups.length === 1
        ? `Guardado en ${basename(backups[0].dst)}`
        : `${backups.filter(b => b.ok).length} de ${backups.length} carpetas respaldadas`,
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

  // Storage path correcto (template actual)
  if (await fileExists(storageDir)) {
    await rmrf(storageDir);
    console.log(dim('  · ') + cyan(storageDir) + dim(' borrado'));
  }

  // Path stale del template viejo (`.qdrant_storage` con punto + underscore).
  // Si un usuario corrió install antes del fix de naming, los datos quedan ahí
  // y el reset moderno los dejaba intactos → datos zombies. Lo limpiamos también.
  const staleStorageDir = join(PHOBOS_HOME, '.qdrant_storage');
  if (await fileExists(staleStorageDir)) {
    await rmrf(staleStorageDir);
    console.log(dim('  · ') + yellow(staleStorageDir) + dim(' borrado (path stale del template viejo)'));
  }

  if (await fileExists(QDRANT_COMPOSE_GLOBAL)) {
    const { rm } = await import('node:fs/promises');
    await rm(QDRANT_COMPOSE_GLOBAL, { force: true });
    console.log(dim('  · ') + cyan(QDRANT_COMPOSE_GLOBAL) + dim(' borrado'));
  }
  history.push({ label: 'Limpieza', value: 'storage + compose eliminados (incluyendo path stale si existía)' });

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
  const activeCollection = await getProjectActiveCollection();
  history.push({
    label: 'Re-indexación',
    value: indexCode === 0
      ? `Vault del proyecto re-indexado en collection ${activeCollection}`
      : `Falló (exit ${indexCode}) — corré manualmente con node vault/memory/.engine/index-vault.mjs --force`,
  });

  // ─── Pantalla final ─────────────────────────────────────────────────
  renderWizardStep(printMemoryBanner, history, '');
  console.log('  ' + green('Reset completado.'));
  console.log('');
  console.log('  ' + dim('Tu collection en Qdrant: ') + cyan(activeCollection));
  if (backupDone) {
    console.log('  ' + dim('Backup del storage anterior: ') + cyan(backupPath));
    console.log('  ' + dim('  → si querés restaurarlo en el futuro: parar Qdrant, mv backup encima de qdrant-storage/, levantar.'));
  }
  console.log('  ' + dim('Otros proyectos con Memory: corré ') + cyan('/reindex-memory') + dim(' en cada uno para que vuelvan a aparecer en Qdrant.'));
  await pressEnterToContinue();
}

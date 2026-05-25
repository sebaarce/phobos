// Wizard de instalación de Memory.
//
// Flujo nuevo (post-refactor a install global):
//   1. Verificar prerequisitos (docker, node)
//   2. Detectar Qdrant + collection + agentes
//   3. Storage location: prompt de disco (default ~/.phobos o custom)
//   4. Detectar + limpiar instalación legacy en el proyecto (si la hay)
//   5. Copiar engine global a <base>/memory-engine/
//   6. Instalar node_modules en <base>/memory-engine/ (npm install)
//   7. Escribir artefactos chicos en el proyecto (config.json + launcher.mjs)
//   8. Levantar Qdrant
//   9. Indexación inicial

import { join } from 'node:path';
import { homedir } from 'node:os';
import { cwd } from 'node:process';
import { rl } from '../runtime.mjs';
import { cyan, dim, yellow, red, green } from '../colors.mjs';
import { tuiYesNo } from '../tui.mjs';
import { runChild } from '../child.mjs';
import { printMemoryBanner, renderWizardStep } from '../banners.mjs';
import { pressEnterToContinue } from '../exit.mjs';
import { rmrf, formatBytes } from '../fs-utils.mjs';
import {
  PHOBOS_HOME,
  QDRANT_COMPOSE_GLOBAL,
  QDRANT_URL,
  QDRANT_STORAGE_DIR,
  MEMORY_ENGINE_GLOBAL,
  detectQdrantStatus,
  ensurePhobosHome,
  installMemoryEngineGlobalFiles,
  writeProjectMemoryArtifacts,
  appendGitignoreSnippet,
} from './engine.mjs';
import {
  checkCommand,
  verifyMemoryDepsInstalled,
  installMemoryDepsWithRetry,
} from './deps.mjs';
import {
  projectCollectionSlug,
  resolveCollectionSlug,
} from './collection.mjs';
import { detectAgentsHaveMemorySupport } from './inspect.mjs';
import { promptStorageDisk, ensureLinkTo, printVerificationCommands } from '../storage.mjs';
import { detectLegacyMemoryInstall } from '../globals.mjs';

export async function actionInstallMemory(adapter) {
  const history = [];

  // ─── Step 1/9: Verificar prerequisitos ──────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[1/9] Verificar prerequisitos');

  const dockerOK = checkCommand('docker');
  const nodeOK = checkCommand('node');

  console.log('  ' + (dockerOK ? green('✓') : red('✗')) + ' docker');
  console.log('  ' + (nodeOK ? green('✓') : red('✗')) + ' node');
  console.log('  ' + dim('  (el proyecto host no necesita ser Node — Memory se instala global)'));

  if (!dockerOK || !nodeOK) {
    console.log('');
    if (!dockerOK) console.log('  ' + yellow('Docker es necesario para correr Qdrant local. Instalalo desde docker.com/get-started'));
    if (!nodeOK) console.log('  ' + yellow('Node es necesario para el engine de embeddings.'));
    history.push({ label: 'Prerequisitos', value: 'Faltantes — wizard cancelado' });
    renderWizardStep(printMemoryBanner, history, '');
    console.log('  ' + yellow('No se puede continuar. Resolvé los prerequisitos y reintentá.'));
    await pressEnterToContinue();
    return;
  }
  history.push({ label: 'Prerequisitos', value: 'docker ✓, node ✓' });

  // ─── Step 2/9: Detectar Qdrant + collection + agentes ───────────────
  renderWizardStep(printMemoryBanner, history, '[2/9] Detectar Qdrant global y collection');

  const qdrant = await detectQdrantStatus();

  const resolved = qdrant.healthy
    ? await resolveCollectionSlug()
    : { slug: projectCollectionSlug(), isReuse: false };
  if (!resolved) {
    history.push({ label: 'Collection', value: 'Cancelado por colisión de nombre' });
    renderWizardStep(printMemoryBanner, history, '');
    console.log('  ' + dim('⊘ Instalación cancelada.'));
    await pressEnterToContinue();
    return;
  }
  const collectionName = resolved.slug;

  const agentSupport = await detectAgentsHaveMemorySupport(adapter);
  const agentsReady = agentSupport.researcherOK && agentSupport.archivistOK;

  console.log('  ' + dim('Qdrant global: ') + (
    qdrant.containerRunning && qdrant.healthy ? green('✓ corriendo y healthy en ' + QDRANT_URL)
    : qdrant.containerRunning ? yellow('⚠ contenedor up pero sin responder a /healthz aún')
    : dim('— no está corriendo (se levantará en el paso 8)')
  ));
  console.log('  ' + dim('Install mode: ') + cyan('global en ' + MEMORY_ENGINE_GLOBAL)
    + dim('  (el proyecto solo recibe config.json + launcher.mjs)'));
  console.log('  ' + dim('Collection name: ') + cyan(collectionName));
  console.log('  ' + dim('Agentes preparados para Memory: ')
    + (agentsReady
        ? green('✓ researcher y archivist tienen reglas RAG')
        : yellow('⚠ alguno está outdated — ver advertencia abajo')));

  if (!agentsReady) {
    console.log('');
    console.log('  ' + yellow('Advertencia — agentes outdated:'));
    if (!agentSupport.researcherOK) {
      console.log('  ' + dim('  · researcher.md NO tiene la regla "Pre-flight: semantic search"'));
    }
    if (!agentSupport.archivistOK) {
      console.log('  ' + dim('  · archivist.md NO tiene la regla "Trigger semantic re-index"'));
    }
    console.log('');
    console.log('  ' + dim('  Memory se va a instalar igual y los scripts'));
    console.log('  ' + dim('    node vault/memory/.engine/launcher.mjs search "<query>"'));
    console.log('  ' + dim('    node vault/memory/.engine/launcher.mjs index --incremental'));
    console.log('  ' + dim('  van a funcionar correctamente desde la terminal.'));
  }

  history.push({
    label: 'Estado inicial',
    value: `Qdrant ${qdrant.healthy ? 'corriendo' : 'no corriendo'} · install global · agentes ${agentsReady ? 'OK' : 'outdated'}`,
  });

  const proceedPrompt = agentsReady
    ? '\n¿Continuar con la instalación de Memory?'
    : '\n¿Continuar igualmente (los agentes seguirán sin invocar Memory hasta que los actualices)?';

  const proceed = await tuiYesNo(proceedPrompt, agentsReady);
  if (!proceed) {
    history.push({
      label: 'Confirmación',
      value: agentsReady ? 'Cancelado por el usuario' : 'Cancelado — primero actualizar agentes',
    });
    renderWizardStep(printMemoryBanner, history, '');
    console.log('  ' + dim('  ⊘ Instalación cancelada.'));
    await pressEnterToContinue();
    return;
  }

  // ─── Step 3/9: Storage location (disk prompt) ───────────────────────
  renderWizardStep(printMemoryBanner, history, '[3/9] Storage location para Memory (Qdrant + engine)');

  const storage = await promptStorageDisk({
    componentName: 'Memory (Qdrant + engine RAG)',
    defaultLabel: `${PHOBOS_HOME} (default — disco del home)`,
    suggestedSubdir: 'phobos',
  });

  // Si user eligió custom: asegurar PHOBOS_HOME real (junction creado abajo
  // para qdrant-storage y memory-engine) o todo PHOBOS_HOME como junction.
  // Estrategia simple: hacemos junction de PHOBOS_HOME completo si todavía
  // no existe; si ya existe como dir real, solo hacemos junction de las
  // subcarpetas pesadas.
  let memoryStorageBase = null;
  if (storage.mode === 'custom') {
    memoryStorageBase = storage.basePath;
    try {
      // ~/.phobos como junction al disco elegido. Si ya hay datos legacy
      // adentro, ensureLinkTo pregunta migración.
      await ensureLinkTo({
        linkPath: PHOBOS_HOME,
        targetPath: memoryStorageBase,
        componentName: 'Phobos global (~/.phobos)',
      });
      history.push({ label: 'Storage', value: `~/.phobos → ${memoryStorageBase}` });
    } catch (e) {
      console.log('  ' + red('✗ ' + e.message));
      history.push({ label: 'Storage', value: 'Falló: ' + e.message });
      renderWizardStep(printMemoryBanner, history, '');
      await pressEnterToContinue();
      return;
    }
  } else {
    history.push({ label: 'Storage', value: `${PHOBOS_HOME} (default)` });
  }

  // ─── Step 4/9: Detectar + limpiar instalación legacy ────────────────
  renderWizardStep(printMemoryBanner, history, '[4/9] Detectar instalación legacy en el proyecto');

  const legacy = await detectLegacyMemoryInstall(cwd());
  if (legacy.exists) {
    console.log('  ' + yellow('⚠ Detecté instalación legacy en ') + cyan(legacy.path) +
                dim(' (' + formatBytes(legacy.sizeBytes) + ')'));
    console.log('  ' + dim('  Causa: install viejo cuando Memory instalaba node_modules dentro del proyecto.'));
    console.log('  ' + dim('  El install nuevo va a ' + MEMORY_ENGINE_GLOBAL + '/ — el del proyecto sobra.'));
    const cleanLegacy = await tuiYesNo('  ¿Borrar el node_modules legacy del proyecto?', true);
    if (cleanLegacy) {
      await rmrf(legacy.path);
      console.log('  ' + green('✓ ') + dim('Legacy borrado.'));
      history.push({ label: 'Legacy', value: `Limpiado ${formatBytes(legacy.sizeBytes)}` });
    } else {
      console.log('  ' + yellow('  Mantenido. El install global se hace igual; el legacy queda como peso muerto.'));
      history.push({ label: 'Legacy', value: 'Mantenido (decisión del user)' });
    }
  } else {
    console.log('  ' + dim('  ℹ Sin install legacy detectado.'));
    history.push({ label: 'Legacy', value: 'No había' });
  }

  // ─── Step 5/9: Asegurar ~/.phobos + copiar engine global ────────────
  renderWizardStep(printMemoryBanner, history, '[5/9] Preparar ~/.phobos/ y copiar engine global');

  const homeResult = await ensurePhobosHome();
  console.log('  ' + dim('~/.phobos/ ') + (homeResult.created ? green('creado') : dim('ya existía')));
  console.log('  ' + dim('docker-compose.qdrant.yml: ') + cyan(QDRANT_COMPOSE_GLOBAL));
  console.log('');
  console.log('  ' + dim('Engine global → ') + cyan(MEMORY_ENGINE_GLOBAL));
  await installMemoryEngineGlobalFiles();
  history.push({ label: 'Engine global', value: `Scripts copiados a ${MEMORY_ENGINE_GLOBAL}` });

  // ─── Step 6/9: Instalar node_modules en el engine global ────────────
  renderWizardStep(printMemoryBanner, history, '[6/9] Instalar node_modules en ' + MEMORY_ENGINE_GLOBAL);

  console.log('  ' + dim('Deps: @xenova/transformers, @qdrant/js-client-rest, onnxruntime-node'));
  console.log('  ' + dim('  (paquetes incluyen binarios nativos onnxruntime ~50-80 MB)'));

  const preCheck = await verifyMemoryDepsInstalled();
  let installSummary;
  if (preCheck.ok) {
    console.log('  ' + green('✓ Deps ya instaladas en ' + MEMORY_ENGINE_GLOBAL + '/node_modules/ — saltando install.'));
    installSummary = 'Reutilizando install global previo';
  } else {
    const result = await installMemoryDepsWithRetry('npm');
    if (!result.ok) {
      history.push({ label: 'Dependencias', value: `Falló — faltan: ${result.missing.join(', ')}` });
      renderWizardStep(printMemoryBanner, history, '');
      console.log('  ' + red('✗ No se pudieron instalar las dependencias globales.'));
      console.log('  ' + dim('  Probá manualmente:'));
      console.log('    ' + cyan(`cd "${MEMORY_ENGINE_GLOBAL}" && npm install`));
      await pressEnterToContinue();
      return;
    }
    const flagsApplied = result.usedFlags?.length ? ' ' + result.usedFlags.join(' ') : '';
    installSummary = result.exitCode === 0
      ? `Instalado con npm${flagsApplied} en ${MEMORY_ENGINE_GLOBAL}`
      : `Instalado (exit ${result.exitCode}, warnings ignorados) en ${MEMORY_ENGINE_GLOBAL}`;
  }
  history.push({ label: 'Dependencias', value: installSummary });

  // ─── Step 7/9: Escribir artefactos chicos en el proyecto ─────────────
  renderWizardStep(printMemoryBanner, history, '[7/9] Escribir config + launcher en el proyecto');

  await writeProjectMemoryArtifacts(collectionName);
  await appendGitignoreSnippet();
  history.push({
    label: 'Project artifacts',
    value: `config.json (collection=${collectionName}) + launcher.mjs`,
  });

  // ─── Step 8/9: Levantar Qdrant ──────────────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[8/9] Levantar Qdrant global');

  if (qdrant.containerRunning && qdrant.healthy) {
    console.log('  ' + green('✓ Qdrant ya está corriendo — reutilizando instancia global.'));
    history.push({ label: 'Qdrant global', value: 'Ya corriendo, reutilizado' });
  } else {
    console.log('  ' + dim('Levantando Qdrant con docker compose...'));
    rl.pause();
    const composeCode = await runChild(
      'docker',
      ['compose', '-f', QDRANT_COMPOSE_GLOBAL, 'up', '-d'],
      'docker compose up -d (qdrant global)',
    );
    if (composeCode !== 0) {
      history.push({ label: 'Qdrant global', value: 'Falló el docker compose' });
      renderWizardStep(printMemoryBanner, history, '');
      console.log('  ' + yellow('Engine instalado, pero Qdrant no arrancó.'));
      console.log('  ' + dim('  Arrancá Docker Desktop y corré manualmente:'));
      console.log('    ' + cyan(`docker compose -f "${QDRANT_COMPOSE_GLOBAL}" up -d`));
      console.log('  ' + dim('Después, indexá con:'));
      console.log('    ' + cyan('node vault/memory/.engine/launcher.mjs index'));
      await pressEnterToContinue();
      return;
    }
    history.push({ label: 'Qdrant global', value: 'Levantado en ' + QDRANT_URL });

    console.log(dim('\n  Esperando a que Qdrant esté listo (5s)...'));
    await new Promise(r => setTimeout(r, 5000));
  }

  // ─── Step 9/9: Indexación inicial ───────────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[9/9] Indexación inicial del vault');

  rl.pause();
  const indexCode = await runChild(
    'node',
    ['vault/memory/.engine/launcher.mjs', 'index'],
    'launcher.mjs index (full)',
  );
  if (indexCode !== 0) {
    history.push({ label: 'Indexación', value: 'Falló — corré manualmente cuando puedas' });
  } else {
    history.push({ label: 'Indexación', value: `Vault indexado en collection ${collectionName}` });
  }

  // ─── Pantalla final ─────────────────────────────────────────────────
  renderWizardStep(printMemoryBanner, history, '');
  console.log('  ' + green('Memory instalado en modo GLOBAL.'));
  console.log('');
  console.log('  ' + dim('Engine + deps: ') + cyan(MEMORY_ENGINE_GLOBAL));
  console.log('  ' + dim('Qdrant storage: ') + cyan(QDRANT_STORAGE_DIR));
  console.log('  ' + dim('Compose: ') + cyan(QDRANT_COMPOSE_GLOBAL));
  console.log('  ' + dim('Tu collection en Qdrant: ') + cyan(collectionName));
  console.log('');
  console.log('  ' + dim('En el proyecto solo quedan:'));
  console.log('    ' + cyan('vault/memory/.engine/config.json') + dim('  (collection + vault roots)'));
  console.log('    ' + cyan('vault/memory/.engine/launcher.mjs') + dim('  (despacha al engine global)'));
  console.log('');
  console.log('  ' + dim('Comandos útiles (corren desde el proyecto):'));
  console.log('    ' + cyan('node vault/memory/.engine/launcher.mjs search "<query>"'));
  console.log('    ' + cyan('node vault/memory/.engine/launcher.mjs index --incremental'));
  console.log('    ' + cyan('node vault/memory/.engine/launcher.mjs list'));
  console.log('');
  console.log('  ' + dim('Control de Qdrant:'));
  console.log('    ' + cyan(`docker compose -f "${QDRANT_COMPOSE_GLOBAL}" down`));
  console.log('    ' + cyan(`docker compose -f "${QDRANT_COMPOSE_GLOBAL}" up -d`));
  console.log('');
  console.log('  ' + dim('Dashboard Qdrant: ') + cyan('http://localhost:6333/dashboard'));

  if (storage.mode === 'custom') {
    printVerificationCommands('Memory storage', PHOBOS_HOME, memoryStorageBase);
  }

  await pressEnterToContinue();
}

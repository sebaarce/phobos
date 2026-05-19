// Wizard de instalación de Memory.
import { rl } from '../runtime.mjs';
import { cyan, dim, yellow, red, green } from '../colors.mjs';
import { tuiYesNo } from '../tui.mjs';
import { runChild } from '../child.mjs';
import { printMemoryBanner, renderWizardStep } from '../banners.mjs';
import { pressEnterToContinue } from '../exit.mjs';
import {
  PHOBOS_HOME,
  QDRANT_COMPOSE_GLOBAL,
  QDRANT_URL,
  MEMORY_ENGINE_FILES,
  detectQdrantStatus,
  ensurePhobosHome,
  copyMemoryEngineToProject,
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

// `adapter` opcional — se usa para chequear si los agentes locales tienen
// soporte de Memory (ver detectAgentsHaveMemorySupport). Sin adapter, hace
// fallback a `.opencode/agent/`.
export async function actionInstallMemory(adapter) {
  const history = [];

  // ─── Step 1/6: Verificar prerequisitos ──────────────────────────────
  // Solo requerimos docker (para Qdrant) y node (para correr los scripts del
  // engine). El proyecto host NO necesita ser Node — las deps de Memory se
  // instalan aisladas en vault/memory/.engine/node_modules/ (mismo patrón que
  // CodeGraph). Esto permite que Memory funcione en proyectos Rails, Python,
  // Go, Java, etc.
  renderWizardStep(printMemoryBanner, history, '[1/6] Verificar prerequisitos');

  const dockerOK = checkCommand('docker');
  const nodeOK = checkCommand('node');

  console.log('  ' + (dockerOK ? green('✓') : red('✗')) + ' docker');
  console.log('  ' + (nodeOK ? green('✓') : red('✗')) + ' node');
  console.log('  ' + dim('  (el proyecto host no necesita ser Node — Memory se instala aislado)'));

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

  // ─── Step 2/6: Detección de Qdrant global + collection + agentes ────
  // No detectamos problematic-stacks ni leemos .npmrc del proyecto — el
  // install aislado tiene su propio .npmrc con legacy-peer-deps=true,
  // así que esas heurísticas dejaron de aplicar.
  renderWizardStep(printMemoryBanner, history, '[2/6] Detectar Qdrant global y collection');

  const qdrant = await detectQdrantStatus();

  // Resolver collection con detección de colisiones. Si hay otro proyecto con el
  // mismo basename ("backend", "frontend", "api"), el resolver ofrece un nombre
  // alternativo (parent-basename) o custom.
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
    : dim('— no está corriendo (se levantará en el paso 5)')
  ));
  console.log('  ' + dim('Install mode: ') + cyan('aislado en vault/memory/.engine/')
    + dim('  (no toca el package.json del proyecto)'));
  console.log('  ' + dim('Collection name: ') + cyan(collectionName));
  console.log('  ' + dim('Global compose: ') + cyan(QDRANT_COMPOSE_GLOBAL));
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
    console.log('  ' + dim('    node vault/memory/.engine/search.mjs "<query>"'));
    console.log('  ' + dim('    node vault/memory/.engine/index-vault.mjs --incremental'));
    console.log('  ' + dim('  van a funcionar correctamente desde la terminal.'));
    console.log('');
    console.log('  ' + dim('  PERO los agentes viejos no van a invocarlos automáticamente.'));
    console.log('  ' + dim('  Para que Phobos use Memory en su flujo normal de tareas:'));
    console.log('  ' + dim('    1. Cancelá este wizard (Esc o "No").'));
    console.log('  ' + dim('    2. Volvé al menú principal → ') + cyan('"Actualizar agentes"'));
    console.log('  ' + dim('    3. Aplicá las actualizaciones (preservan tus modelos).'));
    console.log('  ' + dim('    4. Volvé a entrar a "Memory (RAG)".'));
  }

  history.push({
    label: 'Estado inicial',
    value: `Qdrant ${qdrant.healthy ? 'corriendo' : 'no corriendo'} · install aislado · agentes ${agentsReady ? 'OK' : 'outdated'}`,
  });

  const proceedPrompt = agentsReady
    ? '\n¿Continuar con la instalación de Memory en este proyecto?'
    : '\n¿Continuar igualmente (los agentes seguirán sin invocar Memory hasta que los actualices)?';

  const proceed = await tuiYesNo(proceedPrompt, agentsReady);
  if (!proceed) {
    history.push({
      label: 'Confirmación',
      value: agentsReady ? 'Cancelado por el usuario' : 'Cancelado — primero actualizar agentes',
    });
    renderWizardStep(printMemoryBanner, history, '');
    if (!agentsReady) {
      console.log('  ' + dim('  Volvé al menú principal y elegí "Actualizar agentes" primero.'));
      console.log('  ' + dim('  Cuando los templates queden sincronizados, reintentá Memory.'));
    } else {
      console.log('  ' + dim('  ⊘ Instalación saltada.'));
    }
    await pressEnterToContinue();
    return;
  }

  // ─── Step 3/6: Copiar engine al proyecto ────────────────────────────
  // Tiene que ir ANTES del install de deps: el package.json y el .npmrc
  // aislados se copian acá, y el install los necesita.
  renderWizardStep(printMemoryBanner, history, '[3/6] Copiar engine al proyecto');

  await copyMemoryEngineToProject(collectionName);
  await appendGitignoreSnippet();
  history.push({
    label: 'Engine',
    value: `${MEMORY_ENGINE_FILES.length} archivos en vault/memory/.engine/ · collection=${collectionName}`,
  });

  // ─── Step 4/6: Instalar dependencias aisladas en .engine/ ────────────
  // Corre con cwd=vault/memory/.engine/. El package.json y .npmrc están ahí
  // (copiados en el step anterior). El proyecto host queda intacto.
  renderWizardStep(printMemoryBanner, history, '[4/6] Instalar deps aisladas en vault/memory/.engine/');

  console.log('  ' + dim('Install: ') + cyan('npm install') + dim('  (cwd=vault/memory/.engine/)'));
  console.log('  ' + dim('Deps: @xenova/transformers, @qdrant/js-client-rest, onnxruntime-node'));
  console.log('  ' + dim('  (paquetes incluyen binarios nativos onnxruntime ~50-80 MB)'));

  // Pre-check: si las deps ya estaban instaladas (re-run del wizard, o legacy
  // install en el project root), saltamos.
  const preCheck = await verifyMemoryDepsInstalled();
  let installSummary;

  if (preCheck.ok) {
    console.log('');
    if (preCheck.location === 'project') {
      console.log('  ' + green('✓ Deps detectadas en node_modules/ del proyecto (instalación legacy) — reutilizándolas.'));
      console.log('  ' + dim('    Para migrar al patrón aislado, borrá las deps del package.json del proyecto y reintentá.'));
      installSummary = 'Reutilizando install legacy (project root)';
    } else {
      console.log('  ' + green('✓ Deps ya instaladas en vault/memory/.engine/node_modules/ — saltando install.'));
      installSummary = 'Reutilizando install aislado previo';
    }
  } else {
    // En el install aislado siempre usamos npm — está garantizado con Node,
    // y el .npmrc local fuerza la buena conducta (hoisted, legacy-peer-deps).
    const result = await installMemoryDepsWithRetry('npm');
    if (!result.ok) {
      history.push({ label: 'Dependencias', value: `Falló — faltan: ${result.missing.join(', ')}` });
      renderWizardStep(printMemoryBanner, history, '');
      console.log('  ' + red('✗ No se pudieron instalar las dependencias aisladas.'));
      console.log('');
      console.log('  ' + dim('  Probá manualmente desde el dir aislado:'));
      console.log('    ' + cyan('cd vault/memory/.engine && npm install'));
      console.log('  ' + dim('  Cuando estén instaladas, volvé a entrar a "Memory (RAG)".'));
      await pressEnterToContinue();
      return;
    }
    const flagsApplied = result.usedFlags?.length ? ' ' + result.usedFlags.join(' ') : '';
    installSummary = result.exitCode === 0
      ? `Instalado con npm${flagsApplied} en vault/memory/.engine/`
      : `Instalado (exit ${result.exitCode}, warnings ignorados) en vault/memory/.engine/`;
  }
  history.push({ label: 'Dependencias', value: installSummary });

  // ─── Step 5/6: Preparar Qdrant GLOBAL ───────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[5/6] Preparar Qdrant global en ~/.phobos/');

  const homeResult = await ensurePhobosHome();
  console.log('  ' + dim('~/.phobos/ ') + (homeResult.created ? green('creado') : dim('ya existía')));
  console.log('  ' + dim('docker-compose.qdrant.yml: ') + cyan(QDRANT_COMPOSE_GLOBAL));

  if (qdrant.containerRunning && qdrant.healthy) {
    console.log('  ' + green('✓ Qdrant ya está corriendo — reutilizando instancia global.'));
    history.push({ label: 'Qdrant global', value: 'Ya corriendo, reutilizado' });
  } else {
    console.log('');
    console.log('  ' + dim('Levantando Qdrant global con docker compose...'));
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
      console.log('    ' + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} up -d`));
      console.log('  ' + dim('Después, indexá con:'));
      console.log('    ' + cyan('node vault/memory/.engine/index-vault.mjs'));
      await pressEnterToContinue();
      return;
    }
    history.push({ label: 'Qdrant global', value: 'Levantado en ' + QDRANT_URL });

    console.log(dim('\n  Esperando a que Qdrant esté listo (5s)...'));
    await new Promise(r => setTimeout(r, 5000));
  }

  // ─── Step 6/6: Indexación inicial ───────────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[6/6] Indexación inicial del vault');

  rl.pause();
  const indexCode = await runChild(
    'node',
    ['vault/memory/.engine/index-vault.mjs'],
    'index-vault.mjs (full)',
  );
  if (indexCode !== 0) {
    history.push({ label: 'Indexación', value: 'Falló — corré manualmente cuando puedas' });
  } else {
    history.push({ label: 'Indexación', value: `Vault indexado en collection ${collectionName}` });
  }

  // ─── Pantalla final ─────────────────────────────────────────────────
  renderWizardStep(printMemoryBanner, history, '');
  console.log('  ' + green('Memory engine instalado y conectado a Qdrant global.'));
  console.log('');
  console.log('  ' + dim('Tu collection en Qdrant: ') + cyan(collectionName));
  console.log('  ' + dim('Otros proyectos con Phobos van a tener su propia collection en la misma instancia.'));
  console.log('');
  console.log('  ' + dim('Comandos útiles:'));
  console.log('    ' + cyan('node vault/memory/.engine/search.mjs "<query>"'));
  console.log('    ' + cyan('node vault/memory/.engine/index-vault.mjs --incremental'));
  console.log('    ' + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} down`) + dim('  (parar Qdrant global)'));
  console.log('    ' + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} up -d`) + dim('  (levantar Qdrant global)'));
  console.log('');
  console.log('  ' + dim('Dashboard Qdrant: ') + cyan('http://localhost:6333/dashboard'));
  await pressEnterToContinue();
}

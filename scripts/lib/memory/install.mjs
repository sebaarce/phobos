// Wizard de instalación de Memory.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TEMPLATES_DIR, rl } from '../runtime.mjs';
import { cyan, dim, yellow, red, green, bold } from '../colors.mjs';
import { tuiSelect, tuiYesNo } from '../tui.mjs';
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
  readPackageJson,
  detectPackageManager,
  detectProblematicStack,
  checkNpmrcHasLegacyPeerDeps,
  addLegacyPeerDepsToNpmrc,
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
  renderWizardStep(printMemoryBanner, history, '[1/6] Verificar prerequisitos');

  const dockerOK = checkCommand('docker');
  const nodeOK = checkCommand('node');
  const pkg = await readPackageJson();

  console.log('  ' + (dockerOK ? green('✓') : red('✗')) + ' docker');
  console.log('  ' + (nodeOK ? green('✓') : red('✗')) + ' node');
  console.log('  ' + (pkg ? green('✓') : red('✗')) + ' package.json (proyecto Node)');

  if (!dockerOK || !nodeOK || !pkg) {
    console.log('');
    if (!dockerOK) console.log('  ' + yellow('Docker es necesario para correr Qdrant local. Instalalo desde docker.com/get-started'));
    if (!nodeOK) console.log('  ' + yellow('Node es necesario para el engine de embeddings.'));
    if (!pkg) console.log('  ' + yellow('El proyecto destino debe tener package.json (Node/TS). Memory no aplica a otros stacks.'));
    history.push({ label: 'Prerequisitos', value: 'Faltantes — wizard cancelado' });
    renderWizardStep(printMemoryBanner, history, '');
    console.log('  ' + yellow('No se puede continuar. Resolvé los prerequisitos y reintentá.'));
    await pressEnterToContinue();
    return;
  }

  history.push({ label: 'Prerequisitos', value: 'docker ✓, node ✓, package.json ✓' });

  // ─── Step 2/6: Detección de Qdrant global + package manager ─────────
  renderWizardStep(printMemoryBanner, history, '[2/6] Detectar Qdrant global y package manager');

  const qdrant = await detectQdrantStatus();
  const pm = await detectPackageManager();

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
  const problemStacks = await detectProblematicStack();
  const npmrcHasFlag = await checkNpmrcHasLegacyPeerDeps();

  console.log('  ' + dim('Qdrant global: ') + (
    qdrant.containerRunning && qdrant.healthy ? green('✓ corriendo y healthy en ' + QDRANT_URL)
    : qdrant.containerRunning ? yellow('⚠ contenedor up pero sin responder a /healthz aún')
    : dim('— no está corriendo (se levantará en el paso 5)')
  ));
  console.log('  ' + dim('Package manager: ') + cyan(pm));
  console.log('  ' + dim('Stack detectado: ')
    + (problemStacks.length > 0
        ? yellow(problemStacks.join(', ') + ' — suele requerir --legacy-peer-deps')
        : dim('sin stacks con issues conocidos de peer-deps')));
  if (problemStacks.length > 0 && npmrcHasFlag) {
    console.log('  ' + dim('  .npmrc del proyecto ya tiene ') + green('legacy-peer-deps=true') + dim(' ✓'));
  }
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
    value: `Qdrant ${qdrant.healthy ? 'corriendo' : 'no corriendo'} · pm=${pm} · agentes ${agentsReady ? 'OK' : 'outdated'}`,
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

  // ─── Step 3/6: Instalar dependencias npm ────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[3/6] Instalar dependencias del proyecto');

  const depsRaw = await readFile(join(TEMPLATES_DIR, 'phobos/memory/package-deps.json'), 'utf-8');
  const depsJson = JSON.parse(depsRaw);
  const depList = Object.entries(depsJson.dependencies).map(([n, v]) => `${n}@${v}`);
  console.log('  Instalando: ' + cyan(depList.join(', ')));
  console.log(dim('  (paquetes incluyen binarios nativos onnxruntime ~50-80 MB)'));

  // Pre-check: si las deps ya estaban instaladas (re-run del wizard), saltamos
  const preCheck = await verifyMemoryDepsInstalled();
  let installSummary;
  let usedLegacyPeerDeps = false;

  if (preCheck.ok) {
    console.log('');
    console.log('  ' + green('✓ Ambos paquetes ya están en node_modules — salteando install.'));
    installSummary = `Ya instalados (reusados de instalación previa)`;
  } else {
    // Si detectamos stack problemático + npm + sin flag persistida → preguntar
    // si arrancar el install con --legacy-peer-deps desde el primer intento.
    let initialFlags = [];
    if (problemStacks.length > 0 && pm === 'npm' && !npmrcHasFlag) {
      console.log('');
      console.log('  ' + yellow('⚠ Detecté ') + bold(problemStacks.join(', '))
        + yellow(' en el proyecto.'));
      console.log('  ' + dim('   Estos stacks suelen tener conflictos de peer dependencies (ERESOLVE)'));
      console.log('  ' + dim('   en NPM v7+. La flag ') + cyan('--legacy-peer-deps')
        + dim(' soluciona esto sin tocar tu árbol de deps.'));
      console.log('');

      const stackChoice = await tuiSelect(
        '¿Cómo arrancar el install?',
        [
          'npm install ' + green('--legacy-peer-deps') + dim('  (recomendado para ' + problemStacks[0] + ')'),
          'npm install (sin flags — puede fallar si hay conflictos preexistentes)',
        ],
        0,
      );
      if (stackChoice.index === 0) {
        initialFlags = ['--legacy-peer-deps'];
        usedLegacyPeerDeps = true;
      }
    } else if (npmrcHasFlag) {
      // El .npmrc ya tiene la flag — npm la va a aplicar automáticamente
      usedLegacyPeerDeps = true;
    }

    const result = await installMemoryDepsWithRetry(pm, depList, initialFlags);
    if (!result.ok) {
      history.push({ label: 'Dependencias', value: `Falló — faltan: ${result.missing.join(', ')}` });
      renderWizardStep(printMemoryBanner, history, '');
      console.log('  ' + red('✗ No se pudieron instalar las dependencias.'));
      console.log('');
      console.log('  ' + dim('  Probá manualmente:'));
      console.log('    ' + cyan(`${pm} ${pm === 'npm' ? 'install' : 'add'} ${depList.join(' ')}${problemStacks.length > 0 ? ' --legacy-peer-deps' : ''}`));
      console.log('  ' + dim('  Cuando estén instaladas, volvé a entrar a "Memory (RAG)".'));
      await pressEnterToContinue();
      return;
    }
    // Detectar si el install terminó usando --legacy-peer-deps (por initialFlags
    // o porque el usuario la eligió en el retry menu)
    if (result.usedFlags && result.usedFlags.includes('--legacy-peer-deps')) {
      usedLegacyPeerDeps = true;
    }
    const flagsApplied = result.usedFlags?.length ? ' ' + result.usedFlags.join(' ') : '';
    const pmApplied = result.usedPm || pm;
    installSummary = result.exitCode === 0
      ? `${depList.length} paquetes instalados con ${pmApplied}${flagsApplied}`
      : `${depList.length} paquetes instalados (exit ${result.exitCode}, warnings ignorados)`;
  }
  history.push({ label: 'Dependencias', value: installSummary });

  // Si usamos --legacy-peer-deps (manual o desde retry) y .npmrc no lo tiene,
  // ofrecer persistirla para que futuros installs no fallen.
  if (usedLegacyPeerDeps && !npmrcHasFlag && pm === 'npm') {
    console.log('');
    console.log('  ' + dim('Tu instalación necesitó ') + cyan('--legacy-peer-deps') + dim('.'));
    console.log('  ' + dim('Para que futuros ') + cyan('npm install') + dim(' no fallen por el mismo motivo,'));
    console.log('  ' + dim('te conviene persistir la flag en el ') + cyan('.npmrc') + dim(' del proyecto.'));
    console.log('');
    const persist = await tuiYesNo(
      `¿Agregar ${cyan('legacy-peer-deps=true')} al ${cyan('.npmrc')} del proyecto?`,
      true,
    );
    if (persist) {
      const r = await addLegacyPeerDepsToNpmrc();
      if (r.added) {
        console.log('  ' + green('✓ .npmrc actualizado'));
        history.push({ label: '.npmrc', value: 'legacy-peer-deps=true agregado al .npmrc' });
      } else {
        console.log('  ' + dim('  · .npmrc ya tenía la flag — no se modificó'));
      }
    } else {
      console.log('  ' + dim('  · saltado. Vas a tener que pasar --legacy-peer-deps en futuros installs.'));
    }
  }

  // ─── Step 4/6: Copiar engine al proyecto ────────────────────────────
  renderWizardStep(printMemoryBanner, history, '[4/6] Copiar engine al proyecto');

  await copyMemoryEngineToProject(collectionName);
  await appendGitignoreSnippet();
  history.push({
    label: 'Engine',
    value: `${MEMORY_ENGINE_FILES.length} archivos en vault/memory/.engine/ · collection=${collectionName}`,
  });

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

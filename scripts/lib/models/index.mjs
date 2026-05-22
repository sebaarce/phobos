// Models — entry points del wizard + orchestration del flow.
//
// Responsabilidades:
//   - actionSetModels: el wizard interactivo (4 steps) que el usuario llama
//     desde el menú principal.
//   - actionViewModels: read-only view del estado actual.
//   - chooseMode: el step 3/4 — Auto / Uniform / Custom (con provider menu
//     + multi-IDE "mantener actual").
//   - applyChanges: persistencia + backup post-confirm.
//
// Importa la data layer de catalog.mjs y los componentes de ui.mjs. El módulo
// `scripts/lib/models.mjs` (shim) re-exporta de acá para preservar la API
// pública que phobos.mjs consume.

import { resolve as resolvePath } from 'node:path';
import { cwd } from 'node:process';
import { AGENTS, AGENT_PROFILES } from '../runtime.mjs';
import { green, yellow, cyan, dim, bold, pad } from '../colors.mjs';
import { tuiSelect, tuiYesNo, clearScreen, panel } from '../tui.mjs';
import { printModelsBanner, renderWizardStep } from '../banners.mjs';
import { pressEnterToContinue } from '../exit.mjs';
import { backupAgents } from '../update.mjs';

import {
  getProvider,
  recommendForAgent,
  detect,
  summarizeDetection,
  getFinalModelList,
  readCurrentModels,
  writeModel,
} from './catalog.mjs';

import {
  showCurrentStatus,
  agentHeaderBlock,
  pickFromList,
  renderSuggestionPanel,
  printDiff,
} from './ui.mjs';

// Re-exports para back-compat — phobos.mjs solo usa actionSetModels +
// actionViewModels, pero exponemos lo que tradicionalmente vivía en models.mjs
// por si alguien más lo consume en el futuro.
export {
  getProvider,
  recommendForAgent,
  detect,
  summarizeDetection,
  getFinalModelList,
  readCurrentModels,
  writeModel,
} from './catalog.mjs';
export { groupByProvider, PROFILE_WEIGHTS, PROVIDER_PREFERENCES } from './catalog.mjs';
export { showCurrentStatus, agentHeaderBlock, pickFromList, renderSuggestionPanel, printDiff } from './ui.mjs';

// ═══════════════════════════════════════════════════════════════════
// chooseMode — Step 3/4 del wizard (Auto / Uniform / Custom)
// ═══════════════════════════════════════════════════════════════════

// chooseMode recibe `history` mutable: cada sub-decisión agrega una línea
// al historial superior y limpia la pantalla en el siguiente sub-step.
export async function chooseMode(history, allModels, current, adapter = null) {
  const detectedProviders = Array.from(new Set(allModels.map(m => getProvider(m)))).sort();
  const hasMultipleProviders = detectedProviders.length > 1;

  // Helper: si ya existe una entry con ese label, la reemplaza; si no, la agrega.
  function setHistoryEntry(label, value) {
    const existing = history.findIndex(h => h.label === label);
    if (existing >= 0) history[existing] = { label, value };
    else history.push({ label, value });
  }

  // ─── Sub-step 3a: mostrar sugerencia cross-provider + elegir estrategia ───
  //
  // Estrategia ANTES de provider: el scope tiene sentido recién cuando sabemos
  // si el usuario va a usar Auto/Uniform (un único scope) o Custom (un scope
  // distinto por agente). Preguntar provider primero gastaba un click cuando
  // el usuario elegía Custom.
  renderWizardStep(printModelsBanner, history, '[3/4] Asignar modelo · elegir estrategia');

  // Sugerencias cross-provider — usadas internamente por Custom para el
  // "modelo sugerido" del header de cada agente. NO se muestran al elegir
  // estrategia; el panel solo aparece después de elegir Auto + provider.
  const recommendedCross = Object.fromEntries(
    AGENTS.map(a => [a, recommendForAgent(a, allModels, adapter)])
  );

  // Label del modo Custom: si solo hay 1 provider (típico de Claude Code),
  // el sufijo "multi-provider" confunde. Lo adaptamos al caso real.
  const customLabel = hasMultipleProviders
    ? 'Custom — agente por agente (multi-provider)'
    : 'Custom — un modelo por agente';

  const { index } = await tuiSelect(
    '\n¿Cómo asignamos los modelos?',
    [
      'Aplicar la sugerencia automática',
      'Asignar el MISMO modelo a todos (preset uniforme)',
      customLabel,
      'Cancelar y salir',
    ],
    0,
  );

  // Helper: cuando una estrategia requiere un provider único (Auto/Uniform)
  // y hay múltiples detectados, este sub-step lo pregunta. Devuelve el
  // provider elegido o null si el usuario canceló con Esc.
  async function askProvider(stepLabel) {
    if (!hasMultipleProviders) {
      const only = detectedProviders[0];
      const count = allModels.filter(m => getProvider(m) === only).length;
      setHistoryEntry('Provider', `${only} (${count} modelos) — único disponible`);
      return only;
    }
    renderWizardStep(printModelsBanner, history, stepLabel);
    const providerOptions = detectedProviders.map(p => {
      const count = allModels.filter(m => getProvider(m) === p).length;
      return `${p} (${count} modelos)`;
    });
    const { index: provIdx } = await tuiSelect(
      '\n¿Qué proveedor usamos?',
      providerOptions,
      0,
    );
    const chosen = detectedProviders[provIdx];
    const count = allModels.filter(m => getProvider(m) === chosen).length;
    setHistoryEntry('Provider', `${chosen} (${count} modelos)`);
    return chosen;
  }

  // ─── Auto ──────────────────────────────────────────────────────────
  if (index === 0) {
    setHistoryEntry('Estrategia', 'Aplicar sugerencia automática');
    const provider = await askProvider('[3/4] Asignar modelo · scope para la sugerencia');
    if (!provider) return null;
    const modelsScope = allModels.filter(m => getProvider(m) === provider);

    // Recomendaciones scopeadas al provider elegido — si para algún rol no
    // hay match en ese scope, caemos al cross-provider de fallback.
    const suggestion = Object.fromEntries(
      AGENTS.map(a => [a, recommendForAgent(a, modelsScope, adapter) || recommendedCross[a]])
    );

    // Recién acá mostramos el panel — el usuario ya eligió Auto y eligió
    // provider, así que la sugerencia es concreta y scopeada.
    renderWizardStep(printModelsBanner, history, '[3/4] Asignar modelo · sugerencia para ' + provider);
    console.log('');
    renderSuggestionPanel(suggestion, current);

    const apply = await tuiYesNo('\n¿Aplicar esta sugerencia?', true);
    if (!apply) {
      // El usuario vio la sugerencia y no le convenció — devolvemos null
      // para cancelar el wizard. Puede volver a entrar y elegir otra
      // estrategia (Custom o Uniform).
      setHistoryEntry('Estrategia', 'Aplicar sugerencia automática — descartada por el usuario');
      return null;
    }
    return suggestion;
  }

  // ─── Uniform ───────────────────────────────────────────────────────
  if (index === 1) {
    setHistoryEntry('Estrategia', 'Mismo modelo para TODOS los agentes');
    const provider = await askProvider('[3/4] Asignar modelo · scope del preset uniforme');
    if (!provider) return null;
    const modelsScope = allModels.filter(m => getProvider(m) === provider);
    renderWizardStep(printModelsBanner, history, '[3/4] Asignar modelo · elegir modelo uniforme');
    const uniformPrompt = '  ' + bold(cyan('Modelo para TODOS los agentes')) + '\n   ' + dim('actual:  ' + current.phobos);
    const m = await pickFromList(modelsScope, uniformPrompt, current.phobos);
    setHistoryEntry('Modelo uniforme', m);
    return Object.fromEntries(AGENTS.map(a => [a, m]));
  }

  // ─── Custom (multi-provider, agente por agente) ────────────────────
  if (index === 2) {
    setHistoryEntry('Estrategia', 'Custom — agente por agente (multi-provider)');
    const target = {};
    // Sticky default: el provider elegido para el agente anterior queda
    // pre-seleccionado para el siguiente; ahorra clicks si reutilizás el
    // mismo provider en varios agentes seguidos.
    let stickyProvider = detectedProviders[0];

    for (let i = 0; i < AGENTS.length; i++) {
      const agent = AGENTS[i];

      // Screen limpio por agente: solo banner + wizard history previa.
      // Las elecciones per-agent NO se acumulan en la history (para que
      // siempre veas únicamente el agente N/6 actual).
      renderWizardStep(
        printModelsBanner,
        history,
        `[3/4] Asignar modelo · agente ${i + 1}/${AGENTS.length}: ${agent}`,
      );

      const headerBlock = agentHeaderBlock(
        i, AGENTS.length, agent,
        AGENT_PROFILES[agent].role,
        current[agent],
        recommendedCross[agent],
      );
      console.log(headerBlock);

      // Sub-pregunta 1: ¿qué provider para este agente?
      // Agregamos "Mantener actual" como última opción para que el user
      // pueda saltar el config de UN agente sin tener que elegir provider+modelo
      // (que es 2 clicks para terminar en el mismo modelo). Útil en custom mode
      // cuando solo querés cambiar 2 de 6 agentes.
      let scopedModels = allModels;
      let keptCurrent = false;
      if (hasMultipleProviders) {
        const providerOptions = detectedProviders.map(p => {
          const count = allModels.filter(m => getProvider(m) === p).length;
          return `${p} (${count} modelos)`;
        });
        // "Mantener actual" — siempre como última opción.
        const keepLabel = current[agent]
          ? `Mantener actual ${dim('(' + current[agent] + ')')}`
          : `Mantener actual ${dim('(sin modelo previo)')}`;
        providerOptions.push(keepLabel);
        const keepIdx = providerOptions.length - 1;

        // Default: provider del modelo actual del agente, si no, el sticky.
        const currentProviderForAgent = getProvider(current[agent] || '');
        let defaultIdx = detectedProviders.indexOf(currentProviderForAgent);
        if (defaultIdx < 0) defaultIdx = detectedProviders.indexOf(stickyProvider);
        if (defaultIdx < 0) defaultIdx = 0;

        const { index: provIdx } = await tuiSelect(
          '\n¿Qué provider para este agente?',
          providerOptions,
          defaultIdx,
        );

        if (provIdx === keepIdx) {
          // Usuario eligió "Mantener actual" — skip provider + model picker.
          target[agent] = current[agent];
          keptCurrent = true;
        } else {
          const chosenProvider = detectedProviders[provIdx];
          scopedModels = allModels.filter(m => getProvider(m) === chosenProvider);
          stickyProvider = chosenProvider;
        }
      }

      // Sub-pregunta 2: ¿qué modelo dentro del provider elegido?
      // Skip si el user ya eligió "Mantener actual" arriba.
      if (!keptCurrent) {
        target[agent] = await pickFromList(scopedModels, `\nElegí modelo para @${agent}:`, current[agent]);
      }
    }

    // Resumen del provider final — refleja si quedó mono o mixto.
    const finalProviders = new Set(AGENTS.map(a => getProvider(target[a])));
    if (finalProviders.size === 1) {
      setHistoryEntry('Provider', `${[...finalProviders][0]} (todos los agentes)`);
    } else {
      setHistoryEntry('Provider', `${finalProviders.size} providers (mixto)`);
    }
    return target;
  }

  // index === 3 → "Cancelar y salir"
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// applyChanges — persistir el target, con backup previo
// ═══════════════════════════════════════════════════════════════════

export async function applyChanges(agentDir, current, target, adapter = null) {
  // Determinar primero qué agentes efectivamente cambian — backup-eamos solo
  // esos para evitar copias inútiles y mantener el directorio de backup limpio.
  const agentsToChange = AGENTS.filter(a => current[a] !== target[a]);

  if (agentsToChange.length === 0) {
    console.log(dim('\n  ⊘ No hay cambios para aplicar.'));
    return { changed: 0, backup: null };
  }

  // Backup silencioso pre-escritura. Reusa el helper de update.mjs para
  // mantener un solo formato de backup independientemente del wizard que lo
  // dispare. Paths derivados del adapter (default: OpenCode para compat).
  const agentRel = adapter ? adapter.agentDir : '.opencode/agent';
  const backupBase = adapter && typeof adapter.backupBaseDir === 'function'
    ? adapter.backupBaseDir()
    : '.opencode/agent_backup/phobos';
  const filesToBackup = agentsToChange.map(a => `${agentRel}/${a}.md`);
  const backup = await backupAgents(filesToBackup, backupBase);

  let changed = 0;
  for (const agent of agentsToChange) {
    try {
      await writeModel(agentDir, agent, target[agent]);
      changed++;
    } catch (err) {
      console.error(`  ${yellow('✗')} ${agent}: ${err.message}`);
    }
  }
  console.log(green(`\n✓ ${changed} agente(s) actualizado(s).`));
  if (changed > 0) {
    const ideName = adapter && adapter.displayName ? adapter.displayName : 'el IDE';
    console.log(dim(`\nSi ${ideName} está abierto, cambiá de agente (Tab) y volvé para recargar.`));
  }
  return { changed, backup };
}

// ═══════════════════════════════════════════════════════════════════
// actionSetModels — entry point del wizard interactivo (4 steps)
// ═══════════════════════════════════════════════════════════════════

// Recibe el adapter del IDE activo. Deriva el agentDir internamente del
// adapter — el resto del flow es target-agnostic (lee modelos, escribe a
// los .md, hace backup).
export async function actionSetModels(adapter) {
  if (!adapter) throw new Error('actionSetModels requires an adapter (IDEAdapter instance).');
  const agentDir = resolvePath(cwd(), adapter.agentDir);
  // El historial siempre arranca con qué IDE estamos configurando — es la
  // ÚNICA forma que tiene el usuario de saber "estoy modificando .claude o
  // .opencode" sin volver al menú principal.
  const history = [
    { label: 'IDE', value: `${adapter.displayName}  ·  ${adapter.agentDir}/` },
  ];

  // ─── Step 1/4: Detectar providers ──────────────────────────────────
  renderWizardStep(printModelsBanner, history, '[1/4] Detectando providers conectados...');
  const detected = await adapter.listAvailableModels();

  if (detected.providers.size === 0) {
    const help = adapter.noProvidersHelp();
    console.log('  ' + yellow('✗ ' + (help[0] || `No detecté proveedores para ${adapter.displayName}.`)));
    console.log('');
    for (const line of help.slice(1)) {
      console.log('  ' + (line === '' ? '' : dim(line)));
    }
    console.log('');
    await pressEnterToContinue();
    return;
  }

  summarizeDetection(detected);
  history.push({
    label: 'Detección',
    value: `${detected.providers.size} provider${detected.providers.size > 1 ? 's' : ''}, ${detected.models.size} modelos`,
  });

  // ─── Step 2/4: Definir lista de modelos a asignar ──────────────────
  renderWizardStep(printModelsBanner, history, '[2/4] Definir lista de modelos a asignar');
  const allModels = await getFinalModelList(detected, adapter);
  if (!allModels || allModels.length === 0) {
    console.log('\n  ' + yellow('Lista vacía — no se puede continuar.'));
    await pressEnterToContinue();
    return;
  }
  history.push({
    label: 'Lista de modelos',
    value: `${allModels.length} modelo${allModels.length > 1 ? 's' : ''} disponibles`,
  });

  // ─── Step 3/4: Asignar modelo a cada agente ────────────────────────
  //   (chooseMode hace su propio renderWizardStep antes de cada sub-pregunta
  //    y va agregando entries al historial: Provider, Estrategia, y por agente
  //    si se eligió custom)
  const current = await readCurrentModels(agentDir);
  const target = await chooseMode(history, allModels, current, adapter);
  if (!target) {
    history.push({ label: 'Asignación', value: 'Cancelado por el usuario' });
    renderWizardStep(printModelsBanner, history, '');
    console.log('  ' + yellow('Wizard cancelado — sin cambios aplicados.'));
    await pressEnterToContinue();
    return;
  }
  const agentsToChange = AGENTS.filter(a => current[a] !== target[a]);

  // ─── Step 4/4: Aplicar cambios ─────────────────────────────────────
  renderWizardStep(printModelsBanner, history, '[4/4] Aplicar cambios');
  const hasChanges = printDiff(current, target);

  let applyResult = null;
  if (hasChanges) {
    const confirm = await tuiYesNo('\n¿Aplicar los cambios?', false);
    if (confirm) {
      applyResult = await applyChanges(agentDir, current, target, adapter);
      history.push({
        label: 'Aplicado',
        value: `${agentsToChange.length} cambio${agentsToChange.length > 1 ? 's' : ''} persistido${agentsToChange.length > 1 ? 's' : ''} en ${adapter.agentDir}/`,
      });
      if (applyResult?.backup?.backupRel) {
        history.push({
          label: 'Backup',
          value: `${applyResult.backup.count} archivo${applyResult.backup.count > 1 ? 's' : ''} en ${applyResult.backup.backupRel}/`,
        });
      }
    } else {
      history.push({ label: 'Aplicado', value: 'Cancelado por el usuario, ningún archivo modificado' });
    }
  } else {
    console.log('\n  ' + dim('✓ Los modelos ya están configurados — no hay cambios que aplicar.'));
    history.push({ label: 'Aplicado', value: 'Sin cambios (ya estaba al día)' });
  }

  // ─── Pantalla final con resumen completo ───────────────────────────
  renderWizardStep(printModelsBanner, history, '');
  console.log('  ' + green('Wizard completado.'));
  if (applyResult?.backup?.backupRel) {
    console.log('');
    console.log('  ' + dim('↺ Backup previo de los archivos modificados:'));
    console.log('    ' + cyan(applyResult.backup.backupRel + '/'));
    console.log('  ' + dim('  Si querés revertir un cambio: ') + dim(`copiá el archivo desde ese directorio al ${adapter.agentDir}/.`));
  }
  await pressEnterToContinue();
}

// ═══════════════════════════════════════════════════════════════════
// actionViewModels — vista read-only del estado actual
// ═══════════════════════════════════════════════════════════════════

// Acción read-only del menú principal: imprime el estado actual de cada
// agente sin modificar nada. Útil para diagnosticar configuraciones antes
// de tocarlas, ver qué provider domina, o auditar después de un cambio.
export async function actionViewModels(adapter) {
  if (!adapter) throw new Error('actionViewModels requires an adapter (IDEAdapter instance).');
  const agentDir = resolvePath(cwd(), adapter.agentDir);
  clearScreen();
  printModelsBanner();
  console.log('');

  const current = await readCurrentModels(agentDir);

  // Tabla agente → rol → modelo (reusa el renderer del wizard).
  showCurrentStatus(current);

  // Distribución por provider — útil para detectar "está todo en un solo
  // proveedor" vs "está mezclado" sin tener que escanear visualmente.
  const byProvider = {};
  for (const agent of AGENTS) {
    const model = current[agent] || '(no detectado)';
    const provider = getProvider(model);
    if (!byProvider[provider]) byProvider[provider] = [];
    byProvider[provider].push(agent);
  }

  const providerEntries = Object.entries(byProvider).sort();
  const wProvider = Math.max(...providerEntries.map(([p]) => p.length));
  const providerLines = providerEntries.map(([p, agents]) =>
    cyan(' ▸ ') + bold(pad(p, wProvider)) + dim('   →   ') + agents.join(', ')
  );

  console.log('');
  panel('Distribución por provider', providerLines);

  // Cantidad total de agentes por estado.
  const total = AGENTS.length;
  const configured = AGENTS.filter(a => current[a] && !current[a].startsWith('(')).length;
  const unconfigured = total - configured;

  console.log('');
  console.log('  ' + dim(`${configured}/${total} agentes con modelo configurado`)
    + (unconfigured > 0 ? '  ' + yellow(`(${unconfigured} sin detectar)`) : ''));

  console.log('');
  console.log(dim('  Para cambiar modelos: menú principal → "Setear modelos de agentes".'));
  console.log('');

  await pressEnterToContinue();
}

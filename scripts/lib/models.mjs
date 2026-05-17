// Modelos — detección, asignación, picker, diff y apply.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stdin, stdout, exit, platform, env, cwd } from 'node:process';
import { AGENTS, AGENT_PROFILES, rl } from './runtime.mjs';
import { fileExists, tryExec } from './fs-utils.mjs';
import { green, yellow, cyan, red, dim, bold, pad } from './colors.mjs';
import { panel, tuiSelect, tuiYesNo } from './tui.mjs';
import { printModelsBanner, renderWizardStep } from './banners.mjs';
import { pressEnterToContinue } from './exit.mjs';

function parseModelsList(output) {
  return output.split('\n')
    .map(l => l.trim())
    .filter(l => l && /^[a-z][a-z0-9_-]*\/[a-z0-9._-]+$/i.test(l));
}

export function getProvider(id) {
  const slash = id.indexOf('/');
  return slash >= 0 ? id.substring(0, slash) : '(sin provider)';
}

export function groupByProvider(models) {
  const groups = {};
  for (const id of models) {
    const p = getProvider(id);
    if (!groups[p]) groups[p] = [];
    groups[p].push(id);
  }
  for (const p of Object.keys(groups)) groups[p].sort();
  return groups;
}

// Clasificación heurística — tiers MUTUAMENTE EXCLUYENTES (un modelo es top, mid, low, o code).
// El orden de evaluación importa: primero top, después code, después low, finalmente mid como default.
function classifyModel(id) {
  const tags = new Set();
  // Trabajar con la parte después del / (sin provider) para que las regex sean simples
  const name = id.toLowerCase().includes('/')
    ? id.toLowerCase().split('/').slice(1).join('/')
    : id.toLowerCase();

  // Top tier — modelos más capaces
  if (/opus|big-pickle/.test(name)) tags.add('top');
  else if (/-pro($|-)/.test(name)) tags.add('top');
  else if (/^gpt-?5\.5/.test(name)) tags.add('top');

  // Code tier — especialización en código
  if (/codex|grok-code/.test(name)) tags.add('code');

  // Low tier — barato y rápido
  if (/haiku|nano|mini|flash|small|free|light/.test(name)) tags.add('low');

  // Mid tier — base balanced (solo si NO es top/code/low)
  if (!tags.has('top') && !tags.has('code') && !tags.has('low')) {
    if (/sonnet|^gpt-?5(?:$|\.\d|\b)|^gpt-?4\.1|^gpt-?4o(?!-mini)|gemini[-.\d]+pro/.test(name)) {
      tags.add('mid');
    }
  }

  // Familia conocida — para preferir sobre modelos misteriosos
  if (/claude|sonnet|opus|haiku|gpt|gemini/.test(name)) tags.add('known');

  return tags;
}

// Cada agente tiene weights explícitos por tag. Más claro que prefer-order.
export const PROFILE_WEIGHTS = {
  phobos:     { top: 100, mid:  60, low: -40, known: 15 },
  planner:    { top: 100, mid:  30, low: -40, known: 15 },
  programmer: { code: 100, mid:  60, top:  30, known: 15 },
  researcher: { low: 100, mid:  40, top: -40, code: 10, known: 15 },
  tester:     { low: 100, mid:  20, top: -50, known: 15 },
  archivist:  { mid: 100, top:  60, low: -40, known: 15 },
};

function scoreModel(agent, modelId) {
  const tags = classifyModel(modelId);
  const weights = PROFILE_WEIGHTS[agent] || {};
  let score = 0;
  for (const [tag, w] of Object.entries(weights)) {
    if (tags.has(tag)) score += w;
  }
  // Penalización suave para modelos sin family conocida (evita picks raros tipo "big-pickle")
  if (!tags.has('known')) score -= 20;
  return score;
}

export function recommendForAgent(agent, allModels) {
  let best = null;
  let bestScore = -Infinity;
  for (const id of allModels) {
    const s = scoreModel(agent, id);
    // Tie-breaker: ante igual score, preferí el ID lex-mayor (típicamente versión más nueva)
    if (s > bestScore || (s === bestScore && best !== null && id > best)) {
      bestScore = s;
      best = id;
    }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════════
// Detección
// ═══════════════════════════════════════════════════════════════════

export async function detect() {
  const detected = { models: new Map(), providers: new Set(), notes: [] };

  const v = tryExec('opencode --version', 8000);
  if (!v.ok) {
    console.log('');
    console.log('  ' + yellow('✗ No detecté el CLI de OpenCode en tu PATH.'));
    console.log('');
    console.log('  ' + dim('phobos necesita el CLI de OpenCode para'));
    console.log('  ' + dim('descubrir providers y modelos disponibles.'));
    console.log('');
    console.log('  Instalá OpenCode y volvé a correr:  ' + cyan('npx github:sebaarce/phobos'));
    console.log('  ' + dim('→ ') + cyan('https://opencode.ai'));
    console.log('');
    rl.close();
    exit(1);
  }

  // Auth file → providers (lectura silenciosa, no exponemos el path)
  const authPaths = [
    join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
    join(homedir(), '.config', 'opencode', 'auth.json'),
    platform === 'win32' && env.APPDATA ? join(env.APPDATA, 'opencode', 'auth.json') : null,
    platform === 'win32' && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'opencode', 'auth.json') : null,
  ].filter(Boolean);

  for (const path of authPaths) {
    if (await fileExists(path)) {
      try {
        const data = JSON.parse(await readFile(path, 'utf-8'));
        const providers = Object.keys(data || {});
        for (const p of providers) detected.providers.add(p);
      } catch {
        // silencioso — si falla, seguimos con lo que tengamos
      }
    }
  }

  // opencode models — listado canónico (silencioso)
  const allR = tryExec('opencode models', 20000);
  if (allR.ok && allR.out) {
    const ids = parseModelsList(allR.out);
    for (const id of ids) {
      detected.models.set(id, 'opencode models');
      detected.providers.add(getProvider(id));
    }
  } else {
    detected.notes.push('opencode models no devolvió nada — posible problema de auth');
  }

  // opencode models <provider> — por si algún provider tiene modelos no incluidos en el default
  for (const provider of detected.providers) {
    const r = tryExec(`opencode models ${provider}`, 12000);
    if (r.ok && r.out) {
      const ids = parseModelsList(r.out);
      for (const id of ids) {
        if (!detected.models.has(id)) {
          detected.models.set(id, `opencode models ${provider}`);
        }
      }
    }
  }

  return detected;
}

// ═══════════════════════════════════════════════════════════════════
// Lectura/escritura de agentes
// ═══════════════════════════════════════════════════════════════════

export async function readCurrentModels(agentDir) {
  const result = {};
  for (const agent of AGENTS) {
    const filepath = join(agentDir, `${agent}.md`);
    try {
      const content = await readFile(filepath, 'utf-8');
      const match = content.match(/^model:\s*(.+)$/m);
      result[agent] = match ? match[1].trim() : '(no detectado)';
    } catch (err) {
      result[agent] = `(error: ${err.code || err.message})`;
    }
  }
  return result;
}

export async function writeModel(agentDir, agent, newModel) {
  const filepath = join(agentDir, `${agent}.md`);
  const content = await readFile(filepath, 'utf-8');
  if (!/^model:\s*.+$/m.test(content)) {
    throw new Error(`No encontré línea 'model:' en ${filepath}`);
  }
  const updated = content.replace(/^model:\s*.+$/m, `model: ${newModel}`);
  await writeFile(filepath, updated);
}

// ═══════════════════════════════════════════════════════════════════
// UI — resumen, paste manual, picker con filtros
// ═══════════════════════════════════════════════════════════════════

export function summarizeDetection(detected) {
  if (detected.models.size === 0) {
    console.log(yellow('\n  ⚠ No se detectaron modelos.\n'));
    if (detected.notes.length > 0) {
      for (const n of detected.notes) console.log(dim('  · ' + n));
    }
    return;
  }

  const grouped = groupByProvider(Array.from(detected.models.keys()));
  const providers = Object.entries(grouped).sort();
  const wProvider = Math.max(...providers.map(([p]) => p.length));

  const lines = [
    bold('Providers conectados'),
    ...providers.map(([provider, ids]) =>
      cyan(' ▸ ') + pad(provider, wProvider) + '    ' + green(ids.length + ' modelos')
    ),
    '',
    bold('Total disponible') + '    ' + bold(green(detected.models.size + ' modelos')),
  ];

  console.log('');
  panel('Detección', lines);

  if (detected.notes.length > 0) {
    console.log(dim('\n  Notas:'));
    for (const n of detected.notes) console.log(dim('    · ' + n));
  }
}

export async function getFinalModelList(detected) {
  let list = Array.from(detected.models.keys());

  if (list.length === 0) {
    console.log(yellow('\n⚠ No se detectaron modelos automáticamente.'));
    console.log('  Pegá los IDs disponibles, uno por línea (desde el selector de OpenCode).');
    console.log(dim('  Línea vacía + ENTER para terminar.\n'));
    while (true) {
      const line = (await rl.question('  > ')).trim();
      if (!line) break;
      list.push(line);
    }
    if (list.length === 0) {
      console.log(yellow('Lista vacía — no se puede continuar.'));
      return null;
    }
    return list;
  }

  const wantsManual = await tuiYesNo('\n¿Querés especificar manualmente el proveedor y modelo para los agentes?', false);
  if (wantsManual) {
    console.log(dim('\n  Pegá uno por línea (formato: ' + cyan('provider/modelo') + dim('), vacío para terminar.\n')));
    while (true) {
      const line = (await rl.question('  > ')).trim();
      if (!line) break;
      if (!list.includes(line)) list.push(line);
    }
  }

  return list;
}

function showCurrentStatus(current) {
  const wAgent = Math.max(...AGENTS.map(a => a.length));
  const wRole = Math.max(...AGENTS.map(a => AGENT_PROFILES[a].role.length));
  const wModel = Math.max(...AGENTS.map(a => (current[a] || '').length));

  const lines = AGENTS.map(agent => {
    const role = AGENT_PROFILES[agent].role;
    const model = current[agent];
    return bold(pad(agent, wAgent)) + '  ' + dim(pad(role, wRole)) + '  ' + green(pad(model, wModel));
  });

  console.log('');
  panel('Configuración actual', lines);
  console.log('');
}

export function agentHeaderBlock(idx, total, agent, role, currentModel, suggestedModel) {
  const stepTag = `[${idx + 1}/${total}]`;
  const agentSpaced = agent.toUpperCase().split('').join(' ');

  const isSameAsCurrent = suggestedModel && currentModel === suggestedModel;

  // Líneas visibles (para cálculo de ancho)
  const visibleL1 = `${stepTag}   ${agentSpaced}`;
  const visibleL2 = `· ${role}`;
  const visibleL3 = `Modelo actual:    ${currentModel}`;
  const visibleL4 = suggestedModel
    ? `Modelo sugerido:  ${suggestedModel}${isSameAsCurrent ? '  (igual)' : ''}`
    : '';
  const innerW = Math.max(
    54,
    Math.max(visibleL1.length, visibleL2.length, visibleL3.length, visibleL4.length) + 4,
  );

  const top    = '┏' + '━'.repeat(innerW) + '┓';
  const bottom = '┗' + '━'.repeat(innerW) + '┛';
  const blank  = '┃' + ' '.repeat(innerW) + '┃';

  // Estilo de líneas
  const styledL1 = dim(stepTag) + '   ' + bold(cyan(agentSpaced));
  const styledL2 = cyan('·') + ' ' + bold(role);
  const styledL3 = dim('Modelo actual:    ') + currentModel;
  const styledL4 = suggestedModel
    ? dim('Modelo sugerido:  ') + (isSameAsCurrent
        ? dim(suggestedModel + '  (igual)')
        : yellow(suggestedModel))
    : null;

  function row(visible, styled) {
    const padding = innerW - 2 - visible.length;
    return cyan('┃') + '  ' + styled + ' '.repeat(Math.max(0, padding)) + cyan('┃');
  }

  const lines = [
    '',
    '  ' + cyan(top),
    '  ' + cyan(blank),
    '  ' + row(visibleL1, styledL1),
    '  ' + row(visibleL2, styledL2),
    '  ' + cyan(blank),
    '  ' + row(visibleL3, styledL3),
  ];
  if (styledL4) lines.push('  ' + row(visibleL4, styledL4));
  lines.push('  ' + cyan(blank));
  lines.push('  ' + cyan(bottom));

  return lines.join('\n');
}

export async function pickFromList(allModels, promptHeader, current) {
  let filter = '';
  let cursorIdx = 0;
  let linesPrinted = 0;

  function buildRows() {
    const matches = filter
      ? allModels.filter(m => m.toLowerCase().includes(filter.toLowerCase()))
      : allModels;
    const grouped = groupByProvider(matches);
    const rows = [];

    for (const [provider, ids] of Object.entries(grouped).sort()) {
      rows.push({ type: 'group', label: '  ─── ' + provider + '/ ───' });
      for (const id of ids) {
        const short = id.includes('/') ? id.split('/').slice(1).join('/') : id;
        rows.push({ type: 'option', id, label: short });
      }
    }

    if (matches.length === 0) {
      rows.push({ type: 'note', label: yellow('  ⚠ Sin matches para "' + filter + '"') });
    }

    rows.push({ type: 'sep' });
    rows.push({ type: 'action', key: 'filter', label: 'Cambiar filtro' });
    rows.push({ type: 'action', key: 'manual',  label: 'Otro (escribir ID manualmente)' });
    rows.push({ type: 'action', key: 'keep',    label: 'Dejar como está' });

    return rows;
  }

  function nextSelectable(rows, from, dir) {
    let i = from + dir;
    while (i >= 0 && i < rows.length) {
      const r = rows[i];
      if (r.type === 'option' || r.type === 'action') return i;
      i += dir;
    }
    return from;
  }

  function ensureValidCursor(rows) {
    const r = rows[cursorIdx];
    if (r && (r.type === 'option' || r.type === 'action')) return;
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i];
      if (x.type === 'option' || x.type === 'action') {
        cursorIdx = i;
        return;
      }
    }
  }

  function render(firstTime) {
    const rows = buildRows();
    ensureValidCursor(rows);

    if (!firstTime && linesPrinted > 0) {
      stdout.write(`\x1b[${linesPrinted}A\x1b[J`);
    }

    let count = 0;
    function out(s) {
      stdout.write(s + '\n');
      count += (s.match(/\n/g) || []).length + 1;
    }

    // Header (multi-línea OK)
    out(promptHeader);
    if (filter) out('   ' + dim('filtro activo: "' + filter + '"'));
    out('');

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const isCursor = i === cursorIdx;
      if (r.type === 'group') {
        out(dim(r.label));
      } else if (r.type === 'sep') {
        out('');
      } else if (r.type === 'note') {
        out(r.label);
      } else if (r.type === 'option') {
        const marker = isCursor ? cyan('●') : ' ';
        const isCurrent = r.id === current;
        let text = r.label + (isCurrent ? dim('   (actual)') : '');
        if (isCursor) text = cyan(r.label) + (isCurrent ? dim('   (actual)') : '');
        out('      ' + marker + ' ' + text);
      } else if (r.type === 'action') {
        const marker = isCursor ? cyan('●') : ' ';
        let label = r.label;
        if (r.key === 'keep') label = r.label + dim(' (' + current + ')');
        if (isCursor) label = cyan(label);
        out('      ' + marker + ' ' + label);
      }
    }

    out('');
    out('  ' + dim('↑/↓ navegar  ·  Enter elegir  ·  / filtrar  ·  Esc o 0 dejar  ·  Ctrl+C salir'));

    linesPrinted = count;
  }

  return new Promise((resolve) => {
    if (!stdin.isTTY || !stdout.isTTY) {
      console.log('\n' + promptHeader);
      console.log(dim('  (no TTY — manteniendo: ' + current + ')'));
      return resolve(current);
    }

    rl.pause();
    stdin.setRawMode(true);
    stdin.resume();

    function teardown() {
      stdin.setRawMode(false);
      stdin.removeListener('keypress', onKey);
      rl.resume();
    }

    async function handleFilter() {
      teardown();
      stdout.write('\n');
      filter = (await rl.question('  Filtro (vacío = limpiar): ')).trim();
      cursorIdx = 0;
      linesPrinted = 0;
      rl.pause();
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', onKey);
      render(true);
    }

    async function handleManual() {
      teardown();
      stdout.write('\n');
      const custom = (await rl.question('  ID exacto del modelo: ')).trim();
      stdout.write('\n');
      resolve(custom || current);
    }

    const onKey = (str, key) => {
      if (!key) return;
      const rows = buildRows();

      if (key.name === 'up' || key.name === 'k') {
        cursorIdx = nextSelectable(rows, cursorIdx, -1);
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        cursorIdx = nextSelectable(rows, cursorIdx, +1);
        render();
      } else if (key.name === 'pageup') {
        for (let n = 0; n < 8; n++) {
          const prev = nextSelectable(rows, cursorIdx, -1);
          if (prev === cursorIdx) break;
          cursorIdx = prev;
        }
        render();
      } else if (key.name === 'pagedown') {
        for (let n = 0; n < 8; n++) {
          const next = nextSelectable(rows, cursorIdx, +1);
          if (next === cursorIdx) break;
          cursorIdx = next;
        }
        render();
      } else if (key.name === 'return') {
        const r = rows[cursorIdx];
        if (!r) return;
        if (r.type === 'option') {
          teardown();
          stdout.write('\n');
          resolve(r.id);
        } else if (r.type === 'action') {
          if (r.key === 'filter') return handleFilter();
          if (r.key === 'manual') return handleManual();
          if (r.key === 'keep') {
            teardown();
            stdout.write('\n');
            resolve(current);
          }
        }
      } else if (str === '/') {
        return handleFilter();
      } else if (key.name === 'escape' || str === '0') {
        teardown();
        stdout.write('\n');
        resolve(current);
      } else if (key.ctrl && key.name === 'c') {
        teardown();
        stdout.write('\n' + dim('(cancelado)') + '\n');
        exit(0);
      }
    };

    stdin.on('keypress', onKey);
    render(true);
  });
}

// ═══════════════════════════════════════════════════════════════════
// Modos de asignación
// ═══════════════════════════════════════════════════════════════════

export function renderSuggestionPanel(recommended, current) {
  const wAgent = Math.max(...AGENTS.map(a => a.length));
  const wRole  = Math.max(...AGENTS.map(a => AGENT_PROFILES[a].role.length));
  const wModel = Math.max(...AGENTS.map(a => (recommended[a] || '').length));

  const lines = AGENTS.map(a => {
    const cur = current[a];
    const rec = recommended[a];
    const changed = cur !== rec;
    const modelCol = changed ? yellow(pad(rec, wModel)) : green(pad(rec, wModel));
    const marker = changed ? yellow('↻ cambia') : dim('· actual');
    return (
      bold(pad(a, wAgent)) + '  ' +
      dim(pad(AGENT_PROFILES[a].role, wRole)) + '  ' +
      modelCol + '  ' +
      marker
    );
  });

  // Resumen de providers usados en la sugerencia
  const providersUsed = {};
  for (const a of AGENTS) {
    const p = getProvider(recommended[a]);
    providersUsed[p] = (providersUsed[p] || 0) + 1;
  }
  const providersList = Object.entries(providersUsed)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => cyan(p) + dim(' (' + n + ')'))
    .join(dim(' · '));
  const providerLabel = Object.keys(providersUsed).length > 1 ? 'Proveedores' : 'Proveedor';
  lines.push('');
  lines.push(dim(providerLabel + ':  ') + providersList);

  panel('Sugerencia automática', lines);
}

// chooseMode — Step 3 del wizard. Recibe `history` mutable: cada sub-decisión
// agrega una línea al historial superior y limpia la pantalla en el siguiente sub-step.
export async function chooseMode(history, allModels, current) {
  const detectedProviders = Array.from(new Set(allModels.map(m => getProvider(m)))).sort();
  const hasMultipleProviders = detectedProviders.length > 1;

  // OpenCode usa un solo proveedor por sesión — siempre elegimos uno (no hay opción "todos")
  let providerFilter = detectedProviders[0];

  // Helper: si ya existe una entry con ese label, la reemplaza; si no, la agrega.
  function setHistoryEntry(label, value) {
    const existing = history.findIndex(h => h.label === label);
    if (existing >= 0) history[existing] = { label, value };
    else history.push({ label, value });
  }

  // Helper: quita todas las entries posteriores a (e incluyendo) un label.
  // Útil cuando volvemos al sub-step A desde "Cambiar proveedor".
  function trimHistoryFrom(label) {
    const idx = history.findIndex(h => h.label === label);
    if (idx >= 0) history.splice(idx);
  }

  while (true) {
    // ─── Sub-step 3a: elegir provider (si hay múltiples) ─────────────
    if (hasMultipleProviders) {
      // Si venimos de un loop ("Cambiar proveedor"), borrar entries posteriores
      trimHistoryFrom('Estrategia');

      renderWizardStep(printModelsBanner, history, '[3/4] Asignar modelo · elegir proveedor');

      const providerOptions = detectedProviders.map(p => {
        const count = allModels.filter(m => getProvider(m) === p).length;
        return `${p} (${count} modelos)`;
      });

      const defaultIdx = Math.max(0, detectedProviders.indexOf(providerFilter));

      const { index: provIdx } = await tuiSelect(
        '\n¿Qué proveedor usamos?',
        providerOptions,
        defaultIdx,
      );

      providerFilter = detectedProviders[provIdx];
      const count = allModels.filter(m => getProvider(m) === providerFilter).length;
      setHistoryEntry('Provider', `${providerFilter} (${count} modelos)`);
    } else {
      // Solo un provider — registramos sin preguntar
      const count = allModels.filter(m => getProvider(m) === providerFilter).length;
      setHistoryEntry('Provider', `${providerFilter} (${count} modelos) — único disponible`);
    }

    // ─── Sub-step 3b: mostrar sugerencia + elegir estrategia ─────────
    renderWizardStep(printModelsBanner, history, '[3/4] Asignar modelo · elegir estrategia');

    const modelsScope = allModels.filter(m => getProvider(m) === providerFilter);

    const recommended = Object.fromEntries(
      AGENTS.map(a => [a, recommendForAgent(a, modelsScope)])
    );

    console.log('');
    renderSuggestionPanel(recommended, current);

    const modeOptions = [
      'Aplicar la sugerencia automática',
      'Asignar el MISMO modelo a todos (preset uniforme)',
      'Custom — agente por agente (con filtros)',
    ];
    if (hasMultipleProviders) {
      modeOptions.push('Cambiar proveedor de la sugerencia');
    }
    modeOptions.push('Cancelar y salir');

    const { index } = await tuiSelect(
      '\n¿Cómo asignamos los modelos?',
      modeOptions,
      0,
    );

    if (index === 0) {
      setHistoryEntry('Estrategia', 'Aplicar sugerencia automática');
      return recommended;
    }

    if (index === 1) {
      setHistoryEntry('Estrategia', 'Mismo modelo para TODOS los agentes');
      renderWizardStep(printModelsBanner, history, '[3/4] Asignar modelo · elegir modelo uniforme');
      const uniformPrompt = '  ' + bold(cyan('Modelo para TODOS los agentes')) + '\n   ' + dim('actual:  ' + current.phobos);
      const m = await pickFromList(modelsScope, uniformPrompt, current.phobos);
      setHistoryEntry('Modelo uniforme', m);
      return Object.fromEntries(AGENTS.map(a => [a, m]));
    }

    if (index === 2) {
      setHistoryEntry('Estrategia', 'Custom — agente por agente');
      const target = {};
      for (let i = 0; i < AGENTS.length; i++) {
        const agent = AGENTS[i];
        renderWizardStep(
          printModelsBanner,
          history,
          `[3/4] Asignar modelo · agente ${i + 1}/${AGENTS.length}: ${agent}`,
        );
        const prompt = agentHeaderBlock(
          i, AGENTS.length, agent,
          AGENT_PROFILES[agent].role,
          current[agent],
          recommended[agent],
        );
        target[agent] = await pickFromList(modelsScope, prompt, current[agent]);
        setHistoryEntry(`  · ${agent}`, target[agent]);
      }
      return target;
    }

    // "Cambiar proveedor" — solo si hay múltiples; loop back al sub-step 3a
    if (hasMultipleProviders && index === 3) {
      continue;
    }

    // Cancelar y salir
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Diff + aplicar
// ═══════════════════════════════════════════════════════════════════

export function printDiff(current, target) {
  const wAgent = Math.max(...AGENTS.map(a => a.length));
  const wCur   = Math.max(...AGENTS.map(a => (current[a] || '').length));
  const wTgt   = Math.max(...AGENTS.map(a => (target[a]  || '').length));

  let any = false;
  const lines = AGENTS.map(agent => {
    const cur = current[agent];
    const tgt = target[agent];
    const changed = cur !== tgt;
    if (changed) any = true;
    return (
      bold(pad(agent, wAgent)) + '  ' +
      dim(pad(cur, wCur)) + '  ' +
      (changed ? cyan('→') : dim('=')) + '  ' +
      (changed ? yellow(pad(tgt, wTgt)) : dim(pad(tgt, wTgt))) + '  ' +
      (changed ? yellow('↻ cambio') : dim('· igual'))
    );
  });

  console.log('');
  panel('Resumen de cambios', lines);
  return any;
}

export async function applyChanges(agentDir, current, target) {
  let changed = 0;
  for (const agent of AGENTS) {
    if (current[agent] !== target[agent]) {
      try {
        await writeModel(agentDir, agent, target[agent]);
        changed++;
      } catch (err) {
        console.error(`  ${yellow('✗')} ${agent}: ${err.message}`);
      }
    }
  }
  console.log(green(`\n✓ ${changed} agente(s) actualizado(s).`));
  if (changed > 0) {
    console.log(dim('\nSi OpenCode está abierto, cambiá de agente (Tab) y volvé para recargar.'));
  }
}

export async function actionSetModels(agentDir) {
  const history = [];

  // ─── Step 1/4: Detectar providers ──────────────────────────────────
  renderWizardStep(printModelsBanner, history, '[1/4] Detectando providers conectados...');
  const detected = await detect();

  if (detected.providers.size === 0) {
    console.log('  ' + yellow('✗ No detecté proveedores conectados en OpenCode.'));
    console.log('');
    console.log('  ' + dim('Para configurar modelos necesitás al menos un proveedor conectado.'));
    console.log('');
    console.log('  ' + bold('Para conectar uno:'));
    console.log('    ' + dim('1.') + ' Iniciá OpenCode con  ' + cyan('opencode'));
    console.log('    ' + dim('2.') + ' Agregá un proveedor con  ' + cyan('/connect'));
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
  const allModels = await getFinalModelList(detected);
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
  const target = await chooseMode(history, allModels, current);
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

  if (hasChanges) {
    const confirm = await tuiYesNo('\n¿Aplicar los cambios?', false);
    if (confirm) {
      await applyChanges(agentDir, current, target);
      history.push({
        label: 'Aplicado',
        value: `${agentsToChange.length} cambio${agentsToChange.length > 1 ? 's' : ''} persistido${agentsToChange.length > 1 ? 's' : ''} en .opencode/agent/`,
      });
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
  await pressEnterToContinue();
}

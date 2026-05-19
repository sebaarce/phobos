// Modelos — detección, asignación, picker, diff y apply.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { stdin, stdout, exit, platform, env, cwd } from 'node:process';
import { AGENTS, AGENT_PROFILES, rl } from './runtime.mjs';
import { fileExists, tryExec, assertSafeShellArg, safeWriteFile } from './fs-utils.mjs';
import { green, yellow, cyan, red, dim, bold, pad } from './colors.mjs';
import { panel, tuiSelect, tuiYesNo, clearScreen } from './tui.mjs';
import { printModelsBanner, renderWizardStep } from './banners.mjs';
import { pressEnterToContinue } from './exit.mjs';
import { backupAgents } from './update.mjs';

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

// Preferencia explícita por provider — gana sobre el scoring genérico cuando hay match.
// El objetivo: si el usuario tiene Zen (opencode/*) configurado, sugerimos el "camino B"
// — un set coherente con buen aprovechamiento del cache read y costos optimizados por rol.
// Si no hay match en ese provider, cae al scoring de PROFILE_WEIGHTS (cross-provider).
//
// Patrones tolerantes: la versión puede venir con punto (`claude-sonnet-4.6`) o guión
// (`claude-sonnet-4-6`); ambos son válidos según cómo el provider exponga el ID.
export const PROVIDER_PREFERENCES = {
  opencode: {
    phobos:     [/^opencode\/claude-sonnet-4[-.]6$/i, /^opencode\/claude-sonnet/i],
    planner:    [/^opencode\/claude-sonnet-4[-.]6$/i, /^opencode\/claude-sonnet/i],
    programmer: [/^opencode\/claude-sonnet-4[-.]6$/i, /^opencode\/claude-sonnet/i],
    researcher: [/^opencode\/qwen3?[-.]?6[-.]plus$/i, /^opencode\/qwen/i, /^opencode\/gpt-?5[-.]4[-.]mini$/i],
    tester:     [/^opencode\/gpt-?5[-.]4[-.]mini$/i, /^opencode\/qwen3?[-.]?6[-.]plus$/i],
    archivist:  [/^opencode\/claude-sonnet-4[-.]6$/i, /^opencode\/claude-sonnet/i],
  },
};

function matchPreferred(agent, allModels) {
  for (const [provider, byAgent] of Object.entries(PROVIDER_PREFERENCES)) {
    const patterns = byAgent[agent];
    if (!patterns) continue;
    // Solo aplicamos el override si el provider está realmente presente en la lista detectada.
    const hasProvider = allModels.some(id => id.startsWith(provider + '/'));
    if (!hasProvider) continue;
    for (const pattern of patterns) {
      const hit = allModels.find(id => pattern.test(id));
      if (hit) return hit;
    }
  }
  return null;
}

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
  // Override por provider preferido (ej: Zen → "camino B" coherente con cache + costo por rol).
  const preferred = matchPreferred(agent, allModels);
  if (preferred) return preferred;

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

  // opencode models <provider> — por si algún provider tiene modelos no incluidos en el default.
  // El provider viene de auth.json (potencialmente atacante-controlado si auth.json fue manipulado)
  // → validamos con regex estricta antes de pasarlo a shell. Si no matchea, lo salteamos con warning
  // en vez de abortar (otros providers válidos podrían existir).
  const PROVIDER_PATTERN = /^[a-zA-Z0-9_-]+$/;
  for (const provider of detected.providers) {
    let safeProvider;
    try {
      safeProvider = assertSafeShellArg(provider, 'provider', PROVIDER_PATTERN);
    } catch (err) {
      detected.notes.push(`Provider "${String(provider).slice(0, 40)}" tiene caracteres no válidos — salteado por seguridad.`);
      continue;
    }
    const r = tryExec(`opencode models ${safeProvider}`, 12000);
    if (r.ok && r.out) {
      const ids = parseModelsList(r.out);
      for (const id of ids) {
        if (!detected.models.has(id)) {
          detected.models.set(id, `opencode models ${safeProvider}`);
        }
      }
    }
  }

  return detected;
}

// ═══════════════════════════════════════════════════════════════════
// Lectura/escritura de agentes
// ═══════════════════════════════════════════════════════════════════

// Lee el modelo configurado de cada agente. Acepta el agentDir directo
// (path absoluto al directorio de agentes del proyecto) — quien llama suele
// pasar `resolve(cwd(), adapter.agentDir)`.
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
  // safeWriteFile valida sandbox (cwd) + rechaza symlinks.
  await safeWriteFile(filepath, updated);
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

export function showCurrentStatus(current) {
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
  let viewportStart = 0;
  let linesPrinted = 0;

  // Viewport: deja espacio para header (~3), indicadores arriba/abajo (~2),
  // hint final (~1) y margen. Mínimo razonable 8 filas, sino se ve apretado.
  function getViewportSize() {
    const rows = stdout.rows || 24;
    return Math.max(8, rows - 8);
  }

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

  function adjustViewport(rows, viewportSize) {
    if (viewportStart > Math.max(0, rows.length - viewportSize)) {
      viewportStart = Math.max(0, rows.length - viewportSize);
    }
    if (cursorIdx < viewportStart) {
      viewportStart = cursorIdx;
    } else if (cursorIdx >= viewportStart + viewportSize) {
      viewportStart = cursorIdx - viewportSize + 1;
    }
    if (viewportStart < 0) viewportStart = 0;
  }

  function render(firstTime) {
    const rows = buildRows();
    ensureValidCursor(rows);
    const viewportSize = getViewportSize();
    adjustViewport(rows, viewportSize);

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

    const viewportEnd = Math.min(rows.length, viewportStart + viewportSize);
    const hiddenAbove = viewportStart;
    const hiddenBelow = rows.length - viewportEnd;

    if (hiddenAbove > 0) {
      out('      ' + dim('↑ ' + hiddenAbove + ' más arriba'));
    } else {
      out('');
    }

    for (let i = viewportStart; i < viewportEnd; i++) {
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

    if (hiddenBelow > 0) {
      out('      ' + dim('↓ ' + hiddenBelow + ' más abajo'));
    } else {
      out('');
    }

    out('');
    out('  ' + dim('↑/↓ navegar  ·  PgUp/PgDn saltar  ·  Enter elegir  ·  / filtrar  ·  Esc o 0 dejar'));

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
      viewportStart = 0;
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
    AGENTS.map(a => [a, recommendForAgent(a, allModels)])
  );

  const { index } = await tuiSelect(
    '\n¿Cómo asignamos los modelos?',
    [
      'Aplicar la sugerencia automática',
      'Asignar el MISMO modelo a todos (preset uniforme)',
      'Custom — agente por agente (multi-provider)',
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
      AGENTS.map(a => [a, recommendForAgent(a, modelsScope) || recommendedCross[a]])
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
      let scopedModels = allModels;
      if (hasMultipleProviders) {
        const providerOptions = detectedProviders.map(p => {
          const count = allModels.filter(m => getProvider(m) === p).length;
          return `${p} (${count} modelos)`;
        });
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
        const chosenProvider = detectedProviders[provIdx];
        scopedModels = allModels.filter(m => getProvider(m) === chosenProvider);
        stickyProvider = chosenProvider;
      }

      // Sub-pregunta 2: ¿qué modelo dentro del provider elegido?
      target[agent] = await pickFromList(scopedModels, `\nElegí modelo para @${agent}:`, current[agent]);
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
  // Determinar primero qué agentes efectivamente cambian — backup-eamos solo
  // esos para evitar copias inútiles y mantener el directorio de backup limpio.
  const agentsToChange = AGENTS.filter(a => current[a] !== target[a]);

  if (agentsToChange.length === 0) {
    console.log(dim('\n  ⊘ No hay cambios para aplicar.'));
    return { changed: 0, backup: null };
  }

  // Backup silencioso pre-escritura. Reusa el helper de update.mjs para
  // mantener un solo formato de backup (`.opencode/agent_backup/phobos/<ts>/`)
  // independientemente del wizard que lo dispare.
  const filesToBackup = agentsToChange.map(a => `.opencode/agent/${a}.md`);
  const backup = await backupAgents(filesToBackup);

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
    console.log(dim('\nSi OpenCode está abierto, cambiá de agente (Tab) y volvé para recargar.'));
  }
  return { changed, backup };
}

// Recibe el adapter del IDE activo. Deriva el agentDir internamente del
// adapter — el resto del flow es target-agnostic (lee modelos, escribe a
// los .md, hace backup). La detección de providers/modelos (`detect()`)
// sigue siendo OpenCode-specific por ahora; cuando se sume Claude Code se
// va a parametrizar via `adapter.detectModels()`.
export async function actionSetModels(adapter) {
  if (!adapter) throw new Error('actionSetModels requires an adapter (IDEAdapter instance).');
  const agentDir = resolvePath(cwd(), adapter.agentDir);
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

  let applyResult = null;
  if (hasChanges) {
    const confirm = await tuiYesNo('\n¿Aplicar los cambios?', false);
    if (confirm) {
      applyResult = await applyChanges(agentDir, current, target);
      history.push({
        label: 'Aplicado',
        value: `${agentsToChange.length} cambio${agentsToChange.length > 1 ? 's' : ''} persistido${agentsToChange.length > 1 ? 's' : ''} en .opencode/agent/`,
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
    console.log('  ' + dim('  Si querés revertir un cambio: ') + dim('copiá el archivo desde ese directorio al .opencode/agent/.'));
  }
  await pressEnterToContinue();
}

// ═══════════════════════════════════════════════════════════════════
// Ver configuración (read-only)
// ═══════════════════════════════════════════════════════════════════

// Acción read-only del menú principal: imprime el estado actual de cada
// agente sin modificar nada. Útil para diagnosticar configuraciones antes
// de tocarlas, ver qué provider domina, o auditar después de un cambio.
// Recibe el adapter del IDE activo y muestra el estado actual de los
// modelos asignados a cada agente. Read-only: nunca modifica archivos.
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

// Models catalog — data layer.
//
// Responsabilidades:
//   1. Detección de modelos disponibles (vía CLI de OpenCode + auth.json).
//   2. Recomendación por agente (scoring heurístico + override por provider).
//   3. I/O del campo `model:` en cada agent .md.
//   4. Helpers de provider (getProvider, groupByProvider).
//
// No tiene side effects de UI más allá de los errores fatales del CLI no
// detectado en detect() (donde printeamos un mensaje y abortamos — eso vive
// acá porque es parte del "data is not available" en lugar de UI).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { platform, env, exit } from 'node:process';
import { AGENTS, rl } from '../runtime.mjs';
import { fileExists, tryExec, assertSafeShellArg, safeWriteFile } from '../fs-utils.mjs';
import { green, yellow, cyan, dim, bold, pad } from '../colors.mjs';
import { panel, tuiYesNo } from '../tui.mjs';

// ═══════════════════════════════════════════════════════════════════
// Helpers de provider (utility)
// ═══════════════════════════════════════════════════════════════════

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

function parseModelsList(output) {
  return output.split('\n')
    .map(l => l.trim())
    .filter(l => l && /^[a-z][a-z0-9_-]*\/[a-z0-9._-]+$/i.test(l));
}

// ═══════════════════════════════════════════════════════════════════
// Recomendación heurística por agente
// ═══════════════════════════════════════════════════════════════════

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

export function recommendForAgent(agent, allModels, adapter = null) {
  // 1) Override del adapter — Claude define modelos por agente explícitamente
  // (ej: phobos → inherit, researcher → haiku). Si el adapter tiene una
  // recomendación y está en la lista disponible, usarla sin scoring.
  if (adapter && typeof adapter.defaultModelForAgent === 'function') {
    const adapterDefault = adapter.defaultModelForAgent(agent);
    if (adapterDefault && allModels.includes(adapterDefault)) {
      return adapterDefault;
    }
  }

  // 2) Override por provider preferido (ej: Zen → "camino B" coherente con cache + costo por rol).
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

// Summary text para el panel del wizard step "Detección". UI-thin, no es
// un componente reusable — vive acá porque está acoplado al shape de `detected`.
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

// Devuelve la lista final de modelos para asignar — la detectada + (opcional)
// IDs manuales que el usuario quiera pegar. Si no se detectó nada, fuerza paste.
export async function getFinalModelList(detected, adapter = null) {
  let list = Array.from(detected.models.keys());
  // Formato del ID esperado — depende del IDE.
  //   OpenCode: provider/modelo (ej: github-copilot/claude-sonnet-4-6)
  //   Claude:   alias o full ID (ej: sonnet, inherit, claude-sonnet-4-6)
  const idFormat = adapter && adapter.id === 'claude'
    ? 'alias o full ID Claude'
    : 'provider/modelo';

  if (list.length === 0) {
    console.log(yellow('\n⚠ No se detectaron modelos automáticamente.'));
    console.log(`  Pegá los IDs disponibles, uno por línea (formato: ${cyan(idFormat)}).`);
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

  const wantsManual = await tuiYesNo('\n¿Querés agregar manualmente modelos extra para los agentes?', false);
  if (wantsManual) {
    console.log(dim('\n  Pegá uno por línea (formato: ' + cyan(idFormat) + dim('), vacío para terminar.\n')));
    while (true) {
      const line = (await rl.question('  > ')).trim();
      if (!line) break;
      if (!list.includes(line)) list.push(line);
    }
  }

  return list;
}

// ═══════════════════════════════════════════════════════════════════
// I/O — lectura y escritura del campo `model:` en cada agent .md
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

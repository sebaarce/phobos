// Inspect Qdrant + helpers de diagnóstico de Memory.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { fileExists } from '../fs-utils.mjs';
import { cyan, dim, yellow, red, green, bold, pad } from '../colors.mjs';
import { panel } from '../tui.mjs';
import { printMemoryBanner } from '../banners.mjs';
import { clearScreen } from '../tui.mjs';
import { pressEnterToContinue } from '../exit.mjs';
import {
  QDRANT_URL,
  QDRANT_COMPOSE_GLOBAL,
  detectQdrantStatus,
  listQdrantCollectionsDetailed,
  getCollectionSamples,
  detectStaleStoragePath,
} from './engine.mjs';
import { getProjectActiveCollection } from './collection.mjs';

// Extrae el nombre del módulo faltante del stack trace de ERR_MODULE_NOT_FOUND.
export function extractMissingModule(output) {
  // Patrón 1: "Cannot find module 'X'" (CommonJS)
  let m = output.match(/Cannot find module ['"]([^'"]+)['"]/);
  if (m) return m[1];
  // Patrón 2: "Cannot find package 'X'" (ESM)
  m = output.match(/Cannot find package ['"]([^'"]+)['"]/);
  if (m) return m[1];
  // Patrón 3: ESM resolver — "imported from /.../node_modules/X/..."
  m = output.match(/imported from\s+['"]?[^'"]*node_modules[\\\/]([@a-z0-9_.-]+(?:[\\\/][a-z0-9_.-]+)?)/i);
  if (m) return m[1].replace(/\\/g, '/');
  return null;
}

// Detecta patrones comunes en el output de un script de Memory y devuelve
// un mensaje de diagnóstico accionable, o null si no encuentra nada conocido.
export function diagnoseMemoryFailure(output) {
  if (/Cannot find module|Cannot find package|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i.test(output)) {
    const moduleName = extractMissingModule(output);
    const isTopLevel = moduleName && (moduleName === '@xenova/transformers' || moduleName === '@qdrant/js-client-rest');
    const isSubDep = moduleName && !isTopLevel && (
      moduleName.startsWith('onnxruntime-')
      || moduleName.includes('@huggingface')
      || moduleName === 'sharp'
    );

    let steps;
    if (isTopLevel || !moduleName) {
      steps = [
        'Las deps top-level del engine no están en node_modules/ (instalación parcial).',
        'Probable causa: ERESOLVE en NPM v7+ (típico de NestJS/Angular).',
        'Solución:',
        '  npm install --legacy-peer-deps @xenova/transformers @qdrant/js-client-rest',
        'O desde el submenú: "Re-instalar engine en este proyecto".',
      ];
    } else if (isSubDep) {
      // Caso específico: onnxruntime-node es optional de @xenova/transformers.
      // Algunos npm flags lo saltan. Solución directa: instalarlo como top-level.
      if (moduleName.startsWith('onnxruntime-node')) {
        steps = [
          `onnxruntime-node es una optional dependency de @xenova/transformers que no`,
          'se instaló (común con --legacy-peer-deps o ciertas configs de npm).',
          '',
          'Solución directa — instalar onnxruntime-node como top-level:',
          '  npm install --legacy-peer-deps onnxruntime-node@1.14.0',
          '',
          'Después reintentá el reindex.',
          '',
          'Notas:',
          '· La versión 1.14.0 es la que matcha la usada internamente por @xenova/transformers@2.17.2.',
          '· En Windows el postinstall descarga un prebuilt; no requiere Visual Studio',
          '  Build Tools (a menos que el prebuilt para tu plataforma no exista).',
          '· Si querés blindar el proyecto para futuros installs:',
          '    npm install --legacy-peer-deps --include=optional',
          '  (fuerza npm a procesar optional deps siempre).',
        ];
      } else {
        steps = [
          `Falta una sub-dep nativa (${moduleName}). Suele ser binarios nativos`,
          'que no se compilaron en postinstall.',
          'Solución completa (reinstala todo limpio):',
          '  Remove-Item -Recurse -Force node_modules, package-lock.json',
          '  npm install --legacy-peer-deps',
          '',
          'Si tenés problemas con bindings nativos en Windows, instalá:',
          '  Build Tools for Visual Studio (workload "Desktop development with C++")',
          '  https://visualstudio.microsoft.com/visual-cpp-build-tools/',
        ];
      }
    } else {
      steps = [
        `Solución sugerida — reinstalación limpia:`,
        '  Remove-Item -Recurse -Force node_modules, package-lock.json',
        '  npm install --legacy-peer-deps',
        '',
        'O instalación puntual del paquete que falta:',
        `  npm install --legacy-peer-deps ${moduleName}`,
      ];
    }

    return {
      hint: moduleName
        ? `Falta el módulo: ${moduleName}`
        : 'Falta un módulo de Node (no se pudo identificar cuál).',
      steps,
    };
  }
  if (/fatal:\s*Unauthorized/i.test(output) || /\b401\b/.test(output) || /api[\s_-]?key/i.test(output)) {
    return {
      hint: 'Qdrant está corriendo pero rechaza con Unauthorized.',
      steps: [
        'Bug del template viejo del docker-compose (línea QDRANT__SERVICE__API_KEY:"").',
        'Solución: submenú Memory → "Reset Qdrant global". Regenera el compose limpio.',
      ],
    };
  }
  if (/qdrant unreachable/i.test(output) || /ECONNREFUSED/i.test(output)) {
    return {
      hint: 'Qdrant no responde.',
      steps: [
        'Levantalo con: docker compose -f ~/.phobos/docker-compose.qdrant.yml up -d',
        'Esperá 5 segundos y reintentá.',
      ],
    };
  }
  if (/ENOTFOUND|ETIMEDOUT|getaddrinfo|fetch failed/i.test(output)) {
    return {
      hint: 'Error de red — probablemente descarga del modelo Xenova.',
      steps: [
        'Verificá conexión a internet (la primera vez se descarga ~80 MB del modelo).',
        'Reintentá. Si persiste, problemas con HuggingFace mirror.',
      ],
    };
  }
  if (/ENOSPC/i.test(output)) {
    return {
      hint: 'Sin espacio en disco.',
      steps: ['Liberá espacio en el filesystem y reintentá.'],
    };
  }
  return null;
}

// Detecta si el researcher.md del proyecto tiene las reglas RAG (pre-flight
// search + Previous insights). Si no las tiene, el researcher NUNCA va a
// consultar el engine, sin importar que Qdrant esté corriendo.
// `adapter` opcional: si se pasa, usa adapter.agentDir; si no, default
// OpenCode (.opencode/agent/) por compat con callers internos viejos.
export async function detectResearcherHasRAG(adapter) {
  const agentDir = adapter && adapter.agentDir ? adapter.agentDir : '.opencode/agent';
  try {
    const content = await readFile(join(agentDir, 'researcher.md'), 'utf-8');
    return /Pre-flight:\s*semantic\s*search/i.test(content)
      || /vault\/memory\/\.engine\/launcher\.mjs/.test(content)
      || /vault\/memory\/\.engine\/search\.mjs/.test(content);
  } catch {
    return false;
  }
}

// Devuelve la fecha en la que Memory se instaló en este proyecto.
// Usamos el mtime del config.json o del .index-state.json (lo que exista primero).
export async function getMemoryInstalledAt() {
  const { stat } = await import('node:fs/promises');
  const candidates = [
    'vault/memory/.engine/.index-state.json',
    'vault/memory/.engine/config.json',
  ];
  for (const p of candidates) {
    try {
      const s = await stat(p);
      return s.mtime;
    } catch {}
  }
  return null;
}

// Recorre vault/memory/tasks/ y reporta cuántas tareas tienen evidencia de uso
// del memory engine (Previous insights en research.md, conclusion cerrada).
// Cada tarea incluye el `closedAt` (mtime de conclusion.md) para poder
// clasificarla como pre/post-instalación de Memory.
export async function checkTaskMemoryUsage() {
  const { stat } = await import('node:fs/promises');
  const tasksDir = 'vault/memory/tasks';
  const out = { total: 0, closed: 0, withPreviousInsights: 0, tasks: [] };
  if (!await fileExists(tasksDir)) return out;

  let entries = [];
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const slug = e.name;
    const dir = join(tasksDir, slug);
    const conclusionPath = join(dir, 'conclusion.md');
    const hasConclusion = await fileExists(conclusionPath);
    const researchPath = join(dir, 'research.md');
    const hasResearch = await fileExists(researchPath);
    let hasPreviousInsights = false;
    let closedAt = null;
    let researchAt = null;

    if (hasResearch) {
      try {
        const content = await readFile(researchPath, 'utf-8');
        if (/##\s*Previous\s*insights/i.test(content)) {
          const section = content.split(/##\s*Previous\s*insights/i)[1] || '';
          const head = section.split(/\n##\s/)[0] || '';
          hasPreviousInsights = /\[\[[^\]]+\]\]/.test(head) || /similarity\s+[\d.]+/i.test(head);
        }
      } catch {}
      try {
        const s = await stat(researchPath);
        researchAt = s.mtime;
      } catch {}
    }
    if (hasConclusion) {
      try {
        const s = await stat(conclusionPath);
        closedAt = s.mtime;
      } catch {}
    }

    out.tasks.push({ slug, hasConclusion, hasResearch, hasPreviousInsights, closedAt, researchAt });
    out.total++;
    if (hasConclusion) out.closed++;
    if (hasPreviousInsights) out.withPreviousInsights++;
  }
  return out;
}

// Chequea si los agentes researcher.md y archivist.md del proyecto tienen
// las reglas de soporte de Memory (pre-flight search en researcher, trigger
// reindex en archivist). Si ambos las tienen, Memory va a funcionar
// automáticamente. Si no, el engine se instala pero los agentes viejos no la
// usan — el usuario debe correr "Actualizar agentes" primero.
// `adapter` opcional: si se pasa, usa adapter.agentDir; si no, default OpenCode.
export async function detectAgentsHaveMemorySupport(adapter) {
  const agentDir = adapter && adapter.agentDir ? adapter.agentDir : '.opencode/agent';
  const researcherPath = join(cwd(), agentDir, 'researcher.md');
  const archivistPath = join(cwd(), agentDir, 'archivist.md');

  let researcherOK = false;
  let archivistOK = false;

  try {
    const r = await readFile(researcherPath, 'utf-8');
    researcherOK = /Pre-flight:\s*semantic\s*search/i.test(r)
      || /vault\/memory\/\.engine\/launcher\.mjs/.test(r)
      || /vault\/memory\/\.engine\/search\.mjs/.test(r);
  } catch {}

  try {
    const a = await readFile(archivistPath, 'utf-8');
    archivistOK = /Trigger\s*semantic\s*re-?index/i.test(a)
      || /vault\/memory\/\.engine\/launcher\.mjs/.test(a)
      || /vault\/memory\/\.engine\/index-vault\.mjs/.test(a);
  } catch {}

  return { researcherOK, archivistOK };
}

// `adapter` opcional — sirve a detectResearcherHasRAG() para chequear el
// agente en el path correcto del IDE. Sin adapter, fallback a .opencode/agent/.
export async function actionInspectQdrant(adapter) {
  clearScreen();
  printMemoryBanner();

  panel('Inspect Qdrant — estado del engine', [
    'Pantalla read-only. No modifica nada — solo lee el estado actual.',
  ]);

  // ── 1. Healthcheck ────────────────────────────────────────────────
  const status = await detectQdrantStatus();
  console.log('');
  console.log('  ' + bold('Qdrant'));
  if (!status.healthy) {
    console.log('  ' + red('  ✗ no está corriendo o no responde'));
    console.log('  ' + dim('    Levantalo con: ') + cyan(`docker compose -f ${QDRANT_COMPOSE_GLOBAL} up -d`));
    await pressEnterToContinue();
    return;
  }
  console.log('  ' + green('  ✓ healthy en ') + cyan(QDRANT_URL));
  console.log('  ' + dim('    Dashboard: ') + cyan(QDRANT_URL + '/dashboard'));

  // ── 1.5 Detección de issues en el compose global ──────────────────
  const staleCheck = await detectStaleStoragePath();
  // Chequeo extra: puertos expuestos en 0.0.0.0 (binding default de Docker)
  // en vez de loopback (127.0.0.1). Riesgo en LAN si Qdrant corre sin auth.
  let composeHasOpenPort = false;
  if (await fileExists(QDRANT_COMPOSE_GLOBAL)) {
    try {
      const composeContent = await readFile(QDRANT_COMPOSE_GLOBAL, 'utf-8');
      // Match port mapping SIN prefijo de IP (formato "6333:6333" o "- 6333:6333")
      // Si tiene "127.0.0.1:6333:6333" no matchea.
      composeHasOpenPort = /^[ \t-]*"?6333:6333"?\s*(?:#|$)/m.test(composeContent);
    } catch {}
  }

  if (staleCheck.hasStalePath || staleCheck.oldDirExists || composeHasOpenPort) {
    console.log('');
    console.log('  ' + bold(yellow('⚠ Issues detectados en el compose global')));

    if (staleCheck.hasStalePath) {
      console.log('  ' + dim('  · El compose tiene un path viejo: ') + yellow('./.qdrant_storage'));
      console.log('  ' + dim('    Debería ser: ./qdrant-storage'));
    }
    if (staleCheck.oldDirExists) {
      console.log('  ' + dim('  · Carpeta stale presente: ') + yellow(staleCheck.oldDir));
      if (staleCheck.newDirExists) {
        console.log('  ' + dim('    Carpeta nueva también presente: ') + cyan(staleCheck.newDir));
        console.log('  ' + dim('    ⚠ Datos potencialmente duplicados o desincronizados.'));
      }
    }
    if (composeHasOpenPort) {
      console.log('  ' + dim('  · Puerto 6333 expuesto en ') + yellow('0.0.0.0') + dim(' (visible en LAN).'));
      console.log('  ' + dim('    Riesgo: Qdrant corre sin auth — cualquier proceso en tu red puede'));
      console.log('  ' + dim('    leer/borrar vectores. Debería bindear a 127.0.0.1:6333:6333 (loopback).'));
    }

    console.log('');
    console.log('  ' + dim('  Solución: submenú Memory → "Reset Qdrant global" (regenera el compose'));
    console.log('  ' + dim('  con los valores correctos; ofrece backup antes de borrar datos).'));
  }

  // ── 2. Collections en la instancia ───────────────────────────────
  console.log('');
  console.log('  ' + bold('Collections en la instancia global'));
  const collections = await listQdrantCollectionsDetailed();
  const mySlug = await getProjectActiveCollection();

  if (collections.length === 0) {
    console.log('  ' + dim('  (ninguna — instalá Memory en algún proyecto y se va a crear)'));
  } else {
    const maxName = Math.max(...collections.map(c => c.name.length));
    for (const c of collections) {
      const isMine = c.name === mySlug;
      const marker = isMine ? green('  ← este proyecto') : '';
      const nameLabel = isMine ? cyan(pad(c.name, maxName)) : pad(c.name, maxName);
      console.log('  · ' + nameLabel + '  '
        + dim(c.points + ' pts · ' + c.dims + 'd · ' + c.distance + ' · ' + c.status)
        + marker);
    }
  }

  // ── 3. Detalle de la collection del proyecto ──────────────────────
  console.log('');
  console.log('  ' + bold('Tu collection: ') + cyan(mySlug));
  const mine = collections.find(c => c.name === mySlug);
  if (!mine) {
    console.log('  ' + yellow('  ⚠ La collection todavía no existe.'));
    console.log('  ' + dim('    Corré: ') + cyan('node vault/memory/.engine/launcher.mjs index'));
  } else if (mine.points === 0) {
    console.log('  ' + yellow('  ⚠ Existe pero está vacía (0 points).'));
    console.log('  ' + dim('    El archivist nunca indexó, o se reseteó. Corré: ') + cyan('node vault/memory/.engine/launcher.mjs index --force'));
  } else {
    console.log('  ' + dim('  Points totales: ') + cyan(mine.points));
    console.log('  ' + dim('  Dimensiones:    ') + cyan(mine.dims + 'd, ' + mine.distance));

    const samples = await getCollectionSamples(mySlug, 5);
    if (samples.length > 0) {
      console.log('  ' + dim('  Muestras (primeros ' + samples.length + ' chunks):'));
      for (const p of samples) {
        const path = p.payload?.filePath || '(sin filePath)';
        const section = p.payload?.sectionTitle ? '  § ' + p.payload.sectionTitle : '';
        const updatedAt = p.payload?.updatedAt ? '  [' + p.payload.updatedAt.slice(0, 19).replace('T', ' ') + ']' : '';
        console.log('    · ' + cyan(path) + dim(section) + dim(updatedAt));
      }
    }
  }

  // ── 4. Sanity de agentes — diagnóstico accionable ─────────────────
  console.log('');
  console.log('  ' + bold('Sanity de agentes — uso de Memory en tareas'));
  const usage = await checkTaskMemoryUsage();
  const researcherHasRAG = await detectResearcherHasRAG(adapter);
  const installedAt = await getMemoryInstalledAt();

  const fmtDate = (d) => d ? d.toISOString().slice(0, 19).replace('T', ' ') : '?';

  console.log('  ' + dim('  researcher.md tiene reglas RAG: ')
    + (researcherHasRAG ? green('✓') : red('✗ — falta sección "Pre-flight: semantic search"')));
  console.log('  ' + dim('  Memory instalada en proyecto:   ')
    + (installedAt ? cyan(fmtDate(installedAt)) : dim('(no detectada)')));

  if (usage.total === 0) {
    console.log('  ' + dim('  (sin tareas en vault/memory/tasks/ todavía)'));
  } else {
    // Clasificación correcta: usamos el mtime de RESEARCH.md (no de conclusion.md)
    // para determinar si el researcher corrió pre o post-Memory. El research.md
    // no se regenera al cerrar la tarea — si fue escrito antes del install, es
    // histórico aunque el cierre sea posterior.
    const closedTasks = usage.tasks.filter(t => t.hasConclusion);
    const historicalResearch = [];        // research.md generado antes del install
    const postInstall = [];                // research.md generado después del install
    const closedButPreResearch = [];      // cerradas post-install pero con research pre-install
    if (installedAt) {
      for (const t of closedTasks) {
        if (!t.researchAt) {
          // No hay research.md → no aplica al sanity check
          historicalResearch.push(t);
        } else if (t.researchAt < installedAt) {
          historicalResearch.push(t);
          if (t.closedAt && t.closedAt >= installedAt) {
            closedButPreResearch.push(t);
          }
        } else {
          postInstall.push(t);
        }
      }
    } else {
      postInstall.push(...closedTasks);
    }
    const postWithInsights = postInstall.filter(t => t.hasPreviousInsights).length;

    console.log('');
    console.log('  ' + dim('  Tareas totales:                            ') + cyan(usage.total));
    console.log('  ' + dim('  Cerradas:                                  ') + cyan(closedTasks.length + '/' + usage.total));
    if (historicalResearch.length > 0) {
      console.log('  ' + dim('  Pre-Memory (research generado antes):      ')
        + dim(historicalResearch.length + ' tarea(s) — no aplican al flujo RAG'));
    }
    console.log('  ' + dim('  Post-Memory (research generado después):   ') + cyan(postInstall.length));
    if (postInstall.length > 0) {
      const ratio = postWithInsights + '/' + postInstall.length;
      const color = postWithInsights === postInstall.length ? green
                  : postWithInsights > 0 ? yellow
                  : red;
      console.log('  ' + dim('    Con Previous insights:                   ') + color(ratio));
    }

    // Última tarea cerrada post-Memory
    if (postInstall.length > 0) {
      const last = postInstall[postInstall.length - 1];
      console.log('');
      console.log('  ' + dim('  Última tarea cerrada post-Memory: ') + cyan(last.slug));
      console.log('  ' + dim('    research.md generado el:         ') + cyan(fmtDate(last.researchAt)));
      console.log('  ' + dim('    Previous insights presente:      ')
        + (last.hasPreviousInsights ? green('✓') : yellow('✗')));
    }

    // ── Diagnóstico accionable ─────────────────────────────────────
    console.log('');
    console.log('  ' + bold('Diagnóstico'));

    if (!researcherHasRAG) {
      console.log('  ' + red('  ✗ El researcher.md de este proyecto no tiene la regla RAG.'));
      console.log('  ' + dim('    El researcher NUNCA va a consultar el engine en este estado.'));
      console.log('  ' + dim('    Solución:'));
      console.log('    ' + cyan('    npx github:sebaarce/phobos') + dim('  → "Actualizar agentes" → aplicar'));
      console.log('  ' + dim('    Después reiniciá OpenCode para que tome el prompt nuevo.'));
    } else if (postInstall.length === 0 && closedButPreResearch.length > 0) {
      // ESCENARIO ESPECÍFICO: tareas cerradas post-install pero research.md pre-install
      console.log('  ' + yellow('  ⚠ Las tareas cerradas después de instalar Memory tienen su research.md'));
      console.log('  ' + yellow('    generado ANTES del install. Esos research.md NO se regeneran al cerrar.'));
      console.log('');
      console.log('  ' + dim('    Detalle de la(s) tarea(s) afectada(s):'));
      for (const t of closedButPreResearch.slice(-3)) {
        console.log('  ' + dim('      · ') + cyan(t.slug));
        console.log('  ' + dim('        research.md:     ') + fmtDate(t.researchAt) + dim('  (pre-Memory)'));
        console.log('  ' + dim('        conclusion.md:   ') + fmtDate(t.closedAt) + dim('  (post-Memory)'));
      }
      console.log('');
      console.log('  ' + bold('Esto es normal') + dim(' — el flujo RAG funciona desde el ') + bold('OPEN') + dim(' de una tarea.'));
      console.log('  ' + dim('    Para validar, hacé esto:'));
      console.log('  ' + dim('      1. Abrí una tarea ') + bold('nueva') + dim(' en Phobos (Open task, no Resume).'));
      console.log('  ' + dim('      2. Dejá que el researcher escriba research.md desde cero.'));
      console.log('  ' + dim('      3. Cuando termine, volvé a Inspect.'));
      console.log('  ' + dim('      4. Verificá que "Post-Memory" suba a 1 y "Con Previous insights" sea 1/1.'));
    } else if (postInstall.length === 0) {
      console.log('  ' + yellow('  ⚠ Sin tareas con research.md generado después de instalar Memory.'));
      console.log('  ' + dim('    Probá abrir una tarea NUEVA y dejar que corra el pipeline completo.'));
    } else if (postWithInsights === postInstall.length) {
      console.log('  ' + green('  ✓ Todo OK. ') + dim('Researcher consulta el engine en cada tarea post-Memory.'));
    } else if (postWithInsights === 0) {
      console.log('  ' + yellow('  ⚠ researcher.md tiene reglas RAG, pero ninguna tarea post-Memory las usó.'));
      console.log('  ' + dim('    Causa más probable: OpenCode todavía tiene el prompt viejo cacheado.'));
      console.log('  ' + dim('    Solución:'));
      console.log('  ' + dim('      1. Cerrar OpenCode completamente (no solo el tab).'));
      console.log('  ' + dim('      2. Volver a abrirlo.'));
      console.log('  ' + dim('      3. Crear una tarea nueva de prueba (Open task, no Resume).'));
      console.log('  ' + dim('      4. Volver a Inspect Qdrant y verificar.'));
      console.log('  ' + dim('    Si persiste: el researcher puede estar fallando silenciosamente al correr'));
      console.log('  ' + dim('    el launcher search (ej: por permisos). Revisá los logs de la sesión hija.'));
    } else {
      console.log('  ' + yellow('  ⚠ Uso mixto: algunas tareas post-Memory tienen Previous insights, otras no.'));
      console.log('  ' + dim('    Puede ser intermitente — chequeá las que faltan, capaz fallaron por Qdrant down momentáneo.'));
    }
  }

  // ── 5. Cómo probar manualmente ───────────────────────────────────
  console.log('');
  console.log('  ' + bold('Cómo probar end-to-end manualmente'));
  console.log('  ' + dim('  Query semántica desde terminal:'));
  console.log('    ' + cyan('node vault/memory/.engine/launcher.mjs search "<tu query>"'));
  console.log('  ' + dim('  Activity en vivo (logs del container):'));
  console.log('    ' + cyan('docker logs -f phobos-qdrant'));
  console.log('  ' + dim('  Buscás líneas "POST /collections/.../points/search" o "/points" (upsert).'));

  console.log('');
  await pressEnterToContinue();
}

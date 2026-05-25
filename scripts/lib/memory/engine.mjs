// Memory engine — Qdrant global state + helpers que tocan ~/.phobos/ y el filesystem del proyecto.
//
// Layout nuevo (instalación global):
//   ~/.phobos/
//   ├── docker-compose.qdrant.yml         compose
//   ├── qdrant-storage/                   volumen Qdrant
//   └── memory-engine/                    engine RAG (scripts + node_modules)
//       ├── package.json
//       ├── .npmrc
//       ├── node_modules/
//       └── *.mjs (search, index-vault, list-memory, embed, chunk, qdrant-client, costs)
//
// El proyecto host solo recibe artefactos chicos en vault/memory/.engine/:
//   ├── config.json                       (collection name, vault roots)
//   ├── launcher.mjs                      (despacha al engine global)
//   └── .index-state.json                 (estado del indexador incremental, runtime)

import { readFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { cwd } from 'node:process';
import { TEMPLATES_DIR } from '../runtime.mjs';
import { fileExists, tryExec, safeWriteFile } from '../fs-utils.mjs';
import { cyan, dim, yellow } from '../colors.mjs';
import {
  PHOBOS_HOME,
  QDRANT_COMPOSE_GLOBAL,
  QDRANT_STORAGE_DIR,
  QDRANT_URL,
  QDRANT_CONTAINER,
  MEMORY_ENGINE_GLOBAL,
} from '../globals.mjs';

// Re-export para preservar la API previa que otros módulos importan desde engine.mjs.
export {
  PHOBOS_HOME,
  QDRANT_COMPOSE_GLOBAL,
  QDRANT_STORAGE_DIR,
  QDRANT_URL,
  QDRANT_CONTAINER,
  MEMORY_ENGINE_GLOBAL,
};

// Archivos del engine que viven GLOBALMENTE en <base>/memory-engine/.
// Estos son los scripts pesados con sus deps — se instalan una sola vez por
// usuario y se comparten entre todos los proyectos.
export const GLOBAL_ENGINE_FILES = [
  // src (relativo a TEMPLATES_DIR) → dst (relativo a MEMORY_ENGINE_GLOBAL)
  { src: 'phobos/memory/.engine/embed.mjs',          dst: 'embed.mjs' },
  { src: 'phobos/memory/.engine/chunk.mjs',          dst: 'chunk.mjs' },
  { src: 'phobos/memory/.engine/qdrant-client.mjs',  dst: 'qdrant-client.mjs' },
  { src: 'phobos/memory/.engine/index-vault.mjs',    dst: 'index-vault.mjs' },
  { src: 'phobos/memory/.engine/search.mjs',         dst: 'search.mjs' },
  { src: 'phobos/memory/.engine/list-memory.mjs',    dst: 'list-memory.mjs' },
  { src: 'phobos/memory/.engine/costs.mjs',          dst: 'costs.mjs' },
  { src: 'phobos/memory/.engine/README.md',          dst: 'README.md' },
  { src: 'phobos/memory/.engine/package.json',       dst: 'package.json' },
  { src: 'phobos/memory/.engine/.npmrc',             dst: '.npmrc' },
];

// Archivos que SÍ viven en el proyecto. Chicos, sin deps.
export const PROJECT_ENGINE_FILES = [
  { src: 'phobos/memory/.engine/config.json',        dst: 'vault/memory/.engine/config.json' },
  { src: 'phobos/memory/.engine/launcher.mjs',       dst: 'vault/memory/.engine/launcher.mjs' },
];

// Estado de Qdrant global. Devuelve { containerRunning, healthy }.
export async function detectQdrantStatus() {
  const ps = tryExec(
    `docker ps --filter name=${QDRANT_CONTAINER} --filter status=running --format "{{.Names}}"`,
    4000,
  );
  const containerRunning = ps.ok && ps.out.trim() === QDRANT_CONTAINER;

  let healthy = false;
  if (containerRunning) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const r = await fetch(`${QDRANT_URL}/healthz`, { signal: controller.signal });
      clearTimeout(timer);
      healthy = r.ok;
    } catch {
      healthy = false;
    }
  }

  return { containerRunning, healthy };
}

// Lee la lista de collections de Qdrant via REST. Vacío si no se puede.
export async function listQdrantCollections() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const r = await fetch(`${QDRANT_URL}/collections`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    const j = await r.json();
    return j?.result?.collections?.map(c => c.name) || [];
  } catch {
    return [];
  }
}

// Para cada collection, lee detalles (count, dims, distance).
export async function listQdrantCollectionsDetailed() {
  const names = await listQdrantCollections();
  const detailed = [];
  for (const name of names) {
    try {
      const r = await fetch(`${QDRANT_URL}/collections/${encodeURIComponent(name)}`);
      if (!r.ok) {
        detailed.push({ name, points: 0, dims: 0, distance: '?', status: '?' });
        continue;
      }
      const j = await r.json();
      const result = j?.result || {};
      detailed.push({
        name,
        points: result.points_count ?? 0,
        dims: result.config?.params?.vectors?.size ?? 0,
        distance: result.config?.params?.vectors?.distance ?? '?',
        status: result.status ?? '?',
      });
    } catch {
      detailed.push({ name, points: 0, dims: 0, distance: '?', status: '?' });
    }
  }
  return detailed;
}

// Devuelve hasta N points de una collection (con payload completo).
export async function getCollectionSamples(name, limit = 3) {
  try {
    const r = await fetch(`${QDRANT_URL}/collections/${encodeURIComponent(name)}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit, with_payload: true, with_vector: false }),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return j?.result?.points || [];
  } catch {
    return [];
  }
}

// Asegura que ~/.phobos/ exista (junction o real) con la estructura básica:
// docker-compose.qdrant.yml + qdrant-storage/. Idempotente.
//
// IMPORTANTE: las subcarpetas (qdrant-storage, memory-engine, codegraph) pueden
// ser junctions a otros discos — eso lo maneja storage.mjs en el flujo de
// install. Acá solo nos aseguramos que PHOBOS_HOME exista y tenga el compose.
export async function ensurePhobosHome() {
  await mkdir(PHOBOS_HOME, { recursive: true });
  // qdrant-storage puede ya ser junction; mkdir recursive es no-op en ese caso.
  await mkdir(QDRANT_STORAGE_DIR, { recursive: true });

  if (!await fileExists(QDRANT_COMPOSE_GLOBAL)) {
    const srcPath = join(TEMPLATES_DIR, 'phobos/memory/docker-compose.qdrant.yml');
    if (!await fileExists(srcPath)) {
      throw new Error(`Template no encontrado: ${srcPath}`);
    }
    const content = await readFile(srcPath, 'utf-8');
    await safeWriteFile(QDRANT_COMPOSE_GLOBAL, content, { allowedRoot: PHOBOS_HOME });
    return { created: true };
  }
  return { created: false };
}

// Asegura que <base>/memory-engine/ exista y tenga todos los scripts globales
// + el package.json + .npmrc. Idempotente (sobrescribe siempre — los scripts
// son nuestros, no del usuario).
//
// IMPORTANTE: NO instala node_modules acá. Eso lo hace deps.mjs.
export async function installMemoryEngineGlobalFiles() {
  await mkdir(MEMORY_ENGINE_GLOBAL, { recursive: true });
  for (const file of GLOBAL_ENGINE_FILES) {
    const srcPath = join(TEMPLATES_DIR, file.src);
    if (!await fileExists(srcPath)) {
      console.log(yellow(`  ⚠ template no encontrado: ${file.src}`));
      continue;
    }
    const content = await readFile(srcPath, 'utf-8');
    const dstPath = join(MEMORY_ENGINE_GLOBAL, file.dst);
    // allowedRoot=MEMORY_ENGINE_GLOBAL (no PHOBOS_HOME) — si PHOBOS_HOME es un
    // junction A→X y MEMORY_ENGINE_GLOBAL también es junction A→Y, la doble
    // resolución haría que el target escape el primer root. Usamos el root
    // propio del componente.
    await safeWriteFile(dstPath, content, { allowedRoot: MEMORY_ENGINE_GLOBAL });
    console.log(dim('  · ') + cyan(dstPath));
  }
}

// Escribe los artefactos chicos en el proyecto: config.json (con el collection
// slug específico) + launcher.mjs.
export async function writeProjectMemoryArtifacts(collectionName) {
  for (const file of PROJECT_ENGINE_FILES) {
    const srcPath = join(TEMPLATES_DIR, file.src);
    if (!await fileExists(srcPath)) {
      console.log(yellow(`  ⚠ template no encontrado: ${file.src}`));
      continue;
    }
    let content = await readFile(srcPath, 'utf-8');

    // Para config.json — substituir el collection name por el slug del proyecto.
    if (basename(file.src) === 'config.json') {
      const parsed = JSON.parse(content);
      parsed.qdrant.collection = collectionName;
      content = JSON.stringify(parsed, null, 2) + '\n';
    }

    await safeWriteFile(file.dst, content);
    console.log(dim('  · ') + cyan(file.dst));
  }
}

export async function appendGitignoreSnippet() {
  const gitignorePath = join(cwd(), '.gitignore');
  let existing = '';
  try { existing = await readFile(gitignorePath, 'utf-8'); } catch {}

  // Entradas canónicas del nuevo layout: solo .index-state.json runtime y
  // (defensivo) cualquier resto de node_modules de instalaciones legacy.
  const hasStateEntry = existing.includes('vault/memory/.engine/.index-state.json');
  const hasLegacyNodeModulesEntry = existing.includes('vault/memory/.engine/node_modules/');

  if (hasStateEntry && hasLegacyNodeModulesEntry) {
    console.log(dim('  · .gitignore ya tiene las entradas de memory.'));
    return;
  }

  const linesToAdd = [];
  if (!hasStateEntry) {
    linesToAdd.push('# Phobos memory engine — runtime state del indexador (no commitear)');
    linesToAdd.push('vault/memory/.engine/.index-state.json');
  }
  if (!hasLegacyNodeModulesEntry) {
    if (linesToAdd.length > 0) linesToAdd.push('');
    linesToAdd.push('# Defensa: si quedó algún node_modules legacy del install viejo');
    linesToAdd.push('vault/memory/.engine/node_modules/');
  }

  const joined = (existing.trim() + '\n\n' + linesToAdd.join('\n') + '\n').replace(/^\s+/, '');
  await safeWriteFile('.gitignore', joined);
  const addedCount = (hasStateEntry ? 0 : 1) + (hasLegacyNodeModulesEntry ? 0 : 1);
  console.log(dim(`  · .gitignore actualizado (${addedCount} entrada${addedCount > 1 ? 's' : ''} de memory)`));
}

// Detecta si el ~/.phobos/docker-compose.qdrant.yml tiene el bug viejo donde
// el volumen apuntaba a ./.qdrant_storage en vez de ./qdrant-storage.
export async function detectStaleStoragePath() {
  const result = {
    hasStalePath: false,
    oldDirExists: false,
    newDirExists: false,
    oldDir: join(PHOBOS_HOME, '.qdrant_storage'),
    newDir: join(PHOBOS_HOME, 'qdrant-storage'),
  };

  if (await fileExists(QDRANT_COMPOSE_GLOBAL)) {
    try {
      const content = await readFile(QDRANT_COMPOSE_GLOBAL, 'utf-8');
      result.hasStalePath = /\.\/\.qdrant_storage:/.test(content);
    } catch {}
  }

  result.oldDirExists = await fileExists(result.oldDir);
  result.newDirExists = await fileExists(result.newDir);

  return result;
}

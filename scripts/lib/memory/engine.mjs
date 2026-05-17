// Memory engine — Qdrant global state + helpers que tocan ~/.phobos/ y el filesystem del proyecto.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { cwd } from 'node:process';
import { TEMPLATES_DIR } from '../runtime.mjs';
import { fileExists, tryExec } from '../fs-utils.mjs';
import { cyan, dim, yellow } from '../colors.mjs';

// Path global donde vive la instancia compartida de Qdrant.
export const PHOBOS_HOME = join(homedir(), '.phobos');
export const QDRANT_COMPOSE_GLOBAL = join(PHOBOS_HOME, 'docker-compose.qdrant.yml');
export const QDRANT_URL = 'http://localhost:6333';
export const QDRANT_CONTAINER = 'phobos-qdrant';

// Engine files que se copian al proyecto destino. El docker-compose y el
// storage de Qdrant ya NO se copian al proyecto — viven globales en ~/.phobos/.
export const MEMORY_ENGINE_FILES = [
  // src (relativo a TEMPLATES_DIR) → dst (relativo al cwd del proyecto)
  { src: 'phobos/memory/.engine/config.json',         dst: 'vault/memory/.engine/config.json' },
  { src: 'phobos/memory/.engine/embed.mjs',           dst: 'vault/memory/.engine/embed.mjs' },
  { src: 'phobos/memory/.engine/chunk.mjs',           dst: 'vault/memory/.engine/chunk.mjs' },
  { src: 'phobos/memory/.engine/qdrant-client.mjs',   dst: 'vault/memory/.engine/qdrant-client.mjs' },
  { src: 'phobos/memory/.engine/index-vault.mjs',     dst: 'vault/memory/.engine/index-vault.mjs' },
  { src: 'phobos/memory/.engine/search.mjs',          dst: 'vault/memory/.engine/search.mjs' },
  { src: 'phobos/memory/.engine/README.md',           dst: 'vault/memory/.engine/README.md' },
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
    // Intenta el endpoint /healthz con timeout corto. fetch global (Node 18+).
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

// Asegura que ~/.phobos/ exista y tenga el docker-compose.qdrant.yml copiado.
// Idempotente: si ya existen, no los toca.
export async function ensurePhobosHome() {
  await mkdir(PHOBOS_HOME, { recursive: true });
  await mkdir(join(PHOBOS_HOME, 'qdrant-storage'), { recursive: true });

  if (!await fileExists(QDRANT_COMPOSE_GLOBAL)) {
    const srcPath = join(TEMPLATES_DIR, 'phobos/memory/docker-compose.qdrant.yml');
    if (!await fileExists(srcPath)) {
      throw new Error(`Template no encontrado: ${srcPath}`);
    }
    const content = await readFile(srcPath, 'utf-8');
    await writeFile(QDRANT_COMPOSE_GLOBAL, content);
    return { created: true };
  }
  return { created: false };
}

// Copia el engine al proyecto + reescribe config.json con el collection slug
// específico de este proyecto. Esto es lo que hace que cada proyecto tenga su
// propia "memoria" dentro de la instancia global de Qdrant.
export async function copyMemoryEngineToProject(collectionName) {
  for (const file of MEMORY_ENGINE_FILES) {
    const srcPath = join(TEMPLATES_DIR, file.src);
    const dstPath = join(cwd(), file.dst);
    if (!await fileExists(srcPath)) {
      console.log(yellow(`  ⚠ template no encontrado: ${file.src}`));
      continue;
    }
    await mkdir(dirname(dstPath), { recursive: true });
    let content = await readFile(srcPath, 'utf-8');

    // Para config.json — substituir el collection name por el slug del proyecto.
    if (basename(file.src) === 'config.json') {
      const parsed = JSON.parse(content);
      parsed.qdrant.collection = collectionName;
      content = JSON.stringify(parsed, null, 2) + '\n';
    }

    await writeFile(dstPath, content);
    console.log(dim('  · ') + cyan(file.dst));
  }
}

export async function appendGitignoreSnippet() {
  const snippetPath = join(TEMPLATES_DIR, 'phobos/memory/.gitignore.snippet');
  if (!await fileExists(snippetPath)) return;
  const snippet = await readFile(snippetPath, 'utf-8');
  const gitignorePath = join(cwd(), '.gitignore');
  let existing = '';
  try { existing = await readFile(gitignorePath, 'utf-8'); } catch {}
  if (existing.includes('vault/memory/.engine/.index-state.json')) {
    console.log(dim('  · .gitignore ya tiene la entrada de memory.'));
    return;
  }
  const joined = (existing.trim() + '\n\n' + snippet.trim() + '\n').replace(/^\s+/, '');
  await writeFile(gitignorePath, joined);
  console.log(dim('  · .gitignore actualizado con .index-state.json'));
}

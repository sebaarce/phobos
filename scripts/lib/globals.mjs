// Phobos global paths — single source of truth para dónde viven las
// instalaciones globales de Memory engine y CodeGraph.
//
// Layout:
//   ~/.phobos/                            (puede ser junction al disco elegido)
//   ├── docker-compose.qdrant.yml         compose Qdrant
//   ├── qdrant-storage/                   volumen Qdrant
//   ├── memory-engine/                    engine RAG global (scripts + node_modules)
//   └── codegraph/                        codegraph global (binario + node_modules)
//
// Cualquier subdirectorio puede ser independientemente un junction a otro
// disco. El código de Phobos siempre escribe a las rutas canónicas
// (~/.phobos/<algo>); la indirección la maneja el FS.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspectPath } from './storage.mjs';
import { fileExists } from './fs-utils.mjs';

// Base path canónico — siempre apunta a ~/.phobos, que puede ser real o junction.
export const PHOBOS_HOME = join(homedir(), '.phobos');

// Subdirs globales bajo PHOBOS_HOME.
export const QDRANT_STORAGE_DIR = join(PHOBOS_HOME, 'qdrant-storage');
export const QDRANT_COMPOSE_GLOBAL = join(PHOBOS_HOME, 'docker-compose.qdrant.yml');
export const MEMORY_ENGINE_GLOBAL = join(PHOBOS_HOME, 'memory-engine');
export const CODEGRAPH_GLOBAL = join(PHOBOS_HOME, 'codegraph');

// Constantes de Qdrant
export const QDRANT_URL = 'http://localhost:6333';
export const QDRANT_CONTAINER = 'phobos-qdrant';

// ═══════════════════════════════════════════════════════════════════
// Inspección de instalaciones existentes
// ═══════════════════════════════════════════════════════════════════

// Devuelve metadata del install global de Memory engine.
// { installed: bool, sizeBytes, target?: string, isJunction: bool }
export async function inspectMemoryEngineGlobal() {
  const info = await inspectPath(MEMORY_ENGINE_GLOBAL);
  const installed = info.exists && await fileExists(join(MEMORY_ENGINE_GLOBAL, 'node_modules', '@xenova', 'transformers'));
  return {
    path: MEMORY_ENGINE_GLOBAL,
    installed,
    isJunction: info.isLink,
    target: info.target,
    sizeBytes: info.sizeBytes,
  };
}

// Devuelve metadata del install global de CodeGraph.
export async function inspectCodeGraphGlobal() {
  const info = await inspectPath(CODEGRAPH_GLOBAL);
  const installed = info.exists && await fileExists(join(CODEGRAPH_GLOBAL, 'node_modules', '@colbymchenry', 'codegraph'));
  return {
    path: CODEGRAPH_GLOBAL,
    installed,
    isJunction: info.isLink,
    target: info.target,
    sizeBytes: info.sizeBytes,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Detección de instalaciones LEGACY (en el proyecto)
// ═══════════════════════════════════════════════════════════════════

// Detecta si el proyecto host tiene una instalación vieja de Memory engine
// embebida en vault/memory/.engine/node_modules/. Devuelve { exists, sizeBytes }.
export async function detectLegacyMemoryInstall(projectDir) {
  const legacyPath = join(projectDir, 'vault', 'memory', '.engine', 'node_modules');
  const info = await inspectPath(legacyPath);
  return {
    path: legacyPath,
    exists: info.exists && info.isDirectory,
    sizeBytes: info.sizeBytes,
  };
}

// Detecta si el proyecto host tiene una instalación vieja de CodeGraph
// embebida en .codegraph/node_modules/. Devuelve { exists, sizeBytes }.
export async function detectLegacyCodeGraphInstall(projectDir) {
  const legacyPath = join(projectDir, '.codegraph', 'node_modules');
  const info = await inspectPath(legacyPath);
  return {
    path: legacyPath,
    exists: info.exists && info.isDirectory,
    sizeBytes: info.sizeBytes,
  };
}

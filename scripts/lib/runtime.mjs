// Runtime singletons + constants compartidos por todos los módulos.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import readlineSync from 'node:readline';
import { stdin, stdout } from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// TEMPLATES_DIR vive en scripts/templates — este archivo está en scripts/lib/.
export const TEMPLATES_DIR = join(__dirname, '..', 'templates');

// Versión del CLI — leída del package.json del repo al cargar.
// Fallback "?.?.?" si por alguna razón el package.json no se puede leer
// (ej: instalación corrupta). No bloqueamos el arranque por esto.
export const PKG_VERSION = (() => {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '?.?.?';
  } catch {
    return '?.?.?';
  }
})();

export const AGENTS_DIR = '.opencode/agent';
export const AGENTS = ['phobos', 'researcher', 'planner', 'programmer', 'tester', 'archivist'];

// Habilitar keypress events para TUI
readlineSync.emitKeypressEvents(stdin);

// ═══════════════════════════════════════════════════════════════════
// Bootstrap — archivos que deben existir en el proyecto
// ═══════════════════════════════════════════════════════════════════

export const BOOTSTRAP_GROUPS = {
  agentes: [
    'opencode/agent/phobos.md',
    'opencode/agent/researcher.md',
    'opencode/agent/planner.md',
    'opencode/agent/programmer.md',
    'opencode/agent/tester.md',
    'opencode/agent/archivist.md',
    'opencode/agent/README.md',
  ],
  comandos: [
    'opencode/command/adapt-agents.md',
    'opencode/command/models-wizard.md',
    'opencode/command/reindex-memory.md',
    'opencode/command/list-memory.md',
  ],
  vault: [
    'vault/SCHEMA.md',
    'vault/TASKS.md',
    'vault/README.md',
    'vault/sources/.gitkeep',
    'vault/memory/tasks/.gitkeep',
    'vault/memory/insights/.gitkeep',
    'vault/memory/wiki/.gitkeep',
    'vault/memory/glossary/.gitkeep',
  ],
};

// Mapeo src (relativo a TEMPLATES_DIR) → dst (relativo a cwd)
export function srcToDst(srcPath) {
  // 'opencode/agent/phobos.md' → '.opencode/agent/phobos.md'
  // 'vault/SCHEMA.md' → 'vault/SCHEMA.md'
  if (srcPath.startsWith('opencode/')) return '.' + srcPath;
  return srcPath;
}

// Rol de cada agente (solo descriptivo para UI — los weights están en PROFILE_WEIGHTS).
export const AGENT_PROFILES = {
  phobos:     { role: 'orquestación' },
  planner:    { role: 'razonamiento' },
  programmer: { role: 'código' },
  researcher: { role: 'lectura rápida' },
  tester:     { role: 'tests, barato' },
  archivist:  { role: 'prosa, distilar' },
};

// readline para inputs de texto (filtros, manual paste). Para yes/no y menús usamos TUI.
export const rl = readline.createInterface({ input: stdin, output: stdout });

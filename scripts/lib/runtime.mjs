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

// Lista de agentes — IDE-agnostic. Estos 6 agentes existen en cualquier
// target del Phobos (OpenCode, Claude Code, etc.) con los mismos roles;
// solo cambia el formato del frontmatter, que lo maneja el adapter.
export const AGENTS = ['phobos', 'researcher', 'planner', 'programmer', 'tester', 'archivist'];

// Habilitar keypress events para TUI
readlineSync.emitKeypressEvents(stdin);

// ═══════════════════════════════════════════════════════════════════
// Nota: BOOTSTRAP_GROUPS, AGENTS_DIR y srcToDst() vivían acá hasta Fase 2.
// Ahora la verdad de qué archivos copia el bootstrap, y a qué paths del
// proyecto destino, vive en cada IDEAdapter (scripts/lib/adapters/*.mjs)
// vía adapter.bootstrapFiles() y adapter.agentDir.
// ═══════════════════════════════════════════════════════════════════

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

// Project root resolution — detecta mismatch entre `process.cwd()` y el git
// root, y le pregunta al user cuál usar cuando hay ambigüedad. Setea cwd al
// elegido vía `process.chdir()` para que el resto del wizard escriba en el
// lugar correcto sin tener que pasar la ruta por todos lados.
//
// También expone `ensureVaultScaffolding()` que mantiene la INVARIANTE:
// **vault/ vive en cwd, siempre**. Si no existe, se crea la estructura
// mínima (subdirs vacíos) para que cualquier subagente que escriba después
// no se tope con "dir no existe" y termine buscando por todos lados.
//
// Background:
//   En monorepos (ej: `payments-backoffice/` es el git root, pero el proyecto
//   real vive en `payments-backoffice/backoffice/`), `cwd()` y git root pueden
//   diferir según cómo se invocó el wizard. OpenCode + Claude Code suelen
//   setear cwd = workspace root = git root, NO el subdir donde el user "vive".
//   Si Phobos asume cwd ciegamente, escribe `vault/`, `.codegraph/`, etc. en
//   el git root en vez del proyecto real.
//
// Solución:
//   1. Compará cwd vs git root.
//   2. Si coinciden → todo OK, no preguntar.
//   3. Si difieren → mostrá ambos, sugerí cuál con un heurístico
//      (presencia de package.json/Cargo.toml/pom.xml/etc), pedí confirmación.
//   4. process.chdir() al elegido. Todo el resto del wizard usa cwd() normal.

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { cwd, chdir } from 'node:process';
import { execSync } from 'node:child_process';
import { tuiSelect, tuiYesNo } from './tui.mjs';
import { cyan, dim, yellow, green } from './colors.mjs';

// Archivos que típicamente identifican el root de un proyecto. Si están en cwd
// pero NO en git root, cwd casi seguro es el proyecto. Si están en git root
// pero NO en cwd, el usuario probablemente está en un subdir incorrecto.
const PROJECT_INDICATORS = [
  'package.json',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'composer.json',
  'Gemfile',
  'AGENTS.md',
  'pnpm-workspace.yaml',
  'turbo.json',
  'nx.json',
];

function hasProjectIndicator(dir) {
  try {
    return PROJECT_INDICATORS.some(f => existsSync(join(dir, f)));
  } catch {
    return false;
  }
}

function getGitRoot() {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    // git devuelve forward slashes en Windows también — normalizamos al sep nativo.
    return normalize(out);
  } catch {
    return null;
  }
}

function normalizePathForCompare(p) {
  return normalize(resolve(p)).replace(/\\$/, '').replace(/\/$/, '').toLowerCase();
}

/**
 * Resuelve el project root. Si cwd y git root difieren, pregunta al user.
 * Hace `process.chdir()` al elegido. Devuelve el path final.
 *
 * Opciones:
 *   - `silent: true` → no pregunta nunca, devuelve cwd como está.
 *   - `nonInteractive: true` → si hay mismatch, falla en vez de preguntar
 *     (útil para tests / CI). Default: false.
 *
 * Variable de entorno:
 *   - `PHOBOS_PROJECT_ROOT` → si está seteada, se usa directo (skip prompt).
 *     Útil para CI o para usuarios que quieren forzar un dir específico.
 *
 * Si el user cancela en el prompt, tira Error.
 */
export async function ensureProjectRoot({ silent = false, nonInteractive = false } = {}) {
  // Override por env var — gana sobre todo.
  const envOverride = process.env.PHOBOS_PROJECT_ROOT;
  if (envOverride) {
    const target = resolve(envOverride);
    if (!existsSync(target)) {
      throw new Error(`PHOBOS_PROJECT_ROOT apunta a un path inexistente: ${target}`);
    }
    if (normalizePathForCompare(target) !== normalizePathForCompare(cwd())) {
      chdir(target);
    }
    return target;
  }

  const current = cwd();

  if (silent) return current;

  const gitRoot = getGitRoot();
  if (!gitRoot) {
    // No es un repo git — usá cwd y listo.
    return current;
  }

  if (normalizePathForCompare(gitRoot) === normalizePathForCompare(current)) {
    // Coinciden — sin ambigüedad.
    return current;
  }

  // Mismatch. Analizar heurísticos.
  const cwdHasInd = hasProjectIndicator(current);
  const gitHasInd = hasProjectIndicator(gitRoot);

  // Decisión automática solo si está clarísimo: cwd tiene package.json + git root no.
  // En ese caso cwd es el proyecto, no preguntamos (caso típico de subdir-as-project).
  if (cwdHasInd && !gitHasInd) {
    return current;
  }

  // Caso opuesto: git root tiene el indicador, cwd no — user está en un subdir
  // dentro del proyecto (ej: dentro de `src/` por error). Sugerimos git root.
  // Pero igual preguntamos para no asumir sin permiso.

  if (nonInteractive) {
    throw new Error(
      `Project root ambiguo:\n  cwd:      ${current}\n  git root: ${gitRoot}\n` +
      `Pasá --project-root o setea PHOBOS_PROJECT_ROOT para resolver.`,
    );
  }

  // Preguntar al user
  console.log('');
  console.log('  ' + yellow('⚠ Tu directorio actual no coincide con el git root.'));
  console.log('  ' + dim('  Phobos va a escribir ') + cyan('vault/, .codegraph/, .opencode/')
    + dim(' adentro del dir que elijas — afecta dónde quedan los datos.'));
  console.log('');
  console.log('  ' + dim('cwd:      ') + cyan(current)
    + (cwdHasInd ? dim('  (tiene package.json/Cargo.toml/etc → parece proyecto)') : dim('  (sin indicadores de proyecto)')));
  console.log('  ' + dim('git root: ') + cyan(gitRoot)
    + (gitHasInd ? dim('  (tiene package.json/Cargo.toml/etc → parece proyecto)') : dim('  (sin indicadores de proyecto)')));
  console.log('');

  // Default del select: si solo git root tiene indicador, sugerimos git root;
  // sino, sugerimos cwd (lo más intuitivo — "donde estoy parado").
  const defaultIndex = (!cwdHasInd && gitHasInd) ? 1 : 0;

  const { index } = await tuiSelect(
    '¿Dónde está el project root real?',
    [
      `Usar cwd ${dim('→ ' + current)}`,
      `Usar git root ${dim('→ ' + gitRoot)}`,
      'Cancelar (no instalar nada todavía)',
    ],
    defaultIndex,
  );

  if (index === 2) {
    throw new Error('Cancelado: project root no resuelto. Re-corré desde el dir correcto.');
  }

  const chosen = index === 0 ? current : gitRoot;

  if (normalizePathForCompare(chosen) !== normalizePathForCompare(current)) {
    chdir(chosen);
    console.log('  ' + green('✓ ') + dim('cwd ahora es ') + cyan(chosen));
  } else {
    console.log('  ' + green('✓ ') + dim('Usando cwd actual: ') + cyan(chosen));
  }
  console.log('');

  return chosen;
}

// ═══════════════════════════════════════════════════════════════════
// Vault scaffolding — INVARIANTE de Phobos
//
// Regla: `vault/` vive en `cwd`. Siempre. Cualquier subagente que escriba
// vault usa paths relativos (`vault/memory/...`) y NUNCA busca en otros
// lados (parent dirs, ~/.config, subdirs random). Si vault no existe en
// cwd, NO se busca — se crea con esta función o se devuelve blocked.
//
// Esta función crea los subdirs mínimos necesarios (no archivos — los
// archivos los pone el archivist Bootstrap o se van escribiendo a medida
// que el flow SDD los necesita). Idempotente: si los dirs ya existen, no
// toca nada.
//
// La diferencia con archivist Bootstrap:
//   · Bootstrap escribe templates: SCHEMA.md, TASKS.md (con secciones),
//     README.md del vault, SECURITY.md, etc. ES contenido inicial completo.
//   · Esta función solo crea CARPETAS vacías. Es el piso mínimo para que
//     el archivist pueda escribir SIN equivocarse de dir.
//
// Por qué hacer ambos: el wizard se ejecuta en el shell del user (process
// limpio, paths confiables) — crear dirs es 100% determinista. El archivist
// corre en una sesión de subagente (cwd posiblemente confuso) y ha mostrado
// patrones de drift al crear estructura. Separar las dos cosas reduce el
// blast radius del drift.
// ═══════════════════════════════════════════════════════════════════

const VAULT_DIRS = [
  'vault',
  'vault/memory',
  'vault/memory/tasks',
  'vault/memory/insights',
  'vault/memory/wiki',
  'vault/memory/glossary',
  'vault/memory/research-queries',
  'vault/sources',
];

/**
 * Asegura que el scaffolding mínimo de vault/ exista en cwd. Idempotente.
 *
 * Opciones:
 *   - `silent: true` → si vault no existe, lo crea sin preguntar.
 *   - `prompt: true` (default) → si vault no existe, pregunta al user antes
 *     de crear. Útil para evitar crear vault/ por error en un dir random
 *     (ej: si ensureProjectRoot devolvió un dir equivocado).
 *
 * Devuelve `true` si vault está listo, `false` si el user canceló.
 */
export async function ensureVaultScaffolding({ silent = false, prompt = true } = {}) {
  const vaultPath = resolve(cwd(), 'vault');
  const vaultExists = existsSync(vaultPath);

  if (vaultExists) {
    // Verificar y completar subdirs faltantes (idempotente).
    let createdAny = false;
    for (const d of VAULT_DIRS) {
      const full = resolve(cwd(), d);
      if (!existsSync(full)) {
        await mkdir(full, { recursive: true });
        createdAny = true;
      }
    }
    if (createdAny) {
      console.log('  ' + green('✓ ') + dim('vault/ ya existía — completé subdirs faltantes en ') + cyan(vaultPath));
    }
    return true;
  }

  // vault/ no existe en cwd.
  if (!silent && prompt) {
    console.log('');
    console.log('  ' + yellow('ℹ ') + dim('No hay ') + cyan('vault/') + dim(' en este directorio:'));
    console.log('  ' + dim('  ') + cyan(cwd()));
    console.log('  ' + dim('  Phobos exige la INVARIANTE: vault/ vive en cwd. Si no existe acá,'));
    console.log('  ' + dim('  todos los agents van a fallar (o peor — explorar por todos lados).'));
    console.log('');
    const create = await tuiYesNo('¿Crear vault/ con el scaffolding mínimo ahora?', true);
    if (!create) {
      console.log('  ' + yellow('⊘ ') + dim('vault/ no creado. Los agents no van a poder operar.'));
      return false;
    }
  }

  // Crear todo el árbol de una.
  for (const d of VAULT_DIRS) {
    await mkdir(resolve(cwd(), d), { recursive: true });
  }
  console.log('  ' + green('✓ ') + dim('vault/ creado en ') + cyan(vaultPath));
  console.log('  ' + dim('    (subdirs: memory/{tasks,insights,wiki,glossary,research-queries}, sources/)'));
  console.log('  ' + dim('    Los archivos iniciales (TASKS.md, SCHEMA.md, etc.) los escribe el archivist en su próximo Bootstrap.'));
  return true;
}

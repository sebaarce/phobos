// Project root resolution — detecta mismatch entre `process.cwd()` y el git
// root, y le pregunta al user cuál usar cuando hay ambigüedad. Setea cwd al
// elegido vía `process.chdir()` para que el resto del wizard escriba en el
// lugar correcto sin tener que pasar la ruta por todos lados.
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
import { join, normalize, resolve, sep } from 'node:path';
import { cwd, chdir } from 'node:process';
import { execSync } from 'node:child_process';
import { tuiSelect } from './tui.mjs';
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

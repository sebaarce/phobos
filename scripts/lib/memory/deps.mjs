// Detección + instalación de deps de Memory (npm, peer-deps, etc).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd, platform } from 'node:process';
import { fileExists, tryExec, safeWriteFile } from '../fs-utils.mjs';
import { rl } from '../runtime.mjs';
import { cyan, dim, bold, green, yellow, red } from '../colors.mjs';
import { tuiSelect } from '../tui.mjs';
import { runChild } from '../child.mjs';

export function checkCommand(cmd) {
  // Run with shell:true so PATH resolution works on Windows.
  const r = tryExec(platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, 3000);
  return r.ok && r.out.trim().length > 0;
}

export async function readPackageJson() {
  try {
    const raw = await readFile(join(cwd(), 'package.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function detectPackageManager() {
  if (await fileExists('pnpm-lock.yaml')) return 'pnpm';
  if (await fileExists('yarn.lock')) return 'yarn';
  if (await fileExists('bun.lockb') || await fileExists('bun.lock')) return 'bun';
  return 'npm';
}

// Detecta stacks que históricamente requieren --legacy-peer-deps con NPM v7+
// (conflictos de peer dependencies habituales).
export async function detectProblematicStack() {
  const pkg = await readPackageJson();
  if (!pkg) return [];
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const indicators = [
    { stack: 'NestJS',       test: () => Object.keys(allDeps).some(k => k.startsWith('@nestjs/')) },
    { stack: 'Angular',      test: () => Object.keys(allDeps).some(k => k.startsWith('@angular/')) },
    { stack: 'Next.js',      test: () => 'next' in allDeps },
    { stack: 'React Native', test: () => 'react-native' in allDeps },
  ];
  return indicators.filter(i => i.test()).map(i => i.stack);
}

// Lee el .npmrc del proyecto y devuelve true si tiene legacy-peer-deps habilitado.
export async function checkNpmrcHasLegacyPeerDeps() {
  try {
    const content = await readFile(join(cwd(), '.npmrc'), 'utf-8');
    return /^\s*legacy-peer-deps\s*=\s*true/im.test(content);
  } catch {
    return false;
  }
}

// Persiste legacy-peer-deps=true en el .npmrc del proyecto (idempotente).
export async function addLegacyPeerDepsToNpmrc() {
  const npmrcPath = join(cwd(), '.npmrc');
  let existing = '';
  try {
    existing = await readFile(npmrcPath, 'utf-8');
  } catch {}
  if (/^\s*legacy-peer-deps\s*=\s*true/im.test(existing)) {
    return { added: false, reason: 'ya estaba' };
  }
  const snippet = '# Phobos Memory installer — NestJS/Angular peer-deps fix\nlegacy-peer-deps=true\n';
  const content = existing.trim()
    ? existing.trim() + '\n\n' + snippet
    : snippet;
  // .npmrc vive en cwd → safeWriteFile valida sandbox + rechaza symlinks.
  await safeWriteFile('.npmrc', content);
  return { added: true };
}

// Verifica si los paquetes de Memory están realmente presentes en node_modules.
// Lo usamos como segunda señal después del install — pnpm/npm pueden retornar
// exit code != 0 por warnings o por descargas parciales pero igual dejar los
// paquetes utilizables. Chequeamos también onnxruntime-node porque algunos
// package managers saltan optional deps y eso rompe el engine al runtime.
export async function verifyMemoryDepsInstalled() {
  const required = ['@xenova/transformers', '@qdrant/js-client-rest', 'onnxruntime-node'];
  const missing = [];
  for (const dep of required) {
    const pjPath = join(cwd(), 'node_modules', dep, 'package.json');
    if (!await fileExists(pjPath)) missing.push(dep);
  }
  return { ok: missing.length === 0, missing };
}

// Ejecuta el comando de install hasta que tenga éxito o el usuario cancele.
// Detecta errores comunes (ERESOLVE de NPM) y ofrece flags específicas
// (--legacy-peer-deps, --force) en el menú de reintento.
export async function installMemoryDepsWithRetry(pm, depList, initialFlags = []) {
  let currentPm = pm;
  let extraFlags = [...initialFlags];

  const installCmdFor = (m) => m === 'yarn' ? 'add'
                              : m === 'pnpm' ? 'add'
                              : m === 'bun' ? 'add'
                              : 'install';

  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) {
      console.log('');
      const flagsStr = extraFlags.length ? ' ' + extraFlags.join(' ') : '';
      console.log(dim(`  Reintento ${attempt - 1}/4 con ${currentPm}${flagsStr}...`));
    }

    const installCmd = installCmdFor(currentPm);
    const args = [installCmd, ...depList, ...extraFlags];
    const label = `Instalar deps (${currentPm}${extraFlags.length ? ' ' + extraFlags.join(' ') : ''})`;

    rl.pause();
    const exitCode = await runChild(currentPm, args, label);

    const verify = await verifyMemoryDepsInstalled();

    if (verify.ok) {
      if (exitCode !== 0) {
        console.log('');
        console.log(yellow(`  ⚠ ${currentPm} retornó exit code ${exitCode} pero los paquetes están en node_modules.`));
        console.log(dim('    Probablemente warnings de subdependencias deprecadas o de scripts opcionales.'));
        console.log(dim('    Continuamos — los paquetes principales están utilizables.'));
      }
      return { ok: true, exitCode, usedFlags: [...extraFlags], usedPm: currentPm };
    }

    // Falló y faltan paquetes
    console.log('');
    console.log(red(`  ✗ Faltan paquetes en node_modules: ${verify.missing.join(', ')}`));
    console.log(dim('    Exit code de ' + currentPm + ': ' + exitCode));
    console.log('');
    console.log('  ' + bold('Causas comunes:'));
    console.log('    ' + dim('· ') + yellow('Conflicto de peer dependencies (npm error ERESOLVE)') + dim(' — típico en proyectos NestJS/Angular.'));
    console.log('    ' + dim('  Fix: usar ') + cyan('--legacy-peer-deps') + dim(' (NPM lo sugiere en su propio output).'));
    console.log('    ' + dim('· Red/firewall bloqueando descarga de binarios nativos (onnxruntime).'));
    console.log('    ' + dim('· Antivirus interceptando archivos durante la descarga.'));
    console.log('    ' + dim('· Mirror de npm/pnpm temporal con problemas.'));
    console.log('    ' + dim('· Espacio en disco insuficiente (los paquetes pesan ~50-80 MB).'));
    console.log('');

    // Opciones del menú dependen del package manager actual.
    let options, handlers;
    if (currentPm === 'npm') {
      options = [
        'Reintentar con npm ' + green('--legacy-peer-deps') + dim('  (recomendado para ERESOLVE)'),
        'Reintentar con npm ' + yellow('--force') + dim('  (más agresivo, último recurso)'),
        'Reintentar con npm (sin flags adicionales)',
        'Cancelar instalación de Memory',
      ];
      handlers = [
        () => { extraFlags = ['--legacy-peer-deps']; },
        () => { extraFlags = ['--force']; },
        () => { extraFlags = []; },
        null, // cancel
      ];
    } else {
      options = [
        `Reintentar con ${currentPm} (sin cambios)`,
        'Cambiar a npm + ' + green('--legacy-peer-deps') + dim('  (recomendado para ERESOLVE)'),
        'Cambiar a npm (sin flags)',
        'Cancelar instalación de Memory',
      ];
      handlers = [
        () => { extraFlags = []; },
        () => { currentPm = 'npm'; extraFlags = ['--legacy-peer-deps']; },
        () => { currentPm = 'npm'; extraFlags = []; },
        null,
      ];
    }

    const choice = await tuiSelect('\n¿Qué hacés?', options, 0);
    const handler = handlers[choice.index];
    if (!handler) {
      return { ok: false, exitCode, missing: verify.missing };
    }
    handler();
  }

  return { ok: false, exitCode: -1, missing: ['(retries exhausted)'] };
}

// Detección + instalación de deps de Memory.
//
// Patrón nuevo (install GLOBAL): las deps viven en <base>/memory-engine/node_modules/
// (donde <base> es ~/.phobos/ o un junction al disco elegido). El proyecto host
// nunca tiene node_modules de Memory — solo config.json + launcher.mjs.
//
// Esto fixea Vite/bundlers que se confundían con los node_modules anidados en
// vault/memory/.engine/.

import { join } from 'node:path';
import { platform } from 'node:process';
import { fileExists, tryExec } from '../fs-utils.mjs';
import { rl } from '../runtime.mjs';
import { cyan, dim, bold, green, yellow, red } from '../colors.mjs';
import { tuiSelect } from '../tui.mjs';
import { runChild } from '../child.mjs';
import { MEMORY_ENGINE_GLOBAL } from '../globals.mjs';

export function checkCommand(cmd) {
  const r = tryExec(platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, 3000);
  return r.ok && r.out.trim().length > 0;
}

export async function detectPackageManager() {
  if (await fileExists('pnpm-lock.yaml')) return 'pnpm';
  if (await fileExists('yarn.lock')) return 'yarn';
  if (await fileExists('bun.lockb') || await fileExists('bun.lock')) return 'bun';
  return 'npm';
}

// Verifica si los paquetes están presentes en el install GLOBAL.
// El install legacy (en el proyecto) ya no se considera válido — el wizard
// debería haberlo migrado en la detección de legacy.
export async function verifyMemoryDepsInstalled() {
  const required = ['@xenova/transformers', '@qdrant/js-client-rest', 'onnxruntime-node'];
  const missing = [];
  for (const dep of required) {
    const pjPath = join(MEMORY_ENGINE_GLOBAL, 'node_modules', dep, 'package.json');
    if (!await fileExists(pjPath)) missing.push(dep);
  }
  return {
    ok: missing.length === 0,
    missing,
    location: missing.length === 0 ? 'global' : null,
  };
}

// Instala las deps del engine en <base>/memory-engine/. Siempre usa npm —
// el .npmrc local del engine fuerza buena conducta (hoisted + legacy-peer-deps).
export async function installMemoryDepsWithRetry(_pmIgnored = 'npm', _depListUnused = null, initialFlags = []) {
  let extraFlags = [...initialFlags];

  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) {
      console.log('');
      const flagsStr = extraFlags.length ? ' ' + extraFlags.join(' ') : '';
      console.log(dim(`  Reintento ${attempt - 1}/4 con npm${flagsStr}...`));
    }

    const args = ['install', ...extraFlags];
    const label = `Instalar deps Memory global (npm${extraFlags.length ? ' ' + extraFlags.join(' ') : ''})`;

    rl.pause();
    const exitCode = await runChild('npm', args, label, { cwd: MEMORY_ENGINE_GLOBAL });

    const verify = await verifyMemoryDepsInstalled();

    if (verify.ok) {
      if (exitCode !== 0) {
        console.log('');
        console.log(yellow(`  ⚠ npm retornó exit code ${exitCode} pero los paquetes están en node_modules.`));
        console.log(dim('    Probablemente warnings de subdependencias deprecadas.'));
        console.log(dim('    Continuamos — los paquetes principales están utilizables.'));
      }
      return { ok: true, exitCode, usedFlags: [...extraFlags], usedPm: 'npm' };
    }

    console.log('');
    console.log(red(`  ✗ Faltan paquetes en ${MEMORY_ENGINE_GLOBAL}/node_modules: ${verify.missing.join(', ')}`));
    console.log(dim('    Exit code de npm: ' + exitCode));
    console.log('');
    console.log('  ' + bold('Causas comunes:'));
    console.log('    ' + dim('· Red/firewall bloqueando descarga de binarios nativos (onnxruntime).'));
    console.log('    ' + dim('· Antivirus interceptando archivos durante la descarga.'));
    console.log('    ' + dim('· Mirror de npm temporal con problemas.'));
    console.log('    ' + dim('· Espacio en disco insuficiente (los paquetes pesan ~50-80 MB).'));
    console.log('');

    const options = [
      'Reintentar con npm ' + green('--legacy-peer-deps'),
      'Reintentar con npm ' + yellow('--force'),
      'Reintentar con npm (sin flags adicionales)',
      'Cancelar instalación de Memory',
    ];
    const handlers = [
      () => { extraFlags = ['--legacy-peer-deps']; },
      () => { extraFlags = ['--force']; },
      () => { extraFlags = []; },
      null,
    ];

    const choice = await tuiSelect('\n¿Qué hacés?', options, 0);
    const handler = handlers[choice.index];
    if (!handler) {
      return { ok: false, exitCode, missing: verify.missing };
    }
    handler();
  }

  return { ok: false, exitCode: -1, missing: ['(retries exhausted)'] };
}

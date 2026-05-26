// Tools — autoskills, obsidian-skills, impeccable, codegraph, opencode.
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd, platform } from 'node:process';
import { rl } from './runtime.mjs';
import { fileExists, rmrf, safeWriteFile, formatBytes } from './fs-utils.mjs';
import { cyan, bold, dim, yellow, green, red } from './colors.mjs';
import { tuiSelect, tuiMultiSelect, tuiYesNo, panel, clearScreen } from './tui.mjs';
import { runChild } from './child.mjs';
import { printToolsBanner, showHappyGoodbye } from './banners.mjs';
import { finalizeAndExit, pressEnterToContinue } from './exit.mjs';
import { detectPackageManager } from './memory/deps.mjs';
import {
  PHOBOS_HOME,
  CODEGRAPH_GLOBAL,
  detectLegacyCodeGraphInstall,
} from './globals.mjs';
import { promptStorageDisk, ensureLinkTo, printVerificationCommands } from './storage.mjs';

export async function installObsidianSkills() {
  // Instalación per-proyecto vía Skills CLI (npx skills add).
  // El ecosistema instala cada skill individualmente en .agents/skills/<skill>/SKILL.md
  // que es donde OpenCode realmente auto-descubre los SKILL.md.

  console.log('\n' + cyan('▸ ') + bold('Instalar obsidian-skills (per-proyecto vía Skills CLI)'));
  console.log(dim('  destino: .agents/skills/<skill>/  (en este proyecto)'));
  console.log(dim('  fuente:  github.com/kepano/obsidian-skills'));
  console.log('');

  const skillsToInstall = [
    { id: 'obsidian-markdown',  desc: 'wikilinks, callouts, embeds, properties' },
    { id: 'obsidian-bases',     desc: 'archivos .base (filtros, fórmulas, vistas)' },
    { id: 'json-canvas',        desc: '.canvas (diagramas con nodos/edges)' },
    { id: 'obsidian-cli',       desc: 'queries al vault desde CLI' },
    { id: 'defuddle',           desc: 'extraer markdown limpio de URLs' },
  ];

  const { index } = await tuiSelect(
    '¿Cuáles instalar?',
    [
      `Las 5 ${dim('(obsidian-markdown, obsidian-bases, json-canvas, obsidian-cli, defuddle)')}`,
      'Elegir cuáles (multi-select)',
      'Cancelar',
    ],
    0,
  );

  if (index === 2) {
    console.log(dim('  ⊘ saltado.\n'));
    return;
  }

  let selected;
  if (index === 0) {
    selected = skillsToInstall.map(s => s.id);
  } else {
    const picks = await tuiMultiSelect(
      '\nMarcá las que querés instalar:',
      skillsToInstall.map(s => ({ value: s.id, label: s.id + '  ' + dim('— ' + s.desc) })),
      ['obsidian-markdown', 'obsidian-bases', 'json-canvas'],
    );
    selected = picks;
  }

  if (selected.length === 0) {
    console.log(dim('\n  ⊘ ninguna seleccionada.\n'));
    return;
  }

  console.log(dim('\n  Instalando ' + selected.length + ' skill(s)...'));

  for (const skill of selected) {
    const pkg = `kepano/obsidian-skills@${skill}`;
    await runChild('npx', ['skills', 'add', pkg, '-y'], `Instalar ${skill}`);
  }

  console.log(dim('\n  OpenCode auto-descubrirá los SKILL.md al reiniciar.'));
  console.log(dim('  Verificá con:  ') + cyan('opencode debug skill'));
  console.log(dim('  Tip: si no querés commitear las skills, agregá a .gitignore:'));
  console.log(dim('    echo ".agents/skills/" >> .gitignore\n'));
}

export async function installImpeccable(adapter) {
  // Impeccable — skill de diseño (pbakaus/impeccable).
  const skillDir = adapter && adapter.skillDirs && adapter.skillDirs[0]
    ? adapter.skillDirs[0]
    : '.opencode/skills';
  const dest = join(skillDir, 'impeccable');

  console.log('\n' + cyan('▸ ') + bold('Instalar Impeccable (skill de diseño per-proyecto)'));
  console.log(dim('  destino: ' + dest + '/  (en este proyecto)'));
  console.log(dim('  fuente:  github.com/pbakaus/impeccable'));
  console.log(dim('  qué hace: vocabulario + 27 anti-patterns + workflows de auditoría de UI.'));
  console.log('');

  const { index } = await tuiSelect(
    '¿Instalar impeccable en este proyecto?',
    [
      `Sí, instalar  ${dim('(git clone + copy a ' + dest + '/)')}`,
      'Cancelar',
    ],
    0,
  );

  if (index === 1) {
    console.log(dim('  ⊘ saltado.\n'));
    return;
  }

  if (await fileExists(dest)) {
    const { index: overwriteIdx } = await tuiSelect(
      `Ya existe ${dest}. ¿Sobrescribir?`,
      ['Sobrescribir (borra el existente y reinstala)', 'Cancelar'],
      1,
    );
    if (overwriteIdx === 1) {
      console.log(dim('  ⊘ saltado.\n'));
      return;
    }
  }

  await mkdir(skillDir, { recursive: true }).catch(() => {});

  const tmpDir = '.tmp-impeccable-' + Date.now();
  const cloneCode = await runChild(
    'git',
    ['clone', '--depth', '1', 'https://github.com/pbakaus/impeccable.git', tmpDir],
    'Clonar impeccable (shallow)',
  );
  if (cloneCode !== 0) {
    console.log(yellow('  ⚠ Falló el git clone. Verificá que git esté en PATH y haya internet.\n'));
    return;
  }

  const src = join(tmpDir, '.opencode', 'skills', 'impeccable');
  if (!await fileExists(src)) {
    console.log(yellow(`  ⚠ El repo clonado no tiene ${src}. Quizás el upstream cambió.\n`));
    await rmrf(tmpDir);
    return;
  }

  if (await fileExists(dest)) await rmrf(dest);

  const copyCmd = platform === 'win32'
    ? { cmd: 'xcopy', args: [src.replace(/\//g, '\\'), dest.replace(/\//g, '\\'), '/E', '/I', '/Y', '/Q'] }
    : { cmd: 'cp', args: ['-r', src, dest] };

  const copyCode = await runChild(copyCmd.cmd, copyCmd.args, `Copiar ${dest}/`);
  await rmrf(tmpDir);

  if (copyCode !== 0) {
    console.log(yellow('  ⚠ Falló la copia. Revisá permisos.\n'));
    return;
  }

  console.log(green('\n  ✓ Impeccable instalado en ') + cyan(dest));
  console.log(dim('\n  El IDE auto-descubrirá la skill al reiniciar.'));
  console.log(dim('  Tip CLI extra (sin instalar):  ') + cyan('npx impeccable detect src/'));
  console.log(dim('  Tip: si no querés commitear la skill, agregá a .gitignore:'));
  console.log(dim('    echo "' + dest + '/" >> .gitignore\n'));
}

// ═══════════════════════════════════════════════════════════════════
// CodeGraph — install GLOBAL.
//
// Layout nuevo:
//   <base>/codegraph/                  ← global, compartido entre proyectos
//   ├── package.json                   ← manifest aislado
//   ├── .npmrc                         ← ignore-workspace + flat
//   ├── node_modules/                  ← @colbymchenry/codegraph
//   └── cg.cjs                         ← shim de invocación (createRequire)
//
//   <project>/.codegraph/              ← per-project (chico)
//   ├── launcher.mjs                   ← despacha al shim global con cwd=project
//   ├── config.json                    ← creado por `codegraph init`
//   └── codegraph.db                   ← creado por `codegraph index`
// ═══════════════════════════════════════════════════════════════════

const CODEGRAPH_PKG = '@colbymchenry/codegraph';
const CODEGRAPH_PKG_MARKER = join(CODEGRAPH_GLOBAL, 'node_modules', '@colbymchenry', 'codegraph', 'package.json');

// Shim global — vive con el install global. Usa createRequire para resolver
// el bin del paquete sin asumir layout específico (flat npm vs hoisted pnpm).
const CODEGRAPH_SHIM_GLOBAL = join(CODEGRAPH_GLOBAL, 'cg.cjs');

// Per-project: launcher chico que despacha al shim global con cwd=project.
const CODEGRAPH_LAUNCHER_LOCAL = '.codegraph/launcher.mjs';

// Crea el shim GLOBAL (en <base>/codegraph/cg.cjs). Sobreescribe siempre.
async function ensureCodeGraphShimGlobal() {
  const shim = `// Stable invocation shim for CodeGraph — generated by Phobos.
// Vive en ${CODEGRAPH_GLOBAL}/cg.cjs (instalación global).
//
// Uses Node's createRequire so the package resolves correctly regardless of
// whether the package manager produced a flat node_modules (npm/yarn classic),
// a symlinked layout (pnpm default), or PnP (yarn berry).
const { createRequire } = require('node:module');
const { join } = require('node:path');

const req = createRequire(join(__dirname, 'package.json'));

let pkgPath;
try {
  pkgPath = req.resolve('@colbymchenry/codegraph/package.json');
} catch (err) {
  console.error('[cg.cjs] No pude resolver @colbymchenry/codegraph desde', __dirname);
  console.error('         Reinstalá con:  cd', __dirname, '&&  npm install');
  process.exit(1);
}

const pkg = require(pkgPath);
let entry;
if (typeof pkg.bin === 'string') {
  entry = pkg.bin;
} else if (pkg.bin && typeof pkg.bin === 'object') {
  entry = pkg.bin.codegraph || Object.values(pkg.bin)[0];
}
if (!entry) {
  console.error('[cg.cjs] No pude resolver bin entry desde package.json de @colbymchenry/codegraph');
  process.exit(1);
}

require(join(pkgPath, '..', entry));
`;
  await mkdir(CODEGRAPH_GLOBAL, { recursive: true });
  await safeWriteFile(CODEGRAPH_SHIM_GLOBAL, shim, { allowedRoot: CODEGRAPH_GLOBAL });
}

// Crea el manifest global (<base>/codegraph/package.json).
async function ensureCodeGraphHostManifestGlobal() {
  const manifestPath = join(CODEGRAPH_GLOBAL, 'package.json');
  await mkdir(CODEGRAPH_GLOBAL, { recursive: true });
  if (await fileExists(manifestPath)) return { created: false };

  const manifest = {
    name: 'phobos-codegraph-host',
    private: true,
    version: '0.0.0',
    description: 'Phobos global install of @colbymchenry/codegraph. Shared across projects via launcher.mjs in each .codegraph/.',
    dependencies: {
      [CODEGRAPH_PKG]: 'latest',
    },
  };
  await safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { allowedRoot: CODEGRAPH_GLOBAL });
  return { created: true };
}

// Crea el .npmrc global (<base>/codegraph/.npmrc).
async function ensureCodeGraphNpmrcGlobal() {
  const npmrcPath = join(CODEGRAPH_GLOBAL, '.npmrc');
  if (await fileExists(npmrcPath)) return { created: false };
  const content = [
    '# Phobos CodeGraph global install — flat layout + workspace isolation.',
    'ignore-workspace=true',
    'node-linker=hoisted',
    'shamefully-hoist=true',
    '',
  ].join('\n');
  await safeWriteFile(npmrcPath, content, { allowedRoot: CODEGRAPH_GLOBAL });
  return { created: true };
}

// Escribe el launcher per-proyecto en .codegraph/launcher.mjs.
async function writeProjectCodeGraphLauncher() {
  await mkdir('.codegraph', { recursive: true });
  const content = `#!/usr/bin/env node
// Phobos CodeGraph launcher (per-project).
//
// Este archivo es chico a propósito — el binario + node_modules viven
// globalmente en ~/.phobos/codegraph/. Acá solo despachamos con cwd=proyecto
// para que codegraph lea .codegraph/config.json y escriba .codegraph/codegraph.db
// localmente.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CG_GLOBAL = join(homedir(), '.phobos', 'codegraph');
const CG_SHIM = join(CG_GLOBAL, 'cg.cjs');

if (!existsSync(CG_SHIM)) {
  console.error(\`[phobos-codegraph] global no instalado en \${CG_GLOBAL}\`);
  console.error('[phobos-codegraph]  reinstalá con: npx github:sebaarce/phobos → Tools → CodeGraph');
  process.exit(1);
}

const result = spawn(process.execPath, [CG_SHIM, ...process.argv.slice(2)], {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
});
result.on('exit', code => process.exit(code ?? 1));
`;
  await safeWriteFile(CODEGRAPH_LAUNCHER_LOCAL, content);
}

// Versión "user-friendly" del path para mostrar en mensajes.
const CODEGRAPH_BIN_DISPLAY = `node ${CODEGRAPH_LAUNCHER_LOCAL}`;

// Detecta si CodeGraph ya está instalado global Y configurado en este proyecto.
export async function detectCodeGraphStatus() {
  const pkgInstalled = await fileExists(CODEGRAPH_PKG_MARKER);
  const launcherReady = await fileExists(CODEGRAPH_LAUNCHER_LOCAL);
  const projectInitialized = await fileExists('.codegraph');
  const dbBuilt = await fileExists('.codegraph/codegraph.db');

  let sizeMB = null;
  let lastIndexedAt = null;
  if (dbBuilt) {
    try {
      const { stat } = await import('node:fs/promises');
      const s = await stat(join(cwd(), '.codegraph/codegraph.db'));
      sizeMB = Math.round((s.size / (1024 * 1024)) * 10) / 10;
      lastIndexedAt = s.mtime;
    } catch {}
  }

  return { pkgInstalled, projectInitialized, shimReady: launcherReady, dbBuilt, sizeMB, lastIndexedAt };
}

// Asegura que `.codegraph/` esté listado en .gitignore.
async function ensureCodeGraphInGitignore() {
  const path = '.gitignore';
  let existing = '';
  try {
    existing = await readFile(join(cwd(), path), 'utf-8');
  } catch {}

  const alreadyListed = /^\s*\.codegraph\/?\s*$/m.test(existing);
  if (alreadyListed) return { added: false };

  // Estrategia nueva: ignoramos todo .codegraph/ EXCEPTO el launcher.mjs.
  // El launcher es chico, generado, y debería viajar con el proyecto para
  // que el agente lo invoque. La DB y el config son runtime/per-machine.
  const snippet = [
    '',
    '# Phobos CodeGraph — runtime/per-machine (no commitear DB ni config local).',
    '.codegraph/*',
    '!.codegraph/launcher.mjs',
    '',
  ].join('\n');
  const content = existing.endsWith('\n') || existing === ''
    ? existing + snippet
    : existing + '\n' + snippet;
  await safeWriteFile(path, content);
  return { added: true };
}

// Flujo completo de install / re-index / re-install para CodeGraph (GLOBAL).
//
// El install se divide en dos partes:
//   1. GLOBAL — siempre se hace, vive en ~/.phobos/codegraph/. Independiente
//      del cwd. Acá va el paquete, node_modules y el shim. Se puede correr
//      desde cualquier carpeta (no requiere proyecto válido).
//   2. PER-PROJECT — solo se hace si el cwd parece un proyecto (.git, package.json,
//      o AGENTS.md). Acá va el .codegraph/launcher.mjs, config y DB.
//
// Esto permite "instalar CodeGraph globalmente una vez" desde el home, y
// después ir a cada proyecto y hacer solo la parte per-project.
export async function installCodeGraph() {
  console.log('\n' + cyan('▸ ') + bold('CodeGraph — índice semántico del código (install global)'));
  console.log(dim('  paquete: ' + CODEGRAPH_PKG + '  →  ' + join(CODEGRAPH_GLOBAL, 'node_modules') + '/'));
  console.log(dim('  fuente:  github.com/colbymchenry/codegraph'));
  console.log(dim('  qué hace: AST + grafo de relaciones; reduce ~94% los tool calls del researcher.'));
  console.log(dim('  ⚡ Binario GLOBAL — el proyecto solo recibe .codegraph/launcher.mjs + DB (si hay proyecto).'));
  console.log('');

  // Detectamos si el cwd parece un proyecto. Si NO, hacemos solo la parte
  // global y avisamos al usuario. Esto NO bloquea — la parte global se
  // puede instalar desde cualquier lado.
  const inProject = await fileExists('.git')
    || await fileExists('package.json')
    || await fileExists('AGENTS.md');

  if (!inProject) {
    console.log(yellow('  ℹ Este directorio no parece un proyecto (sin .git, package.json o AGENTS.md).'));
    console.log(dim('    Voy a hacer SOLO la instalación global. Para configurar CodeGraph en un'));
    console.log(dim('    proyecto, andá a la raíz del repo y re-corré el wizard → CodeGraph.'));
    console.log('');
  }

  const status = await detectCodeGraphStatus();

  // ─── Decisión rápida si ya está todo OK ────────────────────────────
  if (status.pkgInstalled && status.shimReady && status.dbBuilt && inProject) {
    const { index } = await tuiSelect(
      'CodeGraph ya está instalado e indexado en este proyecto. ¿Qué hacer?',
      [
        'Re-indexar (recomendado si el código cambió mucho)',
        'Re-instalar el paquete global (forzar actualización)',
        'Desinstalar ' + dim('(per-proyecto / global / completo)'),
        'Cancelar',
      ],
      0,
    );
    if (index === 3) {
      console.log(dim('  ⊘ saltado.\n'));
      return;
    }
    if (index === 0) {
      console.log(dim('\n  Re-indexando — puede tardar varios minutos en repos grandes.\n'));
      const code = await runChild('node', [CODEGRAPH_LAUNCHER_LOCAL, 'index'], 'Re-indexar CodeGraph');
      if (code === 0) {
        console.log(green('\n  ✓ Re-indexación completa.\n'));
      } else {
        console.log(yellow(`\n  ⚠ codegraph index exit code ${code}.\n`));
      }
      return;
    }
    if (index === 2) {
      await uninstallCodeGraph();
      return;
    }
    // index === 1: continúa al flujo normal (reinstala el paquete global).
  } else if (status.pkgInstalled && !status.dbBuilt && inProject) {
    console.log(dim('  ℹ Paquete global instalado pero sin indexar todavía. Voy a configurar el proyecto + indexar.\n'));
  } else if (status.pkgInstalled && !inProject) {
    // Global ya instalado, sin proyecto activo. Ofrecer re-install / uninstall.
    const { index } = await tuiSelect(
      'CodeGraph global ya está instalado. Sin proyecto en cwd, no hay configuración local que hacer.',
      [
        'Re-instalar el paquete global (forzar actualización)',
        'Desinstalar ' + dim('(global completo)'),
        'Cancelar',
      ],
      2,
    );
    if (index === 2) return;
    if (index === 1) {
      await uninstallCodeGraph();
      return;
    }
    // index === 0: cae al flujo normal y reinstala.
  } else {
    const promptMsg = inProject
      ? '¿Instalar CodeGraph (global) y configurar este proyecto?'
      : '¿Instalar CodeGraph globalmente (sin configurar ningún proyecto)?';
    const confirm = await tuiYesNo(promptMsg, true);
    if (!confirm) {
      console.log(dim('  ⊘ saltado.\n'));
      return;
    }
  }

  // ─── Step: Detectar legacy install en el proyecto (solo si hay proyecto) ────
  if (inProject) {
  const legacy = await detectLegacyCodeGraphInstall(cwd());
  if (legacy.exists) {
    console.log(yellow('  ⚠ Detecté instalación legacy en ') + cyan(legacy.path) +
                dim(' (' + formatBytes(legacy.sizeBytes) + ')'));
    console.log(dim('    Causa: install viejo cuando CodeGraph vivía dentro del proyecto.'));
    console.log(dim('    El nuevo va a ' + CODEGRAPH_GLOBAL + '/ — el del proyecto sobra.'));
    const clean = await tuiYesNo('  ¿Borrar el node_modules legacy del proyecto?', true);
    if (clean) {
      await rmrf(legacy.path);
      // También borramos el .codegraph/package.json legacy y .npmrc si existen
      // (eran del install aislado viejo, ahora viven global).
      const legacyManifest = join(cwd(), '.codegraph', 'package.json');
      const legacyNpmrc = join(cwd(), '.codegraph', '.npmrc');
      const legacyShim = join(cwd(), '.codegraph', 'cg.cjs');
      if (await fileExists(legacyManifest)) await rmrf(legacyManifest);
      if (await fileExists(legacyNpmrc)) await rmrf(legacyNpmrc);
      if (await fileExists(legacyShim)) await rmrf(legacyShim);
      console.log(green('  ✓ ') + dim('Legacy borrado (node_modules + manifest + .npmrc + cg.cjs).'));
    } else {
      console.log(yellow('  Mantenido. El install global se hace igual; el legacy queda como peso muerto.'));
    }
  }
  } // ← fin del if (inProject) para legacy detection

  // ─── Step: Storage location prompt ──────────────────────────────────
  console.log('');
  const storage = await promptStorageDisk({
    componentName: 'CodeGraph (node_modules + binario)',
    defaultLabel: `${CODEGRAPH_GLOBAL} (default — disco del home)`,
    suggestedSubdir: 'phobos\\codegraph',
  });

  if (storage.mode === 'custom') {
    try {
      await ensureLinkTo({
        linkPath: CODEGRAPH_GLOBAL,
        targetPath: storage.basePath,
        componentName: 'CodeGraph global',
      });
    } catch (e) {
      console.log(red('  ✗ ' + e.message));
      console.log(dim('  Reintentá el install cuando lo resuelvas.\n'));
      return;
    }
  }

  // ─── Step: Crear manifest + .npmrc + shim globales ──────────────────
  await mkdir(CODEGRAPH_GLOBAL, { recursive: true });

  const m = await ensureCodeGraphHostManifestGlobal();
  console.log((m.created ? green('  ✓ ') : dim('  ℹ ')) +
              dim((m.created ? 'Creé ' : 'Reuso ') + 'manifest global: ') +
              cyan(join(CODEGRAPH_GLOBAL, 'package.json')));

  const npmrc = await ensureCodeGraphNpmrcGlobal();
  console.log((npmrc.created ? green('  ✓ ') : dim('  ℹ ')) +
              dim((npmrc.created ? 'Creé ' : 'Reuso ') + '.npmrc global: ') +
              cyan(join(CODEGRAPH_GLOBAL, '.npmrc')));

  // ─── Step: npm install en el global ─────────────────────────────────
  const projectPm = await detectPackageManager();
  console.log(dim('\n  Project package manager: ') + cyan(projectPm) + dim('  (no afecta — uso npm para el install global)') + '\n');

  rl.pause();
  const installCode = await runChild(
    'npm', ['install'],
    `Instalar ${CODEGRAPH_PKG} (global con npm en ${CODEGRAPH_GLOBAL}/)`,
    { cwd: CODEGRAPH_GLOBAL },
  );
  if (installCode !== 0) {
    const verify = await detectCodeGraphStatus();
    if (!verify.pkgInstalled) {
      console.log(red(`\n  ✗ Falló la instalación con npm (exit ${installCode}).`));
      console.log(dim('    Probá manualmente: ') + cyan(`cd "${CODEGRAPH_GLOBAL}" && npm install`));
      console.log('');
      return;
    }
    console.log(yellow(`\n  ⚠ npm retornó exit ${installCode} pero el paquete está. Continuamos.\n`));
  } else {
    console.log(green(`\n  ✓ ${CODEGRAPH_PKG} instalado en ${CODEGRAPH_GLOBAL}/node_modules/\n`));
  }

  // ─── Step: Generar shim global ──────────────────────────────────────
  await ensureCodeGraphShimGlobal();
  console.log(green('  ✓ ') + dim('Shim global regenerado: ') + cyan(CODEGRAPH_SHIM_GLOBAL));

  // ─── Steps per-project (solo si estamos en un proyecto) ─────────────
  if (inProject) {
    await writeProjectCodeGraphLauncher();
    console.log(green('  ✓ ') + dim('Launcher escrito en el proyecto: ') + cyan(CODEGRAPH_LAUNCHER_LOCAL));

    // codegraph init (genera .codegraph/config.json)
    if (!await fileExists('.codegraph/config.json') && !await fileExists('.codegraph/config.yaml')) {
      const initCode = await runChild(
        'node', [CODEGRAPH_LAUNCHER_LOCAL, 'init'],
        'Inicializar CodeGraph (.codegraph/config.json)',
      );
      if (initCode !== 0) {
        console.log(yellow(`\n  ⚠ codegraph init falló (exit ${initCode}). Probá manualmente:`));
        console.log(dim('    ') + cyan(`node ${CODEGRAPH_LAUNCHER_LOCAL} init -i`));
        console.log('');
      } else {
        console.log(green('\n  ✓ Config generada en .codegraph/\n'));
      }
    } else {
      console.log(dim('  ℹ .codegraph/ ya tiene config — salteo init.\n'));
    }

    // .gitignore
    const gi = await ensureCodeGraphInGitignore();
    if (gi.added) {
      console.log(green('  ✓ ') + dim('Actualicé ') + cyan('.gitignore') + dim(' (ignora .codegraph/ excepto launcher.mjs)'));
    } else {
      console.log(dim('  ℹ .codegraph/ ya estaba en .gitignore'));
    }
    console.log('');

    // Indexación inicial
    const wantIndex = await tuiYesNo(
      '¿Correr indexación inicial ahora? (puede tardar varios minutos en repos grandes)',
      true,
    );
    if (wantIndex) {
      const indexCode = await runChild('node', [CODEGRAPH_LAUNCHER_LOCAL, 'index'], 'Indexar el proyecto');
      if (indexCode === 0) {
        console.log(green('\n  ✓ Indexación inicial completa.'));
      } else {
        console.log(yellow(`\n  ⚠ codegraph index salió con exit ${indexCode}.`));
        console.log(dim('    Reintentá con: ') + cyan(`node ${CODEGRAPH_LAUNCHER_LOCAL} index`));
      }
    } else {
      console.log(dim('\n  ⊘ Indexación pospuesta. Cuando quieras, correla con:'));
      console.log(dim('    ') + cyan(`node ${CODEGRAPH_LAUNCHER_LOCAL} index`));
    }
  }

  // ─── Resumen final ──────────────────────────────────────────────────
  console.log('');
  console.log(bold('  Layout:'));
  console.log(dim('    Global (compartido):  ') + cyan(CODEGRAPH_GLOBAL));
  if (inProject) {
    console.log(dim('    Proyecto (este repo): ') + cyan('.codegraph/launcher.mjs') + dim(' + .codegraph/config.json + .codegraph/codegraph.db'));
    console.log('');
    console.log(bold('  Próximos pasos:'));
    console.log(dim('    · Probá una query:  ') + cyan(`node ${CODEGRAPH_LAUNCHER_LOCAL} query "..."`));
    console.log(dim('    · Tests afectados:  ') + cyan(`node ${CODEGRAPH_LAUNCHER_LOCAL} affected <files>`));
    console.log(dim('    · El @researcher detectará la instalación automáticamente.'));
    console.log('');
    console.log(dim('  Borrar todo lo del proyecto: ') + cyan(`rm -rf .codegraph/`) + dim('  (no afecta el global).'));
  } else {
    console.log(dim('    Proyecto: (no configurado — este directorio no es un proyecto)'));
    console.log('');
    console.log(bold('  Próximos pasos:'));
    console.log(dim('    Andá a la raíz de un repo y corré:'));
    console.log('    ' + cyan('npx github:sebaarce/phobos') + dim('  → CodeGraph'));
    console.log(dim('    Eso crea ') + cyan('.codegraph/launcher.mjs') + dim(' y corre la indexación inicial.'));
  }

  if (storage.mode === 'custom') {
    printVerificationCommands('CodeGraph', CODEGRAPH_GLOBAL, storage.basePath);
  }
  console.log('');
}

// Router para la entrada "CodeGraph" del menú principal.
//
// Envuelve `installCodeGraph` con un `pressEnterToContinue()` para que ningún
// exit path (cancelación, install completo, error temprano) vuelva al menú
// instantáneamente — sin la pausa, el main loop re-renderiza el menú apenas
// retorna esto y el usuario ve un "parpadeo" sin entender qué pasó.
//
// El submenú "Instalar herramientas" ya hace su propio pressEnterToContinue
// después de llamar a `installCodeGraph` (ver actionInstallTools abajo), por
// eso ahí seguimos llamando a `installCodeGraph` directamente.
export async function actionCodeGraph(_adapter) {
  await installCodeGraph();
  await pressEnterToContinue();
}

// ═══════════════════════════════════════════════════════════════════
// Uninstall de CodeGraph.
//
// Tres niveles:
//   1. Per-proyecto    → borra .codegraph/* y limpia .gitignore.
//   2. Solo global     → borra ~/.phobos/codegraph/ (deja per-proyecto orphan).
//   3. Completo        → 1 + 2. Si ~/.phobos queda vacío, rompe el junction.
// ═══════════════════════════════════════════════════════════════════

const CODEGRAPH_PROJECT_FILES = [
  '.codegraph/launcher.mjs',
  '.codegraph/config.json',
  '.codegraph/config.yaml',
  '.codegraph/codegraph.db',
  '.codegraph/.index-state.json',
  '.codegraph/cg.cjs',          // legacy shim
  '.codegraph/package.json',    // legacy manifest
  '.codegraph/.npmrc',          // legacy npmrc
];

async function previewCodeGraphProject() {
  const items = [];
  for (const f of CODEGRAPH_PROJECT_FILES) {
    if (await fileExists(f)) {
      const { stat } = await import('node:fs/promises');
      try {
        const s = await stat(f);
        items.push({ path: f, type: 'file', size: s.size });
      } catch {}
    }
  }
  if (await fileExists('.codegraph/node_modules')) {
    const { getDirSize } = await import('./fs-utils.mjs');
    items.push({ path: '.codegraph/node_modules/', type: 'dir', size: await getDirSize('.codegraph/node_modules') });
  }
  return items;
}

async function previewCodeGraphGlobal() {
  const items = [];
  if (await fileExists(CODEGRAPH_GLOBAL)) {
    const { getDirSize } = await import('./fs-utils.mjs');
    items.push({ path: CODEGRAPH_GLOBAL + '/', type: 'dir', size: await getDirSize(CODEGRAPH_GLOBAL) });
  }
  return items;
}

async function uninstallCodeGraphProjectFiles() {
  const removed = [];
  for (const f of CODEGRAPH_PROJECT_FILES) {
    if (await fileExists(f)) {
      await rmrf(f);
      removed.push(f);
    }
  }
  if (await fileExists('.codegraph/node_modules')) {
    await rmrf('.codegraph/node_modules');
    removed.push('.codegraph/node_modules/');
  }
  // Si .codegraph/ quedó vacío, removerlo también
  if (await fileExists('.codegraph')) {
    const { readdir } = await import('node:fs/promises');
    try {
      const left = await readdir('.codegraph');
      if (left.length === 0) {
        await rmrf('.codegraph');
        removed.push('.codegraph/ (dir vacío)');
      }
    } catch {}
  }
  return removed;
}

async function cleanCodeGraphGitignoreEntries() {
  const { readFile } = await import('node:fs/promises');
  const gitignorePath = join(cwd(), '.gitignore');
  if (!await fileExists(gitignorePath)) return { cleaned: false };
  const content = await readFile(gitignorePath, 'utf-8');

  const patterns = [
    /^# CodeGraph.*$\r?\n/gm,
    /^# Phobos CodeGraph.*$\r?\n/gm,
    /^\.codegraph\/?\r?\n/gm,
    /^\.codegraph\/\*\r?\n/gm,
    /^!\.codegraph\/launcher\.mjs\r?\n/gm,
  ];
  let cleaned = content;
  for (const p of patterns) cleaned = cleaned.replace(p, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  if (cleaned === content) return { cleaned: false };
  await safeWriteFile('.gitignore', cleaned);
  return { cleaned: true };
}

async function uninstallCodeGraphGlobalFiles() {
  const removed = [];
  if (await fileExists(CODEGRAPH_GLOBAL)) {
    await rmrf(CODEGRAPH_GLOBAL);
    removed.push(CODEGRAPH_GLOBAL + '/');
  }
  return removed;
}

export async function uninstallCodeGraph() {
  // Import lazy de breakJunctionIfEmpty para no engordar el top-level
  const { breakJunctionIfEmpty } = await import('./storage.mjs');
  const { getDirSize, formatBytes: fmtBytes } = await import('./fs-utils.mjs');

  console.log('\n' + cyan('▸ ') + bold('Desinstalar CodeGraph'));
  console.log('');

  const projectItems = await previewCodeGraphProject();
  const globalItems = await previewCodeGraphGlobal();

  if (projectItems.length === 0 && globalItems.length === 0) {
    console.log(dim('  ℹ No detecté nada de CodeGraph para desinstalar (ni global ni en este proyecto).\n'));
    return;
  }

  const projectSize = projectItems.reduce((s, i) => s + (i.size || 0), 0);
  const globalSize = globalItems.reduce((s, i) => s + (i.size || 0), 0);

  console.log(dim('  Detectado en este proyecto:'));
  if (projectItems.length === 0) {
    console.log('    ' + dim('(nada)'));
  } else {
    for (const i of projectItems) {
      console.log('    ' + cyan(i.path) + dim(' · ' + fmtBytes(i.size || 0)));
    }
  }
  console.log('');
  console.log(dim('  Detectado global:'));
  if (globalItems.length === 0) {
    console.log('    ' + dim('(nada)'));
  } else {
    for (const i of globalItems) {
      console.log('    ' + cyan(i.path) + dim(' · ' + fmtBytes(i.size || 0)));
    }
    console.log('    ' + yellow('⚠ ') + dim('borrar global afecta a TODOS los proyectos que usan este install.'));
  }
  console.log('');

  const options = [];
  const handlers = [];
  if (projectItems.length > 0) {
    options.push(`Solo per-proyecto ${dim('(' + fmtBytes(projectSize) + ')')}`);
    handlers.push('project');
  }
  if (globalItems.length > 0) {
    options.push(`Solo global ${dim('(' + fmtBytes(globalSize) + ' · afecta otros proyectos)')}`);
    handlers.push('global');
  }
  if (projectItems.length > 0 && globalItems.length > 0) {
    options.push(`Completo ${dim('(per-proyecto + global + romper junction si queda vacío · ' + fmtBytes(projectSize + globalSize) + ')')}`);
    handlers.push('complete');
  }
  options.push('Cancelar');
  handlers.push('cancel');

  let choice;
  try {
    choice = await tuiSelect('¿Qué nivel?', options, options.length - 1);
  } catch {
    return;
  }
  const level = handlers[choice.index];
  if (level === 'cancel') {
    console.log(dim('  ⊘ Cancelado.\n'));
    return;
  }

  let confirmMsg;
  if (level === 'project') confirmMsg = '¿Confirmás borrar SOLO los archivos de este proyecto?';
  else if (level === 'global') confirmMsg = yellow('⚠ Esto deja sin binario a TODOS los proyectos. ¿Confirmás?');
  else confirmMsg = yellow('⚠ Esto borra todo (proyecto + global). ¿Confirmás?');

  const confirm = await tuiYesNo('\n' + confirmMsg, false);
  if (!confirm) {
    console.log(dim('  ⊘ Cancelado.\n'));
    return;
  }

  console.log('');
  if (level === 'project' || level === 'complete') {
    console.log(cyan('▸ Borrando archivos del proyecto...'));
    const removed = await uninstallCodeGraphProjectFiles();
    for (const r of removed) console.log(green('  ✓ ') + dim('borrado: ') + r);
    const gi = await cleanCodeGraphGitignoreEntries();
    if (gi.cleaned) console.log(green('  ✓ ') + dim('.gitignore: removí entradas de CodeGraph'));
  }
  if (level === 'global' || level === 'complete') {
    console.log('');
    console.log(cyan('▸ Borrando install global...'));
    const removed = await uninstallCodeGraphGlobalFiles();
    for (const r of removed) console.log(green('  ✓ ') + dim('borrado: ') + r);
  }

  if (level === 'complete') {
    console.log('');
    const r = await breakJunctionIfEmpty(PHOBOS_HOME);
    if (r.broken) {
      console.log(green('  ✓ ') + dim('Junction roto: ') + cyan(PHOBOS_HOME) + dim(' (apuntaba a ') + r.target + dim(')'));
    } else if (r.reason === 'target-not-empty') {
      console.log(yellow('  ⚠ Mantengo el junction ') + cyan(PHOBOS_HOME) + dim(' — todavía hay contenido:'));
      for (const name of r.remaining.slice(0, 5)) console.log('      ' + dim(name));
      if (r.remaining.length > 5) console.log('      ' + dim('  … y ' + (r.remaining.length - 5) + ' más'));
      if (r.remaining.includes('memory-engine') || r.remaining.includes('qdrant-storage')) {
        console.log('  ' + dim('  Tip: para llegar a estado virgen, después corré "Desinstalar Memory (Completo)".'));
      }
    }
  }

  console.log('');
  console.log(green('  ✓ CodeGraph desinstalado.'));
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════
// Tools registry — Opción A (registry plano)
// ═══════════════════════════════════════════════════════════════════

const TOOLS = [
  {
    id: 'autoskills',
    label: 'npx autoskills           ' + dim('— skills del proyecto en ./skills/'),
    action: () => runChild('npx', ['autoskills'], 'Generar skills/ del proyecto'),
  },
  {
    id: 'obsidian-skills',
    label: 'Instalar obsidian-skills ' + dim('— vault/notes en formato Obsidian'),
    action: installObsidianSkills,
  },
  {
    id: 'impeccable',
    label: 'Instalar impeccable      ' + dim('— skill de diseño/UI (vocab + anti-patterns)'),
    action: (adapter) => installImpeccable(adapter),
  },
  {
    id: 'codegraph',
    label: async () => {
      const s = await detectCodeGraphStatus();
      if (s.pkgInstalled && s.dbBuilt) {
        return 'Instalar CodeGraph       ' + dim('(instalado · re-instalar / re-indexar)');
      }
      if (s.pkgInstalled && !s.dbBuilt) {
        return 'Instalar CodeGraph       ' + dim('(paquete global instalado · falta indexar)');
      }
      return 'Instalar CodeGraph       ' + dim('— índice semántico del código (–94% tool calls)');
    },
    action: installCodeGraph,
  },
];

export async function actionInstallTools(adapter) {
  if (!adapter) throw new Error('actionInstallTools requires an adapter (IDEAdapter instance).');
  while (true) {
    clearScreen();
    printToolsBanner();
    panel('Instalar herramientas', [
      'Cada acción ejecuta un comando externo y vuelve a este menú al terminar.',
      dim('Elegí una opción con ↑/↓ y Enter.'),
    ]);

    const labels = await Promise.all(
      TOOLS.map(t => typeof t.label === 'function' ? t.label() : t.label),
    );
    const backLabel = dim('← Volver al menú principal');
    const backIndex = labels.length;

    const { index } = await tuiSelect(
      '\n¿Qué querés hacer?',
      [...labels, backLabel],
      0,
    );

    if (index === backIndex) return;

    const tool = TOOLS[index];
    rl.pause();
    await tool.action(adapter);

    if (tool.exitAfter) {
      showHappyGoodbye();
      finalizeAndExit(0);
      return;
    }

    await pressEnterToContinue();
  }
}

// Tools — autoskills, obsidian-skills, impeccable, codegraph, opencode.
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd, platform } from 'node:process';
import { rl } from './runtime.mjs';
import { fileExists, rmrf, safeWriteFile } from './fs-utils.mjs';
import { cyan, bold, dim, yellow, green, red } from './colors.mjs';
import { tuiSelect, tuiMultiSelect, tuiYesNo, panel, clearScreen } from './tui.mjs';
import { runChild } from './child.mjs';
import { printToolsBanner, showHappyGoodbye } from './banners.mjs';
import { finalizeAndExit, pressEnterToContinue } from './exit.mjs';
import { detectPackageManager } from './memory/deps.mjs';

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

  // Submenu: instalar todas o elegir
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

export async function installImpeccable() {
  // Impeccable — skill de diseño (pbakaus/impeccable).
  // Layout del repo: .opencode/skills/impeccable/{SKILL.md, reference/, scripts/}
  // No es publicable vía `npx skills add` (el repo tiene un solo skill en path no-estándar).
  // Estrategia: git clone shallow + copy del subdirectorio, sin requerir git config global.

  console.log('\n' + cyan('▸ ') + bold('Instalar Impeccable (skill de diseño per-proyecto)'));
  console.log(dim('  destino: .opencode/skills/impeccable/  (en este proyecto)'));
  console.log(dim('  fuente:  github.com/pbakaus/impeccable'));
  console.log(dim('  qué hace: vocabulario + 27 anti-patterns + workflows de auditoría de UI.'));
  console.log('');

  const { index } = await tuiSelect(
    '¿Instalar impeccable en este proyecto?',
    [
      `Sí, instalar  ${dim('(git clone + copy a .opencode/skills/impeccable/)')}`,
      'Cancelar',
    ],
    0,
  );

  if (index === 1) {
    console.log(dim('  ⊘ saltado.\n'));
    return;
  }

  const dest = '.opencode/skills/impeccable';
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

  // Asegurar que .opencode/skills/ exista
  await mkdir('.opencode/skills', { recursive: true }).catch(() => {});

  // Step 1: git clone shallow a tmp
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

  // Step 2: copiar .opencode/skills/impeccable/ del tmp al destino
  const src = join(tmpDir, '.opencode', 'skills', 'impeccable');
  if (!await fileExists(src)) {
    console.log(yellow(`  ⚠ El repo clonado no tiene ${src}. Quizás el upstream cambió.\n`));
    await rmrf(tmpDir);
    return;
  }

  // Borrar destino previo (si overwrite fue confirmado arriba)
  if (await fileExists(dest)) await rmrf(dest);

  // Copia recursiva multiplataforma vía spawn
  const copyCmd = platform === 'win32'
    ? { cmd: 'xcopy', args: [src.replace(/\//g, '\\'), dest.replace(/\//g, '\\'), '/E', '/I', '/Y', '/Q'] }
    : { cmd: 'cp', args: ['-r', src, dest] };

  const copyCode = await runChild(copyCmd.cmd, copyCmd.args, 'Copiar .opencode/skills/impeccable/');
  await rmrf(tmpDir);

  if (copyCode !== 0) {
    console.log(yellow('  ⚠ Falló la copia. Revisá permisos.\n'));
    return;
  }

  console.log(green('\n  ✓ Impeccable instalado en ') + cyan(dest));
  console.log(dim('\n  OpenCode auto-descubrirá la skill al reiniciar.'));
  console.log(dim('  Verificá con:  ') + cyan('opencode debug skill'));
  console.log(dim('  Tip CLI extra (sin instalar):  ') + cyan('npx impeccable detect src/'));
  console.log(dim('  Tip: si no querés commitear la skill, agregá a .gitignore:'));
  console.log(dim('    echo ".opencode/skills/impeccable/" >> .gitignore\n'));
}

// ═══════════════════════════════════════════════════════════════════
// CodeGraph — índice semántico AST + grafo de relaciones del código.
// Per-project install (devDependency en package.json) — alineado con
// el patrón que usa Memory para sus deps.
// ═══════════════════════════════════════════════════════════════════

const CODEGRAPH_PKG = '@colbymchenry/codegraph';
// Install aislado para que NO entre al package.json del proyecto principal
// (CI/CD no debería bajarlo nunca). Todo vive bajo .codegraph/:
//   .codegraph/package.json              ← manifest aislado, propio
//   .codegraph/node_modules/...          ← node_modules aislado
//   .codegraph/node_modules/.bin/codegraph ← binario invocable
//   .codegraph/codegraph.db              ← índice (también aislado)
const CODEGRAPH_HOST_DIR = '.codegraph';
const CODEGRAPH_PKG_MARKER = '.codegraph/node_modules/@colbymchenry/codegraph/package.json';

// Path al binario, en formato nativo del SO y con prefix relativo explícito.
// Windows cmd.exe interpreta el primer `/` como inicio de flag, así que en
// Windows necesitamos backslashes. Y `.\` (Win) / `./` (Unix) le dice al
// shell "esto es relativo al cwd actual, no busques en PATH".
const CODEGRAPH_BIN = platform === 'win32'
  ? '.\\.codegraph\\node_modules\\.bin\\codegraph'
  : './.codegraph/node_modules/.bin/codegraph';

// Versión "user-friendly" del path para mostrar en mensajes — siempre con
// forward slashes para que se vea uniforme y sea copiable en cualquier shell
// moderno (PowerShell, Git Bash, sh, zsh).
const CODEGRAPH_BIN_DISPLAY = '.codegraph/node_modules/.bin/codegraph';

// Detecta si CodeGraph ya está instalado y listo en este proyecto.
// Devuelve un objeto con flags individuales para que la UI pueda mostrar
// estado granular ("instalado pero sin indexar todavía").
export async function detectCodeGraphStatus() {
  const pkgInstalled = await fileExists(CODEGRAPH_PKG_MARKER);
  const projectInitialized = await fileExists('.codegraph');
  const dbBuilt = await fileExists('.codegraph/codegraph.db');
  return { pkgInstalled, projectInitialized, dbBuilt };
}

// Asegura que `.codegraph/` esté listado en .gitignore. Idempotente — si
// ya está, no toca el archivo. Si no existe .gitignore, lo crea.
async function ensureCodeGraphInGitignore() {
  const path = '.gitignore';
  let existing = '';
  try {
    existing = await readFile(join(cwd(), path), 'utf-8');
  } catch {}

  // Match líneas que mencionen .codegraph/ o .codegraph (con o sin slash final).
  const alreadyListed = /^\s*\.codegraph\/?\s*$/m.test(existing);
  if (alreadyListed) return { added: false };

  const snippet = '\n# CodeGraph — índice local del código (no commitear)\n.codegraph/\n';
  const content = existing.endsWith('\n') || existing === ''
    ? existing + snippet
    : existing + '\n' + snippet;
  await safeWriteFile(path, content);
  return { added: true };
}

// Crea (o reusa) el manifest aislado en .codegraph/package.json. Esto
// es lo que hace que CodeGraph viva fuera del package.json principal del
// proyecto, y por ende NO sea bajado por CI/CD cuando hace `npm install`.
async function ensureCodeGraphHostManifest() {
  const manifestPath = join(CODEGRAPH_HOST_DIR, 'package.json');
  if (await fileExists(manifestPath)) return { created: false };

  await mkdir(CODEGRAPH_HOST_DIR, { recursive: true }).catch(() => {});

  const manifest = {
    name: 'phobos-codegraph-host',
    private: true,
    version: '0.0.0',
    description: 'Isolated install of @colbymchenry/codegraph for this project. NOT part of the main package.json — CI/CD will not install it.',
    dependencies: {
      [CODEGRAPH_PKG]: 'latest',
    },
  };
  await safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { created: true };
}

// Invocar el binario del install aislado.
// `.bin/codegraph` es un wrapper script (.cmd en Windows, shell script en
// Unix) — NO un módulo JS. Por eso `node <path>` falla con MODULE_NOT_FOUND.
// La forma correcta es ejecutar el path directo y dejar que el shell resuelva
// la extensión (.cmd vía PATHEXT en Windows; ejecuta el sh-bang en Unix).
// `runChild` usa `shell: true`, así que esto funciona en ambas plataformas.

export async function installCodeGraph() {
  console.log('\n' + cyan('▸ ') + bold('Instalar CodeGraph (índice semántico del código, install aislado)'));
  console.log(dim('  paquete: ' + CODEGRAPH_PKG + '  →  ' + CODEGRAPH_HOST_DIR + '/node_modules/'));
  console.log(dim('  fuente:  github.com/colbymchenry/codegraph'));
  console.log(dim('  qué hace: AST + grafo de relaciones; reduce ~94% los tool calls del researcher.'));
  console.log(dim('  ⚡ NO toca el package.json principal — CI/CD nunca lo va a bajar.'));
  console.log('');

  // ─── Step 1/6: Verificar prerequisitos ─────────────────────────────
  // No exigimos package.json — el install aislado funciona en cualquier
  // directorio. Solo verificamos que estemos en un proyecto razonable.
  if (!await fileExists('.git') && !await fileExists('package.json') && !await fileExists('AGENTS.md')) {
    console.log(yellow('  ✗ No parece un proyecto válido (sin .git, package.json o AGENTS.md).'));
    console.log(dim('    Corré el wizard desde la raíz de un repo.'));
    console.log('');
    return;
  }

  const status = await detectCodeGraphStatus();

  // ─── Step 2/6: Decidir acción según estado actual ─────────────────
  if (status.pkgInstalled && status.dbBuilt) {
    const { index } = await tuiSelect(
      'CodeGraph ya está instalado e indexado. ¿Qué hacer?',
      [
        'Re-indexar (recomendado si el código cambió mucho)',
        'Re-instalar el paquete (forzar actualización a la última versión)',
        'Cancelar',
      ],
      0,
    );
    if (index === 2) {
      console.log(dim('  ⊘ saltado.\n'));
      return;
    }
    if (index === 0) {
      console.log(dim('\n  Re-indexando — puede tardar varios minutos en repos grandes.\n'));
      const code = await runChild(CODEGRAPH_BIN, ['index'], 'Re-indexar CodeGraph');
      if (code === 0) {
        console.log(green('\n  ✓ Re-indexación completa.\n'));
      } else {
        console.log(yellow(`\n  ⚠ codegraph index exit code ${code}.\n`));
      }
      return;
    }
    // index === 1: cae al flujo normal y reinstala el paquete.
  } else if (status.pkgInstalled && !status.dbBuilt) {
    console.log(dim('  ℹ Paquete instalado pero sin indexar todavía. Voy a inicializar + indexar.\n'));
  } else {
    const confirm = await tuiYesNo(
      '¿Instalar CodeGraph (aislado) en este proyecto?',
      true,
    );
    if (!confirm) {
      console.log(dim('  ⊘ saltado.\n'));
      return;
    }
  }

  // ─── Step 3/6: Crear manifest aislado + instalar adentro ──────────
  const m = await ensureCodeGraphHostManifest();
  if (m.created) {
    console.log(green('  ✓ ') + dim('Creé manifest aislado en ') + cyan(CODEGRAPH_HOST_DIR + '/package.json'));
  } else {
    console.log(dim('  ℹ Manifest aislado ya existe — reuso.'));
  }

  const pm = await detectPackageManager();
  console.log(dim('  Package manager detectado: ') + cyan(pm) + '\n');

  // El install corre adentro de .codegraph/ — no toca el package.json principal.
  const installArgs = pm === 'yarn' ? ['install']
                    : pm === 'pnpm' ? ['install']
                    : pm === 'bun'  ? ['install']
                    : ['install'];

  rl.pause();
  const installCode = await runChild(
    pm, installArgs,
    `Instalar ${CODEGRAPH_PKG} (aislado en ${CODEGRAPH_HOST_DIR}/)`,
    { cwd: CODEGRAPH_HOST_DIR },
  );
  if (installCode !== 0) {
    const verify = await detectCodeGraphStatus();
    if (!verify.pkgInstalled) {
      console.log(red(`\n  ✗ Falló la instalación (exit ${installCode}).`));
      console.log(dim('    Probá manualmente: ') + cyan(`cd ${CODEGRAPH_HOST_DIR} && ${pm} install`));
      console.log('');
      return;
    }
    console.log(yellow(`\n  ⚠ ${pm} retornó exit ${installCode} pero el paquete está. Continuamos.\n`));
  } else {
    console.log(green(`\n  ✓ ${CODEGRAPH_PKG} instalado en ${CODEGRAPH_HOST_DIR}/node_modules/\n`));
  }

  // ─── Step 4/6: Inicializar config (.codegraph/config.json) ────────
  if (!await fileExists('.codegraph/config.json') && !await fileExists('.codegraph/config.yaml')) {
    const initCode = await runChild(
      CODEGRAPH_BIN, ['init'],
      'Inicializar CodeGraph (.codegraph/config.json)',
    );
    if (initCode !== 0) {
      console.log(yellow(`\n  ⚠ codegraph init falló (exit ${initCode}). Probá manualmente:`));
      console.log(dim('    ') + cyan(`${CODEGRAPH_BIN_DISPLAY} init -i`));
      console.log('');
    } else {
      console.log(green('\n  ✓ Config generada en .codegraph/\n'));
    }
  } else {
    console.log(dim('  ℹ .codegraph/ ya tiene config — salteo init.\n'));
  }

  // ─── Step 5/6: .gitignore ─────────────────────────────────────────
  const gi = await ensureCodeGraphInGitignore();
  if (gi.added) {
    console.log(green('  ✓ ') + dim('Agregué ') + cyan('.codegraph/') + dim(' a .gitignore'));
  } else {
    console.log(dim('  ℹ .codegraph/ ya estaba en .gitignore'));
  }
  console.log('');

  // ─── Step 6/6: Indexación inicial ─────────────────────────────────
  const wantIndex = await tuiYesNo(
    '¿Correr indexación inicial ahora? (puede tardar varios minutos en repos grandes)',
    true,
  );
  if (wantIndex) {
    const indexCode = await runChild(
      CODEGRAPH_BIN, ['index'],
      'Indexar el proyecto',
    );
    if (indexCode === 0) {
      console.log(green('\n  ✓ Indexación inicial completa.'));
    } else {
      console.log(yellow(`\n  ⚠ codegraph index salió con exit ${indexCode}.`));
      console.log(dim('    Reintentá con: ') + cyan(`${CODEGRAPH_BIN_DISPLAY} index`));
    }
  } else {
    console.log(dim('\n  ⊘ Indexación pospuesta. Cuando quieras, correla con:'));
    console.log(dim('    ') + cyan(`${CODEGRAPH_BIN_DISPLAY} index`));
  }

  // ─── Resumen final ─────────────────────────────────────────────────
  console.log('');
  console.log(bold('  Próximos pasos:'));
  console.log(dim('    · Probá una query:  ') + cyan(`${CODEGRAPH_BIN_DISPLAY} query "..."`));
  console.log(dim('    · Tests afectados:  ') + cyan(`${CODEGRAPH_BIN_DISPLAY} affected <files>`));
  console.log(dim('    · El @researcher detectará la instalación automáticamente y usará CodeGraph'));
  console.log(dim('      antes de caer a rg/grep, a partir de la próxima task SDD.'));
  console.log('');
  console.log(dim('  Para borrar todo: ') + cyan(`rm -rf ${CODEGRAPH_HOST_DIR}/`) + dim('  (auto-ignored, no afecta nada más).'));
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════
// Tools registry — Opción A (registry plano)
// ═══════════════════════════════════════════════════════════════════
//
// Cada entry describe una herramienta del menú "Instalar herramientas".
// Para agregar una nueva: 1 entry. El menú y el dispatcher se generan
// del array, no hay switch hardcodeado por índice.
//
// Contrato de cada Tool:
//   id         string — identificador único (no se muestra, sirve para debug).
//   label      string | async () => string — texto del item. Si es función,
//              puede consultar el filesystem para mostrar estado dinámico
//              (ej: "instalado · re-instalar / re-indexar").
//   action     async () => void — qué hacer cuando el usuario lo elige.
//   exitAfter  bool (opcional) — si true, después de ejecutar el wizard
//              cierra (caso típico: "Abrir OpenCode" reemplaza el proceso).
//
// Para growth grande (>10 herramientas) considerar Opción C (plugin
// discovery: cada tool en su propio archivo bajo scripts/lib/tools/).
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
    action: installImpeccable,
  },
  {
    id: 'codegraph',
    label: async () => {
      const s = await detectCodeGraphStatus();
      if (s.pkgInstalled && s.dbBuilt) {
        return 'Instalar CodeGraph       ' + dim('(instalado · re-instalar / re-indexar)');
      }
      if (s.pkgInstalled && !s.dbBuilt) {
        return 'Instalar CodeGraph       ' + dim('(paquete instalado · falta indexar)');
      }
      return 'Instalar CodeGraph       ' + dim('— índice semántico del código (–94% tool calls)');
    },
    action: installCodeGraph,
  },
  {
    id: 'opencode',
    label: 'Abrir OpenCode           ' + dim('— lanzar el TUI'),
    action: () => runChild('opencode', [], 'Abrir OpenCode'),
    exitAfter: true,
  },
];

export async function actionInstallTools() {
  while (true) {
    clearScreen();
    printToolsBanner();
    panel('Instalar herramientas', [
      'Cada acción ejecuta un comando externo y vuelve a este menú al terminar.',
      dim('Elegí una opción con ↑/↓ y Enter.'),
    ]);

    // Resolver labels: si es función la await-eamos para que pueda consultar
    // estado del filesystem. Si es string, lo dejamos como está.
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
    await tool.action();

    if (tool.exitAfter) {
      // Caso "Abrir OpenCode" — el usuario probablemente quiera salir del wizard.
      showHappyGoodbye();
      finalizeAndExit(0);
      return;
    }

    await pressEnterToContinue();
  }
}

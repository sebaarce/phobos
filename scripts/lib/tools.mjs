// Tools — autoskills, obsidian-skills, impeccable, opencode.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:process';
import { rl } from './runtime.mjs';
import { fileExists, rmrf } from './fs-utils.mjs';
import { cyan, bold, dim, yellow, green } from './colors.mjs';
import { tuiSelect, tuiMultiSelect, panel, clearScreen } from './tui.mjs';
import { runChild } from './child.mjs';
import { printToolsBanner, showHappyGoodbye } from './banners.mjs';
import { finalizeAndExit, pressEnterToContinue } from './exit.mjs';

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

export async function actionInstallTools() {
  while (true) {
    clearScreen();
    printToolsBanner();
    panel('Instalar herramientas', [
      'Cada acción ejecuta un comando externo y vuelve a este menú al terminar.',
      dim('Elegí una opción con ↑/↓ y Enter.'),
    ]);

    const { index } = await tuiSelect(
      '\n¿Qué querés hacer?',
      [
        'npx autoskills           ' + dim('— skills del proyecto en ./skills/'),
        'Instalar obsidian-skills ' + dim('— vault/notes en formato Obsidian'),
        'Instalar impeccable      ' + dim('— skill de diseño/UI (vocab + anti-patterns)'),
        'Abrir OpenCode           ' + dim('— lanzar el TUI'),
        dim('← Volver al menú principal'),
      ],
      0,
    );

    if (index === 4) return; // volver

    rl.pause();
    if (index === 0) {
      await runChild('npx', ['autoskills'], 'Generar skills/ del proyecto');
    } else if (index === 1) {
      await installObsidianSkills();
    } else if (index === 2) {
      await installImpeccable();
    } else if (index === 3) {
      await runChild('opencode', [], 'Abrir OpenCode');
      // Si se abrió OpenCode, el usuario probablemente quiera salir del wizard
      showHappyGoodbye();
      finalizeAndExit(0);
      return;
    }

    await pressEnterToContinue();
  }
}

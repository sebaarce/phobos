// Bootstrap — chequeo y creación del scaffold (agentes, comandos, vault).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { cwd, stdout } from 'node:process';
import { BOOTSTRAP_GROUPS, TEMPLATES_DIR, srcToDst } from './runtime.mjs';
import { fileExists } from './fs-utils.mjs';
import { green, dim, bold } from './colors.mjs';
import { tuiYesNo } from './tui.mjs';

// ═══════════════════════════════════════════════════════════════════
// Progress bar
// ═══════════════════════════════════════════════════════════════════

export function drawProgress(label, current, total, width = 24) {
  const pct = current / total;
  const filled = Math.round(pct * width);
  const bar = green('█'.repeat(filled)) + dim('░'.repeat(width - filled));
  const percent = Math.round(pct * 100).toString().padStart(3);
  stdout.write(`\r  [${bar}] ${percent}%  ${label} ${dim('(' + current + '/' + total + ')')}`);
  if (current === total) stdout.write('\n');
}

export async function findMissing() {
  const missing = { agentes: [], comandos: [], vault: [], gitignore: false };
  for (const [group, files] of Object.entries(BOOTSTRAP_GROUPS)) {
    for (const src of files) {
      const dst = srcToDst(src);
      if (!await fileExists(join(cwd(), dst))) missing[group].push(src);
    }
  }
  // .gitignore — opcional, no se sobreescribe si existe
  if (!await fileExists(join(cwd(), '.gitignore'))) {
    missing.gitignore = await fileExists(join(TEMPLATES_DIR, '.gitignore'));
  }
  return missing;
}

export function summarizeMissing(missing) {
  const counts = {
    agentes: missing.agentes.length,
    comandos: missing.comandos.length,
    vault: missing.vault.length,
    gitignore: missing.gitignore ? 1 : 0,
  };
  const total = counts.agentes + counts.comandos + counts.vault + counts.gitignore;
  return { counts, total };
}

export async function bootstrap(missing) {
  console.log(bold('\n  Bootstrap iniciado.\n'));

  const groupLabels = {
    agentes:  'Creando agentes      ',
    comandos: 'Creando comandos     ',
    vault:    'Creando estructura de memory',
  };

  for (const group of ['agentes', 'comandos', 'vault']) {
    const files = missing[group];
    if (files.length === 0) continue;
    for (let i = 0; i < files.length; i++) {
      const src = join(TEMPLATES_DIR, files[i]);
      const dst = join(cwd(), srcToDst(files[i]));
      await mkdir(dirname(dst), { recursive: true });
      const content = await readFile(src, 'utf-8');
      await writeFile(dst, content);
      drawProgress(groupLabels[group], i + 1, files.length);
    }
  }

  if (missing.gitignore) {
    const src = join(TEMPLATES_DIR, '.gitignore');
    const dst = join(cwd(), '.gitignore');
    const content = await readFile(src, 'utf-8');
    await writeFile(dst, content);
    console.log(`  ${green('✓')} .gitignore creado`);
  }

  console.log(green('\n  ✓ Bootstrap completo.\n'));
}

export async function ensureBootstrap() {
  const missing = await findMissing();
  const { total } = summarizeMissing(missing);

  if (total === 0) return true;

  const confirm = await tuiYesNo('\n¿Querés instalar los agentes en este proyecto?', true);
  if (!confirm) {
    return false;
  }

  await bootstrap(missing);
  return true;
}

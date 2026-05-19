// Bootstrap — chequeo y creación del scaffold (agentes, comandos, vault).
// Recibe un IDEAdapter como parámetro; la lista de archivos a copiar viene
// de adapter.bootstrapFiles() — agnóstico al target IDE.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd, stdout } from 'node:process';
import { TEMPLATES_DIR } from './runtime.mjs';
import { fileExists, safeWriteFile } from './fs-utils.mjs';
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

// ═══════════════════════════════════════════════════════════════════
// Discovery
// ═══════════════════════════════════════════════════════════════════

// Devuelve los archivos del bootstrap que faltan en el cwd.
// Estructura: { byGroup: { agentes: [...], comandos: [...], vault: [...] },
//               flat: [...], gitignore: bool }
// `byGroup` agrupa por el campo `group` del adapter para mostrar progress
// segmentado. `flat` es la lista plana para conteos.
export async function findMissing(adapter) {
  const files = adapter.bootstrapFiles();
  const byGroup = {};
  const flat = [];
  for (const file of files) {
    if (!await fileExists(join(cwd(), file.dst))) {
      const group = file.group || 'other';
      if (!byGroup[group]) byGroup[group] = [];
      byGroup[group].push(file);
      flat.push(file);
    }
  }
  // .gitignore — opcional, no se sobreescribe si existe
  const gitignoreMissing = !await fileExists(join(cwd(), '.gitignore'))
    && await fileExists(join(TEMPLATES_DIR, '.gitignore'));
  return { byGroup, flat, gitignore: gitignoreMissing };
}

export function summarizeMissing(missing) {
  const counts = {};
  for (const [group, files] of Object.entries(missing.byGroup)) {
    counts[group] = files.length;
  }
  counts.gitignore = missing.gitignore ? 1 : 0;
  const total = missing.flat.length + counts.gitignore;
  return { counts, total };
}

// ═══════════════════════════════════════════════════════════════════
// Bootstrap execution
// ═══════════════════════════════════════════════════════════════════

// Labels para el progress bar por grupo. Si un grupo no está acá, se usa
// el nombre del grupo capitalizado. Esto permite que el adapter introduzca
// grupos nuevos sin que bootstrap.mjs los conozca.
const GROUP_LABELS = {
  agentes:  'Creando agentes      ',
  comandos: 'Creando comandos     ',
  vault:    'Creando estructura de memory',
};

export async function bootstrap(missing, adapter) {
  console.log(bold('\n  Bootstrap iniciado.\n'));

  // Render groups in a stable order: known groups first (agentes, comandos,
  // vault), then any additional groups alphabetically.
  const knownOrder = ['agentes', 'comandos', 'vault'];
  const allGroups = Object.keys(missing.byGroup);
  const orderedGroups = [
    ...knownOrder.filter(g => allGroups.includes(g)),
    ...allGroups.filter(g => !knownOrder.includes(g)).sort(),
  ];

  for (const group of orderedGroups) {
    const files = missing.byGroup[group];
    if (!files || files.length === 0) continue;
    const label = GROUP_LABELS[group] || ('Creando ' + group);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const src = join(TEMPLATES_DIR, file.src);
      let content = await readFile(src, 'utf-8');

      // Si el archivo declara un transform, delegamos al adapter.
      // Esto permite que adapters específicos (ej: ClaudeAdapter) reescriban
      // el frontmatter de los templates de OpenCode antes de escribirlos
      // al destino. Single source of truth, transform per IDE.
      if (file.transform && adapter && typeof adapter[`transform${capitalize(file.transform)}`] === 'function') {
        // Derivar nombre del agente desde el filename (sin extensión) para
        // ayudar al transformer cuando aplique (ej: phobos.md → "phobos").
        const agentName = file.dst.split(/[\\/]/).pop().replace(/\.md$/, '');
        content = adapter[`transform${capitalize(file.transform)}`](content, agentName);
      }

      // safeWriteFile valida symlinks + path-traversal y crea el dirname.
      await safeWriteFile(file.dst, content);
      drawProgress(label, i + 1, files.length);
    }
  }

  if (missing.gitignore) {
    const src = join(TEMPLATES_DIR, '.gitignore');
    const content = await readFile(src, 'utf-8');
    await safeWriteFile('.gitignore', content);
    console.log(`  ${green('✓')} .gitignore creado`);
  }

  console.log(green('\n  ✓ Bootstrap completo.\n'));
}

export async function ensureBootstrap(adapter) {
  if (!adapter) {
    throw new Error('ensureBootstrap requires an adapter (IDEAdapter instance).');
  }
  const missing = await findMissing(adapter);
  const { total } = summarizeMissing(missing);

  if (total === 0) return true;

  const confirm = await tuiYesNo(
    `\n¿Querés instalar Phobos para ${adapter.displayName} en este proyecto?`,
    true,
  );
  if (!confirm) {
    return false;
  }

  await bootstrap(missing, adapter);
  return true;
}

// Helper para "agent" → "Agent" (capitalize first letter).
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

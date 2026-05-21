#!/usr/bin/env node
// Strip decorative emojis from agent prompt templates.
//
// USO:
//   node scripts/dev/strip-decorative-emojis.mjs           # dry-run (muestra qué cambiaría)
//   node scripts/dev/strip-decorative-emojis.mjs --apply   # aplica cambios
//
// QUÉ HACE:
//   Remueve emojis decorativos (puramente cosméticos) del prompt body de los
//   agentes en scripts/templates/agentes/*.md. Mantiene los indicadores
//   funcionales: ✓ ✗ ⚠ ❌ ⊘ ✅, arrows → ← ↻ ↑ ↓, markers ● ○,
//   y box-drawing chars ┌ ─ │ └ ├ ┤ que son estructurales al UI.
//
// CUÁNDO USARLO:
//   Después de editar templates si sospechás que metiste emojis decorativos.
//   Idealmente nunca — la convención es no agregar emojis decorativos al
//   prompt body en primer lugar. Este script es safety net, no rutina.
//
// LO QUE NO HACE:
//   - NO toca double-spaces de alignment (aprendí esa lección: el script
//     original colapsaba espacios que servían para alinear tablas).
//   - NO procesa archivos fuera de scripts/templates/agentes/.
//   - NO modifica archivos instalados en proyectos (.opencode/agent/ o
//     .claude/agents/) — esos se actualizan vía "Actualizar agentes" del
//     wizard, que re-aplica el template ya limpio.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '../templates/agentes');

// Emojis a REMOVER. Si encontrás uno nuevo que querés sacar, sumalo acá.
// Si querés MANTENER uno (ej: 🤖 si lo considerás funcional), sacalo de la lista.
const DECORATIVE_EMOJIS = [
  '🎯', '📊', '🚨', '💊', '💡', '🤔', '🔮', '🧪', '📝', '📋',
  '🟢', '🟡', '🔴', '🤖', '⚡', '🎬', '💰', '✻', '✨', '🐛',
  '🔍', '🧹', '🔄', '🎙️', '📌', '📦', '🔧', '🛠️', '🧠', '📚',
  '🎉', '🔥', '🏆', '⏳', '📉', '📈', '💬', '🪶', '🪐', '🚀',
  '🌐', '🌍', '🐳', '🤝', '👀', '👉', '👍', '👎', '☝', '✋',
  '⭐', '✏️', '🔒', '🔓', '🛡️', '⚙️', '🗂️', '🗃️', '📂', '📁',
];

// MANTENER explícitamente (documental — el script no los toca):
//   ✓ ✗ ⚠ ❌ ⊘ ✅   — status indicators en tablas
//   → ← ↻ ↑ ↓       — arrows en flow / nav
//   ● ○             — selection markers (TodoList, picker)
//   ┌ ┐ └ ┘ ─ │     — box-drawing del status banner
//   ├ ┤ ┬ ┴ ┼       — box-drawing de tree diagrams

function stripDecorative(content) {
  let out = content;
  for (const emoji of DECORATIVE_EMOJIS) {
    out = out.split(emoji).join('');
  }
  // Solo limpiamos:
  // - Headers que quedaron con doble espacio post-emoji: "## 🎯 Algo" → "##  Algo" → "## Algo"
  out = out.replace(/^(#{1,6})\s{2,}/gm, '$1 ');
  // - Bullets idem
  out = out.replace(/^([-*+])\s{2,}/gm, '$1 ');
  // NO colapsamos otros double-spaces — esos suelen ser alignment intencional.
  return out;
}

const apply = process.argv.includes('--apply');

console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
console.log(`Target: ${TEMPLATES_DIR}\n`);

const files = await readdir(TEMPLATES_DIR);
const mdFiles = files.filter(f => f.endsWith('.md'));

let totalChanges = 0;

for (const f of mdFiles) {
  const path = join(TEMPLATES_DIR, f);
  const before = await readFile(path, 'utf-8');
  const after = stripDecorative(before);
  if (before === after) {
    console.log(`  · ${f}: no changes`);
    continue;
  }
  const removed = before.length - after.length;
  totalChanges += removed;
  console.log(`  · ${f}: ${removed > 0 ? '-' : ''}${removed} chars`);
  if (apply) {
    await writeFile(path, after, 'utf-8');
  }
}

console.log(`\nTotal: ${totalChanges} chars ${apply ? 'removed' : 'would be removed'}.`);
if (!apply && totalChanges > 0) {
  console.log('Run with --apply to write changes.');
  console.log('Verify with git diff before committing.');
}

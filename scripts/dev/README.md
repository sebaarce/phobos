# `scripts/dev/` — Developer maintenance tools

Scripts de mantenimiento que **NO se exponen al usuario final** del wizard.
Son herramientas para el desarrollo del propio Phobos (esta repo), no para
los proyectos que instalan Phobos.

Características comunes:
- No se documentan en el README principal
- No aparecen en el wizard (`scripts/phobos.mjs`)
- Operan sobre `scripts/templates/` (archivos de la repo), no sobre
  `.opencode/` / `.claude/` (instalaciones de usuario)
- Son one-shot: corren cuando hace falta, no en cada bootstrap

---

## Scripts disponibles

### `strip-decorative-emojis.mjs`

Remueve emojis decorativos del prompt body de los agentes en
`scripts/templates/agentes/`.

**Uso:**

```bash
# Dry-run — muestra qué cambiaría, no escribe
node scripts/dev/strip-decorative-emojis.mjs

# Aplica los cambios
node scripts/dev/strip-decorative-emojis.mjs --apply
```

**Después de aplicar:**

```bash
git diff scripts/templates/agentes/
# Revisá los cambios antes de commitear.
```

**Qué remueve:**
- 🎯 📊 🚨 💊 💡 🤔 🔮 🧪 📝 📋 (decorativos varios)
- 🟢 🟡 🔴 (semáforos cosméticos)
- 🤖 ⚡ 🎬 ✻ ✨ (otros decorativos)
- `☝` ✋ 👀 👉 👍 👎 (gestos)
- Lista completa en el código del script

**Qué NO toca (mantiene):**
- `✓ ✗ ⚠ ❌ ⊘ ✅` — status indicators en tablas
- `→ ← ↻ ↑ ↓` — arrows
- `● ○` — selection markers (TodoList, picker)
- `┌ ─ │ └ ├ ┤` — box-drawing (status banner)

**Cuándo correrlo:**
- Después de editar uno o más templates si sospechás que metiste decorativos
- Antes de un release / commit grande de templates como safety net
- Idealmente: nunca, porque la convención es no agregar decorativos al editar

---

## Agregar un nuevo dev script

1. Crear el archivo `.mjs` acá
2. Agregar shebang `#!/usr/bin/env node` (opcional, ayuda en Unix)
3. Documentar usage en el top del archivo Y en este README
4. NO sumar al wizard de `scripts/phobos.mjs`

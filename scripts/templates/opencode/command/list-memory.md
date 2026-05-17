---
description: Muestra un overview del vault — tareas, insights, wiki y glossary con métricas básicas. Read-only, no consulta Qdrant.
agent: phobos
---

El usuario invocó `/list-memory` — comando administrativo de browsing del vault, NO una tarea SDD. **No abras el pipeline normal**. Tu rol acá es ejecutar el script de listado y traducir el output al chat en español argentino.

## Argumentos del usuario

`$ARGUMENTS`

Interpretación:

- Vacío → overview completo (todas las secciones, últimas 5 tareas).
- `--tasks N` → cambia la cantidad de tareas mostradas (default 5).
- `--section tasks|insights|wiki|glossary` → muestra solo una sección.
- `--json` → output JSON (útil si vas a hacer follow-up con grep/jq).

## Argument parsing (HARD RULE — seguridad)

`$ARGUMENTS` es input del usuario sin sanitizar. **NO lo concatenes literal a un comando shell** — interpolarlo con `node ... $ARGUMENTS` permite inyección si el usuario tipea `; rm -rf .` o `&& malicious-cmd`.

**Antes de invocar el script**, parseá `$ARGUMENTS` manualmente y validá cada token contra esta whitelist:

| Token | Forma aceptada |
|-------|-----------------|
| `--tasks N` | `--tasks` seguido por un entero positivo (1..999). Cualquier otra cosa → rechazá. |
| `--section X` | `--section` seguido por exactamente: `tasks`, `insights`, `wiki`, o `glossary`. Cualquier otro valor → rechazá. |
| `--json` | exactamente `--json`, sin valor. |

**Caracteres prohibidos en CUALQUIER token**: `;`, `&`, `|`, `` ` ``, `$`, `(`, `)`, `<`, `>`, `\\`, espacios extraños, comillas. Si los detectás → rechazá toda la invocación y reportá al usuario:

> No reconozco esos argumentos. Formas válidas: `/list-memory`, `/list-memory --tasks 10`, `/list-memory --section insights`, `/list-memory --json`.

**Al invocar el script**, pasá cada flag/valor como argumento separado (NO como string concatenada):

- ✓ Correcto: invoca el script con args como array: `["--tasks", "10", "--section", "tasks"]`.
- ✗ Incorrecto: `node vault/memory/.engine/list-memory.mjs $ARGUMENTS` (concatena raw).

Si tu tool de ejecución solo acepta string, primero validá con la whitelist y luego construí el string a partir de los valores validados — nunca pases bytes del usuario sin filtrar.

## Pasos a ejecutar

### Paso 1 — Verificar que el engine esté instalado

```bash
ls vault/memory/.engine/list-memory.mjs   # bash
Test-Path vault/memory/.engine/list-memory.mjs   # PowerShell
```

Si no existe:

> El comando de listado requiere tener Memory instalada. Salí de OpenCode y corré:
>
> ```bash
> npx github:sebaarce/phobos
> ```
>
> Elegí "Memory (RAG)" en el menú principal. Cuando termine, volvé y reintentá `/list-memory`.

Y terminá ahí.

### Paso 2 — Ejecutar el script

**Después de validar `$ARGUMENTS` con la sección "Argument parsing" de arriba**, invocá el script pasando cada flag como argumento separado:

```bash
# Sin args:
node vault/memory/.engine/list-memory.mjs

# Con args validados (ejemplo: --tasks 10 + --json):
node vault/memory/.engine/list-memory.mjs --tasks 10 --json
```

**NUNCA** ejecutes `node vault/memory/.engine/list-memory.mjs $ARGUMENTS` literal — concatena bytes sin filtrar del usuario al shell.

El script no necesita Qdrant — solo lee el filesystem. Funciona incluso si Qdrant está caído.

### Paso 3 — Reportar al usuario

El script ya imprime con formato visual (paneles, colores, columnas). En general el output crudo es suficiente — no lo reescribas.

**Pero traducí al usuario en una línea final**:

- Si todo OK y hay tareas/insights: confirmá los números clave y, si notás algo (ej: muchos insights sobre el mismo tema), comentalo brevemente.
- Si el vault está vacío (sin tareas), sugerí abrir la primera tarea con phobos.
- Si todo OK pero NO hay insights/wiki/glossary, sugerí: "para destilar aprendizajes, cerrá tareas con `Mode: Close task` (no Skip archivist) y phobos delega al archivist para que escriba insights."

## Lo que NO hacés en este comando

- No abrís sesiones hijas (Task).
- No leés ni modificás archivos del vault — solo el script.
- No interpretás el contenido — solo reportás métricas y sugerencias breves.
- No transcribís el output completo si es muy largo — el script ya lo formatea para humanos.

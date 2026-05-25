---
description: Re-indexa la memoria semántica del vault en Qdrant. Incremental por defecto, full para reindex completo.
argument-hint: "[full]"
disable-model-invocation: true
allowed-tools: Bash(node vault/memory/.engine/launcher.mjs index *)
---

El usuario invocó `/reindex-memory` — comando administrativo, NO una tarea SDD. Tu único trabajo es: ejecutar el script de indexación, leer su output, traducir al chat en español argentino.

## Argumentos del usuario

`$ARGUMENTS`

Interpretación:
- Vacío o cualquier valor que no sea reconocido → **incremental** (default, rápido).
- `full`, `force`, `--force` → **reindex completo** (más lento).

## Argument parsing (HARD RULE — seguridad)

`$ARGUMENTS` es input del usuario sin sanitizar. **NO lo concatenes literal a un comando shell**. Para este comando hacé el parsing así:

1. Tomá `$ARGUMENTS` y stripealo de whitespace.
2. Comparalo (lowercase) contra el set exacto `{"full", "force", "--force"}`.
3. Si matchea EXACTAMENTE alguno de esos tres → activá modo `--force`.
4. Si está vacío o NO matchea (incluyendo cualquier cosa con `;`, `&`, `|`, `` ` ``, `$`, paréntesis, espacios, etc.) → modo `--incremental`.

**Nunca interpoles `$ARGUMENTS` en el comando shell.** Los dos flags válidos (`--force` / `--incremental`) son strings literales hardcoded — el LLM elige cuál usar, pero los bytes del usuario nunca van al shell.

Si detectás caracteres peligrosos en `$ARGUMENTS`, antes de ejecutar reportá:

> No reconozco esos argumentos. Formas válidas: `/reindex-memory` (incremental), `/reindex-memory full` (reindex completo).

## Comando a ejecutar

Si el parsing arrojó modo force, ejecutá:

```bash
node vault/memory/.engine/launcher.mjs index --force
```

Si no, ejecutá:

```bash
node vault/memory/.engine/launcher.mjs index --incremental
```

**Ejecutalo directamente.** NO hagas healthchecks previos, NO verifiques existencia de archivos — el script ya valida todo internamente y reporta errores claros con mensajes específicos en el output.

## Cómo reportar el resultado

Leé el stdout/stderr del script. Casos:

### Caso 1 — Exit 0, terminó OK

Output incluye `[memory] done in Xs: A indexed, B unchanged, C chunks total`.

Reportá en español argentino (voseo), ≤4 líneas:

> ✅ Reindex terminado en X s.
> Archivos: A indexados (con cambios), B sin cambios.
> Total en Qdrant: C chunks en la collection del proyecto.

Si fue full reindex (`--force`), agregá:
> Tip: la próxima vez podés usar `/reindex-memory` sin args — incremental es mucho más rápido.

### Caso 2 — `qdrant unreachable`

Output incluye `[memory] qdrant unreachable at http://localhost:6333`.

Reportá:

> ⚠️ Qdrant no está corriendo. Levantalo con:
>
> ```bash
> docker compose -f ~/.phobos/docker-compose.qdrant.yml up -d
> ```
>
> Esperá 5 segundos y volvé a correr `/reindex-memory`.

### Caso 3 — `Unauthorized` (bug del template viejo)

Output incluye `[memory] fatal: Unauthorized`, o `401`, o "api key".

Reportá:

> ⚠️ Qdrant está corriendo pero rechaza con `Unauthorized`. Es un bug de una versión vieja del template del docker-compose que activaba auth con key vacía.
>
> Para arreglarlo, salí de Claude Code y corré:
>
> ```bash
> docker compose -f ~/.phobos/docker-compose.qdrant.yml down
> rm ~/.phobos/docker-compose.qdrant.yml
> npx github:sebaarce/phobos
> ```
>
> En el wizard elegí **Memory (RAG)** — el step 5 va a detectar que falta el compose y lo regenera con la versión nueva (sin la línea rota). Después volvés a Claude Code y `/reindex-memory` va a andar.

### Caso 4 — Archivo del engine no existe

Output incluye `Cannot find module` o `ENOENT` sobre `vault/memory/.engine/`.

Reportá:

> ⚠️ La memoria semántica no está instalada en este proyecto. Salí de Claude Code y corré:
>
> ```bash
> npx github:sebaarce/phobos
> ```
>
> Elegí **Memory (RAG)** en el menú principal. El wizard instala dependencias, levanta Qdrant y hace la primera indexación.

### Caso 5 — Otro error / exit code != 0

Reportá las últimas 3-5 líneas del stderr:

> ⚠️ El reindex falló (exit N). Output:
> ```
> <últimas líneas del stderr>
> ```
>
> Posibles causas: archivo corrupto en `vault/memory/`, error de red al descargar el modelo Xenova, falta de RAM.

## Lo que NO hacés en este comando

- No abrís sub-agents (Agent tool) — esto es directo.
- No verificás existencia de archivos antes — el script lo hace.
- No hacés healthcheck de Qdrant antes — el script lo hace.
- No leés ni modificás archivos del vault — el script lo hace.
- No transcribís más de 5 líneas del output crudo al chat — resumí.

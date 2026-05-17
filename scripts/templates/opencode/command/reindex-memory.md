---
description: Re-indexa la memoria semántica del vault en Qdrant. Incremental por defecto, --force para reindex completo.
agent: phobos
---

El usuario invocó `/reindex-memory` — esto es un comando administrativo, NO una tarea SDD. **No abras el pipeline normal** (no delegues a researcher/planner/programmer/tester). Tu rol acá es ejecutar el script de indexación y traducir el output al chat en español argentino.

## Argumentos del usuario

`$ARGUMENTS`

Interpretación:

- Vacío o cualquier valor que no sea reconocido → **incremental** (default, rápido — solo re-indexa archivos cuyo hash SHA-1 cambió).
- `full`, `force`, `--force` → **reindex completo** (más lento, re-vectoriza todo el vault).

## Pasos a ejecutar

### Paso 1 — Verificar que la memoria esté instalada

Ejecutá:

```bash
ls vault/memory/.engine/index-vault.mjs
```

Si el archivo NO existe, respondé al usuario (en español) algo equivalente a:

> La memoria semántica no está instalada en este proyecto todavía. Para instalarla, salí de OpenCode y corré:
>
> ```bash
> npx github:sebaarce/phobos
> ```
>
> En el menú principal elegí **Memory (RAG)**. El wizard instala dependencias, levanta Qdrant en Docker y hace la primera indexación.

Y terminá ahí — no avances al paso 2.

### Paso 2 — Verificar que Qdrant esté corriendo

Probá un health check rápido:

```bash
curl -sf http://localhost:6333/healthz -o /dev/null && echo "qdrant-ok" || echo "qdrant-down"
```

Si la salida es `qdrant-down`, decile al usuario:

> Qdrant no está corriendo. Levantalo con:
>
> ```bash
> docker compose -f ~/.phobos/docker-compose.qdrant.yml up -d
> ```
>
> Esperá 5 segundos y volvé a correr `/reindex-memory`.

Y terminá ahí — no intentes indexar contra un Qdrant caído.

### Paso 3 — Ejecutar el reindex

Si `$ARGUMENTS` contiene `full`, `force` o `--force`:

```bash
node vault/memory/.engine/index-vault.mjs --force
```

Si no:

```bash
node vault/memory/.engine/index-vault.mjs --incremental
```

### Paso 4 — Reportar al usuario

Leé el stdout del script. Va a tener líneas como:

```
[memory] qdrant: http://localhost:6333
[memory] model: Xenova/multilingual-e5-small (384d)
[memory] indexing N file(s) (incremental)
  ✓ vault/memory/insights/foo.md → 3 chunk(s)
  · vault/memory/wiki/bar.md (unchanged)
  ...
[memory] done in 4.2s: X indexed, Y unchanged, Z chunks total
```

Reportá al usuario en ≤5 líneas (español, voseo):

- Cantidad de archivos indexados (cambiados) y sin cambios.
- Total de chunks en Qdrant.
- Tiempo total.
- Si fue full reindex, recordale que para próximas veces basta con `/reindex-memory` (sin args) y es mucho más rápido.

Ejemplo de reporte exitoso:

> ✅ Reindex incremental terminado en 4.2s.
> Archivos: 2 indexados (con cambios), 18 sin cambios.
> Total en Qdrant: 47 chunks en la collection del proyecto.

Ejemplo de error si el script salió con código != 0:

> ⚠️ El reindex falló con código N. Output relevante:
> `<últimas 3-5 líneas del stderr>`
> Probables causas: Qdrant cayó durante el proceso, espacio en disco, o un archivo del vault corrupto.

## Lo que NO hacés en este comando

- No abrís ninguna sesión hija (Task) — esto es directo.
- No leés ni modificás archivos del vault — el script lo hace solo.
- No interpretás el contenido del vault — solo reportás métricas.
- No transcribís output crudo de varias líneas al chat — resumí.

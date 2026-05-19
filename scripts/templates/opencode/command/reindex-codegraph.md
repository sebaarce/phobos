---
description: Re-indexa el código del proyecto en CodeGraph (.codegraph/codegraph.db).
agent: phobos
---

El usuario invocó `/reindex-codegraph` — comando administrativo, NO una tarea SDD. Tu único trabajo es: ejecutar `node .codegraph/cg.cjs index`, leer su output, traducir al chat en español argentino.

## Argumentos del usuario

`$ARGUMENTS`

Interpretación:
- Vacío o cualquier valor que no sea reconocido → re-index normal (CodeGraph detecta cambios automáticamente).
- `full`, `force`, `--force` → re-index normal (mismo comando — CodeGraph no expone una flag `--force` separada, el index ya reconstruye lo necesario).

## Argument parsing (HARD RULE — seguridad)

`$ARGUMENTS` es input del usuario sin sanitizar. **NO lo concatenes literal a un comando shell**. Para este comando hacé el parsing así:

1. Tomá `$ARGUMENTS` y stripealo de whitespace.
2. Comparalo (lowercase) contra el set exacto `{"full", "force", "--force"}`.
3. Si matchea EXACTAMENTE alguno de esos tres → mostrá un hint que CodeGraph siempre re-indexa todo lo que cambió y el comando es el mismo.
4. Si está vacío o NO matchea (incluyendo cualquier cosa con `;`, `&`, `|`, `` ` ``, `$`, paréntesis, espacios, etc.) → ejecutá el index estándar.

**Nunca interpoles `$ARGUMENTS` en el comando shell.** El comando a ejecutar es siempre el mismo string literal hardcoded.

Si detectás caracteres peligrosos en `$ARGUMENTS`, antes de ejecutar reportá:

> No reconozco esos argumentos. Forma válida: `/reindex-codegraph` (sin args).

## Comando a ejecutar

```bash
node .codegraph/cg.cjs index
```

**Ejecutalo directamente.** NO hagas healthchecks previos extensos — el comando mismo te dice si el binario o la DB no existen.

Solo un check rápido permitido ANTES de invocar (opcional, ayuda a dar mejor error si falta):

```bash
ls .codegraph/cg.cjs 2>/dev/null
```

Si ese ls falla → andá directo al Caso 2 ("CodeGraph no instalado") y NO ejecutes el index.

## Cómo reportar el resultado

Leé el stdout/stderr del script. Casos:

### Caso 1 — Exit 0, terminó OK

Output incluye un bloque tipo:

```
┌  Indexing project
│  Scanning files — N found
│  Parsing code — done
│  Resolving refs
◆  Indexed N files
●  X nodes, Y edges in Z ms
└  Done
```

Reportá en español argentino (voseo), ≤4 líneas:

> ✅ CodeGraph re-indexado en Z ms.
> N archivos · X nodes · Y edges.
> El @researcher ahora ve la versión actualizada del código.

### Caso 2 — CodeGraph no instalado

`ls` no encuentra `.codegraph/cg.cjs`, o el comando falla con `Cannot find module '.../cg.cjs'`, o `ENOENT` sobre `.codegraph/`.

Reportá:

> ⚠️ CodeGraph no está instalado en este proyecto. Salí de OpenCode y corré:
>
> ```bash
> npx github:sebaarce/phobos
> ```
>
> Elegí **Instalar herramientas** → **Instalar CodeGraph**. El wizard hace el install aislado en `.codegraph/`, lo inicializa, y corre la primera indexación. Después volvé y `/reindex-codegraph` va a andar.

### Caso 3 — Paquete instalado pero falta la DB

Output incluye algo como `Cannot find database` o `codegraph.db not found` o termina sin generar el archivo.

Reportá:

> ⚠️ El paquete de CodeGraph está pero falta la DB inicial. Corré:
>
> ```bash
> node .codegraph/cg.cjs init
> node .codegraph/cg.cjs index
> ```
>
> O alternativamente: `phobos` → **Instalar herramientas** → **Instalar CodeGraph** → elegí *"Re-indexar"*.

### Caso 4 — `MODULE_NOT_FOUND` sobre `@colbymchenry/codegraph`

Output incluye `Cannot find module '@colbymchenry/codegraph/package.json'` o similar.

Reportá:

> ⚠️ La instalación de CodeGraph en `.codegraph/node_modules/` está corrupta (suele pasar con pnpm en workspaces). Salí de OpenCode y corré:
>
> ```bash
> rm -rf .codegraph
> npx github:sebaarce/phobos
> ```
>
> En el wizard elegí **Instalar herramientas** → **Instalar CodeGraph**. La instalación nueva usa `npm` aislado y el shim `.codegraph/cg.cjs`, que evita el problema.

### Caso 5 — Lenguaje no soportado por parsers

Output incluye `unsupported language` o errores de tree-sitter sobre archivos específicos.

Reportá las primeras 2 líneas del error y mencioná que CodeGraph soporta 19+ lenguajes (TypeScript, JavaScript, Python, Go, Rust, Java, C#, PHP, Ruby, C, C++, Swift, Kotlin, Dart, Svelte, Vue, Liquid, Pascal/Delphi) pero **no todos**.

> ⚠️ CodeGraph falló parseando algunos archivos. Últimas líneas del error:
>
> ```
> <últimas 2-3 líneas del stderr>
> ```
>
> Si tu proyecto usa un lenguaje fuera del soporte de CodeGraph, los archivos de ese lenguaje quedan fuera del grafo (pero el resto del proyecto se indexa igual). El @researcher usa CodeGraph para los lenguajes soportados y cae a `Select-String` / `Get-ChildItem` para el resto.

### Caso 6 — Otro error / exit code != 0

Reportá las últimas 3-5 líneas del stderr:

> ⚠️ Re-index de CodeGraph falló (exit N). Output:
> ```
> <últimas líneas del stderr>
> ```
>
> Posibles causas: corrupción de `.codegraph/codegraph.db` (probá borrarla y re-correr), falta de espacio en disco, archivo del repo bloqueado por otro proceso.

## Cuándo usarlo (referencia para el usuario)

El comando es para refrescar el índice cuando:
- Hiciste un refactor grande (rename masivo, mover módulos, agregar/quitar archivos).
- Las queries del researcher devuelven resultados desactualizados.
- Acabás de hacer pull de cambios grandes (`git pull` con muchos archivos modificados).

No hace falta correrlo después de cada commit chico — CodeGraph tiene auto-sync vía FS watchers (FSEvents/inotify/ReadDirectoryChangesW) que detecta cambios en segundos.

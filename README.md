# phobos-cli

CLI para bootstrap y configuración del sistema de agentes **Phobos** sobre [OpenCode](https://opencode.ai).

Phobos es un orquestador SDD (Spec-Driven Delivery) compuesto por 6 agentes especializados con memoria persistente en un vault de Obsidian. `phobos-cli` te permite instalar el sistema en cualquier proyecto y configurar los modelos de cada agente desde una TUI sin tocar archivos a mano.

---

## Tabla de contenidos

- [Qué es esto](#qué-es-esto)
- [Construcción — historial](#construcción--historial)
- [Comandos que se usaron](#comandos-que-se-usaron)
- [Instalación](#instalación)
- [Uso](#uso)
- [El sistema Phobos en detalle](#el-sistema-phobos-en-detalle)
- [Desinstalación](#desinstalación)
- [Iteración y desarrollo](#iteración-y-desarrollo)
- [Referencias](#referencias)

---

## Qué es esto

Tres piezas conectadas:

1. **El sistema Phobos** — 6 agentes (`phobos`, `researcher`, `planner`, `programmer`, `tester`, `archivist`) + 2 comandos custom (`/adapt-agents`, `/models-wizard`) + vault de memoria persistente. Viven en `.opencode/` y `vault/` de cada proyecto.

2. **El CLI `phobos`** — un script Node.js standalone (`scripts/configure-models.mjs`) que hace dos cosas:
   - **Bootstrap** del sistema Phobos en cualquier proyecto (copia los templates).
   - **Configuración interactiva** de modelos por agente con TUI navegable.

3. **Los templates** — copia limpia de `.opencode/` y `vault/` en `scripts/templates/` que el CLI usa para bootstrappear proyectos nuevos.

Disponible públicamente en **[github.com/sebaarce/phobos](https://github.com/sebaarce/phobos)**. Lo más rápido para usarlo:

```bash
npx github:sebaarce/phobos
```

No requiere clonar el repo ni `npm link`. Cada vez que corrés ese comando, npx descarga (o usa cache) la última versión de `main` desde GitHub.

---

## Construcción — historial

Esto se construyó iterativamente. Resumen de las etapas:

### 1. Agentes base
Creamos 6 archivos `.md` con frontmatter YAML siguiendo el formato OpenCode:
- `phobos.md` — orquestador primary
- `researcher.md` — investiga, write scoped a `vault/memory/tasks/**/research.md`
- `planner.md` — planifica con checkboxes, scoped a `plan.md`
- `programmer.md` — implementa, edit broad, git mutations denegadas
- `tester.md` — valida; ante fallos pregunta al usuario, soporta skip
- `archivist.md` — destila memoria al cierre, escribe `conclusion.md`+ insights/wiki/glossary

### 2. Memoria — vault de Obsidian
Pasamos de una idea de carpeta `sdd/` plana al patrón [obsidian-memory-for-ai](https://github.com/jrcruciani/obsidian-memory-for-ai) con `vault/SCHEMA.md`, `vault/TASKS.md`, `vault/memory/{tasks,insights,wiki,glossary}/`. Naming **por ticket** en `tasks/`, **por tópico** en insights/wiki/glossary.

### 3. Política de git estricta
**Ningún agente puede ejecutar mutaciones git**. `permission.bash` con `deny` explícito en `git commit*`, `git push*`, `git add*`, `git reset --hard*`, `git checkout --*`, `git rebase*`, `git merge*`, `git stash*`, `git tag*`. Lectura sí (`git status`, `diff`, `log`, `show`).

### 4. Permisos scoped por path
Aprovechando `permission.edit` con globs:
- `researcher`: solo puede escribir `vault/memory/tasks/**/research.md`
- `planner`: solo `vault/memory/tasks/**/plan.md`
- `archivist`: solo `vault/memory/**` y `vault/TASKS.md`

### 5. Comandos custom
- `/adapt-agents` — corre después de `/init` de OpenCode. Adapta `AGENTS.md` agregando secciones sobre Phobos.
- `/models-wizard` — redirige a `npx github:sebaarce/phobos` (la UX rica vive en el CLI).

### 6. Script de configuración de modelos
Empezó como prompt en Phobos, después migró a un Node.js script porque:
- Listar 50+ modelos en chat es caro y propenso a errores.
- Filtros y grouping son código real, no prompt-engineering.
- Funciona incluso si Phobos está mal configurado (bootstrap).

### 7. Detección real de proveedores y modelos
Descubrimos que OpenCode CLI expone `opencode models [provider]` y `opencode providers list`. El script los usa directamente:
- Lee `~/.local/share/opencode/auth.json` para detectar providers conectados.
- Corre `opencode models` para listar los 53 modelos (o los que sean).
- Para cada provider detectado, corre `opencode models <provider>` por si tiene IDs no listados en el default.

### 8. TUI completa
- **Header ASCII** "PHOBOS" en cyan al inicio.
- **Selector de provider** (solo si hay >1 conectado).
- **Recomendación automática** basada en heurística sobre nombres de modelos (tiers: top/mid/low/code).
- **Modos**: aplicar sugerencia, preset uniforme, custom por agente, cambiar proveedor, cancelar y salir.
- **Picker custom** con cursor navegable (↑/↓), filtros (`/`), grouping por provider, marcador `●` para el actual.
- **Box prominente por agente** con letras espaciadas `P H O B O S`, modelo actual y modelo sugerido.
- **Resumen final** en panel con diff (`↻ cambio` vs `· igual`).
- **Bootstrap inicial** con barras de progreso (`Creando agentes 7/7`, `Creando estructura de memory 8/8`).

### 9. Validaciones de entorno
- Si el CLI de OpenCode no está en PATH → mensaje + exit.
- Si no hay proveedores conectados → mensaje con instrucciones para correr `/connect` + exit.
- Detección de TTY: si está pipeado o redirigido, hay fallbacks no-interactivos.

### 10. Templates portables
La carpeta `scripts/templates/` contiene copia limpia de `.opencode/` y `vault/`. Cuando se ejecuta el CLI en una carpeta vacía, copia desde ahí.

---

## Comandos que se usaron

Ejecutados desde `d:/IA/opencode` durante el setup:

```bash
# Crear estructura de directorios del sistema
mkdir -p .opencode/agent .opencode/command
mkdir -p vault/sources vault/memory/{tasks,insights,wiki,glossary}

# Crear estructura del CLI
mkdir -p scripts
mkdir -p scripts/templates/opencode/{agent,command}
mkdir -p scripts/templates/vault/sources
mkdir -p scripts/templates/vault/memory/{tasks,insights,wiki,glossary}

# Copiar el estado actual a los templates
cp .opencode/agent/*.md scripts/templates/opencode/agent/
cp .opencode/command/*.md scripts/templates/opencode/command/
cp vault/SCHEMA.md vault/TASKS.md vault/README.md scripts/templates/vault/
cp vault/sources/.gitkeep scripts/templates/vault/sources/
cp vault/memory/tasks/.gitkeep scripts/templates/vault/memory/tasks/
cp vault/memory/insights/.gitkeep scripts/templates/vault/memory/insights/
cp vault/memory/wiki/.gitkeep scripts/templates/vault/memory/wiki/
cp vault/memory/glossary/.gitkeep scripts/templates/vault/memory/glossary/
cp .gitignore scripts/templates/.gitignore

# Instalar globalmente (creates symlink)
npm link

# Verificar instalación global
npm ls -g --depth=0 | grep phobos
# → phobos-cli@0.1.0 -> .\D:\IA\opencode
```

Después de esto, `npx phobos` funciona desde cualquier carpeta.

### Comandos de OpenCode que el script invoca

El CLI los corre internamente; los listo por referencia:

```bash
opencode --version                  # verifica CLI presente
opencode models                     # lista todos los modelos del provider default
opencode models <provider-name>     # lista modelos de un provider específico
```

### Comandos que el usuario corre por su cuenta

Una vez instalado el sistema en un proyecto:

```bash
opencode                            # inicia OpenCode TUI
/init                               # genera AGENTS.md (nativo de OpenCode)
/adapt-agents                       # nuestro comando custom para adaptar AGENTS.md
/connect                            # conectar un proveedor (si no hay ninguno)
npx phobos                   # bootstrap + configurar modelos
npx autoskills                      # (opcional) generar skills/ del proyecto
```

---

## Instalación

### Opción A — Desde GitHub (recomendado, sin setup)

El repo es público en **[github.com/sebaarce/phobos](https://github.com/sebaarce/phobos)**. Desde cualquier carpeta:

```bash
npx github:sebaarce/phobos
```

npx descarga el paquete (o usa cache) y ejecuta el bin `phobos`. La primera vez tarda unos segundos clonando; las siguientes son instantáneas.

Para forzar la última versión (sin cache):
```bash
npx --no-cache github:sebaarce/phobos
```

Para pinear a un commit/tag/branch específico:
```bash
npx github:sebaarce/phobos#main
npx github:sebaarce/phobos#v0.1.0
npx github:sebaarce/phobos#abc1234
```

### Opción B — `npm link` (para desarrollo local)

Una sola vez por máquina:

```bash
# 1. Cloná o copiá este directorio donde quieras tenerlo
git clone <este-repo> opencode
# o
cp -r d:/IA/opencode/ ~/code/phobos-cli/

# 2. Entrar al directorio
cd opencode

# 3. Crear el symlink global
npm link
```

`npm link` registra el paquete `phobos-cli` en el directorio global de npm con un symlink al directorio donde estás. Desde ese momento `npx phobos` (o `phobos` a secas) funciona desde cualquier carpeta del sistema.

### Verificar que esté instalado

```bash
npm ls -g --depth=0 | grep phobos
# Output esperado:
#   phobos-cli@0.1.0 -> .\D:\IA\opencode
```

### Requisitos

- **Node.js ≥ 18**
- **OpenCode CLI** instalado y con al menos un proveedor conectado (correr `/connect` dentro de OpenCode)
- (opcional) **Obsidian** para navegar el vault de memoria como grafo de wikilinks

---

## Uso

Desde cualquier proyecto donde quieras usar Phobos:

```bash
cd mi-proyecto
npx phobos
```

El CLI guía todo el flujo:

1. **Bootstrap si falta** — pregunta `¿Querés instalar los agentes en este proyecto?` Si Sí, copia los templates con progress bars.
2. **Detección de modelos** — silenciosa si todo OK. Si falla la CLI de OpenCode o no hay providers, sale con instrucciones.
3. **Panel "Detección"** — muestra cuántos providers y modelos están disponibles.
4. **Selector de provider** (si hay >1) — TUI con cursor.
5. **Sugerencia automática** en panel + menú de modo (aplicar / uniforme / custom / cambiar proveedor / cancelar).
6. **Picker por agente** (si custom) — TUI navegable con filtros.
7. **Resumen** en panel con diff.
8. **Confirmación** Sí/No → escribe los `model:` que cambian.

### Alternativas de invocación

```bash
npx phobos       # global (recomendado, tras npm link)
phobos           # también global, sin npx
npm run models          # desde la raíz del repo
node scripts/configure-models.mjs   # directo
```

---

## El sistema Phobos en detalle

### Estructura instalada en cada proyecto

```
mi-proyecto/
├── .opencode/
│   ├── agent/
│   │   ├── phobos.md       # primary  — orquestador
│   │   ├── researcher.md   # subagent — investiga (write scoped)
│   │   ├── planner.md      # subagent — diseña el plan (scoped)
│   │   ├── programmer.md   # subagent — implementa código
│   │   ├── tester.md       # subagent — valida, pregunta al usuario ante fallos
│   │   ├── archivist.md    # subagent — destila memoria al cierre
│   │   └── README.md       # docs del sistema
│   └── command/
│       ├── adapt-agents.md # /adapt-agents
│       └── models-wizard.md# /models-wizard (redirige a npx github:sebaarce/phobos)
├── AGENTS.md           # generado por /init de OpenCode
├── vault/              # memoria persistente
│   ├── SCHEMA.md       # reglas del vault
│   ├── TASKS.md        # Current / Active / Archive
│   ├── README.md
│   ├── sources/        # inputs crudos del usuario (gitignored)
│   └── memory/
│       ├── tasks/<slug>/      # artefactos por-tarea
│       ├── insights/          # aprendizajes destilados (por tópico)
│       ├── wiki/              # conceptos durables (por tópico)
│       └── glossary/          # términos del dominio (por tópico)
└── .gitignore
```

### Flujo de una tarea

```
Usuario abre tarea con Phobos
        │
        ▼
Phobos pregunta slug ──▶ crea vault/memory/tasks/<slug>/  +  TASKS.md → Current
        │
        ▼
@researcher ──▶ research.md (write scoped a su path)
        │
        ▼
@planner ──▶ plan.md con checkboxes  (usuario aprueba)
        │
        ▼
@programmer ──▶ código + implementation.md
                Phobos togglea checkboxes [x] por paso
        │
        ▼
@tester ──▶ test-report.md
            Si falla → pregunta al usuario qué acción tomar (a/b/c/d)
            Si skip → reporte mínimo ⊘ SKIPPED
        │
        ▼
@archivist ──▶ conclusion.md + entradas en insights/wiki/glossary
                Naming POR TÓPICO, no por ticket
        │
        ▼
Phobos cierra: TASKS.md → Archive, sugiere comandos de git al usuario
```

### Política de git (crítica)

**Ningún agente ejecuta nunca `git commit`, `git push`, `git add`** ni mutaciones del repo. El usuario maneja git siempre.

Implementado vía `permission.bash` con `deny` explícito en cada `.md` de agente:
```yaml
permission:
  bash:
    "git push*": deny
    "git commit*": deny
    "git add*": deny
    "git reset --hard*": deny
    "git checkout --*": deny
    "git rebase*": deny
    "git merge*": deny
    "git stash*": deny
    "git tag*": deny
```

Lectura sí permitida: `git status`, `diff`, `log`, `show`.

### Heurística de recomendación

El CLI clasifica modelos por tier basado en patrones de nombre:

| Tier  | Patrones                            | Ejemplos                          |
|-------|-------------------------------------|-----------------------------------|
| top   | `opus`, `big-pickle`, `-pro`, `5.5` | `claude-opus-4-7`, `gpt-5.5-pro`  |
| mid   | `sonnet`, `gpt-5`, `gpt-4.1`        | `claude-sonnet-4-6`, `gpt-5.4`    |
| low   | `haiku`, `nano`, `mini`, `flash`    | `claude-haiku-4-5`, `gpt-5-nano`  |
| code  | `codex`, `grok-code`                | `gpt-5-codex`, `grok-code-fast-1` |

Pesos por agente:

| Agente     | Prefiere               |
|------------|------------------------|
| phobos     | top → mid              |
| planner    | top                    |
| programmer | code → mid → top       |
| researcher | low → mid              |
| tester     | low                    |
| archivist  | mid → top              |

Tie-breaker: ID lex-mayor (típicamente versión más nueva).

---

## Desinstalación

### Sacar el comando global (sin tocar archivos)

```bash
npm unlink -g phobos-cli
```

Esto remueve el symlink del directorio global de npm. El comando `phobos` deja de existir en el PATH. El directorio fuente queda intacto donde está.

Verificar que se removió:
```bash
npm ls -g --depth=0 | grep phobos
# (no output)
```

### Borrar todo el setup

```bash
# 1. Sacar el link global
npm unlink -g phobos-cli

# 2. Borrar el directorio fuente
rm -rf /ruta/a/opencode/

# o en Windows:
# rmdir /s /q D:\IA\opencode
```

### Quitar Phobos de un proyecto específico (sin desinstalar el CLI)

```bash
cd mi-proyecto
rm -rf .opencode/ vault/
# Editar AGENTS.md a mano para sacar la sección "Sistema de agentes y memoria"
```

---

## Iteración y desarrollo

Como `npm link` crea un **symlink**, cualquier cambio al script se refleja al instante en `npx phobos` desde cualquier carpeta. No hay que reinstalar.

```bash
# Editás scripts/configure-models.mjs
# Probás desde otra carpeta
cd /tmp/test
npx phobos   # usa la última versión automáticamente
```

Lo mismo aplica a los templates en `scripts/templates/` — si los editás, el próximo bootstrap usa la versión nueva.

### Probar el bootstrap en limpio

```bash
mkdir /tmp/test-phobos && cd /tmp/test-phobos
npx phobos   # detecta carpeta vacía, ofrece bootstrap
```

### Validar sintaxis del script

```bash
cd <ruta>/opencode
node --check scripts/configure-models.mjs
```

### Actualizar templates con el estado actual

Si modificás `.opencode/agent/phobos.md` (por ejemplo) en el proyecto fuente y querés que esos cambios se propaguen al template:

```bash
cd <ruta>/opencode
cp .opencode/agent/*.md scripts/templates/opencode/agent/
cp .opencode/command/*.md scripts/templates/opencode/command/
cp vault/SCHEMA.md vault/TASKS.md vault/README.md scripts/templates/vault/
```

---

## Estructura del repo

```
opencode/
├── README.md             # este archivo
├── package.json          # bin: phobos → scripts/configure-models.mjs
├── .gitignore
├── scripts/
│   ├── configure-models.mjs   # el CLI (~700 líneas, sin deps externas)
│   └── templates/             # copia de .opencode/ y vault/ para bootstrap
│       ├── .gitignore
│       ├── opencode/
│       │   ├── agent/*.md
│       │   └── command/*.md
│       └── vault/
│           ├── SCHEMA.md, TASKS.md, README.md
│           ├── sources/.gitkeep
│           └── memory/{tasks,insights,wiki,glossary}/.gitkeep
├── .opencode/            # sistema Phobos instalado en este repo (autoreferencial)
│   ├── agent/*.md        # los 6 agentes + README
│   └── command/*.md      # adapt-agents, models-wizard
└── vault/                # vault del propio repo
    ├── SCHEMA.md
    ├── TASKS.md
    ├── README.md
    ├── sources/
    └── memory/
        ├── tasks/
        ├── insights/
        ├── wiki/
        └── glossary/
```

---

## Referencias

- [OpenCode docs — agentes](https://opencode.ai/docs/es/agents/)
- [OpenCode docs — rules / AGENTS.md](https://opencode.ai/docs/es/rules/)
- [OpenCode docs — comandos](https://opencode.ai/docs/es/commands/)
- [OpenCode docs — permisos](https://opencode.ai/docs/es/permissions/)
- [obsidian-memory-for-ai](https://github.com/jrcruciani/obsidian-memory-for-ai) — patrón de vault que usamos

---

## Estado

Versión **0.1.0**. No publicado a npm. Funciona en Windows con OpenCode Zen y GitHub Copilot como proveedores; testeado con 53 modelos detectados.

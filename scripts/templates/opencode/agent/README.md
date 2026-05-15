# Phobos — Sistema de agentes SDD para OpenCode con memoria Obsidian

Orquestador con flujo Spec-Driven Delivery + memoria persistente en un vault de Obsidian siguiendo el patrón [obsidian-memory-for-ai](https://github.com/jrcruciani/obsidian-memory-for-ai).

## Estructura

```
.opencode/
├── agent/
│   ├── phobos.md       # primary  — orquestador
│   ├── researcher.md   # subagent — investiga (write scoped a research.md)
│   ├── planner.md      # subagent — diseña el plan (write scoped a plan.md)
│   ├── programmer.md   # subagent — implementa código
│   ├── tester.md       # subagent — valida, pregunta al usuario ante fallos
│   ├── archivist.md    # subagent — destila memoria al cerrar tarea
│   └── README.md
└── command/
    └── adapt-agents.md # comando /adapt-agents

AGENTS.md               # contexto del proyecto (generado con /init)
skills/                 # skills de OpenCode (generadas con npx autoskills)
.gitignore              # excluye vault/sources/* por privacidad

vault/                  # memoria persistente
├── SCHEMA.md
├── TASKS.md
├── sources/            # inputs crudos del usuario (gitignored)
└── memory/
    ├── tasks/<slug>/   # artefactos por-ticket
    ├── insights/       # aprendizajes destilados (naming por tópico)
    ├── wiki/           # conceptos durables (por tópico)
    └── glossary/       # términos del dominio (por tópico)
```

## Setup inicial (una vez por proyecto)

```bash
opencode                    # abrir
/init                       # genera AGENTS.md base
/adapt-agents               # adapta AGENTS.md al flujo SDD/vault
/models-wizard              # (opcional) configura modelos por agente
npx autoskills              # genera skills/ del proyecto
```

Después seleccioná `phobos` como agente activo. En la primera tarea Phobos detecta que `vault/` falta y te ofrece bootstrappearlo.

## Política de git — **CRÍTICO**

**Ningún agente ejecuta nunca `git commit`, `git push`, `git add`** ni mutaciones del repo. El usuario maneja git siempre. Los agentes:
- Pueden leer estado con `git status`, `git diff`, `git log`, `git show`.
- Al cerrar tareas, sugieren los comandos para que el usuario los corra.

Esto está implementado vía `permission.bash` con `deny` explícito en todos los agentes.

## Flujo de una tarea

```
1. Phobos detecta AGENTS.md, vault/, skills/ — si falta algo lo sugiere
2. Phobos pregunta slug + si tests son required o skip
3. Crea vault/memory/tasks/<slug>/  +  TASKS.md → ## Current
4. @researcher                ─▶ research.md (write scoped)
5. @planner                   ─▶ plan.md con checkboxes (write scoped)
6. Phobos muestra plan, usuario aprueba
7. @programmer                ─▶ código + implementation.md
                                 Phobos togglea [x] por paso
                                 Reconcilia contra implementation.md al cerrar
8. @tester                    ─▶ test-report.md
                                 Si falla → pregunta al usuario qué hacer
                                 Si skip → reporte mínimo ⊘ SKIPPED
9. @archivist                 ─▶ conclusion.md + insights/wiki/glossary
                                 Naming POR TÓPICO, no por ticket
10. Phobos cierra: TASKS.md → Archive, sugiere comandos git
```

## Comandos custom

- `/adapt-agents` — corre después de `/init`. Adapta `AGENTS.md` agregando secciones sobre Phobos, vault, skills y política de git.
- `/models-wizard` — wizard interactivo para asignar el modelo de cada agente. **In-session** (corre dentro de OpenCode).

## Script de configuración desde terminal

Para configurar modelos **sin abrir OpenCode**, hay un script standalone:

```bash
node scripts/configure-models.mjs   # invocación directa
# o
npm run models                       # vía package.json
```

Sin dependencias externas (solo Node.js ≥ 18). Hace lo mismo que `/models-wizard`:
- Lee el `model:` actual de los 6 agentes.
- Ofrece presets (Opus / Sonnet / Haiku / Balanceado / Fast) o configuración por agente.
- Muestra diff y pide confirmación antes de escribir.
- Edita solo el campo `model:` en cada `.md`, nunca otra cosa.

## Permisos — scoping por path

OpenCode soporta `permission.edit` con globs. Reglas clave:
- Sintaxis: `"*": deny` primero, allows específicos después (la última regla coincidente gana).
- Patrones soportados: `*` (cero o más), `?` (exactamente uno). No es glob bash completo.

Cómo se ve en este proyecto:

| Agente     | edit scope                                            | bash                              |
|------------|-------------------------------------------------------|-----------------------------------|
| phobos     | `allow` (general)                                     | deny git mutations, ask `npx*`    |
| researcher | solo `vault/memory/tasks/**/research.md`              | solo comandos de lectura          |
| planner    | solo `vault/memory/tasks/**/plan.md`                  | todo deny                         |
| programmer | `allow` (general)                                     | deny git mutations                |
| tester     | `allow` (general)                                     | deny git mutations                |
| archivist  | solo `vault/memory/**` + `vault/TASKS.md`             | todo deny                         |

## Configuración de modelos

| Agente     | Modelo                | Temp | Razón                              |
|------------|----------------------|------|------------------------------------|
| phobos     | `claude-opus-4-7`     | 0.2  | Orquestación y juicio              |
| researcher | `claude-sonnet-4-6`   | 0.1  | Lectura, hechos                    |
| planner    | `claude-opus-4-7`     | 0.2  | Razonamiento de diseño             |
| programmer | `claude-sonnet-4-6`   | 0.1  | Código determinista                |
| tester     | `claude-haiku-4-5`    | 0.1  | Tests, barato y rápido             |
| archivist  | `claude-sonnet-4-6`   | 0.3  | Distilación con prosa de calidad   |

Editá el campo `model:` en cada `.md` para cambiarlos.

**Formato de model ID**: depende del provider que tengas configurado.
- Si usás **OpenCode Zen** (default): solo el ID, sin prefijo → `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`. Existe variante `-fast` para algunos (`claude-opus-4-7-fast`).
- Si usás un provider directo: puede pedir prefijo → `anthropic/claude-opus-4-5`, `openai/gpt-4o`, etc. Probá con y sin prefijo si tenés dudas.

**Para ver tu lista real de modelos**: abrí el selector de modelo en la UI de OpenCode (la línea de status muestra el modelo activo — click ahí o usá Tab para cambiar). También podés revisar `opencode.json` si tu provider está declarado ahí.

## Flujo de fallos en tests

Cuando `@tester` reporta `✗ FALLO`:
1. Phobos te muestra el reporte (test, mensaje, causa probable).
2. Te pregunta qué hacer:
   - **a)** Volver al Programmer para corregir
   - **b)** Re-ejecutar (si parece flaky)
   - **c)** Skip y documentar como follow-up
   - **d)** Abandonar la tarea
3. Esperás tu decisión — no asume.

También podés pedir **skip de tests al abrir la tarea** si tenés razón para hacerlo (prototipo, exploración, etc.). El Tester escribe entonces un reporte mínimo `⊘ SKIPPED`.

## Memoria — cómo se usa

| Capa            | Vive en                            | Quién la mantiene             | Naming      |
|-----------------|------------------------------------|-------------------------------|-------------|
| Stack proyecto  | `AGENTS.md`                        | `/init` + `/adapt-agents`     | -           |
| Schema vault    | `vault/SCHEMA.md`                  | Bootstrap, editable           | -           |
| Tareas vivas    | `vault/TASKS.md`                   | Phobos                        | -           |
| Per-tarea       | `vault/memory/tasks/<slug>/`       | Subagentes vía Phobos         | Por ticket  |
| Aprendizajes    | `vault/memory/insights/`           | Archivist al cerrar           | **Por tópico** |
| Conceptos       | `vault/memory/wiki/`               | Archivist cuando emerge       | **Por tópico** |
| Glosario        | `vault/memory/glossary/`           | Archivist al ver términos     | **Por tópico** |
| Inputs crudos   | `vault/sources/`                   | Usuario (drag-and-drop)       | Libre       |

**Wikilinks `[[]]`** conectan tareas con insights/wiki/glossary. Abrí `vault/` en Obsidian para ver el grafo.

## Cómo invocar

- **Primary**: seleccioná `phobos`. Delega a los subagentes y maneja el vault.
- **Subagente directo**: `@researcher`, `@planner`, `@programmer`, `@tester`, `@archivist`.
- **Comando**: `/adapt-agents` después de `/init`.

## Personalización

- Cambiar modelo → `model:` en el `.md`.
- Endurecer/aflojar permisos → bloque `permission:`. Recordá `deny` primero, `allow` específicos después.
- Cambiar comportamiento → cuerpo markdown del agente (es el system prompt).
- Cambiar reglas del vault → `vault/SCHEMA.md`.
- Hacer global → copiar `.opencode/agent/` a `~/.config/opencode/agent/`.

## Referencias

- Agentes OpenCode: https://opencode.ai/docs/es/agents/
- Rules / AGENTS.md: https://opencode.ai/docs/es/rules/
- Comandos: https://opencode.ai/docs/es/commands/
- Permisos: https://opencode.ai/docs/es/permissions/
- obsidian-memory-for-ai: https://github.com/jrcruciani/obsidian-memory-for-ai

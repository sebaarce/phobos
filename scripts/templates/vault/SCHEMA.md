# Memory Schema — Vault de Phobos

Este vault es la memoria persistente del proyecto, siguiendo el patrón
[obsidian-memory-for-ai](https://github.com/jrcruciani/obsidian-memory-for-ai).
Reglas para Phobos y subagentes:

## Capas

- **`sources/`** — Inputs crudos del usuario (PRDs, briefs, screenshots, mockups).
  No los modificás, solo los leés. El usuario los pone acá manualmente.
- **`memory/tasks/<slug>/`** — Artefactos por-tarea (research, plan, impl, test, conclusion).
  Una carpeta por ticket. El `<slug>` es el nombre de la tarea en kebab-case.
- **`memory/insights/<tema>.md`** — Aprendizajes destilados que aplican a múltiples tareas.
  Nacen al cerrar una tarea cuando un aprendizaje es genérico, no específico.
- **`memory/wiki/<concepto>.md`** — Conceptos durables del proyecto (módulos centrales,
  patrones arquitectónicos, decisiones de diseño explicadas en profundidad).
- **`memory/glossary/<término>.md`** — Vocabulario del dominio (términos de negocio,
  acrónimos del proyecto, conceptos no obvios).

## Reglas de escritura

- **Wikilinks `[[nombre]]`** para cross-referenciar entre tareas, insights, wiki y glossary.
  Ejemplo en una conclusión: `Aplica la convención de [[db-tests]] y resuelve [[bug-cors-prod]].`
- Cada nota tiene un `# Título` claro y una sección `## Updated YYYY-MM-DD` al final
  o un `**Cierre:** YYYY-MM-DD` en el frontmatter de texto.
- **Nunca borres** notas obsoletas — agregales una línea `> Outdated YYYY-MM-DD: motivo`
  al principio. La historia vale.
- **Insights** se crean cuando un aprendizaje aplica a >1 tarea o describe una
  restricción no documentada en `AGENTS.md`.
- **Wiki** se crea cuando un concepto recurre en >2 tareas y merece explicación durable.
- **Glossary** se crea cuando aparece un término que un nuevo miembro del equipo no
  entendería sin contexto.

## Reglas de lectura

- Al arrancar una tarea, Phobos escanea `TASKS.md` (Active + Archive) y los títulos
  de `memory/insights/` buscando match con el objetivo.
- Si encuentra match relevante, **cita la nota** antes de delegar al Researcher y
  pasale el contexto. Evitar re-investigar lo ya resuelto.
- Si el código actual contradice una nota vieja, **confiar en el código** y agregar
  `> Outdated` a la nota.

## TODOs y progreso

- El estado activo del proyecto vive en `TASKS.md`:
  - `## Current` — slug de la tarea en curso (solo uno a la vez).
  - `## Active` — tareas abiertas pero no en curso (paused o en backlog).
  - `## Archive` — tareas cerradas, cronológico inverso.
- Dentro de cada `memory/tasks/<slug>/plan.md`, los pasos usan checkboxes Markdown
  (`- [ ]` pendiente, `- [x]` hecho). Phobos togglea a medida que el Programmer
  reporta pasos completos.

## Localidad — vault local al proyecto

Este vault pertenece **exclusivamente al proyecto donde vive**. Reglas:

- Todo se escribe con **rutas relativas** al directorio del proyecto (`vault/...`, nunca `D:\...` ni `~/`).
- **No hay vault global**. Cada proyecto tiene su propio `vault/` junto a `.opencode/`.
- Si OpenCode se invoca desde una carpeta sin `.opencode/agent/`, Phobos detiene cualquier operación de vault y avisa al usuario.
- **Nunca se comparte memoria entre proyectos** vía vault. Si querés mover conocimiento de un proyecto a otro, copialo manualmente.

## Convenciones de nombres

### `memory/tasks/<slug>/` → naming por ticket
- `kebab-case` descriptivo, **prefijado con el ID del ticket si existe**:
  `tr-01-login-screen`, `jira-1234-fix-cors`, `auth-refresh-token` (sin ticket formal).
- Cada carpeta es única e irrepetible — agrupa todo el trabajo de **ese ticket**.

### `memory/insights/`, `memory/wiki/`, `memory/glossary/` → naming por **tópico**
- **Nunca prefijar con ticket.** Correcto: `oauth-client-contract.md`. Incorrecto: `tr-01-oauth-client-contract.md`.
- Un archivo por **concepto**, no uno por descubrimiento. Si un ticket futuro toca el mismo tema, se actualiza el archivo existente (nueva entrada en `## Origen` con `[[slug]]`), no se crea un duplicado.
- Sustantivo o frase sustantiva, no verbo: `token-rotation` (✓), `rotate-tokens` (✗).
- Si el tópico es muy genérico, prefijar con el dominio: `auth-token-rotation` en vez de `token-rotation`.

**Razón**: los insights, wikis y términos de glosario describen *conocimiento del proyecto*, no eventos. Viven mucho más que cualquier ticket individual. La trazabilidad al ticket original vive dentro del archivo (sección `## Origen` con wikilinks), nunca en el nombre.

## Updated 2026-05-13

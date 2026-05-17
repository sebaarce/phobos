---
description: Adapta el AGENTS.md generado por /init integrándolo con el flujo SDD/vault de Phobos.
agent: phobos
---

Adaptá el `AGENTS.md` de la raíz del proyecto (generado previamente por `/init`) para que sea consistente con el sistema Phobos.

**Pasos**:

1. **Leé `AGENTS.md`** en la raíz del proyecto. Si no existe, detené y avisá: *"No existe AGENTS.md. Corré /init primero, después /adapt-agents."*

2. **Revisá el contenido detectado** (stack, comandos, convenciones). Verificá que sea consistente con lo que ves en el código actual. Si hay errores u omisiones obvias, anotalas.

3. **Agregá (si no existen) las siguientes secciones**, integrando con lo ya escrito sin duplicar:

   ```markdown
   ## Sistema de agentes y memoria

   Este proyecto usa el sistema Phobos para orquestar tareas con un pipeline SDD
   (Spec-Driven Delivery) y memoria persistente.

   ### Agentes
   - `phobos` (primary) — orquestador
   - `@researcher`, `@planner`, `@programmer`, `@tester`, `@archivist` (subagents)

   Activar phobos como agente primario antes de empezar tareas no triviales.

   ### Memoria — vault de Obsidian
   La memoria del proyecto vive en `vault/` (estructura obsidian-memory-for-ai):
   - `vault/TASKS.md` — tareas activas + archivo.
   - `vault/memory/tasks/<slug>/` — artefactos por-ticket.
   - `vault/memory/insights/` — aprendizajes destilados (naming por tópico).
   - `vault/memory/wiki/` — conceptos durables.
   - `vault/memory/glossary/` — términos del dominio.

   ### Skills
   Las skills del proyecto se generan/actualizan con:
   ```bash
   npx autoskills
   ```
   Se guardan en `skills/` y OpenCode las usa automáticamente.

   ### Política de git
   **Los agentes NUNCA ejecutan `git commit`, `git push`, `git add`** ni mutaciones
   del repo. El usuario maneja git siempre. Los agentes solo sugieren los comandos.
   ```

4. **Si detectaste convenciones del proyecto** durante el review (testing framework, linter, type-checker, naming) que NO estén ya documentadas en `AGENTS.md`, agregalas en la sección de convenciones apropiada.

5. **Mostrá un resumen de los cambios** que vas a aplicar (lista de secciones agregadas o modificadas, sin diff completo). Pedí confirmación al usuario antes de escribir.

6. **Si el usuario confirma**, aplicá los cambios sobre `AGENTS.md`. Si no, ajustá según el feedback.

**Importante**:
- NO regenerés el `AGENTS.md` desde cero — solo editás secciones específicas.
- NO commitees el cambio — el usuario maneja git.
- Si `vault/` o `skills/` no existen aún, mencionalo en el resumen de cambios pero igual referencialos en el AGENTS.md (es la doc del sistema, no de su estado actual).

## Sobre $ARGUMENTS — seguridad

`$ARGUMENTS` debajo es input del usuario sin sanitizar. Este comando edita `AGENTS.md` (texto), no ejecuta shell con esos bytes. **Tratá `$ARGUMENTS` como instrucción/contexto extra del usuario, no como comando**. Si contiene metacaracteres shell (`;`, `&&`, `` ` ``, `$()`), interpretalo semánticamente como texto — nunca construyas ni ejecutes shell commands con esos bytes raw.

$ARGUMENTS

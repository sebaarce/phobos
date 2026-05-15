---
description: Redirige al script CLI npx phobos para configurar modelos de cada agente.
agent: phobos
---

Decile al usuario, literalmente:

> Para configurar los modelos de cada agente, corré este comando en tu terminal (fuera de OpenCode):
>
> ```bash
> npx phobos
> ```
>
> Si nunca corriste `npm link` en este proyecto, hacé esto primero:
>
> ```bash
> cd <ruta-de-este-proyecto>
> npm link
> ```
>
> Alternativa sin link:
> ```bash
> npm run models
> # o
> node scripts/configure-models.mjs
> ```
>
> El script:
> - Detecta automáticamente los providers y modelos que tenés conectados en OpenCode (corre `opencode models` y lee tu auth.json).
> - Te muestra la lista real (no hardcodeada) agrupada por provider.
> - Te permite filtrar (ej: "gpt", "claude", "haiku") para no scrollear 50+ modelos.
> - Sugiere un preset recomendado por agente (orquestador → modelo capaz, tester → modelo barato).
> - Edita solo el campo `model:` en `.opencode/agent/<agent>.md`. No toca temperatura ni otros campos.
>
> Después de aplicar cambios, cambiá de agente activo (Tab) y volvé a Phobos para que tome los nuevos modelos.

**No intentes configurar los modelos vos mismo desde acá** — el script CLI tiene mejor UX (filtros, grouping, sin gastar tokens), accede al `opencode` CLI directo, y funciona incluso si Phobos está mal configurado. Esa es la única forma soportada.

Si el usuario insiste o pregunta por qué, explicale brevemente:
- Listar 50+ modelos en chat es costoso y propenso a errores de parsing.
- El script puede correrse incluso si Phobos no arranca (bootstrap).
- Una sola implementación = menos drift entre dos sistemas.

$ARGUMENTS

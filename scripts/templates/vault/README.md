# Vault — Memoria persistente de Phobos

Este vault sigue el patrón [obsidian-memory-for-ai](https://github.com/jrcruciani/obsidian-memory-for-ai). Es una memoria persistente en Markdown plano: funciona sin Obsidian, pero abrirlo en Obsidian te da un grafo navegable.

## Cómo abrirlo en Obsidian (opcional)

1. Instalar [Obsidian](https://obsidian.md/).
2. **Open folder as vault** → seleccionar esta carpeta (`vault/`).
3. Activar la vista de grafo (icono de grafo en la barra lateral) para ver las conexiones entre tareas, insights, wiki y glossary vía wikilinks `[[]]`.

## Estructura

```
vault/
├── SCHEMA.md          ← schema/reglas (no borrar, editar para personalizar)
├── TASKS.md           ← estado vivo de tareas (Current / Active / Archive)
├── README.md          ← este archivo
├── sources/           ← inputs crudos del usuario (drag-and-drop PRDs, mockups)
└── memory/
    ├── tasks/<slug>/  ← una carpeta por ticket
    │   ├── README.md
    │   ├── research.md
    │   ├── plan.md          ← contiene checkboxes que Phobos togglea
    │   ├── implementation.md
    │   ├── test-report.md
    │   └── conclusion.md
    ├── insights/      ← aprendizajes cross-tarea
    ├── wiki/          ← conceptos durables del proyecto
    └── glossary/      ← términos del dominio
```

## Quién escribe qué

| Archivo                           | Lo escribe              |
|----------------------------------|-------------------------|
| `SCHEMA.md`                      | Bootstrap + vos manual  |
| `TASKS.md`                       | Phobos (auto)           |
| `sources/*`                      | Vos manualmente         |
| `memory/tasks/<slug>/*`          | Phobos + subagentes     |
| `memory/insights/*`              | Phobos al cerrar tareas |
| `memory/wiki/*`                  | Phobos cuando emerge un tema durable |
| `memory/glossary/*`              | Phobos al detectar términos del dominio |

## Convenciones

- **Wikilinks**: `[[slug-de-tarea]]`, `[[nombre-de-insight]]`.
- **Slugs**: `kebab-case` descriptivo (`auth-refresh-token`, no `task1`).
- **Notas obsoletas**: agregar `> Outdated YYYY-MM-DD: motivo` al inicio, no borrar.

Detalles en [SCHEMA.md](./SCHEMA.md).

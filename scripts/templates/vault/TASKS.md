# TASKS

Estado vivo de las tareas que Phobos está orquestando. Una sola tarea puede estar en `## Current` a la vez.

## Current

_(ninguna — esperando primera tarea)_

## Active

_(vacío)_

## Archive

_(vacío)_

---

**Formato de cada línea**:
```
- [[<slug>]] — <YYYY-MM-DD> — <estado> — <objetivo en una frase>
```

Ejemplos:
```
## Current
- [[auth-refresh-token]] — 2026-05-13 — in_progress — Agregar refresh token al flujo OAuth

## Archive
- [[fix-cors-prod]] — 2026-05-10 — ✓ done — Corregir headers CORS en producción
- [[migrate-postgres-15]] — 2026-04-22 — ⚠ partial — Migración a PG15, pendiente índices GIN
```

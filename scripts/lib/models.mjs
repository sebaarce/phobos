// Models — shim de retrocompatibilidad.
//
// El módulo real fue partido en `scripts/lib/models/` (catalog, ui, index)
// para mantenibilidad. Este archivo re-exporta TODO desde el index del
// nuevo paquete para que cualquier caller que importe `lib/models.mjs`
// siga funcionando sin cambios.
//
// Path canónico: `import { actionSetModels } from './lib/models.mjs'`
// también funciona. La estructura interna queda libre de ser refactorizada
// dentro de `models/` sin romper consumidores externos.

export * from './models/index.mjs';

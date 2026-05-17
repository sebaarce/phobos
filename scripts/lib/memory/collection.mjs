// Helpers para resolver nombre de collection del proyecto.
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { cwd } from 'node:process';
import { Buffer } from 'node:buffer';
import { fileExists } from '../fs-utils.mjs';
import { rl } from '../runtime.mjs';
import { cyan, dim, yellow, red, green } from '../colors.mjs';
import { tuiSelect } from '../tui.mjs';
import { listQdrantCollections, getCollectionSamples } from './engine.mjs';

// Convierte el nombre del proyecto en un slug "default" para Qdrant collection.
// Es solo el candidato inicial. La collection REAL del proyecto se persiste en
// vault/memory/.engine/config.json (ver getProjectActiveCollection).
export function projectCollectionSlug() {
  const base = basename(cwd()).toLowerCase();
  let slug = base.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) {
    slug = 'project-' + Buffer.from(cwd()).toString('hex').slice(0, 8);
  }
  return `phobos-vault-${slug}`;
}

// Devuelve la collection que el proyecto está USANDO realmente. Si Memory
// está instalada, lee el config.json; si no, devuelve el default basado en basename.
export async function getProjectActiveCollection() {
  try {
    const raw = await readFile('vault/memory/.engine/config.json', 'utf-8');
    const parsed = JSON.parse(raw);
    const fromConfig = parsed?.qdrant?.collection;
    if (fromConfig) return fromConfig;
  } catch {}
  return projectCollectionSlug();
}

// Resolver interactivo: decide qué collection usar para este proyecto.
// Detecta colisiones con collections existentes en Qdrant (otro proyecto con
// el mismo basename) y ofrece alternativas.
// Devuelve { slug, isReuse } o null si el usuario cancela.
export async function resolveCollectionSlug() {
  const cwdStr = cwd();
  const candidate = projectCollectionSlug();
  const existing = await listQdrantCollections();

  // Caso simple: no hay colisión
  if (!existing.includes(candidate)) {
    return { slug: candidate, isReuse: false };
  }

  // Colisión detectada. Tratamos de discriminar si es re-instalación
  // (mismo proyecto) o proyecto distinto, mirando una muestra existente.
  const samples = await getCollectionSamples(candidate, 1);
  const sampleFile = samples[0]?.payload?.filePath || '';
  let isSameProject = false;
  if (sampleFile) {
    isSameProject = await fileExists(sampleFile);
  }

  // Sugerir un nombre alternativo usando el directorio padre como discriminador.
  const parent = basename(dirname(cwdStr)).toLowerCase();
  const base = basename(cwdStr).toLowerCase();
  let altRaw = `${parent}-${base}`.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!altRaw) altRaw = 'project-' + Buffer.from(cwdStr).toString('hex').slice(0, 8);
  let altCandidate = `phobos-vault-${altRaw}`;
  // Si la alternativa también choca, agregar un suffix corto.
  if (existing.includes(altCandidate)) {
    altCandidate = `${altCandidate}-${Date.now().toString(36).slice(-4)}`;
  }

  console.log('');
  console.log('  ' + yellow('⚠ Ya existe la collection ') + cyan(`"${candidate}"`) + yellow(' en Qdrant.'));
  if (sampleFile) {
    console.log('  ' + dim('  Sample existente apunta a: ') + cyan(sampleFile));
    console.log('  ' + dim('  ¿Ese archivo existe en este proyecto? ')
      + (isSameProject
          ? green('SÍ — probable re-instalación del mismo proyecto')
          : yellow('NO — parece ser OTRO proyecto con el mismo basename')));
  } else {
    console.log('  ' + dim('  (collection vacía o sin muestras — no puedo discriminar de qué proyecto vino)'));
  }
  console.log('');

  const options = [
    isSameProject
      ? `Reusar "${candidate}"  ${green('(recomendado — parece el mismo proyecto)')}`
      : `Reusar "${candidate}"  ${red('(NO recomendado — mezclaría vectores de OTRO proyecto)')}`,
    `Crear nueva: "${altCandidate}"  ${(!isSameProject ? green('(recomendado para proyectos distintos)') : dim(''))}`,
    'Ingresar nombre custom',
    'Cancelar instalación',
  ];
  const defaultIdx = isSameProject ? 0 : 1;

  const choice = await tuiSelect('\n¿Qué hacés con el nombre de la collection?', options, defaultIdx);

  if (choice.index === 3) return null;
  if (choice.index === 0) return { slug: candidate, isReuse: true };
  if (choice.index === 1) return { slug: altCandidate, isReuse: false };
  // Custom
  rl.resume();
  console.log('');
  const custom = (await rl.question('  Nombre de la collection (sin prefijo "phobos-vault-"): ')).trim();
  rl.pause();
  let customSlug = custom.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!customSlug) {
    console.log('  ' + yellow('Nombre inválido. Cancelando.'));
    return null;
  }
  const finalSlug = `phobos-vault-${customSlug}`;
  if (existing.includes(finalSlug)) {
    console.log('  ' + yellow(`Ese nombre también existe ("${finalSlug}"). Reintentá con algo más único.`));
    return null;
  }
  return { slug: finalSlug, isReuse: false };
}

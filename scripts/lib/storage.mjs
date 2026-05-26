// Storage location helpers — disk selection + junction/symlink management.
//
// Usado por Memory (Qdrant) y CodeGraph para redirigir datos pesados a un
// disco elegido por el user. En Windows usa junctions (mklink /J — no requiere
// admin); en Linux/Mac usa symlinks comunes.
//
// La idea: el código de Phobos sigue escribiendo a ~/.phobos/<algo>, pero ese
// path puede ser un junction al disco elegido. Transparente para todos los
// demás módulos.

import { lstat, readlink, mkdir, unlink, rmdir, rename, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute, normalize, parse } from 'node:path';
import { platform } from 'node:os';
import { execSync } from 'node:child_process';
import { rl } from './runtime.mjs';
import { tuiSelect, tuiYesNo } from './tui.mjs';
import { cyan, dim, green, yellow, red } from './colors.mjs';
import { fileExists, rmrf, copyDirRecursive, getDirSize, formatBytes } from './fs-utils.mjs';

const isWindows = platform() === 'win32';

// ═══════════════════════════════════════════════════════════════════
// Inspección
// ═══════════════════════════════════════════════════════════════════

// Devuelve metadata sobre un path: si existe, si es link/junction, target,
// si está vacío, tamaño total (siguiendo el link en caso de junction).
export async function inspectPath(p) {
  const info = {
    exists: false,
    isLink: false,
    isDirectory: false,
    target: null,
    isEmpty: true,
    sizeBytes: 0,
  };
  try {
    const st = await lstat(p);
    info.exists = true;
    info.isLink = st.isSymbolicLink();
    if (info.isLink) {
      try { info.target = await readlink(p); } catch {}
      // Junction/symlink a directorio: el target manda
      info.isDirectory = true;
    } else {
      info.isDirectory = st.isDirectory();
    }
    if (info.isDirectory && await fileExists(p)) {
      const { readdir } = await import('node:fs/promises');
      try {
        const entries = await readdir(p);
        info.isEmpty = entries.length === 0;
      } catch {}
      info.sizeBytes = await getDirSize(p);
    }
  } catch {}
  return info;
}

// ═══════════════════════════════════════════════════════════════════
// Prompt de disco
// ═══════════════════════════════════════════════════════════════════

// Pregunta al user qué disco usar para guardar los datos de un componente.
//
// Devuelve:
//   { mode: 'default', basePath: null }                      → usar default (no junction)
//   { mode: 'custom',  basePath: 'E:\\phobos' }              → user eligió custom
//
// Parámetros:
//   componentName: "Qdrant (RAG)", "CodeGraph", etc.
//   defaultLabel:  string mostrado en el menú para la opción default
//                  (ej: "~/.phobos/  (default)").
//   suggestedSubdir: subcarpeta sugerida bajo <disk>:\, ej "phobos".
export async function promptStorageDisk({ componentName, defaultLabel, suggestedSubdir = 'phobos' }) {
  console.log('  ' + dim('Storage location para ') + cyan(componentName) + dim(':'));

  let index;
  try {
    const r = await tuiSelect(
      `\n¿Dónde guardar los datos de ${componentName}?`,
      [
        `Default — ${defaultLabel}`,
        'Elegir otro disco (se creará un junction transparente)',
      ],
      0,
    );
    index = r.index;
  } catch {
    return { mode: 'default', basePath: null };
  }

  if (index === 0) {
    return { mode: 'default', basePath: null };
  }

  // Loop hasta que el user ingrese un disco válido (o cancele)
  while (true) {
    rl.resume();
    const raw = (await rl.question('  Letra de disco (ej: E) o path absoluto: ')).trim();
    rl.pause();

    if (!raw) {
      const retry = await tuiYesNo('  No ingresaste nada. ¿Reintentar?', true);
      if (!retry) return { mode: 'default', basePath: null };
      continue;
    }

    const cleaned = raw.replace(/[\\\/]+$/, '');
    let basePath;

    if (isWindows && /^[a-zA-Z]:?$/.test(cleaned)) {
      // "E" o "E:" → "E:\phobos"
      const letter = cleaned[0].toUpperCase();
      basePath = `${letter}:\\${suggestedSubdir}`;
    } else if (isAbsolute(cleaned)) {
      basePath = cleaned;
    } else {
      console.log('  ' + red('✗ Formato inválido. Usá una letra de disco (E) o un path absoluto.'));
      continue;
    }

    // Validar raíz accesible
    const rootCheck = isWindows ? parse(basePath).root : '/';
    if (!existsSync(rootCheck)) {
      console.log('  ' + red(`✗ El disco/raíz ${rootCheck} no existe o no es accesible.`));
      const retry = await tuiYesNo('  ¿Reintentar?', true);
      if (!retry) return { mode: 'default', basePath: null };
      continue;
    }

    // Test de escritura: crear basePath
    try {
      await mkdir(basePath, { recursive: true });
    } catch (e) {
      console.log('  ' + red(`✗ No pude crear ${basePath}: ${e.message}`));
      const retry = await tuiYesNo('  ¿Reintentar con otro disco?', true);
      if (!retry) return { mode: 'default', basePath: null };
      continue;
    }

    console.log('  ' + green('✓ ') + dim('Storage location: ') + cyan(basePath));
    return { mode: 'custom', basePath };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Junction / symlink
// ═══════════════════════════════════════════════════════════════════

// Crea un junction (Windows) o symlink (Unix) `linkPath` → `target`.
// Asume que linkPath NO existe y target SÍ existe.
async function createLink(linkPath, target) {
  const parent = parse(linkPath).dir;
  if (parent) await mkdir(parent, { recursive: true });

  if (isWindows) {
    // /J = directory junction. No requiere admin para volúmenes locales.
    // execSync para que el error se propague si falla.
    execSync(`cmd /c mklink /J "${linkPath}" "${target}"`, { stdio: 'pipe' });
  } else {
    await symlink(target, linkPath, 'dir');
  }
}

// Remueve SOLO el link (no toca el target). Funciona para junctions y symlinks.
async function removeLinkOnly(p) {
  try {
    await unlink(p);
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EISDIR') {
      // En Windows, junctions a veces necesitan rmdir
      await rmdir(p);
    } else {
      throw e;
    }
  }
}

// Asegura que `linkPath` apunte (o sea redirigido) a `targetPath`.
//
// Casos manejados:
//   1. linkPath no existe → crear junction + target
//   2. linkPath es junction al mismo target → noop
//   3. linkPath es junction a otro target con datos → ofrecer migrar
//   4. linkPath es junction a otro target vacío → unlink + repointar
//   5. linkPath es dir real vacío → rmdir + crear junction
//   6. linkPath es dir real con datos → ofrecer migrar contenido + crear junction
//
// Devuelve { action: 'noop'|'created'|'migrated'|'repointed', from, to }.
// Si el user cancela una migración necesaria, tira error.
export async function ensureLinkTo({ linkPath, targetPath, componentName }) {
  const target = normalize(targetPath);
  const info = await inspectPath(linkPath);

  // ── Caso 1: no existe → crear junction limpio
  if (!info.exists) {
    await mkdir(target, { recursive: true });
    await createLink(linkPath, target);
    console.log('  ' + green('✓ ') + dim('Junction creado: ') + cyan(linkPath) + dim(' → ') + cyan(target));
    return { action: 'created', from: linkPath, to: target };
  }

  // ── Caso 2/3/4: ya es link
  if (info.isLink) {
    const curTarget = info.target ? normalize(info.target) : null;
    if (curTarget && curTarget === target) {
      console.log('  ' + dim('ℹ Junction ya apunta a ') + cyan(target));
      return { action: 'noop', from: linkPath, to: target };
    }

    console.log('  ' + yellow('⚠ ') + linkPath + dim(' ya es junction a ') + cyan(curTarget || '?'));

    if (info.isEmpty) {
      const reassign = await tuiYesNo(`  Target actual vacío. ¿Repuntar a ${target}?`, true);
      if (!reassign) {
        return { action: 'noop', from: linkPath, to: curTarget };
      }
      await removeLinkOnly(linkPath);
      await mkdir(target, { recursive: true });
      await createLink(linkPath, target);
      console.log('  ' + green('✓ ') + dim('Junction repuntado a ') + cyan(target));
      return { action: 'repointed', from: linkPath, to: target };
    }

    // Junction con datos en otro disco
    console.log('  ' + dim('  Target actual tiene ') + formatBytes(info.sizeBytes) + dim(' de datos de ') + componentName + '.');
    const r = await tuiSelect(
      `  ¿Qué hacer?`,
      [
        `Mantener junction actual (datos en ${curTarget})`,
        `Mover datos a ${target} y repuntar`,
        'Cancelar instalación',
      ],
      0,
    );
    if (r.index === 0) return { action: 'noop', from: linkPath, to: curTarget };
    if (r.index === 2) throw new Error('Cancelado por el usuario');

    // Migración entre dos targets externos.
    //
    // Casos:
    //   a) target NO existe              → rename (curTarget → target) en una sola op.
    //   b) target existe vacío           → rmdir + rename.
    //   c) target existe con contenido   → MERGE: mover cada hijo de curTarget
    //      adentro de target, dejando intacto lo que ya hay (ej: codegraph\
    //      del install previo). Si hay conflicto de nombre, error con detalle.
    await removeLinkOnly(linkPath);
    await safeMkdirParent(target);

    if (await fileExists(target)) {
      const tInfo = await inspectPath(target);
      if (tInfo.isEmpty) {
        await rmdir(target);
        await moveOrCopy(curTarget, target);
      } else {
        // MERGE — mover hijos de curTarget adentro de target.
        const { readdir: readdirFn } = await import('node:fs/promises');
        const sourceChildren = await readdirFn(curTarget);
        const conflicts = sourceChildren.filter(name => existsSync(join(target, name)));
        if (conflicts.length > 0) {
          // Restablecer el link al estado previo para no dejar al user sin acceso.
          await createLink(linkPath, curTarget).catch(() => {});
          throw new Error(
            `No puedo mergear: estos nombres ya existen en ${target}: ${conflicts.join(', ')}. ` +
            `Resolvé manualmente moviendo o eliminando esos archivos del destino, después reintentá.`,
          );
        }
        for (const name of sourceChildren) {
          await moveOrCopy(join(curTarget, name), join(target, name));
        }
        // Limpiar el curTarget que ya está vacío.
        try { await rmdir(curTarget); } catch {}
        console.log('  ' + green('✓ ') + dim('Datos mergeados a ') + cyan(target) + dim(' + junction creado'));
        await createLink(linkPath, target);
        return { action: 'migrated', from: linkPath, to: target };
      }
    } else {
      await moveOrCopy(curTarget, target);
    }

    await createLink(linkPath, target);
    console.log('  ' + green('✓ ') + dim('Datos migrados a ') + cyan(target) + dim(' + junction creado'));
    return { action: 'migrated', from: linkPath, to: target };
  }

  // ── Caso 5: dir real vacío → reemplazar por junction
  if (info.isDirectory && info.isEmpty) {
    await rmdir(linkPath);
    await mkdir(target, { recursive: true });
    await createLink(linkPath, target);
    console.log('  ' + green('✓ ') + dim('Junction creado (reemplaza dir vacío): ') + cyan(linkPath) + dim(' → ') + cyan(target));
    return { action: 'created', from: linkPath, to: target };
  }

  // ── Caso 6: dir real con datos → migrar
  if (info.isDirectory && !info.isEmpty) {
    console.log('  ' + yellow('⚠ ') + linkPath + dim(' tiene ') + formatBytes(info.sizeBytes) + dim(' de datos de ') + componentName + '.');
    const migrate = await tuiYesNo(`  ¿Mover los datos a ${target} y crear junction?`, true);
    if (!migrate) {
      throw new Error(
        `Cancelado: ${linkPath} tiene datos y no querés migrarlos.\n` +
        `  Movelo manualmente a ${target}, borrá ${linkPath}, y reintentá.`,
      );
    }
    // Crear padre del target (skip si es root del drive — Windows tira EPERM).
    await safeMkdirParent(target);

    if (await fileExists(target)) {
      const tInfo = await inspectPath(target);
      if (!tInfo.isEmpty) {
        throw new Error(`El destino ${target} ya tiene contenido. Resolvé manualmente para evitar pérdida.`);
      }
      await rmdir(target);
    }
    try {
      await rename(linkPath, target);
    } catch (e) {
      if (e.code === 'EXDEV' || e.code === 'EPERM') {
        await mkdir(target, { recursive: true });
        await copyDirRecursive(linkPath, target);
        await rmrf(linkPath);
      } else {
        throw e;
      }
    }
    await createLink(linkPath, target);
    console.log('  ' + green('✓ ') + dim('Datos migrados a ') + cyan(target) + dim(' + junction creado'));
    return { action: 'migrated', from: linkPath, to: target };
  }

  // Fallback: archivo (no debería pasar para los componentes que manejamos)
  throw new Error(`${linkPath} existe y no es un directorio. Resolvé manualmente.`);
}

// ═══════════════════════════════════════════════════════════════════
// Verificación (para mostrar al user al final del install)
// ═══════════════════════════════════════════════════════════════════

// Imprime los comandos que el user puede correr para confirmar dónde quedan
// los datos. linkPath es la ruta canónica (ej: ~/.phobos/qdrant-storage);
// targetPath es opcional — si se pasa, se muestra como referencia.
export function printVerificationCommands(componentName, linkPath, targetPath = null) {
  console.log('');
  console.log('  ' + cyan('Verificar storage de ') + cyan(componentName) + cyan(':'));
  if (isWindows) {
    console.log('    ' + cyan(`Get-Item "${linkPath}" | Select-Object Name, LinkType, Target`));
    if (targetPath) {
      console.log('    ' + cyan(`Get-ChildItem "${targetPath}"`));
    }
  } else {
    console.log('    ' + cyan(`ls -la "${linkPath}"`));
    if (targetPath) {
      console.log('    ' + cyan(`ls -la "${targetPath}"`));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Uninstall helpers
// ═══════════════════════════════════════════════════════════════════

// Rompe el junction `linkPath` SI su target está vacío (o no existe).
// Si el target tiene contenido, NO rompe — devuelve la lista de hijos para
// que el caller informe al user.
//
// Devuelve:
//   { broken: true, target: '...' }
//   { broken: false, reason: 'not-a-link', linkPath: ... }
//   { broken: false, reason: 'target-not-empty', target: '...', remaining: [...] }
//
// NO toca el target si tiene contenido — el caller decide qué hacer.
// El `linkPath` (el junction file) sí se borra si target está vacío.
export async function breakJunctionIfEmpty(linkPath) {
  const info = await inspectPath(linkPath);
  if (!info.exists || !info.isLink) {
    return { broken: false, reason: 'not-a-link', linkPath };
  }
  const target = info.target;
  if (info.isEmpty) {
    // Borrar el target dir si existe
    if (target && existsSync(target)) {
      try { await rmdir(target); } catch {}
    }
    await removeLinkOnly(linkPath);
    return { broken: true, target };
  }
  // Target con contenido — listarlo para que el caller informe
  const { readdir: readdirFn } = await import('node:fs/promises');
  let remaining = [];
  try { remaining = await readdirFn(linkPath); } catch {}
  return { broken: false, reason: 'target-not-empty', target, remaining };
}

// ═══════════════════════════════════════════════════════════════════
// Helpers internos (no exportados)
// ═══════════════════════════════════════════════════════════════════

// mkdir del parent de `p` si el parent NO es la raíz del drive.
// En Windows, `mkdir 'E:\'` tira EPERM aunque ya exista — la raíz del drive
// no se puede "crear". Sólo creamos el parent si es un subdirectorio.
async function safeMkdirParent(p) {
  const parent = parse(p).dir;
  if (!parent) return;
  const parsed = parse(parent);
  const isDriveRoot = parsed.root === parent;
  if (isDriveRoot) return;
  await mkdir(parent, { recursive: true });
}

// rename si están en el mismo volumen; sino copy + delete.
async function moveOrCopy(src, dst) {
  try {
    await rename(src, dst);
  } catch (e) {
    if (e.code === 'EXDEV' || e.code === 'EPERM') {
      await mkdir(dst, { recursive: true });
      await copyDirRecursive(src, dst);
      await rmrf(src);
    } else {
      throw e;
    }
  }
}

// File system + exec utilities.
import { access, readdir, lstat, realpath, writeFile as writeFileRaw, mkdir as mkdirRaw } from 'node:fs/promises';
import { join, resolve as resolvePath, dirname, basename, sep } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { platform, cwd } from 'node:process';

export async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

// Helper rmrf multiplataforma sin dependencias (Node 16.14+ tiene fs.rm)
export async function rmrf(path) {
  try {
    const { rm } = await import('node:fs/promises');
    await rm(path, { recursive: true, force: true });
  } catch {
    // Fallback al CLI del SO
    const cmd = platform === 'win32'
      ? { cmd: 'cmd', args: ['/c', 'rmdir', '/S', '/Q', path.replace(/\//g, '\\')] }
      : { cmd: 'rm', args: ['-rf', path] };
    await new Promise((resolve) => {
      const p = spawn(cmd.cmd, cmd.args, { stdio: 'ignore', shell: true });
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }
}

// Copia recursiva multiplataforma (Node 16.7+ tiene fs.cp con {recursive:true})
export async function copyDirRecursive(src, dst) {
  const { cp } = await import('node:fs/promises');
  await cp(src, dst, { recursive: true });
}

// Tamaño total de un directorio en bytes. Si no existe, devuelve 0.
export async function getDirSize(dirPath) {
  if (!await fileExists(dirPath)) return 0;
  const { stat } = await import('node:fs/promises');
  let total = 0;
  async function walk(p) {
    try {
      const s = await stat(p);
      if (s.isDirectory()) {
        const entries = await readdir(p);
        for (const entry of entries) {
          await walk(join(p, entry));
        }
      } else if (s.isFile()) {
        total += s.size;
      }
    } catch {}
  }
  await walk(dirPath);
  return total;
}

// Formato humano (B, KB, MB, GB).
export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function tryExec(cmd, timeoutMs = 15000) {
  try {
    const out = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      shell: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, out: stripAnsi(out).trim() };
  } catch (err) {
    return { ok: false, err: err.message || String(err) };
  }
}

// Sube por el path hasta encontrar un ancestor que exista en el filesystem.
// Devuelve { real: realpath del ancestor, virtualRest: tail virtual sin resolver }.
// Usado por safeWriteFile cuando el target todavía no existe (escritura inicial).
async function getDeepestRealAncestor(absPath) {
  const segments = [];
  let current = absPath;
  while (true) {
    try {
      const real = await realpath(current);
      return { real, virtualRest: segments.reverse().join(sep) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = dirname(current);
      if (parent === current) {
        // Llegamos a la raíz sin encontrar ancestor — should not happen in practice
        throw new Error(`No existing ancestor found for ${absPath}`);
      }
      segments.push(basename(current));
      current = parent;
    }
  }
}

// Escritura segura con dos defensas:
//   1. NO seguir symlinks — si `filePath` existe y es symlink, rechaza.
//   2. Sandbox de path — el destino, resuelto con realpath, debe estar dentro
//      de `allowedRoot` (default: cwd). Previene "..", symlinks intermedios
//      que apuntan afuera, etc.
//
// Uso típico:
//   await safeWriteFile('vault/memory/.engine/config.json', json)
//   await safeWriteFile(globalCompose, yaml, { allowedRoot: PHOBOS_HOME })
export async function safeWriteFile(filePath, content, { allowedRoot = cwd() } = {}) {
  const rootReal = await realpath(resolvePath(allowedRoot));
  const absTarget = resolvePath(allowedRoot, filePath);

  // 1) Si ya existe, debe ser archivo regular (NUNCA symlink, ni socket, ni device).
  try {
    const st = await lstat(absTarget);
    if (st.isSymbolicLink()) {
      throw new Error(
        `safeWriteFile: refusing to write to symlink at "${filePath}". ` +
        `Symlinks could redirect the write outside the project. ` +
        `Delete the symlink first if you intend to write here.`,
      );
    }
    if (!st.isFile()) {
      throw new Error(
        `safeWriteFile: "${filePath}" exists but is not a regular file (type: ${
          st.isDirectory() ? 'directory' : 'special'
        }).`,
      );
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && !/refusing|not a regular/i.test(err.message)) {
      throw err;
    }
    if (/refusing|not a regular/i.test(err.message)) throw err;
    // ENOENT — el target no existe, continuamos a validar el dirname
  }

  // 2) El dirname (existente o más cercano ancestor) debe resolver dentro de rootReal.
  const { real: ancestorReal, virtualRest } = await getDeepestRealAncestor(dirname(absTarget));
  const projectedReal = virtualRest ? ancestorReal + sep + virtualRest : ancestorReal;
  if (projectedReal !== rootReal && !projectedReal.startsWith(rootReal + sep)) {
    throw new Error(
      `safeWriteFile: target escapes allowedRoot. ` +
      `Resolved target dir: ${projectedReal}. Allowed root: ${rootReal}. ` +
      `Possible symlink attack or path traversal — write rejected.`,
    );
  }

  // 3) Crear el dirname si no existe (recursivo). Usamos mkdirRaw directo porque
  //    el path ya fue validado contra root en (2). NO usamos safeMkdir para
  //    evitar re-validar el mismo path dos veces.
  await mkdirRaw(dirname(absTarget), { recursive: true });

  // 4) Write.
  await writeFileRaw(absTarget, content);
}

// mkdir seguro: crea el directorio (recursivo) validando que el path final
// quede dentro de allowedRoot. Mismo principio que safeWriteFile.
export async function safeMkdir(dirPath, { allowedRoot = cwd(), recursive = true } = {}) {
  const rootReal = await realpath(resolvePath(allowedRoot));
  const absTarget = resolvePath(allowedRoot, dirPath);

  // Validar que el target esté dentro del root (incluso si todavía no existe).
  const { real: ancestorReal, virtualRest } = await getDeepestRealAncestor(absTarget);
  const projectedReal = virtualRest ? ancestorReal + sep + virtualRest : ancestorReal;
  if (projectedReal !== rootReal && !projectedReal.startsWith(rootReal + sep)) {
    throw new Error(
      `safeMkdir: target escapes allowedRoot. ` +
      `Resolved: ${projectedReal}. Allowed: ${rootReal}.`,
    );
  }

  // Si ya existe Y es symlink, rechazar (cubre el caso edge "dir conocido apunta afuera").
  try {
    const st = await lstat(absTarget);
    if (st.isSymbolicLink()) {
      throw new Error(
        `safeMkdir: refusing to operate on existing symlink at "${dirPath}".`,
      );
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && !/refusing/i.test(err.message)) throw err;
    if (/refusing/i.test(err.message)) throw err;
    // ENOENT — OK, lo vamos a crear
  }

  await mkdirRaw(absTarget, { recursive });
}

// Valida que un string es seguro para interpolar en un comando shell.
// Charset permitido por defecto: alfanumérico + _ - . / : (cubre nombres de
// providers, paths simples, slugs, container names — nada de ; & | ` $ () etc).
//
// Lanza Error si no matchea, con un mensaje útil incluyendo el label.
// Devuelve el valor sin cambios si pasó la validación (para uso inline).
//
// Uso:
//   const safeProvider = assertSafeShellArg(provider, 'provider');
//   tryExec(`opencode models ${safeProvider}`);
//
// Si necesitás validar con un charset distinto, pasá una regex custom.
export function assertSafeShellArg(value, label = 'value', allowedPattern = /^[a-zA-Z0-9_.\/:-]+$/) {
  if (typeof value !== 'string') {
    throw new Error(`${label}: expected string, got ${typeof value}`);
  }
  if (value.length === 0) {
    throw new Error(`${label}: empty string is not allowed`);
  }
  if (value.length > 256) {
    throw new Error(`${label}: too long (${value.length} chars, max 256) — possible injection attempt`);
  }
  if (!allowedPattern.test(value)) {
    // Reportamos sin transcribir el valor completo (puede ser malicioso).
    // Solo mostramos un preview corto para debugging legítimo.
    const preview = value.slice(0, 40).replace(/[^\x20-\x7E]/g, '?');
    throw new Error(
      `${label}: contains unsafe characters. Allowed: ${allowedPattern}. ` +
      `Preview: "${preview}${value.length > 40 ? '…' : ''}"`,
    );
  }
  return value;
}

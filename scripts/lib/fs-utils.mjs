// File system + exec utilities.
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { platform } from 'node:process';

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

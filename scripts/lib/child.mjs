// Helpers para spawn de child processes.
import { spawn } from 'node:child_process';
import process, { stdout } from 'node:process';
import { cyan, bold, dim, green, yellow } from './colors.mjs';

export function runChild(cmd, args, label) {
  return new Promise((resolve) => {
    console.log('\n' + cyan('▸ ') + bold(label));
    console.log(dim('  ejecutando: ' + cmd + ' ' + args.join(' ')) + '\n');
    const proc = spawn(cmd, args, { stdio: 'inherit', shell: true });
    proc.on('close', (code) => {
      if (code === 0) {
        console.log(green('\n  ✓ ' + label + ' completado.\n'));
      } else {
        console.log(yellow('\n  ⚠ ' + label + ' terminó con código ' + code + '\n'));
      }
      resolve(code);
    });
    proc.on('error', (err) => {
      console.log(yellow('\n  ⚠ Error ejecutando ' + cmd + ': ' + err.message + '\n'));
      resolve(1);
    });
  });
}

// Variante de runChild que captura stdout/stderr Y los mirrora a la terminal
// en vivo. Útil para scripts cuyo output necesitamos para diagnosticar errores
// (el reindex de Memory, por ejemplo).
export function runChildCaptured(cmd, args, label) {
  return new Promise((resolve) => {
    console.log('\n' + cyan('▸ ') + bold(label));
    console.log(dim('  ejecutando: ' + cmd + ' ' + args.join(' ')) + '\n');
    const proc = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'], shell: true });
    let stdoutBuf = '';
    let stderrBuf = '';
    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdoutBuf += s;
      stdout.write(s);
    });
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderrBuf += s;
      process.stderr.write(s);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        console.log(green('\n  ✓ ' + label + ' completado.\n'));
      } else {
        console.log(yellow('\n  ⚠ ' + label + ' terminó con código ' + code + '\n'));
      }
      resolve({ code, stdout: stdoutBuf, stderr: stderrBuf });
    });
    proc.on('error', (err) => {
      console.log(yellow('\n  ⚠ Error ejecutando ' + cmd + ': ' + err.message + '\n'));
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
  });
}

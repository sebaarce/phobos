// Exit helpers + sentinel WIZARD_CANCELLED + hints de la TUI.
import { stdin, stdout, exit } from 'node:process';
import { dim } from './colors.mjs';
import { rl } from './runtime.mjs';

// Sentinel para cancelar el wizard actual (Esc) y volver al menú principal.
// Distinto a Ctrl+C que sale del proceso completo.
export const WIZARD_CANCELLED = Symbol('WIZARD_CANCELLED');

export const HINT_SELECT = '  ↑/↓ navegar  ·  Enter confirmar  ·  Esc volver al menú  ·  Ctrl+C salir';
export const HINT_MULTI  = '  ↑/↓ navegar  ·  Space marcar  ·  Enter confirmar  ·  Esc volver al menú  ·  Ctrl+C salir';

// Cleanup robusto: stdin puede quedar en raw mode o "flowing" después de
// los child processes con stdio: 'inherit', lo cual mantiene a Node vivo
// (especialmente en Windows con shell: true).
// Forzamos cierre limpio + exit duro como red de seguridad.
export function finalizeAndExit(code = 0) {
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(false);
    }
  } catch {}
  try { stdin.removeAllListeners('keypress'); } catch {}
  try { stdin.removeAllListeners('data'); } catch {}
  try { rl.close(); } catch {}
  try { stdin.pause(); } catch {}
  try { stdin.unref(); } catch {}
  // Flush stdout/stderr y salir. En Windows con stdio: 'inherit' previo,
  // los handles a veces quedan pegados — process.exit() es la única salida segura.
  if (stdout.write('')) {
    exit(code);
  } else {
    stdout.once('drain', () => exit(code));
    // Fallback duro: 200ms y mata el proceso pase lo que pase.
    setTimeout(() => exit(code), 200).unref();
  }
}

export async function pressEnterToContinue() {
  console.log('');
  console.log(dim('  Presioná Enter o Esc para volver al menú...'));
  await new Promise((resolve) => {
    const onKey = (str, key) => {
      if (!key) return;
      // Enter, Space, Esc, o Ctrl+C — todos liberan (la acción ya terminó).
      if (key.name === 'return' || key.name === 'space' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        stdin.removeListener('keypress', onKey);
        try { stdin.setRawMode(false); } catch {}
        resolve();
      }
    };
    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    stdin.on('keypress', onKey);
  });
}

// Envuelve una acción del wizard de forma que si el usuario apreta Esc
// dentro del flujo, capturamos el sentinel WIZARD_CANCELLED y volvemos
// al menú principal en lugar de propagar el reject.
export async function runAction(actionFn) {
  try {
    await actionFn();
  } catch (err) {
    if (err === WIZARD_CANCELLED) {
      // Volvemos al menú principal silenciosamente.
      return;
    }
    throw err;
  }
}

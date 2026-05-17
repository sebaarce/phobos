// Colors + visual helpers — usados por TUI primitives y banners.

export function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
export function color(c, s) { return process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s; }
export const green = (s) => color('32', s);
export const yellow = (s) => color('33', s);
export const cyan = (s) => color('36', s);
export const magenta = (s) => color('35', s);
export const red = (s) => color('31', s);
export const dim = (s) => color('2', s);
export const bold = (s) => color('1', s);
// Naranja "true" via ANSI 256-color (208 = bright orange). Soportado en
// todos los terminales modernos: Windows Terminal, iTerm2, gnome-terminal.
export const orange = (s) => color('38;5;208', s);

export function visibleLen(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

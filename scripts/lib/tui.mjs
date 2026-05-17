// TUI helpers — selección con cursor + Enter, multiselect, yes/no, panel, clearScreen.
import { stdin, stdout, exit } from 'node:process';
import { cyan, dim, green, visibleLen } from './colors.mjs';
import { rl } from './runtime.mjs';
import { WIZARD_CANCELLED, HINT_SELECT, HINT_MULTI } from './exit.mjs';

export function tuiSelect(prompt, options, defaultIdx = 0) {
  return new Promise((resolve, reject) => {
    let selected = defaultIdx;
    const N = options.length;
    const isTTY = stdin.isTTY && stdout.isTTY;

    if (!isTTY) {
      // Fallback no-TTY: solo imprimir y devolver el default
      console.log(prompt);
      options.forEach((o, i) => console.log(`  ${i === selected ? '●' : '○'} ${o}`));
      console.log(dim(`  (no TTY — default: ${options[selected]})`));
      return resolve({ index: selected, value: options[selected] });
    }

    const fmt = (i, sel) => {
      const marker = i === sel ? cyan('●') : ' ';
      const text = i === sel ? cyan(options[i]) : options[i];
      return `  ${marker} ${text}`;
    };

    console.log(prompt);
    for (let i = 0; i < N; i++) console.log(fmt(i, selected));
    console.log(dim(HINT_SELECT));

    const rerender = () => {
      // Subir N+1 líneas (N opciones + 1 línea de hint)
      stdout.write(`\x1b[${N + 1}A`);
      for (let i = 0; i < N; i++) {
        stdout.write('\r\x1b[K' + fmt(i, selected) + '\n');
      }
      stdout.write('\r\x1b[K' + dim(HINT_SELECT) + '\n');
    };

    rl.pause();
    stdin.setRawMode(true);
    stdin.resume();

    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        selected = (selected - 1 + N) % N;
        rerender();
      } else if (key.name === 'down' || key.name === 'j') {
        selected = (selected + 1) % N;
        rerender();
      } else if (key.name === 'return') {
        cleanup();
        // Limpiar la línea de hint para no dejar basura
        stdout.write('\x1b[1A\r\x1b[K\n');
        resolve({ index: selected, value: options[selected] });
      } else if (key.name === 'escape') {
        cleanup();
        stdout.write('\x1b[1A\r\x1b[K\n');
        reject(WIZARD_CANCELLED);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        console.log('\n(salida)');
        exit(0);
      } else if (/^[1-9]$/.test(str || '')) {
        const n = parseInt(str, 10) - 1;
        if (n < N) {
          selected = n;
          rerender();
        }
      }
    };

    function cleanup() {
      stdin.setRawMode(false);
      stdin.removeListener('keypress', onKey);
      rl.resume();
    }

    stdin.on('keypress', onKey);
  });
}

export async function tuiYesNo(prompt, defaultYes = false) {
  const { value } = await tuiSelect(prompt, ['Sí', 'No'], defaultYes ? 0 : 1);
  return value === 'Sí';
}

export function tuiMultiSelect(prompt, options, defaultChecked = []) {
  return new Promise((resolve, reject) => {
    let cursor = 0;
    const checked = new Set(defaultChecked);
    const N = options.length;
    const isTTY = stdin.isTTY && stdout.isTTY;

    if (!isTTY) {
      console.log(prompt);
      options.forEach((o) => console.log(`  ${checked.has(o.value) ? '☑' : '☐'} ${o.label}`));
      console.log(dim(`  (no TTY — selección: ${Array.from(checked).join(', ') || 'ninguna'})`));
      return resolve(Array.from(checked));
    }

    const fmt = (i) => {
      const isCursor = i === cursor;
      const isChecked = checked.has(options[i].value);
      // Checkbox Unicode con check verde cuando marcado
      const box = isChecked ? green('☑') : dim('☐');
      let label = options[i].label;
      if (isChecked) {
        label = green(label);
      } else if (isCursor) {
        label = cyan(label);
      }
      const arrow = isCursor ? cyan('›') : ' ';
      return '  ' + arrow + ' ' + box + ' ' + label;
    };

    console.log(prompt);
    for (let i = 0; i < N; i++) console.log(fmt(i));
    console.log(dim(HINT_MULTI));

    const rerender = () => {
      stdout.write(`\x1b[${N + 1}A`);
      for (let i = 0; i < N; i++) {
        stdout.write('\r\x1b[K' + fmt(i) + '\n');
      }
      stdout.write('\r\x1b[K' + dim(HINT_MULTI) + '\n');
    };

    rl.pause();
    stdin.setRawMode(true);
    stdin.resume();

    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        cursor = (cursor - 1 + N) % N;
        rerender();
      } else if (key.name === 'down' || key.name === 'j') {
        cursor = (cursor + 1) % N;
        rerender();
      } else if (key.name === 'space' || str === ' ') {
        const val = options[cursor].value;
        if (checked.has(val)) checked.delete(val);
        else checked.add(val);
        rerender();
      } else if (key.name === 'return') {
        cleanup();
        stdout.write('\x1b[1A\r\x1b[K\n');
        resolve(Array.from(checked));
      } else if (key.name === 'escape') {
        cleanup();
        stdout.write('\x1b[1A\r\x1b[K\n');
        reject(WIZARD_CANCELLED);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        console.log('\n(salida)');
        exit(0);
      }
    };

    function cleanup() {
      stdin.setRawMode(false);
      stdin.removeListener('keypress', onKey);
      rl.resume();
    }

    stdin.on('keypress', onKey);
  });
}

export function clearScreen() {
  // ESC[2J clears, ESC[H moves cursor to (0,0). Funciona en Windows Terminal, iTerm2, gnome-terminal.
  // Fallback console.clear() para entornos exóticos.
  if (stdout.isTTY) {
    stdout.write('\x1b[2J\x1b[3J\x1b[H');
  } else {
    console.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════
// Panel — caja con título y líneas de contenido
// ═══════════════════════════════════════════════════════════════════

export function panel(title, lines) {
  const titleW = visibleLen(title);
  const contentW = lines.length ? Math.max(...lines.map(visibleLen)) : 0;
  const innerW = Math.max(contentW + 4, titleW + 6);

  const dashesAfter = Math.max(1, innerW - titleW - 3);
  const top    = '╭─ ' + title + ' ' + '─'.repeat(dashesAfter) + '╮';
  const bottom = '╰' + '─'.repeat(innerW) + '╯';
  const blank  = '│' + ' '.repeat(innerW) + '│';

  console.log('  ' + cyan(top));
  console.log('  ' + cyan(blank));
  for (const line of lines) {
    if (line === '') {
      console.log('  ' + cyan(blank));
    } else {
      const padding = innerW - 2 - visibleLen(line);
      console.log('  ' + cyan('│') + '  ' + line + ' '.repeat(Math.max(0, padding)) + cyan('│'));
    }
  }
  console.log('  ' + cyan(blank));
  console.log('  ' + cyan(bottom));
}

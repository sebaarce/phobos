#!/usr/bin/env node
// Phobos Memory launcher (per-project).
//
// Este archivo es chico a propósito — todo el engine (scripts + node_modules)
// vive globalmente en ~/.phobos/memory-engine/ (que puede ser un junction al
// disco que elegiste durante el install). Acá solo despachamos.
//
// Usage:
//   node vault/memory/.engine/launcher.mjs search "<query>" [--top N] [--json]
//   node vault/memory/.engine/launcher.mjs index [--incremental] [--force]
//   node vault/memory/.engine/launcher.mjs list  [--tasks N] [--json] [--section <name>]

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const ENGINE_GLOBAL = join(homedir(), '.phobos', 'memory-engine');

const SCRIPTS = {
  search: 'search.mjs',
  index:  'index-vault.mjs',
  list:   'list-memory.mjs',
};

const [, , cmd, ...rest] = process.argv;
const script = SCRIPTS[cmd];

if (!script) {
  console.error('Usage: launcher.mjs <search|index|list> [args...]');
  console.error('  search "<query>" [--top N] [--json]');
  console.error('  index [--incremental] [--force]');
  console.error('  list  [--tasks N] [--json] [--section <tasks|insights|wiki|glossary>]');
  process.exit(2);
}

const scriptPath = join(ENGINE_GLOBAL, script);
if (!existsSync(scriptPath)) {
  console.error(`[phobos-memory] engine global no instalado en ${ENGINE_GLOBAL}`);
  console.error('[phobos-memory]  reinstalá Memory con: npx github:sebaarce/phobos  →  Memory (RAG) → Instalar');
  process.exit(1);
}

const result = spawnSync(process.execPath, [
  scriptPath,
  '--project', PROJECT_ROOT,
  ...rest,
], { stdio: 'inherit' });

process.exit(result.status ?? 1);

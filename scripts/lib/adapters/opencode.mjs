// OpencodeAdapter — implementación concreta del IDEAdapter para OpenCode.
//
// Encapsula:
//   - Convenciones de paths: `.opencode/agent/`, `.opencode/command/`, `.opencode/skills/`
//   - Lista de archivos para bootstrap y "Actualizar agentes"
//   - Detección del CLI `opencode` en PATH
//   - Detección de providers vía `auth.json` de OpenCode
//   - Normalización del frontmatter (heredada de IDEAdapter por ahora)
//
// Filosofía: este archivo es la "verdad" sobre cómo se configura un proyecto
// para OpenCode. Si OpenCode cambia su layout (ej: `.opencode/agents/` en
// plural), solo se actualiza acá.
//
// Estado en Fase 1: declara los datos pero los módulos del codebase
// (bootstrap, update, models, etc.) siguen usando los globals viejos de
// runtime.mjs. En Fase 2 los módulos pasan a consumir el adapter.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { env, platform } from 'node:process';
import { IDEAdapter } from './base.mjs';
import { fileExists, tryExec } from '../fs-utils.mjs';

export class OpencodeAdapter extends IDEAdapter {
  // ─── Identidad ─────────────────────────────────────────────────────

  get id() { return 'opencode'; }
  get displayName() { return 'OpenCode'; }
  get isImplemented() { return true; }

  // ─── Paths del proyecto destino ────────────────────────────────────

  get agentDir() { return '.opencode/agent'; }
  get commandDir() { return '.opencode/command'; }
  get skillDirs() {
    // Orden de búsqueda: local primero, global después.
    return [
      '.opencode/skills',       // proyecto (OpenCode native)
      '.agents/skills',          // proyecto (Skills CLI / Claude Code-compatible)
      join(homedir(), '.config', 'opencode', 'skills'), // global OpenCode
      join(homedir(), '.claude', 'skills'),              // global Claude Code (compatible)
      join(homedir(), '.agents', 'skills'),              // global Skills CLI
    ];
  }

  // ─── Paths del template source ─────────────────────────────────────

  get templateAgentDir() { return 'opencode/agent'; }
  get templateCommandDir() { return 'opencode/command'; }

  // ─── Archivos para bootstrap ───────────────────────────────────────

  bootstrapFiles() {
    // Cada item: { src (relativo a TEMPLATES_DIR), dst (relativo a cwd), group }
    // El `group` es solo cosmético para el progress bar — agrupa archivos
    // relacionados ("Creando agentes" vs "Creando comandos" vs "Creando vault").
    const files = [];

    // Agentes
    for (const agent of ['phobos', 'researcher', 'planner', 'programmer', 'tester', 'archivist']) {
      files.push({
        src: `opencode/agent/${agent}.md`,
        dst: `.opencode/agent/${agent}.md`,
        group: 'agentes',
      });
    }

    // Slash commands
    for (const cmd of ['adapt-agents', 'models-wizard', 'reindex-memory', 'reindex-codegraph', 'list-memory']) {
      files.push({
        src: `opencode/command/${cmd}.md`,
        dst: `.opencode/command/${cmd}.md`,
        group: 'comandos',
      });
    }

    // Vault — IDE-agnostic, pero el adapter lo lista por completitud del bootstrap.
    const vaultFiles = [
      'vault/SCHEMA.md',
      'vault/TASKS.md',
      'vault/README.md',
      'vault/sources/.gitkeep',
      'vault/memory/tasks/.gitkeep',
      'vault/memory/insights/.gitkeep',
      'vault/memory/wiki/.gitkeep',
      'vault/memory/glossary/.gitkeep',
      'vault/memory/research-queries/.gitkeep',
    ];
    for (const v of vaultFiles) {
      files.push({ src: v, dst: v, group: 'vault' });
    }

    return files;
  }

  // ─── Archivos trackeados (Actualizar agentes) ──────────────────────

  trackedFiles() {
    return [
      // Agentes — ignoreModel: true porque el usuario customiza el campo `model:` deliberadamente.
      { src: 'opencode/agent/phobos.md',     dst: '.opencode/agent/phobos.md',     ignoreModel: true },
      { src: 'opencode/agent/researcher.md', dst: '.opencode/agent/researcher.md', ignoreModel: true },
      { src: 'opencode/agent/planner.md',    dst: '.opencode/agent/planner.md',    ignoreModel: true },
      { src: 'opencode/agent/programmer.md', dst: '.opencode/agent/programmer.md', ignoreModel: true },
      { src: 'opencode/agent/tester.md',     dst: '.opencode/agent/tester.md',     ignoreModel: true },
      { src: 'opencode/agent/archivist.md',  dst: '.opencode/agent/archivist.md',  ignoreModel: true },
      // Slash commands — no tienen `model:`, compare exact.
      { src: 'opencode/command/adapt-agents.md',      dst: '.opencode/command/adapt-agents.md',      ignoreModel: false },
      { src: 'opencode/command/models-wizard.md',     dst: '.opencode/command/models-wizard.md',     ignoreModel: false },
      { src: 'opencode/command/reindex-memory.md',    dst: '.opencode/command/reindex-memory.md',    ignoreModel: false },
      { src: 'opencode/command/reindex-codegraph.md', dst: '.opencode/command/reindex-codegraph.md', ignoreModel: false },
      { src: 'opencode/command/list-memory.md',       dst: '.opencode/command/list-memory.md',       ignoreModel: false },
    ];
  }

  // ─── Detección del CLI ─────────────────────────────────────────────

  async detectCli() {
    const r = tryExec('opencode --version', 8000);
    if (!r.ok) {
      return { ok: false, error: 'OpenCode CLI no detectado en PATH.' };
    }
    const version = (r.out || '').trim().split('\n')[0];
    return { ok: true, version };
  }

  async detectAuthProviders() {
    const authPaths = [
      join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
      join(homedir(), '.config', 'opencode', 'auth.json'),
      platform === 'win32' && env.APPDATA      ? join(env.APPDATA, 'opencode', 'auth.json')      : null,
      platform === 'win32' && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'opencode', 'auth.json') : null,
    ].filter(Boolean);

    const providers = new Set();
    const notes = [];

    for (const path of authPaths) {
      if (await fileExists(path)) {
        try {
          const data = JSON.parse(await readFile(path, 'utf-8'));
          for (const p of Object.keys(data || {})) providers.add(p);
        } catch (err) {
          notes.push(`Error parseando ${path}: ${err.message}`);
        }
      }
    }

    if (providers.size === 0 && notes.length === 0) {
      notes.push('No encontré auth.json de OpenCode en los paths habituales.');
    }

    return { providers: Array.from(providers), notes };
  }
}

#!/usr/bin/env node
'use strict';
/*
 * Phobos enforcement hooks — per-agent path confinement (SPEC §7.3), wired
 * from each agent's frontmatter. Modes (combinable):
 *   --allow <glob> / --deny <glob>       Edit/Write file_path confinement.
 *                                        Deny wins; with any --allow present
 *                                        the path must match one of them.
 *                                        Non-write tools pass untouched.
 *   --bash-deny-writes <glob>            Bash: extracted write targets AND any
 *                                        path-looking token matched against
 *                                        the globs.
 *   --bash-tokens <csv>                  Bash token mode: chaining/redirection/
 *   --bash-subcommands <csv>             substitution/assignments rejected
 *   --bash-forbid-flags <csv>            outright, then first token, second
 *                                        token and flags are validated.
 * FAIL-CLOSED (SPEC §7.3 / DA-6): any internal error exits 2 with stderr.
 * Every denial is audited via lib.auditWrite, like guard.cjs.
 */
const lib = require('./lib.cjs');

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
// Rejected outright in token mode: ; && || | & ` $( > < newline and VAR=.
const TOKEN_MODE_FORBIDDEN = /[;&|<>`\r\n]|\$\(/;

function parseArgs(argv) {
  const cfg = {
    allow: [],
    deny: [],
    bashDenyWrites: [],
    bashTokens: null,
    bashSubcommands: null,
    bashForbidFlags: [],
  };
  const csv = (value) => String(value).split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('falta el valor del flag ' + arg);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--allow':
        cfg.allow.push(next());
        break;
      case '--deny':
        cfg.deny.push(next());
        break;
      case '--bash-deny-writes':
        cfg.bashDenyWrites.push(next());
        break;
      case '--bash-tokens':
        cfg.bashTokens = (cfg.bashTokens || []).concat(csv(next()));
        break;
      case '--bash-subcommands':
        cfg.bashSubcommands = (cfg.bashSubcommands || []).concat(csv(next()));
        break;
      case '--bash-forbid-flags':
        cfg.bashForbidFlags = cfg.bashForbidFlags.concat(csv(next()));
        break;
      default:
        throw new Error('flag desconocido: ' + arg);
    }
  }
  return cfg;
}

function flagMatches(token, flag) {
  if (token === flag) return true;
  if (token.startsWith(flag + '=')) return true;
  // Short flags may carry their value attached (-ovalor).
  if (/^-[^-]$/.test(flag) && token.startsWith(flag)) return true;
  return false;
}

function makeDeny(projectDir, payload, toolName) {
  return function deny(reason, ruleId, detail) {
    lib.auditWrite(projectDir, {
      ts: new Date().toISOString(),
      session_id: payload.session_id || null,
      event: 'PreToolUse',
      agent_type: payload.agent_type || payload.agent_name || payload.subagent_type || null,
      tool_name: toolName,
      decision: 'deny',
      reason: ruleId,
      detail: lib.truncate(detail, 200),
      cwd: payload.cwd || null,
    });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason + ' — ver vault/SECURITY.md',
        },
      }),
    );
    process.exit(0);
  };
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const payload = await lib.readStdinJson();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
  const toolName = String(payload.tool_name || '');
  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const deny = makeDeny(projectDir, payload, toolName);

  if ((cfg.allow.length > 0 || cfg.deny.length > 0) && WRITE_TOOLS.includes(toolName)) {
    const filePath = String(toolInput.file_path || '');
    const relative = lib.toProjectRelative(projectDir, filePath);
    for (const pattern of cfg.deny) {
      if (lib.globMatch(pattern, relative)) {
        deny('Este agente no puede escribir en "' + relative + '" (ruta vedada)', 'confinamiento-deny', filePath);
      }
    }
    if (cfg.allow.length > 0 && !cfg.allow.some((pattern) => lib.globMatch(pattern, relative))) {
      deny(
        'Este agente solo puede escribir dentro de sus rutas permitidas; "' + relative + '" queda fuera',
        'confinamiento-allow',
        filePath,
      );
    }
  }

  if (toolName === 'Bash') {
    const command = String(toolInput.command || '');

    if (cfg.bashTokens) {
      if (TOKEN_MODE_FORBIDDEN.test(command)) {
        deny('Este agente no puede encadenar, redirigir ni sustituir comandos', 'bash-encadenamiento', command);
      }
      const tokens = command.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
      if (tokens.some((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t))) {
        deny('Este agente no puede asignar variables de entorno en sus comandos', 'bash-encadenamiento', command);
      }
      const first = tokens[0] || '';
      if (!cfg.bashTokens.includes(first)) {
        deny('Comando "' + first + '" fuera de la lista permitida para este agente', 'bash-token', command);
      }
      if (cfg.bashSubcommands && cfg.bashSubcommands.length > 0) {
        const second = tokens[1] || '';
        if (!cfg.bashSubcommands.includes(second)) {
          deny('Subcomando "' + second + '" fuera de la lista permitida para este agente', 'bash-subcomando', command);
        }
      }
      for (const token of tokens) {
        for (const flag of cfg.bashForbidFlags) {
          if (flagMatches(token, flag)) {
            deny('Flag prohibido para este agente: ' + flag, 'bash-flag-prohibido', command);
          }
        }
      }
    }

    if (cfg.bashDenyWrites.length > 0) {
      const { segments, writeTargets } = lib.normalizeCommand(command);
      const candidates = writeTargets.slice();
      for (const segment of segments) {
        for (const token of segment.split(' ')) {
          const clean = token.replace(/^['"]+|['"]+$/g, '');
          if (clean && !clean.startsWith('-')) candidates.push(clean);
        }
      }
      for (const candidate of candidates) {
        const relative = lib.toProjectRelative(projectDir, candidate);
        for (const pattern of cfg.bashDenyWrites) {
          if (lib.globMatch(pattern, relative)) {
            deny(
              'Este agente no puede tocar "' + relative + '" vía Bash (ruta protegida)',
              'bash-escritura-protegida',
              command,
            );
          }
        }
      }
    }
  }

  process.exit(0);
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write('paths-allow.cjs: error interno, se bloquea la operación (fail-closed): ' + message + '\n');
  process.exit(2);
});
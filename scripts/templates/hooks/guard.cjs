#!/usr/bin/env node
'use strict';
/*
 * Phobos enforcement hooks — PreToolUse global guard (SPEC §7.2). Loads
 * .claude/policies.json and applies the regex rule families over normalized
 * Bash segments and over Read/Grep/Glob targets; extracted write targets are
 * matched against protectedPaths.
 * FAIL-CLOSED (SPEC §7.3 / DA-6): any internal error — malformed stdin,
 * missing or corrupt policies.json — exits 2 with a reason on stderr, which
 * blocks the tool call instead of silently allowing it.
 */
const fs = require('fs');
const path = require('path');
const lib = require('./lib.cjs');

const READ_TOOLS = ['Read', 'Grep', 'Glob'];

function loadPolicies(projectDir) {
  const policiesPath = path.join(projectDir, '.claude', 'policies.json');
  const raw = fs.readFileSync(policiesPath, 'utf8');
  const policies = JSON.parse(raw);
  if (!policies || typeof policies !== 'object' || !Array.isArray(policies.rules)) {
    throw new Error('policies.json no tiene la estructura esperada ({ version, protectedPaths, rules })');
  }
  return policies;
}

/**
 * Test every rule applying to `toolName` against every candidate text.
 * Returns the first deny hit, or the first ask hit when no rule denies.
 */
function evaluateRules(rules, toolName, texts) {
  let askHit = null;
  for (const rule of rules) {
    if (!Array.isArray(rule.tools) || !rule.tools.includes(toolName)) continue;
    const re = new RegExp(rule.pattern, rule.flags || '');
    for (const text of texts) {
      if (!text || !re.test(text)) continue;
      const hit = { action: rule.action === 'ask' ? 'ask' : 'deny', ruleId: rule.id, reason: rule.reason };
      if (hit.action === 'deny') return hit;
      if (!askHit) askHit = hit;
    }
  }
  return askHit;
}

function emitDecision(projectDir, payload, toolName, hit, detail) {
  lib.auditWrite(projectDir, {
    ts: new Date().toISOString(),
    session_id: payload.session_id || null,
    event: 'PreToolUse',
    agent_type: payload.agent_type || payload.agent_name || payload.subagent_type || null,
    tool_name: toolName,
    decision: hit.action,
    reason: hit.ruleId,
    detail: lib.truncate(detail, 200),
    cwd: payload.cwd || null,
  });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: hit.action,
        permissionDecisionReason: hit.reason + ' — ver vault/SECURITY.md',
      },
    }),
  );
  process.exit(0);
}

async function main() {
  const payload = await lib.readStdinJson();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
  const policies = loadPolicies(projectDir);
  const toolName = String(payload.tool_name || '');
  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};

  if (toolName === 'Bash') {
    const command = String(toolInput.command || '');
    if (!command.trim()) process.exit(0);
    const { segments, writeTargets, assignments } = lib.normalizeCommand(command);
    // The whole collapsed command is tested too: rules that inherently span a
    // pipe (pipe-a-shell) would never match a single segment.
    const wholeCollapsed = command.trim().replace(/\s+/g, ' ');
    const texts = segments.concat(assignments, [wholeCollapsed]);
    const hit = evaluateRules(policies.rules, 'Bash', texts);
    if (hit && hit.action === 'deny') emitDecision(projectDir, payload, toolName, hit, command);

    const protectedPaths = Array.isArray(policies.protectedPaths) ? policies.protectedPaths : [];
    for (const target of writeTargets) {
      for (const pattern of protectedPaths) {
        if (lib.globMatch(pattern, target)) {
          emitDecision(
            projectDir,
            payload,
            toolName,
            {
              action: 'deny',
              ruleId: 'escritura-protegida',
              reason: 'Escritura vía Bash sobre una ruta protegida del sistema (' + target + ')',
            },
            command,
          );
        }
      }
    }
    if (hit) emitDecision(projectDir, payload, toolName, hit, command); // remaining ask
    process.exit(0);
  }

  if (READ_TOOLS.includes(toolName)) {
    const target = String(toolInput.file_path || toolInput.path || toolInput.pattern || '');
    if (!target) process.exit(0);
    const hit = evaluateRules(policies.rules, toolName, [target]);
    if (hit) emitDecision(projectDir, payload, toolName, hit, target);
    process.exit(0);
  }

  process.exit(0);
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write('guard.cjs: error interno, se bloquea la operación (fail-closed): ' + message + '\n');
  process.exit(2);
});
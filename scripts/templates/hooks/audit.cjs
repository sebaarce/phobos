#!/usr/bin/env node
'use strict';
/*
 * Phobos enforcement hooks — audit (SPEC §7.5): appends one JSONL event per
 * invocation to .claude/audit/<YYYY-MM-DD>.jsonl for SessionStart,
 * SubagentStart/Stop, PostToolUse, PostToolUseFailure and PermissionDenied
 * (`--event <name>`).
 *
 * On SubagentStop it also classifies the report the subagent returned
 * (SPEC §5.3): `report_cortado` is true when the closing sentinel is missing,
 * which is how a subagent that ran out of turns looks — the harness reports
 * `completed` and hands back the agent's last text instead of its report.
 *
 * EXCEPTION TO THE FAIL-CLOSED CONTRACT (deliberate, SPEC §7.3): this hook is
 * pure observability — it must NEVER block the session. Any internal error is
 * reported on stderr and the process still exits 0 (fail-open).
 */
const lib = require('./lib.cjs');

/** Closing sentinel of the PHOBOS-REPORT envelope (SPEC §5.3). */
const REPORT_SENTINEL = '### FIN-PHOBOS-REPORT';
const ESTADO_RE = /^ESTADO:\s*(COMPLETO|PARCIAL|BLOQUEADO|ERROR)\b/m;

/**
 * Classify a subagent's final text. Returns nulls when there is no text to
 * judge: "no lo pude verificar" must never be logged as "vino cortado".
 */
function classifyReport(lastMessage) {
  if (typeof lastMessage !== 'string' || lastMessage.length === 0) {
    return { report_cortado: null, report_estado: null };
  }
  const estado = ESTADO_RE.exec(lastMessage);
  return {
    report_cortado: !lastMessage.includes(REPORT_SENTINEL),
    report_estado: estado ? estado[1] : null,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const eventIdx = argv.indexOf('--event');
  const eventArg = eventIdx !== -1 ? argv[eventIdx + 1] : undefined;

  const payload = await lib.readStdinJson();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const event = eventArg || payload.hook_event_name || 'unknown';
  const detailSource =
    toolInput.command ||
    toolInput.file_path ||
    toolInput.path ||
    toolInput.pattern ||
    payload.prompt ||
    payload.error ||
    payload.last_assistant_message ||
    '';

  const report =
    event === 'SubagentStop'
      ? classifyReport(payload.last_assistant_message)
      : { report_cortado: null, report_estado: null };

  lib.auditWrite(projectDir, {
    ts: new Date().toISOString(),
    session_id: payload.session_id || null,
    event,
    agent_type: payload.agent_type || payload.agent_name || payload.subagent_type || null,
    agent_id: payload.agent_id || null,
    tool_name: payload.tool_name || null,
    decision: null,
    reason: null,
    detail: detailSource ? lib.truncate(String(detailSource), 200) : null,
    report_cortado: report.report_cortado,
    report_estado: report.report_estado,
    cwd: payload.cwd || null,
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write('audit.cjs: error interno (no bloqueante): ' + message + '\n');
    process.exit(0);
  });

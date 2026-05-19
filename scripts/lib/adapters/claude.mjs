// ClaudeAdapter — implementación para Claude Code.
//
// Filosofía: SINGLE SOURCE OF TRUTH.
// Los prompts de los agentes (el body markdown) son los mismos para ambos IDEs.
// La verdad vive en `scripts/templates/opencode/agent/*.md` — Claude los reusa
// vía un transformer que reescribe el YAML frontmatter al formato Claude Code.
// Esto evita drift entre los dos targets cuando se actualizan los prompts.
//
// Los slash commands sí están escritos a mano en `scripts/templates/claude/commands/`
// (son cortos, el frontmatter difiere bastante, y se actualizan poco).
//
// Mapeo de frontmatter OpenCode → Claude (aplicado por `transformAgent`):
//   - mode, temperature, permission, security → drop (no existen en Claude)
//   - tools: object con booleans → comma-separated string ("Read, Bash, Edit, ...")
//   - permission.task whitelist → agregado al tools como Agent(researcher, planner, ...)
//   - permission.edit deny / permission.webfetch deny → disallowedTools
//   - model: github-copilot/X o opencode/X → strip provider prefix, normalize
//   - name: derivado del filename (lowercase, hyphenated)
//
// Configuración por agente para Claude Code (modelos recomendados, etc.):
// Ver CLAUDE_AGENT_CONFIG abajo.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { IDEAdapter } from './base.mjs';
import { tryExec, fileExists } from '../fs-utils.mjs';

// Configuración por agente (Claude-specific). Centralizada para que sea fácil
// de ajustar sin tocar el transformer.
const CLAUDE_AGENT_CONFIG = {
  phobos: {
    // phobos orquesta — necesita Agent tool con whitelist de subagentes que puede invocar.
    // tools como string; el transformer le agrega Agent(...) basado en permission.task del template OpenCode.
    model: 'inherit',  // hereda del main session de Claude Code
  },
  researcher: {
    model: 'haiku',    // fast, barato — researcher hace muchas lecturas
  },
  planner: {
    model: 'sonnet',   // razonamiento estructurado
  },
  programmer: {
    model: 'sonnet',   // código — balance capacidad/costo
  },
  tester: {
    model: 'haiku',    // tests cortos, salida concisa
  },
  archivist: {
    model: 'sonnet',   // prosa para distilar insights / conclusions
  },
};

// Modelos válidos para Claude Code. Lista estática (Claude no tiene un comando
// `claude models` como OpenCode tiene `opencode models`).
const CLAUDE_AVAILABLE_MODELS = [
  // Aliases (recomendados — el usuario los reconoce más fácil)
  'inherit',
  'sonnet',
  'opus',
  'haiku',
  // Full IDs (cuando se quiere pinear una versión específica)
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-haiku-4-5',
];

export class ClaudeAdapter extends IDEAdapter {
  // ─── Identidad ─────────────────────────────────────────────────────

  get id() { return 'claude'; }
  get displayName() { return 'Claude Code'; }
  get isImplemented() { return true; }

  // ─── Paths del proyecto destino ────────────────────────────────────

  get agentDir() { return '.claude/agents'; }
  get commandDir() { return '.claude/commands'; }
  get skillDirs() {
    return [
      '.claude/skills',                         // proyecto
      join(homedir(), '.claude', 'skills'),     // global Claude Code
      // Compatibilidad con ecosystem Skills CLI:
      '.agents/skills',
      join(homedir(), '.agents', 'skills'),
    ];
  }

  // ─── Paths del template source ─────────────────────────────────────

  // Los agentes los reusamos de OpenCode (single source of truth).
  // Los commands viven en claude/commands/ (escritos a mano).
  get templateAgentDir() { return 'opencode/agent'; }
  get templateCommandDir() { return 'claude/commands'; }

  // ─── Archivos para bootstrap ───────────────────────────────────────

  bootstrapFiles() {
    const files = [];

    // Agentes: tomamos los templates de OpenCode (single source of truth)
    // y los escribimos a .claude/agents/<agent>.md aplicando el transformer
    // de frontmatter. El body queda idéntico.
    for (const agent of ['phobos', 'researcher', 'planner', 'programmer', 'tester', 'archivist']) {
      files.push({
        src: `opencode/agent/${agent}.md`,
        dst: `.claude/agents/${agent}.md`,
        group: 'agentes',
        transform: 'agent',  // bootstrap llamará adapter.transformAgent(content)
      });
    }

    // Slash commands: templates Claude-specific (a mano, en claude/commands/).
    for (const cmd of ['adapt-agents', 'models-wizard', 'reindex-memory', 'reindex-codegraph', 'list-memory']) {
      files.push({
        src: `claude/commands/${cmd}.md`,
        dst: `.claude/commands/${cmd}.md`,
        group: 'comandos',
      });
    }

    // Vault — IDE-agnostic, idéntico para los dos targets.
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
      // Agentes — mismo single source. ignoreModel: true porque el usuario
      // customiza el modelo deliberadamente vía "Setear modelos".
      { src: 'opencode/agent/phobos.md',     dst: '.claude/agents/phobos.md',     ignoreModel: true,  transform: 'agent' },
      { src: 'opencode/agent/researcher.md', dst: '.claude/agents/researcher.md', ignoreModel: true,  transform: 'agent' },
      { src: 'opencode/agent/planner.md',    dst: '.claude/agents/planner.md',    ignoreModel: true,  transform: 'agent' },
      { src: 'opencode/agent/programmer.md', dst: '.claude/agents/programmer.md', ignoreModel: true,  transform: 'agent' },
      { src: 'opencode/agent/tester.md',     dst: '.claude/agents/tester.md',     ignoreModel: true,  transform: 'agent' },
      { src: 'opencode/agent/archivist.md',  dst: '.claude/agents/archivist.md',  ignoreModel: true,  transform: 'agent' },
      // Commands — templates propios.
      { src: 'claude/commands/adapt-agents.md',      dst: '.claude/commands/adapt-agents.md',      ignoreModel: false },
      { src: 'claude/commands/models-wizard.md',     dst: '.claude/commands/models-wizard.md',     ignoreModel: false },
      { src: 'claude/commands/reindex-memory.md',    dst: '.claude/commands/reindex-memory.md',    ignoreModel: false },
      { src: 'claude/commands/reindex-codegraph.md', dst: '.claude/commands/reindex-codegraph.md', ignoreModel: false },
      { src: 'claude/commands/list-memory.md',       dst: '.claude/commands/list-memory.md',       ignoreModel: false },
    ];
  }

  // ─── Detección del CLI ─────────────────────────────────────────────

  async detectCli() {
    const r = tryExec('claude --version', 8000);
    if (!r.ok) {
      return { ok: false, error: 'Claude Code CLI no detectado en PATH.' };
    }
    return { ok: true, version: (r.out || '').trim().split('\n')[0] };
  }

  // Claude Code no tiene `~/.config/claude/auth.json` con providers — el auth
  // se maneja directamente por Anthropic API o Claude.ai login. Devolvemos
  // una lista vacía con una nota.
  async detectAuthProviders() {
    return {
      providers: ['anthropic'],
      notes: ['Claude Code usa Anthropic API directa; no hay archivo de providers múltiples como OpenCode.'],
    };
  }

  // ─── Catalog de modelos disponibles ────────────────────────────────

  // Lista estática de modelos válidos en Claude Code (no hay CLI subcommand
  // que los liste dinámicamente — los aliases son fijos).
  async listAvailableModels() {
    // Devolvemos en el mismo shape que `detect()` de OpenCode usa para que
    // `actionSetModels` no tenga que diferenciar:
    //   { models: Map<id, source>, providers: Set, notes: [] }
    const models = new Map();
    for (const m of CLAUDE_AVAILABLE_MODELS) {
      models.set(m, 'claude (static)');
    }
    return {
      models,
      providers: new Set(['claude']),
      notes: ['Claude Code: lista estática de modelos. Usá "inherit" para heredar del main session, o un alias / full ID.'],
    };
  }

  // ─── Recomendaciones por agente ────────────────────────────────────

  defaultModelForAgent(agentName) {
    return CLAUDE_AGENT_CONFIG[agentName]?.model || 'inherit';
  }

  launchCommand() {
    // `--agent phobos` arranca Claude Code con phobos como agente primario
    // (Opción 1 — explicit primary). Los subagentes researcher/planner/etc.
    // se invocan vía la Task tool desde phobos.
    return { bin: 'claude', args: ['--agent', 'phobos'] };
  }

  backupBaseDir() {
    return '.claude/agents_backup/phobos';
  }

  noProvidersHelp() {
    return [
      `Claude Code usa una lista estática de modelos — no requiere providers conectados.`,
      '',
      'Si estás viendo este mensaje, algo raro pasó con el adapter.',
    ];
  }

  // ─── Normalización del model id ────────────────────────────────────

  // Convierte un model id de cualquier forma (OpenCode-style con provider,
  // o ya Claude-style) al formato que Claude Code espera.
  normalizeModelId(id) {
    if (!id) return 'inherit';
    const lower = id.toLowerCase().trim();

    // Si ya es un alias o full ID Claude válido, devolver tal cual.
    if (CLAUDE_AVAILABLE_MODELS.includes(lower)) return lower;

    // OpenCode-style: "github-copilot/claude-sonnet-4.6" → "claude-sonnet-4-6"
    // "opencode/claude-sonnet-4-6" → "claude-sonnet-4-6"
    const slash = lower.indexOf('/');
    if (slash >= 0) {
      const tail = lower.slice(slash + 1).replace(/\./g, '-');
      // Si el resto matchea un modelo Claude conocido, usar ese.
      if (CLAUDE_AVAILABLE_MODELS.includes(tail)) return tail;
      // Si contiene "sonnet", "opus", "haiku" → mapear al alias correspondiente.
      if (tail.includes('sonnet')) return 'sonnet';
      if (tail.includes('opus')) return 'opus';
      if (tail.includes('haiku')) return 'haiku';
    }

    // Si nada matchea, fallback a inherit (seguro — usa el del main session).
    return 'inherit';
  }

  // ─── Transformer del frontmatter de agentes ────────────────────────

  // Toma el contenido de un agente OpenCode (.md con YAML frontmatter) y
  // devuelve el equivalente para Claude Code:
  //   - Frontmatter Claude-style (name, description, tools, model, etc.).
  //   - Body markdown idéntico (mismo prompt).
  transformAgent(opencodeContent, agentName) {
    const { frontmatter, body } = splitYamlFrontmatter(opencodeContent);

    // Derivar nombre Claude: lowercase, hyphens-only.
    const name = (agentName || frontmatter._sourceName || 'agent')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    // tools de Claude (comma-separated). Mapeo desde OpenCode:
    //   tools: { read: true, bash: true, task: true } → "Read, Bash, Agent"
    //   write/edit no se incluyen si están false.
    const claudeTools = mapOpencodeToolsToClaude(frontmatter.tools, frontmatter.permission, agentName);

    // disallowedTools: si OpenCode tiene `permission.webfetch: deny`,
    // `permission.edit: deny` → equivalente en Claude.
    const disallowed = mapDeniesToDisallowedTools(frontmatter.permission);

    // Modelo: normalizar al formato Claude.
    // Si CLAUDE_AGENT_CONFIG tiene preferencia explícita, usar esa.
    // Si no, normalizar lo que venga de OpenCode.
    const configuredModel = CLAUDE_AGENT_CONFIG[name]?.model;
    const model = configuredModel || this.normalizeModelId(frontmatter.model);

    // Construir el frontmatter Claude (orden: name, description, model, tools, disallowedTools).
    const claudeFm = [];
    claudeFm.push(`name: ${name}`);
    if (frontmatter.description) {
      // description puede ser larga — la dejamos en una sola línea.
      claudeFm.push(`description: ${escapeYamlValue(frontmatter.description)}`);
    }
    claudeFm.push(`model: ${model}`);
    if (claudeTools) {
      claudeFm.push(`tools: ${claudeTools}`);
    }
    if (disallowed) {
      claudeFm.push(`disallowedTools: ${disallowed}`);
    }

    return `---\n${claudeFm.join('\n')}\n---\n\n${body}`;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Helpers de transformación
// ═══════════════════════════════════════════════════════════════════

// Split mínimo de YAML frontmatter — extrae el bloque entre `---` y el body.
// Parseo simple (NO usa una librería YAML) porque solo necesitamos los campos
// top-level que sabemos que existen en los templates de Phobos.
function splitYamlFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]+?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const yamlBlock = match[1];
  const body = match[2] || '';
  const frontmatter = parseSimpleYaml(yamlBlock);
  return { frontmatter, body };
}

// Parser YAML súper minimal para el subset que usan los agentes Phobos:
//   - Top-level: scalar | object | nested object
//   - tools: { read: true, bash: false, ... }
//   - permission: { edit: deny, bash: { "git push*": deny, ... } }
//
// No es un YAML parser general — solo cubre los patrones que conocemos.
function parseSimpleYaml(yaml) {
  const lines = yaml.split('\n');

  // Parser indent-aware. Soporta 2 niveles de anidamiento (suficiente para
  // los templates de Phobos: tools, permission.{edit,webfetch,bash,task}).
  //
  // Estructura de los templates:
  //   permission:           ← level 0
  //     edit: deny          ← level 1 scalar
  //     bash:               ← level 1, empty → level 2 block
  //       "*": ask          ← level 2 scalar
  //       "ls *": allow     ← level 2 scalar
  //     task:               ← level 1, empty → level 2 block
  //       researcher: allow ← level 2 scalar
  //       ...

  // Helper: cantidad de espacios al inicio. \t cuenta como 2.
  function getIndent(line) {
    let n = 0;
    for (const ch of line) {
      if (ch === ' ') n++;
      else if (ch === '\t') n += 2;
      else break;
    }
    return n;
  }

  function stripComment(s) {
    // Saca comentario inline pero respeta # dentro de comillas.
    const m = s.match(/^([^"#]*(?:"[^"]*"[^"#]*)*)#.*$/);
    return m ? m[1] : s;
  }

  function parseKV(line) {
    const stripped = stripComment(line).trim();
    if (!stripped) return null;
    const m = stripped.match(/^"?([^"]+?)"?:\s*(.*)$/);
    if (!m) return null;
    return {
      key: m[1],
      value: m[2].trim().replace(/^["']|["']$/g, ''),
    };
  }

  const result = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { i++; continue; }
    if (getIndent(line) !== 0) { i++; continue; }  // ignoramos sub-niveles "huérfanos"

    const kv = parseKV(line);
    if (!kv) { i++; continue; }
    i++;

    if (kv.value === '') {
      // Block en level 1. Parseamos sub-keys con indent > 0.
      const block = {};
      while (i < lines.length) {
        const sub = lines[i];
        if (!sub.trim()) { i++; continue; }
        const subIndent = getIndent(sub);
        if (subIndent === 0) break;  // volvió a top-level

        // Solo procesamos sub-claves de level 1 (indent 2 típicamente).
        // Si encontramos indent mayor (level 2), asumimos que es un sub-block
        // del último sub-key con value vacío.
        const subKv = parseKV(sub);
        if (subKv) {
          if (subKv.value === '') {
            // Sub-block (nivel 2). Parseamos sus hijos.
            i++;
            const subBlock = {};
            const baseIndent = subIndent;
            while (i < lines.length) {
              const sub2 = lines[i];
              if (!sub2.trim()) { i++; continue; }
              const sub2Indent = getIndent(sub2);
              if (sub2Indent <= baseIndent) break;  // volvió a level 1 o 0
              const sub2Kv = parseKV(sub2);
              if (sub2Kv) {
                subBlock[sub2Kv.key] = sub2Kv.value;
              }
              i++;
            }
            block[subKv.key] = subBlock;
          } else {
            block[subKv.key] = subKv.value;
            i++;
          }
        } else {
          i++;
        }
      }
      result[kv.key] = block;
    } else {
      result[kv.key] = kv.value;
    }
  }
  return result;
}

// Mapea el bloque `tools` (object con booleans) de OpenCode al string de
// Claude (comma-separated). Si el agente tiene `permission.task` whitelist
// de subagents, agrega `Agent(researcher, planner, ...)` al tools.
function mapOpencodeToolsToClaude(openCodeTools, openCodePermission, agentName) {
  const claudeTools = new Set();

  // Si OpenCode declara `tools:` explícito, usamos eso como base.
  if (openCodeTools && typeof openCodeTools === 'object') {
    // OpenCode keys: read, write, edit, bash, task, todowrite, todoread, webfetch
    if (openCodeTools.read === 'true' || openCodeTools.read === true) claudeTools.add('Read');
    if (openCodeTools.write === 'true' || openCodeTools.write === true) claudeTools.add('Write');
    if (openCodeTools.edit === 'true' || openCodeTools.edit === true) claudeTools.add('Edit');
    if (openCodeTools.bash === 'true' || openCodeTools.bash === true) claudeTools.add('Bash');
    if (openCodeTools.todowrite === 'true' || openCodeTools.todowrite === true) claudeTools.add('TodoWrite');
    if (openCodeTools.webfetch === 'true' || openCodeTools.webfetch === true) claudeTools.add('WebFetch');
  } else {
    // Sin `tools:` explícito (caso típico de subagents OpenCode que heredan defaults).
    // Asumimos Read + Bash como baseline; el resto se infiere de `permission`.
    claudeTools.add('Read');
    claudeTools.add('Bash');
  }

  // Inferir Edit/Write desde permission.edit. OpenCode subagents que escriben
  // suelen NO declarar `tools:` pero sí tienen `permission.edit: "*": allow`
  // o `permission.edit: allow`. Sin esta inferencia, programmer/tester/archivist
  // quedan sin permisos para editar en Claude.
  if (openCodePermission && openCodePermission.edit !== undefined) {
    const editPerm = openCodePermission.edit;
    // Caso 1: edit es un string ("allow" o "deny" simple). Si != deny → tiene permisos.
    if (typeof editPerm === 'string' && editPerm !== 'deny') {
      claudeTools.add('Edit');
      claudeTools.add('Write');
    }
    // Caso 2: edit es un object (con patterns). Si tiene AL MENOS UN allow → puede editar.
    else if (typeof editPerm === 'object' && editPerm !== null) {
      const hasAllow = Object.values(editPerm).some(v => v === 'allow');
      if (hasAllow) {
        claudeTools.add('Edit');
        claudeTools.add('Write');
      }
    }
  }

  // Glob/Grep son tools "naturales" para cualquier agente que pueda leer.
  // Las agregamos siempre que haya Read.
  if (claudeTools.has('Read')) {
    claudeTools.add('Glob');
    claudeTools.add('Grep');
  }

  // Si OpenCode tiene `task: true` Y permission.task con whitelist de subagents,
  // generar Agent(researcher, planner, ...). Esto solo aplica para Phobos típicamente.
  const taskEnabled = openCodeTools && (openCodeTools.task === 'true' || openCodeTools.task === true);
  if (taskEnabled && openCodePermission && openCodePermission.task) {
    const allowedSubagents = [];
    for (const [subagent, perm] of Object.entries(openCodePermission.task)) {
      if (perm === 'allow' && subagent !== '*') {
        allowedSubagents.push(subagent);
      }
    }
    if (allowedSubagents.length > 0) {
      claudeTools.add(`Agent(${allowedSubagents.join(', ')})`);
    } else {
      claudeTools.add('Agent');
    }
  }

  return [...claudeTools].join(', ');
}

// Mapea denies de OpenCode (permission.edit: deny, permission.webfetch: deny)
// a `disallowedTools` de Claude. Devuelve string comma-separated o '' si no hay.
function mapDeniesToDisallowedTools(openCodePermission) {
  if (!openCodePermission) return '';
  const denies = [];
  if (openCodePermission.edit === 'deny') denies.push('Edit', 'Write');
  if (openCodePermission.webfetch === 'deny') denies.push('WebFetch');
  // Las reglas finas de permission.bash NO se mapean — Claude no las soporta.
  // Quedan en el body del prompt como guidance defensiva del agente.
  return denies.join(', ');
}

// Escapa un valor YAML para que sea válido. Si el value tiene caracteres
// problemáticos (`:` en medio, `#`, comillas), lo wrappeamos en comillas dobles.
function escapeYamlValue(value) {
  const s = String(value);
  if (/[:\n#]/.test(s) || /^["'`\[\{!&*|>%@]/.test(s)) {
    return JSON.stringify(s);  // double-quoted, escapes internas
  }
  return s;
}

// IDEAdapter — clase abstracta. Define el contrato que cada adapter
// específico (OpencodeAdapter, ClaudeAdapter, etc.) debe cumplir.
//
// Filosofía: Phobos es target-agnostic en su lógica de orquestación SDD.
// Las únicas cosas que dependen del IDE son convenciones de paths,
// formato de frontmatter de agentes, listado de archivos a bootstrap
// y trackear, y detección del CLI del IDE. Todo eso vive en el adapter.
//
// Para extender Phobos a un IDE nuevo, NO hace falta tocar bootstrap.mjs,
// update.mjs, models.mjs, tools.mjs, memory/*. Solo:
//   1. Implementar una subclase de IDEAdapter.
//   2. Agregar templates correspondientes bajo scripts/templates/<id>/.
//   3. Registrar la nueva subclase en phobos.mjs → selectTarget().

export class IDEAdapter {
  // ─── Identidad ─────────────────────────────────────────────────────

  /**
   * Identificador interno del adapter. Lowercase, kebab-case.
   * Usado en logs, paths de templates, etc.
   * @returns {string} ej: 'opencode' | 'claude'
   */
  get id() {
    throw new Error(`${this.constructor.name} must override get id()`);
  }

  /**
   * Nombre legible para el usuario en el menú selectTarget.
   * @returns {string} ej: 'OpenCode' | 'Claude Code'
   */
  get displayName() {
    throw new Error(`${this.constructor.name} must override get displayName()`);
  }

  /**
   * True si este adapter está implementado completamente.
   * False = stub (se muestra "próximamente" y se sale del wizard).
   * @returns {boolean}
   */
  get isImplemented() {
    return false;
  }

  // ─── Paths del proyecto destino ────────────────────────────────────

  /**
   * Directorio del proyecto donde viven los agentes .md.
   * @returns {string} ej: '.opencode/agent' | '.claude/agents'
   */
  get agentDir() {
    throw new Error(`${this.constructor.name} must override get agentDir()`);
  }

  /**
   * Directorio del proyecto donde viven los slash commands .md.
   * @returns {string} ej: '.opencode/command' | '.claude/commands'
   */
  get commandDir() {
    throw new Error(`${this.constructor.name} must override get commandDir()`);
  }

  /**
   * Paths donde el IDE busca skills (ordenados por prioridad — local primero).
   * @returns {string[]}
   */
  get skillDirs() {
    return [];
  }

  // ─── Paths del template source (en scripts/templates/) ────────────

  /**
   * Subdirectorio bajo TEMPLATES_DIR donde viven los templates de agentes
   * para este IDE.
   * @returns {string} ej: 'agentes' (single source of truth — both IDEs reusan estos templates; Claude aplica transformAgent al frontmatter)
   */
  get templateAgentDir() {
    throw new Error(`${this.constructor.name} must override get templateAgentDir()`);
  }

  /**
   * Subdirectorio bajo TEMPLATES_DIR donde viven los templates de slash commands.
   * @returns {string} ej: 'opencode/command' | 'claude/commands'
   */
  get templateCommandDir() {
    throw new Error(`${this.constructor.name} must override get templateCommandDir()`);
  }

  // ─── Listas de archivos para bootstrap y update ───────────────────

  /**
   * Lista de archivos del template que deben copiarse al proyecto al
   * bootstrappear. Cada item: { src, dst } donde src es relativo a
   * TEMPLATES_DIR y dst es relativo al cwd del proyecto.
   * @returns {Array<{src: string, dst: string}>}
   */
  bootstrapFiles() {
    throw new Error(`${this.constructor.name} must override bootstrapFiles()`);
  }

  /**
   * Lista de archivos a trackear para "Actualizar agentes" (detecta drift
   * entre template y local). Cada item: { src, dst, ignoreModel }.
   * - ignoreModel: si true, al comparar contenido para ver si hay update
   *   pendiente, se enmascara la línea `model: ...` del frontmatter (porque
   *   el usuario probablemente cambió el modelo a propósito).
   * @returns {Array<{src: string, dst: string, ignoreModel: boolean}>}
   */
  trackedFiles() {
    throw new Error(`${this.constructor.name} must override trackedFiles()`);
  }

  // ─── Detección del CLI del IDE ─────────────────────────────────────

  /**
   * Verifica que el CLI del IDE esté instalado y accesible en PATH.
   * @returns {Promise<{ok: boolean, version?: string, error?: string}>}
   */
  async detectCli() {
    return { ok: false, error: 'detectCli not implemented' };
  }

  /**
   * Lee el archivo de auth del IDE para extraer providers configurados.
   * @returns {Promise<{providers: string[], notes: string[]}>}
   */
  async detectAuthProviders() {
    return { providers: [], notes: ['detectAuthProviders not implemented'] };
  }

  // ─── Catálogo de modelos disponibles ──────────────────────────────

  /**
   * Lista de modelos disponibles para este IDE. Cada adapter define cómo
   * los descubre (CLI subcommand, auth.json, lista estática, etc.).
   * Shape esperado para que `actionSetModels` sea target-agnostic:
   *   {
   *     models: Map<string, string>,   // id → source ("opencode models" | "claude (static)" | ...)
   *     providers: Set<string>,         // providers configurados
   *     notes: string[],                // mensajes informativos para el usuario
   *   }
   * @returns {Promise<{models: Map<string,string>, providers: Set<string>, notes: string[]}>}
   */
  async listAvailableModels() {
    throw new Error(`${this.constructor.name} must override listAvailableModels()`);
  }

  /**
   * Modelo recomendado por defecto para un agente dado. Usado por el wizard
   * cuando todavía no hay un modelo asignado o cuando el usuario elige "auto".
   * @param {string} agentName  ej: 'phobos' | 'researcher' | ...
   * @returns {string}  ej: 'inherit' | 'sonnet' | 'github-copilot/claude-sonnet-4-6'
   */
  defaultModelForAgent(agentName) {
    throw new Error(`${this.constructor.name} must override defaultModelForAgent()`);
  }

  /**
   * Mensaje (UI) a mostrar cuando `listAvailableModels` devuelve 0 providers.
   * Permite a cada adapter dar instrucciones específicas (ej: "iniciá OpenCode
   * con /connect" vs "configurá ANTHROPIC_API_KEY").
   * @returns {string[]}  líneas de texto a mostrar (sin colores)
   */
  noProvidersHelp() {
    return [
      `No detecté proveedores conectados para ${this.displayName}.`,
      'Configurá al menos uno antes de continuar.',
    ];
  }

  // ─── Lanzar la TUI del IDE con Phobos ─────────────────────────────

  /**
   * Comando para abrir la TUI del IDE en modo Phobos. El wizard usa esto
   * en la acción "Abrir TUI" del menú principal.
   *   OpenCode: `opencode`
   *   Claude:   `claude --agent phobos`
   * @returns {{bin: string, args: string[]}}
   */
  launchCommand() {
    throw new Error(`${this.constructor.name} must override launchCommand()`);
  }

  // ─── Manipulación del frontmatter del agente ──────────────────────

  /**
   * Normaliza el contenido de un agente para comparación (ignora cambios
   * que el usuario hace deliberadamente, ej: model:).
   * Default: ignora línea `model:`. Adapters pueden override para más logic.
   * @param {string} content
   * @returns {string}
   */
  normalizeAgentFrontmatter(content) {
    return content.replace(/^model:\s*.+$/m, 'model: <PRESERVED>');
  }
}

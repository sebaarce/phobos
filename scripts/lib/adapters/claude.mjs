// ClaudeAdapter — stub. Phobos NO está implementado para Claude Code todavía.
//
// El menú selectTarget() de phobos.mjs muestra "Claude Code (próximamente)"
// y permite seleccionarlo, pero el wizard cierra al elegirlo con un mensaje
// informativo. La clase existe para mantener simétrica la arquitectura y
// reservar el espacio para la implementación futura.
//
// Cuando se decida portar Phobos a Claude Code, este archivo se completa
// con la misma estructura que OpencodeAdapter:
//   - agentDir/commandDir/skillDirs según convenciones de Claude Code
//   - templateAgentDir/templateCommandDir apuntando a scripts/templates/claude/
//   - bootstrapFiles() y trackedFiles() listando los templates portados
//   - detectCli() corriendo `claude --version`
//   - detectAuthProviders() leyendo el auth state correcto

import { IDEAdapter } from './base.mjs';

export class ClaudeAdapter extends IDEAdapter {
  get id() { return 'claude'; }
  get displayName() { return 'Claude Code'; }
  get isImplemented() { return false; }

  // Los siguientes getters tiran al ser usados — para evitar que algún módulo
  // de Phobos por error opere con paths fantasma cuando el adapter no está
  // implementado. phobos.mjs debe chequear `adapter.isImplemented` antes de
  // pasarlo a cualquier módulo.

  get agentDir() {
    throw new Error('ClaudeAdapter aún no implementado — selectTarget() debería haber salido antes de llegar acá.');
  }
  get commandDir() {
    throw new Error('ClaudeAdapter aún no implementado.');
  }
  get templateAgentDir() {
    throw new Error('ClaudeAdapter aún no implementado.');
  }
  get templateCommandDir() {
    throw new Error('ClaudeAdapter aún no implementado.');
  }
  bootstrapFiles() {
    throw new Error('ClaudeAdapter aún no implementado.');
  }
  trackedFiles() {
    throw new Error('ClaudeAdapter aún no implementado.');
  }
}

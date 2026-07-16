const CLAUDE_COMMANDS = new Set(['claude', 'claude-code']);

export function isClaudeCommand(command) {
  return CLAUDE_COMMANDS.has(String(command || '').toLowerCase());
}

export function isClaudePane(command, title = '') {
  const normalized = String(command || '').toLowerCase();
  return isClaudeCommand(normalized) || (normalized === 'node' && /^\s*✳(?:\s|$)/u.test(String(title)));
}

export function shouldUseNativeWheel({ command, title, forceCopy, clientMouseSgr, mouseAny, mouseSgr }) {
  return Boolean(
    !forceCopy &&
    isClaudePane(command, title) &&
    (clientMouseSgr || (mouseAny && mouseSgr))
  );
}

export function sgrWheel(dir, count, col, row) {
  const button = dir < 0 ? 64 : 65;
  let data = '';
  for (let i = 0; i < count; i++) data += `\x1b[<${button};${col};${row}M`;
  return data;
}

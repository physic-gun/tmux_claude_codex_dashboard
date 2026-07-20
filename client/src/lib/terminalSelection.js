// xterm returns explicitly painted padding cells as regular spaces. Trim that
// padding without changing unrelated clipboard sources such as OSC 52 or files.
/**
 * @param {string} text
 */
export function normalizeTerminalSelection(text) {
  return text
    .replace(/ +(?=\r\n|\n|\r|$)/g, '')
    .replace(/(^|\r\n|\n|\r) {2}/g, '$1');
}

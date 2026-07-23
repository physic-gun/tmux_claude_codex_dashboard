export const DEFAULT_TERMINAL_THEME = 'tokyo-night';

export const TERMINAL_THEME_IDS = Object.freeze([
  DEFAULT_TERMINAL_THEME,
  'github-light',
  'catppuccin-latte',
  'ayu-light',
  'gruvbox-light',
  'bluloco-light',
  'horizon-bright',
]);

const TERMINAL_THEME_ID_SET = new Set(TERMINAL_THEME_IDS);

export function isTerminalThemeId(value) {
  return typeof value === 'string' && TERMINAL_THEME_ID_SET.has(value);
}

// Old clients do not send term_theme. Preserve the current account preference in that case;
// an explicit unknown value is a bad request rather than a silent reset to the default.
export function resolveTerminalThemeSetting(body, current) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, 'term_theme')) {
    return {
      ok: true,
      value: isTerminalThemeId(current) ? current : DEFAULT_TERMINAL_THEME,
    };
  }
  if (!isTerminalThemeId(body.term_theme)) return { ok: false, value: null };
  return { ok: true, value: body.term_theme };
}

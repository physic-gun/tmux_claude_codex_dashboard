// Light/dark theme, persisted client-side (no server round-trip). The chosen theme sets
// data-theme="light"|"dark" on <html>; styles.css + tailwind.css react to it via CSS vars.
// The terminal (xterm) intentionally stays dark regardless of theme.
//
// NOTE: the same localStorage key + attribute are set by an inline boot script in index.html so
// the correct theme paints on first frame (no dark→light flash). Keep the key ('tmuxdash:theme')
// and default ('dark') in sync with that script.
export type Theme = 'dark' | 'light';

const KEY = 'tmuxdash:theme';

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
}

export function setTheme(t: Theme): void {
  try { localStorage.setItem(KEY, t); } catch { /* private mode / quota */ }
  applyTheme(t);
}

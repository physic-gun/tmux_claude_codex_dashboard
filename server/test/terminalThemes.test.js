import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TERMINAL_THEME,
  TERMINAL_THEME_IDS,
  isTerminalThemeId,
  resolveTerminalThemeSetting,
} from '../src/terminalThemes.js';

test('terminal theme allowlist is unique and includes the default', () => {
  assert.equal(new Set(TERMINAL_THEME_IDS).size, TERMINAL_THEME_IDS.length);
  assert.ok(isTerminalThemeId(DEFAULT_TERMINAL_THEME));
  assert.equal(isTerminalThemeId('not-a-theme'), false);
  assert.equal(isTerminalThemeId(null), false);
});

test('legacy settings requests preserve the current terminal theme', () => {
  assert.deepEqual(resolveTerminalThemeSetting({}, 'ayu-light'), {
    ok: true,
    value: 'ayu-light',
  });
  assert.deepEqual(resolveTerminalThemeSetting({}, 'stale-value'), {
    ok: true,
    value: DEFAULT_TERMINAL_THEME,
  });
});

test('explicit terminal theme values must be allowlisted', () => {
  assert.deepEqual(resolveTerminalThemeSetting({ term_theme: 'github-light' }, 'ayu-light'), {
    ok: true,
    value: 'github-light',
  });
  assert.deepEqual(resolveTerminalThemeSetting({ term_theme: 'unknown' }, 'ayu-light'), {
    ok: false,
    value: null,
  });
});

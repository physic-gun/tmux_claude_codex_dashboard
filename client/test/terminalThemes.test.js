import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TERMINAL_THEME,
  TERMINAL_THEMES,
  TERMINAL_THEME_SOURCE,
  getTerminalTheme,
  isTerminalThemeId,
} from '../src/lib/terminalThemes.js';

const COLOR_KEYS = [
  'background', 'foreground', 'cursor', 'cursorAccent',
  'selectionBackground', 'selectionForeground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

test('terminal palettes have unique ids and complete valid xterm colors', () => {
  assert.equal(TERMINAL_THEMES.length, 7);
  assert.equal(new Set(TERMINAL_THEMES.map((theme) => theme.id)).size, TERMINAL_THEMES.length);
  for (const preset of TERMINAL_THEMES) {
    assert.ok(['dark', 'light'].includes(preset.appearance));
    assert.equal(preset.swatches.length, 16);
    for (const key of COLOR_KEYS) {
      assert.match(preset.theme[key], /^#[0-9a-f]{6}$/i, `${preset.id}.${key}`);
    }
  }
});

test('unknown terminal palettes fall back to the pinned default', () => {
  assert.ok(isTerminalThemeId(DEFAULT_TERMINAL_THEME));
  assert.equal(isTerminalThemeId('unknown'), false);
  assert.equal(getTerminalTheme('unknown').id, DEFAULT_TERMINAL_THEME);
  assert.equal(getTerminalTheme('github-light').id, 'github-light');
});

test('palette source stays pinned to the reviewed upstream revision', () => {
  assert.match(TERMINAL_THEME_SOURCE.commit, /^[0-9a-f]{40}$/);
});

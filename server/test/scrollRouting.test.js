import test from 'node:test';
import assert from 'node:assert/strict';
import { isClaudePane, sgrWheel, shouldUseNativeWheel } from '../src/scrollRouting.js';

test('Claude is recognized when tmux reports the wrapper as node', () => {
  assert.equal(isClaudePane('node', '✳ Refactor the parser'), true);
  assert.equal(isClaudePane('node', 'project dashboard'), false);
});

test('Claude uses native wheel when the server sees SGR even if the browser missed it', () => {
  assert.equal(shouldUseNativeWheel({
    command: 'claude',
    clientMouseSgr: false,
    mouseAny: true,
    mouseSgr: true,
  }), true);
});

test('a stale browser mouse hint never reaches Codex or a shell', () => {
  for (const command of ['codex', 'bash']) {
    assert.equal(shouldUseNativeWheel({
      command,
      clientMouseSgr: true,
      mouseAny: true,
      mouseSgr: true,
    }), false);
  }
});

test('a Node-wrapped Claude pane keeps native wheel routing', () => {
  assert.equal(shouldUseNativeWheel({
    command: 'node',
    title: '✳ Review deployment safety',
    clientMouseSgr: false,
    mouseAny: true,
    mouseSgr: true,
  }), true);
});

test('forceCopy overrides Claude mouse mode', () => {
  assert.equal(shouldUseNativeWheel({
    command: 'claude-code',
    forceCopy: true,
    clientMouseSgr: true,
    mouseAny: true,
    mouseSgr: true,
  }), false);
});

test('SGR wheel encoding preserves direction, location, and count', () => {
  assert.equal(sgrWheel(-1, 2, 10, 7), '\x1b[<64;10;7M\x1b[<64;10;7M');
  assert.equal(sgrWheel(1, 1, 3, 4), '\x1b[<65;3;4M');
});

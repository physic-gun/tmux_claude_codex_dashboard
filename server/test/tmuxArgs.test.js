import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTmuxArgs } from '../src/tmuxArgs.js';

test('externally managed clients cannot start a tmux server', () => {
  assert.deepEqual(buildTmuxArgs({
    socket: 'tmuxdash',
    conf: '/srv/tmux-dashboard/server/tmux.conf',
    managedExternally: true,
  }, ['new-session', '-d', '-s', 'grp_1']), [
    '-N', '-L', 'tmuxdash', '-f', '/srv/tmux-dashboard/server/tmux.conf',
    'new-session', '-d', '-s', 'grp_1',
  ]);
});

test('development mode retains tmux auto-start behavior', () => {
  assert.deepEqual(buildTmuxArgs({
    socket: 'tmuxdash',
    conf: '/tmp/tmux.conf',
    managedExternally: false,
  }, ['list-sessions']), [
    '-L', 'tmuxdash', '-f', '/tmp/tmux.conf', 'list-sessions',
  ]);
});

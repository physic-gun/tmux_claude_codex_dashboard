import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentForProcess,
  buildActivitySnapshot,
  derivePaneActivity,
  forwardInputAfterActivity,
  inputActivitySignal,
  parsePaneActivity,
  transitionActivityForInput,
  writeActivityTransition,
} from '../src/activity.js';

const option = (overrides = {}) => JSON.stringify({
  v: 1,
  agent: 'claude',
  phase: 'working',
  reason: 'prompt_submitted',
  eventId: 'turn-1',
  updatedAt: 1_753_000_000_000,
  ...overrides,
});

const pane = (overrides = {}) => ({
  groupId: 4,
  window: 'main',
  paneId: '%2',
  panePid: 100,
  active: true,
  command: 'bash',
  title: '',
  activityRaw: '',
  ...overrides,
});

test('pane option parser accepts epoch milliseconds and rejects malformed enum values atomically', () => {
  assert.deepEqual(parsePaneActivity(option()), {
    agent: 'claude',
    phase: 'working',
    reason: 'prompt_submitted',
    detail: null,
    updatedAt: new Date(1_753_000_000_000).toISOString(),
    eventId: 'turn-1',
  });
  assert.equal(parsePaneActivity(option({ phase: 'streaming' })), null);
  assert.equal(parsePaneActivity('{bad json'), null);
  assert.equal(parsePaneActivity('x'.repeat(5000)), null);
});

test('failure detail is admitted only through the fixed detail whitelist', () => {
  assert.equal(parsePaneActivity(option({ detail: 'rate_limit' })).detail, 'rate_limit');
  assert.equal(parsePaneActivity(option({ detail: 'future_failure' })).detail, null);
  assert.equal(parsePaneActivity(option({ detail: '<script>alert(1)</script>' })).detail, null);
});

test('Claude and Codex wrappers are identified without database or open-file inspection', () => {
  assert.equal(agentForProcess({ comm: 'claude', cmdline: 'claude --resume abc' }), 'claude');
  assert.equal(agentForProcess({ comm: 'node', cmdline: 'node /home/u/.local/bin/codex --full-auto' }), 'codex');
  assert.equal(agentForProcess({
    comm: 'node',
    cmdline: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  }), 'claude');
  assert.equal(agentForProcess({ comm: 'codex-code-mode-host', cmdline: '/bin/codex-code-mode-host' }), null);
  assert.equal(agentForProcess({ comm: 'node', cmdline: 'node /srv/app/server.js codex' }), null);
});

test('a recognized agent without hook state is gray idle', () => {
  const activity = derivePaneActivity(pane(), {
    reliable: true,
    rows: [
      { pid: 100, ppid: 1, comm: 'bash', cmdline: '-bash' },
      { pid: 101, ppid: 100, comm: 'codex', cmdline: '/opt/bin/codex' },
    ],
  });
  assert.equal(activity.agent, 'codex');
  assert.equal(activity.phase, 'idle');
  assert.equal(activity.reason, 'detected');
});

test('working becomes abnormal_exit when its matching agent process disappears', () => {
  const activity = derivePaneActivity(pane({ activityRaw: option() }), {
    reliable: true,
    rows: [{ pid: 100, ppid: 1, comm: 'bash', cmdline: '-bash' }],
  });
  assert.equal(activity.agent, 'claude');
  assert.equal(activity.phase, 'attention');
  assert.equal(activity.reason, 'abnormal_exit');
});

test('attention persists after exit, while acknowledged idle does not leave a stale gray dot', () => {
  const processes = {
    reliable: true,
    rows: [{ pid: 100, ppid: 1, comm: 'bash', cmdline: '-bash' }],
  };
  assert.equal(derivePaneActivity(pane({
    activityRaw: option({ phase: 'attention', reason: 'completed' }),
  }), processes).reason, 'completed');
  assert.equal(derivePaneActivity(pane({
    activityRaw: option({ phase: 'idle', reason: 'acknowledged' }),
  }), processes), null);
});

test('a window with split panes surfaces attention ahead of working and idle', () => {
  const panes = [
    pane({ paneId: '%1', panePid: 100, activityRaw: option() }),
    pane({ paneId: '%2', panePid: 200, active: false, activityRaw: option({ phase: 'attention', reason: 'permission' }) }),
  ];
  const snapshot = buildActivitySnapshot(panes, {
    reliable: true,
    rows: [
      { pid: 100, ppid: 1, comm: 'bash', cmdline: '-bash' },
      { pid: 101, ppid: 100, comm: 'claude', cmdline: 'claude' },
      { pid: 200, ppid: 1, comm: 'bash', cmdline: '-bash' },
      { pid: 201, ppid: 200, comm: 'claude', cmdline: 'claude' },
    ],
  });
  const activity = snapshot.byWindow.get('4\0main');
  assert.equal(activity.phase, 'attention');
  assert.equal(activity.paneId, '%2');
});

test('only standalone terminal keys are semantic activity signals', () => {
  assert.equal(inputActivitySignal('\r'), 'enter');
  assert.equal(inputActivitySignal('\x03'), 'interrupt');
  assert.equal(inputActivitySignal('\x1b'), 'interrupt');
  for (const data of ['hello\r', 'pasted\ntext', '\x1b[A', '\x1b[15~']) {
    assert.equal(inputActivitySignal(data), null);
  }
});

test('input transitions resume prompts and acknowledge completed turns', () => {
  assert.deepEqual(transitionActivityForInput({
    agent: 'codex', phase: 'attention', reason: 'question',
  }, 'enter'), { agent: 'codex', phase: 'working', reason: 'resumed' });
  assert.deepEqual(transitionActivityForInput({
    agent: 'claude', phase: 'attention', reason: 'completed',
  }, 'enter'), { agent: 'claude', phase: 'idle', reason: 'acknowledged' });
  assert.deepEqual(transitionActivityForInput({
    agent: 'codex', phase: 'attention', reason: 'abnormal_exit',
  }, 'enter'), { agent: 'codex', phase: 'idle', reason: 'acknowledged' });
  assert.deepEqual(transitionActivityForInput({
    agent: 'claude', phase: 'working', reason: 'prompt_submitted',
  }, 'interrupt'), { agent: 'claude', phase: 'attention', reason: 'interrupted' });
  assert.deepEqual(transitionActivityForInput({
    agent: 'codex', phase: 'attention', reason: 'permission',
  }, 'interrupt'), { agent: 'codex', phase: 'attention', reason: 'interrupted' });
  for (const reason of ['completed', 'failed', 'abnormal_exit']) {
    assert.equal(transitionActivityForInput({
      agent: 'claude', phase: 'attention', reason,
    }, 'interrupt'), null);
  }
  assert.equal(transitionActivityForInput({
    agent: 'claude', phase: 'working', reason: 'prompt_submitted',
  }, 'enter'), null);
});

test('old attention is reconciled before Enter can trigger a new hook turn', async () => {
  const events = [];
  await forwardInputAfterActivity({
    groupId: 1,
    window: 'main',
    data: '\r',
    reconcile: async () => {
      await Promise.resolve();
      events.push('old-turn-ack');
    },
    write: async () => {
      events.push('pty-enter');
      events.push('new-turn-hook');
    },
  });
  assert.deepEqual(events, ['old-turn-ack', 'pty-enter', 'new-turn-hook']);
});

test('an old HTTP acknowledgement cannot replace a newer turn event', async () => {
  let live = option({ eventId: 'new-turn', phase: 'working', reason: 'prompt_submitted' });
  const changed = await writeActivityTransition({
    paneId: '%1',
    eventId: 'old-turn',
    agent: 'claude',
    phase: 'attention',
    reason: 'completed',
  }, {
    agent: 'claude',
    phase: 'idle',
    reason: 'acknowledged',
  }, async (_paneId, expectedEventId, next) => {
    if (parsePaneActivity(live)?.eventId !== expectedEventId) return false;
    live = next;
    return true;
  });
  assert.equal(changed, false);
  assert.equal(parsePaneActivity(live).eventId, 'new-turn');
  assert.equal(parsePaneActivity(live).phase, 'working');
});

test('ordinary input bypasses activity reconciliation', async () => {
  let reconciled = false;
  let written = '';
  await forwardInputAfterActivity({
    groupId: 1,
    window: 'main',
    data: 'pasted\ntext',
    reconcile: async () => { reconciled = true; },
    write: async (data) => { written = data; },
  });
  assert.equal(reconciled, false);
  assert.equal(written, 'pasted\ntext');
});

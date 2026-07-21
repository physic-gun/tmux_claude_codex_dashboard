import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ACTIVITY_OPTION,
  applyRuntimeActivity,
  findDashboardBaseSession,
  mapRuntimeActivity,
} from '../scripts/runtime-activity-hook.js';
import { parsePaneActivity } from '../src/activity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.resolve(__dirname, '../scripts/runtime-activity-hook.js');
const now = 1_721_234_567_890;

test('Claude lifecycle maps to idle, working, attention, and clear states', () => {
  assert.deepEqual(mapRuntimeActivity('claude', {
    hook_event_name: 'SessionStart', session_id: 'session-1',
  }, now), {
    action: 'set',
    value: {
      v: 1,
      agent: 'claude',
      phase: 'idle',
      reason: 'session_started',
      eventId: `session-1:${now}:${process.pid}`,
      updatedAt: now,
    },
  });
  assert.equal(mapRuntimeActivity('claude', {
    hook_event_name: 'SessionEnd', session_id: 'session-1',
  }, now).action, 'clear');
  assert.equal(mapRuntimeActivity('claude', {
    hook_event_name: 'UserPromptSubmit', prompt_id: 'prompt-1',
  }, now).value.phase, 'working');
  assert.equal(mapRuntimeActivity('claude', {
    hook_event_name: 'Stop', prompt_id: 'prompt-1',
  }, now).value.reason, 'completed');
});

test('Claude question, permission, interruption, and API failure details are bounded', () => {
  const question = mapRuntimeActivity('claude', {
    hook_event_name: 'PreToolUse',
    prompt_id: 'prompt-2',
    tool_name: 'AskUserQuestion',
    tool_input: { secret: 'must not be copied' },
  }, now).value;
  assert.equal(question.phase, 'attention');
  assert.equal(question.reason, 'question');
  assert.equal(question.detail, 'question');
  assert.equal(JSON.stringify(question).includes('secret'), false);

  const permission = mapRuntimeActivity('claude', {
    hook_event_name: 'PermissionRequest', prompt_id: 'prompt-2', tool_name: 'Bash',
  }, now).value;
  assert.equal(permission.detail, 'permission');

  const idleNotification = mapRuntimeActivity('claude', {
    hook_event_name: 'Notification',
    prompt_id: 'prompt-2',
    notification_type: 'idle_prompt',
    message: 'sensitive notification body',
  }, now).value;
  assert.equal(idleNotification.reason, 'question');
  assert.equal(idleNotification.detail, 'idle_prompt');
  assert.equal(JSON.stringify(idleNotification).includes('sensitive'), false);

  const permissionNotification = mapRuntimeActivity('claude', {
    hook_event_name: 'Notification',
    prompt_id: 'prompt-2',
    notification_type: 'permission_prompt',
  }, now).value;
  assert.equal(permissionNotification.reason, 'permission');
  assert.equal(permissionNotification.detail, 'permission');

  const interrupted = mapRuntimeActivity('claude', {
    hook_event_name: 'PostToolUseFailure',
    prompt_id: 'prompt-2',
    tool_name: 'AskUserQuestion',
    is_interrupt: true,
    error: 'sensitive error body',
  }, now).value;
  assert.equal(interrupted.reason, 'interrupted');
  assert.equal(interrupted.detail, 'question');
  assert.equal(JSON.stringify(interrupted).includes('sensitive'), false);

  const questionFailure = mapRuntimeActivity('claude', {
    hook_event_name: 'PostToolUseFailure',
    prompt_id: 'prompt-2',
    tool_name: 'AskUserQuestion',
    is_interrupt: false,
  }, now).value;
  assert.equal(questionFailure.phase, 'attention');
  assert.equal(questionFailure.reason, 'failed');
  assert.equal(questionFailure.detail, 'question');

  const failure = mapRuntimeActivity('claude', {
    hook_event_name: 'StopFailure', prompt_id: 'prompt-2', error: 'rate_limit',
    error_details: 'sensitive response',
  }, now).value;
  assert.equal(failure.detail, 'rate_limit');
  assert.equal(JSON.stringify(failure).includes('sensitive'), false);

  const unknown = mapRuntimeActivity('claude', {
    hook_event_name: 'StopFailure', prompt_id: 'prompt-2', error: 'future_error_with_text',
  }, now).value;
  assert.equal(unknown.detail, 'unknown');
});

test('Codex uses the exact request_user_input canonical tool name', () => {
  const waiting = mapRuntimeActivity('codex', {
    hook_event_name: 'PreToolUse',
    turn_id: 'turn-1',
    tool_name: 'request_user_input',
  }, now);
  assert.equal(waiting.value.reason, 'question');
  assert.equal(waiting.value.eventId, 'turn-1');
  assert.equal(mapRuntimeActivity('codex', {
    hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'AskUserQuestion',
  }, now), null);
  assert.equal(mapRuntimeActivity('codex', {
    hook_event_name: 'StopFailure', turn_id: 'turn-1', error: 'server_error',
  }, now), null);
});

test('event ids use the backend CAS whitelist and fail closed to a local fallback', () => {
  const invalid = mapRuntimeActivity('claude', {
    hook_event_name: 'Stop',
    prompt_id: 'prompt id with spaces',
    tool_use_id: 'tool/id',
    session_id: 'session id',
  }, now).value;
  assert.equal(invalid.eventId, `claude:${now}:${process.pid}`);

  const valid = mapRuntimeActivity('codex', {
    hook_event_name: 'Stop',
    turn_id: '0190abcd-1234:turn_1.2',
  }, now).value;
  assert.equal(valid.eventId, '0190abcd-1234:turn_1.2');
});

test('every emitted activity payload is accepted by the server option parser', () => {
  const cases = [
    ['claude', { hook_event_name: 'SessionStart', session_id: 'session-1' }],
    ['claude', { hook_event_name: 'UserPromptSubmit', prompt_id: 'prompt-1' }],
    ['claude', { hook_event_name: 'PreToolUse', prompt_id: 'prompt-1', tool_name: 'AskUserQuestion' }],
    ['claude', { hook_event_name: 'PostToolUse', prompt_id: 'prompt-1', tool_name: 'AskUserQuestion' }],
    ['claude', { hook_event_name: 'PermissionRequest', prompt_id: 'prompt-1' }],
    ['claude', { hook_event_name: 'Notification', prompt_id: 'prompt-1', notification_type: 'agent_needs_input' }],
    ['claude', { hook_event_name: 'Stop', prompt_id: 'prompt-1' }],
    ['claude', { hook_event_name: 'StopFailure', prompt_id: 'prompt-1', error: 'server_error' }],
    ['codex', { hook_event_name: 'SessionStart', session_id: 'session-2' }],
    ['codex', { hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2' }],
    ['codex', { hook_event_name: 'PreToolUse', turn_id: 'turn-2', tool_name: 'request_user_input' }],
    ['codex', { hook_event_name: 'PostToolUse', turn_id: 'turn-2', tool_name: 'request_user_input' }],
    ['codex', { hook_event_name: 'PermissionRequest', turn_id: 'turn-2' }],
    ['codex', { hook_event_name: 'Stop', turn_id: 'turn-2' }],
  ];
  for (const [agent, input] of cases) {
    const mapped = mapRuntimeActivity(agent, input, now);
    assert.ok(mapped?.value, `${agent} ${input.hook_event_name} should emit a value`);
    assert.ok(parsePaneActivity(JSON.stringify(mapped.value)));
  }
});

test('base-session guard accepts only the exact grp_N session for the pane', () => {
  const panes = [
    'viewer_alice\t%7',
    'grp_12-copy\t%7',
    'grp_12\t%7',
    'grp_x\t%8',
  ].join('\n');
  assert.equal(findDashboardBaseSession(panes, '%7'), 'grp_12');
  assert.equal(findDashboardBaseSession('viewer_alice\t%7\n', '%7'), '');
  assert.equal(findDashboardBaseSession('grp_12\t%8\n', '%7'), '');
  assert.equal(findDashboardBaseSession('grp_12\tbad\n', 'bad'), '');
});

test('runtime hook writes one pane option through inherited tmux and never targets viewers', () => {
  const calls = [];
  const env = { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7' };
  const runTmux = (args, receivedEnv) => {
    calls.push(args);
    assert.equal(receivedEnv, env);
    if (args[0] === 'list-panes') return 'viewer_alice\t%7\ngrp_12\t%7\n';
    return '';
  };
  assert.equal(applyRuntimeActivity({
    agent: 'codex',
    input: { hook_event_name: 'Stop', turn_id: 'turn-9' },
    env,
    now,
    runTmux,
  }), true);
  assert.deepEqual(calls[1].slice(0, 6), [
    'set-option', '-p', '-q', '-t', '%7', ACTIVITY_OPTION,
  ]);
  assert.deepEqual(JSON.parse(calls[1][6]), {
    v: 1,
    agent: 'codex',
    phase: 'attention',
    reason: 'completed',
    eventId: 'turn-9',
    updatedAt: now,
  });
});

test('Claude SessionEnd unsets the pane option after the same base-session guard', () => {
  const calls = [];
  const env = { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%4' };
  const runTmux = (args) => {
    calls.push(args);
    return args[0] === 'list-panes' ? 'grp_3\t%4\n' : '';
  };
  assert.equal(applyRuntimeActivity({
    agent: 'claude',
    input: { hook_event_name: 'SessionEnd', session_id: 'session-end' },
    env,
    now,
    runTmux,
  }), true);
  assert.deepEqual(calls[1], [
    'set-option', '-p', '-q', '-u', '-t', '%4', ACTIVITY_OPTION,
  ]);
});

test('runtime hook is fail-open without tmux or when tmux fails', () => {
  let called = false;
  assert.equal(applyRuntimeActivity({
    agent: 'claude',
    input: { hook_event_name: 'Stop', prompt_id: 'prompt-3' },
    env: {},
    runTmux: () => { called = true; },
  }), false);
  assert.equal(called, false);
  assert.equal(applyRuntimeActivity({
    agent: 'claude',
    input: { hook_event_name: 'Stop', prompt_id: 'prompt-3' },
    env: { TMUX: 'socket', TMUX_PANE: '%1' },
    runTmux: () => { throw new Error('tmux unavailable'); },
  }), false);
});

test('hook CLI produces no stdout and exits successfully on valid or invalid input', () => {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  for (const input of [
    '{invalid',
    JSON.stringify({ hook_event_name: 'Stop', prompt_id: 'prompt-4' }),
  ]) {
    const result = spawnSync(process.execPath, [hookPath, '--agent', 'claude'], {
      env,
      input,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityKey,
  getGroupIndicatorKinds,
  getTabClickAck,
  getWindowIndicatorKinds,
} from '../src/lib/activity.js';

const activity = (overrides = {}) => ({
  groupId: 3,
  window: 'main',
  todo: false,
  manualWorking: false,
  agent: 'claude',
  phase: 'idle',
  reason: 'session_started',
  detail: null,
  updatedAt: null,
  ...overrides,
});

test('window dots keep todo and runtime state independent', () => {
  assert.deepEqual(getWindowIndicatorKinds(activity({ todo: true, phase: 'working' })), ['todo', 'working']);
  assert.deepEqual(getWindowIndicatorKinds(activity({ todo: true, phase: 'attention' })), ['todo', 'attention']);
  assert.deepEqual(getWindowIndicatorKinds(activity({ agent: null, phase: null })), []);
  assert.deepEqual(getWindowIndicatorKinds(activity({
    todo: true, manualWorking: true, agent: null, phase: null,
  })), ['todo', 'working']);
  assert.deepEqual(getWindowIndicatorKinds(activity({
    manualWorking: true, phase: 'attention',
  })), ['working']);
});

test('tab clicks clear todo while preserving a running turn', () => {
  assert.deepEqual(getTabClickAck(activity({ todo: true, phase: 'working' })), {
    clearTodo: true,
    clearAttention: false,
  });
  assert.deepEqual(getTabClickAck(activity({ todo: true, phase: 'idle' })), {
    clearTodo: true,
    clearAttention: false,
  });
});

test('tab clicks clear coexisting todo and attention together', () => {
  assert.deepEqual(getTabClickAck(activity({ todo: true, phase: 'attention' })), {
    clearTodo: true,
    clearAttention: true,
  });
});

test('attention without todo is not acknowledged by selecting the tab', () => {
  assert.equal(getTabClickAck(activity({ phase: 'attention' })), null);
  assert.equal(getTabClickAck(activity({ phase: 'working' })), null);
});

test('tab clicks never clear a manual working override', () => {
  assert.deepEqual(getTabClickAck(activity({
    todo: true,
    manualWorking: true,
    phase: 'attention',
  })), {
    clearTodo: true,
    clearAttention: false,
  });
});

test('group dots aggregate each actionable color and suppress idle gray', () => {
  assert.deepEqual(getGroupIndicatorKinds([
    activity({ todo: true, phase: 'idle' }),
    activity({ window: 'manual', manualWorking: true, agent: null, phase: null }),
    activity({ window: 'worker', phase: 'working' }),
    activity({ window: 'done', agent: 'codex', phase: 'attention' }),
  ]), ['todo', 'working', 'attention']);
});

test('group shows gray only when recognized agents are otherwise idle', () => {
  assert.deepEqual(getGroupIndicatorKinds([activity()]), ['idle']);
  assert.deepEqual(getGroupIndicatorKinds([activity({ todo: true })]), ['todo']);
  assert.deepEqual(getGroupIndicatorKinds([activity({ agent: null, phase: null })]), []);
});

test('activity keys separate same-named windows across groups', () => {
  assert.equal(activityKey(3, 'main'), '3:main');
  assert.notEqual(activityKey(3, 'main'), activityKey(4, 'main'));
});

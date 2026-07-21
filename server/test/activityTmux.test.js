import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActivityPaneList } from '../src/tmux.js';

test('all-pane parser admits exact base sessions and excludes grouped viewers', () => {
  const raw = [
    'grp_7\t@1\tmain\t%1\t123\t1\tclaude\t{"v":1}\tClaude title',
    'grp_7_v_deadbeef\t@1\tmain\t%1\t123\t1\tclaude\t{"v":1}\tClaude title',
    'grp_bad\t@2\tmain\t%2\t124\t1\tbash\t\thost',
    'personal\t@3\tmain\t%3\t125\t1\tcodex\t\tCodex',
  ].join('\n');
  assert.deepEqual(parseActivityPaneList(raw), [{
    groupId: 7,
    session: 'grp_7',
    windowId: '@1',
    window: 'main',
    paneId: '%1',
    panePid: 123,
    active: true,
    command: 'claude',
    activityRaw: '{"v":1}',
    title: 'Claude title',
  }]);
});

test('physical pane ids are de-duplicated and titles may contain tabs', () => {
  const raw = [
    'grp_1\t@1\ta\t%9\t123\t0\tbash\t\tfirst\ttitle',
    'grp_2\t@1\tb\t%9\t123\t1\tbash\t\tduplicate',
  ].join('\n');
  const panes = parseActivityPaneList(raw);
  assert.equal(panes.length, 1);
  assert.equal(panes[0].title, 'first\ttitle');
});

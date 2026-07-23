import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  findOwnedActivityWindow,
  isManualWorking,
  listActivityWindowsForUser,
  setOwnedWindowManualWorking,
  setOwnedWindowTodo,
} from '../src/activityStore.js';

function fixture() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE groups (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE windows (
      id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, name TEXT NOT NULL,
      todo INTEGER NOT NULL DEFAULT 0, manual_working_at INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO groups VALUES (1, 10, 'mine', 0, '2025-01-01');
    INSERT INTO groups VALUES (2, 20, 'theirs', 0, '2025-01-01');
    INSERT INTO windows VALUES (1, 1, 'main', 0, NULL, 0);
    INSERT INTO windows VALUES (2, 1, 'background', 1, NULL, 1);
    INSERT INTO windows VALUES (3, 2, 'secret', 1, NULL, 0);
  `);
  return database;
}

test('activity listing includes every owned window and excludes other users', () => {
  const database = fixture();
  assert.deepEqual(listActivityWindowsForUser(database, 10).map((row) => row.name), ['main', 'background']);
  database.close();
});

test('todo updates are owner-scoped and persist as SQLite state', () => {
  const database = fixture();
  assert.equal(setOwnedWindowTodo(database, 10, 1, 'main', true).todo, 1);
  assert.equal(findOwnedActivityWindow(database, 10, 1, 'main').todo, 1);
  assert.equal(setOwnedWindowTodo(database, 10, 2, 'secret', false), null);
  assert.equal(findOwnedActivityWindow(database, 20, 2, 'secret').todo, 1);
  database.close();
});

test('manual working timestamps are owner-scoped and yield to newer runtime events', () => {
  const database = fixture();
  const marked = setOwnedWindowManualWorking(database, 10, 1, 'main', true, 2_000);
  assert.equal(marked.manual_working_at, 2_000);
  assert.equal(isManualWorking(marked.manual_working_at, new Date(1_000).toISOString()), true);
  assert.equal(isManualWorking(marked.manual_working_at, new Date(3_000).toISOString()), false);
  assert.equal(isManualWorking(marked.manual_working_at, null), true);
  assert.equal(setOwnedWindowManualWorking(database, 10, 2, 'secret', true, 4_000), null);
  assert.equal(setOwnedWindowManualWorking(database, 10, 1, 'main', false).manual_working_at, null);
  database.close();
});

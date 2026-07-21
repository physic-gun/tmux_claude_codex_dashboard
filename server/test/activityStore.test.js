import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  findOwnedActivityWindow,
  listActivityWindowsForUser,
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
      todo INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO groups VALUES (1, 10, 'mine', 0, '2025-01-01');
    INSERT INTO groups VALUES (2, 20, 'theirs', 0, '2025-01-01');
    INSERT INTO windows VALUES (1, 1, 'main', 0, 0);
    INSERT INTO windows VALUES (2, 1, 'background', 1, 1);
    INSERT INTO windows VALUES (3, 2, 'secret', 1, 0);
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

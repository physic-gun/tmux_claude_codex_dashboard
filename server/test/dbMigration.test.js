import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('database bootstrap adds windows.todo with a zero default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxdash-db-'));
  const dbPath = path.join(dir, 'dashboard.db');
  try {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/db.js'"], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        DB_PATH: dbPath,
        ADMIN_USERNAME: 'migration-test',
        ADMIN_PASSWORD: 'migration-test-password',
      },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const database = new Database(dbPath, { readonly: true });
    const todo = database.prepare('PRAGMA table_info(windows)').all().find((column) => column.name === 'todo');
    assert.ok(todo);
    assert.equal(todo.notnull, 1);
    assert.equal(String(todo.dflt_value), '0');
    database.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

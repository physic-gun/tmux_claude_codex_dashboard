import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('database bootstrap adds activity and terminal preference columns with compatible defaults', () => {
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
    const manualWorking = database.prepare('PRAGMA table_info(windows)').all()
      .find((column) => column.name === 'manual_working_at');
    assert.ok(todo);
    assert.equal(todo.notnull, 1);
    assert.equal(String(todo.dflt_value), '0');
    assert.ok(manualWorking);
    assert.equal(manualWorking.notnull, 0);
    const termTheme = database.prepare('PRAGMA table_info(users)').all()
      .find((column) => column.name === 'term_theme');
    assert.ok(termTheme);
    assert.equal(termTheme.notnull, 1);
    assert.equal(String(termTheme.dflt_value), "'tokyo-night'");
    database.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

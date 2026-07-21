import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, name),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS windows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL,
  name       TEXT NOT NULL,
  is_open    INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(group_id, name),
  FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  label      TEXT NOT NULL,
  command    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS git_repos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,                 -- denormalized owner; every query filters on it
  group_id   INTEGER NOT NULL,
  repo_path  TEXT NOT NULL,                     -- absolute, resolved, validated-inside-group-dir path
  rel_path   TEXT NOT NULL,                     -- path relative to the group dir, for display ('.' = group dir itself)
  created_at TEXT NOT NULL,
  UNIQUE(group_id, repo_path),
  FOREIGN KEY(user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE
);
`);

// Lightweight additive migrations (CREATE TABLE IF NOT EXISTS won't alter existing tables).
function ensureColumn(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
// Optional custom working directory for a group; NULL → default <root>/<user>/<name>.
ensureColumn('groups', 'path', 'path TEXT');
// User-defined group ordering in the sidebar (0 keeps the legacy created_at order until reordered).
ensureColumn('groups', 'sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0');
// Last-seen agent session name (Claude pane title or Codex thread title), persisted so the tab
// label and searchable name survive a tmux restart — and so closed/dead tabs can be restored.
ensureColumn('windows', 'title', 'title TEXT');
// The Claude session id (UUID) a window was last running, captured heuristically from the
// pane's cwd, so a tab can be matched back to its conversation after a crash.
ensureColumn('windows', 'session_id', 'session_id TEXT');
// Isolated-agent windows: the git worktree dir the window runs in, and the branch it checked
// out. NULL for ordinary windows (which run in the shared group dir). Set only by the
// /windows/worktree route — purely additive, existing rows stay NULL.
ensureColumn('windows', 'worktree_path', 'worktree_path TEXT');
ensureColumn('windows', 'branch', 'branch TEXT');
// Manual attention marker. Unlike transient agent activity (kept on the tmux pane), todo follows
// the persisted window across browser/device reconnects and while the tab is in the background.
ensureColumn('windows', 'todo', 'todo INTEGER NOT NULL DEFAULT 0');
// Per-user scroll-button step sizes (lines per click of the small / big scroll buttons).
ensureColumn('users', 'scroll_step_small', 'scroll_step_small INTEGER NOT NULL DEFAULT 20');
ensureColumn('users', 'scroll_step_big', 'scroll_step_big INTEGER NOT NULL DEFAULT 60');
// When 1, ignore the fixed steps above and derive them from the live terminal row count
// (small = ceil(rows * 0.25), big = rows - 10), so scrolling tracks the visible screen size.
ensureColumn('users', 'scroll_auto', 'scroll_auto INTEGER NOT NULL DEFAULT 0');
// Preferred terminal font family (a single font name; '' → the built-in monospace stack).
ensureColumn('users', 'term_font', "term_font TEXT NOT NULL DEFAULT ''");
// Resting opacity (percent, 5–100) of the floating restore buttons. Default 20%.
ensureColumn('users', 'float_opacity', 'float_opacity INTEGER NOT NULL DEFAULT 20');

// Seed the initial admin account on first boot.
const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get(config.adminUsername);
if (!existingAdmin) {
  // Never seed a known default password: when ADMIN_PASSWORD is unset, generate a
  // random one and print it once so there is no guessable admin credential.
  const generated = !config.adminPassword;
  const password = config.adminPassword || crypto.randomBytes(9).toString('base64url');
  db.prepare(
    'INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 1, ?)'
  ).run(config.adminUsername, bcrypt.hashSync(password, 10), new Date().toISOString());
  console.log(`[seed] created admin user "${config.adminUsername}"`);
  if (generated) {
    console.log('========================================================');
    console.log(`  Admin login -> user: ${config.adminUsername}  password: ${password}`);
    console.log('  (set ADMIN_PASSWORD to choose your own; change it after login)');
    console.log('========================================================');
  }
}

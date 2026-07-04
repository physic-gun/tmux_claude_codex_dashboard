// One-time backfill: turn each user's existing workspace subfolders into groups.
//
// For every user, scan <WORKSPACE_ROOT>/<username>/ and create a group named after each
// immediate subdirectory that isn't already a group (matched case-insensitively, since the
// mac filesystem is case-insensitive — "AgentA" and "agentA" are the same folder). It only
// ever ADDS groups: never removes a group, never touches any file on disk. Idempotent —
// safe to re-run. tmux sessions are NOT created here; they spin up lazily the first time a
// group is opened in the UI (the windows endpoint calls ensureSession).
//
// Run from the server/ dir so .env and ./data/dashboard.db resolve:
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/import-groups.js

import fs from 'fs';
import path from 'path';
import { db } from '../src/db.js';
import { config } from '../src/config.js';

// Same rule the create-group route enforces; folders that don't match are skipped.
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

if (!config.workspaceRoot) {
  console.error('WORKSPACE_ROOT is not set — nothing to scan. Aborting.');
  process.exit(1);
}
db.pragma('busy_timeout = 5000'); // tolerate the running server briefly holding the write lock
const root = path.resolve(config.workspaceRoot);

const users = db.prepare('SELECT id, username FROM users ORDER BY id').all();
const insert = db.prepare('INSERT INTO groups (user_id, name, created_at) VALUES (?, ?, ?)');

let totalCreated = 0;
for (const user of users) {
  const userDir = path.join(root, user.username);
  let entries;
  try {
    entries = fs.readdirSync(userDir, { withFileTypes: true });
  } catch {
    console.log(`- ${user.username}: no workspace folder (${userDir}) — skipped`);
    continue;
  }

  // immediate subdirectories, sorted for stable insertion order; skip dotfiles
  const subdirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  // existing group names (lowercased) so a folder differing only in case from an existing
  // group — i.e. the same dir on a case-insensitive FS — isn't imported as a duplicate
  const existing = new Set(
    db.prepare('SELECT name FROM groups WHERE user_id = ?').all(user.id).map((r) => r.name.toLowerCase())
  );

  const created = [];
  const skippedExist = [];
  const skippedInvalid = [];
  db.transaction(() => {
    for (const name of subdirs) {
      if (!NAME_RE.test(name)) { skippedInvalid.push(name); continue; }
      if (existing.has(name.toLowerCase())) { skippedExist.push(name); continue; }
      insert.run(user.id, name, new Date().toISOString());
      existing.add(name.toLowerCase());
      created.push(name);
    }
  })();

  totalCreated += created.length;
  const parts = [`created ${created.length}`];
  if (created.length) parts.push(`[${created.join(', ')}]`);
  if (skippedExist.length) parts.push(`already ${skippedExist.length} (${skippedExist.join(', ')})`);
  if (skippedInvalid.length) parts.push(`invalid-name ${skippedInvalid.length} (${skippedInvalid.join(', ')})`);
  console.log(`- ${user.username}: ${parts.join('  ·  ')}`);
}

console.log(`\nDone. Created ${totalCreated} group(s) total. tmux sessions are created lazily on first open.`);

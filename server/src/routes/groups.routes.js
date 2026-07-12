import os from 'os';
import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { config } from '../config.js';
import { ah } from '../asyncHandler.js';
import * as tmux from '../tmux.js';
import { sessionNameForGroup, groupSessionCwd } from '../ws.js';
import { ensureGroupDirFor, groupDirFilesFor, prepareCustomDir, worktreesRootFor } from '../workspace.js';
import { latestSessionId } from '../sessions.js';
import {
  findGitRepos, isGitRepo, repoStatus, repoFiles, fileDiff, gitCommit, gitPull, gitPush, gitFetch,
  ensureRepoInited, addWorktree, removeWorktree, refreshNestedRepoIgnore, branchExists,
} from '../git.js';

const router = Router();
router.use(authRequired);

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
// tmux reads a purely-numeric window target as a window INDEX, not a name — so a window named
// "2" can't be addressed by name (every select/kill/send hits index 2 instead). Forbid such
// names; existing ones are auto-healed on load (see the windows GET handler).
const isNumericName = (s) => /^\d+$/.test(s);
const nowIso = () => new Date().toISOString();

// Archive a window's pane scrollback to disk BEFORE a destructive kill. An interactive claude
// session does not write its own resumable transcript to ~/.claude until an internal checkpoint
// it usually never reaches, so when a tab/group is deleted the conversation would otherwise be
// lost. This best-effort text snapshot (the rendered pane history) is the safety net. Returns the
// written file path, or null when there's nothing meaningful to save / capture failed.
const ARCHIVE_DIR = path.join(path.dirname(path.resolve(config.dbPath)), 'session-archives');
async function archiveWindowPane(group, windowName, meta = {}) {
  let text = '';
  try {
    // Cap history (tmux history-limit is 10000) so a wide pane can't overflow run()'s maxBuffer
    // and silently return '' — which used to drop exactly the largest, most valuable conversations.
    text = await tmux.capturePane(sessionNameForGroup(group.id), windowName, 10000);
  } catch {
    return null;
  }
  // Skip empty / trivial panes (a bare shell prompt with no real conversation isn't worth a file).
  if (!text || text.replace(/\s+/g, '').length < 40) return null;
  try {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const stamp = nowIso().replace(/[:.]/g, '-');
    const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
    const file = path.join(ARCHIVE_DIR, `${safe(group.name)}__${safe(windowName)}__${stamp}.txt`);
    const header =
      `# tmux-dashboard session archive\n` +
      `# group: ${group.name} (id ${group.id})\n` +
      `# window: ${windowName}${meta.branch ? `  branch: ${meta.branch}` : ''}\n` +
      `${meta.sessionId ? `# claude session id (best-effort): ${meta.sessionId}\n` : ''}` +
      `# archived: ${nowIso()}\n` +
      `# NOTE: rendered pane text, not a resumable transcript.\n` +
      `${'='.repeat(72)}\n\n`;
    fs.writeFileSync(file, header + text.replace(/\s+$/, '') + '\n');
    return file;
  } catch {
    return null;
  }
}

// Expand a "kiaa[[1-5]]" / "kiaa[[n]]" pattern into concrete window names.
// "[[n]]" defaults to the range 1-5; "[[a-b]]" uses the given inclusive range.
function expandPattern(input) {
  const m = input.match(/\[\[(?:(\d+)-(\d+)|n)\]\]/);
  if (!m) return [input];
  let start = 1;
  let end = 5;
  if (m[1] !== undefined) {
    start = Number(m[1]);
    end = Number(m[2]);
  }
  if (end < start) [start, end] = [end, start];
  if (end - start + 1 > config.maxWindowExpansion) end = start + config.maxWindowExpansion - 1;
  const names = [];
  for (let i = start; i <= end; i++) names.push(input.replace(m[0], String(i)));
  return names;
}

// ---- groups ----

router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT id, name, path, created_at FROM groups WHERE user_id = ? ORDER BY sort_order, created_at, id')
    .all(req.user.id);
  res.json(rows);
});

// Persist the sidebar order: body { order: [groupId, ...] }. Only the caller's own groups move.
router.post('/reorder', (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order.map(Number).filter(Number.isInteger) : null;
  if (!order || !order.length) return res.status(400).json({ error: '缺少排序列表' });
  const owned = new Set(db.prepare('SELECT id FROM groups WHERE user_id = ?').all(req.user.id).map((r) => r.id));
  const upd = db.prepare('UPDATE groups SET sort_order = ? WHERE id = ? AND user_id = ?');
  db.transaction((ids) => {
    let i = 0;
    for (const id of ids) if (owned.has(id)) upd.run(i++, id, req.user.id);
  })(order);
  res.json({ ok: true });
});

router.post('/', ah(async (req, res) => {
  const name = (req.body?.name || '').trim();
  const rawPath = (req.body?.path || '').trim();
  if (!NAME_RE.test(name)) {
    return res.status(400).json({ error: '分组名只能含字母、数字、_-，且以字母/数字/下划线开头' });
  }
  if (db.prepare('SELECT id FROM groups WHERE user_id = ? AND name = ?').get(req.user.id, name)) {
    return res.status(409).json({ error: '分组已存在' });
  }
  // Optional custom working directory; NULL keeps the default <root>/<user>/<name>.
  let storedPath = null;
  let cwd;
  if (rawPath) {
    const r = prepareCustomDir(rawPath);
    if (r.error) return res.status(400).json({ error: r.error });
    storedPath = r.dir;
    cwd = r.dir;
  } else {
    cwd = ensureGroupDirFor({ name, path: null }, req.user.username);
  }
  const order =
    db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM groups WHERE user_id = ?').get(req.user.id).n;
  const info = db
    .prepare('INSERT INTO groups (user_id, name, path, created_at, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, name, storedPath, nowIso(), order);
  const id = Number(info.lastInsertRowid);
  // The default `main` tab is a PLAIN window in the group's working dir — auto-worktree creation
  // is disabled (it auto-converted the group dir into a git repo and caused bugs without helping
  // session persistence). The first `main` window is adopted into the DB on the first windows load.
  await tmux.ensureSession(sessionNameForGroup(id), cwd);
  res.json({ id, name, path: storedPath, created_at: nowIso() });
}));

function loadGroup(req, res, next) {
  const gid = Number(req.params.gid);
  const group = db.prepare('SELECT * FROM groups WHERE id = ? AND user_id = ?').get(gid, req.user.id);
  if (!group) return res.status(404).json({ error: '分组不存在' });
  req.group = group;
  next();
}

router.delete('/:gid', loadGroup, ah(async (req, res) => {
  // For a DEFAULT-path group (folder auto-created at <root>/<user>/<name>), refuse to delete
  // while that folder still has files — so we don't drop a group that holds real work.
  // Deleting a group never removes files on disk; this is only a safety net. A CUSTOM-path
  // group points at a directory the user chose explicitly (often a pre-existing project), so
  // deleting it is just un-linking and must NOT be blocked by that project having files.
  if (!req.group.path) {
    const files = groupDirFilesFor(req.group, req.user.username);
    if (files.length > 0) {
      return res.status(409).json({
        error: `分组目录「${req.group.name}」下还有 ${files.length} 个文件/文件夹，已拒绝删除。删除分组不会删除磁盘上的任何文件——如确需删除分组，请先清空或移走该目录内容。`,
      });
    }
  }
  const base = sessionNameForGroup(req.group.id);
  // Snapshot every window's conversation text before the session (and its claude processes) die.
  try {
    const live = await tmux.listWindows(base);
    const branchByName = new Map(
      db.prepare('SELECT name, branch, session_id FROM windows WHERE group_id = ?').all(req.group.id)
        .map((w) => [w.name, w])
    );
    for (const w of live) {
      const meta = branchByName.get(w.name) || {};
      await archiveWindowPane(req.group, w.name, { branch: meta.branch, sessionId: meta.session_id });
    }
  } catch { /* best-effort: a capture failure must never block group deletion */ }
  await tmux.killSession(base);
  // Reap any per-connection grouped viewer sessions (grp_<id>_v_*) so they don't
  // outlive the group and keep windows/processes alive with no UI to clean them up.
  await tmux.killSessionsByPrefix(`${base}_v_`);
  db.prepare('DELETE FROM groups WHERE id = ?').run(req.group.id);
  res.json({ ok: true });
}));

// ---- windows (tabs) ----

// A bare shell's pane title is just the hostname/cwd, so it's ignored — only a real program
// (e.g. claude) gives a meaningful, persistable title.
const SHELLS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', 'dash', 'fish', 'tcsh', 'ksh', 'login']);

// The shell's DEFAULT window title (the machine hostname, or `user@host[:cwd]`) leaks through
// even while a non-shell program runs: claude runs as `node`, so the SHELLS check above passes,
// but until you start a conversation claude hasn't set its own title and tmux still reports the
// shell's leftover hostname. That makes EVERY claude tab show the same hostname label — tabs
// become indistinguishable. Treat such hostname-shaped titles as not-meaningful so the tab falls
// back to its (unique) window name instead.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOST_FQDN = os.hostname().toLowerCase();
const HOST_SHORT = HOST_FQDN.split('.')[0];
const HOST_AT_RE = new RegExp(`@${esc(HOST_SHORT)}(\\b|[.:]|$)`); // user@host / user@host:cwd / cwd — user@host
function isShellDefaultTitle(title) {
  const t = String(title || '').trim().toLowerCase();
  if (!t) return true;
  if (t === HOST_FQDN || t === HOST_SHORT) return true;
  if (t.startsWith(`${HOST_SHORT}:`) || t.startsWith(`${HOST_FQDN}:`)) return true; // host:cwd
  return HOST_AT_RE.test(t);
}
const meaningfulTitle = (w) =>
  w.title && w.title !== w.name && !SHELLS.has(w.command) && !isShellDefaultTitle(w.title);

// List windows. Tabs are PERSISTED in the DB, not derived from tmux: an open tab missing
// from tmux (after a tmux restart/crash) is recreated rather than dropped, and each window's
// claude session title is stored so it survives and stays searchable. Only an explicit
// "kill window" removes a tab.
router.get('/:gid/windows', loadGroup, ah(async (req, res) => {
  const session = sessionNameForGroup(req.group.id);
  const cwd = ensureGroupDirFor(req.group, req.user.username);
  // Create the session in the main window's worktree (worktree-scheme groups) so a freshly
  // (re)created `main` lands there, not in the shared group dir; legacy groups use the group dir.
  await tmux.ensureSession(session, groupSessionCwd(req.group, req.user.username));

  let live = await tmux.listWindows(session);
  let liveNames = new Set(live.map((w) => w.name));
  let dbWindows = db
    .prepare('SELECT * FROM windows WHERE group_id = ? ORDER BY sort_order, id')
    .all(req.group.id);

  // Heal purely-numeric window names (created before they were forbidden): tmux reads such a
  // name as a window INDEX, so the tab can't be addressed by name and every op silently hits
  // the wrong window. Rename it to a safe non-numeric name — by window id, which is the only
  // way to target it unambiguously — and update the DB. Idempotent: a no-op once none remain.
  const numericRows = dbWindows.filter((w) => isNumericName(w.name));
  if (numericRows.length) {
    const taken = new Set(dbWindows.map((w) => w.name));
    for (const w of numericRows) {
      let safe = `w${w.name}`;
      for (let i = 2; taken.has(safe); i++) safe = `w${w.name}-${i}`;
      taken.add(safe);
      const liveW = live.find((l) => l.name === w.name);
      if (liveW) await tmux.renameWindowById(liveW.id, safe);
      db.prepare('UPDATE windows SET name = ? WHERE id = ?').run(safe, w.id);
    }
    live = await tmux.listWindows(session);
    liveNames = new Set(live.map((w) => w.name));
    dbWindows = db
      .prepare('SELECT * FROM windows WHERE group_id = ? ORDER BY sort_order, id')
      .all(req.group.id);
  }

  // Restore persisted tabs: any OPEN window missing from tmux (e.g. the tmux server was
  // restarted/killed) is recreated with the same name + cwd. It comes back as a fresh shell
  // — claude isn't auto-started — but the tab and its stored title survive, so the user can
  // `claude --resume` the matching session.
  let restored = false;
  for (const w of dbWindows) {
    if (w.is_open && !liveNames.has(w.name)) {
      // Recreate in the window's own worktree if it has one (and it still exists), else group dir.
      const wcwd = w.worktree_path && fs.existsSync(w.worktree_path) ? w.worktree_path : cwd;
      await tmux.newWindow(session, w.name, wcwd);
      restored = true;
    }
  }
  if (restored) {
    live = await tmux.listWindows(session);
    liveNames = new Set(live.map((w) => w.name));
  }

  // Adopt tmux windows we don't yet track (e.g. the initial "main" window).
  const dbNames = new Set(dbWindows.map((w) => w.name));
  for (const w of live) {
    if (!dbNames.has(w.name)) {
      db.prepare(
        'INSERT INTO windows (group_id, name, is_open, sort_order, created_at) VALUES (?, ?, 1, ?, ?)'
      ).run(req.group.id, w.name, w.index, nowIso());
    }
  }

  // Persist each running window's claude session title AND bind it to the claude session id
  // (the most-recently-written session file in the pane's cwd), so both survive a tmux
  // restart and the tab can be matched back to its conversation.
  for (const w of live) {
    if (meaningfulTitle(w)) {
      db.prepare('UPDATE windows SET title = ? WHERE group_id = ? AND name = ?')
        .run(w.title, req.group.id, w.name);
      const sid = w.cwd ? latestSessionId(w.cwd) : null;
      if (sid) {
        db.prepare('UPDATE windows SET session_id = ? WHERE group_id = ? AND name = ?')
          .run(sid, req.group.id, w.name);
      }
    }
  }

  const all = db
    .prepare('SELECT name, is_open, title, session_id, branch FROM windows WHERE group_id = ? ORDER BY sort_order, id')
    .all(req.group.id);
  // Tab labels: prefer the live claude title; fall back to the persisted one so a restored
  // (now-fresh-shell) tab still shows the claude session name it last ran.
  const liveTitle = {};
  for (const w of live) if (meaningfulTitle(w)) liveTitle[w.name] = w.title;
  const titles = {};
  const sessions = {};
  const branches = {};
  for (const w of all) {
    // Fall back to the persisted title, but never surface a shell-default (hostname) one —
    // older rows may have captured it before this was filtered out.
    const t = liveTitle[w.name] || w.title;
    if (t && t !== w.name && !isShellDefaultTitle(t)) titles[w.name] = t;
    if (w.session_id) sessions[w.name] = w.session_id;
    if (w.branch) branches[w.name] = w.branch; // isolated-agent windows only
  }

  res.json({
    open: all.filter((w) => w.is_open).map((w) => w.name),
    background: all.filter((w) => !w.is_open).map((w) => w.name),
    titles,
    sessions,
    branches,
  });
}));

// Persist tab order within a group: body { order: [windowName, ...] }. The open tabs named in
// `order` are packed to the front in that order; every window NOT named (untouched open tabs plus
// all background ones) keeps its current relative order after them. Mirrors /groups/reorder — the
// windows GET handler serves `open` sorted by (sort_order, id), so this is what the tab bar reads.
router.post('/:gid/windows/reorder', loadGroup, (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : null;
  if (!order || !order.length) return res.status(400).json({ error: '缺少排序列表' });
  const rows = db
    .prepare('SELECT id, name FROM windows WHERE group_id = ? ORDER BY sort_order, id')
    .all(req.group.id);
  const byName = new Map(rows.map((r) => [r.name, r]));
  const seen = new Set();
  const ordered = [];
  for (const name of order) {
    const row = byName.get(name);
    if (row && !seen.has(row.id)) { ordered.push(row); seen.add(row.id); }
  }
  for (const row of rows) if (!seen.has(row.id)) ordered.push(row); // untouched + background, in place
  const upd = db.prepare('UPDATE windows SET sort_order = ? WHERE id = ?');
  db.transaction((list) => { let i = 0; for (const row of list) upd.run(i++, row.id); })(ordered);
  res.json({ ok: true });
});

router.post('/:gid/windows', loadGroup, ah(async (req, res) => {
  const raw = (req.body?.name || '').trim();
  if (!raw) return res.status(400).json({ error: '窗口名不能为空' });
  const names = expandPattern(raw);
  for (const n of names) {
    if (!NAME_RE.test(n)) return res.status(400).json({ error: `窗口名非法: ${n}` });
    if (isNumericName(n)) {
      return res.status(400).json({ error: `窗口名不能是纯数字（会和 tmux 窗口序号冲突）: ${n}` });
    }
  }

  const session = sessionNameForGroup(req.group.id);
  const cwd = ensureGroupDirFor(req.group, req.user.username);
  await tmux.ensureSession(session, cwd);
  let order = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM windows WHERE group_id = ?')
    .get(req.group.id).n;

  const created = [];
  for (const n of names) {
    const existing = db
      .prepare('SELECT id, is_open FROM windows WHERE group_id = ? AND name = ?')
      .get(req.group.id, n);
    if (existing) {
      // Already exists: just make sure it's visible as a tab.
      if (!existing.is_open) db.prepare('UPDATE windows SET is_open = 1 WHERE id = ?').run(existing.id);
      continue;
    }
    await tmux.newWindow(session, n, cwd);
    order += 1;
    db.prepare(
      'INSERT INTO windows (group_id, name, is_open, sort_order, created_at) VALUES (?, ?, 1, ?, ?)'
    ).run(req.group.id, n, order, nowIso());
    created.push(n);
  }
  res.json({ created });
}));

// Open a new tab in this group and resume a Claude session inside it.
router.post('/:gid/windows/resume', loadGroup, ah(async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  // UUID-ish; the strict charset also keeps it safe to drop into the resume command.
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{5,}$/.test(sessionId)) {
    return res.status(400).json({ error: '无效的会话 id' });
  }
  const session = sessionNameForGroup(req.group.id);
  const cwd = ensureGroupDirFor(req.group, req.user.username);
  await tmux.ensureSession(session, cwd);

  // A unique window name derived from the short id (satisfies NAME_RE).
  let name = `cc-${sessionId.slice(0, 8)}`;
  for (let i = 2; db.prepare('SELECT id FROM windows WHERE group_id = ? AND name = ?').get(req.group.id, name); i++) {
    name = `cc-${sessionId.slice(0, 8)}-${i}`;
  }
  await tmux.newWindow(session, name, cwd);
  const order =
    db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM windows WHERE group_id = ?').get(req.group.id).n + 1;
  db.prepare(
    'INSERT INTO windows (group_id, name, is_open, sort_order, created_at, session_id) VALUES (?, ?, 1, ?, ?, ?)'
  ).run(req.group.id, name, order, nowIso(), sessionId);
  // send-keys buffers into the fresh shell's pane, so the resume runs once its prompt is up.
  await tmux.sendKeys(session, name, `claude --resume ${sessionId}`);
  res.json({ name });
}));

// Create one plain (shared-dir, non-worktree) window in `group`, deriving a unique, NAME_RE-safe
// name from `base` (a branch name or any string). Returns the created window name. Used as the
// worktree fallback for container-of-repos groups, which can't host an isolated worktree.
async function openPlainWindow(group, username, base) {
  const dir = ensureGroupDirFor(group, username);
  const session = sessionNameForGroup(group.id);
  await tmux.ensureSession(session, dir);
  let root = String(base || '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (!root || isNumericName(root)) root = 'agent'; // never empty / purely numeric (tmux index clash)
  let name = root;
  for (let i = 2; db.prepare('SELECT id FROM windows WHERE group_id = ? AND name = ?').get(group.id, name); i++) {
    name = `${root}-${i}`;
  }
  await tmux.newWindow(session, name, dir);
  const order =
    db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM windows WHERE group_id = ?').get(group.id).n + 1;
  db.prepare(
    'INSERT INTO windows (group_id, name, is_open, sort_order, created_at) VALUES (?, ?, 1, ?, ?)'
  ).run(group.id, name, order, nowIso());
  return name;
}

// Open an ISOLATED agent window: ensure the group dir is a git repo (auto `git init` + `main`
// on first use), add a worktree on a NEW branch, open a tmux window whose cwd is that worktree.
// Forward-only — never touches existing windows or the shared checkout. Optionally `--resume`s a
// claude session inside it; otherwise leaves a ready shell in the worktree.
router.post('/:gid/windows/worktree', loadGroup, ah(async (req, res) => {
  const branch = String(req.body?.branch || '').trim();
  const sessionId = String(req.body?.sessionId || '').trim(); // optional resume target
  // Allow git-legal branch names (slashes for namespacing) but nothing that could break a shell.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) || branch.includes('..')) {
    return res.status(400).json({ error: '无效的分支名（字母/数字/._/-，不能以特殊字符开头）' });
  }
  if (sessionId && !/^[A-Za-z0-9][A-Za-z0-9-]{5,}$/.test(sessionId)) {
    return res.status(400).json({ error: '无效的会话 id' });
  }
  const dir = ensureGroupDirFor(req.group, req.user.username);
  if (!dir) return res.status(400).json({ error: '分组目录不可用' });

  // NOTE: this worktree route is no longer invoked by the UI (the "+" button and new-group main
  // tab both create plain windows now). Kept for API compatibility; the guard below still matters
  // for any direct caller. A container-of-repos group (the group dir holds multiple SEPARATE git
  // repos but isn't itself one) can't host an isolated worktree: `git init`-ing it would embed
  // every sub-repo as a gitlink and — because findGitRepos stops at the first `.git` — hide them
  // all from discovery/SCM. Fall back to a plain shared-dir window so it never corrupts the container.
  if (!(await isGitRepo(dir))) {
    const nested = await findGitRepos(dir, { maxDepth: 3 });
    if (nested.some((r) => path.resolve(r) !== path.resolve(dir))) {
      const name = await openPlainWindow(req.group, req.user.username, branch);
      return res.json({ name, plain: true });
    }
  }

  const init = await ensureRepoInited(dir);
  if (!init.ok) return res.status(409).json({ error: `初始化 git 仓库失败：${init.output}` });

  // Window + worktree dir name derived from the branch (NAME_RE-safe, never purely numeric).
  const slug = branch.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'agent';
  let name = `wt-${slug}`;
  for (let i = 2; db.prepare('SELECT id FROM windows WHERE group_id = ? AND name = ?').get(req.group.id, name); i++) {
    name = `wt-${slug}-${i}`;
  }
  const wtPath = path.join(worktreesRootFor(req.group, req.user.username), name);

  // Branch off the live trunk (`main`) when it exists — the group dir's own HEAD is detached at
  // the init commit, so HEAD would be stale. Falls back to HEAD for an arbitrary existing repo.
  const startPoint = (await branchExists(dir, 'main')) ? 'main' : 'HEAD';
  const add = await addWorktree(dir, wtPath, branch, { startPoint });
  if (!add.ok) return res.status(409).json({ error: `创建 worktree 失败（分支可能已存在）：${add.output}` });

  const session = sessionNameForGroup(req.group.id);
  await tmux.ensureSession(session, groupSessionCwd(req.group, req.user.username));
  await tmux.newWindow(session, name, wtPath);
  const order =
    db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM windows WHERE group_id = ?').get(req.group.id).n + 1;
  db.prepare(
    'INSERT INTO windows (group_id, name, is_open, sort_order, created_at, session_id, worktree_path, branch) VALUES (?, ?, 1, ?, ?, ?, ?, ?)'
  ).run(req.group.id, name, order, nowIso(), sessionId || null, wtPath, branch);
  if (sessionId) await tmux.sendKeys(session, name, `claude --resume ${sessionId}`);
  res.json({ name, branch, worktree: wtPath });
}));

// Refresh the group dir's .gitignore so a future group-level `git init` won't embed nested git
// repos as gitlinks. Safe to run anytime; only rewrites a managed block. Returns excluded paths.
router.post('/:gid/git/ignore-nested', loadGroup, ah(async (req, res) => {
  const dir = ensureGroupDirFor(req.group, req.user.username);
  if (!dir) return res.status(400).json({ error: '分组目录不可用' });
  const r = await refreshNestedRepoIgnore(dir);
  if (!r.ok) return res.status(500).json({ error: r.output || '更新 .gitignore 失败' });
  res.json({ ok: true, excluded: r.excluded });
}));

router.post('/:gid/windows/:name/close', loadGroup, (req, res) => {
  db.prepare('UPDATE windows SET is_open = 0 WHERE group_id = ? AND name = ?').run(
    req.group.id,
    req.params.name
  );
  res.json({ ok: true });
});

router.post('/:gid/windows/:name/reopen', loadGroup, (req, res) => {
  db.prepare('UPDATE windows SET is_open = 1 WHERE group_id = ? AND name = ?').run(
    req.group.id,
    req.params.name
  );
  res.json({ ok: true });
});

router.delete('/:gid/windows/:name', loadGroup, ah(async (req, res) => {
  const session = sessionNameForGroup(req.group.id);
  const live = await tmux.listWindows(session);
  if (live.length <= 1) {
    return res.status(400).json({ error: '至少保留一个窗口，无法结束最后一个' });
  }
  // If this is an isolated-agent window, also clean up its git worktree. `force` only when the
  // caller explicitly confirms (?force=1): without it, git refuses to remove a worktree with
  // uncommitted changes, so unsaved work is preserved on disk (the DB row/tab is still removed).
  const row = db
    .prepare('SELECT worktree_path, branch, session_id FROM windows WHERE group_id = ? AND name = ?')
    .get(req.group.id, req.params.name);
  // Snapshot the conversation text before the kill destroys the (un-persisted) claude session.
  const archived = await archiveWindowPane(req.group, req.params.name, {
    branch: row?.branch,
    sessionId: row?.session_id,
  });
  await tmux.killWindow(session, req.params.name);
  db.prepare('DELETE FROM windows WHERE group_id = ? AND name = ?').run(req.group.id, req.params.name);
  let worktreeKept = false;
  if (row?.worktree_path) {
    const dir = ensureGroupDirFor(req.group, req.user.username);
    const force = req.query.force === '1';
    const rm = dir ? await removeWorktree(dir, row.worktree_path, { force }) : { ok: false };
    worktreeKept = !rm.ok; // dirty/uncommitted → left on disk so nothing is lost
  }
  res.json({ ok: true, worktreeKept, archived: archived || null });
}));

router.post('/:gid/windows/:name/rename', loadGroup, ah(async (req, res) => {
  const newName = (req.body?.newName || '').trim();
  if (!NAME_RE.test(newName)) return res.status(400).json({ error: '窗口名非法' });
  if (isNumericName(newName)) {
    return res.status(400).json({ error: '窗口名不能是纯数字（会和 tmux 窗口序号冲突）' });
  }
  if (db.prepare('SELECT id FROM windows WHERE group_id = ? AND name = ?').get(req.group.id, newName)) {
    return res.status(409).json({ error: '窗口名已存在' });
  }
  await tmux.renameWindow(sessionNameForGroup(req.group.id), req.params.name, newName);
  db.prepare('UPDATE windows SET name = ? WHERE group_id = ? AND name = ?').run(
    newName,
    req.group.id,
    req.params.name
  );
  res.json({ ok: true, name: newName });
}));

router.post('/:gid/windows/:name/send', loadGroup, ah(async (req, res) => {
  const command = req.body?.command ?? '';
  await tmux.sendKeys(sessionNameForGroup(req.group.id), req.params.name, command);
  res.json({ ok: true });
}));

// ---- git source-control (read-only) ----

// Resolve a stored/raw repo path to a real directory strictly inside the group's working dir.
// Re-run on EVERY request (defense in depth): a stored repo_path could now point outside the
// group dir, be a symlink escape, or be gone. realpath defeats symlink tricks; the
// `=== baseReal` half of the containment check guards the /a/proj vs /a/proj-evil prefix bug.
// Use realpathSync.NATIVE for both sides: the JS realpath preserves the requested case of the
// final component, so a group dir stored as `agentA` while the disk holds `AgentA` yields a
// lowercase baseReal but canonical-cased child paths — and the case-SENSITIVE prefix check then
// wrongly rejects every nested repo as out-of-bounds. The native realpath canonicalises both to
// the on-disk case, so containment holds on case-insensitive filesystems (and stays exact on Linux).
// Returns { ok, dir, baseReal } or { error, code }.
function resolveRepoInGroup(group, username, repoPath) {
  const base = ensureGroupDirFor(group, username);
  if (!base) return { error: 'group_dir', code: 400 };
  let baseReal;
  let real;
  try {
    baseReal = fs.realpathSync.native(base);
  } catch {
    return { error: 'group_dir', code: 400 };
  }
  const candidate = path.resolve(base, repoPath);
  try {
    real = fs.realpathSync.native(candidate);
  } catch {
    return { error: 'missing', code: 410 }; // deleted on disk
  }
  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) {
    return { error: 'out_of_bounds', code: 400 };
  }
  return { ok: true, dir: real, baseReal };
}

// Hand-rolled bounded-concurrency map (the codebase has no p-limit). At most `limit`
// invocations of `fn` run at once; results stay index-aligned with `items`.
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// A — discover git repos under the group dir, flagging which are already tracked.
router.get('/:gid/git/discover', loadGroup, ah(async (req, res) => {
  const base = ensureGroupDirFor(req.group, req.user.username);
  if (!base) return res.status(400).json({ error: '分组目录不可用' });
  let baseReal;
  try {
    baseReal = await fs.promises.realpath(base);
  } catch {
    return res.status(400).json({ error: '分组目录不可用' });
  }
  const tracked = new Set(
    db
      .prepare('SELECT repo_path FROM git_repos WHERE group_id = ? AND user_id = ?')
      .all(req.group.id, req.user.id)
      .map((r) => r.repo_path)
  );
  // Confirm each is a real working tree (filters a stray `.git` that isn't a gitlink), 8-way
  // parallel so a group dir with many repos doesn't pay N serial `git rev-parse` spawns.
  const found = await findGitRepos(baseReal);
  const checked = await mapLimit(found, 8, async (dir) => ((await isGitRepo(dir)) ? dir : null));
  const candidates = checked.filter(Boolean).map((dir) => ({
    path: dir,
    relPath: path.relative(baseReal, dir) || '.',
    name: path.basename(dir),
    tracked: tracked.has(dir),
  }));
  res.json({ groupDir: base, candidates });
}));

// B — list the group's tracked repos (config only, no disk access).
router.get('/:gid/git/repos', loadGroup, (req, res) => {
  const rows = db
    .prepare('SELECT id, repo_path, rel_path FROM git_repos WHERE group_id = ? AND user_id = ? ORDER BY id')
    .all(req.group.id, req.user.id);
  res.json(
    rows.map((r) => ({ id: r.id, repoPath: r.repo_path, relPath: r.rel_path, name: path.basename(r.repo_path) }))
  );
});

// C — track one or more repos. Each path is re-validated (containment + real working tree);
// out-of-bounds / non-repo / already-tracked entries are skipped, and only the newly inserted
// rows are returned.
router.post('/:gid/git/repos', loadGroup, ah(async (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : null;
  if (!paths || !paths.length) return res.status(400).json({ error: '缺少仓库路径' });
  const insert = db.prepare(
    'INSERT OR IGNORE INTO git_repos (user_id, group_id, repo_path, rel_path, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const added = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const r = resolveRepoInGroup(req.group, req.user.username, raw.trim());
    if (!r.ok) continue;
    if (!(await isGitRepo(r.dir))) continue;
    const relPath = path.relative(r.baseReal, r.dir) || '.';
    const info = insert.run(req.user.id, req.group.id, r.dir, relPath, nowIso());
    if (info.changes > 0) {
      added.push({ id: Number(info.lastInsertRowid), repoPath: r.dir, relPath, name: path.basename(r.dir) });
    }
  }
  res.status(201).json(added);
}));

// D — untrack a repo. Config-only: never touches disk, so it works even for a deleted repo.
router.delete('/:gid/git/repos/:repoId', loadGroup, (req, res) => {
  const repoId = Number(req.params.repoId);
  const info = db
    .prepare('DELETE FROM git_repos WHERE id = ? AND group_id = ? AND user_id = ?')
    .run(repoId, req.group.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: '仓库未跟踪' });
  res.json({ ok: true });
});

// E — live status badges for every tracked repo (the hot path). Runs 8-way parallel with a
// per-repo timeout; a per-repo failure is reported inline, never fatal for the response.
// `?fetch=1` (sent only by the manual ⟳ refresh, never the 8s poll) does a best-effort network
// fetch per repo first, so `behind` reflects the TRUE remote instead of stale local refs.
router.get('/:gid/git/status', loadGroup, ah(async (req, res) => {
  const doFetch = req.query.fetch === '1';
  const rows = db
    .prepare('SELECT id, repo_path, rel_path FROM git_repos WHERE group_id = ? AND user_id = ? ORDER BY id')
    .all(req.group.id, req.user.id);
  const repos = await mapLimit(rows, 8, async (row) => {
    const head = { id: row.id, relPath: row.rel_path, name: path.basename(row.repo_path) };
    const r = resolveRepoInGroup(req.group, req.user.username, row.repo_path);
    if (!r.ok) return { ...head, ok: false, error: r.error === 'missing' ? 'missing' : 'error' };
    if (doFetch) await gitFetch(r.dir).catch(() => {}); // best-effort; offline/auth failure → local refs
    const s = await repoStatus(r.dir);
    return { ...head, ...s };
  });
  res.json({ repos });
}));

// Load a tracked repo row and re-resolve it to a real in-bounds dir. Returns { dir } or sends
// the error response and returns null. Shared by the files + diff routes.
function loadTrackedRepoDir(req, res) {
  const row = db
    .prepare('SELECT repo_path FROM git_repos WHERE id = ? AND group_id = ? AND user_id = ?')
    .get(Number(req.params.repoId), req.group.id, req.user.id);
  if (!row) {
    res.status(404).json({ error: '仓库未跟踪' });
    return null;
  }
  const r = resolveRepoInGroup(req.group, req.user.username, row.repo_path);
  if (!r.ok) {
    if (r.error === 'missing') res.status(410).json({ error: 'missing' });
    else res.status(r.code || 400).json({ error: '仓库不可用' });
    return null;
  }
  return r.dir;
}

// Resolve a client-supplied `file` (repo-relative) to a repo-relative, forward-slash path that is
// provably INSIDE the repo dir. The real traversal vector: realpathSync defeats a committed
// symlink pointing at /etc; a deleted file (status 'D') has no symlink to follow, so its lexical
// containment (already checked) suffices. Returns the safe rel path or null.
function resolveFileInRepo(repoDir, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  const abs = path.resolve(repoDir, file);
  if (abs !== repoDir && !abs.startsWith(repoDir + path.sep)) return null; // lexical (.. ) guard
  let real;
  try {
    real = fs.realpathSync(abs); // symlink-safe when the file exists
  } catch {
    // Missing leaf (e.g. a deleted file 'D'): realpath the PARENT — which DOES exist — so an
    // intermediate committed symlink can't smuggle the path out of the repo, then re-attach the
    // leaf. (Lexical containment alone is NOT enough here: it never resolves a parent symlink.)
    let parentReal;
    try {
      parentReal = fs.realpathSync(path.dirname(abs));
    } catch {
      return null;
    }
    if (parentReal !== repoDir && !parentReal.startsWith(repoDir + path.sep)) return null;
    real = path.join(parentReal, path.basename(abs));
  }
  if (real !== repoDir && !real.startsWith(repoDir + path.sep)) return null;
  const rel = path.relative(repoDir, real);
  if (!rel || rel.startsWith('..')) return null;
  return rel.split(path.sep).join('/');
}

// F — changed-file list for one tracked repo.
router.get('/:gid/git/repos/:repoId/files', loadGroup, ah(async (req, res) => {
  const dir = loadTrackedRepoDir(req, res);
  if (!dir) return;
  const out = await repoFiles(dir);
  if (!out.ok) return res.status(500).json({ error: out.error });
  res.json({ branch: out.branch, detached: out.detached, files: out.files });
}));

// G — single-file diff (staged + unstaged sections).
router.get('/:gid/git/repos/:repoId/diff', loadGroup, ah(async (req, res) => {
  const dir = loadTrackedRepoDir(req, res);
  if (!dir) return;
  const rel = resolveFileInRepo(dir, req.query.file);
  if (!rel) return res.status(400).json({ error: '文件路径非法' });
  const diff = await fileDiff(dir, rel);
  if (diff.error) return res.status(500).json({ error: '读取差异失败' }); // never surface as a false "no diff"
  res.json({ ...diff, path: rel });
}));

// ---- git write actions (commit / push / pull) ----
// Each returns 200 with { ok, conflict?, output } even on git failure, so the client can show the
// raw git output in a copy-able popup; only auth/validation problems are non-200.

router.post('/:gid/git/repos/:repoId/commit', loadGroup, ah(async (req, res) => {
  const dir = loadTrackedRepoDir(req, res);
  if (!dir) return;
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: '提交信息不能为空' });
  res.json(await gitCommit(dir, message));
}));

router.post('/:gid/git/repos/:repoId/pull', loadGroup, ah(async (req, res) => {
  const dir = loadTrackedRepoDir(req, res);
  if (!dir) return;
  res.json(await gitPull(dir));
}));

router.post('/:gid/git/repos/:repoId/push', loadGroup, ah(async (req, res) => {
  const dir = loadTrackedRepoDir(req, res);
  if (!dir) return;
  res.json(await gitPush(dir));
}));

export default router;

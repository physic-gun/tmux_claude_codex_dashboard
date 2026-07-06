import { Router } from 'express';
import { authRequired } from '../auth.js';
import { ah } from '../asyncHandler.js';
import { db } from '../db.js';
import * as tmux from '../tmux.js';
import { sessionNameForGroup } from '../ws.js';
import {
  pathStat, completePath, resolveViewPath, readFileForView, ensureGroupDirFor,
} from '../workspace.js';

// Filesystem helpers for the custom-path group dialog and the clipboard file-preview split. Any
// logged-in user can stat/list/read host paths — acceptable here because every user already has a
// full shell in their windows.
const router = Router();
router.use(authRequired);

// Does this path exist, and is it a directory? Drives the validate button (确定/创建).
router.get('/validate', (req, res) => {
  res.json(pathStat(String(req.query.path || '')));
});

// CLI-style directory-name completion for the path input (Tab key).
router.get('/complete', (req, res) => {
  res.json(completePath(String(req.query.path || '')));
});

// Resolve claude's running directory for a group's window — the pane cwd — so a relative path
// from copied text can be anchored to it. Verifies the group belongs to the caller; falls back to
// the group's working dir when the live pane cwd can't be read. Returns null when unavailable.
async function paneCwd(user, gid, windowName) {
  if (!Number.isFinite(gid)) return null;
  const group = db.prepare('SELECT * FROM groups WHERE id = ? AND user_id = ?').get(gid, user.id);
  if (!group) return null;
  try {
    const wins = await tmux.listWindows(sessionNameForGroup(gid));
    const w = wins.find((x) => x.name === windowName);
    if (w?.cwd) return w.cwd;
  } catch { /* fall through to the group dir */ }
  return ensureGroupDirFor(group, user.username);
}

// Read a file named by copied text, for the clipboard file-preview split. `path` may be an
// absolute path or a path relative to claude's running dir (the pane cwd of gid/window). Read-only,
// size-capped and binary-guarded (see readFileForView). Non-existent / non-file paths return
// { exists:false } (200) so the client can quietly show nothing rather than treat it as an error.
router.get('/file', ah(async (req, res) => {
  const candidate = String(req.query.path || '');
  const gid = Number(req.query.gid);
  const windowName = String(req.query.window || 'main');
  const base = await paneCwd(req.user, gid, windowName);
  const resolved = resolveViewPath(candidate, base);
  if (!resolved) return res.json({ ok: true, exists: false });
  res.json({ ok: true, path: resolved, base: base || null, ...readFileForView(resolved) });
}));

export default router;

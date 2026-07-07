import express, { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { authRequired } from '../auth.js';
import { ah } from '../asyncHandler.js';
import { db } from '../db.js';
import * as tmux from '../tmux.js';
import { sessionNameForGroup } from '../ws.js';
import {
  pathStat, completePath, resolveViewPath, readFileForView, ensureGroupDirFor,
  listDir, makeDir, makeFile, renamePath, removePath, writeUpload, writePasteImage,
} from '../workspace.js';

// Filesystem helpers for the custom-path group dialog, the clipboard file-preview split, and the
// floating file explorer. Any logged-in user can stat/list/read AND mutate host paths — acceptable
// here because every user already has a full shell in their windows, so this grants no new reach.
// Mutations are still guarded in workspace.js (no root/$HOME delete, basename-only uploads, no
// clobbering renames) against accidents.
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

// The directory a relative path / a browse request is anchored to: the caller's pane cwd (so the
// explorer opens where claude is working) or, if that can't be read, the server user's home. gid /
// window arrive in the query (GET) or the JSON body (POST); upload passes them in the query.
async function baseFor(req) {
  const gid = Number(req.query.gid ?? req.body?.gid);
  const windowName = String(req.query.window ?? req.body?.window ?? 'main');
  return (await paneCwd(req.user, gid, windowName)) || os.homedir();
}

// Resolve a client-supplied path against the request's base dir. An empty path falls back to the
// base itself (so /list with no path opens the pane cwd). Returns null only when unresolvable.
function resolveArg(raw, base) {
  const s = String(raw || '');
  return s ? resolveViewPath(s, base) : base;
}

// Read a file named by copied text, for the clipboard file-preview split. `path` may be an
// absolute path or a path relative to claude's running dir (the pane cwd of gid/window). Read-only,
// size-capped and binary-guarded (see readFileForView). Non-existent / non-file paths return
// { exists:false } (200) so the client can quietly show nothing rather than treat it as an error.
router.get('/file', ah(async (req, res) => {
  const candidate = String(req.query.path || '');
  const base = await baseFor(req);
  const resolved = resolveViewPath(candidate, base);
  if (!resolved) return res.json({ ok: true, exists: false });
  res.json({ ok: true, path: resolved, base: base || null, ...readFileForView(resolved) });
}));

// List a directory for the explorer. `path` (optional) is absolute, ~-relative, or relative to the
// pane cwd; empty → the pane cwd itself. `hidden=1` includes dotfiles.
router.get('/list', ah(async (req, res) => {
  const base = await baseFor(req);
  const dir = resolveArg(req.query.path, base);
  if (!dir) return res.json({ ok: false, error: '无法解析路径' });
  const showHidden = req.query.hidden === '1' || req.query.hidden === 'true';
  res.json(listDir(dir, showHidden));
}));

// Stream a file to the browser as a download (Content-Disposition: attachment).
router.get('/download', ah(async (req, res) => {
  const base = await baseFor(req);
  const resolved = resolveArg(req.query.path, base);
  if (!resolved) return res.status(400).json({ error: '无法解析路径' });
  let st;
  try { st = fs.statSync(resolved); } catch { return res.status(404).json({ error: '文件不存在' }); }
  if (!st.isFile()) return res.status(400).json({ error: '只能下载文件' });
  // dotfiles:'allow' — without it send()'s legacy mode 404s any dot-prefixed basename (.env, .bashrc).
  res.download(resolved, path.basename(resolved), { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: '文件不存在' });
  });
}));

// Small JSON helper: 200 with the result on success, 400 with the error otherwise.
function reply(res, r) {
  res.status(r.error ? 400 : 200).json(r);
}

// Create a folder. Body: { path, gid, window }.
router.post('/mkdir', ah(async (req, res) => {
  const base = await baseFor(req);
  const resolved = resolveArg(req.body?.path, base);
  if (!resolved) return res.status(400).json({ error: '无法解析路径' });
  const r = makeDir(resolved);
  reply(res, r.error ? r : { ok: true, path: resolved });
}));

// Create an empty file. Body: { path, gid, window }.
router.post('/newfile', ah(async (req, res) => {
  const base = await baseFor(req);
  const resolved = resolveArg(req.body?.path, base);
  if (!resolved) return res.status(400).json({ error: '无法解析路径' });
  const r = makeFile(resolved);
  reply(res, r.error ? r : { ok: true, path: resolved });
}));

// Rename/move. Body: { from, to, gid, window }. `to` may be a bare name (resolved against the same
// base) or a full path; the server refuses to overwrite an existing destination.
router.post('/rename', ah(async (req, res) => {
  const base = await baseFor(req);
  const from = resolveArg(req.body?.from, base);
  const to = resolveArg(req.body?.to, base);
  if (!from || !to) return res.status(400).json({ error: '无法解析路径' });
  const r = renamePath(from, to);
  reply(res, r.error ? r : { ok: true, path: to });
}));

// Delete a file/folder. Body: { path, gid, window }. Guarded (no root/$HOME) in workspace.js.
router.post('/delete', ah(async (req, res) => {
  const base = await baseFor(req);
  const resolved = resolveArg(req.body?.path, base);
  if (!resolved) return res.status(400).json({ error: '无法解析路径' });
  const r = removePath(resolved);
  reply(res, r.error ? r : { ok: true, path: resolved });
}));

// Upload a file. The body IS the raw bytes (express.raw), so gid/window/dir/name/overwrite ride in
// the query. The client always sends Content-Type: application/octet-stream so the global JSON
// parser skips it and this raw parser owns the body.
router.post('/upload', express.raw({ type: () => true, limit: '64mb' }), ah(async (req, res) => {
  const base = await baseFor(req);
  const dir = resolveArg(req.query.dir, base) || base;
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const r = writeUpload(dir, String(req.query.name || ''), buf, req.query.overwrite === '1');
  reply(res, r);
}));

// Save a browser-pasted / dropped image to a server temp file; returns { ok, path } (absolute) so
// the client can inject the path into the pane for claude to auto-attach. Body is the raw bytes.
router.post('/paste-image', express.raw({ type: () => true, limit: '32mb' }), ah(async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  reply(res, writePasteImage(req.query.ext, buf));
}));

export default router;

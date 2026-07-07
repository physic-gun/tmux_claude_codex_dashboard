import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from './config.js';

// Expand a leading ~ (like a shell) so the custom-path input can use ~/foo.
function expandHome(p) {
  const s = (p || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

function longestCommonPrefix(arr) {
  if (!arr.length) return '';
  let pre = arr[0];
  for (const s of arr) {
    let i = 0;
    while (i < pre.length && i < s.length && pre[i] === s[i]) i++;
    pre = pre.slice(0, i);
    if (!pre) break;
  }
  return pre;
}

// Isolated-agent git worktrees live under this hidden dir inside the group's working dir, so
// they travel with the group (same WORKSPACE_ROOT volume) yet are kept out of repo-discovery
// and never shown as tabs. Also gitignored by the default template so a group-level `git init`
// won't try to track them.
export const WORKTREE_DIRNAME = '.agent-worktrees';

// Resolve a group's working directory (<WORKSPACE_ROOT>/<username>/<groupname>)
// WITHOUT creating it. Returns null when no root is configured or the path would
// escape the root (defense in depth — the seeded ADMIN_USERNAME is operator-supplied).
export function groupDirPath(username, groupName) {
  if (!config.workspaceRoot) return null;
  const root = path.resolve(config.workspaceRoot);
  const dir = path.resolve(root, username, groupName);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    console.error(`[workspace] refusing path outside WORKSPACE_ROOT: ${dir}`);
    return null;
  }
  return dir;
}

// Resolve a group's working directory from its DB record: a stored custom `path` wins,
// otherwise the default <root>/<username>/<name>. (Custom paths are validated on create.)
function dirForGroup(group, username) {
  return group.path ? path.resolve(group.path) : groupDirPath(username, group.name);
}

// Resolve + create a group's working directory from its record; null on failure.
export function ensureGroupDirFor(group, username) {
  const dir = dirForGroup(group, username);
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error(`[workspace] failed to create ${dir}: ${e?.message || e}`);
    return null;
  }
  return dir;
}

// The root holding a group's isolated-agent worktrees (created lazily by git worktree add).
export function worktreesRootFor(group, username) {
  const dir = ensureGroupDirFor(group, username);
  return dir ? path.join(dir, WORKTREE_DIRNAME) : null;
}

// Entries in a group's directory that count as "real work" (used to refuse deleting a non-empty
// group). Ignores OS cruft AND the dashboard's own git scaffolding (.git / .gitignore / the
// worktrees dir) — those are auto-created for the worktree scheme, so a group that contains only
// them is effectively empty and must stay deletable. Deleting a group never removes files; this
// is only a safety guard.
const SCAFFOLD = new Set(['.DS_Store', '.git', '.gitignore', WORKTREE_DIRNAME]);
export function groupDirFilesFor(group, username) {
  const dir = dirForGroup(group, username);
  if (!dir) return [];
  try {
    return fs.readdirSync(dir).filter((e) => !SCAFFOLD.has(e));
  } catch {
    return [];
  }
}

// Stat a path for the custom-path dialog: is it absolute, does it exist, is it a directory?
export function pathStat(p) {
  const e = expandHome(p);
  if (!e || !path.isAbsolute(e)) return { ok: false, error: '请输入绝对路径（以 / 或 ~ 开头）' };
  const resolved = path.resolve(e);
  try {
    const st = fs.statSync(resolved);
    return { ok: true, resolved, exists: true, isDir: st.isDirectory() };
  } catch {
    return { ok: true, resolved, exists: false, isDir: false };
  }
}

// Validate + create a custom group directory; returns { dir } or { error }.
export function prepareCustomDir(rawPath) {
  const e = expandHome(rawPath);
  if (!e || !path.isAbsolute(e)) return { error: '请输入绝对路径（以 / 或 ~ 开头）' };
  const dir = path.resolve(e);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { error: `无法创建/访问该路径：${err?.message || err}` };
  }
  try {
    if (!fs.statSync(dir).isDirectory()) return { error: '该路径已存在且不是文件夹' };
  } catch {
    return { error: '无法访问该路径' };
  }
  return { dir };
}

// ── Read-only file preview (clipboard file-preview split) ─────────────────────────────────────
// A copied path can be previewed in the clipboard panel. Cap what we ship to the browser so a
// huge or binary file can't blow up the response / the DOM.
const MAX_VIEW_BYTES = 2 * 1024 * 1024; // 2 MB

// Resolve a copied-path candidate for the viewer: expand a leading ~, keep an absolute path as-is,
// and anchor a relative path to `baseDir` (claude's pane cwd). Returns null when there's nothing
// usable (empty candidate, or relative path with no base to resolve against).
export function resolveViewPath(candidate, baseDir) {
  const e = expandHome(candidate);
  if (!e) return null;
  if (path.isAbsolute(e)) return path.resolve(e);
  if (!baseDir) return null;
  return path.resolve(baseDir, e);
}

// Read a file for the read-only viewer. Never throws — returns a descriptor the client renders:
//   { exists:false }                                   — nothing at that path
//   { exists:true, isFile:false, isDir }               — a directory (or other non-file)
//   { exists:true, isFile:true, binary:true, size }    — looks binary; content withheld
//   { exists:true, isFile:true, size, content, truncated } — text (capped at MAX_VIEW_BYTES)
export function readFileForView(resolved) {
  let st;
  try { st = fs.statSync(resolved); } catch { return { exists: false }; }
  if (!st.isFile()) return { exists: true, isFile: false, isDir: st.isDirectory() };
  const truncated = st.size > MAX_VIEW_BYTES;
  const len = Math.min(st.size, MAX_VIEW_BYTES);
  let buf;
  try {
    const fd = fs.openSync(resolved, 'r');
    try {
      buf = Buffer.alloc(len);
      if (len > 0) fs.readSync(fd, buf, 0, len, 0);
    } finally { fs.closeSync(fd); }
  } catch (e) {
    return { exists: true, isFile: true, error: String(e?.message || e) };
  }
  // Text sniff over the sampled head (memory stays bounded — buf is already capped at MAX_VIEW_BYTES).
  // Treat as binary — and withhold the bytes so they don't render as 乱码 — when we see a NUL byte, or
  // when >10% of the sample is non-text control bytes (anything outside tab/newline/CR and the
  // printable range). UTF-8 lead/continuation bytes are ≥0x80, so this keeps CJK/UTF-8 text as text.
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let ctrl = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) return { exists: true, isFile: true, binary: true, size: st.size };
    if (b < 9 || (b > 13 && b < 32) || b === 127) ctrl++; // control chars except \t \n \r
  }
  if (sample.length && ctrl / sample.length > 0.1) return { exists: true, isFile: true, binary: true, size: st.size };
  return { exists: true, isFile: true, size: st.size, content: buf.toString('utf8'), truncated };
}

// CLI-style directory-name completion for the custom-path input. Given a partial absolute
// path, list the child directories of its parent whose name matches the typed prefix, plus
// their longest common prefix (so Tab can extend the input). Only directories are offered.
export function completePath(p) {
  const raw = (p || '').trim();
  const e = expandHome(raw);
  if (!e || !path.isAbsolute(e)) return { matches: [], common: raw };
  // A trailing slash (in the raw input — checked before resolve strips it) means "list this
  // dir's contents"; otherwise complete the last segment within its parent. We check `raw`
  // so that "~/" (which expandHome turns into the slash-less home dir) still lists $HOME.
  const wantContents = raw.endsWith('/');
  let dir, prefix;
  if (wantContents) { dir = path.resolve(e); prefix = ''; }
  else { const r = path.resolve(e); dir = path.dirname(r); prefix = path.basename(r); }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { matches: [], common: raw };
  }
  // Offer directories, including symlinks that resolve to one (statSync follows the link),
  // to stay consistent with validate/create which also follow symlinks.
  const isDir = (d) => {
    if (d.isDirectory()) return true;
    if (d.isSymbolicLink()) {
      try { return fs.statSync(path.join(dir, d.name)).isDirectory(); } catch { return false; }
    }
    return false;
  };
  const names = entries
    .filter((d) => !d.name.startsWith('.') && d.name.startsWith(prefix) && isDir(d))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  const matches = names.map((n) => path.join(dir, n));
  const common = names.length ? path.join(dir, longestCommonPrefix(names)) : raw;
  return { matches, common };
}

// ── File explorer: directory listing + write operations ───────────────────────────────────────
// The explorer lets a logged-in user browse/manage host files from the panel. Same trust model as
// the read-only preview above: any authenticated user can already open a full shell in their
// windows, so file access here grants nothing new — but every mutation is still guarded (no root /
// $HOME deletion, uploaded names are basename-only, renames never clobber) against accidents.
const MAX_DIR_ENTRIES = 5000; // cap so a huge dir (e.g. node_modules) can't blow up the response / DOM

// List a directory's immediate children with light metadata for the explorer. Never throws —
// returns { ok:false, error } on failure. `stat` follows symlinks so a link to a dir acts as a
// dir; a dangling link is kept and flagged `broken`. Dotfiles are included only when showHidden.
// Entries are capped at MAX_DIR_ENTRIES with a `truncated` flag.
export function listDir(resolvedDir, showHidden = false) {
  let st;
  try { st = fs.statSync(resolvedDir); } catch { return { ok: false, error: '无法访问该目录' }; }
  if (!st.isDirectory()) return { ok: false, error: '该路径不是文件夹' };
  let dirents;
  try { dirents = fs.readdirSync(resolvedDir, { withFileTypes: true }); }
  catch (e) { return { ok: false, error: `无法读取目录：${e?.message || e}` }; }
  const all = showHidden ? dirents : dirents.filter((d) => !d.name.startsWith('.'));
  const truncated = all.length > MAX_DIR_ENTRIES;
  const slice = truncated ? all.slice(0, MAX_DIR_ENTRIES) : all;
  const entries = slice.map((d) => {
    const full = path.join(resolvedDir, d.name);
    const isSymlink = d.isSymbolicLink();
    let isDir = d.isDirectory();
    let isFile = d.isFile();
    let size = 0, mtimeMs = 0, broken = false;
    try {
      const s = fs.statSync(full); // follows the link, so a link → dir sorts/acts as a dir
      isDir = s.isDirectory(); isFile = s.isFile(); size = s.size; mtimeMs = s.mtimeMs;
    } catch {
      broken = isSymlink;                                   // dangling symlink: keep it, flagged
      try { mtimeMs = fs.lstatSync(full).mtimeMs; } catch { /* gone between readdir and lstat */ }
    }
    return { name: d.name, isDir, isFile, isSymlink, broken, size, mtimeMs };
  });
  const parent = path.dirname(resolvedDir);
  return { ok: true, path: resolvedDir, parent: parent === resolvedDir ? null : parent, truncated, entries };
}

// Create a directory (mkdir -p for the parent chain). Refuses when the leaf already exists —
// mkdir -p is idempotent, so without this an existing dir reports a misleading "created". { ok } | { error }.
export function makeDir(resolved) {
  if (fs.existsSync(resolved)) return { error: '同名文件/文件夹已存在' };
  try { fs.mkdirSync(resolved, { recursive: true }); return { ok: true }; }
  catch (e) { return { error: `无法创建文件夹：${e?.message || e}` }; }
}

// Create an empty file; refuses to clobber an existing path (flag 'wx'). Parent dirs are created.
export function makeFile(resolved) {
  try { fs.mkdirSync(path.dirname(resolved), { recursive: true }); } catch { /* report the write error below */ }
  try { fs.writeFileSync(resolved, '', { flag: 'wx' }); return { ok: true }; }
  catch (e) {
    if (e?.code === 'EEXIST') return { error: '同名文件已存在' };
    return { error: `无法创建文件：${e?.message || e}` };
  }
}

// Rename/move a path; refuses to overwrite an existing destination. { ok } | { error }.
export function renamePath(from, to) {
  if (fs.existsSync(to)) return { error: '目标已存在，未覆盖' };
  try { fs.renameSync(from, to); return { ok: true }; }
  catch (e) {
    if (e?.code === 'EXDEV') return { error: '跨设备移动暂不支持（请在终端用 mv）' };
    return { error: `重命名失败：${e?.message || e}` };
  }
}

// Delete a file/dir. Guards against the filesystem root and the user's home dir (accidental
// catastrophe); a symlink is unlinked itself (never followed). Dirs are removed recursively.
export function removePath(resolved) {
  const p = path.resolve(resolved);
  if (p === path.parse(p).root) return { error: '拒绝删除根目录' };
  if (p === os.homedir()) return { error: '拒绝删除用户主目录' };
  let ls;
  try { ls = fs.lstatSync(p); } catch { return { error: '路径不存在' }; }
  try {
    if (ls.isDirectory()) fs.rmSync(p, { recursive: true, force: true }); // real dir (not a symlink)
    else fs.unlinkSync(p);                                                // file or symlink → unlink the link
    return { ok: true };
  } catch (e) { return { error: `删除失败：${e?.message || e}` }; }
}

// Write uploaded bytes to <dir>/<basename(name)>. The basename strips any path components in the
// client-supplied name, so an upload can't escape the target dir. Refuses to overwrite unless
// `overwrite`. { ok, path } | { error, exists? }.
export function writeUpload(resolvedDir, name, buf, overwrite = false) {
  const safeName = path.basename(String(name || '')).trim();
  if (!safeName || safeName === '.' || safeName === '..') return { error: '文件名无效' };
  let dirStat;
  try { dirStat = fs.statSync(resolvedDir); } catch { return { error: '目标目录不存在' }; }
  if (!dirStat.isDirectory()) return { error: '目标不是文件夹' };
  const dest = path.join(resolvedDir, safeName);
  try {
    fs.writeFileSync(dest, buf, { flag: overwrite ? 'w' : 'wx' });
    return { ok: true, path: dest };
  } catch (e) {
    if (e?.code === 'EEXIST') return { error: '同名文件已存在（可选择覆盖）', exists: true };
    return { error: `写入失败：${e?.message || e}` };
  }
}

// ── Pasted / dropped image intake ──────────────────────────────────────────────────────────────
// claude reads images by file PATH (there's no OS clipboard on a headless server), so a browser-
// pasted image is written to a server temp file whose absolute path is injected into the pane;
// claude then auto-attaches the .png/.jpg/.gif/.webp it finds in the prompt. Files land in one temp
// dir and stale ones are pruned so it can't grow without bound. Only known raster types are accepted.
const PASTE_IMAGE_DIR = path.join(os.tmpdir(), 'tmux-dashboard-images');
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MAX_IMAGE_BYTES = 32 * 1024 * 1024; // matches claude's per-image ceiling

// Best-effort: drop paste images older than a day so the temp dir stays small.
function prunePasteImages() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let names;
  try { names = fs.readdirSync(PASTE_IMAGE_DIR); } catch { return; }
  for (const n of names) {
    if (!n.startsWith('paste-')) continue;
    const p = path.join(PASTE_IMAGE_DIR, n);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* raced away — ignore */ }
  }
}

// Write image bytes to a fresh temp file; returns { ok, path } (absolute) or { error }.
export function writePasteImage(ext, buf) {
  const e = IMAGE_EXTS.has(String(ext || '').toLowerCase()) ? String(ext).toLowerCase() : 'png';
  if (!buf || !buf.length) return { error: '空图片数据' };
  if (buf.length > MAX_IMAGE_BYTES) return { error: '图片过大（>32MB）' };
  try { fs.mkdirSync(PASTE_IMAGE_DIR, { recursive: true }); }
  catch (err) { return { error: `无法创建临时目录：${err?.message || err}` }; }
  prunePasteImages();
  const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${e}`;
  const dest = path.join(PASTE_IMAGE_DIR, name);
  try { fs.writeFileSync(dest, buf); return { ok: true, path: dest }; }
  catch (err) { return { error: `写入失败：${err?.message || err}` }; }
}

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
  // Binary sniff: a NUL byte in the sampled head ⇒ treat as binary (don't ship raw bytes).
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) return { exists: true, isFile: true, binary: true, size: st.size };
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

// Resolve a tmux pane to the root Codex CLI thread it is currently running. Codex does not put
// the thread title in pane_title by default; the authoritative name lives in its read-only
// state_N.sqlite `threads.title` row. The open rollout file descriptors provide the exact
// pane-to-thread binding, avoiding unsafe "latest session in this cwd" guesses.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Database from 'better-sqlite3';

const execFileP = promisify(execFile);
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const STATE_RE = /(?:^|\/)state_(\d+)\.sqlite$/;
const CANDIDATE_COMMANDS = new Set(['node', 'codex', 'codex-cli']);
const DARWIN_OPEN_PATH_TTL_MS = 15000;
const DARWIN_OPEN_PATH_FAILURE_TTL_MS = 1000;
const DARWIN_OPEN_PATH_CACHE_LIMIT = 128;
const darwinOpenPathCache = new Map();

const uniq = (xs) => [...new Set(xs)];

function procStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = raw.lastIndexOf(')');
    if (end < 0) return null;
    const fields = raw.slice(end + 2).trim().split(/\s+/);
    return {
      pgrp: Number(fields[2]),
      tpgid: Number(fields[5]),
      starttime: fields[19] || '',
    };
  } catch {
    return null;
  }
}

function procChildren(pid) {
  try {
    return fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isInteger);
  } catch {
    return [];
  }
}

function descendants(rootPid) {
  const out = [];
  const seen = new Set([rootPid]);
  const pending = [rootPid];
  while (pending.length) {
    const parent = pending.pop();
    for (const pid of procChildren(parent)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      out.push(pid);
      pending.push(pid);
    }
  }
  return out;
}

function procEnv(pid) {
  try {
    const entries = fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0');
    return new Map(entries.filter(Boolean).map((entry) => {
      const i = entry.indexOf('=');
      return i < 0 ? [entry, ''] : [entry.slice(0, i), entry.slice(i + 1)];
    }));
  } catch {
    return new Map();
  }
}

function procCommand(pid) {
  let exe = '';
  let cmdline = '';
  try { exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''); } catch {}
  try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch {}
  return { exe: path.basename(exe), cmdline };
}

function openPathsLinux(pid) {
  let fds;
  try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { return []; }
  const paths = [];
  for (const fd of fds) {
    try {
      const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).replace(/ \(deleted\)$/, '');
      if (path.isAbsolute(target)) paths.push(target);
    } catch {}
  }
  return uniq(paths);
}

function nativeCodexLinux(win) {
  const panePid = Number(win.panePid);
  if (!Number.isInteger(panePid) || panePid <= 0 || !win.paneId) return null;
  const pane = procStat(panePid);
  if (!pane || pane.tpgid <= 0) return null;
  for (const pid of descendants(panePid)) {
    const stat = procStat(pid);
    if (!stat || stat.pgrp !== pane.tpgid) continue;
    const command = procCommand(pid);
    if (command.exe !== 'codex' || command.cmdline.includes('codex-code-mode-host')) continue;
    const env = procEnv(pid);
    if (env.get('TMUX_PANE') !== win.paneId) continue;
    return { pid, starttime: stat.starttime, paths: openPathsLinux(pid) };
  }
  return null;
}

async function darwinProcessTable() {
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,command='], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const rows = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/);
      if (!m) continue;
      rows.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        pgrp: Number(m[3]),
        tpgid: Number(m[4]),
        command: m[5],
      });
    }
    return rows;
  } catch {
    return [];
  }
}

function pruneDarwinOpenPathCache(now) {
  for (const [key, entry] of darwinOpenPathCache) {
    if (!entry.pending && entry.expiresAt <= now) darwinOpenPathCache.delete(key);
  }
  while (darwinOpenPathCache.size > DARWIN_OPEN_PATH_CACHE_LIMIT) {
    darwinOpenPathCache.delete(darwinOpenPathCache.keys().next().value);
  }
}

async function openPathsDarwin(pid, fingerprint) {
  const now = Date.now();
  pruneDarwinOpenPathCache(now);
  const cached = darwinOpenPathCache.get(fingerprint);
  if (cached?.pending) return cached.pending;
  if (cached && cached.expiresAt > now) return cached.paths;

  const pending = (async () => {
    const { stdout } = await execFileP('lsof', ['-p', String(pid), '-Fn'], {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const paths = uniq(
      stdout
        .split('\n')
        .filter((line) => line.startsWith('n/'))
        .map((line) => line.slice(1))
    );
    return paths;
  })();
  darwinOpenPathCache.set(fingerprint, { expiresAt: now, paths: [], pending });
  try {
    const paths = await pending;
    darwinOpenPathCache.set(fingerprint, {
      expiresAt: Date.now() + DARWIN_OPEN_PATH_TTL_MS,
      paths,
      pending: null,
    });
    return paths;
  } catch {
    darwinOpenPathCache.set(fingerprint, {
      expiresAt: Date.now() + DARWIN_OPEN_PATH_FAILURE_TTL_MS,
      paths: [],
      pending: null,
    });
    return [];
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function nativeCodexDarwin(win, rows) {
  const panePid = Number(win.panePid);
  if (!Number.isInteger(panePid) || panePid <= 0) return null;
  const pane = rows.find((row) => row.pid === panePid);
  if (!pane || pane.tpgid <= 0) return null;
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const pending = [...(children.get(panePid) || [])];
  while (pending.length) {
    const row = pending.pop();
    pending.push(...(children.get(row.pid) || []));
    if (row.pgrp !== pane.tpgid) continue;
    const executable = row.command.trim().split(/\s+/, 1)[0];
    if (path.basename(executable) !== 'codex' || row.command.includes('codex-code-mode-host')) continue;
    const fingerprint = `${row.pid}:${row.ppid}:${row.pgrp}:${row.tpgid}:${row.command}`;
    return { pid: row.pid, starttime: '', paths: await openPathsDarwin(row.pid, fingerprint) };
  }
  return null;
}

function statePathsFor(openPaths, rolloutPaths) {
  const direct = openPaths.filter((p) => STATE_RE.test(p));
  if (direct.length) return uniq(direct).sort((a, b) => {
    const av = Number(a.match(STATE_RE)?.[1] || 0);
    const bv = Number(b.match(STATE_RE)?.[1] || 0);
    return bv - av;
  });
  const homes = uniq(rolloutPaths.map((p) => p.slice(0, p.lastIndexOf(`${path.sep}sessions${path.sep}`))).filter(Boolean));
  const found = [];
  for (const home of homes) {
    try {
      for (const name of fs.readdirSync(home)) {
        if (/^state_\d+\.sqlite$/.test(name)) found.push(path.join(home, name));
      }
    } catch {}
  }
  return uniq(found).sort((a, b) => {
    const av = Number(a.match(STATE_RE)?.[1] || 0);
    const bv = Number(b.match(STATE_RE)?.[1] || 0);
    return bv - av;
  });
}

function queryRootThread(statePath, ids) {
  let database;
  try {
    database = new Database(statePath, { readonly: true, fileMustExist: true, timeout: 1000 });
    const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map((row) => row.name));
    if (!columns.has('id') || !columns.has('title')) return null;
    const optional = ['first_user_message', 'preview', 'source', 'thread_source', 'updated_at_ms', 'updated_at'];
    const selected = ['id', 'title', ...optional.filter((name) => columns.has(name))];
    const placeholders = ids.map(() => '?').join(',');
    let rows = database
      .prepare(`SELECT ${selected.join(', ')} FROM threads WHERE id IN (${placeholders})`)
      .all(...ids);
    if (!rows.length) return null;

    if (columns.has('thread_source') || columns.has('source')) {
      const roots = rows.filter((row) => row.thread_source === 'user' || row.source === 'cli');
      if (roots.length) rows = roots;
      else return null;
    } else if (rows.length > 1) {
      return null;
    }

    rows.sort((a, b) => {
      const at = Number(a.updated_at_ms || 0) || Number(a.updated_at || 0) * 1000;
      const bt = Number(b.updated_at_ms || 0) || Number(b.updated_at || 0) * 1000;
      return bt - at;
    });
    const row = rows[0];
    const title = String(row.title || row.preview || row.first_user_message || '').trim();
    return { detected: true, id: row.id, title };
  } catch {
    return null;
  } finally {
    try { database?.close(); } catch {}
  }
}

function resolveFromOpenPaths(openPaths) {
  const rolloutPaths = openPaths.filter((p) => p.includes(`${path.sep}sessions${path.sep}`) && UUID_RE.test(p));
  const ids = uniq(rolloutPaths.map((p) => p.match(UUID_RE)?.[1]).filter(Boolean));
  if (!ids.length) return { detected: true, id: null, title: '' };
  for (const statePath of statePathsFor(openPaths, rolloutPaths)) {
    const thread = queryRootThread(statePath, ids);
    if (thread) return thread;
  }
  return { detected: true, id: null, title: '' };
}

// Map pane id -> { detected, id, title }. A detected Codex process with an unavailable title is
// still returned so callers do not persist Codex's default cwd/spinner pane_title by mistake.
export async function codexSessionsForWindows(windows) {
  const out = new Map();
  const candidates = windows.filter((win) => CANDIDATE_COMMANDS.has(String(win.command || '').toLowerCase()));
  if (!candidates.length) return out;

  if (process.platform === 'linux') {
    for (const win of candidates) {
      const native = nativeCodexLinux(win);
      if (native) out.set(win.paneId, resolveFromOpenPaths(native.paths));
    }
    return out;
  }

  if (process.platform === 'darwin') {
    const rows = await darwinProcessTable();
    const resolved = await mapWithConcurrency(candidates, 4, async (win) => {
      const native = await nativeCodexDarwin(win, rows);
      return native ? [win.paneId, resolveFromOpenPaths(native.paths)] : null;
    });
    for (const entry of resolved) {
      if (entry) out.set(...entry);
    }
  }
  return out;
}

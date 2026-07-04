// Read Claude Code's on-disk session history. Claude stores each session as
// ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl, where the cwd is encoded by
// replacing every non-alphanumeric char with '-'. We never write here — read only.
import fs from 'fs';
import os from 'os';
import path from 'path';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const dirFor = (cwd) => path.join(PROJECTS, String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-'));

// Strip Claude's injected wrapper tags (e.g. <local-command-caveat>, <command-name>) so a
// session opened via a slash command still gets a readable label.
function cleanText(content) {
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ')
        : '';
  return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// A short human label for a session: its summary, else the first real user message. Reads
// only the head of the file so large sessions stay cheap.
function sessionLabel(file) {
  let buf = Buffer.alloc(65536);
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    buf = buf.subarray(0, n);
  } catch {
    return '';
  } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch {} }
  }
  let fallback = '';
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; } // last line may be truncated
    if (obj.type === 'summary' && obj.summary) return String(obj.summary).slice(0, 100);
    const m = obj.message || obj;
    if ((obj.type === 'user' || m.role === 'user') && m.content) {
      const t = cleanText(m.content);
      if (t.length >= 4) return t.slice(0, 100); // first meaningful user message
      if (!fallback && t) fallback = t;
    }
  }
  return fallback.slice(0, 100);
}

// All Claude sessions for a working directory, newest first.
export function listSessions(cwd, limit = 40) {
  const dir = dirFor(cwd);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return files
    .map((f) => {
      const full = path.join(dir, f);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      return { id: f.replace(/\.jsonl$/, ''), full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((s) => ({ id: s.id, shortId: s.id.slice(0, 8), mtime: Math.round(s.mtime), label: sessionLabel(s.full) }));
}

// The id of the most-recently-active session in a directory — i.e. the one a running Claude
// is currently writing — or null. Used to bind a window to its live session.
export function latestSessionId(cwd) {
  const dir = dirFor(cwd);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  let best = null;
  let bestM = -1;
  for (const f of files) {
    let m = 0;
    try { m = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
    if (m > bestM) { bestM = m; best = f.replace(/\.jsonl$/, ''); }
  }
  return best;
}

// Read-only snapshot of every tab (window) and its likely Claude session, BEFORE a restart.
// Touches nothing: opens the SQLite DB read-only and reads Claude's on-disk session history
// (~/.claude/projects/<encoded-cwd>/*.jsonl). Does NOT talk to tmux or the running server.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/report-tabs.js

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';

const db = new Database(path.resolve(config.dbPath), { readonly: true, fileMustExist: true });
const root = config.workspaceRoot ? path.resolve(config.workspaceRoot) : null;
const projects = path.join(os.homedir(), '.claude', 'projects');

// Claude encodes a project's cwd by replacing every non-alphanumeric char with '-'.
const claudeDirFor = (cwd) => path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'));

// First user message of a session, as a human-readable label. Reads only the first 64KB
// (the opening messages) so large session files stay cheap.
function firstUserText(file) {
  let buf = Buffer.alloc(65536);
  try {
    const fd = fs.openSync(file, 'r');
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    buf = buf.subarray(0, n);
  } catch { return ''; }
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; } // last line may be truncated
    if (obj.type === 'summary' && obj.summary) return String(obj.summary).slice(0, 90);
    const m = obj.message || obj;
    if ((obj.type === 'user' || m.role === 'user') && m.content) {
      const c = m.content;
      const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join(' ') : '')
        .replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 90);
    }
  }
  return '';
}

function recentSessions(cwd, limit = 4) {
  const dir = claudeDirFor(cwd);
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
    .map((s) => ({ ...s, summary: firstUserText(s.full) }));
}

const out = [];
const log = (s = '') => { out.push(s); console.log(s); };
const fmt = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '');

log(`# Tmux Dashboard — 选项卡 / Claude 会话快照`);
log(`# 生成于 ${new Date().toISOString()}（重启前的记录）`);
log('');

const users = db.prepare('SELECT id, username FROM users ORDER BY id').all();
let totalGroups = 0;
let totalTabs = 0;
for (const u of users) {
  const groups = db
    .prepare('SELECT id, name, path FROM groups WHERE user_id = ? ORDER BY created_at, id')
    .all(u.id);
  if (!groups.length) continue;
  totalGroups += groups.length;
  log(`## ${u.username} — ${groups.length} 个分组`);
  for (const g of groups) {
    const cwd = g.path
      ? path.resolve(g.path)
      : (root ? path.join(root, u.username, g.name) : '(WORKSPACE_ROOT 未设置)');
    const wins = db
      .prepare('SELECT name, is_open FROM windows WHERE group_id = ? ORDER BY sort_order, id')
      .all(g.id);
    totalTabs += wins.length;
    const tabs = wins.length
      ? wins.map((w) => `${w.name}${w.is_open ? '' : '（后台）'}`).join(', ')
      : '（DB 无窗口记录）';
    log(`- 分组「${g.name}」${g.path ? ' [自定义路径]' : ''}  →  ${cwd}`);
    log(`    选项卡: ${tabs}`);
    const sess = recentSessions(cwd);
    if (sess.length) {
      log(`    最近的 Claude 会话（按时间倒序，可 cd 到上面目录后 \`claude --resume\` 选用）:`);
      for (const s of sess) log(`      · ${fmt(s.mtime)}  ${s.id}`);
      for (const s of sess) if (s.summary) log(`          ${s.id.slice(0, 8)}… 首条: ${s.summary}`);
    } else {
      log(`    （该目录下未找到 Claude 会话历史）`);
    }
  }
  log('');
}

log(`合计: ${totalGroups} 个分组，${totalTabs} 条窗口记录。`);
const outFile = path.resolve('tabs-snapshot.txt');
fs.writeFileSync(outFile, out.join('\n'));
console.log(`\n>>> 已保存一份到: ${outFile}`);

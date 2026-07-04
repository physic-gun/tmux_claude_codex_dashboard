import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { db } from './db.js';
import * as tmux from './tmux.js';

// Periodic, READ-ONLY snapshot of every live tmux pane's text to disk, so a tmux crash / accidental
// `pkill tmux` (which SIGHUPs every claude and loses any un-flushed interactive transcript) still
// leaves a readable record of each conversation. This is NOT a resumable transcript — it's the
// rendered pane text — but it's the reliable safety net for the one failure the dashboard can't
// otherwise survive. The on-delete archive (groups.routes.js) covers the deliberate-delete case;
// this covers the sudden-death case.
//
// Design constraints (why it can't grow unbounded / leak / disturb sessions):
//  · `tmux capture-pane -p` only READS the scrollback — it never sends input, resizes, changes the
//    active pane, or locks anything, so the running claude is completely unaffected.
//  · Bounded disk: exactly ONE file per live window (overwritten each cycle) under live/, and files
//    for windows that no longer exist are pruned every cycle → total = current window count.
//  · No fd leak: capture spawns a short-lived `tmux` via execFile (pipes close on exit); it does NOT
//    allocate a pty (unlike node-pty, the source of the historical ptmx-master leak).
//  · No timer pile-up: a single self-rescheduling setTimeout (next run scheduled only AFTER the
//    current finishes) plus a re-entrancy guard, so a slow cycle can never overlap the next.
//  · Never throws: the whole cycle is wrapped best-effort so a capture failure can't crash the loop.

const ARCHIVE_ROOT = path.join(path.dirname(path.resolve(config.dbPath)), 'session-archives');
const LIVE_DIR = path.join(ARCHIVE_ROOT, 'live');

// Cadence: default 4 min, floored at 60s so a misconfigured env can't turn this into a capture storm.
const INTERVAL_MS = Math.max(60_000, Number(process.env.SESSION_ARCHIVE_INTERVAL_MS) || 240_000);
const MAX_LINES = 5000; // per-pane history cap (keeps each capture well under run()'s maxBuffer)
const MAX_BYTES = 2 * 1024 * 1024; // hard ceiling on a single archive file
// Retention for the on-delete timestamped archives (written by groups.routes.js) — those DON'T
// overwrite, so without a sweep they'd grow unbounded over weeks of tab churn.
const RETENTION_DAYS = Math.max(1, Number(process.env.SESSION_ARCHIVE_RETENTION_DAYS) || 30);

const sanitize = (s) => String(s || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) || 'x';

let running = false; // re-entrancy guard (belt-and-suspenders alongside self-rescheduling)
let timer = null;

// H1: age-sweep the on-delete timestamped archives (top-level *.txt in ARCHIVE_ROOT; the live/
// subdir is handled by overwrite+prune). Runs once per cycle; cheap (a readdir + stat).
function pruneOldDeleteArchives() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const f of fs.readdirSync(ARCHIVE_ROOT)) {
      if (!f.endsWith('.txt')) continue; // only the delete-time files; never touch live/
      const fp = path.join(ARCHIVE_ROOT, f);
      try {
        const st = fs.statSync(fp);
        if (st.isFile() && st.mtimeMs < cutoff) fs.rmSync(fp, { force: true });
      } catch {
        /* skip this file */
      }
    }
  } catch {
    /* ARCHIVE_ROOT may not exist yet */
  }
}

export async function captureAllOnce() {
  if (running) return;
  running = true;
  try {
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    // Base group sessions only (grp_<id>); never the transient viewer copies (grp_<id>_v_*).
    const sessions = (await tmux.listSessions()).filter((s) => /^grp_\d+$/.test(s));
    const nameById = new Map(db.prepare('SELECT id, name FROM groups').all().map((g) => [g.id, g.name]));
    const seen = new Set();
    for (const sess of sessions) {
      const gid = Number(sess.slice(4));
      const gname = nameById.get(gid) || sess;
      let windows;
      try {
        windows = await tmux.listWindows(sess);
      } catch {
        continue;
      }
      for (const w of windows) {
        // Filename keyed on gid + the UNIQUE tmux window id (@N) so two windows can never collide
        // onto one file — display names can collapse under sanitize() (e.g. two CJK group names →
        // the same ascii), which would silently lose one window's snapshot. Name is included only
        // for readability. Add to `seen` BEFORE capturing so a transient capture failure keeps the
        // last good snapshot instead of the end-of-cycle prune deleting it.
        const fname = `${gid}__${sanitize(w.name)}__${sanitize(w.id)}.txt`;
        seen.add(fname);
        try {
          const text = await tmux.capturePane(sess, w.name, MAX_LINES);
          if (!text || text.replace(/\s+/g, '').length < 40) continue; // nothing worth writing this cycle
          const body = text.length > MAX_BYTES ? text.slice(text.length - MAX_BYTES) : text;
          const header =
            `# live pane snapshot — overwritten each cycle; NOT a resumable transcript\n` +
            `# group: ${gname} (id ${gid})  window: ${w.name}\n` +
            `# updated: ${new Date().toISOString()}\n` +
            `${'='.repeat(64)}\n\n`;
          fs.writeFileSync(path.join(LIVE_DIR, fname), header + body.replace(/\s+$/, '') + '\n');
        } catch {
          /* best-effort per window — the last good file is preserved (fname already in `seen`) */
        }
      }
    }
    // Prune snapshots whose window no longer exists so live/ stays bounded to current windows.
    try {
      for (const f of fs.readdirSync(LIVE_DIR)) {
        if (f.endsWith('.txt') && !seen.has(f)) fs.rmSync(path.join(LIVE_DIR, f), { force: true });
      }
    } catch {
      /* pruning is best-effort */
    }
    pruneOldDeleteArchives();
  } catch {
    /* never let the periodic loop throw */
  } finally {
    running = false;
  }
}

// Start the self-rescheduling snapshot loop. Idempotent (never stacks timers). The next run is
// scheduled only after the current one settles, so cycles can never overlap. unref() so this timer
// never keeps the process alive on shutdown.
export function startPeriodicArchiver() {
  if (timer) return;
  const tick = async () => {
    await captureAllOnce();
    timer = setTimeout(tick, INTERVAL_MS);
    if (timer.unref) timer.unref();
  };
  // First snapshot shortly after boot (once tabs have restored), then every INTERVAL_MS — so a
  // restart-then-`pkill` window isn't left with no fresh snapshot for a whole interval.
  timer = setTimeout(tick, Math.min(15_000, INTERVAL_MS));
  if (timer.unref) timer.unref();
}

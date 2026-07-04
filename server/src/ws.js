import fs from 'fs';
import { WebSocketServer } from 'ws';
import nodePty from 'node-pty';
import { randomUUID } from 'crypto';
import { verifyTokenStr, getUserById } from './auth.js';
import { db } from './db.js';
import * as tmux from './tmux.js';
import { config } from './config.js';
import { ensureGroupDirFor } from './workspace.js';

const { spawn } = nodePty;

// ── node-pty pty-master fd-leak workaround ──────────────────────────────────────────────────────
// node-pty 1.1.0 leaks exactly one /dev/ptmx master fd per spawn() on macOS: its native addon opens
// a master clone it neither tracks nor closes (ptyProc.fd is a *different* fd that DOES get closed on
// teardown). Left alone these strays accumulate to the macOS pty cap (kern.tty.ptmx_max ≈ 511); past
// it, every new terminal dies with `forkpty: Device not configured`. The leaked fd isn't reachable
// through node-pty's API, so we detect it by diffing the process's open pty char-device fds across
// the (synchronous, so nothing else can touch the fd table mid-spawn) spawn() call, and close the
// strays at teardown. Each close re-verifies the fd is still a matching char device that isn't the
// live master, so a recycled fd is never touched — and a future node-pty that stops leaking just
// makes this find nothing.
const devMajor = (rdev) => Math.floor(rdev / (1 << 24)) & 0xff;

// fd -> device major, for every currently-open char-device fd (skips std streams 0/1/2).
function openCharDevFds() {
  const map = new Map();
  for (let fd = 3; fd < 4096; fd++) {
    try {
      const st = fs.fstatSync(fd);
      if (st.isCharacterDevice()) map.set(fd, devMajor(st.rdev));
    } catch { /* fd not open */ }
  }
  return map;
}

// spawn() a pty and record the extra master fds the native layer leaked (those that appear during
// spawn() besides ptyProc.fd and share its device major). Stored on the proc for teardown.
function spawnPtyTracked(file, args, opts) {
  const before = openCharDevFds();
  const proc = spawn(file, args, opts);
  const after = openCharDevFds();
  let master = -1;
  let major = -1;
  try { master = proc.fd; major = devMajor(fs.fstatSync(master).rdev); } catch {}
  const leaked = [];
  for (const [fd, maj] of after) {
    if (fd !== master && maj === major && major !== -1 && !before.has(fd)) leaked.push(fd);
  }
  proc._leakedMasterFds = leaked;
  proc._ptmxMajor = major;
  return proc;
}

// Close the master fds node-pty leaked for this pty. Safe + idempotent: re-checks each fd is still a
// char device of the same major that isn't the live master before closing.
function closeLeakedMasterFds(proc) {
  if (!proc || !proc._leakedMasterFds || !proc._leakedMasterFds.length) return;
  let liveMaster = -1;
  try { liveMaster = proc.fd; } catch {}
  for (const fd of proc._leakedMasterFds) {
    try {
      const st = fs.fstatSync(fd);
      if (st.isCharacterDevice() && devMajor(st.rdev) === proc._ptmxMajor && fd !== liveMaster) {
        fs.closeSync(fd);
      }
    } catch { /* already gone / recycled to something else — leave it */ }
  }
  proc._leakedMasterFds = [];
}

export const sessionNameForGroup = (groupId) => `grp_${groupId}`;

// The cwd a group's tmux session should be created with. For a worktree-scheme group, the `main`
// window lives in its own worktree, so the auto-created `main` must land THERE (not the shared
// group dir) — otherwise a full tmux restart would recreate `main` in the shared dir. Legacy
// groups (no main worktree recorded) keep using the plain group dir.
export function groupSessionCwd(group, username) {
  const main = db
    .prepare("SELECT worktree_path FROM windows WHERE group_id = ? AND name = 'main'")
    .get(group.id);
  if (main?.worktree_path) {
    try { if (fs.existsSync(main.worktree_path)) return main.worktree_path; } catch {}
  }
  return ensureGroupDirFor(group, username);
}

// The cwd to recreate a specific window in after a tmux restart: its own worktree if it has one
// (and the dir still exists on disk), else the group dir.
function windowCwd(win, groupDir) {
  if (win.worktree_path) {
    try { if (fs.existsSync(win.worktree_path)) return win.worktree_path; } catch {}
  }
  return groupDir;
}

// On startup, make sure every group's persisted OPEN windows exist in tmux — recreating any the
// tmux server lost to a restart/crash, as fresh shells. A no-op when tmux already has them (e.g.
// only node was restarted), so it's safe to run every boot. Lets tabs come back without the user
// having to open each group first.
export async function restoreOpenWindows() {
  const groups = db.prepare('SELECT * FROM groups').all();
  for (const g of groups) {
    const open = db
      .prepare('SELECT name, worktree_path FROM windows WHERE group_id = ? AND is_open = 1 ORDER BY sort_order, id')
      .all(g.id);
    if (!open.length) continue;
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(g.user_id);
    const session = sessionNameForGroup(g.id);
    try {
      const cwd = ensureGroupDirFor(g, user?.username);
      // Create the session in the main window's worktree (if any) so the auto `main` lands there.
      await tmux.ensureSession(session, groupSessionCwd(g, user?.username));
      const liveNames = new Set((await tmux.listWindows(session)).map((w) => w.name));
      for (const w of open) {
        if (!liveNames.has(w.name)) await tmux.newWindow(session, w.name, windowCwd(w, cwd));
      }
    } catch { /* skip a group that can't be restored now; it restores on first open */ }
  }
}

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws/terminal' });

  // Heartbeat. Browsers auto-reply to ping frames with a pong at the protocol layer, so a healthy
  // (even idle) terminal keeps answering. A connection that dies WITHOUT a clean close — laptop
  // sleep, Wi-Fi flap, hard-killed tab — would otherwise never fire 'close', so cleanup() never runs
  // and its pty + viewer session leak until the next restart (and the client's auto-reconnect spawns
  // a fresh pty on top). terminate() forces 'close', so cleanup() runs and reclaims everything within
  // ~2 ticks.
  const HEARTBEAT_MS = 30000;
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.(); // don't keep the event loop alive on shutdown
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let clientSession = null;
    let ptyProc = null;
    let closed = false;
    // Set when we drive the viewer into tmux copy-mode (a plain-shell wheel scroll). While it's
    // on, keystrokes are copy-mode commands, not input — so the next real keystroke first cancels
    // copy-mode, then goes through. Self-heals a pane that got stuck in copy-mode (e.g. a scroll
    // landed during the brief window an app had torn down its alt-screen).
    let inCopyMode = false;
    // Non-null only during the async copy-mode cancel: buffers keystrokes so they flush in order
    // (and none are dropped) once the cancel lands — the cancel and the pty write travel over
    // different channels, so without this a fast follow-up key could overtake the first.
    let resumeBuf = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      try { if (ptyProc) ptyProc.kill(); } catch {}
      closeLeakedMasterFds(ptyProc); // reclaim node-pty's leaked /dev/ptmx master fd
      if (clientSession) tmux.killSession(clientSession);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    const fail = (code, msg) => {
      try { ws.send(JSON.stringify({ type: 'error', data: msg })); } catch {}
      try { ws.close(code, msg); } catch {}
    };

    (async () => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const token = url.searchParams.get('token');
        const gid = Number(url.searchParams.get('gid'));
        const windowName = url.searchParams.get('window') || 'main';
        const cols = Math.max(1, Number(url.searchParams.get('cols')) || 80);
        const rows = Math.max(1, Number(url.searchParams.get('rows')) || 24);

        const payload = token ? verifyTokenStr(token) : null;
        const user = payload ? getUserById(payload.id) : null;
        if (!user) return fail(4001, '未授权');

        const group = db.prepare('SELECT * FROM groups WHERE id = ? AND user_id = ?').get(gid, user.id);
        if (!group) return fail(4003, '无权访问该分组');

        const base = sessionNameForGroup(gid);
        await tmux.ensureSession(base, groupSessionCwd(group, user.username));

        clientSession = `${base}_v_${randomUUID().slice(0, 8)}`;
        await tmux.newGroupedSession(base, clientSession);
        // If the socket already closed while we were setting up, undo and bail.
        if (closed) { tmux.killSession(clientSession); return; }
        await tmux.selectWindow(clientSession, windowName);

        ptyProc = spawnPtyTracked('tmux', ['-L', config.tmuxSocket, 'attach-session', '-t', clientSession], {
          name: 'xterm-256color',
          cols,
          rows,
          env: process.env,
        });
        // The socket may have closed during setup; cleanup() already ran (with ptyProc
        // still null), so tear down the pty + session we just created here.
        if (closed) {
          try { ptyProc.kill(); } catch {}
          closeLeakedMasterFds(ptyProc);
          tmux.killSession(clientSession);
          return;
        }

        ptyProc.onData((data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data }));
        });
        ptyProc.onExit(() => { try { ws.close(); } catch {} });

        ws.on('message', (raw) => {
          ws.isAlive = true; // any client traffic also counts as a live heartbeat
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          if (msg.type === 'input') {
            if (resumeBuf) {
              resumeBuf.push(msg.data); // cancel in flight — queue in order, flushed below
            } else if (inCopyMode) {
              // A prior wheel scroll left the viewer in copy-mode; exit it first so this key
              // reaches the app instead of being eaten as a copy-mode command. Buffer this and
              // any keys that arrive during the async cancel, then flush them in order.
              inCopyMode = false;
              resumeBuf = [msg.data];
              tmux.cancelCopyMode(clientSession).finally(() => {
                const buf = resumeBuf;
                resumeBuf = null;
                try { for (const d of buf) ptyProc.write(d); } catch {}
              });
            } else {
              ptyProc.write(msg.data);
            }
          } else if (msg.type === 'resize') {
            try { ptyProc.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0)); } catch {}
          } else if (msg.type === 'scroll') {
            // Plain-shell scrollback lives in tmux; scroll the viewer's copy-mode history.
            // Scrolling up enters copy-mode; remember it so the next keystroke can restore input.
            if (msg.dir < 0) inCopyMode = true;
            tmux.scrollViewer(clientSession, msg.dir < 0 ? -1 : 1, msg.n | 0);
          }
        });
      } catch (e) {
        fail(1011, String(e?.message || e));
      }
    })();
  });
}

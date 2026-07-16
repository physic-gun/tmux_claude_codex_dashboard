import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { buildTmuxArgs } from './tmuxArgs.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `-f` makes a freshly-started tmux server load our headless config (status off,
// fast escape-time, truecolor) so attached clients render TUIs cleanly.
const CONF = path.resolve(__dirname, '../tmux.conf');

export function clientArgs(args = []) {
  return buildTmuxArgs({
    socket: config.tmuxSocket,
    conf: CONF,
    managedExternally: config.tmuxManagedExternally,
  }, args);
}

// The dashboard's tmux server inherits Claude Code's session-marker env vars when the service is
// (re)started from inside a Claude Code session (CLAUDECODE / CLAUDE_CODE_CHILD_SESSION /
// CLAUDE_CODE_SESSION_ID / ...). A `claude` launched in a window that inherits these is treated as a
// nested CHILD session and does NOT write a resumable ~/.claude/projects/<cwd>/<uuid>.jsonl —
// silently breaking Claude session-history / one-click resume. Scrub them so every pane is a clean
// top-level session. (Confirmed by same-machine A/B test: with these set an interactive claude
// persists nothing; unset, it persists normally.)
const CLAUDE_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_EFFORT',
  'AI_AGENT',
];
// Env for every tmux invocation: a freshly-started server is thus born without the markers, so all
// its windows/panes (and the claude sessions in them) start clean.
const TMUX_ENV = (() => {
  const e = { ...process.env };
  for (const v of CLAUDE_ENV_VARS) delete e[v];
  return e;
})();

async function run(args, { ignoreError = false } = {}) {
  try {
    // timeout: every tmux op here is local + instant; a 15s cap means a wedged tmux server can
    // never hang a request or the periodic archiver loop (it kills the child and rejects instead).
    // maxBuffer 8MB: capture-pane of a wide, full-history pane can exceed 4MB.
    const { stdout } = await execFileP('tmux', clientArgs(args), {
      env: TMUX_ENV,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    return stdout;
  } catch (e) {
    if (ignoreError) return '';
    throw e;
  }
}

// `=name` forces an exact (non-glob) match for session/window targets.
const sTarget = (session) => `=${session}`;
const wTarget = (session, name) => `=${session}:=${name}`;

export async function sessionExists(session) {
  try {
    await run(['has-session', '-t', sTarget(session)]);
    return true;
  } catch {
    return false;
  }
}

export async function serverReady() {
  try {
    await run(['show-options', '-gqv', 'exit-empty']);
    return true;
  } catch {
    return false;
  }
}

export async function ensureSession(session, cwd = null) {
  if (!(await sessionExists(session))) {
    const args = ['new-session', '-d', '-s', session, '-n', 'main'];
    if (cwd) args.push('-c', cwd);
    await run(args);
  }
}

// Remove any inherited Claude Code session-marker vars from the RUNNING server's global environment,
// so windows created from now on are clean even when the server was already started polluted (a node
// restart doesn't restart the long-lived tmux server). Idempotent; a no-op when no server is running
// yet (the next new-session, run with the scrubbed TMUX_ENV above, is born clean anyway).
export async function scrubServerEnv() {
  for (const v of CLAUDE_ENV_VARS) {
    await run(['set-environment', '-g', '-u', v], { ignoreError: true });
  }
}

export async function listWindows(session) {
  // pane_title carries the active program's OSC 0/2 title (e.g. claude's session name);
  // pane_current_command lets us ignore the shell's default title (hostname/cwd).
  const out = await run(
    [
      'list-windows',
      '-t',
      sTarget(session),
      '-F',
      '#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}',
    ],
    { ignoreError: true }
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const [id, index, name, active, paneId, panePid, command, cwd] = parts;
      const title = parts.slice(8).join('\t'); // titles may contain tabs, so keep them last
      return {
        id, // tmux window id like "@3" — unambiguous (unlike a numeric name, which reads as an index)
        index: Number(index),
        name,
        active: active === '1',
        paneId: paneId || '',
        panePid: Number(panePid) || 0,
        command: command || '',
        cwd: cwd || '',
        title: title || '',
      };
    });
}

export async function newWindow(session, name, cwd = null) {
  // -d: create in background without switching the session's active window.
  const args = ['new-window', '-d', '-t', sTarget(session), '-n', name];
  if (cwd) args.push('-c', cwd);
  await run(args);
}

// Capture a window's active-pane scrollback as plain text (tmux history + the visible screen,
// wrapped lines joined). -p prints to stdout, -J joins wrapped lines. `maxLines` bounds how far
// back to reach: 0 => all history (`-S -`), N>0 => only the last N history lines (`-S -N`) so a
// runaway pane can't blow run()'s maxBuffer. Best-effort: '' if the window/session is gone. Used
// to archive a conversation, since an interactive claude session does NOT persist its own
// transcript to ~/.claude until an internal checkpoint it usually never reaches.
export async function capturePane(session, name, maxLines = 0) {
  const start = maxLines > 0 ? String(-maxLines) : '-';
  return run(['capture-pane', '-t', wTarget(session, name), '-p', '-S', start, '-J'], { ignoreError: true });
}

export async function killWindow(session, name) {
  await run(['kill-window', '-t', wTarget(session, name)], { ignoreError: true });
}

export async function renameWindow(session, oldName, newName) {
  await run(['rename-window', '-t', wTarget(session, oldName), newName]);
}

// Rename by window id (e.g. "@3"). Needed to heal purely-numeric names: a window named "2"
// can't be targeted by name (tmux reads "2" as window index 2), but its id is unambiguous.
export async function renameWindowById(id, newName) {
  await run(['rename-window', '-t', id, newName]);
}

// Scroll a viewer's scrollback via tmux copy-mode. A plain shell's history lives in tmux (not
// in xterm, which only ever receives the visible screen), so the browser wheel/buttons can't
// reach it locally — we drive copy-mode here instead. `-e` makes copy-mode exit once scrolled
// back down to the live bottom. dir < 0 scrolls up (into history), dir > 0 scrolls back down.
export async function scrollViewer(viewer, dir, n) {
  const count = Math.max(1, Math.min(1000, n | 0));
  if (dir < 0) {
    await run(['copy-mode', '-e', '-t', viewer], { ignoreError: true });
    await run(['send-keys', '-t', viewer, '-X', '-N', String(count), 'scroll-up'], { ignoreError: true });
  } else {
    // Only meaningful while already in copy-mode; a no-op (ignored) error otherwise.
    await run(['send-keys', '-t', viewer, '-X', '-N', String(count), 'scroll-down'], { ignoreError: true });
  }
}

// Exit copy-mode on a viewer's active pane. Called before forwarding real keystrokes: a pane
// left in copy-mode (e.g. a wheel scroll that entered it while the app had briefly torn down
// its alt-screen) swallows every key as a copy-mode nav command, so the terminal looks
// "dead" to input until it's cancelled. Idempotent — a no-op (ignored) when not in a mode.
export async function cancelCopyMode(viewer) {
  await run(['send-keys', '-t', viewer, '-X', 'cancel'], { ignoreError: true });
}

// The browser is attached to a grouped tmux session, so xterm's own normal/alternate buffer says
// what the OUTER tmux client is doing, not what the pane's foreground program is doing. Query tmux
// directly when routing a wheel gesture. This is intentionally viewer-scoped: copy-mode belongs to
// one attached viewer and must never disturb another browser watching the same base window.
export async function getViewerPaneState(viewer) {
  const out = await run(
    [
      'display-message',
      '-p',
      '-t',
      viewer,
      '-F',
      '#{pane_current_command}\t#{mouse_any_flag}\t#{mouse_sgr_flag}\t#{pane_in_mode}\t#{pane_width}\t#{pane_height}\t#{pane_title}',
    ],
    { ignoreError: true }
  );
  if (!out.trim()) return null;
  const parts = out.trimEnd().split('\t');
  const [command, mouseAny, mouseSgr, inMode, width, height] = parts;
  return {
    command: command || '',
    mouseAny: mouseAny === '1',
    mouseSgr: mouseSgr === '1',
    inMode: inMode === '1',
    width: Math.max(1, Number(width) || 1),
    height: Math.max(1, Number(height) || 1),
    title: parts.slice(6).join('\t'),
  };
}

export async function sendKeys(session, name, command) {
  // -l sends the string literally (no key-name interpretation), then a real Enter.
  await run(['send-keys', '-t', wTarget(session, name), '-l', command]);
  await run(['send-keys', '-t', wTarget(session, name), 'Enter']);
}

// Create a grouped session: it shares the base session's window list but keeps an
// independent "current window" and size, so one viewer never disturbs another.
export async function newGroupedSession(base, client) {
  await run(['new-session', '-d', '-s', client, '-t', sTarget(base)]);
}

export async function selectWindow(client, name) {
  await run(['select-window', '-t', wTarget(client, name)], { ignoreError: true });
}

export async function refreshClient(client) {
  await run(['refresh-client', '-t', sTarget(client)], { ignoreError: true });
}

export async function killSession(session) {
  await run(['kill-session', '-t', sTarget(session)], { ignoreError: true });
}

export async function listSessions() {
  const out = await run(['list-sessions', '-F', '#{session_name}'], { ignoreError: true });
  return out.split('\n').filter(Boolean);
}

export async function killSessionsByPrefix(prefix) {
  const sessions = await listSessions();
  await Promise.all(sessions.filter((s) => s.startsWith(prefix)).map((s) => killSession(s)));
}

// Per-connection viewer sessions are named `<base>_v_<uuid>`; reap orphans.
export async function reapViewerSessions() {
  const sessions = await listSessions();
  await Promise.all(sessions.filter((s) => s.includes('_v_')).map((s) => killSession(s)));
}

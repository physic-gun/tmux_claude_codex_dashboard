import { useEffect, useRef, useState, type TouchEvent as ReactTouchEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { getToken, api, postRaw } from '../api';
import { copyText } from '../lib/clipboard';
import { filePathCandidate, isMarkdownPath, fmtSize, renderMarkdown, type FileView } from '../lib/fileview';
import FloatingPanel from './FloatingPanel';
import FileExplorer from './FileExplorer';

// ── Clipboard relay store ───────────────────────────────────────────────────────────────────
// The app's OSC 52 copies are kept in an in-app list (the reliable "剪贴板中转"), per terminal
// window, persisted in localStorage and capped so it can't grow without bound. A monotonic id
// (derived from the list, not a clock) keys React rows and the edit target.
type ClipItem = { id: number; text: string; ts: number };
const CLIP_CAP = 50;
const clipKey = (gid: number, win: string) => `tmuxdash:clip:${gid}:${win}`;
function loadClips(gid: number, win: string): ClipItem[] {
  try {
    const raw = localStorage.getItem(clipKey(gid, win));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((c) => c && typeof c.text === 'string') : [];
  } catch {
    return [];
  }
}
function saveClips(gid: number, win: string, clips: ClipItem[]) {
  try { localStorage.setItem(clipKey(gid, win), JSON.stringify(clips)); } catch {}
}

// Decode an OSC 52 base64 payload as UTF-8 (atob yields a Latin1 byte-string; claude's copies
// often contain non-ASCII, e.g. Chinese, so decode the bytes as UTF-8). '' on malformed input.
function decodeB64Utf8(b64: string): string {
  try {
    const bin = atob(b64.trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

// Pull OSC 52 clipboard writes straight out of a raw output chunk. We do this INSTEAD of relying
// solely on xterm's ClipboardAddon because the addon silently drops some real-world cases — most
// notably tmux rewrites `ESC]52;c;…` to an empty selection (`ESC]52;;…`), and long payloads get
// split across frames. `carry` holds an in-progress sequence spanning chunks; returns the decoded
// texts found plus the leftover carry. Bounded so a stray ESC]52; without a terminator can't grow
// without limit. Sequence: ESC ] 52 ; <sel> ; <base64> (BEL | ESC \).
const OSC52_CARRY_MAX = 8 * 1024 * 1024;
function extractOsc52(chunk: string, carry: string): { texts: string[]; carry: string } {
  const texts: string[] = [];
  let s = carry ? carry + chunk : chunk;
  let outCarry = '';
  let i = 0;
  for (;;) {
    const start = s.indexOf('\x1b]52;', i);
    if (start === -1) break;
    const bel = s.indexOf('\x07', start + 5);
    const st = s.indexOf('\x1b\\', start + 5);
    let end = -1;
    let termLen = 0;
    if (bel !== -1 && (st === -1 || bel < st)) { end = bel; termLen = 1; }
    else if (st !== -1) { end = st; termLen = 2; }
    if (end === -1) { // terminator not here yet — carry the tail to the next chunk (bounded)
      const tail = s.slice(start);
      outCarry = tail.length <= OSC52_CARRY_MAX ? tail : '';
      break;
    }
    const body = s.slice(start + 5, end); // "<sel>;<base64>"
    const semi = body.indexOf(';');
    if (semi !== -1) {
      const b64 = body.slice(semi + 1);
      if (b64 && b64 !== '?') { const t = decodeB64Utf8(b64); if (t) texts.push(t); }
    }
    i = end + termLen;
  }
  return { texts, carry: outCarry };
}

// Apps like claude turn on mouse reporting (1000/1002/1003 + SGR 1006) to grab both drags
// and the wheel. We ALWAYS strip the enable sequences before xterm sees them, so a plain
// drag does a local text selection (copy-on-select) instead of being forwarded to the app.
// The wheel is then forwarded back to the app by hand (see the wheel handler) so it still
// scrolls — giving select-to-copy and scrolling at the same time, with no mode toggle.
const MOUSE_ENABLE_RE = /\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1015)h/g;
// Read the app's mouse state from its raw output, scanned in order so the last token wins:
//   1000/1002/1003 h|l → app wants the mouse on|off; 1006 h|l → SGR encoding on|off;
//   1049/1047/47 l or ESC c (RIS) → app left alt-screen / reset → force mouse off, so an app
//   that quit without disabling the mouse can't leave us forwarding wheel bytes into a shell.
const MOUSE_STATE_RE = /\x1b\[\?(1000|1002|1003|1006)([hl])|\x1b\[\?(?:1049|1047|47)l|\x1bc/g;

// The built-in monospace stack, used as the fallback (and the default when no font is chosen).
// Latin faces first, then a CJK system fallback (PingFang / 微软雅黑 / Noto) so Chinese still
// renders — even under a Latin-only pick like JetBrains Mono — WITHOUT pulling the bundled 5.2 MB
// Maple Mono CN. Picking "Maple Mono CN" explicitly (composeFont prepends it) uses the bundled face.
const DEFAULT_TERM_FONT =
  'Menlo, Monaco, Consolas, "Courier New", "PingFang SC", "Microsoft YaHei", ' +
  '"Noto Sans Mono CJK SC", "Noto Sans CJK SC", monospace';
// Prepend the user's chosen family (if any) so an unavailable font still falls back to a
// monospace face — the terminal grid depends on monospace metrics.
function composeFont(name?: string) {
  const n = (name || '').trim();
  return n ? `"${n}", ${DEFAULT_TERM_FONT}` : DEFAULT_TERM_FONT;
}

// ── On-screen English keyboard (mobile) ─────────────────────────────────────────────────────
// Docks below the terminal and sends each key to the pty LIVE (like a real keyboard) so claude
// sees keystrokes as they're pressed. Full terminal key set: letters/digits/symbols plus Enter,
// Backspace, Space, Esc, Tab, arrows, and one-shot Shift / Ctrl modifiers (Ctrl+letter → control
// byte, so Ctrl+C etc. work). Latin-only — deliberately no IME, per the "纯英文输入" requirement.
type VKey =
  | { t: 'c'; b: string; s: string; w?: number }        // character key: base + shifted variant
  | { t: 'k'; label: string; data: string; w?: number } // fixed key sending raw bytes
  | { t: 'm'; label: string; mod: 'shift' | 'ctrl'; w?: number }; // modifier toggle

const VK_ROWS: VKey[][] = [
  [
    { t: 'c', b: '`', s: '~' }, { t: 'c', b: '1', s: '!' }, { t: 'c', b: '2', s: '@' },
    { t: 'c', b: '3', s: '#' }, { t: 'c', b: '4', s: '$' }, { t: 'c', b: '5', s: '%' },
    { t: 'c', b: '6', s: '^' }, { t: 'c', b: '7', s: '&' }, { t: 'c', b: '8', s: '*' },
    { t: 'c', b: '9', s: '(' }, { t: 'c', b: '0', s: ')' }, { t: 'c', b: '-', s: '_' },
    { t: 'c', b: '=', s: '+' }, { t: 'k', label: '⌫', data: '\x7f', w: 2 },
  ],
  [
    { t: 'k', label: 'Tab', data: '\t', w: 2 },
    ...'qwertyuiop'.split('').map((ch) => ({ t: 'c', b: ch, s: ch.toUpperCase() } as VKey)),
    { t: 'c', b: '[', s: '{' }, { t: 'c', b: ']', s: '}' }, { t: 'c', b: '\\', s: '|' },
  ],
  [
    { t: 'k', label: 'Esc', data: '\x1b', w: 2 },
    ...'asdfghjkl'.split('').map((ch) => ({ t: 'c', b: ch, s: ch.toUpperCase() } as VKey)),
    { t: 'c', b: ';', s: ':' }, { t: 'c', b: "'", s: '"' },
    { t: 'k', label: '↵', data: '\r', w: 2 },
  ],
  [
    { t: 'm', label: '⇧', mod: 'shift', w: 2 },
    ...'zxcvbnm'.split('').map((ch) => ({ t: 'c', b: ch, s: ch.toUpperCase() } as VKey)),
    { t: 'c', b: ',', s: '<' }, { t: 'c', b: '.', s: '>' }, { t: 'c', b: '/', s: '?' },
    { t: 'k', label: '↑', data: '\x1b[A' },
  ],
  [
    { t: 'm', label: 'Ctrl', mod: 'ctrl', w: 2 },
    { t: 'k', label: '空格', data: ' ', w: 6 },
    { t: 'k', label: '←', data: '\x1b[D' }, { t: 'k', label: '↓', data: '\x1b[B' },
    { t: 'k', label: '→', data: '\x1b[C' },
  ],
];

function VirtualKeyboard({ onKey, onClose }: { onKey: (d: string) => void; onClose: () => void }) {
  const [shift, setShift] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  // Ctrl+<char> → the control byte (c & 0x1f); works for letters and @ [ \ ] ^ _.
  const ctlByte = (c: string) => String.fromCharCode(c.toUpperCase().charCodeAt(0) & 0x1f);
  const clearMods = () => { if (shift) setShift(false); if (ctrl) setCtrl(false); };

  const pressChar = (k: { b: string; s: string }) => {
    if (ctrl) onKey(ctlByte(k.b));
    else onKey(shift ? k.s : k.b);
    clearMods();
  };
  const pressRaw = (data: string) => { onKey(data); clearMods(); };

  const keyLabel = (k: VKey) => {
    if (k.t === 'c') return shift ? k.s : k.b;
    return k.label;
  };
  const onDown = (e: ReactPointerEvent, fn: () => void) => { e.preventDefault(); fn(); };

  return (
    <div className="vkbd" onPointerDown={(e) => e.preventDefault()}>
      <div className="vkbd-bar">
        <span className="vkbd-hint">屏幕键盘 · 逐键实时发送{ctrl ? ' · Ctrl' : ''}{shift ? ' · Shift' : ''}</span>
        <button className="vkbd-close" onPointerDown={(e) => onDown(e, onClose)}>收起 ▾</button>
      </div>
      {VK_ROWS.map((row, ri) => (
        <div className="vkbd-row" key={ri}>
          {row.map((k, ci) => {
            const active = k.t === 'm' && ((k.mod === 'shift' && shift) || (k.mod === 'ctrl' && ctrl));
            return (
              <button
                key={ci}
                className={`vkbd-key${k.t === 'm' ? ' mod' : ''}${k.t === 'k' ? ' fn' : ''}${active ? ' on' : ''}`}
                style={{ flexGrow: k.w || 1 }}
                onPointerDown={(e) =>
                  onDown(e, () => {
                    if (k.t === 'c') pressChar(k);
                    else if (k.t === 'k') pressRaw(k.data);
                    else if (k.mod === 'shift') setShift((v) => !v);
                    else setCtrl((v) => !v);
                  })
                }
              >
                {keyLabel(k)}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Track an overlay's open/close in a shared LIFO stack so a single global Esc handler can dismiss
// the top-most overlay first and then work down — "依次关闭". Push on open, remove on close/unmount.
function useOverlayStack(stackRef: { current: string[] }, id: string, open: boolean) {
  useEffect(() => {
    if (!open) return;
    stackRef.current.push(id);
    return () => { stackRef.current = stackRef.current.filter((x) => x !== id); };
  }, [stackRef, id, open]);
}

export default function TerminalView({
  gid,
  windowName,
  stepSmall = 20,
  stepBig = 60,
  scrollAuto = false,
  fontFamily,
  selectMode = false,
  mobile = false,
  active = true,
}: {
  gid: number;
  windowName: string;
  stepSmall?: number;
  stepBig?: number;
  scrollAuto?: boolean;
  fontFamily?: string;
  selectMode?: boolean;
  mobile?: boolean;
  // Terminal-pool mode (Dashboard keeps every visited tab mounted, hidden via display:none, so
  // switching back is instant). `active` = this tab is the visible one. Inactive instances stay
  // connected and keep buffering output, but must NOT act on window-level events (Esc/gesture
  // handlers), write the system clipboard, steal focus, or push a 0×0 resize to the pty.
  active?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const openEditorRef = useRef<() => void>(() => {});
  // Scroll the pane by N lines/steps in a direction (-1 up / +1 down); wired up inside the
  // effect and called by the on-screen scroll buttons. No-op until the terminal mounts.
  const scrollByRef = useRef<(dir: number, n: number) => void>(() => {});
  // Bump the terminal font size by ±1 (wired up inside the effect, called by the A+/A− buttons).
  const changeFontRef = useRef<(delta: number) => void>(() => {});
  // Refit the terminal (wired up inside the effect); called when the font family changes so
  // cols/rows + the remote pty size follow the new glyph metrics.
  const doFitRef = useRef<() => void>(() => {});
  // Live mouse state of the app in this pane, parsed from its output: whether it has mouse
  // reporting on (→ forward the wheel to it) and whether it speaks SGR (1006) encoding.
  const appMouseRef = useRef(false);
  const sgrMouseRef = useRef(false);
  // "Sticky" view of the above: set once the app enables mouse/SGR on the alternate screen,
  // cleared only when it tears the alt screen down. tmux re-sends the enables on every
  // (re)attach/redraw — but it DISABLES then re-ENABLES them, so the live flags above flip off
  // briefly on each tab switch/redraw (and a frame-split can drop an enable entirely). Without
  // the sticky flag the wheel would, in that window, fall through to xterm's alternate-scroll
  // and reach claude as ARROW KEYS ("scroll wheel is sending arrow keys · use PgUp/PgDn").
  const appMouseSeenRef = useRef(false);
  const sgrSeenRef = useRef(false);
  // True while an Alt/Option-drag is being forwarded to the app as mouse events (vs a local
  // text selection). Lets us suppress copy-on-select for that gesture.
  const mouseFwdRef = useRef(false);
  // Live "selection mode" flag (mobile range-select), read by the touch handlers without
  // re-running the terminal effect.
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;
  // Transient on-screen hint (e.g. "粘贴请用 Ctrl+Shift+V").
  const showHintRef = useRef<(msg: string) => void>(() => {});
  const hintTimerRef = useRef<number>();
  // Handler for OSC 52 clipboard writes arriving from the app (claude's copy). Assigned
  // below (needs setState); the terminal effect's clipboard provider calls through it.
  const onOsc52Ref = useRef<(text: string) => void>(() => {});
  // The latest claude copy that couldn't reach the SYSTEM clipboard immediately (an OSC 52 arrives
  // with no user activation, which browsers often block). Flushed on the next user gesture, where
  // the clipboard write is permitted. Cleared by a manual copy so it can't clobber the user's own.
  const pendingClipRef = useRef('');
  // Single-flight guard for the short retry timer that flushes a blocked write once focus returns.
  const clipRetryRef = useRef(false);
  // Send raw bytes to the pty over the socket (used by the on-screen virtual keyboard and
  // the clipboard "发送"). Wired up inside the effect once the socket exists.
  const sendInputRef = useRef<(data: string) => boolean>(() => false);
  // Toggle the mobile soft-keyboard suppression on the live terminal (wired up in the effect).
  const applyMobileInputRef = useRef<(on: boolean) => void>(() => {});
  // Live mobile flag for handlers that must not re-run the terminal effect.
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  // Live `active` flag (terminal pool): window-level handlers and clipboard writes must no-op on
  // hidden instances without re-running the terminal effect.
  const activeRef = useRef(active);
  activeRef.current = active;

  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sendErr, setSendErr] = useState('');
  // Live terminal row count (the visible "CLI 行数"), kept in sync on every fit. Shown on the
  // scroll rail and, in auto mode, used to derive the scroll-step sizes.
  const [rows, setRows] = useState(0);
  const [hint, setHint] = useState('');
  // Clipboard relay: every OSC 52 copy from the app (claude's /copy, select-to-copy) is stored
  // here so the content is never lost even when the browser blocks the system-clipboard write
  // (no user gesture / http origin). Per-window, persisted, capped — see clipKey / CLIP_CAP.
  const [clips, setClips] = useState<ClipItem[]>(() => loadClips(gid, windowName));
  const [clipListOpen, setClipListOpen] = useState(false);
  const [clipEdit, setClipEdit] = useState<{ id: number; text: string } | null>(null);
  // File preview for the open clip: when its text is a path to a real file, its content is shown
  // in a split below the source. `fileMd` toggles Markdown rendering, `fileZoom` pops a floating
  // reader for viewing/copying. lastFilePathRef defaults the MD toggle once per distinct file.
  const [fileView, setFileView] = useState<FileView>({ status: 'idle' });
  const [fileMd, setFileMd] = useState(false);
  const [fileZoom, setFileZoom] = useState(false);
  const lastFilePathRef = useRef<string | null>(null);
  // On-screen English keyboard (mobile): docked at the CLI bottom, keys sent live to the pty.
  const [kbdOpen, setKbdOpen] = useState(false);
  // Floating file explorer (📁 FAB): browse/manage host files, anchored to this pane's cwd.
  const [explorerOpen, setExplorerOpen] = useState(false);
  const draftKey = `tmuxdash:draft:${gid}:${windowName}`;

  // ── Overlay dismissal ──────────────────────────────────────────────────────────────────────
  // The clipboard list + the three floating panels (clip editor, file zoom, Ctrl+G editor) form a
  // stack. A global Esc closes the top-most one (even when focus is in the terminal, not the panel),
  // so repeated Esc peels them off one by one. The clip list additionally closes on an outside click.
  const overlayStackRef = useRef<string[]>([]);
  const overlayClosersRef = useRef<Record<string, () => void>>({});
  overlayClosersRef.current = {
    clipList: () => setClipListOpen(false),
    clipEdit: () => setClipEdit(null),
    fileZoom: () => setFileZoom(false),
    editor: () => setEditorOpen(false),
    explorer: () => setExplorerOpen(false),
  };
  useOverlayStack(overlayStackRef, 'clipList', clipListOpen);
  useOverlayStack(overlayStackRef, 'clipEdit', clipEdit != null);
  useOverlayStack(overlayStackRef, 'fileZoom', fileZoom);
  useOverlayStack(overlayStackRef, 'editor', editorOpen);
  useOverlayStack(overlayStackRef, 'explorer', explorerOpen);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Pool: a HIDDEN instance must never consume Esc — its stopPropagation would eat the key
      // before the visible tab's handler (or the pty) ever saw it.
      if (!activeRef.current) return;
      if (e.key !== 'Escape') return;
      const stack = overlayStackRef.current;
      if (!stack.length) return; // nothing open → let Esc reach the terminal (claude)
      const close = overlayClosersRef.current[stack[stack.length - 1]];
      if (!close) return;
      e.preventDefault();
      e.stopPropagation(); // don't also send ESC into the pty while we're dismissing a panel
      close();
    };
    // Capture phase so this beats xterm's own textarea keydown handler regardless of focus.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // Clicking anywhere outside the open clip list collapses it. The list itself and the 📋 toggle are
  // excluded: a click on a clip row (inside .clip-panel) opens the editor panel untouched, and the
  // FAB keeps its own toggle. Clicking the editor panel is "outside", so the list tidies away.
  useEffect(() => {
    if (!clipListOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!activeRef.current) return; // pool: hidden instance — leave its (hidden) panel state alone
      const t = e.target as HTMLElement | null;
      if (t && t.closest('.clip-panel, .cli-fab')) return;
      setClipListOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [clipListOpen]);

  // Auto mode derives the steps from the visible screen: small = ¼ of the rows (rounded up),
  // big = a near-full page (rows − 10). Otherwise the user's fixed settings are used.
  const effSmall = scrollAuto ? Math.max(1, Math.ceil(rows * 0.25)) : stepSmall;
  const effBig = scrollAuto ? Math.max(1, rows - 10) : stepBig;

  // Keep the opener current; setEditorOpen is stable so this is cheap.
  openEditorRef.current = () => {
    setDraft(localStorage.getItem(draftKey) || '');
    setSendErr('');
    setEditorOpen(true);
  };

  // Show a brief hint that auto-dismisses (setHint is stable, so this is cheap to reassign).
  showHintRef.current = (msg: string) => {
    setHint(msg);
    if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => setHint(''), 2200);
  };

  // Write to the SYSTEM clipboard, first reclaiming page focus when the document lost it — holding
  // Alt (the selection modifier for claude's own select/scroll) activates the browser menu bar on
  // Windows/Edge, which unfocuses the document, and navigator.clipboard.writeText() rejects while the
  // document is unfocused. Refocusing the terminal textarea pulls focus back to the page so the write
  // is allowed. Only refocus when the WHOLE page is unfocused (document.hasFocus() false) — never
  // steal focus from an open panel (editor / explorer), where hasFocus() is still true.
  // A clipboard write only actually reaches the OS clipboard from within a live USER ACTIVATION — a
  // real click/keypress in the last few seconds. NOT from a bare async event, and NOT from mere focus:
  // on Chromium/Edge writeText() without activation still RESOLVES but silently writes nothing (the
  // crux of the "hint said 已复制 but the clipboard is empty" bug). Holding Alt + wheel grants NO
  // activation (modifier keys and the wheel don't count), so claude's async OSC 52 copy has none — it
  // is kept pending and committed on the user's next real gesture (the pointerdown/keydown flush).
  const canWriteClip = () => {
    const ua = (navigator as unknown as { userActivation?: { isActive?: boolean } }).userActivation;
    return ua && typeof ua.isActive === 'boolean' ? ua.isActive : document.hasFocus();
  };
  const writeSysClip = (text: string): Promise<boolean> => {
    if (!canWriteClip()) return Promise.resolve(false);
    return copyText(text);
  };

  // After a blocked immediate write, retry on a short timer: the block is usually a transient blur
  // (Alt still held / the browser menu open), and the moment focus returns (Alt released) a retry
  // succeeds — so the copy reaches the system clipboard with no extra action. Bounded (~3s) and
  // single-flight so it can never churn; stops on success or when a manual copy clears pending.
  const retryClipWrite = (attempt: number) => {
    clipRetryRef.current = true;
    const t = pendingClipRef.current;
    // Pool: stop the moment this tab goes hidden — a background retry must never write the
    // system clipboard off another tab's user activation. (The relay list keeps the text.)
    if (!activeRef.current || !t || attempt >= 40) { clipRetryRef.current = false; return; } // ~6s; blurred ticks are cheap no-ops
    writeSysClip(t).then((ok) => {
      if (ok) { pendingClipRef.current = ''; clipRetryRef.current = false; showHintRef.current('✓ 已写入系统剪贴板'); }
      else window.setTimeout(() => retryClipWrite(attempt + 1), 150);
    });
  };

  // An OSC 52 copy from the app (claude): append it to the clipboard relay list so it's never lost,
  // AND put it on the system clipboard. The immediate write can still be blocked (the OSC 52 arrives
  // in a WebSocket event with no user activation); when it is, the text is held in pendingClipRef and
  // flushed to the system clipboard on the next user gesture.
  onOsc52Ref.current = (text: string) => {
    if (!text) return;
    setClips((prev) => {
      if (prev[0]?.text === text) return prev; // ignore an immediate duplicate re-copy
      const next = [{ id: (prev[0]?.id ?? 0) + 1, text, ts: Date.now() }, ...prev].slice(0, CLIP_CAP);
      saveClips(gid, windowName, next);
      return next;
    });
    // Pool: a copy arriving in a HIDDEN tab goes to its relay list only — a background claude
    // must never clobber the system clipboard (nor arm the gesture-flush) while the user works
    // in another tab. The 📋/📥 relay is the designed recovery path for exactly this.
    if (!activeRef.current) return;
    writeSysClip(text).then((ok) => {
      if (ok) { pendingClipRef.current = ''; showHintRef.current('✓ 已写入系统剪贴板（同时存入中转）'); }
      else {
        pendingClipRef.current = text;
        showHintRef.current('已存入中转 · 在终端点一下 / 按任意键即写入系统剪贴板');
        if (!clipRetryRef.current) window.setTimeout(() => retryClipWrite(0), 150); // in case activation lingers
      }
    });
  };

  // Write the newest relay clip to the SYSTEM clipboard. Invoked from a button — a real click IS a
  // user activation, so this write actually lands, unlike claude's async OSC 52 copy (which has none:
  // Alt+wheel grants no activation, so it can only sit in the relay until an explicit gesture like this).
  function writeLatestToSysClip() {
    const t = clips[0]?.text;
    if (!t) { showHintRef.current('剪贴板中转为空'); return; }
    pendingClipRef.current = '';
    copyText(t).then((ok) => showHintRef.current(ok ? '✓ 已写入系统剪贴板' : '写入失败（需 https / 已授权）'));
  }

  function saveDraft(v: string) {
    setDraft(v);
    try { localStorage.setItem(draftKey, v); } catch {}
  }

  // Remove one clip from the relay list (and persist).
  function deleteClip(id: number) {
    setClips((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveClips(gid, windowName, next);
      return next;
    });
    setClipEdit((e) => (e && e.id === id ? null : e));
  }

  // Send a clip's text into claude as a single bracketed paste (multi-line stays one paste,
  // not submitted line-by-line). Returns false (with a hint) if the socket is down.
  function sendClipText(text: string) {
    if (!sendInputRef.current('\x1b[200~' + text + '\x1b[201~')) {
      showHintRef.current('连接已断开，无法发送');
      return;
    }
    setClipEdit(null);
    setClipListOpen(false);
    if (!mobileRef.current) termRef.current?.focus();
    showHintRef.current('已发送到 claude');
  }

  // Send the draft as a single bracketed paste so multi-line text is inserted (not submitted
  // line-by-line) in apps like claude. `submit` appends a trailing Enter OUTSIDE the paste so
  // claude runs the prompt immediately ("直发 claude"); without it the text just lands in claude's
  // input line for review ("插入不发送"). Empty draft sends nothing (no accidental blank submit).
  function sendDraft(submit = false) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setSendErr('连接已断开，无法发送（草稿已保存，可稍后重试）');
      return; // keep the editor open so the text isn't silently dropped
    }
    if (draft) ws.send(JSON.stringify({ type: 'input', data: '\x1b[200~' + draft + '\x1b[201~' + (submit ? '\r' : '') }));
    setSendErr('');
    setEditorOpen(false);
    termRef.current?.focus();
  }

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: composeFont(fontFamily),
      // Persisted so the A+/A− zoom carries across tabs/reloads. Pooled instances stay mounted
      // across switches, so the [active] effect re-reads this on every re-activation.
      fontSize: Number(localStorage.getItem('tmuxdash:fontSize')) || 13,
      theme: { background: '#1a1b26', foreground: '#c0caf5' },
      scrollback: 5000,
      allowProposedApi: true,
      // A plain drag selects text locally (we strip the app's mouse enables). Holding
      // Alt/Option instead forwards the click/drag to the app (claude) as mouse events — so
      // this must be false, otherwise xterm would steal Option-drag for a forced selection.
      macOptionClickForcesSelection: false,
      // (rightClickSelectsWord removed: on mobile a long-press fires contextmenu, which this
      // turned into an auto word-selection — blocking proper range selection. Drag-copy covers it.)
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);

    // Unicode 11 width tables. xterm's default (V6) mis-widths many emoji and symbols as 1 cell,
    // while tmux (and the apps under it, e.g. claude's status line) treat them as 2 — the mismatch
    // is what makes emoji rows "挤在一起"/misalign. Activating v11 lines xterm's wcwidth up with
    // tmux so cells stay in register.
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
    } catch { /* width tables stay at the default V6 */ }

    term.open(ref.current!);

    // Mobile: stop a tap on the CLI from popping the OS soft keyboard. xterm focuses a helper
    // textarea on tap; inputmode="none" tells mobile browsers not to raise a keyboard for it, so
    // the terminal stays scroll/select-only and input goes through the on-screen keyboard / editor
    // buttons instead. Toggled live by the mobile effect below.
    const applyMobileInput = (on: boolean) => {
      const ta = term.textarea;
      if (!ta) return;
      if (on) ta.setAttribute('inputmode', 'none');
      else ta.removeAttribute('inputmode');
    };
    applyMobileInputRef.current = applyMobileInput;
    applyMobileInput(mobileRef.current);

    // GPU/canvas renderer so block & box-drawing glyphs tile seamlessly.
    let renderer = false;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
      term.loadAddon(webgl);
      renderer = true;
    } catch { /* try canvas */ }
    if (!renderer) {
      try { term.loadAddon(new CanvasAddon()); } catch { /* DOM fallback */ }
    }

    // OSC 52 clipboard writes (claude's copy) route into the clipboard relay list + auto-copy.
    // readText is intentionally a no-op: never let terminal-driven OSC 52 *read* queries
    // pull the host clipboard back into the pty (that would let rendered output
    // exfiltrate the user's clipboard).
    const clipboardProvider = {
      readText: async () => '',
      writeText: async (_sel: unknown, data: string) => { onOsc52Ref.current(data); },
    };
    try { term.loadAddon(new ClipboardAddon(clipboardProvider as never)); } catch {}

    try { fit.fit(); } catch {}

    // ── Image input (paste / drag-drop) ──────────────────────────────────────────────────────
    // claude has no OS clipboard on the server, so it can't take a pasted image directly. Instead we
    // upload the image bytes to a server temp file and inject its absolute path into the pane as a
    // bracketed paste (no Enter). claude auto-detects .png/.jpg/.gif/.webp paths in the prompt and
    // attaches the image — the user can add a note, then press Enter. Reached from Ctrl+V /
    // Ctrl+Shift+V / Cmd+V (async clipboard API) and from a drag-drop / context-menu paste.
    const IMAGE_MIME_EXT: Record<string, string> = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    };
    const uploadImage = async (blob: Blob) => {
      if (blob.size > 32 * 1024 * 1024) { showHintRef.current('图片过大（>32MB），未上传'); return; }
      const ext = IMAGE_MIME_EXT[blob.type] || 'png';
      showHintRef.current('图片上传中…');
      try {
        const r = await postRaw(`/fs/paste-image?gid=${gid}&window=${encodeURIComponent(windowName)}&ext=${ext}`, blob);
        if (r?.path) {
          sendInputRef.current('\x1b[200~' + r.path + ' \x1b[201~'); // trailing space so a prompt won't glue on
          showHintRef.current('图片已插入路径，可补充说明后回车发给 claude');
        } else showHintRef.current('图片上传失败');
      } catch (err) { showHintRef.current('图片上传失败：' + (err as Error).message); }
    };
    // Pull image blobs out of a clipboard / drag payload (items first, then files).
    const imagesFrom = (dt: DataTransfer | null): Blob[] => {
      const out: Blob[] = [];
      if (!dt) return out;
      for (const it of Array.from(dt.items || [])) {
        if (it.kind === 'file' && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) out.push(f); }
      }
      if (!out.length) for (const f of Array.from(dt.files || [])) if (f.type.startsWith('image/')) out.push(f);
      return out;
    };
    // Ctrl+V/Ctrl+Shift+V path: try the async clipboard for an image. Returns true if it uploaded
    // one, so the caller can otherwise fall back to text paste / the nudge.
    const tryClipboardImage = async (): Promise<boolean> => {
      try {
        if (!navigator.clipboard?.read) return false;
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const t = it.types.find((x) => x.startsWith('image/'));
          if (t) { await uploadImage(await it.getType(t)); return true; }
        }
      } catch { /* unavailable / denied → caller falls back */ }
      return false;
    };
    const readTextAndPaste = () => {
      navigator.clipboard?.readText?.()
        .then((text) => { if (text) termRef.current?.paste(text); })
        .catch(() => showHintRef.current('无法读取剪贴板（需 https/已授权）'));
    };

    // Intercept Ctrl+G (multi-line editor), Cmd/Ctrl+Shift+C (copy), and paste shortcuts.
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'g' || e.key === 'G')) {
        if (e.type === 'keydown') { e.preventDefault(); openEditorRef.current(); }
        return false;
      }
      // Cmd+C copies the xterm selection (Ctrl+Shift+C is avoided — it opens browser
      // DevTools). Claude's own select-to-copy arrives via OSC 52 (handled separately).
      const isCopy = e.metaKey && (e.key === 'c' || e.key === 'C');
      if (isCopy && term.hasSelection()) {
        if (e.type === 'keydown') { e.preventDefault(); copyText(term.getSelection()); pendingClipRef.current = ''; }
        return false;
      }
      // Paste: Ctrl/Cmd+Shift+V reads the clipboard and pastes (bracketed) into the app.
      const isPaste = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V');
      if (isPaste) {
        if (e.type === 'keydown') {
          e.preventDefault();
          // An image in the clipboard is uploaded + injected; otherwise fall back to text paste.
          tryClipboardImage().then((did) => { if (!did) readTextAndPaste(); });
        }
        return false;
      }
      // Plain Ctrl+V: paste a clipboard image if present; otherwise nudge to Ctrl+Shift+V for text.
      if (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
        if (e.type === 'keydown') {
          e.preventDefault();
          tryClipboardImage().then((did) => { if (!did) showHintRef.current('粘贴请用 Ctrl+Shift+V'); });
        }
        return false;
      }
      return true;
    });

    // Copy-on-select: when the user finishes a local xterm selection (Option+drag works
    // even while claude has mouse mode on), copy it. This runs inside the mouseup user
    // gesture, so it succeeds even on a plain http LAN origin (unlike OSC52 copies, which
    // arrive in a WebSocket event with no user activation and get blocked by the browser).
    const el = ref.current;
    const onMouseUp = () => {
      const sel = term.getSelection();
      if (sel) { copyText(sel); pendingClipRef.current = ''; } // a manual copy supersedes a pending claude one
    };
    el?.addEventListener('mouseup', onMouseUp);

    // Flush a claude copy that the browser blocked from the system clipboard: the next user gesture
    // (a click or keypress, anywhere) supplies the activation the write needs. Cheap no-op when
    // nothing is pending. Passive — never preventDefault/stopPropagation, so it's transparent.
    const flushPendingClip = () => {
      if (!activeRef.current) return; // pool: only the visible tab may write the system clipboard
      const t = pendingClipRef.current;
      if (!t) return;
      pendingClipRef.current = '';
      writeSysClip(t).then((ok) => { if (ok) showHintRef.current('✓ 已写入系统剪贴板'); else pendingClipRef.current = t; });
    };
    window.addEventListener('pointerdown', flushPendingClip, true);
    window.addEventListener('keydown', flushPendingClip, true);
    // 'focus' non-capture → only the window's own focus (returning to the tab; Chrome allows a focused
    // write). A wheel flush was intentionally dropped: scrolling grants no user activation, so a write
    // from it can only ever fail — and would re-arm pending and churn on every scroll tick.
    window.addEventListener('focus', flushPendingClip);

    // Image intake via a context-menu paste or a drag-drop onto the terminal (Ctrl+V / Ctrl+Shift+V
    // go through the key handler's tryClipboardImage instead). Text paste/drag is left untouched.
    const onPasteEvt = (e: ClipboardEvent) => {
      const imgs = imagesFrom(e.clipboardData);
      if (imgs.length) { e.preventDefault(); e.stopPropagation(); imgs.forEach((b) => uploadImage(b)); }
    };
    const onDragOverEvt = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some((i) => i.kind === 'file')) e.preventDefault();
    };
    const onDropEvt = (e: DragEvent) => {
      const dt = e.dataTransfer;
      const hasFiles = !!dt && (Array.from(dt.items || []).some((i) => i.kind === 'file') || (dt.files?.length ?? 0) > 0);
      if (!hasFiles) return;                       // not a file drop → leave text/other drops alone
      e.preventDefault(); e.stopPropagation();     // stop the browser from navigating to the dropped file
      const imgs = imagesFrom(dt);
      if (imgs.length) imgs.forEach((b) => uploadImage(b));
      else showHintRef.current('仅支持拖入图片');
    };
    el?.addEventListener('paste', onPasteEvt, true);
    el?.addEventListener('dragover', onDragOverEvt);
    el?.addEventListener('drop', onDropEvt);

    // Forward the wheel to the app (claude) while it has mouse reporting on, so it scrolls
    // its own view even though we stripped its mouse-enable to keep drag-selection working.
    // At a plain shell (no app mouse mode) — or with Shift held (terminal convention to
    // reach the local scrollback past an app that grabbed the mouse) — we leave the wheel
    // alone, so xterm scrolls its own scrollback. Capture phase + stopPropagation pre-empts
    // xterm's own wheel handler.
    // Build `n` SGR (1006) wheel reports in `dir` (-1 up / +1 down) at cell (col,row). We
    // ONLY ever emit SGR — never legacy X10 (ESC[M + raw bytes), whose coordinate bytes leak
    // as literal keystrokes (e.g. "IIJJ;;LL") if they reach a program not in mouse mode.
    // Forwarding is gated on sgrMouseRef, so we send only when the app negotiated SGR.
    const wheelSeq = (dir: number, n: number, col: number, row: number) => {
      const btn = dir < 0 ? 64 : 65;                  // 64 = wheel up, 65 = wheel down
      let s = '';
      for (let i = 0; i < n; i++) s += `\x1b[<${btn};${col};${row}M`;
      return s;
    };

    // The app wants SGR wheel reports if it has the mouse + SGR on now, OR had them on earlier
    // in this alternate-screen session (sticky). Using the sticky flag means a reconnect/redraw
    // desync (live flags momentarily false) doesn't drop us back to xterm's wheel→arrow-keys
    // fallback while claude is still up. A program that only ever spoke X10 (no 1006) stays
    // false here, so we never inject SGR bytes it can't parse.
    const wantSgrWheel = () =>
      (appMouseRef.current || appMouseSeenRef.current) && (sgrMouseRef.current || sgrSeenRef.current);

    // The app gets its wheel forwarded ONLY when it's actually on the alternate screen AND we've
    // seen it turn on mouse+SGR. Gating on the alt screen (not just the sticky flag) is what stops
    // a stale "mouse seen" flag — left over when a prior claude was torn down without us seeing its
    // alt-screen-exit reset — from hijacking the wheel of the plain shell that replaced it: a normal
    // buffer's scrollback lives in tmux, so it must always route there regardless of the flag.
    const forwardWheelToApp = () =>
      wantSgrWheel() && termRef.current?.buffer.active.type === 'alternate';

    // Scroll the pane `n` steps in `dir`. Three cases, by what owns the screen:
    //  · plain shell (normal buffer) → its scrollback lives in tmux, not xterm, so ask the server
    //    to scroll the viewer's copy-mode history (checked FIRST, so a stale flag can't divert it);
    //  · alt-screen app that grabbed the mouse (claude) → forward a synthetic SGR wheel;
    //  · alt-screen app without mouse (less/man) → scroll xterm's own buffer.
    // Shared by the wheel handler and the on-screen scroll buttons.
    const scrollBy = (dir: number, n: number) => {
      const t = termRef.current;
      if (!t) return;
      const sock = wsRef.current;
      const ready = sock && sock.readyState === WebSocket.OPEN;
      if (t.buffer.active.type === 'normal') {          // plain shell → tmux copy-mode history
        if (ready) sock!.send(JSON.stringify({ type: 'scroll', dir, n }));
        return;
      }
      if (!forwardWheelToApp()) {                        // alt-screen app w/o mouse → xterm's buffer
        t.scrollLines(dir * n);
        return;
      }
      if (!ready) return;
      const col = Math.max(1, Math.floor(t.cols / 2)); // app only cares about wheel direction
      const row = Math.max(1, Math.floor(t.rows / 2));
      sock!.send(JSON.stringify({ type: 'input', data: wheelSeq(dir, n, col, row) }));
    };
    scrollByRef.current = scrollBy;

    let wheelAccum = 0;
    const onWheel = (e: WheelEvent) => {
      const t = termRef.current;
      const sock = wsRef.current;
      const box = ref.current;
      if (e.shiftKey || !e.deltaY || !t || !box || !sock || sock.readyState !== WebSocket.OPEN) return;
      const shell = t.buffer.active.type === 'normal'; // plain shell → tmux copy-mode scroll
      const appMouse = !shell && forwardWheelToApp();   // alt-screen app w/ mouse → SGR wheel
      // A normal buffer always scrolls tmux (even if a stale mouse flag lingers — a plain shell
      // never wants the wheel as mouse). Otherwise (alt-screen app without mouse, e.g. less/man)
      // bail and let xterm's own alternate-scroll turn the wheel into arrow keys — which they expect.
      if (!appMouse && !shell) return;
      const rect = box.getBoundingClientRect();
      const cellH = t.rows ? rect.height / t.rows : 0;
      const cellW = t.cols ? rect.width / t.cols : 0;
      if (!cellH || !cellW) return;                   // pane not laid out yet
      e.preventDefault();
      e.stopPropagation();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= cellH;             // delta in lines
      else if (e.deltaMode === 2) dy *= rect.height;  // delta in pages
      if ((dy > 0) !== (wheelAccum > 0)) wheelAccum = 0; // reset on direction change
      wheelAccum += dy;
      const lines = Math.trunc(wheelAccum / cellH);
      if (!lines) return;
      const dir = lines < 0 ? -1 : 1;
      const n = Math.min(Math.abs(lines), 5);         // cap the burst per event
      wheelAccum -= dir * n * cellH;                  // drain only what we send; carry the rest
      const cap = 5 * cellH;                          // ...but keep the carry bounded
      wheelAccum = Math.max(-cap, Math.min(cap, wheelAccum));
      if (appMouse) {
        const col = Math.max(1, Math.min(t.cols, Math.floor((e.clientX - rect.left) / cellW) + 1));
        const row = Math.max(1, Math.min(t.rows, Math.floor((e.clientY - rect.top) / cellH) + 1));
        sock.send(JSON.stringify({ type: 'input', data: wheelSeq(dir, n, col, row) }));
      } else {
        sock.send(JSON.stringify({ type: 'scroll', dir, n }));
      }
    };
    el?.addEventListener('wheel', onWheel, { capture: true, passive: false });

    // Alt/Option + drag forwards a real click/drag to the app (claude) as SGR mouse reports, so
    // you can use its mouse UI. Plain drag (no modifier) stays a local selection (copy-on-select).
    // Only active when the app actually requested the mouse (sticky SGR state). The down/up
    // handlers stopPropagation in the capture phase so xterm starts no selection and the
    // copy-on-select mouseup is skipped for this gesture; move/up live on window so a drag that
    // leaves the terminal still tracks.
    const cellAt = (clientX: number, clientY: number) => {
      const t = termRef.current; const box = ref.current;
      if (!t || !box) return null;
      const r = box.getBoundingClientRect();
      const cw = t.cols ? r.width / t.cols : 0;
      const ch = t.rows ? r.height / t.rows : 0;
      if (!cw || !ch) return null;
      return {
        col: Math.max(1, Math.min(t.cols, Math.floor((clientX - r.left) / cw) + 1)),
        row: Math.max(1, Math.min(t.rows, Math.floor((clientY - r.top) / ch) + 1)),
      };
    };
    const sendMouse = (cb: number, col: number, row: number, press: boolean) => {
      const sock = wsRef.current;
      if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: 'input', data: `\x1b[<${cb};${col};${row}${press ? 'M' : 'm'}` }));
      }
    };
    let lastCell = { col: 0, row: 0 };
    const onMouseDownFwd = (e: MouseEvent) => {
      if (!e.altKey || e.button !== 0 || !forwardWheelToApp()) return;
      const c = cellAt(e.clientX, e.clientY); if (!c) return;
      e.preventDefault(); e.stopPropagation();
      mouseFwdRef.current = true; lastCell = c;
      sendMouse(0, c.col, c.row, true);             // left-button press
    };
    const onMouseMoveFwd = (e: MouseEvent) => {
      if (!mouseFwdRef.current) return;
      const c = cellAt(e.clientX, e.clientY); if (!c) return;
      if (c.col === lastCell.col && c.row === lastCell.row) return; // one report per cell
      lastCell = c;
      sendMouse(32, c.col, c.row, true);            // motion with button 0 held (drag)
    };
    const onMouseUpFwd = (e: MouseEvent) => {
      if (!mouseFwdRef.current) return;
      const c = cellAt(e.clientX, e.clientY) || lastCell;
      e.preventDefault(); e.stopPropagation();
      sendMouse(0, c.col, c.row, false);            // release
      mouseFwdRef.current = false;
    };
    el?.addEventListener('mousedown', onMouseDownFwd, true);
    window.addEventListener('mousemove', onMouseMoveFwd, true);
    window.addEventListener('mouseup', onMouseUpFwd, true);

    // Touch range-selection, active ONLY in "select mode" (toggled from the tab bar). The
    // terminal is canvas-rendered, so a long-press has no DOM text to grab — instead we map a
    // one-finger drag to an xterm cell selection (in buffer coords, so it tracks scrollback) and
    // copy on release. Off by default, so normal touch keeps scrolling/typing untouched.
    let selAnchor: { col: number; row: number } | null = null;
    const onTouchStartSel = (e: TouchEvent) => {
      if (!selectModeRef.current || e.touches.length !== 1) return;
      const c = cellAt(e.touches[0].clientX, e.touches[0].clientY);
      if (!c) return;
      selAnchor = c;
      try { term.clearSelection(); } catch {}
    };
    const onTouchMoveSel = (e: TouchEvent) => {
      if (!selectModeRef.current || !selAnchor || e.touches.length !== 1) return;
      const c = cellAt(e.touches[0].clientX, e.touches[0].clientY);
      if (!c) return;
      e.preventDefault(); // stop the viewport from scrolling while we select
      const cols = term.cols;
      const vy = term.buffer.active.viewportY; // top buffer line of the visible area
      const aOff = (vy + selAnchor.row - 1) * cols + (selAnchor.col - 1);
      const bOff = (vy + c.row - 1) * cols + (c.col - 1);
      const start = Math.min(aOff, bOff);
      const len = Math.abs(bOff - aOff) + 1;
      try { term.select(start % cols, Math.floor(start / cols), len); } catch {}
    };
    const onTouchEndSel = (e: TouchEvent) => {
      if (!selectModeRef.current || !selAnchor) return;
      selAnchor = null;
      const sel = term.getSelection();
      if (sel) {
        e.preventDefault(); // swallow the synthesized click so it doesn't clear the selection / pop the keyboard
        copyText(sel);
        pendingClipRef.current = '';
        showHintRef.current('已复制所选文字');
      }
    };
    // The OS can pre-empt a touch (incoming call, gesture handoff) with touchcancel instead of
    // touchend — drop the anchor and clear the half-drawn selection so no phantom lingers.
    const onTouchCancelSel = () => {
      if (!selAnchor) return;
      selAnchor = null;
      try { term.clearSelection(); } catch {}
    };
    el?.addEventListener('touchstart', onTouchStartSel, { passive: true });
    el?.addEventListener('touchmove', onTouchMoveSel, { passive: false });
    el?.addEventListener('touchend', onTouchEndSel);
    el?.addEventListener('touchcancel', onTouchCancelSel);

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // Built per-connect (not once): the server spawns the viewer pty at the cols/rows in the url,
    // and a pooled tab can reconnect long after mount (server restart while hidden) — always hand
    // it the grid xterm currently has, not the mount-time one.
    const wsUrl = () =>
      `${proto}://${location.host}/ws/terminal?token=${encodeURIComponent(getToken() || '')}` +
      `&gid=${gid}&window=${encodeURIComponent(windowName)}&cols=${term.cols}&rows=${term.rows}`;
    // Reconnect bookkeeping (see connect() below).
    let reconnectTimer: number | undefined;
    let retries = 0;
    let disposed = false;

    // Track the app's mouse state from its raw output, applying every token in order. We keep
    // the set of active tracking modes (1000/1002/1003) so the app still "wants the mouse" as
    // long as ANY is on — an asymmetric partial disable (e.g. 1002h then 1000l) can't wrongly
    // drop it. Alt-screen exit / RIS clears everything, so an app that quit without disabling
    // can't leave us forwarding.
    const mouseModes = new Set<string>();
    const trackMouseState = (data: string) => {
      let m2: RegExpExecArray | null;
      MOUSE_STATE_RE.lastIndex = 0;
      while ((m2 = MOUSE_STATE_RE.exec(data))) {
        if (m2[1] === '1006') {
          sgrMouseRef.current = m2[2] === 'h';
          if (m2[2] === 'h') sgrSeenRef.current = true;            // sticky: SGR seen this alt session
        } else if (m2[1]) {                                        // 1000/1002/1003
          if (m2[2] === 'h') { mouseModes.add(m2[1]); appMouseSeenRef.current = true; }
          else mouseModes.delete(m2[1]);
          appMouseRef.current = mouseModes.size > 0;
        } else {                                                   // alt-screen exit / RIS: full reset
          mouseModes.clear();
          appMouseRef.current = false; sgrMouseRef.current = false;
          appMouseSeenRef.current = false; sgrSeenRef.current = false;
        }
      }
    };

    // Connect, and auto-reconnect with backoff if the socket drops (e.g. the server restarts),
    // so the terminal re-attaches to the same window without a manual reload.
    let osc52Carry = '';
    const connect = () => {
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'output') {
            trackMouseState(m.data);
            // Capture claude's OSC 52 copies straight from the stream (reliable path; the
            // ClipboardAddon misses tmux-rewritten/empty-selection and frame-split sequences).
            const { texts, carry } = extractOsc52(m.data, osc52Carry);
            osc52Carry = carry;
            for (const t of texts) onOsc52Ref.current(t);
            // Always strip the app's mouse-tracking enables so xterm stays out of mouse mode
            // and a plain drag selects text locally; the wheel is forwarded back separately.
            term.write(m.data.replace(MOUSE_ENABLE_RE, ''));
          } else if (m.type === 'error') {
            term.write(`\r\n\x1b[31m[错误] ${m.data}\x1b[0m\r\n`);
          }
        } catch {}
      };
      // Don't auto-focus on mobile — focusing is the "enter input state" we're suppressing there.
      ws.onopen = () => {
        retries = 0;
        doFit();
        // Hidden pooled tab: the fit above was guard-skipped — still sync the fresh pty to the
        // grid xterm already has, so output buffered while hidden wraps at the right width.
        try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch { /* not open */ }
        if (!mobileRef.current && activeRef.current) term.focus();
      };
      ws.onclose = () => {
        if (disposed) return;
        try { term.write('\r\n\x1b[33m[连接断开，重连中…]\x1b[0m\r\n'); } catch {}
        reconnectTimer = window.setTimeout(connect, Math.min(4000, 400 * 2 ** retries));
        retries += 1;
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    };

    const dataSub = term.onData((d) => {
      const s = wsRef.current;
      if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: 'input', data: d }));
    });

    // Raw-input sender for the on-screen keyboard and the clipboard "发送". Returns whether the
    // socket accepted it (so callers can surface a "连接已断开" hint instead of silently dropping).
    sendInputRef.current = (data: string) => {
      const s = wsRef.current;
      if (s && s.readyState === WebSocket.OPEN) { s.send(JSON.stringify({ type: 'input', data })); return true; }
      return false;
    };

    const doFit = () => {
      // Pool: never fit while hidden (display:none → 0×0) — FitAddon would propose a tiny grid
      // and we'd shrink the remote tmux window to ~2×1 under the running app. The ResizeObserver
      // plus the `active` effect refit the moment the tab is shown again.
      const host = ref.current;
      if (!host || host.clientWidth < 20 || host.clientHeight < 20) return;
      try {
        fit.fit();
        setRows(term.rows); // keep the displayed row count (and auto steps) in sync
        const s = wsRef.current;
        if (s && s.readyState === WebSocket.OPEN) {
          s.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {}
    };

    // Zoom the terminal font by ±1px (clamped), persist it, then refit so cols/rows + the
    // remote pty size follow the new glyph size.
    const changeFont = (delta: number) => {
      const cur = term.options.fontSize ?? 13;
      const next = Math.max(8, Math.min(32, cur + delta));
      if (next === cur) return;
      term.options.fontSize = next;
      try { localStorage.setItem('tmuxdash:fontSize', String(next)); } catch {}
      doFit();
    };
    changeFontRef.current = changeFont;
    doFitRef.current = doFit;
    const ro = new ResizeObserver(() => doFit());
    if (ref.current) ro.observe(ref.current);

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ro.disconnect();
      dataSub.dispose();
      el?.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('pointerdown', flushPendingClip, true);
      window.removeEventListener('keydown', flushPendingClip, true);
      window.removeEventListener('focus', flushPendingClip);
      el?.removeEventListener('paste', onPasteEvt, true);
      el?.removeEventListener('dragover', onDragOverEvt);
      el?.removeEventListener('drop', onDropEvt);
      el?.removeEventListener('wheel', onWheel, true);
      el?.removeEventListener('mousedown', onMouseDownFwd, true);
      window.removeEventListener('mousemove', onMouseMoveFwd, true);
      window.removeEventListener('mouseup', onMouseUpFwd, true);
      el?.removeEventListener('touchstart', onTouchStartSel);
      el?.removeEventListener('touchmove', onTouchMoveSel);
      el?.removeEventListener('touchend', onTouchEndSel);
      el?.removeEventListener('touchcancel', onTouchCancelSel);
      try { wsRef.current?.close(); } catch {}
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }, [gid, windowName]);

  // Apply a terminal-font change live (the terminal is created once per tab, so a settings
  // change must update the existing instance and refit, not wait for a remount).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = composeFont(fontFamily);
    doFitRef.current();
  }, [fontFamily]);

  // Apply mobile soft-keyboard suppression live when the flag flips; blur the terminal when
  // turning it on so any keyboard already up is dismissed, and close the on-screen keyboard.
  useEffect(() => {
    applyMobileInputRef.current(mobile);
    if (mobile) { try { termRef.current?.blur(); } catch {} }
    else setKbdOpen(false);
  }, [mobile]);

  // Pool activation/deactivation. Deactivation cancels any pending system-clipboard write — the
  // relay list keeps the text, and a stale flush on return would clobber whatever the user copied
  // in the meantime (it also starves the bounded retry loop). Re-activation re-syncs the font zoom
  // (A+/A− in another tab updates localStorage, not this mounted instance), refits (the container
  // was 0×0 while hidden, all fits skipped), and refocuses — unless a restored floating panel is
  // open, which should keep receiving the keystrokes instead of the pty behind it.
  useEffect(() => {
    if (!active) {
      pendingClipRef.current = '';
      return;
    }
    const term = termRef.current;
    const fs = Number(localStorage.getItem('tmuxdash:fontSize')) || 13;
    if (term && term.options.fontSize !== fs) term.options.fontSize = fs;
    doFitRef.current();
    if (!mobileRef.current && overlayStackRef.current.length === 0) term?.focus();
  }, [active]);

  // The on-screen keyboard docks below the terminal, so opening/closing it changes the CLI
  // height — refit so cols/rows and the remote pty follow.
  useEffect(() => { doFitRef.current(); }, [kbdOpen]);

  // Probe the open clip's text against the filesystem: if it's a path to a real file (absolute, or
  // relative to claude's pane cwd), fetch its content for the preview split. Debounced so editing
  // the text doesn't spam the server; cancelled on change/close so a stale response can't land.
  useEffect(() => {
    if (!clipEdit) { setFileView({ status: 'idle' }); return; }
    const cand = filePathCandidate(clipEdit.text);
    if (!cand) { setFileView({ status: 'none' }); return; }
    let cancelled = false;
    // Keep an already-resolved preview on screen while re-probing (an edit reruns this effect on
    // every keystroke) — flashing 'loading' would collapse the split, jump the textarea height,
    // and close/reopen the magnify reader. Returning the same object also lets React skip the
    // re-render, so the MD-default effect below doesn't re-fire on a same-file re-probe.
    setFileView((prev) => (prev.status === 'ok' ? prev : { status: 'loading' }));
    const timer = window.setTimeout(async () => {
      try {
        const q = `/fs/file?path=${encodeURIComponent(cand)}&gid=${gid}&window=${encodeURIComponent(windowName)}`;
        const r = await api.get(q);
        if (cancelled) return;
        if (r?.exists && r.isFile && !r.error) setFileView({ status: 'ok', ...r });
        else if (r?.error) setFileView({ status: 'error', error: r.error }); // stat ok but read failed
        else setFileView({ status: 'none' });
      } catch (e) {
        if (!cancelled) setFileView({ status: 'error', error: (e as Error).message });
      }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [clipEdit, gid, windowName]);

  // Default the MD toggle to on for Markdown files, but only when a *new* file loads — so a manual
  // toggle isn't undone by an unrelated re-probe (e.g. an edit that resolves to the same file).
  useEffect(() => {
    if (fileView.status === 'ok' && fileView.path && fileView.path !== lastFilePathRef.current) {
      lastFilePathRef.current = fileView.path;
      setFileMd(isMarkdownPath(fileView.path));
    } else if (fileView.status === 'idle' || fileView.status === 'none' || fileView.status === 'error') {
      lastFilePathRef.current = null; // terminal non-file states only — NOT the transient 'loading'
    }
  }, [fileView]);

  // The magnify reader is tied to the current preview: close it whenever the file context is lost
  // (clip closed, or the text no longer resolves to a file) so it can't silently reappear later.
  useEffect(() => { if (fileView.status !== 'ok') setFileZoom(false); }, [fileView.status]);

  // Press-and-hold a scroll button: scroll once immediately, then auto-repeat while held.
  const repeatRef = useRef<{ t?: number; i?: number }>({});
  function stopRepeat() {
    if (repeatRef.current.t) window.clearTimeout(repeatRef.current.t);
    if (repeatRef.current.i) window.clearInterval(repeatRef.current.i);
    repeatRef.current = {};
  }
  function startRepeat(dir: number, n: number) {
    stopRepeat();
    scrollByRef.current(dir, n);
    repeatRef.current.t = window.setTimeout(() => {
      // Gate each tick on `active`: if the slot is hidden mid-hold (multi-input edge: a touch tap
      // on another tab while the mouse holds an arrow), mouseleave never fires on a display:none
      // element and the repeat would otherwise scroll the hidden viewer forever.
      repeatRef.current.i = window.setInterval(() => { if (activeRef.current) scrollByRef.current(dir, n); }, 110);
    }, 320);
  }
  useEffect(() => stopRepeat, []);
  useEffect(() => () => { if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current); }, []);

  // Press-and-hold button handlers that work for both mouse and touch. On touch we preventDefault
  // in touchEnd so the browser doesn't synthesize the compatibility mouse/click events that would
  // otherwise focus the terminal and pop the mobile soft keyboard ("输入模式").
  const holdHandlers = (dir: number, n: number) => ({
    onMouseDown: () => startRepeat(dir, n),
    onMouseUp: stopRepeat,
    onMouseLeave: stopRepeat,
    onTouchStart: () => startRepeat(dir, n),
    onTouchEnd: (e: ReactTouchEvent) => { e.preventDefault(); stopRepeat(); },
  });
  // Single-tap button handlers (same no-keyboard behavior on touch).
  const tapHandlers = (fn: () => void) => ({
    onMouseDown: fn,
    onTouchStart: fn,
    onTouchEnd: (e: ReactTouchEvent) => e.preventDefault(),
  });

  // The read-only file content: Markdown-rendered or raw, plus binary/truncated notes. Shared by
  // the inline preview split and the zoom (magnify) floating reader.
  const fileBody = () => {
    if (fileView.status !== 'ok') return null;
    if (fileView.binary) return <div className="file-note">二进制文件，无法预览（{fmtSize(fileView.size)}）。</div>;
    const content = fileView.content || '';
    return (
      <div className="file-viewer">
        {fileMd && content ? (
          <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
        ) : (
          <pre className="file-pre">{content || '（空文件）'}</pre>
        )}
        {fileView.truncated && <div className="file-note">文件较大，仅显示前一部分（共 {fmtSize(fileView.size)}）。</div>}
      </div>
    );
  };

  return (
    <>
      <div className="term-col">
        <div className={`term-wrap${selectMode ? ' select-mode' : ''}`}>
          <div className="terminal" ref={ref} />
          {hint && <div className="term-hint">{hint}</div>}
          {/* Right-middle rail: font zoom (A+/A−) above the scroll buttons. Press-and-hold the
              arrows to auto-repeat. onMouseDown preventDefault (desktop) and touchEnd preventDefault
              (mobile) keep taps from stealing focus / popping the soft keyboard. */}
          <div className="scroll-rail" onMouseDown={(e) => e.preventDefault()}>
            <button className="font-btn" title="增大文字" tabIndex={-1} {...tapHandlers(() => changeFontRef.current(1))}>A+</button>
            <button className="font-btn" title="缩小文字" tabIndex={-1} {...tapHandlers(() => changeFontRef.current(-1))}>A−</button>
            <button title={`上滚 ${effBig} 行（可长按）`} tabIndex={-1} {...holdHandlers(-1, effBig)}>▲▲</button>
            <button title={`上滚 ${effSmall} 行（可长按）`} tabIndex={-1} {...holdHandlers(-1, effSmall)}>▲</button>
            <span className="scroll-rows" title={`当前终端行数：${rows}${scrollAuto ? ` · 自动步进 小${effSmall}/大${effBig}` : ''}`}>{rows}</span>
            <button title={`下滚 ${effSmall} 行（可长按）`} tabIndex={-1} {...holdHandlers(1, effSmall)}>▼</button>
            <button title={`下滚 ${effBig} 行（可长按）`} tabIndex={-1} {...holdHandlers(1, effBig)}>▼▼</button>
          </div>

          {/* Clipboard relay list: the app's OSC 52 copies, held here so nothing is lost when the
              system-clipboard write is blocked. Tap a row to view/edit and 发送 into claude. */}
          {clipListOpen && (
            <div className="clip-panel" onMouseDown={(e) => e.preventDefault()}>
              <div className="clip-head">
                <span>剪贴板 · {clips.length} 条</span>
                <span className="clip-head-actions">
                  {clips.length > 0 && (
                    <button className="clip-x" title="清空" onClick={() => { setClips([]); saveClips(gid, windowName, []); }}>清空</button>
                  )}
                  <button className="clip-x" title="关闭" onClick={() => setClipListOpen(false)}>×</button>
                </span>
              </div>
              {clips.length > 0 && (
                <button className="clip-write-sys" onClick={writeLatestToSysClip}
                  title="把最新一条写入系统剪贴板（点击即完成手势写入，claude 复制无法自动写入系统剪贴板时用它）">
                  📥 写入系统剪贴板（最新一条）
                </button>
              )}
              {clips.length === 0 ? (
                <div className="clip-empty">还没有捕获到复制内容。<br />claude 里 /copy 或选中文字自动复制后会出现在这里。</div>
              ) : (
                <div className="clip-list">
                  {clips.map((c) => (
                    <button key={c.id} className="clip-item" onClick={() => setClipEdit({ id: c.id, text: c.text })}>
                      <span className="clip-item-text">{c.text.replace(/\s+/g, ' ').trim() || '（空白）'}</span>
                      <span className="clip-item-meta">{c.text.length}字</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Bottom-right floating buttons: clipboard (always) + mobile input entrances. */}
          <div className="cli-fab" onMouseDown={(e) => e.preventDefault()}>
            {mobile && (
              <button className="cli-fab-btn" title="多行输入（打开编辑框）" tabIndex={-1}
                {...tapHandlers(() => openEditorRef.current())}>输入</button>
            )}
            {mobile && (
              <button className={`cli-fab-btn${kbdOpen ? ' on' : ''}`} title="屏幕键盘" tabIndex={-1}
                {...tapHandlers(() => setKbdOpen((v) => !v))}>⌨</button>
            )}
            <button className={`cli-fab-btn${explorerOpen ? ' on' : ''}`} title="文件浏览器" tabIndex={-1}
              {...tapHandlers(() => setExplorerOpen((v) => !v))}>📁</button>
            {clips.length > 0 && (
              <button className="cli-fab-btn" title="把最新复制写入系统剪贴板（点击=手势，可靠写入）" tabIndex={-1}
                {...tapHandlers(() => writeLatestToSysClip())}>📥</button>
            )}
            <button className={`cli-fab-btn${clipListOpen ? ' on' : ''}`} title="剪贴板" tabIndex={-1}
              {...tapHandlers(() => setClipListOpen((v) => !v))}>
              📋{clips.length > 0 && <span className="cli-fab-badge">{clips.length}</span>}
            </button>
          </div>
        </div>

        {mobile && kbdOpen && (
          <VirtualKeyboard onKey={(d) => sendInputRef.current(d)} onClose={() => setKbdOpen(false)} />
        )}
      </div>

      {clipEdit && (
        <FloatingPanel
          title={`剪贴板内容（${clipEdit.text.length} 字符）· 可编辑后发送`}
          storageKey="tmuxdash:panel:clip"
          defaultSize={{ w: 560, h: 360 }}
          defaultOffset={36}
          onClose={() => setClipEdit(null)}
          footer={
            <>
              <button className="btn-ghost" style={{ marginRight: 'auto' }} onClick={() => deleteClip(clipEdit.id)}>删除</button>
              <button className="btn-ghost" onClick={() => copyText(clipEdit.text).then((ok) => showHintRef.current(ok ? '已复制到系统剪贴板' : '复制失败（需 https/已授权）'))}>复制</button>
              <button className="btn-primary" onClick={() => sendClipText(clipEdit.text)}>发送</button>
            </>
          }
        >
          <textarea
            className="float-textarea"
            style={fileView.status === 'ok' ? { flex: '0 1 auto', height: 92, maxHeight: '40%', minHeight: 44 } : undefined}
            autoFocus
            value={clipEdit.text}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setClipEdit({ ...clipEdit, text: e.target.value })}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendClipText(clipEdit.text); }
              else if (e.key === 'Escape') { e.preventDefault(); setClipEdit(null); }
            }}
          />
          {/* When the clip's text is a path to a real file, preview its content in a split below.
              📄 header carries the MD-render toggle and a magnify button (pops a floating reader).
              No 'loading' note: detection is quick and a candidate can be a false positive (prose
              with a slash), so we render the split only once the server confirms a real file. */}
          {fileView.status === 'error' && <div className="file-note">读取失败：{fileView.error}</div>}
          {fileView.status === 'ok' && (
            <div className="clip-file">
              <div className="clip-file-head">
                <span className="clip-file-path" title={fileView.path}>📄 {fileView.path}</span>
                <span className="clip-file-actions">
                  <button className="clip-x" title="切换 Markdown 渲染 / 原文" onClick={() => setFileMd((v) => !v)}>
                    {fileMd ? '原文' : 'MD'}
                  </button>
                  <button className="clip-x" title="放大查看（悬浮窗，可复制）" onClick={() => setFileZoom(true)}>⛶</button>
                </span>
              </div>
              {fileBody()}
            </div>
          )}
        </FloatingPanel>
      )}
      {/* Magnify: a larger, self-contained floating reader for the previewed file (view + copy). */}
      {fileZoom && fileView.status === 'ok' && (
        <FloatingPanel
          title={`文件预览 · ${fileView.path}`}
          storageKey="tmuxdash:panel:fileview"
          defaultSize={{ w: 760, h: 560 }}
          defaultOffset={72}
          onClose={() => setFileZoom(false)}
          footer={
            <>
              <button className="btn-ghost" style={{ marginRight: 'auto' }} onClick={() => setFileMd((v) => !v)}>
                {fileMd ? '原文' : 'Markdown'}
              </button>
              <button
                className="btn-ghost"
                onClick={() => copyText(fileView.content || '').then((ok) => showHintRef.current(ok ? '已复制文件内容' : '复制失败（需 https/已授权）'))}
              >
                复制全文
              </button>
            </>
          }
        >
          {fileBody()}
        </FloatingPanel>
      )}
      {editorOpen && (
        <FloatingPanel
          title="多行输入（Ctrl+G）· 草稿按选项卡自动保存"
          storageKey="tmuxdash:panel:editor"
          defaultSize={{ w: 640, h: 340 }}
          onClose={() => setEditorOpen(false)}
          footer={
            <>
              {/* Shortcut hint sits on the same row as the buttons (not inside them), on the left;
                  a send error replaces it when the socket is down. */}
              {sendErr
                ? <div className="err small" style={{ marginRight: 'auto', alignSelf: 'center' }}>{sendErr}</div>
                : <span className="editor-foot-hint">Ctrl/Cmd+Enter 直发 · Enter / Alt+Enter 换行 · Esc 关闭</span>}
              <button className="btn-ghost" onClick={() => setEditorOpen(false)}>取消</button>
              <button className="btn-ghost" title="粘贴到 claude 输入框，不自动回车（可再自行确认后回车）" onClick={() => sendDraft(false)}>插入不发送</button>
              <button className="btn-primary" title="粘贴并回车，直接提交给 claude" onClick={() => sendDraft(true)}>直发 claude</button>
            </>
          }
        >
          <textarea
            className="float-textarea"
            autoFocus
            value={draft}
            onChange={(e) => saveDraft(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter → 直发 (paste + submit). Alt+Enter and plain Enter both insert a
              // newline (Alt+Enter has no default newline, so we insert it ourselves). Esc closes.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendDraft(true); }
              else if (e.altKey && e.key === 'Enter') { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditorOpen(false); }
            }}
            placeholder="在此编辑/粘贴多行长文本。Ctrl/Cmd+Enter 直发 claude；Enter 或 Alt+Enter 换行；“插入不发送”只粘贴不回车；Esc 关闭。"
          />
        </FloatingPanel>
      )}
      {explorerOpen && (
        <FileExplorer
          gid={gid}
          windowName={windowName}
          sendInput={(d) => sendInputRef.current(d)}
          onHint={(m) => showHintRef.current(m)}
          onClose={() => setExplorerOpen(false)}
        />
      )}
    </>
  );
}

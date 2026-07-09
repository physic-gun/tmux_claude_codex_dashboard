import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { api, fetchBlob, postRaw } from '../api';
import { copyText } from '../lib/clipboard';
import { fmtSize, isMarkdownPath, renderMarkdown, type FileView } from '../lib/fileview';
import FloatingPanel from './FloatingPanel';

// ── File explorer ───────────────────────────────────────────────────────────────────────────
// A floating, draggable file manager for the host filesystem, opened from the 📁 FAB on a terminal
// and anchored (on first open) to that pane's cwd — i.e. where claude is working. Browse folders,
// one-click copy an absolute path, send a path into claude, preview text/Markdown, and manage files
// (new folder/file, rename, delete, upload, download). Talks to /api/fs; mutations are guarded
// server-side. Hosted inside TerminalView so it can send straight into the pty (paste / cd).

type Entry = {
  name: string; isDir: boolean; isFile: boolean; isSymlink: boolean; broken: boolean;
  size: number; mtimeMs: number;
};
type SortKey = 'name' | 'size' | 'mtime' | 'type';

// Join an absolute dir with a child name (root has no trailing slash to strip).
function joinPath(dir: string, name: string): string {
  return dir === '/' ? '/' + name : dir.replace(/\/+$/, '') + '/' + name;
}
// Single-quote a path for a shell `cd` (wrap, and escape any embedded single quotes).
function shellQuote(p: string): string {
  return "'" + p.replace(/'/g, "'\\''") + "'";
}
// Breadcrumb segments for the current dir, each with the absolute path to jump to.
function crumbs(dir: string): { label: string; path: string }[] {
  const out = [{ label: '/', path: '/' }];
  let acc = '';
  for (const seg of dir.split('/').filter(Boolean)) { acc += '/' + seg; out.push({ label: seg, path: acc }); }
  return out;
}

const IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'];
const ARCHIVE = ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst'];
const AUDIO = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'];
const VIDEO = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'];
function iconFor(e: Entry): string {
  if (e.isDir) return '📁';
  if (e.broken) return '⚠️';
  const ext = (e.name.includes('.') ? e.name.split('.').pop() || '' : '').toLowerCase();
  if (IMG.includes(ext)) return '🖼️';
  if (ARCHIVE.includes(ext)) return '🗜️';
  if (AUDIO.includes(ext)) return '🎵';
  if (VIDEO.includes(ext)) return '🎬';
  if (ext === 'pdf') return '📕';
  if (isMarkdownPath(e.name)) return '📝';
  return '📄';
}

// Compact mtime: "MM-DD HH:mm" within this year, else "YYYY-MM-DD".
function fmtTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === new Date().getFullYear()
    ? `${md} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getFullYear()}-${md}`;
}

// Dirs always first (by name); files by the chosen key.
function sortEntries(list: Entry[], key: SortKey): Entry[] {
  const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);
  const extOf = (e: Entry) => (e.name.includes('.') ? e.name.split('.').pop() || '' : '').toLowerCase();
  const cmp = (a: Entry, b: Entry) => {
    if (key === 'size') return b.size - a.size || byName(a, b);
    if (key === 'mtime') return b.mtimeMs - a.mtimeMs || byName(a, b);
    if (key === 'type') return extOf(a).localeCompare(extOf(b)) || byName(a, b);
    return byName(a, b);
  };
  const dirs = list.filter((e) => e.isDir).sort(byName);
  const files = list.filter((e) => !e.isDir).sort(cmp);
  return [...dirs, ...files];
}

const HIDDEN_KEY = 'tmuxdash:fx:hidden';
const SORT_KEY = 'tmuxdash:fx:sort';

export default function FileExplorer({
  gid, windowName, sendInput, onHint, onClose,
}: {
  gid: number;
  windowName: string;
  sendInput: (data: string) => boolean;
  onHint: (msg: string) => void;
  onClose: () => void;
}) {
  const [cwd, setCwd] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [addr, setAddr] = useState('');           // editable address bar (mirrors cwd, Enter = go)
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem(HIDDEN_KEY) === '1');
  const [sortKey, setSortKey] = useState<SortKey>(() => (localStorage.getItem(SORT_KEY) as SortKey) || 'name');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<{ kind: 'dir' | 'file'; value: string } | null>(null);
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [dropActive, setDropActive] = useState(false);

  // File preview (selecting a file loads it into the bottom split; ⛶ pops the magnify reader).
  const [preview, setPreview] = useState<FileView>({ status: 'idle' });
  const [previewPath, setPreviewPath] = useState('');
  const [previewMd, setPreviewMd] = useState(false);
  const [zoom, setZoom] = useState(false);
  // Draggable height of the preview split (persisted); the file list flexes to fill the rest.
  const [previewH, setPreviewH] = useState(() => Number(localStorage.getItem('tmuxdash:fx:previewH')) || 240);
  const rootRef = useRef<HTMLDivElement>(null);

  // Drag the divider between the list and the preview to resize the preview (dragging up = taller).
  const startPreviewResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = previewH;
    const rootH = rootRef.current?.clientHeight ?? 600;
    let latest = startH;
    const move = (ev: PointerEvent) => {
      latest = Math.max(90, Math.min(rootH - 170, startH + (startY - ev.clientY)));
      setPreviewH(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { localStorage.setItem('tmuxdash:fx:previewH', String(Math.round(latest))); } catch { /* ignore */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const loadSeqRef = useRef(0); // epoch so a slow list response can't overwrite a newer navigation
  const cwdRef = useRef(''); // latest cwd, so load() can tell a real navigation from a same-dir refresh
  cwdRef.current = cwd;

  const qs = useCallback(
    (extra: Record<string, string> = {}) =>
      new URLSearchParams({ gid: String(gid), window: windowName, ...extra }).toString(),
    [gid, windowName]
  );

  // Load a directory. `dir` empty → the server anchors to the pane cwd (first open / 🏠).
  const load = useCallback(async (dir?: string) => {
    const seq = ++loadSeqRef.current;
    setLoading(true); setError('');
    try {
      const extra: Record<string, string> = {};
      if (dir) extra.path = dir;
      if (showHidden) extra.hidden = '1';
      const r = await api.get(`/fs/list?${qs(extra)}`);
      if (seq !== loadSeqRef.current) return; // a newer load already superseded this one
      if (!r.ok) { setError(r.error || '无法读取目录'); setLoading(false); return; }
      // Drop a stale file preview only on a real directory change — keep it across refresh /
      // hidden-toggle / post-mutation reloads of the same dir (which pass the current cwd).
      if (cwdRef.current && cwdRef.current !== r.path) { setPreview({ status: 'idle' }); setPreviewPath(''); setZoom(false); }
      setCwd(r.path); setAddr(r.path); setParent(r.parent ?? null);
      setEntries(r.entries || []); setTruncated(!!r.truncated);
      setSelected(null); setCreating(null); setRenaming(null);
    } catch (e) {
      if (seq === loadSeqRef.current) setError((e as Error).message);
    }
    if (seq === loadSeqRef.current) setLoading(false);
  }, [qs, showHidden]);

  // First open (cwd '' → the pane cwd) + reload when the hidden-files toggle flips. This single
  // effect also covers the initial mount, so there's no separate []-effect (which would double-fetch).
  useEffect(() => { load(cwd || undefined); /* eslint-disable-line */ }, [showHidden]);

  useEffect(() => { try { localStorage.setItem(HIDDEN_KEY, showHidden ? '1' : '0'); } catch { /* ignore */ } }, [showHidden]);
  useEffect(() => { try { localStorage.setItem(SORT_KEY, sortKey); } catch { /* ignore */ } }, [sortKey]);

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f ? entries.filter((e) => e.name.toLowerCase().includes(f)) : entries;
    return sortEntries(list, sortKey);
  }, [entries, filter, sortKey]);

  // ── File preview ────────────────────────────────────────────────────────────────────────────
  const loadPreview = useCallback(async (full: string) => {
    setPreviewPath(full); setPreview({ status: 'loading' });
    try {
      const r = await api.get(`/fs/file?${qs({ path: full })}`);
      if (r?.exists && r.isFile && !r.error) { setPreview({ status: 'ok', ...r }); setPreviewMd(isMarkdownPath(full)); }
      else if (r?.error) setPreview({ status: 'error', error: r.error });
      else setPreview({ status: 'none' });
    } catch (e) { setPreview({ status: 'error', error: (e as Error).message }); }
  }, [qs]);
  const closePreview = () => { setPreview({ status: 'idle' }); setPreviewPath(''); setZoom(false); };
  useEffect(() => { if (preview.status !== 'ok') setZoom(false); }, [preview.status]);

  // ── Navigation / row activation ──────────────────────────────────────────────────────────────
  const openEntry = useCallback((e: Entry) => {
    const full = joinPath(cwd, e.name);
    if (e.isDir) load(full);
    else loadPreview(full);
  }, [cwd, load, loadPreview]);

  // ── Mutations ────────────────────────────────────────────────────────────────────────────────
  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { onHint(`${label}失败：${(e as Error).message}`); }
    setBusy(false);
  }
  function doCreate() {
    if (!creating) return;
    if (!cwd) { setCreating(null); return; } // guard the pre-first-listing window (cwd '' → joinPath yields '/name')
    const name = creating.value.trim();
    if (!name) { setCreating(null); return; }
    const dest = joinPath(cwd, name);
    const kind = creating.kind;
    run(kind === 'dir' ? '新建文件夹' : '新建文件', async () => {
      await api.post(kind === 'dir' ? '/fs/mkdir' : '/fs/newfile', { path: dest, gid, window: windowName });
      setCreating(null);
      await load(cwd);
      onHint(kind === 'dir' ? '已新建文件夹' : '已新建文件');
    });
  }
  function doRename() {
    if (!renaming) return;
    if (!cwd) { setRenaming(null); return; }
    const to = renaming.value.trim();
    if (!to || to === renaming.name) { setRenaming(null); return; }
    const from = joinPath(cwd, renaming.name);
    const dest = joinPath(cwd, to);
    run('重命名', async () => {
      await api.post('/fs/rename', { from, to: dest, gid, window: windowName });
      setRenaming(null);
      if (previewPath === from) closePreview(); // the previewed file's path is now dead
      await load(cwd);
      onHint('已重命名');
    });
  }
  function doDelete(e: Entry) {
    const full = joinPath(cwd, e.name);
    const what = e.isDir ? '文件夹（及其全部内容）' : '文件';
    if (!confirm(`确定删除${what}「${e.name}」？此操作不可撤销。`)) return;
    if (e.isDir && !e.isSymlink && !confirm(`再次确认：递归删除整个文件夹「${e.name}」？`)) return;
    run('删除', async () => {
      await api.post('/fs/delete', { path: full, gid, window: windowName });
      if (previewPath === full) closePreview();
      await load(cwd);
      onHint('已删除');
    });
  }
  async function doDownload(e: Entry) {
    const full = joinPath(cwd, e.name);
    await run('下载', async () => {
      const blob = await fetchBlob(`/fs/download?${qs({ path: full })}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = e.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
  }

  // Upload one or more files into the current dir; on a name clash, offer to overwrite.
  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    let ok = 0;
    for (const f of files) {
      try {
        let r = await postRaw(`/fs/upload?${qs({ dir: cwd, name: f.name })}`, f);
        if (r?.error && r.exists) {
          if (!confirm(`「${f.name}」已存在，覆盖？`)) continue;
          r = await postRaw(`/fs/upload?${qs({ dir: cwd, name: f.name, overwrite: '1' })}`, f);
        }
        if (r?.error) onHint(`上传 ${f.name} 失败：${r.error}`);
        else ok++;
      } catch (e) { onHint(`上传 ${f.name} 失败：${(e as Error).message}`); }
    }
    setBusy(false);
    if (ok) { onHint(`已上传 ${ok} 个文件`); await load(cwd); }
  }, [cwd, qs, load, onHint]);

  // ── Path helpers (copy / send / cd) ──────────────────────────────────────────────────────────
  const copyPath = (p: string) => copyText(p).then((done) => onHint(done ? '已复制路径' : '已复制（若失败请手动）'));
  const sendPath = (p: string) => {
    // A filename may legally contain control bytes (ESC, the \x1b[201~ paste terminator, newline).
    // Sending those verbatim would break out of bracketed paste and inject live keystrokes into the
    // pane. A path with control chars is pathological — refuse rather than send a silently-altered one.
    if (/[\x00-\x1f\x7f]/.test(p)) { onHint('路径含控制字符，未发送'); return; }
    if (sendInput('\x1b[200~' + p + '\x1b[201~')) onHint('已发送路径到 claude');
    else onHint('连接已断开，无法发送');
  };
  const cdTo = (dir: string) => {
    if (sendInput('cd ' + shellQuote(dir) + '\n')) onHint('已在终端 cd（需终端处于 shell 提示符）');
    else onHint('连接已断开，无法发送');
  };

  // ── Keyboard nav over the visible list ───────────────────────────────────────────────────────
  function onListKeyDown(ev: ReactKeyboardEvent) {
    if (creating || renaming) return; // an inline input owns the keyboard
    const idx = selected ? visible.findIndex((e) => e.name === selected) : -1;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      const n = visible[Math.min(visible.length - 1, idx + 1)];
      if (n) setSelected(n.name);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      const n = visible[Math.max(0, idx <= 0 ? 0 : idx - 1)];
      if (n) setSelected(n.name);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const e = visible[idx];
      if (e) openEntry(e);
    } else if (ev.key === 'Backspace') {
      ev.preventDefault();
      if (parent) load(parent);
    }
  }

  // Drag-and-drop upload onto the list.
  const onDrop = (ev: ReactDragEvent) => {
    ev.preventDefault(); setDropActive(false);
    const files = Array.from(ev.dataTransfer?.files || []);
    if (files.length) uploadFiles(files);
  };

  const previewBody = () => {
    if (preview.status !== 'ok') return null;
    if (preview.binary) return <div className="file-note">二进制文件，无法预览（{fmtSize(preview.size)}）。</div>;
    const content = preview.content || '';
    return (
      <div className="file-viewer">
        {previewMd && content
          ? <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
          : <pre className="file-pre">{content || '（空文件）'}</pre>}
        {preview.truncated && <div className="file-note">文件较大，仅显示前一部分（共 {fmtSize(preview.size)}）。</div>}
      </div>
    );
  };

  return (
    <FloatingPanel
      title={<span className="fx-title">📁 文件浏览器</span>}
      storageKey="tmuxdash:panel:explorer"
      defaultSize={{ w: 720, h: 560 }}
      onClose={onClose}
      bodyClassName="fx-body"
    >
      <div className="fx-root" ref={rootRef} onDragOver={(e) => { e.preventDefault(); setDropActive(true); }}
        onDragLeave={() => setDropActive(false)} onDrop={onDrop}>
        {/* Nav row: up · editable address · reload · home(pane cwd) */}
        <div className="fx-nav">
          <button className="fx-ibtn" title="上一级 (Backspace)" disabled={!parent || busy} onClick={() => parent && load(parent)}>⬆</button>
          <input
            className="fx-addr" spellCheck={false} value={addr}
            placeholder="输入绝对路径或 ~/… 回车跳转"
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); load(addr.trim()); } }}
          />
          <button className="fx-ibtn" title="刷新" disabled={busy} onClick={() => load(cwd)}>⟳</button>
          <button className="fx-ibtn" title="回到 claude 当前目录" disabled={busy} onClick={() => load()}>🏠</button>
        </div>

        {/* Breadcrumbs */}
        <div className="fx-crumbs">
          {crumbs(cwd).map((c, i, arr) => (
            <span key={c.path}>
              <button className="fx-crumb" title={c.path} onClick={() => load(c.path)}>{c.label}</button>
              {i < arr.length - 1 && <span className="fx-crumb-sep">/</span>}
            </span>
          ))}
        </div>

        {/* Tools row: filter · hidden · sort · create · upload */}
        <div className="fx-tools">
          <input className="fx-filter" placeholder="过滤当前目录…" spellCheck={false}
            value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className={`fx-ibtn${showHidden ? ' on' : ''}`} title="显示隐藏文件（.dotfiles）"
            onClick={() => setShowHidden((v) => !v)}>👁</button>
          <select className="fx-sort" title="排序" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
            <option value="name">名称</option>
            <option value="mtime">修改时间</option>
            <option value="size">大小</option>
            <option value="type">类型</option>
          </select>
          <span className="fx-tools-gap" />
          <button className="fx-ibtn" title="新建文件夹" disabled={busy || !cwd} onClick={() => { setRenaming(null); setCreating({ kind: 'dir', value: '' }); }}>📁+</button>
          <button className="fx-ibtn" title="新建文件" disabled={busy || !cwd} onClick={() => { setRenaming(null); setCreating({ kind: 'file', value: '' }); }}>📄+</button>
          <button className="fx-ibtn" title="上传到当前目录" disabled={busy || !cwd} onClick={() => fileInputRef.current?.click()}>⬆️</button>
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }}
            onChange={(e) => { uploadFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
        </div>

        {error && <div className="fx-error">⚠ {error}</div>}

        {/* Entry list */}
        <div className={`fx-list${dropActive ? ' drop' : ''}`} ref={listRef} tabIndex={0} onKeyDown={onListKeyDown}>
          {creating && (
            <div className="fx-row fx-creating">
              <span className="fx-icon">{creating.kind === 'dir' ? '📁' : '📄'}</span>
              <input className="fx-inline-input" autoFocus spellCheck={false}
                placeholder={creating.kind === 'dir' ? '新文件夹名' : '新文件名'}
                value={creating.value}
                onChange={(e) => setCreating({ ...creating, value: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doCreate(); } else if (e.key === 'Escape') { e.preventDefault(); setCreating(null); } }}
                onBlur={doCreate}
              />
            </div>
          )}
          {loading ? (
            <div className="fx-empty">加载中…</div>
          ) : visible.length === 0 && !creating ? (
            <div className="fx-empty">{filter ? '没有匹配的项目' : '空文件夹'}</div>
          ) : (
            visible.map((e) => {
              const isRenaming = renaming?.name === e.name;
              return (
                <div
                  key={e.name}
                  className={`fx-row${selected === e.name ? ' active' : ''}${e.broken ? ' broken' : ''}`}
                  onClick={() => { setSelected(e.name); if (e.isFile) loadPreview(joinPath(cwd, e.name)); }}
                  onDoubleClick={() => { if (e.isDir) openEntry(e); else setZoom(true); }}
                  title={joinPath(cwd, e.name)}
                >
                  <span className="fx-icon">{iconFor(e)}</span>
                  {isRenaming ? (
                    <input className="fx-inline-input" autoFocus spellCheck={false}
                      value={renaming!.value}
                      onClick={(ev) => ev.stopPropagation()}
                      onChange={(ev) => setRenaming({ name: e.name, value: ev.target.value })}
                      onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doRename(); } else if (ev.key === 'Escape') { ev.preventDefault(); setRenaming(null); } }}
                      onBlur={doRename}
                    />
                  ) : (
                    <span className="fx-name">
                      {e.name}{e.isSymlink && <span className="fx-link" title="符号链接">↗</span>}
                    </span>
                  )}
                  <span className="fx-size">{e.isFile ? fmtSize(e.size) : ''}</span>
                  <span className="fx-time">{fmtTime(e.mtimeMs)}</span>
                  <span className="fx-actions" onClick={(ev) => ev.stopPropagation()}>
                    {e.isDir && <button className="fx-act" title="打开文件夹" onClick={() => openEntry(e)}>▸</button>}
                    <button className="fx-act" title="复制路径" onClick={() => copyPath(joinPath(cwd, e.name))}>⧉</button>
                    <button className="fx-act" title="发送路径到 claude" onClick={() => sendPath(joinPath(cwd, e.name))}>➤</button>
                    {e.isDir && <button className="fx-act" title="在终端 cd 到此" onClick={() => cdTo(joinPath(cwd, e.name))}>❯</button>}
                    <button className="fx-act" title="重命名" onClick={() => { setCreating(null); setRenaming({ name: e.name, value: e.name }); }}>✎</button>
                    {e.isFile && !e.broken && <button className="fx-act" title="下载" onClick={() => doDownload(e)}>⬇</button>}
                    <button className="fx-act danger" title="删除" onClick={() => doDelete(e)}>🗑</button>
                  </span>
                </div>
              );
            })
          )}
          {truncated && <div className="fx-empty">项目过多，仅显示前一部分。请用过滤或进入子目录。</div>}
        </div>

        {/* Preview split (draggable divider resizes it) */}
        {preview.status !== 'idle' && preview.status !== 'none' && (
          <>
            <div className="fx-split" title="拖动调整预览高度（上下拖）" onPointerDown={startPreviewResize} />
            <div className="fx-preview" style={{ height: previewH }}>
            <div className="fx-preview-head">
              <span className="fx-preview-path" title={previewPath}>📄 {previewPath}</span>
              <span className="fx-preview-actions">
                {preview.status === 'ok' && !preview.binary && (
                  <button className="fx-act" title="Markdown / 原文" onClick={() => setPreviewMd((v) => !v)}>{previewMd ? '原文' : 'MD'}</button>
                )}
                {preview.status === 'ok' && <button className="fx-act" title="放大查看" onClick={() => setZoom(true)}>⛶</button>}
                <button className="fx-act" title="复制路径" onClick={() => copyPath(previewPath)}>⧉</button>
                <button className="fx-act" title="关闭预览" onClick={closePreview}>×</button>
              </span>
            </div>
            {preview.status === 'loading' && <div className="file-note">读取中…</div>}
            {preview.status === 'error' && <div className="file-note">读取失败：{preview.error}</div>}
            {preview.status === 'ok' && previewBody()}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="fx-foot">
          <span className="fx-foot-count">{visible.length} 项{filter ? `（已过滤，共 ${entries.length}）` : ''}</span>
          <span className="fx-tools-gap" />
          <button className="fx-foot-btn" title="复制当前目录路径" onClick={() => copyPath(cwd)} disabled={!cwd}>复制路径</button>
          <button className="fx-foot-btn" title="在终端 cd 到当前目录" onClick={() => cdTo(cwd)} disabled={!cwd}>cd 此处</button>
        </div>
      </div>

      {/* Magnify: a larger reader for the previewed file (reuses the shared Markdown renderer). */}
      {zoom && preview.status === 'ok' && (
        <FloatingPanel
          title={`文件预览 · ${previewPath}`}
          storageKey="tmuxdash:panel:explorer-zoom"
          defaultSize={{ w: 780, h: 580 }}
          defaultOffset={40}
          onClose={() => setZoom(false)}
          footer={
            <>
              <button className="btn-ghost" style={{ marginRight: 'auto' }} onClick={() => setPreviewMd((v) => !v)}>{previewMd ? '原文' : 'Markdown'}</button>
              <button className="btn-ghost" onClick={() => copyText(preview.content || '').then((ok) => onHint(ok ? '已复制文件内容' : '复制失败'))}>复制全文</button>
            </>
          }
        >
          {previewBody()}
        </FloatingPanel>
      )}
    </FloatingPanel>
  );
}

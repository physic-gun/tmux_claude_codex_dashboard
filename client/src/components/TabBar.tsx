import { useState, useEffect, useRef, FormEvent } from 'react';

interface Props {
  gid: number;
  windows: string[];
  titles?: Record<string, string>;
  branches?: Record<string, string>;
  active: string | null;
  onSelect: (n: string) => void;
  onClose: (n: string) => void;
  // Add a PLAIN window in the group's shared dir (auto-worktree creation is disabled). Blank name
  // → the handler auto-names it.
  onAddWindow: (name: string) => Promise<void> | void;
  // Persist a new tab order (array of the open window names). Server reindexes windows.sort_order.
  onReorder: (order: string[]) => Promise<void> | void;
}

const STAR_KEY = 'tmuxdash:starredTabs';

export default function TabBar({
  gid, windows, titles, branches, active, onSelect, onClose, onAddWindow, onReorder,
}: Props) {
  const [wtAdding, setWtAdding] = useState(false);
  const [wtName, setWtName] = useState('');
  const [err, setErr] = useState('');
  // Right-click context menu anchored at the cursor, acting on one tab.
  const [menu, setMenu] = useState<{ x: number; y: number; w: string } | null>(null);
  // Starred/favorite tabs, keyed `${gid}:${window}`, persisted in localStorage (no backend). A star
  // is a pure marker — it doesn't reorder the tab, so it composes cleanly with manual 前移/后移.
  const [starred, setStarred] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(STAR_KEY) || '[]')); }
    catch { return new Set(); }
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  const starK = (w: string) => `${gid}:${w}`;
  const isStar = (w: string) => starred.has(starK(w));
  function toggleStar(w: string) {
    setStarred((prev) => {
      const next = new Set(prev);
      const k = starK(w);
      if (next.has(k)) next.delete(k); else next.add(k);
      try { localStorage.setItem(STAR_KEY, JSON.stringify([...next])); } catch { /* quota */ }
      return next;
    });
  }

  // Swap a tab one slot toward the front (dir -1) or back (dir +1) and persist the new order.
  function move(w: string, dir: -1 | 1) {
    const i = windows.indexOf(w);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= windows.length) return;
    const next = windows.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onReorder(next);
  }

  // Pin a tab all the way to the front (置顶) or back (置底), keeping every other tab's relative
  // order — unlike move(), a single jump rather than N single-slot swaps.
  function moveToEnd(w: string, toFront: boolean) {
    const i = windows.indexOf(w);
    if (i < 0) return;
    if (toFront ? i === 0 : i === windows.length - 1) return; // already there
    const rest = windows.filter((x) => x !== w);
    const next = toFront ? [w, ...rest] : [...rest, w];
    onReorder(next);
  }

  // Vertical wheel over the (single-row) tab strip scrolls it horizontally. Native non-passive
  // listener so preventDefault sticks; only hijack the wheel when there's actual overflow, so a
  // wheel over a non-overflowing strip still scrolls the page.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || e.shiftKey) return;
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Keep the active tab in view (e.g. switching groups restores a tab that may be off-screen).
  // Only touches the strip's scrollLeft — never scrolls the page. Measure the tab's offset
  // RELATIVE TO the scroll container via getBoundingClientRect (a .tab's offsetParent is the
  // positioned .main, not .tab-scroll, so offsetLeft would be off by the tabrow/sidebar inset).
  useEffect(() => {
    const el = scrollRef.current, act = activeRef.current;
    if (!el || !act) return;
    const cr = el.getBoundingClientRect(), ar = act.getBoundingClientRect();
    const l = ar.left - cr.left + el.scrollLeft, r = l + ar.width;
    if (l < el.scrollLeft) el.scrollLeft = l - 8;
    else if (r > el.scrollLeft + el.clientWidth) el.scrollLeft = r - el.clientWidth + 8;
  }, [active, windows]);

  // Dismiss the context menu on Escape, or on resize/scroll (its fixed position would go stale).
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  async function submitWt(e: FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      // Pass the (possibly empty) name through; the handler auto-names a blank one.
      await onAddWindow(wtName.trim());
      setWtName('');
      setWtAdding(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // A tab's label is its agent session title when it has one, else the window name. If the
  // SAME title is shared by several tabs (e.g. fresh claude windows all reporting the host's
  // default title, or two sessions with the same summary), that title can't tell them apart —
  // fall back to the unique window name so two tabs are never indistinguishable.
  const baseLabel = (w: string) => (titles?.[w] && titles[w] !== w ? titles[w] : w);
  const labelCounts: Record<string, number> = {};
  for (const w of windows) {
    const b = baseLabel(w);
    labelCounts[b] = (labelCounts[b] || 0) + 1;
  }

  const menuIdx = menu ? windows.indexOf(menu.w) : -1;

  return (
    <div className="tabbar">
      <div className="tab-scroll" ref={scrollRef}>
        {windows.map((w) => {
          const base = baseLabel(w);
          const label = labelCounts[base] > 1 ? w : base;
          const branch = branches?.[w];
          const kind = branch
            ? `隔离 worktree · 分支: ${branch}`
            : '普通窗口（共享分组目录，非 worktree）';
          return (
            <div
              key={w}
              ref={w === active ? activeRef : undefined}
              className={`tab ${w === active ? 'active' : ''}`}
              onClick={() => onSelect(w)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, w });
              }}
              title={`${label === w ? w : `${label}  ·  窗口: ${w}`}\n${kind}\n（右键：前移/后移/置顶/置底、收藏）`}
            >
              {isStar(w) && <span className="tab-star" title="已收藏">★</span>}
              {branch && <span className="tab-branch" title={`隔离 worktree · 分支 ${branch}`}>⎇</span>}
              <span className="tab-label">{label}</span>
              <button
                className="x"
                title="关闭选项卡（转入后台，不结束窗口）"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(w);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {wtAdding ? (
        <form className="tab-add" onSubmit={submitWt}>
          <input
            autoFocus
            placeholder="窗口名（留空回车=自动命名）· 新建普通窗口（共享分组目录）"
            value={wtName}
            onChange={(e) => setWtName(e.target.value)}
            onBlur={() => setWtAdding(false)}
          />
        </form>
      ) : (
        <button
          className="tab-new"
          title="新建普通窗口：在分组共享目录里开一个新窗口（非 worktree，不会改动 git）。留空回车=自动命名"
          onClick={() => setWtAdding(true)}
        >
          ＋
        </button>
      )}
      {err && <span className="err small">{err}</span>}

      {menu && (
        <>
          <div className="tab-menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="tab-menu"
            style={{
              left: Math.min(menu.x, window.innerWidth - 170),
              top: Math.min(menu.y, window.innerHeight - 140),
            }}
          >
            <button disabled={menuIdx <= 0} onClick={() => { move(menu.w, -1); setMenu(null); }}>
              ← 前移
            </button>
            <button disabled={menuIdx < 0 || menuIdx >= windows.length - 1} onClick={() => { move(menu.w, 1); setMenu(null); }}>
              后移 →
            </button>
            <button disabled={menuIdx <= 0} onClick={() => { moveToEnd(menu.w, true); setMenu(null); }}>
              ⇤ 置顶
            </button>
            <button disabled={menuIdx < 0 || menuIdx >= windows.length - 1} onClick={() => { moveToEnd(menu.w, false); setMenu(null); }}>
              置底 ⇥
            </button>
            <div className="tab-menu-sep" />
            <button onClick={() => { toggleStar(menu.w); setMenu(null); }}>
              {isStar(menu.w) ? '☆ 取消收藏' : '★ 收藏'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

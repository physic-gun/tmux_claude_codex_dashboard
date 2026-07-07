import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';

// ── Floating, draggable, resizable panel ────────────────────────────────────────────────────
// A non-blocking window (no backdrop, so the CLI behind stays scrollable/usable): drag by its
// title bar, resize from the bottom-right grip, position + size persisted per storageKey and
// clamped into the viewport. Shared by the Ctrl+G editor, the clipboard editor, the file preview
// magnify reader, and the file explorer — so several can coexist. (Terminal-hosted ones auto-close
// on tab/group switch because TerminalView remounts then.)
export type Rect = { x: number; y: number; w: number; h: number };
const PANEL_MIN_W = 300;
const PANEL_MIN_H = 170;

function clampRect(r: Rect): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(PANEL_MIN_W, Math.min(r.w, vw - 16));
  const h = Math.max(PANEL_MIN_H, Math.min(r.h, vh - 16));
  const x = Math.max(8, Math.min(r.x, Math.max(8, vw - w - 8)));
  const y = Math.max(8, Math.min(r.y, Math.max(8, vh - h - 8)));
  return { x, y, w, h };
}

function loadRect(key: string): Rect | null {
  try {
    const r = JSON.parse(localStorage.getItem(key) || 'null');
    if (r && ['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number')) return r;
  } catch { /* ignore */ }
  return null;
}

export default function FloatingPanel({
  title, storageKey, defaultSize, defaultOffset = 0, footer, onClose, children, bodyClassName,
}: {
  title: ReactNode;
  storageKey: string;
  defaultSize: { w: number; h: number };
  defaultOffset?: number;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  bodyClassName?: string;
}) {
  const [rect, setRect] = useState<Rect>(() => {
    const saved = loadRect(storageKey);
    if (saved) return clampRect(saved);
    const vw = window.innerWidth;
    const w = Math.min(defaultSize.w, vw - 24);
    const h = Math.min(defaultSize.h, window.innerHeight - 24);
    return clampRect({ w, h, x: (vw - w) / 2 + defaultOffset, y: 64 + defaultOffset });
  });
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify(rectRef.current)); } catch { /* ignore */ } };

  // Shared pointer-drag driver for both the title-bar move and the corner resize.
  const startGesture = (e: ReactPointerEvent, apply: (r0: Rect, dx: number, dy: number) => Rect) => {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const r0 = rectRef.current;
    const move = (ev: PointerEvent) => setRect(clampRect(apply(r0, ev.clientX - sx, ev.clientY - sy)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      persist();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const startDrag = (e: ReactPointerEvent) => startGesture(e, (r0, dx, dy) => ({ ...r0, x: r0.x + dx, y: r0.y + dy }));
  const startResize = (e: ReactPointerEvent) => { e.stopPropagation(); startGesture(e, (r0, dx, dy) => ({ ...r0, w: r0.w + dx, h: r0.h + dy })); };

  // Keep the panel on-screen if the browser window is resized.
  useEffect(() => {
    const onResize = () => setRect((r) => clampRect(r));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div className="float-panel" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <div className="float-panel-bar" onPointerDown={startDrag}>
        <span className="float-panel-title">{title}</span>
        <button className="float-panel-x" title="关闭" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>×</button>
      </div>
      <div className={`float-panel-body${bodyClassName ? ' ' + bodyClassName : ''}`}>{children}</div>
      {footer && <div className="float-panel-footer">{footer}</div>}
      <div className="float-panel-resize" title="拖动改变大小" onPointerDown={startResize} />
    </div>
  );
}

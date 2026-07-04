import { useEffect, useState, FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { api } from '../api';
import { QuickCommand } from '../types';

// The resizable body height is clamped so the section can never squeeze the groups list or push
// the sidebar footer off-screen (cap = 55% of the viewport, also re-applied on window resize).
const MIN_H = 80;
const maxH = () => Math.min(600, Math.round(window.innerHeight * 0.55));
const clampH = (h: number) => Math.max(MIN_H, Math.min(maxH(), h));

// Quick commands live in the left sidebar as a collapsible section. When expanded, its height is
// drag-resizable (grab the top edge); collapse state + height persist across reloads.
export default function QuickCommands({ onRun, canRun }: { onRun: (cmd: string) => void; canRun: boolean }) {
  const [cmds, setCmds] = useState<QuickCommand[]>([]);
  const [managing, setManaging] = useState(false);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('tmuxdash:qcCollapsed') === '1');
  const [bodyH, setBodyH] = useState(() => clampH(Number(localStorage.getItem('tmuxdash:qcHeight')) || 200));

  async function load() {
    setCmds(await api.get('/commands'));
  }
  useEffect(() => {
    load();
  }, []);

  // Keep the height bounded if the viewport shrinks (e.g. the window is made shorter).
  useEffect(() => {
    const onResize = () => setBodyH((h) => clampH(h));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function toggleCollapse() {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem('tmuxdash:qcCollapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  // Drag the top edge: moving up grows the body (and shrinks the groups list above). Persist on release.
  function startResize(e: ReactMouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = bodyH;
    let latest = startH;
    const onMove = (ev: MouseEvent) => {
      latest = clampH(startH + (startY - ev.clientY));
      setBodyH(latest);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      try { localStorage.setItem('tmuxdash:qcHeight', String(latest)); } catch {}
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!label.trim() || !command.trim()) return;
    await api.post('/commands', { label: label.trim(), command });
    setLabel('');
    setCommand('');
    load();
  }
  async function del(id: number) {
    await api.del(`/commands/${id}`);
    load();
  }

  return (
    <div className="quickcmds">
      {!collapsed && <div className="qc-resize" title="拖动调整高度" onMouseDown={startResize} />}
      <div className="qc-head">
        <span className="section-title">快捷命令</span>
        <span className="qc-head-actions">
          {!collapsed && (
            <button className="link" onClick={() => setManaging((m) => !m)}>
              {managing ? '完成' : '管理'}
            </button>
          )}
          <button className="qc-collapse" title={collapsed ? '展开' : '收起'} onClick={toggleCollapse}>
            {collapsed ? '▸' : '▾'}
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="qc-body" style={{ height: bodyH }}>
          <div className="qc-list">
            {cmds.map((c) => (
              <span key={c.id} className="chip">
                <button onClick={() => onRun(c.command)} disabled={!canRun} title={c.command}>
                  {c.label}
                </button>
                {managing && (
                  <button className="x" onClick={() => del(c.id)}>
                    ×
                  </button>
                )}
              </span>
            ))}
            {cmds.length === 0 && <span className="muted small">暂无快捷命令，点“管理”添加</span>}
          </div>
          {managing && (
            <form className="qc-add" onSubmit={add}>
              <input placeholder="按钮名称" value={label} onChange={(e) => setLabel(e.target.value)} />
              <input placeholder="命令，例如 ls -la" value={command} onChange={(e) => setCommand(e.target.value)} />
              <button>添加</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

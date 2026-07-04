import { useState, FormEvent } from 'react';

interface Props {
  windows: string[];
  titles?: Record<string, string>;
  branches?: Record<string, string>;
  active: string | null;
  onSelect: (n: string) => void;
  onClose: (n: string) => void;
  // Add a PLAIN window in the group's shared dir (auto-worktree creation is disabled). Blank name
  // → the handler auto-names it.
  onAddWindow: (name: string) => Promise<void> | void;
}

export default function TabBar({ windows, titles, branches, active, onSelect, onClose, onAddWindow }: Props) {
  const [wtAdding, setWtAdding] = useState(false);
  const [wtName, setWtName] = useState('');
  const [err, setErr] = useState('');

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

  // A tab's label is its claude session title when it has one, else the window name. If the
  // SAME title is shared by several tabs (e.g. fresh claude windows all reporting the host's
  // default title, or two sessions with the same summary), that title can't tell them apart —
  // fall back to the unique window name so two tabs are never indistinguishable.
  const baseLabel = (w: string) => (titles?.[w] && titles[w] !== w ? titles[w] : w);
  const labelCounts: Record<string, number> = {};
  for (const w of windows) {
    const b = baseLabel(w);
    labelCounts[b] = (labelCounts[b] || 0) + 1;
  }

  return (
    <div className="tabbar">
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
            className={`tab ${w === active ? 'active' : ''}`}
            onClick={() => onSelect(w)}
            title={`${label === w ? w : `${label}  ·  窗口: ${w}`}\n${kind}`}
          >
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
    </div>
  );
}

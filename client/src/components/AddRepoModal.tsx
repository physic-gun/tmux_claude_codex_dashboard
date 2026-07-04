import { useEffect, useState } from 'react';
import { api } from '../api';
import { TrackableFolder } from '../types';

// Discover git repos under the group dir (resolved server-side) and multi-select which to track.
// Already-tracked folders come back checked + disabled. Reuses the .modal-overlay shell.
export default function AddRepoModal({
  gid,
  onClose,
  onTrack,
}: {
  gid: number;
  onClose: () => void;
  onTrack: (paths: string[]) => Promise<void>;
}) {
  const [folders, setFolders] = useState<TrackableFolder[]>([]);
  const [groupDir, setGroupDir] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr('');
    api
      .get(`/groups/${gid}/git/discover`)
      .then((r) => {
        if (!alive) return;
        setFolders(r.candidates || []);
        setGroupDir(r.groupDir || '');
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [gid]);

  function toggle(p: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  async function submit() {
    if (!picked.size) return;
    setBusy(true);
    setErr('');
    try {
      await onTrack([...picked]);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal repo-add-modal">
        <div className="modal-title">添加要跟踪的 Git 仓库</div>
        {groupDir && (
          <div className="field-label" title={groupDir}>
            扫描目录：{groupDir}
          </div>
        )}

        {loading ? (
          <div className="muted small">扫描中…</div>
        ) : folders.length === 0 ? (
          !err && <div className="muted small">该分组目录下没有发现 Git 仓库</div>
        ) : (
          <div className="repo-pick-list">
            {folders.map((f) => (
              <label key={f.path} className={`repo-pick${f.tracked ? ' tracked' : ''}`} title={f.path}>
                <input
                  type="checkbox"
                  disabled={f.tracked || busy}
                  checked={f.tracked || picked.has(f.path)}
                  onChange={() => toggle(f.path)}
                />
                <span className="repo-pick-name">{f.relPath === '.' ? f.name : f.relPath}</span>
                {f.tracked && <span className="muted small">已跟踪</span>}
              </label>
            ))}
          </div>
        )}

        {err && <div className="err small">{err}</div>}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" disabled={!picked.size || busy} onClick={submit}>
            跟踪所选 ({picked.size})
          </button>
        </div>
      </div>
    </div>
  );
}

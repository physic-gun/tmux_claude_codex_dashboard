import { useEffect, useState } from 'react';
import { api } from '../api';
import { SessionGroup } from '../types';

// Browse Claude session history (read from disk, grouped by dashboard group) and resume any
// session — it opens a new tab in that group running `claude --resume <id>`.
export default function SessionHistoryModal({
  onClose,
  onResume,
}: {
  onClose: () => void;
  onResume: (gid: number, sessionId: string) => Promise<void>;
}) {
  const [data, setData] = useState<SessionGroup[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(''); // id being resumed

  useEffect(() => {
    api.get('/sessions').then(setData).catch((e) => setErr((e as Error).message));
  }, []);

  async function resume(gid: number, sessionId: string) {
    setBusy(sessionId);
    setErr('');
    try {
      await onResume(gid, sessionId); // parent closes the modal on success
    } catch (e) {
      setErr((e as Error).message);
      setBusy('');
    }
  }

  const fmt = (ms: number) => new Date(ms).toLocaleString();

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal session-modal">
        <div className="modal-title">Claude 会话历史 · 点击在对应分组打开并 resume</div>
        {err && <div className="err small">{err}</div>}
        {data == null ? (
          <div className="muted small">加载中…</div>
        ) : data.length === 0 ? (
          <div className="muted small">没有找到 Claude 会话历史（各分组目录下都没有会话文件）。</div>
        ) : (
          <div className="session-list">
            {data.map((g) => (
              <div key={g.gid} className="session-group">
                <div className="session-group-name">{g.group}</div>
                {g.sessions.map((s) => (
                  <button
                    key={s.id}
                    className="session-item"
                    disabled={!!busy}
                    onClick={() => resume(g.gid, s.id)}
                    title={`${s.id}\n${fmt(s.mtime)}`}
                  >
                    <span className="sid">{s.shortId}</span>
                    {s.active && <span className="sbadge">进行中</span>}
                    <span className="slabel">{s.label || '(无摘要)'}</span>
                    <span className="stime">{fmt(s.mtime)}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

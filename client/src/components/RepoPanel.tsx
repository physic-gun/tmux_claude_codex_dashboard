import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useRepoStatus } from '../scm/useRepoStatus';
import RepoRow from './RepoRow';
import AddRepoModal from './AddRepoModal';
import GitOutputModal from './GitOutputModal';

// Right-rail body: head (title / ⟳ refresh / ＋ add / » collapse), the tracked-repo list with
// empty/error states, the add-repo modal, and a copy-the-error popup for a failed pull.
export default function RepoPanel({
  gid,
  onToggleCollapse,
}: {
  gid: number | null;
  onToggleCollapse: () => void;
}) {
  const { repos, statuses, loading, refreshing, error, refresh, track, untrack, pull } = useRepoStatus(gid);
  const [addOpen, setAddOpen] = useState(false);
  const [pullingId, setPullingId] = useState<number | null>(null);
  const [gitOut, setGitOut] = useState<string | null>(null);

  async function handlePull(id: number) {
    setPullingId(id);
    try {
      const r = await pull(id);
      if (!r.ok) setGitOut(r.output || '拉取失败');
    } catch (e) {
      setGitOut((e as Error).message);
    } finally {
      setPullingId(null);
    }
  }

  return (
    <div className="scm-panel">
      <div className="scm-head">
        <div className="section-title">源代码管理</div>
        <button
          className={`icon-btn${refreshing ? ' spinning' : ''}`}
          title={refreshing ? '正在联网检查远端…' : '刷新状态（联网检查是否落后远端）'}
          disabled={gid == null || refreshing}
          onClick={() => refresh({ fetch: true }).catch(() => {})}
        >
          ⟳
        </button>
        <button className="icon-btn" title="添加仓库" disabled={gid == null} onClick={() => setAddOpen(true)}>
          ＋
        </button>
        <button className="icon-btn" title="收起源代码管理" onClick={onToggleCollapse}>
          »
        </button>
      </div>

      {gid == null ? (
        <div className="scm-empty muted small">请选择一个分组</div>
      ) : error ? (
        <div className="scm-empty err small">{error}</div>
      ) : repos.length === 0 ? (
        <div className="scm-empty muted small">{loading ? '加载中…' : '未跟踪任何仓库，点击 ＋ 添加'}</div>
      ) : (
        <ul className="repo-list">
          {repos.map((r) => (
            <RepoRow
              key={r.id}
              gid={gid}
              repo={r}
              status={statuses[r.id]}
              onUntrack={untrack}
              onPull={handlePull}
              pulling={pullingId === r.id}
            />
          ))}
        </ul>
      )}

      {gid != null && repos.length > 0 && (
        <div className="scm-foot">
          <Link className="scm-foot-link" to={`/repos?gid=${gid}`}>查看文件差异 →</Link>
        </div>
      )}

      {addOpen && gid != null && (
        <AddRepoModal gid={gid} onClose={() => setAddOpen(false)} onTrack={track} />
      )}
      {gitOut != null && (
        <GitOutputModal title="拉取失败 / 冲突" output={gitOut} onClose={() => setGitOut(null)} />
      )}
    </div>
  );
}

import { RepoStatus } from '../types';

// Machine error codes → Chinese (never surface a raw `not_a_repo` in a tooltip).
const ERR_ZH: Record<string, string> = {
  missing: '仓库已删除',
  timeout: '读取超时',
  not_a_repo: '不是 git 仓库',
  error: '读取失败',
};

// Lightweight status cluster: dirty (M), ahead (↑n), behind (↓n), clean (✓), or error (!).
// Reused in the rail now and the diff page later.
export default function RepoBadges({ s }: { s?: RepoStatus }) {
  if (!s) return <span className="repo-badges loading">…</span>;
  if (!s.ok) {
    return (
      <span className="repo-badges err" title={ERR_ZH[s.error ?? 'error']}>
        !
      </span>
    );
  }
  const clean = !s.dirty && s.ahead === 0 && s.behind === 0;
  return (
    <span className="repo-badges" title={s.detached ? '分离 HEAD' : s.branch}>
      {s.dirty && (
        <span className="badge dirty" title={`${s.changedFiles} 个改动`}>
          M
        </span>
      )}
      {s.ahead > 0 && (
        <span className="badge ahead" title="领先远端（待推送）">
          ↑{s.ahead}
        </span>
      )}
      {s.behind > 0 && (
        <span className="badge behind" title="落后远端（待拉取）">
          ↓{s.behind}
        </span>
      )}
      {clean && (
        <span className="badge clean" title="干净">
          ✓
        </span>
      )}
    </span>
  );
}

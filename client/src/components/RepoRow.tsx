import { Link } from 'react-router-dom';
import { RepoStatus, TrackedRepo } from '../types';
import RepoBadges from './RepoBadges';

// One tracked repo in the rail: name (deep-links to the diff page) + current branch (dim,
// display-only) + status badges + a green pull button when behind the remote + hover untrack ×.
export default function RepoRow({
  gid,
  repo,
  status,
  onUntrack,
  onPull,
  pulling,
}: {
  gid: number;
  repo: TrackedRepo;
  status?: RepoStatus;
  onUntrack: (id: number) => void;
  onPull: (id: number) => void;
  pulling?: boolean;
}) {
  const behind = status?.ok ? status.behind ?? 0 : 0;
  return (
    <li className="repo-row">
      <Link
        className="repo-name"
        to={`/repos?gid=${gid}&repo=${repo.id}`}
        title={repo.relPath === '.' ? repo.name : repo.relPath}
      >
        {repo.name}
      </Link>
      {status?.ok && status.branch && <span className="repo-branch" title="当前分支">({status.branch})</span>}
      <RepoBadges s={status} />
      {behind > 0 && (
        <button
          className="repo-pull"
          title={`代码不是最新（落后 ${behind}）— 点击拉取`}
          disabled={pulling}
          onClick={() => onPull(repo.id)}
        >
          ↑
        </button>
      )}
      <button
        className="repo-untrack"
        title="取消跟踪（不会删除磁盘上的文件）"
        onClick={() => onUntrack(repo.id)}
      >
        ×
      </button>
    </li>
  );
}

import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { GitActionResult, RepoFile } from '../../types';
import GitOutputModal from '../GitOutputModal';

// Diff-page column 2: changed files of the selected repo (scrollable) + a pinned commit/push/pull
// footer. Fetches on (gid, repo) change and after a commit/pull; a reqRef epoch guards stale loads.
export default function ScmFileList({
  gid,
  repo,
  file,
  onSelect,
  onStatusChange,
}: {
  gid: number | null;
  repo: number | null;
  file: string;
  onSelect: (file: string) => void;
  // Fired after a successful commit/push/pull so the parent can refresh the repo status badges.
  onStatusChange?: () => void;
}) {
  const [files, setFiles] = useState<RepoFile[]>([]);
  const [branch, setBranch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [commitMsg, setCommitMsg] = useState('');
  const [busy, setBusy] = useState<'' | 'commit' | 'push' | 'pull'>('');
  const [gitOut, setGitOut] = useState<{ title: string; output: string } | null>(null);
  const reqRef = useRef(0);
  const fileRef = useRef(file);
  fileRef.current = file;

  useEffect(() => {
    if (gid == null || repo == null) {
      setFiles([]);
      setBranch('');
      setError('');
      return;
    }
    const id = ++reqRef.current;
    setLoading(true);
    setError('');
    api
      .get(`/groups/${gid}/git/repos/${repo}/files`)
      .then((r) => {
        if (id !== reqRef.current) return;
        const list: RepoFile[] = r.files || [];
        setFiles(list);
        setBranch(r.detached ? '(分离 HEAD)' : r.branch || '');
        if (list.length && !list.some((f) => f.path === fileRef.current)) onSelect(list[0].path);
        else if (!list.length) onSelect('');
      })
      .catch((e) => {
        if (id === reqRef.current) setError((e as Error).message);
      })
      .finally(() => {
        if (id === reqRef.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gid, repo, reload]);

  const canAct = gid != null && repo != null;

  async function run(kind: 'commit' | 'push' | 'pull', body?: unknown) {
    if (!canAct) return;
    setBusy(kind);
    try {
      const r: GitActionResult = await api.post(`/groups/${gid}/git/repos/${repo}/${kind}`, body);
      if (r.ok) {
        if (kind === 'commit') setCommitMsg('');
        if (kind !== 'push') setReload((n) => n + 1); // commit/pull change the working tree
        onStatusChange?.(); // any action shifts ahead/behind/dirty — refresh the status badges so success is visible
      } else {
        const titles = { commit: '提交失败', push: '推送失败 / 冲突', pull: '拉取失败 / 冲突' } as const;
        setGitOut({ title: titles[kind], output: r.output || titles[kind] });
      }
    } catch (e) {
      setGitOut({ title: '操作失败', output: (e as Error).message });
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="scm-col-files">
      <div className="scm-files-head">
        <span className="section-title">改动文件</span>
        {branch && <span className="muted small scm-branch">{branch}</span>}
      </div>

      <div className="scm-files-scroll">
        {gid == null || repo == null ? (
          <div className="muted small scm-pad">选择一个仓库</div>
        ) : loading ? (
          <div className="muted small scm-pad">加载中…</div>
        ) : error ? (
          <div className="err small scm-pad">{error}</div>
        ) : files.length === 0 ? (
          <div className="muted small scm-pad">工作区是干净的</div>
        ) : (
          <div className="scm-file-items">
            {files.map((f) => (
              <button
                key={f.path}
                className={`file-item${f.path === file ? ' active' : ''}`}
                title={f.path}
                onClick={() => onSelect(f.path)}
              >
                <span className={`fstat ${f.status === '?' ? 'untracked' : f.status}`}>{f.status}</span>
                <span className="fpath">{f.path}</span>
                <span className="fnum">
                  {f.binary ? (
                    '二进制'
                  ) : (
                    <>
                      {f.additions > 0 && <span className="add">+{f.additions}</span>}
                      {f.deletions > 0 && <span className="del">−{f.deletions}</span>}
                    </>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {canAct && (
        <div className="scm-git-actions">
          <input
            className="scm-commit-input"
            placeholder="提交信息（提交全部改动）"
            value={commitMsg}
            spellCheck={false}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && commitMsg.trim() && !busy) run('commit', { message: commitMsg.trim() });
            }}
          />
          <div className="scm-git-btns">
            <button disabled={!!busy || !commitMsg.trim()} onClick={() => run('commit', { message: commitMsg.trim() })}>
              {busy === 'commit' ? '提交中…' : '提交'}
            </button>
            <button disabled={!!busy} onClick={() => run('push')}>{busy === 'push' ? '推送中…' : '推送'}</button>
            <button disabled={!!busy} onClick={() => run('pull')}>{busy === 'pull' ? '拉取中…' : '拉取'}</button>
          </div>
        </div>
      )}

      {gitOut && <GitOutputModal title={gitOut.title} output={gitOut.output} onClose={() => setGitOut(null)} />}
    </div>
  );
}

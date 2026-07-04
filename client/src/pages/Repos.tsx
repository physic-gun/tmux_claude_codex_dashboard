import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ScmGroupList from '../components/scm/ScmGroupList';
import ScmFileList from '../components/scm/ScmFileList';
import DiffViewer from '../components/scm/DiffViewer';

type Mode = 'unified' | 'split';

// Second-level diff page. All view state lives in the URL (?gid=&repo=&file=&mode=) so it is
// deep-linkable + back/forward friendly; `file` goes in the query because it contains slashes.
export default function Repos() {
  const [params, setParams] = useSearchParams();
  // Bumped after a commit/push/pull in the file list so the group list re-pulls status badges.
  const [statusEpoch, setStatusEpoch] = useState(0);

  const gidParam = params.get('gid');
  const savedGid = (() => {
    const s = localStorage.getItem('tmuxdash:activeGid');
    return s ? Number(s) : null;
  })();
  const gid = gidParam ? Number(gidParam) : savedGid;
  const repo = params.get('repo') ? Number(params.get('repo')) : null;
  const file = params.get('file') || '';
  const mode = (params.get('mode') || localStorage.getItem('tmuxdash:diffMode') || 'unified') as Mode;

  // Merge a partial change into the query string (null/'' deletes the key).
  const patch = useCallback(
    (next: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(next)) {
            if (v == null || v === '') p.delete(k);
            else p.set(k, v);
          }
          return p;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  const selectRepo = useCallback((g: number, r: number) => patch({ gid: String(g), repo: String(r), file: null }), [patch]);
  const selectFile = useCallback((f: string) => patch({ file: f || null }), [patch]);
  const setMode = useCallback(
    (m: Mode) => {
      try { localStorage.setItem('tmuxdash:diffMode', m); } catch {}
      patch({ mode: m });
    },
    [patch]
  );

  return (
    <div className="scm-page-wrap">
      <div className="scm-page-head">
        {/* same-tab link: the tmux session persists server-side, so the terminal just reconnects */}
        <Link to="/" className="scm-back">← 返回控制台</Link>
        <span className="scm-page-title">文件差异</span>
        <span className="scm-mode-toggle">
          <button className={mode === 'unified' ? 'on' : ''} onClick={() => setMode('unified')}>单栏</button>
          <button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>双栏</button>
        </span>
      </div>
      <div className="scm-page">
        <ScmGroupList gid={gid} repo={repo} reloadStatus={statusEpoch} onSelect={selectRepo} />
        <ScmFileList
          gid={gid}
          repo={repo}
          file={file}
          onSelect={selectFile}
          onStatusChange={() => setStatusEpoch((n) => n + 1)}
        />
        <DiffViewer gid={gid} repo={repo} file={file} mode={mode} />
      </div>
    </div>
  );
}

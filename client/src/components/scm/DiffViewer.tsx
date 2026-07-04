import { useEffect, useMemo, useRef, useState } from 'react';
import { parseDiff, Diff, Hunk } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { api } from '../../api';
import { FileDiff } from '../../types';

// Diff-page main pane. Fetches the selected file's diff and renders the staged + unstaged
// sections with react-diff-view; the 单栏/双栏 toggle is just the `viewType` prop over the same
// parsed hunks (no refetch). A reqRef epoch guards against a slow diff overwriting a newer pick.
export default function DiffViewer({
  gid,
  repo,
  file,
  mode,
}: {
  gid: number | null;
  repo: number | null;
  file: string;
  mode: 'unified' | 'split';
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const reqRef = useRef(0);

  useEffect(() => {
    if (gid == null || repo == null || !file) {
      setDiff(null);
      setError('');
      return;
    }
    const id = ++reqRef.current;
    setLoading(true);
    setError('');
    api
      .get(`/groups/${gid}/git/repos/${repo}/diff?file=${encodeURIComponent(file)}`)
      .then((d) => {
        if (id === reqRef.current) setDiff(d);
      })
      .catch((e) => {
        if (id === reqRef.current) setError((e as Error).message);
      })
      .finally(() => {
        if (id === reqRef.current) setLoading(false);
      });
  }, [gid, repo, file]);

  // Parse once per diff (NOT per render) — toggling 单栏/双栏 then only swaps the viewType prop.
  const sections = useMemo(() => {
    if (!diff || diff.binary || diff.truncated) return [];
    return [
      { key: 'staged', label: '已暂存（index → HEAD）', text: diff.staged },
      { key: 'unstaged', label: diff.added ? '新增文件' : '未暂存（工作区 → index）', text: diff.unstaged },
    ]
      .filter((s) => s.text && s.text.trim())
      .map((s) => ({ ...s, parsed: parseDiff(s.text) }));
  }, [diff]);

  const wrap = (content: React.ReactNode) => <div className="scm-col-diff">{content}</div>;

  if (gid == null || repo == null || !file) return wrap(<div className="center">选择一个文件查看差异</div>);
  if (loading) return wrap(<div className="center">加载中…</div>);
  if (error) return wrap(<div className="center err">{error}</div>);
  if (!diff) return wrap(<div className="center">选择一个文件查看差异</div>);
  if (diff.binary) return wrap(<div className="center">二进制文件，无法显示差异</div>);
  if (diff.truncated) return wrap(<div className="center">差异过大，已省略</div>);
  if (!sections.length) return wrap(<div className="center">该文件没有可显示的文本差异</div>);

  const viewType = mode === 'split' ? 'split' : 'unified';
  return wrap(
    <div className="scm-diff-scroll">
      <div className="scm-diff-path" title={diff.path}>{diff.path}</div>
      {sections.map((s) => (
        <div key={s.key} className="scm-diff-section">
          <div className="scm-diff-section-label">{s.label}</div>
          {s.parsed.map((f, i) => (
            <Diff key={i} viewType={viewType} diffType={f.type} hunks={f.hunks}>
              {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
            </Diff>
          ))}
          {s.parsed.length === 0 && <div className="muted small scm-pad">（无法解析此差异）</div>}
        </div>
      ))}
    </div>
  );
}

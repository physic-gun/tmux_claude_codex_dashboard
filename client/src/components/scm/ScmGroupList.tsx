import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { Group, TrackedRepo, RepoStatus } from '../../types';

// Diff-page column 1: a groups accordion → tracked repos. The active ?gid auto-expands and its
// repos load lazily (cached per gid). Selecting a repo lifts (gid, repoId) into the URL.
export default function ScmGroupList({
  gid,
  repo,
  reloadStatus,
  onSelect,
}: {
  gid: number | null;
  repo: number | null;
  // Bumped by the parent after a commit/push/pull so the active group's status badges refresh.
  reloadStatus?: number;
  onSelect: (gid: number, repoId: number) => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(() => (gid != null ? new Set([gid]) : new Set()));
  const [reposByGid, setReposByGid] = useState<Record<number, TrackedRepo[]>>({});
  // Per-group repo status keyed by repo id, so each repo row can flag whether it has a diff.
  const [statusByGid, setStatusByGid] = useState<Record<number, Record<number, RepoStatus>>>({});

  // Status (dirty / ahead / behind) for the diff + ahead/behind indicators — best-effort, and
  // independent of the repo list so it can be re-pulled on its own after a git action.
  const loadStatus = useCallback(async (g: number) => {
    try {
      const { repos: st } = await api.get(`/groups/${g}/git/status`);
      setStatusByGid((prev) => ({
        ...prev,
        [g]: Object.fromEntries((st as RepoStatus[]).map((x) => [x.id, x])),
      }));
    } catch {
      /* no badge if status can't be read */
    }
  }, []);

  const loadRepos = useCallback(async (g: number) => {
    try {
      const r = await api.get(`/groups/${g}/git/repos`);
      setReposByGid((prev) => ({ ...prev, [g]: r }));
    } catch {
      /* leave it unloaded; the row just shows nothing */
    }
    loadStatus(g);
  }, [loadStatus]);

  useEffect(() => {
    api.get('/groups').then(setGroups).catch(() => {});
  }, []);

  // Auto-expand + load the active group's repos.
  useEffect(() => {
    if (gid == null) return;
    setExpanded((s) => (s.has(gid) ? s : new Set(s).add(gid)));
    loadRepos(gid);
  }, [gid, loadRepos]);

  // After a commit/push/pull (signalled by the parent bumping reloadStatus), re-pull the active
  // group's status so the ahead/behind/dirty badges immediately reflect the result.
  useEffect(() => {
    if (reloadStatus && gid != null) loadStatus(gid);
  }, [reloadStatus, gid, loadStatus]);

  function toggle(g: number) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(g)) n.delete(g);
      else {
        n.add(g);
        if (!reposByGid[g]) loadRepos(g);
      }
      return n;
    });
  }

  return (
    <div className="scm-col-groups">
      <div className="section-title">分组 / 仓库</div>
      <ul className="scm-group-list">
        {groups.map((g) => (
          <li key={g.id}>
            <button className="scm-group-row" onClick={() => toggle(g.id)}>
              <span className="caret">{expanded.has(g.id) ? '▾' : '▸'}</span>
              <span className="scm-group-name">{g.name}</span>
            </button>
            {expanded.has(g.id) && (
              <ul className="scm-repo-sublist">
                {(reposByGid[g.id] || []).map((r) => {
                  const st = statusByGid[g.id]?.[r.id];
                  const dirty = !!st?.ok && !!st.dirty;
                  const ahead = st?.ok ? st.ahead ?? 0 : 0;
                  const behind = st?.ok ? st.behind ?? 0 : 0;
                  return (
                    <li key={r.id}>
                      <button
                        className={`scm-repo-row${gid === g.id && repo === r.id ? ' active' : ''}`}
                        title={
                          [
                            r.relPath,
                            dirty ? `${st!.changedFiles} 个改动` : st && !st.ok ? '状态不可用' : st?.ok ? '无改动' : '',
                            ahead > 0 ? `领先远端 ${ahead}` : '',
                            behind > 0 ? `落后远端 ${behind}` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        }
                        onClick={() => onSelect(g.id, r.id)}
                      >
                        <span className="scm-repo-name">{r.name}</span>
                        {ahead > 0 && (
                          <span className="badge ahead" title="领先远端（待推送）">↑{ahead}</span>
                        )}
                        {behind > 0 && (
                          <span className="badge behind" title="落后远端（待拉取）">↓{behind}</span>
                        )}
                        {dirty ? (
                          <span className="scm-diff-flag dirty">●{st!.changedFiles ? ` ${st!.changedFiles}` : ''}</span>
                        ) : st?.ok ? (
                          <span className="scm-diff-flag clean">✓</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
                {reposByGid[g.id] && reposByGid[g.id].length === 0 && (
                  <li className="muted small scm-sub-empty">无跟踪仓库</li>
                )}
              </ul>
            )}
          </li>
        ))}
        {groups.length === 0 && <li className="muted small">没有分组</li>}
      </ul>
    </div>
  );
}

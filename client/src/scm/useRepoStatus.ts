import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { GitActionResult, RepoStatus, TrackedRepo } from '../types';

// Owns a group's tracked repos + their live status badges. Mirrors Dashboard's loadWindows +
// poll, but the status poll is SLOWER (8s) and VISIBILITY-GATED: a hidden tab must not keep
// fanning out git subprocesses in the background (multiple open tabs otherwise multiply that).
// We also refetch on focus / visibilitychange so a returning tab is immediately fresh.
export function useRepoStatus(gid: number | null) {
  const [repos, setRepos] = useState<TrackedRepo[]>([]);
  const [statuses, setStatuses] = useState<Record<number, RepoStatus>>({});
  const [loading, setLoading] = useState(false);
  // True only during a manual ⟳ refresh that hits the network (fetch) — lets the button show a
  // "checking remote" state without affecting the silent 8s poll.
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  // Bumped on every gid change; a load that was dispatched for an older epoch is discarded
  // so a slow previous-group response can't clobber the current group's repos/badges. (api.ts
  // is plain fetch with no AbortController, so in-flight requests aren't cancelled — we guard
  // at commit time instead.)
  const epoch = useRef(0);

  const loadRepos = useCallback(async (g: number) => {
    const e = epoch.current;
    const list = await api.get(`/groups/${g}/git/repos`);
    if (e === epoch.current) setRepos(list);
  }, []);

  // `fetch` triggers a server-side network fetch so `behind` reflects the true remote. Reserved
  // for the manual ⟳ refresh; the poll always passes false to stay offline/cheap.
  const loadStatus = useCallback(async (g: number, fetch = false) => {
    const e = epoch.current;
    const { repos: list } = await api.get(`/groups/${g}/git/status${fetch ? '?fetch=1' : ''}`);
    if (e === epoch.current) setStatuses(Object.fromEntries((list as RepoStatus[]).map((x) => [x.id, x])));
  }, []);

  // On gid change: invalidate stale loads, clear so we never flash the previous group's repos,
  // then (re)load both repos + statuses.
  useEffect(() => {
    epoch.current += 1;
    setRepos([]);
    setStatuses({});
    setError('');
    if (gid == null) return;
    setLoading(true);
    Promise.all([loadRepos(gid), loadStatus(gid)])
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [gid, loadRepos, loadStatus]);

  // Visibility-gated 8s poll + refetch on focus/visibilitychange.
  useEffect(() => {
    if (gid == null) return;
    const tick = () => {
      if (document.visibilityState === 'visible') loadStatus(gid).catch(() => {});
    };
    const id = window.setInterval(tick, 8000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [gid, loadStatus]);

  // Manual refresh. `{ fetch: true }` (the ⟳ button) does a network fetch so the behind/ahead
  // counts are accurate; the cheaper no-fetch form is reused after track/untrack/pull.
  const refresh = useCallback(
    async (opts?: { fetch?: boolean }) => {
      if (gid == null) return;
      if (opts?.fetch) setRefreshing(true);
      try {
        await Promise.all([loadRepos(gid), loadStatus(gid, opts?.fetch)]);
      } finally {
        if (opts?.fetch) setRefreshing(false);
      }
    },
    [gid, loadRepos, loadStatus]
  );

  const track = useCallback(
    async (paths: string[]) => {
      if (gid != null && paths.length) {
        await api.post(`/groups/${gid}/git/repos`, { paths });
        await refresh();
      }
    },
    [gid, refresh]
  );

  const untrack = useCallback(
    async (repoId: number) => {
      if (gid != null) {
        await api.del(`/groups/${gid}/git/repos/${repoId}`);
        await refresh();
      }
    },
    [gid, refresh]
  );

  // Pull latest; refresh badges on success. Returns the action result so the caller can show the
  // copy-the-error popup on a conflict/failure.
  const pull = useCallback(
    async (repoId: number): Promise<GitActionResult> => {
      if (gid == null) return { ok: false, output: '' };
      const r: GitActionResult = await api.post(`/groups/${gid}/git/repos/${repoId}/pull`);
      if (r.ok) await refresh();
      return r;
    },
    [gid, refresh]
  );

  return { repos, statuses, loading, refreshing, error, refresh, track, untrack, pull };
}

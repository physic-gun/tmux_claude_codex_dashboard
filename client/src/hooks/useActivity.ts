import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ActivityResp, WindowActivity } from '../types';
import { activityKey } from '../lib/activity.js';

const emptyWindowActivity = (gid: number, name: string): WindowActivity => ({
  groupId: gid,
  window: name,
  todo: false,
  agent: null,
  phase: null,
  reason: null,
  detail: null,
  updatedAt: null,
});

export default function useActivity() {
  const [snapshot, setSnapshot] = useState<ActivityResp>({ observedAt: '', windows: [] });
  const loadingRef = useRef(false);
  const revisionRef = useRef(0);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const revision = revisionRef.current;
    try {
      const next: ActivityResp = await api.get('/activity');
      if (!next || !Array.isArray(next.windows) || revision !== revisionRef.current) return;
      setSnapshot(next);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const refresh = () => { load().catch(() => {}); };
    refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 1000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  const patchWindow = useCallback((gid: number, name: string, patch: Partial<WindowActivity>) => {
    setSnapshot((current) => {
      const key = activityKey(gid, name);
      let found = false;
      const windows = current.windows.map((item) => {
        if (activityKey(item.groupId, item.window) !== key) return item;
        found = true;
        return { ...item, ...patch };
      });
      if (!found) windows.push({ ...emptyWindowActivity(gid, name), ...patch });
      return { ...current, windows };
    });
  }, []);

  const setTodo = useCallback(async (gid: number, name: string, todo: boolean) => {
    // Revision guards stop a GET that began before/during this POST from repainting stale state.
    revisionRef.current += 1;
    try {
      await api.post(`/groups/${gid}/windows/${encodeURIComponent(name)}/todo`, { todo });
      patchWindow(gid, name, { todo });
    } finally {
      revisionRef.current += 1;
      load().catch(() => {});
    }
  }, [load, patchWindow]);

  const acknowledge = useCallback(async (
    gid: number,
    name: string,
    clearTodo: boolean,
    clearAttention: boolean,
  ) => {
    if (!clearTodo && !clearAttention) return;
    revisionRef.current += 1;
    try {
      const result = await api.post(`/groups/${gid}/windows/${encodeURIComponent(name)}/ack`, {
        clearTodo,
        clearAttention,
      });
      const patch: Partial<WindowActivity> = {};
      if (clearTodo) patch.todo = false;
      // A newer turn may have replaced the green state before this request reached tmux. The
      // server's eventId CAS reports that race; never paint the newer yellow turn gray locally.
      if (clearAttention && result?.attentionCleared) {
        patch.phase = 'idle';
        patch.reason = 'acknowledged';
        patch.detail = null;
        patch.updatedAt = new Date().toISOString();
      }
      patchWindow(gid, name, patch);
    } finally {
      revisionRef.current += 1;
      load().catch(() => {});
    }
  }, [load, patchWindow]);

  return { activities: snapshot.windows, observedAt: snapshot.observedAt, setTodo, acknowledge };
}

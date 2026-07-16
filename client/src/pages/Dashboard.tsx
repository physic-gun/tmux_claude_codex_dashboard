import { useEffect, useState, useCallback, useRef, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Group, WindowsResp } from '../types';
import GroupSidebar from '../components/GroupSidebar';
import TabBar from '../components/TabBar';
import TerminalView from '../components/TerminalView';
import QuickCommands from '../components/QuickCommands';
import BackgroundWindows from '../components/BackgroundWindows';
import HelpModal from '../components/HelpModal';
import SettingsModal from '../components/SettingsModal';
import SessionHistoryModal from '../components/SessionHistoryModal';
import RepoPanel from '../components/RepoPanel';

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [groups, setGroups] = useState<Group[]>([]);
  // Restore the last-open group/tab across reloads (validated against what still exists).
  const [activeGid, setActiveGid] = useState<number | null>(() => {
    const s = localStorage.getItem('tmuxdash:activeGid');
    return s ? Number(s) : null;
  });
  const [windows, setWindows] = useState<WindowsResp>({ open: [], background: [] });
  const [activeWindow, setActiveWindow] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('tmuxdash:sidebar') === '1');
  const [tabsCollapsed, setTabsCollapsed] = useState(() => localStorage.getItem('tmuxdash:tabrow') === '1');
  // The right source-control rail mirrors the left sidebar's collapse/persist behaviour.
  const [scmCollapsed, setScmCollapsed] = useState(() => localStorage.getItem('tmuxdash:scm') === '1');
  // Mobile text-selection mode: a one-finger drag selects + copies terminal text (off = scroll/type).
  const [selectMode, setSelectMode] = useState(() => localStorage.getItem('tmuxdash:selectMode') === '1');
  // Mobile mode: tapping the CLI won't pop the soft keyboard (input goes through the on-screen
  // keyboard / editor buttons instead). Auto-detected from a coarse (touch) pointer, but the
  // stored value ('1'/'0') overrides the guess so a touch laptop or the reverse can be corrected.
  const [mobile, setMobile] = useState(() => {
    const saved = localStorage.getItem('tmuxdash:mobile');
    if (saved === '1' || saved === '0') return saved === '1';
    try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
  });
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  function toggleSidebar() {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem('tmuxdash:sidebar', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  // Collapse the whole tab row to give the terminal more height; a floating button restores it.
  function toggleTabs() {
    setTabsCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem('tmuxdash:tabrow', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  function toggleScm() {
    setScmCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem('tmuxdash:scm', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  function toggleSelectMode() {
    setSelectMode((c) => {
      const next = !c;
      try { localStorage.setItem('tmuxdash:selectMode', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  // Force mobile mode on/off, overriding the auto-detected default (persisted).
  function toggleMobile() {
    setMobile((c) => {
      const next = !c;
      try { localStorage.setItem('tmuxdash:mobile', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  // Global shortcuts: Ctrl+Alt+1/2/3 collapse-toggle the left sidebar / tab row / git rail.
  // Captured at the document (capture phase) so they fire even when the terminal is focused and
  // are stopped before xterm forwards them to the pty. AltGr (reported as Ctrl+Alt on some
  // layouts) is excluded so the combo can't hijack AltGr character entry. A ref keeps the
  // listener attached once while always calling the latest toggles.
  const shortcutsRef = useRef({ toggleSidebar, toggleTabs, toggleScm });
  shortcutsRef.current = { toggleSidebar, toggleTabs, toggleScm };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey || e.repeat) return;
      if (e.getModifierState?.('AltGraph')) return;
      const t = shortcutsRef.current;
      let hit = true;
      if (e.code === 'Digit1') t.toggleSidebar();
      else if (e.code === 'Digit2') t.toggleTabs();
      else if (e.code === 'Digit3') t.toggleScm();
      else hit = false;
      if (hit) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const loadGroups = useCallback(async () => {
    const g: Group[] = await api.get('/groups');
    setGroups(g);
    setActiveGid((prev) => (prev && g.some((x) => x.id === prev) ? prev : g[0]?.id ?? null));
  }, []);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // Live activeGid for async guards: a windows response for a group the user has already left
  // (a 4s poll or a trailing reload that was in flight during the switch) must be dropped, not
  // applied — otherwise it would resurrect the old group's tabs/activeWindow under the new one.
  const activeGidRef = useRef(activeGid);
  activeGidRef.current = activeGid;

  // Tracks which group the live `activeWindow` belongs to, so a poll refresh keeps the current
  // tab, but switching groups (or returning to one) restores THAT group's last-opened tab — even
  // when both groups happen to have a same-named tab (e.g. "main").
  const loadedGidRef = useRef<number | null>(null);
  const loadWindows = useCallback(async (gid: number) => {
    const w: WindowsResp = await api.get(`/groups/${gid}/windows`);
    if (activeGidRef.current !== gid) return; // group switched while in flight — stale response
    setWindows(w);
    const sameGroup = loadedGidRef.current === gid;
    loadedGidRef.current = gid;
    setActiveWindow((prev) => {
      if (sameGroup && prev && w.open.includes(prev)) return prev; // poll refresh: keep current tab
      const saved = localStorage.getItem(`tmuxdash:win:${gid}`);
      if (saved && w.open.includes(saved)) return saved;           // switch/return: restore last tab
      return w.open[0] ?? null;
    });
  }, []);

  // Persist the active group; the per-tab choice is saved on explicit selection (see selectWindow).
  useEffect(() => {
    if (activeGid != null) {
      try { localStorage.setItem('tmuxdash:activeGid', String(activeGid)); } catch {}
    }
  }, [activeGid]);

  // Select a tab and remember it for this group (so a reload/reconnect returns to it).
  const selectWindow = useCallback((name: string) => {
    setActiveWindow(name);
    setActiveGid((gid) => {
      if (gid != null) { try { localStorage.setItem(`tmuxdash:win:${gid}`, name); } catch {} }
      return gid;
    });
  }, []);

  // Terminal pool: every tab VISITED in the current group stays mounted (hidden when inactive),
  // so switching back is instant — no xterm/WebSocket/pty teardown+rebuild. Lazy: a tab is only
  // mounted on its first activation (eager-mounting all open tabs would spawn N ptys on every
  // group switch). Pruned when a window is closed/killed.
  const [pool, setPool] = useState<string[]>([]);
  // Group switch: reset the pool + active window DURING RENDER (React's adjust-state-on-prop-
  // change pattern — it re-renders before committing). Clearing in an effect would run AFTER the
  // commit, so the first render of the new gid would still mount the ENTIRE old pool under the
  // new gid's keys: N wasted xterm/WebGL/WS spawns per switch, torn down one render later.
  const [poolGid, setPoolGid] = useState(activeGid);
  if (poolGid !== activeGid) {
    setPoolGid(activeGid);
    setPool([]);
    setActiveWindow(null);
  }
  useEffect(() => {
    if (activeWindow) setPool((p) => (p.includes(activeWindow) ? p : [...p, activeWindow]));
  }, [activeWindow]);
  useEffect(() => {
    setPool((p) => {
      const n = p.filter((w) => windows.open.includes(w));
      return n.length === p.length ? p : n; // keep the reference stable on the 4s poll
    });
  }, [windows.open]);

  useEffect(() => {
    if (activeGid != null) {
      loadWindows(activeGid);
    } else {
      setWindows({ open: [], background: [] });
    }
  }, [activeGid, loadWindows]);

  // True while a tab reorder is being persisted, so the background poll doesn't clobber the
  // optimistic order with a stale (pre-commit) server response.
  const reorderingRef = useRef(false);

  // Poll so tab labels track each window's live agent title (Claude OSC or Codex thread state).
  useEffect(() => {
    if (activeGid == null) return;
    const id = setInterval(() => {
      if (reorderingRef.current) return;
      loadWindows(activeGid).catch(() => {});
    }, 4000);
    return () => clearInterval(id);
  }, [activeGid, loadWindows]);

  async function createGroup(name: string) {
    const g = await api.post('/groups', { name });
    await loadGroups();
    setActiveGid(g.id);
  }

  async function createGroupWithPath(name: string, path: string) {
    const g = await api.post('/groups', { name, path });
    await loadGroups();
    setActiveGid(g.id);
  }

  // Open a new tab in the given group and resume the Claude session there.
  async function resumeSession(gid: number, sessionId: string) {
    const r = await api.post(`/groups/${gid}/windows/resume`, { sessionId });
    setSessionsOpen(false);
    setActiveGid(gid);
    await loadWindows(gid);
    if (r?.name) selectWindow(r.name);
  }

  // Persist a new tab order for the active group. Optimistic: reorder locally now (so the drag/menu
  // action feels instant), persist to the server (windows.sort_order), then reload to reconcile.
  async function reorderWindows(order: string[]) {
    if (activeGid == null) return;
    reorderingRef.current = true;
    setWindows((w) => ({ ...w, open: order }));
    try {
      try { await api.post(`/groups/${activeGid}/windows/reorder`, { order }); } catch { /* loadWindows restores truth */ }
      await loadWindows(activeGid);
    } finally {
      reorderingRef.current = false;
    }
  }

  async function reorderGroups(ids: number[]) {
    // Optimistic: reorder locally now, persist, then reload to reconcile.
    setGroups((gs) => ids.map((id) => gs.find((g) => g.id === id)).filter(Boolean) as Group[]);
    try { await api.post('/groups/reorder', { order: ids }); } catch { /* loadGroups restores truth */ }
    await loadGroups();
  }

  async function deleteGroup(id: number) {
    try {
      await api.del(`/groups/${id}`);
    } catch (e) {
      alert('删除分组失败：' + (e as Error).message);
      return;
    }
    if (id === activeGid) setActiveGid(null);
    await loadGroups();
  }

  const enc = (s: string) => encodeURIComponent(s);

  // Open a PLAIN window in the group's shared working dir. Auto-worktree creation is disabled:
  // new tabs are ordinary windows (no isolated git worktree / branch), so the group dir is never
  // auto-converted to a repo. Existing worktree tabs are unaffected.
  async function addWindow(name: string) {
    if (activeGid == null) return;
    const n = name.trim() || `tab-${crypto.randomUUID().slice(0, 6)}`;
    const r = await api.post(`/groups/${activeGid}/windows`, { name: n });
    await loadWindows(activeGid);
    selectWindow((r?.created && r.created[0]) || n);
  }
  // Refresh a group's .gitignore so a later `git init` won't embed nested repos as gitlinks.
  async function updateIgnore(gid: number) {
    try {
      const r = await api.post(`/groups/${gid}/git/ignore-nested`);
      const list: string[] = r?.excluded || [];
      alert(list.length ? `.gitignore 已更新，已排除 ${list.length} 个子仓库：\n${list.join('\n')}` : '.gitignore 已更新（未发现嵌套 git 仓库）。');
    } catch (e) {
      alert('更新 .gitignore 失败：' + (e as Error).message);
    }
  }
  async function closeWindow(name: string) {
    if (activeGid == null) return;
    await api.post(`/groups/${activeGid}/windows/${enc(name)}/close`);
    await loadWindows(activeGid);
  }
  async function reopenWindow(name: string) {
    if (activeGid == null) return;
    await api.post(`/groups/${activeGid}/windows/${enc(name)}/reopen`);
    await loadWindows(activeGid);
    selectWindow(name);
  }
  async function killWindow(name: string) {
    if (activeGid == null) return;
    if (!confirm(`确定结束窗口「${name}」？该窗口内的进程会被终止。`)) return;
    try {
      await api.del(`/groups/${activeGid}/windows/${enc(name)}`);
    } catch (e) {
      alert((e as Error).message);
    }
    await loadWindows(activeGid);
  }
  async function sendCommand(cmd: string) {
    if (activeGid == null || activeWindow == null) return;
    await api.post(`/groups/${activeGid}/windows/${enc(activeWindow)}/send`, { command: cmd });
  }

  // Drive the floating-button resting opacity from the user's setting (percent → 0–1 var).
  const appStyle = { '--float-opacity': String((user?.float_opacity ?? 20) / 100) } as CSSProperties;

  return (
    <div
      className={`app${collapsed ? ' sidebar-collapsed' : ''}${scmCollapsed ? ' scm-collapsed' : ''}`}
      style={appStyle}
    >
      <aside className="sidebar">
        <div className="brand">
          <span>🖥️ Tmux Dashboard</span>
          <button className="icon-btn" title="收起侧栏" onClick={toggleSidebar}>«</button>
        </div>
        <GroupSidebar
          groups={groups}
          activeGid={activeGid}
          onSelect={setActiveGid}
          onCreate={createGroup}
          onCreatePath={createGroupWithPath}
          onDelete={deleteGroup}
          onReorder={reorderGroups}
          onUpdateIgnore={updateIgnore}
        />
        <QuickCommands onRun={sendCommand} canRun={activeWindow != null} />
        <div className="sidebar-footer">
          <button className="who" title="设置（滚动步进等）" onClick={() => setSettingsOpen(true)}>
            {user?.username} ⚙
          </button>
          {user?.is_admin && <Link to="/admin">用户管理</Link>}
          <button className="link" onClick={logout}>退出</button>
        </div>
      </aside>

      <main className="main">
        {!tabsCollapsed && (
          <div className="tabrow">
            {collapsed && (
              <button className="icon-btn" title="展开侧栏" onClick={toggleSidebar}>☰</button>
            )}
            {activeGid == null ? (
              <div className="topbar-spacer" />
            ) : (
              <TabBar
                gid={activeGid}
                windows={windows.open}
                titles={windows.titles}
                branches={windows.branches}
                active={activeWindow}
                onSelect={selectWindow}
                onClose={closeWindow}
                onAddWindow={addWindow}
                onReorder={reorderWindows}
              />
            )}
            <button className="icon-btn" title="Claude 会话历史" onClick={() => setSessionsOpen(true)}>🕘</button>
            <button
              className={`icon-btn${selectMode ? ' on' : ''}`}
              title="选择模式（移动端：单指拖动选择文字并复制；开启时不滚动）"
              onClick={toggleSelectMode}
            >
              选
            </button>
            <button
              className={`icon-btn${mobile ? ' on' : ''}`}
              title="移动端模式（点击 CLI 不弹系统键盘；用右下角“输入/⌨”按钮输入）"
              onClick={toggleMobile}
            >
              📱
            </button>
            <button className="icon-btn help" title="快捷键 / 帮助" onClick={() => setHelpOpen(true)}>?</button>
            <button className="icon-btn" title="收起选项卡栏" onClick={toggleTabs}>▴</button>
          </div>
        )}
        {tabsCollapsed && (
          <button className="tabs-expand-float" title="展开选项卡栏" onClick={toggleTabs}>▾</button>
        )}

        {activeGid == null ? (
          <div className="center">请在左侧创建并选择一个分组</div>
        ) : (
          <>
            <div className="term-area">
              {/* Include the just-activated window in the same render (the pool effect commits it
                  a beat later) so a first visit never flashes the empty-state placeholder. */}
              {(activeWindow && !pool.includes(activeWindow) ? [...pool, activeWindow] : pool).map((w) => (
                <div
                  key={`${activeGid}:${w}`}
                  className="term-slot"
                  style={w === activeWindow ? undefined : { display: 'none' }}
                >
                  <TerminalView
                    gid={activeGid}
                    windowName={w}
                    active={w === activeWindow}
                    stepSmall={user?.scroll_step_small ?? 20}
                    stepBig={user?.scroll_step_big ?? 60}
                    scrollAuto={!!user?.scroll_auto}
                    fontFamily={user?.term_font}
                    selectMode={selectMode}
                    mobile={mobile}
                  />
                </div>
              ))}
              {!activeWindow && (
                <div className="center">没有打开的窗口，点击选项卡栏的 ＋ 新建隔离 agent（独立 worktree + 分支，留空=随机分支名）</div>
              )}
            </div>
            <BackgroundWindows windows={windows.background} onReopen={reopenWindow} onKill={killWindow} />
          </>
        )}
        {scmCollapsed && (
          <button className="icon-btn scm-reopen" title="展开源代码管理" onClick={toggleScm}>⎇</button>
        )}
      </main>

      <aside className="scm-rail">
        <RepoPanel gid={activeGid} onToggleCollapse={toggleScm} />
      </aside>

      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {sessionsOpen && (
        <SessionHistoryModal onClose={() => setSessionsOpen(false)} onResume={resumeSession} />
      )}
    </div>
  );
}

export interface User {
  id: number;
  username: string;
  is_admin: boolean;
  scroll_step_small: number;
  scroll_step_big: number;
  // When 1, derive the scroll steps from the live terminal row count instead of the fixed values.
  scroll_auto?: number;
  // Preferred terminal font family ('' / undefined → the built-in monospace stack).
  term_font?: string;
  // Resting opacity (percent, 5–100) of the floating restore buttons. Default 20.
  float_opacity?: number;
}

export interface Group {
  id: number;
  name: string;
  path?: string | null;
  created_at?: string;
}

export interface WindowsResp {
  open: string[];
  background: string[];
  // live pane titles (e.g. claude's session name) keyed by window name
  titles?: Record<string, string>;
  // claude session id bound to each window, keyed by window name
  sessions?: Record<string, string>;
  // git branch for isolated-agent (worktree) windows, keyed by window name
  branches?: Record<string, string>;
}

export interface ClaudeSession {
  id: string;
  shortId: string;
  mtime: number;
  label: string;
  active: boolean;
}

export interface SessionGroup {
  gid: number;
  group: string;
  sessions: ClaudeSession[];
}

export interface QuickCommand {
  id: number;
  label: string;
  command: string;
}

export interface AdminUser {
  id: number;
  username: string;
  is_admin: number;
  created_at: string;
}

// ---- git source-control panel ----

export interface TrackedRepo {
  id: number;
  repoPath: string;
  relPath: string; // relative to the group dir ('.' = the group dir itself)
  name: string; // basename, for display
}

// Mirrors the server's /git/status response, which is one of two shapes: a success object (the
// status fields spread from repoStatus()) or a per-repo failure object ({ ok:false, error }).
// The status fields are therefore optional — present only when ok — and the badge code reads
// them after the `!s.ok` guard. (`error` is likewise present only on the failure shape.)
export interface RepoStatus {
  id: number;
  ok: boolean;
  dirty?: boolean;
  changedFiles?: number;
  ahead?: number;
  behind?: number;
  branch?: string;
  detached?: boolean;
  upstream?: boolean;
  error?: 'missing' | 'timeout' | 'not_a_repo' | 'error';
}

export interface TrackableFolder {
  path: string;
  relPath: string;
  name: string;
  tracked: boolean;
}

export interface RepoFile {
  path: string;
  status: 'M' | 'A' | 'D' | 'U' | '?'; // no 'R' — we run --no-renames
  index: string;
  worktree: string;
  staged: boolean;
  untracked: boolean;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface FileDiff {
  path: string;
  binary: boolean;
  truncated: boolean;
  added?: boolean;
  deleted?: boolean;
  staged: string; // unified-diff patch text (index vs HEAD), '' if none
  unstaged: string; // unified-diff patch text (worktree vs index), '' if none
  language?: string;
  error?: string;
}

// Result of a commit / pull / push: ok=true on success; on failure `output` carries the raw git
// text for the copy-the-error popup, and `conflict` flags a merge conflict / rejected push.
export interface GitActionResult {
  ok: boolean;
  conflict?: boolean;
  output: string;
}

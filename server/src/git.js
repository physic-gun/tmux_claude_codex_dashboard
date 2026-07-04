import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { WORKTREE_DIRNAME } from './workspace.js';

const execFileP = promisify(execFile);

const GIT_TIMEOUT = 5000; // ms; the local status calls we make are fast
const MAX_DIFF_BYTES = 1.5 * 1024 * 1024; // pre-flight truncation gate (used by the Phase 2 diff route)
const MAX_BUFFER = 6 * 1024 * 1024; // hard ceiling on a git child's stdout; MUST stay > MAX_DIFF_BYTES

export { MAX_DIFF_BYTES };

// Build-/dependency-output dirs we never descend into while hunting for repos: they are huge,
// never themselves a tracked project root, and would blow the visited-dir budget for nothing.
const SKIP = new Set([
  'node_modules', '.cache', 'dist', 'build', '.venv', 'venv',
  '.next', 'target', '.terraform', 'vendor', WORKTREE_DIRNAME,
]);

// Map an execFile rejection to a stable machine code the UI can translate to Chinese.
// Note: a hung call is killed by execFile's `timeout` (SIGTERM) and surfaces as killed/ETIMEDOUT.
function classifyGitError(err) {
  // Output overflow also kills the child (killed/SIGTERM), so check it BEFORE the timeout branch
  // or a too-large status would mis-report as "timeout".
  if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'error';
  if (err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT') return 'timeout';
  const text = `${err?.stderr || ''}`.toLowerCase();
  if (text.includes('not a git repository')) return 'not_a_repo';
  return 'error'; // includes ENOENT (git missing) — never a 500 for the whole /status
}

// Run `git -C <cwd> <args>` with no shell, bounded output, and a timeout so a wedged git
// can't hang a request. `ignoreExit` accepts an exit-1-with-stdout result (e.g.
// `diff --no-index` returns 1 *when a diff exists*, like grep) which the promisified
// execFile would otherwise reject — dropping the stdout we actually want.
export async function git(cwd, args, { timeout = GIT_TIMEOUT, ignoreExit = false } = {}) {
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return { ok: true, stdout, code: 0 };
  } catch (err) {
    if (ignoreExit && err.code === 1 && typeof err.stdout === 'string') {
      return { ok: true, stdout: err.stdout, code: 1 };
    }
    return {
      ok: false,
      stdout: err.stdout || '',
      code: err.code,
      signal: err.signal,
      error: classifyGitError(err),
    };
  }
}

// Is `dir` a real git working tree? Accepts submodules / linked worktrees (where `.git`
// is a file, not a dir) because rev-parse resolves those too.
export async function isGitRepo(dir) {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

// Depth-limited, async, result- AND visited-capped scan for git working trees under `base`.
// Async fs (never block the event loop on a big or custom-path tree). Symlink-safe: every
// step is realpath'd and constrained to stay inside realpath(base), and we recurse into the
// *resolved* path so discovered repo paths come back canonical — matching what
// resolveRepoInGroup later stores, so the "already tracked" join is reliable.
export async function findGitRepos(base, { maxDepth = 3, maxResults = 500, maxVisited = 5000 } = {}) {
  const out = new Set();
  let root;
  try {
    root = await fs.promises.realpath(base);
  } catch {
    return [];
  }
  let visited = 0;
  const walk = async (dir, depth) => {
    if (out.size >= maxResults || depth > maxDepth || ++visited > maxVisited) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // A repo: record it and STOP — we don't list nested submodules separately.
    if (entries.some((e) => e.name === '.git')) {
      out.add(dir);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      let real;
      try {
        real = await fs.promises.realpath(path.join(dir, e.name));
      } catch {
        continue;
      }
      // Containment (mirrors workspace.js groupDirPath; the `=== root` half guards the
      // string-prefix bug where /a/proj is a prefix of /a/proj-evil).
      if (real !== root && !real.startsWith(root + path.sep)) continue;
      await walk(real, depth + 1);
    }
  };
  if (fs.existsSync(path.join(root, '.git'))) out.add(root); // the group dir itself may be a repo
  else await walk(root, 1);
  return [...out];
}

// Cheap per-repo status from a single porcelain-v2 call. ahead/behind come from local refs
// (no network fetch). Per-repo failure is reported as { ok:false, error }, never thrown — a
// broken repo must not take down the whole /status response.
export async function repoStatus(dir) {
  const r = await git(dir, [
    '-c', 'color.ui=false',
    'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--no-renames',
  ]);
  if (!r.ok) return { ok: false, error: r.error || 'error' };

  let branch = '';
  let detached = false;
  let upstream = false;
  let ahead = 0;
  let behind = 0;
  let changedFiles = 0;

  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    if (line[0] === '#') {
      if (line.startsWith('# branch.head ')) {
        const head = line.slice('# branch.head '.length).trim();
        if (head === '(detached)') detached = true;
        else branch = head;
      } else if (line.startsWith('# branch.upstream ')) {
        upstream = true;
      } else if (line.startsWith('# branch.ab ')) {
        // "# branch.ab +<ahead> -<behind>" — present only when an upstream exists.
        const m = line.match(/\+(-?\d+)\s+-(-?\d+)/);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
      continue;
    }
    changedFiles += 1; // any non-# line is a changed path
  }

  // Defensive: a missing branch.head (very old git, or an odd state) ⇒ treat as detached.
  if (!branch && !detached) detached = true;

  // A detached primary checkout is the dashboard's worktree scheme: the group dir is pure repo
  // STORAGE (real branches — main/master + per-tab agents — live in linked worktrees), so the
  // porcelain view has no branch and no upstream → ahead/behind can never surface. The user works
  // and pushes on the MAIN line, so persistently report that branch's REF status (name +
  // ahead/behind vs its upstream) instead of a useless detached HEAD. Ref-only: no working-tree
  // dirty state (that lives in whichever worktree has the branch checked out).
  if (detached) {
    const view = await primaryBranchRefStatus(dir);
    if (view) return view;
  }

  return {
    ok: true,
    branch,
    detached,
    upstream,
    dirty: changedFiles > 0,
    changedFiles,
    ahead,
    behind,
  };
}

// Ref-only status of a detached repo's PRIMARY branch: origin's advertised default branch if a
// remote sets one (refs/remotes/origin/HEAD), else local `main`, else local `master` (the default
// branch isn't always named main). Returns { branch, ahead, behind, upstream } with no dirty
// state, or null when none of those branches exist (leave the caller's detached view as-is). All
// reads are local + fast; the network refresh (fetch) happens separately on the manual refresh.
async function primaryBranchRefStatus(dir) {
  let branch = '';
  const originHead = await git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead.ok) branch = originHead.stdout.trim().replace(/^origin\//, '');
  if (!branch) {
    for (const cand of ['main', 'master']) {
      if (await branchExists(dir, cand)) { branch = cand; break; }
    }
  }
  if (!branch) return null;

  let upstream = false;
  let ahead = 0;
  let behind = 0;
  const up = await git(dir, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`]);
  const upName = up.ok ? up.stdout.trim() : '';
  if (upName) {
    upstream = true;
    // `A...B --left-right --count` → "<ahead>\t<behind>": commits in branch-not-upstream, then
    // upstream-not-branch.
    const ab = await git(dir, ['rev-list', '--left-right', '--count', `${branch}...${upName}`]);
    if (ab.ok) {
      const m = ab.stdout.trim().split(/\s+/);
      ahead = Number(m[0]) || 0;
      behind = Number(m[1]) || 0;
    }
  }
  return { ok: true, branch, detached: false, upstream, dirty: false, changedFiles: 0, ahead, behind };
}

// Parse `git diff --numstat -z [--cached]` into a map: path -> { adds, dels, binary }.
// numstat columns are a '-' for binary files; -z makes each record NUL-terminated.
async function numstatMap(dir, cached) {
  // --no-renames so the output matches repoFiles' porcelain view (a rename = D + A); otherwise
  // git emits a single rename record whose -z format wouldn't join back to either path.
  const args = ['diff', '--numstat', '-z', '--no-renames'];
  if (cached) args.push('--cached');
  const r = await git(dir, args);
  const map = new Map();
  if (!r.ok) return map;
  for (const rec of r.stdout.split('\0')) {
    if (!rec) continue;
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    map.set(m[3], { adds: binary ? 0 : Number(m[1]), dels: binary ? 0 : Number(m[2]), binary });
  }
  return map;
}

// Changed-file list for one repo (the diff page's middle column). porcelain v1 -z is safe for
// spaces/newlines/unicode in paths; --no-renames means a rename shows as D + A/?? (no 'R').
// Per-file +/- and binary come from numstat. status ∈ 'M' | 'A' | 'D' | 'U' | '?'.
export async function repoFiles(dir) {
  const headRef = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = headRef.ok ? headRef.stdout.trim() : '';
  const detached = !headRef.ok; // symbolic-ref fails on a detached HEAD

  const st = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (!st.ok) return { ok: false, error: st.error || 'error' };

  const [unstaged, staged] = await Promise.all([numstatMap(dir, false), numstatMap(dir, true)]);

  const files = [];
  for (const rec of st.stdout.split('\0')) {
    if (!rec) continue;
    const x = rec[0];
    const y = rec[1];
    const p = rec.slice(3); // "XY <path>"
    const untracked = x === '?' && y === '?';
    const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    let status;
    if (untracked) status = '?';
    else if (conflict) status = 'U';
    else {
      const s = x !== ' ' && x !== '?' ? x : y;
      status = s === 'A' ? 'A' : s === 'D' ? 'D' : 'M';
    }
    const staged_ = !untracked && x !== ' ' && x !== '?';
    const u = unstaged.get(p);
    const g = staged.get(p);
    files.push({
      path: p,
      index: x,
      worktree: y,
      status,
      staged: staged_,
      untracked,
      additions: (u?.adds || 0) + (g?.adds || 0),
      deletions: (u?.dels || 0) + (g?.dels || 0),
      binary: !!(u?.binary || g?.binary),
    });
  }
  return { ok: true, branch, detached, files };
}

// Single-file diff for the preview pane. Returns BOTH the staged (index vs HEAD) and unstaged
// (worktree vs index) unified-patch sections so a partially-staged file shows both; untracked
// files diff against /dev/null (exit 1 = "there is a diff", hence ignoreExit). A diff bigger
// than MAX_DIFF_BYTES is reported truncated with the body omitted; binary files carry no body.
export async function fileDiff(dir, relFile) {
  const base = { path: relFile, binary: false, truncated: false, staged: '', unstaged: '' };

  // A diff so large it overflows MAX_BUFFER is far past MAX_DIFF_BYTES — report it as truncated
  // rather than letting git()'s ok:false collapse the section to '' (which would read as "no diff").
  const tooBig = (g) => g.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

  const tracked = await git(dir, ['ls-files', '--error-unmatch', '--', relFile]);
  if (!tracked.ok) {
    // Untracked: whole-file diff vs /dev/null.
    const r = await git(dir, ['diff', '--no-color', '--no-index', '--', '/dev/null', relFile], { ignoreExit: true });
    if (!r.ok) {
      if (tooBig(r)) return { ...base, added: true, truncated: true };
      return { ...base, added: true, error: r.error || 'error' };
    }
    if (/^Binary files /m.test(r.stdout)) return { ...base, added: true, binary: true };
    if (r.stdout.length > MAX_DIFF_BYTES) return { ...base, added: true, truncated: true };
    return { ...base, added: true, unstaged: r.stdout };
  }

  // Tracked: staged + unstaged sections (either may be empty).
  const [staged, unstaged] = await Promise.all([
    git(dir, ['diff', '--no-color', '--cached', '--', relFile], { ignoreExit: true }),
    git(dir, ['diff', '--no-color', '--', relFile], { ignoreExit: true }),
  ]);
  if (tooBig(staged) || tooBig(unstaged)) return { ...base, truncated: true };
  const sText = staged.ok ? staged.stdout : '';
  const uText = unstaged.ok ? unstaged.stdout : '';
  if (/^Binary files /m.test(sText) || /^Binary files /m.test(uText)) return { ...base, binary: true };
  if (sText.length + uText.length > MAX_DIFF_BYTES) return { ...base, truncated: true };
  return { ...base, staged: sText, unstaged: uText };
}

// ---- write actions (commit / pull / push) ----

const GIT_NET_TIMEOUT = 90000; // network ops (pull/push) can be slow — well above the local 5s

// Run a git command with a strictly NON-INTERACTIVE environment so it can never hang a request
// waiting on a credential / SSH passphrase / host-key / editor prompt — it fails fast instead.
// Captures stdout AND stderr combined, because the user needs the full git output on a conflict,
// a rejected push, or an auth failure (that's what the copy-the-error popup shows).
async function gitExec(cwd, args, { timeout = GIT_NET_TIMEOUT } = {}) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0', // never prompt for https credentials
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15',
    GCM_INTERACTIVE: 'never', // git-credential-manager: don't pop UI
    GIT_EDITOR: 'true', // never spawn an editor (e.g. a merge commit message) — would hang
  };
  try {
    const { stdout, stderr } = await execFileP('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env,
    });
    return { ok: true, output: `${stdout || ''}${stderr || ''}`.trim() };
  } catch (err) {
    if (err.killed || err.code === 'ETIMEDOUT') {
      return { ok: false, output: '操作超时（可能在等待认证或网络无响应）。请在终端里手动执行该 git 操作。' };
    }
    const out = `${err.stdout || ''}${err.stderr || ''}`.trim();
    return { ok: false, output: out || classifyGitError(err) };
  }
}

// Stage everything (incl. untracked) then commit — there is no staging UI, so a commit means
// "commit all current changes". `add -A` is harmless; the commit may still fail (nothing to commit).
export async function gitCommit(dir, message) {
  const add = await gitExec(dir, ['add', '-A'], { timeout: GIT_TIMEOUT });
  if (!add.ok) return { ok: false, output: add.output || '暂存改动失败' };
  const r = await gitExec(dir, ['commit', '-m', message], { timeout: GIT_TIMEOUT });
  return { ok: r.ok, output: r.output || (r.ok ? '已提交' : '提交失败') };
}

// Merge-pull (never rebase, never open an editor). A conflict / "local changes would be
// overwritten" comes back as ok:false with the git output for the copy-the-error popup.
export async function gitPull(dir) {
  const r = await gitExec(dir, ['pull', '--no-edit', '--no-rebase']);
  if (r.ok) return { ok: true, output: r.output || '已是最新' };
  const conflict = /CONFLICT|Automatic merge failed|Merge conflict|needs merge|would be overwritten/i.test(r.output);
  return { ok: false, conflict, output: r.output || '拉取失败' };
}

export async function gitPush(dir) {
  const r = await gitExec(dir, ['push']);
  if (r.ok) return { ok: true, output: r.output || '已推送' };
  const conflict = /rejected|non-fast-forward|fetch first|failed to push/i.test(r.output);
  return { ok: false, conflict, output: r.output || '推送失败' };
}

// Best-effort, NON-INTERACTIVE fetch so a subsequent repoStatus() reports the TRUE remote
// behind/ahead instead of stale local refs. Network-bound, so a tighter-than-pull timeout keeps
// a manual refresh from hanging on one unreachable remote. Returns the gitExec result; callers
// treat any failure (offline / auth / no remote) as a no-op and fall back to local refs.
export async function gitFetch(dir) {
  return gitExec(dir, ['fetch', '--quiet'], { timeout: 20000 });
}

// ---- isolated-agent worktrees (one group = one repo; one window = one branch + worktree) ----

// Seed .gitignore for a freshly-init'd group repo: keep build/dep output, editor cruft, the
// agent worktrees dir, and Claude's per-dir store out of the tree.
export const DEFAULT_GITIGNORE = [
  '# created by tmux-dashboard',
  'node_modules/', 'dist/', 'build/', '.next/', 'target/', 'venv/', '.venv/',
  '.DS_Store', '.claude/', `${WORKTREE_DIRNAME}/`,
].join('\n') + '\n';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IGN_BEGIN = '# >>> tmux-dashboard: nested git repos (do not edit) >>>';
const IGN_END = '# <<< tmux-dashboard: nested git repos <<<';

// Does a local branch exist in `dir`?
export async function branchExists(dir, branch) {
  const r = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.ok && r.stdout.trim() !== '';
}

// Make `dir` a git repo on branch `main` if it isn't one already (no-op otherwise). Writes the
// default + nested-repo .gitignore FIRST (so the initial commit pulls in neither deps/worktrees
// nor nested repos as gitlinks), forces the branch name to `main` regardless of the host's
// init.defaultBranch, sets an inline identity (works on servers with no global git user), then
// DETACHES the primary checkout — so `main` is free to be checked out in a worktree and the group
// dir itself is never an agent workspace (every tab, including main, is its own worktree).
export async function ensureRepoInited(dir) {
  if (await isGitRepo(dir)) return { ok: true, already: true };
  try {
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, DEFAULT_GITIGNORE);
  } catch (e) {
    return { ok: false, output: `写入 .gitignore 失败：${e?.message || e}` };
  }
  let r = await gitExec(dir, ['init'], { timeout: GIT_TIMEOUT });
  if (!r.ok) return { ok: false, output: r.output || 'git init 失败' };
  // Point the unborn HEAD at main before the first commit → portable across git versions.
  await gitExec(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { timeout: GIT_TIMEOUT });
  await refreshNestedRepoIgnore(dir); // never embed nested repos as gitlinks
  await gitExec(dir, ['add', '-A'], { timeout: GIT_TIMEOUT });
  r = await gitExec(
    dir,
    ['-c', 'user.email=dashboard@tmux.local', '-c', 'user.name=tmux-dashboard',
      'commit', '--allow-empty', '-m', 'chore: init (tmux-dashboard)'],
    { timeout: GIT_TIMEOUT }
  );
  if (!r.ok) return { ok: false, output: r.output || '初始提交失败' };
  // Free the `main` branch for a worktree (group dir becomes pure repo storage).
  await gitExec(dir, ['checkout', '--detach'], { timeout: GIT_TIMEOUT });
  return { ok: true };
}

// Add a linked worktree at `wtPath`. By default creates a NEW branch off `startPoint`; pass
// newBranch:false to check out an EXISTING branch (used for the default `main` worktree).
export async function addWorktree(repoDir, wtPath, branch, { startPoint = 'HEAD', newBranch = true } = {}) {
  const args = newBranch
    ? ['worktree', 'add', '-b', branch, wtPath, startPoint]
    : ['worktree', 'add', wtPath, branch];
  const r = await gitExec(repoDir, args, { timeout: GIT_TIMEOUT });
  return { ok: r.ok, output: r.output };
}

// Remove a linked worktree. git REFUSES by default if it has uncommitted changes (so work is
// never silently lost); pass force only on explicit user confirmation.
export async function removeWorktree(repoDir, wtPath, { force = false } = {}) {
  const args = ['worktree', 'remove', wtPath];
  if (force) args.push('--force');
  const r = await gitExec(repoDir, args, { timeout: GIT_TIMEOUT });
  return { ok: r.ok, output: r.output };
}

// Rewrite a managed block in `dir`/.gitignore listing every NESTED git repo (so a group-level
// `git init` won't embed them as gitlinks). Idempotent — only the marked block changes.
// Returns the excluded relative paths.
export async function refreshNestedRepoIgnore(dir) {
  let root;
  try { root = await fs.promises.realpath(dir); } catch { root = path.resolve(dir); }
  const repos = await findGitRepos(root, { maxDepth: 4 });
  const rels = repos
    .map((r) => path.relative(root, r))
    .filter((rel) => rel && !rel.startsWith('..')) // drop the group dir itself
    .map((rel) => rel.split(path.sep).join('/') + '/')
    .sort();
  const block = [IGN_BEGIN, ...rels, IGN_END].join('\n') + '\n';
  const p = path.join(dir, '.gitignore');
  let existing = '';
  try { existing = fs.readFileSync(p, 'utf8'); } catch {}
  const re = new RegExp(`${esc(IGN_BEGIN)}[\\s\\S]*?${esc(IGN_END)}\\n?`);
  const next = re.test(existing)
    ? existing.replace(re, block)
    : (existing ? existing.replace(/\n?$/, '\n') : '') + block;
  try { fs.writeFileSync(p, next); } catch (e) {
    return { ok: false, output: `写入 .gitignore 失败：${e?.message || e}` };
  }
  return { ok: true, excluded: rels };
}

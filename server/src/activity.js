import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import * as tmux from './tmux.js';
import { isClaudePane } from './scrollRouting.js';

const execFileP = promisify(execFile);
const SNAPSHOT_TTL_MS = 650;
const VALID_AGENTS = new Set(['claude', 'codex']);
const VALID_PHASES = new Set(['idle', 'working', 'attention']);
const VALID_REASONS = new Set([
  'session_started',
  'prompt_submitted',
  'permission',
  'question',
  'agent_needs_input',
  'idle_prompt',
  'resumed',
  'completed',
  'failed',
  'interrupted',
  'abnormal_exit',
  'acknowledged',
  'detected',
  'idle',
  'notification',
]);
const RESUME_REASONS = new Set(['permission', 'question', 'agent_needs_input', 'idle_prompt']);
const VALID_DETAILS = new Set([
  'permission',
  'question',
  'idle_prompt',
  'agent_needs_input',
  'rate_limit',
  'overloaded',
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'unknown',
]);
const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_OPTION_BYTES = 4096;

let snapshotCache = null;

function isoTimestamp(value) {
  const millis = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(millis) || millis <= 0) return null;
  try { return new Date(millis).toISOString(); } catch { return null; }
}

// Pane options are an untrusted boundary: users can set them manually from tmux. Only a compact,
// versioned, enum-constrained object is admitted; malformed/oversized values are ignored atomically.
export function parsePaneActivity(raw) {
  const text = String(raw || '');
  if (!text || Buffer.byteLength(text) > MAX_OPTION_BYTES) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || value.v !== 1 || !VALID_AGENTS.has(value.agent) || !VALID_PHASES.has(value.phase)) return null;
  if (!VALID_REASONS.has(value.reason)) return null;
  const updatedAt = isoTimestamp(value.updatedAt);
  if (!updatedAt) return null;
  const eventId = typeof value.eventId === 'string' && EVENT_ID_RE.test(value.eventId)
    ? value.eventId
    : null;
  const detail = typeof value.detail === 'string' && VALID_DETAILS.has(value.detail)
    ? value.detail
    : null;
  return {
    agent: value.agent,
    phase: value.phase,
    reason: value.reason,
    detail,
    updatedAt,
    eventId,
  };
}

function storedActivity({ agent, phase, reason, detail = null }) {
  return JSON.stringify({
    v: 1,
    agent,
    phase,
    reason,
    ...(detail && VALID_DETAILS.has(detail) ? { detail } : {}),
    eventId: randomUUID(),
    updatedAt: Date.now(),
  });
}

function procStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = raw.lastIndexOf(')');
    if (end < 0) return null;
    const comm = raw.slice(raw.indexOf('(') + 1, end);
    const fields = raw.slice(end + 2).trim().split(/\s+/);
    return { pid, ppid: Number(fields[1]) || 0, comm };
  } catch {
    return null;
  }
}

function procChildren(pid) {
  try {
    return fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((child) => Number.isInteger(child) && child > 0);
  } catch {
    return [];
  }
}

function procCmdline(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { return ''; }
}

function readLinuxProcesses(rootPids) {
  const rows = [];
  const seen = new Set();
  const pending = rootPids.filter((pid) => Number.isInteger(pid) && pid > 0);
  while (pending.length) {
    const pid = pending.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const stat = procStat(pid);
    if (!stat) continue;
    rows.push({ ...stat, cmdline: procCmdline(pid) });
    pending.push(...procChildren(pid));
  }
  return { reliable: true, rows };
}

async function readDarwinProcesses(timeoutMs = 5000) {
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,command='], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    const rows = [];
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const cmdline = match[3].trim();
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        comm: path.basename(cmdline.split(/\s+/, 1)[0] || ''),
        cmdline,
      });
    }
    return { reliable: true, rows };
  } catch {
    return { reliable: false, rows: [] };
  }
}

async function readProcessSnapshot(panes, { timeoutMs = 5000 } = {}) {
  if (process.platform === 'linux') return readLinuxProcesses(panes.map((pane) => pane.panePid));
  if (process.platform === 'darwin') return readDarwinProcesses(timeoutMs);
  return { reliable: false, rows: [] };
}

function nodeEntrypoint(cmdline) {
  const match = /^\s*\S*node(?:\.exe)?\s+(?:--[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(cmdline);
  return (match?.[1] || match?.[2] || match?.[3] || '').toLowerCase();
}

export function agentForProcess(row) {
  const comm = path.basename(String(row?.comm || '')).toLowerCase();
  const cmdline = String(row?.cmdline || '');
  const lower = cmdline.toLowerCase();
  if (comm === 'claude' || comm === 'claude-code') return 'claude';
  if ((comm === 'codex' || comm === 'codex-cli') && !lower.includes('codex-code-mode-host')) return 'codex';
  if (comm !== 'node' && comm !== 'nodejs') return null;
  const entry = nodeEntrypoint(cmdline);
  if (!entry) return null;
  if (/(?:^|[/\\])claude(?:-code)?$/.test(entry) || entry.includes('/@anthropic-ai/claude-code/')) {
    return 'claude';
  }
  if (/(?:^|[/\\])codex(?:-cli)?$/.test(entry) || entry.includes('/@openai/codex/')) return 'codex';
  return null;
}

function processIndex(snapshot) {
  const byPid = new Map();
  const children = new Map();
  for (const row of snapshot?.rows || []) {
    byPid.set(row.pid, row);
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  return { byPid, children };
}

function agentInPane(pane, index) {
  const pending = [pane.panePid];
  const seen = new Set();
  while (pending.length) {
    const pid = pending.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = index.byPid.get(pid);
    const agent = agentForProcess(row);
    if (agent) return agent;
    pending.push(...(index.children.get(pid) || []));
  }
  // Unsupported platforms still get a conservative direct-command fallback. A generic `node`
  // process is not guessed as an agent unless Claude's distinctive title is present.
  if (isClaudePane(pane.command, pane.title)) return 'claude';
  if (['codex', 'codex-cli'].includes(String(pane.command || '').toLowerCase())) return 'codex';
  return null;
}

export function derivePaneActivity(pane, processSnapshot, index = processIndex(processSnapshot)) {
  const stored = parsePaneActivity(pane.activityRaw);
  const detected = agentInPane(pane, index);
  if (stored) {
    // A working hook state with no matching live agent is an abnormal ending. Keep it derived
    // rather than writing during GET, so a read-only poll can never race and overwrite a newer hook.
    if (stored.phase === 'working' && processSnapshot?.reliable && detected !== stored.agent) {
      return { ...stored, phase: 'attention', reason: 'abnormal_exit', detail: null };
    }
    // An acknowledged/idle option must not leave a permanent gray dot after the CLI exits.
    if (stored.phase === 'idle' && processSnapshot?.reliable && detected !== stored.agent) {
      return detected
        ? { agent: detected, phase: 'idle', reason: 'detected', detail: null, updatedAt: null, eventId: null }
        : null;
    }
    return stored;
  }
  return detected
    ? { agent: detected, phase: 'idle', reason: 'detected', detail: null, updatedAt: null, eventId: null }
    : null;
}

const phasePriority = (phase) => ({ attention: 3, working: 2, idle: 1 }[phase] || 0);
export const activityWindowKey = (groupId, window) => `${groupId}\0${window}`;

export function buildActivitySnapshot(panes, processSnapshot, observedAt = new Date().toISOString()) {
  const index = processIndex(processSnapshot);
  const byWindow = new Map();
  for (const pane of panes) {
    const activity = derivePaneActivity(pane, processSnapshot, index);
    if (!activity) continue;
    const candidate = { ...activity, paneId: pane.paneId };
    const key = activityWindowKey(pane.groupId, pane.window);
    const current = byWindow.get(key);
    if (!current || phasePriority(candidate.phase) > phasePriority(current.phase) ||
        (phasePriority(candidate.phase) === phasePriority(current.phase) && pane.active)) {
      byWindow.set(key, candidate);
    }
  }
  return { observedAt, byWindow };
}

export function invalidateActivitySnapshot() {
  snapshotCache = null;
}

export async function getActivitySnapshot({ force = false } = {}) {
  const now = Date.now();
  if (!force && snapshotCache?.value && snapshotCache.expiresAt > now) return snapshotCache.value;
  if (!force && snapshotCache?.pending) return snapshotCache.pending;
  const pending = (async () => {
    const panes = await tmux.listActivityPanes();
    const processes = await readProcessSnapshot(panes);
    return buildActivitySnapshot(panes, processes, new Date().toISOString());
  })();
  snapshotCache = { pending, value: null, expiresAt: now + SNAPSHOT_TTL_MS };
  try {
    const value = await pending;
    // A forced refresh or a state write may have replaced/invalidated this in-flight read. Never
    // let the older completion repopulate the cache over the newer snapshot.
    if (snapshotCache?.pending === pending) {
      snapshotCache = { pending: null, value, expiresAt: Date.now() + SNAPSHOT_TTL_MS };
    }
    return value;
  } catch (error) {
    if (snapshotCache?.pending === pending) snapshotCache = null;
    throw error;
  }
}

export function inputActivitySignal(data) {
  if (data === '\r' || data === '\n' || data === '\r\n') return 'enter';
  if (data === '\x03' || data === '\x1b') return 'interrupt';
  return null;
}

export function transitionActivityForInput(activity, signal) {
  if (!activity || !VALID_AGENTS.has(activity.agent)) return null;
  if (signal === 'interrupt' && (
    activity.phase === 'working'
    || (activity.phase === 'attention' && RESUME_REASONS.has(activity.reason))
  )) {
    return { agent: activity.agent, phase: 'attention', reason: 'interrupted' };
  }
  if (signal !== 'enter' || activity.phase !== 'attention') return null;
  if (RESUME_REASONS.has(activity.reason)) {
    return { agent: activity.agent, phase: 'working', reason: 'resumed' };
  }
  return { agent: activity.agent, phase: 'idle', reason: 'acknowledged' };
}

export async function writeActivityTransition(
  current,
  next,
  setIfCurrent = tmux.setPaneActivityIfEvent
) {
  if (!current?.paneId || !current.eventId || !next) return false;
  const ok = await setIfCurrent(current.paneId, current.eventId, storedActivity(next));
  // A failed CAS usually means a newer hook already replaced the snapshot we read; invalidate in
  // both cases so the next GET observes that authoritative state immediately.
  invalidateActivitySnapshot();
  return ok;
}

export async function reconcileWindowInput(groupId, window, data) {
  const signal = inputActivitySignal(data);
  if (!signal) return false;
  const pane = await tmux.getWindowActivityPane(`grp_${groupId}`, window);
  if (!pane) return false;
  const parsed = parsePaneActivity(pane.activityRaw);
  let current = parsed ? { ...parsed, paneId: pane.paneId } : null;
  // abnormal_exit is intentionally derived during polling instead of persisted. Re-derive it for
  // Enter so a green abnormal ending can be acknowledged just like completed/failed/interrupted.
  if (signal === 'enter' && parsed?.phase === 'working') {
    const processes = await readProcessSnapshot([pane], { timeoutMs: 500 });
    const derived = derivePaneActivity(pane, processes);
    current = derived ? { ...derived, paneId: pane.paneId } : null;
  }
  return writeActivityTransition(current, transitionActivityForInput(current, signal));
}

// Semantic keys are reconciled before entering the PTY. This ordering prevents an old completed
// turn's acknowledgement from landing after the key has already triggered a new UserPromptSubmit
// hook. The tmux helpers enforce a hard deadline, and errors fail open before `write` is called.
export async function forwardInputAfterActivity({ groupId, window, data, write, reconcile = reconcileWindowInput }) {
  if (inputActivitySignal(data)) {
    try { await reconcile(groupId, window, data); } catch {}
  }
  return write(data);
}

export async function acknowledgeWindowActivity(groupId, window) {
  const snapshot = await getActivitySnapshot({ force: true });
  const current = snapshot.byWindow.get(activityWindowKey(groupId, window));
  if (!current || current.phase !== 'attention') return false;
  return writeActivityTransition(current, {
    agent: current.agent,
    phase: 'idle',
    reason: 'acknowledged',
  });
}

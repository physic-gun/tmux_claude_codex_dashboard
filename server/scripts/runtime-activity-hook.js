#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ACTIVITY_OPTION = '@tmuxdash_agent_activity';
export const ACTIVITY_VERSION = 1;

const AGENTS = new Set(['claude', 'codex']);
const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const CLAUDE_FAILURE_DETAILS = new Set([
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

const cleanId = (value) => {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim();
  return EVENT_ID_RE.test(cleaned) ? cleaned : '';
};

function eventIdFor(agent, input, now) {
  const preferred = agent === 'claude' ? input.prompt_id : input.turn_id;
  const direct = cleanId(preferred) || cleanId(input.tool_use_id);
  if (direct) return direct;
  // Claude <2.1.196 has no prompt_id. Never fall back to a bare session id: every turn in that
  // session would then share one CAS identity, allowing an old acknowledgement to replace a newer
  // turn. Timestamp + hook PID keeps the fallback unique while remaining inside the backend's
  // conservative event-id character/length whitelist.
  const session = cleanId(input.session_id) || agent;
  return `${session.slice(0, 80)}:${now}:${process.pid}`;
}

function activity(agent, input, now, phase, reason, detail) {
  const value = {
    v: ACTIVITY_VERSION,
    agent,
    phase,
    reason,
    eventId: eventIdFor(agent, input, now),
    updatedAt: now,
  };
  if (detail) value.detail = detail;
  return { action: 'set', value };
}

export function mapRuntimeActivity(agent, input, now = Date.now()) {
  if (!AGENTS.has(agent) || !input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const event = cleanId(input.hook_event_name);
  if (!event) return null;
  const timestamp = Number.isFinite(now) ? Math.trunc(now) : Date.now();

  if (agent === 'claude') {
    switch (event) {
      case 'SessionStart':
        return activity(agent, input, timestamp, 'idle', 'session_started');
      case 'SessionEnd':
        return { action: 'clear' };
      case 'UserPromptSubmit':
        return activity(agent, input, timestamp, 'working', 'prompt_submitted');
      case 'PermissionRequest':
        return activity(agent, input, timestamp, 'attention', 'permission', 'permission');
      case 'Notification':
        if (input.notification_type === 'permission_prompt') {
          return activity(agent, input, timestamp, 'attention', 'permission', 'permission');
        }
        if (input.notification_type === 'idle_prompt') {
          return activity(agent, input, timestamp, 'attention', 'question', 'idle_prompt');
        }
        if (input.notification_type === 'agent_needs_input') {
          return activity(agent, input, timestamp, 'attention', 'question', 'agent_needs_input');
        }
        return null;
      case 'PreToolUse':
        if (input.tool_name === 'AskUserQuestion') {
          return activity(agent, input, timestamp, 'attention', 'question', 'question');
        }
        return null;
      case 'PostToolUse':
        if (input.tool_name === 'AskUserQuestion') {
          return activity(agent, input, timestamp, 'working', 'resumed', 'question');
        }
        return null;
      case 'PostToolUseFailure':
        if (input.tool_name !== 'AskUserQuestion') return null;
        return input.is_interrupt === true
          ? activity(agent, input, timestamp, 'attention', 'interrupted', 'question')
          : activity(agent, input, timestamp, 'attention', 'failed', 'question');
      case 'Stop':
        return activity(agent, input, timestamp, 'attention', 'completed');
      case 'StopFailure': {
        const error = cleanId(input.error);
        const detail = CLAUDE_FAILURE_DETAILS.has(error) ? error : 'unknown';
        return activity(agent, input, timestamp, 'attention', 'failed', detail);
      }
      default:
        return null;
    }
  }

  switch (event) {
    case 'SessionStart':
      return activity(agent, input, timestamp, 'idle', 'session_started');
    case 'UserPromptSubmit':
      return activity(agent, input, timestamp, 'working', 'prompt_submitted');
    case 'PermissionRequest':
      return activity(agent, input, timestamp, 'attention', 'permission', 'permission');
    case 'PreToolUse':
      if (input.tool_name === 'request_user_input') {
        return activity(agent, input, timestamp, 'attention', 'question', 'question');
      }
      return null;
    case 'PostToolUse':
      if (input.tool_name === 'request_user_input') {
        return activity(agent, input, timestamp, 'working', 'resumed', 'question');
      }
      return null;
    case 'Stop':
      return activity(agent, input, timestamp, 'attention', 'completed');
    default:
      return null;
  }
}

export function findDashboardBaseSession(listPanesOutput, paneId) {
  if (!/^%\d+$/.test(String(paneId || ''))) return '';
  for (const line of String(listPanesOutput || '').split('\n')) {
    const [sessionName, listedPaneId] = line.split('\t');
    if (listedPaneId === paneId && /^grp_\d+$/.test(sessionName)) return sessionName;
  }
  return '';
}

function defaultRunTmux(args, env) {
  return execFileSync('tmux', args, {
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1500,
  });
}

export function applyRuntimeActivity({
  agent,
  input,
  env = process.env,
  now = Date.now(),
  runTmux = defaultRunTmux,
} = {}) {
  try {
    const paneId = String(env.TMUX_PANE || '');
    if (!env.TMUX || !/^%\d+$/.test(paneId)) return false;

    const mapped = mapRuntimeActivity(agent, input, now);
    if (!mapped) return false;

    const panes = runTmux(
      ['list-panes', '-a', '-F', '#{session_name}\t#{pane_id}'],
      env,
    );
    if (!findDashboardBaseSession(panes, paneId)) return false;

    if (mapped.action === 'clear') {
      runTmux(['set-option', '-p', '-q', '-u', '-t', paneId, ACTIVITY_OPTION], env);
    } else {
      runTmux([
        'set-option', '-p', '-q', '-t', paneId,
        ACTIVITY_OPTION, JSON.stringify(mapped.value),
      ], env);
    }
    return true;
  } catch {
    return false;
  }
}

export function parseAgentArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--agent') return AGENTS.has(argv[i + 1]) ? argv[i + 1] : '';
    if (argv[i].startsWith('--agent=')) {
      const value = argv[i].slice('--agent='.length);
      return AGENTS.has(value) ? value : '';
    }
  }
  return '';
}

export function runHookCli(argv = process.argv.slice(2), env = process.env) {
  try {
    const agent = parseAgentArg(argv);
    if (!agent) return;
    const raw = fs.readFileSync(0, 'utf8');
    const input = JSON.parse(raw);
    applyRuntimeActivity({ agent, input, env });
  } catch {
    // Hooks are observational and must never affect the agent's control flow.
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) runHookCli();

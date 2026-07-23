import type { WindowActivity } from '../types';
import { getGroupIndicatorKinds, getWindowIndicatorKinds } from '../lib/activity.js';

type IndicatorKind = 'todo' | 'working' | 'attention' | 'idle';

const GROUP_TITLES: Record<IndicatorKind, string> = {
  todo: '有手动标记的待办会话',
  working: '有正在工作的会话',
  attention: '有需要关注的会话',
  idle: '有空闲的 Claude/Codex 会话',
};

const REASON_LABELS: Record<string, string> = {
  session_started: '空闲',
  detected: '空闲',
  acknowledged: '已确认',
  prompt_submitted: '正在工作',
  resumed: '继续工作',
  permission: '等待权限确认',
  permission_request: '等待权限确认',
  question: '等待选择或输入',
  needs_input: '等待选择或输入',
  agent_needs_input: '等待输入',
  idle_prompt: '等待继续操作',
  completed: '已完成',
  failed: '执行失败',
  interrupted: '已中断',
  abnormal_exit: '进程异常退出',
  idle: '空闲',
  notification: '需要关注',
};

function agentLabel(agent: WindowActivity['agent']) {
  return agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex CLI' : 'Agent';
}

function phaseLabel(activity: WindowActivity) {
  if (activity.reason && REASON_LABELS[activity.reason]) return REASON_LABELS[activity.reason];
  if (activity.phase === 'working') return '正在工作';
  if (activity.phase === 'attention') return '需要关注';
  return '空闲';
}

function windowTitle(kind: IndicatorKind, activity: WindowActivity) {
  if (kind === 'todo') return '手动标记的待办';
  if (kind === 'working' && activity.manualWorking) return '手动标记为正在工作';
  const detail = activity.detail ? `：${activity.detail}` : '';
  let when = '';
  if (activity.updatedAt) {
    const timestamp = new Date(activity.updatedAt);
    if (!Number.isNaN(timestamp.getTime())) when = ` · ${timestamp.toLocaleString()}`;
  }
  return `${agentLabel(activity.agent)} · ${phaseLabel(activity)}${detail}${when}`;
}

function Dot({ kind, title }: { kind: IndicatorKind; title: string }) {
  return <span className={`activity-dot ${kind}`} title={title} role="img" aria-label={title} />;
}

export function WindowActivityDots({ activity }: { activity?: WindowActivity }) {
  if (!activity) return null;
  const kinds = getWindowIndicatorKinds(activity) as IndicatorKind[];
  if (!kinds.length) return null;
  return (
    <span className="activity-dots">
      {kinds.map((kind) => <Dot key={kind} kind={kind} title={windowTitle(kind, activity)} />)}
    </span>
  );
}

export function GroupActivityDots({ activities }: { activities: WindowActivity[] }) {
  const kinds = getGroupIndicatorKinds(activities) as IndicatorKind[];
  if (!kinds.length) return null;
  return (
    <span className="activity-dots group-activity-dots">
      {kinds.map((kind) => <Dot key={kind} kind={kind} title={GROUP_TITLES[kind]} />)}
    </span>
  );
}

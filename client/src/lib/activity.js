const PHASES = new Set(['idle', 'working', 'attention']);

/** Return the dots shown for one window, in their stable display order. */
export function getWindowIndicatorKinds(activity) {
  if (!activity) return [];
  const kinds = [];
  if (activity.todo) kinds.push('todo');
  if (activity.manualWorking) {
    kinds.push('working');
    return kinds;
  }
  if (activity.agent && PHASES.has(activity.phase)) kinds.push(activity.phase);
  return kinds;
}

/**
 * A click acknowledges a manual todo. Attention is cleared at the same time only when it coexists
 * with that todo; attention on its own deliberately requires Enter in the terminal.
 */
export function getTabClickAck(activity) {
  if (!activity?.todo) return null;
  return {
    clearTodo: true,
    clearAttention: !activity.manualWorking && activity.phase === 'attention',
  };
}

/** Aggregate all windows in a group without turning the sidebar into a counter dashboard. */
export function getGroupIndicatorKinds(activities) {
  let todo = false;
  let working = false;
  let attention = false;
  let idle = false;

  for (const activity of activities || []) {
    todo ||= !!activity?.todo;
    if (activity?.manualWorking) {
      working = true;
      continue;
    }
    if (!activity?.agent) continue;
    working ||= activity.phase === 'working';
    attention ||= activity.phase === 'attention';
    idle ||= activity.phase === 'idle';
  }

  const kinds = [];
  if (todo) kinds.push('todo');
  if (working) kinds.push('working');
  if (attention) kinds.push('attention');
  if (kinds.length === 0 && idle) kinds.push('idle');
  return kinds;
}

export function activityKey(groupId, windowName) {
  return `${groupId}:${windowName}`;
}

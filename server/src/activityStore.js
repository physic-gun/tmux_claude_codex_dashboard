// Database access for activity is kept in small injectable helpers so ownership and persistence
// rules can be tested against an in-memory SQLite database without starting the HTTP server.

export function listActivityWindowsForUser(database, userId) {
  return database.prepare(`
    SELECT g.id AS group_id, w.name, w.todo, w.manual_working_at
    FROM windows w
    JOIN groups g ON g.id = w.group_id
    WHERE g.user_id = ?
    ORDER BY g.sort_order, g.created_at, g.id, w.sort_order, w.id
  `).all(userId);
}

export function findOwnedActivityWindow(database, userId, groupId, window) {
  return database.prepare(`
    SELECT w.id, w.group_id, w.name, w.todo, w.manual_working_at
    FROM windows w
    JOIN groups g ON g.id = w.group_id
    WHERE g.user_id = ? AND g.id = ? AND w.name = ?
  `).get(userId, groupId, window) || null;
}

export function setOwnedWindowTodo(database, userId, groupId, window, todo) {
  const row = findOwnedActivityWindow(database, userId, groupId, window);
  if (!row) return null;
  database.prepare('UPDATE windows SET todo = ? WHERE id = ?').run(todo ? 1 : 0, row.id);
  return { ...row, todo: todo ? 1 : 0 };
}

export function setOwnedWindowManualWorking(database, userId, groupId, window, working, now = Date.now()) {
  const row = findOwnedActivityWindow(database, userId, groupId, window);
  if (!row) return null;
  const manualWorkingAt = working ? Math.max(1, Math.trunc(Number(now) || Date.now())) : null;
  database.prepare('UPDATE windows SET manual_working_at = ? WHERE id = ?').run(manualWorkingAt, row.id);
  return { ...row, manual_working_at: manualWorkingAt };
}

export function isManualWorking(manualWorkingAt, runtimeUpdatedAt) {
  const manual = Number(manualWorkingAt);
  if (!Number.isFinite(manual) || manual <= 0) return false;
  const runtime = Date.parse(String(runtimeUpdatedAt || ''));
  return !Number.isFinite(runtime) || manual >= runtime;
}

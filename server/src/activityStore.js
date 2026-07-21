// Database access for activity is kept in small injectable helpers so ownership and persistence
// rules can be tested against an in-memory SQLite database without starting the HTTP server.

export function listActivityWindowsForUser(database, userId) {
  return database.prepare(`
    SELECT g.id AS group_id, w.name, w.todo
    FROM windows w
    JOIN groups g ON g.id = w.group_id
    WHERE g.user_id = ?
    ORDER BY g.sort_order, g.created_at, g.id, w.sort_order, w.id
  `).all(userId);
}

export function findOwnedActivityWindow(database, userId, groupId, window) {
  return database.prepare(`
    SELECT w.id, w.group_id, w.name, w.todo
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

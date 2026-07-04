import { Router } from 'express';
import path from 'path';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { listSessions } from '../sessions.js';
import { groupDirPath } from '../workspace.js';

// Claude session history for the logged-in user, grouped by their dashboard groups. Each
// group's sessions are read (read-only) from that group's working directory's Claude store.
const router = Router();
router.use(authRequired);

router.get('/', (req, res) => {
  const groups = db
    .prepare('SELECT id, name, path FROM groups WHERE user_id = ? ORDER BY created_at, id')
    .all(req.user.id);
  const out = [];
  for (const g of groups) {
    const cwd = g.path ? path.resolve(g.path) : groupDirPath(req.user.username, g.name);
    const sessions = cwd ? listSessions(cwd) : [];
    if (!sessions.length) continue;
    // Mark sessions an open window is currently bound to, so the UI can flag "in use".
    const active = new Set(
      db
        .prepare('SELECT session_id FROM windows WHERE group_id = ? AND is_open = 1 AND session_id IS NOT NULL')
        .all(g.id)
        .map((r) => r.session_id)
    );
    out.push({
      gid: g.id,
      group: g.name,
      sessions: sessions.map((s) => ({ ...s, active: active.has(s.id) })),
    });
  }
  res.json(out);
});

export default router;

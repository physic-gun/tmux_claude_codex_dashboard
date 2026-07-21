import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { ah } from '../asyncHandler.js';
import { activityWindowKey, getActivitySnapshot } from '../activity.js';
import { listActivityWindowsForUser } from '../activityStore.js';

const router = Router();
router.use(authRequired);

router.get('/', ah(async (req, res) => {
  const rows = listActivityWindowsForUser(db, req.user.id);
  if (!rows.length) {
    return res.json({ observedAt: new Date().toISOString(), windows: [] });
  }
  const snapshot = await getActivitySnapshot();
  res.json({
    observedAt: snapshot.observedAt,
    windows: rows.map((row) => {
      const activity = snapshot.byWindow.get(activityWindowKey(row.group_id, row.name));
      return {
        groupId: row.group_id,
        window: row.name,
        todo: Boolean(row.todo),
        agent: activity?.agent || null,
        phase: activity?.phase || null,
        reason: activity?.reason || null,
        detail: activity?.detail || null,
        updatedAt: activity?.updatedAt || null,
      };
    }),
  });
}));

export default router;

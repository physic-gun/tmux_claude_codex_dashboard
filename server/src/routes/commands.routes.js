import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

router.get('/', (req, res) => {
  res.json(
    db
      .prepare('SELECT id, label, command, created_at FROM commands WHERE user_id = ? ORDER BY created_at, id')
      .all(req.user.id)
  );
});

router.post('/', (req, res) => {
  const label = (req.body?.label || '').trim();
  const command = req.body?.command ?? '';
  if (!label || !command) return res.status(400).json({ error: '名称和命令均必填' });
  const info = db
    .prepare('INSERT INTO commands (user_id, label, command, created_at) VALUES (?, ?, ?, ?)')
    .run(req.user.id, label, command, new Date().toISOString());
  res.json({ id: Number(info.lastInsertRowid), label, command });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM commands WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

export default router;

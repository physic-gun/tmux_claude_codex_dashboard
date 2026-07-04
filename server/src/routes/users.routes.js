import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, adminRequired, hashPassword } from '../auth.js';

const router = Router();
router.use(authRequired, adminRequired);

const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY created_at, id').all());
});

router.post('/', (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';
  const is_admin = req.body?.is_admin ? 1 : 0;
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: '用户名非法' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: '用户名已存在' });
  }
  const info = db
    .prepare('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password), is_admin, new Date().toISOString());
  res.json({ id: Number(info.lastInsertRowid), username, is_admin });
});

router.post('/:id/password', (req, res) => {
  const password = req.body?.password || '';
  if (password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), Number(req.params.id));
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除当前登录的自己' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

export default router;

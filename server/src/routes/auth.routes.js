import { Router } from 'express';
import { db } from '../db.js';
import { verifyPassword, signToken, hashPassword, authRequired } from '../auth.js';

const router = Router();

router.post('/login', (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  res.json({
    token: signToken(user),
    user: {
      id: user.id, username: user.username, is_admin: !!user.is_admin,
      scroll_step_small: user.scroll_step_small, scroll_step_big: user.scroll_step_big,
      scroll_auto: user.scroll_auto, term_font: user.term_font, float_opacity: user.float_opacity,
    },
  });
});

router.get('/me', authRequired, (req, res) => {
  res.json({
    id: req.user.id, username: req.user.username, is_admin: !!req.user.is_admin,
    scroll_step_small: req.user.scroll_step_small, scroll_step_big: req.user.scroll_step_big,
    scroll_auto: req.user.scroll_auto, term_font: req.user.term_font, float_opacity: req.user.float_opacity,
  });
});

// Per-user preferences (scroll steps, terminal font, floating-button opacity), on the users row.
router.post('/settings', authRequired, (req, res) => {
  const clampInt = (v, min, max, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
  };
  const small = clampInt(req.body?.scroll_step_small, 1, 100, 20);
  const big = clampInt(req.body?.scroll_step_big, 1, 500, 60);
  const auto = req.body?.scroll_auto ? 1 : 0;
  // Terminal font: a single font-family name, conservatively whitelisted (defense in depth —
  // it ends up in the terminal's CSS font-family). Anything unexpected falls back to '' (the
  // built-in monospace stack). The opacity is a percent, kept slightly visible at the low end.
  const rawFont = typeof req.body?.term_font === 'string' ? req.body.term_font.trim() : '';
  const term_font = /^[A-Za-z0-9 _-]{1,40}$/.test(rawFont) ? rawFont : '';
  const float_opacity = clampInt(req.body?.float_opacity, 5, 100, 20);
  db.prepare(
    'UPDATE users SET scroll_step_small = ?, scroll_step_big = ?, scroll_auto = ?, term_font = ?, float_opacity = ? WHERE id = ?'
  ).run(small, big, auto, term_font, float_opacity, req.user.id);
  res.json({ scroll_step_small: small, scroll_step_big: big, scroll_auto: auto, term_font, float_opacity });
});

router.post('/change-password', authRequired, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(oldPassword || '', user.password_hash)) {
    return res.status(400).json({ error: '原密码错误' });
  }
  if ((newPassword || '').length < 4) {
    return res.status(400).json({ error: '新密码至少 4 位' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

export default router;

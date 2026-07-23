import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { jwtSecret } from './secret.js';
import { db } from './db.js';

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

export function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, is_admin: !!user.is_admin },
    jwtSecret,
    { expiresIn: config.tokenTtl }
  );
}

export function verifyTokenStr(token) {
  try {
    return jwt.verify(token, jwtSecret);
  } catch {
    return null;
  }
}

export function getUserById(id) {
  return db
    .prepare(
      'SELECT id, username, is_admin, scroll_step_small, scroll_step_big, scroll_auto, term_font, term_theme, float_opacity FROM users WHERE id = ?'
    )
    .get(id);
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyTokenStr(token) : null;
  if (!payload) return res.status(401).json({ error: '未登录或登录已过期' });
  const user = getUserById(payload.id);
  if (!user) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = user;
  next();
}

export function adminRequired(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: '需要管理员权限' });
  next();
}

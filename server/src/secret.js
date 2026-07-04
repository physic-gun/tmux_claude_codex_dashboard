import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';

// Resolve the JWT signing secret without ever falling back to a public/literal
// default: use JWT_SECRET when provided (>=16 chars), otherwise generate a random
// secret on first run and persist it next to the database so it survives restarts.
function resolveSecret() {
  if (config.jwtSecret && config.jwtSecret.length >= 16) return config.jwtSecret;

  if (config.jwtSecret) {
    console.warn('[secret] JWT_SECRET is too short (<16 chars); ignoring and using a generated secret.');
  }

  const dir = path.dirname(path.resolve(config.dbPath));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.jwt_secret');

  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    // not yet generated
  }

  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  console.log(`[secret] generated a persistent random JWT secret at ${file}`);
  console.log('[secret] set JWT_SECRET explicitly if you want a fixed value across deployments.');
  return secret;
}

export const jwtSecret = resolveSecret();

import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 6880),
  // No insecure literal default: an unset/short secret triggers an auto-generated,
  // persisted random secret (see secret.js).
  jwtSecret: process.env.JWT_SECRET || '',
  tokenTtl: process.env.TOKEN_TTL || '7d',
  dbPath: process.env.DB_PATH || './data/dashboard.db',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  // No default: when unset, db.js seeds a random admin password and prints it once.
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Directory of the built React client; set in Docker. Empty -> resolve relative to repo.
  publicDir: process.env.PUBLIC_DIR || '',
  // Dedicated tmux server socket so this app never collides with a user's own tmux.
  tmuxSocket: process.env.TMUX_SOCKET || 'tmuxdash',
  // Root for per-user workspaces. New windows start in <root>/<username>/<groupname>.
  // Empty -> don't set a working directory (tmux uses the default).
  workspaceRoot: process.env.WORKSPACE_ROOT || '',
  // Optional TLS: when both files exist, the server runs over HTTPS (wss) — a secure
  // context, so the system clipboard / claude's OSC52 auto-copy work over the LAN.
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
  // Upper bound for web[[1-5]] style window expansion.
  maxWindowExpansion: Number(process.env.MAX_WINDOW_EXPANSION || 50),
};

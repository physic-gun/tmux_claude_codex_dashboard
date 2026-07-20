import express from 'express';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import './db.js';
import authRoutes from './routes/auth.routes.js';
import groupRoutes from './routes/groups.routes.js';
import commandRoutes from './routes/commands.routes.js';
import userRoutes from './routes/users.routes.js';
import fsRoutes from './routes/fs.routes.js';
import sessionRoutes from './routes/sessions.routes.js';
import { setupWebSocket, restoreOpenWindows } from './ws.js';
import * as tmux from './tmux.js';
import { startPeriodicArchiver } from './sessionArchive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', async (req, res) => {
  const tmuxReady = !config.tmuxManagedExternally || await tmux.serverReady();
  res.status(tmuxReady ? 200 : 503).json({ ok: tmuxReady, tmux: tmuxReady });
});
app.use('/api/auth', authRoutes);
app.use('/api/groups', groupRoutes); // groups + nested windows
app.use('/api/commands', commandRoutes);
app.use('/api/users', userRoutes);
app.use('/api/fs', fsRoutes);
app.use('/api/sessions', sessionRoutes);

// API JSON 404 (so the SPA fallback below never swallows unknown API routes).
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// Serve the built React client and fall back to index.html for client-side routes.
const publicDir = config.publicDir || path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
} else {
  console.warn(`[warn] client build not found at ${publicDir} (API-only mode)`);
}

// JSON error handler — must be last so async-handler rejections never hang a request.
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误' });
});

// HTTPS when a cert/key pair is configured and present (secure context -> clipboard
// works over the LAN); plain HTTP otherwise.
const useTls =
  config.tlsCert && config.tlsKey && fs.existsSync(config.tlsCert) && fs.existsSync(config.tlsKey);

// First scrub inherited Claude Code session-marker env vars from the tmux server's global environment
// (so claude sessions in dashboard tabs persist a resumable transcript — see tmux.js). Then reap
// stale per-connection viewer sessions from a previous run and re-materialize every group's open tabs
// (recreates any windows a tmux restart dropped; no-op otherwise).
tmux
  .scrubServerEnv()
  .then(() => tmux.reapViewerSessions())
  .then(() => restoreOpenWindows())
  .catch(() => {});

// Periodically snapshot every live pane's text to disk (read-only) so a tmux crash / accidental
// `pkill tmux` still leaves a readable record of each conversation. See sessionArchive.js.
startPeriodicArchiver();

if (useTls) {
  const httpsServer = https.createServer(
    { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) },
    app
  );
  setupWebSocket(httpsServer);

  // Plain-HTTP requests that hit the TLS port are 301'd to the same host over https.
  const redirectServer = http.createServer((req, res) => {
    const host = req.headers.host || `localhost:${config.port}`;
    res.writeHead(301, { Location: `https://${host}${req.url}` });
    res.end();
  });

  // One port serves both: peek the first byte — a TLS ClientHello starts with 0x16,
  // anything else is a plain-HTTP request we redirect to https.
  const front = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (buf) => {
      socket.pause();
      socket.unshift(buf);
      (buf[0] === 0x16 ? httpsServer : redirectServer).emit('connection', socket);
      // Resume on the next tick so the (TLS) server finishes taking over the socket
      // before buffered bytes flow — a synchronous resume drops the TLS handshake.
      process.nextTick(() => socket.resume());
    });
  });
  front.listen(config.port, config.host, () => {
    console.log(`tmux-dashboard listening on https://${config.host}:${config.port} (plain http on this port redirects to https)`);
    console.log('[tls] self-signed cert in use — accept the browser warning once per device');
  });
} else {
  const server = http.createServer(app);
  setupWebSocket(server);
  server.listen(config.port, config.host, () => {
    console.log(`tmux-dashboard listening on http://${config.host}:${config.port}`);
  });
}

<div align="center">

**English** · [简体中文](README.zh-CN.md)

# tmux_claude_codex_dashboard

**A self-hosted, browser-based tmux console for running & babysitting long-lived CLI coding agents — Claude Code, Codex, or any shell — from your desktop or your phone.**

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node 20](https://img.shields.io/badge/Node-20-5FA04E?logo=node.js&logoColor=white)
![tmux](https://img.shields.io/badge/tmux-1BB91F?logo=tmux&logoColor=white)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

<img src="docs/screenshots/dashboard.png" alt="Dashboard — groups, tabs and a live terminal" width="840">

</div>

## Why

Long-lived coding agents (Claude Code, Codex) still need a human in the loop — but you're rarely sitting at the box they run on. This puts every agent in a **browser tab**: named **groups → tabs** over real tmux windows, so you can glance in, paste context, grab their output, and nudge them from anywhere on your LAN — even your phone — while the processes keep running on the host.

## Quick start

> **Runs natively on the host — not in Docker.** The terminals, tmux, and the `claude` / `codex` you launch all run as your system user, reusing your existing `~/.claude` login and full filesystem access — exactly what babysitting real agents needs. A container would wall the agent off from your projects and credentials.

**Requires:** Node 20 · tmux · git

```bash
git clone https://github.com/physic-gun/tmux_claude_codex_dashboard.git
cd tmux_claude_codex_dashboard

(cd server && npm install)                    # backend deps (compiles native modules)
(cd client && npm install && npm run build)   # client build (served by the backend)

cd server && node src/server.js               # → http://<lan-ip>:6880
```

On first boot a random **admin** password is printed to the log. Open `http://<lan-ip>:6880` and log in. To pin your own credentials, `cp .env.example .env` and set `ADMIN_PASSWORD` (and optionally `JWT_SECRET`) before starting.

## Features

|  | Feature | What it does |
|---|---|---|
| 🗂️ | **Groups → tabs** | Each user gets named groups (one long-lived tmux session each); tabs are tmux windows. Close a tab and it just backgrounds — the process keeps running — reopen or kill it later. |
| 📋 | **Clipboard relay** | Captures every terminal **OSC 52** copy (Claude's `/copy`, select-to-copy) straight from the stream, so nothing is lost even when the browser blocks the system clipboard. One tap to refill or send it back. |
| 📄 | **File preview** | Copy a file path (absolute, or relative to the agent's working dir) and its contents open in a read-only split — with Markdown rendering and a pop-out reader. |
| ⌨️ | **Direct-send composer** | `Ctrl+G` opens a draggable, resizable multi-line editor; insert as one paste, or **send straight to the agent** with `Ctrl+Enter`. Drafts autosave per tab. |
| 🌿 | **Git panel** | A side rail shows repo changes / "behind remote", with an inline diff viewer and commit · pull · push. |
| 🕘 | **Resume & archive** | One-click resume of a previous Claude session; every window's scrollback is periodically snapshotted to disk so a tmux crash never loses a conversation. |
| 📱 | **Mobile** | On-screen keyboard, one-finger drag-select-to-copy, and tap-without-popping-the-OS-keyboard — babysit agents from your phone. |
| 🔒 | **Auth & HTTPS** | JWT login with admin-managed users; optional self-signed HTTPS so the clipboard works across the LAN. |

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/clipboard-file-preview.png" alt="Clipboard relay and file preview"></td>
    <td width="50%"><img src="docs/screenshots/direct-send-editor.png" alt="Direct-send composer"></td>
  </tr>
  <tr>
    <td align="center">Clipboard relay → file preview with live Markdown</td>
    <td align="center"><code>Ctrl+G</code> multi-line direct-send composer</td>
  </tr>
</table>

## Tech stack

`React` · `xterm.js` · `Express` · `node-pty` · `tmux` · `SQLite`

```
Browser (React + xterm.js)  ──REST /api──▶  Express  ──▶  SQLite
                            ──WS /ws/terminal──▶  node-pty  ──▶  tmux (grouped session per viewer)
```

Each terminal connection spins up a tmux *grouped session* as its own viewer client, so disconnecting kills only that viewer — the real windows and other viewers are untouched.

## Configuration

All optional — sensible defaults, secrets auto-generated on first boot.

| Var | Default | Notes |
|---|---|---|
| `PORT` | `6880` | Listen port |
| `JWT_SECRET` | auto-generated & persisted | Empty → auto-generate a random key; set a fixed value (≥16 chars) to pin it |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / random | First-boot admin; empty password → random, printed to the log |
| `DB_PATH` | `./data/dashboard.db` | SQLite path |
| `TMUX_SOCKET` | `tmuxdash` | Dedicated tmux socket (isolated from your system tmux) |
| `WORKSPACE_ROOT` | *(empty)* | New windows start in `<root>/<user>/<group>`; empty → tmux default dir |
| `TLS_CERT` / `TLS_KEY` | *(empty)* | Point both at a cert/key to serve HTTPS (wss) |
| `MAX_WINDOW_EXPANSION` | `50` | Upper bound for `name[[1-5]]` batch window creation |

## Run persistently

<details>
<summary><b>Linux (systemd, recommended)</b></summary>

```ini
# /etc/systemd/system/tmux-dashboard.service — replace <repo> / <user>
[Unit]
Description=tmux_claude_codex_dashboard
After=network.target

[Service]
Type=simple
User=<user>
WorkingDirectory=<repo>/server
ExecStart=/usr/bin/env node src/server.js   # use an absolute node path if node isn't on PATH
Restart=always
RestartSec=2
# EnvironmentFile=<repo>/server/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tmux-dashboard
journalctl -u tmux-dashboard -f          # first-boot admin password shows here
```
</details>

<details>
<summary><b>macOS (no systemd)</b></summary>

Host it in a detached tmux session that survives SSH logout and auto-restarts on crash:

```bash
tmux -L dashsvc new-session -d -s server \
  "cd <repo>/server && \
   export PATH='/opt/homebrew/opt/node@20/bin:/opt/homebrew/bin:/usr/bin:/bin' && \
   while true; do node src/server.js; sleep 2; done"
```

- Logs: `tmux -L dashsvc attach` (`Ctrl-b d` detaches, doesn't stop it)
- Stop: `tmux -L dashsvc kill-server`

> Survives SSH logout but **not a reboot** (tmux is gone after restart). For true auto-start use launchd, and grant the node binary **Full Disk Access** if the project lives under `~/Documents` (macOS TCC) — otherwise launchd hangs at startup.
</details>

## HTTPS (enables the browser clipboard on the LAN)

The browser clipboard API only works in a **secure context** (https or localhost). Serve HTTPS with a self-signed cert so LAN devices can copy too:

```bash
cd server && mkdir -p certs
cat > certs/san.cnf <<'CNF'
[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=tmux-dashboard
[v3]
subjectAltName=@alt
basicConstraints=CA:FALSE
[alt]
DNS.1=localhost
IP.1=127.0.0.1
IP.2=192.168.1.100      # your LAN IP
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/key.pem -out certs/cert.pem -config certs/san.cnf
```

Then set `TLS_CERT` / `TLS_KEY` to those files (or put them in `server/.env`) and restart. Certs and `server/.env` are gitignored — never commit them.

## Development

```bash
(cd server && npm install && JWT_SECRET=dev npm run dev)   # backend :6880
(cd client && npm install && npm run dev)                  # frontend :5173 (proxies /api, /ws)
```

## Security

Built for a **trusted LAN**. **Every logged-in user gets a real shell on the host, as the system user running the service** — able to read/write anything that user can and use its `~/.claude` credentials. Only hand out accounts to people you trust; use strong passwords and a strong `JWT_SECRET`. If you must expose it publicly, put it behind an HTTPS reverse proxy and run the service as a dedicated low-privilege user.

## License

[MIT](LICENSE)

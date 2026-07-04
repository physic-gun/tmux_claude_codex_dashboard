# Tmux Dashboard

局域网内的轻量 tmux 控制台：账号登录后，在浏览器里以「分组 → 选项卡」的方式管理自己的 tmux 窗口，
内置 xterm 终端、快捷命令、批量建窗（`web[[1-5]]`），关闭选项卡只转后台、不结束进程。

## 功能

- **账号登录**：JWT 鉴权，管理员预置 + 后台增删用户、重置密码。
- **分组**：每个用户可建多个命名分组，一个分组对应一个 tmux session（`grp_<id>`，常驻后台）。
- **选项卡 = tmux 窗口**：切换选项卡即切换窗口；关闭选项卡 → 转入「后台窗口」（窗口仍在运行），可恢复或彻底结束。
- **批量建窗**：窗口名支持 `name[[1-5]]`（或 `name[[n]]`，默认 1–5），自动循环创建 `name1…name5`。
- **真实终端**：xterm.js + WebSocket，可执行任意 shell 命令，不仅限 tmux。
- **快捷命令**：保存常用命令，一键 `send-keys` 注入当前窗口。
- **数据存储**：本地 SQLite。

## 一键运行（Docker）

```bash
docker compose up -d --build
docker compose logs | grep -A2 'Admin login'   # 查看首次生成的随机管理员密码
```

访问 `http://<本机局域网IP>:6880`，用日志里打印的 `admin` 账号与随机密码登录（登录后可在“用户管理”里重置）。

如需自定义账号密码，先 `cp .env.example .env` 填入 `ADMIN_PASSWORD`（及可选的 `JWT_SECRET`）再启动。

> - 未设置 `JWT_SECRET` 时，应用会在首次启动自动生成并持久化一个随机密钥（`/app/server/data/.jwt_secret`），无需手动配置且重启不失效。
> - 数据持久化在命名卷 `tmux-dash-data`（容器内 `/app/server/data`）。

## 本地开发

```bash
# 后端（需要本机已安装 tmux）
cd server && npm install && JWT_SECRET=dev npm run dev   # :6880

# 前端
cd client && npm install && npm run dev                  # :5173，已配置 /api 与 /ws 代理
```

## 本地常驻运行（macOS 原生，非 Docker）

让服务在本机长期运行、并且**关闭 SSH 会话后继续存活**：用一个独立的 tmux 会话托管它（守护进程化，
崩溃自动重启）。`<repo>` 换成仓库根目录。

```bash
# 启动（Node 20 必需：better-sqlite3 / node-pty 原生模块 ABI 对应 Node 20）
tmux -L dashsvc new-session -d -s server \
  "cd <repo>/server && \
   export PATH='/opt/homebrew/opt/node@20/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' && \
   while true; do node src/server.js; sleep 2; done"
```

### 管理 & 开机自启

- 看服务日志：`tmux -L dashsvc attach`（`Ctrl-b d` 退出查看，不会停服务）
- 停服务：`tmux -L dashsvc kill-server`
- 查健康：`curl -sk https://localhost:6880/api/health`

> **开机自启的限制**：以上 tmux 方式能扛住「关闭 SSH 会话」，但**扛不住 Mac 重启**（tmux 重启即消失）。
> 若要真正开机自动启动，需用 launchd（`~/Library/LaunchAgents`）并给 node 二进制手动授予**完全磁盘访问**
> （系统设置 › 隐私与安全性 › 完全磁盘访问）——因为项目位于 `~/Documents`（受 macOS TCC 保护），
> launchd 守护进程没有该权限会在启动时卡死（`getcwd` 阻塞）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `6880` | 监听端口 |
| `JWT_SECRET` | 自动生成并持久化 | 留空即自动生成随机密钥；设置则使用固定值（需 ≥16 位） |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / 随机生成 | 首次启动创建的管理员；密码留空则随机生成并打印到日志 |
| `DB_PATH` | `./data/dashboard.db` | SQLite 路径 |
| `TMUX_SOCKET` | `tmuxdash` | 专用 tmux socket（与系统 tmux 隔离） |
| `MAX_WINDOW_EXPANSION` | `50` | `[[a-b]]` 批量建窗上限 |
| `WORKSPACE_ROOT` | 空 | 新窗口起始目录根 `<root>/<用户名>/<分组名>`（自动创建）；空则用 tmux 默认目录 |
| `TLS_CERT` / `TLS_KEY` | 空 | 两者都指向存在的证书/私钥时，服务以 HTTPS(wss) 运行 |

## HTTPS（启用浏览器剪贴板）

浏览器的剪贴板 API 仅在**安全上下文**（https 或 localhost）可用。要让局域网设备也能复制
（含 claude 选中即自动复制），用自签名证书开启 HTTPS：

```bash
cd server && mkdir -p certs
# 把 IP.2 换成你的局域网 IP（也可加多个）
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
IP.2=192.168.1.100
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/key.pem -out certs/cert.pem -config certs/san.cnf
```

然后设置 `TLS_CERT=…/server/certs/cert.pem`、`TLS_KEY=…/server/certs/key.pem`（或写入 `server/.env`）
并重启。浏览器首次访问会提示证书不受信任，点“继续访问”即可（之后即为安全上下文）。证书与
`server/.env` 不应提交到 git（已在 `.gitignore` 中）。

## 架构

```
React + xterm.js ──REST /api──▶ Express ──▶ SQLite
                 ──WS /ws/terminal──▶ node-pty ──▶ tmux (grouped session 作为独立客户端)
```

每个终端连接会为该分组的 session 创建一个 *grouped session* 作为独立观察客户端：断开只杀这个客户端
session，业务窗口与其它观察者互不影响。

## 安全提示

面向**可信局域网**设计。如需公网暴露，请置于 HTTPS 反向代理之后，使用强口令与强 `JWT_SECRET`，
并注意：登录用户在容器内拥有等同容器用户的 shell 权限。

# tmux_claude_codex_dashboard

浏览器里的多会话 tmux 控制台，为长时间运行的 CLI 编码代理（**Claude Code**、**Codex** 等）而生：
账号登录后以「分组 → 选项卡」管理多个 tmux 会话/窗口，关闭选项卡只转后台、进程不断。内置 xterm 终端、
剪贴板中转、文件预览、多行「直发」输入与移动端屏幕键盘——桌面与手机上都能顺手盯着代理跑。

> A browser-based, multi-user tmux console for running & babysitting long-lived CLI coding agents
> (Claude Code, Codex, …): groups → tabs over live terminals, with clipboard relay, file preview,
> a direct-send composer and an on-screen keyboard — from desktop or phone.

## 功能

- **账号登录**：JWT 鉴权，管理员预置 + 后台增删用户、重置密码。
- **分组 / 选项卡**：每个用户可建多个命名分组（一个分组 = 一个常驻 tmux session `grp_<id>`）；切换选项卡即切换窗口，关闭选项卡 → 转「后台窗口」（进程仍在跑），可恢复或彻底结束；🕘 会话历史可一键 resume 此前的 claude 会话。
- **真实终端**：xterm.js + WebSocket + node-pty，可跑任意 shell 命令；拖选即复制、滚轮照常滚动应用 / tmux 历史（无需切换鼠标模式），A+/A− 字号缩放，内置可选终端字体（修复 CJK / emoji 对齐）。
- **剪贴板中转**：从原始输出流捕获终端 OSC 52 复制（含 claude `/copy`、选中即复制），浏览器拦截系统剪贴板也不丢；列表留存，一键回填 / 发送。
- **文件预览**：复制一段文件路径（绝对路径，或相对代理运行目录），在剪贴板面板下方分栏只读预览，支持 Markdown 渲染与放大悬浮窗。
- **多行输入 / 直发**：Ctrl+G 打开可拖动、可缩放的悬浮编辑器，作为一次粘贴送入，或「直发」直接提交给代理；草稿按选项卡自动保存。
- **移动端**：屏幕键盘、单指拖选复制、点按不弹系统键盘，手机上也能盯着代理跑。
- **Git 源代码管理**：右侧源码栏显示仓库改动 / 「落后远程」状态，内置 diff 查看与 commit / pull / push，操作后自动刷新。
- **会话存档 / 可续接**：定期把每个窗口的终端文本快照落盘（只读），tmux 崩溃 / 误杀也留有记录；并清理继承的环境变量，让面板内启动的 claude 会话保留可 resume 的转录。
- **快捷命令 & 批量建窗**：常用命令一键 `send-keys` 注入；窗口名支持 `name[[1-5]]`，自动创建 `name1…name5`。
- **数据存储**：本地 SQLite；可选自签名 HTTPS（启用局域网剪贴板）。

## 部署（原生，宿主机直接运行）

> **本项目要求在宿主机上原生运行——不要用 Docker。** 网页终端里的 shell / tmux / 你启动的 `claude`
> 都以运行本服务的系统用户身份执行，因此能直接复用你现成的 `~/.claude` 登录、访问整机文件——跑
> Claude Code / Codex 这类代理正需要这点。放进容器则会把 tmux 与 claude 关在容器内：既看不到宿主
> 项目、也没有你的 claude 凭证。

**环境要求**：**Node 20**（`better-sqlite3` / `node-pty` 原生模块按 Node 20 ABI 编译，建议用 nvm 或官方包）、**tmux**、**git**。

```bash
# 1) 后端依赖（会编译原生模块）
cd server && npm install

# 2) 前端依赖 + 构建（服务端会直接托管 client/dist）
cd ../client && npm install && npm run build

# 3) 启动（首次启动把随机 admin 密码打印到日志）
cd ../server && node src/server.js          # 默认 :6880
```

访问 `http://<本机局域网IP>:6880`，用日志里打印的 `admin` 账号与随机密码登录（登录后可在“用户管理”里重置）。
如需自定义账号密码，先 `cp .env.example .env` 填入 `ADMIN_PASSWORD`（及可选的 `JWT_SECRET`）再启动。

> 未设置 `JWT_SECRET` 时，应用首次启动会自动生成并持久化一个随机密钥（`server/data/.jwt_secret`），
> 无需手动配置且重启不失效；数据默认落在 `server/data/`（SQLite）。

## 本地开发

```bash
# 后端（需要本机已安装 tmux）
cd server && npm install && JWT_SECRET=dev npm run dev   # :6880

# 前端
cd client && npm install && npm run dev                  # :5173，已配置 /api 与 /ws 代理
```

## 常驻运行（开机自启 / 崩溃重启）

### Linux（systemd，推荐）

```ini
# /etc/systemd/system/tmux-dashboard.service —— <repo> / <你的用户名> 按实际替换
[Unit]
Description=tmux_claude_codex_dashboard
After=network.target

[Service]
Type=simple
User=<你的用户名>
WorkingDirectory=<repo>/server
ExecStart=/usr/bin/env node src/server.js        # node 不在标准 PATH 时改用绝对路径（which node）
Restart=always
RestartSec=2
# EnvironmentFile=<repo>/server/.env             # 可选：把 JWT_SECRET / ADMIN_PASSWORD 等写这里

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tmux-dashboard
journalctl -u tmux-dashboard -f            # 看日志（含首次生成的 admin 密码）
sudo systemctl restart tmux-dashboard      # 改了 server/ 代码后重启生效；tmux 会话在独立 socket 上不受影响
```

### macOS（无 systemd）

用一个独立 tmux 会话托管，**关闭 SSH 会话后仍存活**（崩溃自动重启）。`<repo>` 换成仓库根目录。

```bash
# Node 20 必需：better-sqlite3 / node-pty 原生模块 ABI 对应 Node 20
tmux -L dashsvc new-session -d -s server \
  "cd <repo>/server && \
   export PATH='/opt/homebrew/opt/node@20/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' && \
   while true; do node src/server.js; sleep 2; done"
```

### macOS 管理 & 开机自启

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

面向**可信局域网**设计。**每个登录用户都会在宿主机上获得一个等同于「运行本服务的系统用户」的真实
shell**——可读写该用户能碰的所有文件、并使用其 `~/.claude` 等凭证。请务必只给可信的人开账号，用强口令
与强 `JWT_SECRET`；如需公网暴露，请置于 HTTPS 反向代理之后，并建议用一个专用的低权限系统用户来运行本服务。

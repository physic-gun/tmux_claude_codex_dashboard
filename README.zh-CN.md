<div align="center">

[English](README.md) · **简体中文**

# tmux_claude_codex_dashboard

**一个自托管、浏览器端的 tmux 控制台——在桌面或手机上运行并「盯着」长时间运行的 CLI 编码代理（Claude Code、Codex，或任意 shell）。**

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node 20](https://img.shields.io/badge/Node-20-5FA04E?logo=node.js&logoColor=white)
![tmux](https://img.shields.io/badge/tmux-1BB91F?logo=tmux&logoColor=white)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

<img src="docs/screenshots/dashboard.png" alt="控制台——分组、选项卡与实时终端" width="840">

</div>

> 本文是英文 [README](README.md) 的翻译，可能略有滞后；以英文版为准。

## 为什么

长时间运行的编码代理（Claude Code、Codex）仍然需要「人在环内」，但你未必守在它们运行的那台机器前。本项目把每个代理放进一个**浏览器选项卡**：以命名的**分组 → 选项卡**对应真实 tmux 窗口，于是你能从局域网里任何地方（甚至手机上）瞥一眼、粘贴上下文、拷走它的输出、推它一把——而进程始终在宿主机上继续跑。

## 快速开始

> **在宿主机上原生运行——不要用 Docker。** 网页终端、tmux、以及你启动的 `claude` / `codex` 都以你的系统用户身份运行，直接复用你现成的 `~/.claude` 登录与整机文件访问——盯真实代理正需要这点。放进容器则会把代理与你的项目、凭证隔开。

**环境要求：** Node 20 · tmux · git

```bash
git clone https://github.com/physic-gun/tmux_claude_codex_dashboard.git
cd tmux_claude_codex_dashboard

(cd server && npm install)                    # 后端依赖（会编译原生模块）
(cd client && npm install && npm run build)   # 前端构建（由后端直接托管）

cd server && node src/server.js               # → http://<局域网IP>:6880
```

首次启动会把随机 **admin** 密码打印到日志。访问 `http://<局域网IP>:6880` 登录即可。要固定自己的账号密码，先 `cp .env.example .env` 填入 `ADMIN_PASSWORD`（及可选 `JWT_SECRET`）再启动。

## 功能

|  | 功能 | 说明 |
|---|---|---|
| 🗂️ | **分组 → 选项卡** | 每个用户可建多个命名分组（每组 = 一个常驻 tmux session）；选项卡就是 tmux 窗口。关闭选项卡只转后台——进程仍在跑——可随时恢复或彻底结束。 |
| 📋 | **剪贴板中转** | 从原始输出流捕获终端 **OSC 52** 复制（claude 的 `/copy`、选中即复制），即使浏览器拦截系统剪贴板也不丢；一键回填或发送回去。 |
| 📄 | **文件预览** | 复制一段文件路径（绝对路径，或相对代理运行目录），内容在下方分栏只读预览——支持 Markdown 渲染与放大悬浮窗。 |
| ⌨️ | **直发编辑器** | `Ctrl+G` 打开可拖动、可缩放的多行编辑器；作为一次粘贴插入，或 `Ctrl+Enter` **直发**给代理。草稿按选项卡自动保存。 |
| 🌿 | **Git 面板** | 右侧源码栏显示仓库改动 /「落后远程」，内置 diff 查看与 commit · pull · push。 |
| 🕘 | **恢复与存档** | 一键 resume 此前的 claude 会话；定期把每个窗口的滚动内容快照落盘，tmux 崩溃也不丢对话。 |
| 📱 | **移动端** | 屏幕键盘、单指拖选复制、点按不弹系统键盘——在手机上也能盯着代理。 |
| 🔒 | **鉴权与 HTTPS** | JWT 登录、管理员增删用户；可选自签名 HTTPS，让局域网也能用剪贴板。 |

## 截图

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/clipboard-file-preview.png" alt="剪贴板中转与文件预览"></td>
    <td width="50%"><img src="docs/screenshots/direct-send-editor.png" alt="直发编辑器"></td>
  </tr>
  <tr>
    <td align="center">剪贴板中转 → 文件预览（实时 Markdown）</td>
    <td align="center"><code>Ctrl+G</code> 多行直发编辑器</td>
  </tr>
</table>

## 技术栈

`React` · `xterm.js` · `Express` · `node-pty` · `tmux` · `SQLite`

```
浏览器 (React + xterm.js)  ──REST /api──▶  Express  ──▶  SQLite
                          ──WS /ws/terminal──▶  node-pty  ──▶  tmux（每个观察者一个 grouped session）
```

每个终端连接都会创建一个 tmux *grouped session* 作为独立观察客户端：断开只杀这个观察者，业务窗口与其它观察者互不影响。

## 环境变量

全部可选——默认合理，密钥首次启动自动生成。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `6880` | 监听端口 |
| `JWT_SECRET` | 自动生成并持久化 | 留空即自动生成随机密钥；设固定值（需 ≥16 位）则固定 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / 随机 | 首次启动创建的管理员；密码留空则随机生成并打印到日志 |
| `DB_PATH` | `./data/dashboard.db` | SQLite 路径 |
| `TMUX_SOCKET` | `tmuxdash` | 专用 tmux socket（与系统 tmux 隔离） |
| `WORKSPACE_ROOT` | *（空）* | 新窗口起始目录 `<root>/<用户名>/<分组名>`；空则用 tmux 默认目录 |
| `TLS_CERT` / `TLS_KEY` | *（空）* | 两者都指向证书/私钥时以 HTTPS(wss) 运行 |
| `MAX_WINDOW_EXPANSION` | `50` | `name[[1-5]]` 批量建窗上限 |

## 常驻运行

<details>
<summary><b>Linux（systemd，推荐）</b></summary>

```ini
# /etc/systemd/system/tmux-dashboard.service —— <repo> / <你的用户名> 按实际替换
[Unit]
Description=tmux_claude_codex_dashboard
After=network.target

[Service]
Type=simple
User=<你的用户名>
WorkingDirectory=<repo>/server
ExecStart=/usr/bin/env node src/server.js   # node 不在 PATH 时用绝对路径
Restart=always
RestartSec=2
# EnvironmentFile=<repo>/server/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tmux-dashboard
journalctl -u tmux-dashboard -f          # 首次生成的 admin 密码在这里
```
</details>

<details>
<summary><b>macOS（无 systemd）</b></summary>

用一个独立 tmux 会话托管，关闭 SSH 会话后仍存活、崩溃自动重启：

```bash
tmux -L dashsvc new-session -d -s server \
  "cd <repo>/server && \
   export PATH='/opt/homebrew/opt/node@20/bin:/opt/homebrew/bin:/usr/bin:/bin' && \
   while true; do node src/server.js; sleep 2; done"
```

- 看日志：`tmux -L dashsvc attach`（`Ctrl-b d` 退出查看，不停服务）
- 停服务：`tmux -L dashsvc kill-server`

> 能扛住「关闭 SSH 会话」，但**扛不住重启**（tmux 重启即消失）。若要真正开机自启需用 launchd；项目若位于 `~/Documents`（受 macOS TCC 保护）还需给 node 授予**完全磁盘访问**，否则 launchd 启动时会卡死。
</details>

## HTTPS（启用浏览器剪贴板）

浏览器剪贴板 API 仅在**安全上下文**（https 或 localhost）可用。用自签名证书开启 HTTPS，让局域网设备也能复制：

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
IP.2=192.168.1.100      # 换成你的局域网 IP
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/key.pem -out certs/cert.pem -config certs/san.cnf
```

然后设置 `TLS_CERT` / `TLS_KEY` 指向证书/私钥（或写入 `server/.env`）并重启。证书与 `server/.env` 已在 `.gitignore` 中，切勿提交。

## 本地开发

```bash
(cd server && npm install && JWT_SECRET=dev npm run dev)   # 后端 :6880
(cd client && npm install && npm run dev)                  # 前端 :5173（已代理 /api、/ws）
```

## 安全提示

面向**可信局域网**设计。**每个登录用户都会在宿主机上获得一个等同于「运行本服务的系统用户」的真实 shell**——可读写该用户能碰的所有文件、并使用其 `~/.claude` 等凭证。请务必只给可信的人开账号，用强口令与强 `JWT_SECRET`；如需公网暴露，请置于 HTTPS 反向代理之后，并建议用一个专用的低权限系统用户来运行本服务。

## 许可

[MIT](LICENSE)

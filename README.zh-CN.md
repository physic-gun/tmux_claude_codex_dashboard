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

**环境要求：** Node 20 · tmux 3.2+ · git

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
| 🚦 | **代理活动灯** | Claude Code / Codex CLI 工作时亮黄灯；完成、等待、失败或中断时亮绿灯；空闲显示灰灯。右键选项卡可添加持久红色待办，也可在 hook 漏报时手动补黄灯。 |
| 🎨 | **终端配色** | 内置 7 套深色、浅色、彩色和高活力 CLI 配色，所有已打开终端实时切换；选择写入账号并跨设备同步。 |
| 📋 | **剪贴板中转** | 从原始输出流捕获终端 **OSC 52** 复制（claude 的 `/copy`、选中即复制），即使浏览器拦截系统剪贴板也不丢；一键回填或发送回去。 |
| 📄 | **文件预览** | 复制一段文件路径（绝对路径，或相对代理运行目录），内容在下方分栏只读预览——支持 Markdown 渲染与放大悬浮窗。 |
| 📁 | **文件浏览器** | 悬浮可拖拽的文件管理器（右下角 📁），默认定位到窗口工作目录：浏览目录、一键**复制路径**或**发送给代理**、预览文本/Markdown、`cd`，并可新建 / 重命名 / 删除 / **上传（拖拽）** / 下载；地址栏可直接跳转到任意路径。 |
| 🖼️ | **粘贴图片给代理** | 在终端里粘贴（`Ctrl+V` / `Ctrl+Shift+V`）或拖入图片——自动上传到服务器临时文件并把路径注入到输入框，代理据此识别为图片读取；无头服务器没有系统剪贴板也能用。 |
| ⌨️ | **直发编辑器** | `Ctrl+G` 打开可拖动、可缩放的多行编辑器；作为一次粘贴插入，或 `Ctrl+Enter` **直发**给代理。草稿按选项卡自动保存。 |
| 🌿 | **Git 面板** | 右侧源码栏显示仓库改动 /「落后远程」，内置 diff 查看与 commit · pull · push。 |
| 🕘 | **恢复与存档** | 一键 resume 此前的 claude 会话；定期 pane 快照可辅助恢复崩溃前最近的滚动内容。 |
| 📱 | **移动端** | 输入按钮、多行编辑器和屏幕键盘跟随手机可见视窗，自动适应浏览器栏与原生软键盘后的实际宽高。 |
| 🔒 | **鉴权与 HTTPS** | JWT 登录、管理员增删用户；可选自签名 HTTPS，让局域网也能用剪贴板。 |

## 近期更新（2026-07）

- **基于 lifecycle hook 的代理活动灯：** 使用 Claude/Codex 官方 hooks 显示黄色工作、绿色关注、
  灰色空闲状态，不解析终端文本；手工红色待办保存在 SQLite，后台窗口和跨设备访问也会保留。
  hook 漏报时可右键手动补黄灯，之后时间更新更晚的正常 lifecycle 事件自动接管。
- **账号同步终端配色：** Tokyo Night 及 6 套浅色/彩色预设可实时预览，不重建 xterm、不重连
  WebSocket；终端外边距同步背景色，浅色方案不会留下深色边框。
- **移动端可见视窗输入层：** 只有当前活动的池化终端显示移动输入层；竖屏、横屏及原生软键盘
  改变视窗后，编辑器和自定义键盘仍保持在可见区域，并按实测键盘高度给 xterm 留位后重新 fit。
- **识别代理会话标题：** Claude 继续使用 OSC 标题；Codex CLI 根据 pane 正在打开的 rollout 文件和
  Codex 只读状态库精确解析 root thread 标题，支持 Linux/macOS。标题不可用或重复时回退到稳定窗口名。
- **按前台进程路由滚轮：** 服务端核验真实前台命令。Claude 启用 SGR 鼠标时保持应用原生滚动；
  Codex、shell 和其它程序进入观察者独立的 tmux copy-mode。滚动、退出 copy-mode 与紧随其后的输入
  串行执行，避免滚动后的第一个按键被吞。
- **systemd 生命周期解耦：** `TMUX_MANAGED_EXTERNALLY=1`、`tmux -N` 和并列的 Node/tmux unit
  让应用重载不再拥有或向长期业务 pane 发送信号。

## 代理活动 hooks

活动灯需要安装用户级 lifecycle hooks。安装器默认只读，请先检查计划再应用：

```bash
node server/scripts/install-runtime-activity-hooks.js --check
node server/scripts/install-runtime-activity-hooks.js --apply --claude --codex
```

安装 Codex hooks 后，请新开一个 Codex 会话并运行 `/hooks`，审核并信任精确的命令定义。
最低版本、单独安装某一个 CLI、确认规则和已知边界见[中文活动灯说明](docs/agent-activity-hooks.zh-CN.md)；
也可查看[英文说明](docs/agent-activity-hooks.md)。

## 终端配色

打开**设置 → CLI 配色**可实时预览并保存 7 套内置方案：Tokyo Night、GitHub Light、
Catppuccin Latte、Ayu Light、Gruvbox Light、Bluloco Light 和 Horizon Bright。
预览只重绘现有池化终端，不重建终端、不重连 WebSocket；取消会恢复已保存方案，保存后写入
用户账号。Dashboard 网页外壳的深色/浅色主题仍是独立的设备本地偏好。

配色值静态内置，来源固定为
[iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) 提交
[`97e244cf98a0eb2ce4339d2069ec1bba6c81f141`](https://github.com/mbadolato/iTerm2-Color-Schemes/commit/97e244cf98a0eb2ce4339d2069ec1bba6c81f141)；
应用运行时不会联网获取主题数据。

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

```text
浏览器 ──REST/WS──▶ Node service cgroup ──Unix socket──▶ 持久 tmux service cgroup
                      Express + node-pty                   业务 pane + 代理
```

每个终端连接都会创建一个 tmux *grouped session* 作为独立观察客户端：断开只杀这个观察者，业务窗口与其它观察者互不影响。

## 环境变量

全部可选——默认合理，密钥首次启动自动生成。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `6880` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；可设为指定局域网 IPv4 以限制暴露范围 |
| `JWT_SECRET` | 自动生成并持久化 | 留空即自动生成随机密钥；设固定值（需 ≥16 位）则固定 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / 随机 | 首次启动创建的管理员；密码留空则随机生成并打印到日志 |
| `DB_PATH` | `./data/dashboard.db` | SQLite 路径 |
| `TMUX_SOCKET` | `tmuxdash` | 专用 tmux socket（与系统 tmux 隔离） |
| `TMUX_MANAGED_EXTERNALLY` | `false` | tmux 由独立服务监管时设为 `true`；Node 客户端加 `-N`，socket 缺失时失败而不在自身 cgroup 重建 |
| `WORKSPACE_ROOT` | *（空）* | 新窗口起始目录 `<root>/<用户名>/<分组名>`；空则用 tmux 默认目录 |
| `TLS_CERT` / `TLS_KEY` | *（空）* | 两者都指向证书/私钥时以 HTTPS(wss) 运行 |
| `MAX_WINDOW_EXPANSION` | `50` | `name[[1-5]]` 批量建窗上限 |

## 常驻运行

<details>
<summary><b>Linux（systemd，推荐）</b></summary>

使用 [`deploy/systemd/`](deploy/systemd/README.md) 下的两份模板：一个前台 `tmux -D` unit
拥有业务 pane，Node unit 只通过 `tmux -N` 连接 socket。Dashboard unit 只使用 `Wants=` 与
`After=`，不要添加 `PartOf=`、`BindsTo=` 或向 tmux unit 传播 stop。tmux 模板还设置了
`RefuseManualStop=yes`，避免普通应用部署意外结束所有会话。外管模式下 tmux 不可用时
`/api/health` 返回 503，避免把“Node 仍存活”误判为终端服务健康。

全新安装时，先渲染并验证两份模板，再安装、执行 `systemctl daemon-reload`，随后先启动 tmux unit，
再启动 Dashboard unit。`daemon-reload` 本身不会向进程发送信号。

已有单 unit 部署**不能靠 restart 直接切换**：现有 pane 可能仍与 Node 共享 cgroup，会被一起终止。
应安排维护窗口，或单独审核 live-preservation 迁移；见
[生命周期迁移说明](docs/tmux-lifecycle-separation.md)。拆分核验完成后，应用部署只重启
`tmux-dashboard.service`，绝不重启 tmux unit。
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
- 仅前端构建无需发送任何信号。后端更新只重载唯一、正数、监听 Dashboard 端口的 Node PID；
  不停止任何 tmux server：

```bash
REPO=/absolute/path/to/tmux_dashboard
PORT=${PORT:-6880}
HEALTH_URL=${HEALTH_URL:-http://localhost:$PORT/api/health}
TMUX_SOCKET=${TMUX_SOCKET:-tmuxdash}
set -- $(lsof -nP -tiTCP:$PORT -sTCP:LISTEN | sort -u)
[ "$#" -eq 1 ] || { echo "监听 PID 不是唯一值" >&2; exit 1; }
pid=$1
case "$pid" in ''|*[!0-9]*) exit 1 ;; esac
[ "$pid" -gt 1 ] || exit 1
cmd=$(ps -p "$pid" -o command=)
case "$cmd" in *"node src/server.js"*) ;; *) echo "进程不匹配: $cmd" >&2; exit 1 ;; esac
ppid=$(ps -p "$pid" -o ppid= | tr -d ' ')
case "$ppid" in ''|*[!0-9]*) exit 1 ;; esac
parent_cmd=$(ps -p "$ppid" -o command=)
case "$parent_cmd" in *"while true"*"node src/server.js"*) ;; *) echo "supervisor 不匹配: $parent_cmd" >&2; exit 1 ;; esac
cwd=$(lsof -a -p "$pid" -d cwd -Fn | sed -n 's/^n//p')
[ "$cwd" = "$REPO/server" ] || { echo "cwd 不匹配: $cwd" >&2; exit 1; }
tmux_before=$(tmux -N -L "$TMUX_SOCKET" list-sessions -F '#{pid}' | sort -u)
case "$tmux_before" in ''|*[!0-9]*) echo "tmux PID 无效" >&2; exit 1 ;; esac
/bin/kill -TERM "$pid" || { echo "无法向 Node 发送 TERM" >&2; exit 1; }
healthy=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl -kLsSf "$HEALTH_URL" >/dev/null; then healthy=1; break; fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$healthy" -eq 1 ] || { echo "Dashboard 未恢复" >&2; exit 1; }
set -- $(lsof -nP -tiTCP:$PORT -sTCP:LISTEN | sort -u)
[ "$#" -eq 1 ] && [ "$1" != "$pid" ] || { echo "Node PID 未变化" >&2; exit 1; }
tmux_after=$(tmux -N -L "$TMUX_SOCKET" list-sessions -F '#{pid}' | sort -u)
[ "$tmux_before" = "$tmux_after" ] || { echo "tmux PID 发生变化" >&2; exit 1; }
```

禁止使用 `tmux kill-server`、宽泛 `pkill`、负 PID 或进程组信号部署。

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
IP.2=YOUR_LAN_IP        # 运行 openssl 前替换
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

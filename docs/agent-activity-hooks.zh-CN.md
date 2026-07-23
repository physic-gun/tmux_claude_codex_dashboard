# Claude / Codex 会话活动灯

[English](agent-activity-hooks.md)

Dashboard 可以在分组、打开的选项卡和后台窗口上显示代理状态：

- 黄灯：当前 turn 正在工作，包括思考、工具调用和等待命令。
- 绿灯：已完成、等待权限或用户输入、失败或被中断，需要用户关注。
- 红灯：手工标记的待办，保存在 SQLite 中，可跨浏览器和设备同步。
- 灰灯：已识别的 Claude Code / Codex CLI 处于空闲。普通 shell 和其它 TUI 不显示状态灯。

运行状态来自 Claude Code 与 Codex CLI 的用户级 lifecycle hooks。hook 把一段很小的版本化
JSON 写入 pane 级 tmux user option；Dashboard 不解析终端文本，也不把临时状态写入 SQLite。
写入前 helper 会核验该 pane 同时属于精确命名为 `grp_<数字>` 的基础 session，因此普通 tmux、
SSH 或其它终端里的代理不会受到影响。

## 环境要求

- Dashboard、tmux 与代理需在同一宿主机上，以同一个系统用户原生运行。
- 建议使用 Claude Code 2.1.196 或更高版本。该版本开始提供逐 prompt 的 `prompt_id`，Dashboard
  可据此防止旧 turn 的确认状态覆盖新 turn。
- 本实现已用 Claude Code 2.1.216 和 Codex CLI 0.144.1 验证；更早版本可能只能提供部分状态。

## 安装 hooks

在仓库根目录先执行只读检查：

```bash
node server/scripts/install-runtime-activity-hooks.js --check
```

请以 Dashboard/tmux 服务配置的同一个非特权账号运行安装器，不要使用 `sudo`；代理 pane 的
`PATH` 也必须能够找到 `tmux`。

确认目标文件和 handler 列表后再应用：

```bash
# 同时配置当前账号使用的两个 CLI
node server/scripts/install-runtime-activity-hooks.js --apply --claude --codex

# 也可以只配置其中一个
node server/scripts/install-runtime-activity-hooks.js --apply --claude
node server/scripts/install-runtime-activity-hooks.js --apply --codex
```

安装器会：

1. 保留 `~/.claude/settings.json`、`~/.codex/hooks.json` 中无关的设置和 hooks。
2. 修改已有文件前创建带时间戳的 `.bak-*` 备份。
3. 使用当前 Node 与 runtime helper 的绝对路径。
4. 原子写入；后续文件写入失败时回滚本次已修改的文件。

默认模式和 `--check` 都不会写文件。示例结构见
[`server/scripts/runtime-activity-hooks.example.json`](../server/scripts/runtime-activity-hooks.example.json)。

Codex 要求审核并信任非托管 command hook。安装后新开一个 Codex 会话，运行 `/hooks`，确认并
信任安装器生成的精确定义。不要把 `--dangerously-bypass-hook-trust` 当作长期方案。

生成的命令会指向当前 checkout 中的 helper。如果移动 Node 或仓库路径，请重新执行 `--check`
和 `--apply`，以更新安装器管理的命令。

## 状态与确认规则

- 新启动的 Claude/Codex 会话从 `SessionStart` 起显示灰灯。
- 已运行的会话不会被停止；CLI 重新加载配置并触发受支持事件后开始完整上报状态。
- 绿灯在活动选项卡上也会保留。单独绿灯需在对应终端按 Enter 确认；红灯与绿灯共存时，
  点击标签同时清除两者；红灯与黄灯共存时，点击只清红灯。
- CLI 漏掉 lifecycle 事件时，可右键选项卡选择**手动标为工作中**。这个黄色兜底状态保存在
  SQLite，即使还没识别出 agent 也能显示；时间更新更晚的正常 hook 事件会优先接管。普通点击
  标签不会清除手动黄灯，只能从同一右键菜单取消。
- 独立 Ctrl+C 或 Esc 可把正在工作或等待输入的 turn 标记为已中断；方向键的转义序列以及
  粘贴文本中的换行不会被当作确认键。
- 手工红色待办可以和手动或 hook 驱动的黄灯，以及绿、灰运行状态同时存在。

helper 不输出内容、超时很短且失败开放。tmux 状态缺失或 helper 出错都不会阻止 prompt、工具、
权限请求或 turn 完成。

CLI 虽然会通过 stdin 向 hook 传入事件 JSON，但 helper 只保存白名单化的 agent、phase、reason、
detail、事件标识和时间戳。prompt 文本、工具参数、transcript 路径及 transcript 内容都不会写入
pane option，也不会由 activity API 返回。

## 已知边界

Claude Code 提供 `StopFailure`，可显示常见 API 失败类别。Codex CLI 当前没有等价的失败/中断
hook；Dashboard 仍能识别浏览器转发的中断键，以及工作中的代理进程退出，但 Codex 进程仍存活时
发生的内部 API 错误无法被可靠分类。完全结构化的失败状态需要改用 Codex App Server 启动拓扑；
本项目不会自动迁移现有 TUI 会话。

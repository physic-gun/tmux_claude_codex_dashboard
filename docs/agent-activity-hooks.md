# Claude / Codex agent activity indicators

[简体中文](agent-activity-hooks.zh-CN.md)

The dashboard can show agent state on groups, open tabs, and background windows:

- Yellow: the current turn is working, including thinking, tool calls, and command waits.
- Green: the turn completed, needs permission or user input, failed, or was interrupted.
- Red: a manually marked todo, persisted in SQLite across browsers and devices.
- Gray: a recognized Claude Code or Codex CLI process is idle. Shells and unrelated TUIs show no dot.

Runtime state comes from user-level Claude Code and Codex lifecycle hooks. Hooks write a small,
versioned JSON value to a pane-scoped tmux user option; the dashboard does not parse terminal text or
persist transient activity in SQLite. Before writing, the helper verifies that the pane also belongs
to an exact base session named `grp_<number>`, so agents in unrelated tmux or SSH sessions are ignored.

## Requirements

- Run the dashboard, tmux, and the agents natively on the same host and as the same system user.
- Claude Code 2.1.196 or newer is recommended. That version introduced per-prompt `prompt_id`, which
  lets the dashboard prevent an acknowledgement from an old turn overwriting a newer turn.
- The implementation is tested with Claude Code 2.1.216 and Codex CLI 0.144.1. Older releases may
  expose fewer lifecycle states.

## Install the hooks

From the repository root, inspect the proposed changes first:

```bash
node server/scripts/install-runtime-activity-hooks.js --check
```

Run the installer as the same unprivileged account configured as the dashboard/tmux service user;
do not use `sudo`. The agent pane's `PATH` must also be able to find `tmux`.

Apply only after reviewing the target files and handler list:

```bash
# Configure both CLIs used by this account
node server/scripts/install-runtime-activity-hooks.js --apply --claude --codex

# Or configure only one CLI
node server/scripts/install-runtime-activity-hooks.js --apply --claude
node server/scripts/install-runtime-activity-hooks.js --apply --codex
```

The installer:

1. Preserves unrelated settings and hooks in `~/.claude/settings.json` and `~/.codex/hooks.json`.
2. Creates a timestamped `.bak-*` copy before changing an existing file.
3. Uses absolute paths to the current Node executable and runtime helper.
4. Writes atomically and rolls back files already changed if a later write fails.

Default mode and `--check` are read-only. See
[`server/scripts/runtime-activity-hooks.example.json`](../server/scripts/runtime-activity-hooks.example.json)
for illustrative configuration shapes.

Codex requires non-managed command hooks to be reviewed and trusted. Start a new Codex session, run
`/hooks`, and trust the exact installed definition. Do not use
`--dangerously-bypass-hook-trust` as a permanent workaround.

The generated command points to the helper in this checkout. If Node or the repository is moved,
run `--check` and `--apply` again so the managed command is updated.

## State and acknowledgement behavior

- New Claude/Codex sessions become gray from `SessionStart`.
- Existing sessions are not stopped. They begin reporting full state after the CLI reloads its
  configuration and emits a supported event.
- Green stays visible even on the active tab. A green-only tab is acknowledged by pressing Enter in
  its terminal. Clicking a red+green tab clears both; clicking a red+yellow tab clears only red.
- Standalone Ctrl+C or Esc can mark an active/waiting turn as interrupted. Arrow-key escape sequences
  and newlines inside pasted text are not treated as acknowledgement keys.
- A manual red todo can coexist with a yellow, green, or gray runtime indicator.

The helper writes no output, uses short timeouts, and fails open. Missing tmux state or a helper error
does not block prompts, tools, permissions, or turn completion.

Although the CLI sends event JSON to the hook on stdin, the helper stores only allowlisted
agent/phase/reason/detail values, an event identifier, and a timestamp. Prompt text, tool arguments,
transcript paths, and transcript contents are neither persisted in the pane option nor returned by
the activity API.

## Known limitations

Claude Code exposes `StopFailure`, so common API failure categories can be shown. Codex CLI currently
has no equivalent failure/interruption hook. The dashboard can still observe terminal-forwarded
interrupt keys and a working agent process that exits, but it cannot reliably classify an internal
Codex API failure while the process remains alive. Fully structured failure state would require a
different launch topology based on Codex App Server; this project does not migrate existing TUI
sessions automatically.

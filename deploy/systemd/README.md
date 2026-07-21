# systemd Templates

These templates keep the long-lived tmux server and the replaceable Node web process in sibling
systemd units. Restarting `tmux-dashboard.service` then disconnects browser viewer clients briefly,
but does not signal base panes or the agents running in them.

Replace every token before installing:

- `@USER@` / `@GROUP@`: the unprivileged account that owns the projects and agent credentials.
- `@HOME@`: that account's home directory.
- `@HOST@`: the exact listen address for the dashboard web service.
- `@REPO_ROOT@`: absolute checkout path, without a trailing slash.
- `@NODE_BIN@` / `@TMUX_BIN@`: absolute executable paths from `command -v node` and
  `command -v tmux`.
- `@PATH@`: the controlled executable search path needed by shells and coding agents.

If you enable the optional agent activity hooks, run their installer as `@USER@` (never with
`sudo`) so it updates that account's Claude/Codex configuration. `@PATH@` must include the `tmux`
binary because the runtime helper talks to the pane's inherited tmux socket.

Validate rendered files before installation:

```bash
systemd-analyze verify ./tmux-dashboard-tmux.service ./tmux-dashboard.service
```

For a fresh installation, install both rendered files in `/etc/systemd/system/`, run
`systemctl daemon-reload`, then enable/start the tmux unit before the dashboard unit.

For an existing single-unit deployment, do **not** restart the old service to apply these files.
Its tmux server may still be in the same cgroup and would be terminated. Use a maintenance window or
the separately reviewed preservation procedure in [the lifecycle runbook](../../docs/tmux-lifecycle-separation.md).

Do not add `PartOf=tmux-dashboard-tmux.service`, `BindsTo=`, or stop propagation from the dashboard
unit to the tmux unit. Application deployment must never restart the tmux unit.

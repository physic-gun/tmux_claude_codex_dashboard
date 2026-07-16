# Separating Dashboard and tmux Lifecycles

## Why

systemd normally places a service and every process it starts in one cgroup. If Node implicitly
starts the tmux server, `systemctl stop`, `systemctl restart`, or a MainPID failure cleanup may signal
the tmux server, every pane shell, and every coding agent in that cgroup.

The durable design uses two sibling units connected by the existing Unix socket:

```text
tmux-dashboard-tmux.service        tmux-dashboard.service
  tmux -D                            node src/server.js
  base sessions and panes            browser viewer clients
  shell / Claude / Codex              HTTP + WebSocket
             \___________________________/
                    tmux socket
```

The dashboard unit sets `TMUX_MANAGED_EXTERNALLY=1`. Every tmux client then includes `-N`, which
means a missing socket is reported as an error instead of silently creating a new server inside the
Node cgroup.

## Fresh Installation

Render and review the templates under `deploy/systemd/`. Start the persistent tmux unit first, then
the dashboard unit. Confirm they have different `ControlGroup` values before opening long-running
sessions.

The tmux unit uses foreground mode (`tmux -D`) so systemd tracks the actual server process. It also
sets `RefuseManualStop=yes`, because intentionally stopping that unit is a destructive session
maintenance action, not an application deployment step.

Give the tmux unit only a reviewed `HOME`, `PATH`, locale, and working directory. Do not import the
Dashboard `.env` into long-lived panes: it may contain web credentials or TLS paths. Add only the
environment variables that shells and agents genuinely require.

## Existing Combined Deployment

Creating unit files and running `systemctl daemon-reload` do not send signals. Activating the new
layout by restarting an old combined unit can still terminate every existing pane.

Choose one of these approaches:

1. Schedule a cold maintenance window after recording resumable session IDs and recent pane
   snapshots, then stop the combined unit and start the two new units.
2. Have an administrator experienced with the host's systemd and cgroup version design and review a
   live preservation helper. Existing tmux and pane PIDs must be moved to a sibling scope without
   signals before Node is restarted. PID adoption differs by systemd version, may be non-atomic, and
   is not a portable copy-paste operation. The helper must guarantee thaw, check PID reuse, control
   early-moved processes, repeat descendant-closure scans, and detect/rollback partial moves.

Never attempt a cgroup freezer migration from a shell inside the cgroup being frozen. Never move
only the tmux server PID: existing pane descendants must be included and verified individually.
This repository intentionally does not ship a generic live-migration executable.

`RefuseManualStop=yes` is an accident guard, not a security boundary. Keep normal unit-management
permissions restricted and treat direct signals, `systemctl kill`, and shutdown as separate risks.

## Verification

```text
[ ] tmux and Node have different ControlGroup values
[ ] the tmux socket is owned by the expected tmux unit/scope
[ ] Node TMUX_SOCKET exactly matches the tmux unit socket
[ ] TMUX_MANAGED_EXTERNALLY=1 is present on Node
[ ] Node tmux commands include -N
[ ] /api/health returns 503 when externally managed tmux is unavailable
[ ] base session and window counts match the pre-migration inventory
[ ] restarting only Node changes no tmux server or agent PID
[ ] application deployment never stops/restarts the tmux unit
```

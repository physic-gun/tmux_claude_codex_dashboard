#!/bin/sh
set -eu

socket=${1:?tmux socket name is required}
attempts=${2:-50}
tmux_bin=${3:-/usr/bin/tmux}
i=0

while [ "$i" -lt "$attempts" ]; do
  if "$tmux_bin" -N -L "$socket" show-options -gqv exit-empty >/dev/null 2>&1; then
    exit 0
  fi
  i=$((i + 1))
  sleep 0.1
done

echo "tmux socket '$socket' did not become ready" >&2
exit 1

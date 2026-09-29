#!/bin/sh
# One gateway per container, so a gateway.lock left by the previous run is always stale.
# Upstream keeps it when the recorded pid is alive — and in a fresh container the same
# entrypoint gets the same pid, i.e. our own — so the start would be refused.
set -eu
CONFIG_DIR="${QWAUDIO_CONFIG_DIR:-/data/qwaudio}"
mkdir -p "$CONFIG_DIR"
rm -f "$CONFIG_DIR/gateway.lock"
exec "$@"

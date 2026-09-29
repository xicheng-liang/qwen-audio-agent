#!/usr/bin/env bash
# Experimental GPT-Live 1 build for the earbud text uplink (branch exp/gpt-live-1-earbud-wake).
# Separate image, container, port and data dir; the trial and compare containers are untouched.
# Usage: ./run-exp.sh build | start | stop | logs | env-set KEY VALUE
set -euo pipefail
cd /srv/qaa-trial/exp
NAME=qaa-exp
IMAGE=qaa:gpt-live-1-exp
PORT=3125
# Same keys as the trial column; only the port differs. Copied server-side, never printed.
seed_env() {
  [ -f exp.env ] && return
  (umask 077; grep -v '^PORT=' /srv/qaa-trial/trial.env > exp.env; echo "PORT=$PORT" >> exp.env)
}

case "${1:-start}" in
  build)
    rm -rf src && mkdir src && tar xzf gl1-exp-tree.tgz -C src
    cp -r ops src/ops
    if (cd src && sudo docker build -f ops/Dockerfile -t "$IMAGE" .) > build.log 2>&1; then
      echo "build ok $(sudo docker images --format '{{.ID}}' "$IMAGE")"
    else
      echo "build FAILED"; tail -20 build.log; exit 1
    fi
    ;;
  start)
    seed_env
    grep -q "^PORT=$PORT\$" exp.env && grep -q '^HOST=127.0.0.1$' exp.env \
      || { echo "exp.env must hold PORT=$PORT and HOST=127.0.0.1 (delete it to re-seed)"; exit 1; }
    sudo install -d -o 10001 -g 10001 -m 700 data
    sudo docker rm -f "$NAME" >/dev/null 2>&1 || true
    sudo find data -iname "*lock*" -type f -delete 2>/dev/null || true
    sudo docker run -d --name "$NAME" --restart unless-stopped --network host \
      --env-file exp.env -v /srv/qaa-trial/exp/data:/data \
      --label trial.owner=xicheng --label trial.purpose=gpt-live-1-earbud-experiment \
      "$IMAGE" >/dev/null
    sleep 6
    echo "health: $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health")"
    sudo docker logs "$NAME" 2>&1 | grep -E "gateway.ready|gateway.start_failed|Error|error" | grep -viE "sk-|token|secret|key" | tail -5
    ;;
  env-set)
    # Non-secret tuning keys only (e.g. GPT_LIVE_1_IDLE_CLOSE_MS). Takes effect on the next start.
    seed_env
    key=$2; value=$3
    case "$key" in *KEY*|*TOKEN*|*SECRET*) echo "refusing to set a secret here"; exit 1;; esac
    (umask 077; grep -v "^$key=" exp.env > exp.env.tmp || true; echo "$key=$value" >> exp.env.tmp; mv exp.env.tmp exp.env)
    echo "set $key"
    ;;
  stop) sudo docker rm -f "$NAME" >/dev/null 2>&1 || true; echo "$NAME removed";;
  logs) sudo docker logs --since "${2:-10m}" "$NAME" 2>&1 | grep -viE "sk-|bearer";;
  *) echo "usage: $0 build|start|stop|logs [since]|env-set KEY VALUE"; exit 1;;
esac

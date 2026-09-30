#!/usr/bin/env bash
# GPT-Live earbud trial for several people on this box: one qaa-exp container per tenant, started
# on first use and removed after 30 min without a connection. The 34.212 allocator sends a tenant
# here when its route carries SIGMA_ROUTE_HOST=10.0.2.151 (allocator branch exp/gpt-live-route-host).
#   ./glx.sh up | down | status | list | warm <tenant> | drop <tenant> | check <tenant> [hold_s] | logs [since]
# Entry 10.0.2.151:80, 34.212 and this box only, X-Qaa-Proxy must match:
#   GET /t/<tenant>/api/realtime · POST /t/<tenant>/warm · POST /t/<tenant>/drop
# Secrets are copied server-side into 600 files and never printed. down removes every container,
# those copies and the tenants' data; the scripts and the qaa:gpt-live-1-exp image stay.
# Test knobs for up: GLX_MAX (5), GLX_IDLE_S (1800), GLX_SWEEP_S (60).
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
IMAGE=qaa:gpt-live-1-exp
PY=python:3.12-alpine
NGINX=nginx:1.27-alpine
ENTRY=qaa-glx-entry
DOORMAN=qaa-glx-doorman
ENTRY_URL=http://10.0.2.151:80
TUNING=(GPT_LIVE_1_IDLE_CLOSE_MS=30000 GPT_LIVE_1_DROP_SPONTANEOUS_SPEECH=1
        GPT_LIVE_1_DROP_CANCELLED_TAIL=1 GPT_LIVE_1_OUTPUT_GAIN=2 GPT_LIVE_1_RESTART_ON_CANCEL=1)

tenant_arg() {
  [[ ${1:-} =~ ^[0-9a-f]{12}$ ]] || { echo "tenant must be 12 hex"; exit 1; }
}

seed_env() {
  # The trial column's keys, minus its port, plus the earbud tuning the exp column runs with.
  local drop='^(PORT|GPT_LIVE_1_IDLE_CLOSE_MS|GPT_LIVE_1_DROP_SPONTANEOUS_SPEECH|GPT_LIVE_1_DROP_CANCELLED_TAIL|GPT_LIVE_1_OUTPUT_GAIN|GPT_LIVE_1_RESTART_ON_CANCEL)='
  (umask 077; grep -v -E "$drop" /srv/qaa-trial/trial.env > glx.env; printf '%s\n' "${TUNING[@]}" >> glx.env)
  grep -q '^HOST=127.0.0.1$' glx.env || { rm -f glx.env; echo "trial.env must hold HOST=127.0.0.1"; exit 1; }
  grep -q '^QWEN_AUDIO_REALTIME_PROVIDER=gpt-live-1$' glx.env \
    || { rm -f glx.env; echo "trial.env must run the gpt-live-1 provider"; exit 1; }
}

write_conf() {
  local v t
  (umask 077; mkdir -p conf)
  v=$(sudo grep -m1 '^QAA_PROXY_SECRET=' /srv/sigma-link/.env | cut -d= -f2- | tr -d "\r\n\"'")
  [ "${#v}" -ge 32 ] || { echo "proxy secret missing"; exit 1; }
  t=$(grep -m1 '^QWEN_AUDIO_GATEWAY_ACCESS_TOKEN=' glx.env | cut -d= -f2- | tr -d "\r\n")
  [ "${#t}" -ge 24 ] || { echo "glx.env has no access token"; exit 1; }
  umask 077
  printf 'map $http_x_qaa_proxy $gw_proxy_ok {\n  default 0;\n  "%s" 1;\n}\n' "$v" > conf/secret.conf
  printf 'map $host $glx_bearer {\n  default "Bearer %s";\n}\n' "$t" > conf/bearer.conf
  printf '%s' "$v" > conf/marker
  printf 'X-Qaa-Proxy: %s\n' "$v" > conf/marker.hdr
  unset v t
}

cmd_up() {
  sudo docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || { echo "no $IMAGE: build it with /srv/qaa-trial/exp/run-exp.sh build"; exit 1; }
  if ! sudo docker image inspect "$PY" >/dev/null 2>&1; then
    sudo docker pull -q "$PY" >/dev/null
    touch .pulled-python
  fi
  [ -f glx.env ] || seed_env
  write_conf
  sudo install -d -o root -g root -m 700 data
  sudo docker rm -f "$ENTRY" "$DOORMAN" >/dev/null 2>&1 || true
  sudo docker run -d --name "$DOORMAN" --restart unless-stopped --network host \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$HERE:/glx" \
    -e GLX_HOST_ROOT="$HERE" -e GLX_IMAGE="$IMAGE" -e GLX_MAX="${GLX_MAX:-5}" \
    -e GLX_IDLE_S="${GLX_IDLE_S:-1800}" -e GLX_SWEEP_S="${GLX_SWEEP_S:-60}" \
    --label trial.owner=xicheng --label trial.purpose=glx "$PY" python -u /glx/doorman.py >/dev/null
  local _
  for _ in $(seq 30); do
    curl -sf --max-time 1 -o /dev/null http://127.0.0.1:4299/healthz && break
    sleep 0.3
  done
  curl -sf --max-time 1 -o /dev/null http://127.0.0.1:4299/healthz \
    || { echo "doorman did not come up"; sudo docker logs --tail 20 "$DOORMAN"; exit 1; }
  sudo docker run -d --name "$ENTRY" --restart unless-stopped --network host \
    -v "$HERE/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$HERE/conf:/etc/nginx/glx:ro" \
    --label trial.owner=xicheng --label trial.purpose=glx "$NGINX" >/dev/null
  sleep 1
  sudo docker exec "$ENTRY" nginx -t 2>&1 | tail -1
  echo "glx up: entry 10.0.2.151:80, doorman 127.0.0.1:4299, max ${GLX_MAX:-5}, idle ${GLX_IDLE_S:-1800}s"
}

cmd_down() {
  local ids
  sudo docker rm -f "$ENTRY" "$DOORMAN" >/dev/null 2>&1 || true
  ids=$(sudo docker ps -aq --filter label=trial.purpose=glx-tenant)
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    sudo docker rm -f $ids >/dev/null
  fi
  sudo rm -rf data glx.env conf
  if [ -f .pulled-python ]; then
    sudo docker rmi "$PY" >/dev/null 2>&1 || true
    rm -f .pulled-python
  fi
  echo "glx down: containers, secret copies and tenant data removed; scripts and $IMAGE kept"
}

post() {  # post <action> <tenant>
  curl -s -o /dev/null -w "$1 %{http_code} %{time_total}s\n" --max-time 75 -X POST \
    -H @conf/marker.hdr "$ENTRY_URL/t/$2/$1"
}

case "${1:-status}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status)
    sudo docker ps -a --filter label=trial.purpose=glx --filter label=trial.purpose=glx-tenant \
      --format '{{.Names}} {{.Status}}'
    ;;
  list) curl -s --max-time 5 http://127.0.0.1:4299/list; echo ;;
  warm) tenant_arg "${2:-}"; post warm "$2" ;;
  drop) tenant_arg "${2:-}"; post drop "$2" ;;
  check)
    tenant_arg "${2:-}"
    sudo docker run --rm --network host --user 0 --entrypoint node \
      -v "$HERE/ws-check.mjs:/ws-check.mjs:ro" -v "$HERE/conf/marker:/run/glx-marker:ro" \
      --label trial.owner=xicheng --label trial.purpose=glx-check "$IMAGE" /ws-check.mjs "$2" "${3:-0}"
    ;;
  logs)
    echo "== doorman"; sudo docker logs --since "${2:-10m}" "$DOORMAN" 2>&1 | tail -40
    echo "== entry"; sudo docker logs --since "${2:-10m}" "$ENTRY" 2>&1 | grep -viE "bearer|x-qaa-proxy" | tail -40
    ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac

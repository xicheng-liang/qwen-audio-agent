#!/usr/bin/env bash
# Earbud gateway entry on EC2: lets the 34.212 device gateway reach one qaa column here.
#   TLS :4210, only 10.1.16.181 (34.212), X-Qaa-Proxy must equal the gateway's secret;
#   forwards /api/realtime to the chosen column with its Bearer token, stripping the secret
#   and the gateway's cookie. Secrets are generated server-side into 600 files, never printed.
# Usage: ./gw-entry.sh start [target] | switch <target> | status | logs [since] | stop
#   targets: exp (qaa-exp :3125) · gl1 (qaa-trial :3120) · qwen (qaa-cmp-qwen :3122) · hf (qaa-cmp-hf :3123)
set -euo pipefail
cd "$(dirname "$0")"
NAME=qaa-gw-entry
PORT=4210
GATEWAY_IP=10.1.16.181
declare -A PORTS=([exp]=3125 [gl1]=3120 [qwen]=3122 [hf]=3123)
declare -A CONTAINERS=([exp]=qaa-exp [gl1]=qaa-trial [qwen]=qaa-cmp-qwen [hf]=qaa-cmp-hf)

write_secret() {
  umask 077; mkdir -p conf
  local v
  v=$(sudo grep -m1 '^QAA_PROXY_SECRET=' /srv/sigma-link/.env | cut -d= -f2- | tr -d "\r\n\"'")
  [ "${#v}" -ge 32 ] || { echo "proxy secret missing"; exit 1; }
  printf 'map $http_x_qaa_proxy $gw_proxy_ok {\n  default 0;\n  "%s" 1;\n}\n' "$v" > conf/secret.conf
  unset v
}

write_route() {
  local target=$1 port=${PORTS[$1]:-} container=${CONTAINERS[$1]:-} token
  [ -n "$port" ] || { echo "unknown target: $target (exp|gl1|qwen|hf)"; exit 1; }
  umask 077; mkdir -p conf
  token=$(sudo docker exec "$container" printenv QWEN_AUDIO_GATEWAY_ACCESS_TOKEN)
  [ "${#token}" -ge 24 ] || { echo "$container has no access token"; exit 1; }
  printf 'map $host $gw_upstream {\n  default 127.0.0.1:%s;\n}\nmap $host $gw_bearer {\n  default "Bearer %s";\n}\n' "$port" "$token" > conf/route.conf
  unset token
  echo "$target" > conf/target
}

run() {
  sudo docker rm -f "$NAME" >/dev/null 2>&1 || true
  sudo docker run -d --name "$NAME" --restart unless-stopped --network host \
    -v "$PWD/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$PWD/conf:/etc/nginx/gw:ro" -v "$PWD/tls:/etc/nginx/tls:ro" \
    --label trial.owner=xicheng --label trial.purpose=earbud-gateway-entry nginx:1.27-alpine >/dev/null
  sleep 1
  sudo docker exec "$NAME" nginx -t 2>&1 | tail -1
  echo "entry :$PORT -> $(cat conf/target) (${PORTS[$(cat conf/target)]})"
}

case "${1:-status}" in
  start)
    [ -f tls/cert.pem ] || { (umask 077; mkdir -p tls); sudo cp /srv/qaa-compare/tls/cert.pem /srv/qaa-compare/tls/key.pem tls/; sudo chmod 644 tls/cert.pem; }
    write_secret; write_route "${2:-exp}"; run ;;
  switch)
    case "${2:?target}" in
      gl1) [ "${FORCE:-}" = 1 ] || { echo "gl1 has none of the earbud fixes and stays silent on the earbud; FORCE=1 to switch anyway"; exit 1; } ;;
      qwen|hf) echo "note: $2 is a compare-page column; the earbud and browser users share its single voice slot" ;;
    esac
    write_route "$2"; run ;;
  status) echo "target: $(cat conf/target 2>/dev/null || echo none)"; sudo docker ps --filter name="$NAME" --format '{{.Names}} {{.Status}}' ;;
  logs) sudo docker logs --since "${2:-10m}" "$NAME" 2>&1 | grep -viE "bearer|x-qaa-proxy" ;;
  stop) sudo docker rm -f "$NAME" >/dev/null 2>&1 || true; echo "$NAME removed" ;;
  *) echo "usage: $0 start [target] | switch <exp|gl1|qwen|hf> | status | logs [since] | stop"; exit 1 ;;
esac

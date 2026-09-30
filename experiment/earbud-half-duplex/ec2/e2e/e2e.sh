#!/usr/bin/env bash
# End-to-end earbud harness: the real device gateway (live-agent-api, qwen engine, origin/main)
# driven by a half-duplex push-to-talk earbud simulator, against one qaa container on this box.
#
#   ./e2e.sh build                 build live-agent/api:qaa-e2e from origin/main (shallow clone in /tmp, removed after)
#   ./e2e.sh up <qaa_port>         start qaa-e2e-gw on 127.0.0.1:18081 -> ws://127.0.0.1:<qaa_port>/api/realtime
#   ./e2e.sh turns <N> [wav...]    N PTT turns; wav = path, or a name in wav/ (default: q1 q2 q3, cycled)
#   ./e2e.sh report [run_dir]      reprint the per-turn report of a run (default: latest)
#   ./e2e.sh hear [run_dir]        transcribe that run's saved clips (live + 2002) with the gateway's ASR
#   ./e2e.sh status | down | clean down = remove gateway + its postgres/minio; clean = down + remove the image
#
# Knobs (env): LINGER=45 QUIET=20 (idle listen after each turn), HEAR=1 (transcribe clips after turns), CONNECT_AFTER_IDENTITY=true (prod value),
#   NOTIFY_TAIL_PAD_MS=0 (prod pads 3000), QWEN_LOCALE=en-US, QWEN_TIME_ZONE=UTC, FORCE=1 (skip busy-qaa check),
#   QAA_URL=<ws url> (dial this instead of 127.0.0.1:<qaa_port>, skipping the health / cookie probe; pass it to
#   turns too), QAA_ENV_FILE=<600 file> (extra gateway env lines, e.g. QAA_EXTRA_HEADERS carrying an entry's marker).
#
# Isolation: its own postgres and minio (tmpfs, bridge network, nothing published) because the gateway's
# startup runs create_all + column auto-migrate + default-agent seed and creates its S3 bucket; neither
# may touch the dev stack. Nothing secret goes into the gateway: trust-auth DB, dummy keys.
# The only value read from the dev checkout is PLAUD_ASR_URL. qaa is reached over loopback with no
# X-Forwarded-* headers, so qaa v2 grants local identity (personal mode = user_personal) without a token.
set -euo pipefail

HERE=/srv/qaa-trial/exp/e2e
REPO=${REPO:-$HOME/plaud-agent-platform}
GIT_URL=${GIT_URL:-https://github.com/Plaud-AI/plaud-agent-platform.git}
SRC=/tmp/qaa-e2e-src
IMG=live-agent/api:qaa-e2e
GW=qaa-e2e-gw
PG=qaa-e2e-pg
S3=qaa-e2e-s3
PORT=${GW_PORT:-18081}
METRICS_PORT=${METRICS_PORT:-19081}
STATE=$HERE/.state
DEFAULT_WAVS=(q1 q2 q3)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { echo "  x $*" >&2; exit 1; }

# Every container log line shown or saved goes through this. The one rename keeps the gateway's
# voice_latency record (field llm_first_token_ms) from being dropped by the "token" filter.
redact() { sed -E 's/\x1b\[[0-9;]*m//g; s/llm_first_token/llm_first_tkn/g' \
           | grep -viE 'sk-|bearer|token|secret|password|key=' || true; }

qaa_container() {
  case "$1" in
    3125) echo qaa-exp ;; 3122) echo qaa-cmp-qwen ;; 3123) echo qaa-cmp-hf ;; 3120) echo qaa-trial ;;
    *) echo "${QAA_CONTAINER:?set QAA_CONTAINER for port $1}" ;;
  esac
}

# Voice clients connected to a qaa right now (connected minus disconnected over its log). qaa v2
# gives every loopback / Bearer client the same ownerId (user_personal), so a browser on the compare
# page and this gateway would fight over one voice slot.
open_clients() {
  sudo docker logs "$1" 2>&1 \
    | awk '/voice_client\.connected/{n++} /voice_client\.disconnected/{if(n>0)n--} END{print n+0}'
}

cmd_build() {
  say "[build] origin/main -> $IMG"
  rm -rf "$SRC"
  git clone -q --depth 1 --branch main "$GIT_URL" "$SRC"
  local sha subject
  sha=$(git -C "$SRC" rev-parse HEAD); subject=$(git -C "$SRC" log -1 --format=%s)
  echo "  commit ${sha:0:8} $subject"
  sudo docker build -q -f "$SRC/live-agent-api/Dockerfile" --label "e2e.commit=$sha" -t "$IMG" "$SRC" >/dev/null
  rm -rf "$SRC"
  echo "  built $(sudo docker images --format '{{.ID}} {{.Size}}' "$IMG"); clone removed"
  df -h / | awk 'NR==2{print "  disk free: "$4}'
}

cmd_up() {
  local qport="${1:?usage: up <qaa_port>}" qc
  qc=$(qaa_container "$qport")
  sudo docker image inspect "$IMG" >/dev/null 2>&1 || die "no image $IMG - run: $0 build"
  [ -n "${QAA_URL:-}" ] || curl -sf --max-time 5 -o /dev/null "http://127.0.0.1:$qport/api/health" \
    || die "qaa on :$qport not healthy"
  if ! sudo docker ps -q --filter "name=^${GW}$" | grep -q .; then
    ss -ltn | grep -qE "[:.]$PORT\s" && die "port $PORT already in use"
    ss -ltn | grep -qE "[:.]$METRICS_PORT\s" && die "metrics port $METRICS_PORT already in use"
  fi
  install -d -m 700 "$STATE"

  # Fresh schema the way the product boots one: init_db.sql as a postgres init script, then
  # scripts/migrate.py, then the app's own init_db() (create_all + auto-migrate + default agents).
  say "[up] postgres $PG (throwaway, tmpfs)"
  local fresh=0
  if ! sudo docker ps -q --filter "name=^${PG}$" | grep -q .; then
    fresh=1
    sudo docker rm -f "$PG" >/dev/null 2>&1 || true
    sudo docker run --rm "$IMG" cat /app/init_db.sql > "$STATE/init_db.sql"
    chmod 644 "$STATE/init_db.sql"
    sudo docker run -d --name "$PG" --label e2e.owner=xicheng \
      -e POSTGRES_USER=postgres -e POSTGRES_DB=e2e -e POSTGRES_HOST_AUTH_METHOD=trust \
      -v "$STATE/init_db.sql:/docker-entrypoint-initdb.d/init_db.sql:ro" \
      --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
  fi
  local _
  for _ in $(seq 40); do
    sudo docker exec "$PG" pg_isready -h 127.0.0.1 -U postgres -d e2e -q 2>/dev/null && break; sleep 1
  done
  sudo docker exec "$PG" pg_isready -h 127.0.0.1 -U postgres -d e2e -q || die "postgres not ready"
  local pgip
  pgip=$(sudo docker inspect "$PG" -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
  echo "  ready at $pgip:5432"

  say "[up] minio $S3 (throwaway, tmpfs)"
  if ! sudo docker ps -q --filter "name=^${S3}$" | grep -q .; then
    sudo docker rm -f "$S3" >/dev/null 2>&1 || true
    sudo docker run -d --name "$S3" --label e2e.owner=xicheng \
      -e MINIO_ROOT_USER=e2e-dummy -e MINIO_ROOT_PASSWORD=e2e-dummy-not-a-secret \
      --tmpfs /data minio/minio:latest server /data >/dev/null
  fi
  local s3ip
  s3ip=$(sudo docker inspect "$S3" -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
  for _ in $(seq 30); do
    curl -sf --max-time 2 -o /dev/null "http://$s3ip:9000/minio/health/live" && break; sleep 1
  done
  echo "  ready at $s3ip:9000"

  say "[up] gateway $GW on 127.0.0.1:$PORT -> qaa $qc (:$qport)"
  # Optional: a qaa in browser identity mode signs a cookie for loopback HTTP; personal mode signs none
  # and needs none. The value only ever goes into the 600 env file.
  local cookie=""
  [ -n "${QAA_URL:-}" ] || cookie=$(curl -s -D- -o /dev/null --max-time 5 "http://127.0.0.1:$qport/" \
           | tr -d '\r' | grep -i '^set-cookie: *qwen_audio_agent_identity=' | sed 's/^[^:]*: *//' | cut -d';' -f1 || true)
  (
    umask 077
    {
      grep -E '^PLAUD_ASR_URL=' "$REPO/.env" || true
      echo "DATABASE_URL=postgresql+asyncpg://postgres@$pgip:5432/e2e"
      echo "SECRET_KEY=e2e-dummy-not-a-secret"
      echo "S3_BUCKET_NAME=e2e-dummy"
      echo "S3_ENDPOINT_URL=http://$s3ip:9000"
      echo "AWS_ACCESS_KEY_ID=e2e-dummy"
      echo "AWS_SECRET_ACCESS_KEY=e2e-dummy-not-a-secret"
      echo "FISH_API_KEY=e2e-dummy"
      echo "OPENAI_API_KEY=e2e-dummy"
      echo "OPENROUTER_API_KEY=e2e-dummy"
      echo "METRICS_PORT=$METRICS_PORT"
      echo "DEVICE_WS_ENGINE=qwen"
      echo "DEVICE_WS_IDLE_NOTIFY_ENABLED=true"
      echo "DEVICE_WS_QWEN_CONNECT_AFTER_IDENTITY=${CONNECT_AFTER_IDENTITY:-true}"
      echo "DEVICE_WS_NOTIFY_TAIL_PAD_MS=${NOTIFY_TAIL_PAD_MS:-0}"
      echo "DEVICE_WS_QWEN_LOCALE=${QWEN_LOCALE:-en-US}"
      echo "DEVICE_WS_QWEN_TIME_ZONE=${QWEN_TIME_ZONE:-UTC}"
      echo "QWEN_AUDIO_AGENT_WS_URL=${QAA_URL:-ws://127.0.0.1:$qport/api/realtime}"
      echo "QWEN_AUDIO_AGENT_AUTH_SECRET=e2e-dummy-secret-at-least-32-characters"
      if [ -n "$cookie" ]; then echo "QAA_EXTRA_COOKIES=$cookie"; fi
      if [ -n "${QAA_ENV_FILE:-}" ]; then cat "$QAA_ENV_FILE"; fi
    } > "$STATE/gw.env"
  )
  grep -qE '^PLAUD_ASR_URL=.+' "$STATE/gw.env" || die "PLAUD_ASR_URL missing from $REPO/.env"
  echo "  identity cookie from qaa: $([ -n "$cookie" ] && echo "issued (browser mode), passed via QAA_EXTRA_COOKIES" || echo "none (personal mode: loopback = user_personal)")"
  if [ "$fresh" = 1 ]; then
    sudo docker run --rm --network host --env-file "$STATE/gw.env" "$IMG" .venv/bin/python scripts/migrate.py \
      2>&1 | redact | grep -iE 'error|fail|applied|complete' | tail -5 | sed 's/^/  migrate: /' || true
  fi
  sudo docker rm -f "$GW" >/dev/null 2>&1 || true
  sudo docker run -d --name "$GW" --network host --env-file "$STATE/gw.env" \
    --label e2e.owner=xicheng --label "e2e.qaa_port=$qport" \
    "$IMG" .venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port "$PORT" \
      --ws-per-message-deflate false --ws-ping-interval 3600 --ws-ping-timeout 3600 >/dev/null
  echo "$qport" > "$STATE/qaa_port"
  for _ in $(seq 40); do
    curl -sf --max-time 3 -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 2
  done
  if ! curl -sf --max-time 3 -o /dev/null "http://127.0.0.1:$PORT/health"; then
    sudo docker logs "$GW" 2>&1 | redact | tail -25
    die "gateway did not come up"
  fi
  echo "  health OK; image commit $(sudo docker image inspect -f '{{index .Config.Labels "e2e.commit"}}' "$IMG" | cut -c1-8)"
  sudo docker exec "$GW" sh -c 'for k in DEVICE_WS_ENGINE QWEN_AUDIO_AGENT_WS_URL DEVICE_WS_IDLE_NOTIFY_ENABLED DEVICE_WS_QWEN_CONNECT_AFTER_IDENTITY DEVICE_WS_NOTIFY_TAIL_PAD_MS DEVICE_WS_QWEN_LOCALE; do eval "echo \"    $k=\$$k\""; done'
  echo "  stop with: $0 down"
}

resolve_wav() {
  local a="$1"
  for f in "$a" "$HERE/wav/$a" "$HERE/wav/$a.wav"; do
    [ -f "$f" ] && { echo "$f"; return; }
  done
  cat >&2 <<EOF
  x no WAV for "$a". This box has no TTS; make one on a Mac and copy it here:
      say -v Tingting -o x.aiff "$a" && afconvert -f WAVE -d LEI16@16000 -c 1 x.aiff x.wav
      scp x.wav <box>:$HERE/wav/<name>.wav      # then: $0 turns 1 <name>
EOF
  return 1
}

cmd_turns() {
  local n="${1:?usage: turns <N> [wav...]}"; shift || true
  sudo docker ps -q --filter "name=^${GW}$" | grep -q . || die "gateway not running - run: $0 up <qaa_port>"
  local qport qc busy
  qport=$(cat "$STATE/qaa_port"); qc=$(qaa_container "$qport")
  [ -n "${QAA_URL:-}" ] || curl -sf --max-time 5 -o /dev/null "http://127.0.0.1:$qport/api/health" \
    || die "qaa on :$qport not healthy"
  busy=$(open_clients "$qc")
  if [ "$busy" != "0" ] && [ "${FORCE:-0}" != "1" ]; then
    die "$qc has $busy voice client(s) connected (browser?) - same ownerId as us; wait, or FORCE=1"
  fi
  local names=("$@"); [ ${#names[@]} -eq 0 ] && names=("${DEFAULT_WAVS[@]}")
  local wavs=() a f
  for a in "${names[@]}"; do f=$(resolve_wav "$a") || exit 1; wavs+=("$f"); done

  local run; run="$HERE/runs/$(date -u +%Y%m%dT%H%M%SZ)-p$qport"
  mkdir -p "$run"
  local since; since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  sudo docker exec "$GW" sh -c 'rm -rf /tmp/e2e /tmp/e2e_out && mkdir -p /tmp/e2e'
  sudo docker cp "$HERE/e2e_sim.py" "$GW:/tmp/e2e/e2e_sim.py" >/dev/null
  local args=()
  for f in "${wavs[@]}"; do
    sudo docker cp "$f" "$GW:/tmp/e2e/$(basename "$f")" >/dev/null; args+=(--wav "/tmp/e2e/$(basename "$f")")
  done
  say "[turns] $n turn(s) via $GW -> $qc (:$qport); run dir $run"
  local url="ws://127.0.0.1:$PORT/api/live_agent/v1/device/ws?uid=e2e&platform=device&engine=qwen"
  sudo docker exec "$GW" /app/.venv/bin/python /tmp/e2e/e2e_sim.py "$url" --turns "$n" "${args[@]}" \
    --linger "${LINGER:-45}" --quiet "${QUIET:-20}" 2>&1 | tee "$run/sim.log" || true
  sudo docker cp "$GW:/tmp/e2e_out" "$run/audio" >/dev/null 2>&1 || true
  sudo chown -R "$(id -u):$(id -g)" "$run"
  sleep 2
  sudo docker logs --since "$since" "$GW" 2>&1 | redact > "$run/gateway.log"
  sudo docker logs --since "$since" "$qc" 2>&1 | grep -E '^[0-9TZ:.-]+ (INFO|WARN|ERROR|DEBUG) ' | redact > "$run/qaa.log" || true
  echo "$qc" > "$run/qaa_container"
  cmd_report "$run"
  if [ "${HEAR:-1}" = "1" ]; then cmd_hear "$run"; fi
}

cmd_hear() {
  local run="${1:-$(ls -d "$HERE"/runs/*/ 2>/dev/null | sort | tail -1)}"
  [ -d "$run/audio" ] || die "no saved clips in $run"
  sudo docker ps -q --filter "name=^${GW}$" | grep -q . || die "gateway not running (the ASR client lives in its image) - run: $0 up <qaa_port>"
  sudo docker exec "$GW" sh -c 'rm -rf /tmp/e2e_hear && mkdir -p /tmp/e2e_hear'
  sudo docker cp "$HERE/transcribe.py" "$GW:/tmp/e2e/transcribe.py" >/dev/null
  local f
  for f in "$run"/audio/*.plaudopus; do sudo docker cp "$f" "$GW:/tmp/e2e_hear/" >/dev/null; done
  say "[hear] what each saved clip says (gateway ASR)"
  sudo docker exec -w /app "$GW" /app/.venv/bin/python /tmp/e2e/transcribe.py /tmp/e2e_hear 2>/dev/null \
    | grep -E '\.plaudopus\s' | redact | tee "$run/heard.txt" || true
}

cmd_report() {
  local run="${1:-$(ls -d "$HERE"/runs/*/ 2>/dev/null | sort | tail -1)}"
  [ -n "$run" ] && [ -f "$run/sim.log" ] || die "no run found"
  python3 "$HERE/summarize.py" "$run"
}

cmd_status() {
  sudo docker ps -a --filter "name=^${GW}$" --filter "name=^${PG}$" --filter "name=^${S3}$" --format '  {{.Names}}\t{{.Status}}'
  [ -f "$STATE/qaa_port" ] && echo "  qaa port: $(cat "$STATE/qaa_port")"
  sudo docker images --format '  {{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}' "$IMG"
}

cmd_down() {
  sudo docker rm -f "$GW" "$PG" "$S3" >/dev/null 2>&1 || true
  rm -f "$STATE/gw.env" "$STATE/qaa_port" "$STATE/init_db.sql"
  echo "  removed $GW, $PG, $S3 (image $IMG kept; '$0 clean' removes it)"
}

cmd_clean() {
  cmd_down
  sudo docker rmi "$IMG" >/dev/null 2>&1 || true
  rm -rf "$SRC"
  echo "  removed image $IMG"
}

case "${1:-}" in
  build) cmd_build ;;
  up) shift; cmd_up "$@" ;;
  turns) shift; cmd_turns "$@" ;;
  report) shift; cmd_report "$@" ;;
  hear) shift; cmd_hear "$@" ;;
  status) cmd_status ;;
  down|stop) cmd_down ;;
  clean) cmd_clean ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac

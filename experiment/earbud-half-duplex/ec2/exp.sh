#!/usr/bin/env bash
# One switch for the half-duplex GPT-Live 1 earbud experiment on this box.
#   ./exp.sh up      start qaa-exp (:3125) and the earbud entry (:4210 -> exp)
#   ./exp.sh down    stop both; delete this experiment's secret copies and the e2e gateway image
#   ./exp.sh status
# Image, code tarball, data and scripts survive down, so up needs no rebuild.
# An earbud only reaches this once the 34.212 gateway routes its serial here (see README).
set -euo pipefail
cd /srv/qaa-trial/exp

case "${1:-status}" in
  up)
    sudo docker image inspect qaa:gpt-live-1-exp >/dev/null 2>&1 || ./run-exp.sh build
    # exp.env is re-seeded from trial.env when missing; the two tuning keys are not in it.
    ./run-exp.sh env-set GPT_LIVE_1_IDLE_CLOSE_MS 30000
    ./run-exp.sh env-set GPT_LIVE_1_DROP_SPONTANEOUS_SPEECH 1
    ./run-exp.sh start
    gw-entry/gw-entry.sh start exp
    ;;
  down)
    gw-entry/gw-entry.sh stop
    ./run-exp.sh stop
    e2e/e2e.sh clean
    sudo rm -rf exp.env gw-entry/conf/secret.conf gw-entry/conf/route.conf gw-entry/conf/target gw-entry/tls
    echo "experiment shelved; image qaa:gpt-live-1-exp, code, data and scripts kept"
    ;;
  status)
    sudo docker ps -a --filter name='^qaa-exp$' --filter name='^qaa-gw-entry$' --format '{{.Names}} {{.Status}}'
    sudo docker images --format '{{.Repository}}:{{.Tag}} {{.Size}} {{.CreatedSince}}' qaa:gpt-live-1-exp
    ;;
  *) sed -n '2,7p' "$0"; exit 1 ;;
esac

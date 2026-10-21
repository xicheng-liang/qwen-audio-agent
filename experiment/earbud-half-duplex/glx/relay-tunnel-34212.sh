#!/usr/bin/env bash
# 34.212: one new container, sigma-link network only. Reverse-forwards the relay's shim port to EC2 loopback.
# Teardown: docker rm -f glx-relay-tunnel; docker rmi glx-relay-tunnel:1; sudo rm -rf /srv/glx-relay-tunnel
set -euo pipefail
ssh devbox-34 'set -e
D=/srv/glx-relay-tunnel
printf "FROM alpine:3\nRUN apk add --no-cache openssh-client\n" | docker build -q -t glx-relay-tunnel:1 -
docker rm -f glx-relay-tunnel >/dev/null 2>&1 || true
docker run -d --name glx-relay-tunnel --restart unless-stopped --network sigma-link \
  --cap-drop ALL --security-opt no-new-privileges --memory 64m \
  --label trial.owner=xicheng --label trial.purpose=glx-relay-tunnel \
  -v $D:/k:ro glx-relay-tunnel:1 sh -c "while true; do
    ssh -N -i /k/id_ed25519 -o UserKnownHostsFile=/k/known_hosts -o StrictHostKeyChecking=yes \
      -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -R 127.0.0.1:19801:sigma-link-relay:9801 xicheng.liang@10.0.2.151
    echo tunnel exited \$?, retry in 5s; sleep 5; done"
sleep 4; docker ps --filter name=glx-relay-tunnel --format "{{.Names}} {{.Status}}"; docker logs --tail 5 glx-relay-tunnel'

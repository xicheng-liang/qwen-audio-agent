#!/usr/bin/env bash
# Throwaway shim on the EC2 bridge, exactly as a glx container runs it; sends one ACP initialize.
# Usage: glx-shim-probe.sh <tenant>   (proof computed on the box, never printed)
set -euo pipefail
T=${1:?tenant}
ssh -i "$HOME/.ssh/xicheng.liang.pem" xicheng.liang@10.2.2.151 "set -e
G=/srv/qaa-trial/glx
P=\$(python3 -c 'import hmac,hashlib,sys; print(hmac.new(open(sys.argv[1]).read().strip().encode(), sys.argv[2].encode(), hashlib.sha256).hexdigest())' \$G/conf/relay-shim.secret $T)
printf '%s\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1,\"clientCapabilities\":{}}}' \
 | sudo docker run --rm -i --entrypoint node \
     -e SIGMA_RELAY_URL=ws://172.17.0.1:19801 -e SIGMA_TENANT_ID=$T -e SIGMA_TENANT_PROOF=\$P \
     -v \$G/sigma/sigma-shim:/opt/sigma/sigma-shim:ro -v \$G/sigma/sigma-runner:/opt/sigma/sigma-runner:ro \
     qaa:gpt-live-1-exp -e '
       const { spawn } = require(\"node:child_process\");
       const c = spawn(\"node\", [\"/opt/sigma/sigma-shim/shim.mjs\"], { stdio: [\"pipe\", \"pipe\", \"inherit\"] });
       process.stdin.pipe(c.stdin, { end: false });
       c.stdout.on(\"data\", d => { process.stdout.write(\"STDOUT \" + String(d).slice(0, 300)); c.kill(); process.exit(0); });
       setTimeout(() => { console.log(\"no reply in 15s\"); c.kill(); process.exit(1); }, 15000);'"

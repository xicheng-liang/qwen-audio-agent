# GPT-Live 1 on the half-duplex earbud (experiment)

| | |
|---|---|
| Status | Shelved. Never merged, never pushed. Retires once the earbud is full duplex; the real path is the upstream full-duplex provider PR. |
| Branch | `exp/gpt-live-1-earbud-wake`, local only, in `~/Agent-Platform/qwen-audio-agent` |
| Commits | `0a660d4d` snapshot of the GPT-Live 1 provider PR (base) · `85b9614e` half-duplex adaptation · the next commit adds this folder |
| EC2 | `/srv/qaa-trial/exp/` on the qaa EC2 box (`10.2.2.151` from the Mac VPN, `10.0.2.151` from 34.212) |

## 1. What runs where

```
earbud ── 34.212 device gateway (live-agent-api, dokploy)
            │  static route for one serial, wss :4210
            ▼
          EC2 qaa-gw-entry (nginx, TLS; only 34.212; checks X-Qaa-Proxy; adds the column's Bearer)
            ├─ exp  → qaa-exp       :3125  image qaa:gpt-live-1-exp (this branch)
            ├─ qwen → qaa-cmp-qwen  :3122  compare-page column
            └─ hf   → qaa-cmp-hf    :3123  compare-page column
```

Every other earbud keeps its normal allocator tenant: a static `serial:` route is checked before the allocator and bypasses it.

## 2. Bring it back

1. On EC2: `cd /srv/qaa-trial/exp && ./exp.sh up`. The image is kept, so this takes about 10 s. It rebuilds only if the image is gone (section 4).
2. In dokploy, set these on the 34.212 live-agent-api, then redeploy. Every earbud reconnects, about 15 s.
   ```
   QWEN_AUDIO_AGENT_WS_ROUTES={"serial:<full serial>":"wss://10.0.2.151:4210/api/realtime"}
   QAA_TLS_VERIFY=false
   ```
3. Check: the gateway logs `qwen_engine.route_applied` with `source=static` and `host=10.0.2.151:4210`, and `gw-entry/gw-entry.sh logs` shows `101`.

To compare providers on the same earbud, run `gw-entry/gw-entry.sh switch qwen|hf|exp`. The earbud reconnects once. The qwen and hf columns share one voice slot with compare-page browsers.

## 3. Shelve again

1. In dokploy, set `QWEN_AUDIO_AGENT_WS_ROUTES={}` and `QAA_TLS_VERIFY=true`, then redeploy.
2. On EC2: `./exp.sh down`. This stops both containers and deletes this experiment's secret copies (`exp.env`, the entry's conf and its TLS copy) and the e2e gateway image. The image `qaa:gpt-live-1-exp`, the code tarball, the data and the scripts stay.

## 4. Rebuild from the branch

Only needed if the image is gone.

```
git -C ~/Agent-Platform/qwen-audio-agent archive --format=tar.gz -o gl1-exp-tree.tgz exp/gpt-live-1-earbud-wake
scp gl1-exp-tree.tgz <ec2>:/srv/qaa-trial/exp/
./run-exp.sh build          # Dockerfile from ec2/ops (snapshot)
```

`exp.env` is seeded from `/srv/qaa-trial/trial.env`, which holds the GPT-Live key. If that file is gone, create `exp.env` by hand with mode 600, `PORT=3125` and `HOST=127.0.0.1`.

To read the code again, run `git -C ~/Agent-Platform/qwen-audio-agent worktree add ../qaa-gpt-live-1-exp exp/gpt-live-1-earbud-wake`. `git diff 0a660d4d 85b9614e` shows only the half-duplex adaptation.

## 5. Test harness (no earbud needed)

The harness runs the real gateway (origin/main) with a push-to-talk earbud simulator, on EC2.

```
e2e/e2e.sh build                      # gateway image from origin/main
e2e/e2e.sh up 3125                    # 3122 qwen · 3123 hf
QUIET=12 e2e/e2e.sh turns 2 q1 q2     # q1..q4 in e2e/wav
e2e/e2e.sh down                       # frees the column's voice slot; run it before a real earbud test
```

## 6. Known limits

- A tool chain longer than 8 s with no filler speech ends the turn with -503. This is the same gateway budget qwen has.
- One reminder can yield two 2002 notifications.
- qaa-exp has no backend agent, so it cannot run coding tasks.
- The due-reminder re-announce fix (`confirmsTaskNotificationOnPlaybackStart`) is a qaa v2 bug that also affects qwen. The real v2 sync must handle it.

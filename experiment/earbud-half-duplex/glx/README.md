# GPT-Live earbud trial for several people (glx)

Short-lived experiment. Colleagues pick the `gpt_live` route in the allocator console and their earbud
lands on a half-duplex GPT-Live qaa container on the EC2 box. Front end only, no backend agent.
Nothing here is merged; restoring puts every system back to its state before the trial.

## 1. How it fits together

```
earbud ──► 34.212 device gateway ──/resolve──► allocator (branch exp/gpt-live-route-host)
                 │                                  │ route gpt_live: SIGMA_ROUTE_HOST=10.0.2.151
                 │  ws://10.0.2.151:80/t/<tenant>/api/realtime
                 ▼                                  │ POST /t/<tenant>/warm | drop
      EC2 qaa-glx-entry (nginx :80) ◄───────────────┘
                 │ auth_request
                 ▼
      qaa-glx-doorman (127.0.0.1:4299) ──docker──► qaa-glx-<tenant> (qaa:gpt-live-1-exp, :3130-3134)
```

- **Allocator.** The allocator answers `/resolve` with the EC2 URL for a tenant whose *running container* was built on a route carrying `SIGMA_ROUTE_HOST`.
  - A start on that route warms the EC2 container.
  - A switch away drops it, which makes the gateway re-resolve.
  - Routes without the key are unchanged.
- **Allocator switches.**
  - Mid-switch, the running container's route label decides the answer. Outside a switch, the tenant's row decides.
  - The drop is tried up to three times, goes out before the switch commits, and is also sent when a switch is settled after an allocator restart and when a tenant is removed.
- **Doorman.** It starts one container per tenant on first use, allows at most 5 at a time, and removes a container after 30 minutes with no connection.
  - "Full" answers 503, never 401 or 403, which the gateway would read as its own identity being refused.
  - It answers only requests that carry the entry's key.
- **Tenant containers.** They run on the docker bridge, published on 127.0.0.1 only, and each has its own access token. qaa therefore sees a non-loopback peer and enforces the token, so other processes on the box cannot reach a tenant's session.
- **Entry.** It accepts connections from 34.212 and from this box only, and the `X-Qaa-Proxy` header must match. It injects the tenant's token and strips the cookie.

## 2. Files

| File | What it is |
|---|---|
| `glx.sh` | `up`, `down`, `status`, `list`, `warm`, `drop`, `check`, `logs` |
| `doorman.py` | Container lifecycle (Python stdlib, docker socket) |
| `nginx.conf` | Entry on 10.0.2.151:80 |
| `ws-check.mjs` | Connects through the entry the way the gateway does and reports `voice.ready` |

On EC2 the directory is `/srv/qaa-trial/glx/`. `glx.env` is seeded from `/srv/qaa-trial/trial.env` plus the five experiment tuning keys. Secret copies are 600 files and are never printed.

## 3. Bring-up runbook

Record each "before" value first; the restore needs it.

1. **EC2.** Run `./glx.sh up`, then check with `./glx.sh warm <tenant>`, `./glx.sh check <tenant>` and `./glx.sh drop <tenant>`.
   - To run a real gateway through the entry:
     ```
     QAA_URL=ws://10.0.2.151:80/t/<tenant>/api/realtime QAA_ENV_FILE=conf/e2e.env \
       QAA_CONTAINER=qaa-glx-<tenant> ../exp/e2e/e2e.sh up 0
     ```
     Then run `turns` with the same variables.
2. **34.212 allocator.** Build the branch image and swap it in:
   - `git archive exp/gpt-live-route-host allocator ops/qaa-instance/ASSISTANT.md`, then build with `docker build -f allocator/Dockerfile -t sigma-link/allocator:gpt-live-exp .`
   - Tag the current image: `sigma-link/allocator:latest` → `:pre-gpt-live-exp`. It is the same image as `:route-console`.
   - Tag `:gpt-live-exp` → `:latest`, then recreate only the allocator from the dokploy compose dir: `up -d --no-deps --no-build --force-recreate allocator`.
3. **Route.** Inside the allocator container, using the admin key, which never leaves the container:
   ```
   PUT /routes/gpt_live {"title": "GPT-Live trial (EC2)", "env": {"SIGMA_ROUTE_HOST": "10.0.2.151"}}
   ```
4. **dokploy gateway env.** Change three values, then Redeploy. All earbuds reconnect once, for about 15 s.
   - `DEVICE_WS_QWEN_ROUTE_ALLOWED_HOSTS=sigma-link-tenant-nginx:80,10.0.2.151:80`
   - `QWEN_AUDIO_AGENT_WS_ROUTES={}`
   - `QAA_TLS_VERIFY=true`
5. **Switch a person.** Record the tenant's current route from `GET /instances`, then choose `gpt_live` in the console. Expect the gateway log line `qwen_engine.route_applied host=10.0.2.151:80`.

## 4. Restore runbook

Do this in reverse order.

1. Switch every trial tenant back to the route recorded in step 5. The allocator drops them on EC2.
   - Wait until no row is `switching`, then confirm that `./glx.sh list` shows no connections.
   - If a connection is left over, run `./glx.sh drop <tenant>`.
2. `DELETE /routes/gpt_live`.
3. Tag `sigma-link/allocator:route-console` → `:latest` and recreate the allocator the same way as in step 2.
4. In dokploy, set `DEVICE_WS_QWEN_ROUTE_ALLOWED_HOSTS=sigma-link-tenant-nginx:80`, then Redeploy.
5. On EC2, run `./glx.sh down` and then `rm -rf /srv/qaa-trial/glx`. `down` removes every container, the secret copies, the tenant data and the Python image if `up` pulled it.
6. For the older single-container experiment, run `/srv/qaa-trial/exp/exp.sh down`.

## 5. Known limits

- Each colleague gets a fresh qaa: the tenant's memory and history stay on 34.212, and there is no coding-agent backend.
- The experiment's known issues remain:
  - audio gaps mid-sentence, because the output streams at 1× real time;
  - slow delegation;
  - a stale gateway session can fight over the voice lease (VAI-311).
- An admin stop does not drop the EC2 container. The device's next resolve starts the tenant again anyway. Remove does drop it.
- The 34.212 → EC2 hop is plain ws/http inside the VPC, the same scheme and port as the local tenant path, so the gateway marker crosses the VPC unencrypted.
- Whoever holds the allocator admin key decides where `SIGMA_ROUTE_HOST` points, and the allocator sends the gateway marker there. That key already controls every route's env.
- A device that reconnects in the few seconds while its tenant is switching onto `gpt_live`, and uses a gateway cache entry from before the switch, may stay on the local container until its next reconnect.

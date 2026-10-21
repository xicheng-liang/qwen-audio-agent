"""Doorman for the GPT-Live earbud trial: one qaa container per tenant on this box, started on
first use and removed after GLX_IDLE_S without a connection. Listens on 127.0.0.1 only and
answers only requests carrying the entry's key. The entry nginx asks /ensure before it proxies a
tenant's socket and forwards /warm and /drop to it.

Tenant containers run on the docker bridge, published on 127.0.0.1 only, each with its own access
token: qaa then sees a non-loopback peer and enforces that token, so another process on this box
cannot talk to a tenant's session.

Backend line (on when conf/relay-shim.secret exists): each container's ACP slot runs the Sigma shim
with the env the 34.212 allocator gives a tenant, so tasks reach the runner on the user's own machine.
The 34.212 relay's shim port arrives on this box's loopback through a reverse ssh tunnel; this
process forwards it from the docker bridge gateway, where the containers can reach it."""
from __future__ import annotations

import contextlib
import hashlib
import hmac
import http.client
import http.server
import json
import os
import re
import secrets
import shutil
import socket
import threading
import time
import urllib.parse

IMAGE = os.environ.get("GLX_IMAGE", "qaa:gpt-live-1-exp")
ROOT = "/glx"                                             # /srv/qaa-trial/glx, mounted
# the same dir as the docker daemon sees it (bind sources)
HOST_ROOT = os.environ.get("GLX_HOST_ROOT", "/srv/qaa-trial/glx")
PORT_LO, PORT_HI = (int(p) for p in os.environ.get("GLX_PORTS", "3130-3164").split("-"))
MAX_TENANTS = int(os.environ.get("GLX_MAX", "35"))
IDLE_S = float(os.environ.get("GLX_IDLE_S", "1800"))
SWEEP_S = float(os.environ.get("GLX_SWEEP_S", "60"))
READY_S = float(os.environ.get("GLX_READY_S", "20"))
LISTEN = ("127.0.0.1", int(os.environ.get("GLX_LISTEN_PORT", "4299")))
KEY_FILE = f"{ROOT}/conf/doorman.key"
TOKENS = f"{ROOT}/tokens"
CONTAINER_PORT = 3000
MEMORY_BYTES = 1024 * 1024 * 1024
QAA_UID = 10001
NAME_PREFIX = "qaa-glx-"
LABEL = "glx.tenant"
TENANT_RE = re.compile(r"^[0-9a-f]{12}$")
SOCKET_URI_RE = re.compile(r"^/t/([0-9a-f]{12})/api/realtime(?:\?.*)?$")
ACTION_RE = re.compile(r"^/(warm|drop)/([0-9a-f]{12})$")
# glx.env keys every tenant gets its own value for
PER_TENANT = ("PORT", "HOST", "QWEN_AUDIO_GATEWAY_ACCESS_TOKEN")
TCP_ESTABLISHED, TCP_LISTEN = "01", "0A"
# backend line: shim files copied from a 34.212 tenant container, the relay reached via the tunnel
SHIM_SECRET_FILE = f"{ROOT}/conf/relay-shim.secret"
SHIM_DIR = f"{HOST_ROOT}/sigma"
# 19801, not 9801: a dev identity mock already holds 127.0.0.1:9801 on this box
RELAY_FWD_LISTEN = (os.environ.get("GLX_RELAY_FWD_HOST", "172.17.0.1"), 19801)
RELAY_FWD_TARGET = ("127.0.0.1", 19801)
SHIM_FORWARD_ENV = "SIGMA_RELAY_URL,SIGMA_TENANT_ID,SIGMA_TENANT_PROOF,SIGMA_SHIM_READY_TIMEOUT_MS"
BACKEND_KEYS = ("AGENT_PROTOCOL", "ACP_COMMAND", "ACP_ARGS", "ACP_LABEL", "CLAUDE_CODE_EXECUTABLE",
                "SIGMA_RELAY_URL", "SIGMA_TENANT_ID", "SIGMA_TENANT_PROOF",
                "QWEN_AUDIO_AGENT_ACP_FORWARD_ENV")


def log(event: str, **fields: object) -> None:
    print(json.dumps({"ts": round(time.time(), 3), "event": event, **fields},
                     separators=(",", ":")), flush=True)


class Docker:
    """Docker Engine API over the unix socket."""

    def __init__(self, path: str = "/var/run/docker.sock") -> None:
        self.path = path

    def call(self, method: str, url: str, body: object = None,
             timeout_s: float = 30.0) -> tuple[int, object]:
        conn = http.client.HTTPConnection("docker", timeout=timeout_s)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout_s)
        sock.connect(self.path)
        conn.sock = sock
        payload = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        try:
            conn.request(method, url, body=payload, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
        finally:
            conn.close()
        try:
            return resp.status, json.loads(data) if data else None
        except ValueError:
            return resp.status, data.decode(errors="replace")[:200]


def tcp_counts(ports: set[int]) -> tuple[dict[int, int], set[int]]:
    """Established connections per local port, and which ports have a listener (host netns)."""
    established = {p: 0 for p in ports}
    listening: set[int] = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table, encoding="ascii") as fh:
                rows = fh.read().splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            cols = row.split()
            if len(cols) < 4:
                continue
            port = int(cols[1].rsplit(":", 1)[1], 16)
            if cols[3] == TCP_LISTEN:
                listening.add(port)
            elif cols[3] == TCP_ESTABLISHED and port in established:
                established[port] += 1
    return established, listening


def healthy(port: int, token: str, deadline: float) -> bool:
    while time.monotonic() < deadline:
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1.0)
            conn.request("GET", "/api/health", headers={"Authorization": f"Bearer {token}"})
            status = conn.getresponse().status
            conn.close()
            if status == 200:
                return True
        except OSError:
            pass
        time.sleep(0.2)
    return False


def shim_secret() -> str:
    try:
        with open(SHIM_SECRET_FILE, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def backend_env(tenant: str, secret: str) -> list[str]:
    """allocator runtime.backend_env: shim → relay → the runner this tenant's account holds."""
    proof = hmac.new(secret.encode(), tenant.encode(), hashlib.sha256).hexdigest()
    return ["AGENT_PROTOCOL=acp", "ACP_COMMAND=node",
            'ACP_ARGS=["/opt/sigma/sigma-shim/shim.mjs"]', "ACP_LABEL=OpenAgent",
            f"SIGMA_RELAY_URL=ws://{RELAY_FWD_LISTEN[0]}:{RELAY_FWD_LISTEN[1]}",
            f"SIGMA_TENANT_ID={tenant}", f"SIGMA_TENANT_PROOF={proof}",
            f"QWEN_AUDIO_AGENT_ACP_FORWARD_ENV={SHIM_FORWARD_ENV}"]


def tenant_env(tenant: str, token: str, secret: str) -> list[str]:
    """glx.env as docker --env-file reads it (KEY=VALUE, literal), with this tenant's own values."""
    skip = PER_TENANT + (BACKEND_KEYS if secret else ())
    env: list[str] = []
    with open(f"{ROOT}/glx.env", encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\r\n")
            if not line or line.lstrip().startswith("#") or "=" not in line:
                continue
            if line.split("=", 1)[0].strip() in skip:
                continue
            env.append(line)
    env += ["HOST=0.0.0.0", f"PORT={CONTAINER_PORT}", f"QWEN_AUDIO_GATEWAY_ACCESS_TOKEN={token}"]
    return env + (backend_env(tenant, secret) if secret else [])


def _pipe(src: socket.socket, dst: socket.socket) -> None:
    with contextlib.suppress(OSError):
        while chunk := src.recv(65536):
            dst.sendall(chunk)
    for s in (src, dst):
        with contextlib.suppress(OSError):
            s.shutdown(socket.SHUT_RDWR)


def relay_forward_forever() -> None:
    """Docker bridge gateway → loopback end of the reverse tunnel to the 34.212 relay's shim port."""
    while True:
        try:
            server = socket.create_server(RELAY_FWD_LISTEN)
            break
        except OSError as exc:                            # bridge not up yet after a reboot
            log("relay_fwd.retry", error=str(exc)[:120])
            time.sleep(5)
    log("relay_fwd.ready", listen=f"{RELAY_FWD_LISTEN[0]}:{RELAY_FWD_LISTEN[1]}")
    while True:
        client, _ = server.accept()
        try:
            upstream = socket.create_connection(RELAY_FWD_TARGET, timeout=5)
            upstream.settimeout(None)
        except OSError as exc:
            log("relay_fwd.no_tunnel", error=str(exc)[:120])
            client.close()
            continue
        for a, b in ((client, upstream), (upstream, client)):
            threading.Thread(target=_pipe, args=(a, b), daemon=True).start()


def read_token(tenant: str) -> str:
    try:
        with open(f"{TOKENS}/{tenant}", encoding="ascii") as fh:
            return fh.read().strip()
    except OSError:
        return ""


class Doorman:
    def __init__(self, docker: Docker) -> None:
        self.docker = docker
        self.lock = threading.Lock()
        self.last_used: dict[str, float] = {}      # tenant → monotonic time last seen in use

    def tenants(self) -> dict[str, dict[str, object]]:
        query = urllib.parse.quote(json.dumps({"label": [LABEL]}))
        status, rows = self.docker.call("GET", f"/containers/json?all=1&filters={query}")
        if status != 200 or not isinstance(rows, list):
            raise RuntimeError(f"docker list: {status}")
        out: dict[str, dict[str, object]] = {}
        for row in rows:
            labels = row.get("Labels") or {}
            tenant = labels.get(LABEL, "")
            if TENANT_RE.match(tenant):
                out[tenant] = {"port": int(labels.get("glx.port") or 0),
                               "state": row.get("State", "")}
        return out

    def _create(self, tenant: str, port: int) -> str:
        data = f"{ROOT}/data/{tenant}"
        shutil.rmtree(data, ignore_errors=True)
        os.makedirs(data, mode=0o700)
        os.chown(data, QAA_UID, QAA_UID)
        token = secrets.token_urlsafe(32)
        fd = os.open(f"{TOKENS}/{tenant}", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as fh:
            fh.write(token)
        exposed = f"{CONTAINER_PORT}/tcp"
        secret = shim_secret()
        binds = [f"{HOST_ROOT}/data/{tenant}:/data"]
        if secret:
            binds += [f"{SHIM_DIR}/sigma-shim:/opt/sigma/sigma-shim:ro",
                      f"{SHIM_DIR}/sigma-runner:/opt/sigma/sigma-runner:ro"]
        spec = {
            "Image": IMAGE,
            "Env": tenant_env(tenant, token, secret),
            "ExposedPorts": {exposed: {}},
            "Labels": {"trial.owner": "xicheng", "trial.purpose": "glx-tenant",
                       LABEL: tenant, "glx.port": str(port)},
            "HostConfig": {"PortBindings": {exposed: [{"HostIp": "127.0.0.1",
                                                       "HostPort": str(port)}]},
                           "Binds": binds,
                           "RestartPolicy": {"Name": "unless-stopped"},
                           "Memory": MEMORY_BYTES},
        }
        status, body = self.docker.call("POST", f"/containers/create?name={NAME_PREFIX}{tenant}",
                                        spec)
        if status != 201:
            raise RuntimeError(f"create: {status} {str(body)[:120]}")
        status, body = self.docker.call("POST", f"/containers/{NAME_PREFIX}{tenant}/start")
        if status not in (204, 304):
            raise RuntimeError(f"start: {status} {str(body)[:120]}")
        return token

    def _remove(self, tenant: str) -> None:
        self.docker.call("DELETE", f"/containers/{NAME_PREFIX}{tenant}?force=1")   # 404 = gone
        shutil.rmtree(f"{ROOT}/data/{tenant}", ignore_errors=True)
        with contextlib.suppress(OSError):
            os.remove(f"{TOKENS}/{tenant}")
        self.last_used.pop(tenant, None)

    def ensure(self, tenant: str) -> tuple[int, int, str, str]:
        """(http status, port, token, reason): 200 once healthy · 503 full or failed to come up.
        Never 401/403: the gateway reads those as its own identity being refused."""
        try:
            with self.lock:
                rows = self.tenants()
                row = rows.get(tenant)
                token = read_token(tenant) if row else ""
                if row and row["state"] == "running" and row["port"] and token:
                    port = int(row["port"])  # type: ignore[arg-type]
                else:
                    if row:                               # exited / half-made: start clean
                        self._remove(tenant)
                        rows.pop(tenant)
                    if len(rows) >= MAX_TENANTS:
                        log("tenant.refused", tenant=tenant, reason="full", running=len(rows))
                        return 503, 0, "", "full"
                    taken = {int(r["port"]) for r in rows.values()}  # type: ignore[arg-type]
                    _, listening = tcp_counts(set())
                    free = [p for p in range(PORT_LO, PORT_HI + 1)
                            if p not in taken and p not in listening]
                    if not free:
                        log("tenant.refused", tenant=tenant, reason="no_port")
                        return 503, 0, "", "no_port"
                    port = free[0]
                    token = self._create(tenant, port)
                    log("tenant.started", tenant=tenant, port=port)
        except Exception as exc:  # noqa: BLE001
            log("tenant.error", tenant=tenant, error=f"{type(exc).__name__}: {str(exc)[:160]}")
            return 503, 0, "", "error"
        if not healthy(port, token, time.monotonic() + READY_S):
            log("tenant.not_healthy", tenant=tenant, port=port)
            with self.lock:
                self._remove(tenant)                      # the next ensure builds a fresh one
            return 503, port, "", "not_healthy"
        with self.lock:
            self.last_used[tenant] = time.monotonic()
        return 200, port, token, ""

    def drop(self, tenant: str) -> None:
        with self.lock:
            self._remove(tenant)
        log("tenant.removed", tenant=tenant, reason="drop")

    def sweep(self) -> None:
        with self.lock:
            rows = self.tenants()
            ports = {int(r["port"]) for r in rows.values()}  # type: ignore[arg-type]
            established, _ = tcp_counts(ports)
            now = time.monotonic()
            for tenant, row in rows.items():
                if established.get(int(row["port"]), 0):  # type: ignore[arg-type]
                    self.last_used[tenant] = now
                    continue
                if now - self.last_used.setdefault(tenant, now) >= IDLE_S:
                    self._remove(tenant)
                    log("tenant.removed", tenant=tenant, reason="idle")

    def listing(self) -> list[dict[str, object]]:
        with self.lock:
            rows = self.tenants()
        established, _ = tcp_counts({int(r["port"]) for r in rows.values()})  # type: ignore[arg-type]
        now = time.monotonic()
        return [{"tenant": t, "port": r["port"], "state": r["state"],
                 "connections": established.get(int(r["port"]), 0),  # type: ignore[arg-type]
                 "idle_s": round(now - self.last_used.get(t, now))}
                for t, r in sorted(rows.items())]


def load_key() -> str:
    try:
        with open(KEY_FILE, encoding="ascii") as fh:
            return fh.read().strip()
    except OSError:
        return ""


DOORMAN = Doorman(Docker())
KEY = load_key()


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "glx-doorman"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass                                                     # our own log lines only

    def _reply(self, status: int, body: object = None, headers: dict[str, str] | None = None,
               ) -> None:
        payload = json.dumps(body if body is not None else {}).encode()
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authorized(self) -> bool:
        given = self.headers.get("X-Glx-Doorman", "")
        return bool(KEY) and hmac.compare_digest(given.encode(), KEY.encode())

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/healthz":
            self._reply(200, {"ok": True, "keyed": bool(KEY)})
            return
        if not self._authorized():
            self._reply(401)
            return
        if path == "/ensure":
            match = SOCKET_URI_RE.match(self.headers.get("X-Original-URI", ""))
            if not match:
                self._reply(404, {"reason": "bad_uri"})
                return
            status, port, token, reason = DOORMAN.ensure(match.group(1))
            if status == 200:
                self._reply(200, {}, {"X-Glx-Port": str(port), "X-Glx-Bearer": f"Bearer {token}"})
            else:
                self._reply(status, {"reason": reason})
        elif path == "/list":
            self._reply(200, DOORMAN.listing())
        else:
            self._reply(404)

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            self._reply(401)
            return
        match = ACTION_RE.match(urllib.parse.urlsplit(self.path).path)
        if not match:
            self._reply(404)
            return
        action, tenant = match.groups()
        if action == "warm":
            status, _, _, reason = DOORMAN.ensure(tenant)
            self._reply(status, {"reason": reason} if reason else {})
        else:
            DOORMAN.drop(tenant)
            self._reply(200)


def sweep_forever() -> None:
    while True:
        time.sleep(SWEEP_S)
        try:
            DOORMAN.sweep()
        except Exception as exc:  # noqa: BLE001
            log("sweep.error", error=f"{type(exc).__name__}: {str(exc)[:160]}")


def main() -> None:
    os.makedirs(TOKENS, mode=0o700, exist_ok=True)
    threading.Thread(target=sweep_forever, name="sweep", daemon=True).start()
    if shim_secret():
        threading.Thread(target=relay_forward_forever, name="relay-fwd", daemon=True).start()
    server = http.server.ThreadingHTTPServer(LISTEN, Handler)
    server.daemon_threads = True
    log("doorman.ready", listen=f"{LISTEN[0]}:{LISTEN[1]}", image=IMAGE, max=MAX_TENANTS,
        idle_s=IDLE_S, ports=f"{PORT_LO}-{PORT_HI}", keyed=bool(KEY), backend=bool(shim_secret()))
    server.serve_forever()


if __name__ == "__main__":
    main()

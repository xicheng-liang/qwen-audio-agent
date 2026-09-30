"""Doorman for the GPT-Live earbud trial: one qaa container per tenant on this box, started on
first use and removed after GLX_IDLE_S without a connection. Listens on 127.0.0.1 only. The entry
nginx asks /ensure before it proxies a tenant's socket and forwards /warm and /drop to it."""
from __future__ import annotations

import http.client
import http.server
import json
import os
import re
import shutil
import socket
import threading
import time
import urllib.parse

IMAGE = os.environ.get("GLX_IMAGE", "qaa:gpt-live-1-exp")
ROOT = "/glx"                                             # /srv/qaa-trial/glx, mounted
# the same dir as the docker daemon sees it (bind sources)
HOST_ROOT = os.environ.get("GLX_HOST_ROOT", "/srv/qaa-trial/glx")
PORT_LO, PORT_HI = (int(p) for p in os.environ.get("GLX_PORTS", "3130-3134").split("-"))
MAX_TENANTS = int(os.environ.get("GLX_MAX", "5"))
IDLE_S = float(os.environ.get("GLX_IDLE_S", "1800"))
SWEEP_S = float(os.environ.get("GLX_SWEEP_S", "60"))
READY_S = float(os.environ.get("GLX_READY_S", "20"))
LISTEN = ("127.0.0.1", int(os.environ.get("GLX_LISTEN_PORT", "4299")))
MEMORY_BYTES = 1024 * 1024 * 1024
QAA_UID = 10001
NAME_PREFIX = "qaa-glx-"
LABEL = "glx.tenant"
TENANT_RE = re.compile(r"^[0-9a-f]{12}$")
SOCKET_URI_RE = re.compile(r"^/t/([0-9a-f]{12})/api/realtime(?:\?.*)?$")
ACTION_RE = re.compile(r"^/(warm|drop)/([0-9a-f]{12})$")
TCP_ESTABLISHED, TCP_LISTEN = "01", "0A"


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


def healthy(port: int, deadline: float) -> bool:
    while time.monotonic() < deadline:
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1.0)
            conn.request("GET", "/api/health")
            status = conn.getresponse().status
            conn.close()
            if status == 200:
                return True
        except OSError:
            pass
        time.sleep(0.2)
    return False


def tenant_env(port: int) -> list[str]:
    """glx.env as docker --env-file reads it (KEY=VALUE, literal), with this tenant's port."""
    env: list[str] = []
    with open(f"{ROOT}/glx.env", encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\r\n")
            if not line or line.lstrip().startswith("#") or "=" not in line:
                continue
            if line.split("=", 1)[0].strip() == "PORT":
                continue
            env.append(line)
    env.append(f"PORT={port}")
    return env


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

    def _create(self, tenant: str, port: int) -> None:
        data = f"{ROOT}/data/{tenant}"
        shutil.rmtree(data, ignore_errors=True)
        os.makedirs(data, mode=0o700)
        os.chown(data, QAA_UID, QAA_UID)
        spec = {
            "Image": IMAGE,
            "Env": tenant_env(port),
            "Labels": {"trial.owner": "xicheng", "trial.purpose": "glx-tenant",
                       LABEL: tenant, "glx.port": str(port)},
            "HostConfig": {"NetworkMode": "host",
                           "Binds": [f"{HOST_ROOT}/data/{tenant}:/data"],
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

    def _remove(self, tenant: str) -> None:
        self.docker.call("DELETE", f"/containers/{NAME_PREFIX}{tenant}?force=1")   # 404 = gone
        shutil.rmtree(f"{ROOT}/data/{tenant}", ignore_errors=True)
        self.last_used.pop(tenant, None)

    def ensure(self, tenant: str) -> tuple[int, int, str]:
        """(http status, port, reason): 200 once healthy · 403 full · 503 failed to come up."""
        try:
            with self.lock:
                rows = self.tenants()
                row = rows.get(tenant)
                if row and row["state"] == "running" and row["port"]:
                    port = int(row["port"])  # type: ignore[arg-type]
                else:
                    if row:                               # exited / half-made: start clean
                        self._remove(tenant)
                        rows.pop(tenant)
                    if len(rows) >= MAX_TENANTS:
                        log("tenant.refused", tenant=tenant, reason="full", running=len(rows))
                        return 403, 0, "full"
                    taken = {int(r["port"]) for r in rows.values()}  # type: ignore[arg-type]
                    _, listening = tcp_counts(set())
                    free = [p for p in range(PORT_LO, PORT_HI + 1)
                            if p not in taken and p not in listening]
                    if not free:
                        log("tenant.refused", tenant=tenant, reason="no_port")
                        return 403, 0, "no_port"
                    port = free[0]
                    self._create(tenant, port)
                    log("tenant.started", tenant=tenant, port=port)
                self.last_used[tenant] = time.monotonic()
        except Exception as exc:  # noqa: BLE001
            log("tenant.error", tenant=tenant, error=f"{type(exc).__name__}: {str(exc)[:160]}")
            return 503, 0, "error"
        if not healthy(port, time.monotonic() + READY_S):
            log("tenant.not_healthy", tenant=tenant, port=port)
            return 503, port, "not_healthy"
        return 200, port, ""

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


DOORMAN = Doorman(Docker())


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "glx-doorman"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass                                                     # our own log lines only

    def _reply(self, status: int, body: object = None, port: int = 0) -> None:
        payload = json.dumps(body if body is not None else {}).encode()
        self.send_response(status)
        if port:
            self.send_header("X-Glx-Port", str(port))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/ensure":
            match = SOCKET_URI_RE.match(self.headers.get("X-Original-URI", ""))
            if not match:
                self._reply(403, {"reason": "bad_uri"})
                return
            status, port, reason = DOORMAN.ensure(match.group(1))
            self._reply(status, {"reason": reason} if reason else {}, port if status == 200 else 0)
        elif path == "/healthz":
            self._reply(200, {"ok": True})
        elif path == "/list":
            self._reply(200, DOORMAN.listing())
        else:
            self._reply(404)

    def do_POST(self) -> None:  # noqa: N802
        match = ACTION_RE.match(urllib.parse.urlsplit(self.path).path)
        if not match:
            self._reply(404)
            return
        action, tenant = match.groups()
        if action == "warm":
            status, _, reason = DOORMAN.ensure(tenant)
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
    threading.Thread(target=sweep_forever, name="sweep", daemon=True).start()
    server = http.server.ThreadingHTTPServer(LISTEN, Handler)
    server.daemon_threads = True
    log("doorman.ready", listen=f"{LISTEN[0]}:{LISTEN[1]}", image=IMAGE, max=MAX_TENANTS,
        idle_s=IDLE_S, ports=f"{PORT_LO}-{PORT_HI}")
    server.serve_forever()


if __name__ == "__main__":
    main()

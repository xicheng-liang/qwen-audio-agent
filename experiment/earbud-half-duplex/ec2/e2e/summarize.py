#!/usr/bin/env python3
"""Per-turn report for one e2e run directory.

sim.log     device view (E2E_TURN json lines from e2e_sim.py)
gateway.log gateway records (already redacted, one line per record)
qaa.log     qaa gateway lines (already redacted)

Log lines are attributed to a turn by time: [PTT down of turn k, PTT down of turn k+1).
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
from pathlib import Path

run = Path(sys.argv[1])
turns = [json.loads(l.split(" ", 1)[1]) for l in (run / "sim.log").read_text().splitlines()
         if l.startswith("E2E_TURN ")]
gw_lines = (run / "gateway.log").read_text().splitlines() if (run / "gateway.log").exists() else []
qaa_lines = (run / "qaa.log").read_text().splitlines() if (run / "qaa.log").exists() else []
qaa_name = (run / "qaa_container").read_text().strip() if (run / "qaa_container").exists() else "qaa"


def ts(s: str) -> float:
    s = s.replace("Z", "").replace(" ", "T")
    return dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc).timestamp()


def hms(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%H:%M:%S.%f")[:-3]


GW_RE = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) \| (\S+)\s*\| (\S+) \| (.*)$")
QAA_RE = re.compile(r"^(\S+Z) (\S+) \S+ (\S+) ?(\{.*\})?\s*$")
GW_KEEP = re.compile(
    r"device_gateway\.(turn\.|notify_|first_audio|closed|connected)|voice_latency|qwen_engine\.|"
    r"device_gateway\.text")
GW_SKIP = re.compile(r"qwen_engine\.(teardown)")
QAA_DROP_FIELDS = {"subsystem", "ownerId", "sessionId", "provider"}

gw = []
for line in gw_lines:
    m = GW_RE.match(line)
    if not m:
        continue
    t, level, name, msg = m.groups()
    if GW_KEEP.search(msg) or level in ("WARNING", "ERROR"):
        gw.append((ts(t), level, msg))

qaa = []
for line in qaa_lines:
    m = QAA_RE.match(line)
    if not m:
        continue
    t, level, event, body = m.groups()
    fields = {}
    if body:
        try:
            fields = json.loads(body)
        except ValueError:
            fields = {"raw": body[:200]}
    qaa.append((ts(t), level, event, fields))

bounds = [ts(t["ptt_down_at"]) for t in turns] + [float("inf")]
latency = {}
for _, _, msg in gw:
    if msg.startswith("voice_latency "):
        try:
            rec = json.loads(msg.split(" ", 1)[1])
            latency[rec.get("turn_id")] = rec
        except ValueError:
            pass


def short(v) -> str:
    s = str(v)
    return s if len(s) <= 22 else s[:22] + "…"


def qaa_fmt(event: str, f: dict) -> str:
    keep = {k: v for k, v in f.items() if k not in QAA_DROP_FIELDS}
    order = ["origin", "responseId", "turnId", "requestId", "status", "hasAudio", "accepted",
             "suppressed", "reason", "waitMs", "durationMs", "clientType", "closeCode", "error"]
    parts = [f"{k}={short(keep.pop(k))}" for k in order if k in keep]
    parts += [f"{k}={short(v)}" for k, v in keep.items()]
    return f"{event} " + " ".join(parts)


print(f"run {run.name}   qaa={qaa_name}")
rows = []
for i, t in enumerate(turns):
    lo, hi = bounds[i], bounds[i + 1]
    tid = t["turn"]
    lat = latency.get(tid, {})
    transcript = next((m.split("text=", 1)[1] for tt, _, m in gw
                       if lo <= tt < hi and m.startswith(f"device_gateway.turn.transcript turn_id={tid} ")), "")
    reply = next((m.split("reply=", 1)[1] for tt, _, m in gw
                  if lo <= tt < hi and m.startswith(f"device_gateway.turn.done turn_id={tid} ")), "")
    outcome = "ok" if t["outcome"] == "ok" else (
        f"{(t['error'] or {}).get('status')} {(t['error'] or {}).get('reason')}")
    late = t.get("late_audio_bytes", 0)
    print(f"\n=== turn {tid} ({t['wav']})  ASR: {transcript or '-'}")
    print(f"  device : outcome={outcome}  first_audio={t['first_audio_s']}s  "
          f"LIVE={t['live_bytes']}B ({t['live_s']}s)  after-end tts_audio={late}B  "
          f"2002 announced={len(t['announced'])} pulled={t.get('notify_bytes', 0)}B ({t.get('notify_s', 0)}s)")
    for p in t["pulls"]:
        print(f"           2002 msg_id={p['msg_id']} announced {p['announced_at'][11:23]} "
              f"({p['announced_phase']}) -> {p['bytes']}B ({p['seconds']}s) rejected={p['rejected']}")
    for k, b in t["late_audio"].items():
        print(f"           late tts_audio turn_id={k}: {b['bytes']}B {b['first_at'][11:23]}..{b['last_at'][11:23]}")
    if lat:
        keys = ["result", "reason", "e2e_ms", "tts_first_audio_ms", "llm_first_tkn_ms", "qwen_pcm_bytes",
                "qwen_opus_bytes", "qwen_notifies", "qwen_tool_followups", "qwen_dropped_deltas",
                "qwen_provider", "qwen_out_rate"]
        print("  gateway: " + " ".join(f"{k}={lat[k]}" for k in keys if k in lat))
    if reply:
        print(f"  live caption: {reply}")
    print("  gateway log:")
    for tt, level, msg in gw:
        if lo <= tt < hi and not msg.startswith("voice_latency ") and not GW_SKIP.search(msg):
            print(f"    {hms(tt)} {msg[:260]}")
    print(f"  {qaa_name} log:")
    for tt, level, event, f in qaa:
        if lo <= tt < hi:
            print(f"    {hms(tt)} {qaa_fmt(event, f)[:260]}")
    rows.append((tid, t["wav"], outcome, t["first_audio_s"], t["live_bytes"], t["live_s"], late,
                 t.get("notify_bytes", 0), t.get("notify_s", 0)))

print("\nturn  wav      outcome                         first_audio  LIVE B (s)       after-end B  2002 B (s)")
for r in rows:
    print(f"{r[0]:<5} {r[1]:<8} {str(r[2])[:31]:<31} {str(r[3]):<12} {r[4]:>7} ({r[5]:>5})   {r[6]:>9}   {r[7]:>7} ({r[8]})")

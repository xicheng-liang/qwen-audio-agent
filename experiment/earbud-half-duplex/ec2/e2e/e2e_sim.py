#!/usr/bin/env python3
"""Half-duplex push-to-talk earbud simulator for the device gateway, instrumented.

Runs inside the gateway image (needs /app/tools/device_sim/{wire,device_sim}.py,
opuslib_next, websockets). Same wire behaviour as tools/device_sim/device_sim.py:
connect -> device_info; per turn audio_start + audio_chunk @100 ms + audio_end,
1 s idle acks while waiting, 10 s downlink watchdog. On top of that it records
what device_sim.py does not:

  * LIVE audio: tts_audio frames of the open turn until is_final / error;
  * LATE audio: any tts_audio frame after the turn ended (the earbud has already
    stopped playing, so this is audio nobody hears);
  * 2002: device_notify.available announced during/after the turn, pulled once
    the link is idle (the real earbud shows it as unread and plays it on tap);
  * UTC wall-clock stamps to line up with gateway and qaa logs.

Output: human lines plus one "E2E_TURN {json}" per turn and "E2E_SUMMARY {json}".
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import sys
import time
import wave
from pathlib import Path

sys.path.insert(0, "/app/tools/device_sim")
import websockets  # noqa: E402
from device_sim import load_uplink_audio  # noqa: E402
from wire import CHUNK_PKTS, MSG_AUDIO, MSG_NOTIFY, PKT, decode_frame, encode_frame  # noqa: E402

BYTES_PER_S = PKT * 50  # plaud-opus CBR: 80 B per 20 ms


def utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def secs(nbytes: int) -> float:
    return round(nbytes / BYTES_PER_S, 2)


def save_wav(path: Path, opus: bytes) -> None:
    try:
        import opuslib_next  # noqa: PLC0415
        dec = opuslib_next.Decoder(16000, 1)
        pcm = b"".join(dec.decode(bytes(opus[i:i + PKT]), 960) for i in range(0, len(opus), PKT))
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(pcm)
    except Exception as exc:  # noqa: BLE001
        print(f"[i] could not decode {path.name}: {exc!r}")


class Sim:
    def __init__(self, url: str, serial: str, out: Path, linger_s: float, quiet_s: float):
        self.url, self.serial, self.out = url, serial, out
        self.linger_s, self.quiet_s = linger_s, quiet_s
        self.seq = 0
        self.turn_id = 0
        self.ws = None
        self.t0 = time.monotonic()
        self.pending: list[dict] = []     # announced, not yet pulled
        self.notify_no = 0

    def _next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def rel(self) -> float:
        return round(time.monotonic() - self.t0, 3)

    async def connect(self) -> None:
        self.ws = await websockets.connect(self.url, max_size=16 * 1024 * 1024)
        first = json.loads(await asyncio.wait_for(self.ws.recv(), 10))
        assert first.get("type") == "connected", first
        print(f"[+] {utc()} connected session_id={(first.get('data') or {}).get('session_id')}")
        await self.ws.send(json.dumps({
            "req_id": "di-1", "type": "device_info",
            "data": {"timezone": 8, "serial_number": self.serial,
                     "device_type": "sigma", "device_version": "sim-e2e-0.1"},
        }))
        resp = json.loads(await asyncio.wait_for(self.ws.recv(), 10))
        assert resp.get("type") == "device_info" and resp.get("status") == 0, resp
        print(f"[+] {utc()} device_info acknowledged serial={self.serial}")

    async def _recv(self, timeout: float):
        try:
            return await asyncio.wait_for(self.ws.recv(), timeout=timeout)
        except asyncio.TimeoutError:
            return None

    def _classify(self, raw) -> dict:
        """One received frame -> a small record."""
        if isinstance(raw, bytes):
            msg_type, _seq, meta, payload = decode_frame(raw)
            mtype = meta.get("type")
            d = meta.get("data") or {}
            if mtype == "audio_pipeline.tts_audio":
                return {"k": "tts", "turn_id": d.get("turn_id"), "final": bool(d.get("is_final")),
                        "bytes": len(payload), "payload": payload}
            if msg_type == MSG_NOTIFY and mtype == "tts_notify.audio":
                return {"k": "n2002", "msg_id": d.get("msg_id"), "final": bool(d.get("is_final")),
                        "bytes": len(payload), "payload": payload}
            return {"k": "bin", "type": mtype, "status": meta.get("status")}
        msg = json.loads(raw)
        mtype = msg.get("type")
        d = msg.get("data") or {}
        if mtype == "device_notify.available":
            return {"k": "avail", "msg_id": d.get("msg_id", ""), "notify_id": d.get("notify_id", ""),
                    "notify_type": d.get("notify_type", "")}
        if mtype == "device_notify.recall":
            return {"k": "recall", "notify_id": d.get("notify_id")}
        if mtype == "audio_pipeline.error":
            return {"k": "error", "status": d.get("status"), "reason": d.get("reason"),
                    "turn_id": d.get("turn_id")}
        return {"k": "text", "type": mtype, "status": msg.get("status"), "req_id": msg.get("req_id")}

    def _note_side(self, rec: dict, phase: str, rep: dict) -> None:
        """Frames that are not the open turn's audio."""
        if rec["k"] == "avail":
            rec2 = {"msg_id": rec["msg_id"], "notify_type": rec["notify_type"],
                    "phase": phase, "at": utc(), "t_after_turn_end_s": None}
            self.pending.append(rec2)
            rep["announced"].append(rec2)
            print(f"[~] {rec2['at']} device_notify.available msg_id={rec['msg_id']} "
                  f"type={rec['notify_type']} phase={phase}")
        elif rec["k"] == "recall":
            self.pending = [p for p in self.pending if p.get("notify_id") != rec["notify_id"]]
            print(f"[~] {utc()} device_notify.recall notify_id={rec['notify_id']}")
        elif rec["k"] == "tts":
            bucket = rep["late_audio"].setdefault(str(rec["turn_id"]), {
                "frames": 0, "bytes": 0, "first_at": utc(), "last_at": None, "phase": phase})
            bucket["frames"] += 1
            bucket["bytes"] += rec["bytes"]
            bucket["last_at"] = utc()
        elif rec["k"] == "n2002":
            rep["unsolicited_2002_bytes"] += rec["bytes"]
        elif rec["k"] == "error":
            rep["late_errors"].append({**{k: rec[k] for k in ("status", "reason", "turn_id")},
                                       "at": utc(), "phase": phase})
            print(f"[!] {utc()} late audio_pipeline.error {rec}")

    async def turn(self, audio: bytes, label: str) -> dict:
        self.turn_id += 1
        turn = self.turn_id
        chunk = PKT * CHUNK_PKTS
        chunks = [audio[i:i + chunk] for i in range(0, len(audio), chunk)]
        rep: dict = {"turn": turn, "wav": label, "uplink_s": secs(len(audio)),
                     "ptt_down_at": utc(), "live_bytes": 0, "live_frames": 0, "live_s": 0.0,
                     "first_audio_s": None, "end_s": None, "outcome": None, "error": None,
                     "announced": [], "late_audio": {}, "unsolicited_2002_bytes": 0,
                     "late_errors": [], "pulls": []}
        await self.ws.send(encode_frame(MSG_AUDIO, self._next_seq(), {
            "req_id": f"ai_{self.seq}", "type": "audio_start", "sub_type": "",
            "data": {"turn_id": turn, "codec": "opus", "sample_rate": 16000, "channels": 1,
                     "bit_depth": 16, "frame_duration_ms": 20, "duration_ms": len(chunks[0]) // 4},
        }, chunks[0]))
        for c in chunks[1:]:
            await asyncio.sleep(0.1)
            await self.ws.send(encode_frame(MSG_AUDIO, self._next_seq(), {
                "req_id": f"ai_{self.seq}", "type": "audio_chunk", "sub_type": "",
                "data": {"turn_id": turn, "duration_ms": len(c) // 4},
            }, c))
        record_end_ms = int(time.time() * 1000)
        await self.ws.send(encode_frame(MSG_AUDIO, self._next_seq(), {
            "req_id": f"ai_{self.seq}", "type": "audio_end", "sub_type": "",
            "data": {"turn_id": turn, "reason": "ptt", "duration_ms": 0,
                     "record_end_time_ms": record_end_ms, "send_time_ms": record_end_ms},
        }))
        t_end = time.monotonic()
        rep["ptt_up_at"] = utc()
        print(f"[>] {rep['ptt_up_at']} turn {turn} ({label}): PTT released after "
              f"{rep['uplink_s']}s of speech")

        # ---- open turn: what the earbud plays
        live = bytearray()
        idle = 0
        while True:
            raw = await self._recv(1.0)
            if raw is None:
                idle += 1
                if idle >= 10:
                    rep["outcome"] = "watchdog"
                    rep["error"] = {"reason": "device downlink watchdog (10 s without tts_audio)"}
                    break
                await self.ws.send(encode_frame(MSG_AUDIO, self._next_seq(), {
                    "req_id": f"ai_{self.seq}", "type": "ack", "sub_type": "tts_audio",
                    "data": {"turn_id": turn, "recv_count": rep["live_frames"]},
                }))
                continue
            idle = 0
            rec = self._classify(raw)
            if rec["k"] == "tts" and rec["turn_id"] == turn:
                rep["live_frames"] += 1
                if rec["bytes"]:
                    if rep["first_audio_s"] is None:
                        rep["first_audio_s"] = round(time.monotonic() - t_end, 2)
                        rep["first_audio_at"] = utc()
                        await self.ws.send(encode_frame(MSG_AUDIO, self._next_seq(), {
                            "req_id": f"ai_{self.seq}", "type": "audio_playback_start",
                            "sub_type": "", "data": {
                                "record_end_time_ms": record_end_ms,
                                "tts_receive_time_ms": int(time.time() * 1000),
                                "start_play_time_ms": int(time.time() * 1000)}}))
                    live.extend(rec["payload"])
                if rec["final"]:
                    rep["outcome"] = "ok"
                    break
                continue
            if rec["k"] == "error" and rec.get("turn_id") in (turn, None):
                rep["outcome"] = "error"
                rep["error"] = {"status": rec["status"], "reason": rec["reason"]}
                break
            self._note_side(rec, "in_turn", rep)
        rep["end_s"] = round(time.monotonic() - t_end, 2)
        rep["turn_end_at"] = utc()
        rep["live_bytes"] = len(live)
        rep["live_s"] = secs(len(live))
        print(f"[<] {rep['turn_end_at']} turn {turn} ended: outcome={rep['outcome']} "
              f"err={rep['error']} first_audio={rep['first_audio_s']}s live={rep['live_bytes']}B "
              f"({rep['live_s']}s) end={rep['end_s']}s")
        if live:
            (self.out / f"turn{turn}_live.plaudopus").write_bytes(bytes(live))
            save_wav(self.out / f"turn{turn}_live.wav", bytes(live))

        # ---- idle after the turn: nothing should arrive except 2002 announcements
        t_idle = time.monotonic()
        last_rx = t_idle
        while True:
            now = time.monotonic()
            if now - t_idle >= self.linger_s or now - last_rx >= self.quiet_s:
                break
            raw = await self._recv(min(1.0, self.quiet_s))
            if raw is None:
                continue
            last_rx = time.monotonic()
            rec = self._classify(raw)
            if rec["k"] == "avail":
                self._note_side(rec, "after_turn", rep)
                rep["announced"][-1]["t_after_turn_end_s"] = round(last_rx - t_idle, 2)
            else:
                self._note_side(rec, "after_turn", rep)
        for tid, b in rep["late_audio"].items():
            print(f"[!] late tts_audio for turn {tid}: {b['frames']} frames {b['bytes']}B "
                  f"({secs(b['bytes'])}s) {b['first_at']}..{b['last_at']} phase={b['phase']}")
        await self.pull_all(rep)
        rep["notify_bytes"] = sum(p["bytes"] for p in rep["pulls"])
        rep["notify_s"] = secs(rep["notify_bytes"])
        rep["late_audio_bytes"] = sum(b["bytes"] for b in rep["late_audio"].values())
        print("E2E_TURN " + json.dumps(rep, ensure_ascii=False))
        return rep

    async def pull_all(self, rep: dict) -> None:
        """The link is idle: fetch what was announced (the earbud does this on tap)."""
        while self.pending:
            p = self.pending.pop(0)
            self.notify_no += 1
            t_pull = time.monotonic()
            await self.ws.send(json.dumps({
                "req_id": f"dn_pull_{self._next_seq()}", "type": "device_notify.pull",
                "data": {"msg_id": p["msg_id"]}}, ensure_ascii=False))
            audio, frames, rejected = bytearray(), 0, None
            while True:
                raw = await self._recv(3.0)
                if raw is None:
                    rejected = {"reason": "no 2002 stream and no rejection within 3 s"}
                    break
                if isinstance(raw, bytes):
                    rec = self._classify(raw)
                    if rec["k"] == "n2002" and rec["msg_id"] == p["msg_id"]:
                        frames += 1
                        audio.extend(rec["payload"])
                        if rec["final"]:
                            await self.ws.send(json.dumps({
                                "req_id": f"dn_ack_{self._next_seq()}", "type": "device_notify.ack",
                                "data": {"msg_id": p["msg_id"]}}, ensure_ascii=False))
                            break
                        continue
                    self._note_side(rec, "during_pull", rep)
                    continue
                msg = json.loads(raw)
                if "dn_pull" in str(msg.get("req_id", "")) and msg.get("status"):
                    rejected = {"status": msg["status"], "msg": msg.get("msg", "")}
                    break
                self._note_side(self._classify(raw), "during_pull", rep)
            r = {"msg_id": p["msg_id"], "announced_phase": p["phase"], "announced_at": p["at"],
                 "frames": frames, "bytes": len(audio), "seconds": secs(len(audio)),
                 "stream_s": round(time.monotonic() - t_pull, 2), "rejected": rejected}
            print(f"[<] {utc()} 2002 pulled: {json.dumps(r, ensure_ascii=False)}")
            if audio:
                (self.out / f"turn{rep['turn']}_notify{self.notify_no}.plaudopus").write_bytes(bytes(audio))
                save_wav(self.out / f"turn{rep['turn']}_notify{self.notify_no}.wav", bytes(audio))
            rep["pulls"].append(r)


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--wav", action="append", required=True, help="16 kHz mono WAV; repeatable, cycled")
    ap.add_argument("--turns", type=int, default=3)
    ap.add_argument("--serial", default="SIM-E2E-001")
    ap.add_argument("--linger", type=float, default=45.0, help="max idle listen after each turn (s)")
    ap.add_argument("--quiet", type=float, default=20.0, help="stop idling after this much silence (s)")
    ap.add_argument("--out", default="/tmp/e2e_out")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    clips = [(Path(w).name, load_uplink_audio(w)) for w in args.wav]
    sim = Sim(args.url, args.serial, out, args.linger, args.quiet)
    reports = []
    try:
        await sim.connect()
        for i in range(args.turns):
            label, audio = clips[i % len(clips)]
            reports.append(await sim.turn(audio, label))
    finally:
        if sim.ws is not None:
            await sim.ws.close()
    summary = [{k: r[k] for k in ("turn", "wav", "outcome", "error", "first_audio_s", "live_bytes",
                                  "live_s", "late_audio_bytes", "notify_bytes", "notify_s")}
               | {"announced": len(r["announced"])} for r in reports]
    print("E2E_SUMMARY " + json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

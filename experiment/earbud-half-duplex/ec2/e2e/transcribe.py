#!/usr/bin/env python3
"""Transcribe the clips a run saved (live turn audio and pulled 2002s) with the gateway's own ASR.

Runs inside the gateway container (PLAUD_ASR_URL from its env). Prints "<file>\t<text>".
Audio is fed as plaud-opus at 4x real time, then flushed, same client the qwen engine uses.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, "/app")
from config.settings import settings  # noqa: E402
from services.realtime.asr.streaming_asr import PlaudRealtimeStreamingASR  # noqa: E402

STEP = 400  # 100 ms of plaud-opus


async def one(path: Path) -> str:
    data = path.read_bytes()
    asr = PlaudRealtimeStreamingASR(url=settings.PLAUD_ASR_URL, language=settings.PLAUD_ASR_LANGUAGE,
                                    flush_wait_timeout_s=4.0, codec="opus")
    finals: list[str] = []
    try:
        for i in range(0, len(data), STEP):
            for r in await asr.send_pcm(data[i:i + STEP]):
                if r.final and (r.text or "").strip():
                    finals.append(r.text.strip())
            await asyncio.sleep(0.025)
        for r in await asr.flush():
            if r.final and (r.text or "").strip():
                finals.append(r.text.strip())
    finally:
        await asr.close()
    return " ".join(finals)


async def main() -> None:
    for p in sorted(Path(sys.argv[1]).glob("*.plaudopus")):
        try:
            text = await one(p)
        except Exception as exc:  # noqa: BLE001
            text = f"<asr failed: {type(exc).__name__}>"
        print(f"{p.name}\t{len(p.read_bytes()) / 4000:.1f}s\t{text}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())

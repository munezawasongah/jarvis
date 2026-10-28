#!/usr/bin/env python3
"""Jarvis voice worker: Jarvis speaks in YOUR voice, generated on this machine.

Uses Kyutai Pocket TTS (free, runs on a normal laptop CPU, faster than real time) to clone the voice
in voices/my-voice.wav. The worker dials OUT to the Jarvis server over WebSocket (/voice), exactly
like the Android companion, so it works whether Jarvis runs on this laptop or in the cloud, with no
tunnel or open port. Nothing you say is sent to any outside service.

    python jarvis_voice.py                       # connect to Jarvis and serve speech
    python jarvis_voice.py --say "Hello Evans"   # just make voices/test.wav and play it

Settings come from (highest first): command line, environment (JARVIS_URL, JARVIS_TOKEN),
settings.json next to this file, then ../data/token.txt + http://localhost:3000.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import io
import json
import logging
import os
import platform
import socket
import sys
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

VERSION = "1.0.0"
HERE = Path(__file__).resolve().parent
VOICES = HERE / "voices"
SAMPLE = VOICES / "my-voice.wav"
STATE = VOICES / "my-voice.safetensors"  # fast-loading cache of the learnt voice
STATE_SHA = VOICES / "my-voice.sha"  # which sample the cache was built from
SETTINGS = HERE / "settings.json"
SR = 24000  # Pocket TTS sample rate
PROMPT_SECONDS = 25.0  # the best stretch of your sample is used as the voice prompt
LANGS = {"english": ["en"], "french": ["fr"], "german": ["de"], "spanish": ["es"], "italian": ["it"], "portuguese": ["pt"], "dutch": ["nl"]}

log = logging.getLogger("jarvis-voice")


# ---------------------------------------------------------------- audio helpers
def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_wav(data: bytes) -> tuple[np.ndarray, int]:
    """16-bit PCM WAV bytes -> mono float32 in [-1, 1] and its sample rate."""
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("The voice sample must be 16-bit PCM WAV.")
        ch, rate = w.getnchannels(), w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        pcm = pcm.reshape(-1, ch).mean(axis=1)
    return pcm, rate


def to_wav(audio: np.ndarray, rate: int = SR) -> bytes:
    pcm = np.clip(audio, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def resample(x: np.ndarray, src: int, dst: int = SR) -> np.ndarray:
    if src == dst:
        return x
    from math import gcd

    from scipy.signal import resample_poly

    g = gcd(src, dst)
    return resample_poly(x, dst // g, src // g).astype(np.float32)


def best_prompt(x: np.ndarray, rate: int = SR, seconds: float = PROMPT_SECONDS) -> np.ndarray:
    """Pick the stretch of the sample with the most clean speech, starting and ending in a pause,
    and bring it to a steady loudness. Long silences inside it are shortened."""
    x = x - float(np.mean(x))  # remove DC offset
    hop = int(0.05 * rate)
    n = len(x) // hop
    if n < 10:
        raise ValueError("The voice sample is too short.")
    frames = x[: n * hop].reshape(n, hop)
    db = 20 * np.log10(np.sqrt(np.mean(frames**2, axis=1)) + 1e-9)
    floor = np.percentile(db, 10)
    speech = db > max(floor + 10.0, db.max() - 40.0)
    clipped = np.max(np.abs(frames), axis=1) > 0.985

    # Shorten pauses longer than 0.4 s to 0.3 s so the prompt is mostly voice.
    keep = np.ones(n, dtype=bool)
    run = 0
    for i in range(n):
        if speech[i]:
            run = 0
            continue
        run += 1
        if run > 6:
            keep[i] = False
    idx = np.flatnonzero(keep)
    x2 = frames[idx].reshape(-1)
    speech2, clipped2, db2 = speech[idx], clipped[idx], db[idx]

    win = int(seconds / 0.05)
    if len(idx) > win:
        score = speech2.astype(np.float32) - 3.0 * clipped2.astype(np.float32)
        csum = np.concatenate([[0.0], np.cumsum(score)])
        totals = csum[win:] - csum[:-win]
        start = int(np.argmax(totals))
        # Snap start/end to the quietest nearby frame so the prompt begins and ends between words.
        lo = max(0, start - 10)
        start = lo + int(np.argmin(db2[lo : start + 11]))
        end = min(len(idx), start + win)
        lo = max(start + win // 2, end - 15)
        end = lo + int(np.argmin(db2[lo:end])) + 1
        x2 = x2[start * hop : end * hop]

    rms = float(np.sqrt(np.mean(x2[np.abs(x2) > 0.003] ** 2))) if np.any(np.abs(x2) > 0.003) else 0.0
    if rms > 0:
        x2 = x2 * (0.1 / rms)  # about -20 dBFS speech
    peak = float(np.max(np.abs(x2)))
    if peak > 0.95:
        x2 = x2 * (0.95 / peak)
    return x2.astype(np.float32)


# ---------------------------------------------------------------- the voice model
class Voice:
    def __init__(self, language: str, quantize: bool):
        self.language = language
        self.quantize = quantize
        self.model = None
        self.state = None
        self.sample_sha: str | None = None
        self.ready = False
        self.busy = False
        self.error = ""

    @property
    def cloning(self) -> bool:
        return bool(self.model is not None and getattr(self.model, "has_voice_cloning", False))

    def load_model(self) -> None:
        from pocket_tts import TTSModel

        t = time.time()
        log.info("Loading Pocket TTS (%s)... the first run downloads about 400 MB, later runs are instant.", self.language)
        self.model = TTSModel.load_model(language=self.language, quantize=self.quantize)
        log.info("Model ready in %.1f s. Voice cloning: %s", time.time() - t, "yes" if self.cloning else "NO")

    def load_voice(self) -> None:
        """Use the cached voice if it matches the sample, otherwise learn the sample."""
        self.ready = False
        if not SAMPLE.exists():
            self.sample_sha = None
            self.error = "No voice sample yet. Record one in Jarvis > Settings > Record my voice."
            return
        data = SAMPLE.read_bytes()
        self.sample_sha = sha256(data)
        if STATE.exists() and STATE_SHA.exists() and STATE_SHA.read_text().strip() == self.sample_sha:
            self.state = self.model.get_state_for_audio_prompt(STATE)  # loads in well under a second
            self.ready, self.error = True, ""
            log.info("Your voice is loaded (cached).")
            return
        self.learn(data)

    def learn(self, data: bytes) -> None:
        import torch
        from pocket_tts import export_model_state

        if not self.cloning:
            self.ready = False
            self.error = (
                "Voice cloning is locked. Accept the terms at huggingface.co/kyutai/pocket-tts, "
                "then run setup.ps1 again (it logs you in)."
            )
            log.error(self.error)
            return
        self.busy = True
        try:
            t = time.time()
            pcm, rate = read_wav(data)
            prompt = best_prompt(resample(pcm, rate))
            log.info("Learning your voice from %.1f s of your sample...", len(prompt) / SR)
            state = self.model.get_state_for_audio_prompt(torch.from_numpy(prompt).unsqueeze(0))
            VOICES.mkdir(exist_ok=True)
            export_model_state(state, str(STATE))
            STATE_SHA.write_text(sha256(data))
            (VOICES / "my-voice-prompt.wav").write_bytes(to_wav(prompt))  # what was used, for checking
            self.state, self.sample_sha = state, sha256(data)
            self.ready, self.error = True, ""
            log.info("Your voice is learnt in %.1f s.", time.time() - t)
        except Exception as e:  # keep running; report the problem to the app
            self.ready = False
            self.error = f"Could not learn the voice sample: {e}"
            log.exception("Learning failed")
        finally:
            self.busy = False

    def set_sample(self, data: bytes) -> None:
        read_wav(data)  # validate before replacing anything
        VOICES.mkdir(exist_ok=True)
        tmp = SAMPLE.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, SAMPLE)
        self.ready = False
        self.learn(data)

    def speak(self, text: str) -> bytes:
        if not self.ready or self.state is None:
            raise RuntimeError(self.error or "Your voice is not ready yet.")
        audio = self.model.generate_audio(self.state, text, copy_state=True)
        return to_wav(audio.detach().cpu().numpy().reshape(-1), self.model.sample_rate)

    def status(self) -> dict:
        return {
            "ready": self.ready,
            "busy": self.busy,
            "cloning": self.cloning,
            "languages": LANGS.get(self.language.split("_")[0], ["en"]),
            "sampleSha": self.sample_sha,
            "error": self.error,
        }


# ---------------------------------------------------------------- Jarvis connection
async def safe(fn, *args) -> None:
    try:
        await fn(*args)
    except Exception as e:  # e.g. the connection dropped while we were answering
        log.debug("message handler stopped: %s", e)


def ws_url(server: str, token: str) -> str:
    from urllib.parse import quote

    s = server.strip().rstrip("/")
    if s.startswith("https://"):
        s = "wss://" + s[len("https://") :]
    elif s.startswith("http://"):
        s = "ws://" + s[len("http://") :]
    elif not s.startswith(("ws://", "wss://")):
        s = "wss://" + s
    return f"{s}/voice?token={quote(token, safe='')}"


async def serve(voice: Voice, server: str, token: str) -> None:
    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed, InvalidStatus

    pool = ThreadPoolExecutor(max_workers=1)  # the model is not thread-safe: one job at a time
    loop = asyncio.get_running_loop()
    run = lambda fn, *a: loop.run_in_executor(pool, fn, *a)  # noqa: E731
    url = ws_url(server, token)
    shown = url.split("?")[0]
    delay = 1.0

    while True:
        try:
            async with connect(url, max_size=48 * 1024 * 1024, ping_interval=20, ping_timeout=30, open_timeout=15) as ws:
                delay = 1.0
                log.info("Connected to Jarvis at %s. Jarvis now speaks with your voice.", shown)
                await ws.send(json.dumps({"type": "hello", "engine": "pocket-tts", "version": VERSION, "device": socket.gethostname(), **voice.status()}))

                async def report():
                    await ws.send(json.dumps({"type": "status", **voice.status()}))

                async def handle(m: dict):
                    kind = m.get("type")
                    if kind == "tts":
                        rid = str(m.get("id", ""))
                        try:
                            t = time.time()
                            wav = await run(voice.speak, str(m.get("text", ""))[:2000])
                            log.info("Spoke %d chars in %.2f s", len(m.get("text", "")), time.time() - t)
                            await ws.send(json.dumps({"type": "audio", "id": rid, "ok": True, "wav_b64": base64.b64encode(wav).decode()}))
                        except Exception as e:
                            await ws.send(json.dumps({"type": "audio", "id": rid, "ok": False, "error": str(e)}))
                    elif kind == "set_voice":
                        data = base64.b64decode(m.get("wav_b64", ""))
                        if m.get("sha") and m["sha"] == voice.sample_sha and voice.ready:
                            await report()  # already have exactly this voice
                            return
                        log.info("Jarvis sent a voice sample (%d KB).", len(data) // 1024)
                        voice.busy, voice.ready = True, False
                        await report()
                        try:
                            await run(voice.set_sample, data)
                        except Exception as e:
                            voice.busy, voice.error = False, f"Bad voice sample: {e}"
                        await report()
                    elif kind == "get_voice" and SAMPLE.exists():
                        data = SAMPLE.read_bytes()
                        await ws.send(json.dumps({"type": "voice_sample", "sha": sha256(data), "wav_b64": base64.b64encode(data).decode()}))

                async for raw in ws:
                    try:
                        m = json.loads(raw)
                    except (TypeError, ValueError):
                        continue
                    # Learning a sample takes a while; don't block pings and other messages on it.
                    asyncio.create_task(safe(handle, m))
        except InvalidStatus as e:
            code = getattr(getattr(e, "response", None), "status_code", "?")
            if code == 401:
                log.error("Jarvis rejected the access token. Run: powershell -ExecutionPolicy Bypass -File start.ps1 -Token YOUR_JARVIS_TOKEN")
            else:
                log.error("Jarvis refused the voice connection (HTTP %s). Is this Jarvis version up to date?", code)
            delay = 30.0
        except (OSError, ConnectionClosed, asyncio.TimeoutError) as e:
            log.warning("Jarvis not reachable at %s (%s). Retrying in %.0f s...", shown, e.__class__.__name__, delay)
        await asyncio.sleep(delay)
        delay = min(delay * 2, 30.0)


# ---------------------------------------------------------------- entry point
def settings() -> dict:
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8-sig"))  # PowerShell 5.1 writes a BOM
    except (OSError, ValueError):
        return {}


def main() -> None:
    saved = settings()
    p = argparse.ArgumentParser(description="Jarvis voice worker (your cloned voice, on this machine)")
    p.add_argument("--server", default=os.environ.get("JARVIS_URL") or saved.get("server") or "http://localhost:3000", help="Jarvis address, e.g. https://jarvis.up.railway.app")
    p.add_argument("--token", default=os.environ.get("JARVIS_TOKEN") or saved.get("token") or "", help="Jarvis access token (JARVIS_TOKEN)")
    p.add_argument("--language", default=os.environ.get("VOICE_LANGUAGE") or saved.get("language") or "english", help="Pocket TTS language model (english, french, german, spanish, italian, portuguese, dutch)")
    p.add_argument("--quantize", action="store_true", default=bool(saved.get("quantize")), help="int8 model: less memory, faster on weak CPUs")
    p.add_argument("--sample", help="use this WAV as your voice sample (copied to voices/my-voice.wav)")
    p.add_argument("--say", help="speak this text into voices/test.wav, play it, and exit")
    p.add_argument("--save", action="store_true", help="remember --server/--token/--language in settings.json")
    a = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S", stream=sys.stdout)
    for noisy in ("httpx", "huggingface_hub", "urllib3", "websockets"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    if not a.token:
        tok = HERE.parent / "data" / "token.txt"
        if tok.exists():
            a.token = tok.read_text().strip()
    if a.save:
        SETTINGS.write_text(json.dumps({"server": a.server, "token": a.token, "language": a.language, "quantize": a.quantize}, indent=2), encoding="utf-8")
        log.info("Saved settings to %s", SETTINGS.name)

    voice = Voice(a.language, a.quantize)
    voice.load_model()
    if a.sample:
        data = Path(a.sample).read_bytes()
        voice.set_sample(data)
    else:
        voice.load_voice()

    if a.say is not None:
        if not voice.ready:
            log.error(voice.error)
            sys.exit(1)
        t = time.time()
        wav = voice.speak(a.say)
        out = VOICES / "test.wav"
        out.write_bytes(wav)
        secs = (len(wav) - 44) / 2 / SR
        log.info("Made %.1f s of speech in %.1f s -> %s", secs, time.time() - t, out)
        if platform.system() == "Windows":
            os.startfile(out)  # type: ignore[attr-defined]  # opens in the default player
        return

    if not a.token:
        log.error("No Jarvis access token. Run: start.ps1 -Token <your JARVIS_TOKEN>  (or put Jarvis' data folder next to this one)")
        sys.exit(1)
    if not voice.ready:
        log.warning(voice.error)
    try:
        asyncio.run(serve(voice, a.server, a.token))
    except KeyboardInterrupt:
        log.info("Voice worker stopped.")


if __name__ == "__main__":
    main()

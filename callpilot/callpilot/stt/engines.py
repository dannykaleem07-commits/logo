"""Speech-to-text engines.

* Deepgram (streaming websocket): word-by-word interim results, ~300 ms latency,
  automatic language detection / code-switching. Recommended for live calls.
* OpenAI (gpt-4o-transcribe / whisper-1): utterance-level, high accuracy.
* Local (faster-whisper): fully offline, nothing leaves the PC.
"""

from __future__ import annotations

import io
import json
import logging
import queue
import threading
import time
import uuid
import wave
from collections.abc import Callable
from urllib.parse import urlencode

import numpy as np

from callpilot.audio import dsp
from callpilot.core import secrets
from callpilot.core.config import SpeechSettings

log = logging.getLogger(__name__)

# on_result(speaker, text, is_final, language, end_of_turn, segment_id)
ResultCallback = Callable[[str, str, bool, str, bool, str], None]
ErrorCallback = Callable[[str], None]


class STTEngine:
    def __init__(self, speaker: str, cfg: SpeechSettings, on_result: ResultCallback,
                 on_error: ErrorCallback):
        self.speaker = speaker
        self.cfg = cfg
        self.on_result = on_result
        self.on_error = on_error

    def start(self) -> None: ...
    def stop(self) -> None: ...
    def feed(self, frame: bytes) -> None: ...


# =============================================================== Deepgram streaming
class DeepgramEngine(STTEngine):
    URL = "wss://api.deepgram.com/v1/listen"

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._q: queue.Queue[bytes | None] = queue.Queue(maxsize=500)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._seg_id = uuid.uuid4().hex[:12]
        self._turn_has_text = False
        self._closing = False
        self._ws = None

    def _url(self) -> str:
        params = {
            "model": self.cfg.deepgram_model, "encoding": "linear16", "sample_rate": dsp.TARGET_RATE,
            "channels": 1, "interim_results": "true", "smart_format": "true", "punctuate": "true",
            "endpointing": self.cfg.endpoint_ms, "utterance_end_ms": 1000, "vad_events": "true",
        }
        lang = self.cfg.language or "multi"
        params["language"] = lang
        return f"{self.URL}?{urlencode(params)}"

    def start(self) -> None:
        if not secrets.get("deepgram_api_key"):
            raise RuntimeError("Deepgram API key missing – add it in Settings → API keys.")
        self._thread = threading.Thread(target=self._run, daemon=True, name=f"deepgram-{self.speaker}")
        self._thread.start()

    def stop(self) -> None:
        self._closing = True
        try:
            self._q.put(None, timeout=0.5)  # sender sends CloseStream -> Deepgram flushes final words
        except queue.Full:
            pass
        if self._thread:
            self._thread.join(timeout=2.5)
        self._stop.set()
        ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:  # noqa: BLE001
                pass
        if self._thread:
            self._thread.join(timeout=1.5)

    def feed(self, frame: bytes) -> None:
        if self._closing:
            return
        try:
            self._q.put_nowait(frame)
        except queue.Full:
            pass  # network stalled; drop audio rather than grow latency unboundedly

    def _run(self) -> None:
        from websockets.sync.client import connect

        backoff = 1.0
        while not self._stop.is_set():
            try:
                with connect(self._url(), additional_headers={
                        "Authorization": f"Token {secrets.get('deepgram_api_key')}"},
                        open_timeout=10, max_size=2**22) as ws:
                    self._ws = ws
                    backoff = 1.0
                    sender = threading.Thread(target=self._sender, args=(ws,), daemon=True)
                    sender.start()
                    for msg in ws:
                        if isinstance(msg, str):
                            try:
                                self._handle(json.loads(msg))
                            except Exception:  # noqa: BLE001 - a callback bug must not drop the socket
                                log.exception("transcript callback failed")
                    sender.join(timeout=1)
                if self._closing:
                    break
            except Exception as e:  # noqa: BLE001
                if self._stop.is_set() or self._closing:
                    break
                self.on_error(f"Speech connection ({self.speaker}) dropped: {e}. Reconnecting…")
                time.sleep(backoff)
                backoff = min(backoff * 2, 15)

    def _sender(self, ws) -> None:
        while True:
            try:
                item = self._q.get(timeout=1)
            except queue.Empty:
                try:
                    ws.send(json.dumps({"type": "KeepAlive"}))
                except Exception:  # noqa: BLE001
                    return
                continue
            try:
                if item is None:
                    ws.send(json.dumps({"type": "CloseStream"}))
                    return
                ws.send(item)
            except Exception:  # noqa: BLE001
                return

    def _handle(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "UtteranceEnd":
            if self._turn_has_text:
                self._turn_has_text = False
                self.on_result(self.speaker, "", True, "", True, uuid.uuid4().hex[:12])
            return
        if kind != "Results":
            return
        alts = (msg.get("channel") or {}).get("alternatives") or [{}]
        alt = alts[0]
        text = (alt.get("transcript") or "").strip()
        langs = alt.get("languages") or []
        lang = langs[0] if langs else (msg.get("channel") or {}).get("detected_language", "")
        is_final = bool(msg.get("is_final"))
        speech_final = bool(msg.get("speech_final"))
        if not text and not speech_final:
            return
        if text:
            self._turn_has_text = True
        self.on_result(self.speaker, text, is_final, lang or "", speech_final and is_final, self._seg_id)
        if is_final:
            self._seg_id = uuid.uuid4().hex[:12]
            if speech_final:
                self._turn_has_text = False


# =============================================================== VAD-chunked engines
class _ChunkedEngine(STTEngine):
    MAX_UTTERANCE_S = 14.0

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._vad = dsp.EnergyVAD(hang_ms=max(200, self.cfg.endpoint_ms))
        self._frames: list[np.ndarray] = []
        self._pre: list[np.ndarray] = []
        self._jobs: queue.Queue[tuple[np.ndarray, str] | None] = queue.Queue()
        self._worker: threading.Thread | None = None
        self._listening_id = uuid.uuid4().hex[:12]

    def start(self) -> None:
        self._load()
        self._worker = threading.Thread(target=self._work, daemon=True, name=f"stt-{self.speaker}")
        self._worker.start()

    def stop(self) -> None:
        self._flush()
        self._jobs.put(None)
        if self._worker:
            self._worker.join(timeout=5)

    def _load(self) -> None: ...

    def feed(self, frame: bytes) -> None:
        x = dsp.pcm16_to_float(frame)
        speaking = self._vad.update(x)
        if speaking:
            if not self._frames:
                self._frames.extend(self._pre)  # keep the word onset
                self.on_result(self.speaker, "…", False, "", False, self._listening_id)
            self._frames.append(x)
            if len(self._frames) * dsp.FRAME_MS / 1000 > self.MAX_UTTERANCE_S:
                self._flush()
        else:
            if self._frames:
                self._flush()
            self._pre = (self._pre + [x])[-5:]

    def _flush(self) -> None:
        if not self._frames:
            return
        audio = np.concatenate(self._frames)
        self._frames = []
        seg_id, self._listening_id = self._listening_id, uuid.uuid4().hex[:12]
        if audio.size > dsp.TARGET_RATE * 0.3:
            self._jobs.put((audio, seg_id))
        else:
            self.on_result(self.speaker, "", True, "", False, seg_id)  # clear the "…" placeholder

    def _work(self) -> None:
        while True:
            job = self._jobs.get()
            if job is None:
                return
            audio, seg_id = job
            try:
                text, lang = self._transcribe(audio)
            except Exception as e:  # noqa: BLE001
                self.on_error(f"Transcription failed: {e}")
                text, lang = "", ""
            try:
                self.on_result(self.speaker, text.strip(), True, lang, True, seg_id)
            except Exception:  # noqa: BLE001 - keep transcribing even if a consumer misbehaves
                log.exception("transcript callback failed")

    def _transcribe(self, audio: np.ndarray) -> tuple[str, str]:
        raise NotImplementedError


def _wav_bytes(audio: np.ndarray) -> bytes:
    bio = io.BytesIO()
    with wave.open(bio, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(dsp.TARGET_RATE)
        w.writeframes(dsp.float_to_pcm16(audio))
    return bio.getvalue()


class OpenAIEngine(_ChunkedEngine):
    def _load(self) -> None:
        import openai

        if not secrets.get("openai_api_key"):
            raise RuntimeError("OpenAI API key missing – add it in Settings → API keys.")
        self._client = openai.OpenAI(api_key=secrets.get("openai_api_key"), timeout=30)

    def _transcribe(self, audio):
        lang = self.cfg.language if self.cfg.language not in ("", "multi") else None
        kw = {"model": self.cfg.openai_model, "file": ("speech.wav", _wav_bytes(audio), "audio/wav")}
        if lang:
            kw["language"] = lang
        if self.cfg.openai_model == "whisper-1":
            r = self._client.audio.transcriptions.create(response_format="verbose_json", **kw)
            return r.text, getattr(r, "language", "") or ""
        r = self._client.audio.transcriptions.create(**kw)
        return r.text, ""


class LocalWhisperEngine(_ChunkedEngine):
    _shared_model = None
    _shared_lock = threading.Lock()

    def _load(self) -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise RuntimeError("Offline engine not installed. Run: pip install faster-whisper") from e
        with LocalWhisperEngine._shared_lock:
            if LocalWhisperEngine._shared_model is None:
                LocalWhisperEngine._shared_model = WhisperModel(self.cfg.local_model, device="auto",
                                                                compute_type="int8")
        self._model = LocalWhisperEngine._shared_model

    def _transcribe(self, audio):
        lang = self.cfg.language if self.cfg.language not in ("", "multi") else None
        with LocalWhisperEngine._shared_lock:
            segs, info = self._model.transcribe(audio, language=lang, beam_size=1, vad_filter=False,
                                                condition_on_previous_text=False)
            text = " ".join(s.text.strip() for s in segs)
        return text, getattr(info, "language", "") or ""


def make_engine(speaker: str, cfg: SpeechSettings, on_result: ResultCallback,
                on_error: ErrorCallback) -> STTEngine:
    engine = {"deepgram": DeepgramEngine, "openai": OpenAIEngine, "local": LocalWhisperEngine}.get(
        cfg.engine, DeepgramEngine)
    return engine(speaker, cfg, on_result, on_error)

"""Wires audio -> recorder -> speech -> brain for one call. UI-agnostic."""

from __future__ import annotations

import logging
import time
import uuid
from collections import deque
from collections.abc import Callable

from callpilot.ai.copilot import CallSession, similar
from callpilot.ai.providers import make_provider
from callpilot.audio.capture import AppSource, Channel, MicSource, SystemLoopbackSource
from callpilot.core.config import Settings
from callpilot.core.models import AGENT, CALLER
from callpilot.hubs.model import Hub
from callpilot.stt.engines import make_engine

log = logging.getLogger(__name__)


class CallController:
    def __init__(self, settings: Settings, hub: Hub, emit: Callable[[str, object], None],
                 case_file=None, call_type: str = "", memory=None):
        self.settings = settings
        self.hub = hub
        self.emit = emit
        self.case_file = case_file
        self.call_type = call_type
        self.memory = memory
        self.channels: dict[str, Channel] = {}
        self.engines = {}
        self.session: CallSession | None = None
        self.recorder = None
        self.call_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        self._recent_caller: deque[tuple[float, str]] = deque(maxlen=20)
        self.running = False

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        provider = None
        try:
            provider = make_provider(self.settings.ai)
        except Exception as e:  # noqa: BLE001
            self.emit("error", f"AI provider unavailable ({e}). Transcription will still run.")
        if self.settings.recording.enabled:
            try:
                from callpilot.audio.recorder import CallRecorder

                self.recorder = CallRecorder(self.call_id)
            except Exception as e:  # noqa: BLE001
                self.emit("error", f"Recording unavailable: {e}")
        self.session = CallSession(self.settings, self.hub, provider, self.emit, case_file=self.case_file,
                                   call_type=self.call_type, recorder=self.recorder, call_id=self.call_id,
                                   memory=self.memory)

        a = self.settings.audio
        if a.mic_enabled:
            self.channels[AGENT] = Channel(AGENT, [MicSource(a.mic_device)])
        if a.capture_mode == "apps" and a.target_apps:
            self.channels[CALLER] = Channel(CALLER, [AppSource(a.target_apps)])
        elif a.capture_mode == "system":
            self.channels[CALLER] = Channel(CALLER, [SystemLoopbackSource(a.loopback_device)])

        started = []
        try:
            for speaker, ch in self.channels.items():
                eng = make_engine(speaker, self.settings.speech, self._on_stt, self._on_stt_error)
                eng.start()
                self.engines[speaker] = eng
                ch.subscribe(eng.feed)
                if self.recorder is not None:
                    ch.subscribe(lambda frame, sp=speaker: self.recorder.feed(sp, frame))
                ch.start()
                started.append(ch)
                if speaker == CALLER:
                    src = ch.sources[0]
                    if isinstance(src, AppSource):
                        self.emit("status", "Capturing: " + ", ".join(src.captured))
        except Exception:
            for ch in started:
                ch.stop()
            for eng in self.engines.values():
                eng.stop()
            self.channels.clear()
            self.engines.clear()
            if self.recorder is not None:
                self.recorder.close()
            raise
        self.running = True
        self.emit("call_started", time.time())

    def stop(self, summarize: bool = True) -> dict:
        self.running = False
        for ch in self.channels.values():
            ch.stop()
        for eng in self.engines.values():
            try:
                eng.stop()
            except Exception:  # noqa: BLE001
                log.exception("stopping STT")
        self.channels.clear()
        self.engines.clear()
        if self.recorder is not None:
            try:
                self.recorder.close()
            except Exception:  # noqa: BLE001
                log.exception("closing recorder")
        summary = self.session.end(summarize=summarize) if self.session else {}
        self.emit("call_ended", summary)
        return summary

    # ------------------------------------------------------------------ controls
    def set_muted(self, speaker: str, muted: bool) -> None:
        if speaker in self.channels:
            self.channels[speaker].muted = muted

    def pause_recording(self, paused: bool) -> None:
        """Card-payment pause: audio, transcript and AI all stop until resumed."""
        if self.recorder is not None:
            (self.recorder.pause if paused else self.recorder.resume)()
        for ch in self.channels.values():
            ch.muted = paused
        self.emit("recording_paused", paused)

    def levels(self) -> dict[str, float]:
        return {k: ch.level_db for k, ch in self.channels.items()}

    # ------------------------------------------------------------------ speech results
    def _on_stt(self, speaker: str, text: str, is_final: bool, language: str, end_of_turn: bool,
                segment_id: str) -> None:
        if self.session is None:
            return
        now = time.time()
        if speaker == CALLER and is_final and text:
            self._recent_caller.append((now, text))
        if speaker == AGENT and is_final and text and self._is_echo(text, now):
            # Caller audio leaked from speakers into the mic – don't attribute it to the agent.
            self.session.on_transcript(AGENT, "", True, "", False, segment_id)
            return
        self.session.on_transcript(speaker, text, is_final, language, end_of_turn, segment_id)

    def _is_echo(self, text: str, now: float) -> bool:
        return any(now - t < 6 and similar(text, c) > 0.75 for t, c in list(self._recent_caller))

    def _on_stt_error(self, msg: str) -> None:
        self.emit("error", msg)

"""Call recording: one stereo WAV per call (caller on the left, you on the right),
with pause/resume for card payments, and 10-second clips behind pins.

The WAV is encrypted into the session vault when the call ends; while the call
is live it sits in the user's app-data folder, which only their Windows account
can read.
"""

from __future__ import annotations

import threading
import time
import wave
from collections import deque
from pathlib import Path

import numpy as np

from callpilot.audio import dsp
from callpilot.core import paths


class CallRecorder:
    def __init__(self, call_id: str, clip_seconds: float = 10.0):
        self.dir = paths.sub_dir("recordings")
        self.path = self.dir / f"{call_id}.wav"
        self._wav = wave.open(str(self.path), "wb")
        self._wav.setnchannels(2)
        self._wav.setsampwidth(2)
        self._wav.setframerate(dsp.TARGET_RATE)
        self._lock = threading.Lock()
        self._pending = {"caller": deque(), "agent": deque()}
        self.paused = False
        self.pauses: list[tuple[float, float | None]] = []
        self.started_at = time.time()
        self._ring: deque[bytes] = deque(maxlen=int(clip_seconds * 1000 / dsp.FRAME_MS))
        self.frames_written = 0
        self.closed = False

    # ------------------------------------------------------------- input
    def feed(self, speaker: str, frame: bytes) -> None:
        """Frames arrive on separate clocks; interleave once both sides have one."""
        with self._lock:
            if self.closed:
                return
            key = "agent" if speaker == "agent" else "caller"
            self._pending[key].append(frame)
            while self._pending["caller"] and self._pending["agent"]:
                left = np.frombuffer(self._pending["caller"].popleft(), dtype="<i2")
                right = np.frombuffer(self._pending["agent"].popleft(), dtype="<i2")
                self._write(left, right)
            # a channel that is missing entirely (mic off) must not block recording
            for solo, other in (("caller", "agent"), ("agent", "caller")):
                while len(self._pending[solo]) > 25 and not self._pending[other]:
                    mono = np.frombuffer(self._pending[solo].popleft(), dtype="<i2")
                    silent = np.zeros_like(mono)
                    self._write(mono if solo == "caller" else silent, mono if solo == "agent" else silent)

    def _write(self, left: np.ndarray, right: np.ndarray) -> None:
        if self.paused:
            left = np.zeros_like(left)
            right = np.zeros_like(right)
        stereo = np.empty(left.size * 2, dtype="<i2")
        stereo[0::2] = left
        stereo[1::2] = right
        data = stereo.tobytes()
        self._wav.writeframes(data)
        self._ring.append(data)
        self.frames_written += left.size

    # ------------------------------------------------------------- controls
    def pause(self) -> None:
        """Pause for card details: silence is written so timestamps stay aligned."""
        if not self.paused:
            self.paused = True
            self.pauses.append((time.time(), None))

    def resume(self) -> None:
        if self.paused:
            self.paused = False
            if self.pauses and self.pauses[-1][1] is None:
                self.pauses[-1] = (self.pauses[-1][0], time.time())

    def position_s(self) -> float:
        return self.frames_written / dsp.TARGET_RATE

    def clip(self, name: str) -> Path | None:
        """Save the last ~10 s (both tracks) as its own WAV – the audio behind a pin."""
        with self._lock:
            chunks = list(self._ring)
        if not chunks:
            return None
        p = self.dir / f"{name}.wav"
        with wave.open(str(p), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(dsp.TARGET_RATE)
            w.writeframes(b"".join(chunks))
        return p

    def close(self) -> Path:
        with self._lock:
            if not self.closed:
                self.closed = True
                self._wav.close()
        return self.path

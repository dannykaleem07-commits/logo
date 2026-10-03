"""Audio sources -> 16 kHz mono PCM channels ("agent" = mic, "caller" = apps/system).

Each `Channel` mixes one or more sources on a steady 40 ms clock, so speech
engines always receive a continuous stream (silence when nobody talks), and
level meters can be drawn from it.
"""

from __future__ import annotations

import logging
import sys
import threading
import time
from collections.abc import Callable

import numpy as np

from callpilot.audio import dsp

log = logging.getLogger(__name__)

FrameCallback = Callable[[bytes], None]


class _RingBuffer:
    def __init__(self, seconds: float = 4.0):
        self.max = int(dsp.TARGET_RATE * seconds)
        self.buf = np.zeros(0, dtype=np.float32)
        self.lock = threading.Lock()

    def push(self, x: np.ndarray) -> None:
        with self.lock:
            self.buf = np.concatenate((self.buf, x))[-self.max:]

    def pop(self, n: int) -> np.ndarray:
        with self.lock:
            # Keep latency bounded if the device clock runs faster than ours.
            backlog = self.buf.size - n
            if backlog > dsp.TARGET_RATE * 0.3:
                self.buf = self.buf[backlog - int(dsp.TARGET_RATE * 0.08):]
            out, self.buf = self.buf[:n], self.buf[n:]
        if out.size < n:
            out = np.concatenate((out, np.zeros(n - out.size, dtype=np.float32)))
        return out


class Source:
    name = "source"

    def __init__(self):
        self.ring = _RingBuffer()

    def _feed(self, x: np.ndarray, rate: int) -> None:
        self.ring.push(dsp.resample(x, rate))

    def pop(self, n: int) -> np.ndarray:
        return self.ring.pop(n)

    def start(self) -> None: ...
    def stop(self) -> None: ...


class MicSource(Source):
    def __init__(self, device_name: str = ""):
        super().__init__()
        self.device_name = device_name
        self.name = f"mic:{device_name or 'default'}"
        self._stream = None

    def start(self) -> None:
        import sounddevice as sd

        device = None
        if self.device_name:
            for i, d in enumerate(sd.query_devices()):
                if d["max_input_channels"] > 0 and self.device_name.lower() in d["name"].lower():
                    device = i
                    break
        info = sd.query_devices(device, "input")
        rate = int(info["default_samplerate"])
        ch = 1

        def cb(indata, frames, t, status):
            self._feed(dsp.to_float_mono(indata[:, 0].copy(), 1), rate)

        self._stream = sd.InputStream(device=device, channels=ch, samplerate=rate, dtype="float32",
                                      blocksize=int(rate * 0.02), callback=cb)
        self._stream.start()

    def stop(self) -> None:
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None


class SystemLoopbackSource(Source):
    """Everything the PC plays (WASAPI loopback of an output device)."""

    def __init__(self, device_name: str = ""):
        super().__init__()
        self.device_name = device_name
        self.name = f"system:{device_name or 'default'}"
        self._pa = self._stream = None

    def start(self) -> None:
        if sys.platform != "win32":
            raise OSError("System-audio capture is Windows-only")
        import pyaudiowpatch as pyaudio

        self._pa = pa = pyaudio.PyAudio()
        dev = None
        if self.device_name:
            for lb in pa.get_loopback_device_info_generator():
                if self.device_name.lower() in lb["name"].lower():
                    dev = lb
                    break
        if dev is None:
            dev = pa.get_default_wasapi_loopback()
        rate, ch = int(dev["defaultSampleRate"]), int(dev["maxInputChannels"])

        def cb(in_data, frame_count, time_info, status):
            x = dsp.to_float_mono(np.frombuffer(in_data, dtype="<i2"), ch)
            self._feed(x, rate)
            return (None, pyaudio.paContinue)

        self._stream = pa.open(format=pyaudio.paInt16, channels=ch, rate=rate, input=True,
                               input_device_index=dev["index"], frames_per_buffer=int(rate * 0.02),
                               stream_callback=cb)
        self._stream.start_stream()

    def stop(self) -> None:
        try:
            if self._stream:
                self._stream.stop_stream()
                self._stream.close()
        finally:
            if self._pa:
                self._pa.terminate()
            self._stream = self._pa = None


class AppSource(Source):
    """Only the audio of selected applications (process-tree loopback)."""

    def __init__(self, exe_names: list[str]):
        super().__init__()
        self.exe_names = exe_names
        self.name = "apps:" + ",".join(exe_names)
        self._caps = []
        self._rings: list[_RingBuffer] = []
        self.captured: list[str] = []

    def start(self) -> None:
        from callpilot.audio.apps import root_pids
        from callpilot.audio.process_loopback import ProcessLoopbackCapture

        errors = []
        for exe in self.exe_names:
            for pid in root_pids(exe):
                ring = _RingBuffer()
                cap = ProcessLoopbackCapture(pid, lambda x, rate, r=ring: r.push(dsp.resample(x, rate)))
                try:
                    cap.start()
                    self._caps.append(cap)
                    self._rings.append(ring)
                    self.captured.append(f"{exe} (pid {pid})")
                except OSError as e:
                    errors.append(f"{exe}/{pid}: {e}")
        if not self._caps:
            raise OSError("None of the selected apps are running or capturable. "
                          + ("; ".join(errors) if errors else "Start the call app first."))

    def pop(self, n: int) -> np.ndarray:
        out = np.zeros(n, dtype=np.float32)
        for r in self._rings:
            out += r.pop(n)
        return out

    def stop(self) -> None:
        for c in self._caps:
            c.stop()
        self._caps.clear()
        self._rings.clear()


class Channel:
    """Mixes sources and publishes fixed 40 ms PCM16 frames to subscribers."""

    def __init__(self, label: str, sources: list[Source]):
        self.label = label
        self.sources = sources
        self.subscribers: list[FrameCallback] = []
        self.level_db = -120.0
        self.muted = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def subscribe(self, cb: FrameCallback) -> None:
        self.subscribers.append(cb)

    def start(self) -> None:
        started = []
        try:
            for s in self.sources:
                s.start()
                started.append(s)
        except Exception:
            for s in started:
                s.stop()
            raise
        self._thread = threading.Thread(target=self._pump, daemon=True, name=f"channel-{self.label}")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1)
        for s in self.sources:
            try:
                s.stop()
            except Exception:  # noqa: BLE001
                log.exception("stopping %s", s.name)

    def _pump(self) -> None:
        period = dsp.FRAME_MS / 1000.0
        time.sleep(0.1)  # prefill: a ~100 ms jitter buffer avoids choppy frames
        nxt = time.perf_counter()
        while not self._stop.is_set():
            nxt += period
            mix = np.zeros(dsp.FRAME_SAMPLES, dtype=np.float32)
            for s in self.sources:
                mix += s.pop(dsp.FRAME_SAMPLES)
            if self.muted:
                mix[:] = 0
            self.level_db = 0.7 * self.level_db + 0.3 * dsp.rms_db(mix) if self.level_db > -119 else dsp.rms_db(mix)
            frame = dsp.float_to_pcm16(mix)
            for cb in self.subscribers:
                try:
                    cb(frame)
                except Exception:  # noqa: BLE001
                    log.exception("frame subscriber failed")
            delay = nxt - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            elif delay < -0.5:
                nxt = time.perf_counter()  # fell behind (e.g. system sleep) – resync


def list_input_devices() -> list[str]:
    try:
        import sounddevice as sd

        hostapis = sd.query_hostapis()
        names = []
        for d in sd.query_devices():
            if d["max_input_channels"] > 0:
                api = hostapis[d["hostapi"]]["name"]
                if sys.platform == "win32" and "WASAPI" not in api and "MME" not in api:
                    continue
                if d["name"] not in names:
                    names.append(d["name"])
        return names
    except Exception:  # noqa: BLE001
        return []


def list_output_devices() -> list[str]:
    try:
        import sounddevice as sd

        names = []
        for d in sd.query_devices():
            if d["max_output_channels"] > 0 and d["name"] not in names:
                names.append(d["name"])
        return names
    except Exception:  # noqa: BLE001
        return []

"""Small, dependency-light audio helpers. Pipeline format: 16 kHz mono int16."""

from __future__ import annotations

import numpy as np

TARGET_RATE = 16000
FRAME_MS = 40
FRAME_SAMPLES = TARGET_RATE * FRAME_MS // 1000   # 640 samples
FRAME_BYTES = FRAME_SAMPLES * 2


def to_float_mono(data: np.ndarray, channels: int) -> np.ndarray:
    if data.dtype == np.int16:
        x = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        x = data.astype(np.float32) / 2147483648.0
    else:
        x = data.astype(np.float32, copy=False)
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    return x


def resample(x: np.ndarray, src_rate: int, dst_rate: int = TARGET_RATE) -> np.ndarray:
    if src_rate == dst_rate or x.size == 0:
        return x
    ratio = src_rate / dst_rate
    if ratio.is_integer() and ratio > 1:
        r = int(ratio)
        n = (x.size // r) * r
        return x[:n].reshape(-1, r).mean(axis=1)
    if ratio > 1:
        # crude anti-alias low-pass before linear interpolation
        k = int(round(ratio))
        if k > 1:
            x = np.convolve(x, np.ones(k, dtype=np.float32) / k, mode="same")
    n_out = int(round(x.size / ratio))
    if n_out <= 0:
        return np.zeros(0, dtype=np.float32)
    src_t = np.arange(x.size, dtype=np.float64)
    dst_t = np.linspace(0, x.size - 1, n_out)
    return np.interp(dst_t, src_t, x).astype(np.float32)


def float_to_pcm16(x: np.ndarray) -> bytes:
    return (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def pcm16_to_float(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype="<i2").astype(np.float32) / 32768.0


def rms_db(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    r = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    return 20.0 * np.log10(max(r, 1e-6))


class EnergyVAD:
    """Adaptive energy VAD with hangover; good enough to segment phone speech."""

    def __init__(self, gate_db: float = -50.0, hang_ms: int = 500, frame_ms: int = FRAME_MS):
        self.gate_db = gate_db
        self.noise_db = -70.0
        self.hang_frames = max(1, hang_ms // frame_ms)
        self._hang = 0
        self.speaking = False

    def update(self, frame: np.ndarray) -> bool:
        db = rms_db(frame)
        if not self.speaking:
            self.noise_db = 0.95 * self.noise_db + 0.05 * db
        threshold = max(self.gate_db, self.noise_db + 9.0)
        if db > threshold:
            self.speaking = True
            self._hang = self.hang_frames
        elif self._hang > 0:
            self._hang -= 1
        else:
            self.speaking = False
        return self.speaking

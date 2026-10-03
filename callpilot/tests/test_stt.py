import time

import numpy as np

from callpilot.audio import dsp
from callpilot.core.config import SpeechSettings
from callpilot.stt.engines import DeepgramEngine, _ChunkedEngine


def test_deepgram_message_handling():
    out = []
    eng = DeepgramEngine("caller", SpeechSettings(), lambda *a: out.append(a), lambda e: None)

    def res(text, is_final, speech_final, langs=("es",)):
        return {"type": "Results", "is_final": is_final, "speech_final": speech_final,
                "channel": {"alternatives": [{"transcript": text, "languages": list(langs)}]}}

    eng._handle(res("hola", False, False))
    eng._handle(res("hola tuve un", False, False))
    eng._handle(res("hola tuve un accidente", True, True))
    eng._handle(res("", False, False))  # ignored
    eng._handle(res("y otra cosa", True, False))
    eng._handle({"type": "UtteranceEnd"})
    texts = [(o[1], o[2], o[4]) for o in out]
    assert texts[0] == ("hola", False, False)
    assert texts[2] == ("hola tuve un accidente", True, True)
    assert out[0][5] == out[2][5]           # interims update the same segment
    assert out[3][5] != out[2][5]           # next utterance gets a new segment id
    assert out[-1][1] == "" and out[-1][4]  # UtteranceEnd closes the turn
    assert out[2][3] == "es"
    assert "language=multi" in eng._url() and "interim_results=true" in eng._url()


class _Fake(_ChunkedEngine):
    def _transcribe(self, audio):
        return f"{audio.size / dsp.TARGET_RATE:.1f}s of speech", "en"


def test_chunked_engine_segments_on_silence():
    out = []
    eng = _Fake("agent", SpeechSettings(endpoint_ms=200), lambda *a: out.append(a), lambda e: None)
    eng.start()
    silence = np.zeros(dsp.FRAME_SAMPLES, dtype=np.float32)
    tone = (0.3 * np.sin(np.arange(dsp.FRAME_SAMPLES) * 0.3)).astype(np.float32)
    for _ in range(10):
        eng.feed(dsp.float_to_pcm16(silence))
    for _ in range(25):
        eng.feed(dsp.float_to_pcm16(tone))
    for _ in range(15):
        eng.feed(dsp.float_to_pcm16(silence))
    eng.stop()
    deadline = time.time() + 3
    while time.time() < deadline and not any(o[2] and o[1] for o in out):
        time.sleep(0.02)
    finals = [o for o in out if o[2] and o[1]]
    assert out[0][1] == "…" and not out[0][2]
    assert len(finals) == 1 and finals[0][4] and finals[0][5] == out[0][5]


def test_deepgram_stop_sends_close_stream():
    import json

    class FakeWS:
        def __init__(self):
            self.sent = []
            self.closed = False

        def send(self, data):
            self.sent.append(data)

        def close(self):
            self.closed = True

    eng = DeepgramEngine("caller", SpeechSettings(), lambda *a: None, lambda e: None)
    ws = FakeWS()
    eng._ws = ws
    import threading

    t = threading.Thread(target=eng._sender, args=(ws,), daemon=True)
    t.start()
    eng.feed(b"\x00\x00" * 10)
    eng.stop()
    t.join(timeout=2)
    assert not t.is_alive()
    assert json.loads(ws.sent[-1]) == {"type": "CloseStream"}

"""Voice-interpreter mode: speak a reply (usually in the caller's language).

Audio is played to any output device. Point it at a virtual cable
(e.g. VB-Audio "CABLE Input") and select "CABLE Output" as the microphone in
WhatsApp/Teams to have the translated voice go straight into the call.
"""

from __future__ import annotations

import threading

import numpy as np

from callpilot.core import secrets


def _find_output_device(name: str):
    if not name:
        return None
    import sounddevice as sd

    for i, d in enumerate(sd.query_devices()):
        if d["max_output_channels"] > 0 and name.lower() in d["name"].lower():
            return i
    return None


_current: dict = {"stop": None}


def stop() -> None:
    """Interrupt whatever is being spoken (a new card supersedes the old whisper)."""
    try:
        import sounddevice as sd

        sd.stop()
    except Exception:  # noqa: BLE001
        pass


def speak(text: str, device_name: str = "", voice: str = "alloy", ear: str = "both",
          on_done=None, on_error=None) -> threading.Thread:
    """Speak `text`. ear="left"/"right" plays into one headset ear only (whisper mode)."""

    def run():
        try:
            import openai
            import sounddevice as sd

            client = openai.OpenAI(api_key=secrets.get("openai_api_key") or None)
            with client.audio.speech.with_streaming_response.create(
                    model="gpt-4o-mini-tts", voice=voice, input=text, response_format="pcm") as r:
                pcm = b"".join(r.iter_bytes())
            audio = np.frombuffer(pcm, dtype=np.int16)
            if ear in ("left", "right"):
                stereo = np.zeros((audio.size, 2), dtype=np.int16)
                stereo[:, 0 if ear == "left" else 1] = audio
                audio = stereo
            sd.play(audio, samplerate=24000, device=_find_output_device(device_name), blocking=True)
            if on_done:
                on_done()
        except Exception as e:  # noqa: BLE001
            if on_error:
                on_error(str(e))

    t = threading.Thread(target=run, daemon=True, name="callpilot-tts")
    t.start()
    return t

"""Spoken output: whisper translations into one ear, read a card aloud, or (AI mode) speak
as the AI employee into a virtual cable.

Audio is played to any output device. Point it at a virtual cable
(e.g. VB-Audio "CABLE Input") and select "CABLE Output" as the microphone in
WhatsApp/Teams to have the voice go straight into the call.

A new `speak()` supersedes the previous one, and `stop()` cancels the current
utterance even while its audio is still being fetched (barge-in / take-over).
"""

from __future__ import annotations

import threading

import numpy as np

from callpilot.core import secrets


def find_output_device(name: str):
    """Index of the first output device whose name contains `name`; None if absent."""
    if not name:
        return None
    import sounddevice as sd

    for i, d in enumerate(sd.query_devices()):
        if d["max_output_channels"] > 0 and name.lower() in d["name"].lower():
            return i
    return None


_find_output_device = find_output_device  # backwards compatibility

_lock = threading.Lock()
_current: dict = {"cancel": None}


def stop() -> None:
    """Interrupt whatever is being spoken or fetched (a new card / the caller supersedes it)."""
    with _lock:
        cancel = _current["cancel"]
        _current["cancel"] = None
    if cancel is not None:
        cancel.set()
    try:
        import sounddevice as sd

        sd.stop()
    except Exception:  # noqa: BLE001
        pass


def speak(text: str, device_name: str = "", voice: str = "alloy", ear: str = "both",
          on_done=None, on_error=None) -> threading.Thread:
    """Speak `text`. ear="left"/"right" plays into one headset ear only (whisper mode).

    on_done() is called when the utterance has finished or was cancelled; on_error(msg)
    if it could not be fetched or played. If `device_name` is set and no such device
    exists, nothing is played and on_error is called (never speak into the wrong place).
    """
    cancel = threading.Event()
    with _lock:
        previous, _current["cancel"] = _current["cancel"], cancel
    if previous is not None:
        previous.set()
        try:
            import sounddevice as sd

            sd.stop()
        except Exception:  # noqa: BLE001
            pass

    def finish():
        with _lock:
            if _current["cancel"] is cancel:
                _current["cancel"] = None
        if on_done:
            on_done()

    def run():
        try:
            import openai
            import sounddevice as sd

            device = None
            if device_name:
                device = find_output_device(device_name)
                if device is None:
                    raise RuntimeError(f"output device '{device_name}' not found – check Settings → AI mode / Speech")
            client = openai.OpenAI(api_key=secrets.get("openai_api_key") or None)
            with client.audio.speech.with_streaming_response.create(
                    model="gpt-4o-mini-tts", voice=voice, input=text, response_format="pcm") as r:
                chunks = []
                for b in r.iter_bytes():
                    if cancel.is_set():
                        finish()
                        return
                    chunks.append(b)
            pcm = b"".join(chunks)
            if cancel.is_set():
                finish()
                return
            audio = np.frombuffer(pcm, dtype=np.int16)
            if ear in ("left", "right"):
                stereo = np.zeros((audio.size, 2), dtype=np.int16)
                stereo[:, 0 if ear == "left" else 1] = audio
                audio = stereo
            sd.play(audio, samplerate=24000, device=device, blocking=True)
            finish()
        except Exception as e:  # noqa: BLE001
            with _lock:
                if _current["cancel"] is cancel:
                    _current["cancel"] = None
            if on_error:
                on_error(str(e))

    t = threading.Thread(target=run, daemon=True, name="callpilot-tts")
    t.start()
    return t

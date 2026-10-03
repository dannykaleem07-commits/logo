"""Application settings, persisted as JSON. Secrets are NOT stored here (see secrets.py)."""

from __future__ import annotations

import json
import threading
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

from callpilot.core import paths


@dataclass
class AudioSettings:
    mic_device: str = ""                 # "" = system default input
    capture_mode: str = "apps"           # "apps" | "system" | "off"
    target_apps: list[str] = field(default_factory=lambda: ["WhatsApp.exe"])
    loopback_device: str = ""            # "" = default output (system mode)
    noise_gate_db: float = -50.0
    mic_enabled: bool = True


@dataclass
class SpeechSettings:
    engine: str = "deepgram"             # "deepgram" | "openai" | "local"
    deepgram_model: str = "nova-3"
    openai_model: str = "gpt-4o-transcribe"
    local_model: str = "small"           # faster-whisper size
    language: str = "multi"              # "multi" = auto-detect / code-switching
    endpoint_ms: int = 350               # silence that ends a caller turn


@dataclass
class AISettings:
    provider: str = "anthropic"          # "anthropic" | "openai"
    anthropic_model: str = "claude-opus-5-5"
    anthropic_effort: str = "low"        # low effort keeps live suggestions fast
    anthropic_fast_mode: bool = False    # Opus fast mode (research preview, premium pricing)
    anthropic_fallbacks: bool = True     # server-side refusal fallbacks
    openai_model: str = "gpt-4.1"
    speculative: bool = True             # start drafting while the caller is still finishing
    suggestion_max_tokens: int = 1200
    extract_every_n_turns: int = 2


@dataclass
class TranslationSettings:
    enabled: bool = True
    engine: str = "llm"                  # "llm" | "deepl" | "off"
    agent_language: str = "English"      # what YOU read and speak
    reply_in_caller_language: bool = False
    speak_replies: bool = False          # voice-interpreter mode (TTS)
    tts_output_device: str = ""          # e.g. "CABLE Input (VB-Audio Virtual Cable)"
    tts_voice: str = "alloy"


@dataclass
class PrivacySettings:
    encrypt_sessions: bool = True
    save_sessions: bool = True
    retention_days: int = 30
    redact_saved_pii: bool = True
    redact_payment_data_before_cloud: bool = True
    exclude_windows_from_capture: bool = True   # hide CallPilot from screen-shares/recordings
    require_unlock: bool = False                # master passphrase on startup
    consent_reminder: bool = True


@dataclass
class UISettings:
    theme: str = "dark"
    overlay_enabled: bool = True
    overlay_opacity: float = 0.92
    overlay_font_pt: int = 15
    overlay_click_through: bool = False
    hotkey_regenerate: str = "<ctrl>+<shift>+<space>"
    hotkey_overlay: str = "<ctrl>+<shift>+o"
    hotkey_copy: str = "<ctrl>+<shift>+c"
    hotkey_toggle_call: str = "<ctrl>+<shift>+l"
    font_pt: int = 11
    window_geometry: str = ""
    overlay_geometry: str = ""


@dataclass
class Settings:
    audio: AudioSettings = field(default_factory=AudioSettings)
    speech: SpeechSettings = field(default_factory=SpeechSettings)
    ai: AISettings = field(default_factory=AISettings)
    translation: TranslationSettings = field(default_factory=TranslationSettings)
    privacy: PrivacySettings = field(default_factory=PrivacySettings)
    ui: UISettings = field(default_factory=UISettings)
    active_hub: str = "courtesy-cars-accident-management"
    agent_name: str = ""
    first_run: bool = True

    # ------------------------------------------------------------------ io
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Settings":
        s = cls()
        for f in fields(cls):
            if f.name not in data:
                continue
            current = getattr(s, f.name)
            value = data[f.name]
            if hasattr(current, "__dataclass_fields__") and isinstance(value, dict):
                setattr(s, f.name, _merge_dataclass(current, value))
            else:
                setattr(s, f.name, value)
        return s


def _merge_dataclass(obj: Any, data: dict[str, Any]) -> Any:
    """Copy known keys only, so old/new settings files never crash the app."""
    for f in fields(obj):
        if f.name in data:
            setattr(obj, f.name, data[f.name])
    return obj


_lock = threading.Lock()


def load(path: Path | None = None) -> Settings:
    path = path or paths.config_file()
    if not path.exists():
        return Settings()
    try:
        return Settings.from_dict(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        # A corrupt settings file must never brick the app; keep a copy for support.
        try:
            path.replace(path.with_suffix(".corrupt.json"))
        except OSError:
            pass
        return Settings()


def save(settings: Settings, path: Path | None = None) -> None:
    path = path or paths.config_file()
    with _lock:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(settings.to_dict(), indent=2), encoding="utf-8")
        tmp.replace(path)

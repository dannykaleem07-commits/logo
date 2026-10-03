"""Plain data objects passed between the audio, speech, AI and UI layers."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field

AGENT = "agent"      # you (microphone)
CALLER = "caller"    # the other party (app / system audio)


@dataclass
class Segment:
    speaker: str
    text: str
    is_final: bool
    language: str = ""
    translation: str = ""
    start: float = field(default_factory=time.time)
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    confidence: float = 1.0

    def to_dict(self) -> dict:
        return {
            "id": self.id, "speaker": self.speaker, "text": self.text,
            "language": self.language, "translation": self.translation,
            "start": self.start, "confidence": self.confidence,
        }


@dataclass
class Suggestion:
    """A live reply suggestion, filled progressively as tokens stream in."""

    turn_id: str
    filler: str = ""          # say this immediately (buys 2-4 seconds)
    say_now: str = ""         # the key answer, first sentence
    continue_with: str = ""   # the remainder, generated while you speak
    ask_next: list[str] = field(default_factory=list)  # questions to collect missing info
    warnings: list[str] = field(default_factory=list)  # compliance / rule reminders
    translated: str = ""      # say_now + continue in the caller's language
    source: str = "llm"       # "instant-kb" | "llm"
    done: bool = False
    first_token_ms: float = 0.0
    total_ms: float = 0.0

    def full_text(self) -> str:
        return " ".join(p for p in (self.filler, self.say_now, self.continue_with) if p).strip()

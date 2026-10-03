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
    entities: list = field(default_factory=list)   # [(kind, text)] – dates, regs, money shown as chips
    pinned: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id, "speaker": self.speaker, "text": self.text,
            "language": self.language, "translation": self.translation,
            "start": self.start, "confidence": self.confidence,
            "entities": [list(e) for e in self.entities], "pinned": self.pinned,
        }


ASK, SAY, WATCH = "ask", "say", "watch"


@dataclass
class Card:
    """One AI card. Every card names its source so it can be checked against the audio."""

    type: str                          # ask | say | watch
    text: str
    sources: list[str] = field(default_factory=list)   # playbook section / "transcript 14:32:05" / "rule:injury"
    segment_id: str = ""               # transcript line it came from
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    shown_at: float = field(default_factory=time.time)
    action: str = ""                   # "" | used | dismissed | ignored
    pinned_top: bool = False           # e.g. "no signed authority" stays until resolved
    more: str = ""                     # say cards: the continuation that streams in
    filler: str = ""                   # say cards: instant opener
    translated: str = ""
    done: bool = True
    origin: str = "llm"                # llm | rule | playbook | script

    def to_dict(self) -> dict:
        return {"id": self.id, "type": self.type, "text": self.text, "more": self.more,
                "sources": self.sources, "segment_id": self.segment_id, "shown_at": self.shown_at,
                "action": self.action, "origin": self.origin, "pinned_top": self.pinned_top}

    def spoken(self) -> str:
        return " ".join(p for p in (self.text, self.more) if p).strip()


@dataclass
class Pin:
    kind: str                          # date | commitment | figure | admission | allegation | deadline
    value: str                         # normalised value ("07/10/2026", "£1,250", "within 14 days")
    quote: str                         # the exact words
    segment_id: str
    speaker: str
    at: float = field(default_factory=time.time)
    due_at: str = ""                   # ISO date for deadlines
    clip_path: str = ""
    confirmed: bool = False
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    def to_dict(self) -> dict:
        return self.__dict__.copy()


@dataclass
class Task:
    title: str
    due_at: str = ""
    owner: str = ""
    source_segment_id: str = ""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    done: bool = False

    def to_dict(self) -> dict:
        return self.__dict__.copy()


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

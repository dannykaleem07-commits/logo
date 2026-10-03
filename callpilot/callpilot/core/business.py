"""Business profiles – the top of the hierarchy: Business profile → Call hub → Call.

A business holds what is true for every call it takes: the legal status line,
house rules, banned phrases, scripts the handler reads out, and the email
signature. Call hubs belong to a business and add the call-type specifics.
Rules set here apply to every hub under the business.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

from callpilot.core import paths


@dataclass
class Script:
    title: str
    text: str
    when: str = ""           # "opening" | "consent" | "closing" | "terms" | "" (any time)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Business:
    id: str
    name: str
    tagline: str = ""
    website: str = ""
    status_line: str = ""                       # legal/regulatory footer – goes on every email draft
    rules: list[str] = field(default_factory=list)          # apply to every hub of this business
    banned_phrases: list[str] = field(default_factory=list)
    scripts: list[Script] = field(default_factory=list)
    email_signature: str = ""
    phone: str = ""
    email: str = ""
    version: int = 1

    def to_dict(self) -> dict:
        d = asdict(self)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Business":
        known = {f.name for f in fields(cls)}
        data = {k: v for k, v in d.items() if k in known}
        data["scripts"] = [Script(**{k: v for k, v in s.items() if k in Script.__dataclass_fields__})
                           for s in d.get("scripts", []) if isinstance(s, dict)]
        return cls(**data)

    def prompt_block(self) -> str:
        lines = [f"## Business: {self.name}"]
        if self.tagline:
            lines.append(self.tagline)
        if self.status_line:
            lines.append(f"Status wording (use exactly this if asked who you are): {self.status_line}")
        if self.rules:
            lines.append("House rules for every call:")
            lines += [f"- {r}" for r in self.rules]
        if self.banned_phrases:
            lines.append("Never say: " + "; ".join(self.banned_phrases))
        return "\n".join(lines)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "business"


def builtin_dir() -> Path:
    return paths.resource_path("callpilot/hubs/builtin/businesses")


class BusinessStore:
    def __init__(self, root: Path | None = None):
        self.root = root or paths.sub_dir("businesses")

    def list(self) -> list[Business]:
        found: dict[str, Business] = {}
        bdir = builtin_dir()
        if bdir.exists():
            for f in sorted(bdir.glob("*.json")):
                try:
                    b = Business.from_dict(json.loads(f.read_text(encoding="utf-8")))
                    found[b.id] = b
                except (ValueError, TypeError, KeyError):
                    continue
        for f in sorted(self.root.glob("*.json")):
            try:
                b = Business.from_dict(json.loads(f.read_text(encoding="utf-8")))
                found[b.id] = b
            except (ValueError, TypeError, KeyError):
                continue
        return sorted(found.values(), key=lambda b: b.name.lower())

    def get(self, business_id: str) -> Business | None:
        for b in self.list():
            if b.id == business_id:
                return b
        return None

    def save(self, b: Business) -> Path:
        if not b.id:
            b.id = _slug(b.name)
        f = self.root / f"{b.id}.json"
        f.write_text(json.dumps(b.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
        return f

    def delete(self, business_id: str) -> None:
        f = self.root / f"{business_id}.json"
        if f.exists():
            f.unlink()

    def new(self, name: str) -> Business:
        base, i = _slug(name), 2
        bid = base
        existing = {b.id for b in self.list()}
        while bid in existing:
            bid, i = f"{base}-{i}", i + 1
        return Business(id=bid, name=name)

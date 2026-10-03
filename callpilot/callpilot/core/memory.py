"""Long-term memory: what the AI remembers between calls and how it trains itself.

Three kinds of entries, all encrypted at rest and all reviewable/deletable:

* **answer**  – a question callers ask and the answer that worked (either what you
                actually said, or an AI suggestion you marked as used). These become
                instant answers and few-shot examples for the next call.
* **fact**    – a durable fact about a caller, a company or a file ("Aviva handler
                Tom Avery wants rate evidence by email", "client prefers texts").
* **lesson**  – a style/approach preference learned from your feedback: cards you
                dismissed teach the AI what not to suggest; cards you used, what to
                keep doing; the wrap-up notes which phrasing you prefer.

Entries carry a score that rises with use and decays when dismissed, so the
memory sharpens over time instead of just growing.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

from callpilot.core import paths
from callpilot.core.crypto import Vault
from callpilot.kb.retriever import BM25, QAMatcher


@dataclass
class MemoryEntry:
    kind: str                      # answer | fact | lesson
    text: str                      # the answer / fact / lesson
    question: str = ""             # for answers: what the caller said
    hub_id: str = ""               # "" = applies to every hub
    subject: str = ""              # caller name / phone / company / file id for facts
    score: float = 1.0             # confidence; grows with use, shrinks when dismissed
    uses: int = 0
    source_call: str = ""
    created_at: float = field(default_factory=time.time)
    last_used: float = 0.0
    origin: str = "learned"        # learned | manual | feedback
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "MemoryEntry":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in known})


class MemoryStore:
    def __init__(self, path: Path | None = None, vault: Vault | None = None):
        self.path = path or (paths.app_data_dir() / "memory.cpv")
        self._vault = vault
        self._lock = threading.RLock()
        self.entries: list[MemoryEntry] = []
        self._load()

    @property
    def vault(self) -> Vault:
        return self._vault or Vault.current()

    # ------------------------------------------------------------- io
    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = self.vault.decrypt_json(self.path.read_bytes())
            self.entries = [MemoryEntry.from_dict(d) for d in data.get("entries", [])]
        except Exception:  # noqa: BLE001
            try:
                self.path.replace(self.path.with_suffix(".corrupt"))
            except OSError:
                pass
            self.entries = []

    def _flush(self) -> None:
        blob = self.vault.encrypt_json({"v": 1, "entries": [e.to_dict() for e in self.entries]})
        tmp = self.path.with_suffix(".tmp")
        tmp.write_bytes(blob)
        tmp.replace(self.path)

    # ------------------------------------------------------------- write
    def add(self, entry: MemoryEntry) -> MemoryEntry:
        with self._lock:
            dup = self._find_duplicate(entry)
            if dup is not None:
                dup.score = min(5.0, dup.score + 0.5)
                dup.uses += 1
                dup.last_used = time.time()
                if len(entry.text) > len(dup.text):
                    dup.text = entry.text
                self._flush()
                return dup
            self.entries.append(entry)
            self._flush()
            return entry

    def add_many(self, entries: list[MemoryEntry]) -> int:
        n = 0
        with self._lock:
            for e in entries:
                before = len(self.entries)
                self.add(e)
                n += int(len(self.entries) > before)
        return n

    def _find_duplicate(self, e: MemoryEntry) -> MemoryEntry | None:
        key = _norm(e.question or e.text)
        for x in self.entries:
            if x.kind != e.kind or (x.hub_id and e.hub_id and x.hub_id != e.hub_id):
                continue
            if x.kind == "answer" and _similar(_norm(x.question), key) >= 0.85:
                return x
            if x.kind != "answer" and _similar(_norm(x.text), _norm(e.text)) >= 0.9:
                return x
        return None

    def feedback(self, question: str, answer: str, used: bool, hub_id: str, call_id: str = "") -> None:
        """Operator feedback on a card: used -> remember it; dismissed -> remember to avoid it."""
        with self._lock:
            if used and answer.strip():
                self.add(MemoryEntry("answer", answer.strip(), question=question.strip()[:300], hub_id=hub_id,
                                     score=1.5, uses=1, last_used=time.time(), source_call=call_id,
                                     origin="feedback"))
            elif not used:
                dup = self._find_duplicate(MemoryEntry("answer", answer, question=question, hub_id=hub_id))
                if dup is not None:
                    dup.score = max(0.0, dup.score - 0.75)
                    if dup.score <= 0.25:
                        self.entries.remove(dup)
                    self._flush()

    def remove(self, entry_id: str) -> None:
        with self._lock:
            self.entries = [e for e in self.entries if e.id != entry_id]
            self._flush()

    def clear(self, hub_id: str | None = None) -> None:
        with self._lock:
            self.entries = [] if hub_id is None else [e for e in self.entries if e.hub_id != hub_id]
            self._flush()

    # ------------------------------------------------------------- read
    def for_hub(self, hub_id: str, kind: str | None = None) -> list[MemoryEntry]:
        out = [e for e in self.entries if (not e.hub_id or e.hub_id == hub_id) and (kind is None or e.kind == kind)]
        return sorted(out, key=lambda e: (e.score, e.uses), reverse=True)

    def learned_pairs(self, hub_id: str, min_score: float = 0.75, limit: int = 300) -> list[tuple[str, str]]:
        return [(e.question, e.text) for e in self.for_hub(hub_id, "answer") if e.question and e.score >= min_score][:limit]

    def matcher(self, hub_id: str) -> QAMatcher:
        return QAMatcher(self.learned_pairs(hub_id))

    def search(self, hub_id: str, query: str, k: int = 4) -> list[MemoryEntry]:
        pool = self.for_hub(hub_id)
        if not pool or not query.strip():
            return []
        docs = [f"{e.question} {e.text} {e.subject}" for e in pool]
        hits = BM25(docs).search(query, k=k)
        return [pool[h.ref] for h in hits]

    def facts_about(self, subject: str, hub_id: str = "") -> list[MemoryEntry]:
        s = _norm(subject)
        if not s:
            return []
        return [e for e in self.for_hub(hub_id, "fact") if s in _norm(e.subject) or _norm(e.subject) in s]

    def prompt_block(self, hub_id: str, subject: str = "", max_chars: int = 12000) -> str:
        """Stable text cached into the system prompt at call start."""
        lines = ["## What you have learned from past calls (use it, but never state it as fact to the caller "
                 "unless it is in the file)"]
        lessons = self.for_hub(hub_id, "lesson")[:25]
        if lessons:
            lines.append("Preferences of this handler:")
            lines += [f"- {e.text}" for e in lessons]
        facts = self.facts_about(subject, hub_id)[:15] if subject else []
        if facts:
            lines.append(f"Known about {subject}:")
            lines += [f"- {e.text}" for e in facts]
        answers = [e for e in self.for_hub(hub_id, "answer") if e.question][:40]
        if answers:
            lines.append("Answers that worked before (caller said -> handler said):")
            for e in answers:
                lines.append(f"- Q: {e.question}\n  A: {e.text}")
        text = "\n".join(lines)
        return text[:max_chars] if len(lines) > 1 else ""

    def stats(self, hub_id: str) -> dict:
        pool = self.for_hub(hub_id)
        return {"answers": sum(e.kind == "answer" for e in pool), "facts": sum(e.kind == "fact" for e in pool),
                "lessons": sum(e.kind == "lesson" for e in pool),
                "calls": len({e.source_call for e in pool if e.source_call})}


def _norm(t: str) -> str:
    return " ".join((t or "").lower().split())


def _similar(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    import difflib

    return difflib.SequenceMatcher(None, a, b).ratio()

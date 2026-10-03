"""Call hubs: per-company / per-campaign brains (persona, rules, Q&A, knowledge, fields)."""

from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

from callpilot.core import paths
from callpilot.kb.retriever import BM25, QAMatcher, chunk_text


@dataclass
class CaptureField:
    key: str
    label: str
    hint: str = ""
    required: bool = True


@dataclass
class Hub:
    id: str
    name: str
    company: str = ""
    description: str = ""
    persona: str = ""
    tone: str = "Warm, calm, confident and concise. British English."
    greeting: str = ""
    closing: str = ""
    consent_script: str = ""
    rules: list[str] = field(default_factory=list)
    forbidden_phrases: list[str] = field(default_factory=list)
    required_disclosures: list[str] = field(default_factory=list)
    escalation_triggers: list[str] = field(default_factory=list)
    fillers: list[str] = field(default_factory=list)
    qa: list[dict] = field(default_factory=list)            # [{"q": ..., "a": ...}]
    knowledge: str = ""
    documents: list[dict] = field(default_factory=list)     # [{"name": ..., "text": ...}]
    capture_fields: list[CaptureField] = field(default_factory=list)
    call_types: dict = field(default_factory=dict)      # {"handler": "instructions…", ...}
    status_line: str = ""                               # footer on every email draft
    version: int = 1

    # ------------------------------------------------------------ serialisation
    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Hub":
        known = {f.name for f in fields(cls)}
        data = {k: v for k, v in d.items() if k in known}
        data["capture_fields"] = [
            CaptureField(**{k: v for k, v in cf.items() if k in CaptureField.__dataclass_fields__})
            if isinstance(cf, dict) else cf
            for cf in d.get("capture_fields", [])
        ]
        return cls(**data)

    # ------------------------------------------------------------ derived indexes
    def qa_pairs(self) -> list[tuple[str, str]]:
        return [(p["q"], p["a"]) for p in self.qa if p.get("q") and p.get("a")]

    def build_matcher(self) -> QAMatcher:
        return QAMatcher(self.qa_pairs())

    def all_knowledge_text(self) -> str:
        parts = [self.knowledge.strip()] + [
            f"# {d.get('name', 'Document')}\n{d.get('text', '').strip()}" for d in self.documents
        ]
        return "\n\n".join(p for p in parts if p)

    def build_index(self) -> BM25:
        chunks = chunk_text(self.all_knowledge_text())
        chunks += [f"Q: {q}\nA: {a}" for q, a in self.qa_pairs()]
        return BM25(chunks)

    # ------------------------------------------------------------ prompt
    def system_prompt(self, max_kb_chars: int = 400_000) -> str:
        """Stable text (cache-friendly: no timestamps or per-call data)."""
        lines = [
            f"You are the live call co-pilot for {self.company or self.name}.",
            "A human agent is on a live phone/WhatsApp call. You see the transcript and must "
            "give them words they can say out loud immediately.",
        ]
        if self.persona:
            lines += ["", "## Agent persona", self.persona]
        if self.tone:
            lines += ["", "## Tone", self.tone]
        if self.rules:
            lines += ["", "## Rules (must always be followed)"] + [f"- {r}" for r in self.rules]
        if self.forbidden_phrases:
            lines += ["", "## Never say"] + [f"- {p}" for p in self.forbidden_phrases]
        if self.required_disclosures:
            lines += ["", "## Disclosures the agent must make during the call"] + [
                f"- {p}" for p in self.required_disclosures]
        if self.capture_fields:
            lines += ["", "## Information the agent must collect"] + [
                f"- {f.label}" + (f" ({f.hint})" if f.hint else "") for f in self.capture_fields]
        if self.qa:
            lines += ["", "## Approved answers (prefer these wording choices)"]
            for q, a in self.qa_pairs():
                lines += [f"Q: {q}", f"A: {a}"]
        kb = self.all_knowledge_text()
        if kb:
            lines += ["", "## Knowledge base", kb[:max_kb_chars]]
        return "\n".join(lines)


# ---------------------------------------------------------------- persistence
def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "hub"


def builtin_dir() -> Path:
    return paths.resource_path("callpilot/hubs/builtin")


class HubStore:
    def __init__(self, root: Path | None = None):
        self.root = root or paths.hubs_dir()

    def list(self) -> list[Hub]:
        found: dict[str, Hub] = {}
        bdir = builtin_dir()
        if bdir.exists():
            for f in sorted(bdir.glob("*.json")):
                h = Hub.from_dict(json.loads(f.read_text(encoding="utf-8")))
                found[h.id] = h
        for f in sorted(self.root.glob("*.json")):
            try:
                h = Hub.from_dict(json.loads(f.read_text(encoding="utf-8")))
                found[h.id] = h  # user copy overrides built-in
            except (ValueError, TypeError, KeyError):
                continue
        return sorted(found.values(), key=lambda h: h.name.lower())

    def get(self, hub_id: str) -> Hub | None:
        for h in self.list():
            if h.id == hub_id:
                return h
        return None

    def save(self, hub: Hub) -> Path:
        if not hub.id:
            hub.id = _slug(hub.name)
        f = self.root / f"{hub.id}.json"
        f.write_text(json.dumps(hub.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
        return f

    def delete(self, hub_id: str) -> None:
        f = self.root / f"{hub_id}.json"
        if f.exists():
            f.unlink()

    def new(self, name: str) -> Hub:
        base, i = _slug(name), 2
        hid = base
        existing = {h.id for h in self.list()}
        while hid in existing:
            hid, i = f"{base}-{i}", i + 1
        return Hub(id=hid, name=name, company=name)


# ---------------------------------------------------------------- importing
def read_document(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in (".txt", ".md", ".markdown", ".csv", ".json"):
        return path.read_text(encoding="utf-8", errors="replace")
    if ext == ".pdf":
        from pypdf import PdfReader

        return "\n\n".join((p.extract_text() or "") for p in PdfReader(str(path)).pages)
    if ext == ".docx":
        import docx

        d = docx.Document(str(path))
        return "\n".join(p.text for p in d.paragraphs)
    raise ValueError(f"Unsupported document type: {ext}")


def parse_qa_csv(text: str) -> list[dict]:
    """CSV with columns question,answer (header optional)."""
    rows = list(csv.reader(io.StringIO(text)))
    out = []
    for r in rows:
        if len(r) < 2:
            continue
        q, a = r[0].strip(), r[1].strip()
        if q.lower() in ("question", "q") and a.lower() in ("answer", "a"):
            continue
        if q and a:
            out.append({"q": q, "a": a})
    return out

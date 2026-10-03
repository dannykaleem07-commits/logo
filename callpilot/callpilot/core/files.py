"""Case files and contacts – the left-hand column of the cockpit.

A small encrypted store (one AES-GCM blob) holding the files a desk works on:
client, registration, stage, hire start, signed authority, deadlines,
chronology and tasks. Calls attach to a file; the wrap-up writes back to it.

Caller-ID file pop needs the telephony provider (see README); on the desktop the
operator searches or pastes a number and the matching file opens.
"""

from __future__ import annotations

import datetime as dt
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

from callpilot.core import paths
from callpilot.core.crypto import Vault

STAGES = ["new enquiry", "FNOL taken", "hire live", "repair in progress", "total loss", "settled", "closed"]
ROLES = ["client", "handler", "engineer", "bodyshop", "council", "solicitor", "other"]


def _norm_phone(p: str) -> str:
    d = re.sub(r"\D", "", p or "")
    if d.startswith("44"):
        d = "0" + d[2:]
    return d


@dataclass
class Contact:
    name: str
    role: str = "client"
    organisation: str = ""
    phone_numbers: list[str] = field(default_factory=list)
    email: str = ""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])


@dataclass
class ChronologyEntry:
    event_date: str          # ISO date
    text: str
    source: str = "call"     # call | letter | manual | ai
    source_id: str = ""      # call id / segment id
    created_at: float = field(default_factory=time.time)
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])


@dataclass
class Deadline:
    kind: str                # reply | authority | inspection | payment | complaint | other
    due_at: str              # ISO date
    text: str = ""
    source_id: str = ""
    done: bool = False
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    def days_left(self, today: dt.date | None = None) -> int:
        today = today or dt.date.today()
        try:
            return (dt.date.fromisoformat(self.due_at[:10]) - today).days
        except ValueError:
            return 9999


@dataclass
class CaseFile:
    business: str = "Courtesy Cars"       # Courtesy Cars | Fixmyfile
    client_name: str = ""
    client_contact_id: str = ""
    reg: str = ""
    reference: str = ""
    stage: str = "new enquiry"
    hire_start: str = ""                  # ISO date
    hire_end: str = ""
    signed_authority_at: str = ""
    engagement_signed_at: str = ""
    cancellation_waiver_at: str = ""
    insurer: str = ""
    tp_insurer: str = ""
    summary: str = ""
    notes: str = ""
    contacts: list[Contact] = field(default_factory=list)
    chronology: list[ChronologyEntry] = field(default_factory=list)
    deadlines: list[Deadline] = field(default_factory=list)
    tasks: list[dict] = field(default_factory=list)
    call_ids: list[str] = field(default_factory=list)
    intake: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    # -------------------------------------------------------------- derived
    @property
    def title(self) -> str:
        bits = [b for b in (self.client_name, self.reg, self.reference) if b]
        return " · ".join(bits) or "Untitled file"

    def hire_days(self, today: dt.date | None = None) -> int | None:
        if not self.hire_start:
            return None
        today = today or dt.date.today()
        try:
            start = dt.date.fromisoformat(self.hire_start[:10])
            end = dt.date.fromisoformat(self.hire_end[:10]) if self.hire_end else today
        except ValueError:
            return None
        return (end - start).days + 1

    def next_deadline(self) -> Deadline | None:
        live = [d for d in self.deadlines if not d.done]
        return min(live, key=lambda d: d.due_at) if live else None

    def has_signed_authority(self) -> bool:
        return bool(self.signed_authority_at)

    def summary_for_prompt(self) -> str:
        """Short, stable text cached into the live-card prompt at call start."""
        lines = [f"File: {self.title} ({self.business}) – stage: {self.stage}."]
        if self.insurer or self.tp_insurer:
            lines.append(f"Client insurer: {self.insurer or 'unknown'}; third-party insurer: {self.tp_insurer or 'unknown'}.")
        hd = self.hire_days()
        if hd is not None:
            lines.append(f"Hire running {hd} day(s) since {self.hire_start}.")
        lines.append("Signed authority on file." if self.has_signed_authority() else "NO signed authority on file.")
        nd = self.next_deadline()
        if nd:
            lines.append(f"Next deadline: {nd.kind} – {nd.text or ''} due {nd.due_at} ({nd.days_left()} days).")
        if self.summary:
            lines.append("Summary: " + self.summary.strip())
        if self.intake:
            filled = {k: v for k, v in self.intake.items() if v}
            if filled:
                lines.append("Intake on file: " + "; ".join(f"{k}={v}" for k, v in list(filled.items())[:20]))
        recent = sorted(self.chronology, key=lambda c: c.event_date)[-5:]
        if recent:
            lines.append("Last chronology entries:")
            lines += [f"  {c.event_date}: {c.text}" for c in recent]
        return "\n".join(lines)

    # -------------------------------------------------------------- io
    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "CaseFile":
        known = {f.name for f in fields(cls)}
        data = {k: v for k, v in d.items() if k in known}
        data["contacts"] = [Contact(**{k: v for k, v in c.items() if k in Contact.__dataclass_fields__})
                            for c in d.get("contacts", [])]
        data["chronology"] = [ChronologyEntry(**{k: v for k, v in c.items() if k in ChronologyEntry.__dataclass_fields__})
                              for c in d.get("chronology", [])]
        data["deadlines"] = [Deadline(**{k: v for k, v in c.items() if k in Deadline.__dataclass_fields__})
                             for c in d.get("deadlines", [])]
        return cls(**data)


class FileStore:
    def __init__(self, path: Path | None = None, vault: Vault | None = None):
        self.path = path or (paths.app_data_dir() / "files.cpv")
        self._vault = vault
        self._lock = threading.Lock()
        self._files: dict[str, CaseFile] = {}
        self._load()

    @property
    def vault(self) -> Vault:
        return self._vault or Vault.current()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = self.vault.decrypt_json(self.path.read_bytes())
            self._files = {d["id"]: CaseFile.from_dict(d) for d in data.get("files", [])}
        except Exception:  # noqa: BLE001 - never brick the app on a bad store
            backup = self.path.with_suffix(".corrupt")
            try:
                self.path.replace(backup)
            except OSError:
                pass
            self._files = {}

    def _flush(self) -> None:
        blob = self.vault.encrypt_json({"v": 1, "files": [f.to_dict() for f in self._files.values()]})
        tmp = self.path.with_suffix(".tmp")
        tmp.write_bytes(blob)
        tmp.replace(self.path)

    # -------------------------------------------------------------- CRUD
    def list(self) -> list[CaseFile]:
        return sorted(self._files.values(), key=lambda f: f.updated_at, reverse=True)

    def get(self, file_id: str) -> CaseFile | None:
        return self._files.get(file_id)

    def save(self, f: CaseFile) -> CaseFile:
        with self._lock:
            f.updated_at = time.time()
            self._files[f.id] = f
            self._flush()
        return f

    def delete(self, file_id: str) -> None:
        with self._lock:
            self._files.pop(file_id, None)
            self._flush()

    # -------------------------------------------------------------- lookup
    def search(self, query: str) -> list[CaseFile]:
        q = query.strip().lower()
        if not q:
            return self.list()
        qn = _norm_phone(q)
        out = []
        for f in self._files.values():
            hay = " ".join([f.client_name, f.reg, f.reference, f.insurer, f.tp_insurer, f.summary,
                            " ".join(c.name + " " + c.organisation for c in f.contacts)]).lower()
            phones = [_norm_phone(p) for c in f.contacts for p in c.phone_numbers]
            if q in hay or q.replace(" ", "") in f.reg.replace(" ", "").lower() or \
                    (qn and len(qn) >= 6 and any(qn in p or p in qn for p in phones)):
                out.append(f)
        return sorted(out, key=lambda f: f.updated_at, reverse=True)

    def match_phone(self, number: str) -> tuple[CaseFile, Contact] | None:
        n = _norm_phone(number)
        if len(n) < 6:
            return None
        for f in self.list():
            for c in f.contacts:
                if any(_norm_phone(p) == n for p in c.phone_numbers):
                    return f, c
        return None

    def all_deadlines(self) -> list[tuple[CaseFile, Deadline]]:
        out = [(f, d) for f in self._files.values() for d in f.deadlines if not d.done]
        return sorted(out, key=lambda fd: fd[1].due_at)

"""Encrypted call-history store with retention policy and export."""

from __future__ import annotations

import datetime as dt
import json
import time
from pathlib import Path

from callpilot.core import paths
from callpilot.core.config import PrivacySettings
from callpilot.core.crypto import Vault
from callpilot.core.redact import redact_all


def _redact_record(rec: dict) -> dict:
    rec = json.loads(json.dumps(rec))
    for s in rec.get("segments", []):
        s["text"] = redact_all(s.get("text", ""))
        s["translation"] = redact_all(s.get("translation", ""))
    for k, v in list(rec.get("fields", {}).items()):
        if k in ("caller_phone", "caller_email") and v:
            rec["fields"][k] = redact_all(v)
    return rec


def redact_record(rec: dict) -> dict:
    """A copy of the record with PII redacted (what the store saves when redaction is on)."""
    return _redact_record(rec)


class SessionStore:
    def __init__(self, privacy: PrivacySettings, root: Path | None = None, vault: Vault | None = None):
        self.privacy = privacy
        self.root = root or paths.sessions_dir()
        self._vault = vault

    @property
    def vault(self) -> Vault:
        return self._vault or Vault.current()

    def save(self, record: dict) -> Path | None:
        if not self.privacy.save_sessions:
            return None
        if self.privacy.redact_saved_pii:
            record = _redact_record(record)
        stamp = dt.datetime.fromtimestamp(record.get("started_at", time.time())).strftime("%Y%m%d-%H%M%S")
        name = f"{stamp}-{record.get('hub_id', 'call')}"
        if self.privacy.encrypt_sessions:
            f = self.root / f"{name}.cpv"
            f.write_bytes(self.vault.encrypt_json(record))
        else:
            f = self.root / f"{name}.json"
            f.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
        return f

    def list(self) -> list[Path]:
        return sorted(list(self.root.glob("*.cpv")) + list(self.root.glob("*.json")), reverse=True)

    def load(self, f: Path) -> dict:
        if f.suffix == ".cpv":
            return self.vault.decrypt_json(f.read_bytes())
        return json.loads(f.read_text(encoding="utf-8"))

    def purge_expired(self) -> int:
        days = self.privacy.retention_days
        if days <= 0:
            return 0
        cutoff = time.time() - days * 86400
        n = 0
        for f in self.list():
            if f.stat().st_mtime < cutoff:
                secure_delete(f)
                n += 1
        return n


def secure_delete(f: Path) -> None:
    """Overwrite then unlink (best effort; SSD wear-levelling may keep old blocks)."""
    try:
        size = f.stat().st_size
        with f.open("r+b") as fh:
            fh.write(b"\0" * size)
            fh.flush()
    except OSError:
        pass
    f.unlink(missing_ok=True)


def field_label(key: str, labels: dict | None = None) -> str:
    """The hub's label for an intake field ('Caller full name'), or the key in plain words ('Caller name')."""
    if labels and labels.get(key):
        return labels[key]
    return key.replace("_", " ").strip().capitalize()


def export_text(rec: dict) -> str:
    out = [f"CallPilot transcript – {rec.get('hub_name', '')}",
           f"Started: {dt.datetime.fromtimestamp(rec.get('started_at', 0)):%d/%m/%Y %H:%M:%S}", ""]
    for s in rec.get("segments", []):
        t = dt.datetime.fromtimestamp(s["start"]).strftime("%H:%M:%S")
        who = "You" if s["speaker"] == "agent" else "Caller"
        out.append(f"[{t}] {who}: {s['text']}")
        if s.get("translation"):
            out.append(f"           ↳ {s['translation']}")
    if rec.get("fields"):
        labels = rec.get("field_labels") or {}
        out += ["", "Captured details:"] + [f"  {field_label(k, labels)}: {v}" for k, v in rec["fields"].items() if v]
    summ = rec.get("summary") or {}
    if summ:
        out += ["", "Summary:", f"  {summ.get('summary', '')}"]
        for a in summ.get("next_actions", []) or []:
            out.append(f"  • {a}")
    return "\n".join(out)


def export_srt(rec: dict) -> str:
    segs = rec.get("segments", [])
    if not segs:
        return ""
    t0 = rec.get("started_at", segs[0]["start"])

    def ts(sec: float) -> str:
        sec = max(0.0, sec)
        h, rem = divmod(sec, 3600)
        m, s = divmod(rem, 60)
        return f"{int(h):02}:{int(m):02}:{int(s):02},{int((s % 1) * 1000):03}"

    out = []
    for i, s in enumerate(segs, 1):
        start = s["start"] - t0
        end = (segs[i]["start"] - t0) if i < len(segs) else start + 4
        who = "You" if s["speaker"] == "agent" else "Caller"
        out += [str(i), f"{ts(start)} --> {ts(max(end, start + 0.5))}", f"{who}: {s['text']}", ""]
    return "\n".join(out)

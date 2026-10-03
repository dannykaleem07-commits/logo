"""Wrap-up: one call to the stronger model at hang-up, QA scoring, and the
"as discussed" email that is drafted but can never be sent by this code."""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
import subprocess
import sys
from email.message import EmailMessage
from pathlib import Path

from callpilot.ai.cards import banned_filter
from callpilot.ai.copilot_prompts import WRAPUP_SYSTEM
from callpilot.core import paths

log = logging.getLogger(__name__)


def extract_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return {}
    try:
        val = json.loads(m.group(0))
        return val if isinstance(val, dict) else {}
    except ValueError:
        return {}


def run_wrapup(provider, *, business: str, hub_rules: list[str], status_line: str, call_type: str,
               transcript_rows: list[dict], pins: list[dict], intake: dict, file_summary: str,
               disclosures: dict, banned: list[str], agent_name: str, call_started: float) -> dict:
    """Returns the wrap-up JSON (see WRAPUP_SYSTEM) with banned phrases filtered out."""
    rows = []
    for r in transcript_rows:
        t = dt.datetime.fromtimestamp(r["start"]).strftime("%H:%M:%S")
        who = "US" if r["speaker"] == "agent" else "CALLER"
        rows.append(f"[{r['id']} {t}] {who}: {r['text']}")
    user = (
        f"Business: {business}\nCall type: {call_type or 'unspecified'}\nOperator name: {agent_name or 'the handler'}\n"
        f"Call date: {dt.datetime.fromtimestamp(call_started):%A %d %B %Y}\n"
        f"Status line for the email footer: {status_line}\n\n"
        f"House rules:\n" + "\n".join(f"- {r}" for r in hub_rules) +
        f"\n\nFile summary:\n{file_summary or '(no file attached)'}\n\n"
        f"Intake captured so far: {json.dumps(intake, ensure_ascii=False)}\n"
        f"Disclosures: {json.dumps(disclosures)}\n"
        f"Pins already captured on the call: {json.dumps(pins, ensure_ascii=False)}\n\n"
        f"Transcript (each line is prefixed with its segment id):\n" + "\n".join(rows)
    )
    out = provider.complete(WRAPUP_SYSTEM, [{"role": "user", "content": user}], 16000, fast=False)
    data = extract_json(out) or {"summary": out.strip()}
    # Banned-phrase filter on everything that could leave the building.
    hits: list[str] = []
    for key in ("summary", "file_note"):
        if isinstance(data.get(key), str):
            data[key], h = banned_filter(data[key], banned)
            hits += h
    email = data.get("email") or {}
    for key in ("subject", "body"):
        if isinstance(email.get(key), str):
            email[key], h = banned_filter(email[key], banned)
            hits += h
    data["email"] = email
    if hits:
        data.setdefault("compliance_gaps", []).append("Banned phrases removed from AI output: " + ", ".join(sorted(set(hits))))
    data["qa"] = qa_checklist(data, disclosures, intake)
    return data


def qa_checklist(data: dict, disclosures: dict, intake: dict) -> dict:
    """Post-call QA: scored against the checklist, not vibes."""
    items = {}
    notice = next((v for k, v in disclosures.items() if "record" in k.lower()), None)
    if notice is not None:
        items["Recording notice given"] = bool(notice)
    for k, v in disclosures.items():
        if "record" not in k.lower():
            items[k] = bool(v)
    required = data.get("required_intake_keys") or []
    if required:
        done = sum(1 for k in required if str(intake.get(k, "")).strip())
        items[f"Intake complete ({done}/{len(required)})"] = done == len(required)
    items["Follow-up email drafted"] = bool((data.get("email") or {}).get("body"))
    items["No banned phrases"] = not any("Banned phrases" in g for g in data.get("compliance_gaps", []))
    score = round(100 * sum(items.values()) / max(1, len(items)))
    return {"items": items, "score": score}


# ----------------------------------------------------------------- email delivery (draft only)
class EmailDraft:
    def __init__(self, to: str, subject: str, body: str, status_line: str = "", signature: str = ""):
        self.to = to
        self.subject = subject
        footer = "\n\n" + "\n".join(p for p in (signature.strip(), status_line.strip()) if p)
        self.body = body.rstrip() + (footer if footer.strip() else "")

    def to_eml(self) -> bytes:
        msg = EmailMessage()
        msg["To"] = self.to
        msg["Subject"] = self.subject
        msg["X-Unsent"] = "1"  # Outlook opens it as an editable, unsent message
        msg.set_content(self.body)
        return msg.as_bytes()

    def save_eml(self, directory: Path | None = None) -> Path:
        directory = directory or paths.sub_dir("drafts")
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        p = directory / f"{stamp}-as-discussed.eml"
        p.write_bytes(self.to_eml())
        return p

    def open_in_default_client(self) -> Path:
        p = self.save_eml()
        if sys.platform == "win32":
            import os

            os.startfile(str(p))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p)])
        return p

    def create_outlook_draft(self) -> bool:
        """Put the draft in Outlook's Drafts folder. There is deliberately no Send() anywhere here."""
        if sys.platform != "win32":
            raise OSError("Outlook drafts need Windows with Outlook desktop installed")
        import win32com.client  # type: ignore[import-not-found]

        outlook = win32com.client.Dispatch("Outlook.Application")
        mail = outlook.CreateItem(0)  # olMailItem
        mail.To = self.to
        mail.Subject = self.subject
        mail.Body = self.body
        mail.Save()  # lands in Drafts – the final click is the operator's
        return True

"""Wrap-up screen: summary, pins, chronology, deadlines, tasks and the email draft
side by side. One button saves the lot to the file; nothing saves silently."""

from __future__ import annotations

import datetime as dt
import html
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QCheckBox, QDialog, QDialogButtonBox, QFormLayout, QHBoxLayout, QLabel,
                               QLineEdit, QListWidget, QListWidgetItem, QMessageBox, QPlainTextEdit,
                               QPushButton, QSplitter, QTabWidget, QTextBrowser, QVBoxLayout, QWidget)

from callpilot.ai.wrapup import EmailDraft
from callpilot.core.config import Settings
from callpilot.core.files import CaseFile, ChronologyEntry, Deadline


class WrapUpDialog(QDialog):
    def __init__(self, settings: Settings, record: dict, case_file: CaseFile | None, hub, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Wrap up")
        self.resize(1240, 760)
        self.s = settings
        self.rec = record
        self.file = case_file
        self.hub = hub
        self.summary = record.get("summary") or {}
        self.saved = False
        root = QVBoxLayout(self)
        head = QHBoxLayout()
        title = QLabel(f"Wrap up – {record.get('hub_name', '')}")
        title.setObjectName("title")
        head.addWidget(title)
        head.addStretch()
        qa = self.summary.get("qa") or {}
        if qa:
            badge = QLabel(f"QA {qa.get('score', '–')}/100")
            badge.setObjectName("badge")
            badge.setToolTip("\n".join(f"{'✅' if ok else '❌'} {k}" for k, ok in qa.get("items", {}).items()))
            head.addWidget(badge)
        root.addLayout(head)

        split = QSplitter(Qt.Horizontal)
        root.addWidget(split, 1)

        # ---- left: summary, pins, chronology, deadlines, tasks
        left = QTabWidget()
        self.summary_edit = QPlainTextEdit(self.summary.get("file_note") or self.summary.get("summary", ""))
        left.addTab(self.summary_edit, "File note")
        self.pins_list = self._checklist(
            [(f"[{p.get('kind', '')}] {p.get('value', '')}  —  “{p.get('quote', '')[:120]}”", p)
             for p in self._all_pins()], checked=True)
        left.addTab(self.pins_list, f"Pins ({self.pins_list.count()})")
        self.chron_list = self._checklist(
            [(f"{c.get('event_date', '')}  {c.get('text', '')}", c) for c in self.summary.get("chronology", []) or []],
            checked=True)
        left.addTab(self.chron_list, f"Chronology ({self.chron_list.count()})")
        self.dead_list = self._checklist(
            [(f"{d.get('due_at', '')}  {d.get('kind', '')} – {d.get('text', '')}", d)
             for d in self._all_deadlines()], checked=True)
        left.addTab(self.dead_list, f"Deadlines ({self.dead_list.count()})")
        self.task_list = self._checklist(
            [(f"{t.get('title', '')}  ({t.get('owner', 'us')}{', due ' + t['due_at'] if t.get('due_at') else ''})", t)
             for t in self._all_tasks()], checked=True)
        left.addTab(self.task_list, f"Tasks ({self.task_list.count()})")
        gaps = QTextBrowser()
        gaps.setHtml(self._qa_html())
        left.addTab(gaps, "QA")
        split.addWidget(left)

        # ---- right: email draft
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.addWidget(QLabel("“As discussed” email – drafted, never sent by the app"))
        form = QFormLayout()
        email = self.summary.get("email") or {}
        self.to = QLineEdit(email.get("to", "") or self._guess_to())
        self.subject = QLineEdit(email.get("subject", "") or f"As discussed – {self._ref()}")
        form.addRow("To", self.to)
        form.addRow("Subject", self.subject)
        rl.addLayout(form)
        self.body = QPlainTextEdit(email.get("body", ""))
        rl.addWidget(self.body, 1)
        self.status_line = QLabel(getattr(hub, "status_line", "") or "")
        self.status_line.setObjectName("section")
        self.status_line.setWordWrap(True)
        rl.addWidget(self.status_line)
        btns = QHBoxLayout()
        self.btn_outlook = QPushButton("Create Outlook draft")
        self.btn_eml = QPushButton("Open in mail app (.eml)")
        self.btn_copy = QPushButton("Copy text")
        self.btn_outlook.clicked.connect(self._outlook)
        self.btn_eml.clicked.connect(self._eml)
        self.btn_copy.clicked.connect(self._copy)
        for b in (self.btn_outlook, self.btn_eml, self.btn_copy):
            btns.addWidget(b)
        btns.addStretch()
        rl.addLayout(btns)
        split.addWidget(right)
        split.setSizes([620, 620])

        bottom = QHBoxLayout()
        self.save_to_file = QCheckBox("Save ticked items, file note and confirmed intake to the file")
        self.save_to_file.setChecked(case_file is not None)
        self.save_to_file.setEnabled(case_file is not None)
        bottom.addWidget(self.save_to_file)
        bottom.addStretch()
        bb = QDialogButtonBox()
        self.btn_export = bb.addButton("💾 Save call to computer…", QDialogButtonBox.ActionRole)
        self.btn_export.clicked.connect(self._export)
        self.btn_save = bb.addButton("Save wrap-up", QDialogButtonBox.AcceptRole)
        self.btn_save.setObjectName("primary")
        bb.addButton("Close without saving to file", QDialogButtonBox.RejectRole)
        bb.accepted.connect(self._save)
        bb.rejected.connect(self.reject)
        bottom.addWidget(bb)
        root.addLayout(bottom)

    # ------------------------------------------------------------- helpers
    def _all_pins(self) -> list[dict]:
        seen, out = set(), []
        for p in (self.rec.get("pins", []) or []) + (self.summary.get("pins", []) or []):
            key = (p.get("kind"), str(p.get("value", ""))[:40])
            if key not in seen:
                seen.add(key)
                out.append(p)
        return out

    def _all_tasks(self) -> list[dict]:
        out, seen = [], set()
        for t in (self.summary.get("tasks", []) or []) + (self.rec.get("tasks", []) or []):
            key = str(t.get("title", "")).strip().lower()
            if key and key not in seen:
                seen.add(key)
                out.append(t)
        return out

    def _all_deadlines(self) -> list[dict]:
        out, seen = [], set()
        existing = {(d.due_at[:10], d.text[:40].lower()) for d in (self.file.deadlines if self.file else [])}
        for d in list(self.summary.get("deadlines", []) or []) + [
                {"kind": "reply", "due_at": p["due_at"], "text": p.get("quote", "")[:100], "segment_id": p.get("segment_id", "")}
                for p in (self.rec.get("pins", []) or []) if p.get("kind") == "deadline" and p.get("due_at")]:
            key = (str(d.get("due_at", ""))[:10], str(d.get("text", ""))[:40].lower())
            if key in seen or key in existing or not d.get("due_at"):
                continue
            # same due date already listed with different wording -> keep the first only
            if any(k[0] == key[0] for k in seen):
                continue
            seen.add(key)
            out.append(d)
        return out

    def _checklist(self, items, checked=True) -> QListWidget:
        lst = QListWidget()
        for label, data in items:
            it = QListWidgetItem(label)
            it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
            it.setCheckState(Qt.Checked if checked else Qt.Unchecked)
            it.setData(Qt.UserRole, data)
            lst.addItem(it)
        return lst

    @staticmethod
    def _ticked(lst: QListWidget) -> list[dict]:
        return [lst.item(i).data(Qt.UserRole) for i in range(lst.count()) if lst.item(i).checkState() == Qt.Checked]

    def _ref(self) -> str:
        return (self.file.reference or self.file.reg) if self.file else dt.datetime.now().strftime("%d/%m/%Y")

    def _guess_to(self) -> str:
        if not self.file:
            return ""
        for c in self.file.contacts:
            if c.email and c.role != "client":
                return c.email
        return next((c.email for c in self.file.contacts if c.email), "")

    def _qa_html(self) -> str:
        qa = self.summary.get("qa") or {}
        rows = [f"<h3>Post-call QA – {qa.get('score', '–')}/100</h3>"]
        rows += [f"<div>{'✅' if ok else '❌'} {html.escape(k)}</div>" for k, ok in (qa.get("items") or {}).items()]
        for key, title in (("compliance_gaps", "Compliance gaps"),):
            vals = self.summary.get(key) or []
            if vals:
                rows.append(f"<h4>{title}</h4><ul>" + "".join(f"<li>{html.escape(str(v))}</li>" for v in vals) + "</ul>")
        if self.summary.get("coaching_tip"):
            rows.append(f"<p><b>Coaching tip:</b> {html.escape(self.summary['coaching_tip'])}</p>")
        if self.summary.get("vulnerability"):
            rows.append(f"<p><b>Vulnerability:</b> {html.escape(self.summary['vulnerability'])}</p>")
        if self.summary.get("error"):
            rows.append(f"<p style='color:#EF4444'>Wrap-up AI error: {html.escape(self.summary['error'])}</p>")
        return "".join(rows)

    def _draft(self) -> EmailDraft:
        return EmailDraft(self.to.text().strip(), self.subject.text().strip(), self.body.toPlainText(),
                          status_line=getattr(self.hub, "status_line", "") or "",
                          signature=self.s.email.signature or self.s.agent_name)

    def _outlook(self):
        try:
            self._draft().create_outlook_draft()
            QMessageBox.information(self, "Outlook", "Draft created in Outlook → Drafts. Nothing has been sent.")
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, "Outlook", f"Could not create the Outlook draft ({e}).\n"
                                                 "Use “Open in mail app” instead.")

    def _eml(self):
        try:
            p = self._draft().open_in_default_client()
            QMessageBox.information(self, "Draft", f"Opened {p.name} in your mail app as an unsent message.")
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, "Draft", str(e))

    def _copy(self):
        from PySide6.QtWidgets import QApplication

        d = self._draft()
        QApplication.clipboard().setText(f"To: {d.to}\nSubject: {d.subject}\n\n{d.body}")

    # ------------------------------------------------------------- save
    def result_payload(self) -> dict:
        return {
            "file_note": self.summary_edit.toPlainText(),
            "pins": self._ticked(self.pins_list),
            "chronology": self._ticked(self.chron_list),
            "deadlines": self._ticked(self.dead_list),
            "tasks": self._ticked(self.task_list),
            "email": {"to": self.to.text(), "subject": self.subject.text(), "body": self.body.toPlainText()},
        }

    def apply_to_file(self, f: CaseFile, call_id: str, confirmed_intake: dict) -> None:
        payload = self.result_payload()
        today = dt.date.today().isoformat()
        chron_texts = []
        for c in payload["chronology"]:
            if c.get("text", "").strip():
                f.chronology.append(ChronologyEntry(c.get("event_date") or today, c.get("text", ""), "call", call_id))
                chron_texts.append(c["text"].lower())
        for p in payload["pins"]:
            val = str(p.get("value", "")).strip()
            if p.get("kind") in ("commitment", "admission", "allegation", "deadline", "figure") and val \
                    and not any(val.lower() in t for t in chron_texts):
                f.chronology.append(ChronologyEntry(today, f"[{p['kind']}] {val} – “{p.get('quote', '')[:160]}”",
                                                    "call", call_id))
        for d in payload["deadlines"]:
            if d.get("due_at"):
                f.deadlines.append(Deadline(d.get("kind", "other"), d["due_at"], d.get("text", ""), call_id))
        seen_tasks = {t.get("title", "").strip().lower() for t in f.tasks}
        for t in payload["tasks"]:
            title = str(t.get("title", "")).strip()
            if title and title.lower() not in seen_tasks:
                seen_tasks.add(title.lower())
                f.tasks.append({"title": title, "owner": t.get("owner", "us"), "due_at": t.get("due_at", ""),
                                "source_call_id": call_id, "done": False})
        if payload["file_note"].strip():
            f.chronology.append(ChronologyEntry(today, "Call note: " + payload["file_note"].strip()[:1500], "call", call_id))
            new = (self.summary.get("summary") or "").strip()
            if new:
                f.summary = (f"{today}: {new}\n" + f.summary)[:2000]  # running summary, newest first
        for k, v in confirmed_intake.items():
            if v:
                f.intake[k] = v
        if call_id not in f.call_ids:
            f.call_ids.append(call_id)

    def _export(self):
        from PySide6.QtWidgets import QFileDialog

        from callpilot.core.export import default_export_dir, export_call

        d = QFileDialog.getExistingDirectory(self, "Save call to…", str(default_export_dir()))
        if d:
            rec = dict(self.rec)
            rec["wrapup"] = self.result_payload()
            folder = export_call(rec, Path(d))
            QMessageBox.information(self, "Saved", f"Transcript, summary, pins and email draft saved to:\n{folder}")

    def _save(self):
        self.saved = True
        self.accept()

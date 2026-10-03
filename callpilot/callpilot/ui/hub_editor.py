"""Call-hub editor: train a hub with persona, rules, Q&A, documents and capture fields."""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (QAbstractItemView, QCheckBox, QDialog, QDialogButtonBox, QFileDialog,
                               QFormLayout, QHBoxLayout, QHeaderView, QLabel, QLineEdit, QListWidget,
                               QMessageBox, QPlainTextEdit, QPushButton, QTableWidget, QTableWidgetItem,
                               QTabWidget, QVBoxLayout, QWidget)

from callpilot.hubs.model import CaptureField, Hub, parse_qa_csv, read_document

QA_GEN_SYSTEM = """You build call-centre answer banks. From the company knowledge provided, write the
questions callers most often ask and an approved, compliant, spoken answer for each (2-3 short sentences,
first person as the agent, British English, no guarantees, never say "free").
Return ONLY a JSON array of objects: [{"q": "...", "a": "..."}]. Produce 15-30 pairs."""


def _lines(text: str) -> list[str]:
    return [ln.strip(" -•\t") for ln in text.splitlines() if ln.strip(" -•\t")]


class HubEditor(QDialog):
    _qa_ready = Signal(list, str)

    def __init__(self, hub: Hub, provider_factory=None, parent=None):
        super().__init__(parent)
        self.setWindowTitle(f"Call hub – {hub.name}")
        self.resize(980, 720)
        self.hub = hub
        self.provider_factory = provider_factory
        self.documents = list(hub.documents)
        root = QVBoxLayout(self)
        tabs = QTabWidget()
        root.addWidget(tabs)

        # ---------------- general
        g = QWidget()
        gf = QFormLayout(g)
        self.name = QLineEdit(hub.name)
        self.company = QLineEdit(hub.company)
        self.description = QLineEdit(hub.description)
        self.persona = QPlainTextEdit(hub.persona)
        self.tone = QPlainTextEdit(hub.tone)
        self.greeting = QPlainTextEdit(hub.greeting)
        self.closing = QPlainTextEdit(hub.closing)
        self.consent = QPlainTextEdit(hub.consent_script)
        for w in (self.tone, self.greeting, self.closing, self.consent):
            w.setMaximumHeight(70)
        gf.addRow("Hub name", self.name)
        gf.addRow("Company name", self.company)
        gf.addRow("Description", self.description)
        gf.addRow("Who the agent is / goal of calls", self.persona)
        gf.addRow("Tone of voice", self.tone)
        gf.addRow("Opening script", self.greeting)
        gf.addRow("Closing script", self.closing)
        gf.addRow("Recording / consent notice", self.consent)
        self.status_line = QLineEdit(hub.status_line)
        self.status_line.setPlaceholderText("Footer on every email draft, e.g. 'Paralegal services. Not a firm of solicitors.'")
        gf.addRow("Status line (email footer)", self.status_line)
        tabs.addTab(g, "General")

        # ---------------- call types
        ctw = QWidget()
        ctl = QVBoxLayout(ctw)
        ctl.addWidget(QLabel("Instructions the AI gets for each call type (new accident, handler, engineer, bodyshop, "
                             "client chase, council). One block per type: 'key: instructions'."))
        self.call_types = QPlainTextEdit("\n\n".join(f"{k}: {v}" for k, v in hub.call_types.items()))
        ctl.addWidget(self.call_types)
        tabs.addTab(ctw, "Call types")

        # ---------------- scripts
        scw = QWidget()
        scl = QVBoxLayout(scw)
        scl.addWidget(QLabel("Scripts you read out on this type of call (opening and closing come from General). "
                             "One script per block: a title line, then the text. Blank line between scripts."))
        self.scripts_edit = QPlainTextEdit("\n\n".join(f"{sc.get('title', '')}\n{sc.get('text', '')}" for sc in hub.scripts))
        scl.addWidget(self.scripts_edit)
        tabs.addTab(scw, f"Scripts ({len(hub.scripts)})")

        # ---------------- rules
        r = QWidget()
        rf = QFormLayout(r)
        self.rules = QPlainTextEdit("\n".join(hub.rules))
        self.forbidden = QPlainTextEdit("\n".join(hub.forbidden_phrases))
        self.disclosures = QPlainTextEdit("\n".join(hub.required_disclosures))
        self.escalations = QPlainTextEdit("\n".join(hub.escalation_triggers))
        self.fillers = QPlainTextEdit("\n".join(hub.fillers))
        rf.addRow(QLabel("One item per line."))
        rf.addRow("Rules the AI must follow", self.rules)
        rf.addRow("Banned phrases (alert if you say them)", self.forbidden)
        rf.addRow("Mandatory disclosures (checklist)", self.disclosures)
        rf.addRow("Escalation keywords (alert if caller says them)", self.escalations)
        rf.addRow("House filler phrases", self.fillers)
        tabs.addTab(r, "Rules && compliance")

        # ---------------- Q&A
        q = QWidget()
        ql = QVBoxLayout(q)
        ql.addWidget(QLabel("Approved answers appear instantly (no AI wait) when the caller asks something "
                            "similar, and guide the AI's wording for everything else."))
        self.qa = QTableWidget(0, 2)
        self.qa.setHorizontalHeaderLabels(["Caller asks…", "Approved answer"])
        self.qa.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.qa.setWordWrap(True)
        self.qa.setSelectionBehavior(QAbstractItemView.SelectRows)
        for p in hub.qa:
            self._add_qa(p.get("q", ""), p.get("a", ""))
        ql.addWidget(self.qa)
        row = QHBoxLayout()
        for label, slot in (("+ Add", lambda: self._add_qa("", "")), ("− Remove", self._remove_qa),
                            ("Import CSV…", self._import_qa_csv),
                            ("✨ Generate from knowledge with AI", self._generate_qa)):
            b = QPushButton(label)
            b.clicked.connect(slot)
            row.addWidget(b)
        row.addStretch()
        ql.addLayout(row)
        tabs.addTab(q, f"Q&&A ({len(hub.qa)})")

        # ---------------- knowledge
        k = QWidget()
        kl = QVBoxLayout(k)
        kl.addWidget(QLabel("Policies, procedures, price lists, scripts, FAQs… Paste text below or import "
                            "PDF / Word / text files. Everything is searched live during calls."))
        self.knowledge = QPlainTextEdit(hub.knowledge)
        kl.addWidget(self.knowledge, 2)
        kl.addWidget(QLabel("Imported documents"))
        self.docs = QListWidget()
        kl.addWidget(self.docs, 1)
        self._refresh_docs()
        row = QHBoxLayout()
        imp = QPushButton("Import documents…")
        rm = QPushButton("Remove selected")
        imp.clicked.connect(self._import_docs)
        rm.clicked.connect(self._remove_doc)
        row.addWidget(imp)
        row.addWidget(rm)
        row.addStretch()
        kl.addLayout(row)
        tabs.addTab(k, "Knowledge")

        # ---------------- fields
        fw = QWidget()
        fl = QVBoxLayout(fw)
        fl.addWidget(QLabel("Details the AI listens for and fills in automatically during the call."))
        self.fields = QTableWidget(0, 4)
        self.fields.setHorizontalHeaderLabels(["Key", "Label", "Hint", "Required"])
        self.fields.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        for cf in hub.capture_fields:
            self._add_field(cf)
        fl.addWidget(self.fields)
        row = QHBoxLayout()
        add = QPushButton("+ Add field")
        rem = QPushButton("− Remove")
        add.clicked.connect(lambda: self._add_field(CaptureField("", "")))
        rem.clicked.connect(lambda: self.fields.removeRow(self.fields.currentRow()))
        row.addWidget(add)
        row.addWidget(rem)
        row.addStretch()
        fl.addLayout(row)
        tabs.addTab(fw, "Capture fields")

        bb = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        bb.accepted.connect(self._save)
        bb.rejected.connect(self.reject)
        root.addWidget(bb)
        self._qa_ready.connect(self._on_qa_ready)

    # ------------------------------------------------------------- Q&A helpers
    def _add_qa(self, q: str, a: str) -> None:
        r = self.qa.rowCount()
        self.qa.insertRow(r)
        self.qa.setItem(r, 0, QTableWidgetItem(q))
        self.qa.setItem(r, 1, QTableWidgetItem(a))

    def _remove_qa(self):
        rows = sorted({i.row() for i in self.qa.selectedIndexes()}, reverse=True)
        for r in rows:
            self.qa.removeRow(r)

    def _import_qa_csv(self):
        f, _ = QFileDialog.getOpenFileName(self, "Import Q&A CSV", "", "CSV (*.csv)")
        if f:
            for p in parse_qa_csv(Path(f).read_text(encoding="utf-8", errors="replace")):
                self._add_qa(p["q"], p["a"])

    def _generate_qa(self):
        if not self.provider_factory:
            return
        text = self.knowledge.toPlainText() + "\n\n" + "\n\n".join(d["text"] for d in self.documents)
        if len(text.strip()) < 200:
            QMessageBox.information(self, "Generate Q&A", "Add some knowledge text or documents first.")
            return
        company = self.company.text()

        def run():
            try:
                p = self.provider_factory()
                out = p.complete(QA_GEN_SYSTEM, [{"role": "user", "content":
                                                  f"Company: {company}\n\nKnowledge:\n{text[:300000]}"}],
                                 16000, fast=False)
                m = re.search(r"\[.*\]", out, re.S)
                pairs = json.loads(m.group(0)) if m else []
                self._qa_ready.emit([p for p in pairs if isinstance(p, dict)], "")
            except Exception as e:  # noqa: BLE001
                self._qa_ready.emit([], str(e))

        threading.Thread(target=run, daemon=True).start()
        QMessageBox.information(self, "Generate Q&A", "Generating… new rows will appear in the table shortly. "
                                "Review every answer before saving.")

    def _on_qa_ready(self, pairs: list, err: str):
        if err:
            QMessageBox.warning(self, "Generate Q&A", f"Failed: {err}")
            return
        for p in pairs:
            self._add_qa(str(p.get("q", "")), str(p.get("a", "")))

    # ------------------------------------------------------------- docs
    def _refresh_docs(self):
        self.docs.clear()
        for d in self.documents:
            self.docs.addItem(f"{d['name']}  ({len(d['text']):,} chars)")

    def _import_docs(self):
        files, _ = QFileDialog.getOpenFileNames(self, "Import documents", "",
                                                "Documents (*.pdf *.docx *.txt *.md *.csv)")
        errors = []
        for f in files:
            try:
                text = read_document(Path(f))
                if text.strip():
                    self.documents.append({"name": Path(f).name, "text": text})
            except Exception as e:  # noqa: BLE001
                errors.append(f"{Path(f).name}: {e}")
        self._refresh_docs()
        if errors:
            QMessageBox.warning(self, "Import", "\n".join(errors))

    def _remove_doc(self):
        r = self.docs.currentRow()
        if r >= 0:
            del self.documents[r]
            self._refresh_docs()

    # ------------------------------------------------------------- fields
    def _add_field(self, cf: CaptureField):
        r = self.fields.rowCount()
        self.fields.insertRow(r)
        self.fields.setItem(r, 0, QTableWidgetItem(cf.key))
        self.fields.setItem(r, 1, QTableWidgetItem(cf.label))
        self.fields.setItem(r, 2, QTableWidgetItem(cf.hint))
        chk = QCheckBox()
        chk.setChecked(cf.required)
        self.fields.setCellWidget(r, 3, chk)

    # ------------------------------------------------------------- save
    def _save(self):
        h = self.hub
        h.name = self.name.text().strip() or h.name
        h.company = self.company.text().strip()
        h.description = self.description.text().strip()
        h.persona = self.persona.toPlainText().strip()
        h.tone = self.tone.toPlainText().strip()
        h.greeting = self.greeting.toPlainText().strip()
        h.closing = self.closing.toPlainText().strip()
        h.consent_script = self.consent.toPlainText().strip()
        h.status_line = self.status_line.text().strip()
        cts = {}
        for block in re.split(r"\n\s*\n", self.call_types.toPlainText()):
            m = re.match(r"\s*([a-z_]+)\s*:\s*(.+)", block.strip(), re.S)
            if m:
                cts[m.group(1)] = m.group(2).strip()
        h.call_types = cts
        scripts = []
        for block in re.split(r"\n\s*\n", self.scripts_edit.toPlainText()):
            lines = [ln for ln in block.strip().splitlines() if ln.strip()]
            if len(lines) >= 2:
                scripts.append({"title": lines[0].strip(), "text": " ".join(ln.strip() for ln in lines[1:]), "when": ""})
        h.scripts = scripts
        h.rules = _lines(self.rules.toPlainText())
        h.forbidden_phrases = _lines(self.forbidden.toPlainText())
        h.required_disclosures = _lines(self.disclosures.toPlainText())
        h.escalation_triggers = _lines(self.escalations.toPlainText())
        h.fillers = _lines(self.fillers.toPlainText())
        qa = []
        for r in range(self.qa.rowCount()):
            q = (self.qa.item(r, 0).text() if self.qa.item(r, 0) else "").strip()
            a = (self.qa.item(r, 1).text() if self.qa.item(r, 1) else "").strip()
            if q and a:
                qa.append({"q": q, "a": a})
        h.qa = qa
        h.knowledge = self.knowledge.toPlainText()
        h.documents = self.documents
        fields = []
        for r in range(self.fields.rowCount()):
            label = (self.fields.item(r, 1).text() if self.fields.item(r, 1) else "").strip()
            if not label:
                continue
            key = (self.fields.item(r, 0).text() if self.fields.item(r, 0) else "").strip()
            key = key or re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
            hint = (self.fields.item(r, 2).text() if self.fields.item(r, 2) else "").strip()
            fields.append(CaptureField(key, label, hint, self.fields.cellWidget(r, 3).isChecked()))
        h.capture_fields = fields
        h.version += 1
        self.accept()

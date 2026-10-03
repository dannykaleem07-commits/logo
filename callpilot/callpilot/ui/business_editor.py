"""Business profile editor: the rules, status line and scripts that apply to every call
the business takes, plus the list of its call hubs."""

from __future__ import annotations

from PySide6.QtWidgets import (QDialog, QDialogButtonBox, QFormLayout, QHBoxLayout, QHeaderView, QInputDialog,
                               QLabel, QLineEdit, QListWidget, QPlainTextEdit, QPushButton, QTableWidget,
                               QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget)

from callpilot.core.business import Business, BusinessStore, Script
from callpilot.hubs.model import Hub, HubStore


def _lines(text: str) -> list[str]:
    return [ln.strip(" -•\t") for ln in text.splitlines() if ln.strip(" -•\t")]


class BusinessEditor(QDialog):
    def __init__(self, business: Business, bstore: BusinessStore, hstore: HubStore, parent=None,
                 open_hub_editor=None):
        super().__init__(parent)
        self.setWindowTitle(f"Business profile – {business.name}")
        self.resize(900, 680)
        self.b = business
        self.bstore = bstore
        self.hstore = hstore
        self.open_hub_editor = open_hub_editor
        root = QVBoxLayout(self)
        intro = QLabel("Business profile → Call hubs → Calls.  Everything here applies to every hub and every call "
                       "this business takes. Hub-specific answers and intake live in each hub.")
        intro.setWordWrap(True)
        intro.setObjectName("hint")
        root.addWidget(intro)
        tabs = QTabWidget()
        root.addWidget(tabs, 1)

        g = QWidget()
        f = QFormLayout(g)
        self.name = QLineEdit(business.name)
        self.tagline = QLineEdit(business.tagline)
        self.website = QLineEdit(business.website)
        self.status = QPlainTextEdit(business.status_line)
        self.status.setMaximumHeight(70)
        self.status.setPlaceholderText("e.g. 'Fixmyfile provides paralegal and dispute services. Not a firm of solicitors.'")
        self.phone = QLineEdit(business.phone)
        self.email = QLineEdit(business.email)
        self.signature = QPlainTextEdit(business.email_signature)
        self.signature.setMaximumHeight(90)
        for label, w in (("Business name", self.name), ("One-line description", self.tagline), ("Website", self.website),
                         ("Status line (said when asked who you are; email footer)", self.status),
                         ("Phone", self.phone), ("Email", self.email), ("Email signature", self.signature)):
            f.addRow(label, w)
        tabs.addTab(g, "Profile")

        r = QWidget()
        rf = QFormLayout(r)
        rf.addRow(QLabel("One per line. These apply to every hub of this business."))
        self.rules = QPlainTextEdit("\n".join(business.rules))
        self.banned = QPlainTextEdit("\n".join(business.banned_phrases))
        rf.addRow("Rules the AI must follow", self.rules)
        rf.addRow("Banned phrases (alert if you say them; filtered from AI output)", self.banned)
        tabs.addTab(r, "Rules")

        sw = QWidget()
        sl = QVBoxLayout(sw)
        sl.addWidget(QLabel("Scripts you read out on calls. They appear in the Scripts panel during a call and the "
                            "AI employee uses them in AI mode. 'When' can be opening, consent, terms, closing or blank."))
        self.scripts = QTableWidget(0, 3)
        self.scripts.setHorizontalHeaderLabels(["Title", "When", "Text"])
        self.scripts.horizontalHeader().setSectionResizeMode(2, QHeaderView.Stretch)
        self.scripts.setWordWrap(True)
        for s in business.scripts:
            self._add_script(s)
        sl.addWidget(self.scripts, 1)
        row = QHBoxLayout()
        add = QPushButton("+ Script")
        rem = QPushButton("− Remove")
        add.clicked.connect(lambda: self._add_script(Script("", "", "")))
        rem.clicked.connect(lambda: self.scripts.removeRow(self.scripts.currentRow()))
        row.addWidget(add)
        row.addWidget(rem)
        row.addStretch()
        sl.addLayout(row)
        tabs.addTab(sw, f"Scripts ({len(business.scripts)})")

        hw = QWidget()
        hl = QVBoxLayout(hw)
        hl.addWidget(QLabel("Call hubs under this business – each one is a call type with its own answers, "
                            "knowledge, intake fields and scripts."))
        self.hubs = QListWidget()
        hl.addWidget(self.hubs, 1)
        row = QHBoxLayout()
        edit = QPushButton("Edit / train hub…")
        new = QPushButton("+ New hub…")
        edit.clicked.connect(self._edit_hub)
        new.clicked.connect(self._new_hub)
        row.addWidget(edit)
        row.addWidget(new)
        row.addStretch()
        hl.addLayout(row)
        tabs.addTab(hw, "Call hubs")
        self._refresh_hubs()

        bb = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        bb.accepted.connect(self._save)
        bb.rejected.connect(self.reject)
        root.addWidget(bb)

    def _add_script(self, s: Script):
        r = self.scripts.rowCount()
        self.scripts.insertRow(r)
        self.scripts.setItem(r, 0, QTableWidgetItem(s.title))
        self.scripts.setItem(r, 1, QTableWidgetItem(s.when))
        self.scripts.setItem(r, 2, QTableWidgetItem(s.text))
        self.scripts.setRowHeight(r, 70)

    def _refresh_hubs(self):
        self.hubs.clear()
        self._hub_ids = []
        for h in self.hstore.list():
            if h.business_id == self.b.id:
                self.hubs.addItem(f"{h.name}  ·  {len(h.qa)} answers · {len(h.capture_fields)} intake fields")
                self._hub_ids.append(h.id)

    def _edit_hub(self):
        r = self.hubs.currentRow()
        if r < 0 or not self.open_hub_editor:
            return
        hub = self.hstore.get(self._hub_ids[r])
        if hub and self.open_hub_editor(hub):
            self._refresh_hubs()

    def _new_hub(self):
        name, ok = QInputDialog.getText(self, "New call hub", "Call type / hub name (e.g. 'CCJ removal'):")
        if ok and name.strip():
            hub: Hub = self.hstore.new(f"{self.b.name} – {name.strip()}")
            hub.company = self.b.name
            hub.business_id = self.b.id
            hub.status_line = self.b.status_line
            self.hstore.save(hub)
            self._refresh_hubs()
            if self.open_hub_editor:
                self.open_hub_editor(hub)
                self._refresh_hubs()

    def _save(self):
        b = self.b
        b.name = self.name.text().strip() or b.name
        b.tagline = self.tagline.text().strip()
        b.website = self.website.text().strip()
        b.status_line = self.status.toPlainText().strip()
        b.phone = self.phone.text().strip()
        b.email = self.email.text().strip()
        b.email_signature = self.signature.toPlainText().strip()
        b.rules = _lines(self.rules.toPlainText())
        b.banned_phrases = _lines(self.banned.toPlainText())
        scripts = []
        for r in range(self.scripts.rowCount()):
            title = (self.scripts.item(r, 0).text() if self.scripts.item(r, 0) else "").strip()
            when = (self.scripts.item(r, 1).text() if self.scripts.item(r, 1) else "").strip()
            text = (self.scripts.item(r, 2).text() if self.scripts.item(r, 2) else "").strip()
            if title and text:
                scripts.append(Script(title, text, when))
        b.scripts = scripts
        b.version += 1
        self.bstore.save(b)
        self.accept()

"""Find, create or edit a case file; pick one to attach to the call."""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QComboBox, QDialog, QDialogButtonBox, QFormLayout, QHBoxLayout, QHeaderView,
                               QLabel, QLineEdit, QListWidget, QListWidgetItem, QPlainTextEdit, QPushButton,
                               QSplitter, QTableWidget, QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget)

from callpilot.core.files import ROLES, STAGES, CaseFile, Contact, Deadline, FileStore


class FilePicker(QDialog):
    def __init__(self, store: FileStore, parent=None, query: str = ""):
        super().__init__(parent)
        self.setWindowTitle("Attach a file to this call")
        self.resize(900, 560)
        self.store = store
        self.selected: CaseFile | None = None
        root = QVBoxLayout(self)
        row = QHBoxLayout()
        self.search = QLineEdit(query)
        self.search.setPlaceholderText("Search name, reg, reference, insurer or paste the caller's number…")
        self.search.textChanged.connect(self._refresh)
        new = QPushButton("+ New file")
        new.clicked.connect(self._new)
        row.addWidget(self.search, 1)
        row.addWidget(new)
        root.addLayout(row)
        split = QSplitter()
        self.list = QListWidget()
        self.list.currentRowChanged.connect(self._preview)
        self.list.itemDoubleClicked.connect(lambda _: self._accept())
        self.preview = QLabel("")
        self.preview.setWordWrap(True)
        self.preview.setAlignment(Qt.AlignTop)
        self.preview.setObjectName("chip")
        split.addWidget(self.list)
        split.addWidget(self.preview)
        split.setSizes([420, 460])
        root.addWidget(split, 1)
        bb = QDialogButtonBox()
        self.btn_edit = bb.addButton("Edit file…", QDialogButtonBox.ActionRole)
        self.btn_attach = bb.addButton("Attach", QDialogButtonBox.AcceptRole)
        bb.addButton("No file (new enquiry)", QDialogButtonBox.RejectRole)
        self.btn_edit.clicked.connect(self._edit)
        bb.accepted.connect(self._accept)
        bb.rejected.connect(self.reject)
        root.addWidget(bb)
        self.files: list[CaseFile] = []
        self._refresh()

    def _refresh(self):
        q = self.search.text()
        self.files = self.store.search(q)
        self.list.clear()
        m = self.store.match_phone(q) if q else None
        for f in self.files:
            tag = "  📞 number matches" if m and m[0].id == f.id else ""
            self.list.addItem(QListWidgetItem(f"{f.title}  ·  {f.stage}{tag}"))
        if self.files:
            self.list.setCurrentRow(0)
        else:
            self.preview.setText("No matching file. Create one, or continue without a file.")

    def _preview(self, row: int):
        if 0 <= row < len(self.files):
            self.preview.setText(self.files[row].summary_for_prompt())

    def _current(self) -> CaseFile | None:
        r = self.list.currentRow()
        return self.files[r] if 0 <= r < len(self.files) else None

    def _accept(self):
        self.selected = self._current()
        if self.selected:
            self.accept()

    def _new(self):
        f = CaseFile()
        dlg = FileEditor(f, self)
        if dlg.exec():
            self.store.save(dlg.file)
            self.search.setText(dlg.file.client_name)
            self._refresh()

    def _edit(self):
        f = self._current()
        if f:
            dlg = FileEditor(f, self)
            if dlg.exec():
                self.store.save(dlg.file)
                self._refresh()


class FileEditor(QDialog):
    def __init__(self, f: CaseFile, parent=None):
        super().__init__(parent)
        self.setWindowTitle("File")
        self.resize(820, 620)
        self.file = f
        root = QVBoxLayout(self)
        tabs = QTabWidget()
        root.addWidget(tabs)

        g = QWidget()
        form = QFormLayout(g)
        self.business = QComboBox()
        self.business.addItems(["Courtesy Cars", "Fixmyfile"])
        self.business.setCurrentText(f.business)
        self.client = QLineEdit(f.client_name)
        self.reg = QLineEdit(f.reg)
        self.reference = QLineEdit(f.reference)
        self.stage = QComboBox()
        self.stage.addItems(STAGES)
        self.stage.setCurrentText(f.stage)
        self.hire_start = QLineEdit(f.hire_start)
        self.hire_start.setPlaceholderText("YYYY-MM-DD")
        self.hire_end = QLineEdit(f.hire_end)
        self.authority = QLineEdit(f.signed_authority_at)
        self.authority.setPlaceholderText("YYYY-MM-DD – empty = NOT on file")
        self.engagement = QLineEdit(f.engagement_signed_at)
        self.waiver = QLineEdit(f.cancellation_waiver_at)
        self.insurer = QLineEdit(f.insurer)
        self.tp_insurer = QLineEdit(f.tp_insurer)
        self.summary = QPlainTextEdit(f.summary)
        self.summary.setMaximumHeight(120)
        for label, w in (("Business", self.business), ("Client", self.client), ("Registration", self.reg),
                         ("Reference", self.reference), ("Stage", self.stage), ("Hire start", self.hire_start),
                         ("Hire end", self.hire_end), ("Signed authority date", self.authority),
                         ("Engagement signed", self.engagement), ("Cancellation waiver", self.waiver),
                         ("Client insurer", self.insurer), ("Third-party insurer", self.tp_insurer),
                         ("Summary", self.summary)):
            form.addRow(label, w)
        tabs.addTab(g, "File")

        c = QWidget()
        cl = QVBoxLayout(c)
        self.contacts = QTableWidget(0, 5)
        self.contacts.setHorizontalHeaderLabels(["Name", "Role", "Organisation", "Phone numbers (comma)", "Email"])
        self.contacts.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        for ct in f.contacts:
            self._add_contact(ct)
        cl.addWidget(self.contacts)
        row = QHBoxLayout()
        add = QPushButton("+ Contact")
        rem = QPushButton("− Remove")
        add.clicked.connect(lambda: self._add_contact(Contact("", "client")))
        rem.clicked.connect(lambda: self.contacts.removeRow(self.contacts.currentRow()))
        row.addWidget(add)
        row.addWidget(rem)
        row.addStretch()
        cl.addLayout(row)
        tabs.addTab(c, "Contacts")

        d = QWidget()
        dl = QVBoxLayout(d)
        self.deadlines = QTableWidget(0, 3)
        self.deadlines.setHorizontalHeaderLabels(["Due (YYYY-MM-DD)", "Kind", "What"])
        self.deadlines.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        for dd in f.deadlines:
            if not dd.done:
                self._add_deadline(dd)
        dl.addWidget(self.deadlines)
        row = QHBoxLayout()
        add = QPushButton("+ Deadline")
        rem = QPushButton("− Done / remove")
        add.clicked.connect(lambda: self._add_deadline(Deadline("reply", "", "")))
        rem.clicked.connect(lambda: self.deadlines.removeRow(self.deadlines.currentRow()))
        row.addWidget(add)
        row.addWidget(rem)
        row.addStretch()
        dl.addLayout(row)
        tabs.addTab(d, "Deadlines")

        ch = QPlainTextEdit("\n".join(f"{c.event_date}  {c.text}" for c in sorted(f.chronology, key=lambda c: c.event_date)))
        ch.setReadOnly(True)
        tabs.addTab(ch, f"Chronology ({len(f.chronology)})")

        bb = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        bb.accepted.connect(self._save)
        bb.rejected.connect(self.reject)
        root.addWidget(bb)

    def _add_contact(self, ct: Contact):
        r = self.contacts.rowCount()
        self.contacts.insertRow(r)
        self.contacts.setItem(r, 0, QTableWidgetItem(ct.name))
        role = QComboBox()
        role.addItems(ROLES)
        role.setCurrentText(ct.role)
        self.contacts.setCellWidget(r, 1, role)
        self.contacts.setItem(r, 2, QTableWidgetItem(ct.organisation))
        self.contacts.setItem(r, 3, QTableWidgetItem(", ".join(ct.phone_numbers)))
        self.contacts.setItem(r, 4, QTableWidgetItem(ct.email))

    def _add_deadline(self, dd: Deadline):
        r = self.deadlines.rowCount()
        self.deadlines.insertRow(r)
        self.deadlines.setItem(r, 0, QTableWidgetItem(dd.due_at))
        self.deadlines.setItem(r, 1, QTableWidgetItem(dd.kind))
        self.deadlines.setItem(r, 2, QTableWidgetItem(dd.text))

    def _cell(self, table, r, c) -> str:
        it = table.item(r, c)
        return it.text().strip() if it else ""

    def _save(self):
        f = self.file
        f.business = self.business.currentText()
        f.client_name = self.client.text().strip()
        f.reg = self.reg.text().strip().upper()
        f.reference = self.reference.text().strip()
        f.stage = self.stage.currentText()
        f.hire_start = self.hire_start.text().strip()
        f.hire_end = self.hire_end.text().strip()
        f.signed_authority_at = self.authority.text().strip()
        f.engagement_signed_at = self.engagement.text().strip()
        f.cancellation_waiver_at = self.waiver.text().strip()
        f.insurer = self.insurer.text().strip()
        f.tp_insurer = self.tp_insurer.text().strip()
        f.summary = self.summary.toPlainText().strip()
        contacts = []
        for r in range(self.contacts.rowCount()):
            name = self._cell(self.contacts, r, 0)
            if not name:
                continue
            phones = [p.strip() for p in self._cell(self.contacts, r, 3).split(",") if p.strip()]
            contacts.append(Contact(name, self.contacts.cellWidget(r, 1).currentText(),
                                    self._cell(self.contacts, r, 2), phones, self._cell(self.contacts, r, 4)))
        f.contacts = contacts
        kept = []
        for r in range(self.deadlines.rowCount()):
            due = self._cell(self.deadlines, r, 0)
            if due:
                kept.append(Deadline(self._cell(self.deadlines, r, 1) or "other", due, self._cell(self.deadlines, r, 2)))
        f.deadlines = kept + [d for d in f.deadlines if d.done]
        self.accept()

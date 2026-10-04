"""Call history browser (decrypts on demand, exports, secure delete)."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QDialog, QFileDialog, QHBoxLayout, QListWidget, QListWidgetItem, QMessageBox,
                               QPushButton, QSplitter, QTextBrowser, QVBoxLayout)

from callpilot.core.sessions import SessionStore, export_srt, export_text, secure_delete
from callpilot.ui.widgets import DialogKeys, fit_to_screen


class HistoryDialog(QDialog):
    def __init__(self, store: SessionStore, parent=None, audit=None):
        super().__init__(parent)
        self.setWindowTitle("Call history")
        fit_to_screen(self, 1000, 640)
        self.store = store
        self.audit = audit
        self.files: list[Path] = []
        self.current: dict | None = None
        self._cache: dict[Path, tuple[float, dict]] = {}   # path -> (mtime, record)
        self._last_error = ""
        root = QVBoxLayout(self)
        from PySide6.QtWidgets import QLineEdit

        self.search = QLineEdit()
        self.search.setPlaceholderText("Search every call… e.g. “Aviva hire rate Khan” – returns the line, the time and the clip")
        self.search.returnPressed.connect(self._search)
        root.addWidget(self.search)
        split = QSplitter()
        self.list = QListWidget()
        self.list.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.list.setTextElideMode(Qt.ElideRight)
        self.list.setWordWrap(True)
        self.view = QTextBrowser()
        split.addWidget(self.list)
        split.addWidget(self.view)
        split.setSizes([300, 700])
        root.addWidget(split)
        row = QHBoxLayout()
        for label, slot in (("Export TXT", lambda: self._export("txt")), ("Export SRT", lambda: self._export("srt")),
                            ("Export JSON", lambda: self._export("json")), ("Secure delete", self._delete)):
            b = QPushButton(label)
            b.clicked.connect(slot)
            row.addWidget(b)
        row.addStretch()
        root.addLayout(row)
        # No default button: Enter in the search box runs the search only, never an export.
        for b in self.findChildren(QPushButton):
            b.setAutoDefault(False)
        self._keys = DialogKeys(self)   # …but Enter on a button you Tabbed to still presses it
        self.list.currentRowChanged.connect(self._show)
        self._load()

    def done(self, r):
        self._cache.clear()   # decrypted calls do not outlive the dialog
        super().done(r)

    def _record(self, f: Path) -> dict | None:
        """The decoded call, decrypted once per file version."""
        try:
            mtime = f.stat().st_mtime
            hit = self._cache.get(f)
            if hit is not None and hit[0] == mtime:
                return hit[1]
            rec = self.store.load(f)
            self._cache[f] = (mtime, rec)
            return rec
        except Exception as e:  # noqa: BLE001
            self._cache.pop(f, None)
            self._last_error = str(e)
            return None

    def _label(self, f: Path, rec: dict | None = None) -> str:
        """'Sat 03 Oct 22:55  Courtesy Cars · Jane Smith' rather than the raw file name."""
        if rec is None:
            rec = self._record(f)
        if rec is not None:
            fields = rec.get("fields") or {}
            who = fields.get("caller_name") or fields.get("client_name") or ""
            return (f"{dt.datetime.fromtimestamp(rec.get('started_at', 0)):%a %d %b %H:%M}  "
                    f"{rec.get('hub_name', '').split('–')[0].strip()}{' · ' + who if who else ''}")
        try:
            d = dt.datetime.strptime(f.stem[:15], "%Y%m%d-%H%M%S")
        except ValueError:
            return f.stem
        return f"{d:%a %d %b %H:%M}  (cannot open)"

    def _load(self):
        self.list.clear()
        self.files = self.store.list()
        for f in self.files:
            item = QListWidgetItem(("🔒 " if f.suffix == ".cpv" else "") + self._label(f))
            if f.suffix == ".cpv":
                item.setToolTip("Encrypted")
            self.list.addItem(item)
        if self.files:
            self.list.setCurrentRow(0)
        else:
            self.view.setPlainText("No saved calls yet.")

    def _show(self, row: int):
        if row < 0 or row >= len(self.files):
            return
        self.current = self._record(self.files[row])
        if self.current is None:
            self.view.setPlainText(f"Cannot open this file: {self._last_error}")
            return
        if self.audit:
            self.audit.record("history_viewed", file=self.files[row].name)
        rec = self.current
        summ = rec.get("summary") or {}
        lines = [f"<h2>{rec.get('hub_name', '')}</h2>",
                 f"<p>{dt.datetime.fromtimestamp(rec.get('started_at', 0)):%A %d %B %Y, %H:%M}</p>"]
        if summ.get("summary"):
            lines.append(f"<h3>Summary</h3><p>{summ['summary']}</p>")
            if summ.get("outcome"):
                lines.append(f"<p><b>Outcome:</b> {summ['outcome']}</p>")
            if summ.get("next_actions"):
                lines.append("<ul>" + "".join(f"<li>{a}</li>" for a in summ["next_actions"]) + "</ul>")
            if summ.get("quality_score") is not None:
                lines.append(f"<p><b>Quality score:</b> {summ.get('quality_score')} – {summ.get('coaching_tip', '')}</p>")
        lines.append("<pre style='white-space:pre-wrap'>" + export_text(rec).replace("<", "&lt;") + "</pre>")
        self.view.setHtml("".join(lines))

    def _search(self):
        q = self.search.text().strip().lower()
        if not q:
            self._load()
            return
        words = [w for w in q.split() if w]
        hits = []
        for f in self.store.list():
            rec = self._record(f)
            if rec is None:
                continue
            lines = []
            for s in rec.get("segments", []):
                t = (s.get("text", "") + " " + s.get("translation", "")).lower()
                if all(w in t for w in words):
                    lines.append(("line", s))
            for p in rec.get("pins", []):
                t = (p.get("quote", "") + " " + p.get("value", "")).lower()
                if all(w in t for w in words):
                    lines.append(("pin", p))
            hay = " ".join([rec.get("hub_name", ""), json.dumps(rec.get("fields", {})),
                            json.dumps(rec.get("summary", {}))]).lower()
            if lines or all(w in hay for w in words):
                hits.append((f, rec, lines))
        self.list.clear()
        self.files = [h[0] for h in hits]
        self._hits = hits
        for f, rec, lines in hits:
            self.list.addItem(f"{self._label(f, rec)}  ({len(lines)} hits)")
        if not hits:
            self.view.setPlainText("No matches.")
            return
        self.list.currentRowChanged.disconnect()
        self.list.currentRowChanged.connect(self._show_hit)
        self.list.setCurrentRow(0)

    def _show_hit(self, row: int):
        if row < 0 or row >= len(getattr(self, "_hits", [])):
            return
        f, rec, lines = self._hits[row]
        self.current = rec
        out = [f"<h3>{rec.get('hub_name', '')} – {f.stem}</h3>"]
        for kind, item in lines:
            if kind == "line":
                t = dt.datetime.fromtimestamp(item["start"]).strftime("%H:%M:%S")
                who = "Us" if item["speaker"] == "agent" else "Caller"
                out.append(f"<p><b>{t} {who}:</b> {item['text']}</p>")
            else:
                clip = f" · <a href='file:///{item['clip_path']}'>▶ clip</a>" if item.get("clip_path") else ""
                out.append(f"<p>📌 <b>{item.get('kind', '')}</b> {item.get('value', '')} – “{item.get('quote', '')}”{clip}</p>")
        self.view.setOpenExternalLinks(True)
        self.view.setHtml("".join(out))

    def _export(self, kind: str):
        if not self.current:
            return
        f, _ = QFileDialog.getSaveFileName(self, "Export", f"call.{kind}")
        if not f:
            return
        if kind == "txt":
            Path(f).write_text(export_text(self.current), encoding="utf-8")
        elif kind == "srt":
            Path(f).write_text(export_srt(self.current), encoding="utf-8")
        else:
            Path(f).write_text(json.dumps(self.current, indent=2, ensure_ascii=False), encoding="utf-8")
        if self.audit:
            self.audit.record("history_exported", format=kind)

    def _delete(self):
        row = self.list.currentRow()
        if row < 0:
            return
        if QMessageBox.question(self, "Delete", "Permanently delete this call?") != QMessageBox.Yes:
            return
        secure_delete(self.files[row])
        if self.audit:
            self.audit.record("history_deleted", file=self.files[row].name)
        self._load()

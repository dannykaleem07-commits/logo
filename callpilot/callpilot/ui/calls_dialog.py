"""Calls: every call on this PC – open, read, download the transcript, save the whole
call (transcript, summary, pins, recording) to a folder."""

from __future__ import annotations

import datetime as dt
import html
import os
import subprocess
import sys
from pathlib import Path

from PySide6.QtWidgets import (QDialog, QFileDialog, QHBoxLayout, QLineEdit, QListWidget, QMessageBox,
                               QPushButton, QSplitter, QTextBrowser, QVBoxLayout)

from callpilot.core.export import default_export_dir, export_call
from callpilot.core.sessions import SessionStore, export_text


def open_folder(path: Path) -> None:
    try:
        if sys.platform == "win32":
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except Exception:  # noqa: BLE001
        pass


class CallsDialog(QDialog):
    def __init__(self, store: SessionStore, settings, parent=None, audit=None):
        super().__init__(parent)
        self.setWindowTitle("Calls")
        self.resize(1100, 680)
        self.store = store
        self.s = settings
        self.audit = audit
        self.files: list[Path] = []
        self.current: dict | None = None
        root = QVBoxLayout(self)
        top = QHBoxLayout()
        self.search = QLineEdit()
        self.search.setPlaceholderText("Search calls… name, reg, what was said")
        self.search.textChanged.connect(self._load)
        top.addWidget(self.search, 1)
        folder_btn = QPushButton("Open saved-calls folder")
        folder_btn.clicked.connect(lambda: open_folder(Path(self.s.export.folder) if self.s.export.folder else default_export_dir()))
        top.addWidget(folder_btn)
        root.addLayout(top)
        split = QSplitter()
        self.list = QListWidget()
        self.view = QTextBrowser()
        split.addWidget(self.list)
        split.addWidget(self.view)
        split.setSizes([360, 740])
        root.addWidget(split, 1)
        row = QHBoxLayout()
        for label, slot in (("⬇ Download transcript (.txt)", self._download_txt),
                            ("⬇ Download transcript (.docx)", self._download_docx),
                            ("💾 Save whole call to computer…", self._save_all),
                            ("🔊 Recording", self._recording),
                            ("Delete", self._delete)):
            b = QPushButton(label)
            b.clicked.connect(slot)
            row.addWidget(b)
        row.addStretch()
        root.addLayout(row)
        self.list.currentRowChanged.connect(self._show)
        self._load()

    def _load(self):
        q = self.search.text().strip().lower()
        self.list.clear()
        self.files = []
        self.current = None
        for f in self.store.list():
            try:
                rec = self.store.load(f)
            except Exception:  # noqa: BLE001
                continue
            hay = " ".join([rec.get("hub_name", ""), str(rec.get("fields", {})),
                            " ".join(s.get("text", "") for s in rec.get("segments", []))]).lower()
            if q and q not in hay:
                continue
            started = dt.datetime.fromtimestamp(rec.get("started_at", 0))
            who = (rec.get("fields") or {}).get("caller_name") or (rec.get("fields") or {}).get("client_name") or ""
            dur = ""
            if rec.get("ended_at") and rec.get("started_at"):
                secs = int(rec["ended_at"] - rec["started_at"])
                dur = f" · {secs // 60}m{secs % 60:02d}s"
            self.list.addItem(f"{started:%a %d %b %H:%M}  {rec.get('hub_name', '').split('–')[0].strip()}"
                              f"{' · ' + who if who else ''}{dur}")
            self.files.append(f)
        if self.files:
            self.list.setCurrentRow(0)
        else:
            self.view.setPlainText("No calls yet.")

    def _show(self, row: int):
        if row < 0 or row >= len(self.files):
            return
        try:
            self.current = self.store.load(self.files[row])
        except Exception as e:  # noqa: BLE001
            self.view.setPlainText(f"Cannot open: {e}")
            return
        rec = self.current
        summ = rec.get("summary") or {}
        parts = [f"<h2 style='margin:0'>{html.escape(rec.get('hub_name', ''))}</h2>",
                 f"<p>{dt.datetime.fromtimestamp(rec.get('started_at', 0)):%A %d %B %Y, %H:%M}"
                 f"{' · recorded' if rec.get('recording') else ''}</p>"]
        if summ.get("summary"):
            parts.append(f"<h3>Summary</h3><p>{html.escape(summ['summary'])}</p>")
        pins = rec.get("pins") or []
        if pins:
            parts.append("<h3>Pins</h3><ul>" + "".join(
                f"<li><b>{html.escape(p.get('kind', ''))}</b> {html.escape(str(p.get('value', '')))} – “{html.escape(p.get('quote', ''))}”</li>"
                for p in pins) + "</ul>")
        parts.append("<h3>Transcript</h3><pre style='white-space:pre-wrap'>" + html.escape(export_text(rec)) + "</pre>")
        self.view.setHtml("".join(parts))

    def _default_name(self, ext: str) -> str:
        from callpilot.core.export import call_folder_name

        return f"{call_folder_name(self.current)} transcript.{ext}" if self.current else f"transcript.{ext}"

    def _download_txt(self):
        if not self.current:
            return
        f, _ = QFileDialog.getSaveFileName(self, "Download transcript", str(Path.home() / "Downloads" / self._default_name("txt")),
                                           "Text (*.txt)")
        if f:
            Path(f).write_text(export_text(self.current), encoding="utf-8")
            self._done(Path(f))

    def _download_docx(self):
        if not self.current:
            return
        from callpilot.core.export import transcript_docx

        f, _ = QFileDialog.getSaveFileName(self, "Download transcript", str(Path.home() / "Downloads" / self._default_name("docx")),
                                           "Word (*.docx)")
        if f:
            transcript_docx(self.current, Path(f))
            self._done(Path(f))

    def _save_all(self):
        if not self.current:
            return
        d = QFileDialog.getExistingDirectory(self, "Save call to…", str(default_export_dir()))
        if d:
            folder = export_call(self.current, Path(d), vault=self.store.vault)
            self._done(folder)

    def _recording(self):
        if not self.current or not self.current.get("recording"):
            QMessageBox.information(self, "Recording", "This call has no recording.")
            return
        folder = export_call(self.current, None, vault=self.store.vault, include_recording=True)
        wav = folder / "recording.wav"
        if wav.exists():
            open_folder(folder)
        else:
            QMessageBox.information(self, "Recording", "The recording file is missing.")

    def _done(self, path: Path):
        if self.audit:
            self.audit.record("call_exported", path=str(path))
        QMessageBox.information(self, "Saved", f"Saved to:\n{path}")
        open_folder(path if path.is_dir() else path.parent)

    def _delete(self):
        row = self.list.currentRow()
        if row < 0:
            return
        if QMessageBox.question(self, "Delete", "Permanently delete this call from the app?") != QMessageBox.Yes:
            return
        from callpilot.core.sessions import secure_delete

        secure_delete(self.files[row])
        self._load()

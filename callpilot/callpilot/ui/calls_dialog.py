"""Calls: every call on this PC – open, read, download the transcript, save the whole
call (transcript, summary, pins, recording) to a folder."""

from __future__ import annotations

import datetime as dt
import html
import os
import subprocess
import sys
import threading
from pathlib import Path

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import (QDialog, QFileDialog, QHBoxLayout, QLineEdit, QListWidget, QMenu, QMessageBox,
                               QPushButton, QSplitter, QTextBrowser, QVBoxLayout)

from callpilot.core.export import default_export_dir, export_call
from callpilot.core.sessions import SessionStore, export_text
from callpilot.ui.widgets import DialogKeys, fit_to_screen


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
    _warmed = Signal()          # emitted by the warm-up thread once every call is decoded into the cache

    def __init__(self, store: SessionStore, settings, parent=None, audit=None):
        super().__init__(parent)
        self.setWindowTitle("Calls")
        fit_to_screen(self, 1100, 680)
        self.store = store
        self.s = settings
        self.audit = audit
        self.files: list[Path] = []
        self.current: dict | None = None
        self._cache: dict[Path, tuple[float, dict, str]] = {}   # path -> (mtime, record, lowercase haystack)
        self._last_error = ""
        self._closed = False
        self._warming = False
        root = QVBoxLayout(self)
        top = QHBoxLayout()
        self.search = QLineEdit()
        self.search.setPlaceholderText("Search calls… name, reg, what was said")
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(250)
        self._debounce.timeout.connect(self._load)
        self.search.textChanged.connect(self._debounce.start)
        self.search.returnPressed.connect(self._search_now)
        top.addWidget(self.search, 1)
        folder_btn = QPushButton("Open saved-calls folder")
        folder_btn.clicked.connect(lambda: open_folder(Path(self.s.export.folder) if self.s.export.folder else default_export_dir()))
        top.addWidget(folder_btn)
        root.addLayout(top)
        split = QSplitter()
        self.list = QListWidget()
        self.list.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.list.setTextElideMode(Qt.ElideRight)
        self.list.setWordWrap(True)
        self.view = QTextBrowser()
        split.addWidget(self.list)
        split.addWidget(self.view)
        split.setSizes([360, 740])
        root.addWidget(split, 1)
        row = QHBoxLayout()
        # short labels so the row fits a 125-150 % screen; the tooltips say exactly what each one does
        self.btn_transcript = QPushButton("⬇ Transcript ▾")
        self.btn_transcript.setToolTip("Download this call's transcript as plain text (.txt) or a Word document (.docx)")
        self.btn_transcript.setAccessibleName("Download transcript")
        menu = QMenu(self.btn_transcript)
        menu.addAction("Plain text (.txt)…", self._download_txt)
        menu.addAction("Word document (.docx)…", self._download_docx)
        self.btn_transcript.setMenu(menu)
        self.btn_transcript.setStyleSheet("QPushButton::menu-indicator { image: none; width: 0px; }")   # the label has ▾
        self.btn_save = QPushButton("💾 Save call…")
        self.btn_save.setToolTip("Save the whole call – transcript, summary, pins and recording – to a folder on this computer")
        self.btn_save.setAccessibleName("Save whole call to computer")
        self.btn_save.clicked.connect(self._save_all)
        self.btn_recording = QPushButton("Recording folder")
        self.btn_recording.setToolTip("Decrypts the recording into the saved-calls folder and opens it")
        self.btn_recording.clicked.connect(self._recording)
        self.row_buttons: list[QPushButton] = [self.btn_transcript, self.btn_save, self.btn_recording]
        for b in self.row_buttons:
            row.addWidget(b)
        row.addStretch()
        self.btn_delete = QPushButton("Delete")
        self.btn_delete.setToolTip("Permanently delete this call from the app")
        self.btn_delete.clicked.connect(self._delete)
        row.addWidget(self.btn_delete)
        self.row_buttons.append(self.btn_delete)
        root.addLayout(row)
        self.list.currentRowChanged.connect(self._show)
        self._warmed.connect(self._load)
        # No default button: Enter in the search box must never open a folder, export or delete.
        for b in self.findChildren(QPushButton):
            b.setAutoDefault(False)
        self._keys = DialogKeys(self)   # …but Enter on a button you Tabbed to still presses it
        files = self.store.list()
        if len(files) <= 40:
            self._load()
            if self.files:
                self.list.setFocus()
        else:
            self._warming = True
            self._sync_buttons()
            self.view.setPlainText("Loading calls…")
            threading.Thread(target=self._warm, args=(files,), daemon=True, name="callpilot-calls").start()

    # ------------------------------------------------------------- loading
    def _warm(self, files: list[Path]) -> None:
        """Worker thread: decode every call into the cache. Never touches widgets."""
        for f in files:
            if self._closed:
                break
            self._record(f)
        self._warming = False
        try:
            self._warmed.emit()
        except RuntimeError:  # dialog already destroyed
            pass

    def _record(self, f: Path) -> tuple[dict, str] | None:
        """(record, lowercase search text) for a saved call, decrypted once per file version."""
        try:
            mtime = f.stat().st_mtime
            hit = self._cache.get(f)
            if hit is not None and hit[0] == mtime:
                return hit[1], hit[2]
            rec = self.store.load(f)
            hay = " ".join([rec.get("hub_name", ""), str(rec.get("fields", {})),
                            " ".join(s.get("text", "") for s in rec.get("segments", []))]).lower()
            self._cache[f] = (mtime, rec, hay)
            return rec, hay
        except Exception as e:  # noqa: BLE001
            self._cache.pop(f, None)
            self._last_error = str(e)
            return None

    def _search_now(self):
        self._debounce.stop()
        self._load()
        if self.list.count():
            self.list.setFocus()
            if self.list.currentRow() < 0:
                self.list.setCurrentRow(0)

    def _load(self):
        if self._warming or self._closed:
            return   # closed: never decrypt the rest on the GUI thread for a dialog nobody sees
        text = self.search.text().strip()
        q = text.lower()
        self.list.clear()
        self.files = []
        self.current = None
        for f in self.store.list():
            got = self._record(f)
            if got is None:
                continue
            rec, hay = got
            if q and q not in hay:
                continue
            started = dt.datetime.fromtimestamp(rec.get("started_at", 0))
            who = (rec.get("fields") or {}).get("caller_name") or (rec.get("fields") or {}).get("client_name") or ""
            dur = ""
            if rec.get("ended_at") and rec.get("started_at"):
                secs = int(rec["ended_at"] - rec["started_at"])
                dur = f" · {secs // 60}m{secs % 60:02d}s"
            hub = rec.get("hub_name", "").split("–")[0].strip()
            self.list.addItem(f"{started:%a %d %b %H:%M}{dur}\n{hub}{' · ' + who if who else ''}")
            self.files.append(f)
        if self.files:
            self.list.setCurrentRow(0)
        elif text:
            self.view.setPlainText(f'No calls match "{text}".')
        else:
            self.view.setPlainText("No calls yet. Your first call will appear here after you press ● Start call and end it.")
        self._sync_buttons()

    def _sync_buttons(self):
        on = self.current is not None
        for b in self.row_buttons:
            b.setEnabled(on)
        has_recording = on and bool(self.current.get("recording"))
        self.btn_recording.setEnabled(has_recording)
        self.btn_recording.setToolTip("Decrypts the recording into the saved-calls folder and opens it"
                                      if has_recording else "This call has no recording")

    def _show(self, row: int):
        if row < 0 or row >= len(self.files):
            return
        got = self._record(self.files[row])
        if got is None:
            self.current = None
            self.view.setPlainText(f"Cannot open: {self._last_error}")
            self._sync_buttons()
            return
        self.current = got[0]
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
        self._sync_buttons()

    def done(self, r):
        self._closed = True
        self._debounce.stop()
        self._cache.clear()        # decrypted calls do not outlive the dialog
        self.current = None
        super().done(r)

    def closeEvent(self, e):
        self._closed = True
        super().closeEvent(e)

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

        path = self.files[row]
        secure_delete(path)
        self._cache.pop(path, None)
        self._load()

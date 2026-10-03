"""Reusable widgets: transcript, suggestion card, level meters, claim form."""

from __future__ import annotations

import datetime as dt
import html
from collections import OrderedDict

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QColor, QPainter
from PySide6.QtWidgets import (QApplication, QFrame, QGridLayout, QHBoxLayout, QLabel, QLineEdit,
                               QPushButton, QSizePolicy, QTextBrowser, QVBoxLayout, QWidget)

from callpilot.core.models import AGENT, Segment, Suggestion
from callpilot.ui.theme import palette


def card() -> QFrame:
    f = QFrame()
    f.setObjectName("card")
    return f


def section(text: str) -> QLabel:
    lbl = QLabel(text.upper())
    lbl.setObjectName("section")
    return lbl


class LevelMeter(QWidget):
    def __init__(self, label: str, theme: str = "dark"):
        super().__init__()
        self.label = label
        self.db = -120.0
        self.c = palette(theme)
        self.setFixedSize(120, 18)
        self.setToolTip(f"{label} level")

    def set_db(self, db: float) -> None:
        self.db = db
        self.update()

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(self.c["panel2"]))
        p.drawRoundedRect(0, 4, self.width(), 10, 5, 5)
        frac = max(0.0, min(1.0, (self.db + 60) / 60))
        col = self.c["good"] if frac < 0.75 else (self.c["warn"] if frac < 0.92 else self.c["bad"])
        p.setBrush(QColor(col))
        p.drawRoundedRect(0, 4, int(self.width() * frac), 10, 5, 5)


class SentimentMeter(QLabel):
    def set_value(self, v: float) -> None:
        face = "🙂" if v > 0.25 else ("😟" if v < -0.25 else "😐")
        self.setText(f"Caller mood {face}")


class TranscriptView(QTextBrowser):
    """Live transcript; interim results update in place, rendered at ≤10 fps."""

    def __init__(self, theme: str = "dark"):
        super().__init__()
        self.setOpenExternalLinks(False)
        self.c = palette(theme)
        self.segments: OrderedDict[str, Segment] = OrderedDict()
        self.show_translation = True
        self._dirty = False
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._render)
        self._timer.start(100)

    def clear_all(self) -> None:
        self.segments.clear()
        self._dirty = True

    def upsert(self, seg: Segment) -> None:
        if seg.is_final and not seg.text:
            self.segments.pop(seg.id, None)
        else:
            old = self.segments.get(seg.id)
            if old and old.translation and not seg.translation:
                seg.translation = old.translation
            self.segments[seg.id] = seg
        self._dirty = True

    def _render(self) -> None:
        if not self._dirty:
            return
        self._dirty = False
        bar = self.verticalScrollBar()
        at_bottom = bar.value() >= bar.maximum() - 30
        rows = []
        for s in self.segments.values():
            agent = s.speaker == AGENT
            who = "You" if agent else "Caller"
            col = self.c["agent"] if agent else self.c["caller"]
            t = dt.datetime.fromtimestamp(s.start).strftime("%H:%M:%S")
            style = "" if s.is_final else f"color:{self.c['muted']};"
            lang = f" · {html.escape(s.language.upper())}" if s.language and not agent else ""
            body = html.escape(s.text)
            row = (f"<div style='margin:6px 0;'><span style='color:{col};font-weight:700'>{who}</span>"
                   f"<span style='color:{self.c['muted']};font-size:small'>  {t}{lang}</span><br>"
                   f"<span style='{style}'>{body}</span>")
            if self.show_translation and s.translation:
                row += (f"<br><span style='color:{self.c['muted']}'>↳ "
                        f"{html.escape(s.translation)}</span>")
            rows.append(row + "</div>")
        self.setHtml("".join(rows) or
                     f"<p style='color:{self.c['muted']}'>Start a call – live transcript appears here.</p>")
        if at_bottom:
            bar.setValue(bar.maximum())


class WrapLabel(QLabel):
    def __init__(self, name: str):
        super().__init__()
        self.setObjectName(name)
        self.setWordWrap(True)
        self.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Minimum)


class SuggestionPanel(QFrame):
    regenerate = Signal()
    speak = Signal(str)
    closing = Signal()

    def __init__(self):
        super().__init__()
        self.setObjectName("card")
        self.current: Suggestion | None = None
        lay = QVBoxLayout(self)
        lay.setContentsMargins(18, 14, 18, 14)
        lay.setSpacing(8)
        top = QHBoxLayout()
        top.addWidget(section("Say next"))
        top.addStretch()
        self.src = QLabel("")
        self.src.setObjectName("badge")
        top.addWidget(self.src)
        lay.addLayout(top)
        self.filler = WrapLabel("filler")
        self.say = WrapLabel("say")
        self.more = WrapLabel("more")
        self.their_title = section("In the caller's language")
        self.their = WrapLabel("their")
        self.warn = WrapLabel("warnbox")
        lay.addWidget(self.filler)
        lay.addWidget(self.say)
        lay.addWidget(self.more)
        lay.addWidget(self.their_title)
        lay.addWidget(self.their)
        lay.addWidget(self.warn)
        lay.addWidget(section("Ask next"))
        self.ask_box = QVBoxLayout()
        self.ask_box.setSpacing(6)
        lay.addLayout(self.ask_box)
        lay.addStretch()
        btns = QHBoxLayout()
        self.btn_regen = QPushButton("⟳ Regenerate")
        self.btn_copy = QPushButton("⧉ Copy")
        self.btn_speak = QPushButton("🔊 Speak")
        self.btn_close = QPushButton("👋 Closing script")
        self.btn_close.clicked.connect(self.closing.emit)
        self.btn_regen.clicked.connect(self.regenerate.emit)
        self.btn_copy.clicked.connect(self.copy)
        self.btn_speak.clicked.connect(lambda: self.speak.emit(self._speak_text()))
        for b in (self.btn_regen, self.btn_copy, self.btn_speak, self.btn_close):
            btns.addWidget(b)
        btns.addStretch()
        lay.addLayout(btns)
        self.show_suggestion(None)

    def _speak_text(self) -> str:
        if not self.current:
            return ""
        return self.current.translated or self.current.full_text()

    def copy(self) -> None:
        if self.current:
            QApplication.clipboard().setText(self.current.translated or self.current.full_text())

    def show_suggestion(self, s: Suggestion | None) -> None:
        self.current = s
        if s is None:
            self.filler.setText("Waiting for the caller…")
            for w in (self.say, self.more, self.their, self.their_title, self.warn):
                w.setVisible(False)
            self.src.setText("")
            self._set_asks([])
            return
        self.filler.setText(f"“{s.filler}”" if s.filler else "")
        self.say.setText(s.say_now or ("…" if not s.done else ""))
        self.say.setVisible(True)
        self.more.setText(s.continue_with)
        self.more.setVisible(bool(s.continue_with))
        self.their.setText(s.translated)
        self.their.setVisible(bool(s.translated))
        self.their_title.setVisible(bool(s.translated))
        self.warn.setText("⚠ " + " ".join(s.warnings) if s.warnings else "")
        self.warn.setVisible(bool(s.warnings))
        src = "⚡ Approved answer" if s.source == "instant-kb" else "AI"
        if s.first_token_ms:
            src += f" · {s.first_token_ms / 1000:.2f}s"
        if not s.done:
            src += " · writing…"
        self.src.setText(src)
        self._set_asks(s.ask_next)

    def _set_asks(self, asks: list[str]) -> None:
        while self.ask_box.count():
            w = self.ask_box.takeAt(0).widget()
            if w:
                w.deleteLater()
        for q in asks:
            chip = QLabel("❓ " + q)
            chip.setObjectName("chip")
            chip.setWordWrap(True)
            chip.setTextInteractionFlags(Qt.TextSelectableByMouse)
            self.ask_box.addWidget(chip)


class FieldsPanel(QWidget):
    """Auto-filled claim form; agent can correct values by hand."""

    edited = Signal(str, str)

    def __init__(self):
        super().__init__()
        self.setObjectName("formpanel")
        self.grid = QGridLayout(self)
        self.grid.setColumnStretch(1, 1)
        self.edits: dict[str, QLineEdit] = {}
        self.required: dict[str, bool] = {}
        self.progress = QLabel("")
        self.progress.setObjectName("badge")

    def set_fields(self, fields) -> None:
        while self.grid.count():
            w = self.grid.takeAt(0).widget()
            if w:
                w.deleteLater()
        self.edits.clear()
        self.grid.addWidget(self.progress, 0, 0, 1, 2)
        for i, f in enumerate(fields, start=1):
            lbl = QLabel(f.label + (" *" if f.required else ""))
            lbl.setToolTip(f.hint)
            e = QLineEdit()
            e.setPlaceholderText(f.hint or "listening…")
            e.editingFinished.connect(lambda k=f.key, w=e: self.edited.emit(k, w.text()))
            self.grid.addWidget(lbl, i, 0)
            self.grid.addWidget(e, i, 1)
            self.edits[f.key] = e
            self.required[f.key] = f.required
        self._update_progress()

    def update_values(self, values: dict) -> None:
        for k, v in values.items():
            e = self.edits.get(k)
            if e is not None and v and not e.hasFocus():
                e.setText(v)
        self._update_progress()

    def _update_progress(self) -> None:
        req = [k for k, r in self.required.items() if r]
        done = sum(1 for k in req if self.edits[k].text().strip())
        self.progress.setText(f"Required captured: {done}/{len(req)}")

    def values(self) -> dict:
        return {k: e.text() for k, e in self.edits.items()}


class AskBar(QWidget):
    asked = Signal(str)

    def __init__(self):
        super().__init__()
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.edit = QLineEdit()
        self.edit.setPlaceholderText("Ask the co-pilot privately… e.g. “caller wants a 7-seater, what do I say?”")
        btn = QPushButton("Ask")
        btn.setObjectName("primary")
        lay.addWidget(self.edit, 1)
        lay.addWidget(btn)
        btn.clicked.connect(self._go)
        self.edit.returnPressed.connect(self._go)

    def _go(self) -> None:
        t = self.edit.text().strip()
        if t:
            self.asked.emit(t)
            self.edit.clear()

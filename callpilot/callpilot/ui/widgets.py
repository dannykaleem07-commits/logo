"""Reusable widgets: transcript, card stack, intake form + progress ring, file pane, meters."""

from __future__ import annotations

import datetime as dt
import html
import re
from collections import OrderedDict

from PySide6.QtCore import QRectF, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QPainter, QPen, QTextCursor
from PySide6.QtWidgets import (QApplication, QCheckBox, QFrame, QGridLayout, QHBoxLayout, QLabel, QLineEdit,
                               QPushButton, QScrollArea, QSizePolicy, QTextBrowser, QVBoxLayout, QWidget)

from callpilot.core.models import AGENT, ASK, SAY, WATCH, Card, Segment
from callpilot.ui.theme import palette


def card() -> QFrame:
    f = QFrame()
    f.setObjectName("card")
    return f


def section(text: str) -> QLabel:
    lbl = QLabel(text.upper())
    lbl.setObjectName("section")
    return lbl


def fit_to_screen(dialog, w: int, h: int, margin_w: int = 48, margin_h: int = 96) -> None:
    """Prefer w x h but never larger than the screen the dialog will appear on."""
    ref = dialog.parentWidget() or dialog
    screen = ref.screen() or QApplication.primaryScreen()
    if screen is None:
        dialog.resize(w, h)
        return
    avail = screen.availableGeometry()
    dialog.resize(min(w, avail.width() - margin_w), min(h, avail.height() - margin_h))


def scrollable(page: QWidget) -> QScrollArea:
    """Wrap a tall page so it scrolls vertically on small screens instead of being clipped."""
    sa = QScrollArea()
    sa.setWidgetResizable(True)
    sa.setFrameShape(QFrame.NoFrame)
    sa.setWidget(page)
    page.setAutoFillBackground(False)            # after setWidget, which turns it on
    sa.viewport().setAutoFillBackground(False)   # otherwise a grey slab shows in the dark theme
    return sa


class ElidedLabel(QLabel):
    """A one-line label that ends in '…' when it is squeezed, instead of being cut mid-word."""

    def minimumSizeHint(self):
        return QSize(1, super().minimumSizeHint().height())

    def paintEvent(self, _):
        p = QPainter(self)
        r = self.contentsRect()
        text = self.fontMetrics().elidedText(self.text(), Qt.ElideRight, r.width())
        self.style().drawItemText(p, r, int(self.alignment()), self.palette(), self.isEnabled(), text, self.foregroundRole())


class LevelMeter(QWidget):
    def __init__(self, label: str, theme: str = "dark"):
        super().__init__()
        self.label = label
        self.db = -120.0
        self.c = palette(theme)
        self.setFixedSize(90, 18)
        self.setToolTip(f"{label}: sound level")
        self.setAccessibleName(f"{label} sound level")

    def set_db(self, db: float) -> None:
        self.db = db
        self.update()

    def set_theme(self, theme: str) -> None:
        self.c = palette(theme)
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


class RecordDot(QLabel):
    """Recording badge. The words always say the state; colour only reinforces it:
    red text while recording with the notice given, amber until the notice has been given,
    muted when paused, plain badge text when idle. Colours come from the theme palette."""

    def __init__(self, theme: str = "dark"):
        super().__init__("● idle")
        self.setObjectName("badge")
        self.c = palette(theme)
        self._state = (False, False, False)
        self._announce("● idle")

    def set_theme(self, theme: str) -> None:
        self.c = palette(theme)
        self.set_state(*self._state)

    def _announce(self, text: str) -> None:
        self.setToolTip(text)        # the header can clip the badge at 1366 px; the full state stays reachable
        self.setAccessibleName(text)

    def set_state(self, recording: bool, notice_given: bool, paused: bool = False):
        self._state = (recording, notice_given, paused)
        if not recording:
            text, css = "● idle", ""
        elif paused:
            text, css = "❚❚ recording paused", f"color:{self.c['muted']};font-weight:700;"
        elif notice_given:
            text, css = "● recording · notice given", f"color:{self.c['bad_text']};font-weight:700;"
        else:
            text, css = "● recording · notice not given yet", f"color:{self.c['warn']};font-weight:700;"
        self.setText(text)
        self.setStyleSheet(css)
        self._announce(text)


class ProgressRing(QWidget):
    def __init__(self, theme: str = "dark", font_pt: int = 11):
        super().__init__()
        self.c = palette(theme)
        self.font_pt = font_pt
        self.done, self.total = 0, 0
        self.setFixedSize(64, 64)

    def set_theme(self, theme: str, font_pt: int | None = None) -> None:
        self.c = palette(theme)
        if font_pt is not None:
            self.font_pt = font_pt
        self.update()

    def set_progress(self, done: int, total: int):
        self.done, self.total = done, total
        self.setToolTip(f"{done} of {total} required fields confirmed")
        self.update()

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        rect = QRectF(6, 6, self.width() - 12, self.height() - 12)
        pen = QPen(QColor(self.c["panel2"]), 7)
        p.setPen(pen)
        p.drawEllipse(rect)
        frac = (self.done / self.total) if self.total else 0.0
        col = self.c["good"] if frac >= 1 else (self.c["accent"] if frac > 0.5 else self.c["warn"])
        pen.setColor(QColor(col))
        pen.setCapStyle(Qt.RoundCap)
        p.setPen(pen)
        p.drawArc(rect, 90 * 16, -int(360 * 16 * frac))
        p.setPen(QColor(self.c["text"]))
        f = p.font()
        f.setBold(True)
        f.setPointSize(min(12, max(9, self.font_pt - 1)))   # never overflows the 64 px ring
        p.setFont(f)
        p.drawText(self.rect(), Qt.AlignCenter, f"{self.done}/{self.total}" if self.total else "–")


# ====================================================================== transcript
# Entity-chip colours per theme. In the transcript the kind colour is used for the chip's border and
# tint only (the chip text stays the palette text colour, which keeps AA over the tint in both themes);
# the pins list uses it for the kind label on the plain panel.
_CHIP_FG = {
    "dark": {"date": "#60A5FA", "deadline": "#FBBF24", "commitment": "#FBBF24", "figure": "#4ADE80",
             "reg": "#C4B5FD", "ref": "#C4B5FD", "admission": "#FCA5A5", "allegation": "#FCA5A5"},
    "light": {"date": "#1D4ED8", "deadline": "#92400E", "commitment": "#92400E", "figure": "#166534",
              "reg": "#6D28D9", "ref": "#6D28D9", "admission": "#B91C1C", "allegation": "#B91C1C"},
}


def chip_colours(theme: str) -> dict:
    return _CHIP_FG["light" if theme == "light" else "dark"]


class TranscriptView(QTextBrowser):
    """Live transcript. Interim lines update in place; dates, regs and money become chips;
    pinned lines get a coloured left edge; auto-scroll pauses while you scroll up.

    Rendering is incremental: settled rows are written once and only the live tail (the last
    three rows) is replaced on each tick, so long calls stay cheap and a selection in older
    lines survives. Any change to a settled row falls back to a full redraw."""

    def __init__(self, theme: str = "dark"):
        super().__init__()
        self.setOpenExternalLinks(False)
        self.c = palette(theme)
        self.chips = chip_colours(theme)
        self.segments: OrderedDict[str, Segment] = OrderedDict()
        self.show_translation = True
        self._dirty = True                # first tick draws the empty-state hint
        self._frozen: list[str] = []      # ids of rows already written and no longer re-rendered
        self._frozen_pos = 0              # document position where the live tail starts
        self._changed: set[str] = set()   # ids upserted since the last render
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._render)
        self._timer.start(100)

    def clear_all(self) -> None:
        self.segments.clear()
        self._frozen = []
        self._frozen_pos = 0
        self._changed = set()
        self._dirty = True

    def set_theme(self, theme: str) -> None:
        self.c = palette(theme)
        self.chips = chip_colours(theme)
        self.rebuild()
        self._render()

    def rebuild(self) -> None:
        """Force a full redraw, e.g. after toggling translations."""
        self._frozen = []
        self._frozen_pos = 0
        self._changed = set()
        self._dirty = True

    def upsert(self, seg: Segment) -> None:
        if seg.is_final and not seg.text:
            self.segments.pop(seg.id, None)
        else:
            old = self.segments.get(seg.id)
            if old and old.translation and not seg.translation:
                seg.translation = old.translation
            self.segments[seg.id] = seg
        self._changed.add(seg.id)
        self._dirty = True

    def _line_html(self, s: Segment) -> str:
        body = html.escape(s.text)
        for kind, text in sorted(s.entities, key=lambda e: -len(e[1])):
            col = self.chips.get(kind)
            if not col:
                continue
            r, g, b = QColor(col).getRgb()[:3]
            esc = html.escape(text)
            body = re.sub(re.escape(esc),
                          f"<span style='background:rgba({r},{g},{b},0.16);border:1px solid {col};"
                          f"border-radius:4px;padding:0 4px;color:{self.c['text']}' title='{kind}'>{esc}</span>",
                          body, count=1)
        return body

    def _row_html(self, s: Segment) -> str:
        agent = s.speaker == AGENT
        who = "You" if agent else "Caller"
        col = self.c["agent"] if agent else self.c["caller"]
        bg = self.c["bubble_agent"] if agent else self.c["bubble_caller"]
        t = dt.datetime.fromtimestamp(s.start).strftime("%H:%M")
        # Interim (not yet final) lines: muted italic plus a trailing ellipsis, so the state is not colour-only.
        style = "" if s.is_final else f"color:{self.c['muted']};font-style:italic;"
        lang = f" · {html.escape(s.language.upper())}" if s.language and not agent else ""
        pin = " · 📌" if s.pinned else ""
        align = "right" if agent else "left"
        body = self._line_html(s)
        if not s.is_final:
            body += " …"
        if self.show_translation and s.translation:
            body += (f"<br><span style='color:{self.c['muted']};font-size:small'>↳ "
                     f"{html.escape(s.translation)}</span>")
        return (f"<table width='100%' cellspacing='0' cellpadding='0' style='margin:4px 0'><tr>"
                f"<td align='{align}'>"
                f"<table cellspacing='0' cellpadding='10' bgcolor='{bg}' style='max-width:86%'><tr><td>"
                f"<span style='color:{col};font-weight:700;font-size:small'>{who}</span>"
                f"<span style='color:{self.c['muted']};font-size:small'>&nbsp; {t}{lang}{pin}</span><br>"
                f"<span style='{style}'>{body}</span>"
                f"</td></tr></table></td></tr></table>")

    def _render(self) -> None:
        if not self._dirty:
            return
        self._dirty = False
        bar = self.verticalScrollBar()
        at_bottom = bar.value() >= bar.maximum() - 30
        ids = list(self.segments)
        if not ids:
            self.setHtml(f"<p style='color:{self.c['muted']};margin:18px 6px'>Press <b>Start call</b>. "
                         f"What the caller says appears on the left, what you say on the right.</p>")
            self._frozen, self._frozen_pos, self._changed = [], 0, set()
            return
        if (not self._frozen or self._frozen != ids[:len(self._frozen)]
                or (self._changed & set(self._frozen))):
            # Full redraw: a settled line changed (pin, late translation, delete) or we start fresh.
            # Only the settled rows go through setHtml; the live tail is appended with the cursor
            # so later renders can replace just that tail.
            live_from = max(0, len(ids) - 3)
            self.setHtml("".join(self._row_html(self.segments[i]) for i in ids[:live_from]))
            cur = QTextCursor(self.document())
            cur.movePosition(QTextCursor.End)
        else:
            # Incremental: replace only the live tail (last three rows).
            live_from = max(len(self._frozen), len(ids) - 3)
            cur = QTextCursor(self.document())
            cur.setPosition(self._frozen_pos)
            cur.movePosition(QTextCursor.End, QTextCursor.KeepAnchor)
            cur.removeSelectedText()                       # insertHtml("") would NOT clear it
            settled = "".join(self._row_html(self.segments[i]) for i in ids[len(self._frozen):live_from])
            if settled:
                cur.insertHtml(settled)
                cur.movePosition(QTextCursor.End)          # position() after a table is not End
        self._frozen, self._frozen_pos = ids[:live_from], cur.position()
        cur.insertHtml("".join(self._row_html(self.segments[i]) for i in ids[live_from:]))
        self._changed = set()
        if at_bottom:
            bar.setValue(bar.maximum())


# ====================================================================== cards
class CardWidget(QFrame):
    used = Signal(object)
    dismissed = Signal(object)

    TITLES = {ASK: "ASK NEXT", SAY: "SAY THIS", WATCH: "WATCH OUT"}

    def __init__(self, theme: str = "dark", font_pt: int = 11):
        super().__init__()
        self.setObjectName("card")
        self.c = palette(theme)
        self.font_pt = font_pt
        self.card: Card | None = None
        self._is_top = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 10, 16, 12)
        lay.setSpacing(6)
        top = QHBoxLayout()
        self.title = QLabel("")
        self.title.setObjectName("section")
        top.addWidget(self.title)
        top.addStretch()
        self.src = QLabel("")
        self.src.setObjectName("badge")
        self.src.setMaximumWidth(360)
        top.addWidget(self.src)
        lay.addLayout(top)
        self.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        self.filler = QLabel("")
        self.filler.setObjectName("filler")
        self.filler.setWordWrap(True)
        self.text = QLabel("")
        self.text.setWordWrap(True)
        self.text.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.text.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Minimum)
        self.more = QLabel("")
        self.more.setObjectName("more")
        self.more.setWordWrap(True)
        self.their = QLabel("")
        self.their.setObjectName("their")
        self.their.setWordWrap(True)
        lay.addWidget(self.filler)
        lay.addWidget(self.text)
        lay.addWidget(self.more)
        lay.addWidget(self.their)
        btns = QHBoxLayout()
        self.btn_used = QPushButton("✓ Used  (Space)")
        self.btn_dismiss = QPushButton("✕  (Esc)")
        self.btn_copy = QPushButton("⧉")
        self.btn_copy.setFixedWidth(36)
        self.btn_copy.setToolTip("Copy")
        self.btn_copy.setAccessibleName("Copy")
        self.btn_used.clicked.connect(lambda: self.used.emit(self.card))
        self.btn_dismiss.clicked.connect(lambda: self.dismissed.emit(self.card))
        self.btn_copy.clicked.connect(self._copy)
        btns.addWidget(self.btn_used)
        btns.addWidget(self.btn_dismiss)
        btns.addWidget(self.btn_copy)
        btns.addStretch()
        lay.addLayout(btns)

    def _copy(self):
        if self.card:
            QApplication.clipboard().setText(self.card.translated or self.card.spoken())

    def set_theme(self, theme: str, font_pt: int | None = None) -> None:
        self.c = palette(theme)
        if font_pt is not None:
            self.font_pt = font_pt
        if self.card is not None:
            self.set_card(self.card, self._is_top)

    def set_card(self, c: Card | None, is_top: bool = False):
        self.card = c
        self._is_top = is_top
        self.setVisible(c is not None)
        if c is None:
            return
        self.title.setText(self.TITLES.get(c.type, c.type.upper()) + ("  ▸" if is_top else ""))
        if c.type == WATCH:
            frame_css = f"QFrame#card{{border:1px solid {self.c['bad']};background:rgba(239,68,68,0.10);}}"
            self.text.setObjectName("say")
            text_css = f"color:{self.c['bad_text']};font-weight:700;"
        elif c.type == SAY:
            frame_css = f"QFrame#card{{border:1px solid {self.c['accent']};}}"
            text_css = f"color:{self.c['say']};font-weight:700;font-size:{self.font_pt + 4}pt;"
        else:
            frame_css = ""
            text_css = f"font-size:{self.font_pt + 2}pt;"
        # Re-polishing is costly and set_card runs on every streamed token: only restyle on a real change.
        if self.styleSheet() != frame_css:
            self.setStyleSheet(frame_css)
        if self.text.styleSheet() != text_css:
            self.text.setStyleSheet(text_css)
        self.filler.setText(f"“{c.filler}”" if (c.type == SAY and c.filler) else "")
        self.filler.setVisible(bool(c.type == SAY and c.filler))
        txt = c.text if c.type != ASK else "\n".join("❓ " + q for q in c.text.split(" | ") if q)
        self.text.setText(txt or ("…" if not c.done else ""))
        self.more.setText(c.more)
        self.more.setVisible(bool(c.more))
        self.their.setText(("🌐 " + c.translated) if c.translated else "")
        self.their.setVisible(bool(c.translated))
        origin = {"playbook": "⚡ approved answer", "rule": "rule", "llm": "AI", "script": "script"}.get(c.origin, c.origin)
        src = " · ".join(s for s in c.sources[:2] if s and s != "model")
        label = origin + (f" · {src}" if src else "") + ("" if c.done else " · writing…")
        self.src.setText(label if len(label) <= 48 else label[:46] + "…")
        self.src.setToolTip("\n".join(c.sources))


class CardsPanel(QWidget):
    """Max three cards: Watch out on top (only red element), then Say this, then Ask next."""

    used = Signal(object)
    dismissed = Signal(object)

    def __init__(self, theme: str = "dark", font_pt: int = 11):
        super().__init__()
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(10)
        self.widgets = {t: CardWidget(theme, font_pt) for t in (WATCH, SAY, ASK)}
        for w in self.widgets.values():
            w.used.connect(self.used.emit)
            w.dismissed.connect(self.dismissed.emit)
            w.setVisible(False)
            lay.addWidget(w)
        self.empty = QLabel("Listening… cards appear here when the caller asks something, a field is missing, "
                            "a date or figure is given, or a risk is heard.")
        self.empty.setObjectName("filler")
        self.empty.setWordWrap(True)
        lay.addWidget(self.empty)
        lay.addStretch()

    def set_theme(self, theme: str, font_pt: int | None = None) -> None:
        for w in self.widgets.values():
            w.set_theme(theme, font_pt)

    def show_cards(self, cards: list[Card]):
        by_type = {c.type: c for c in cards}
        top = next((by_type[t] for t in (WATCH, SAY, ASK) if t in by_type), None)
        for t, w in self.widgets.items():
            w.set_card(by_type.get(t), is_top=(by_type.get(t) is top))
        self.empty.setVisible(not cards)


# ====================================================================== intake
class IntakePanel(QWidget):
    """Live intake form. AI fills values (greyed until you tick them); nothing saves unconfirmed."""

    edited = Signal(str, str, bool)   # key, value, confirmed

    def __init__(self, theme: str = "dark"):
        super().__init__()
        self.setObjectName("formpanel")
        self.c = palette(theme)
        self.grid = QGridLayout(self)
        self.grid.setHorizontalSpacing(12)
        self.grid.setVerticalSpacing(8)
        self.grid.setContentsMargins(8, 8, 8, 8)
        self.grid.setColumnStretch(1, 1)
        self.edits: dict[str, QLineEdit] = {}
        self.checks: dict[str, QCheckBox] = {}
        self.sources: dict[str, QLabel] = {}
        self.required: dict[str, bool] = {}

    def set_fields(self, fields) -> None:
        while self.grid.count():
            w = self.grid.takeAt(0).widget()
            if w:
                w.setParent(None)   # hide at once; deleteLater alone leaves ghosts until the loop spins
                w.deleteLater()
        self.edits.clear()
        self.checks.clear()
        self.sources.clear()
        self.required.clear()
        if fields:
            # Column headings say what the badge and the tick mean, so they are not tooltip-only.
            for col, heading in enumerate(("Field", "Value", "Heard", "Confirmed")):
                self.grid.addWidget(section(heading), 0, col)
        for i, f in enumerate(fields, start=1):
            lbl = QLabel(f.label + (" *" if f.required else ""))
            lbl.setToolTip(f.hint)
            e = QLineEdit()
            e.setPlaceholderText(f.hint or "listening…")
            lbl.setBuddy(e)   # the edit takes the row label as its accessible name
            chk = QCheckBox()
            chk.setToolTip("Confirmed – only ticked values are saved to the file")
            chk.setAccessibleName(f"Confirm {f.label}")
            src = QLabel("")
            src.setObjectName("badge")
            src.setVisible(False)
            e.editingFinished.connect(lambda k=f.key, w=e, c=chk: self.edited.emit(k, w.text(), c.isChecked()))
            chk.toggled.connect(lambda on, k=f.key, w=e: self.edited.emit(k, w.text(), on))
            self.grid.addWidget(lbl, i, 0)
            self.grid.addWidget(e, i, 1)
            self.grid.addWidget(src, i, 2)
            self.grid.addWidget(chk, i, 3)
            self.edits[f.key] = e
            self.checks[f.key] = chk
            self.sources[f.key] = src
            self.required[f.key] = f.required

    def set_theme(self, theme: str) -> None:
        self.c = palette(theme)
        css = f"color:{self.c['muted']};font-style:italic;"
        for e in self.edits.values():
            if e.styleSheet():          # AI-filled, unconfirmed values keep their muted italic look
                e.setStyleSheet(css)

    def update_values(self, payload: dict) -> None:
        values = payload.get("values", payload)
        srcs = payload.get("sources", {})
        for k, v in values.items():
            e = self.edits.get(k)
            if e is None or not v or e.hasFocus() or self.checks[k].isChecked():
                continue
            e.setText(v)
            css = f"color:{self.c['muted']};font-style:italic;"   # AI-filled, unconfirmed
            if e.styleSheet() != css:
                e.setStyleSheet(css)
            e.setToolTip("Suggested from the call – tick Confirmed to save it")
            if srcs.get(k):
                where = f"Heard at transcript line {srcs[k]}"
                self.sources[k].setText("heard")
                self.sources[k].setAccessibleName(where)
                self.sources[k].setToolTip(where)
                self.sources[k].setVisible(True)
        for k, chk in self.checks.items():
            if chk.isChecked():
                e = self.edits[k]
                if e.styleSheet():
                    e.setStyleSheet("")
                if e.toolTip():
                    e.setToolTip("")

    def progress(self) -> tuple[int, int]:
        req = [k for k, r in self.required.items() if r]
        done = sum(1 for k in req if self.edits[k].text().strip() and self.checks[k].isChecked())
        return done, len(req)

    def missing(self) -> list[str]:
        return [k for k, r in self.required.items() if r and not self.edits[k].text().strip()]

    def values(self, confirmed_only: bool = False) -> dict:
        return {k: e.text() for k, e in self.edits.items()
                if (not confirmed_only or self.checks[k].isChecked()) and e.text().strip()}

    def confirm_all_filled(self) -> None:
        for k, e in self.edits.items():
            if e.text().strip():
                self.checks[k].setChecked(True)


# ====================================================================== file pane
class FilePane(QFrame):
    """Left column: the file, read-only during the call."""

    change_file = Signal()

    def __init__(self, theme: str = "dark"):
        super().__init__()
        self.setObjectName("card")
        self.c = palette(theme)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 12, 16, 12)
        top = QHBoxLayout()
        top.addWidget(section("File"))
        top.addStretch()
        self.btn = QPushButton("Attach file…")
        self.btn.clicked.connect(self.change_file.emit)
        top.addWidget(self.btn)
        lay.addLayout(top)
        self.body = QTextBrowser()
        self.body.setOpenExternalLinks(False)
        lay.addWidget(self.body, 1)
        self.show_file(None)

    def set_theme(self, theme: str) -> None:
        self.c = palette(theme)
        self.show_file(*self._shown)

    def show_file(self, f, today: dt.date | None = None):
        self._shown = (f, today)
        if f is None:
            self.body.setHtml(f"<p style='color:{self.c['muted']}'>No file attached. This call is treated as a "
                              f"new enquiry. Attach or create a file so the AI knows the history and the "
                              f"wrap-up has somewhere to save.</p>")
            return
        today = today or dt.date.today()
        rows = [f"<h3 style='margin:0'>{html.escape(f.client_name or 'Untitled')}</h3>",
                f"<p style='color:{self.c['muted']};margin:2px 0 8px 0'>{html.escape(f.business)} · "
                f"{html.escape(f.reference or '')}</p>"]

        def kv(k, v, col=None):
            v = html.escape(str(v))
            style = f"color:{col};font-weight:700" if col else ""
            rows.append(f"<div><span style='color:{self.c['muted']}'>{k}</span>&nbsp; <span style='{style}'>{v}</span></div>")

        kv("Reg", f.reg or "–")
        kv("Stage", f.stage)
        hd = f.hire_days(today)
        if hd is not None:
            kv("Hire days", f"{hd} (since {f.hire_start})", self.c["warn"] if hd > 21 else None)
        nd = f.next_deadline()
        if nd:
            left = nd.days_left(today)
            col = self.c["bad"] if left <= 2 else (self.c["warn"] if left <= 7 else None)
            kv("Next deadline", f"{nd.due_at} · {nd.kind} · {nd.text}  ({left}d)", col)
        kv("Signed authority", f"✅ {f.signed_authority_at}" if f.has_signed_authority() else "❌ NOT ON FILE",
           None if f.has_signed_authority() else self.c["bad"])
        if f.insurer or f.tp_insurer:
            kv("Insurers", f"{f.insurer or '?'} / TP {f.tp_insurer or '?'}")
        if f.summary:
            rows.append(f"<p style='margin-top:8px'>{html.escape(f.summary)}</p>")
        recent = sorted(f.chronology, key=lambda c: c.event_date)[-5:]
        if recent:
            rows.append(f"<div style='color:{self.c['muted']};margin-top:8px'>CHRONOLOGY</div>")
            for c in reversed(recent):
                rows.append(f"<div><b>{c.event_date}</b> {html.escape(c.text)}</div>")
        self.body.setHtml("".join(rows))


class PinsList(QTextBrowser):
    def __init__(self, theme: str = "dark"):
        super().__init__()
        self.c = palette(theme)
        self.chips = chip_colours(theme)
        self.pins = []

    def clear_all(self):
        self.pins = []
        self.setHtml("")

    def set_theme(self, theme: str) -> None:
        self.c = palette(theme)
        self.chips = chip_colours(theme)
        if self.pins:
            self._render()

    def add(self, pin):
        self.pins.append(pin)
        self._render()

    def _render(self):
        rows = []
        for p in reversed(self.pins):
            col = self.chips.get(p.kind, self.c["muted"])
            t = dt.datetime.fromtimestamp(p.at).strftime("%H:%M:%S")
            due = f" · due {p.due_at}" if p.due_at else ""
            clip = " · 🔊" if p.clip_path else ""
            rows.append(f"<div style='margin:4px 0'><span style='color:{col};font-weight:700'>{p.kind.upper()}</span> "
                        f"<span style='color:{self.c['muted']}'>{t}{due}{clip}</span><br>"
                        f"<b>{html.escape(p.value)}</b><br><span style='color:{self.c['muted']}'>“{html.escape(p.quote[:140])}”</span></div>")
        self.setHtml("".join(rows))


class AskBar(QWidget):
    asked = Signal(str)

    def __init__(self):
        super().__init__()
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.edit = QLineEdit()
        self.edit.setPlaceholderText("Ask AI (A)… e.g. “they want a 7-seater, what do I say?”")
        btn = QPushButton("Ask")
        btn.setObjectName("primary")
        btn.setToolTip("Ask the AI what to say (shortcut: A)")
        lay.addWidget(self.edit, 1)
        lay.addWidget(btn)
        btn.clicked.connect(self._go)
        self.edit.returnPressed.connect(self._go)

    def _go(self) -> None:
        t = self.edit.text().strip()
        if t:
            self.asked.emit(t)
            self.edit.clear()

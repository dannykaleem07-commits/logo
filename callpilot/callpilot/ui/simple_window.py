"""The simple view: Business profile › Call hub › Call.

Left: the conversation. Right: what to say next, what you still need to get,
and the scripts you read out. The full Call Desk cockpit lives in an
"Advanced" drawer underneath. AI mode lets a named member of the team take
the call in a realistic voice; you can take over at any moment.
"""

from __future__ import annotations

import html
import logging
import sys
import threading
import time

from PySide6.QtCore import QRect, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QAction, QColor, QFont, QFontMetrics, QKeySequence, QShortcut
from PySide6.QtWidgets import (QApplication, QComboBox, QFrame, QHBoxLayout, QLabel, QListView, QListWidget,
                               QListWidgetItem, QMenu, QPushButton, QScrollArea, QSizePolicy, QSplitter, QStatusBar,
                               QStyle, QStyledItemDelegate, QStyleOptionViewItem, QVBoxLayout, QWidget)

from callpilot import __app_name__
from callpilot.ai import tts
from callpilot.core import config, update
from callpilot.core.config import MODEL_PRESETS, apply_preset, preset_for
from callpilot.core.models import ASK, SAY, WATCH, Card
from callpilot.ui.main_window import MainWindow
from callpilot.ui.setup_wizard import SetupWizard, setup_needed
from callpilot.ui.theme import palette
from callpilot.ui.widgets import ElidedLabel, card, scrollable, section

log = logging.getLogger(__name__)

READ_LOCK_S = 6.0        # a fresh answer is not replaced for this long unless you act on it
QUEUE_PROMOTE_S = 9.0    # a queued answer takes over after this long anyway
TRANSCRIPT_TIP = "Download this call's transcript (.txt or .docx)"
SCRIPTS_AUTOHIDE_W = 1240   # below this window width the scripts rail hides itself (125-150 % scaling)
TIGHT_W = 1000              # below this width (150 % scaling) the top bar uses its short labels


def _clip(t: str, n: int) -> str:
    return t if len(t) <= n else t[:n - 1].rstrip() + "…"


class SayPanel(QFrame):
    """One big answer that only ever grows while you read it. A new answer waits in a
    'Next' bar until you've finished (Said it / Not this / →) or a few seconds pass.
    Scripts pin on top and are never replaced until you press Done."""

    changed = Signal()

    def __init__(self, theme: str, font_pt: int):
        super().__init__()
        self.setObjectName("hero")
        self.c = palette(theme)
        self.font_pt = font_pt
        self.current: Card | None = None
        self._side: tuple[Card | None, Card | None] = (None, None)
        self.queued: list[Card] | None = None
        self.pinned_script = False
        self.listening = False
        self._shown_at = 0.0
        self._acted = True
        self._dots = 0
        self._history: list[Card] = []
        self.need: list[str] = []
        self._src_full = ""
        self._compact: bool | None = None
        lay = self._lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 16, 24, 16)
        lay.setSpacing(8)
        top = QHBoxLayout()
        self.title = section("Say next")
        top.addWidget(self.title)
        top.addStretch()
        self.src = QLabel("")
        self.src.setMinimumWidth(1)
        self.src.setObjectName("badge")
        self.src.setVisible(False)
        top.addWidget(self.src)
        lay.addLayout(top)
        # the risk row keeps its height so the answer never jumps down when a warning appears
        self.watch = QLabel("")
        self.watch.setWordWrap(True)
        self.watch.setMinimumHeight(40)
        self.watch.setStyleSheet("")
        self.filler = QLabel("")
        self.filler.setObjectName("filler")
        self.filler.setWordWrap(True)
        self.main = QLabel("")
        self.main.setWordWrap(True)
        self.main.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.main.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Minimum)
        self.more = QLabel("")
        self.more.setWordWrap(True)
        self.more.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.their = QLabel("")
        self.their.setWordWrap(True)
        self.ask = QLabel("")
        self.ask.setWordWrap(True)
        self.ask.setTextFormat(Qt.RichText)
        self.need_lbl = QLabel("")
        self.need_lbl.setWordWrap(True)
        self._base_styles()
        # the answer scrolls inside the panel: a long answer never pushes the window off the screen or gets cut
        # off mid-sentence, and Said it / Show it below stay where they are
        body = QWidget()
        bl = QVBoxLayout(body)
        bl.setContentsMargins(0, 0, 0, 0)
        bl.setSpacing(8)
        for w in (self.watch, self.filler, self.main, self.more, self.their, self.ask, self.need_lbl):
            bl.addWidget(w)
        bl.addStretch()
        self.scroll = scrollable(body)
        self.scroll.setObjectName("sayscroll")
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.scroll.setMinimumHeight(self._answer_min_height())
        self.scroll.setAccessibleName("Say next answer")
        self.scroll.setFocusPolicy(Qt.TabFocus)   # Tab reaches it to scroll a long answer; a click to select text does not ring it
        lay.addWidget(self.scroll, 1)
        # queued "next" bar
        self.next_bar = QFrame()
        self.next_bar.setObjectName("banner_next")
        nb = QHBoxLayout(self.next_bar)
        nb.setContentsMargins(12, 6, 8, 6)
        self.next_lbl = QLabel("")
        self.next_lbl.setWordWrap(True)
        self._next_full = ""
        nb.addWidget(self.next_lbl, 1)
        self.btn_next_now = QPushButton("Show it  (→)")
        self.btn_next_now.setObjectName("primary")
        self.btn_next_now.setToolTip("Show the waiting answer now (Right arrow)")
        self.btn_next_now.clicked.connect(self.promote)
        nb.addWidget(self.btn_next_now)
        self.next_bar.hide()
        lay.addWidget(self.next_bar)
        row = QHBoxLayout()
        self.btn_used = QPushButton("✓  Said it")
        self.btn_used.setObjectName("primary")
        self.btn_used.setToolTip("Space – marks it used and teaches the AI it was right")
        self.btn_used.setAccessibleName("Said it")
        self.btn_next = QPushButton("⟳  Another answer")
        self.btn_next.setToolTip("Ask the AI for a different answer (Ctrl+R)")
        self.btn_next.setAccessibleName("Another answer")
        self.btn_skip = QPushButton("✕  Not this")
        self.btn_skip.setObjectName("ghost")
        self.btn_skip.setToolTip("Esc – teaches the AI to avoid it")
        self.btn_skip.setAccessibleName("Not this")
        self.btn_done = QPushButton("Done reading")
        self.btn_done.setObjectName("primary")
        self.btn_done.setToolTip("Finished reading the script – go back to live answers")
        self.btn_done.setAccessibleName("Done reading")
        self.btn_done.hide()
        # full label, short label: when the full ones do not fit the pane, the row shows the short ones
        # (tooltips and accessible names keep the meaning)
        self._labels = {self.btn_used: ("✓  Said it", "✓ Said it"), self.btn_next: ("⟳  Another answer", "⟳"),
                        self.btn_skip: ("✕  Not this", "✕"), self.btn_done: ("Done reading", "Done")}
        self.btn_copy = QPushButton("⧉")
        self.btn_copy.setObjectName("iconbtn")
        self.btn_copy.setToolTip("Copy the answer")
        self.btn_copy.setAccessibleName("Copy the answer")
        self.btn_speak = QPushButton("🔊")
        self.btn_speak.setObjectName("iconbtn")
        self.btn_speak.setToolTip("Read it aloud")
        self.btn_speak.setAccessibleName("Read the answer aloud")
        for b in (self.btn_used, self.btn_next, self.btn_skip, self.btn_done):
            row.addWidget(b)
        row.addStretch()
        row.addWidget(self.btn_copy)
        row.addWidget(self.btn_speak)
        self._row = row
        lay.addLayout(row)
        self.recent_title = section("Earlier answers")
        self.recent = QListWidget()
        self.recent.setObjectName("recent")
        self.recent.setWordWrap(True)
        self.recent.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.recent.setMaximumHeight(110)
        self.recent.setMinimumHeight(40)
        lay.addWidget(self.recent_title)
        lay.addWidget(self.recent)
        self.btn_copy.clicked.connect(self.copy)
        self.btn_done.clicked.connect(self.release)
        self.recent.itemClicked.connect(self._recall)
        self.recent.itemActivated.connect(self._recall)
        self._pulse = QTimer(self)
        self._pulse.timeout.connect(self._tick)
        self._pulse.start(500)
        self.reset()

    # ------------------------------------------------------------- layout
    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._fit_row()
        self._fit_src()
        self._fit_next()
        self._fit_height()

    def _fit_next(self):
        """The waiting answer is a preview: at most about two lines, the rest in its tooltip."""
        if not self._next_full:
            return
        m = self._lay.contentsMargins()
        room = self.width() - m.left() - m.right() - self.btn_next_now.sizeHint().width() - 48
        self.next_lbl.setText(self.next_lbl.fontMetrics().elidedText(self._next_full, Qt.ElideRight, max(80, int(room * 1.75))))

    def _fit_height(self):
        """When the pane is short (1366 x 768 with a banner or the Advanced drawer, 125-150 % scaling) the answer keeps
        the room: 'Earlier answers' tucks away and comes back when the pane is tall enough again. It depends on the
        pane's height only, never on the answer's length, so Said it / Show it never shift while an answer grows."""
        has = self.recent.count() > 0
        # a constant height (two rows from the font), so nothing moves when the first earlier answer arrives
        recent_h = min(110, 2 * (self.recent.fontMetrics().lineSpacing() + 14) + 2 * self.recent.spacing() + 8)
        self.recent.setFixedHeight(recent_h)
        m = self._lay.contentsMargins()
        sp = self._lay.spacing()
        fixed = m.top() + m.bottom() + self.title.sizeHint().height() + sp + self.btn_used.sizeHint().height() + sp
        fixed += self.btn_next_now.sizeHint().height() + 16 + sp   # room for the Next bar, counted whether or not it shows
        recent_block = self.recent_title.sizeHint().height() + recent_h + 2 * sp
        room = self._answer_min_height() + 96
        fits = self.height() - fixed - recent_block >= room
        # Decided on the pane's height only. While it fits, the block keeps its space even before the first earlier
        # answer exists, so Said it / Show it never jump up mid-read; when it doesn't fit, it gives the answer the room.
        for w in (self.recent_title, self.recent):
            pol = w.sizePolicy()
            if pol.retainSizeWhenHidden() != fits:
                pol.setRetainSizeWhenHidden(fits)
                w.setSizePolicy(pol)
            w.setVisible(fits and has)

    def _label_width(self, b: QPushButton, text: str) -> int:
        b.ensurePolished()
        f = QFont(b.font())
        f.setBold(True)   # primary buttons are bold; measuring every label bold errs on the safe side
        return QFontMetrics(f).horizontalAdvance(text) + 2 * 16   # 14 px padding + 1 px border each side, +1 slack

    def _full_row_width(self) -> int:
        """Width the action row needs with its full labels: the real size where a button shows its full label, an
        estimate from the font (a little generous) where it shows the short one. The generous estimate gives the
        switch back to full labels some hysteresis, so the row never flickers between the two."""
        need = 0
        shown = 0
        for b, (full, short) in self._labels.items():
            b.setMinimumWidth(self._label_width(b, short))   # the row (and so the pane) can shrink to the short labels
            if b.isHidden():
                continue
            need += b.sizeHint().width() if b.text() == full else self._label_width(b, full)
            shown += 1
        for b in (self.btn_copy, self.btn_speak):
            need += b.sizeHint().width()
            shown += 1
        return need + self._row.spacing() * shown

    def _fit_row(self):
        wide_margins = 24
        compact = self.width() < self._full_row_width() + 2 * wide_margins + 8   # + the hero frame's 5 px edge
        if compact == self._compact:
            return
        self._compact = compact
        for b, (full, short) in self._labels.items():
            b.setText(short if compact else full)
        m = 16 if compact else wide_margins
        self._lay.setContentsMargins(m, 16, m, 16)

    def _fit_src(self):
        """The source badge never cuts a word in half: it elides with '…' to the room it has; the tooltip has it all."""
        if not self._src_full:
            return
        room = self.width() - self._lay.contentsMargins().left() - self._lay.contentsMargins().right() \
            - self.title.sizeHint().width() - 24 - 20
        self.src.setText(self.src.fontMetrics().elidedText(self._src_full, Qt.ElideRight, max(40, room)))

    # ------------------------------------------------------------- timers / helpers
    def _tick(self):
        if self.current is None:
            self._dots = (self._dots + 1) % 4
            self.main.setText(("Listening" + "." * self._dots) if self.listening else "Ready when you are")
        elif self.queued is not None and not self.pinned_script and time.time() - self._shown_at > QUEUE_PROMOTE_S:
            self.promote()

    def copy(self):
        if self.current:
            QApplication.clipboard().setText(self.current.translated or self.current.spoken())
            self.btn_copy.setText("✓")
            self.btn_copy.setToolTip("Copied")

            def restore():
                self.btn_copy.setText("⧉")
                self.btn_copy.setToolTip("Copy the answer")

            QTimer.singleShot(1500, self, restore)

    def visible_cards(self) -> list[Card]:
        """What the reader sees right now; the overlay mirrors this, never the raw deck."""
        w, a = self._side
        return [c for c in (w, self.current, a) if c]

    def _recall(self, item: QListWidgetItem):
        c = item.data(Qt.UserRole)
        if isinstance(c, Card):
            self._render(c, None, None, force=True)

    def _remember(self, c: Card):
        if not c.text or c.origin in ("script", "pinned"):
            return
        if self._history and self._history[-1].id == c.id:
            self._history[-1] = c
        else:
            self._history.append(c)
            self._history = self._history[-6:]
        self.recent.clear()
        for h in reversed(self._history[:-1]):
            it = QListWidgetItem("↶  " + _clip(h.text, 90))
            it.setToolTip(h.text)
            it.setData(Qt.UserRole, h)
            self.recent.addItem(it)
        self._fit_height()

    def acted(self):
        """Said it / Not this: the reader is finished with the current answer."""
        self._acted = True
        if self.queued is not None:
            self.promote()

    def promote(self):
        if self.queued is None:
            return
        cards, self.queued = self.queued, None
        self._next_full = ""
        self.next_bar.hide()
        self.pinned_script = False
        self._show_done(False)
        self.show_cards(cards, force=True)

    def pin_script(self, title: str, text: str):
        c = Card(SAY, text, [title], origin="script")
        c.filler = title
        self.pinned_script = True
        self._show_done(True)
        self._render(c, None, None, force=True)

    def _show_done(self, on: bool):
        self.btn_done.setVisible(on)
        self._compact = None   # the row's needs changed: re-decide full or short labels
        self._fit_row()

    def release(self):
        self.pinned_script = False
        self._show_done(False)
        if self.queued is not None:
            self.promote()
        else:
            self.current = None
            self.show_cards([], force=True)

    def set_need(self, items: list[str]):
        self.need = items
        self.need_lbl.setText(("Still need:  " + "   ·   ".join(items[:6]) + ("  …" if len(items) > 6 else "")) if items else "")
        self.need_lbl.setVisible(bool(items))
        self._fit_height()

    # ------------------------------------------------------------- rendering
    def show_cards(self, cards: list[Card], force: bool = False):
        by = {c.type: c for c in cards}
        s, w, a = by.get(SAY), by.get(WATCH), by.get(ASK)
        reading = (self.current is not None and not self._acted and time.time() - self._shown_at < READ_LOCK_S)
        new_answer = s is not None and (self.current is None or s.id != self.current.id)
        if not force and (self.pinned_script or (reading and new_answer)):
            # don't pull the reader's eye: queue the new answer, but still show risk/ask lines
            if new_answer:
                self.queued = cards
                self._next_full = "Next answer ready:  " + (s.text or "…")
                self.next_lbl.setToolTip(s.text or "")
                self.next_bar.show()
                self._fit_next()
                self._fit_height()
            self._render_side(w, a)
            return
        # rendering the live deck directly: anything still queued is older than this
        self.queued = None
        self._next_full = ""
        self.next_bar.hide()
        self._render(s, w, a)

    def _render_side(self, w: Card | None, a: Card | None):
        self.watch.setText(("⚠  " + w.text) if w else "")
        css = self._watch_css if w else ""
        if self.watch.styleSheet() != css:
            self.watch.setStyleSheet(css)
        self.ask.setText((f"<span style='color:{self.c['muted']}'>Then ask</span>&nbsp; "
                          + " &nbsp;•&nbsp; ".join(html.escape(q) for q in a.text.split(" | "))) if a else "")
        self.ask.setVisible(bool(a))
        self._side = (w, a)
        self._fit_height()
        self.changed.emit()

    def _render(self, s: Card | None, w: Card | None, a: Card | None, force: bool = False):
        new_card = s is None or self.current is None or s.id != self.current.id
        if s is not None and (self.current is None or s.id != self.current.id):
            self._shown_at = time.time()
            self._acted = False
        self.current = s
        if new_card:
            self.scroll.verticalScrollBar().setValue(0)   # a different answer starts at its first line
        self._render_side(w, a)
        if s:
            self.filler.setText(f"“{s.filler}”" if s.filler else "")
            self.main.setText(s.text or "…")
            css = f"color:{self.c['say']};font-weight:800;font-size:{self.font_pt + 13}pt;"
            self.more.setText(s.more)
            self.their.setText(("🌐  " + s.translated) if s.translated else "")
            origin = {"playbook": "⚡ instant", "rule": "rule", "llm": "AI", "script": "script", "ai": "🤖 AI said"}.get(s.origin, s.origin)
            src = next((x for x in s.sources if x and x != "model"), "")
            label = "from memory" if src.startswith("memory:") else _clip(src, 36)
            self._src_full = origin + (f" · {label}" if label else "") + ("" if s.done else " · writing…")
            self.src.setToolTip("Where this answer came from: " + origin + (f" · {src}" if src else ""))
            self.src.setText(self._src_full)
            self.src.setVisible(True)
            self._fit_src()
            self.title.setText("SCRIPT" if s.origin == "script" else ("AI EMPLOYEE SAID" if s.origin == "ai" else "SAY NEXT"))
            if s.origin == "ai":
                self.ask.setText("You're listening in. Press Take over to speak to the caller.")
                self.ask.setVisible(True)
            if s.done:
                self._remember(s)
        else:
            self.filler.setText("")
            self.main.setText("Listening…" if self.listening else "Ready when you are")
            css = f"color:{self.c['muted']};font-weight:600;font-size:{self.font_pt + 8}pt;"
            self.more.setText("")
            self.their.setText("")
            self._src_full = ""
            self.src.setVisible(False)
            self.title.setText("SAY NEXT")
        if self.main.styleSheet() != css:
            self.main.setStyleSheet(css)
        for w_ in (self.filler, self.more, self.their):
            w_.setVisible(bool(w_.text()))
        live_answer = s is not None and s.origin not in ("script", "ai")
        for b in (self.btn_used, self.btn_skip, self.btn_copy, self.btn_speak):
            b.setEnabled(live_answer)
        self.btn_next.setEnabled(self.listening and live_answer)
        self._fit_height()

    def _answer_min_height(self) -> int:
        """The risk row, the opener ("That's a good question.") and two lines of the answer: the answer is never
        squeezed to the tops of its letters."""
        f = QFont(self.font())
        f.setPointSize(self.font_pt + 13)
        f.setBold(True)
        filler = QFont(self.font())
        filler.setPointSize(self.font_pt + 2)
        filler.setItalic(True)
        # risk row (40 + its padding/border 16) + gap, opener line + gap, two answer lines, the frame's 2 px border
        return 40 + 16 + 8 + QFontMetrics(filler).lineSpacing() + 8 + 2 * QFontMetrics(f).lineSpacing() + 4

    def _base_styles(self):
        pt = self.font_pt
        self._watch_css = (f"color:{self.c['bad_text']};font-weight:700;font-size:{pt + 2}pt;"
                           f"background:rgba(239,68,68,0.10);border:1px solid {self.c['bad']};border-radius:10px;padding:8px 12px;")
        self.more.setStyleSheet(f"font-size:{pt + 5}pt;")
        self.their.setStyleSheet(f"color:{self.c['caller']};font-size:{pt + 3}pt;")
        self.ask.setStyleSheet(f"color:{self.c['text']};font-size:{pt + 1}pt;")
        self.need_lbl.setStyleSheet(f"color:{self.c['warn']};font-size:{pt}pt;")

    def set_theme(self, theme: str, font_pt: int) -> None:
        """Live theme / font-size switch. Re-renders the answer in place: same card, same scroll position,
        the read lock and any queued answer are untouched."""
        self.c = palette(theme)
        self.font_pt = font_pt
        self._base_styles()
        self.scroll.setMinimumHeight(self._answer_min_height())
        self.watch.setStyleSheet("")      # forces _render_side to apply the new risk style
        self.main.setStyleSheet("")
        self.set_need(self.need)
        if self.current is not None or any(self._side):
            pos = self.scroll.verticalScrollBar().value()
            self._render(self.current, *self._side)
            self.scroll.verticalScrollBar().setValue(pos)
        else:
            self._render(None, None, None)

    def reset(self):
        self._history = []
        self.queued = None
        self.pinned_script = False
        self.btn_done.hide()
        self.next_bar.hide()
        self.recent.clear()
        self.recent_title.setVisible(False)
        self.recent.setVisible(False)
        self.set_need([])
        self.current = None
        self.show_cards([], force=True)


class _HScroll(QScrollArea):
    """A toolbar that scrolls sideways when the window is narrower than it, instead of forcing the whole
    window wider than the screen. Its height is the toolbar's, plus the thin scrollbar only when it shows."""

    BAR = 10

    def __init__(self, w: QWidget):
        super().__init__()
        self.setWidget(w)
        self.setWidgetResizable(True)
        self.setFrameShape(QFrame.NoFrame)
        self.setFocusPolicy(Qt.NoFocus)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        w.setAutoFillBackground(False)
        self.viewport().setAutoFillBackground(False)
        self._bar = 0

    def _need_bar(self) -> int:
        w = self.widget()
        return self.BAR if w is not None and w.minimumSizeHint().width() > self.width() else 0

    def minimumSizeHint(self):
        w = self.widget()
        return QSize(0, (w.minimumSizeHint().height() if w is not None else 0) + self._need_bar())

    def sizeHint(self):
        w = self.widget()
        return QSize(w.sizeHint().width() if w is not None else 0, self.minimumSizeHint().height())

    def resizeEvent(self, e):
        super().resizeEvent(e)
        bar = self._need_bar()
        if bar != self._bar:
            self._bar = bar
            self.updateGeometry()


class Banner(QFrame):
    def __init__(self, obj: str, button: str, slot, second: str = "", second_slot=None):
        super().__init__()
        self.setObjectName(obj)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(16, 8, 12, 8)
        self.label = QLabel("")
        self.label.setWordWrap(True)
        lay.addWidget(self.label, 1)
        btn = QPushButton(button)
        btn.setObjectName("primary")
        btn.setAccessibleName(button)
        btn.clicked.connect(slot)
        lay.addWidget(btn)
        self.btn = btn
        if second:
            b2 = QPushButton(second)
            b2.clicked.connect(second_slot)
            lay.addWidget(b2)
        x = QPushButton("✕")
        x.setObjectName("iconbtn")
        x.setToolTip("Dismiss")
        x.setAccessibleName("Dismiss this message")
        x.clicked.connect(self.hide)
        lay.addWidget(x)
        self.hide()


WHEN_TAG = {"opening": "Opening", "consent": "Notice", "terms": "Terms", "closing": "Closing"}
TAG_ROLE = Qt.UserRole + 1


class _ScriptDelegate(QStyledItemDelegate):
    """A script row: a small 'when' tag (Opening, Notice, Terms, Closing) over the title; scripts for any point in the
    call have no tag. Titles wrap in full, never elide, and every line starts at the same edge."""

    PAD_X, PAD_Y, GAP = 8, 6, 2

    def __init__(self, view: QListWidget, theme: str):
        super().__init__(view)
        self.view = view
        self.c = palette(theme)

    def _fonts(self, option):
        title = QFont(option.font)
        tag = QFont(option.font)
        tag.setPointSizeF(max(8.0, title.pointSizeF() - 2))
        tag.setBold(True)
        tag.setLetterSpacing(QFont.AbsoluteSpacing, 0.6)
        return tag, title

    def _text_width(self) -> int:
        return max(60, self.view.viewport().width() - 2 * self.PAD_X - 2 * self.view.spacing() - 4)

    def sizeHint(self, option, index):
        tag_f, title_f = self._fonts(option)
        w = self._text_width()
        title = index.data(Qt.DisplayRole) or ""
        h = QFontMetrics(title_f).boundingRect(QRect(0, 0, w, 10000), Qt.TextWordWrap, title).height()
        if index.data(TAG_ROLE):
            h += QFontMetrics(tag_f).height() + self.GAP
        return QSize(w + 2 * self.PAD_X, h + 2 * self.PAD_Y)

    def paint(self, painter, option, index):
        opt = QStyleOptionViewItem(option)
        self.initStyleOption(opt, index)
        style = opt.widget.style() if opt.widget else QApplication.style()
        opt.text = ""
        style.drawControl(QStyle.CE_ItemViewItem, opt, painter, opt.widget)   # background, hover, selection from the theme
        selected = bool(opt.state & QStyle.State_Selected)
        tag_f, title_f = self._fonts(option)
        r = option.rect.adjusted(self.PAD_X, self.PAD_Y, -self.PAD_X, -self.PAD_Y)
        painter.save()
        tag = index.data(TAG_ROLE) or ""
        th = 0
        if tag:
            painter.setFont(tag_f)
            painter.setPen(QColor("white" if selected else self.c["muted"]))
            th = QFontMetrics(tag_f).height()
            painter.drawText(QRect(r.left(), r.top(), r.width(), th), Qt.AlignLeft | Qt.AlignVCenter, tag.upper())
            th += self.GAP
        painter.setFont(title_f)
        painter.setPen(QColor("white" if selected else self.c["text"]))
        painter.drawText(QRect(r.left(), r.top() + th, r.width(), r.height() - th),
                         Qt.TextWordWrap | Qt.AlignLeft | Qt.AlignTop, index.data(Qt.DisplayRole) or "")
        painter.restore()


class ScriptsPanel(QFrame):
    """The scripts for this business and hub. Click one to read it, large, without the AI
    replacing it until you press Done."""

    def __init__(self, on_pick, theme: str = "dark"):
        super().__init__()
        self.setObjectName("card")
        self.on_pick = on_pick
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 12, 16, 12)
        lay.addWidget(section("Scripts"))
        self.list = QListWidget()
        self.list.setObjectName("scripts")
        self.list.setWordWrap(True)
        self.list.setTextElideMode(Qt.ElideNone)
        self.list.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.list.setResizeMode(QListView.Adjust)        # rows re-wrap when the rail changes width
        self.list.setUniformItemSizes(False)
        self.list.setSpacing(2)
        self.list.setItemDelegate(_ScriptDelegate(self.list, theme))
        self.list.setAccessibleName("Scripts")
        self.list.itemClicked.connect(self._pick)
        self.list.itemActivated.connect(self._pick)
        lay.addWidget(self.list, 1)
        hint = QLabel("Click one, or select it and press Enter, to read it out. In call order.")
        hint.setObjectName("hint")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        self.scripts: list[dict] = []
        self.setMinimumWidth(160)
        self.setMaximumWidth(320)

    def set_theme(self, theme: str) -> None:
        self.list.itemDelegate().c = palette(theme)
        self.list.doItemsLayout()          # row heights follow a new font size
        self.list.viewport().update()

    def set_scripts(self, scripts: list[dict]):
        self.scripts = scripts
        self.list.clear()
        order = {"opening": 0, "consent": 1, "terms": 2, "": 3, "closing": 4}
        for sc in sorted(scripts, key=lambda s: order.get(s.get("when", ""), 3)):
            tag = WHEN_TAG.get(sc.get("when", ""), "")
            title = sc.get("title", "Script")
            if title.strip().lower() == tag.lower():
                tag = ""   # a script called 'Opening' needs no 'OPENING' above it
            it = QListWidgetItem(title)
            it.setData(Qt.UserRole, sc)
            it.setData(TAG_ROLE, tag)
            it.setData(Qt.AccessibleTextRole, f"{tag}: {title}" if tag else title)
            it.setToolTip(sc.get("text", "")[:400])
            self.list.addItem(it)

    def _pick(self, item: QListWidgetItem):
        sc = item.data(Qt.UserRole)
        if sc:
            self.on_pick(sc.get("title", "Script"), sc.get("text", ""))


class SimpleWindow(MainWindow):
    """Same engine and the same logic as the cockpit; a much simpler face."""

    START_LABEL = "●  Start call"
    _ai_label = ""

    def _build(self):
        self._build_header()
        self._build_columns()
        self._build_bottom()
        self._build_statusbar_widgets()

        root = QWidget()
        root.setObjectName("root")
        self.setCentralWidget(root)
        v = QVBoxLayout(root)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)

        # ---- top bar, two rows. Row 1: Business › Hub › Call. Row 2: AI, levels and tools.
        top = QFrame()
        top.setObjectName("header")
        self.topbar = top
        outer = QVBoxLayout(top)
        outer.setContentsMargins(16, 8, 16, 8)
        outer.setSpacing(6)
        row1 = QHBoxLayout()
        row1.setSpacing(8)
        row2 = QHBoxLayout()
        row2.setSpacing(8)
        outer.addLayout(row1)
        outer.addLayout(row2)
        title = QLabel(f"◉ {__app_name__}")
        title.setObjectName("title")
        row1.addWidget(title)
        self.business_combo = QComboBox()
        self.business_combo.setToolTip("Business profile – rules, status line and scripts for every call this business takes")
        self.business_combo.currentIndexChanged.connect(self._business_changed)
        row1.addWidget(self.business_combo, 1)   # the combos take spare width (up to their maximum) before the trailing gap
        row1.addWidget(QLabel("›"))
        self.hub_combo.setToolTip("Call hub – the call type: answers, knowledge, intake")
        row1.addWidget(self.hub_combo, 1)
        row1.addWidget(QLabel("›"))
        row1.addWidget(self.btn_call)
        self.btn_new = QPushButton("+ New call")
        self.btn_new.setObjectName("ghost")
        self.btn_new.setToolTip("End this call, do the wrap-up, then start the next one straight away.")
        self.btn_new.clicked.connect(self._new_call)
        self.btn_new.setVisible(False)
        row1.addWidget(self.btn_new)
        self.state_pill = QLabel("Idle")
        self.state_pill.setObjectName("pill_idle")
        row1.addWidget(self.state_pill)
        row1.addStretch()

        self.btn_ai = QPushButton("🤖 AI mode")
        self.btn_ai.setCheckable(True)
        self.btn_ai.setObjectName("ghost")
        self.btn_ai.setProperty("bar", True)   # as 'Take over' it is red but toolbar-sized, so the bar fits 150 % scaling
        self.btn_ai.setToolTip("Available during a call. A named member of the team takes the call in a realistic voice "
                               "– click again to take over.")
        self.btn_ai.toggled.connect(self._ai_toggled)
        row2.addWidget(self.btn_ai)
        self.preset_combo = QComboBox()
        for key, p in MODEL_PRESETS.items():
            self.preset_combo.addItem(p["label"], key)
        self.preset_combo.setCurrentIndex(max(0, self.preset_combo.findData(preset_for(self.s.ai) or self.s.ai.preset)))
        self.preset_combo.currentIndexChanged.connect(self._preset_changed)
        self.preset_combo.setToolTip("Which AI writes your answers")
        row2.addWidget(self.preset_combo, 1)
        for cb in (self.business_combo, self.hub_combo, self.preset_combo):
            cb.setMinimumWidth(0)   # the hub combo inherits a 260 px minimum from the cockpit header
            cb.setSizeAdjustPolicy(QComboBox.AdjustToMinimumContentsLengthWithIcon)
            cb.setMinimumContentsLength(7)   # they grow to 300 px when there is room; 7 characters fit 150 % scaling
            cb.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
            cb.setMaximumWidth(300)
        self.memory_lbl = QLabel("")
        self.memory_lbl.setObjectName("hint")
        self.memory_lbl.setToolTip("What the AI has learned from your past calls. Review in ⚙ → Settings → Memory.")
        row2.addWidget(self.timer_lbl)
        # each level bar carries its own word, so 'is the caller coming through?' needs no hovering
        for meter, word, name in ((self.mic_meter, "You", "Your microphone level"),
                                  (self.caller_meter, "Caller", "Caller sound level")):
            pair = QHBoxLayout()
            pair.setSpacing(4)
            lbl = QLabel(word)
            lbl.setObjectName("hint")
            lbl.setToolTip(name)
            pair.addWidget(lbl)
            meter.setFixedWidth(48)
            meter.setToolTip(name)
            meter.setAccessibleName(name)
            pair.addWidget(meter)
            row2.addLayout(pair)
        row2.addStretch()
        self.btn_mute.setObjectName("iconbtn")
        row2.addWidget(self.btn_mute)
        self.btn_scripts = QPushButton("Scripts")
        self.btn_scripts.setObjectName("ghost")
        self.btn_scripts.setCheckable(True)
        self.btn_scripts.setChecked(True)
        self.btn_scripts.setToolTip("Show or hide the scripts panel")
        self.btn_scripts.toggled.connect(self._scripts_toggled)
        self._scripts_wanted = True    # the handler's own choice; a narrow window hides the rail without changing it
        self._scripts_auto = False
        self._narrow: bool | None = None
        row2.addWidget(self.btn_scripts)
        self.btn_calls = QPushButton("Calls")
        self.btn_calls.setObjectName("ghost")
        self.btn_calls.setToolTip("Open the calls list")
        self.btn_calls.clicked.connect(self._open_calls)
        row2.addWidget(self.btn_calls)
        self.btn_advanced = QPushButton("Advanced ▾")
        self.btn_advanced.setObjectName("ghost")
        self.btn_advanced.setCheckable(True)
        self.btn_advanced.setToolTip("Show the advanced cockpit")
        self.btn_advanced.toggled.connect(self._toggle_advanced)
        row2.addWidget(self.btn_advanced)
        gear = QPushButton("⚙")
        gear.setObjectName("iconbtn")
        gear.setToolTip("Menu: business profile, hub training, settings")
        gear.setAccessibleName("Menu")
        menu = QMenu(self)
        for label, slot in (("Business profile…", self._edit_business), ("Edit / train this hub…", self._edit_hub),
                            ("Rehearse with the AI…", self._rehearse), ("Settings…", lambda: self._open_settings()),
                            ("Run setup again…", self._run_setup), ("Save last call to computer…", self._save_call_to_computer),
                            ("Call history…", self._open_history),
                            ("Floating overlay", lambda: self.btn_overlay.setChecked(not self.overlay.isVisible()))):
            act = QAction(label, self)
            act.triggered.connect(slot)
            menu.addAction(act)
        gear.setMenu(menu)
        row2.addWidget(gear)
        v.addWidget(top)

        # ---- banners
        banners = QWidget()
        bv = QVBoxLayout(banners)
        bv.setContentsMargins(16, 8, 16, 0)
        bv.setSpacing(6)
        self.setup_banner = Banner("banner", "Run setup", self._run_setup)
        self.call_banner = Banner("banner_ok", "Start listening", self._banner_start)
        self.handoff_banner = Banner("banner", "Take over", self._take_over)
        self.handoff_banner.btn.setObjectName("danger")   # same red 'Take over' as the top bar
        self.handoff_banner.btn.setProperty("bar", True)
        self.ai_banner = Banner("banner", "Open AI mode settings", lambda: self._open_settings(6))
        self.update_banner = Banner("banner_ok", "Download update", self._open_update)
        for b in (self.setup_banner, self.call_banner, self.handoff_banner, self.ai_banner, self.update_banner):
            bv.addWidget(b)
        v.addWidget(banners)

        # ---- panes
        body = QWidget()
        bl2 = QHBoxLayout(body)
        bl2.setContentsMargins(16, 8, 16, 8)
        split = QSplitter(Qt.Horizontal)
        bl2.addWidget(split)
        left = card()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(16, 12, 16, 12)
        lt = QHBoxLayout()
        lt.addWidget(section("Conversation"))
        lt.addStretch()
        lt.addWidget(self.lang_badge)
        lt.addWidget(self.sentiment)
        self.btn_transcript = QPushButton("⬇ Transcript")
        self.btn_transcript.setObjectName("ghost")
        self.btn_transcript.clicked.connect(self._download_transcript)
        self.btn_transcript.setEnabled(False)
        self.btn_transcript.setToolTip("Available once a call has started")
        lt.addWidget(self.btn_transcript)
        ll.addLayout(lt)
        ll.addWidget(self.transcript, 1)
        ll.addWidget(self.ask_bar)
        split.addWidget(left)
        self.say_panel = SayPanel(self.s.ui.theme, self.s.ui.font_pt)
        self.say_panel.btn_used.clicked.connect(lambda: self._card_action(None, "used"))
        self.say_panel.btn_skip.clicked.connect(lambda: self._card_action(None, "dismissed"))
        self.say_panel.btn_next.clicked.connect(self._regenerate)
        self.say_panel.btn_speak.clicked.connect(self._speak_current)
        self.say_panel.changed.connect(self._sync_overlay)
        split.addWidget(self.say_panel)
        self.scripts_panel = ScriptsPanel(self._read_script, self.s.ui.theme)
        split.addWidget(self.scripts_panel)
        split.setSizes([500, 760, 240])

        # ---- advanced drawer
        self.drawer = QWidget()
        dl = QVBoxLayout(self.drawer)
        dl.setContentsMargins(16, 0, 16, 0)
        dl.setSpacing(4)
        for strip in (self._header, self._bottom):
            strip.setObjectName("toolbar")
            strip.layout().setContentsMargins(16, 8, 16, 8)
        dl.addWidget(_HScroll(self._header))
        # these duplicate the top bar, the ⚙ menu or the File pane
        for wdg in (self._title, self.btn_settings, self.btn_history, self.caller_lbl, self.latency_badge):
            wdg.hide()
        adv_split = QSplitter(Qt.Horizontal)
        adv_split.addWidget(self.file_pane)
        adv_split.addWidget(self._right_panel)
        adv_split.setSizes([400, 700])
        adv_split.setMinimumHeight(240)   # file + intake keep a usable height; on a short screen they scroll
        # Only the file / intake area scrolls; the two drawer toolbars (call controls, Pin / Task / Wrap up) always
        # stay in view. Opening Advanced never pushes the window past a laptop screen and never squeezes the answer
        # above it below two readable lines.
        self.drawer_scroll = scrollable(adv_split)
        self.drawer_scroll.setMinimumHeight(24)   # it scrolls; on a short screen the answer and both toolbars come first
        dl.addWidget(self.drawer_scroll, 1)
        dl.addWidget(_HScroll(self._bottom))
        self.drawer.hide()
        self.vsplit = QSplitter(Qt.Vertical)
        self.vsplit.setChildrenCollapsible(False)
        self.vsplit.setHandleWidth(4)
        self.vsplit.addWidget(body)
        self.vsplit.addWidget(self.drawer)
        self.vsplit.setStretchFactor(0, 3)
        self.vsplit.setStretchFactor(1, 2)
        v.addWidget(self.vsplit, 1)
        self.cards_scroll.hide()       # hide the scroll area, not just the CardsPanel inside it

        sb = QStatusBar()
        self.setStatusBar(sb)
        # the status message gets the room it needs; the shortcut reminder takes what is left and ends in '…'
        self.status_lbl.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Preferred)
        self.status_lbl.setMinimumWidth(1)              # a long message still never widens the window
        self.status_lbl.setContentsMargins(8, 0, 8, 0)
        sb.addWidget(self.status_lbl)
        hint = ElidedLabel("Space = said it  ·  Esc = not this  ·  → = next  ·  Ctrl+R = another  ·  A = ask AI")
        hint.setObjectName("hint")
        hint.setToolTip("Keyboard shortcuts: Space = said it, Esc = not this, → = show the next answer, "
                        "Ctrl+R = another answer, A = ask the AI")
        hint.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        hint.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        sb.addWidget(hint, 1)
        self.memory_lbl.setContentsMargins(8, 0, 0, 0)
        lock = QLabel("🔒 Encrypted on this PC")
        lock.setObjectName("hint")
        sb.addPermanentWidget(self.memory_lbl)
        sb.addPermanentWidget(lock)
        self._install_shortcuts()
        sc = QShortcut(QKeySequence("Right"), self)
        sc.setContext(Qt.WindowShortcut)
        sc.activated.connect(self.say_panel.promote)
        self._set_call_buttons(False)
        self.btn_ai.setEnabled(False)
        self._detect = QTimer(self)
        self._detect.timeout.connect(self._auto_detect)
        self._detect.start(4000)
        self._load_businesses()
        self._update_memory_badge()
        self._refresh_setup_banner()
        update.check(lambda newer, sha: self.bridge.event.emit("update", {"newer": newer, "sha": sha}))

    # ------------------------------------------------------------- business › hub
    def _load_businesses(self):
        self.business_combo.blockSignals(True)
        self.business_combo.clear()
        for b in self.businesses.list():
            self.business_combo.addItem(b.name, b.id)
        self.business_combo.addItem("All hubs", "")
        hub = self.current_hub()
        want = hub.business_id if hub and hub.business_id else self.s.active_business
        idx = self.business_combo.findData(want)
        self.business_combo.setCurrentIndex(max(0, idx))
        self.business_combo.blockSignals(False)
        self._filter_hubs()

    def _filter_hubs(self):
        bid = self.business_combo.currentData()
        current = self.hub_combo.currentData()
        self.hub_combo.blockSignals(True)
        self.hub_combo.clear()
        for hub in self.hubs.list():
            if not bid or hub.business_id == bid:
                self.hub_combo.addItem(hub.name.split("–", 1)[-1].strip() if bid else hub.name, hub.id)
        idx = self.hub_combo.findData(current)
        self.hub_combo.setCurrentIndex(max(0, idx))
        self.hub_combo.blockSignals(False)
        self._on_hub_changed()

    def _business_changed(self, _):
        bid = self.business_combo.currentData()
        if bid:
            self.s.active_business = bid
            config.save(self.s)
        self._filter_hubs()

    def _load_hubs(self, select=None):
        super()._load_hubs(select)
        if hasattr(self, "business_combo"):
            self._load_businesses()

    def _on_hub_changed(self, *_):
        super()._on_hub_changed()
        if hasattr(self, "scripts_panel"):
            hub = self.current_hub()
            if hub:
                self.scripts_panel.set_scripts(hub.all_scripts(self.current_business()))
        self._update_memory_badge()

    # ------------------------------------------------------------- scripts / reading
    def _read_script(self, title: str, text: str):
        f = self.case_file
        text = (text.replace("{agent}", self.s.agent_name or "…")
                .replace("{client}", f.client_name if f else "the client")
                .replace("{reference}", f.reference if f and f.reference else "…"))
        self.say_panel.pin_script(title, text)   # pin_script re-syncs the overlay
        if "record" in title.lower() or "notice" in title.lower():
            self._notice_given()

    def _show_script(self, text: str, label: str, more: str = ""):
        super()._show_script(text, label, more)
        if text:
            self._read_script(label, text + (("  " + more) if more else ""))

    # ------------------------------------------------------------- setup / state
    def _refresh_setup_banner(self):
        reason = setup_needed(self.s)
        if not reason:
            self.setup_banner.hide()
            return
        live = self.controller is not None
        self.setup_banner.label.setText(f"⚠  Setup needed: {reason}. You can run setup after this call." if live
                                        else f"⚠  Setup needed: {reason}.")
        self.setup_banner.btn.setVisible(not live)   # hidden, not disabled: a disabled primary still looks active
        self.setup_banner.show()

    def _run_setup(self):
        if self.controller is not None:
            self.status_lbl.setText("Setup is available after this call.")
            return
        before = (self.s.ui.theme, self.s.ui.font_pt)
        SetupWizard(self.s, self).exec()
        self.preset_combo.blockSignals(True)
        self.preset_combo.setCurrentIndex(max(0, self.preset_combo.findData(preset_for(self.s.ai) or self.s.ai.preset)))
        self.preset_combo.blockSignals(False)
        if (self.s.ui.theme, self.s.ui.font_pt) != before:
            self._apply_theme()
        else:
            self._update_model_badge()
        self._refresh_setup_banner()

    def _set_state(self, live: bool, notice: bool, paused: bool = False, ai: str = ""):
        self._state_args = (live, notice, paused, ai)
        tight = self.width() < TIGHT_W       # 150 % scaling: short words, full meaning in the tooltip
        if not live:
            txt, obj = "Idle", "pill_idle"
        elif ai:
            txt, obj = ("🤖 AI" if tight else f"🤖 {ai}"), "pill_live"
        elif paused:
            txt, obj = "❚❚ Paused", "pill_idle"
        elif notice:
            txt, obj = ("● Rec" if tight else "● Recording"), "pill_live"
        else:
            txt, obj = ("⚠ Notice" if tight else "⚠ Notice not given"), "pill_amber"
        tips = {"pill_amber": "Recording, but the recording notice hasn't been said yet – read it from Scripts → Recording notice.",
                "pill_live": "This call is being recorded and transcribed." if not ai else "The AI employee is on the call.",
                "pill_idle": "No call in progress." if not live else "Recording is paused."}
        self.state_pill.setToolTip(tips[obj])
        self.state_pill.setAccessibleName(txt.lstrip("●⚠❚ ") + ". " + tips[obj])
        changed = txt != self.state_pill.text()
        fitted = self._on_screen()
        self.state_pill.setText(txt)
        self.state_pill.setObjectName(obj)
        self.state_pill.setStyle(self.state_pill.style())
        if changed and fitted:
            QTimer.singleShot(0, self, self._fit_screen)   # a wider pill may have pushed the window past the screen

    def _update_rec_dot(self):
        super()._update_rec_dot()
        live = bool(self.controller and self.controller.running)
        self._set_state(live, self._notice_flag, self._rec_paused, ai=self._ai_label if self.ai_mode else "")
        self.say_panel.listening = live

    # ------------------------------------------------------------- events
    def _on_event(self, kind: str, payload):
        try:
            super()._on_event(kind, payload)
        except Exception:  # noqa: BLE001 - one bad cockpit branch must not stop the Say-next panel updating
            log.exception("cockpit failed handling event %r", kind)
        if kind == "cards":
            if self.controller is None and self._prep_session is None:
                return
            cards = payload if self.chk_auto.isChecked() else [c for c in payload if c.type == WATCH]
            if self.ai_mode:
                self.overlay.show_cards(cards)   # the pane shows the AI's words; suggestions and Ask answers go here
            else:
                self.say_panel.show_cards(cards)
                self._sync_overlay()   # the teleprompter mirrors the pane (read lock included), never the raw deck
        elif kind == "sentiment":
            mood = self.sentiment.text().removeprefix("Mood: ")          # 'calm 🙂'
            word, _, face = mood.partition(" ")
            self.sentiment.setText(f"{face} {word}".strip())
            self.sentiment.setToolTip(f"Caller's mood: {word} – their tone over the last few lines")
            self.sentiment.setAccessibleName(f"Caller's mood: {word}")
        elif kind == "need":
            self.say_panel.set_need(list(payload))
        elif kind == "ai_said":
            c = Card(SAY, payload["text"], ["AI employee"], origin="ai", segment_id=payload.get("segment_id", ""))
            self.say_panel.show_cards([c], force=True)
        elif kind == "ai_mode":
            st = payload.get("state", "idle")
            label = {"idle": "AI listening", "thinking": "AI thinking…", "speaking": "AI speaking…",
                     "handoff": "AI needs you"}.get(st, "AI")
            self._ai_label = label if payload.get("active") else ""
            self._set_state(True, self._notice_flag, self._rec_paused, ai=self._ai_label)
        elif kind == "handoff":
            self.handoff_banner.label.setText("🤖  The AI asked for a colleague – take over the call.")
            self.handoff_banner.show()
        elif kind == "update":
            if payload.get("newer"):
                self.update_banner.label.setText("⬆  A newer CallPilot build is available.")
                self.update_banner.show()
        elif kind == "call_started":
            self.say_panel.listening = True
            self.btn_ai.setEnabled(True)
            self._set_state(True, self._notice_flag)
            hub = self.current_hub()
            if hub:
                self.say_panel.set_need([f.label for f in hub.capture_fields if f.required])
            self.btn_new.setVisible(True)
            self.btn_call.setObjectName("endcall")   # MainWindow._finish_call resets it to 'start'
            self.btn_call.setStyle(self.btn_call.style())
            self.btn_transcript.setEnabled(True)
            self.btn_transcript.setToolTip(TRANSCRIPT_TIP)
            self._refresh_setup_banner()
        elif kind == "call_ended":
            self.say_panel.listening = False
            self.say_panel.reset()
            self.btn_ai.blockSignals(True)
            self.btn_ai.setChecked(False)
            self.btn_ai.blockSignals(False)
            self.btn_ai.setEnabled(False)
            self.ai_mode = False
            self.handoff_banner.hide()
            self.ai_banner.hide()
            self.btn_new.setVisible(False)
            ok = self.last_record is not None
            self.btn_transcript.setEnabled(ok)
            self.btn_transcript.setToolTip(TRANSCRIPT_TIP if ok else "Available once a call has started")
            self._set_state(False, False)
            self._update_memory_badge()
            self._refresh_setup_banner()
        elif kind == "start_failed":
            self._refresh_setup_banner()
        elif kind == "apps_detected":
            self._detecting = False
            if payload and self.controller is None and not self._wrapping_up and not self.call_banner.isVisible():
                app = payload[0]
                self._detected_exe = app.exe
                self.call_banner.label.setText(f"📞  {app.title} is on a call. Start listening?")
                self.call_banner.show()
        elif kind == "learned":
            self._update_memory_badge()

    # ------------------------------------------------------------- actions
    def _card_action(self, card_obj, action: str):
        if self.ai_mode:
            return None   # the AI is on the call; Space/Esc must not mark the handler's deck
        cur = self.say_panel.current
        if card_obj is None:
            if cur is None or cur.origin in ("script", "ai"):
                return None   # Said it / Not this are off: nothing to mark, and a pinned script stays pinned
            card_obj = cur    # the answer on screen – never the risk line, never an answer still waiting to be read
        marked = super()._card_action(card_obj, action)
        self.say_panel.acted()
        if marked is not None and marked.type == SAY:
            self.status_lbl.setText("Marked as said – the AI will reuse this answer" if action == "used"
                                    else "Marked as not this – the AI will avoid that wording")
        return marked

    def _regenerate(self):
        if self.ai_mode:
            return
        super()._regenerate()

    def _sync_overlay(self):
        """The floating teleprompter shows exactly what the Say-next pane shows (read lock included)."""
        if not hasattr(self, "overlay"):
            return   # the overlay is created after _build
        self.overlay.show_cards(self.say_panel.visible_cards())

    def _start_call(self):
        if setup_needed(self.s) and not getattr(self, "_rehearse_next", False):
            self._refresh_setup_banner()
            self._run_setup()
            if setup_needed(self.s):
                return
        self.say_panel.reset()
        super()._start_call()

    def _new_call(self):
        if self.controller and self.controller.running:
            self._pending_new_call = True
            self._end_call()
        elif self.controller is None:
            self._start_call()

    def _finish_call(self, summary: dict):
        super()._finish_call(summary)
        self.call_banner.hide()
        if getattr(self, "_pending_new_call", False):
            self._pending_new_call = False
            QTimer.singleShot(300, self._start_call)

    def _ai_mode_blocked(self, text: str):
        """AI mode could not start: say why in the status bar and offer the settings, without a modal box."""
        self.status_lbl.setText("⚠ " + text.split(". ")[0] + ".")
        self.ai_banner.label.setText("🤖  " + text)
        self.ai_banner.show()

    def _ai_toggled(self, on: bool):
        self._toggle_ai_mode(on)
        if self.ai_mode:
            self.ai_banner.hide()
        if self.ai_mode != on:
            self.btn_ai.blockSignals(True)
            self.btn_ai.setChecked(self.ai_mode)
            self.btn_ai.blockSignals(False)
        self.btn_ai.setText("👤 Take over" if self.ai_mode else "🤖 AI mode")
        self.btn_ai.setObjectName("danger" if self.ai_mode else "ghost")
        self.btn_ai.setStyle(self.btn_ai.style())
        if not self.ai_mode:
            self._ai_label = ""
            self.handoff_banner.hide()
            self._set_state(bool(self.controller and self.controller.running), self._notice_flag, self._rec_paused)
            cur = self.say_panel.current
            if cur is None or cur.origin == "ai":   # the AI's last line goes; the live suggestions come back
                sess = self._session()
                self.say_panel.show_cards(sess.deck.visible() if sess else [], force=True)
                self._sync_overlay()

    def _take_over(self):
        self.btn_ai.setChecked(False)
        self.handoff_banner.hide()

    def _open_update(self):
        from PySide6.QtGui import QDesktopServices
        from PySide6.QtCore import QUrl

        QDesktopServices.openUrl(QUrl(update.DOWNLOAD_URL))

    def _speak_current(self):
        c = self.say_panel.current
        if not c:
            return
        tts.speak(c.translated or c.spoken(), self.s.translation.tts_output_device or self.s.whisper.device,
                  self.s.translation.tts_voice, on_error=lambda e: self.bridge.event.emit("error", f"Speech failed: {e}"))

    def _apply_theme(self):
        super()._apply_theme()
        sp = getattr(self, "say_panel", None)
        if sp is not None:
            sp.set_theme(self.s.ui.theme, self.s.ui.font_pt)
        rail = getattr(self, "scripts_panel", None)
        if rail is not None:
            rail.set_theme(self.s.ui.theme)

    def _preset_changed(self, _):
        apply_preset(self.s.ai, self.preset_combo.currentData())
        config.save(self.s)
        self._update_model_badge()
        self._refresh_setup_banner()
        if self.controller and self.controller.running:
            self.status_lbl.setText("AI model changes from the next call.")

    # ------------------------------------------------------------- narrow windows (125-150 % scaling)
    def _scripts_toggled(self, on: bool):
        self.scripts_panel.setVisible(on)
        if not self._scripts_auto:
            self._scripts_wanted = on

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._fit_width()
        tight = self.width() < TIGHT_W
        if tight != getattr(self, "_tight", None):
            self._tight = tight
            self.btn_new.setText("+ New" if tight else "+ New call")
            if hasattr(self, "_state_args"):
                self._set_state(*self._state_args)

    def _restore_geometry(self):
        super()._restore_geometry()
        self._fit_screen()

    def showEvent(self, e):
        super().showEvent(e)
        if not getattr(self, "_fitted_on_show", False):
            self._fitted_on_show = True
            QTimer.singleShot(0, self, self._fit_screen)   # again once styled: the first show sizes to the unstyled minimum

    def _fit_screen(self):
        """Never open bigger than the screen (1500 x 900 is the default; a 1366 x 768 or 125-150 % screen is smaller)."""
        if self.isMaximized() or self.isFullScreen():
            return
        scr = self.screen() or QApplication.primaryScreen()
        if scr is None:
            return
        avail = scr.availableGeometry()
        w = min(self.width(), avail.width())
        h = min(self.height(), avail.height() - 40)   # leave room for the title bar
        self._fit_width(w)                             # tuck the rail away first, or it holds the window wide
        if (w, h) != (self.width(), self.height()):
            self.resize(w, h)
        fg = self.frameGeometry()
        if not avail.contains(fg):                     # pull it back onto the screen if it hangs off an edge
            self.move(max(avail.left(), min(fg.left(), avail.right() - fg.width() + 1)),
                      max(avail.top(), min(fg.top(), avail.bottom() - fg.height() + 1)))

    def _fit_width(self, width: int | None = None):
        """Below SCRIPTS_AUTOHIDE_W the scripts rail tucks away (Scripts brings it back); above it, it returns
        unless the handler hid it."""
        if not hasattr(self, "btn_scripts"):
            return
        narrow = (self.width() if width is None else width) < SCRIPTS_AUTOHIDE_W
        if narrow == self._narrow:
            return
        self._narrow = narrow
        self._scripts_auto = True
        try:
            self.btn_scripts.setChecked(self._scripts_wanted and not narrow)
        finally:
            self._scripts_auto = False

    def _on_screen(self) -> bool:
        """The window is shown and fits inside its screen (so it should be kept there when its minimum grows).
        A window the handler spread across two monitors is left alone."""
        scr = self.screen()
        return bool(self.isVisible() and scr is not None and scr.availableGeometry().contains(self.frameGeometry()))

    def _toggle_advanced(self, on: bool):
        if on:
            self._fit_before_drawer = self._on_screen()
        self.drawer.setVisible(on)
        self.btn_advanced.setText("Advanced ▴" if on else "Advanced ▾")
        if on:
            h = max(1, self.vsplit.height())
            self.vsplit.setSizes([int(h * 0.6), h - int(h * 0.6)])   # the answer keeps the larger share
        if getattr(self, "_fit_before_drawer", False):
            QTimer.singleShot(0, self, self._fit_screen)   # never past the screen; back to size once it closes

    def _update_memory_badge(self):
        hub = self.current_hub()
        if not hub or not hasattr(self, "memory_lbl"):
            return
        st = self.memory.stats(hub.id)
        n = st['answers'] + st['facts'] + st['lessons']
        self.memory_lbl.setText("🧠 Learning on" if n == 0 else f"🧠 {n} learned")
        self.memory_lbl.setToolTip(f"{st['answers']} answers that worked · {st['facts']} facts · {st['lessons']} lessons "
                                   "from past calls. Review in ⚙ → Settings → Memory.")

    # ------------------------------------------------------------- auto-detect
    def _auto_detect(self):
        """Every few seconds, off the GUI thread: is a call app playing audio? The result comes back as an
        'apps_detected' event, which shows the 'Start listening?' banner."""
        if (not self.s.ui.auto_detect_calls or self.controller is not None or self._wrapping_up
                or self.call_banner.isVisible() or self.isMinimized() or getattr(self, "_detecting", False)):
            return
        self._detecting = True
        emit = self.bridge.event.emit

        def scan():
            live = []
            ole32 = None
            try:
                if sys.platform == "win32":
                    import ctypes

                    ole32 = ctypes.WinDLL("ole32")
                    if ole32.CoInitializeEx(None, 0) not in (0, 1):   # pycaw needs COM on this thread
                        ole32 = None
                from callpilot.audio.apps import KNOWN_CALL_APPS, list_apps

                live = [a for a in list_apps() if a.has_audio_session and a.exe.lower() in KNOWN_CALL_APPS]
            except Exception:  # noqa: BLE001
                log.debug("call-app detection failed", exc_info=True)
            finally:
                if ole32 is not None:
                    ole32.CoUninitialize()
                try:
                    emit("apps_detected", live)   # always emit: it is what clears _detecting
                except RuntimeError:
                    pass   # the window closed while we were scanning

        threading.Thread(target=scan, daemon=True, name="callpilot-detect").start()

    def _banner_start(self):
        exe = getattr(self, "_detected_exe", "")
        if exe and exe.lower() not in [a.lower() for a in self.s.audio.target_apps]:
            self.s.audio.target_apps = [exe]
            self.s.audio.capture_mode = "apps"
            config.save(self.s)
        self.call_banner.hide()
        self._start_call()

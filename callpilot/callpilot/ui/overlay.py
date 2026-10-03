"""Always-on-top teleprompter that floats over WhatsApp/Teams during a call.

Frameless, translucent, draggable, optionally click-through, and hidden from
screen-shares/recordings on Windows 10 2004+. Shows the same three cards as the
cockpit, Watch out first.
"""

from __future__ import annotations

import html

from PySide6.QtCore import QPoint, Qt
from PySide6.QtGui import QColor, QPainter
from PySide6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

from callpilot.core.models import ASK, SAY, WATCH, Card
from callpilot.ui import winutil


class OverlayWindow(QWidget):
    def __init__(self, opacity: float = 0.92, font_pt: int = 15, exclude_capture: bool = True):
        super().__init__(None, Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setWindowTitle("CallPilot Overlay")
        self._drag: QPoint | None = None
        self._opacity = opacity
        self._exclude = exclude_capture
        self.font_pt = font_pt
        self._last: list[Card] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 10, 16, 14)
        bar = QHBoxLayout()
        self.status = QLabel("CallPilot")
        self.status.setStyleSheet("color:#8EA0BD;font-size:9pt;font-weight:700;")
        bar.addWidget(self.status)
        bar.addStretch()
        for txt, slot in (("A−", lambda: self._zoom(-1)), ("A+", lambda: self._zoom(1)), ("✕", self.hide)):
            b = QPushButton(txt)
            b.setFixedSize(26, 22)
            b.setStyleSheet("QPushButton{background:transparent;color:#8EA0BD;border:none;font-weight:700;"
                            "padding:0;font-size:10pt}QPushButton:hover{color:white}")
            b.clicked.connect(slot)
            bar.addWidget(b)
        lay.addLayout(bar)
        self.body = QLabel("Waiting for the caller…")
        self.body.setWordWrap(True)
        self.body.setTextFormat(Qt.RichText)
        lay.addWidget(self.body)
        self.resize(560, 220)

    def showEvent(self, e):
        super().showEvent(e)
        if self._exclude:
            winutil.exclude_from_capture(self, True)

    def set_click_through(self, enabled: bool) -> None:
        self.setWindowFlag(Qt.WindowTransparentForInput, enabled)
        if self.isVisible():
            self.show()

    def _zoom(self, d: int) -> None:
        self.font_pt = max(9, min(32, self.font_pt + d))
        self.show_cards(self._last)

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        c = QColor(10, 17, 32)
        c.setAlphaF(self._opacity)
        p.setBrush(c)
        p.setPen(QColor(31, 123, 255, 160))
        p.drawRoundedRect(self.rect().adjusted(1, 1, -1, -1), 16, 16)

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            self._drag = e.globalPosition().toPoint() - self.frameGeometry().topLeft()

    def mouseMoveEvent(self, e):
        if self._drag is not None and e.buttons() & Qt.LeftButton:
            self.move(e.globalPosition().toPoint() - self._drag)

    def mouseReleaseEvent(self, _):
        self._drag = None

    def set_status(self, text: str) -> None:
        self.status.setText(text)

    def show_cards(self, cards: list[Card]) -> None:
        self._last = list(cards)
        if not cards:
            self.body.setText("<span style='color:#8EA0BD'>Listening…</span>")
            return
        f = self.font_pt
        by = {c.type: c for c in cards}
        parts = []
        w = by.get(WATCH)
        if w:
            parts.append(f"<div style='color:#EF4444;font-weight:700;font-size:{f - 1}pt'>⚠ {html.escape(w.text)}</div>")
        s = by.get(SAY)
        if s:
            if s.filler:
                parts.append(f"<div style='color:#8EA0BD;font-style:italic;font-size:{f - 2}pt;margin-top:4px'>"
                             f"“{html.escape(s.filler)}”</div>")
            if s.text:
                parts.append(f"<div style='color:white;font-weight:700;font-size:{f + 2}pt;margin-top:2px'>"
                             f"{html.escape(s.text)}</div>")
            if s.more:
                parts.append(f"<div style='color:#DCE6F5;font-size:{f}pt;margin-top:4px'>{html.escape(s.more)}</div>")
            if s.translated:
                parts.append(f"<div style='color:#FBBF24;font-size:{f - 1}pt;margin-top:6px'>🌐 "
                             f"{html.escape(s.translated)}</div>")
        a = by.get(ASK)
        if a:
            parts.append(f"<div style='color:#7DD3FC;font-size:{f - 3}pt;margin-top:6px'>❓ "
                         + " &nbsp;•&nbsp; ".join(html.escape(q) for q in a.text.split(" | ")) + "</div>")
        self.body.setText("".join(parts))
        self.adjustSize()
        self.resize(max(self.width(), 560), self.height())

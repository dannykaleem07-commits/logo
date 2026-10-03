"""The simple view: what they said on the left, what you say next on the right.

Everything else (file pane, intake, pins, checklist, bottom bar) still exists
and still works – it lives in a hidden "Advanced" drawer. One button starts
the call, one dropdown picks the AI, and the app offers to start by itself
when WhatsApp (or another call app) begins a call.
"""

from __future__ import annotations

import html

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (QComboBox, QFrame, QHBoxLayout, QLabel, QPushButton, QSizePolicy, QSplitter,
                               QStatusBar, QVBoxLayout, QWidget)

from callpilot import __app_name__
from callpilot.core import config
from callpilot.core.config import MODEL_PRESETS, apply_preset
from callpilot.core.models import ASK, SAY, WATCH, Card
from callpilot.ui.main_window import MainWindow
from callpilot.ui.theme import palette
from callpilot.ui.widgets import card, section


class SayPanel(QFrame):
    """One big answer. Red line above it if there is a risk; grey questions under it."""

    def __init__(self, theme: str, font_pt: int):
        super().__init__()
        self.setObjectName("card")
        self.c = palette(theme)
        self.font_pt = font_pt
        lay = QVBoxLayout(self)
        lay.setContentsMargins(26, 18, 26, 18)
        lay.setSpacing(10)
        top = QHBoxLayout()
        top.addWidget(section("Say next"))
        top.addStretch()
        self.src = QLabel("")
        self.src.setObjectName("badge")
        top.addWidget(self.src)
        lay.addLayout(top)
        self.watch = QLabel("")
        self.watch.setWordWrap(True)
        self.watch.setStyleSheet(f"color:{self.c['bad']};font-weight:700;font-size:{font_pt + 2}pt;")
        self.filler = QLabel("")
        self.filler.setObjectName("filler")
        self.filler.setWordWrap(True)
        self.main = QLabel("")
        self.main.setWordWrap(True)
        self.main.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.main.setStyleSheet(f"color:{self.c['say']};font-weight:800;font-size:{font_pt + 12}pt;")
        self.main.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Minimum)
        self.more = QLabel("")
        self.more.setWordWrap(True)
        self.more.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.more.setStyleSheet(f"font-size:{font_pt + 5}pt;")
        self.their = QLabel("")
        self.their.setWordWrap(True)
        self.their.setStyleSheet(f"color:{self.c['caller']};font-size:{font_pt + 3}pt;")
        self.ask = QLabel("")
        self.ask.setWordWrap(True)
        self.ask.setStyleSheet(f"color:{self.c['agent']};font-size:{font_pt + 1}pt;")
        for w in (self.watch, self.filler, self.main, self.more, self.their, self.ask):
            lay.addWidget(w)
        lay.addStretch()
        row = QHBoxLayout()
        self.btn_used = QPushButton("✓ Said it   (Space)")
        self.btn_next = QPushButton("⟳ Another answer   (Ctrl+R)")
        self.btn_skip = QPushButton("✕ Not this   (Esc)")
        for b in (self.btn_used, self.btn_next, self.btn_skip):
            row.addWidget(b)
        row.addStretch()
        lay.addLayout(row)
        self.show_cards([])

    def show_cards(self, cards: list[Card]):
        by = {c.type: c for c in cards}
        w, s, a = by.get(WATCH), by.get(SAY), by.get(ASK)
        self.watch.setText(("⚠ " + w.text) if w else "")
        self.watch.setVisible(bool(w))
        if s:
            self.filler.setText(f"“{s.filler}”" if s.filler else "")
            self.main.setText(s.text or "…")
            self.more.setText(s.more)
            self.their.setText(("🌐 " + s.translated) if s.translated else "")
            origin = {"playbook": "⚡ instant", "rule": "rule", "llm": "AI", "script": "script"}.get(s.origin, s.origin)
            src = next((x for x in s.sources if x and x != "model"), "")
            self.src.setText(origin + (f" · {src[:40]}" if src else "") + ("" if s.done else " · writing…"))
            self.src.setVisible(True)
        else:
            self.filler.setText("")
            self.main.setText("Listening…")
            self.main.setStyleSheet(f"color:{self.c['muted']};font-weight:600;font-size:{self.font_pt + 8}pt;")
            self.more.setText("")
            self.their.setText("")
            self.src.setText("")
            self.src.setVisible(False)
        if s:
            self.main.setStyleSheet(f"color:{self.c['say']};font-weight:800;font-size:{self.font_pt + 12}pt;")
        for w_ in (self.filler, self.more, self.their):
            w_.setVisible(bool(w_.text()))
        self.ask.setText(("Then ask: " + "  •  ".join(a.text.split(" | "))) if a else "")
        self.ask.setVisible(bool(a))


class SimpleWindow(MainWindow):
    """Same engine and the same logic as the cockpit; a much simpler face."""

    def _build(self):
        # Build every control the engine needs (they keep working), then show only the essentials.
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

        # ---- slim top row
        top = QFrame()
        top.setObjectName("header")
        h = QHBoxLayout(top)
        h.setContentsMargins(18, 8, 18, 8)
        title = QLabel(f"◉ {__app_name__}")
        title.setObjectName("title")
        h.addWidget(title)
        h.addSpacing(12)
        self.btn_call.setText("●  Start call")
        self.btn_call.setMinimumWidth(170)
        h.addWidget(self.btn_call)
        h.addSpacing(12)
        h.addWidget(QLabel("AI"))
        self.preset_combo = QComboBox()
        for key, p in MODEL_PRESETS.items():
            self.preset_combo.addItem(p["label"], key)
        self.preset_combo.setCurrentIndex(max(0, self.preset_combo.findData(self.s.ai.preset)))
        self.preset_combo.currentIndexChanged.connect(self._preset_changed)
        h.addWidget(self.preset_combo)
        h.addWidget(QLabel("Hub"))
        self.hub_combo.setMinimumWidth(220)
        h.addWidget(self.hub_combo)
        h.addStretch()
        self.memory_lbl = QLabel("")
        self.memory_lbl.setObjectName("badge")
        self.memory_lbl.setToolTip("What the AI has learned from your past calls. Settings → Memory to review.")
        h.addWidget(self.memory_lbl)
        h.addWidget(self.rec_dot)
        h.addWidget(self.timer_lbl)
        h.addWidget(self.btn_mute)
        self.btn_advanced = QPushButton("Advanced ▾")
        self.btn_advanced.setCheckable(True)
        self.btn_advanced.toggled.connect(self._toggle_advanced)
        h.addWidget(self.btn_advanced)
        h.addWidget(self.btn_settings)
        v.addWidget(top)

        # ---- auto-detect banner
        self.banner = QFrame()
        self.banner.setObjectName("header")
        bl = QHBoxLayout(self.banner)
        bl.setContentsMargins(18, 6, 18, 6)
        self.banner_lbl = QLabel("")
        bl.addWidget(self.banner_lbl, 1)
        self.banner_btn = QPushButton("Start now")
        self.banner_btn.setObjectName("primary")
        self.banner_btn.clicked.connect(self._banner_start)
        bl.addWidget(self.banner_btn)
        dismiss = QPushButton("✕")
        dismiss.setFixedWidth(30)
        dismiss.clicked.connect(self.banner.hide)
        bl.addWidget(dismiss)
        self.banner.hide()
        v.addWidget(self.banner)

        # ---- two panes
        body = QWidget()
        bl2 = QHBoxLayout(body)
        bl2.setContentsMargins(12, 12, 12, 8)
        split = QSplitter(Qt.Horizontal)
        bl2.addWidget(split)
        v.addWidget(body, 1)
        left = card()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(16, 12, 16, 12)
        lt = QHBoxLayout()
        lt.addWidget(section("They said · you said"))
        lt.addStretch()
        lt.addWidget(self.lang_badge)
        lt.addWidget(self.sentiment)
        ll.addLayout(lt)
        ll.addWidget(self.transcript, 1)
        ll.addWidget(self.ask_bar)
        split.addWidget(left)
        self.say_panel = SayPanel(self.s.ui.theme, self.s.ui.font_pt)
        self.say_panel.btn_used.clicked.connect(lambda: self._card_action(None, "used"))
        self.say_panel.btn_skip.clicked.connect(lambda: self._card_action(None, "dismissed"))
        self.say_panel.btn_next.clicked.connect(self._regenerate)
        split.addWidget(self.say_panel)
        split.setSizes([560, 760])

        # ---- advanced drawer (everything else), hidden by default
        self.drawer = QWidget()
        dl = QVBoxLayout(self.drawer)
        dl.setContentsMargins(12, 0, 12, 0)
        dl.setSpacing(8)
        dl.addWidget(self._header)
        adv_split = QSplitter(Qt.Horizontal)
        adv_split.addWidget(self.file_pane)
        adv_split.addWidget(self._right_panel)
        adv_split.setSizes([400, 700])
        adv_split.setMinimumHeight(300)
        dl.addWidget(adv_split, 1)
        dl.addWidget(self._bottom)
        self.drawer.hide()
        v.addWidget(self.drawer, 1)
        self.cards.setVisible(False)  # cards live in the Say panel in this view

        sb = QStatusBar()
        self.setStatusBar(sb)
        sb.addWidget(QLabel("You"))
        sb.addWidget(self.mic_meter)
        sb.addWidget(QLabel("Caller"))
        sb.addWidget(self.caller_meter)
        sb.addWidget(self.status_lbl, 1)
        sb.addPermanentWidget(QLabel("🔒 encrypted · keys in Credential Manager"))
        self._install_shortcuts()
        self._set_call_buttons(False)
        self._detect = QTimer(self)
        self._detect.timeout.connect(self._auto_detect)
        self._detect.start(4000)
        self._update_memory_badge()

    # ------------------------------------------------------------- behaviour
    def _on_event(self, kind: str, payload):
        super()._on_event(kind, payload)
        if kind == "cards":
            if self.controller is None and self._prep_session is None:
                return
            cards = payload if self.chk_auto.isChecked() else [c for c in payload if c.type == WATCH]
            self.say_panel.show_cards(cards)
        elif kind == "call_ended":
            self.say_panel.show_cards([])
            self._update_memory_badge()
        elif kind == "learned":
            self._update_memory_badge()

    def _show_script(self, text: str, label: str, more: str = ""):
        super()._show_script(text, label, more)
        f = self.case_file
        if text:
            text = (text.replace("{agent}", self.s.agent_name or "…")
                    .replace("{client}", f.client_name if f else "the client")
                    .replace("{reference}", f.reference if f and f.reference else "…"))
            c = Card(SAY, text, [label], origin="script")
            c.more, c.filler = more, label
            self.say_panel.show_cards([c])

    def _preset_changed(self, _):
        key = self.preset_combo.currentData()
        apply_preset(self.s.ai, key)
        config.save(self.s)
        self._apply_theme()
        if self.controller and self.controller.running:
            self.status_lbl.setText("AI model changes from the next call.")

    def _toggle_advanced(self, on: bool):
        self.drawer.setVisible(on)
        self.btn_advanced.setText("Advanced ▴" if on else "Advanced ▾")

    def _update_memory_badge(self):
        hub = self.current_hub()
        if not hub or not hasattr(self, "memory_lbl"):
            return
        st = self.memory.stats(hub.id)
        self.memory_lbl.setText(f"🧠 {st['answers']} answers · {st['facts']} facts · {st['lessons']} lessons")

    def _on_hub_changed(self, *_):
        super()._on_hub_changed()
        self._update_memory_badge()

    # ------------------------------------------------------------- auto-detect
    def _auto_detect(self):
        if not self.s.ui.auto_detect_calls or (self.controller is not None) or self._wrapping_up:
            return
        if self.banner.isVisible():
            return
        try:
            from callpilot.audio.apps import KNOWN_CALL_APPS, list_apps

            live = [a for a in list_apps() if a.has_audio_session and a.exe.lower() in KNOWN_CALL_APPS]
        except Exception:  # noqa: BLE001
            return
        if not live:
            return
        app = live[0]
        self._detected_exe = app.exe
        self.banner_lbl.setText(f"📞 {app.title} is playing audio – on a call? CallPilot can listen to it now.")
        self.banner.show()

    def _banner_start(self):
        exe = getattr(self, "_detected_exe", "")
        if exe and exe.lower() not in [a.lower() for a in self.s.audio.target_apps]:
            self.s.audio.target_apps = [exe]
            self.s.audio.capture_mode = "apps"
            config.save(self.s)
        self.banner.hide()
        self._start_call()

    def _finish_call(self, summary: dict):
        super()._finish_call(summary)
        self.banner.hide()


def _esc(t: str) -> str:
    return html.escape(t or "")

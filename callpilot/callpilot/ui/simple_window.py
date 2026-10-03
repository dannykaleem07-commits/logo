"""The simple view: what they said on the left, what you say next on the right.

Everything else (file pane, intake, pins, checklist, bottom bar) still exists
and still works – it lives in a hidden "Advanced" drawer. One button starts
the call, one dropdown picks the AI, and the app offers to start by itself
when WhatsApp (or another call app) begins a call.
"""

from __future__ import annotations

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (QApplication, QComboBox, QFrame, QHBoxLayout, QLabel, QListWidget, QListWidgetItem,
                               QMenu, QPushButton, QSizePolicy, QSplitter, QStatusBar, QVBoxLayout, QWidget)

from callpilot import __app_name__
from callpilot.ai import tts
from callpilot.core import config
from callpilot.core.config import MODEL_PRESETS, apply_preset
from callpilot.core.models import ASK, SAY, WATCH, Card
from callpilot.ui.main_window import MainWindow
from callpilot.ui.setup_wizard import SetupWizard, setup_needed
from callpilot.ui.theme import palette
from callpilot.ui.widgets import card, section


class SayPanel(QFrame):
    """One big answer. Red line above it if there is a risk; grey questions under it;
    the last few answers underneath so you can go back to one."""

    def __init__(self, theme: str, font_pt: int):
        super().__init__()
        self.setObjectName("hero")
        self.c = palette(theme)
        self.font_pt = font_pt
        self.current: Card | None = None
        self.listening = False
        self._dots = 0
        self._history: list[Card] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 20, 28, 20)
        lay.setSpacing(10)
        top = QHBoxLayout()
        top.addWidget(section("Say next"))
        top.addStretch()
        self.src = QLabel("")
        self.src.setObjectName("badge")
        self.src.setVisible(False)
        top.addWidget(self.src)
        lay.addLayout(top)
        self.watch = QLabel("")
        self.watch.setWordWrap(True)
        self.watch.setStyleSheet(f"color:{self.c['bad']};font-weight:700;font-size:{font_pt + 2}pt;"
                                 f"background:rgba(239,68,68,0.10);border:1px solid {self.c['bad']};"
                                 f"border-radius:10px;padding:8px 12px;")
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
        self.more.setStyleSheet(f"font-size:{font_pt + 5}pt;")
        self.their = QLabel("")
        self.their.setWordWrap(True)
        self.their.setStyleSheet(f"color:{self.c['caller']};font-size:{font_pt + 3}pt;")
        self.ask = QLabel("")
        self.ask.setWordWrap(True)
        self.ask.setStyleSheet(f"color:{self.c['agent']};font-size:{font_pt + 1}pt;")
        for w in (self.watch, self.filler, self.main, self.more, self.their, self.ask):
            lay.addWidget(w)
        row = QHBoxLayout()
        self.btn_used = QPushButton("✓  Said it")
        self.btn_used.setObjectName("primary")
        self.btn_used.setToolTip("Space – marks it used and teaches the AI it was right")
        self.btn_next = QPushButton("⟳  Another answer")
        self.btn_next.setToolTip("Ctrl+R")
        self.btn_skip = QPushButton("✕  Not this")
        self.btn_skip.setToolTip("Esc – teaches the AI to avoid it")
        self.btn_copy = QPushButton("⧉")
        self.btn_copy.setObjectName("iconbtn")
        self.btn_copy.setToolTip("Copy")
        self.btn_speak = QPushButton("🔊")
        self.btn_speak.setObjectName("iconbtn")
        self.btn_speak.setToolTip("Read it aloud (voice interpreter)")
        for b in (self.btn_used, self.btn_next, self.btn_skip):
            row.addWidget(b)
        row.addStretch()
        row.addWidget(self.btn_copy)
        row.addWidget(self.btn_speak)
        lay.addLayout(row)
        self.recent_title = section("Earlier answers")
        self.recent = QListWidget()
        self.recent.setObjectName("recent")
        self.recent.setMaximumHeight(130)
        lay.addWidget(self.recent_title)
        lay.addWidget(self.recent)
        lay.addStretch()
        self.btn_copy.clicked.connect(self.copy)
        self.recent.itemClicked.connect(self._recall)
        self._pulse = QTimer(self)
        self._pulse.timeout.connect(self._tick)
        self._pulse.start(500)
        self.reset()

    def _tick(self):
        if self.current is None:
            self._dots = (self._dots + 1) % 4
            self.main.setText(("Listening" + "." * self._dots) if self.listening else "Ready when you are")

    def copy(self):
        if self.current:
            QApplication.clipboard().setText(self.current.translated or self.current.spoken())

    def _recall(self, item: QListWidgetItem):
        c = item.data(Qt.UserRole)
        if isinstance(c, Card):
            self._render(c, None, None)

    def _remember(self, c: Card):
        if not c.text or c.origin == "script":
            return
        if self._history and self._history[-1].id == c.id:
            self._history[-1] = c
        else:
            self._history.append(c)
            self._history = self._history[-6:]
        self.recent.clear()
        for h in reversed(self._history[:-1]):
            it = QListWidgetItem("↶  " + h.text[:110])
            it.setData(Qt.UserRole, h)
            self.recent.addItem(it)
        self.recent_title.setVisible(self.recent.count() > 0)
        self.recent.setVisible(self.recent.count() > 0)

    def show_cards(self, cards: list[Card]):
        by = {c.type: c for c in cards}
        self._render(by.get(SAY), by.get(WATCH), by.get(ASK))

    def _render(self, s: Card | None, w: Card | None, a: Card | None):
        self.current = s
        self.watch.setText(("⚠  " + w.text) if w else "")
        self.watch.setVisible(bool(w))
        if s:
            self.filler.setText(f"“{s.filler}”" if s.filler else "")
            self.main.setText(s.text or "…")
            self.main.setStyleSheet(f"color:{self.c['say']};font-weight:800;font-size:{self.font_pt + 13}pt;")
            self.more.setText(s.more)
            self.their.setText(("🌐  " + s.translated) if s.translated else "")
            origin = {"playbook": "⚡ instant", "rule": "rule", "llm": "AI", "script": "script"}.get(s.origin, s.origin)
            src = next((x for x in s.sources if x and x != "model"), "")
            self.src.setText(origin + (f" · {src[:36]}" if src else "") + ("" if s.done else " · writing…"))
            self.src.setVisible(True)
            if s.done:
                self._remember(s)
        else:
            self.filler.setText("")
            self.main.setText("Listening…" if self.listening else "Ready when you are")
            self.main.setStyleSheet(f"color:{self.c['muted']};font-weight:600;font-size:{self.font_pt + 8}pt;")
            self.more.setText("")
            self.their.setText("")
            self.src.setVisible(False)
        for w_ in (self.filler, self.more, self.their):
            w_.setVisible(bool(w_.text()))
        self.ask.setText(("Then ask:  " + "   •   ".join(a.text.split(" | "))) if a else "")
        self.ask.setVisible(bool(a))
        for b in (self.btn_used, self.btn_skip, self.btn_copy, self.btn_speak):
            b.setEnabled(s is not None)

    def reset(self):
        self._history = []
        self.recent.clear()
        self.recent_title.setVisible(False)
        self.recent.setVisible(False)
        self.show_cards([])


class Banner(QFrame):
    def __init__(self, obj: str, button: str, slot):
        super().__init__()
        self.setObjectName(obj)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(16, 8, 12, 8)
        self.label = QLabel("")
        self.label.setWordWrap(True)
        lay.addWidget(self.label, 1)
        btn = QPushButton(button)
        btn.setObjectName("primary")
        btn.clicked.connect(slot)
        lay.addWidget(btn)
        x = QPushButton("✕")
        x.setObjectName("iconbtn")
        x.clicked.connect(self.hide)
        lay.addWidget(x)
        self.hide()


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

        # ---- top row
        top = QFrame()
        top.setObjectName("header")
        h = QHBoxLayout(top)
        h.setContentsMargins(18, 10, 18, 10)
        h.setSpacing(10)
        title = QLabel(f"◉ {__app_name__}")
        title.setObjectName("title")
        h.addWidget(title)
        h.addSpacing(8)
        self.btn_call.setText("●  Start call")
        self.btn_call.setMinimumWidth(190)
        h.addWidget(self.btn_call)
        self.state_pill = QLabel("idle")
        self.state_pill.setObjectName("pill_idle")
        h.addWidget(self.state_pill)
        h.addWidget(self.timer_lbl)
        h.addSpacing(6)
        h.addWidget(QLabel("You"))
        self.mic_meter.setFixedWidth(70)
        h.addWidget(self.mic_meter)
        h.addWidget(QLabel("Caller"))
        self.caller_meter.setFixedWidth(70)
        h.addWidget(self.caller_meter)
        h.addStretch()
        self.preset_combo = QComboBox()
        for key, p in MODEL_PRESETS.items():
            self.preset_combo.addItem(p["label"], key)
        self.preset_combo.setCurrentIndex(max(0, self.preset_combo.findData(self.s.ai.preset)))
        self.preset_combo.currentIndexChanged.connect(self._preset_changed)
        self.preset_combo.setToolTip("Which AI writes your answers")
        h.addWidget(self.preset_combo)
        self.hub_combo.setMinimumWidth(210)
        self.hub_combo.setToolTip("Which company's playbook to use")
        h.addWidget(self.hub_combo)
        self.memory_lbl = QLabel("")
        self.memory_lbl.setObjectName("badge")
        self.memory_lbl.setToolTip("What the AI has learned from your past calls. Settings → Memory to review.")
        h.addWidget(self.memory_lbl)
        self.btn_mute.setObjectName("iconbtn")
        h.addWidget(self.btn_mute)
        self.btn_advanced = QPushButton("Advanced ▾")
        self.btn_advanced.setObjectName("ghost")
        self.btn_advanced.setCheckable(True)
        self.btn_advanced.toggled.connect(self._toggle_advanced)
        h.addWidget(self.btn_advanced)
        gear = QPushButton("⚙")
        gear.setObjectName("iconbtn")
        menu = QMenu(self)
        for label, slot in (("Settings…", lambda: self._open_settings()), ("Run setup again…", self._run_setup),
                            ("Call history…", self._open_history), ("Floating overlay", lambda: self.btn_overlay.toggle()),
                            ("Edit / train this hub…", self._edit_hub)):
            act = QAction(label, self)
            act.triggered.connect(slot)
            menu.addAction(act)
        gear.setMenu(menu)
        h.addWidget(gear)
        v.addWidget(top)

        # ---- banners
        banners = QWidget()
        bv = QVBoxLayout(banners)
        bv.setContentsMargins(14, 8, 14, 0)
        bv.setSpacing(6)
        self.setup_banner = Banner("banner", "Run setup", self._run_setup)
        self.call_banner = Banner("banner_ok", "Start listening", self._banner_start)
        bv.addWidget(self.setup_banner)
        bv.addWidget(self.call_banner)
        v.addWidget(banners)

        # ---- two panes
        body = QWidget()
        bl2 = QHBoxLayout(body)
        bl2.setContentsMargins(14, 8, 14, 8)
        split = QSplitter(Qt.Horizontal)
        bl2.addWidget(split)
        v.addWidget(body, 1)
        left = card()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(16, 12, 16, 12)
        lt = QHBoxLayout()
        lt.addWidget(section("Conversation"))
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
        self.say_panel.btn_speak.clicked.connect(self._speak_current)
        split.addWidget(self.say_panel)
        split.setSizes([520, 820])

        # ---- advanced drawer (everything else), hidden by default
        self.drawer = QWidget()
        dl = QVBoxLayout(self.drawer)
        dl.setContentsMargins(14, 0, 14, 0)
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
        sb.addWidget(self.status_lbl, 1)
        hint = QLabel("Space = said it   ·   Esc = not this   ·   Ctrl+R = another   ·   A = ask AI")
        hint.setObjectName("hint")
        sb.addWidget(hint)
        sb.addPermanentWidget(QLabel("🔒 encrypted on this PC"))
        self._install_shortcuts()
        self._set_call_buttons(False)
        self._detect = QTimer(self)
        self._detect.timeout.connect(self._auto_detect)
        self._detect.start(4000)
        self._update_memory_badge()
        self._refresh_setup_banner()

    # ------------------------------------------------------------- behaviour
    def _refresh_setup_banner(self):
        reason = setup_needed(self.s)
        if reason:
            self.setup_banner.label.setText(f"⚠  Setup needed: {reason}.")
            self.setup_banner.show()
        else:
            self.setup_banner.hide()

    def _run_setup(self):
        if self.controller is not None:
            return
        wiz = SetupWizard(self.s, self)
        wiz.exec()
        self.preset_combo.blockSignals(True)
        self.preset_combo.setCurrentIndex(max(0, self.preset_combo.findData(self.s.ai.preset)))
        self.preset_combo.blockSignals(False)
        self._apply_theme()
        self._refresh_setup_banner()

    def _set_state(self, live: bool, notice: bool, paused: bool = False):
        if not live:
            self.state_pill.setText("idle")
            self.state_pill.setObjectName("pill_idle")
        elif paused:
            self.state_pill.setText("❚❚ paused")
            self.state_pill.setObjectName("pill_idle")
        elif notice:
            self.state_pill.setText("● live · recording")
            self.state_pill.setObjectName("pill_live")
        else:
            self.state_pill.setText("● live · say the recording notice")
            self.state_pill.setObjectName("pill_amber")
        self.state_pill.setStyle(self.state_pill.style())

    def _update_rec_dot(self):
        super()._update_rec_dot()
        live = bool(self.controller and self.controller.running)
        self._set_state(live, self._notice_flag, self._rec_paused)
        self.say_panel.listening = live

    def _on_event(self, kind: str, payload):
        super()._on_event(kind, payload)
        if kind == "cards":
            if self.controller is None and self._prep_session is None:
                return
            cards = payload if self.chk_auto.isChecked() else [c for c in payload if c.type == WATCH]
            self.say_panel.show_cards(cards)
        elif kind == "call_started":
            self.say_panel.listening = True
            self._set_state(True, self._notice_flag)
        elif kind == "call_ended":
            self.say_panel.listening = False
            self.say_panel.show_cards([])
            self._set_state(False, False)
            self._update_memory_badge()
        elif kind == "learned":
            self._update_memory_badge()

    def _start_call(self):
        if setup_needed(self.s):
            self._refresh_setup_banner()
            self._run_setup()
            if setup_needed(self.s):
                return
        self.say_panel.reset()
        super()._start_call()

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

    def _speak_current(self):
        c = self.say_panel.current
        if not c:
            return
        text = c.translated or c.spoken()
        tts.speak(text, self.s.translation.tts_output_device or self.s.whisper.device, self.s.translation.tts_voice,
                  on_error=lambda e: self.bridge.event.emit("error", f"Speech failed: {e}"))

    def _preset_changed(self, _):
        key = self.preset_combo.currentData()
        apply_preset(self.s.ai, key)
        config.save(self.s)
        self._apply_theme()
        self._refresh_setup_banner()
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
        if self.call_banner.isVisible():
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
        self.call_banner.label.setText(f"📞  {app.title} is on a call. Start listening?")
        self.call_banner.show()

    def _banner_start(self):
        exe = getattr(self, "_detected_exe", "")
        if exe and exe.lower() not in [a.lower() for a in self.s.audio.target_apps]:
            self.s.audio.target_apps = [exe]
            self.s.audio.capture_mode = "apps"
            config.save(self.s)
        self.call_banner.hide()
        self._start_call()

    def _finish_call(self, summary: dict):
        super()._finish_call(summary)
        self.call_banner.hide()

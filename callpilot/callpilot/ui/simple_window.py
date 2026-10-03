"""The simple view: Business profile › Call hub › Call.

Left: the conversation. Right: what to say next, what you still need to get,
and the scripts you read out. The full Call Desk cockpit lives in an
"Advanced" drawer underneath. AI mode lets a named member of the team take
the call in a realistic voice; you can take over at any moment.
"""

from __future__ import annotations

import time

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QKeySequence, QShortcut
from PySide6.QtWidgets import (QApplication, QComboBox, QFrame, QHBoxLayout, QLabel, QListWidget, QListWidgetItem,
                               QMenu, QPushButton, QSizePolicy, QSplitter, QStatusBar, QVBoxLayout, QWidget)

from callpilot import __app_name__
from callpilot.ai import tts
from callpilot.core import config, update
from callpilot.core.config import MODEL_PRESETS, apply_preset
from callpilot.core.models import ASK, SAY, WATCH, Card
from callpilot.ui.main_window import MainWindow
from callpilot.ui.setup_wizard import SetupWizard, setup_needed
from callpilot.ui.theme import palette
from callpilot.ui.widgets import card, section

READ_LOCK_S = 6.0        # a fresh answer is not replaced for this long unless you act on it
QUEUE_PROMOTE_S = 9.0    # a queued answer takes over after this long anyway


class SayPanel(QFrame):
    """One big answer that only ever grows while you read it. A new answer waits in a
    'Next' bar until you've finished (Said it / Not this / →) or a few seconds pass.
    Scripts pin on top and are never replaced until you press Done."""

    def __init__(self, theme: str, font_pt: int):
        super().__init__()
        self.setObjectName("hero")
        self.c = palette(theme)
        self.font_pt = font_pt
        self.current: Card | None = None
        self.queued: list[Card] | None = None
        self.pinned_script = False
        self.listening = False
        self._shown_at = 0.0
        self._acted = True
        self._dots = 0
        self._history: list[Card] = []
        self.need: list[str] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 18, 28, 18)
        lay.setSpacing(8)
        top = QHBoxLayout()
        self.title = section("Say next")
        top.addWidget(self.title)
        top.addStretch()
        self.src = QLabel("")
        self.src.setObjectName("badge")
        self.src.setVisible(False)
        top.addWidget(self.src)
        lay.addLayout(top)
        # the risk row keeps its height so the answer never jumps down when a warning appears
        self.watch = QLabel("")
        self.watch.setWordWrap(True)
        self.watch.setMinimumHeight(40)
        self._watch_css = (f"color:{self.c['bad']};font-weight:700;font-size:{font_pt + 2}pt;"
                           f"background:rgba(239,68,68,0.10);border:1px solid {self.c['bad']};border-radius:10px;padding:8px 12px;")
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
        self.more.setStyleSheet(f"font-size:{font_pt + 5}pt;")
        self.their = QLabel("")
        self.their.setWordWrap(True)
        self.their.setStyleSheet(f"color:{self.c['caller']};font-size:{font_pt + 3}pt;")
        self.ask = QLabel("")
        self.ask.setWordWrap(True)
        self.ask.setStyleSheet(f"color:{self.c['agent']};font-size:{font_pt + 1}pt;")
        self.need_lbl = QLabel("")
        self.need_lbl.setWordWrap(True)
        self.need_lbl.setStyleSheet(f"color:{self.c['warn']};font-size:{font_pt}pt;")
        for w in (self.watch, self.filler, self.main, self.more, self.their, self.ask, self.need_lbl):
            lay.addWidget(w)
        # queued "next" bar
        self.next_bar = QFrame()
        self.next_bar.setObjectName("banner_ok")
        nb = QHBoxLayout(self.next_bar)
        nb.setContentsMargins(12, 6, 8, 6)
        self.next_lbl = QLabel("")
        self.next_lbl.setWordWrap(True)
        nb.addWidget(self.next_lbl, 1)
        self.btn_next_now = QPushButton("Show it  (→)")
        self.btn_next_now.setObjectName("primary")
        self.btn_next_now.clicked.connect(self.promote)
        nb.addWidget(self.btn_next_now)
        self.next_bar.hide()
        lay.addWidget(self.next_bar)
        row = QHBoxLayout()
        self.btn_used = QPushButton("✓  Said it")
        self.btn_used.setObjectName("primary")
        self.btn_used.setToolTip("Space – marks it used and teaches the AI it was right")
        self.btn_next = QPushButton("⟳  Another answer")
        self.btn_next.setToolTip("Ctrl+R")
        self.btn_skip = QPushButton("✕  Not this")
        self.btn_skip.setToolTip("Esc – teaches the AI to avoid it")
        self.btn_done = QPushButton("Done reading")
        self.btn_done.setObjectName("primary")
        self.btn_done.hide()
        self.btn_copy = QPushButton("⧉")
        self.btn_copy.setObjectName("iconbtn")
        self.btn_copy.setToolTip("Copy")
        self.btn_speak = QPushButton("🔊")
        self.btn_speak.setObjectName("iconbtn")
        self.btn_speak.setToolTip("Read it aloud")
        for b in (self.btn_used, self.btn_next, self.btn_skip, self.btn_done):
            row.addWidget(b)
        row.addStretch()
        row.addWidget(self.btn_copy)
        row.addWidget(self.btn_speak)
        lay.addLayout(row)
        self.recent_title = section("Earlier answers")
        self.recent = QListWidget()
        self.recent.setObjectName("recent")
        self.recent.setMaximumHeight(110)
        lay.addWidget(self.recent_title)
        lay.addWidget(self.recent)
        lay.addStretch()
        self.btn_copy.clicked.connect(self.copy)
        self.btn_done.clicked.connect(self.release)
        self.recent.itemClicked.connect(self._recall)
        self._pulse = QTimer(self)
        self._pulse.timeout.connect(self._tick)
        self._pulse.start(500)
        self.reset()

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
            it = QListWidgetItem("↶  " + h.text[:110])
            it.setData(Qt.UserRole, h)
            self.recent.addItem(it)
        self.recent_title.setVisible(self.recent.count() > 0)
        self.recent.setVisible(self.recent.count() > 0)

    def acted(self):
        """Said it / Not this: the reader is finished with the current answer."""
        self._acted = True
        if self.queued is not None:
            self.promote()

    def promote(self):
        if self.queued is None:
            return
        cards, self.queued = self.queued, None
        self.next_bar.hide()
        self.pinned_script = False
        self.btn_done.hide()
        self.show_cards(cards, force=True)

    def pin_script(self, title: str, text: str):
        c = Card(SAY, text, [title], origin="script")
        c.filler = title
        self.pinned_script = True
        self.btn_done.show()
        self._render(c, None, None, force=True)

    def release(self):
        self.pinned_script = False
        self.btn_done.hide()
        if self.queued is not None:
            self.promote()
        else:
            self.current = None
            self.show_cards([], force=True)

    def set_need(self, items: list[str]):
        self.need = items
        self.need_lbl.setText(("Still need:  " + "   ·   ".join(items[:6]) + ("  …" if len(items) > 6 else "")) if items else "")
        self.need_lbl.setVisible(bool(items))

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
                self.next_lbl.setText("Next answer ready:  " + (s.text[:120] if s.text else "…"))
                self.next_bar.show()
            self._render_side(w, a)
            return
        self._render(s, w, a)

    def _render_side(self, w: Card | None, a: Card | None):
        self.watch.setText(("⚠  " + w.text) if w else "")
        self.watch.setStyleSheet(self._watch_css if w else "")
        self.ask.setText(("Then ask:  " + "   •   ".join(a.text.split(" | "))) if a else "")
        self.ask.setVisible(bool(a))

    def _render(self, s: Card | None, w: Card | None, a: Card | None, force: bool = False):
        if s is not None and (self.current is None or s.id != self.current.id):
            self._shown_at = time.time()
            self._acted = False
        self.current = s
        self._render_side(w, a)
        if s:
            self.filler.setText(f"“{s.filler}”" if s.filler else "")
            self.main.setText(s.text or "…")
            self.main.setStyleSheet(f"color:{self.c['say']};font-weight:800;font-size:{self.font_pt + 13}pt;")
            self.more.setText(s.more)
            self.their.setText(("🌐  " + s.translated) if s.translated else "")
            origin = {"playbook": "⚡ instant", "rule": "rule", "llm": "AI", "script": "script", "ai": "🤖 AI said"}.get(s.origin, s.origin)
            src = next((x for x in s.sources if x and x != "model"), "")
            self.src.setText(origin + (f" · {src[:36]}" if src else "") + ("" if s.done else " · writing…"))
            self.src.setVisible(True)
            self.title.setText("SCRIPT" if s.origin == "script" else ("AI EMPLOYEE SAID" if s.origin == "ai" else "SAY NEXT"))
            if s.done:
                self._remember(s)
        else:
            self.filler.setText("")
            self.main.setText("Listening…" if self.listening else "Ready when you are")
            self.main.setStyleSheet(f"color:{self.c['muted']};font-weight:600;font-size:{self.font_pt + 8}pt;")
            self.more.setText("")
            self.their.setText("")
            self.src.setVisible(False)
            self.title.setText("SAY NEXT")
        for w_ in (self.filler, self.more, self.their):
            w_.setVisible(bool(w_.text()))
        for b in (self.btn_used, self.btn_skip, self.btn_copy, self.btn_speak):
            b.setEnabled(s is not None and s.origin != "script")

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
        btn.clicked.connect(slot)
        lay.addWidget(btn)
        if second:
            b2 = QPushButton(second)
            b2.clicked.connect(second_slot)
            lay.addWidget(b2)
        x = QPushButton("✕")
        x.setObjectName("iconbtn")
        x.clicked.connect(self.hide)
        lay.addWidget(x)
        self.hide()


class ScriptsPanel(QFrame):
    """The scripts for this business and hub. Click one to read it, large, without the AI
    replacing it until you press Done."""

    def __init__(self, on_pick):
        super().__init__()
        self.setObjectName("card")
        self.on_pick = on_pick
        lay = QVBoxLayout(self)
        lay.setContentsMargins(14, 12, 14, 12)
        lay.addWidget(section("Scripts"))
        self.list = QListWidget()
        self.list.itemClicked.connect(self._pick)
        lay.addWidget(self.list, 1)
        hint = QLabel("Click to read. Opening / notice / terms / closing in call order.")
        hint.setObjectName("hint")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        self.scripts: list[dict] = []
        self.setMinimumWidth(220)
        self.setMaximumWidth(320)

    def set_scripts(self, scripts: list[dict]):
        self.scripts = scripts
        self.list.clear()
        order = {"opening": 0, "consent": 1, "terms": 2, "": 3, "closing": 4}
        for sc in sorted(scripts, key=lambda s: order.get(s.get("when", ""), 3)):
            tag = {"opening": "▶ ", "consent": "● ", "terms": "§ ", "closing": "■ "}.get(sc.get("when", ""), "• ")
            it = QListWidgetItem(tag + sc.get("title", "Script"))
            it.setData(Qt.UserRole, sc)
            it.setToolTip(sc.get("text", "")[:400])
            self.list.addItem(it)

    def _pick(self, item: QListWidgetItem):
        sc = item.data(Qt.UserRole)
        if sc:
            self.on_pick(sc.get("title", "Script"), sc.get("text", ""))


class SimpleWindow(MainWindow):
    """Same engine and the same logic as the cockpit; a much simpler face."""

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

        # ---- top row: Business › Hub › Call
        top = QFrame()
        top.setObjectName("header")
        h = QHBoxLayout(top)
        h.setContentsMargins(18, 10, 18, 10)
        h.setSpacing(8)
        title = QLabel(f"◉ {__app_name__}")
        title.setObjectName("title")
        h.addWidget(title)
        h.addSpacing(6)
        self.business_combo = QComboBox()
        self.business_combo.setToolTip("Business profile – rules, status line and scripts for every call this business takes")
        self.business_combo.currentIndexChanged.connect(self._business_changed)
        h.addWidget(self.business_combo)
        h.addWidget(QLabel("›"))
        self.hub_combo.setMinimumWidth(230)
        self.hub_combo.setToolTip("Call hub – the call type: answers, knowledge, intake")
        h.addWidget(self.hub_combo)
        h.addWidget(QLabel("›"))
        self.btn_call.setText("●  Start call")
        self.btn_call.setMinimumWidth(160)
        h.addWidget(self.btn_call)
        self.btn_new = QPushButton("+ New call")
        self.btn_new.setObjectName("ghost")
        self.btn_new.setToolTip("End this call (wrap-up) and start a fresh one")
        self.btn_new.clicked.connect(self._new_call)
        h.addWidget(self.btn_new)
        self.state_pill = QLabel("idle")
        self.state_pill.setObjectName("pill_idle")
        h.addWidget(self.state_pill)
        h.addWidget(self.timer_lbl)
        h.addWidget(QLabel("You"))
        self.mic_meter.setFixedWidth(60)
        h.addWidget(self.mic_meter)
        h.addWidget(QLabel("Caller"))
        self.caller_meter.setFixedWidth(60)
        h.addWidget(self.caller_meter)
        h.addStretch()
        self.btn_ai = QPushButton("🤖 AI mode")
        self.btn_ai.setCheckable(True)
        self.btn_ai.setObjectName("ghost")
        self.btn_ai.setToolTip("A named member of the team takes the call in a realistic voice. Click again to take over.")
        self.btn_ai.toggled.connect(self._ai_toggled)
        h.addWidget(self.btn_ai)
        self.preset_combo = QComboBox()
        for key, p in MODEL_PRESETS.items():
            self.preset_combo.addItem(p["label"], key)
        self.preset_combo.setCurrentIndex(max(0, self.preset_combo.findData(self.s.ai.preset)))
        self.preset_combo.currentIndexChanged.connect(self._preset_changed)
        self.preset_combo.setToolTip("Which AI writes your answers")
        h.addWidget(self.preset_combo)
        self.memory_lbl = QLabel("")
        self.memory_lbl.setObjectName("badge")
        self.memory_lbl.setToolTip("What the AI has learned from your past calls. Settings → Memory to review.")
        h.addWidget(self.memory_lbl)
        self.btn_mute.setObjectName("iconbtn")
        h.addWidget(self.btn_mute)
        self.btn_scripts = QPushButton("Scripts")
        self.btn_scripts.setObjectName("ghost")
        self.btn_scripts.setCheckable(True)
        self.btn_scripts.setChecked(True)
        self.btn_scripts.toggled.connect(lambda on: self.scripts_panel.setVisible(on))
        h.addWidget(self.btn_scripts)
        self.btn_calls = QPushButton("Calls")
        self.btn_calls.setObjectName("ghost")
        self.btn_calls.clicked.connect(self._open_calls)
        h.addWidget(self.btn_calls)
        self.btn_advanced = QPushButton("Advanced ▾")
        self.btn_advanced.setObjectName("ghost")
        self.btn_advanced.setCheckable(True)
        self.btn_advanced.toggled.connect(self._toggle_advanced)
        h.addWidget(self.btn_advanced)
        gear = QPushButton("⚙")
        gear.setObjectName("iconbtn")
        menu = QMenu(self)
        for label, slot in (("Business profile…", self._edit_business), ("Edit / train this hub…", self._edit_hub),
                            ("Rehearse with the AI…", self._rehearse), ("Settings…", lambda: self._open_settings()),
                            ("Run setup again…", self._run_setup), ("Save last call to computer…", self._save_call_to_computer),
                            ("Call history…", self._open_history), ("Floating overlay", lambda: self.btn_overlay.toggle())):
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
        self.handoff_banner = Banner("banner", "Take over now", self._take_over)
        self.update_banner = Banner("banner_ok", "Download update", self._open_update)
        for b in (self.setup_banner, self.call_banner, self.handoff_banner, self.update_banner):
            bv.addWidget(b)
        v.addWidget(banners)

        # ---- panes
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
        self.btn_transcript = QPushButton("⬇ Transcript")
        self.btn_transcript.setObjectName("ghost")
        self.btn_transcript.setToolTip("Download this call's transcript (.txt or .docx)")
        self.btn_transcript.clicked.connect(self._download_transcript)
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
        split.addWidget(self.say_panel)
        self.scripts_panel = ScriptsPanel(self._read_script)
        split.addWidget(self.scripts_panel)
        split.setSizes([500, 760, 240])

        # ---- advanced drawer
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
        self.cards.setVisible(False)

        sb = QStatusBar()
        self.setStatusBar(sb)
        sb.addWidget(self.status_lbl, 1)
        hint = QLabel("Space = said it  ·  Esc = not this  ·  → = next answer  ·  Ctrl+R = another  ·  A = ask AI")
        hint.setObjectName("hint")
        sb.addWidget(hint)
        sb.addPermanentWidget(QLabel("🔒 encrypted on this PC"))
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
        self.say_panel.pin_script(title, text)
        self.overlay.show_cards([Card(SAY, text, [title], origin="script")])
        if "record" in title.lower() or "notice" in title.lower():
            self._notice_given()

    def _show_script(self, text: str, label: str, more: str = ""):
        super()._show_script(text, label, more)
        if text:
            self._read_script(label, text + (("  " + more) if more else ""))

    # ------------------------------------------------------------- setup / state
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
        SetupWizard(self.s, self).exec()
        self.preset_combo.blockSignals(True)
        self.preset_combo.setCurrentIndex(max(0, self.preset_combo.findData(self.s.ai.preset)))
        self.preset_combo.blockSignals(False)
        self._apply_theme()
        self._refresh_setup_banner()

    def _set_state(self, live: bool, notice: bool, paused: bool = False, ai: str = ""):
        if not live:
            txt, obj = "idle", "pill_idle"
        elif ai:
            txt, obj = f"🤖 {ai}", "pill_live"
        elif paused:
            txt, obj = "❚❚ paused", "pill_idle"
        elif notice:
            txt, obj = "● live · recording", "pill_live"
        else:
            txt, obj = "● live · say the recording notice", "pill_amber"
        self.state_pill.setText(txt)
        self.state_pill.setObjectName(obj)
        self.state_pill.setStyle(self.state_pill.style())

    def _update_rec_dot(self):
        super()._update_rec_dot()
        live = bool(self.controller and self.controller.running)
        self._set_state(live, self._notice_flag, self._rec_paused)
        self.say_panel.listening = live

    # ------------------------------------------------------------- events
    def _on_event(self, kind: str, payload):
        super()._on_event(kind, payload)
        if kind == "cards":
            if self.controller is None and self._prep_session is None:
                return
            cards = payload if self.chk_auto.isChecked() else [c for c in payload if c.type == WATCH]
            if not self.ai_mode:
                self.say_panel.show_cards(cards)
        elif kind == "need":
            self.say_panel.set_need(list(payload))
        elif kind == "ai_said":
            c = Card(SAY, payload["text"], ["AI employee"], origin="ai", segment_id=payload.get("segment_id", ""))
            self.say_panel.show_cards([c], force=True)
        elif kind == "ai_mode":
            st = payload.get("state", "idle")
            label = {"idle": "AI listening", "thinking": "AI thinking…", "speaking": "AI speaking…",
                     "handoff": "AI needs you"}.get(st, "AI")
            self._set_state(True, self._notice_flag, self._rec_paused, ai=label if payload.get("active") else "")
        elif kind == "handoff":
            self.handoff_banner.label.setText("🤖  The AI asked for a colleague – take over the call now.")
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
        elif kind == "call_ended":
            self.say_panel.listening = False
            self.say_panel.reset()
            self.btn_ai.blockSignals(True)
            self.btn_ai.setChecked(False)
            self.btn_ai.blockSignals(False)
            self.btn_ai.setEnabled(False)
            self.ai_mode = False
            self.handoff_banner.hide()
            self._set_state(False, False)
            self._update_memory_badge()
        elif kind == "learned":
            self._update_memory_badge()

    # ------------------------------------------------------------- actions
    def _card_action(self, card_obj, action: str):
        super()._card_action(card_obj, action)
        self.say_panel.acted()

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

    def _ai_toggled(self, on: bool):
        self._toggle_ai_mode(on)
        if self.ai_mode != on:
            self.btn_ai.blockSignals(True)
            self.btn_ai.setChecked(self.ai_mode)
            self.btn_ai.blockSignals(False)
        self.btn_ai.setText("👤 Take over" if self.ai_mode else "🤖 AI mode")
        self.btn_ai.setObjectName("danger" if self.ai_mode else "ghost")
        self.btn_ai.setStyle(self.btn_ai.style())
        if not self.ai_mode:
            self.handoff_banner.hide()
            self._set_state(bool(self.controller and self.controller.running), self._notice_flag, self._rec_paused)

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

    def _preset_changed(self, _):
        apply_preset(self.s.ai, self.preset_combo.currentData())
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

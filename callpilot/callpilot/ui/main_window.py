"""Call Desk cockpit: file on the left, call in the middle, AI on the right."""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

from PySide6.QtCore import QByteArray, QEvent, QObject, Qt, QTimer, Signal
from PySide6.QtGui import QAction, QIcon, QKeySequence, QShortcut
from PySide6.QtWidgets import (QAbstractButton, QAbstractItemView, QApplication, QCheckBox, QComboBox, QFileDialog, QFrame,
                               QHBoxLayout, QInputDialog, QLabel, QListWidget, QMainWindow, QMenu, QMessageBox,
                               QPushButton, QScrollArea, QSizePolicy, QSplitter, QStatusBar, QSystemTrayIcon,
                               QTabBar, QTabWidget, QVBoxLayout, QWidget)

from callpilot import __app_name__, __version__
from callpilot.ai import tts
from callpilot.ai.providers import make_provider
from callpilot.ai.translator import language_name
from callpilot.core import config
from callpilot.core.config import model_label
from callpilot.core.audit import AuditLog
from callpilot.core.controller import CallController
from callpilot.core.business import BusinessStore
from callpilot.core.export import auto_export, default_export_dir, export_call
from callpilot.core.files import CaseFile, FileStore
from callpilot.core.memory import MemoryStore
from callpilot.core.models import SAY, WATCH, Card
from callpilot.core.sessions import SessionStore, redact_record
from callpilot.hubs.model import Hub, HubStore
from callpilot.ui import winutil
from callpilot.ui.file_dialog import FileEditor, FilePicker
from callpilot.ui.history import HistoryDialog
from callpilot.ui.hotkeys import GlobalHotkeys
from callpilot.ui.hub_editor import HubEditor
from callpilot.ui.overlay import OverlayWindow
from callpilot.ui.settings_dialog import SettingsDialog
from callpilot.ui.theme import stylesheet
from callpilot.ui.widgets import (AskBar, CardsPanel, FilePane, IntakePanel, LevelMeter, PinsList,
                                  ProgressRing, RecordDot, TranscriptView, card, section)
from callpilot.ui.wrapup_dialog import WrapUpDialog

log = logging.getLogger(__name__)

CALL_TYPES = [("New accident (FNOL)", "new_accident"), ("Insurer handler", "handler"), ("Engineer", "engineer"),
              ("Bodyshop", "bodyshop"), ("Client chase / update", "client_chase"), ("Council", "council"),
              ("Other", "")]


class Bridge(QObject):
    """Delivers events from worker threads onto the UI thread."""

    event = Signal(str, object)


class _EnterPressesButton(QObject):
    """Keyboard access in the main window.

    * Return/Enter activates the focused button (QMainWindow buttons have no autoDefault, so Enter did nothing).
    * The spec's single-key hotkeys (Space = said it, →, A/P/T/W) give way to the control the handler has Tabbed
      to: Space presses that button or ticks that box, letters type-ahead in a list or combo, → moves in a list.
      Only focus that arrived by Tab / Shift+Tab counts, so a mouse user who has just clicked a button still gets
      Space = said it exactly as before. Esc always stays 'not this'."""

    _MODS = Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier

    def __init__(self, window):
        super().__init__(window)
        self._win = window
        self._kb_focus = None   # the widget focused by Tab / Shift+Tab, if focus is still there

    def _defers(self, w, key: int) -> bool:
        if key == Qt.Key_Space:
            return isinstance(w, (QAbstractButton, QComboBox, QAbstractItemView, QTabBar))
        if key in (Qt.Key_A, Qt.Key_P, Qt.Key_T, Qt.Key_W):
            return isinstance(w, (QComboBox, QAbstractItemView))
        if key in (Qt.Key_Left, Qt.Key_Right):
            return isinstance(w, (QAbstractItemView, QTabBar, QComboBox))
        return False

    def eventFilter(self, obj, ev):
        t = ev.type()
        if t == QEvent.FocusIn:
            if isinstance(obj, QWidget) and obj.window() is self._win:
                self._kb_focus = obj if ev.reason() in (Qt.TabFocusReason, Qt.BacktabFocusReason) else None
        elif t == QEvent.ShortcutOverride:
            if (obj is self._kb_focus and obj.hasFocus() and not (ev.modifiers() & self._MODS)
                    and self._defers(obj, ev.key())):
                ev.accept()          # the focused control handles the key; the window hotkey does not fire
                return True
        elif (t == QEvent.KeyPress and ev.key() in (Qt.Key_Return, Qt.Key_Enter)
                and not (ev.modifiers() & (self._MODS | Qt.ShiftModifier))
                and isinstance(obj, QAbstractButton) and obj.isEnabled() and obj.window() is self._win):
            obj.click()
            return True
        return False


class MainWindow(QMainWindow):
    START_LABEL = "●  Start call   (Ctrl+Shift+L)"
    END_LABEL = "■  End call"

    def __init__(self, settings: config.Settings, audit: AuditLog, icon: QIcon | None = None):
        super().__init__()
        self.s = settings
        self.audit = audit
        self.hubs = HubStore()
        self.store = SessionStore(settings.privacy)
        self.files = FileStore()
        self.memory = MemoryStore()
        self.businesses = BusinessStore()
        self._hub_cache: Hub | None = None    # current_hub() runs on every transcript line; avoid re-reading disk
        self._biz_cache = None
        self.last_record: dict | None = None
        self.ai_mode = False
        self.controller: CallController | None = None
        self.case_file: CaseFile | None = None
        self._saved_sessions: set[int] = set()
        self._save_thread: threading.Thread | None = None
        self.call_started_at: float | None = None
        self._notice_flag = False
        self._rec_paused = False
        self._wrapping_up = False
        self._prep_session = None
        self._last_whispered = ""
        self.bridge = Bridge()
        self.bridge.event.connect(self._on_event)
        self.setWindowTitle(f"{__app_name__} {__version__}")
        if icon:
            self.setWindowIcon(icon)
        self.resize(1500, 900)
        self._build()
        self._apply_theme()
        self.overlay = OverlayWindow(settings.ui.overlay_opacity, settings.ui.overlay_font_pt,
                                     settings.privacy.exclude_windows_from_capture)
        self.overlay.set_click_through(settings.ui.overlay_click_through)
        self._overlay_auto = False   # True while the overlay is shown automatically for a call
        self.overlay.hidden.connect(lambda: self.btn_overlay.setChecked(False))   # its own ✕ unticks the button
        self._restore_geometry()
        self._load_hubs()
        self._setup_hotkeys()
        self._setup_tray(icon)
        self._tick = QTimer(self)
        self._tick.timeout.connect(self._on_tick)
        self._tick.start(100)
        purged = self.store.purge_expired()
        if purged:
            self.audit.record("retention_purge", files=purged)

    # ================================================================ layout
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
        v.addWidget(self._header)
        body = QWidget()
        bl = QHBoxLayout(body)
        bl.setContentsMargins(12, 12, 12, 6)
        split = QSplitter(Qt.Horizontal)
        split.addWidget(self.file_pane)
        split.addWidget(self._centre)
        split.addWidget(self._right_panel)
        split.setSizes([300, 640, 560])
        bl.addWidget(split)
        v.addWidget(body, 1)
        v.addWidget(self._bottom)
        sb = QStatusBar()
        self.setStatusBar(sb)
        sb.addWidget(QLabel("You"))
        sb.addWidget(self.mic_meter)
        sb.addWidget(QLabel("Caller"))
        sb.addWidget(self.caller_meter)
        sb.addWidget(self.status_lbl, 1)
        sb.addPermanentWidget(QLabel("🔒 AES-256 · DPAPI · keys in Credential Manager"))
        self._install_shortcuts()
        self._set_call_buttons(False)

    def _build_header(self):
        header = self._header = QFrame()
        header.setObjectName("header")
        h = QHBoxLayout(header)
        h.setContentsMargins(18, 8, 18, 8)
        title = QLabel(f"◉ {__app_name__}")
        title.setObjectName("title")
        self._title = title
        h.addWidget(title)
        h.addSpacing(10)
        self.hub_combo = QComboBox()
        self.hub_combo.setMinimumWidth(260)
        self.hub_combo.currentIndexChanged.connect(self._on_hub_changed)
        h.addWidget(self.hub_combo)
        hub_btn = QPushButton("Hub")   # Qt draws the menu arrow itself; a text '▾' would double it
        hub_btn.setToolTip("Manage call hubs: edit, new, duplicate, import, export, delete")
        hub_btn.setAccessibleName("Manage call hubs")
        hub_menu = QMenu(self)
        for label, slot in (("Edit / train this hub…", self._edit_hub), ("New hub…", self._new_hub),
                            ("Duplicate hub", self._duplicate_hub), ("Import hub (.json)…", self._import_hub),
                            ("Export hub (.json)…", self._export_hub), ("Delete hub", self._delete_hub)):
            act = QAction(label, self)
            act.triggered.connect(slot)
            hub_menu.addAction(act)
        hub_btn.setMenu(hub_menu)
        h.addWidget(hub_btn)
        self.call_type = QComboBox()
        for label, key in CALL_TYPES:
            self.call_type.addItem(label, key)
        self.call_type.setToolTip("Call type sets the AI's instructions and which rules apply")
        h.addWidget(self.call_type)
        self.caller_lbl = QLabel("No file")
        self.caller_lbl.setObjectName("badge")
        h.addWidget(self.caller_lbl)
        h.addStretch()
        self.rec_dot = RecordDot(self.s.ui.theme)
        self.timer_lbl = QLabel("00:00")
        self.lang_badge = QLabel("")
        self.lang_badge.setObjectName("badge")
        self.lang_badge.setVisible(False)
        self.latency_badge = QLabel("")
        self.latency_badge.setObjectName("badge")
        self.latency_badge.setToolTip("AI model writing the live answers "
                                      "(change it with the preset picker or Settings → AI co-pilot)")
        for b in (self.rec_dot, self.timer_lbl, self.lang_badge, self.latency_badge):
            h.addWidget(b)
        h.addSpacing(8)
        self.chk_auto = QCheckBox("Auto answer")
        self.chk_auto.setChecked(self.s.ui.auto_answer)
        self.chk_whisper = QCheckBox("Whisper (W)")
        self.chk_whisper.setChecked(self.s.whisper.enabled)
        self.chk_translate = QCheckBox("Translate")
        self.chk_translate.setChecked(self.s.translation.enabled)
        self.chk_translate.toggled.connect(self._toggle_translation_view)
        for c in (self.chk_auto, self.chk_whisper, self.chk_translate):
            h.addWidget(c)
        self.btn_mute = QPushButton("🎙")
        self.btn_mute.setCheckable(True)
        self.btn_mute.setToolTip("Mute my microphone")
        self.btn_mute.setAccessibleName("Mute microphone")
        self.btn_mute.toggled.connect(self._toggle_mute)
        self.btn_overlay = QPushButton("Overlay")
        self.btn_overlay.setCheckable(True)
        self.btn_overlay.toggled.connect(self._toggle_overlay)
        self.btn_history = QPushButton("History")
        self.btn_history.clicked.connect(self._open_history)
        self.btn_settings = QPushButton("⚙")
        self.btn_settings.setToolTip("Settings")
        self.btn_settings.setAccessibleName("Settings")
        self.btn_settings.clicked.connect(lambda: self._open_settings())
        for b in (self.btn_mute, self.btn_overlay, self.btn_history, self.btn_settings):
            h.addWidget(b)

    def _build_columns(self):
        self.file_pane = FilePane(self.s.ui.theme)
        self.file_pane.change_file.connect(self._pick_file)

        centre = self._centre = card()
        cl = QVBoxLayout(centre)
        cl.setContentsMargins(16, 12, 16, 12)
        top = QHBoxLayout()
        top.addWidget(section("Live transcript"))
        top.addStretch()
        self.sentiment = QLabel("")
        self.sentiment.setObjectName("badge")
        self.sentiment.setVisible(False)
        top.addWidget(self.sentiment)
        cl.addLayout(top)
        self.transcript = TranscriptView(self.s.ui.theme)
        cl.addWidget(self.transcript, 1)
        self.ask_bar = AskBar()
        self.ask_bar.asked.connect(self._ask)
        cl.addWidget(self.ask_bar)

        right = self._right_panel = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(8)
        self.cards = CardsPanel(self.s.ui.theme, self.s.ui.font_pt)
        self.cards.used.connect(lambda c: self._card_action(c, "used"))
        self.cards.dismissed.connect(lambda c: self._card_action(c, "dismissed"))
        cards_scroll = QScrollArea()
        cards_scroll.setWidgetResizable(True)
        cards_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        cards_scroll.setWidget(self.cards)
        self.cards_scroll = cards_scroll
        rl.addWidget(cards_scroll, 3)
        intake_box = card()
        il = QVBoxLayout(intake_box)
        il.setContentsMargins(16, 12, 16, 12)
        ih = QHBoxLayout()
        self.ring = ProgressRing(self.s.ui.theme, self.s.ui.font_pt)
        ih.addWidget(self.ring)
        ih.addSpacing(8)
        itxt = QVBoxLayout()
        itxt.addWidget(section("Intake"))
        self.missing_lbl = QLabel("")
        self.missing_lbl.setWordWrap(True)
        self.missing_lbl.setObjectName("hint")
        itxt.addWidget(self.missing_lbl)
        ih.addLayout(itxt, 1)
        il.addLayout(ih)
        self.tabs = QTabWidget()
        self.intake = IntakePanel(self.s.ui.theme)
        self.intake.edited.connect(self._field_edited)
        sa = QScrollArea()
        sa.setWidgetResizable(True)
        sa.setWidget(self.intake)
        self.tabs.addTab(sa, "Form")
        self.pins_view = PinsList(self.s.ui.theme)
        self.tabs.addTab(self.pins_view, "Pins")
        self.checklist = QListWidget()
        self.tabs.addTab(self.checklist, "Checklist")
        self.alerts = QListWidget()
        self.tabs.addTab(self.alerts, "Alerts")
        il.addWidget(self.tabs, 1)
        rl.addWidget(intake_box, 3)

    def _build_bottom(self):
        bottom = self._bottom = QFrame()
        bottom.setObjectName("header")
        b = QHBoxLayout(bottom)
        b.setContentsMargins(18, 8, 18, 8)
        self.btn_call = QPushButton(self.START_LABEL)
        self.btn_call.setObjectName("start")
        self.btn_call.setToolTip("Start or end the call (Ctrl+Shift+L)")
        self.btn_call.clicked.connect(self._toggle_call)
        self.btn_pin = QPushButton("📌 Pin last line   (P)")
        self.btn_pin.clicked.connect(self._pin)
        self.btn_task = QPushButton("☑ Create task   (T)")
        self.btn_task.clicked.connect(self._task)
        self.btn_notice = QPushButton("Notice given")
        self.btn_notice.setToolTip("Tick when you have told the caller the call is recorded")
        self.btn_notice.clicked.connect(self._notice_given)
        self.btn_pause = QPushButton("❚❚ Pause for card details")
        self.btn_pause.setCheckable(True)
        self.btn_pause.toggled.connect(self._pause_recording)
        self.btn_book = QPushButton("🚗 Book car")
        self.btn_book.clicked.connect(self._book_car)
        self.btn_wrap = QPushButton("Wrap up ▸")
        self.btn_wrap.clicked.connect(self._toggle_call)
        for w in (self.btn_call, self.btn_pin, self.btn_task, self.btn_notice, self.btn_pause, self.btn_book):
            b.addWidget(w)
        b.addStretch()
        b.addWidget(self.btn_wrap)

    def _build_statusbar_widgets(self):
        self.mic_meter = LevelMeter("You", self.s.ui.theme)
        self.caller_meter = LevelMeter("Caller", self.s.ui.theme)
        self.status_lbl = QLabel("Ready")
        self.status_lbl.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)   # long paths never widen the window

    def _install_shortcuts(self):
        # in-app hotkeys (the spec's single keys), only when the window has focus and no text box does
        for key, slot in (("Space", lambda: self._card_action(None, "used")), ("Escape", lambda: self._card_action(None, "dismissed")),
                          ("P", self._pin), ("T", self._task), ("W", lambda: self.chk_whisper.toggle()),
                          ("A", lambda: self.ask_bar.edit.setFocus()), ("Ctrl+R", self._regenerate)):
            sc = QShortcut(QKeySequence(key), self)
            sc.setContext(Qt.WindowShortcut)
            sc.activated.connect(slot)
        self._enterfilter = _EnterPressesButton(self)
        QApplication.instance().installEventFilter(self._enterfilter)

    def _apply_theme(self):
        """Apply the theme and font size everywhere, live: the app stylesheet, plus every widget that draws its
        own colours (meters, badges, cards, transcript, intake, file, pins) so nothing keeps the old theme."""
        theme, pt = self.s.ui.theme, self.s.ui.font_pt
        QApplication.instance().setStyleSheet(stylesheet(theme, pt))
        for name in ("mic_meter", "caller_meter", "rec_dot", "transcript", "intake", "file_pane", "pins_view"):
            w = getattr(self, name, None)
            if w is not None:
                w.set_theme(theme)
        for name in ("cards", "ring"):
            w = getattr(self, name, None)
            if w is not None:
                w.set_theme(theme, pt)
        self._update_model_badge()

    def _update_model_badge(self):
        self.latency_badge.setText(model_label(self.s.ai))

    def showEvent(self, e):
        super().showEvent(e)
        if self.s.privacy.exclude_windows_from_capture:
            winutil.exclude_from_capture(self, True)

    def _set_call_buttons(self, live: bool):
        for w in (self.btn_pin, self.btn_task, self.btn_notice, self.btn_pause, self.btn_book, self.btn_wrap):
            w.setEnabled(live)

    # ================================================================ hubs / files
    def _load_hubs(self, select: str | None = None):
        self._hub_cache = self._biz_cache = None
        select = select or self.s.active_hub
        self.hub_combo.blockSignals(True)
        self.hub_combo.clear()
        for hub in self.hubs.list():
            self.hub_combo.addItem(hub.name, hub.id)
        idx = self.hub_combo.findData(select)
        self.hub_combo.setCurrentIndex(max(0, idx))
        self.hub_combo.blockSignals(False)
        self._on_hub_changed()

    def current_hub(self) -> Hub | None:
        hid = self.hub_combo.currentData()
        if hid and self._hub_cache is not None and self._hub_cache.id == hid:
            return self._hub_cache
        self._hub_cache = self.hubs.get(hid) if hid else None
        return self._hub_cache

    def current_business(self):
        hub = self.current_hub()
        if not (hub and hub.business_id):
            return None
        if self._biz_cache is not None and self._biz_cache.id == hub.business_id:
            return self._biz_cache
        self._biz_cache = self.businesses.get(hub.business_id)
        return self._biz_cache

    def _edit_business(self):
        from callpilot.ui.business_editor import BusinessEditor

        b = self.current_business()
        link_hub = None
        if b is None:
            hub = self.current_hub()
            b = self.businesses.new((hub.company or hub.name) if hub else "My business")
            link_hub = hub   # attached below, only if the profile is saved

        def open_hub(h):
            dlg = HubEditor(h, provider_factory=lambda: make_provider(self.s.ai), parent=self)
            if dlg.exec():
                self.hubs.save(dlg.hub)
                self._hub_cache = self._biz_cache = None
                return True
            return False

        dlg = BusinessEditor(b, self.businesses, self.hubs, self, open_hub_editor=open_hub)
        accepted = dlg.exec()
        self._hub_cache = self._biz_cache = None   # even a cancelled editor may have changed the cached objects
        if accepted:
            if link_hub is not None:
                link_hub.business_id = b.id
                self.hubs.save(link_hub)
            self.audit.record("business_saved", business=b.id)
        self._load_hubs(self.current_hub().id if self.current_hub() else None)

    def _on_hub_changed(self, *_):
        hub = self.current_hub()
        if not hub:
            return
        self.s.active_hub = hub.id
        config.save(self.s)
        self.intake.set_fields(hub.capture_fields)
        self._update_ring()
        self._render_checklist({d: False for d in hub.required_disclosures})
        # default call type for the hub
        default = "new_accident" if "courtesy" in hub.id else "handler"
        self.call_type.setCurrentIndex(max(0, self.call_type.findData(default)))
        # the booking shortcut only makes sense for courtesy / hire-car hubs
        key = f"{hub.id} {hub.business_id} {hub.name}".lower()
        self.btn_book.setVisible("courtesy" in key or "hire" in key)

    def _edit_hub(self):
        hub = self.current_hub()
        if not hub:
            return
        dlg = HubEditor(hub, provider_factory=lambda: make_provider(self.s.ai), parent=self)
        accepted = dlg.exec()
        self._hub_cache = self._biz_cache = None   # even a cancelled editor may have changed the cached hub
        if accepted:
            self.hubs.save(dlg.hub)
            self.audit.record("hub_saved", hub=dlg.hub.id, version=dlg.hub.version)
            self._load_hubs(dlg.hub.id)

    def _new_hub(self):
        name, ok = QInputDialog.getText(self, "New call hub", "Company / campaign name:")
        if ok and name.strip():
            hub = self.hubs.new(name.strip())
            self.hubs.save(hub)
            self._load_hubs(hub.id)
            self._edit_hub()

    def _duplicate_hub(self):
        hub = self.current_hub()
        if hub:
            copy = Hub.from_dict(hub.to_dict())
            new = self.hubs.new(hub.name + " (copy)")
            copy.id, copy.name = new.id, new.name
            self.hubs.save(copy)
            self._load_hubs(copy.id)

    def _import_hub(self):
        f, _ = QFileDialog.getOpenFileName(self, "Import hub", "", "CallPilot hub (*.json)")
        if not f:
            return
        try:
            hub = Hub.from_dict(json.loads(Path(f).read_text(encoding="utf-8")))
            self.hubs.save(hub)
            self._load_hubs(hub.id)
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, "Import hub", f"Invalid hub file: {e}")

    def _export_hub(self):
        hub = self.current_hub()
        if not hub:
            return
        f, _ = QFileDialog.getSaveFileName(self, "Export hub", f"{hub.id}.json", "CallPilot hub (*.json)")
        if f:
            Path(f).write_text(json.dumps(hub.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")

    def _delete_hub(self):
        hub = self.current_hub()
        if hub and QMessageBox.question(self, "Delete hub", f"Delete “{hub.name}”? "
                                        "(Built-in hubs reset to their defaults.)") == QMessageBox.Yes:
            self.hubs.delete(hub.id)
            self._load_hubs()

    def _pick_file(self):
        if self.controller and self.controller.running:
            QMessageBox.information(self, "File", "The file is read-only during a call. Attach it before you start.")
            return
        dlg = FilePicker(self.files, self)
        if dlg.exec() and dlg.selected:
            self.set_case_file(dlg.selected)
        elif dlg.result() == 0:
            self.set_case_file(None)

    def set_case_file(self, f: CaseFile | None):
        self.case_file = f
        self.file_pane.show_file(f)
        self.caller_lbl.setText(f.title if f else "No file · new enquiry")
        if f:
            self.audit.record("file_opened", file=f.id)
            self.call_type.setCurrentIndex(max(0, self.call_type.findData(
                "client_chase" if f.stage not in ("new enquiry",) and f.business == "Courtesy Cars" else
                ("handler" if f.business == "Fixmyfile" else "new_accident"))))

    # ================================================================ call control
    def _toggle_call(self):
        if self._wrapping_up:
            return  # the wrap-up screen owns the desk until it is saved or closed
        if self.controller and self.controller.running:
            self._end_call()
        elif self.controller is None:
            self._start_call()

    def _start_call(self):
        rehearse, self._rehearse_next = getattr(self, "_rehearse_next", False), False
        hub = self.current_hub()
        if not hub:
            QMessageBox.warning(self, "Start call", "Create or select a call hub first.")
            return
        if self._prep_session is not None:
            self._prep_session.end(summarize=False)
            self._prep_session = None
        self.transcript.clear_all()
        self.lang_badge.setVisible(False)
        self.sentiment.setVisible(False)
        self.alerts.clear()
        self.pins_view.clear_all()
        self.tabs.setTabText(1, "Pins")
        self.tabs.setTabText(3, "Alerts")
        self.intake.set_fields(hub.capture_fields)
        self._notice_flag = False
        self._rec_paused = False
        self.btn_pause.setChecked(False)
        self._render_checklist({d: False for d in hub.required_disclosures})
        self.btn_call.setEnabled(False)
        self.btn_call.setText("Starting…")
        self.status_lbl.setText("Connecting audio and speech…")
        ct = self.call_type.currentData() or ""
        self.controller = CallController(self.s, hub, self.bridge.event.emit, case_file=self.case_file, call_type=ct,
                                         memory=self.memory, business=self.current_business(),
                                         rehearse=rehearse)
        self._show_script(hub.greeting, "Opening script", hub.consent_script if self.s.privacy.consent_reminder else "")

        def run():
            try:
                self.controller.start()
            except Exception as e:  # noqa: BLE001
                log.exception("start failed")
                self.bridge.event.emit("start_failed", str(e))
                return
            # scan for the AI's output device here, once, so toggling AI mode never blocks the window
            dev = self.s.voice_agent.output_device
            try:
                present = (not dev) or tts.find_output_device(dev) is not None
            except Exception:  # noqa: BLE001
                present = True   # cannot enumerate; speak() reports if it is missing
            self._ai_dev_check = (dev, present)

        self._ai_dev_check = ("", True)
        threading.Thread(target=run, daemon=True).start()

    def _show_script(self, text: str, label: str, more: str = ""):
        if not text:
            return
        f = self.case_file
        text = (text.replace("{agent}", self.s.agent_name or "…")
                .replace("{client}", f.client_name if f else "the client")
                .replace("{reference}", f.reference if f and f.reference else "…"))
        c = Card(SAY, text, [label], origin="script")
        c.more = more
        c.filler = label
        self.cards.show_cards([c])
        self.overlay.show_cards([c])

    def _end_call(self):
        self.btn_call.setEnabled(False)
        self.btn_call.setText("Wrapping up…")
        self.status_lbl.setText("Writing wrap-up (summary, pins, email draft)…")
        self._set_call_buttons(False)
        ctl = self.controller

        def run():
            try:
                ctl.stop(summarize=True)
            except Exception as e:  # noqa: BLE001
                self.bridge.event.emit("error", f"Error ending call: {e}")
                self.bridge.event.emit("call_ended", {})

        threading.Thread(target=run, daemon=True).start()

    def _finish_call(self, summary: dict):
        ctl, self.controller = self.controller, None
        self.call_started_at = None
        self.btn_call.setEnabled(True)
        self.btn_call.setObjectName("start")
        self.btn_call.setText(self.START_LABEL)
        self.btn_call.setStyle(self.btn_call.style())
        self.rec_dot.set_state(False, False)
        self.status_lbl.setText("Call ended")
        self.cards.show_cards([])
        self.overlay.show_cards([])
        self.overlay.set_status("CallPilot")
        if self._overlay_auto:   # shown automatically for this call: hide it again; a manual choice is kept
            self._overlay_auto = False
            self.btn_overlay.setChecked(False)
        if not (ctl and ctl.session and ctl.session.segments):
            return
        sess = ctl.session
        rec = sess.to_record()
        hub = ctl.hub
        confirmed = self.intake.values(confirmed_only=True)  # snapshot before anything can reset the form
        case_file = self.case_file
        dlg = WrapUpDialog(self.s, rec, case_file, hub, self)
        saved_to_file = False
        self._wrapping_up = True
        try:
            if dlg.exec() and dlg.saved:
                rec["wrapup"] = dlg.result_payload()
                if case_file is not None and dlg.save_to_file.isChecked():
                    dlg.apply_to_file(case_file, sess.call_id, confirmed)
                    self.files.save(case_file)
                    self.file_pane.show_file(case_file)
                    saved_to_file = True
        finally:
            self._wrapping_up = False
        self._saved_sessions.add(id(sess))
        self._learn_in_background(rec, hub, sess)
        # encrypting the recording and writing the session can take seconds: do it off the GUI thread
        self.last_record = rec   # Transcript / Save call work straight away
        self.status_lbl.setText("Saving the call…")
        work = dict(rec)   # own copy: _encrypt_recording mutates it, and the learner is reading rec
        segs, hub_id, cf_id = len(sess.segments), hub.id, (case_file.id if case_file else "")

        def run():
            try:
                rec2 = self._encrypt_recording(work)
                f = self.store.save(rec2)
                self.bridge.event.emit("saved", {"rec": rec2, "file": f.name if f else None, "segments": segs,
                                                 "hub": hub_id, "case_file": cf_id, "wrote_file": saved_to_file})
            except Exception as e:  # noqa: BLE001
                self.bridge.event.emit("error", f"Could not save call: {e}")

        self._save_thread = threading.Thread(target=run, daemon=True, name="callpilot-save")
        self._save_thread.start()

    # ================================================================ AI mode / rehearsal / exports
    def _auto_export_in_background(self, rec: dict):
        """After-call save to Documents\\CallPilot\\Calls: honours the privacy settings (nothing when
        sessions are not kept, redacted when the store redacts) and never blocks the window."""
        if not (self.s.export.auto_save_calls and self.s.privacy.save_sessions):
            return
        settings, vault, emit = self.s, self.store.vault, self.bridge.event.emit

        def run():
            try:
                folder = auto_export(rec, settings, vault=vault)
                if folder is not None:
                    emit("exported", str(folder))
            except Exception as e:  # noqa: BLE001
                emit("error", f"Could not save the call to disk: {e}")

        threading.Thread(target=run, daemon=True, name="callpilot-export").start()

    def _toggle_ai_mode(self, on: bool):
        if not self.controller or not self.controller.running:
            self.ai_mode = False
            return
        if on and not self.controller.rehearse:
            dev = self.s.voice_agent.output_device
            if not dev:
                self._ai_mode_blocked("AI mode needs a virtual audio cable before it can talk to the caller. "
                                      "In Settings → AI mode, set Speaks into to CABLE Input, and pick CABLE Output "
                                      "as the microphone in WhatsApp or Teams. Until then you can rehearse: "
                                      "⚙ → Rehearse with the AI.")
                on = False
            else:
                # scanned off the GUI thread when the call started (see _start_call)
                scanned, present = getattr(self, "_ai_dev_check", ("", True))
                if scanned != dev:
                    present = True   # device changed since the scan; speak() will report if it is absent
                if not present:
                    self._ai_mode_blocked(f"'{dev}' isn't connected, so AI mode would talk into the room instead of "
                                          "the call. Plug it in or choose another device in Settings → AI mode.")
                    on = False
        self.ai_mode = on
        try:
            self.controller.set_ai_mode(on)
        except Exception as e:  # noqa: BLE001
            log.exception("ai mode")
            self.ai_mode = False
            self.bridge.event.emit("error", f"AI mode could not start: {e}")
        self.audit.record("ai_mode", on=self.ai_mode)

    def _ai_mode_blocked(self, text: str):
        """AI mode could not switch on. No modal: the call must keep flowing (SimpleWindow shows a banner)."""
        self.status_lbl.setText("⚠ " + text.split(". ")[0] + ".")
        box = QMessageBox(QMessageBox.Warning, "AI mode", text, QMessageBox.Ok, self)
        box.setWindowModality(Qt.NonModal)
        box.setAttribute(Qt.WA_DeleteOnClose)
        box.show()

    def _rehearse(self):
        if self.controller is not None:
            return
        if QMessageBox.question(self, "Rehearse with the AI",
                                "You play the caller through your microphone; the AI employee answers out loud "
                                "through your speakers. Nothing is sent to a call app. Start?") != QMessageBox.Yes:
            return
        self._rehearse_next = True
        self._start_call()

    def _open_calls(self):
        from callpilot.ui.calls_dialog import CallsDialog

        CallsDialog(self.store, self.s, self, audit=self.audit).exec()

    def _download_transcript(self):
        from callpilot.core.sessions import export_text

        rec = None
        if self.controller and self.controller.session and self.controller.session.segments:
            rec = self.controller.session.to_record()
        elif self.last_record:
            rec = self.last_record
        if not rec:
            QMessageBox.information(self, "Transcript", "No call to download yet.")
            return
        from callpilot.core.export import call_folder_name

        f, _ = QFileDialog.getSaveFileName(self, "Download transcript",
                                           str(Path.home() / "Downloads" / f"{call_folder_name(rec)} transcript.txt"),
                                           "Text (*.txt);;Word (*.docx)")
        if not f:
            return
        if hasattr(self, "btn_transcript"):
            self.btn_transcript.setEnabled(False)
        self.status_lbl.setText("Saving transcript…")
        emit, audit = self.bridge.event.emit, self.audit

        def run():   # building a Word file mid-call must not stall the window
            try:
                if f.lower().endswith(".docx"):
                    from callpilot.core.export import transcript_docx

                    transcript_docx(rec, Path(f))
                else:
                    Path(f).write_text(export_text(rec), encoding="utf-8")
                audit.record("transcript_downloaded", path=f)
                emit("transcript_saved", {"path": f})
            except Exception as e:  # noqa: BLE001
                emit("transcript_saved", {"path": f, "error": str(e)})

        threading.Thread(target=run, daemon=True, name="callpilot-export").start()

    def _save_call_to_computer(self):
        rec = self.last_record
        if not rec:
            QMessageBox.information(self, "Save call", "End the call first, then save it.")
            return
        d = QFileDialog.getExistingDirectory(self, "Save call to…", str(default_export_dir()))
        if not d:
            return
        self.status_lbl.setText("Saving call…")
        redact, vault, emit = self.s.privacy.redact_saved_pii, self.store.vault, self.bridge.event.emit

        def run():   # decrypting and copying the recording can take seconds
            try:
                r = redact_record(rec) if redact else rec
                folder = export_call(r, Path(d), vault=vault)
                emit("call_exported", {"folder": str(folder)})
            except Exception as e:  # noqa: BLE001
                emit("call_exported", {"error": str(e)})

        threading.Thread(target=run, daemon=True, name="callpilot-export").start()

    def _learn_in_background(self, rec: dict, hub, sess):
        """Self-training: remember what worked on this call for the next one."""
        if not self.s.ai.learn_after_calls or not rec.get("segments"):
            return
        provider = sess.provider
        banned = list(sess.banned)
        memory = self.memory
        self.status_lbl.setText("Learning from this call…")

        def run():
            from callpilot.ai.learn import learn_from_call

            try:
                res = learn_from_call(provider, rec, memory, banned)
                self.audit.record("learned", **{k: v for k, v in res.items() if k != "error"})
                self.bridge.event.emit("learned", res)
            except Exception as e:  # noqa: BLE001
                self.bridge.event.emit("error", f"Learning failed: {e}")

        threading.Thread(target=run, daemon=True, name="callpilot-learn").start()

    def _encrypt_recording(self, rec: dict) -> dict:
        """Move the plain WAV into the vault (AES-GCM) once the call is over."""
        p = rec.get("recording")
        if not p or not self.s.privacy.encrypt_sessions:
            return rec
        try:
            path = Path(p)
            if path.exists():
                enc = path.with_suffix(".wav.cpv")
                enc.write_bytes(self.store.vault.encrypt(path.read_bytes()))
                from callpilot.core.sessions import secure_delete

                secure_delete(path)
                rec["recording"] = str(enc)
        except Exception as e:  # noqa: BLE001
            log.warning("could not encrypt recording: %s", e)
        return rec

    # ================================================================ events
    def _on_event(self, kind: str, payload):
        if kind == "segment":
            self.transcript.upsert(payload)
        elif kind == "cards":
            if self.controller is None and self._prep_session is None:
                return  # a straggler from a call that has ended
            cards = payload if self.chk_auto.isChecked() else [c for c in payload if c.type == WATCH]
            if not self.cards_scroll.isHidden():
                self.cards.show_cards(cards)
            self.overlay.show_cards(cards)
            self._maybe_whisper(cards)
        elif kind == "pin":
            self.pins_view.add(payload)
            self.tabs.setTabText(1, f"Pins ({len(self.pins_view.pins)})")
        elif kind == "fields":
            self.intake.update_values(payload)
            self._update_ring()
        elif kind == "task":
            self.status_lbl.setText(f"Task added: {payload.title}")
        elif kind == "alert":
            self.alerts.insertItem(0, f"{time.strftime('%H:%M:%S')}  {payload}")
            self.tabs.setTabText(3, f"Alerts ({self.alerts.count()})")
            self.status_lbl.setText("⚠ " + str(payload))
        elif kind == "disclosures":
            self._render_checklist(payload)
        elif kind == "notice":
            self._notice_flag = bool(payload)
            self._update_rec_dot()
        elif kind == "recording_paused":
            self._rec_paused = bool(payload)
            self._update_rec_dot()
        elif kind == "sentiment":
            face = "🙂" if payload > 0.25 else ("😟" if payload < -0.25 else "😐")
            word = "calm" if payload > 0.25 else ("upset" if payload < -0.25 else "neutral")
            self.sentiment.setText(f"Mood: {word} {face}")
            self.sentiment.setToolTip("Caller's tone over the last few lines")
            self.sentiment.setVisible(True)
        elif kind == "language":
            self.lang_badge.setText(f"Caller: {language_name(payload)}")
            self.lang_badge.setVisible(True)
        elif kind == "latency":
            self.overlay.set_status("CallPilot · live")
            self.status_lbl.setText(f"Live · first words in {payload['first_token_ms'] / 1000:.2f}s")
        elif kind == "status":
            self.status_lbl.setText(str(payload))
        elif kind == "error":
            self.status_lbl.setText("⚠ " + str(payload))
            self.alerts.insertItem(0, f"{time.strftime('%H:%M:%S')}  {payload}")
        elif kind == "call_started":
            self.call_started_at = time.time()
            if self.controller:
                self.controller.set_muted("agent", self.btn_mute.isChecked())
            self.btn_call.setEnabled(True)
            self.btn_call.setObjectName("danger")
            self.btn_call.setText(self.END_LABEL)
            self.btn_call.setStyle(self.btn_call.style())
            self._set_call_buttons(True)
            self._update_rec_dot()
            if not self.status_lbl.text().startswith("Capturing"):
                self.status_lbl.setText("Live")
            if self.s.ui.overlay_enabled and not self.btn_overlay.isChecked():
                self.btn_overlay.setChecked(True)   # shows it via _toggle_overlay
                self._overlay_auto = True           # set AFTER setChecked so the toggle slot does not clear it
            self.audit.record("call_started", hub=self.controller.hub.id if self.controller else "",
                              call_type=self.call_type.currentData(), case_file=self.case_file.id if self.case_file else "")
        elif kind == "start_failed":
            self.controller = None
            self.btn_call.setEnabled(True)
            self.btn_call.setText(self.START_LABEL)
            self.status_lbl.setText("Could not start")
            QMessageBox.warning(self, "Could not start the call", str(payload))
        elif kind == "call_ended":
            self._finish_call(payload or {})
        elif kind == "summary":
            pass  # consumed by the wrap-up dialog
        elif kind == "ai_mode":
            pass  # the simple view renders this
        elif kind == "handoff":
            self.status_lbl.setText("⚠ The AI asked for a colleague – press Take over")
            if self.tray:
                self.tray.showMessage("CallPilot", "The AI employee needs you on the call.", QSystemTrayIcon.Warning, 5000)
        elif kind == "saved":
            rec = payload["rec"]
            self.last_record = rec
            self._auto_export_in_background(rec)
            self.audit.record("call_saved", file=payload["file"], segments=payload["segments"], hub=payload["hub"],
                              case_file=payload["case_file"], wrote_file=payload["wrote_file"],
                              cards=len(rec.get("ai_cards", [])), pins=len(rec.get("pins", [])))
            if self.controller is None:
                self.status_lbl.setText("Call saved")
        elif kind == "transcript_saved":
            if hasattr(self, "btn_transcript"):
                self.btn_transcript.setEnabled(True)
            err = payload.get("error")
            msg = f"⚠ Could not save the transcript: {err}" if err else f"Transcript saved: {payload['path']}"
            self.status_lbl.setText(msg)
            self.status_lbl.setToolTip(msg)
        elif kind == "call_exported":
            err = payload.get("error")
            msg = f"⚠ Could not save the call: {err}" if err else f"Call saved to {payload['folder']}"
            self.status_lbl.setText(msg)
            self.status_lbl.setToolTip(msg)
            if not err:   # only for 'Save call to computer…', never after the automatic export
                from callpilot.ui.calls_dialog import open_folder

                open_folder(Path(payload["folder"]))
        elif kind == "exported":
            self.status_lbl.setText(f"Call saved to {payload}")
            self.status_lbl.setToolTip(f"Call saved to {payload}")
        elif kind == "learned":
            n = int(payload.get("added", 0)) + int(payload.get("deterministic", 0))
            self.status_lbl.setText(f"Learned {n} new thing{'s' if n != 1 else ''} from that call"
                                    + (f" ({payload['error']})" if payload.get("error") else ""))

    def _update_rec_dot(self):
        live = bool(self.controller and self.controller.running and self.s.recording.enabled)
        self.rec_dot.set_state(live, self._notice_flag, self._rec_paused)

    def _render_checklist(self, done: dict):
        self.checklist.clear()
        for d, ok in done.items():
            self.checklist.addItem(("✅  " if ok else "⬜  ") + d)
        missing = sum(1 for ok in done.values() if not ok)
        self.tabs.setTabText(2, f"Checklist ({missing} left)" if missing else "Checklist ✓")

    def _update_ring(self):
        done, total = self.intake.progress()
        self.ring.set_progress(done, total)
        miss = self.intake.missing()
        hub = self.current_hub()
        labels = {f.key: f.label for f in (hub.capture_fields if hub else [])}
        n = len(miss)
        self.missing_lbl.setText((f"{n} required field{'s' if n != 1 else ''} still to fill – "
                                  + ", ".join(labels.get(k, k) for k in miss[:3])
                                  + (f" and {n - 3} more" if n > 3 else ""))
                                 if miss else "All required fields heard – tick each one to confirm.")

    def _on_tick(self):
        ctl = self.controller
        if ctl and ctl.running:
            lv = ctl.levels()
            self.mic_meter.set_db(lv.get("agent", -120))
            self.caller_meter.set_db(lv.get("caller", -120))
            if self.call_started_at:
                secs = int(time.time() - self.call_started_at)
                self.timer_lbl.setText(f"{secs // 60:02}:{secs % 60:02}")
            if ctl.session:
                ctl.session.deck.expire()
        else:
            self.mic_meter.set_db(-120)
            self.caller_meter.set_db(-120)

    # ================================================================ actions
    def _session(self):
        return self.controller.session if (self.controller and self.controller.session) else None

    def _card_action(self, card_obj, action: str):
        sess = self._session()
        if not sess:
            return None
        typ = card_obj.type if card_obj is not None else None
        c = sess.mark_card(typ, action)
        if c:
            self.audit.record("card_" + action, card=c.id, type=c.type)
        return c

    def _regenerate(self):
        if self._session():
            self._session().regenerate()

    def _pin(self):
        sess = self._session()
        if sess:
            p = sess.pin_last_line()
            if p:
                self.status_lbl.setText("Pinned: " + p.quote[:80])

    def _task(self):
        sess = self._session()
        if not sess:
            return
        title, ok = QInputDialog.getText(self, "Create task", "Task (add a date like 'by Friday' if you want it diarised):")
        if ok and title.strip():
            from callpilot.ai.pins import extract

            due = next((e.due for e in extract(title) if e.due), "")
            sess.add_task(title.strip(), due)

    def _notice_given(self):
        if self._session():
            self._session().notice_given()
            self.audit.record("notice_given")

    def _pause_recording(self, paused: bool):
        if self.controller:
            self.controller.pause_recording(paused)
            self.audit.record("recording_paused" if paused else "recording_resumed")
            self.btn_pause.setText("▶ Resume" if paused else "❚❚ Pause for card details")

    def _book_car(self):
        hub = self.current_hub()
        sess = self._session()
        if not sess or not hub:
            return
        terms = next((a for q, a in hub.qa_pairs() if "insured" in q.lower() or "hire" in q.lower()), "")
        c = Card(SAY, "Let's get your replacement vehicle booked. I'll confirm a delivery slot before we finish, and "
                      "I need to run you through the short hire terms first.", ["script:book car"], origin="script")
        c.more = terms
        sess.deck.show(c)
        sess.add_task("Book replacement vehicle – confirm delivery slot and hire terms agreed")

    def _ask(self, text: str):
        sess = self._session()
        if sess:
            self.status_lbl.setText("Asking the AI…")
            sess.ask(text)
            return
        hub = self.current_hub()
        if not hub:
            return
        from callpilot.ai.copilot import CallSession

        try:
            prov = make_provider(self.s.ai)
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, "Ask", str(e))
            return
        if self._prep_session is None or self._prep_session.hub.id != hub.id:
            if self._prep_session is not None:
                self._prep_session.end(summarize=False)
            self._prep_session = CallSession(self.s, hub, prov, self.bridge.event.emit, case_file=self.case_file,
                                             call_type=self.call_type.currentData() or "", memory=self.memory)
        self.status_lbl.setText("Asking the AI…")
        self._prep_session.ask(text)

    def _maybe_whisper(self, cards: list[Card]):
        if not self.chk_whisper.isChecked() or not cards:
            return
        top = next((c for c in (dict((c.type, c) for c in cards).get(t) for t in (WATCH, SAY)) if c), None)
        if top is None or top.type not in self.s.whisper.types or not top.done or not top.text:
            return
        text = top.text if top.type == WATCH else top.spoken()
        if text == self._last_whispered:
            return
        self._last_whispered = text
        tts.stop()
        tts.speak(("Watch out. " if top.type == WATCH else "") + text, self.s.whisper.device, self.s.whisper.voice,
                  ear=self.s.whisper.ear, on_error=lambda e: self.bridge.event.emit("error", f"Whisper failed: {e}"))

    def _field_edited(self, key: str, value: str, confirmed: bool):
        sess = self._session()
        if sess:
            sess.set_field(key, value, confirmed)
        self._update_ring()

    def _toggle_mute(self, muted: bool):
        self.btn_mute.setText("🔇" if muted else "🎙")
        self.btn_mute.setToolTip("Unmute my microphone" if muted else "Mute my microphone")
        self.btn_mute.setAccessibleName("Microphone muted – unmute" if muted else "Mute microphone")
        if self.controller:
            self.controller.set_muted("agent", muted)

    def _toggle_translation_view(self, on: bool):
        self.transcript.show_translation = on
        self.transcript.rebuild()

    def _toggle_overlay(self, on: bool):
        self._overlay_auto = False   # any toggle (button, ✕, hotkey, gear, tray) makes the state manual
        self.overlay.setVisible(on)

    def _open_settings(self, tab: int = 0):
        dlg = SettingsDialog(self.s, self, start_tab=tab, audit=self.audit)
        if dlg.exec():
            config.save(self.s)
            self._apply_theme()
            self.overlay._opacity = self.s.ui.overlay_opacity
            self.overlay.font_pt = self.s.ui.overlay_font_pt
            self.overlay.set_click_through(self.s.ui.overlay_click_through)
            self.store.privacy = self.s.privacy
            self.chk_whisper.setChecked(self.s.whisper.enabled)
            self.hotkeys.stop()
            self._setup_hotkeys()
            if self.controller and self.controller.running:
                self.status_lbl.setText("Settings saved – some changes apply from the next call.")

    def _open_history(self):
        HistoryDialog(self.store, self, audit=self.audit).exec()

    # ================================================================ hotkeys / tray
    def _setup_hotkeys(self):
        u = self.s.ui
        self.hotkeys = GlobalHotkeys({"call": u.hotkey_toggle_call, "regen": u.hotkey_regenerate,
                                      "overlay": u.hotkey_overlay, "copy": u.hotkey_copy, "pin": u.hotkey_pin})
        self.hotkeys.triggered.connect(self._on_hotkey)
        self.hotkeys.start()

    def _on_hotkey(self, action: str):
        if action == "call":
            self._toggle_call()
        elif action == "regen":
            self._regenerate()
        elif action == "overlay":
            self.btn_overlay.setChecked(not self.overlay.isVisible())
        elif action == "copy":
            sess = self._session()
            top = sess.deck.top() if sess else None
            if top:
                QApplication.clipboard().setText(top.translated or top.spoken())
        elif action == "pin":
            self._pin()

    def _setup_tray(self, icon: QIcon | None):
        self.tray = None
        if not QSystemTrayIcon.isSystemTrayAvailable() or icon is None:
            return
        self.tray = QSystemTrayIcon(icon, self)
        menu = QMenu()
        for label, slot in (("Show CallPilot", self.showNormal), ("Start / end call", self._toggle_call),
                            ("Toggle overlay", lambda: self.btn_overlay.setChecked(not self.overlay.isVisible())),
                            ("Quit", QApplication.instance().quit)):
            a = QAction(label, self)
            a.triggered.connect(slot)
            menu.addAction(a)
        self.tray.setContextMenu(menu)
        self.tray.setToolTip(__app_name__)
        self.tray.activated.connect(lambda r: self.showNormal() if r == QSystemTrayIcon.Trigger else None)
        self.tray.show()

    # ================================================================ persistence
    def _restore_geometry(self):
        g = self.s.ui.window_geometry
        if g:
            self.restoreGeometry(QByteArray.fromBase64(g.encode()))
        og = self.s.ui.overlay_geometry
        if og:
            self.overlay.restoreGeometry(QByteArray.fromBase64(og.encode()))

    def closeEvent(self, e):
        ctl = self.controller
        if ctl is not None and ctl.running:
            if QMessageBox.question(self, "Quit", "A call is in progress. End it and quit?") != QMessageBox.Yes:
                e.ignore()
                return
            ctl.stop(summarize=False)
        unsaved = bool(ctl is not None and ctl.session and ctl.session.segments
                       and id(ctl.session) not in self._saved_sessions)
        t = self._save_thread
        if (t is not None and t.is_alive()) or unsaved:
            self.status_lbl.setText("Saving the call…")
            QApplication.processEvents()
        if t is not None and t.is_alive():
            t.join()   # never quit with a half-written session or a half-zeroed recording
        if unsaved:
            self._saved_sessions.add(id(ctl.session))
            try:
                self.store.save(self._encrypt_recording(ctl.session.to_record()))
            except Exception:  # noqa: BLE001
                log.exception("saving call on close")
        self.s.ui.window_geometry = bytes(self.saveGeometry().toBase64()).decode()
        self.s.ui.overlay_geometry = bytes(self.overlay.saveGeometry().toBase64()).decode()
        self.s.ui.auto_answer = self.chk_auto.isChecked()
        self.s.whisper.enabled = self.chk_whisper.isChecked()
        config.save(self.s)
        self.hotkeys.stop()
        self.overlay.close()
        self.audit.record("app_closed")
        if self.tray:
            self.tray.hide()
        super().closeEvent(e)
        QApplication.instance().quit()


def first_run_message(win: MainWindow):
    if not win.s.first_run:
        return
    from callpilot.ui.setup_wizard import SetupWizard

    if hasattr(win, "_run_setup"):
        win._run_setup()
    else:
        SetupWizard(win.s, win).exec()
    win.s.first_run = False
    config.save(win.s)


__all__ = ["MainWindow", "first_run_message", "FileEditor"]

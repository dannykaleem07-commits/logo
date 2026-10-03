"""CallPilot main window."""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

from PySide6.QtCore import QByteArray, QObject, Qt, QTimer, Signal
from PySide6.QtGui import QAction, QIcon, QKeySequence, QShortcut
from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox, QFileDialog, QFrame, QHBoxLayout,
                               QInputDialog, QLabel, QListWidget, QMainWindow, QMenu, QMessageBox,
                               QPushButton, QSplitter, QStatusBar, QSystemTrayIcon, QTabWidget,
                               QTextBrowser, QVBoxLayout, QWidget)

from callpilot import __app_name__, __version__
from callpilot.ai import tts
from callpilot.ai.providers import make_provider
from callpilot.ai.translator import language_name
from callpilot.core import config, paths
from callpilot.core.audit import AuditLog
from callpilot.core.controller import CallController
from callpilot.core.models import Suggestion
from callpilot.core.sessions import SessionStore
from callpilot.hubs.model import Hub, HubStore
from callpilot.ui import winutil
from callpilot.ui.history import HistoryDialog
from callpilot.ui.hotkeys import GlobalHotkeys
from callpilot.ui.hub_editor import HubEditor
from callpilot.ui.overlay import OverlayWindow
from callpilot.ui.settings_dialog import SettingsDialog
from callpilot.ui.theme import stylesheet
from callpilot.ui.widgets import (AskBar, FieldsPanel, LevelMeter, SentimentMeter, SuggestionPanel,
                                  TranscriptView, card, section)

log = logging.getLogger(__name__)


class Bridge(QObject):
    """Delivers events from worker threads onto the UI thread."""

    event = Signal(str, object)


class MainWindow(QMainWindow):
    def __init__(self, settings: config.Settings, audit: AuditLog, icon: QIcon | None = None):
        super().__init__()
        self.s = settings
        self.audit = audit
        self.hubs = HubStore()
        self.store = SessionStore(settings.privacy)
        self.controller: CallController | None = None
        self._saved_sessions: set[int] = set()
        self.call_started_at: float | None = None
        self.bridge = Bridge()
        self.bridge.event.connect(self._on_event)
        self.setWindowTitle(f"{__app_name__} {__version__}")
        if icon:
            self.setWindowIcon(icon)
        self.resize(1360, 860)
        self._build()
        self._apply_theme()
        self.overlay = OverlayWindow(settings.ui.overlay_opacity, settings.ui.overlay_font_pt,
                                     settings.privacy.exclude_windows_from_capture)
        self.overlay.set_click_through(settings.ui.overlay_click_through)
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
        root = QWidget()
        root.setObjectName("root")
        self.setCentralWidget(root)
        v = QVBoxLayout(root)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)

        header = QFrame()
        header.setObjectName("header")
        h = QHBoxLayout(header)
        h.setContentsMargins(18, 10, 18, 10)
        title = QLabel(f"◉ {__app_name__}")
        title.setObjectName("title")
        h.addWidget(title)
        h.addSpacing(16)
        h.addWidget(QLabel("Call hub"))
        self.hub_combo = QComboBox()
        self.hub_combo.setMinimumWidth(320)
        self.hub_combo.currentIndexChanged.connect(self._on_hub_changed)
        h.addWidget(self.hub_combo)
        hub_btn = QPushButton("Hub ▾")
        hub_menu = QMenu(self)
        for label, slot in (("Edit / train this hub…", self._edit_hub), ("New hub…", self._new_hub),
                            ("Duplicate hub", self._duplicate_hub), ("Import hub (.json)…", self._import_hub),
                            ("Export hub (.json)…", self._export_hub), ("Delete hub", self._delete_hub)):
            act = QAction(label, self)
            act.triggered.connect(slot)
            hub_menu.addAction(act)
        hub_btn.setMenu(hub_menu)
        h.addWidget(hub_btn)
        h.addStretch()
        self.lang_badge = QLabel("Language: –")
        self.lang_badge.setObjectName("badge")
        self.latency_badge = QLabel("AI –")
        self.latency_badge.setObjectName("badge")
        self.provider_badge = QLabel("")
        self.provider_badge.setObjectName("badge")
        for b in (self.provider_badge, self.lang_badge, self.latency_badge):
            h.addWidget(b)
        h.addSpacing(10)
        self.btn_overlay = QPushButton("Overlay")
        self.btn_overlay.setCheckable(True)
        self.btn_overlay.toggled.connect(self._toggle_overlay)
        self.btn_history = QPushButton("History")
        self.btn_history.clicked.connect(self._open_history)
        self.btn_settings = QPushButton("⚙ Settings")
        self.btn_settings.clicked.connect(lambda: self._open_settings())
        self.btn_call = QPushButton("●  Start call")
        self.btn_call.setObjectName("start")
        self.btn_call.clicked.connect(self._toggle_call)
        for b in (self.btn_overlay, self.btn_history, self.btn_settings, self.btn_call):
            h.addWidget(b)
        v.addWidget(header)

        body = QWidget()
        bl = QHBoxLayout(body)
        bl.setContentsMargins(14, 14, 14, 14)
        split = QSplitter(Qt.Horizontal)
        bl.addWidget(split)
        v.addWidget(body, 1)

        left = card()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(16, 12, 16, 12)
        top = QHBoxLayout()
        top.addWidget(section("Live transcript"))
        top.addStretch()
        self.chk_translation = QCheckBox("Show translation")
        self.chk_translation.setChecked(True)
        self.chk_translation.toggled.connect(self._toggle_translation_view)
        self.btn_mute = QPushButton("🎙 Mic on")
        self.btn_mute.setCheckable(True)
        self.btn_mute.toggled.connect(self._toggle_mute)
        top.addWidget(self.chk_translation)
        top.addWidget(self.btn_mute)
        ll.addLayout(top)
        self.transcript = TranscriptView(self.s.ui.theme)
        ll.addWidget(self.transcript, 1)
        self.ask_bar = AskBar()
        self.ask_bar.asked.connect(self._ask)
        ll.addWidget(self.ask_bar)
        split.addWidget(left)

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(12)
        self.suggestion = SuggestionPanel()
        self.suggestion.regenerate.connect(self._regenerate)
        self.suggestion.speak.connect(self._speak)
        self.suggestion.closing.connect(self._show_closing)
        rl.addWidget(self.suggestion, 3)
        self.tabs = QTabWidget()
        self.fields = FieldsPanel()
        self.fields.edited.connect(self._field_edited)
        from PySide6.QtWidgets import QScrollArea

        sa = QScrollArea()
        sa.setWidgetResizable(True)
        sa.setWidget(self.fields)
        self.tabs.addTab(sa, "Claim form")
        self.checklist = QListWidget()
        self.tabs.addTab(self.checklist, "Checklist")
        self.alerts = QListWidget()
        self.tabs.addTab(self.alerts, "Alerts")
        self.summary = QTextBrowser()
        self.tabs.addTab(self.summary, "Summary")
        rl.addWidget(self.tabs, 2)
        split.addWidget(right)
        split.setSizes([700, 640])

        sb = QStatusBar()
        self.setStatusBar(sb)
        self.mic_meter = LevelMeter("You", self.s.ui.theme)
        self.caller_meter = LevelMeter("Caller", self.s.ui.theme)
        self.timer_lbl = QLabel("00:00")
        self.sentiment = SentimentMeter("Caller mood 😐")
        self.status_lbl = QLabel("Ready")
        sec = QLabel("🔒 AES-256 · keys in Windows Credential Manager")
        sec.setToolTip("Call history is encrypted at rest with AES-256-GCM. API keys are DPAPI protected.")
        sb.addWidget(QLabel("You"))
        sb.addWidget(self.mic_meter)
        sb.addWidget(QLabel("Caller"))
        sb.addWidget(self.caller_meter)
        sb.addWidget(self.timer_lbl)
        sb.addWidget(self.sentiment)
        sb.addWidget(self.status_lbl, 1)
        sb.addPermanentWidget(sec)

        QShortcut(QKeySequence("Ctrl+R"), self, activated=self._regenerate)
        QShortcut(QKeySequence("Ctrl+K"), self, activated=lambda: self.ask_bar.edit.setFocus())

    def _apply_theme(self):
        QApplication.instance().setStyleSheet(stylesheet(self.s.ui.theme, self.s.ui.font_pt))
        prov = "Claude" if self.s.ai.provider == "anthropic" else "ChatGPT"
        model = self.s.ai.anthropic_model if self.s.ai.provider == "anthropic" else self.s.ai.openai_model
        self.provider_badge.setText(f"{prov} · {model}")

    def showEvent(self, e):
        super().showEvent(e)
        if self.s.privacy.exclude_windows_from_capture:
            winutil.exclude_from_capture(self, True)

    # ================================================================ hubs
    def _load_hubs(self, select: str | None = None):
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
        return self.hubs.get(hid) if hid else None

    def _on_hub_changed(self, *_):
        hub = self.current_hub()
        if not hub:
            return
        self.s.active_hub = hub.id
        config.save(self.s)
        self.fields.set_fields(hub.capture_fields)
        self._render_checklist({d: False for d in hub.required_disclosures})

    def _edit_hub(self):
        hub = self.current_hub()
        if not hub:
            return
        dlg = HubEditor(hub, provider_factory=lambda: make_provider(self.s.ai), parent=self)
        if dlg.exec():
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

    # ================================================================ call control
    def _toggle_call(self):
        if self.controller and self.controller.running:
            self._end_call()
        elif self.controller is None:
            self._start_call()

    def _start_call(self):
        hub = self.current_hub()
        if not hub:
            QMessageBox.warning(self, "Start call", "Create or select a call hub first.")
            return
        self.transcript.clear_all()
        self.alerts.clear()
        self.summary.clear()
        self.fields.set_fields(hub.capture_fields)
        self._render_checklist({d: False for d in hub.required_disclosures})
        self.btn_call.setEnabled(False)
        self.btn_call.setText("Starting…")
        self.status_lbl.setText("Connecting audio and speech…")
        self.controller = CallController(self.s, hub, self.bridge.event.emit)
        self._show_opening(hub)

        def run():
            try:
                self.controller.start()
            except Exception as e:  # noqa: BLE001
                log.exception("start failed")
                self.bridge.event.emit("start_failed", str(e))

        threading.Thread(target=run, daemon=True).start()

    def _show_opening(self, hub: Hub):
        greet = hub.greeting.replace("{agent}", self.s.agent_name or "…")
        consent = hub.consent_script if self.s.privacy.consent_reminder else ""
        s = Suggestion(turn_id="open", filler="Opening script", say_now=greet, continue_with=consent,
                       source="instant-kb", done=True)
        self.suggestion.show_suggestion(s)
        self.overlay.show_suggestion(s)

    def _show_closing(self):
        hub = self.current_hub()
        if not hub or not hub.closing:
            return
        missing = []
        if self.controller and self.controller.session:
            missing = self.controller.session.monitor.missing_disclosures()
        s = Suggestion(turn_id="close", filler="Closing script", say_now=hub.closing,
                       warnings=(["Before closing, still to cover: " + "; ".join(missing)] if missing else []),
                       source="instant-kb", done=True)
        self.suggestion.show_suggestion(s)
        self.overlay.show_suggestion(s)

    def _end_call(self):
        self.btn_call.setEnabled(False)
        self.btn_call.setText("Wrapping up…")
        self.status_lbl.setText("Writing call summary…")
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
        self._saved_sessions.add(id(ctl.session)) if ctl and ctl.session else None
        self.call_started_at = None
        self.btn_call.setEnabled(True)
        self.btn_call.setObjectName("start")
        self.btn_call.setText("●  Start call")
        self.btn_call.setStyle(self.btn_call.style())
        self.status_lbl.setText("Call ended")
        if self.s.ui.overlay_enabled and not self.btn_overlay.isChecked():
            self.overlay.hide()
        if summary:
            self._render_summary(summary)
            self.tabs.setCurrentWidget(self.summary)
        if ctl and ctl.session and ctl.session.segments:
            try:
                f = self.store.save(ctl.session.to_record())
                self.audit.record("call_saved", file=f.name if f else None,
                                  segments=len(ctl.session.segments), hub=ctl.hub.id)
            except Exception as e:  # noqa: BLE001
                self.bridge.event.emit("error", f"Could not save call: {e}")

    # ================================================================ events
    def _on_event(self, kind: str, payload):
        if kind == "segment":
            self.transcript.upsert(payload)
        elif kind == "suggestion":
            self.suggestion.show_suggestion(payload)
            self.overlay.show_suggestion(payload)
        elif kind == "fields":
            self.fields.update_values(payload)
        elif kind == "alert":
            self.alerts.insertItem(0, f"{time.strftime('%H:%M:%S')}  {payload}")
            self.tabs.setTabText(2, f"Alerts ({self.alerts.count()})")
            self.status_lbl.setText("⚠ " + str(payload))
            if self.tray and "Escalation" in str(payload):
                self.tray.showMessage("CallPilot alert", str(payload), QSystemTrayIcon.Warning, 4000)
        elif kind == "disclosures":
            self._render_checklist(payload)
        elif kind == "sentiment":
            self.sentiment.set_value(payload)
        elif kind == "language":
            self.lang_badge.setText(f"Caller: {language_name(payload)}")
        elif kind == "latency":
            self.latency_badge.setText(f"AI {payload['first_token_ms'] / 1000:.2f}s")
            self.overlay.set_status(f"CallPilot · {payload['first_token_ms'] / 1000:.2f}s")
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
            self.btn_call.setText("■  End call")
            self.btn_call.setStyle(self.btn_call.style())
            if not self.status_lbl.text().startswith("Capturing"):
                self.status_lbl.setText("Live")
            if self.s.ui.overlay_enabled:
                self.overlay.show()
            self.audit.record("call_started", hub=self.controller.hub.id if self.controller else "")
        elif kind == "start_failed":
            self.controller = None
            self.btn_call.setEnabled(True)
            self.btn_call.setText("●  Start call")
            self.status_lbl.setText("Could not start")
            QMessageBox.warning(self, "Could not start the call", str(payload))
        elif kind == "call_ended":
            self._finish_call(payload or {})
        elif kind == "summary":
            self._render_summary(payload)

    def _render_checklist(self, done: dict):
        self.checklist.clear()
        for d, ok in done.items():
            self.checklist.addItem(("✅  " if ok else "⬜  ") + d)
        missing = sum(1 for ok in done.values() if not ok)
        self.tabs.setTabText(1, f"Checklist ({missing} left)" if missing else "Checklist ✓")

    def _render_summary(self, s: dict):
        if not s:
            return
        parts = [f"<h3>Summary</h3><p>{s.get('summary', '')}</p>"]
        if s.get("outcome"):
            parts.append(f"<p><b>Outcome:</b> {s['outcome']}</p>")
        if s.get("liability_view"):
            parts.append(f"<p><b>Liability view:</b> {s['liability_view']}</p>")
        if s.get("next_actions"):
            parts.append("<b>Next actions</b><ul>" + "".join(f"<li>{a}</li>" for a in s["next_actions"]) + "</ul>")
        if s.get("compliance_gaps"):
            parts.append("<b>Compliance gaps</b><ul>" + "".join(f"<li>{a}</li>" for a in s["compliance_gaps"])
                         + "</ul>")
        if s.get("vulnerability"):
            parts.append(f"<p><b>Vulnerability:</b> {s['vulnerability']}</p>")
        if s.get("quality_score") is not None:
            parts.append(f"<p><b>Call quality:</b> {s['quality_score']}/100</p>")
        if s.get("coaching_tip"):
            parts.append(f"<p><b>Coaching tip:</b> {s['coaching_tip']}</p>")
        if s.get("error"):
            parts.append(f"<p style='color:#EF4444'>{s['error']}</p>")
        self.summary.setHtml("".join(parts))

    def _on_tick(self):
        ctl = self.controller
        if ctl and ctl.running:
            lv = ctl.levels()
            self.mic_meter.set_db(lv.get("agent", -120))
            self.caller_meter.set_db(lv.get("caller", -120))
            if self.call_started_at:
                secs = int(time.time() - self.call_started_at)
                self.timer_lbl.setText(f"{secs // 60:02}:{secs % 60:02}")
        else:
            self.mic_meter.set_db(-120)
            self.caller_meter.set_db(-120)

    # ================================================================ actions
    def _regenerate(self):
        if self.controller and self.controller.session:
            self.controller.session.regenerate()

    def _ask(self, text: str):
        if self.controller and self.controller.session:
            self.controller.session.ask(text)
            return
        # Not on a call: answer from the hub anyway (practice / prep mode).
        hub = self.current_hub()
        if not hub:
            return
        from callpilot.ai.copilot import CallSession

        try:
            prov = make_provider(self.s.ai)
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, "Ask", str(e))
            return
        self._prep_session = CallSession(self.s, hub, prov, self.bridge.event.emit)
        self._prep_session.ask(text)

    def _speak(self, text: str):
        if not text:
            return
        if not self.s.translation.speak_replies:
            QMessageBox.information(self, "Speak", "Enable the voice interpreter in Settings → Translation.")
            return
        self.status_lbl.setText("Speaking…")
        tts.speak(text, self.s.translation.tts_output_device, self.s.translation.tts_voice,
                  on_done=lambda: self.bridge.event.emit("status", "Spoken"),
                  on_error=lambda e: self.bridge.event.emit("error", f"Speech failed: {e}"))

    def _field_edited(self, key: str, value: str):
        if self.controller and self.controller.session:
            self.controller.session.fields[key] = value

    def _toggle_mute(self, muted: bool):
        self.btn_mute.setText("🔇 Mic muted" if muted else "🎙 Mic on")
        if self.controller:
            self.controller.set_muted("agent", muted)

    def _toggle_translation_view(self, on: bool):
        self.transcript.show_translation = on
        self.transcript._dirty = True

    def _toggle_overlay(self, on: bool):
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
                                      "overlay": u.hotkey_overlay, "copy": u.hotkey_copy})
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
            self.suggestion.copy()

    def _setup_tray(self, icon: QIcon | None):
        self.tray = None
        if not QSystemTrayIcon.isSystemTrayAvailable() or icon is None:
            return
        self.tray = QSystemTrayIcon(icon, self)
        menu = QMenu()
        for label, slot in (("Show CallPilot", self.showNormal), ("Start / end call", self._toggle_call),
                            ("Toggle overlay", lambda: self.btn_overlay.toggle()),
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
        if ctl is not None:
            if ctl.running:
                if QMessageBox.question(self, "Quit", "A call is in progress. End it and quit?") != QMessageBox.Yes:
                    e.ignore()
                    return
                ctl.stop(summarize=False)
            # Either we just stopped it, or it is still wrapping up in the background:
            # save the transcript now so nothing is lost when the process exits.
            if ctl.session and ctl.session.segments and id(ctl.session) not in self._saved_sessions:
                self._saved_sessions.add(id(ctl.session))
                try:
                    self.store.save(ctl.session.to_record())
                except Exception:  # noqa: BLE001
                    log.exception("saving call on close")
        self.s.ui.window_geometry = bytes(self.saveGeometry().toBase64()).decode()
        self.s.ui.overlay_geometry = bytes(self.overlay.saveGeometry().toBase64()).decode()
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
    win.s.first_run = False
    config.save(win.s)
    QMessageBox.information(
        win, "Welcome to CallPilot",
        "Three quick steps:\n\n"
        "1. Settings → API keys: add your Anthropic (Claude) or OpenAI key, plus a Deepgram key for live speech.\n"
        "2. Settings → Audio sources: tick WhatsApp (or Teams / Zoom / your softphone).\n"
        "3. Pick a call hub (Courtesy Cars is pre-loaded) and press ● Start call.\n\n"
        f"Your data folder: {paths.app_data_dir()}")
    win._open_settings(0)

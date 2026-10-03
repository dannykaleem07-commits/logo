"""First-run setup: AI key → speech → which app to listen to (with a live mic test) → done."""

from __future__ import annotations

import threading

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import (QCheckBox, QComboBox, QHBoxLayout, QLabel, QLineEdit, QListWidget,
                               QListWidgetItem, QPushButton, QVBoxLayout, QWizard, QWizardPage)

from callpilot.core import config, secrets
from callpilot.core.config import MODEL_PRESETS, Settings, apply_preset
from callpilot.ui.widgets import LevelMeter


def _key_row(name: str, placeholder: str) -> tuple[QHBoxLayout, QLineEdit]:
    row = QHBoxLayout()
    edit = QLineEdit(secrets.get(name))
    edit.setEchoMode(QLineEdit.Password)
    edit.setPlaceholderText(placeholder)
    eye = QPushButton("👁")
    eye.setFixedWidth(40)
    eye.setCheckable(True)
    eye.toggled.connect(lambda on: edit.setEchoMode(QLineEdit.Normal if on else QLineEdit.Password))
    row.addWidget(edit, 1)
    row.addWidget(eye)
    return row, edit


class AIPage(QWizardPage):
    tested = Signal(str)

    def __init__(self, s: Settings):
        super().__init__()
        self.s = s
        self.setTitle("1 · Which AI?")
        self.setSubTitle("Pick the brain and paste its key. You can change this any time from the AI dropdown.")
        lay = QVBoxLayout(self)
        self.preset = QComboBox()
        for key, p in MODEL_PRESETS.items():
            self.preset.addItem(p["label"], key)
        self.preset.setCurrentIndex(max(0, self.preset.findData(s.ai.preset)))
        lay.addWidget(self.preset)
        lay.addWidget(QLabel("Anthropic key (Claude) – console.anthropic.com"))
        r1, self.k_anthropic = _key_row("anthropic_api_key", "sk-ant-…")
        lay.addLayout(r1)
        lay.addWidget(QLabel("OpenAI key (ChatGPT, also used for voice) – platform.openai.com"))
        r2, self.k_openai = _key_row("openai_api_key", "sk-…")
        lay.addLayout(r2)
        row = QHBoxLayout()
        self.btn_test = QPushButton("Test connection")
        self.result = QLabel("")
        self.result.setWordWrap(True)
        row.addWidget(self.btn_test)
        row.addWidget(self.result, 1)
        lay.addLayout(row)
        self.btn_test.clicked.connect(self._test)
        self.tested.connect(self.result.setText)
        hint = QLabel("Keys are stored in Windows Credential Manager, never in a file.")
        hint.setObjectName("hint")
        lay.addWidget(hint)

    def _save(self):
        secrets.set("anthropic_api_key", self.k_anthropic.text())
        secrets.set("openai_api_key", self.k_openai.text())
        apply_preset(self.s.ai, self.preset.currentData())

    def _test(self):
        self._save()
        self.result.setText("Testing…")
        cfg = self.s.ai

        def run():
            try:
                import time

                from callpilot.ai.providers import make_provider

                t0 = time.perf_counter()
                p = make_provider(cfg)
                out = p.complete("Reply with exactly: OK", [{"role": "user", "content": "ping"}], 50, fast=True)
                self.tested.emit(f"✅ {p.name} answered “{out.strip()[:30]}” in {time.perf_counter() - t0:.1f}s")
            except Exception as e:  # noqa: BLE001
                self.tested.emit(f"❌ {str(e)[:160]}")

        threading.Thread(target=run, daemon=True).start()

    def validatePage(self) -> bool:
        self._save()
        return True


class SpeechPage(QWizardPage):
    def __init__(self, s: Settings):
        super().__init__()
        self.s = s
        self.setTitle("2 · Speech to text")
        self.setSubTitle("Deepgram is the fastest (about a third of a second). OpenAI works with the key you already "
                         "entered. Offline keeps audio on this PC but is slower.")
        lay = QVBoxLayout(self)
        self.engine = QComboBox()
        for label, key in (("Deepgram streaming – fastest (recommended)", "deepgram"),
                           ("OpenAI transcription – uses your OpenAI key", "openai"),
                           ("Offline (faster-whisper) – private, slower", "local")):
            self.engine.addItem(label, key)
        self.engine.setCurrentIndex(max(0, self.engine.findData(s.speech.engine)))
        lay.addWidget(self.engine)
        lay.addWidget(QLabel("Deepgram key – console.deepgram.com (free credit to start)"))
        row, self.k_deepgram = _key_row("deepgram_api_key", "…")
        lay.addLayout(row)
        self.lang = QComboBox()
        self.lang.addItem("Auto-detect / mixed languages", "multi")
        for code, name in (("en", "English"), ("es", "Spanish"), ("pl", "Polish"), ("ro", "Romanian"),
                           ("ur", "Urdu"), ("pa", "Punjabi"), ("ar", "Arabic"), ("fr", "French"), ("pt", "Portuguese")):
            self.lang.addItem(name, code)
        self.lang.setCurrentIndex(max(0, self.lang.findData(s.speech.language)))
        lay.addWidget(QLabel("Callers mostly speak"))
        lay.addWidget(self.lang)
        self.translate = QCheckBox("Translate the call live when the caller speaks another language")
        self.translate.setChecked(s.translation.enabled)
        lay.addWidget(self.translate)

    def validatePage(self) -> bool:
        secrets.set("deepgram_api_key", self.k_deepgram.text())
        self.s.speech.engine = self.engine.currentData()
        self.s.speech.language = self.lang.currentData()
        self.s.translation.enabled = self.translate.isChecked()
        return True


class AudioPage(QWizardPage):
    def __init__(self, s: Settings):
        super().__init__()
        self.s = s
        self.setTitle("3 · What to listen to")
        self.setSubTitle("Tick the app your calls come through. Speak now to check your microphone.")
        lay = QVBoxLayout(self)
        self.apps = QListWidget()
        self.apps.setMinimumHeight(170)
        lay.addWidget(self.apps)
        row = QHBoxLayout()
        refresh = QPushButton("Refresh")
        refresh.clicked.connect(self._refresh)
        self.all_audio = QCheckBox("Listen to all computer audio instead")
        self.all_audio.setChecked(s.audio.capture_mode == "system")
        row.addWidget(refresh)
        row.addWidget(self.all_audio)
        row.addStretch()
        lay.addLayout(row)
        mic_row = QHBoxLayout()
        mic_row.addWidget(QLabel("Microphone"))
        self.mic = QComboBox()
        self.mic.addItem("(Windows default)", "")
        try:
            from callpilot.audio.capture import list_input_devices

            for n in list_input_devices():
                self.mic.addItem(n, n)
        except Exception:  # noqa: BLE001
            pass
        self.mic.setCurrentIndex(max(0, self.mic.findData(s.audio.mic_device)))
        self.mic.currentIndexChanged.connect(self._restart_meter)
        mic_row.addWidget(self.mic, 1)
        self.meter = LevelMeter("Mic", s.ui.theme)
        self.meter.setFixedWidth(160)
        mic_row.addWidget(self.meter)
        self.mic_state = QLabel("")
        mic_row.addWidget(self.mic_state)
        lay.addLayout(mic_row)
        hint = QLabel("🔊 = playing audio right now. Use a headset so the caller's voice doesn't reach your mic.")
        hint.setObjectName("hint")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        self._src = None
        self._peak = -120.0
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)
        self._refresh()

    def initializePage(self):
        self._restart_meter()
        self._timer.start(80)

    def cleanupPage(self):
        self._stop_meter()

    def _restart_meter(self):
        self._stop_meter()
        try:
            from callpilot.audio.capture import MicSource

            self._src = MicSource(self.mic.currentData() or "")
            self._src.start()
            self.mic_state.setText("")
        except Exception as e:  # noqa: BLE001
            self._src = None
            self.mic_state.setText(f"⚠ {str(e)[:60]}")

    def _stop_meter(self):
        if self._src is not None:
            try:
                self._src.stop()
            except Exception:  # noqa: BLE001
                pass
            self._src = None

    def _tick(self):
        if self._src is None:
            return
        from callpilot.audio import dsp

        x = self._src.pop(dsp.FRAME_SAMPLES)
        db = dsp.rms_db(x)
        self.meter.set_db(db)
        if db > -35:
            self._peak = max(self._peak, db)
            self.mic_state.setText("✅ hearing you")

    def _refresh(self):
        checked = {a.lower() for a in self.s.audio.target_apps}
        self.apps.clear()
        try:
            from callpilot.audio.apps import list_apps

            for app in list_apps():
                it = QListWidgetItem(app.label)
                it.setData(Qt.UserRole, app.exe)
                it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
                it.setCheckState(Qt.Checked if app.exe.lower() in checked or app.has_audio_session else Qt.Unchecked)
                self.apps.addItem(it)
        except Exception as e:  # noqa: BLE001
            self.apps.addItem(f"Could not list apps: {e}")
        if self.apps.count() == 0:
            for exe in ("WhatsApp.exe", "ms-teams.exe", "Zoom.exe", "chrome.exe"):
                it = QListWidgetItem(f"{exe}  (not running)")
                it.setData(Qt.UserRole, exe)
                it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
                it.setCheckState(Qt.Checked if exe.lower() in checked else Qt.Unchecked)
                self.apps.addItem(it)

    def validatePage(self) -> bool:
        self._stop_meter()
        self._timer.stop()
        apps = [self.apps.item(i).data(Qt.UserRole) for i in range(self.apps.count())
                if self.apps.item(i).checkState() == Qt.Checked and self.apps.item(i).data(Qt.UserRole)]
        self.s.audio.capture_mode = "system" if self.all_audio.isChecked() else "apps"
        if apps:
            self.s.audio.target_apps = apps
        self.s.audio.mic_device = self.mic.currentData() or ""
        return True


class FinishPage(QWizardPage):
    def __init__(self, s: Settings):
        super().__init__()
        self.s = s
        self.setTitle("4 · You")
        self.setSubTitle("Used in the opening line and the email drafts.")
        lay = QVBoxLayout(self)
        lay.addWidget(QLabel("Your name"))
        self.name = QLineEdit(s.agent_name)
        lay.addWidget(self.name)
        self.auto = QCheckBox("Offer to start automatically when WhatsApp / Teams / Zoom begins a call")
        self.auto.setChecked(s.ui.auto_detect_calls)
        lay.addWidget(self.auto)
        self.learn = QCheckBox("Learn from every call (answers that worked, facts, your style)")
        self.learn.setChecked(s.ai.learn_after_calls)
        lay.addWidget(self.learn)
        done = QLabel("That's it. Press ● Start call when the next call comes in, and say the recording notice.")
        done.setWordWrap(True)
        lay.addWidget(done)

    def validatePage(self) -> bool:
        self.s.agent_name = self.name.text().strip()
        self.s.ui.auto_detect_calls = self.auto.isChecked()
        self.s.ai.learn_after_calls = self.learn.isChecked()
        return True


class SetupWizard(QWizard):
    def __init__(self, s: Settings, parent=None):
        super().__init__(parent)
        self.s = s
        self.setWindowTitle("CallPilot setup")
        self.setWizardStyle(QWizard.ClassicStyle)
        self.resize(720, 560)
        self.addPage(AIPage(s))
        self.addPage(SpeechPage(s))
        self.addPage(AudioPage(s))
        self.addPage(FinishPage(s))

    def accept(self):
        self.s.first_run = False
        config.save(self.s)
        super().accept()


def setup_needed(s: Settings) -> str:
    """Return a short reason if the app cannot work yet, else ''."""
    if s.ai.provider == "anthropic" and not secrets.get("anthropic_api_key"):
        return "Add your Anthropic (Claude) key"
    if s.ai.provider == "openai" and not secrets.get("openai_api_key"):
        return "Add your OpenAI key"
    if s.speech.engine == "deepgram" and not secrets.get("deepgram_api_key"):
        return "Add a Deepgram key for live speech (or choose another speech engine)"
    if s.speech.engine == "openai" and not secrets.get("openai_api_key"):
        return "Add your OpenAI key for speech"
    if s.audio.capture_mode == "apps" and not s.audio.target_apps:
        return "Choose which app to listen to"
    return ""

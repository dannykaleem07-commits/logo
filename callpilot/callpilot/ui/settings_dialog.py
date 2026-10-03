"""Settings: API keys, AI, speech, audio sources, translation, privacy, interface."""

from __future__ import annotations

import threading
from pathlib import Path

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import (QCheckBox, QComboBox, QDialog, QDialogButtonBox, QDoubleSpinBox,
                               QFormLayout, QHBoxLayout, QInputDialog, QLabel, QLineEdit, QListWidget,
                               QListWidgetItem, QMessageBox, QPlainTextEdit, QPushButton, QSpinBox, QTabWidget,
                               QVBoxLayout, QWidget)

from callpilot.ai.translator import LANGUAGES
from callpilot.core import secrets
from callpilot.core.config import Settings
from callpilot.core.crypto import BadPassphrase, Vault

CLAUDE_LIVE = ["claude-haiku-4-5-20251001", "claude-sonnet-5-5", "claude-opus-5-5"]
CLAUDE_WRAP = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"]
OPENAI_MODELS = ["gpt-4.1-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini"]
STT_LANGS = ["multi", "en", "en-GB", "es", "fr", "de", "it", "pt", "nl", "pl", "ro", "ru", "uk", "tr",
             "hi", "ja", "ko", "zh", "ar", "sv", "da", "no", "fi", "bg", "cs", "el", "hu", "sk", "vi",
             "id", "ms", "ta"]


DEFAULT_DEVICE = "(Windows default)"


def _device_combo(names, current) -> QComboBox:
    c = QComboBox()
    c.addItem(DEFAULT_DEVICE, "")
    for n in names:
        c.addItem(n, n)
    if current and c.findData(current) < 0:
        c.addItem(current, current)
    c.setCurrentIndex(max(0, c.findData(current)))
    return c


def _combo(items, current, editable=False) -> QComboBox:
    c = QComboBox()
    c.setEditable(editable)
    c.addItems(items)
    if current not in items:
        c.addItem(current)
    c.setCurrentText(current)
    return c


class KeyEdit(QWidget):
    def __init__(self, name: str):
        super().__init__()
        self.name = name
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.edit = QLineEdit(secrets.get(name))
        self.edit.setEchoMode(QLineEdit.Password)
        self.edit.setPlaceholderText("not set")
        eye = QPushButton("👁")
        eye.setFixedWidth(40)
        eye.setCheckable(True)
        eye.toggled.connect(lambda on: self.edit.setEchoMode(QLineEdit.Normal if on else QLineEdit.Password))
        lay.addWidget(self.edit, 1)
        lay.addWidget(eye)

    def save(self) -> None:
        if self.edit.text().strip() != secrets.get(self.name):
            secrets.set(self.name, self.edit.text())


class SettingsDialog(QDialog):
    _test_done = Signal(str)

    def __init__(self, settings: Settings, parent=None, start_tab: int = 0, audit=None):
        super().__init__(parent)
        self.setWindowTitle("CallPilot settings")
        self.resize(760, 640)
        self.s = settings
        self.audit = audit
        root = QVBoxLayout(self)
        self.tabs = QTabWidget()
        root.addWidget(self.tabs)
        self._build_keys()
        self._build_ai()
        self._build_speech()
        self._build_audio()
        self._build_translation()
        self._build_calldesk()
        self._build_aimode()
        self._build_memory()
        self._build_privacy()
        self._build_ui()
        self.tabs.setCurrentIndex(start_tab)
        bb = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        bb.accepted.connect(self._save)
        bb.rejected.connect(self.reject)
        root.addWidget(bb)
        self._test_done.connect(lambda msg: QMessageBox.information(self, "Connection test", msg))

    # ------------------------------------------------------------------ tabs
    def _tab(self, title: str) -> QFormLayout:
        w = QWidget()
        f = QFormLayout(w)
        f.setLabelAlignment(Qt.AlignRight)
        f.setVerticalSpacing(10)
        self.tabs.addTab(w, title)
        return f

    def _build_keys(self):
        f = self._tab("API keys")
        note = QLabel("Keys are stored in Windows Credential Manager (DPAPI-protected, per Windows user). "
                      "They are never written to disk in plain text or sent anywhere except the provider.")
        note.setWordWrap(True)
        f.addRow(note)
        self.keys = {n: KeyEdit(n) for n in secrets.KNOWN_KEYS}
        f.addRow("Anthropic (Claude)", self.keys["anthropic_api_key"])
        f.addRow("OpenAI (ChatGPT / Whisper / TTS)", self.keys["openai_api_key"])
        f.addRow("Deepgram (live speech)", self.keys["deepgram_api_key"])
        f.addRow("DeepL (optional translation)", self.keys["deepl_api_key"])
        test = QPushButton("Test AI connection")
        test.clicked.connect(self._test_ai)
        f.addRow("", test)

    def _build_ai(self):
        a = self.s.ai
        f = self._tab("AI co-pilot")
        self.provider = QComboBox()
        self.provider.addItem("Claude (Anthropic)", "anthropic")
        self.provider.addItem("ChatGPT (OpenAI)", "openai")
        self.provider.setCurrentIndex(0 if a.provider == "anthropic" else 1)
        f.addRow("Provider", self.provider)
        self.claude_model = _combo(CLAUDE_LIVE, a.anthropic_model, editable=True)
        self.claude_model.setToolTip("Live cards: speed first. Haiku 4.5 is the recommended live model.")
        f.addRow("Claude model – live cards", self.claude_model)
        self.claude_wrap = _combo(CLAUDE_WRAP, a.anthropic_wrapup_model, editable=True)
        self.claude_wrap.setToolTip("Wrap-up, file note and email: quality first.")
        f.addRow("Claude model – wrap-up", self.claude_wrap)
        self.effort = _combo(["low", "medium", "high"], a.anthropic_effort)
        self.effort.setToolTip("Lower effort = faster live suggestions. 'low' is recommended on calls.")
        f.addRow("Claude effort", self.effort)
        self.fast = QCheckBox("Fast mode (Opus only, up to 2.5× faster output, premium pricing)")
        self.fast.setChecked(a.anthropic_fast_mode)
        f.addRow("", self.fast)
        self.fallbacks = QCheckBox("Automatic fallback model if a request is declined")
        self.fallbacks.setChecked(a.anthropic_fallbacks)
        f.addRow("", self.fallbacks)
        self.openai_model = _combo(OPENAI_MODELS, a.openai_model, editable=True)
        f.addRow("ChatGPT model – live cards", self.openai_model)
        self.openai_wrap = _combo(OPENAI_MODELS, a.openai_wrapup_model, editable=True)
        f.addRow("ChatGPT model – wrap-up", self.openai_wrap)
        self.window_s = QSpinBox()
        self.window_s.setRange(30, 600)
        self.window_s.setSuffix(" s")
        self.window_s.setValue(a.context_window_s)
        self.window_s.setToolTip("Only this much recent transcript is sent with each card request; the hub and file are cached.")
        f.addRow("Transcript window per card", self.window_s)
        self.learn = QCheckBox("Train itself after every call (remember answers that worked, facts, your preferences)")
        self.learn.setChecked(a.learn_after_calls)
        f.addRow("", self.learn)
        self.use_memory = QCheckBox("Use memory of past calls while suggesting")
        self.use_memory.setChecked(a.use_memory)
        f.addRow("", self.use_memory)
        self.speculative = QCheckBox("Speculative drafting (start answering before the caller finishes)")
        self.speculative.setChecked(a.speculative)
        f.addRow("", self.speculative)
        self.max_tokens = QSpinBox()
        self.max_tokens.setRange(150, 4000)
        self.max_tokens.setValue(a.suggestion_max_tokens)
        f.addRow("Max suggestion length (tokens)", self.max_tokens)
        self.extract_n = QSpinBox()
        self.extract_n.setRange(1, 20)
        self.extract_n.setValue(a.extract_every_n_turns)
        f.addRow("Update claim form every N lines", self.extract_n)

    def _build_speech(self):
        sp = self.s.speech
        f = self._tab("Speech")
        self.engine = QComboBox()
        for label, key in (("Deepgram streaming (fastest, recommended)", "deepgram"),
                           ("OpenAI transcription (accurate)", "openai"),
                           ("Offline – faster-whisper on this PC (private)", "local")):
            self.engine.addItem(label, key)
        self.engine.setCurrentIndex(max(0, self.engine.findData(sp.engine)))
        f.addRow("Engine", self.engine)
        self.dg_model = _combo(["nova-3", "nova-2", "nova-3-medical"], sp.deepgram_model, editable=True)
        f.addRow("Deepgram model", self.dg_model)
        self.oa_model = _combo(["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"], sp.openai_model,
                               editable=True)
        f.addRow("OpenAI model", self.oa_model)
        self.local_model = _combo(["tiny", "base", "small", "medium", "large-v3", "distil-large-v3"],
                                  sp.local_model)
        f.addRow("Offline model", self.local_model)
        self.stt_lang = _combo(STT_LANGS, sp.language, editable=True)
        self.stt_lang.setToolTip("'multi' auto-detects and follows language switches mid-call.")
        f.addRow("Spoken language", self.stt_lang)
        self.endpoint = QSpinBox()
        self.endpoint.setRange(100, 2000)
        self.endpoint.setSuffix(" ms")
        self.endpoint.setValue(sp.endpoint_ms)
        self.endpoint.setToolTip("How much silence ends the caller's turn. Lower = faster suggestions.")
        f.addRow("End-of-turn silence", self.endpoint)

    def _build_audio(self):
        from callpilot.audio.capture import list_input_devices, list_output_devices

        au = self.s.audio
        f = self._tab("Audio sources")
        self.mic_enabled = QCheckBox("Transcribe my microphone (shows what you said)")
        self.mic_enabled.setChecked(au.mic_enabled)
        f.addRow("", self.mic_enabled)
        self.mic = _device_combo(list_input_devices(), au.mic_device)
        f.addRow("Microphone", self.mic)
        self.mode = QComboBox()
        for label, key in (("Selected apps only (recommended)", "apps"),
                           ("All computer audio", "system"), ("Off", "off")):
            self.mode.addItem(label, key)
        self.mode.setCurrentIndex(max(0, self.mode.findData(au.capture_mode)))
        f.addRow("Caller audio from", self.mode)
        box = QVBoxLayout()
        self.apps = QListWidget()
        self.apps.setMinimumHeight(180)
        box.addWidget(self.apps)
        row = QHBoxLayout()
        refresh = QPushButton("Refresh running apps")
        self.show_all = QCheckBox("Show every process")
        add = QPushButton("Add by name…")
        row.addWidget(refresh)
        row.addWidget(self.show_all)
        row.addStretch()
        row.addWidget(add)
        box.addLayout(row)
        hint = QLabel("🔊 = currently playing audio. Tip: start the WhatsApp call first, then tick the app "
                      "with 🔊. Per-app capture needs Windows 10 (2004) or Windows 11.")
        hint.setWordWrap(True)
        hint.setObjectName("section")
        box.addWidget(hint)
        wrap = QWidget()
        wrap.setLayout(box)
        f.addRow("Apps to listen to", wrap)
        refresh.clicked.connect(self._refresh_apps)
        self.show_all.toggled.connect(self._refresh_apps)
        add.clicked.connect(self._add_app)
        self.loopback = _device_combo(list_output_devices(), au.loopback_device)
        self.loopback.setToolTip("Used for 'All computer audio'")
        f.addRow("Output device (system mode)", self.loopback)
        self._refresh_apps()

    def _refresh_apps(self):
        checked = set(a.lower() for a in self._checked_apps()) if self.apps.count() else \
            set(a.lower() for a in self.s.audio.target_apps)
        self.apps.clear()
        seen = set()
        try:
            from callpilot.audio.apps import list_apps

            for app in list_apps(include_all=self.show_all.isChecked()):
                it = QListWidgetItem(app.label)
                it.setData(Qt.UserRole, app.exe)
                it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
                it.setCheckState(Qt.Checked if app.exe.lower() in checked else Qt.Unchecked)
                self.apps.addItem(it)
                seen.add(app.exe.lower())
        except Exception as e:  # noqa: BLE001
            self.apps.addItem(f"Could not list apps: {e}")
        for exe in sorted(checked - seen):
            it = QListWidgetItem(f"{exe}  (not running)")
            it.setData(Qt.UserRole, exe)
            it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
            it.setCheckState(Qt.Checked)
            self.apps.addItem(it)

    def _add_app(self):
        name, ok = QInputDialog.getText(self, "Add app", "Executable name (e.g. WhatsApp.exe):")
        if ok and name.strip():
            exe = name.strip() if name.strip().lower().endswith(".exe") else name.strip() + ".exe"
            it = QListWidgetItem(exe)
            it.setData(Qt.UserRole, exe)
            it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
            it.setCheckState(Qt.Checked)
            self.apps.addItem(it)

    def _checked_apps(self) -> list[str]:
        out = []
        for i in range(self.apps.count()):
            it = self.apps.item(i)
            if it.checkState() == Qt.Checked and it.data(Qt.UserRole):
                out.append(it.data(Qt.UserRole))
        return out

    def _build_translation(self):
        from callpilot.audio.capture import list_output_devices

        t = self.s.translation
        f = self._tab("Translation")
        self.tr_enabled = QCheckBox("Translate the conversation live")
        self.tr_enabled.setChecked(t.enabled)
        f.addRow("", self.tr_enabled)
        self.tr_engine = QComboBox()
        for label, key in (("AI model (best for slang & context)", "llm"), ("DeepL", "deepl")):
            self.tr_engine.addItem(label, key)
        self.tr_engine.setCurrentIndex(max(0, self.tr_engine.findData(t.engine)))
        f.addRow("Engine", self.tr_engine)
        self.agent_lang = _combo(sorted(LANGUAGES.values()), t.agent_language)
        f.addRow("My language", self.agent_lang)
        self.reply_their = QCheckBox("Also write suggested replies in the caller's language")
        self.reply_their.setChecked(t.reply_in_caller_language)
        f.addRow("", self.reply_their)
        self.speak = QCheckBox("Enable 🔊 Speak button (voice interpreter via OpenAI TTS)")
        self.speak.setChecked(t.speak_replies)
        f.addRow("", self.speak)
        self.tts_dev = _device_combo(list_output_devices(), t.tts_output_device)
        self.tts_dev.setToolTip("Choose 'CABLE Input' (VB-Audio) to send the voice into the call, "
                                "then select 'CABLE Output' as the microphone in WhatsApp.")
        f.addRow("Speak to device", self.tts_dev)
        self.voice = _combo(["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"],
                            t.tts_voice, editable=True)
        f.addRow("Voice", self.voice)

    def _build_calldesk(self):
        from callpilot.audio.capture import list_output_devices

        r, w, em = self.s.recording, self.s.whisper, self.s.email
        f = self._tab("Recording, whisper && email")
        self.rec_enabled = QCheckBox("Record calls (two tracks: caller left, you right; encrypted after the call)")
        self.rec_enabled.setChecked(r.enabled)
        self.rec_clips = QCheckBox("Keep a 10-second audio clip behind every pin")
        self.rec_clips.setChecked(r.clips)
        f.addRow("", self.rec_enabled)
        f.addRow("", self.rec_clips)
        self.wh_enabled = QCheckBox("Whisper the top card into my headset (toggle with W during a call)")
        self.wh_enabled.setChecked(w.enabled)
        f.addRow("", self.wh_enabled)
        self.wh_device = _device_combo(list_output_devices(), w.device)
        f.addRow("Headset device", self.wh_device)
        self.wh_ear = _combo(["left", "right", "both"], w.ear)
        f.addRow("Ear", self.wh_ear)
        self.wh_voice = _combo(["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"], w.voice, editable=True)
        f.addRow("Whisper voice", self.wh_voice)
        self.wh_types = QComboBox()
        for label, val in (("Watch out + Say this", "say,watch"), ("Watch out only", "watch"), ("Everything", "say,watch,ask")):
            self.wh_types.addItem(label, val)
        self.wh_types.setCurrentIndex(max(0, self.wh_types.findData(",".join(w.types))))
        f.addRow("Whisper which cards", self.wh_types)
        self.em_method = QComboBox()
        for label, val in (("Outlook desktop → Drafts folder", "outlook"), ("Open .eml in default mail app", "eml"),
                           ("Copy to clipboard", "clipboard")):
            self.em_method.addItem(label, val)
        self.em_method.setCurrentIndex(max(0, self.em_method.findData(em.method)))
        f.addRow("“As discussed” email goes to", self.em_method)
        self.em_sig = QPlainTextEdit(em.signature)
        self.em_sig.setMaximumHeight(80)
        self.em_sig.setPlaceholderText("Your email signature (the hub's status line is added underneath)")
        f.addRow("Signature", self.em_sig)
        note = QLabel("The app has no send capability. Every email is a draft; the final click is yours.")
        note.setObjectName("section")
        f.addRow("", note)

    def _build_aimode(self):
        from callpilot.audio.capture import list_output_devices

        va, ex = self.s.voice_agent, self.s.export
        f = self._tab("AI mode && saving")
        note = QLabel("AI mode: a named member of the team takes the call in a realistic voice. It uses the business "
                      "rules, the hub's answers and what it has learned from you. It hands the call back to you on "
                      "escalation words, distress, a request for a person, or anything outside the playbook. It does "
                      "not announce that it is automated, but answers truthfully if a caller asks directly.")
        note.setWordWrap(True)
        f.addRow(note)
        self.va_name = QLineEdit(va.employee_name)
        self.va_name.setPlaceholderText("Name it uses on the call (empty = your name)")
        f.addRow("Employee name", self.va_name)
        self.va_voice = _combo(["coral", "alloy", "ash", "echo", "fable", "nova", "onyx", "sage", "shimmer"], va.voice, editable=True)
        f.addRow("Voice", self.va_voice)
        self.va_device = _device_combo(list_output_devices(), va.output_device)
        self.va_device.setToolTip("On a real call choose the virtual cable input (e.g. 'CABLE Input'); set WhatsApp's "
                                  "microphone to 'CABLE Output'. Rehearsal uses your speakers.")
        f.addRow("Speaks into (virtual cable)", self.va_device)
        self.va_handoff = QLineEdit(va.handoff_line)
        self.va_handoff.setPlaceholderText("Let me pass you to a colleague who can help with that – one moment please.")
        f.addRow("Hand-off line", self.va_handoff)
        f.addRow(QLabel(""))
        self.ex_auto = QCheckBox("After every call, save the transcript, summary, pins and recording to my computer")
        self.ex_auto.setChecked(ex.auto_save_calls)
        f.addRow("", self.ex_auto)
        row = QHBoxLayout()
        self.ex_folder = QLineEdit(ex.folder)
        self.ex_folder.setPlaceholderText("Documents\\CallPilot\\Calls")
        pick = QPushButton("Choose…")

        def choose():
            from PySide6.QtWidgets import QFileDialog

            d = QFileDialog.getExistingDirectory(self, "Save calls to…", self.ex_folder.text() or str(Path.home()))
            if d:
                self.ex_folder.setText(d)

        pick.clicked.connect(choose)
        row.addWidget(self.ex_folder, 1)
        row.addWidget(pick)
        wrap = QWidget()
        wrap.setLayout(row)
        f.addRow("Save calls to", wrap)

    def _build_memory(self):
        from callpilot.core.memory import MemoryStore

        w = QWidget()
        lay = QVBoxLayout(w)
        lay.addWidget(QLabel("Everything the AI has learned from your calls. Tick-free: select a row and delete it "
                             "if it is wrong. Answers with a higher score are offered first."))
        self.mem_store = MemoryStore()
        self.mem_list = QListWidget()
        lay.addWidget(self.mem_list, 1)
        row = QHBoxLayout()
        add = QPushButton("+ Teach an answer…")
        rem = QPushButton("Delete selected")
        clear = QPushButton("Forget everything")
        add.clicked.connect(self._mem_add)
        rem.clicked.connect(self._mem_delete)
        clear.clicked.connect(self._mem_clear)
        for b in (add, rem, clear):
            row.addWidget(b)
        row.addStretch()
        lay.addLayout(row)
        self.tabs.addTab(w, "Memory")
        self._mem_refresh()

    def _mem_refresh(self):
        self.mem_list.clear()
        for e in sorted(self.mem_store.entries, key=lambda e: (e.kind, -e.score)):
            label = {"answer": "💬", "fact": "📌", "lesson": "🎓"}.get(e.kind, "•")
            text = f"{label} [{e.score:.1f}] " + (f"Q: {e.question}  →  A: {e.text}" if e.question else
                                                  (f"{e.subject}: " if e.subject else "") + e.text)
            it = QListWidgetItem(text[:220])
            it.setData(Qt.UserRole, e.id)
            it.setToolTip(text)
            self.mem_list.addItem(it)

    def _mem_add(self):
        from callpilot.core.memory import MemoryEntry

        q, ok = QInputDialog.getText(self, "Teach an answer", "When the caller says…")
        if not ok or not q.strip():
            return
        a, ok = QInputDialog.getMultiLineText(self, "Teach an answer", "…you want to say:")
        if ok and a.strip():
            self.mem_store.add(MemoryEntry("answer", a.strip(), question=q.strip(), hub_id=self.s.active_hub,
                                           score=2.0, origin="manual"))
            self._mem_refresh()

    def _mem_delete(self):
        for it in self.mem_list.selectedItems():
            self.mem_store.remove(it.data(Qt.UserRole))
        self._mem_refresh()

    def _mem_clear(self):
        if QMessageBox.question(self, "Memory", "Forget everything the AI has learned?") == QMessageBox.Yes:
            self.mem_store.clear()
            self._mem_refresh()

    def _build_privacy(self):
        p = self.s.privacy
        f = self._tab("Privacy && security")
        self.save_sessions = QCheckBox("Save call history")
        self.save_sessions.setChecked(p.save_sessions)
        self.encrypt = QCheckBox("Encrypt call history (AES-256-GCM)")
        self.encrypt.setChecked(p.encrypt_sessions)
        self.retention = QSpinBox()
        self.retention.setRange(0, 3650)
        self.retention.setSuffix(" days (0 = keep forever)")
        self.retention.setValue(p.retention_days)
        self.redact_saved = QCheckBox("Redact personal data (phone, email, NI no., DOB, postcode) in saved history")
        self.redact_saved.setChecked(p.redact_saved_pii)
        self.redact_cloud = QCheckBox("Strip card / bank details before anything is sent to AI providers")
        self.redact_cloud.setChecked(p.redact_payment_data_before_cloud)
        self.exclude = QCheckBox("Hide CallPilot windows from screen-sharing and recordings")
        self.exclude.setChecked(p.exclude_windows_from_capture)
        self.consent = QCheckBox("Remind me to read the recording / consent notice at call start")
        self.consent.setChecked(p.consent_reminder)
        for w in (self.save_sessions, self.encrypt):
            f.addRow("", w)
        f.addRow("Auto-delete after", self.retention)
        for w in (self.redact_saved, self.redact_cloud, self.exclude, self.consent):
            f.addRow("", w)
        pw = QPushButton("Set / change master passphrase…")
        pw.clicked.connect(self._change_passphrase)
        f.addRow("App lock", pw)
        self.require_unlock = QCheckBox("Ask for the passphrase every time CallPilot starts")
        self.require_unlock.setChecked(p.require_unlock or Vault.has_passphrase())
        self.require_unlock.setEnabled(False)
        f.addRow("", self.require_unlock)
        verify = QPushButton("Verify tamper-evident audit log")
        verify.clicked.connect(self._verify_audit)
        f.addRow("Audit", verify)

    def _build_ui(self):
        u = self.s.ui
        f = self._tab("Interface")
        self.agent_name = QLineEdit(self.s.agent_name)
        self.agent_name.setPlaceholderText("Used in opening scripts")
        f.addRow("Your name", self.agent_name)
        self.mode = QComboBox()
        self.mode.addItem("Simple – transcript + what to say next (recommended)", "simple")
        self.mode.addItem("Advanced – full Call Desk cockpit", "advanced")
        self.mode.setCurrentIndex(max(0, self.mode.findData(u.mode)))
        f.addRow("View (restart to apply)", self.mode)
        self.auto_detect = QCheckBox("Offer to start when WhatsApp / Teams / Zoom begins playing audio")
        self.auto_detect.setChecked(u.auto_detect_calls)
        f.addRow("", self.auto_detect)
        self.theme = _combo(["dark", "light"], u.theme)
        f.addRow("Theme", self.theme)
        self.font_pt = QSpinBox()
        self.font_pt.setRange(8, 18)
        self.font_pt.setValue(u.font_pt)
        f.addRow("Font size", self.font_pt)
        self.overlay = QCheckBox("Show floating teleprompter during calls")
        self.overlay.setChecked(u.overlay_enabled)
        f.addRow("", self.overlay)
        self.opacity = QDoubleSpinBox()
        self.opacity.setRange(0.4, 1.0)
        self.opacity.setSingleStep(0.05)
        self.opacity.setValue(u.overlay_opacity)
        f.addRow("Overlay opacity", self.opacity)
        self.overlay_font = QSpinBox()
        self.overlay_font.setRange(9, 32)
        self.overlay_font.setValue(u.overlay_font_pt)
        f.addRow("Overlay font size", self.overlay_font)
        self.click_through = QCheckBox("Overlay is click-through (mouse passes to the app below)")
        self.click_through.setChecked(u.overlay_click_through)
        f.addRow("", self.click_through)
        self.hk = {}
        for key, label in (("hotkey_toggle_call", "Start / end call"), ("hotkey_regenerate", "Regenerate"),
                           ("hotkey_overlay", "Show / hide overlay"), ("hotkey_copy", "Copy top card"),
                           ("hotkey_pin", "Pin last line (global)")):
            e = QLineEdit(getattr(u, key))
            e.setPlaceholderText("<ctrl>+<shift>+x")
            self.hk[key] = e
            f.addRow(label, e)

    # ------------------------------------------------------------------ actions
    def _test_ai(self):
        for k in self.keys.values():
            k.save()
        from callpilot.ai.providers import make_provider
        from callpilot.core.config import AISettings

        cfg = AISettings(**{**self.s.ai.__dict__})
        cfg.provider = self.provider.currentData()
        cfg.anthropic_model = self.claude_model.currentText()
        cfg.anthropic_wrapup_model = self.claude_wrap.currentText()
        cfg.openai_model = self.openai_model.currentText()

        def run():
            try:
                import time

                t0 = time.perf_counter()
                p = make_provider(cfg)
                out = p.complete("Reply with exactly: OK", [{"role": "user", "content": "ping"}], 50, fast=True)
                self._test_done.emit(f"✅ {p.name} replied “{out.strip()[:40]}” in "
                                     f"{time.perf_counter() - t0:.2f}s")
            except Exception as e:  # noqa: BLE001
                self._test_done.emit(f"❌ {e}")

        threading.Thread(target=run, daemon=True).start()

    def _change_passphrase(self):
        current = None
        if Vault.has_passphrase():
            current, ok = QInputDialog.getText(self, "Current passphrase", "Current passphrase:",
                                               QLineEdit.Password)
            if not ok:
                return
        new, ok = QInputDialog.getText(self, "New passphrase",
                                       "New passphrase (leave empty to remove the app lock):",
                                       QLineEdit.Password)
        if not ok:
            return
        if new:
            again, ok = QInputDialog.getText(self, "Confirm", "Repeat new passphrase:", QLineEdit.Password)
            if not ok or again != new:
                QMessageBox.warning(self, "Passphrase", "Passphrases do not match.")
                return
            if len(new) < 10:
                QMessageBox.warning(self, "Passphrase", "Use at least 10 characters.")
                return
        try:
            Vault.change_passphrase(current, new or None)
        except BadPassphrase:
            QMessageBox.warning(self, "Passphrase", "Current passphrase is wrong.")
            return
        self.require_unlock.setChecked(bool(new))
        if self.audit:
            self.audit.record("passphrase_changed", enabled=bool(new))
        QMessageBox.information(self, "Passphrase", "Saved." if new else "App lock removed.")

    def _verify_audit(self):
        if not self.audit:
            return
        ok, n = self.audit.verify()
        if ok:
            QMessageBox.information(self, "Audit log", f"✅ Audit log intact ({n} entries).")
        else:
            QMessageBox.critical(self, "Audit log", f"❌ Audit log has been altered at entry {n}.")

    def _save(self):
        for k in self.keys.values():
            k.save()
        a, sp, au, t, p, u = (self.s.ai, self.s.speech, self.s.audio, self.s.translation,
                              self.s.privacy, self.s.ui)
        a.provider = self.provider.currentData()
        a.anthropic_model = self.claude_model.currentText().strip()
        a.anthropic_wrapup_model = self.claude_wrap.currentText().strip()
        a.openai_wrapup_model = self.openai_wrap.currentText().strip()
        a.context_window_s = self.window_s.value()
        a.anthropic_effort = self.effort.currentText()
        a.anthropic_fast_mode = self.fast.isChecked()
        a.anthropic_fallbacks = self.fallbacks.isChecked()
        a.openai_model = self.openai_model.currentText().strip()
        a.speculative = self.speculative.isChecked()
        a.learn_after_calls = self.learn.isChecked()
        a.use_memory = self.use_memory.isChecked()
        a.suggestion_max_tokens = self.max_tokens.value()
        a.extract_every_n_turns = self.extract_n.value()
        sp.engine = self.engine.currentData()
        sp.deepgram_model = self.dg_model.currentText().strip()
        sp.openai_model = self.oa_model.currentText().strip()
        sp.local_model = self.local_model.currentText()
        sp.language = self.stt_lang.currentText().strip()
        sp.endpoint_ms = self.endpoint.value()
        au.mic_enabled = self.mic_enabled.isChecked()
        au.mic_device = self.mic.currentData()
        au.capture_mode = self.mode.currentData()
        au.target_apps = self._checked_apps()
        au.loopback_device = self.loopback.currentData()
        t.enabled = self.tr_enabled.isChecked()
        t.engine = self.tr_engine.currentData()
        t.agent_language = self.agent_lang.currentText()
        t.reply_in_caller_language = self.reply_their.isChecked()
        t.speak_replies = self.speak.isChecked()
        t.tts_output_device = self.tts_dev.currentData()
        t.tts_voice = self.voice.currentText()
        self.s.recording.enabled = self.rec_enabled.isChecked()
        self.s.recording.clips = self.rec_clips.isChecked()
        self.s.whisper.enabled = self.wh_enabled.isChecked()
        self.s.whisper.device = self.wh_device.currentData()
        self.s.whisper.ear = self.wh_ear.currentText()
        self.s.whisper.voice = self.wh_voice.currentText()
        self.s.whisper.types = self.wh_types.currentData().split(",")
        self.s.voice_agent.employee_name = self.va_name.text().strip()
        self.s.voice_agent.voice = self.va_voice.currentText()
        self.s.voice_agent.output_device = self.va_device.currentData()
        self.s.voice_agent.handoff_line = self.va_handoff.text().strip()
        self.s.export.auto_save_calls = self.ex_auto.isChecked()
        self.s.export.folder = self.ex_folder.text().strip()
        self.s.email.method = self.em_method.currentData()
        self.s.email.signature = self.em_sig.toPlainText()
        p.save_sessions = self.save_sessions.isChecked()
        p.encrypt_sessions = self.encrypt.isChecked()
        p.retention_days = self.retention.value()
        p.redact_saved_pii = self.redact_saved.isChecked()
        p.redact_payment_data_before_cloud = self.redact_cloud.isChecked()
        p.exclude_windows_from_capture = self.exclude.isChecked()
        p.consent_reminder = self.consent.isChecked()
        p.require_unlock = self.require_unlock.isChecked()
        self.s.agent_name = self.agent_name.text().strip()
        u.mode = self.mode.currentData()
        u.auto_detect_calls = self.auto_detect.isChecked()
        u.theme = self.theme.currentText()
        u.font_pt = self.font_pt.value()
        u.overlay_enabled = self.overlay.isChecked()
        u.overlay_opacity = self.opacity.value()
        u.overlay_font_pt = self.overlay_font.value()
        u.overlay_click_through = self.click_through.isChecked()
        for key, e in self.hk.items():
            setattr(u, key, e.text().strip())
        if self.audit:
            self.audit.record("settings_saved", provider=a.provider, stt=sp.engine, capture=au.capture_mode)
        QTimer.singleShot(0, self.accept)

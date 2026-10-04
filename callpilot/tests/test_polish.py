"""Final polish: live theme switch, plain-English hotkeys and field names, the empty transcript hint,
placeholder contrast, and the Advanced drawer never squeezing the answer."""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from callpilot.core.models import SAY, WATCH, Card  # noqa: E402
from callpilot.ui.theme import DARK, LIGHT, stylesheet  # noqa: E402

app = QApplication.instance() or QApplication([])


def test_say_panel_switches_theme_live_without_touching_the_read_lock():
    from callpilot.ui.simple_window import SayPanel

    p = SayPanel("dark", 11)
    p.listening = True
    a = Card(SAY, "There's no upfront cost to you.", ["Q&A"], origin="llm")
    a.done = True
    risk = Card(WATCH, "Don't promise 'free' outright.", [])
    p.show_cards([a, risk])
    p.show_cards([Card(SAY, "Queued answer", ["Q&A"], origin="llm"), risk])   # arrives while reading: queued
    assert p.queued is not None
    assert DARK["say"].lower() in p.main.styleSheet().lower()
    p.set_theme("light", 13)
    assert LIGHT["say"].lower() in p.main.styleSheet().lower(), "the answer follows the new theme"
    assert LIGHT["bad_text"].lower() in p.watch.styleSheet().lower(), "so does the risk line"
    assert f"{13 + 13}pt" in p.main.styleSheet(), "and the new font size"
    assert p.current is a and p.queued is not None, "same answer, still queued: the read lock is untouched"
    assert p.scroll.minimumHeight() >= 40 + 8 + 2 * 30, "room for the risk line plus two answer lines"


def test_widgets_switch_theme_live():
    from callpilot.core.models import Segment
    from callpilot.ui.widgets import CardsPanel, RecordDot, TranscriptView

    dot = RecordDot("dark")
    dot.set_state(True, True)
    dot.set_theme("light")
    assert LIGHT["bad_text"].lower() in dot.styleSheet().lower() and "notice given" in dot.text()
    tv = TranscriptView("dark")
    tv.upsert(Segment("caller", "Someone hit me at the lights.", True))
    tv._render()
    tv.set_theme("light")
    assert LIGHT["caller"].lower() in tv.toHtml().lower()
    cp = CardsPanel("dark", 11)
    c = Card(SAY, "Answer", ["Q&A"])
    cp.show_cards([c])
    cp.set_theme("light", 12)
    assert LIGHT["say"].lower() in cp.widgets[SAY].text.styleSheet().lower()


def test_empty_transcript_shows_the_hint_on_first_tick():
    from callpilot.ui.widgets import TranscriptView

    tv = TranscriptView("dark")
    tv._render()
    assert "Start call" in tv.toPlainText()


def test_hotkeys_read_in_plain_english_and_save_in_library_format():
    from callpilot.ui.settings_dialog import pretty_hotkey, pynput_hotkey

    for spec, shown in (("<ctrl>+<shift>+l", "Ctrl+Shift+L"), ("<ctrl>+<shift>+<space>", "Ctrl+Shift+Space"),
                        ("<ctrl>+<alt>+<f9>", "Ctrl+Alt+F9"), ("", "")):
        assert pretty_hotkey(spec) == shown
        assert pynput_hotkey(shown) == spec
    assert pynput_hotkey("ctrl + shift + space") == "<ctrl>+<shift>+<space>"
    assert pynput_hotkey("<ctrl>+<shift>+l") == "<ctrl>+<shift>+l", "the old format still saves unchanged"


def test_saved_transcript_uses_field_labels():
    from callpilot.core.sessions import export_text, field_label

    rec = {"hub_name": "Courtesy Cars", "started_at": 0, "segments": [],
           "fields": {"caller_name": "Jane Smith", "client_vehicle": "AB12 CDE"},
           "field_labels": {"caller_name": "Caller full name"}}
    txt = export_text(rec)
    assert "Caller full name: Jane Smith" in txt
    assert "Client vehicle: AB12 CDE" in txt, "unknown keys fall back to plain words"
    assert "caller_name" not in txt
    assert field_label("third_party_insurer") == "Third party insurer"


def test_stylesheet_has_placeholder_contrast_and_arrows():
    for theme, c in (("dark", DARK), ("light", LIGHT)):
        css = stylesheet(theme, 11)
        assert f"placeholder-text-color: {c['muted']}" in css
        assert "QComboBox::down-arrow" in css and "QSpinBox::up-arrow" in css
        assert "QListWidget {{ outline: 0; }}".replace("{{", "{").replace("}}", "}") in css


def test_advanced_drawer_keeps_the_answer_readable(monkeypatch):
    from tests.test_simple_ui import _close, _window

    w = _window(monkeypatch)
    try:
        w.resize(1366, 688)
        w.show()
        app.processEvents()
        w.btn_advanced.setChecked(True)
        app.processEvents()
        assert w.drawer.isVisible() and w._bottom.isVisible()
        assert w.say_panel.scroll.height() >= w.say_panel._answer_min_height()
        need = w.layout().totalMinimumSize().height()   # what Qt really enforces (minimumSizeHint under-reports)
        assert need <= 688, f"opening Advanced never pushes the window past a 1366 x 768 screen: {need}"
        w.btn_advanced.setChecked(False)
        app.processEvents()
        assert not w.drawer.isVisible()
    finally:
        _close(w)


def test_space_presses_a_tabbed_button_but_stays_said_it_after_a_click(monkeypatch):
    from PySide6.QtCore import Qt
    from PySide6.QtTest import QTest

    from tests.test_simple_ui import _close, _window

    w = _window(monkeypatch)
    calls = []
    w._card_action = lambda c, a: calls.append(a)
    try:
        w.show()
        w.activateWindow()
        QTest.qWaitForWindowActive(w)
        # a mouse user clicked Scripts: Space still means 'said it' and the button is left alone
        w.btn_calls.setFocus(Qt.MouseFocusReason)
        w.btn_scripts.setFocus(Qt.MouseFocusReason)
        before = w.btn_scripts.isChecked()
        QTest.keyClick(w.btn_scripts, Qt.Key_Space)
        assert calls == ["used"] and w.btn_scripts.isChecked() == before
        # focus moved off a disabled button: Qt reports TabFocusReason, but no Tab key was pressed
        w.btn_calls.setFocus(Qt.MouseFocusReason)
        w.btn_scripts.setFocus(Qt.TabFocusReason)
        calls.clear()
        QTest.keyClick(w.btn_scripts, Qt.Key_Space)
        assert calls == ["used"] and w.btn_scripts.isChecked() == before
        # a keyboard user Tabbed to Scripts (Tab forward, then Shift+Tab back): Space presses Scripts
        calls.clear()
        w.btn_scripts.setFocus(Qt.MouseFocusReason)
        QTest.keyClick(w.btn_scripts, Qt.Key_Tab)
        QTest.keyClick(QApplication.focusWidget(), Qt.Key_Backtab, Qt.ShiftModifier)
        assert QApplication.focusWidget() is w.btn_scripts
        QTest.keyClick(w.btn_scripts, Qt.Key_Space)
        assert calls == [] and w.btn_scripts.isChecked() != before
        # Esc is always 'not this'
        QTest.keyClick(w.btn_scripts, Qt.Key_Escape)
        assert calls == ["dismissed"]
    finally:
        _close(w)


def test_said_it_with_an_answer_waiting_marks_the_one_on_screen_and_shows_the_next(monkeypatch):
    """Answer A is being read, answer B waits behind 'Next answer ready'. Space must mark A (the one on screen),
    leave B unmarked, and bring B onto the screen – never mark B unread or wipe both."""
    from types import SimpleNamespace

    from callpilot.ai.cards import CardDeck
    from tests.test_simple_ui import _close, _window

    w = _window(monkeypatch)
    try:
        deck = CardDeck(lambda: w._on_event("cards", deck.visible()))
        sess = SimpleNamespace(mark_card=deck.mark, mark_this=deck.mark_card, deck=deck)
        w.controller = SimpleNamespace(running=True, session=sess, hub=w.current_hub(), set_muted=lambda *a: None,
                                       voice_agent=None, set_ai_mode=lambda on: None)
        w.say_panel.listening = True
        a = Card(SAY, "There's no upfront cost to you.", ["Q&A"], origin="llm")
        a.done = True
        deck.show(a)
        assert w.say_panel.current is a
        b = Card(SAY, "I can book delivery for tomorrow morning.", ["Q&A"], origin="llm")
        b.done = True
        deck.show(b)                                   # arrives while A is being read
        assert w.say_panel.current is a and w.say_panel.queued is not None
        w._card_action(None, "used")                   # Space
        assert a.action == "used", "the answer on screen gets the feedback"
        assert b.action == "", "the waiting answer is not marked unread"
        assert w.say_panel.current is b and w.say_panel.queued is None, "the waiting answer comes onto the screen"
        # nothing live on screen (a script is pinned): Space / Esc do nothing at all
        w.say_panel.pin_script("Recording notice", "This call is recorded.")
        w._card_action(None, "dismissed")
        assert b.action == "" and w.say_panel.pinned_script, "a pinned script is never released by Esc"
    finally:
        _close(w)


def test_named_keys_keep_their_brackets_so_global_hotkeys_still_register():
    from callpilot.ui.settings_dialog import pretty_hotkey, pynput_hotkey

    for spec in ("<ctrl>+<alt>+<pause>", "<ctrl>+<shift>+<menu>", "<ctrl>+<print_screen>", "<ctrl>+<media_play_pause>"):
        assert pynput_hotkey(pretty_hotkey(spec)) == spec
    assert pretty_hotkey("<ctrl>+<alt>+<pause>") == "Ctrl+Alt+Pause"
    try:
        from pynput.keyboard import HotKey
    except Exception:  # noqa: BLE001 - pynput needs a display on Linux
        return
    HotKey.parse(pynput_hotkey("Ctrl+Alt+Pause"))


def test_take_over_brings_back_the_live_answers(monkeypatch):
    from types import SimpleNamespace

    from callpilot.ai.cards import CardDeck
    from tests.test_simple_ui import _close, _window

    w = _window(monkeypatch)
    try:
        deck = CardDeck(lambda: None)
        live = Card(SAY, "There's no upfront cost to you.", ["Q&A"], origin="llm")
        live.done = True
        deck.show(live)
        w.controller = SimpleNamespace(running=True, session=SimpleNamespace(deck=deck, regenerate=lambda: None),
                                       hub=w.current_hub(), set_muted=lambda *a: None, voice_agent=None,
                                       set_ai_mode=lambda on: None, rehearse=True)
        w.say_panel.listening = True
        w.ai_mode = True
        w.btn_ai.setEnabled(True)
        w.btn_ai.blockSignals(True)
        w.btn_ai.setChecked(True)          # AI mode is on, as after pressing 🤖 AI mode
        w.btn_ai.blockSignals(False)
        w._on_event("ai_said", {"text": "Can I take the registration?", "segment_id": ""})
        assert w.say_panel.current.origin == "ai" and not w.say_panel.btn_next.isEnabled()
        w._take_over()
        assert not w.ai_mode
        assert w.say_panel.current is live, "the live suggestion is back on screen"
        assert w.say_panel.btn_next.isEnabled() and w.say_panel.btn_used.isEnabled()
        assert "Press Take over" not in w.say_panel.ask.text()
    finally:
        _close(w)


def test_enter_in_dialogs_acts_on_the_focused_control(monkeypatch, tmp_path):
    from PySide6.QtCore import Qt
    from PySide6.QtTest import QTest

    from callpilot.core.config import Settings
    from callpilot.ui.settings_dialog import SettingsDialog

    monkeypatch.setattr("callpilot.audio.capture.list_output_devices", lambda: [], raising=False)
    monkeypatch.setattr("callpilot.audio.capture.list_input_devices", lambda: [], raising=False)
    d = SettingsDialog(Settings())
    try:
        d.show()
        d.activateWindow()
        QTest.qWaitForWindowActive(d)
        d.nav.setFocus(Qt.TabFocusReason)
        d.nav.setCurrentRow(1)
        QTest.keyClick(d.nav, Qt.Key_Return)
        assert d.isVisible(), "Enter on a section opens it; it never saves and closes Settings"
        fw = QApplication.focusWidget()
        assert fw is not d.nav and d.tabs.currentWidget().isAncestorOf(fw), "focus moved into the section"
        # the hidden tab bar is not a Tab stop: Tab from the nav leaves it
        d.nav.setFocus(Qt.TabFocusReason)
        QTest.keyClick(d.nav, Qt.Key_Tab)
        assert QApplication.focusWidget() is not d.nav, "no keyboard trap in the section list"
    finally:
        d.reject()


def test_menus_follow_the_theme():
    for theme, c in (("dark", DARK), ("light", LIGHT)):
        css = stylesheet(theme, 11)
        assert f"QMenu {{ background: {c['panel']}; color: {c['text']};".replace("{{", "{") in css


def test_buttons_do_not_jump_when_the_first_earlier_answer_arrives():
    from callpilot.ui.simple_window import SayPanel

    p = SayPanel("dark", 11)
    p.resize(760, 760)
    p.show()
    p.listening = True
    a = Card(SAY, "First answer.", ["Q&A"], origin="llm")
    a.done = True
    p.show_cards([a], force=True)
    app.processEvents()
    y0 = p.btn_used.mapTo(p, p.btn_used.rect().topLeft()).y()
    b = Card(SAY, "Second answer.", ["Q&A"], origin="llm")
    b.done = True
    p.show_cards([b], force=True)            # A becomes the first 'earlier answer'
    app.processEvents()
    assert p.recent.count() == 1 and p.recent.isVisible()
    assert p.btn_used.mapTo(p, p.btn_used.rect().topLeft()).y() == y0, "Said it stays where it was"
    p.close()


def test_advanced_drawer_never_sets_the_window_width(monkeypatch):
    from tests.test_simple_ui import _close, _window

    w = _window(monkeypatch)
    try:
        w.show()
        app.processEvents()
        closed = w.minimumSizeHint().width()
        w.btn_advanced.setChecked(True)
        app.processEvents()
        assert w.minimumSizeHint().width() <= max(closed, 911), "the drawer's toolbars scroll sideways instead"
    finally:
        _close(w)

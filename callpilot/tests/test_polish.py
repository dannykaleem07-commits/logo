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
        assert w.minimumSizeHint().height() <= 688, "opening Advanced never pushes the window past a 1366 x 768 screen"
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
        # a keyboard user Tabbed to Scripts: Space presses Scripts, no card is marked
        calls.clear()
        w.btn_calls.setFocus(Qt.TabFocusReason)
        w.btn_scripts.setFocus(Qt.TabFocusReason)
        QTest.keyClick(w.btn_scripts, Qt.Key_Space)
        assert calls == [] and w.btn_scripts.isChecked() != before
        # Esc is always 'not this'
        QTest.keyClick(w.btn_scripts, Qt.Key_Escape)
        assert calls == ["dismissed"]
    finally:
        _close(w)

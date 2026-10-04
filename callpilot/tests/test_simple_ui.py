"""The reading lock in the simple view: an answer never changes under the reader's eyes."""

import os
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from callpilot.core.models import ASK, SAY, WATCH, Card  # noqa: E402
from callpilot.ui.simple_window import SayPanel  # noqa: E402

app = QApplication.instance() or QApplication([])


def _say(text, done=True):
    c = Card(SAY, text, ["Q&A"], origin="llm")
    c.done = done
    return c


def _panel():
    p = SayPanel("dark", 12)
    p.listening = True
    return p


def test_new_answer_queues_while_reading_then_promotes():
    p = _panel()
    a, b = _say("Answer A"), _say("Answer B")
    p.show_cards([a])
    assert p.current is a
    p.show_cards([b, Card(WATCH, "risk", []), Card(ASK, "q1 | q2", [])])
    assert p.current is a, "a new answer must not replace the one being read"
    assert p.queued is not None and p.next_bar.isVisibleTo(p)
    assert p.watch.text().startswith("⚠") and "q1" in p.ask.text(), "risk/ask lines still update"
    p.promote()
    assert p.current is b and p.queued is None and not p.next_bar.isVisibleTo(p)


def test_same_answer_streaming_renders_in_place():
    p = _panel()
    a = _say("There's no upfront", done=False)
    p.show_cards([a])
    a.text = "There's no upfront cost to you"
    p.show_cards([a])
    assert p.current is a and p.queued is None
    assert "no upfront cost to you" in p.main.text()


def test_direct_render_clears_a_stale_queue():
    p = _panel()
    a, b = _say("Answer A"), _say("Answer B")
    p.show_cards([a])
    p.show_cards([b])                       # queued (reading A)
    assert p.queued is not None
    p._shown_at = time.time() - 60          # the reader has long finished
    p.show_cards([b])                       # B streams again -> rendered directly
    assert p.current is b and p.queued is None and not p.next_bar.isVisibleTo(p)
    p.acted()
    assert p.current is b, "acting must not re-promote a stale copy"
    p.show_cards([_say("Answer C")])
    p.show_cards([_say("Answer D")])        # queued
    p._shown_at = time.time() - 60
    p.show_cards([])                        # deck emptied -> no answer, and nothing left queued
    assert p.current is None and p.queued is None and not p.next_bar.isVisibleTo(p)


def test_pinned_script_holds_until_done_reading():
    p = _panel()
    a = _say("Answer A")
    p.show_cards([a])
    p.pin_script("Recording notice", "This call is recorded for training.")
    assert p.current.origin == "script" and p.btn_done.isVisibleTo(p)
    p._shown_at = time.time() - 60
    p.show_cards([_say("Answer B")])        # even after the lock, a pinned script is never replaced
    assert p.current.origin == "script" and p.queued is not None
    p.release()
    assert p.current.text == "Answer B" and not p.btn_done.isVisibleTo(p) and p.queued is None


def test_reset_clears_everything():
    p = _panel()
    p.show_cards([_say("Answer A")])
    p.show_cards([_say("Answer B")])
    p.pin_script("Opening", "Hello")
    p.set_need(["Registration"])
    p.reset()
    assert p.current is None and p.queued is None and not p.pinned_script
    assert not p.btn_done.isVisibleTo(p) and not p.next_bar.isVisibleTo(p) and not p.need_lbl.isVisibleTo(p)


def test_overlay_mirror_follows_the_pane():
    p = _panel()
    seen = []
    p.changed.connect(lambda: seen.append([c.text for c in p.visible_cards()]))
    p.show_cards([_say("Answer A")])
    assert seen[-1] == ["Answer A"]
    p.show_cards([_say("Answer B"), Card(WATCH, "risk", [])])
    assert p.next_bar.isVisibleTo(p)
    assert "Answer A" in seen[-1] and "Answer B" not in seen[-1], "the teleprompter must not jump ahead of the reader"
    assert "risk" in seen[-1], "risk lines still reach the overlay"
    p.promote()
    assert "Answer B" in seen[-1]


# ----------------------------------------------------------------- the whole simple window
def _window(monkeypatch, font_pt=11):
    from PySide6.QtGui import QIcon

    from callpilot.core import config
    from callpilot.core.audit import AuditLog
    from callpilot.core.crypto import Vault
    from callpilot.ui.simple_window import SimpleWindow

    monkeypatch.setattr("callpilot.core.update.check", lambda *a, **k: None)
    s = config.load()
    s.first_run = False
    s.ui.font_pt = font_pt
    return SimpleWindow(s, AuditLog(Vault.open().mac_key), QIcon())


def _close(w):
    w.controller = None   # first: closeEvent with a running controller would open a modal box
    w._detect.stop()
    w.close()
    app.setStyleSheet("")


def test_said_it_marks_the_answer_not_the_risk_line(monkeypatch):
    from types import SimpleNamespace

    from callpilot.ai.cards import CardDeck

    w = _window(monkeypatch)
    try:
        deck = CardDeck(lambda: None)
        w.controller = SimpleNamespace(running=True, session=SimpleNamespace(mark_card=deck.mark, deck=deck),
                                       hub=w.current_hub())
        for action, status in (("used", "Marked as said"), ("dismissed", "Marked as not this")):
            say, watch = _say("There's no upfront cost to you"), Card(WATCH, "Never promise a delivery time", [])
            deck.show(say)
            deck.show(watch)
            w.say_panel.show_cards([c for c in deck.slots.values() if c], force=True)
            assert [c.text for c in w.overlay._last] == [c.text for c in w.say_panel.visible_cards()]
            w._card_action(None, action)
            assert say.action == action and deck.slots[SAY] is None, "the answer on screen gets the feedback"
            assert watch.action == "" and deck.slots[WATCH] is watch, "the risk line above it is left alone"
            assert w.status_lbl.text().startswith(status)
            deck.slots[WATCH] = None
    finally:
        _close(w)


# 1280 = a 1920 screen at 150 %. At 14 pt the live row 1 (with '+ New call' and the amber
# '⚠ Say the recording notice' pill) measures 1296 px, so that one case is held to a 1366 screen.
@pytest.mark.parametrize("font_pt, live_limit", [(11, 1280), (14, 1366)])
def test_header_fits_1280(monkeypatch, font_pt, live_limit):
    w = _window(monkeypatch, font_pt)
    try:
        w.show()
        app.processEvents()
        assert w.topbar.minimumSizeHint().width() <= 1280, w.topbar.minimumSizeHint().width()
        # live: '+ New call' shows, the button reads 'End call' and the pill asks for the notice
        w.btn_new.setVisible(True)
        w.btn_call.setText("■  End call")
        w._set_state(True, False)
        app.processEvents()
        assert w.topbar.minimumSizeHint().width() <= live_limit, w.topbar.minimumSizeHint().width()
    finally:
        _close(w)


def test_auto_detect_runs_one_scan_at_a_time_and_offers_the_banner(monkeypatch):
    from types import SimpleNamespace

    w = _window(monkeypatch)
    try:
        started = []
        monkeypatch.setattr("threading.Thread.start", lambda self: started.append(self.name))
        w.s.ui.auto_detect_calls = True
        w._detecting = True
        w._auto_detect()
        assert started == [], "no second scan while one is running"
        w._detecting = False
        w._auto_detect()
        assert started == ["callpilot-detect"] and w._detecting
        w._on_event("apps_detected", [SimpleNamespace(exe="WhatsApp.exe", title="WhatsApp")])
        assert not w._detecting
        assert w.call_banner.isVisibleTo(w) and "WhatsApp is on a call" in w.call_banner.label.text()
    finally:
        _close(w)


# ----------------------------------------------------------------- small screens (1366 x 768, 125-150 % scaling)
def _long(text_id: str) -> Card:
    c = _say("There's no upfront cost to you – we recover it from the at-fault insurer. " * 4)
    c.id = text_id
    c.more = "We normally aim to deliver a like-for-like car within 24 hours once your claim is set up. " * 3
    return c


def test_long_answer_scrolls_inside_the_pane_and_keeps_the_place():
    p = _panel()
    p.resize(560, 360)
    p.show()
    app.processEvents()
    short_min = p.minimumSizeHint().height()
    a = _long("a")
    p.show_cards([a, Card(WATCH, "Never promise 'free' outright", []), Card(ASK, "Reg? | Where is the car?", [])])
    p.set_need(["Registration", "Where the car is", "Third-party insurer"])
    app.processEvents()
    assert p.minimumSizeHint().height() <= short_min + 40, "a long answer must not grow the pane (and the window) taller"
    bar = p.scroll.verticalScrollBar()
    assert bar.maximum() > 0, "the long answer scrolls inside the pane"
    bar.setValue(bar.maximum() // 2)
    kept = bar.value()
    a.text += " Anything else I can help with?"           # the same answer grows (append-only): the reader keeps their place
    p.show_cards([a])
    app.processEvents()
    assert p.current is a and bar.value() == kept
    p._shown_at = time.time() - 60
    p.show_cards([_long("b")])                             # a different answer starts at its first line
    app.processEvents()
    assert p.current.id == "b" and bar.value() == 0
    p.close()


def test_action_row_shortens_when_the_pane_is_narrow():
    from callpilot.ui.theme import stylesheet

    app.setStyleSheet(stylesheet("dark", 12))
    try:
        p = _panel()
        p.show_cards([_say("Answer A")])
        p.resize(900, 420)
        p.show()
        app.processEvents()
        assert p.btn_next.text() == "⟳  Another answer" and not p._compact
        p.resize(360, 420)
        app.processEvents()
        assert p._compact and p.btn_next.text() == "⟳" and p.btn_next.accessibleName() == "Another answer"
        assert p.minimumSizeHint().width() <= 360
        p.resize(900, 420)
        app.processEvents()
        assert not p._compact and p.btn_used.text() == "✓  Said it"
        p.close()
    finally:
        app.setStyleSheet("")


def test_source_badge_never_cuts_a_word():
    p = _panel()
    c = Card(SAY, "There's no upfront cost to you.", ["memory: do I have to pay for the courtesy car"], origin="playbook")
    c.done = True
    p.show_cards([c])
    assert p.src.text() == "⚡ instant · from memory"
    assert "do I have to pay for the courtesy car" in p.src.toolTip()


def test_window_fits_125_and_150_percent(monkeypatch):
    from types import SimpleNamespace

    w = _window(monkeypatch)
    try:
        w.show()
        app.processEvents()
        assert w.minimumSizeHint().width() <= 911, f"idle at 150 %: {w.minimumSizeHint().width()}"
        w.controller = SimpleNamespace(running=True, session=None, hub=w.current_hub(), set_muted=lambda *a: None,
                                       voice_agent=None, set_ai_mode=lambda on: None)
        w._on_event("call_started", time.time())
        w._on_event("sentiment", 0.4)
        w._set_state(True, False)                    # the widest pill: notice not given yet
        app.processEvents()
        assert w.minimumSizeHint().width() <= 1093, f"live at 125 %: {w.minimumSizeHint().width()}"
        # the scripts rail tucks away below 1240 px and comes back above it, unless the handler hid it
        w.resize(1100, 700)
        app.processEvents()
        assert not w.btn_scripts.isChecked() and not w.scripts_panel.isVisibleTo(w)
        w.resize(1400, 760)
        app.processEvents()
        assert w.btn_scripts.isChecked() and w.scripts_panel.isVisibleTo(w)
        w.btn_scripts.setChecked(False)              # the handler hides it
        w.resize(1100, 700)
        app.processEvents()
        w.resize(1400, 760)
        app.processEvents()
        assert not w.btn_scripts.isChecked(), "a rail the handler hid stays hidden"
    finally:
        _close(w)

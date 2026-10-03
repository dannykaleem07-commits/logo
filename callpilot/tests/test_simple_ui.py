"""The reading lock in the simple view: an answer never changes under the reader's eyes."""

import os
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

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

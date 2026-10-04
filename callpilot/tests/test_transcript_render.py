"""The live transcript renders incrementally: only the last rows are rewritten on each tick.
Whatever the order of interim and final updates, the document must match a one-shot render."""

import os
import random

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QTextBrowser  # noqa: E402

from callpilot.core.models import AGENT, CALLER, Segment  # noqa: E402
from callpilot.ui.widgets import TranscriptView  # noqa: E402

app = QApplication.instance() or QApplication([])

WORDS = ("the other driver went into the back of me at the lights on Friday and they want "
         "£300 storage reg AB12 CDE by 14 March").split()
T0 = 1_700_000_000.0


def _plain(doc) -> str:
    return doc.toPlainText().replace(" ", "\n").replace(" ", "\n")


def _snapshot(view: QTextBrowser) -> tuple[int, str]:
    return view.document().blockCount(), _plain(view.document())


def _seg(i: int, text: str, final: bool) -> Segment:
    sp = CALLER if i % 2 == 0 else AGENT
    s = Segment(sp, text, final, "en" if sp == CALLER else "", id=f"seg{i:04d}", start=T0 + i * 6)
    if final and "£300" in text:
        s.entities = [("figure", "£300")]
    if final and "AB12" in text:
        s.entities.append(("reg", "AB12"))
    if final and sp == CALLER and i % 7 == 0:
        s.translation = "translated line"
    return s


def _stream(views, n: int, start: int = 0, render=None, rng=None):
    """A realistic STT stream: a few growing interims per line, then the final."""
    rng = rng or random.Random(7)
    render = render if render is not None else views
    for i in range(start, start + n):
        words = rng.sample(WORDS, rng.randint(3, 12))
        for k in range(1, len(words) + 1, 3):
            for v in views:
                v.upsert(_seg(i, " ".join(words[:k]), False))
            for v in render:
                v._render()
        for v in views:
            v.upsert(_seg(i, " ".join(words), True))
        for v in render:
            v._render()


def _fresh_copy(view: TranscriptView) -> TranscriptView:
    """A new view that receives every current segment and renders once."""
    ref = TranscriptView("dark")
    ref.show_translation = view.show_translation
    for s in view.segments.values():
        ref.upsert(s)
    ref._render()
    return ref


def _assert_same(view: TranscriptView) -> None:
    ref = _fresh_copy(view)
    assert _snapshot(view) == _snapshot(ref)
    # ...and the same document a single setHtml of every row would produce
    flat = QTextBrowser()
    flat.setHtml("".join(view._row_html(s) for s in view.segments.values()))
    assert _snapshot(view) == _snapshot(flat)


def test_incremental_render_matches_a_full_render():
    view = TranscriptView("dark")
    view._dirty = True
    view._render()
    _stream([view], 100)
    assert len(view.segments) == 100
    assert view._frozen and len(view._frozen) == 97, "settled rows are no longer re-rendered"
    _assert_same(view)


def test_interim_lines_are_marked_by_more_than_colour():
    view = TranscriptView("dark")
    view.upsert(_seg(0, "the other driver", False))
    view._render()
    assert _plain(view.document()).rstrip().endswith("the other driver …")
    view.upsert(_seg(0, "the other driver went into me", True))
    view._render()
    assert "…" not in _plain(view.document())


def test_pinning_an_old_line_redraws_it():
    view = TranscriptView("dark")
    _stream([view], 40)
    old = view.segments["seg0005"]
    assert old.id in view._frozen
    old.pinned = True
    view.upsert(old)
    view._render()
    assert "📌" in _plain(view.document())
    _assert_same(view)
    _stream([view], 5, start=40)   # and the incremental path carries on correctly afterwards
    _assert_same(view)


def test_empty_final_removes_the_live_line():
    view = TranscriptView("dark")
    _stream([view], 30)
    view.upsert(_seg(30, "hello there", False))
    view._render()
    assert "hello there" in _plain(view.document())
    view.upsert(Segment(CALLER, "", True, id="seg0030"))
    view._render()
    assert "seg0030" not in view.segments and "hello there" not in _plain(view.document())
    _assert_same(view)
    _stream([view], 4, start=31)
    _assert_same(view)


def test_rebuild_and_clear_all():
    view = TranscriptView("dark")
    _stream([view], 25)
    view.show_translation = False
    view.rebuild()
    view._render()
    assert "translated line" not in _plain(view.document())
    _assert_same(view)
    view.clear_all()
    view._render()
    assert "Start call" in _plain(view.document()) and not view._frozen
    _stream([view], 6, start=100)
    _assert_same(view)

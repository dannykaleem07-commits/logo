"""'Ask AI' before a call starts: the first question creates a prep session instead of failing silently."""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtGui import QIcon  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

app = QApplication.instance() or QApplication([])


class _StubProvider:
    """Every provider call yields nothing, so no network is touched."""

    def __getattr__(self, name):
        return lambda *a, **k: iter(())


def test_ask_before_call_creates_and_reuses_prep_session(monkeypatch):
    from callpilot.core import config, update
    from callpilot.core.audit import AuditLog
    from callpilot.core.crypto import Vault
    from callpilot.ui import main_window as mw
    from callpilot.ui.simple_window import SimpleWindow

    monkeypatch.setattr(update, "check", lambda *a, **k: None)
    monkeypatch.setattr(mw, "make_provider", lambda cfg: _StubProvider())
    s = config.load()
    s.first_run = False
    w = SimpleWindow(s, AuditLog(Vault.open().mac_key), QIcon())
    try:
        assert w.controller is None and w._prep_session is None
        assert w.current_hub() is not None
        w._ask("they want a 7-seater")          # must not raise
        first = w._prep_session
        assert first is not None and first.hub.id == w.current_hub().id
        assert w.status_lbl.text() == "Asking the AI…"
        w._ask("second question")
        assert w._prep_session is first, "the prep session is reused until the hub changes"
    finally:
        if w._prep_session is not None:
            w._prep_session.end(summarize=False)
            w._prep_session = None
        w.controller = None
        w._detect.stop()
        w.close()

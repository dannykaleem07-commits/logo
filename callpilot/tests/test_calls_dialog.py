"""Calls dialog: search filters from a decrypt-once cache, and Enter never fires a button."""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt  # noqa: E402
from PySide6.QtTest import QTest  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from callpilot.core.config import Settings  # noqa: E402
from callpilot.core.sessions import SessionStore  # noqa: E402
from tests.test_business_export_voice import _record  # noqa: E402

app = QApplication.instance() or QApplication([])


def _store_with_three_calls() -> SessionStore:
    store = SessionStore(Settings().privacy)
    for i, (hub, name) in enumerate((("Courtesy Cars – Accident management", "Jane Smith"),
                                     ("Fixmyfile – CIFAS removal", "Omar Khan"),
                                     ("Courtesy Cars – Hire extension", "Priya Patel"))):
        rec = _record()
        rec["call_id"] = f"call{i}"
        rec["started_at"] += i * 3600          # distinct file names
        rec["ended_at"] += i * 3600
        rec["hub_name"] = hub
        rec["fields"] = {"caller_name": name}
        assert store.save(rec) is not None
    assert len(store.list()) == 3
    return store


def test_calls_search_filters_and_decrypts_each_file_once(monkeypatch):
    from callpilot.ui.calls_dialog import CallsDialog

    store = _store_with_three_calls()
    loads: dict = {}
    real_load = store.load

    def counting_load(f):
        loads[f] = loads.get(f, 0) + 1
        return real_load(f)

    monkeypatch.setattr(store, "load", counting_load)
    d = CallsDialog(store, Settings())
    assert d.list.count() == 3
    assert d.current is not None and all(b.isEnabled() for b in (d.btn_transcript, d.btn_save, d.btn_delete))
    assert d.minimumSizeHint().width() <= 800, "the button row must fit a 125-150 % screen"
    assert not d.btn_recording.isEnabled(), "the test record has no recording"
    first = d.list.item(0).text()
    assert "\n" in first, "rows are two lines: when, then hub and caller"

    d.search.setText("cifas")
    d._load()
    assert d.list.count() == 1 and "Fixmyfile" in d.list.item(0).text() and "Omar Khan" in d.list.item(0).text()

    d.search.setText("Hire Extension")
    d._load()
    assert d.list.count() == 1 and "Priya Patel" in d.list.item(0).text()

    d.search.setText("nobody by this name")
    d._load()
    assert d.list.count() == 0 and d.current is None
    assert 'No calls match "nobody by this name".' in d.view.toPlainText()
    assert not any(b.isEnabled() for b in d.row_buttons), "row buttons grey out when nothing is selected"

    d.search.setText("")
    d._load()
    assert d.list.count() == 3
    assert set(loads) == set(store.list()) and all(n == 1 for n in loads.values()), loads
    d.close()


def test_calls_empty_state_greys_row_buttons():
    from callpilot.ui.calls_dialog import CallsDialog

    d = CallsDialog(SessionStore(Settings().privacy), Settings())
    assert d.list.count() == 0
    assert "No calls yet" in d.view.toPlainText()
    assert not any(b.isEnabled() for b in d.row_buttons)
    assert d.btn_recording.toolTip() == "This call has no recording"
    d.close()


def test_enter_in_calls_search_moves_to_results_and_opens_nothing(monkeypatch):
    import callpilot.ui.calls_dialog as calls_dialog

    opened = []
    monkeypatch.setattr(calls_dialog, "open_folder", lambda p: opened.append(p))
    # any button Enter might press (download, save, delete) would open one of these – record instead of blocking
    monkeypatch.setattr(calls_dialog.QFileDialog, "getSaveFileName", staticmethod(lambda *a, **k: (opened.append("save"), ("", ""))[1]))
    monkeypatch.setattr(calls_dialog.QFileDialog, "getExistingDirectory", staticmethod(lambda *a, **k: (opened.append("dir"), "")[1]))
    monkeypatch.setattr(calls_dialog.QMessageBox, "question",
                        staticmethod(lambda *a, **k: (opened.append("delete?"), calls_dialog.QMessageBox.No)[1]))
    d = calls_dialog.CallsDialog(_store_with_three_calls(), Settings())
    d.show()
    QApplication.processEvents()
    d.search.setFocus()
    d.search.setText("smith")
    QTest.keyClick(d.search, Qt.Key_Return)
    QApplication.processEvents()
    assert opened == [], "Enter in the search box must not press any button (folder, download, save, delete)"
    assert d.isVisible(), "Enter must not close the dialog"
    assert d.list.count() == 1 and d.list.currentRow() == 0
    assert d.focusWidget() is d.list
    d.close()

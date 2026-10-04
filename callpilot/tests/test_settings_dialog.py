"""Settings dialog: the caller-audio combo and the view combo each save to their own field."""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from callpilot.core.config import Settings  # noqa: E402

app = QApplication.instance() or QApplication([])


@pytest.fixture(autouse=True)
def no_devices(monkeypatch):
    import callpilot.audio.capture as capture

    monkeypatch.setattr(capture, "list_input_devices", lambda *a, **k: [])
    monkeypatch.setattr(capture, "list_output_devices", lambda *a, **k: [])


def _dialog(s):
    from callpilot.ui.settings_dialog import SettingsDialog

    return SettingsDialog(s)


def test_save_keeps_capture_mode_and_view_mode_apart():
    s = Settings()
    s.audio.capture_mode = "system"
    s.ui.mode = "advanced"
    d = _dialog(s)
    d._save()
    assert s.audio.capture_mode == "system"
    assert s.ui.mode == "advanced"
    assert d.view_mode.currentData() == "advanced"
    assert d.mode.currentData() == "system"


def test_save_defaults_round_trip():
    s = Settings()
    assert s.audio.capture_mode == "apps" and s.ui.mode == "simple"
    d = _dialog(s)
    d._save()
    assert s.audio.capture_mode == "apps"
    assert s.ui.mode == "simple"
    assert d.view_mode.currentData() == "simple"
    assert d.mode.currentData() == "apps"


def test_view_combo_change_does_not_touch_capture_mode():
    s = Settings()
    d = _dialog(s)
    d.view_mode.setCurrentIndex(d.view_mode.findData("advanced"))
    d._save()
    assert s.ui.mode == "advanced"
    assert s.audio.capture_mode == "apps"


def test_ai_mode_tab_index_is_stable():
    d = _dialog(Settings())
    assert d.tabs.tabText(6) == "AI mode"


def test_section_list_drives_the_tabs():
    d = _dialog(Settings())
    assert d.nav.count() == d.tabs.count() and not d.tabs.tabBar().isVisibleTo(d)
    assert d.nav.item(5).text() == "Recording & email"
    d.nav.setCurrentRow(6)
    assert d.tabs.currentIndex() == 6
    d.tabs.setCurrentIndex(2)
    assert d.nav.currentRow() == 2
    assert d.minimumSizeHint().width() <= 800, "no tab strip that runs off a 125-150 % screen"

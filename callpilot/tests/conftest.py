import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("CALLPILOT_HOME", str(tmp_path / "home"))
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPGRAM_API_KEY", "DEEPL_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    from callpilot.core.crypto import Vault

    Vault._session_vault = None
    yield
    Vault._session_vault = None


os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def pytest_configure(config):
    """The tests measure layouts, so they run under the same widget style as the app (Fusion), on every OS."""
    from PySide6.QtWidgets import QApplication

    from callpilot.ui.theme import use_app_style

    use_app_style(QApplication.instance() or QApplication([]))


def _qt_facts() -> str:
    """Font and screen facts at the top of the test run, so a layout difference between machines can be explained."""
    try:
        from PySide6.QtGui import QFont, QFontInfo, QFontMetrics
        from PySide6.QtWidgets import QApplication

        from callpilot.ui.theme import stylesheet

        app = QApplication.instance() or QApplication([])
        scr = app.primaryScreen()
        app.setStyleSheet(stylesheet("dark", 11))
        f = QFont(["Segoe UI Variable", "Segoe UI", "Inter", "sans-serif"])
        f.setPointSize(11)
        info = QFontInfo(f)
        line = (f"qt: style={app.style().metaObject().className()} platform={app.platformName()} "
                f"screen={scr.size().width()}x{scr.size().height()} logicalDpi={scr.logicalDotsPerInch():.0f} "
                f"physicalDpi={scr.physicalDotsPerInch():.0f} dpr={scr.devicePixelRatio():.2f} "
                f"font={info.family()!r} {info.pointSizeF():.1f}pt {info.pixelSize()}px "
                f"text('Courtesy Cars UK')={QFontMetrics(f).horizontalAdvance('Courtesy Cars UK')}px")
        app.setStyleSheet("")
        return line
    except Exception as e:  # noqa: BLE001
        return f"qt: diagnostics unavailable ({e})"


def pytest_sessionstart(session):
    tr = session.config.pluginmanager.get_plugin("terminalreporter")
    if tr is not None:
        tr.write_line(_qt_facts())

"""Application entry point."""

from __future__ import annotations

import logging
import logging.handlers
import sys

from callpilot import __app_name__, __version__
from callpilot.core import config, paths
from callpilot.core.redact import redact_all


class _RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = redact_all(str(record.getMessage()))
            record.args = ()
        except Exception:  # noqa: BLE001
            pass
        return True


def _setup_logging() -> None:
    handler = logging.handlers.RotatingFileHandler(paths.logs_dir() / "callpilot.log", maxBytes=2_000_000,
                                                   backupCount=3, encoding="utf-8")
    handler.addFilter(_RedactingFilter())
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    for noisy in ("httpx", "httpcore", "websockets", "anthropic", "openai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _unlock_vault(app):
    from PySide6.QtWidgets import QInputDialog, QLineEdit, QMessageBox

    from callpilot.core.crypto import BadPassphrase, Vault, VaultLocked

    if not Vault.has_passphrase():
        return Vault.open()
    for attempt in range(5):
        pw, ok = QInputDialog.getText(None, f"{__app_name__} – locked", "Master passphrase:", QLineEdit.Password)
        if not ok:
            sys.exit(0)
        try:
            return Vault.open(pw)
        except (BadPassphrase, VaultLocked):
            QMessageBox.warning(None, __app_name__, f"Wrong passphrase ({4 - attempt} attempts left).")
    sys.exit(1)


def main() -> int:
    _setup_logging()
    log = logging.getLogger("callpilot")
    log.info("%s %s starting", __app_name__, __version__)

    from PySide6.QtCore import Qt, QTimer
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication

    from callpilot.core.audit import AuditLog
    from callpilot.ui import winutil
    from callpilot.ui.main_window import MainWindow, first_run_message
    from callpilot.ui.simple_window import SimpleWindow

    winutil.set_app_user_model_id()
    QApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
    app = QApplication(sys.argv)
    from callpilot.ui.theme import use_app_style

    use_app_style(app)
    app.setApplicationName(__app_name__)
    app.setApplicationVersion(__version__)
    app.setQuitOnLastWindowClosed(False)
    icon_file = paths.resource_path("assets/icon.png")
    icon = QIcon(str(icon_file)) if icon_file.exists() else None
    if icon:
        app.setWindowIcon(icon)

    settings = config.load()
    vault = _unlock_vault(app)
    audit = AuditLog(vault.mac_key)
    audit.record("app_started", version=__version__)

    win = (MainWindow if settings.ui.mode == "advanced" else SimpleWindow)(settings, audit, icon)
    win.show()
    QTimer.singleShot(400, lambda: first_run_message(win))
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())

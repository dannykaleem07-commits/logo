"""System-wide hotkeys (work while WhatsApp/Teams has focus)."""

from __future__ import annotations

import logging

from PySide6.QtCore import QObject, Signal

log = logging.getLogger(__name__)


class GlobalHotkeys(QObject):
    triggered = Signal(str)

    def __init__(self, mapping: dict[str, str]):
        """mapping: action name -> pynput hotkey string, e.g. '<ctrl>+<shift>+o'."""
        super().__init__()
        self.mapping = {k: v for k, v in mapping.items() if v}
        self._listener = None

    def start(self) -> bool:
        try:
            from pynput import keyboard
        except Exception as e:  # noqa: BLE001
            log.warning("global hotkeys unavailable: %s", e)
            return False
        try:
            handlers = {combo: (lambda a=action: self.triggered.emit(a)) for action, combo in self.mapping.items()}
            self._listener = keyboard.GlobalHotKeys(handlers)
            self._listener.daemon = True
            self._listener.start()
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("could not register hotkeys: %s", e)
            return False

    def stop(self) -> None:
        if self._listener:
            self._listener.stop()
            self._listener = None

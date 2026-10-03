"""Windows-specific window helpers."""

from __future__ import annotations

import ctypes
import sys

WDA_NONE = 0x0
WDA_EXCLUDEFROMCAPTURE = 0x11  # Windows 10 2004+


def exclude_from_capture(widget, enabled: bool = True) -> bool:
    """Hide a window from screen sharing, screenshots and recordings (it stays
    visible on your own monitor). Returns True if applied."""
    if sys.platform != "win32":
        return False
    try:
        hwnd = int(widget.winId())
        user32 = ctypes.WinDLL("user32")
        user32.SetWindowDisplayAffinity.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        return bool(user32.SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE if enabled else WDA_NONE))
    except Exception:  # noqa: BLE001
        return False


def set_app_user_model_id(app_id: str = "CallPilot.Desktop") -> None:
    if sys.platform == "win32":
        try:
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(app_id)
        except Exception:  # noqa: BLE001
            pass

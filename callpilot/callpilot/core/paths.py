"""Filesystem locations. Everything lives under the per-user app-data folder."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from callpilot import __app_name__


def app_data_dir() -> Path:
    override = os.environ.get("CALLPILOT_HOME")
    if override:
        base = Path(override)
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / __app_name__
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / __app_name__
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / __app_name__.lower()
    base.mkdir(parents=True, exist_ok=True)
    return base


def sub_dir(name: str) -> Path:
    p = app_data_dir() / name
    p.mkdir(parents=True, exist_ok=True)
    return p


def config_file() -> Path:
    return app_data_dir() / "settings.json"


def hubs_dir() -> Path:
    return sub_dir("hubs")


def sessions_dir() -> Path:
    return sub_dir("sessions")


def logs_dir() -> Path:
    return sub_dir("logs")


def resource_path(relative: str) -> Path:
    """Locate bundled resources both from source and inside a PyInstaller EXE."""
    base = getattr(sys, "_MEIPASS", None)
    if base:
        return Path(base) / relative
    return Path(__file__).resolve().parents[2] / relative

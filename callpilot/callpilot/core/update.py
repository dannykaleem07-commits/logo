"""Update check against the rolling GitHub release (no auto-install; one click to download)."""

from __future__ import annotations

import json
import logging
import re
import threading
import urllib.request

log = logging.getLogger(__name__)

REPO = "dannykaleem07-commits/logo"
RELEASE_API = f"https://api.github.com/repos/{REPO}/releases/tags/callpilot-latest"
DOWNLOAD_URL = f"https://github.com/{REPO}/releases/download/callpilot-latest/CallPilot-Setup.exe"


def build_sha() -> str:
    try:
        from callpilot import _build  # written by CI

        return getattr(_build, "COMMIT", "")
    except Exception:  # noqa: BLE001
        return ""


def check(callback) -> None:
    """callback(newer: bool, latest_sha: str) on a worker thread; never raises."""

    def run():
        try:
            req = urllib.request.Request(RELEASE_API, headers={"User-Agent": "CallPilot"})
            with urllib.request.urlopen(req, timeout=8) as r:
                data = json.loads(r.read().decode("utf-8"))
            m = re.search(r"commit ([0-9a-f]{7,40})", data.get("body", ""))
            latest = m.group(1) if m else ""
            mine = build_sha()
            newer = bool(latest and mine and not latest.startswith(mine[:7]) and not mine.startswith(latest[:7]))
            callback(newer, latest)
        except Exception as e:  # noqa: BLE001
            log.debug("update check skipped: %s", e)

    threading.Thread(target=run, daemon=True, name="callpilot-update").start()

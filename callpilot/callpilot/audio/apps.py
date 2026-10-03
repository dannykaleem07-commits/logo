"""Discover which applications can be captured (WhatsApp, Teams, Zoom, browsers…)."""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass

log = logging.getLogger(__name__)

KNOWN_CALL_APPS = {
    "whatsapp.exe": "WhatsApp", "whatsapp.root.exe": "WhatsApp",
    "ms-teams.exe": "Microsoft Teams", "teams.exe": "Microsoft Teams (classic)",
    "zoom.exe": "Zoom", "skype.exe": "Skype", "slack.exe": "Slack", "discord.exe": "Discord",
    "telegram.exe": "Telegram", "signal.exe": "Signal", "viber.exe": "Viber",
    "chrome.exe": "Google Chrome", "msedge.exe": "Microsoft Edge", "firefox.exe": "Firefox",
    "brave.exe": "Brave", "opera.exe": "Opera", "3cxwin8phone.exe": "3CX", "3cxsoftphone.exe": "3CX",
    "ringcentral.exe": "RingCentral", "aircall.exe": "Aircall", "dialpad.exe": "Dialpad",
    "microsip.exe": "MicroSIP", "zoiper5.exe": "Zoiper", "zoiper.exe": "Zoiper",
    "phone.exe": "Phone Link", "phoneexperiencehost.exe": "Phone Link", "webex.exe": "Webex",
    "ciscocollabhost.exe": "Webex", "gotomeeting.exe": "GoTo", "goto.exe": "GoTo",
}


@dataclass
class AppInfo:
    exe: str
    title: str
    pids: list[int]
    has_audio_session: bool = False

    @property
    def label(self) -> str:
        tag = "  🔊" if self.has_audio_session else ""
        return f"{self.title} ({self.exe}){tag}"


def _audio_session_exes() -> set[str]:
    if sys.platform != "win32":
        return set()
    try:
        from pycaw.pycaw import AudioUtilities

        return {s.Process.name().lower() for s in AudioUtilities.GetAllSessions() if s.Process}
    except Exception as e:  # noqa: BLE001
        log.debug("pycaw unavailable: %s", e)
        return set()


def list_apps(include_all: bool = False) -> list[AppInfo]:
    """Return candidate apps, call apps and apps currently holding an audio session first."""
    import psutil

    audio = _audio_session_exes()
    by_exe: dict[str, AppInfo] = {}
    for p in psutil.process_iter(["pid", "name"]):
        name = (p.info.get("name") or "").strip()
        if not name:
            continue
        low = name.lower()
        if not include_all and low not in KNOWN_CALL_APPS and low not in audio:
            continue
        info = by_exe.setdefault(low, AppInfo(name, KNOWN_CALL_APPS.get(low, name.rsplit(".", 1)[0]), []))
        info.pids.append(p.info["pid"])
        info.has_audio_session = low in audio
    return sorted(by_exe.values(), key=lambda a: (not a.has_audio_session, a.exe.lower() not in KNOWN_CALL_APPS,
                                                  a.title.lower()))


def root_pids(exe_name: str) -> list[int]:
    """PIDs of the top-most processes with this exe name (children are included by the
    process-tree loopback, so capturing roots avoids double audio)."""
    import psutil

    exe_low = exe_name.lower()
    pids = []
    for p in psutil.process_iter(["pid", "name", "ppid"]):
        if (p.info.get("name") or "").lower() != exe_low:
            continue
        try:
            parent = psutil.Process(p.info["ppid"]).name().lower() if p.info.get("ppid") else ""
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            parent = ""
        if parent != exe_low:
            pids.append(p.info["pid"])
    return pids

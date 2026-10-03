"""Tamper-evident audit log.

Each line carries an HMAC-SHA256 over (previous MAC || entry). Editing, deleting
or re-ordering any line breaks the chain from that point on, which `verify()`
detects. The HMAC key is the vault data key, so the log cannot be re-forged
without access to the user's vault.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
from pathlib import Path

from callpilot.core import paths

GENESIS = "0" * 64


class AuditLog:
    def __init__(self, key: bytes, path: Path | None = None):
        self._key = hashlib.sha256(b"audit|" + key).digest()
        self.path = path or (paths.logs_dir() / "audit.log")
        self._lock = threading.Lock()
        self._last = self._read_last_mac()

    def _read_last_mac(self) -> str:
        if not self.path.exists():
            return GENESIS
        last = GENESIS
        with self.path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        last = json.loads(line)["mac"]
                    except (ValueError, KeyError):
                        pass
        return last

    def _mac(self, prev: str, body: str) -> str:
        return hmac.new(self._key, (prev + body).encode("utf-8"), hashlib.sha256).hexdigest()

    def record(self, event: str, **details) -> None:
        with self._lock:
            body = json.dumps({"ts": round(time.time(), 3), "event": event, "details": details},
                              sort_keys=True, ensure_ascii=False)
            mac = self._mac(self._last, body)
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({"body": body, "mac": mac}) + "\n")
            self._last = mac

    def verify(self) -> tuple[bool, int]:
        """Return (ok, first_bad_line_number or total_lines)."""
        prev = GENESIS
        n = 0
        if not self.path.exists():
            return True, 0
        with self.path.open("r", encoding="utf-8") as fh:
            for n, line in enumerate(fh, start=1):
                try:
                    rec = json.loads(line)
                    if not hmac.compare_digest(self._mac(prev, rec["body"]), rec["mac"]):
                        return False, n
                    prev = rec["mac"]
                except (ValueError, KeyError):
                    return False, n
        return True, n

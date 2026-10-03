"""API-key storage.

On Windows keys go into Windows Credential Manager (protected by DPAPI and bound
to the logged-in user). If no OS keyring is available we fall back to an
AES-256-GCM encrypted file whose key is derived from a machine/user secret.
Keys are never written to settings.json or logs.
"""

from __future__ import annotations

import json
import logging
import os

from callpilot.core import paths

log = logging.getLogger(__name__)

SERVICE = "CallPilot"
KNOWN_KEYS = ("anthropic_api_key", "openai_api_key", "deepgram_api_key", "deepl_api_key")

try:  # pragma: no cover - depends on platform backend
    import keyring
    import keyring.backends.fail
    from keyring.errors import KeyringError, NoKeyringError

    _backend_ok = not isinstance(keyring.get_keyring(), keyring.backends.fail.Keyring)
except Exception:  # noqa: BLE001
    keyring = None
    _backend_ok = False
    KeyringError = NoKeyringError = Exception  # type: ignore[misc,assignment]


def _fallback_file():
    return paths.app_data_dir() / "secrets.vault"


def _fallback_load() -> dict[str, str]:
    from callpilot.core.crypto import Vault

    f = _fallback_file()
    if not f.exists():
        return {}
    try:
        return json.loads(Vault.for_secrets().decrypt(f.read_bytes()).decode("utf-8"))
    except Exception:  # noqa: BLE001
        log.warning("secret vault unreadable; ignoring")
        return {}


def _fallback_save(data: dict[str, str]) -> None:
    from callpilot.core.crypto import Vault

    f = _fallback_file()
    f.write_bytes(Vault.for_secrets().encrypt(json.dumps(data).encode("utf-8")))


def get(name: str) -> str:
    env = os.environ.get(name.upper())
    if env:
        return env
    if _backend_ok:
        try:
            return keyring.get_password(SERVICE, name) or ""
        except (KeyringError, NoKeyringError):
            pass
    return _fallback_load().get(name, "")


def set(name: str, value: str) -> None:  # noqa: A001 - mirrors keyring API
    value = value.strip()
    if _backend_ok:
        try:
            if value:
                keyring.set_password(SERVICE, name, value)
            else:
                try:
                    keyring.delete_password(SERVICE, name)
                except Exception:  # noqa: BLE001
                    pass
            return
        except (KeyringError, NoKeyringError):
            pass
    data = _fallback_load()
    if value:
        data[name] = value
    else:
        data.pop(name, None)
    _fallback_save(data)


def mask(value: str) -> str:
    if not value:
        return ""
    return value[:4] + "•" * 8 + value[-4:] if len(value) > 10 else "•" * len(value)

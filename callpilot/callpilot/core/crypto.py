"""Encryption at rest.

* AES-256-GCM (authenticated encryption, NIST SP 800-38D) for every session file.
* A random 256-bit data key is generated once per user.
* The data key is protected by Windows DPAPI (bound to the Windows user account),
  and - when the user sets a master passphrase - additionally wrapped with a
  key derived via scrypt (N=2^15, r=8, p=1).
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import sys
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from callpilot.core import paths

MAGIC = b"CPV1"
AAD = b"CallPilot/v1"
NONCE_LEN = 12


class VaultLocked(Exception):
    """Raised when the vault needs a passphrase before it can be used."""


class BadPassphrase(Exception):
    pass


# ---------------------------------------------------------------- DPAPI (Windows)
class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(data: bytes, protect: bool) -> bytes:
    crypt32 = ctypes.windll.crypt32  # type: ignore[attr-defined]
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _DataBlob()
    entropy_raw = AAD
    ebuf = ctypes.create_string_buffer(entropy_raw, len(entropy_raw))
    entropy = _DataBlob(len(entropy_raw), ctypes.cast(ebuf, ctypes.POINTER(ctypes.c_char)))
    CRYPTPROTECT_UI_FORBIDDEN = 0x1
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(blob_in), None, ctypes.byref(entropy), None, None,
            CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out))
    if not ok:
        raise OSError("DPAPI call failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def _protect_local(raw: bytes) -> bytes:
    if sys.platform == "win32":
        return b"DPAPI" + _dpapi(raw, True)
    return b"PLAIN" + raw


def _unprotect_local(blob: bytes) -> bytes:
    tag, body = blob[:5], blob[5:]
    if tag == b"DPAPI":
        return _dpapi(body, False)
    if tag == b"PLAIN":
        return body
    raise ValueError("unknown key protection")


def _write_private(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    tmp.replace(path)


# ---------------------------------------------------------------- KDF
def derive_kek(passphrase: str, salt: bytes) -> bytes:
    return Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(passphrase.encode("utf-8"))


# ---------------------------------------------------------------- Vault
class Vault:
    """Authenticated symmetric encryption with a single data key."""

    _session_vault: "Vault | None" = None

    def __init__(self, key: bytes):
        if len(key) != 32:
            raise ValueError("AES-256 requires a 32-byte key")
        self._aes = AESGCM(key)
        self.mac_key = hashlib.sha256(b"callpilot-mac|" + key).digest()

    # -- primitives
    def encrypt(self, plaintext: bytes) -> bytes:
        nonce = os.urandom(NONCE_LEN)
        return MAGIC + nonce + self._aes.encrypt(nonce, plaintext, AAD)

    def decrypt(self, blob: bytes) -> bytes:
        if not blob.startswith(MAGIC):
            raise ValueError("not a CallPilot vault blob")
        nonce = blob[len(MAGIC):len(MAGIC) + NONCE_LEN]
        try:
            return self._aes.decrypt(nonce, blob[len(MAGIC) + NONCE_LEN:], AAD)
        except InvalidTag as e:
            raise ValueError("ciphertext failed authentication (tampered or wrong key)") from e

    def encrypt_json(self, obj) -> bytes:
        return self.encrypt(json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def decrypt_json(self, blob: bytes):
        return json.loads(self.decrypt(blob).decode("utf-8"))

    # -- key management
    @staticmethod
    def _key_file() -> Path:
        return paths.app_data_dir() / "vault.key"

    @classmethod
    def has_passphrase(cls) -> bool:
        f = cls._key_file()
        if not f.exists():
            return False
        try:
            return json.loads(f.read_text())["mode"] == "passphrase"
        except (OSError, ValueError, KeyError):
            return False

    @classmethod
    def open(cls, passphrase: str | None = None) -> "Vault":
        """Open (or create) the user's data vault."""
        f = cls._key_file()
        if not f.exists():
            key = AESGCM.generate_key(bit_length=256)
            cls._store_key(key, passphrase)
            v = cls(key)
        else:
            meta = json.loads(f.read_text())
            inner = _unprotect_local(base64.b64decode(meta["blob"]))
            if meta["mode"] == "passphrase":
                if not passphrase:
                    raise VaultLocked()
                salt, nonce, ct = inner[:16], inner[16:28], inner[28:]
                try:
                    key = AESGCM(derive_kek(passphrase, salt)).decrypt(nonce, ct, AAD)
                except InvalidTag as e:
                    raise BadPassphrase() from e
            else:
                key = inner
            v = cls(key)
        cls._session_vault = v
        return v

    @classmethod
    def _store_key(cls, key: bytes, passphrase: str | None) -> None:
        if passphrase:
            salt, nonce = os.urandom(16), os.urandom(NONCE_LEN)
            inner = salt + nonce + AESGCM(derive_kek(passphrase, salt)).encrypt(nonce, key, AAD)
            mode = "passphrase"
        else:
            inner, mode = key, "device"
        meta = {"v": 1, "mode": mode, "blob": base64.b64encode(_protect_local(inner)).decode()}
        _write_private(cls._key_file(), json.dumps(meta).encode())

    @classmethod
    def change_passphrase(cls, current: str | None, new: str | None) -> None:
        """Re-wrap the data key. Existing encrypted sessions stay readable."""
        f = cls._key_file()
        meta = json.loads(f.read_text())
        inner = _unprotect_local(base64.b64decode(meta["blob"]))
        if meta["mode"] == "passphrase":
            if not current:
                raise VaultLocked()
            salt, nonce, ct = inner[:16], inner[16:28], inner[28:]
            try:
                key = AESGCM(derive_kek(current, salt)).decrypt(nonce, ct, AAD)
            except InvalidTag as e:
                raise BadPassphrase() from e
        else:
            key = inner
        cls._store_key(key, new or None)

    @classmethod
    def current(cls) -> "Vault":
        if cls._session_vault is None:
            return cls.open()
        return cls._session_vault

    @classmethod
    def for_secrets(cls) -> "Vault":
        """Device-bound key for the API-key fallback store (independent of passphrase)."""
        f = paths.app_data_dir() / "secrets.key"
        if f.exists():
            key = _unprotect_local(f.read_bytes())
        else:
            key = AESGCM.generate_key(bit_length=256)
            _write_private(f, _protect_local(key))
        return cls(key)

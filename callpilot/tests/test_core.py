import json

import numpy as np
import pytest

from callpilot.audio import dsp
from callpilot.core import config
from callpilot.core.audit import AuditLog
from callpilot.core.crypto import BadPassphrase, Vault, VaultLocked
from callpilot.core.redact import redact_all, redact_payment
from callpilot.core.sessions import SessionStore, export_srt, export_text
from callpilot.kb.retriever import BM25, chunk_text


def test_settings_roundtrip_and_unknown_keys(tmp_path):
    s = config.Settings()
    s.ai.provider = "openai"
    s.audio.target_apps = ["Zoom.exe"]
    f = tmp_path / "s.json"
    config.save(s, f)
    data = json.loads(f.read_text())
    data["ai"]["removed_in_future"] = 1
    data["brand_new_section"] = {}
    f.write_text(json.dumps(data))
    s2 = config.load(f)
    assert s2.ai.provider == "openai"
    assert s2.audio.target_apps == ["Zoom.exe"]


def test_corrupt_settings_do_not_crash(tmp_path):
    f = tmp_path / "s.json"
    f.write_text("{not json")
    assert config.load(f).ai.provider == "anthropic"


def test_vault_encrypt_decrypt_and_tamper():
    v = Vault.open()
    blob = v.encrypt_json({"a": "secret"})
    assert b"secret" not in blob
    assert v.decrypt_json(blob) == {"a": "secret"}
    tampered = blob[:-1] + bytes([blob[-1] ^ 1])
    with pytest.raises(ValueError):
        v.decrypt(tampered)


def test_vault_passphrase_flow():
    v = Vault.open()
    blob = v.encrypt(b"x")
    Vault.change_passphrase(None, "correct horse")
    Vault._session_vault = None
    assert Vault.has_passphrase()
    with pytest.raises(VaultLocked):
        Vault.open()
    with pytest.raises(BadPassphrase):
        Vault.open("wrong")
    assert Vault.open("correct horse").decrypt(blob) == b"x"


def test_audit_chain_detects_tampering(tmp_path):
    log = AuditLog(b"k" * 32, tmp_path / "audit.log")
    for i in range(5):
        log.record("evt", n=i)
    assert log.verify() == (True, 5)
    lines = (tmp_path / "audit.log").read_text().splitlines()
    rec = json.loads(lines[2])
    rec["body"] = rec["body"].replace('"n": 2', '"n": 9')
    lines[2] = json.dumps(rec)
    (tmp_path / "audit.log").write_text("\n".join(lines) + "\n")
    ok, bad = log.verify()
    assert not ok and bad == 3


def test_redaction():
    t = "Card 4111 1111 1111 1111, cvv 123, email a@b.com, call 07700 900123, NI AB123456C, SW1A 1AA"
    p = redact_payment(t)
    assert "4111 1111" not in p and "[CARD ****1111]" in p and "[CVV]" in p and "a@b.com" in p
    a = redact_all(t)
    for s in ("a@b.com", "07700 900123", "AB123456C", "SW1A 1AA"):
        assert s not in a
    # registrations / non-Luhn numbers survive payment redaction
    assert "1234 5678 9012 3456" in redact_payment("ref 1234 5678 9012 3456")


def test_bm25_and_chunking():
    docs = ["The courtesy car is delivered within 24 hours.", "Repairs happen at approved garages.",
            "Report to police within 24 hours if no details exchanged."]
    hits = BM25(docs).search("when will my replacement car arrive")
    assert hits and hits[0].ref == 0
    text = "\n\n".join(" ".join(f"w{i}_{j}" for j in range(80)) for i in range(5))
    chunks = chunk_text(text, max_words=120, overlap=20)
    assert len(chunks) >= 3
    assert all(len(c.split()) <= 140 for c in chunks)


def test_sessions_encrypted_and_redacted():
    from callpilot.core.config import PrivacySettings

    store = SessionStore(PrivacySettings())
    rec = {"hub_id": "h", "hub_name": "H", "started_at": 1_700_000_000.0,
           "segments": [{"id": "1", "speaker": "caller", "text": "my email is x@y.com", "translation": "",
                         "language": "en", "start": 1_700_000_001.0, "confidence": 1}],
           "fields": {"caller_email": "x@y.com"}, "summary": {"summary": "ok", "next_actions": ["call back"]}}
    f = store.save(rec)
    assert f.suffix == ".cpv" and b"x@y.com" not in f.read_bytes()
    loaded = store.load(f)
    assert "[EMAIL]" in loaded["segments"][0]["text"]
    assert "Caller:" in export_text(loaded) and "-->" in export_srt(loaded)


def test_dsp_resample_and_vad():
    sr = 48000
    t = np.arange(sr) / sr
    x = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    y = dsp.resample(x, sr)
    assert abs(y.size - 16000) <= 1
    y2 = dsp.resample(x, 44100)
    assert abs(y2.size - int(round(48000 / (44100 / 16000)))) <= 2
    vad = dsp.EnergyVAD(gate_db=-45)
    silent = np.zeros(dsp.FRAME_SAMPLES, dtype=np.float32)
    loud = (0.2 * np.sin(np.arange(dsp.FRAME_SAMPLES))).astype(np.float32)
    assert not vad.update(silent)
    assert vad.update(loud)
    assert dsp.pcm16_to_float(dsp.float_to_pcm16(loud)).shape == loud.shape

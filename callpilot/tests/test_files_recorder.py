import datetime as dt
import wave

import numpy as np

from callpilot.ai.wrapup import EmailDraft, qa_checklist
from callpilot.audio import dsp
from callpilot.audio.recorder import CallRecorder
from callpilot.core.files import CaseFile, ChronologyEntry, Contact, Deadline, FileStore


def test_file_store_roundtrip_search_and_phone_match(tmp_path):
    store = FileStore(tmp_path / "files.cpv")
    f = CaseFile(business="Courtesy Cars", client_name="Maria Garcia", reg="AB12 CDE", reference="CC-1001",
                 hire_start="2026-09-20", signed_authority_at="")
    f.contacts.append(Contact("Maria Garcia", "client", phone_numbers=["+44 7700 900123"]))
    f.contacts.append(Contact("Tom Avery", "handler", "Aviva", ["0345 030 1234"]))
    f.deadlines.append(Deadline("reply", "2026-10-10", "Aviva to confirm liability"))
    f.chronology.append(ChronologyEntry("2026-09-18", "Accident – rear-ended at lights"))
    store.save(f)
    assert b"Garcia" not in (tmp_path / "files.cpv").read_bytes()      # encrypted at rest
    store2 = FileStore(tmp_path / "files.cpv")
    g = store2.get(f.id)
    assert g.title == "Maria Garcia · AB12 CDE · CC-1001"
    assert g.hire_days(dt.date(2026, 10, 3)) == 14
    assert g.next_deadline().days_left(dt.date(2026, 10, 3)) == 7
    assert store2.search("ab12cde")[0].id == f.id and store2.search("aviva")[0].id == f.id
    assert store2.match_phone("07700900123")[1].name == "Maria Garcia"
    assert store2.match_phone("0345 030 1234")[1].role == "handler"
    summ = g.summary_for_prompt()
    assert "Hire running" in summ and "NO signed authority" in summ and "Next deadline" in summ


def test_recorder_stereo_pause_and_clip(tmp_path, monkeypatch):
    monkeypatch.setenv("CALLPILOT_HOME", str(tmp_path))
    rec = CallRecorder("test-call")
    tone = dsp.float_to_pcm16((0.5 * np.sin(np.arange(dsp.FRAME_SAMPLES) * 0.2)).astype(np.float32))
    silence = dsp.float_to_pcm16(np.zeros(dsp.FRAME_SAMPLES, dtype=np.float32))
    for _ in range(10):
        rec.feed("caller", tone)
        rec.feed("agent", silence)
    rec.pause()
    for _ in range(5):
        rec.feed("caller", tone)
        rec.feed("agent", tone)
    rec.resume()
    for _ in range(5):
        rec.feed("caller", silence)
        rec.feed("agent", tone)
    clip = rec.clip("pin1")
    path = rec.close()
    with wave.open(str(path)) as w:
        assert w.getnchannels() == 2 and w.getframerate() == dsp.TARGET_RATE
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").reshape(-1, 2)
    n = dsp.FRAME_SAMPLES
    assert data.shape[0] == 20 * n
    assert np.abs(data[:10 * n, 0]).max() > 1000 and np.abs(data[:10 * n, 1]).max() == 0   # caller left only
    assert np.abs(data[10 * n:15 * n]).max() == 0                                           # paused = silence
    assert np.abs(data[15 * n:, 1]).max() > 1000 and np.abs(data[15 * n:, 0]).max() == 0    # agent right only
    assert len(rec.pauses) == 1 and rec.pauses[0][1] is not None
    with wave.open(str(clip)) as w:
        assert w.getnframes() == 20 * n  # whole (short) call fits in the 10 s ring


def test_email_draft_and_qa(tmp_path):
    d = EmailDraft("handler@insurer.example", "As discussed – CC-1001",
                   "As discussed today at 14:32, you confirmed the inspection is booked for Tuesday 7 October.",
                   status_line="Fixmyfile provides paralegal and dispute services. Not a firm of solicitors.",
                   signature="Danny")
    raw = d.to_eml()
    assert b"X-Unsent: 1" in raw and b"Not a firm of solicitors" in raw and b"Subject: As discussed" in raw
    p = d.save_eml(tmp_path)
    assert p.exists() and p.suffix == ".eml"
    assert not hasattr(d, "send")
    qa = qa_checklist({"email": {"body": "x"}, "compliance_gaps": []},
                      {"Call is recorded": True, "Hire terms read": False}, {"a": "1", "b": ""}, required_keys=["a", "b"])
    assert qa["items"]["Recording notice given"] is True
    assert qa["items"]["Intake complete (1/2)"] is False
    assert 0 < qa["score"] < 100

"""Round 4: business profiles, CIFAS hub, append-only answers, call export, AI voice mode."""

import json
import threading
import time

from callpilot.ai import voice_agent
from callpilot.ai.copilot import CallSession, _grow
from callpilot.ai.voice_agent import HUMAN_Q, WANT_HUMAN, VoiceAgent
from callpilot.core.business import Business, BusinessStore, Script
from callpilot.core.config import Settings
from callpilot.core.export import call_folder_name, export_call
from callpilot.core.models import CALLER, SAY
from callpilot.hubs.model import HubStore

from tests.test_copilot import FakeProvider


def _wait(pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


# ----------------------------------------------------------------- business profiles
def test_builtin_businesses_and_hub_hierarchy(tmp_path):
    bs = BusinessStore(root=tmp_path)
    ids = {b.id for b in bs.list()}
    assert {"courtesy-cars", "fixmyfile"} <= ids
    hubs = HubStore().list()
    by_business = {}
    for h in hubs:
        by_business.setdefault(h.business_id, []).append(h.id)
    assert "fixmyfile-cifas-removal" in by_business["fixmyfile"]
    assert "courtesy-cars-accident-management" in by_business["courtesy-cars"]
    for h in hubs:
        assert h.business_id in ids, f"hub {h.id} points at an unknown business"


def test_business_rules_flow_into_every_hub_prompt(tmp_path):
    bs = BusinessStore(root=tmp_path)
    b = bs.new("Acme Repairs")
    assert b.id == "acme-repairs"
    b.rules = ["Always confirm the registration before quoting."]
    b.banned_phrases = ["guaranteed"]
    b.status_line = "Acme Repairs Ltd – an independent garage."
    b.scripts = [Script("Opening", "Hello, Acme Repairs, {agent} speaking.", "opening")]
    bs.save(b)
    again = bs.get("acme-repairs")
    assert again is not None and again.rules == b.rules and again.scripts[0].when == "opening"
    hub = HubStore().get("courtesy-cars-accident-management")
    prompt = hub.system_prompt(business=again)
    assert "## Business: Acme Repairs" in prompt
    assert prompt.index("## Business: Acme Repairs") < prompt.index("## Rules"), "business rules come first"
    assert "Always confirm the registration" in prompt
    assert "Never say: guaranteed" in prompt
    assert "Acme Repairs Ltd" in prompt
    titles = [s["title"] for s in hub.all_scripts(again)]
    assert "Opening" in titles
    bs.delete("acme-repairs")
    assert bs.get("acme-repairs") is None
    # a second business with the same name gets a distinct id
    bs.save(bs.new("Acme Repairs"))
    assert bs.new("Acme Repairs").id == "acme-repairs-2"


def test_business_from_dict_ignores_unknown_keys():
    b = Business.from_dict({"id": "x", "name": "X", "future_field": 1, "scripts": [{"title": "t", "text": "b", "extra": 2}]})
    assert b.scripts[0].title == "t"
    assert json.loads(json.dumps(b.to_dict()))["id"] == "x"


# ----------------------------------------------------------------- CIFAS hub
def test_cifas_hub_is_a_full_specialist_hub():
    hub = HubStore().get("fixmyfile-cifas-removal")
    assert hub is not None
    assert hub.business_id == "fixmyfile"
    assert len(hub.qa) >= 15
    required = [f.key for f in hub.capture_fields if f.required]
    assert len(hub.capture_fields) >= 12 and len(required) >= 5
    assert any("cifas" in q["q"].lower() for q in hub.qa)
    assert any("guaranteed" in p.lower() for p in hub.forbidden_phrases)
    assert hub.scripts, "the hub ships scripts the handler reads out"
    prompt = hub.system_prompt(business=BusinessStore().get("fixmyfile"))
    assert "CIFAS" in prompt and "## Business: Fixmyfile" in prompt
    # the status line (not a firm of solicitors) must be in the prompt so the AI never claims otherwise
    assert "solicitor" in prompt.lower()


# ----------------------------------------------------------------- append-only answers
def test_grow_only_ever_appends():
    shown = "There's no upfront cost to you"
    assert _grow(shown, "There's no upfront cost to you – we recover it") == "There's no upfront cost to you – we recover it"
    # model rewrote the start: the shown text stays, only the new tail is appended
    out = _grow(shown, "No upfront cost to you at all. We recover it from the insurer.")
    assert out.startswith(shown)
    assert out.endswith("We recover it from the insurer.")
    # completely different rewrite with no anchor: keep what the reader has
    assert _grow(shown, "Something entirely different.") == shown
    assert _grow("", "fresh") == "fresh"
    assert _grow(shown, "") == shown
    assert _grow(shown, shown) == shown


def test_session_say_card_never_changes_its_start():
    s = Settings()
    hub = HubStore().get("courtesy-cars-accident-management")
    events = []
    prov = FakeProvider("SAY: There's no upfront cost to you, we recover it from the at-fault insurer.\n"
                        "MORE: Delivery is normally within 24 hours.\nASK: none\nWATCH: none\nSOURCE: Q&A\n", delay=0.002)
    texts: list[str] = []
    finished = []

    def emit(k, p):
        # snapshot the SAY text at emit time: the card object itself is mutated as it streams
        events.append((k, p))
        if k == "cards":
            for c in p:
                if c.type == SAY and c.text and (not texts or texts[-1] != c.text):
                    texts.append(c.text)
                if c.type == SAY and c.done:
                    finished.append(c.text)

    sess = CallSession(s, hub, prov, emit)
    sess.on_transcript(CALLER, "Can you explain how the paperwork for the hire works and who pays", True)
    assert _wait(lambda: any(t.endswith("insurer.") for t in finished)), "SAY card never finished streaming"
    sess.end(summarize=False)
    assert len(texts) >= 2, "expected the answer to stream in several steps"
    for earlier, later in zip(texts, texts[1:]):
        assert later.startswith(earlier), f"start changed while reading: {earlier!r} -> {later!r}"


# ----------------------------------------------------------------- export
def _record():
    t = 1_700_000_000.0
    return {"call_id": "abc123", "hub_name": "Courtesy Cars – Accident management", "call_type": "new_claim",
            "started_at": t, "ended_at": t + 125, "notice_given_at": t + 3,
            "fields": {"caller_name": "Jane Smith", "client_vehicle": "AB12 CDE"},
            "segments": [{"speaker": "agent", "text": "Courtesy Cars, Danny speaking.", "start": t + 1, "end": t + 3,
                          "language": "", "translation": ""},
                         {"speaker": "caller", "text": "Someone hit me at the lights.", "start": t + 4, "end": t + 7,
                          "language": "", "translation": ""}],
            "pins": [{"kind": "date", "value": "2024-01-02", "quote": "by Tuesday", "speaker": "agent", "at": t + 60}],
            "summary": {"summary": "Rear-end collision, car not driveable.",
                        "email": {"to": "jane@example.com", "subject": "As discussed", "body": "As discussed today…"}},
            "recording": ""}


def test_export_call_writes_everything(tmp_path):
    rec = _record()
    name = call_folder_name(rec)
    assert "Courtesy Cars" in name and "Jane Smith" in name and "/" not in name
    folder = export_call(rec, tmp_path, include_recording=False)
    assert folder == tmp_path / name
    txt = (folder / "transcript.txt").read_text(encoding="utf-8")
    assert "Someone hit me at the lights." in txt and "Caller" in txt
    assert (folder / "transcript.srt").exists()
    assert json.loads((folder / "call.json").read_text(encoding="utf-8"))["call_id"] == "abc123"
    assert "by Tuesday" in (folder / "pins.csv").read_text(encoding="utf-8")
    assert "As discussed today" in (folder / "as-discussed-email.txt").read_text(encoding="utf-8")
    try:
        import docx  # noqa: F401
    except ImportError:
        return
    d = docx.Document(str(folder / "transcript.docx"))
    body = "\n".join(p.text for p in d.paragraphs)
    assert "Someone hit me at the lights." in body and "Recording notice given" in body


def test_export_call_decrypts_recording(tmp_path):
    class Vault:
        def decrypt(self, b):
            return b[::-1]

    enc = tmp_path / "rec.wav.cpv"
    enc.write_bytes(b"FFIR")
    rec = _record()
    rec["recording"] = str(enc)
    folder = export_call(rec, tmp_path / "out", vault=Vault())
    assert (folder / "recording.wav").read_bytes() == b"RIFF"


# ----------------------------------------------------------------- AI voice mode
def test_handoff_and_honesty_regexes():
    assert WANT_HUMAN.search("Can I speak to a manager please")
    assert WANT_HUMAN.search("put me through to someone")
    assert WANT_HUMAN.search("I'd like to talk to a real person")
    assert not WANT_HUMAN.search("my insurance agent said the car was a write-off")
    assert not WANT_HUMAN.search("someone hit me at the lights")
    assert HUMAN_Q.search("wait, are you a real person?")
    assert HUMAN_Q.search("am I talking to a bot")
    assert not HUMAN_Q.search("is the car a real write-off")


def _voice(monkeypatch, reply, hub_id="courtesy-cars-accident-management"):
    spoken = []

    def fake_speak(text, device_name="", voice="alloy", ear="both", on_done=None, on_error=None):
        spoken.append((text, device_name, voice))
        if on_done:
            on_done()
        return threading.Thread()

    monkeypatch.setattr(voice_agent.tts, "speak", fake_speak)
    monkeypatch.setattr(voice_agent.tts, "stop", lambda: None)
    s = Settings()
    s.voice_agent.employee_name = "Sam Taylor"
    s.voice_agent.output_device = "CABLE Input (VB-Audio Virtual Cable)"
    events = []
    hub = HubStore().get(hub_id)
    sess = CallSession(s, hub, FakeProvider(reply), lambda k, p: events.append((k, p)))
    agent = VoiceAgent(sess, s, lambda k, p: events.append((k, p)))
    return agent, sess, events, spoken


def test_voice_agent_answers_as_a_named_employee_and_logs_the_line(monkeypatch):
    agent, sess, events, spoken = _voice(monkeypatch, "There's no upfront cost to you, we recover it from the insurer.")
    assert agent._on_caller_turn in sess.turn_listeners
    agent.start(say_opening=True)
    assert len(spoken) == 1 and "Sam" in spoken[0][0], "opens with the greeting as the named employee"
    assert spoken[0][1].startswith("CABLE Input"), "speaks into the virtual cable, not the speakers"
    assert sess.segments[-1].speaker == "agent"
    agent._on_caller_turn("Do I have to pay anything for the courtesy car?", "s1")
    assert _wait(lambda: len(spoken) == 2)
    assert spoken[1][0].startswith("There's no upfront cost")
    assert [s.text for s in sess.segments if s.speaker == "agent"][-1] == spoken[1][0]
    assert any(k == "ai_said" and p["text"] == spoken[1][0] for k, p in events)
    assert agent.state == "idle"
    sys_text = sess.provider.calls[-1][0]
    assert "your name is Sam" in sys_text and "You ARE the person on the call" in sys_text
    # no proactive disclosure anywhere in the instruction, but a truthful answer if asked directly
    assert "answer\ntruthfully" in sys_text or "answer truthfully" in sys_text.replace("\n", " ")
    assert "never mention" not in sys_text.lower()
    agent.stop()
    assert not agent.active


def test_voice_agent_hands_off_on_request_for_a_person(monkeypatch):
    agent, sess, events, spoken = _voice(monkeypatch, "I can help with that.")
    agent.start(say_opening=False)
    agent._on_caller_turn("I want to speak to a manager right now", "s2")
    assert _wait(lambda: agent.state == "handoff")
    assert spoken and "colleague" in spoken[-1][0]
    assert ("handoff", True) in events
    assert sess.provider.calls == [], "no model call: the hand-off is immediate"


def test_voice_agent_hands_off_when_model_says_the_handoff_line(monkeypatch):
    s_line = "Let me pass you to a colleague who can help with that – one moment please."
    agent, sess, events, spoken = _voice(monkeypatch, s_line)
    agent.start(say_opening=False)
    agent._on_caller_turn("I was injured and the police attended", "s3")
    assert _wait(lambda: agent.state == "handoff")
    assert spoken[-1][0] == s_line
    assert ("handoff", True) in events


def test_voice_agent_barge_in_stops_speech(monkeypatch):
    agent, sess, events, spoken = _voice(monkeypatch, "x")
    agent.start(say_opening=False)
    agent.state = "speaking"
    agent.barge_in()
    assert agent.state == "idle"
    assert ("ai_mode", {"active": True, "state": "idle"}) in events


# ----------------------------------------------------------------- review fixes
def test_turn_listeners_fire_even_when_a_speculative_draft_is_adopted():
    """Live use: an interim ≥5 words starts a speculative draft which the final adopts – the
    AI employee must still be told about the turn."""
    s = Settings()
    s.ai.speculative = True
    hub = HubStore().get("courtesy-cars-accident-management")
    heard = []
    sess = CallSession(s, hub, FakeProvider("SAY: No upfront cost.\nMORE: none\nASK: none\nWATCH: none\nSOURCE: Q&A\n",
                                            delay=0.01), lambda k, p: None)
    sess.turn_listeners.append(lambda text, seg_id: heard.append(text))
    sess.on_transcript(CALLER, "do I have to pay anything for the courtesy", False)
    time.sleep(0.3)   # let the speculative draft start
    sess.on_transcript(CALLER, "do I have to pay anything for the courtesy car", True)
    assert _wait(lambda: heard, 3), "turn listener was not called"
    assert heard == ["do I have to pay anything for the courtesy car"]
    sess.end(summarize=False)


class _BlockingProvider(FakeProvider):
    """Blocks inside stream() until released, then fails – lets a test take over mid-generation."""

    def __init__(self):
        super().__init__("")
        self.entered = threading.Event()
        self.release = threading.Event()

    def stream(self, system, messages, max_tokens, cancel=None, fast=True):
        self.calls.append((system, messages, fast))
        self.entered.set()
        self.release.wait(5)
        raise RuntimeError("provider down")
        yield  # pragma: no cover


def test_voice_agent_says_nothing_after_take_over_even_if_generation_fails(monkeypatch):
    spoken = []
    monkeypatch.setattr(voice_agent.tts, "speak",
                        lambda text, device_name="", voice="alloy", ear="both", on_done=None, on_error=None:
                        (spoken.append(text), on_done and on_done(), threading.Thread())[-1])
    monkeypatch.setattr(voice_agent.tts, "stop", lambda: None)
    s = Settings()
    events = []
    prov = _BlockingProvider()
    sess = CallSession(s, HubStore().get("courtesy-cars-accident-management"), prov, lambda k, p: events.append((k, p)))
    agent = VoiceAgent(sess, s, lambda k, p: events.append((k, p)))
    agent.start(say_opening=False)
    agent._on_caller_turn("Can you tell me about the hire terms", "s1")
    assert prov.entered.wait(3)
    agent.stop()                      # human takes over while the model is still thinking
    prov.release.set()
    assert _wait(lambda: agent.state == "idle" and not agent._gen_lock.locked(), 3)
    time.sleep(0.1)
    assert spoken == [], "hand-off line must not be spoken after take-over"
    assert ("handoff", True) not in events
    assert not any(k == "error" for k, _ in events)


def test_voice_agent_ignores_the_end_of_an_interrupted_utterance(monkeypatch):
    callbacks = []
    monkeypatch.setattr(voice_agent.tts, "speak",
                        lambda text, device_name="", voice="alloy", ear="both", on_done=None, on_error=None:
                        (callbacks.append(on_done), threading.Thread())[-1])
    monkeypatch.setattr(voice_agent.tts, "stop", lambda: None)
    s = Settings()
    sess = CallSession(s, HubStore().get("courtesy-cars-accident-management"), FakeProvider("x"), lambda k, p: None)
    agent = VoiceAgent(sess, s, lambda k, p: None)
    agent.start(say_opening=True)       # utterance 1 starts (callback deferred)
    assert agent.state == "speaking"
    agent.barge_in()                    # caller talks over it
    assert agent.state == "idle"
    agent._speak("Second line")         # utterance 2
    assert agent.state == "speaking"
    callbacks[0]()                      # utterance 1 finally reports done – must not flip state
    assert agent.state == "speaking"
    callbacks[1]()
    assert agent.state == "idle"
    sess.end(summarize=False)


def test_rehearsal_echo_detection():
    s = Settings()
    sess = CallSession(s, HubStore().get("courtesy-cars-accident-management"), FakeProvider("x"), lambda k, p: None)
    live = VoiceAgent(sess, s, lambda k, p: None, rehearse=False)
    reh = VoiceAgent(sess, s, lambda k, p: None, rehearse=True)
    live.state = reh.state = "speaking"
    assert not live.hears_itself()
    assert reh.hears_itself()
    reh.state = "idle"
    reh.last_spoke_at = time.time()
    assert reh.hears_itself()
    reh.last_spoke_at = time.time() - 5
    assert not reh.hears_itself()
    sess.end(summarize=False)


def test_auto_export_respects_privacy_settings(tmp_path):
    from callpilot.core.export import auto_export

    rec = _record()
    rec["segments"].append({"speaker": "caller", "text": "my card number is 4111 1111 1111 1111", "start": rec["started_at"] + 9,
                            "end": rec["started_at"] + 12, "language": "", "translation": ""})
    s = Settings()
    s.export.folder = str(tmp_path)
    s.privacy.save_sessions = False
    assert auto_export(rec, s) is None and not list(tmp_path.iterdir())
    s.privacy.save_sessions = True
    s.privacy.redact_saved_pii = True
    folder = auto_export(rec, s)
    assert folder is not None
    txt = (folder / "transcript.txt").read_text(encoding="utf-8")
    assert "4111 1111 1111 1111" not in txt and "Someone hit me" in txt
    assert "4111 1111 1111 1111" not in (folder / "call.json").read_text(encoding="utf-8")
    s.export.auto_save_calls = False
    assert auto_export(rec, s) is None


def test_call_folder_names_do_not_collide_within_a_minute():
    a, b = _record(), _record()
    b["started_at"] += 7
    assert call_folder_name(a) != call_folder_name(b)

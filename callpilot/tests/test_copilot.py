import threading
import time

from callpilot.ai.compliance import ComplianceMonitor, classify_intent
from callpilot.ai.copilot import CallSession, extract_json
from callpilot.ai.streamparse import parse_sections, split_questions
from callpilot.core.config import Settings
from callpilot.core.models import AGENT, CALLER
from callpilot.hubs.model import HubStore


class FakeProvider:
    name = "fake"

    def __init__(self, reply, delay=0.0):
        self.reply = reply
        self.delay = delay
        self.calls = []

    def stream(self, system, messages, max_tokens, cancel=None, fast=True):
        self.calls.append((system, messages))
        if "extract structured" in system:
            yield '{"caller_name": "Jane Smith", "client_vehicle": "AB12CDE"}'
            return
        if "post-call notes" in system:
            yield '{"summary": "Caller reported a rear-end accident.", "next_actions": ["Book car"]}'
            return
        if "interpreter" in system:
            yield "LANG: es\nTEXT: Hello, I had an accident"
            return
        for i in range(0, len(self.reply), 7):
            if cancel is not None and cancel.is_set():
                from callpilot.ai.providers import Cancelled
                raise Cancelled()
            time.sleep(self.delay)
            yield self.reply[i:i + 7]

    def complete(self, system, messages, max_tokens, fast=False):
        return "".join(self.stream(system, messages, max_tokens, fast=fast))


REPLY = ("SAY: I'm sorry to hear that, the good news is we can get you moving again.\n"
         "MORE: We'll arrange a like-for-like replacement car at no upfront cost.\n"
         "ASK: What's your vehicle registration? | Was anyone injured?\n"
         "WARN: none\n")


def _hub():
    return HubStore().get("courtesy-cars-accident-management")


def _collect():
    events = []
    lock = threading.Lock()

    def emit(kind, payload):
        with lock:
            events.append((kind, payload))
    return events, emit


def _wait(pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def test_parse_sections_progressive():
    assert parse_sections("SA") == {}
    assert parse_sections("SAY: Hello th") == {"SAY": "Hello th"}
    s = parse_sections("SAY: Hi.\nMORE: More text\nMO")
    assert s["MORE"] == "More text"
    s = parse_sections(REPLY)
    assert s["SAY"].startswith("I'm sorry") and split_questions(s["ASK"]) == [
        "What's your vehicle registration?", "Was anyone injured?"]
    assert parse_sections("Just a plain answer") == {"SAY": "Just a plain answer"}
    assert parse_sections("**SAY:** bold")["SAY"] == "bold"


def test_builtin_hub_loads_and_matches():
    hub = _hub()
    assert hub and hub.capture_fields and hub.qa
    m = hub.build_matcher().match("do I have to pay anything for the courtesy car")
    assert m and "no upfront cost" in m[1]
    assert hub.build_matcher().match("ok thanks") is None
    assert "Courtesy Cars UK" in hub.system_prompt()


def test_session_full_flow():
    s = Settings()
    s.ai.speculative = False
    s.translation.enabled = False
    events, emit = _collect()
    prov = FakeProvider(REPLY)
    sess = CallSession(s, _hub(), prov, emit)
    sess.on_transcript(CALLER, "Someone crashed into the back of my car and I'm really shaken", True,
                       "en", True)
    assert _wait(lambda: any(k == "suggestion" and p.done for k, p in events))
    sug = [p for k, p in events if k == "suggestion"][-1]
    assert sug.filler  # instant local filler
    assert sug.say_now.startswith("I'm sorry")
    assert "like-for-like" in sug.continue_with
    assert len(sug.ask_next) == 2 and sug.warnings == []
    # agent compliance
    sess.on_transcript(AGENT, "Don't worry, it's free and guaranteed", True, "en", True)
    alerts = [p for k, p in events if k == "alert"]
    assert any("free" in a for a in alerts) and any("guaranteed" in a for a in alerts)
    # extraction + summary
    s.ai.extract_every_n_turns = 1
    sess.on_transcript(CALLER, "My name is Jane Smith", True, "en", True)
    assert _wait(lambda: any(k == "fields" for k, _ in events))
    summary = sess.end()
    assert "rear-end" in summary["summary"]
    rec = sess.to_record()
    assert rec["fields"]["caller_name"] == "Jane Smith" and len(rec["segments"]) == 3


def test_instant_kb_answer_is_kept():
    s = Settings()
    s.ai.speculative = False
    s.translation.enabled = False
    events, emit = _collect()
    sess = CallSession(s, _hub(), FakeProvider(REPLY), emit)
    sess.on_transcript(CALLER, "Do I have to pay for the courtesy car?", True, "en", True)
    first = [p for k, p in events if k == "suggestion"][0]
    assert first.source == "instant-kb" and "no upfront cost" in first.say_now
    assert _wait(lambda: any(k == "suggestion" and p.done for k, p in events))
    final = [p for k, p in events if k == "suggestion"][-1]
    assert "no upfront cost" in final.say_now  # approved wording not overwritten


def test_speculative_draft_adopted():
    s = Settings()
    s.translation.enabled = False
    events, emit = _collect()
    prov = FakeProvider(REPLY, delay=0.01)
    sess = CallSession(s, _hub(), prov, emit)
    sess.on_transcript(CALLER, "the other driver went into the back of me at the lights", False, "en", False)
    time.sleep(0.45)  # speculation fires after 300 ms of stable partial
    sess.on_transcript(CALLER, "the other driver went into the back of me at the lights", True, "en", True)
    assert _wait(lambda: any(k == "suggestion" and p.done for k, p in events))
    assert len([c for c in prov.calls if "co-pilot" in c[0]]) == 1  # no second generation


def test_translation_sets_caller_language():
    s = Settings()
    s.ai.speculative = False
    events, emit = _collect()
    sess = CallSession(s, _hub(), FakeProvider(REPLY), emit)
    sess.on_transcript(CALLER, "Hola, tuve un accidente", True, "", True)
    assert _wait(lambda: any(k == "language" for k, _ in events))
    assert sess.caller_language == "es"
    assert _wait(lambda: any(k == "segment" and p.translation for k, p in events))


def test_compliance_and_intent():
    m = ComplianceMonitor(["it's free"], ["Call is recorded"], ["solicitor"])
    assert m.check_caller("I'm going to call my solicitor")
    m.check_agent("Just so you know this call is recorded for training")
    assert m.missing_disclosures() == []
    assert classify_intent("How long will it take?") == "question"
    assert classify_intent("I'm hurt and scared") == "distress"
    assert extract_json('noise {"a": 1} tail') == {"a": 1}

import datetime as dt
import threading
import time

from callpilot.ai.cards import CardDeck, RuleContext, banned_filter, rule_cards
from callpilot.ai.compliance import ComplianceMonitor, classify_intent
from callpilot.ai.copilot import CallSession, extract_json
from callpilot.ai.pins import extract, resolve_date
from callpilot.ai.streamparse import parse_sections, split_questions
from callpilot.core.config import Settings
from callpilot.core.files import CaseFile
from callpilot.core.models import AGENT, ASK, CALLER, SAY, WATCH, Card
from callpilot.hubs.model import HubStore


class FakeProvider:
    name = "fake"

    def __init__(self, reply, delay=0.0):
        self.reply = reply
        self.delay = delay
        self.calls = []

    def stream(self, system, messages, max_tokens, cancel=None, fast=True):
        sys_text = "\n".join(system) if isinstance(system, list) else system
        self.calls.append((sys_text, messages, fast))
        if "extract structured" in sys_text:
            yield ('{"fields": {"caller_name": "Jane Smith", "client_vehicle": "AB12CDE"}, '
                   '"field_sources": {"caller_name": "s3"}, "pins": []}')
            return
        if "wrap-up" in sys_text:
            yield ('{"summary": "Caller reported a rear-end accident.", "tasks": [{"title": "Book car", "owner": "us"}], '
                   '"email": {"to": "", "subject": "As discussed", "body": "As discussed today at 14:32, the car is completely free and guaranteed."}, '
                   '"chronology": [], "deadlines": [], "pins": [], "compliance_gaps": []}')
            return
        if "interpreter" in sys_text:
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
         "WATCH: none\n"
         "SOURCE: Q&A: hire terms\n")


def _hub(hid="courtesy-cars-accident-management"):
    return HubStore().get(hid)


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


def _cards(events, typ):
    out = []
    for k, p in events:
        if k == "cards":
            for c in p:
                if c.type == typ:
                    out.append(c)
    return out


# ------------------------------------------------------------------ parsing
def test_parse_sections_progressive():
    assert parse_sections("SA") == {}
    assert parse_sections("SAY: Hello th") == {"SAY": "Hello th"}
    s = parse_sections("SAY: Hi.\nMORE: More text\nMO")
    assert s["MORE"] == "More text"
    s = parse_sections(REPLY)
    assert s["SAY"].startswith("I'm sorry") and split_questions(s["ASK"]) == [
        "What's your vehicle registration?", "Was anyone injured?"]
    assert s["SOURCE"] == "Q&A: hire terms"
    assert parse_sections("WARN: old tag")["WATCH"] == "old tag"
    assert parse_sections("Just a plain answer") == {"SAY": "Just a plain answer"}
    assert parse_sections("**SAY:** bold")["SAY"] == "bold"


# ------------------------------------------------------------------ pins
def test_pin_extraction_and_dates():
    base = dt.datetime(2026, 10, 3, 14, 32).timestamp()  # a Saturday
    ents = {e.kind: e for e in extract("You've got 14 days, the engineer is booked for Tuesday 7 October and "
                                       "we'll pay £1,250, reg AB12 CDE", base)}
    assert ents["deadline"].due == "2026-10-17"
    assert ents["date"].value == "07/10/2026"
    assert ents["figure"].value == "£1,250"
    assert ents["reg"].value == "AB12CDE"
    assert ents["commitment"]
    assert resolve_date("by Friday".split()[-1], dt.date(2026, 10, 3)) == dt.date(2026, 10, 9)
    assert extract("it was my fault, I didn't see him")[0].kind == "admission"
    assert any(e.kind == "allegation" for e in extract("we're investigating as the damage is not consistent"))
    assert extract("ok thanks bye") == []


# ------------------------------------------------------------------ rules / deck
def test_rule_cards_trigger_table():
    tp = RuleContext(speaker=CALLER, call_type="handler", third_party=True, signed_authority=False)
    cards = rule_cards("we consider this fraudulent and we're investigating", extract("fraud"), tp)
    types = [(c.type, c.sources[0]) for c in cards]
    assert (WATCH, "rule:authority") in types and (WATCH, "rule:fraud") in types and (ASK, "rule:fraud") in types
    assert any(c.pinned_top for c in cards if c.sources[0] == "rule:authority")
    cl = RuleContext(speaker=CALLER, call_type="new_accident", third_party=False, signed_authority=None)
    inj = rule_cards("my neck really hurts and I went to A&E", [], cl)
    assert inj and inj[0].type == WATCH and "referral" in inj[0].text
    offer = rule_cards("we can offer £1,250 as the pre-accident value", extract("offer £1,250"),
                       RuleContext(speaker=CALLER, call_type="handler", third_party=True, signed_authority=True))
    assert any(c.type == SAY and "£1,250" in c.text for c in offer)
    start = rule_cards("yes go ahead and start please", [], cl)
    assert any("14-day" in c.text for c in start)
    assert rule_cards("okay thank you", [], cl) == []


def test_banned_filter_and_deck():
    clean, hits = banned_filter("Our solicitor will call you, it's free", ["solicitor", "it's free"])
    assert hits == ["solicitor", "it's free"] and "solicitor" not in clean
    changes = []
    deck = CardDeck(lambda: changes.append(1))
    pinned = Card(WATCH, "No authority", ["rule:authority"], pinned_top=True)
    deck.show(pinned)
    deck.show(Card(WATCH, "Injury mentioned", ["rule:injury"]))
    assert deck.slots[WATCH] is pinned and "Injury" in pinned.text   # pinned card keeps the slot
    a = Card(ASK, "Reg?", ["intake"])
    deck.show(a)
    b = Card(ASK, "Injured?", ["intake"])
    deck.show(b)
    assert a.action == "ignored" and deck.visible() == [pinned, b]
    assert deck.top() is pinned
    deck.mark(None, "used")
    assert pinned.action == "used" and deck.top() is b
    assert len(deck.log) == 4


# ------------------------------------------------------------------ session
def test_session_full_flow():
    s = Settings()
    s.ai.speculative = False
    s.translation.enabled = False
    events, emit = _collect()
    prov = FakeProvider(REPLY)
    sess = CallSession(s, _hub(), prov, emit, call_type="new_accident")
    sess.on_transcript(CALLER, "Someone crashed into the back of my car and I'm really shaken", True, "en", True)
    assert _wait(lambda: any(c.done and c.text for c in _cards(events, SAY)))
    say = [c for c in _cards(events, SAY) if c.done][-1]
    assert say.filler and say.text.startswith("I'm sorry") and "like-for-like" in say.more
    assert say.sources == ["Q&A: hire terms"] and say.segment_id
    ask = _cards(events, ASK)[-1]
    assert "registration" in ask.text and "injured" in ask.text
    assert not _cards(events, WATCH)
    # the request carried the 90 s window and the file block
    sys_text, msgs, fast = prov.calls[0]
    assert fast and "This call type: new accident" in sys_text and "<transcript>" in msgs[0]["content"]
    # agent compliance: banned phrases alert
    sess.on_transcript(AGENT, "Don't worry, it's free and guaranteed", True, "en", True)
    alerts = [p for k, p in events if k == "alert"]
    assert any("free" in a for a in alerts) and any("guaranteed" in a for a in alerts)
    # a date spoken by the caller becomes a chip + pin
    sess.on_transcript(CALLER, "the garage said it'll be ready by Friday and they want £300 storage", True, "en", True)
    seg = [p for k, p in events if k == "segment" and "storage" in p.text][-1]
    assert ("deadline", "by Friday") in seg.entities and seg.pinned
    pins = [p for k, p in events if k == "pin"]
    assert {p.kind for p in pins} >= {"deadline", "figure"}
    # extraction + wrap-up
    s.ai.extract_every_n_turns = 1
    sess.on_transcript(CALLER, "My name is Jane Smith", True, "en", True)
    assert _wait(lambda: any(k == "fields" for k, _ in events))
    fp = [p for k, p in events if k == "fields"][-1]
    assert fp["values"]["caller_name"] == "Jane Smith" and fp["sources"]["caller_name"] == "s3"
    sess.add_task("Book car", "2026-10-07")
    summary = sess.end()
    assert "rear-end" in summary["summary"]
    assert "completely free" not in summary["email"]["body"]         # banned-phrase filter ran on the draft
    assert summary["qa"]["score"] >= 0 and "Follow-up email drafted" in summary["qa"]["items"]
    rec = sess.to_record()
    assert rec["fields"]["caller_name"] == "Jane Smith" and len(rec["segments"]) == 4
    assert rec["ai_cards"] and all(c["action"] for c in rec["ai_cards"]) and rec["tasks"][0]["title"] == "Book car"
    assert rec["pins"] and rec["call_type"] == "new_accident"


def test_instant_playbook_answer_is_kept():
    s = Settings()
    s.ai.speculative = False
    s.translation.enabled = False
    events, emit = _collect()
    sess = CallSession(s, _hub(), FakeProvider(REPLY), emit)
    sess.on_transcript(CALLER, "Do I have to pay for the courtesy car?", True, "en", True)
    first = _cards(events, SAY)[0]
    assert first.origin == "playbook" and "no upfront cost" in first.text and first.sources[0].startswith("Q&A:")
    assert _wait(lambda: any(c.done for c in _cards(events, SAY)))
    final = [c for c in _cards(events, SAY) if c.done][-1]
    assert "no upfront cost" in final.text  # approved wording not overwritten


def test_third_party_without_authority_pins_watch_card():
    s = Settings()
    s.ai.speculative = False
    s.translation.enabled = False
    events, emit = _collect()
    f = CaseFile(business="Fixmyfile", client_name="Khan", reg="AB12CDE")
    sess = CallSession(s, _hub("fixmyfile-handler-calls"), None, emit, case_file=f, call_type="handler")
    watch = _cards(events, WATCH)[-1]
    assert watch.pinned_top and "authority" in watch.text.lower()
    sess.on_transcript(CALLER, "we think this claim is staged and we're investigating", True, "en", True)
    asks = _cards(events, ASK)
    assert asks and "in writing" in asks[-1].text
    assert any(p.kind == "allegation" for k, p in events if k == "pin")
    assert "Khan" in sess._system_blocks[1] and "NO signed authority" in sess._system_blocks[1]


def test_speculative_draft_adopted():
    s = Settings()
    s.translation.enabled = False
    events, emit = _collect()
    prov = FakeProvider(REPLY, delay=0.01)
    sess = CallSession(s, _hub(), prov, emit)
    sess.on_transcript(CALLER, "the other driver went into the back of me at the lights", False, "en", False)
    time.sleep(0.45)
    sess.on_transcript(CALLER, "the other driver went into the back of me at the lights", True, "en", True)
    assert _wait(lambda: any(c.done and c.text for c in _cards(events, SAY)))
    assert len([c for c in prov.calls if "How to answer" in c[0]]) == 1  # no second generation


class _FailingProvider(FakeProvider):
    def stream(self, system, messages, max_tokens, cancel=None, fast=True):
        sys_text = "\n".join(system) if isinstance(system, list) else system
        if "How to answer" in sys_text:
            raise RuntimeError("rate limited")
        yield from super().stream(system, messages, max_tokens, cancel, fast)


def test_failed_speculative_draft_is_silent():
    s = Settings()
    s.translation.enabled = False
    events, emit = _collect()
    sess = CallSession(s, _hub(), _FailingProvider(REPLY), emit)
    sess.on_transcript(CALLER, "someone went into the back of my car at the lights today", False, "en", False)
    time.sleep(0.6)
    assert not any(k == "error" for k, _ in events)
    assert not _cards(events, SAY)


def test_late_speculation_never_cancels_real_answer():
    s = Settings()
    s.ai.speculative = False
    s.translation.enabled = False
    events, emit = _collect()
    prov = FakeProvider(REPLY, delay=0.02)
    sess = CallSession(s, _hub(), prov, emit)
    sess.on_transcript(CALLER, "who pays for the repairs to my car", True, "en", True)
    time.sleep(0.05)
    sess._start_generation("who pays for the", True, "x", expected_turn=0)
    sess._start_generation("who pays for the repairs to", True, "x")
    assert _wait(lambda: any(c.done and c.text for c in _cards(events, SAY)))
    assert len([c for c in prov.calls if "How to answer" in c[0]]) == 1
    sess.end(summarize=False)


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


def test_notice_and_manual_pin_and_confirmed_field():
    s = Settings()
    s.ai.speculative = False
    s.translation.enabled = False
    events, emit = _collect()
    sess = CallSession(s, _hub(), None, emit)
    sess.on_transcript(AGENT, "Just so you know this call is recorded and transcribed", True, "en", True)
    assert sess.notice_given_at and ("notice", True) in events
    sess.on_transcript(CALLER, "the car is at Smiths garage in Stockport", True, "en", True)
    pin = sess.pin_last_line()
    assert pin.kind == "pinned" and sess.segments[-1].pinned
    sess.set_field("caller_name", "J Smith", confirmed=True)
    assert "caller_name" in sess.confirmed_fields

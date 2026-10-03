import time

from callpilot.ai.learn import learn_deterministic, learn_from_call
from callpilot.core.memory import MemoryEntry, MemoryStore


def _store(tmp_path):
    return MemoryStore(tmp_path / "memory.cpv")


def test_memory_roundtrip_dedupe_and_feedback(tmp_path):
    m = _store(tmp_path)
    m.add(MemoryEntry("answer", "No upfront cost to you; we recover it from the at-fault insurer.",
                      question="do I have to pay for the courtesy car", hub_id="h1"))
    m.add(MemoryEntry("answer", "There's no upfront cost – recovered from the at-fault insurer.",
                      question="do i have to pay for the courtesy car?", hub_id="h1"))
    assert len(m.entries) == 1 and m.entries[0].uses == 1          # near-duplicate merged, score bumped
    m.add(MemoryEntry("fact", "Handler Tom Avery wants rate evidence by email", subject="Aviva", hub_id="h1"))
    m.add(MemoryEntry("lesson", "Keep answers under two sentences", hub_id=""))
    assert b"Avery" not in (tmp_path / "memory.cpv").read_bytes()  # encrypted
    m2 = _store(tmp_path)
    assert len(m2.entries) == 3
    assert m2.matcher("h1").match("will I have to pay anything for the courtesy car")
    assert m2.facts_about("aviva", "h1")[0].text.startswith("Handler Tom")
    block = m2.prompt_block("h1", subject="Aviva")
    assert "Keep answers" in block and "Tom Avery" in block and "Q: do I have to pay" in block
    assert m2.search("h1", "rate evidence email")[0].kind == "fact"
    # dismissals lower the score and eventually forget the answer
    for _ in range(3):
        m2.feedback("do I have to pay for the courtesy car", "x", False, "h1")
    assert not m2.learned_pairs("h1")
    assert m2.stats("h1")["facts"] == 1 and m2.stats("h1")["lessons"] == 1


def test_learn_deterministic_from_record(tmp_path):
    m = _store(tmp_path)
    rec = {"hub_id": "h1", "call_id": "c1", "segments": [
        {"id": "s1", "speaker": "caller", "text": "How long can I keep the replacement car for?", "start": time.time()},
        {"id": "s2", "speaker": "agent", "text": "You keep it while your own car is being repaired, or until your total loss settlement comes through.", "start": time.time()},
        {"id": "s3", "speaker": "caller", "text": "What if my car is written off?", "start": time.time()},
    ], "ai_cards": [
        {"type": "say", "text": "You keep it while repairs run.", "more": "", "segment_id": "s1", "action": "used"},
        {"type": "say", "text": "The insurer pays market value, it's free.", "more": "", "segment_id": "s3", "action": "dismissed"},
    ]}
    n = learn_deterministic(rec, m, banned=["it's free"])
    assert n >= 1
    pairs = m.learned_pairs("h1")
    assert any("keep it while" in a for q, a in pairs)
    assert all("it's free" not in a for q, a in pairs)


class _Prov:
    def complete(self, system, messages, max_tokens, fast=False):
        return ('{"answers": [{"q": "is the car insured", "a": "Yes, fully insured for the hire period."}], '
                '"facts": [{"subject": "Jane Smith", "text": "Prefers text message updates"}], '
                '"lessons": ["Lead with reassurance before questions"], '
                '"corrections": [{"suggested": "We guarantee delivery today", "preferred": "We aim to deliver within 24 hours"}]}')


def test_learn_with_model(tmp_path):
    m = _store(tmp_path)
    rec = {"hub_id": "h1", "call_id": "c2", "segments": [
        {"id": f"s{i}", "speaker": "caller" if i % 2 else "agent", "text": f"line {i} about the car", "start": time.time()}
        for i in range(6)], "ai_cards": [], "fields": {}, "summary": {"summary": "ok"}}
    res = learn_from_call(_Prov(), rec, m, banned=["guarantee"])
    assert res["added"] == 4 and not res["error"]
    assert m.stats("h1") == {"answers": 1, "facts": 1, "lessons": 2, "calls": 1}
    assert m.matcher("h1").match("is the courtesy car insured")

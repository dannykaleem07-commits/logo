"""Self-training after every call.

Two sources of learning, both written to the MemoryStore:

1. **Deterministic** (no model): every AI card you marked *used* becomes a remembered
   answer; every card you *dismissed* lowers that answer's score; every caller
   question that you answered yourself (your next line after their question)
   becomes a candidate answer in your own words.
2. **Model-distilled** (strong model, one call): reads the transcript and the card
   log and returns new Q&A pairs, durable facts about the caller/company, and
   lessons about how you like to handle things. Everything is reviewable in
   Settings → Memory and can be deleted.
"""

from __future__ import annotations

import json
import logging
import re

from callpilot.ai.cards import banned_filter
from callpilot.core.models import AGENT, CALLER
from callpilot.core.memory import MemoryEntry, MemoryStore

log = logging.getLogger(__name__)

LEARN_SYSTEM = """You help a call handler's assistant learn from a finished call so it gives better
suggestions next time. You see the transcript (US = the handler, CALLER = the other party), the AI cards that
were shown with whether the handler used or dismissed them, and the wrap-up summary.
Return ONLY a JSON object with keys:
"answers": list of {"q": "<what the caller asked or said, generalised a little>", "a": "<the answer the handler
           actually gave, cleaned up into one or two spoken sentences, in the handler's own words>"} – only
           where the handler's answer was good and reusable (max 8);
"facts": list of {"subject": "<caller name / company / reference>", "text": "<durable fact worth remembering next
         time this person or company calls>"} (max 8, no payment data, no health details);
"lessons": list of "<one-sentence preference about how this handler likes suggestions: tone, length, phrasing,
           what to avoid – inferred from which cards were used vs dismissed and from how they actually spoke>"
           (max 5);
"corrections": list of {"suggested": "<what the AI suggested>", "preferred": "<what the handler said instead>"}
               where the handler ignored the card and said something clearly better (max 5).
Be conservative: an empty list is better than a guess."""


def _agent_answers(segments: list[dict]) -> list[tuple[str, str]]:
    """Caller question -> the handler's next substantive line."""
    out = []
    for i, s in enumerate(segments):
        if s["speaker"] != CALLER:
            continue
        txt = s["text"].strip()
        if len(txt.split()) < 4 or not re.search(r"\?|^(what|how|when|where|why|who|can|could|do|does|is|are|will)\b", txt, re.I):
            continue
        for nxt in segments[i + 1:i + 3]:
            if nxt["speaker"] == AGENT and len(nxt["text"].split()) >= 6:
                out.append((txt, nxt["text"].strip()))
                break
    return out


def learn_deterministic(record: dict, memory: MemoryStore, banned: list[str]) -> int:
    hub_id = record.get("hub_id", "")
    call_id = record.get("call_id", "")
    segs = record.get("segments", [])
    by_id = {s["id"]: s for s in segs}
    added = 0
    for c in record.get("ai_cards", []) or []:
        if c.get("type") != "say" or not c.get("text"):
            continue
        q = by_id.get(c.get("segment_id", ""), {}).get("text", "")
        ans = " ".join(p for p in (c.get("text", ""), c.get("more", "")) if p).strip()
        ans, _ = banned_filter(ans, banned)
        if c.get("action") == "used" and q:
            memory.feedback(q, ans, True, hub_id, call_id)
            added += 1
        elif c.get("action") == "dismissed" and q:
            memory.feedback(q, ans, False, hub_id, call_id)
    for q, a in _agent_answers(segs):
        a, _ = banned_filter(a, banned)
        before = len(memory.entries)
        memory.add(MemoryEntry("answer", a, question=q[:300], hub_id=hub_id, score=1.0, source_call=call_id,
                               origin="learned"))
        added += int(len(memory.entries) > before)
    return added


def learn_with_model(provider, record: dict, memory: MemoryStore, banned: list[str]) -> dict:
    hub_id = record.get("hub_id", "")
    call_id = record.get("call_id", "")
    segs = record.get("segments", [])
    rows = [f"[{s['id']}] {'US' if s['speaker'] == AGENT else 'CALLER'}: {s['text']}" for s in segs]
    cards = [f"- ({c.get('action') or 'ignored'}) {c.get('type')}: {c.get('text', '')[:200]}"
             for c in record.get("ai_cards", []) or [] if c.get("text")]
    summary = (record.get("summary") or {}).get("summary", "")
    user = ("Transcript:\n" + "\n".join(rows) + "\n\nAI cards shown:\n" + ("\n".join(cards) or "(none)") +
            f"\n\nWrap-up summary: {summary}\nIntake: {json.dumps(record.get('fields', {}), ensure_ascii=False)}")
    out = provider.complete(LEARN_SYSTEM, [{"role": "user", "content": user}], 6000, fast=False)
    m = re.search(r"\{.*\}", out, re.S)
    data = json.loads(m.group(0)) if m else {}
    entries: list[MemoryEntry] = []
    for p in data.get("answers", []) or []:
        if isinstance(p, dict) and p.get("q") and p.get("a"):
            a, _ = banned_filter(str(p["a"]), banned)
            entries.append(MemoryEntry("answer", a, question=str(p["q"])[:300], hub_id=hub_id, score=1.2,
                                       source_call=call_id))
    for f in data.get("facts", []) or []:
        if isinstance(f, dict) and f.get("text"):
            entries.append(MemoryEntry("fact", str(f["text"])[:400], subject=str(f.get("subject", ""))[:120],
                                       hub_id=hub_id, source_call=call_id))
    for les in data.get("lessons", []) or []:
        if isinstance(les, str) and les.strip():
            entries.append(MemoryEntry("lesson", les.strip()[:300], hub_id=hub_id, source_call=call_id))
    for c in data.get("corrections", []) or []:
        if isinstance(c, dict) and c.get("preferred"):
            entries.append(MemoryEntry("lesson", f"Prefer “{str(c['preferred'])[:160]}” over “{str(c.get('suggested', ''))[:120]}”.",
                                       hub_id=hub_id, source_call=call_id))
    n = memory.add_many(entries)
    return {"added": n, "answers": len(data.get("answers", []) or []), "facts": len(data.get("facts", []) or []),
            "lessons": len(data.get("lessons", []) or []) + len(data.get("corrections", []) or [])}


def learn_from_call(provider, record: dict, memory: MemoryStore, banned: list[str]) -> dict:
    result = {"deterministic": 0, "added": 0, "error": ""}
    try:
        result["deterministic"] = learn_deterministic(record, memory, banned)
    except Exception as e:  # noqa: BLE001
        log.exception("deterministic learning failed")
        result["error"] = str(e)
    if provider is not None and len(record.get("segments", [])) >= 4:
        try:
            result.update(learn_with_model(provider, record, memory, banned))
        except Exception as e:  # noqa: BLE001
            log.warning("model learning failed: %s", e)
            result["error"] = str(e)
    return result

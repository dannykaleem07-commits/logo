"""The Director's logic layer.

Standing orders  - rules the Director gives ("if X, do Y"). Every agent reads them on every job.
Decisions        - when an agent meets a situation the orders don't cover, it stops, suggests a
                   course of action with AI, and asks the Director. The answer is carried out
                   and, if the Director says so, saved as a new standing order. That is how the
                   team learns.
Greeting         - a short, human spoken greeting for the hub, built from live state.
ElevenLabs       - natural voice for the assistant (optional; the browser voice is the fallback).
"""

import json
import logging
import os
import urllib.error
import urllib.request
from datetime import datetime

from . import brain, config, store
from .brain import B, LS, S, obj

log = logging.getLogger("agents")


# ---------------------------------------------------------------- standing orders

def orders_text(limit=60):
    """Standing orders as a prompt block (empty string if none)."""
    rules = store.rules(active_only=True)[:limit]
    if not rules:
        return ""
    lines = [f"{i + 1}. When: {r['situation']}\n   Do: {r['instruction']}" for i, r in enumerate(rules)]
    return (
        f"\nDIRECTOR'S STANDING ORDERS ({config.DIRECTOR_NAME} has given these personally; they override "
        "general practice, within the law and the perimeter rules):\n" + "\n".join(lines) + "\n"
        "If a situation is not covered by these orders or the playbooks, do not guess: flag it as a new "
        "situation for the Director with your recommended approach.\n"
    )


def add_order(situation, instruction, source="director", decision_id=None):
    rid = store.add_rule(situation.strip(), instruction.strip(), source, decision_id)
    store.activity("director", f"New standing order #{rid}: when {situation.strip()[:80]}")
    return rid


# ---------------------------------------------------------------- decisions (new situations)

SUGGEST_SCHEMA = obj({
    "situation": S,
    "why_new": S,
    "recommended": S,
    "options": LS,
    "risk_if_wrong": S,
    "proposed_order": obj({"situation": S, "instruction": S}),
})


def raise_decision(employee_id, folder, situation, context=""):
    """An agent asks the Director what to do. AI drafts the recommendation first."""
    e = store.employee(employee_id) or {"name": employee_id}
    suggestion = None
    try:
        suggestion = brain.ask_json(
            f"You advise {e['name']} and the Director of a UK credit hire and accident management firm. "
            "A situation has come up that the standing orders and playbooks do not clearly cover. Set out "
            "the decision for the Director in plain English: what the situation is, why it is new, the "
            "recommended approach (specific, lawful, within the perimeter), 2-4 alternative options, the "
            "risk if we get it wrong, and a proposed standing order so the team handles it the same way next "
            "time (situation = the general pattern, instruction = what to do).",
            f"Situation reported by {e['name']}: {situation}\nClaim file: {folder or 'none'}\n\nContext:\n{context[:6000]}",
            SUGGEST_SCHEMA, effort="high", max_tokens=6000)
    except Exception as ex:
        log.warning("Suggestion failed: %s", ex)
    did = store.add_decision(employee_id, folder, situation, suggestion)
    store.activity(employee_id, f"Asked {config.DIRECTOR_NAME} for a decision #{did}: {situation[:90]}")
    return did


def answer_decision(decision_id, answer, make_order=True, chosen=None):
    """The Director decides. The employee gets the instruction as a task; optionally it becomes an order."""
    d = store.decision(decision_id)
    if not d or d["status"] != "open":
        return None
    instruction = (answer or "").strip() or (chosen or "").strip()
    if not instruction and d.get("suggestion"):
        instruction = d["suggestion"].get("recommended", "")
    store.close_decision(decision_id, instruction)
    title = f"Decision #{decision_id}: {d['situation'][:70]}"
    tid = store.add_task(d["employee"], title, f"The Director has decided: {instruction}\n\nOriginal situation: {d['situation']}", d["folder"] or "")
    store.activity("director", f"Decided #{decision_id}: {instruction[:90]}")
    rid = None
    if make_order:
        sug = (d.get("suggestion") or {}).get("proposed_order") or {}
        situation = sug.get("situation") or d["situation"]
        rid = add_order(situation, instruction, source="learned", decision_id=decision_id)
    return {"task_id": tid, "rule_id": rid}


# ---------------------------------------------------------------- greeting

def _fallback_greeting(s):
    hr = datetime.now().hour
    part = "Morning" if hr < 12 else "Afternoon" if hr < 18 else "Evening"
    k = s["kpis"]
    bits = []
    if k["awaiting"]:
        bits.append(f"{k['awaiting']} draft{'s' if k['awaiting'] != 1 else ''} waiting for you")
    if k["overdue"]:
        bits.append(f"{k['overdue']} file{'s' if k['overdue'] != 1 else ''} overdue on the other side")
    if s.get("decisions_open"):
        bits.append(f"{s['decisions_open']} decision{'s' if s['decisions_open'] != 1 else ''} only you can make")
    tail = ", ".join(bits) if bits else "nothing waiting on you right now"
    return f"{part}, {s['director']}. {tail[0].upper() + tail[1:]}. Say the word and I'll walk you through it."


def greeting(s):
    """Short spoken greeting, regenerated at most every 20 minutes or when the numbers change."""
    k = s["kpis"]
    key = f"{datetime.now():%Y-%m-%d %H}:{datetime.now().minute // 20}|{k['awaiting']}|{k['overdue']}|{s.get('decisions_open', 0)}|{s['employees'][0]['last']['ts'] if s['employees'] and s['employees'][0]['last'] else ''}"
    cached = store.get("greeting")
    if cached:
        try:
            c = json.loads(cached)
            if c.get("key") == key:
                return c["text"]
        except ValueError:
            pass
    text = _fallback_greeting(s)
    if os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"):
        try:
            from .workers import _brief
            out = brain.ask_json(
                f"You are {s['assistant']}, {config.DIRECTOR_NAME}'s personal assistant at a UK accident claims and "
                "credit hire firm. Write the few sentences you would SAY out loud when he opens the hub: warm, human, "
                "unhurried but sharp, like a trusted chief of staff who has already read everything. Greet him by name "
                "for the time of day, give the one or two things that matter most right now with real numbers from the "
                "briefing, and end with a short offer. 35-60 words. No lists, no markdown, no exclamation marks. Vary "
                "the wording each time; never start with 'Good morning Shahzaib,' twice in a row.",
                f"Now: {datetime.now():%A %d %B %Y, %H:%M}\nBriefing: {_brief()}\nPrevious greeting (don't repeat it): "
                f"{json.loads(cached)['text'] if cached else 'none'}",
                obj({"text": S}), effort="low", with_knowledge=False, max_tokens=800)
            text = out["text"].strip() or text
        except Exception as ex:
            log.warning("Greeting failed: %s", ex)
    store.put("greeting", json.dumps({"key": key, "text": text}))
    return text


# ---------------------------------------------------------------- ElevenLabs

ELEVEN_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVEN_VOICE = os.getenv("ELEVENLABS_VOICE_ID", "")
ELEVEN_MODEL = os.getenv("ELEVENLABS_MODEL", "eleven_multilingual_v2")


def eleven_ready():
    return bool(ELEVEN_KEY)


def eleven_voices():
    req = urllib.request.Request("https://api.elevenlabs.io/v1/voices", headers={"xi-api-key": ELEVEN_KEY})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read())
    return [{"id": v["voice_id"], "name": v["name"], "labels": v.get("labels", {})} for v in data.get("voices", [])]


def eleven_speak(text, voice_id=None):
    """Returns MP3 bytes."""
    vid = voice_id or ELEVEN_VOICE or store.get("eleven_voice") or "EXAVITQu4vr4xnSDxMaL"
    body = json.dumps({
        "text": text[:2500],
        "model_id": ELEVEN_MODEL,
        "voice_settings": {"stability": 0.45, "similarity_boost": 0.8, "style": 0.25, "use_speaker_boost": True},
    }).encode()
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{vid}?output_format=mp3_44100_128", data=body,
        headers={"xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ElevenLabs {e.code}: {e.read()[:200].decode(errors='ignore')}")

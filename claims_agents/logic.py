"""The Director's logic layer.

Standing orders  - rules the Director gives ("if X, do Y"). Every agent reads them on every job.
Decisions        - when an agent meets a situation the orders don't cover, it stops, suggests a
                   course of action with AI, and asks the Director. The answer is carried out
                   and, if the Director says so, saved as a new standing order. That is how the
                   team learns.
Greeting         - a short, human spoken greeting for the hub, built from live state.
Voice            - natural speech for the assistant (Microsoft neural voices; the browser voice is the fallback).
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
    try:
        warm_voice(text)   # best effort, background: the first tap plays from the cache
    except Exception:
        pass
    return text


# ---------------------------------------------------------------- voice (Microsoft neural voices, free, no key)

import asyncio
import base64
import hashlib
import re
import threading
import time

DEFAULT_VOICE = os.getenv("TTS_VOICE", "en-GB-SoniaNeural")
TTS_PROVIDER = (os.getenv("TTS_PROVIDER", "edge") or "edge").strip().lower()   # edge | openai | azure (design only)
TTS_CACHE_MB = int(os.getenv("TTS_CACHE_MB", "200") or 200)
TTS_CACHE_FILES = 2000
CACHE_DIR = config.DATA_DIR / "tts-cache"
VOICES_FILE = config.DATA_DIR / "voices.json"
_VOICE_ID = re.compile(r"^[a-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9]+$")

# A short, good list for the Settings picker (British first); any Microsoft voice name also works in .env.
VOICES = [
    ("en-GB-SoniaNeural", "Sonia", "British, warm"),
    ("en-GB-LibbyNeural", "Libby", "British, bright"),
    ("en-GB-RyanNeural", "Ryan", "British, calm"),
    ("en-GB-ThomasNeural", "Thomas", "British, steady"),
    ("en-GB-MaisieNeural", "Maisie", "British, soft"),
    ("en-IE-EmilyNeural", "Emily", "Irish"),
    ("en-AU-NatashaNeural", "Natasha", "Australian"),
    ("en-US-AvaMultilingualNeural", "Ava", "American, expressive"),
    ("en-US-EmmaMultilingualNeural", "Emma", "American, natural"),
    ("en-US-AriaNeural", "Aria", "American, expressive"),
    ("en-US-JennyNeural", "Jenny", "American, friendly"),
    ("en-US-GuyNeural", "Guy", "American, newsreader"),
]
# Offered only when Microsoft's live voice list (cached in data/voices.json) confirms they exist.
OPTIONAL_VOICES = [
    ("en-GB-AdaMultilingualNeural", "Ada", "British, multilingual"),
    ("en-GB-OllieMultilingualNeural", "Ollie", "British, multilingual"),
]

# Delivery per voice: (rate, pitch, volume). A touch lower and barely faster reads as calm and attentive;
# the old global +4% was slightly hurried for a greeting. TTS_RATE / TTS_PITCH / TTS_VOLUME in .env override all.
VOICE_STYLE = {
    "en-GB-SoniaNeural": ("+2%", "-2Hz", "+10%"),
    "en-GB-LibbyNeural": ("+0%", "-3Hz", "+10%"),
    "en-GB-RyanNeural": ("+3%", "+0Hz", "+5%"),
    "en-GB-ThomasNeural": ("+2%", "+0Hz", "+5%"),
    "en-GB-MaisieNeural": ("+0%", "-2Hz", "+10%"),
}
DEFAULT_STYLE = ("+2%", "+0Hz", "+5%")

# Fixed lines the client uses often: synthesised into the cache at start-up so the first sound never waits.
FIXED_LINES = [
    "One moment.", "Checking the files.", "Let me look.",
    "Still here when you need me.", "I haven't said anything yet.",
    "I'm not connected to Claude yet. The setup note is in the chat.",
]

_voice_cache = {"at": 0, "list": None}
_tts_state = {"ok": None, "last_ok": 0.0, "last_fail": 0.0, "fails": 0, "error": ""}
_jobs_lock = threading.Lock()
_jobs = set()   # cache keys being synthesised in the background (deduped)


def tts_ready():
    try:
        import edge_tts  # noqa: F401
        return True
    except ImportError:
        return False


def tts_status():
    """What the hub shows about the voice service: ok (None = untried), last success/failure, error text."""
    s = dict(_tts_state)
    s["provider"] = TTS_PROVIDER
    return s


def current_voice():
    return store.get("tts_voice") or DEFAULT_VOICE


def voice_style(voice):
    rate, pitch, volume = VOICE_STYLE.get(voice, DEFAULT_STYLE)
    return (os.getenv("TTS_RATE") or rate, os.getenv("TTS_PITCH") or pitch, os.getenv("TTS_VOLUME") or volume)


def known_voices():
    """Microsoft's voice list if it has been fetched (data/voices.json, kept 7 days), else None."""
    if _voice_cache["list"] is not None:
        return _voice_cache["list"]
    try:
        if VOICES_FILE.exists() and time.time() - VOICES_FILE.stat().st_mtime < 7 * 86400:
            _voice_cache["list"] = set(json.loads(VOICES_FILE.read_text(encoding="utf-8")))
            return _voice_cache["list"]
    except (ValueError, OSError):
        pass
    return None


def refresh_voice_list():
    """Fetch Microsoft's list once (background). Silent on failure: the fixed list is enough."""
    if known_voices() is not None:
        return
    try:
        import edge_tts
        voices = _run(asyncio.wait_for(edge_tts.list_voices(), timeout=15))
        ids = sorted(v["ShortName"] for v in voices if v.get("ShortName"))
        if ids:
            VOICES_FILE.write_text(json.dumps(ids), encoding="utf-8")
            _voice_cache["list"] = set(ids)
    except Exception as ex:  # no route to Microsoft, or edge-tts missing
        log.debug("Voice list not fetched: %s", ex)


def tts_voices():
    out = [{"id": i, "name": n, "note": d} for i, n, d in VOICES]
    known = known_voices()
    if known:
        out += [{"id": i, "name": n, "note": d} for i, n, d in OPTIONAL_VOICES if i in known]
    cur = current_voice()
    if cur and cur not in {v["id"] for v in out}:
        out.insert(0, {"id": cur, "name": cur.split("-")[-1].replace("Neural", ""), "note": "from .env"})
    return out


def clean_voice(voice):
    """A voice id the hub will accept (from the client), or None. Only known ids: never a raw string to edge-tts."""
    v = re.sub(r"[^A-Za-z0-9-]", "", str(voice or ""))[:60]
    if not v:
        return current_voice()
    if not _VOICE_ID.match(v):
        return None
    allowed = {i for i, _, _ in VOICES} | {i for i, _, _ in OPTIONAL_VOICES} | {current_voice(), DEFAULT_VOICE}
    known = known_voices()
    if v in allowed or (known and v in known):
        return v
    return None


# One asyncio loop in its own thread: no loop/TLS set-up per sentence, and safe from any request thread.
_loop = None
_loop_lock = threading.Lock()


def _get_loop():
    global _loop
    with _loop_lock:
        if _loop is None or _loop.is_closed():
            _loop = asyncio.new_event_loop()
            threading.Thread(target=_loop.run_forever, daemon=True, name="tts-loop").start()
        return _loop


def _run(coro, timeout=40):
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not None and running is _get_loop():
        raise RuntimeError("tts: _run called from inside the voice loop")
    fut = asyncio.run_coroutine_threadsafe(coro, _get_loop())
    try:
        return fut.result(timeout=timeout)
    except BaseException:
        fut.cancel()
        raise


def tts_key(text, voice=None):
    voice = voice or current_voice()
    rate, pitch, _ = voice_style(voice)
    norm = re.sub(r"\s+", " ", (text or "").strip().lower())
    return hashlib.sha256(f"{voice}|{rate}|{pitch}|{norm}".encode("utf-8")).hexdigest()


def _cache_paths(key):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / f"{key}.mp3", CACHE_DIR / f"{key}.json"


def cache_get(key):
    """(mp3 bytes, boundaries list) from the disk cache, or None. Touches the file (LRU by mtime)."""
    mp3, meta = _cache_paths(key)
    try:
        if not mp3.exists():
            return None
        data = mp3.read_bytes()
        if not data:
            return None
        try:
            bounds = json.loads(meta.read_text(encoding="utf-8")) if meta.exists() else []
        except ValueError:
            bounds = []
        os.utime(mp3, None)
        return data, bounds
    except OSError:
        return None


def _cache_put(key, data, bounds):
    mp3, meta = _cache_paths(key)
    try:
        tmp = mp3.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, mp3)
        meta.write_text(json.dumps(bounds), encoding="utf-8")
    except OSError as ex:
        log.debug("tts cache write failed: %s", ex)


def prune_cache(max_mb=None, max_files=None):
    """Keep the cache under TTS_CACHE_MB / 2000 files, dropping the least recently used first."""
    max_bytes = (max_mb if max_mb is not None else TTS_CACHE_MB) * 1024 * 1024
    max_files = max_files if max_files is not None else TTS_CACHE_FILES
    try:
        files = sorted(CACHE_DIR.glob("*.mp3"), key=lambda p: p.stat().st_mtime)
    except OSError:
        return 0
    total = sum(p.stat().st_size for p in files)
    removed = 0
    while files and (total > max_bytes or len(files) > max_files):
        p = files.pop(0)
        try:
            total -= p.stat().st_size
            p.unlink()
            p.with_suffix(".json").unlink(missing_ok=True)
            removed += 1
        except OSError:
            pass
    return removed


def boundaries_header(bounds):
    """X-Word-Boundaries value: base64 of [[offset_ms, duration_ms, text], ...]."""
    return base64.b64encode(json.dumps(bounds, separators=(",", ":")).encode("utf-8")).decode("ascii")


async def _synth_edge(text, voice):
    import edge_tts
    rate, pitch, volume = voice_style(voice)
    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume, boundary="WordBoundary",
                                connect_timeout=5, receive_timeout=12)
    chunks, bounds = [], []
    async for ch in comm.stream():
        if ch["type"] == "audio":
            chunks.append(ch["data"])
        elif ch["type"] == "WordBoundary":
            bounds.append([int(ch["offset"] // 10000), int(ch["duration"] // 10000), str(ch.get("text", ""))[:40]])
    return b"".join(chunks), bounds


def _synth(text, voice):
    """Provider switch. TTS_PROVIDER=openai|azure is designed (see NOTES.md) but not wired yet: edge is used."""
    if TTS_PROVIDER not in ("edge", ""):
        log.debug("TTS_PROVIDER=%s is not available yet; using edge", TTS_PROVIDER)
    return _run(_synth_edge(text, voice), timeout=20)


def tts_speak_full(text, voice=None, cache_only=False):
    """(mp3 bytes, word boundaries, cache key, from_cache). Raises on failure (502 at the route)."""
    text = re.sub(r"\s+", " ", (text or "").strip())[:2500]
    if not text:
        raise ValueError("Nothing to say")
    voice = clean_voice(voice) or current_voice()
    key = tts_key(text, voice)
    hit = cache_get(key)
    if hit:
        return hit[0], hit[1], key, True
    if cache_only:
        return None
    t0 = time.time()
    try:
        data, bounds = _synth(text, voice)
    except Exception as ex:
        _tts_state.update(ok=False, last_fail=time.time(), fails=_tts_state["fails"] + 1, error=_human_error(ex))
        raise
    if not data:
        _tts_state.update(ok=False, last_fail=time.time(), fails=_tts_state["fails"] + 1, error="No audio returned")
        raise RuntimeError("No audio returned")
    _tts_state.update(ok=True, last_ok=time.time(), fails=0, error="")
    _cache_put(key, data, bounds)
    log.debug("tts %d chars in %.0f ms", len(text), (time.time() - t0) * 1000)
    return data, bounds, key, False


def tts_speak(text, voice=None):
    """MP3 bytes for `text` (cache first). Kept for callers that only want audio."""
    return tts_speak_full(text, voice)[0]


def _human_error(ex):
    s = str(ex) or ex.__class__.__name__
    s = re.sub(r"ssl:<[^>]*>", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    if "Cannot connect" in s or "Name or service" in s or "Connect call failed" in s or "timed out" in s.lower():
        return "No route to Microsoft's voice service"
    return s[:140]


def presynth(texts, voice=None):
    """Synthesise sentences into the cache in a background thread (best effort, deduped by key)."""
    if not tts_ready() or not texts:
        return
    voice = clean_voice(voice) or current_voice()
    todo = []
    with _jobs_lock:
        for t in texts:
            t = re.sub(r"\s+", " ", (t or "").strip())
            if not t:
                continue
            k = tts_key(t, voice)
            if k in _jobs or cache_get(k):
                continue
            _jobs.add(k)
            todo.append((t, k))
    if not todo:
        return

    def go():
        try:
            for t, k in todo:
                if _tts_state["fails"] >= 2 and time.time() - _tts_state["last_fail"] < 300:
                    break   # the service is down: do not hammer it from the background
                try:
                    tts_speak_full(t, voice)
                except Exception:
                    break
            prune_cache()
        finally:
            with _jobs_lock:
                for _, k in todo:
                    _jobs.discard(k)
    threading.Thread(target=go, daemon=True, name="tts-presynth").start()


def speech_chunks(text):
    """Server-side mirror of the client's splitter: first sentence alone, then groups of ~140 chars."""
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return []
    abbr = r"\b(Mr|Mrs|Ms|Dr|Prof|Sgt|St|Ltd|Co|No|Ref|approx|v|vs|i\.e|e\.g|etc)\."
    t = re.sub(abbr, lambda m: m.group(0).replace(".", "\u2024"), t)
    t = re.sub(r"(\d)\.(\d)", "\\1\u2024\\2", t)
    parts = [p.strip().replace("\u2024", ".") for p in re.split(r"(?<=[.!?\u2026])\s+", t) if p.strip()]
    if not parts:
        return []
    out, cur = [parts[0]], ""
    for p in parts[1:]:
        if cur and len(cur) + len(p) + 1 > 140:
            out.append(cur)
            cur = p
        else:
            cur = (cur + " " + p).strip()
    if cur:
        out.append(cur)
    return out


def warm_voice(greeting_text=None):
    """At start-up and after a greeting: the fixed lines plus the greeting's chunks into the cache."""
    texts = list(FIXED_LINES)
    if greeting_text:
        texts += speech_chunks(greeting_text)
    presynth(texts)


def voice_startup():
    """Called once by the hub: fetch the voice list and warm the fixed lines, all in the background."""
    if not tts_ready():
        return

    def go():
        refresh_voice_list()
        prune_cache()
        warm_voice()
    threading.Thread(target=go, daemon=True, name="tts-startup").start()

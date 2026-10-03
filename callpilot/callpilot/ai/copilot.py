"""The live call brain.

Pipeline for every caller turn (target timings on a normal connection):

    0 ms     local filler chosen from the caller's intent ("I'm sorry to hear that…")
    <5 ms    instant approved answer if the question matches the hub's Q&A bank
    ~0.5 s   first words of the AI answer (SAY) start streaming
    …        MORE streams in while the agent is already speaking SAY
    end      ASK (questions to collect missing data) + WARN (compliance)

Speculative drafting: while the caller is still talking, once their words stop
changing for a moment the draft starts early. If the final words match, the
draft is kept (saving the whole model round-trip), otherwise it restarts.

This module has no Qt dependency; the UI subscribes through `emit`.
"""

from __future__ import annotations

import difflib
import json
import logging
import re
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

from callpilot.ai.compliance import ComplianceMonitor, classify_intent, pick_filler
from callpilot.ai.providers import Cancelled, LLMProvider
from callpilot.ai.streamparse import is_none, parse_sections, split_questions
from callpilot.ai.translator import Translator, language_name
from callpilot.core.config import Settings
from callpilot.core.models import AGENT, CALLER, Segment, Suggestion
from callpilot.core.redact import redact_payment
from callpilot.hubs.model import Hub

log = logging.getLogger(__name__)

Emit = Callable[[str, object], None]

FORMAT_RULES = """
## Output format (strict)
Reply ONLY with these tagged lines, in this order, no preamble, no markdown:
SAY: <the single most important sentence to say right now – direct answer or next step, max 25 words>
MORE: <what to say next, 1-3 short spoken sentences that complete the answer; 'none' if SAY is enough>
ASK: <up to 2 questions to collect missing required information, separated by ' | '; 'none' if nothing>
WARN: <one short compliance/risk reminder for the agent only if relevant, else 'none'>
{their_rule}
Everything after SAY/MORE/THEIR is spoken aloud by the agent, so write natural spoken language
in first person as the agent. Do not repeat what the agent already said. Do not invent facts,
prices or promises that are not in the knowledge base – if unknown, tell the agent to check/offer a call back.
The agent has ALREADY said a short filler (e.g. "Okay, I understand"), so start SAY with the substance.
"""

THEIR_RULE = ("THEIR: <the SAY and MORE text translated into {lang}, so the agent can read it out "
              "to the caller in their own language>")

EXTRACT_SYSTEM = """You extract structured claim data from a live call transcript.
Return ONLY a JSON object whose keys are exactly: {keys}.
Use a short string value for each key, or "" if not stated yet. Never guess.
Normalise: dates as DD/MM/YYYY HH:MM when known, UK registrations in upper case without spaces."""

SUMMARY_SYSTEM = """You write post-call notes for a contact-centre CRM.
Return ONLY a JSON object with keys:
"summary" (3-6 sentence factual summary), "outcome" (one line), "next_actions" (list of strings),
"follow_up_date" (string or ""), "liability_view" (one of: "non-fault likely", "fault likely",
"disputed", "unclear"), "vulnerability" (string or ""), "compliance_gaps" (list of strings),
"caller_sentiment" (one of: "positive", "neutral", "negative"), "quality_score" (0-100 integer,
how well the agent handled the call against the hub rules), "coaching_tip" (one sentence)."""


def similar(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def extract_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return {}
    try:
        val = json.loads(m.group(0))
        return val if isinstance(val, dict) else {}
    except ValueError:
        return {}


class _Generation:
    def __init__(self, turn_text: str, speculative: bool):
        self.turn_text = turn_text
        self.speculative = speculative
        self.cancel = threading.Event()
        self.started = time.perf_counter()
        self.suggestion: Suggestion | None = None
        self.thread: threading.Thread | None = None


class CallSession:
    def __init__(self, settings: Settings, hub: Hub, provider: LLMProvider | None, emit: Emit,
                 translator: Translator | None = None):
        self.settings = settings
        self.hub = hub
        self.provider = provider
        self.emit = emit
        self.translator = translator or Translator(provider, settings.translation.engine)
        self.matcher = hub.build_matcher()
        self.index = hub.build_index()
        self.monitor = ComplianceMonitor(hub.forbidden_phrases, hub.required_disclosures,
                                         hub.escalation_triggers)
        self.segments: list[Segment] = []
        self.fields: dict[str, str] = {f.key: "" for f in hub.capture_fields}
        self.caller_language = ""
        self.started_at = time.time()
        self.ended_at: float | None = None
        self.summary: dict = {}
        self._system = hub.system_prompt()
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="callpilot")
        self._lock = threading.RLock()
        self._gen: _Generation | None = None
        self._pending_caller: list[str] = []
        self._spec_timer: threading.Timer | None = None
        self._finals_since_extract = 0
        self._turn_counter = 0
        self.suggestions: list[Suggestion] = []

    # ================================================================= input
    def on_transcript(self, speaker: str, text: str, is_final: bool, language: str = "",
                      end_of_turn: bool = True, segment_id: str | None = None) -> Segment:
        seg = Segment(speaker=speaker, text=text.strip(), is_final=is_final, language=language)
        if segment_id:
            seg.id = segment_id
        self.emit("segment", seg)
        if not is_final:
            if speaker == CALLER:
                self._maybe_speculate(" ".join(self._pending_caller + [seg.text]))
            return seg
        if not seg.text:
            if speaker == CALLER and end_of_turn and self._pending_caller:
                self._caller_turn_complete()
            return seg
        with self._lock:
            self.segments.append(seg)
        self._finals_since_extract += 1
        if language and speaker == CALLER:
            self._note_caller_language(language)
        if self.settings.translation.enabled and self.settings.translation.engine != "off":
            self._pool.submit(self._translate_segment, seg)
        if speaker == CALLER:
            for a in self.monitor.check_caller(seg.text):
                self.emit("alert", a)
            self.emit("sentiment", self.monitor.state.sentiment)
            self._pending_caller.append(seg.text)
            if end_of_turn:
                self._caller_turn_complete()
        else:
            for a in self.monitor.check_agent(seg.text):
                self.emit("alert", a)
            self.emit("disclosures", dict(self.monitor.state.disclosures_done))
        if self._finals_since_extract >= max(1, self.settings.ai.extract_every_n_turns):
            self._finals_since_extract = 0
            self._pool.submit(self._extract_fields)
        return seg

    def ask(self, question: str) -> None:
        """Agent typed a question for the co-pilot ("what if they ask about X?")."""
        self._start_generation(f"[Agent asks the co-pilot privately] {question}", speculative=False)

    def regenerate(self) -> None:
        last = next((s.text for s in reversed(self.segments) if s.speaker == CALLER), "")
        if last:
            self._start_generation(last, speculative=False)

    # ================================================================= turn handling
    def _caller_turn_complete(self) -> None:
        text = " ".join(self._pending_caller).strip()
        self._pending_caller = []
        if self._spec_timer:
            self._spec_timer.cancel()
        if not text:
            return
        with self._lock:
            gen = self._gen
            if gen and gen.speculative and not gen.cancel.is_set() and similar(gen.turn_text, text) >= 0.85:
                gen.speculative = False  # adopt the in-flight draft – it already answers this
                log.debug("speculative draft adopted")
                if gen.suggestion is not None:
                    self.emit("suggestion", gen.suggestion)
                    if gen.thread is not None and not gen.thread.is_alive() and gen.suggestion.done:
                        self.suggestions.append(gen.suggestion)
                return
        self._start_generation(text, speculative=False)

    def _maybe_speculate(self, partial: str) -> None:
        if not self.settings.ai.speculative or self.provider is None:
            return
        if len(partial.split()) < 5:
            return
        if self._spec_timer:
            self._spec_timer.cancel()
        self._spec_timer = threading.Timer(0.30, self._start_generation, args=(partial, True))
        self._spec_timer.daemon = True
        self._spec_timer.start()

    def _start_generation(self, turn_text: str, speculative: bool) -> None:
        with self._lock:
            if self._gen:
                if speculative and similar(self._gen.turn_text, turn_text) >= 0.9:
                    return
                self._gen.cancel.set()
            gen = _Generation(turn_text, speculative)
            self._gen = gen
            self._turn_counter += 1
            turn_id = f"t{self._turn_counter}"
        gen.suggestion = sug = Suggestion(turn_id=turn_id)
        # 1) instant local filler
        sug.filler = pick_filler(classify_intent(turn_text), self.hub.fillers)
        # 2) instant approved answer from the hub Q&A bank
        match = self.matcher.match(turn_text)
        if match:
            sug.source = "instant-kb"
            sug.say_now, sug.continue_with = _split_first_sentence(match[1])
        if not speculative:
            self.emit("suggestion", sug)
        if self.provider is None:
            sug.done = True
            if not speculative:
                self.emit("suggestion", sug)
            return
        gen.thread = threading.Thread(target=self._run_generation, args=(gen,), daemon=True,
                                      name="callpilot-suggest")
        gen.thread.start()

    def _context_block(self, turn_text: str) -> str:
        hits = self.index.search(turn_text, k=4)
        filled = {k: v for k, v in self.fields.items() if v}
        labels = {f.key: f.label for f in self.hub.capture_fields}
        missing = [labels[k] for k, v in self.fields.items() if not v and
                   any(f.key == k and f.required for f in self.hub.capture_fields)]
        lines = ["<context>"]
        if hits:
            lines.append("Most relevant knowledge:")
            lines += [f"- {h.text}" for h in hits]
        if filled:
            lines.append("Already captured: " + "; ".join(f"{labels.get(k, k)}={v}" for k, v in filled.items()))
        if missing:
            lines.append("Still missing (required): " + ", ".join(missing))
        md = self.monitor.missing_disclosures()
        if md:
            lines.append("Disclosures not yet made: " + ", ".join(md))
        if self.caller_language:
            lines.append(f"Caller language: {language_name(self.caller_language)}. "
                         f"Agent language: {self.settings.translation.agent_language}.")
        lines.append("</context>")
        return "\n".join(lines)

    def _transcript_block(self, max_turns: int = 24) -> str:
        with self._lock:
            segs = self.segments[-max_turns:]
        rows = []
        for s in segs:
            who = "AGENT" if s.speaker == AGENT else "CALLER"
            txt = s.text
            if s.translation and s.translation != s.text:
                txt += f"  [translation: {s.translation}]"
            rows.append(f"{who}: {txt}")
        return "\n".join(rows)

    def _want_their(self) -> str:
        tr = self.settings.translation
        if not (tr.reply_in_caller_language and self.caller_language):
            return ""
        lang = language_name(self.caller_language)
        if lang.lower() == tr.agent_language.lower():
            return ""
        return lang

    def build_messages(self, turn_text: str) -> tuple[str, list[dict]]:
        their = self._want_their()
        system = self._system + "\n" + FORMAT_RULES.format(
            their_rule=THEIR_RULE.format(lang=their) if their else "")
        user = (f"{self._context_block(turn_text)}\n\n<transcript>\n{self._transcript_block()}\n"
                f"</transcript>\n\nThe caller just said: \"{turn_text}\"\n"
                f"Write the agent's next words in the required format. Agent language: "
                f"{self.settings.translation.agent_language}.")
        if self.settings.privacy.redact_payment_data_before_cloud:
            user = redact_payment(user)
        return system, [{"role": "user", "content": user}]

    def _run_generation(self, gen: _Generation) -> None:
        sug = gen.suggestion
        assert sug is not None
        system, messages = self.build_messages(gen.turn_text)
        buf = ""
        last_emit = 0.0
        instant_say = sug.say_now if sug.source == "instant-kb" else ""
        instant_more = sug.continue_with if sug.source == "instant-kb" else ""
        try:
            for delta in self.provider.stream(system, messages, self.settings.ai.suggestion_max_tokens,
                                              cancel=gen.cancel, fast=True):
                if not buf:
                    sug.first_token_ms = (time.perf_counter() - gen.started) * 1000
                buf += delta
                now = time.perf_counter()
                if now - last_emit > 0.04:
                    last_emit = now
                    self._apply_sections(sug, buf, instant_say, instant_more)
                    if not gen.speculative:
                        self.emit("suggestion", sug)
        except Cancelled:
            return
        except Exception as e:  # noqa: BLE001 - surface any provider/network error to the UI
            log.exception("suggestion failed")
            self.emit("error", f"AI suggestion failed: {e}")
            sug.done = True
            self.emit("suggestion", sug)
            return
        if gen.cancel.is_set():
            return
        self._apply_sections(sug, buf, instant_say, instant_more)
        sug.done = True
        sug.total_ms = (time.perf_counter() - gen.started) * 1000
        # A speculative draft that was never adopted is silently dropped; if it was
        # adopted (speculative flipped to False) it is published now in full.
        if gen.speculative:
            # Wait briefly in case the caller's turn completes and adopts it.
            deadline = time.time() + 4.0
            while gen.speculative and time.time() < deadline and not gen.cancel.is_set():
                time.sleep(0.05)
            if gen.speculative or gen.cancel.is_set():
                return
        with self._lock:
            self.suggestions.append(sug)
        self.emit("suggestion", sug)
        self.emit("latency", {"first_token_ms": round(sug.first_token_ms), "total_ms": round(sug.total_ms)})

    def _apply_sections(self, sug: Suggestion, buf: str, instant_say: str, instant_more: str) -> None:
        sec = parse_sections(buf)
        say = sec.get("SAY", "")
        more = sec.get("MORE", "")
        if instant_say:
            # The approved wording stays on screen; the AI adds context-specific follow-on.
            sug.say_now = instant_say
            extra = more if not is_none(more) else ""
            sug.continue_with = " ".join(p for p in (instant_more, extra) if p).strip()
        else:
            sug.say_now = say
            sug.continue_with = "" if is_none(more) else more
        sug.ask_next = split_questions(sec.get("ASK", ""))
        warn = sec.get("WARN", "")
        sug.warnings = [] if is_none(warn) else [warn]
        sug.translated = sec.get("THEIR", "")

    # ================================================================= background jobs
    def _note_caller_language(self, lang: str) -> None:
        lang = lang.lower().split("-")[0]
        if lang and lang != self.caller_language:
            self.caller_language = lang
            self.emit("language", lang)

    def _translate_segment(self, seg: Segment) -> None:
        tr = self.settings.translation
        target = tr.agent_language
        if seg.speaker == AGENT:
            if not self.caller_language or language_name(self.caller_language).lower() == target.lower():
                return
            target = language_name(self.caller_language)
        try:
            src, out = self.translator.translate(seg.text, target)
        except Exception as e:  # noqa: BLE001
            self.emit("error", f"Translation failed: {e}")
            return
        if seg.speaker == CALLER and src:
            self._note_caller_language(src)
            seg.language = seg.language or src
        if out and out.strip() != seg.text.strip():
            seg.translation = out
            self.emit("segment", seg)

    def _extract_fields(self) -> None:
        if self.provider is None or not self.hub.capture_fields:
            return
        keys = [f.key for f in self.hub.capture_fields]
        hints = "\n".join(f"- {f.key}: {f.label} {('(' + f.hint + ')') if f.hint else ''}"
                          for f in self.hub.capture_fields)
        transcript = self._transcript_block(max_turns=200)
        if self.settings.privacy.redact_payment_data_before_cloud:
            transcript = redact_payment(transcript)
        try:
            out = self.provider.complete(
                EXTRACT_SYSTEM.format(keys=", ".join(keys)),
                [{"role": "user", "content": f"Fields:\n{hints}\n\nTranscript:\n{transcript}"}],
                3000, fast=True)
        except Exception as e:  # noqa: BLE001
            log.warning("field extraction failed: %s", e)
            return
        data = extract_json(out)
        changed = False
        for k in keys:
            v = str(data.get(k, "") or "").strip()
            if v and v != self.fields.get(k):
                self.fields[k] = v
                changed = True
        if changed:
            self.emit("fields", dict(self.fields))

    # ================================================================= end of call
    def end(self, summarize: bool = True) -> dict:
        self.ended_at = time.time()
        if self._spec_timer:
            self._spec_timer.cancel()
        if self._gen:
            self._gen.cancel.set()
        if summarize and self.provider is not None and self.segments:
            self._extract_fields()
            transcript = self._transcript_block(max_turns=1000)
            if self.settings.privacy.redact_payment_data_before_cloud:
                transcript = redact_payment(transcript)
            try:
                out = self.provider.complete(
                    SUMMARY_SYSTEM,
                    [{"role": "user", "content":
                        "Hub rules:\n" + "\n".join(f"- {r}" for r in self.hub.rules) +
                        f"\n\nCaptured fields: {json.dumps(self.fields)}\n"
                        f"Disclosures made: {json.dumps(self.monitor.state.disclosures_done)}\n\n"
                        f"Transcript:\n{transcript}"}],
                    8000, fast=False)
                self.summary = extract_json(out) or {"summary": out.strip()}
            except Exception as e:  # noqa: BLE001
                self.summary = {"summary": "", "error": str(e)}
            self.emit("summary", self.summary)
        self._pool.shutdown(wait=False, cancel_futures=True)
        return self.summary

    def to_record(self) -> dict:
        return {
            "hub_id": self.hub.id, "hub_name": self.hub.name,
            "started_at": self.started_at, "ended_at": self.ended_at,
            "caller_language": self.caller_language,
            "segments": [s.to_dict() for s in self.segments],
            "fields": self.fields, "summary": self.summary,
            "alerts": self.monitor.state.alerts,
            "disclosures": self.monitor.state.disclosures_done,
            "suggestions": [{"turn": s.turn_id, "text": s.full_text(), "source": s.source,
                             "first_token_ms": round(s.first_token_ms)} for s in self.suggestions],
        }


def _split_first_sentence(text: str) -> tuple[str, str]:
    m = re.match(r"(.+?[.!?])\s+(.*)", text.strip(), re.S)
    if not m:
        return text.strip(), ""
    return m.group(1).strip(), m.group(2).strip()

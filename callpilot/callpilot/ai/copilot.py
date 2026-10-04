"""The live call brain.

For every final transcript line:

    <1 ms   entities extracted on-device (dates, deadlines, figures, regs, admissions, allegations)
            -> chips in the transcript line, pins into the chronology, 10 s audio clip saved
    <1 ms   rule cards from the trigger table (injury, fraud, authority, offer, distress…)
    <5 ms   approved answer from the hub's Q&A bank -> instant Say card
    ~0.5 s  the fast model's SAY streams in; MORE / ASK / WATCH / SOURCE follow
    end     every card is logged with shown / used / dismissed / ignored

Speculative drafting starts the model while the caller is still finishing; if
their final words match, the draft is adopted and a whole round-trip is saved.
At most three cards are on screen (ask / say / watch). This module has no Qt
dependency; the UI subscribes through `emit`.
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

from callpilot.ai import pins as pinx
from callpilot.ai.cards import CardDeck, RuleContext, banned_filter, rule_cards
from callpilot.ai.compliance import ComplianceMonitor, classify_intent, pick_filler
from callpilot.ai.copilot_prompts import EXTRACT_SYSTEM, LIVE_FORMAT, THEIR_RULE
from callpilot.ai.providers import Cancelled, LLMProvider
from callpilot.ai.streamparse import is_none, parse_sections, split_questions
from callpilot.ai.translator import Translator, language_name
from callpilot.core.config import Settings
from callpilot.core.models import AGENT, ASK, CALLER, SAY, WATCH, Card, Pin, Segment, Task
from callpilot.core.redact import redact_payment
from callpilot.hubs.model import Hub

log = logging.getLogger(__name__)

Emit = Callable[[str, object], None]

THIRD_PARTY_TYPES = {"handler", "engineer", "bodyshop", "council", "solicitor"}


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
    def __init__(self, turn_text: str, speculative: bool, segment_id: str):
        self.turn_text = turn_text
        self.speculative = speculative
        self.segment_id = segment_id
        self.cancel = threading.Event()
        self.started = time.perf_counter()
        self.say: Card | None = None
        self.ask: Card | None = None
        self.watch: Card | None = None
        self.thread: threading.Thread | None = None
        self.published = False
        self.failed = False
        self.first_token_ms = 0.0

    def usable(self) -> bool:
        """A draft can be adopted only while it is streaming or finished cleanly."""
        if self.failed or self.cancel.is_set():
            return False
        if self.thread is not None and self.thread.is_alive():
            return True
        return self.say is not None and self.say.done


class CallSession:
    def __init__(self, settings: Settings, hub: Hub, provider: LLMProvider | None, emit: Emit,
                 translator: Translator | None = None, case_file=None, call_type: str = "",
                 recorder=None, call_id: str = "", memory=None, business=None):
        self.settings = settings
        self.hub = hub
        self.business = business
        self.provider = provider
        self.emit = emit
        self.case_file = case_file
        self.call_type = call_type
        self.third_party = call_type in THIRD_PARTY_TYPES
        self.recorder = recorder
        self.call_id = call_id or f"call-{int(time.time())}"
        self.translator = translator or Translator(provider, settings.translation.engine)
        self.memory = memory if (memory is not None and settings.ai.use_memory) else None
        self.matcher = hub.build_matcher()
        self.learned_matcher = self.memory.matcher(hub.id) if self.memory is not None else None
        self.index = hub.build_index()
        self.monitor = ComplianceMonitor(hub.forbidden_phrases, hub.required_disclosures,
                                         hub.escalation_triggers)
        self.segments: list[Segment] = []
        self.fields: dict[str, str] = {f.key: "" for f in hub.capture_fields}
        self.field_sources: dict[str, str] = {}
        self.confirmed_fields: set[str] = set()
        if case_file is not None and getattr(case_file, "intake", None):
            for k, v in case_file.intake.items():
                if k in self.fields and v:
                    self.fields[k] = v
        self.pins: list[Pin] = []
        self.tasks: list[Task] = []
        self.cards_log: list[Card] = []
        self.deck = CardDeck(self._deck_changed, self.cards_log)
        self.caller_language = ""
        self.started_at = time.time()
        self.ended_at: float | None = None
        self.notice_given_at: float | None = None
        self.summary: dict = {}
        self.banned = list(hub.forbidden_phrases) + list(getattr(business, "banned_phrases", []) or [])
        self.turn_listeners: list = []   # callables(turn_text, segment_id) – e.g. the AI voice agent
        subject = (case_file.client_name if case_file is not None else "") or ""
        self._system_blocks = [self._hub_block(), case_file.summary_for_prompt() if case_file else "",
                               self.memory.prompt_block(hub.id, subject) if self.memory is not None else ""]
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="callpilot")
        self._lock = threading.RLock()
        self._gen: _Generation | None = None
        self._pending_caller: list[str] = []
        self._pending_ids: list[str] = []
        self._spec_timer: threading.Timer | None = None
        self._finals_since_extract = 0
        self._turn_counter = 0
        self._ended = False
        self._last_interim = ""
        if self.third_party and case_file is not None and not case_file.has_signed_authority():
            self.deck.show(Card(WATCH, "No signed authority on file – confirm identity and authority before "
                                       "discussing the file.", ["rule:authority"], pinned_top=True, origin="rule"))

    # ================================================================= prompt blocks
    def _hub_block(self) -> str:
        text = self.hub.system_prompt(business=self.business)
        ct = (getattr(self.hub, "call_types", {}) or {}).get(self.call_type)
        if ct:
            text += f"\n\n## This call type: {self.call_type.replace('_', ' ')}\n{ct}"
        return text

    # ================================================================= input
    def on_transcript(self, speaker: str, text: str, is_final: bool, language: str = "",
                      end_of_turn: bool = True, segment_id: str | None = None) -> Segment:
        seg = Segment(speaker=speaker, text=text.strip(), is_final=is_final, language=language)
        if segment_id:
            seg.id = segment_id
        if not is_final:
            self.emit("segment", seg)
            if speaker == CALLER:
                self._maybe_speculate(" ".join(self._pending_caller + [seg.text]), seg.id)
            return seg
        if not seg.text:
            self.emit("segment", seg)
            if speaker == CALLER and end_of_turn and self._pending_caller:
                self._caller_turn_complete()
            return seg
        # -- on-device extraction first, so chips land with the line
        ents = pinx.extract(seg.text, seg.start)
        seg.entities = [(e.kind, e.text) for e in ents]
        with self._lock:
            self.segments.append(seg)
        self.emit("segment", seg)
        for e in pinx.worth_pinning(ents):
            self._add_pin(Pin(e.kind, e.value, e.text if e.kind in ("figure", "deadline") else seg.text,
                              seg.id, speaker, due_at=e.due), seg)
        self._finals_since_extract += 1
        if language and speaker == CALLER:
            self._note_caller_language(language)
        if self.settings.translation.enabled and self.settings.translation.engine != "off":
            self._pool.submit(self._translate_segment, seg)
        # -- rules (instant cards)
        ctx = RuleContext(speaker=speaker, call_type=self.call_type, third_party=self.third_party,
                          signed_authority=(self.case_file.has_signed_authority() if self.case_file else None),
                          missing_fields=self.missing_required(), earlier_values=dict(self.fields))
        for c in rule_cards(seg.text, ents, ctx):
            c.segment_id = seg.id
            self._show_card(c)
        if speaker == CALLER:
            for a in self.monitor.check_caller(seg.text):
                self.emit("alert", a)
            self.emit("sentiment", self.monitor.state.sentiment)
            self._pending_caller.append(seg.text)
            self._pending_ids.append(seg.id)
            if end_of_turn:
                self._caller_turn_complete()
        else:
            for a in self.monitor.check_agent(seg.text):
                self.emit("alert", a)
            self._disclosures_changed()
        if self._finals_since_extract >= max(1, self.settings.ai.extract_every_n_turns):
            self._finals_since_extract = 0
            self._pool.submit(self._extract_fields)
        return seg

    def ask(self, question: str) -> None:
        """Operator typed a question for the AI ("caller wants a 7-seater, what do I say?")."""
        self._start_generation(f"[Handler asks the assistant privately] {question}", speculative=False,
                               segment_id="")

    def regenerate(self) -> None:
        last = next((s for s in reversed(self.segments) if s.speaker == CALLER), None)
        if last:
            self._start_generation(last.text, speculative=False, segment_id=last.id)

    # ================================================================= operator actions
    def mark_card(self, card_type: str | None, action: str) -> Card | None:
        return self._feedback(self.deck.mark(card_type, action), action)

    def mark_this(self, card: Card, action: str) -> Card:
        """Mark the card the handler acted on (the one on screen), never whatever now holds its slot."""
        return self._feedback(self.deck.mark_card(card, action), action)

    def _feedback(self, c: Card | None, action: str) -> Card | None:
        if c is not None and c.type == SAY and self.memory is not None and action in ("used", "dismissed"):
            q = next((s.text for s in self.segments if s.id == c.segment_id), "")
            if q:
                try:
                    self.memory.feedback(q, c.spoken(), action == "used", self.hub.id, self.call_id)
                except Exception:  # noqa: BLE001
                    log.exception("memory feedback failed")
        return c

    def pin_last_line(self) -> Pin | None:
        seg = next((s for s in reversed(self.segments)), None)
        if not seg:
            return None
        pin = Pin("pinned", seg.text[:80], seg.text, seg.id, seg.speaker)
        self._add_pin(pin, seg)
        return pin

    def add_task(self, title: str, due_at: str = "", owner: str = "us") -> Task:
        seg = next((s for s in reversed(self.segments)), None)
        t = Task(title=title, due_at=due_at, owner=owner, source_segment_id=seg.id if seg else "")
        self.tasks.append(t)
        self.emit("task", t)
        return t

    def set_field(self, key: str, value: str, confirmed: bool | None = None) -> None:
        self.fields[key] = value
        if confirmed is True:
            self.confirmed_fields.add(key)
        elif confirmed is False:
            self.confirmed_fields.discard(key)
        self.emit("fields", self.fields_payload())
        self.emit("need", self.missing_required())

    def add_agent_line(self, text: str, language: str = "") -> Segment:
        """A line the AI employee spoke (AI mode) – goes into the transcript as 'us'."""
        seg = Segment(speaker=AGENT, text=text.strip(), is_final=True, language=language)
        with self._lock:
            self.segments.append(seg)
        self.emit("segment", seg)
        for a in self.monitor.check_agent(seg.text):
            self.emit("alert", a)
        self._disclosures_changed()
        return seg

    def notice_given(self) -> None:
        if self.notice_given_at is None:
            self.notice_given_at = time.time()
            for d in self.monitor.state.disclosures_done:
                if "record" in d.lower():
                    self.monitor.state.disclosures_done[d] = True
            self._disclosures_changed()

    def missing_required(self) -> list[str]:
        return [f.label for f in self.hub.capture_fields if f.required and not self.fields.get(f.key, "").strip()]

    def fields_payload(self) -> dict:
        return {"values": dict(self.fields), "sources": dict(self.field_sources),
                "confirmed": sorted(self.confirmed_fields)}

    # ================================================================= internals
    def _disclosures_changed(self) -> None:
        done = dict(self.monitor.state.disclosures_done)
        if self.notice_given_at is None and any(ok and "record" in d.lower() for d, ok in done.items()):
            self.notice_given_at = time.time()
        self.emit("disclosures", done)
        self.emit("notice", self.notice_given_at is not None)

    def _add_pin(self, pin: Pin, seg: Segment) -> None:
        if any(p.segment_id == pin.segment_id and p.kind == pin.kind and p.value == pin.value for p in self.pins):
            return
        if self.recorder is not None and self.settings.recording.clips:
            try:
                p = self.recorder.clip(f"{self.call_id}-{pin.id}")
                pin.clip_path = str(p) if p else ""
            except Exception:  # noqa: BLE001
                log.exception("clip failed")
        seg.pinned = True
        self.pins.append(pin)
        self.emit("pin", pin)
        self.emit("segment", seg)

    def _deck_changed(self) -> None:
        self.emit("cards", self.deck.visible())

    def _show_card(self, card: Card) -> None:
        clean, hits = banned_filter(card.text, self.banned)
        if hits:
            log.info("banned phrase removed from card: %s", hits)
            card.text = clean
            card.sources = card.sources + ["filtered"]
        if card.more:
            card.more, _ = banned_filter(card.more, self.banned)
        self.deck.show(card)

    # ================================================================= turn handling
    def _caller_turn_complete(self) -> None:
        text = " ".join(self._pending_caller).strip()
        seg_id = self._pending_ids[-1] if self._pending_ids else ""
        self._pending_caller = []
        self._pending_ids = []
        if self._spec_timer:
            self._spec_timer.cancel()
        if not text:
            return
        adopted = False
        with self._lock:
            gen = self._gen
            if gen and gen.speculative and gen.usable() and similar(gen.turn_text, text) >= 0.85:
                gen.speculative = False  # adopt the in-flight draft – it already answers this
                gen.segment_id = seg_id
                log.debug("speculative draft adopted")
                self._surface(gen)
                if gen.say is not None and gen.say.done:
                    self._publish(gen)
                adopted = True
        if not adopted:
            self._start_generation(text, speculative=False, segment_id=seg_id)
        for cb in list(self.turn_listeners):   # AI mode etc. hear every completed turn, adopted or not
            try:
                cb(text, seg_id)
            except Exception:  # noqa: BLE001
                log.exception("turn listener failed")

    def _surface(self, gen: _Generation) -> None:
        """Put a generation's cards on the deck (used when a speculative draft is adopted)."""
        for c in (gen.say, gen.ask, gen.watch):
            if c is not None and c.text:
                c.segment_id = gen.segment_id
                self._show_card(c)

    def _publish(self, gen: _Generation) -> None:
        with self._lock:
            if gen.published:
                return
            gen.published = True
        self.emit("latency", {"first_token_ms": round(gen.first_token_ms),
                              "total_ms": round((time.perf_counter() - gen.started) * 1000)})

    def _maybe_speculate(self, partial: str, seg_id: str) -> None:
        if not self.settings.ai.speculative or self.provider is None:
            return
        if len(partial.split()) < 5:
            return
        if self._spec_timer:
            self._spec_timer.cancel()
        self._spec_timer = threading.Timer(0.30, self._start_generation,
                                           args=(partial, True, seg_id, self._turn_counter))
        self._spec_timer.daemon = True
        self._spec_timer.start()

    def _start_generation(self, turn_text: str, speculative: bool, segment_id: str,
                          expected_turn: int | None = None) -> None:
        with self._lock:
            if self._ended:
                return
            if speculative and expected_turn is not None and expected_turn != self._turn_counter:
                return  # a late timer from a turn that has already moved on
            if self._gen:
                if speculative:
                    live = self._gen.say
                    if not self._gen.speculative and not self._gen.cancel.is_set() and live is not None and not live.done:
                        return  # a draft must never interrupt a real answer that is being written
                    if self._gen.usable() and similar(self._gen.turn_text, turn_text) >= 0.9:
                        return
                self._gen.cancel.set()
            gen = _Generation(turn_text, speculative, segment_id)
            self._gen = gen
            self._turn_counter += 1
        intent = classify_intent(turn_text)
        say = Card(SAY, "", [], segment_id=segment_id, done=False, origin="llm")
        say.filler = pick_filler(intent, self.hub.fillers)
        match = self.learned_matcher.match(turn_text, threshold=0.6) if self.learned_matcher else None
        if match:
            say.origin = "playbook"
            say.sources = [f"memory: {match[0][:60]}"]
            say.text, say.more = _split_first_sentence(match[1])
        else:
            match = self.matcher.match(turn_text)
            if match:
                say.origin = "playbook"
                say.sources = [f"Q&A: {match[0][:60]}"]
                say.text, say.more = _split_first_sentence(match[1])
        gen.say = say
        if self.provider is None:
            say.done = True
        if not speculative and (match or self.provider is None):
            self._show_card(say)
        if self.provider is None:
            return
        gen.thread = threading.Thread(target=self._run_generation, args=(gen,), daemon=True,
                                      name="callpilot-cards")
        gen.thread.start()

    # ---------------------------------------------------------------- prompt assembly
    def _context_block(self, turn_text: str) -> str:
        hits = self.index.search(turn_text, k=4)
        labels = {f.key: f.label for f in self.hub.capture_fields}
        filled = {labels.get(k, k): v for k, v in self.fields.items() if v}
        lines = ["<context>"]
        if hits:
            lines.append("Retrieved playbook extracts:")
            lines += [f"- {h.text}" for h in hits]
        if filled:
            lines.append("Intake captured: " + "; ".join(f"{k}={v}" for k, v in list(filled.items())[:25]))
        missing = self.missing_required()
        if missing:
            lines.append("Intake still missing (required): " + ", ".join(missing))
        md = self.monitor.missing_disclosures()
        if md:
            lines.append("Disclosures not yet made: " + ", ".join(md))
        if self.pins:
            lines.append("Pinned so far: " + "; ".join(f"{p.kind}: {p.value}" for p in self.pins[-8:]))
        if self.memory is not None:
            hits = self.memory.search(self.hub.id, turn_text, k=3)
            if hits:
                lines.append("From memory of past calls:")
                lines += [f"- ({e.kind}) " + (f"Q: {e.question} -> A: {e.text}" if e.question else e.text) for e in hits]
        if self.caller_language:
            lines.append(f"Caller language: {language_name(self.caller_language)}. "
                         f"Handler language: {self.settings.translation.agent_language}.")
        who = "a third party (insurer handler / engineer / supplier)" if self.third_party else "the client / caller"
        lines.append(f"The other party on this call is {who}.")
        lines.append("</context>")
        return "\n".join(lines)

    def _transcript_block(self, window_s: float | None = None, max_turns: int = 0) -> str:
        with self._lock:
            segs = list(self.segments)
        if window_s:
            cutoff = time.time() - window_s
            recent = [s for s in segs if s.start >= cutoff]
            if len(recent) < 4:
                recent = segs[-4:]
            segs = recent
        elif max_turns:
            segs = segs[-max_turns:]
        rows = []
        for s in segs:
            who = "US" if s.speaker == AGENT else "CALLER"
            t = time.strftime("%H:%M:%S", time.localtime(s.start))
            txt = s.text
            if s.translation and s.translation != s.text:
                txt += f"  [translation: {s.translation}]"
            rows.append(f"[{s.id} {t}] {who}: {txt}")
        return "\n".join(rows)

    def _want_their(self) -> str:
        tr = self.settings.translation
        if not (tr.reply_in_caller_language and self.caller_language):
            return ""
        lang = language_name(self.caller_language)
        return "" if lang.lower() == tr.agent_language.lower() else lang

    def build_messages(self, turn_text: str) -> tuple[list[str], list[dict]]:
        their = self._want_their()
        window = int(self.settings.ai.context_window_s or 90)
        fmt = LIVE_FORMAT.format(window=window, their_rule=THEIR_RULE.format(lang=their) if their else "")
        system = [self._system_blocks[0] + "\n" + fmt, self._system_blocks[1], self._system_blocks[2]]
        user = (f"{self._context_block(turn_text)}\n\n<transcript>\n{self._transcript_block(window_s=window)}\n"
                f"</transcript>\n\nThe other party just said: \"{turn_text}\"\n"
                f"Write the cards in the required format. Handler language: "
                f"{self.settings.translation.agent_language}.")
        if self.settings.privacy.redact_payment_data_before_cloud:
            user = redact_payment(user)
        return system, [{"role": "user", "content": user}]

    # ---------------------------------------------------------------- streaming
    def _run_generation(self, gen: _Generation) -> None:
        say = gen.say
        assert say is not None
        system, messages = self.build_messages(gen.turn_text)
        buf = ""
        last_emit = 0.0
        instant = (say.text, say.more) if say.origin == "playbook" else None
        try:
            for delta in self.provider.stream(system, messages, self.settings.ai.suggestion_max_tokens,
                                              cancel=gen.cancel, fast=True):
                if not buf:
                    gen.first_token_ms = (time.perf_counter() - gen.started) * 1000
                buf += delta
                now = time.perf_counter()
                if now - last_emit > 0.04:
                    last_emit = now
                    self._apply_sections(gen, buf, instant, final=False)
        except Cancelled:
            say.done = True  # never leave a half card marked "writing…"
            if self.deck.slots[SAY] is say:
                self.deck.update(say)
            return
        except Exception as e:  # noqa: BLE001 - surface any provider/network error to the UI
            log.exception("cards failed")
            gen.failed = True
            gen.cancel.set()
            say.done = True
            if gen.speculative:
                return  # a failed background draft must not blank what is on screen, nor be adopted
            self.emit("error", f"AI cards failed: {e}")
            if say.text:
                self.deck.update(say)
            return
        if gen.cancel.is_set():
            say.done = True
            return
        self._apply_sections(gen, buf, instant, final=True)
        if gen.speculative:
            deadline = time.time() + 4.0
            while gen.speculative and time.time() < deadline and not gen.cancel.is_set():
                time.sleep(0.05)
            if gen.speculative or gen.cancel.is_set():
                gen.cancel.set()  # unadopted: never adoptable later, never blocks the next draft
                return
        self._publish(gen)

    def _apply_sections(self, gen: _Generation, buf: str, instant, final: bool) -> None:
        if self._ended:
            return
        sec = parse_sections(buf)
        say = gen.say
        assert say is not None
        s_txt, more = sec.get("SAY", ""), sec.get("MORE", "")
        src = sec.get("SOURCE", "")
        sources = [s.strip() for s in re.split(r"\s*[|;]\s*", src) if s.strip() and not is_none(s)] if src else []
        if instant:
            say.text = instant[0]
            extra = "" if is_none(more) else more
            say.more = _grow(say.more, " ".join(p for p in (instant[1], extra) if p).strip())
            say.sources = list(dict.fromkeys(say.sources + sources))
        else:
            # Append-only: once words are on screen they never change; the model can only add.
            say.text = _grow(say.text, "" if is_none(s_txt) else s_txt)
            say.more = _grow(say.more, "" if is_none(more) else more)
            say.sources = sources or (["model"] if final else [])
        say.translated = sec.get("THEIR", "")
        say.done = final
        if say.text and not gen.speculative:
            if self.deck.slots[SAY] is say:
                self.deck.update(say)
            elif not say.action:  # a card the operator used/dismissed must not pop back
                say.segment_id = gen.segment_id
                self._show_card(say)
        asks = split_questions(sec.get("ASK", ""))
        if asks and not gen.speculative and ("ASK" in sec) and (final or "WATCH" in sec):
            if gen.ask is None:
                gen.ask = Card(ASK, " | ".join(asks[:2]), sources or ["intake"], segment_id=gen.segment_id,
                               origin="llm")
                self._show_card(gen.ask)
            elif gen.ask.text != " | ".join(asks[:2]) and not gen.ask.action:
                gen.ask.text = " | ".join(asks[:2])
                self.deck.update(gen.ask)
        elif asks and gen.speculative and gen.ask is None and final:
            gen.ask = Card(ASK, " | ".join(asks[:2]), sources or ["intake"], segment_id=gen.segment_id, origin="llm")
        watch = sec.get("WATCH", "")
        if watch and not is_none(watch) and ("SOURCE" in sec or final):
            if gen.watch is None:
                gen.watch = Card(WATCH, watch, sources or ["model"], segment_id=gen.segment_id, origin="llm")
                if not gen.speculative:
                    self._show_card(gen.watch)
            elif gen.watch.text != watch and not gen.watch.action:
                gen.watch.text = watch
                self.deck.update(gen.watch)

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
                4000, fast=True)
        except Exception as e:  # noqa: BLE001
            log.warning("field extraction failed: %s", e)
            return
        data = extract_json(out)
        values = data.get("fields") if isinstance(data.get("fields"), dict) else data
        srcs = data.get("field_sources") if isinstance(data.get("field_sources"), dict) else {}
        changed = False
        for k in keys:
            if k in self.confirmed_fields:
                continue  # the operator's confirmed value wins
            v = str((values or {}).get(k, "") or "").strip()
            if v and v != self.fields.get(k):
                self.fields[k] = v
                if srcs.get(k):
                    self.field_sources[k] = str(srcs[k])
                changed = True
        if changed:
            self.emit("fields", self.fields_payload())
            self.emit("need", self.missing_required())
        seg_by_id = {s.id: s for s in self.segments}
        for p in data.get("pins", []) or []:
            if not isinstance(p, dict) or not p.get("quote"):
                continue
            seg = seg_by_id.get(str(p.get("segment_id", "")))
            if seg is None:
                seg = next((s for s in self.segments if p["quote"][:30].lower() in s.text.lower()), None)
            if seg is None:
                continue
            kind = str(p.get("kind", "commitment"))
            if kind not in ("date", "deadline", "commitment", "figure", "admission", "allegation"):
                continue
            self._add_pin(Pin(kind, str(p.get("value", ""))[:80], str(p["quote"]), seg.id, seg.speaker,
                              due_at=str(p.get("due_at", "") or "")), seg)

    # ================================================================= end of call
    def end(self, summarize: bool = True) -> dict:
        self.ended_at = time.time()
        with self._lock:
            self._ended = True
        if self._spec_timer:
            self._spec_timer.cancel()
        if self._gen:
            self._gen.cancel.set()
        self.deck.clear()
        if summarize and self.provider is not None and self.segments:
            from callpilot.ai.wrapup import run_wrapup

            self._extract_fields()
            try:
                self.summary = run_wrapup(
                    self.provider, business=self.hub.company or self.hub.name, hub_rules=self.hub.rules,
                    status_line=getattr(self.hub, "status_line", "") or "", call_type=self.call_type,
                    transcript_rows=[s.to_dict() for s in self.segments], pins=[p.to_dict() for p in self.pins],
                    intake=self.fields, file_summary=self._system_blocks[1],
                    disclosures=dict(self.monitor.state.disclosures_done), banned=self.banned,
                    agent_name=self.settings.agent_name, call_started=self.started_at,
                    required_keys=[f.key for f in self.hub.capture_fields if f.required])
            except Exception as e:  # noqa: BLE001
                log.exception("wrap-up failed")
                self.summary = {"summary": "", "error": str(e)}
            self.emit("summary", self.summary)
        self._pool.shutdown(wait=False, cancel_futures=True)
        return self.summary

    def to_record(self) -> dict:
        return {
            "call_id": self.call_id, "hub_id": self.hub.id, "hub_name": self.hub.name,
            "call_type": self.call_type, "file_id": getattr(self.case_file, "id", "") if self.case_file else "",
            "started_at": self.started_at, "ended_at": self.ended_at,
            "notice_given_at": self.notice_given_at,
            "caller_language": self.caller_language,
            "segments": [s.to_dict() for s in self.segments],
            "fields": self.fields, "field_sources": self.field_sources,
            "field_labels": {f.key: f.label for f in self.hub.capture_fields},
            "confirmed_fields": sorted(self.confirmed_fields),
            "pins": [p.to_dict() for p in self.pins],
            "tasks": [t.to_dict() for t in self.tasks],
            "summary": self.summary,
            "alerts": self.monitor.state.alerts,
            "disclosures": self.monitor.state.disclosures_done,
            "ai_cards": [c.to_dict() for c in self.cards_log],
            "recording": str(self.recorder.path) if self.recorder is not None else "",
            "recording_pauses": list(self.recorder.pauses) if self.recorder is not None else [],
        }


def _grow(shown: str, new: str) -> str:
    """Return text that keeps everything already shown and only appends.

    If the new text extends the shown text, use it. If the model re-wrote an
    earlier word, anchor on the last words the reader has seen and append only
    what follows them, so the reader's eye is never pulled back to the start.
    """
    if not shown:
        return new
    if not new or new == shown:
        return shown
    if new.startswith(shown):
        return new
    words = shown.split()
    for k in (4, 3, 2):
        if len(words) >= k:
            anchor = " ".join(words[-k:])
            idx = new.rfind(anchor)
            if idx >= 0:
                tail = new[idx + len(anchor):].strip()
                return (shown.rstrip() + " " + tail) if tail else shown
    return shown


def _split_first_sentence(text: str) -> tuple[str, str]:
    m = re.match(r"(.+?[.!?])\s+(.*)", text.strip(), re.S)
    if not m:
        return text.strip(), ""
    return m.group(1).strip(), m.group(2).strip()

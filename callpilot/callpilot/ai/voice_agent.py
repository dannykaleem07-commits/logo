"""AI mode: a named member of the team takes the call in a realistic voice.

How it works
------------
* The caller's words still arrive through the normal transcript pipeline.
* When the caller's turn ends, the agent writes a spoken reply (fast model,
  hub + business + memory, the handler's own phrasing from past calls), speaks
  it through the chosen output device, and adds it to the transcript as "us".
* Output device: on a real call this is a virtual cable (e.g. VB-Audio
  "CABLE Input") that WhatsApp/Teams uses as its microphone. In rehearsal it is
  your speakers and you play the caller through your mic.
* Barge-in: if the caller starts talking while the agent is speaking, the
  speech stops and the agent listens.
* Hand-off: on escalation words, distress, a request for a person, or anything
  outside the playbook, the agent says a hand-off line and the app asks you to
  take over. You can take over at any moment with one click.
* Honesty: it never volunteers that it is automated, but if the caller asks
  directly whether they are speaking to a person it answers truthfully.
"""

from __future__ import annotations

import logging
import re
import threading

from callpilot.ai import tts
from callpilot.ai.cards import banned_filter
from callpilot.ai.providers import Cancelled
from callpilot.core.redact import redact_payment

log = logging.getLogger(__name__)

HUMAN_Q = re.compile(r"\b(are you (a |an )?(real|human|person|robot|bot|ai|machine|computer)|is this (a |an )?(bot|ai|robot|"
                     r"recording|machine)|am i (talking|speaking) to (a |an )?(person|human|bot|robot|ai|machine)|"
                     r"(real|actual) person)\b", re.I)
WANT_HUMAN = re.compile(r"\b(speak|talk) to (a |an |the )?(real |actual )?(person|human|someone|manager|supervisor|colleague)|"
                        r"put me through|transfer me|get me (a |the )?(manager|person|human)|"
                        r"(real|actual) (person|human) please", re.I)

VOICE_FORMAT = """
## You are speaking, not writing
You ARE the person on the call for {business}: your name is {name}. Reply with exactly what you say next,
as spoken words only – no tags, no stage directions, no lists, no markdown. One to three short sentences,
natural, warm, British English. Ask one question at a time. Use the playbook answers and the remembered
answers in the handler's own words where they fit. Never invent facts, prices or promises that are not in
the knowledge base; if you don't know, say you'll check and come back, or offer a call-back.
If the caller asks for a person, a manager, raises a complaint, mentions injury, police, court, distress,
fraud, or anything the playbook does not cover, say the hand-off line and nothing else: "{handoff}"
If the caller directly asks whether they are speaking to a real person or to an automated system, answer
truthfully in one short sentence: you are {business}'s automated assistant, and offer to pass them to a
colleague – then continue to help if they are happy to.
Start of call: open with the opening script if nothing has been said yet.
"""


class VoiceAgent:
    def __init__(self, session, settings, emit, rehearse: bool = False):
        self.session = session
        self.s = settings
        self.emit = emit
        self.rehearse = rehearse
        self.active = False
        self.state = "idle"             # idle | thinking | speaking | handoff
        self._speaking_thread: threading.Thread | None = None
        self._cancel = threading.Event()
        self._gen_lock = threading.Lock()
        self._turn_seq = 0
        self.lines_spoken: list[str] = []
        session.turn_listeners.append(self._on_caller_turn)

    # ------------------------------------------------------------- control
    def start(self, say_opening: bool = True) -> None:
        self.active = True
        self._set_state("idle")
        if say_opening and not any(s.speaker == "agent" for s in self.session.segments):
            opening = self._opening_line()
            if opening:
                self._speak(opening)

    def stop(self) -> None:
        self.active = False
        self._cancel.set()
        tts.stop()
        self._set_state("idle")

    def barge_in(self) -> None:
        """Caller started talking while we were speaking: stop and listen."""
        if self.state == "speaking":
            self._cancel.set()
            tts.stop()
            self._set_state("handoff" if self.lines_spoken and self.lines_spoken[-1] == self._handoff_line() else "idle")

    def _set_state(self, st: str) -> None:
        self.state = st
        self.emit("ai_mode", {"active": self.active, "state": st})

    # ------------------------------------------------------------- turns
    def _on_caller_turn(self, text: str, seg_id: str) -> None:
        if not self.active or self.state == "handoff":
            return  # after the hand-off line the human takes over; the agent stays quiet
        self._turn_seq += 1
        seq = self._turn_seq
        if WANT_HUMAN.search(text) or any(re.search(r"\b" + re.escape(t) + r"\b", text, re.I)
                                         for t in self.session.hub.escalation_triggers):
            self._handoff()
            return
        threading.Thread(target=self._reply, args=(text, seq), daemon=True, name="callpilot-voice").start()

    def _reply(self, text: str, seq: int) -> None:
        with self._gen_lock:
            if seq != self._turn_seq or not self.active:
                return
            self._set_state("thinking")
            try:
                spoken = self._generate(text)
            except Exception as e:  # noqa: BLE001
                log.exception("voice reply failed")
                self.emit("error", f"AI mode could not answer: {e}")
                self._handoff()
                return
            if seq != self._turn_seq or not self.active or not spoken:
                self._set_state("idle")
                return
            if spoken.strip() == self._handoff_line().strip():
                self._handoff(speak=True)
                return
            self._speak(spoken)

    def _generate(self, turn_text: str) -> str:
        sess = self.session
        name = (self.s.voice_agent.employee_name or self.s.agent_name or "Sam").split()[0]
        business = sess.hub.company or sess.hub.name
        system = [sess._system_blocks[0] + "\n" + VOICE_FORMAT.format(business=business, name=name,
                                                                      handoff=self._handoff_line()),
                  sess._system_blocks[1], sess._system_blocks[2]]
        window = int(self.s.ai.context_window_s or 90)
        user = (f"{sess._context_block(turn_text)}\n\n<transcript>\n{sess._transcript_block(window_s=window)}\n"
                f"</transcript>\n\nThe caller just said: \"{turn_text}\"\nYour spoken reply:")
        if self.s.privacy.redact_payment_data_before_cloud:
            user = redact_payment(user)
        out = []
        cancel = threading.Event()
        self._cancel = cancel
        try:
            for delta in sess.provider.stream(system, [{"role": "user", "content": user}], 300, cancel=cancel, fast=True):
                out.append(delta)
        except Cancelled:
            return ""
        text = "".join(out).strip()
        text = re.sub(r"^(SAY|MORE|REPLY)\s*:\s*", "", text, flags=re.I).strip().strip('"')
        text, _ = banned_filter(text, sess.banned)
        return text

    # ------------------------------------------------------------- speech
    def _speak(self, text: str, then: str = "idle") -> None:
        """Speak `text`; when it has been said, move to state `then` (idle, or handoff)."""
        self._set_state("speaking")
        self.lines_spoken.append(text)
        seg = self.session.add_agent_line(text)
        self.emit("ai_said", {"text": text, "segment_id": seg.id})
        device = "" if self.rehearse else self.s.voice_agent.output_device

        def finished():
            if self.state == "speaking":
                self._set_state(then)

        def failed(err: str):
            self.emit("error", f"AI voice failed: {err}")
            self._set_state(then)

        tts.speak(text, device, self.s.voice_agent.voice, ear="both", on_done=finished, on_error=failed)

    def _handoff(self, speak: bool = True) -> None:
        """Say the hand-off line, then stay quiet in state 'handoff' until a human takes over."""
        self.emit("handoff", True)
        if speak:
            self._speak(self._handoff_line(), then="handoff")
        else:
            self._set_state("handoff")

    def _opening_line(self) -> str:
        hub = self.session.hub
        name = (self.s.voice_agent.employee_name or self.s.agent_name or "Sam").split()[0]
        f = self.session.case_file
        text = hub.greeting or f"Hello, you're through to {hub.company or hub.name}, {name} speaking. How can I help?"
        return (text.replace("{agent}", name)
                .replace("{client}", f.client_name if f else "you")
                .replace("{reference}", f.reference if f and f.reference else "your file"))

    def _handoff_line(self) -> str:
        return (self.s.voice_agent.handoff_line or
                "Let me pass you to a colleague who can help with that – one moment please.")

    def status_text(self) -> str:
        return {"idle": "AI listening", "thinking": "AI thinking…", "speaking": "AI speaking…",
                "handoff": "AI asked you to take over"}.get(self.state, "AI")

"""On-device call monitoring: forbidden phrases, required disclosures, escalation
triggers and caller sentiment. No network calls, runs on every final segment."""

from __future__ import annotations

import random
import re
from dataclasses import dataclass, field

from callpilot.kb.retriever import tokenize

_NEG = set("""angry annoyed upset furious ridiculous disgusting terrible awful useless joke
scared shaking crying hurt pain injured worried stressed frustrated complaint complain
unacceptable rubbish waste shocking nightmare never lied lying""".split())
_POS = set("""thanks thank great brilliant perfect lovely appreciate helpful amazing fantastic
good happy relieved excellent cheers""".split())
_DISTRESS = set("""hurt pain injured injury scared shaking crying hospital ambulance bleeding
upset shock shocked stressed worried panicking""".split())
_QUESTION_START = re.compile(
    r"^(what|how|when|where|why|who|which|can|could|do|does|did|is|are|am|will|would|should|"
    r"have|has|may|shall)\b", re.I)


@dataclass
class ComplianceState:
    disclosures_done: dict[str, bool] = field(default_factory=dict)
    alerts: list[str] = field(default_factory=list)
    sentiment: float = 0.0  # -1 .. +1 rolling


class ComplianceMonitor:
    def __init__(self, forbidden: list[str], disclosures: list[str], escalations: list[str]):
        self.forbidden = [f.lower() for f in forbidden if f.strip()]
        self.disclosures = disclosures
        self._disc_tokens = {d: set(tokenize(d)) for d in disclosures}
        self.escalations = [e.lower() for e in escalations if e.strip()]
        self.state = ComplianceState(disclosures_done={d: False for d in disclosures})
        self._agent_said: set[str] = set()

    def check_agent(self, text: str) -> list[str]:
        alerts = []
        low = text.lower()
        for f in self.forbidden:
            if re.search(r"\b" + re.escape(f) + r"\b", low):
                alerts.append(f'You said "{f}" – this phrase is not allowed for this hub.')
        self._agent_said.update(tokenize(text))
        for d, toks in self._disc_tokens.items():
            if not self.state.disclosures_done[d] and toks:
                if len(toks & self._agent_said) / len(toks) >= 0.6:
                    self.state.disclosures_done[d] = True
        self.state.alerts.extend(alerts)
        return alerts

    def check_caller(self, text: str) -> list[str]:
        low = text.lower()
        alerts = [f'Escalation trigger: caller mentioned "{e}".'
                  for e in self.escalations if re.search(r"\b" + re.escape(e) + r"\b", low)]
        self.state.alerts.extend(alerts)
        words = set(re.findall(r"[a-z']+", low))
        score = (len(words & _POS) - len(words & _NEG)) / max(1, len(words & (_POS | _NEG)))
        if words & (_POS | _NEG):
            self.state.sentiment = round(0.6 * self.state.sentiment + 0.4 * score, 3)
        return alerts

    def missing_disclosures(self) -> list[str]:
        return [d for d, ok in self.state.disclosures_done.items() if not ok]


def classify_intent(text: str) -> str:
    t = text.strip()
    words = set(re.findall(r"[a-z']+", t.lower()))
    if words & _DISTRESS or len(words & _NEG) >= 2:
        return "distress"
    if words & _NEG:
        return "complaint"
    if t.endswith("?") or _QUESTION_START.match(t):
        return "question"
    return "statement"


_DEFAULT_FILLERS = {
    "distress": ["I'm really sorry to hear that, let's get this sorted for you.",
                 "Okay, I completely understand, you're in the right place.",
                 "I'm sorry, that sounds really stressful. I'm here to help."],
    "complaint": ["I understand, and thank you for telling me.",
                  "I hear you, let me see what I can do straight away.",
                  "That's fair, let me look into that for you right now."],
    "question": ["That's a good question.", "Sure, let me explain.", "Absolutely, so…",
                 "Great question, so basically…"],
    "statement": ["Okay, thank you.", "Right, got it.", "Okay, that's really helpful.",
                  "Perfect, thank you for that."],
}


def pick_filler(intent: str, hub_fillers: list[str], rng: random.Random | None = None) -> str:
    rng = rng or random
    pool = list(_DEFAULT_FILLERS.get(intent, _DEFAULT_FILLERS["statement"]))
    if intent in ("statement", "question") and hub_fillers:
        pool += hub_fillers
    return rng.choice(pool)

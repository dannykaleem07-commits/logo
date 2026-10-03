"""Card rules built into the code (the spec's trigger table), the banned-phrase
filter that runs on every card and draft before display, and the card deck
(max three on screen, one per type, Watch out is the only red element)."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from callpilot.ai.pins import Entity
from callpilot.core.models import ASK, CALLER, SAY, WATCH, Card

INJURY = re.compile(r"\b(injur\w*|whiplash|hospital|a\s?&\s?e|gp\b|doctor|physio\w*|hurt|neck|back pain|concussion|"
                    r"bruis\w*|ambulance|paramedic|x-?ray|painkiller)", re.I)
FRAUD = re.compile(r"\b(fraud\w*|staged|induced|not consistent|inconsistent|we(?:'re| are) investigating|"
                   r"under investigation|exaggerat\w*|fabricat\w*|low[\s-]?velocity|lvi|pre[\s-]?existing|"
                   r"misrepresent\w*|void(?:ed)?|avoid(?:ed|ance)|cifas|ifb|siu|special investigation)", re.I)
OFFER = re.compile(r"(£\s?\d|\b\d+\s?(?:pounds?|quid|a day|per day)\b|\b(?:offer|settle|settlement|valuation|"
                   r"pre-?accident value|pav|rate of|basic hire rate|bhr|spot rate)\b)", re.I)
DISTRESS = re.compile(r"\b(complain\w*|ombudsman|fos\b|police|crying|scared|panick\w*|suicid\w*|can't cope|"
                      r"distress\w*|harass\w*|threaten\w*|solicitor|lawyer|court)\b", re.I)
START_WORK = re.compile(r"\b(go ahead|start (?:now|straight away|today|work)|crack on|get started|sign me up|"
                        r"let's do it|i(?:'d| would) like you to (?:start|act|take it on)|instruct you)\b", re.I)
QUESTION = re.compile(r"\?\s*$|^(what|how|when|where|why|who|which|can|could|do|does|did|is|are|will|would|should|"
                      r"have|has|am|may)\b", re.I)

STATUS_BANNED = ["solicitor", "lawyer", "legal advice", "we act for", "our client"]


@dataclass
class RuleContext:
    speaker: str
    call_type: str = ""              # new_accident | handler | engineer | client_chase | other
    third_party: bool = False        # caller is an insurer / engineer / bodyshop, not the client
    signed_authority: bool | None = None   # None = no file attached
    missing_fields: list[str] = field(default_factory=list)
    earlier_values: dict[str, str] = field(default_factory=dict)   # field -> value already captured
    business: str = ""               # "Courtesy Cars" | "Fixmyfile"
    file_summary: str = ""


def banned_filter(text: str, banned: list[str]) -> tuple[str, list[str]]:
    """Remove banned phrases from AI output before it is shown. Returns (clean, hits)."""
    hits = []
    out = text
    for phrase in banned:
        p = phrase.strip()
        if not p:
            continue
        rx = re.compile(r"\b" + re.escape(p) + r"\b", re.I)
        if rx.search(out):
            hits.append(p)
            out = rx.sub("[…]", out)
    return out, hits


def rule_cards(text: str, entities: list[Entity], ctx: RuleContext) -> list[Card]:
    """Instant cards from the trigger table. These never wait for a model."""
    cards: list[Card] = []
    low = text.lower()

    def watch(msg: str, src: str, pinned: bool = False):
        cards.append(Card(WATCH, msg, [src], pinned_top=pinned, origin="rule"))

    def ask(msg: str, src: str):
        cards.append(Card(ASK, msg, [src], origin="rule"))

    # No signed authority and a third party is on the line -> pinned red card
    if ctx.third_party and ctx.signed_authority is False:
        watch("No signed authority on file – confirm identity and authority before discussing the file.",
              "rule:authority", pinned=True)

    if ctx.speaker == CALLER:
        if INJURY.search(low):
            watch("Injury mentioned: regulated area. Follow the referral process. Do not advise on the injury.",
                  "rule:injury")
        if FRAUD.search(low) and ctx.third_party:
            watch("Fraud or inconsistency alleged. Do not respond to the substance on the call.", "rule:fraud")
            ask("Please put the allegation in writing with the specific basis and every document relied on.",
                "rule:fraud")
        elif FRAUD.search(low):
            watch("Fraud language from the caller. Take the account cold – record their words, suggest nothing.",
                  "rule:fraud")
        if OFFER.search(low) and ctx.third_party and any(e.kind == "figure" for e in entities):
            fig = next(e.value for e in entities if e.kind == "figure")
            cards.append(Card(SAY, f"Noted at {fig}. That is not accepted. I will come back with our figure and the "
                                   f"basis for it in writing – which lines of yours are in dispute?",
                              ["playbook:never accept the first number"], origin="rule"))
        if DISTRESS.search(low) and not ctx.third_party:
            if re.search(r"\bcomplain", low):
                watch("Complaint language. Log it as a complaint now and offer a named call-back.", "rule:complaint")
            else:
                watch("Distress / police / legal mention. Slow down, offer a call-back with a named person.",
                      "rule:distress")
        if START_WORK.search(low) and not ctx.third_party and ctx.call_type in ("new_accident", "client_chase", ""):
            ask("Confirm in writing that you want us to start within the 14-day cancellation period.",
                "rule:cancellation-period")
        # account differs from what was captured earlier (times / dates / regs)
        for e in entities:
            if e.kind in ("date", "reg") and ctx.earlier_values:
                for k, v in ctx.earlier_values.items():
                    if k in ("accident_datetime", "client_vehicle", "tp_vehicle") and v and e.value \
                            and e.value.lower() not in v.lower() and _conflicts(e, k, v):
                        watch(f"Account differs: earlier {k.replace('_', ' ')} was “{v}”, now “{e.text}”. "
                              f"Check both timestamps.", "rule:consistency")
                        break
    # commitments / deadlines are pins, but also prompt a confirming line
    if ctx.speaker == CALLER and ctx.third_party:
        for e in entities:
            if e.kind in ("deadline", "commitment"):
                cards.append(Card(SAY, f"Just to confirm for the record: {e.text}. I'll put that in writing today.",
                                  ["playbook:paper beats memory"], origin="rule"))
                break
    # missing intake field after a natural pause is handled by the LLM ask card; rules only cover the first one
    return cards


def _conflicts(e: Entity, key: str, earlier: str) -> bool:
    if e.kind == "reg":
        return re.sub(r"\s", "", earlier).upper() != e.value and bool(re.search(r"[A-Z]{2}\d{2}", earlier.upper()))
    if e.kind == "date":
        return bool(re.search(r"\d", earlier)) and e.value.split()[-1] not in earlier
    return False


class CardDeck:
    """At most three cards on screen: one ask, one say, one watch.
    Watch cards marked pinned_top stay until explicitly dismissed."""

    def __init__(self, on_change, log: list[Card] | None = None):
        self.on_change = on_change
        self.slots: dict[str, Card | None] = {ASK: None, SAY: None, WATCH: None}
        self.log: list[Card] = log if log is not None else []
        self.fade_after_s = 45.0

    def show(self, card: Card) -> None:
        old = self.slots.get(card.type)
        if old is not None and old is not card:
            if old.pinned_top and not card.pinned_top and card.type == WATCH:
                # keep the pinned card; queue the new warning into the text
                if card.text not in old.text:
                    old.text = old.text + "  •  " + card.text
                    old.sources = list(dict.fromkeys(old.sources + card.sources))
                card.action = "merged"
                self.log.append(card)  # still part of the record
                self.on_change()
                return
            if not old.action:
                old.action = "ignored"
        self.slots[card.type] = card
        if card not in self.log:
            self.log.append(card)
        self.on_change()

    def update(self, card: Card) -> None:
        """A streaming card changed; re-render if it is still on screen."""
        if self.slots.get(card.type) is card:
            self.on_change()

    def top(self) -> Card | None:
        for t in (WATCH, SAY, ASK):
            c = self.slots[t]
            if c and not c.action:
                return c
        return None

    def mark(self, card_type: str | None, action: str) -> Card | None:
        c = self.top() if card_type is None else self.slots.get(card_type)
        if c is None:
            return None
        c.action = action
        if action in ("used", "dismissed"):
            c.pinned_top = False
            self.slots[c.type] = None
        self.on_change()
        return c

    def expire(self) -> None:
        now = time.time()
        changed = False
        for t, c in self.slots.items():
            if c and not c.pinned_top and c.done and now - c.shown_at > self.fade_after_s:
                if not c.action:
                    c.action = "ignored"
                self.slots[t] = None
                changed = True
        if changed:
            self.on_change()

    def visible(self) -> list[Card]:
        return [c for c in (self.slots[WATCH], self.slots[SAY], self.slots[ASK]) if c]

    def clear(self) -> None:
        for t in self.slots:
            c = self.slots[t]
            if c and not c.action:
                c.action = "ignored"
            self.slots[t] = None
        self.on_change()

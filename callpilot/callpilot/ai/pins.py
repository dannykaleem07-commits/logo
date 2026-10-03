"""On-device extraction of the things worth pinning: dates, deadlines, commitments,
figures, registrations, admissions and allegations. Runs on every final line in
well under a millisecond, so chips appear in the transcript line as it lands.

Dates are resolved against the moment they were spoken (UK conventions).
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass

MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september",
     "october", "november", "december"], start=1)}
MONTHS.update({m[:3]: i for m, i in list(MONTHS.items())})
MONTHS["sept"] = 9
WEEKDAYS = {d: i for i, d in enumerate(
    ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])}
_NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
              "nine": 9, "ten": 10, "fourteen": 14, "twenty": 20, "twenty-one": 21, "twenty one": 21,
              "twenty-eight": 28, "twenty eight": 28, "thirty": 30, "sixty": 60, "ninety": 90, "a": 1, "an": 1}

_MONTH_RE = "(?:" + "|".join(sorted(MONTHS, key=len, reverse=True)) + ")"
_DAY_RE = "(?:" + "|".join(WEEKDAYS) + ")"

RX = {
    "date_dmy": re.compile(r"\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b"),
    "date_long": re.compile(rf"\b(?:(?:{_DAY_RE})\s+)?(?:the\s+)?(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({_MONTH_RE})(?:\s+(\d{{4}}))?\b", re.I),
    "date_long_us": re.compile(rf"\b({_MONTH_RE})\s+(\d{{1,2}})(?:st|nd|rd|th)?(?:,?\s+(\d{{4}}))?\b", re.I),
    "weekday": re.compile(rf"\b(?:(this|next)\s+)?({_DAY_RE})\b", re.I),
    "relative": re.compile(r"\b(today|tomorrow|end of (?:the )?(?:week|month)|next week)\b", re.I),
    "within": re.compile(r"\b(?:within|in|inside)\s+(?:the\s+next\s+)?(\d{1,3}|[a-z\-]+(?:\s[a-z]+)?)\s+(working\s+days?|business\s+days?|days?|weeks?|months?|hours?)\b", re.I),
    "got_days": re.compile(r"\b(?:you(?:'ve| have)|we(?:'ve| have)|they(?:'ve| have))\s+(?:got\s+)?(\d{1,3}|[a-z\-]+)\s+(working\s+days?|days?|weeks?)\b", re.I),
    "by": re.compile(rf"\b(?:by|before|no later than)\s+((?:close of play|cop|5\s?pm|midday|noon)\s+)?((?:this|next)\s+)?({_DAY_RE}|tomorrow|end of (?:the )?(?:week|month)|\d{{1,2}}(?:st|nd|rd|th)?\s+{_MONTH_RE}(?:\s+\d{{4}})?|{_MONTH_RE}\s+\d{{1,2}}(?:st|nd|rd|th)?)\b", re.I),
    "money": re.compile(r"(?:£\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:k|thousand|grand))?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:pounds?|quid|grand)\b|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:a|per)\s+day\b)", re.I),
    "reg": re.compile(r"\b([A-Z]{2}\s?\d{2}\s?[A-Z]{3}|[A-Z]\d{1,3}\s?[A-Z]{3}|[A-Z]{3}\s?\d{1,3}[A-Z])\b"),
    "ref": re.compile(r"\b(?:ref(?:erence)?|claim|policy|case)\s*(?:number|no\.?|#)?\s*(?:is|:|-)?\s*((?=[A-Z0-9/\-]*\d)[A-Z0-9][A-Z0-9/\-]{5,})\b", re.I),
    "time": re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b|\b(\d{1,2}):(\d{2})\b", re.I),
}

COMMITMENT = re.compile(
    r"\b(?:i(?:'ll| will)|we(?:'ll| will)|i can confirm|i confirm|it(?:'s| is) (?:booked|authorised|approved|agreed)|"
    r"(?:is|are) booked (?:in |for )?|has been (?:booked|authorised|approved|agreed)|we(?:'ve| have) (?:authorised|approved|agreed)|"
    r"you(?:'ll| will) (?:have|get|receive)|(?:engineer|inspection|collection|delivery|payment|cheque|bacs)\s+(?:is|will be|has been)\s+\w+)\b", re.I)
ADMISSION = re.compile(
    r"\b(?:(?:it was|that was|i was|we were) (?:my|our|his|her|their) fault|i accept|we accept (?:liability|fault|responsibility)|"
    r"liability (?:is|has been) (?:accepted|admitted|conceded)|(?:we|i) (?:admit|concede)|i hit|i went into|i didn't see|wasn't looking|"
    r"i was on (?:my|the) phone|i(?:'d| had) been drinking|ran the red|i was speeding)\b", re.I)
ALLEGATION = re.compile(
    r"\b(?:fraud(?:ulent)?|staged|induced|not consistent|inconsistent with|we(?:'re| are) investigating|under investigation|"
    r"exaggerat\w+|fabricat\w+|low[\s-]?velocity|lvi|pre[\s-]?existing damage|phantom passenger|misrepresent\w+|avoid(?:ed|ance) (?:the|your) policy|"
    r"void(?:ed)? from inception|cifas|ifb|referred to (?:our )?(?:fraud|siu|special investigations?))\b", re.I)


@dataclass
class Entity:
    kind: str       # date | deadline | figure | reg | ref | commitment | admission | allegation
    text: str       # exact words
    value: str = "" # normalised
    due: str = ""   # ISO date when a deadline/date resolves


def _int(word: str) -> int | None:
    w = word.lower().strip()
    if w.isdigit():
        return int(w)
    return _NUM_WORDS.get(w)


def _next_weekday(base: dt.date, wd: int, next_week: bool = False) -> dt.date:
    delta = (wd - base.weekday()) % 7
    if delta == 0 and not next_week:
        delta = 7
    if next_week and delta < 7 and base.weekday() >= wd:
        delta += 7
    return base + dt.timedelta(days=delta)


def _add_working_days(base: dt.date, n: int) -> dt.date:
    d = base
    while n > 0:
        d += dt.timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def resolve_date(text: str, base: dt.date) -> dt.date | None:
    """Turn a spoken date phrase into a date, relative to `base` (the call date)."""
    t = text.lower().strip()
    if t == "today":
        return base
    if t == "tomorrow":
        return base + dt.timedelta(days=1)
    if t.startswith("end of"):
        if "week" in t:
            return base + dt.timedelta(days=(4 - base.weekday()) % 7)
        nxt = (base.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        return nxt - dt.timedelta(days=1)
    if t == "next week":
        return base + dt.timedelta(days=(7 - base.weekday()) % 7 or 7)
    m = RX["date_dmy"].fullmatch(t)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        y = y + 2000 if y < 100 else y
        try:
            return dt.date(y, mo, d)
        except ValueError:
            return None
    m = RX["date_long"].search(t) or None
    if m:
        d, mo, y = int(m.group(1)), MONTHS.get(m.group(2).lower()), m.group(3)
    else:
        m = RX["date_long_us"].search(t)
        if not m:
            m = None
        else:
            mo, d, y = MONTHS.get(m.group(1).lower()), int(m.group(2)), m.group(3)
    if m and mo:
        year = int(y) if y else base.year
        try:
            cand = dt.date(year, mo, d)
        except ValueError:
            return None
        if not y and cand < base - dt.timedelta(days=30):
            cand = cand.replace(year=year + 1)  # "7 October" said in December means next year
        return cand
    m = re.fullmatch(rf"(?:(this|next)\s+)?({_DAY_RE})", t)
    if m:
        return _next_weekday(base, WEEKDAYS[m.group(2)], next_week=(m.group(1) == "next"))
    return None


def extract(text: str, when: float | None = None) -> list[Entity]:
    base = dt.datetime.fromtimestamp(when).date() if when else dt.date.today()
    out: list[Entity] = []
    seen: set[tuple[str, str]] = set()

    def add(kind: str, raw: str, value: str = "", due: str = ""):
        key = (kind, raw.lower())
        if key in seen or not raw.strip():
            return
        seen.add(key)
        out.append(Entity(kind, raw.strip(), value or raw.strip(), due))

    # deadlines first: "within 14 days", "you've got 21 days", "by Friday", "reply by 7 October"
    for m in RX["within"].finditer(text):
        n = _int(m.group(1))
        unit = m.group(2).lower()
        if n is None or n > 400:
            continue
        if unit.startswith(("working", "business")):
            due = _add_working_days(base, n)
        elif unit.startswith("week"):
            due = base + dt.timedelta(weeks=n)
        elif unit.startswith("month"):
            due = base + dt.timedelta(days=30 * n)
        elif unit.startswith("hour"):
            due = base + dt.timedelta(days=max(1, n // 24))
        else:
            due = base + dt.timedelta(days=n)
        add("deadline", m.group(0), f"{n} {unit}", due.isoformat())
    for m in RX["got_days"].finditer(text):
        n = _int(m.group(1))
        if n is None:
            continue
        unit = m.group(2).lower()
        due = _add_working_days(base, n) if unit.startswith("working") else (
            base + (dt.timedelta(weeks=n) if unit.startswith("week") else dt.timedelta(days=n)))
        add("deadline", m.group(0), f"{n} {unit}", due.isoformat())
    for m in RX["by"].finditer(text):
        d = resolve_date(m.group(3), base)
        if d:
            add("deadline", m.group(0), d.strftime("%d/%m/%Y"), d.isoformat())
    # plain dates
    for key in ("date_dmy", "date_long", "date_long_us"):
        for m in RX[key].finditer(text):
            d = resolve_date(m.group(0), base)
            if d:
                add("date", m.group(0), d.strftime("%d/%m/%Y"), d.isoformat())
    for m in RX["weekday"].finditer(text):
        if any(m.group(0).lower() in e.text.lower() for e in out):
            continue
        d = resolve_date(m.group(0), base)
        if d:
            add("date", m.group(0), d.strftime("%a %d/%m/%Y"), d.isoformat())
    for m in RX["relative"].finditer(text):
        if any(m.group(0).lower() in e.text.lower() for e in out):
            continue
        d = resolve_date(m.group(0), base)
        if d:
            add("date", m.group(0), d.strftime("%d/%m/%Y"), d.isoformat())
    for m in RX["money"].finditer(text):
        add("figure", m.group(0), _norm_money(m.group(0)))
    for m in RX["reg"].finditer(text):
        add("reg", m.group(0), m.group(0).replace(" ", "").upper())
    for m in RX["ref"].finditer(text):
        add("ref", m.group(0), m.group(1).upper())
    if ADMISSION.search(text):
        add("admission", ADMISSION.search(text).group(0), text.strip())
    if ALLEGATION.search(text):
        add("allegation", ALLEGATION.search(text).group(0), text.strip())
    if COMMITMENT.search(text) and (any(e.kind in ("date", "deadline") for e in out)
                                    or re.search(r"\b(booked|authoris|approv|agree|confirm|send|email|call you back|arrange)", text, re.I)):
        add("commitment", COMMITMENT.search(text).group(0), text.strip())
    return out


def _norm_money(raw: str) -> str:
    t = raw.lower().replace(",", "").replace("£", "").strip()
    mult = 1
    if re.search(r"\b(k|thousand|grand)\b", t) or t.endswith("k"):
        mult = 1000
    m = re.search(r"\d+(?:\.\d+)?", t)
    if not m:
        return raw
    val = float(m.group(0)) * mult
    per_day = " per day" if re.search(r"\b(a|per)\s+day\b", t) else ""
    return (f"£{val:,.0f}" if val == int(val) else f"£{val:,.2f}") + per_day


def worth_pinning(entities: list[Entity]) -> list[Entity]:
    """Only the kinds that change the file go into the chronology automatically."""
    return [e for e in entities if e.kind in ("deadline", "commitment", "admission", "allegation", "figure")]

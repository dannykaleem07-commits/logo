"""PII / payment-data redaction for logs, saved sessions and (optionally) cloud calls."""

from __future__ import annotations

import re

_CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_UK_PHONE = re.compile(r"(?:(?:\+|00)44\s?\d{2,4}|\(?0\d{2,4}\)?)[\s-]?\d{3,4}[\s-]?\d{3,4}\b")
_NI = re.compile(r"\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b", re.I)
_SORT_CODE = re.compile(r"\b\d{2}-\d{2}-\d{2}\b")
_ACCOUNT_NO = re.compile(r"\b(?:account(?: number| no\.?)?)\s*[:#]?\s*\d{8}\b", re.I)
_CVV = re.compile(r"\b(?:cvv|cvc|security code)\s*(?:is|:)?\s*\d{3,4}\b", re.I)
_POSTCODE = re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b", re.I)
_DOB = re.compile(r"\b(?:0?[1-9]|[12]\d|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-](?:19|20)\d{2}\b")


def _luhn_ok(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def _card_sub(m: re.Match) -> str:
    digits = re.sub(r"\D", "", m.group(0))
    if 13 <= len(digits) <= 19 and _luhn_ok(digits):
        return "[CARD ****" + digits[-4:] + "]"
    return m.group(0)


def redact_payment(text: str) -> str:
    """Strip only payment data (PCI-DSS). Safe to apply before any cloud call."""
    text = _CARD.sub(_card_sub, text)
    text = _CVV.sub("[CVV]", text)
    text = _ACCOUNT_NO.sub("[ACCOUNT NO]", text)
    text = _SORT_CODE.sub("[SORT CODE]", text)
    return text


def redact_all(text: str) -> str:
    """Full PII redaction for anything persisted to disk."""
    text = redact_payment(text)
    text = _EMAIL.sub("[EMAIL]", text)
    text = _NI.sub("[NI NUMBER]", text)
    text = _UK_PHONE.sub("[PHONE]", text)
    text = _DOB.sub("[DOB]", text)
    text = _POSTCODE.sub("[POSTCODE]", text)
    return text

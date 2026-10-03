"""Incremental parser for the co-pilot's tagged streaming format.

The model writes:

    SAY: <first thing to say, one sentence>
    MORE: <the rest of the answer>
    ASK: <question 1> | <question 2>
    WARN: <compliance warning or 'none'>
    THEIR: <SAY + MORE translated into the caller's language>

Text is parsed after every delta so the UI can show SAY while MORE is still
being generated.
"""

from __future__ import annotations

import re

TAGS = ("FILLER", "SAY", "MORE", "ASK", "WARN", "THEIR")
_TAG_RE = re.compile(r"(?m)^\s*\**\s*(FILLER|SAY|MORE|ASK|WARN|THEIR)\s*\**\s*:\s*\**\s*")


def parse_sections(buf: str) -> dict[str, str]:
    out: dict[str, str] = {}
    matches = list(_TAG_RE.finditer(buf))
    if not matches:
        # Model ignored the format: treat everything as SAY so the agent still gets words.
        stripped = buf.strip()
        if stripped and not any(t.startswith(stripped.lstrip('*').upper()) for t in TAGS):
            out["SAY"] = stripped
        return out
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(buf)
        val = buf[m.end():end].strip()
        if i + 1 == len(matches):
            # Hide a half-written tag at the very end (e.g. "MO").
            tail = re.search(r"\n\s*\**([A-Z]{1,5})$", val)
            if tail and any(t.startswith(tail.group(1)) for t in TAGS):
                val = val[:tail.start()].strip()
        out[m.group(1)] = (out.get(m.group(1), "") + " " + val).strip() if m.group(1) in out else val
    return out


def split_questions(ask: str) -> list[str]:
    parts = [p.strip(" -•\t") for p in re.split(r"\s*\|\s*|\n", ask)]
    return [p for p in parts if p and p.lower() not in ("none", "n/a", "-")]


def is_none(text: str) -> bool:
    return text.strip().lower().rstrip(".") in ("", "none", "n/a", "no", "nothing")

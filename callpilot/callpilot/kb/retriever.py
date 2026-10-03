"""Local, zero-latency knowledge retrieval (BM25) and instant Q&A matching.

Runs entirely on-device in well under a millisecond for typical hub sizes, so
an answer for a known question can be on screen before any cloud model has
even received the request.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

_WORD = re.compile(r"[a-z0-9']+")

STOPWORDS = frozenset("""
a an and are as at be but by can could do does did for from had has have how i i'm if in
is it its it's me my of on or our please so that the their them then there they this to
us was we what when where which who why will with would you your yeah yes ok okay um uh
just like well right hi hello
""".split())

# Light-weight synonym folding for the accident / motor-claims domain.
SYNONYMS = {
    "crash": "accident", "collision": "accident", "bump": "accident", "smash": "accident",
    "prang": "accident", "hit": "accident", "rear": "rear-ended", "car": "vehicle",
    "motor": "vehicle", "van": "vehicle", "replacement": "courtesy", "hire": "courtesy",
    "loan": "courtesy", "cost": "charge", "pay": "charge", "price": "charge", "fee": "charge",
    "fees": "charge", "costs": "charge", "money": "charge", "free": "charge", "injured": "injury",
    "hurt": "injury", "whiplash": "injury", "pain": "injury", "insurer": "insurance",
    "insurers": "insurance", "insured": "insurance", "garage": "repair", "fix": "repair",
    "fixed": "repair", "repairs": "repair", "repaired": "repair", "bodyshop": "repair",
    "written": "total-loss", "write-off": "total-loss", "writeoff": "total-loss",
    "police": "police", "cops": "police", "long": "duration", "days": "duration", "weeks": "duration",
}


def tokenize(text: str) -> list[str]:
    out = []
    for w in _WORD.findall(text.lower()):
        if w in STOPWORDS:
            continue
        w = SYNONYMS.get(w, w)
        if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        out.append(w)
    return out


def chunk_text(text: str, max_words: int = 120, overlap: int = 25) -> list[str]:
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    buf: list[str] = []
    for p in paras:
        words = p.split()
        if len(buf) + len(words) <= max_words:
            buf.extend(words)
            continue
        if buf:
            chunks.append(" ".join(buf))
            buf = buf[-overlap:] if overlap else []
        while len(words) > max_words:
            chunks.append(" ".join(buf + words[:max_words - len(buf)]))
            words = words[max_words - len(buf) - overlap:]
            buf = []
        buf.extend(words)
    if buf:
        chunks.append(" ".join(buf))
    return chunks


@dataclass
class Hit:
    score: float
    text: str
    ref: int


class BM25:
    def __init__(self, docs: list[str], k1: float = 1.4, b: float = 0.75):
        self.docs = docs
        self.k1, self.b = k1, b
        self.toks = [tokenize(d) for d in docs]
        self.lens = [len(t) for t in self.toks]
        self.avg = (sum(self.lens) / len(self.lens)) if self.lens else 0.0
        self.tf = [Counter(t) for t in self.toks]
        df: Counter = Counter()
        for t in self.toks:
            df.update(set(t))
        n = len(docs)
        self.idf = {w: math.log(1 + (n - c + 0.5) / (c + 0.5)) for w, c in df.items()}

    def search(self, query: str, k: int = 4) -> list[Hit]:
        q = tokenize(query)
        if not q or not self.docs:
            return []
        scores = []
        for i, tf in enumerate(self.tf):
            s = 0.0
            for w in q:
                f = tf.get(w)
                if not f:
                    continue
                denom = f + self.k1 * (1 - self.b + self.b * self.lens[i] / (self.avg or 1))
                s += self.idf.get(w, 0.0) * f * (self.k1 + 1) / denom
            if s > 0:
                scores.append(Hit(s, self.docs[i], i))
        scores.sort(key=lambda h: h.score, reverse=True)
        return scores[:k]


class QAMatcher:
    """Matches what the caller said to a curated question bank.

    Confidence combines BM25 rank with token coverage of the stored question so
    short generic utterances ("ok thanks") never trigger an instant answer.
    """

    def __init__(self, pairs: list[tuple[str, str]]):
        self.pairs = pairs
        self.index = BM25([q for q, _ in pairs]) if pairs else None

    def match(self, utterance: str, threshold: float = 0.55) -> tuple[str, str, float] | None:
        if not self.index:
            return None
        u = set(tokenize(utterance))
        if len(u) < 2:
            return None
        hits = self.index.search(utterance, k=3)
        if not hits:
            return None
        best = hits[0]
        qtoks = set(tokenize(self.pairs[best.ref][0]))
        coverage = len(u & qtoks) / max(1, len(qtoks))
        precision = len(u & qtoks) / max(1, len(u))
        conf = 0.6 * coverage + 0.4 * min(1.0, precision * 1.5)
        if len(hits) > 1 and hits[1].score > 0.92 * best.score:
            conf *= 0.85  # ambiguous between two answers
        if conf < threshold:
            return None
        q, a = self.pairs[best.ref]
        return q, a, round(conf, 3)

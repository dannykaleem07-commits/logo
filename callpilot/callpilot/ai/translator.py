"""Live translation of transcript segments (LLM or DeepL)."""

from __future__ import annotations

import logging
import re
from collections import OrderedDict

from callpilot.ai.providers import LLMProvider
from callpilot.core import secrets

log = logging.getLogger(__name__)

# ISO-639-1 -> English name (subset used for UI + DeepL mapping)
LANGUAGES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German", "it": "Italian",
    "pt": "Portuguese", "nl": "Dutch", "pl": "Polish", "ro": "Romanian", "ru": "Russian",
    "uk": "Ukrainian", "tr": "Turkish", "ar": "Arabic", "ur": "Urdu", "hi": "Hindi",
    "pa": "Punjabi", "bn": "Bengali", "gu": "Gujarati", "ta": "Tamil", "zh": "Chinese",
    "ja": "Japanese", "ko": "Korean", "fa": "Persian", "ku": "Kurdish", "so": "Somali",
    "sw": "Swahili", "el": "Greek", "bg": "Bulgarian", "cs": "Czech", "hu": "Hungarian",
    "lt": "Lithuanian", "lv": "Latvian", "sk": "Slovak", "sq": "Albanian", "vi": "Vietnamese",
    "th": "Thai", "id": "Indonesian", "ms": "Malay", "tl": "Tagalog", "he": "Hebrew",
}
NAME_TO_CODE = {v.lower(): k for k, v in LANGUAGES.items()}

_SYSTEM = (
    "You are a real-time call interpreter. Translate the user's text into {target}. "
    "Keep names, numbers, registrations and addresses exact. Keep it natural and spoken. "
    "Reply in exactly this format and nothing else:\nLANG: <ISO-639-1 code of the source text>\n"
    "TEXT: <translation, or the original text unchanged if it is already in {target}>"
)


def language_name(code_or_name: str) -> str:
    c = (code_or_name or "").lower().split("-")[0]
    return LANGUAGES.get(c, code_or_name)


class Translator:
    def __init__(self, provider: LLMProvider | None, engine: str = "llm"):
        self.provider = provider
        self.engine = engine
        self._cache: OrderedDict[tuple[str, str], tuple[str, str]] = OrderedDict()

    def translate(self, text: str, target: str) -> tuple[str, str]:
        """Return (source_lang_code, translated_text)."""
        text = text.strip()
        if not text or self.engine == "off":
            return "", text
        key = (text, target)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        if self.engine == "deepl" and secrets.get("deepl_api_key"):
            res = self._deepl(text, target)
        else:
            res = self._llm(text, target)
        self._cache[key] = res
        if len(self._cache) > 500:
            self._cache.popitem(last=False)
        return res

    def _llm(self, text: str, target: str) -> tuple[str, str]:
        if self.provider is None:
            return "", text
        out = self.provider.complete(_SYSTEM.format(target=target),
                                     [{"role": "user", "content": text}], 1500, fast=True)
        lang = re.search(r"LANG:\s*([A-Za-z-]+)", out)
        body = re.search(r"TEXT:\s*(.*)", out, re.S)
        return (lang.group(1).lower() if lang else "", body.group(1).strip() if body else out.strip())

    def _deepl(self, text: str, target: str) -> tuple[str, str]:
        import httpx

        key = secrets.get("deepl_api_key")
        host = "api-free.deepl.com" if key.endswith(":fx") else "api.deepl.com"
        code = NAME_TO_CODE.get(target.lower(), target).upper()
        if code == "EN":
            code = "EN-GB"
        if code == "PT":
            code = "PT-PT"
        r = httpx.post(f"https://{host}/v2/translate",
                       headers={"Authorization": f"DeepL-Auth-Key {key}"},
                       data={"text": text, "target_lang": code}, timeout=10)
        r.raise_for_status()
        t = r.json()["translations"][0]
        return t.get("detected_source_language", "").lower(), t["text"]

"""LLM providers (Claude via the Anthropic SDK, ChatGPT via the OpenAI SDK).

Both expose the same tiny interface: `stream(system, messages, max_tokens)`
yields text deltas, and `complete(...)` returns the whole string.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from typing import Protocol

from callpilot.core import secrets
from callpilot.core.config import AISettings

log = logging.getLogger(__name__)


class Cancelled(Exception):
    pass


class LLMProvider(Protocol):
    name: str

    def stream(self, system: "str | list[str]", messages: list[dict], max_tokens: int,
               cancel: threading.Event | None = None, fast: bool = True) -> Iterator[str]: ...

    def complete(self, system: "str | list[str]", messages: list[dict], max_tokens: int,
                 fast: bool = False) -> str: ...


# ---------------------------------------------------------------------- Claude
class ClaudeProvider:
    name = "Claude"

    # Beta features are tried first; if the account/model rejects one, it is
    # dropped for the rest of the session instead of failing the call.
    def __init__(self, cfg: AISettings):
        import anthropic

        self._anthropic = anthropic
        key = secrets.get("anthropic_api_key")
        self.client = anthropic.Anthropic(api_key=key or None, max_retries=2, timeout=60.0)
        self.cfg = cfg
        self._use_fallbacks = cfg.anthropic_fallbacks
        self._use_fast = cfg.anthropic_fast_mode
        self._use_cache = True

    def _model(self, fast: bool) -> str:
        return self.cfg.anthropic_model if fast else (self.cfg.anthropic_wrapup_model or self.cfg.anthropic_model)

    def _kwargs(self, system: str, messages: list[dict], max_tokens: int, effort: str, model: str) -> dict:
        kw: dict = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": messages,
        }
        blocks = system if isinstance(system, list) else [system]
        if self._use_cache:
            # Hub prompt + file summary are identical for every turn of a call -> cache them.
            kw["system"] = [{"type": "text", "text": b, "cache_control": {"type": "ephemeral"}} for b in blocks if b]
        else:
            kw["system"] = "\n\n".join(b for b in blocks if b)
        if model.startswith(("claude-opus-5", "claude-sonnet-5", "claude-fable",
                             "claude-opus-4-8", "claude-opus-4-7")):
            kw["output_config"] = {"effort": effort}
        betas = []
        if self._use_fallbacks and model in (
                "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"):
            betas.append("server-side-fallback-2026-07-01")
            kw["fallbacks"] = "default"
        if self._use_fast and model in ("claude-opus-5-5", "claude-opus-5"):
            betas.append("fast-mode-2026-02-01")
            kw["speed"] = "fast"
        if betas:
            kw["betas"] = betas
        return kw

    def _degrade(self, err: Exception) -> bool:
        """Turn off the optional feature named in a 400 error. True if something changed."""
        msg = str(err).lower()
        if self._use_fast and ("speed" in msg or "fast" in msg):
            self._use_fast = False
            return True
        if self._use_fallbacks and "fallback" in msg:
            self._use_fallbacks = False
            return True
        if self._use_fast or self._use_fallbacks:
            self._use_fast = self._use_fallbacks = False
            return True
        return False

    def _open(self, kw: dict):
        if "betas" in kw:
            return self.client.beta.messages.stream(**kw)
        return self.client.messages.stream(**kw)

    def stream(self, system, messages, max_tokens, cancel=None, fast=True):
        effort = self.cfg.anthropic_effort if fast else "medium"
        model = self._model(fast)
        for attempt in range(3):
            kw = self._kwargs(system, messages, max_tokens, effort, model)
            try:
                with self._open(kw) as s:
                    for text in s.text_stream:
                        if cancel is not None and cancel.is_set():
                            raise Cancelled()
                        yield text
                    final = s.get_final_message()
                    if getattr(final, "stop_reason", None) == "refusal":
                        log.warning("model declined this turn")
                return
            except self._anthropic.BadRequestError as e:
                if attempt < 2 and self._degrade(e):
                    log.info("retrying without optional beta feature: %s", e)
                    continue
                raise

    def complete(self, system, messages, max_tokens, fast=False):
        return "".join(self.stream(system, messages, max_tokens, fast=fast))


# ---------------------------------------------------------------------- ChatGPT
class OpenAIProvider:
    name = "ChatGPT"

    def __init__(self, cfg: AISettings):
        import openai

        self.client = openai.OpenAI(api_key=secrets.get("openai_api_key") or None,
                                    max_retries=2, timeout=60.0)
        self.cfg = cfg

    def stream(self, system, messages, max_tokens, cancel=None, fast=True):
        sys_text = "\n\n".join(system) if isinstance(system, list) else system
        msgs = [{"role": "system", "content": sys_text}] + messages
        model = self.cfg.openai_model if fast else (self.cfg.openai_wrapup_model or self.cfg.openai_model)
        resp = self.client.chat.completions.create(
            model=model, messages=msgs, stream=True,
            max_completion_tokens=max_tokens,
        )
        try:
            for chunk in resp:
                if cancel is not None and cancel.is_set():
                    raise Cancelled()
                if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
        finally:
            resp.close()

    def complete(self, system, messages, max_tokens, fast=False):
        return "".join(self.stream(system, messages, max_tokens, fast=fast))


def make_provider(cfg: AISettings) -> LLMProvider:
    if cfg.provider == "openai":
        return OpenAIProvider(cfg)
    return ClaudeProvider(cfg)

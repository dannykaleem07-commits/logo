import json

import httpx2 as httpx

from callpilot.ai.providers import ClaudeProvider
from callpilot.core.config import AISettings


def _sse(events):
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)


STREAM = [
    {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant",
                                          "model": "claude-opus-5-5", "content": [], "stop_reason": None,
                                          "stop_sequence": None,
                                          "usage": {"input_tokens": 10, "output_tokens": 1}}},
    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "SAY: Hello"}},
    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": " there."}},
    {"type": "content_block_stop", "index": 0},
    {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
     "usage": {"output_tokens": 5}},
    {"type": "message_stop"},
]


def _provider(handler, **cfg):
    p = ClaudeProvider(AISettings(**cfg))
    import anthropic

    p.client = anthropic.Anthropic(api_key="test", max_retries=0,
                                   http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    return p


def test_claude_request_shape_and_stream():
    seen = []

    def handler(req: httpx.Request):
        seen.append((dict(req.headers), json.loads(req.content)))
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=_sse(STREAM))

    p = _provider(handler, anthropic_model="claude-opus-5-5")
    out = "".join(p.stream("SYSTEM", [{"role": "user", "content": "hi"}], 300))
    assert out == "SAY: Hello there."
    headers, body = seen[0]
    assert body["model"] == "claude-opus-5-5"
    assert body["output_config"] == {"effort": "low"}
    assert body["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in headers["anthropic-beta"]
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert "thinking" not in body and "temperature" not in body


def test_claude_degrades_when_beta_rejected():
    calls = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        calls.append(body)
        if "fallbacks" in body:
            return httpx.Response(400, json={"type": "error", "error": {
                "type": "invalid_request_error", "message": "fallbacks: not enabled for this organization"}})
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=_sse(STREAM))

    p = _provider(handler, anthropic_model="claude-opus-5-5", anthropic_wrapup_model="claude-opus-5-5")
    assert "Hello" in p.complete("S", [{"role": "user", "content": "hi"}], 100)
    assert "fallbacks" in calls[0] and "fallbacks" not in calls[-1]


def test_fast_mode_flag():
    seen = []

    def handler(req):
        seen.append((dict(req.headers), json.loads(req.content)))
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=_sse(STREAM))

    p = _provider(handler, anthropic_fast_mode=True, anthropic_model="claude-opus-5-5")
    p.complete("S", [{"role": "user", "content": "x"}], 50, fast=True)
    headers, body = seen[0]
    assert body["speed"] == "fast" and "fast-mode-2026-02-01" in headers["anthropic-beta"]


def test_haiku_live_and_sonnet_wrapup_split():
    seen = []

    def handler(req):
        seen.append((dict(req.headers), json.loads(req.content)))
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=_sse(STREAM))

    p = _provider(handler)  # defaults: Haiku live, Sonnet 5.5 wrap-up
    p.complete(["HUB", "FILE"], [{"role": "user", "content": "x"}], 50, fast=True)
    p.complete("S", [{"role": "user", "content": "x"}], 50, fast=False)
    live, wrap = seen[0][1], seen[1][1]
    assert live["model"].startswith("claude-haiku-4-5") and "output_config" not in live
    assert [b["text"] for b in live["system"]] == ["HUB", "FILE"]
    assert all(b["cache_control"] == {"type": "ephemeral"} for b in live["system"])
    assert wrap["model"] == "claude-sonnet-5-5" and wrap["output_config"] == {"effort": "medium"}
    assert "anthropic-beta" not in seen[0][0]

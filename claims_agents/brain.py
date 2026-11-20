"""Claude: the shared playbooks plus one call helper every agent uses."""

import json

import anthropic

from . import config

_client = None
_knowledge = None

FIRM_RULES = f"""
FIRM RULES (apply to every agent, every time):
- You work for Courtesy Cars Group UK / Fixmyfile. The danny-brain and danny-brain-supreme
  playbooks loaded above are your minimum standard; where two rules conflict, the more
  cautious one wins and the perimeter rules govern.
- Nothing goes to an outside party until {config.DIRECTOR_NAME} (the Director) approves it.
  You draft; the system queues the draft for approval. Never say an email "has been sent".
- Aim: expedite every claim, inbound or outbound. Set short, firm response deadlines
  (normally 48 hours to 7 days, never open-ended), chase the moment they pass, and escalate
  through every lawful route: chaser, final chaser, formal complaint, letter before claim,
  letter before action, Financial Ombudsman Service, FCA/ICOBS/BCOBS points where they
  genuinely apply. Argue mitigation fully and do not concede a head of loss without good
  reason; flag any concession for the Director.
- Hard-nosed, never dishonest: no false statements of fact or law, no threats you are not
  instructed to carry out, no harassment, no impersonation, no invented evidence or
  authorities. Cite statutes, rules and cases only where you are confident they exist and
  say what they decide; if unsure, describe the principle without a citation.
- Tone: professional, firm, human. Short paragraphs, plain English, bold (<strong>) for
  deadlines, sums claimed and the action required. UK spelling and dates (e.g. 21 November 2026).
"""

HTML_RULES = """
EMAIL BODY FORMAT: body_html is the inside of an email body only: <p>, <strong>, <ul>/<ol>/<li>,
<br>. No <html>, <head>, signature, footer, sign-off name block or logo: the system adds the
firm's footer. Start with a greeting ("Dear Sirs" for firms, "Dear [Name]" for a known person)
and end with "Yours faithfully" / "Yours sincerely" / "Kind regards" as appropriate, with no name
after it. Put our reference and theirs in the subject line.
"""


def client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


def knowledge(extra=()):
    """Every .md file in the knowledge folder, in a stable order (stable = cacheable)."""
    global _knowledge
    if _knowledge is None:
        files = sorted(p for p in config.KNOWLEDGE_DIR.rglob("*.md") if p.name.lower() != "readme.md")
        if not files:
            raise SystemExit(
                f"No playbooks found in {config.KNOWLEDGE_DIR}. Copy the danny-brain, "
                "danny-brain-supreme and hemant-audit skill folders there (see knowledge/README.md)."
            )
        parts = [f"<playbook file=\"{p.relative_to(config.KNOWLEDGE_DIR)}\">\n{p.read_text(encoding='utf-8')}\n</playbook>" for p in files]
        _knowledge = "\n\n".join(parts)
    return _knowledge


def _system(role_prompt, with_knowledge, with_orders=True):
    blocks = []
    if with_knowledge:
        blocks.append({"type": "text", "text": knowledge(), "cache_control": {"type": "ephemeral"}})
    orders = ""
    if with_orders:
        from .logic import orders_text  # the Director's standing orders, live
        orders = orders_text()
    blocks.append({"type": "text", "text": FIRM_RULES + orders + "\n" + role_prompt})
    return blocks


def _text(response):
    if response.stop_reason == "refusal":
        raise RuntimeError(f"Claude declined: {getattr(response.stop_details, 'explanation', '')}")
    return "".join(b.text for b in response.content if b.type == "text")


def ask_json(role_prompt, content, schema, effort="high", with_knowledge=True, max_tokens=16000):
    """One call that must return JSON matching `schema`."""
    response = client().beta.messages.create(
        model=config.MODEL,
        max_tokens=max_tokens,
        system=_system(role_prompt, with_knowledge),
        messages=[{"role": "user", "content": content}],
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if response.stop_reason == "max_tokens":
        raise RuntimeError("Claude's answer was cut off (max_tokens)")
    return json.loads(_text(response))


def ask_research(role_prompt, content, effort="high", max_searches=10):
    """Free-text answer with live web search (Hemant's research)."""
    messages = [{"role": "user", "content": content}]
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": max_searches,
              "user_location": {"type": "approximate", "country": "GB"}}]
    for _ in range(6):
        with client().beta.messages.stream(
            model=config.MODEL,
            max_tokens=32000,
            system=_system(role_prompt, True),
            messages=messages,
            tools=tools,
            output_config={"effort": effort},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        ) as stream:
            response = stream.get_final_message()
        if response.stop_reason != "pause_turn":
            return _text(response)
        messages.append({"role": "assistant", "content": response.content})
    return _text(response)


def obj(properties, required=None):
    """Strict JSON schema object helper."""
    return {"type": "object", "properties": properties,
            "required": required or list(properties), "additionalProperties": False}


S = {"type": "string"}
B = {"type": "boolean"}
LS = {"type": "array", "items": {"type": "string"}}


def enum(*values):
    return {"type": "string", "enum": list(values)}

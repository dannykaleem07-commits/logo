"""Hemant - Head of Legal & Audit. Daily file audit + weekly legal research, as a visual report."""

import html
import logging
from datetime import datetime

from . import brain, config, store
from .brain import LS, S, enum, obj
from .team import _file_context, _safe, label, send_internal

log = logging.getLogger("agents")

HEMANT = f"""
YOU ARE HEMANT, HEAD OF LEGAL & AUDIT at Courtesy Cars Group UK: the firm's King's Counsel-
standard reviewer. Use the hemant-audit playbook (Phase 1 audit standards only; you do not file
anything with any authority) together with danny-brain and danny-brain-supreme. For each claim
you check: the claim is valid and properly evidenced; every head of loss is supported and
mitigation is answered; deadlines and limitation are diarised; the file would survive the other
side's fraud desk and disclosure; and the claim is being escalated to the maximum the law and the
facts allow (no file left waiting, every lawful pressure point used). Be blunt: say what is weak,
what is missing, and the single most powerful next move. Write for {config.DIRECTOR_NAME}: plain
English, no padding.
"""

AUDIT_SCHEMA = obj({
    "client": S,
    "reference": S,
    "stage": S,
    "rag": enum("red", "amber", "green"),
    "headline": S,
    "liability": S,
    "money_at_stake": S,
    "validity_checks": LS,
    "weaknesses": LS,
    "fraud_desk_risks": LS,
    "escalation_now": S,
    "strongest_next_move": S,
    "next_actions": LS,
    "deadlines": LS,
})


def audit_claim(box, c):
    text = (
        f"Today: {datetime.now():%d %B %Y}\nClaim file: {c['folder']}\n"
        f"Last inbound: {c['last_inbound_at']} | Last outbound: {c['last_outbound_at']} | "
        f"Chasers since their last reply: {c['chase_level']}\n\n"
        f"FILE (latest emails, oldest first):\n{_file_context(box, c['folder'])}\n\n"
        "Audit this file."
    )
    result = brain.ask_json(HEMANT, text, AUDIT_SCHEMA, effort="high")
    result["folder"] = c["folder"]
    return result


def research():
    prompt = (
        f"Today is {datetime.now():%d %B %Y}. Research, using web search, the developments of the last "
        "two weeks (and anything pending) that affect a UK credit hire / accident management firm and "
        "its motor claims: court decisions (credit hire rates, PCO/private hire Hussain line, "
        "fundamental dishonesty, non-party costs, Mazur and litigation conduct), CPR and practice "
        "direction changes, FCA/FOS/ICOBS/consumer credit changes, MIB agreements, small claims and "
        "fixed costs limits, insurer behaviour and fraud-desk trends. For each item: what changed, the "
        "source (with link), and exactly what we should do differently. Format as simple HTML "
        "(<h3>, <p>, <ul>, <strong>, <a>); no <html>/<head>. Put the three most important items first."
    )
    return brain.ask_research(HEMANT, prompt)


_COLOURS = {"red": ("#B42318", "#FEF3F2"), "amber": ("#B54708", "#FFFAEB"), "green": ("#067647", "#ECFDF3")}


def _li(items):
    return "".join(f"<li>{html.escape(i)}</li>" for i in items) or "<li>None</li>"


def render(audits, research_html, drafts):
    counts = {k: sum(a["rag"] == k for a in audits) for k in _COLOURS}
    order = {"red": 0, "amber": 1, "green": 2}
    cards = []
    for a in sorted(audits, key=lambda a: order[a["rag"]]):
        fg, bg = _COLOURS[a["rag"]]
        e = {k: html.escape(str(v)) for k, v in a.items() if isinstance(v, str)}
        cards.append(f"""
<div style="border:1px solid #D0D5DD;border-left:6px solid {fg};border-radius:8px;padding:14px 16px;margin:0 0 14px;background:#fff">
  <div style="font-size:12px;font-weight:bold;color:{fg};background:{bg};display:inline-block;padding:2px 8px;border-radius:10px">{a['rag'].upper()}</div>
  <div style="font-size:17px;font-weight:bold;color:#072647;margin:6px 0 2px">{e['client']} &middot; {e['reference']}</div>
  <div style="color:#344054;margin-bottom:8px">{e['headline']}</div>
  <table style="font-size:13px;color:#344054;border-collapse:collapse" cellpadding="3">
    <tr><td><strong>Stage</strong></td><td>{e['stage']}</td></tr>
    <tr><td><strong>Liability</strong></td><td>{e['liability']}</td></tr>
    <tr><td><strong>At stake</strong></td><td>{e['money_at_stake']}</td></tr>
    <tr><td><strong>Escalation now</strong></td><td>{e['escalation_now']}</td></tr>
  </table>
  <p style="margin:10px 0 4px;color:#1466D2"><strong>Strongest next move:</strong> {e['strongest_next_move']}</p>
  <table style="width:100%;font-size:13px;color:#344054" cellpadding="4"><tr valign="top">
    <td width="33%"><strong>Weaknesses</strong><ul style="margin:4px 0;padding-left:18px">{_li(a['weaknesses'])}</ul></td>
    <td width="33%"><strong>Fraud-desk risks</strong><ul style="margin:4px 0;padding-left:18px">{_li(a['fraud_desk_risks'])}</ul></td>
    <td width="33%"><strong>Next actions</strong><ul style="margin:4px 0;padding-left:18px">{_li(a['next_actions'])}</ul>
      <strong>Deadlines</strong><ul style="margin:4px 0;padding-left:18px">{_li(a['deadlines'])}</ul></td>
  </tr></table>
</div>""")
    tiles = "".join(
        f'<td style="background:{_COLOURS[k][1]};color:{_COLOURS[k][0]};border-radius:8px;padding:12px;text-align:center">'
        f'<div style="font-size:26px;font-weight:bold">{counts[k]}</div><div style="font-size:12px">{k.upper()}</div></td>'
        for k in _COLOURS)
    pending = "".join(f"<li>{html.escape(d['subject'])} &mdash; {html.escape(d['recipients'])} ({html.escape(d['agent'])})</li>"
                      for d in drafts) or "<li>None</li>"
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hemant audit {datetime.now():%d %b %Y}</title></head>
<body style="margin:0;background:#F2F4F7;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:860px;margin:0 auto;padding:16px">
  <div style="background:#072647;color:#fff;border-radius:10px;padding:18px 20px;margin-bottom:14px">
    <div style="font-size:12px;letter-spacing:1px;color:#A9C7F5">HEAD OF LEGAL &amp; AUDIT</div>
    <div style="font-size:22px;font-weight:bold">Hemant's claims audit &middot; {datetime.now():%A %d %B %Y}</div>
    <div style="font-size:13px;color:#D0D5DD">{len(audits)} open files reviewed &middot; {len(drafts)} draft(s) awaiting {html.escape(config.DIRECTOR_NAME)}</div>
  </div>
  <table style="width:100%;border-spacing:8px 0;margin:0 -8px 14px"><tr>{tiles}</tr></table>
  <div style="background:#fff;border-radius:8px;padding:12px 16px;margin-bottom:14px;border:1px solid #D0D5DD">
    <strong style="color:#072647">Awaiting your approval</strong><ul style="font-size:13px">{pending}</ul></div>
  {''.join(cards)}
  {('<div style="background:#fff;border-radius:8px;padding:12px 16px;border:1px solid #D0D5DD"><div style="font-size:18px;font-weight:bold;color:#072647">Legal &amp; market research</div>' + research_html + '</div>') if research_html else ''}
</div></body></html>"""


def daily(box, with_research=False):
    open_claims = store.claims()[: config.HEMANT_MAX_CLAIMS]
    log.info("Hemant: auditing %d file(s)%s", len(open_claims), " + research" if with_research else "")
    audits = [a for a in (_safe(audit_claim, box, c) for c in open_claims) if a]
    research_html = ""
    if with_research:
        research_html = _safe(research) or ""
    page = render(audits, research_html, store.drafts("awaiting"))
    path = config.REPORTS_DIR / f"hemant-{datetime.now():%Y-%m-%d}.html"
    path.write_text(page, encoding="utf-8")
    red = sum(a["rag"] == "red" for a in audits)
    send_internal(f"Hemant audit {datetime.now():%d %b}: {red} red, {len(audits)} files",
                  f"Hemant's audit of {len(audits)} open files. Open in an HTML-capable mail view.", raw_html=page)
    log.info("Hemant report saved to %s and emailed to %s", path, config.DIRECTOR_NAME)
    return path

"""Danny (Claims Manager) and Harry (Claims Handler, with six helpers)."""

import base64
import json
import logging
import mimetypes
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from . import brain, config, emailfmt, store
from .brain import B, LS, S, enum, obj
from .mailbox import clean_folder_name, smtp_send

log = logging.getLogger("agents")

DANNY = f"""
YOU ARE DANNY KALEEM, CLAIMS MANAGER (admin) at Courtesy Cars Group UK. You run the claims
desk: you read every email, understand its context against the whole file, decide what it
means for the claim and what must happen next, and draft the response. You know UK motor
claims law, credit hire, mitigation, liability, insurer fraud desks, ICOBS, FOS/FCA
complaint routes, pre-action protocol (letter before claim / letter before action) and
county court procedure, as set out in the playbooks. You think outside the box for lawful
leverage: regulatory duties, complaint routes, delay interest, the three-month ICOBS 8.2.6R
clock, data subject access requests, preservation demands, and costs consequences of
unreasonable conduct. You never fall back on a claim unless there is a real reason, and when
there is, you flag it to {config.DIRECTOR_NAME} rather than conceding in the draft.
You deal with insurers, fraud desks, solicitors, the MIB, finance companies, FOS and regulators.
"""

HARRY_ROLES = {
    "carflex_reports": "Carflex engineer reports: obtain, check and route them to the Director",
    "client_updates": "updates to our own clients: progress, what we need from them, what happens next",
    "documents": "collecting documents: ID, V5C, licence, policy, photos, dashcam, invoices, earnings",
    "preservation": "CCTV and evidence preservation requests and data subject access requests",
    "garage_recovery_storage": "garages, repairers, recovery and storage firms: estimates, invoices, release",
    "diary_deadlines": "deadlines and diary: acknowledgements, chasers on routine admin, limitation dates",
}

HARRY = f"""
YOU ARE HARRY, CLAIMS HANDLER at Courtesy Cars Group UK, working alongside Danny (Claims
Manager). You handle what Danny has no time for, with six helpers whose specialisms are:
{json.dumps(HARRY_ROLES, indent=1)}
You write in the same firm, professional, human style, chase hard and set short deadlines.
You liaise with the Carflex engineers and make sure every engineer report reaches
{config.DIRECTOR_NAME} for review.
"""

TRIAGE_ROLE = """
You are the triage desk. Read one email and work out which claim file it belongs to and what
it needs. The client folder name is "Client Full Name - Reference": the CLIENT is our own
customer (the claimant / hirer), not the other party or their insurer. The reference is our
claim reference if one appears (e.g. CC12345); if only the other side's reference appears,
use that. If you can match an existing folder from the list, return it exactly in
matched_folder. If you cannot identify the client with reasonable confidence, leave
client_full_name empty.
"""

TRIAGE_SCHEMA = obj({
    "client_full_name": S,
    "claim_reference": S,
    "matched_folder": S,
    "sender_role": enum("insurer", "insurer_fraud_desk", "client", "garage_repairer", "carflex_engineer",
                        "other_engineer", "hire_recovery_storage", "solicitor", "court", "mib",
                        "ombudsman_regulator", "finance_company", "police", "internal", "marketing_spam", "other"),
    "is_carflex_engineer_report": B,
    "summary": S,
    "key_points": LS,
    "deadline_mentioned": S,
    "needs_response": B,
    "handler": enum("danny", "harry", "none"),
    "harry_role": enum(*HARRY_ROLES, "none"),
    "urgency": enum("high", "normal", "low"),
})

DRAFT_SCHEMA = obj({
    "skip": B,
    "skip_reason": S,
    "to": LS,
    "cc": LS,
    "subject": S,
    "body_html": S,
    "attach": LS,
    "escalation_step": S,
    "response_deadline": S,
    "note_for_director": S,
})

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def label(folder):
    """'Clients/John Smith - CC123' -> 'John Smith - CC123'."""
    prefix = config.CLIENTS_PARENT
    return folder[len(prefix) + 1:] if folder.startswith(prefix) and len(folder) > len(prefix) else folder


# ---------------------------------------------------------------- triage

def triage(mail, folders):
    content = (
        f"Existing client folders:\n{json.dumps(folders[-400:])}\n\n"
        f"Our mailbox: {config.MAILBOX}. Carflex domains: {config.CARFLEX_DOMAINS or 'unknown'}.\n\n"
        f"EMAIL:\n{mail.brief(5000)}"
    )
    result = brain.ask_json(TRIAGE_ROLE, content, TRIAGE_SCHEMA, effort="medium", with_knowledge=False,
                            max_tokens=4000)
    domain = mail.from_addr.split("@")[-1]
    if config.CARFLEX_DOMAINS and any(domain.endswith(d) for d in config.CARFLEX_DOMAINS):
        result["sender_role"] = "carflex_engineer"
        if mail.attachments():
            result["is_carflex_engineer_report"] = True
    return result


def target_folder(box, t):
    if t["sender_role"] == "marketing_spam":
        return config.SPAM_FOLDER, None, None
    if t["matched_folder"] and t["matched_folder"] in box_folders_cache(box):
        name = label(t["matched_folder"])
        client, _, ref = name.rpartition(" - ")
        return t["matched_folder"], client or name, ref
    if t["client_full_name"] and t["claim_reference"]:
        client = clean_folder_name(t["client_full_name"].title())
        ref = clean_folder_name(t["claim_reference"].upper())
        return box.client_folder(client, ref), client, ref
    return config.UNALLOCATED_FOLDER, None, None


_folder_cache = {}


def box_folders_cache(box, refresh=False):
    if refresh or "list" not in _folder_cache:
        _folder_cache["list"] = box.client_folders()
    return _folder_cache["list"]


def scan(box, folder="INBOX", since_days=None, dry_run=False):
    """Read, understand and file every new email in `folder`. Returns work for the drafters."""
    mails = [m for m in box.messages(folder, since_days=since_days) if not store.seen(m.message_id)]
    if not mails:
        return []
    log.info("Triage: %d new email(s) in %s", len(mails), folder)
    folders = box_folders_cache(box, refresh=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda m: _safe(triage, m, folders), mails))
    work = []
    for mail, t in zip(mails, results):
        if t is None:
            continue
        target, client, ref = target_folder(box, t)
        outbound = mail.from_addr == config.MAILBOX.lower()
        log.info("  %s | %s -> %s", mail.from_addr, mail.subject[:60], target)
        if dry_run:
            continue
        if client:
            store.upsert_claim(target, client, ref, t["summary"])
            store.touch_claim(target, "out" if outbound else "in", mail.when,
                              ", ".join(mail.to) if outbound else None)
        if folder == "INBOX":
            box.move(mail, target)
        else:  # Sent items stay where they are; a copy goes on the client file
            if target not in (config.UNALLOCATED_FOLDER, config.SPAM_FOLDER):
                box.copy(mail, target)
        store.mark_seen(mail.message_id, folder, target)
        if client and folder == "INBOX":
            _folder_cache.pop("list", None)
            work.append((mail, t, target))
    return work


def _safe(fn, *args):
    try:
        return fn(*args)
    except Exception as e:  # one bad email must not stop the scan
        log.exception("Failed: %s", e)
        return None


# ---------------------------------------------------------------- drafting

def _file_context(box, folder, exclude_id=None):
    parts = []
    for m in box.thread(folder, limit=12):
        if m.message_id == exclude_id:
            continue
        direction = "OUTBOUND (us)" if m.from_addr == config.MAILBOX.lower() else "INBOUND"
        parts.append(f"--- {direction}\n{m.brief(2500)}")
    return "\n\n".join(parts) or "(no earlier emails on file)"


def _available_docs(box, folder):
    """Attachments already on the client file, plus files in case-documents/<folder name>/."""
    docs = {}
    for m in box.thread(folder, limit=25):
        for name, ctype, data in m.attachments():
            docs.setdefault(name, (name, ctype, data))
    local = config.CASE_DOCS_DIR / label(folder)
    if local.is_dir():
        for p in local.iterdir():
            if p.is_file():
                docs.setdefault(p.name, (p.name, mimetypes.guess_type(p.name)[0], p.read_bytes()))
    return docs


def _pdf_blocks(mail, limit=3):
    blocks = []
    for name, ctype, data in mail.attachments():
        if ctype == "application/pdf" and len(data) < 15_000_000 and len(blocks) < limit:
            blocks.append({"type": "document", "title": name,
                           "source": {"type": "base64", "media_type": "application/pdf",
                                      "data": base64.b64encode(data).decode()}})
    return blocks


def _queue(box, agent, kind, folder, d, docs, in_reply_to=None, references=None, dry_run=False):
    to = [a for a in d["to"] if _EMAIL.match(a)]
    cc = [a for a in d["cc"] if _EMAIL.match(a)]
    if d["skip"] or not to:
        log.info("  %s: no email needed (%s)", agent, d["skip_reason"] or "no valid recipient")
        return None
    attachments = [docs[n] for n in d["attach"] if n in docs]
    msg = emailfmt.build(to, d["subject"], d["body_html"], cc=cc, attachments=attachments,
                         in_reply_to=in_reply_to, references=references, agent=agent, kind=kind, folder=folder)
    draft_id = msg["X-CC-Draft-ID"]
    note = (f"{agent} | {kind} | step: {d['escalation_step']} | deadline: {d['response_deadline']}"
            + (f" | NOTE: {d['note_for_director']}" if d["note_for_director"] else ""))
    msg["X-CC-Note"] = re.sub(r"[\r\n]+", " ", note)[:900]
    if dry_run:
        out = config.DATA_DIR / "dry-run"
        out.mkdir(exist_ok=True)
        (out / f"{draft_id}.eml").write_bytes(msg.as_bytes())
        log.info("  [dry run] draft saved to %s", out / f"{draft_id}.eml")
        return draft_id
    box.store(config.AWAITING_FOLDER, msg)
    store.add_draft(draft_id, folder, agent, kind, to + cc, d["subject"], note)
    log.info("  %s drafted '%s' -> %s (awaiting %s)", agent, d["subject"][:60], ", ".join(to), config.DIRECTOR_NAME)
    return draft_id


def draft_reply(box, mail, t, folder, dry_run=False):
    if not t["needs_response"] or t["handler"] == "none" or store.pending_draft(folder):
        return None
    agent, role = ("Harry", HARRY + f"\nThis task is for your '{t['harry_role']}' helper.") \
        if t["handler"] == "harry" else ("Danny", DANNY)
    docs = _available_docs(box, folder)
    text = (
        f"Claim file: {folder}\nToday: {datetime.now().strftime('%d %B %Y')}\n"
        f"Triage: {json.dumps(t)}\n\nEARLIER EMAILS ON THIS FILE (oldest first):\n{_file_context(box, folder, mail.message_id)}\n\n"
        f"NEW EMAIL TO ANSWER:\n{mail.brief(8000)}\n\n"
        f"Documents available to attach (use exact names): {json.dumps(list(docs))}\n\n"
        "Draft the reply that moves this claim forward fastest. Reply to the sender unless the "
        "file shows it should go elsewhere. Set a short, specific response deadline in bold. If no "
        "reply is needed (e.g. a simple acknowledgement we must not answer), set skip=true."
        + brain.HTML_RULES
    )
    content = _pdf_blocks(mail) + [{"type": "text", "text": text}]
    d = brain.ask_json(role, content, DRAFT_SCHEMA, effort="high")
    subject = d["subject"] or ("Re: " + mail.subject)
    d["subject"] = subject
    return _queue(box, agent, "reply", folder, d, docs, in_reply_to=mail.message_id,
                  references=str(mail.msg.get("References", "")) or None, dry_run=dry_run)


LADDER = """
Chase ladder (choose the next lawful step from the file history; you may skip ahead where the
file justifies it, e.g. a fraud allegation with no particulars, or ICOBS three-month clock passed):
1 firm chaser with a 48-hour deadline
2 final chaser: warn that a formal complaint follows if no substantive reply by the deadline
3 formal complaint under the insurer's complaints procedure (DISP), noting the 8-week FOS route
4 letter before claim / letter before action under the Practice Direction on Pre-Action
  Conduct (14 days), with the schedule of loss
5 referral to the Financial Ombudsman Service (where eligible) and/or recommendation to the
  Director to issue proceedings
Steps 4 and 5 (and any mention of proceedings) need the Director's explicit decision: draft
them, and say so in note_for_director.
"""


def followups(box, dry_run=False):
    """Danny chases every file where we are waiting on the other side past FOLLOWUP_HOURS."""
    due = []
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=config.FOLLOWUP_HOURS)).isoformat()
    for c in store.claims():
        out_at, in_at = c["last_outbound_at"], c["last_inbound_at"]
        if store.pending_draft(c["folder"]) or store.recent_draft(c["folder"], cutoff):
            continue
        last = max(x for x in (out_at, in_at) if x) if (out_at or in_at) else None
        if last and last <= cutoff:
            due.append(c)
    log.info("Follow-ups due: %d", len(due))
    for c in due:
        _safe(_followup_one, box, c, dry_run)


def _followup_one(box, c, dry_run):
    folder = c["folder"]
    docs = _available_docs(box, folder)
    we_wrote_last = c["last_outbound_at"] and (not c["last_inbound_at"] or c["last_outbound_at"] > c["last_inbound_at"])
    if we_wrote_last:
        situation = (f"Our last email went out {c['last_outbound_at']} to {c['last_outbound_to']}; no reply since. "
                     f"Chasers already sent since their last reply: {c['chase_level']}.")
    else:
        situation = (f"The last email on file came IN on {c['last_inbound_at']} and nobody has answered it. "
                     "Work out who is waiting on whom: if we owe a reply, draft it now; if the other "
                     "side still owes us something, chase it.")
    text = (
        f"Claim file: {folder}\nToday: {datetime.now().strftime('%d %B %Y')}\n"
        f"{situation}\n{LADDER}\n"
        f"FILE HISTORY (oldest first):\n{_file_context(box, folder)}\n\n"
        f"Documents available to attach (exact names): {json.dumps(list(docs))}\n\n"
        "Draft the next chase / escalation to the party we are waiting on. Reference our earlier "
        "email by date, state what is outstanding, and set a short deadline in bold. If the file "
        "shows nothing is actually owed by the other side (e.g. we are waiting on our own client, "
        "or the claim has settled), set skip=true and explain."
        + brain.HTML_RULES
    )
    d = brain.ask_json(DANNY, text, DRAFT_SCHEMA, effort="high")
    _queue(box, "Danny", "followup", folder, d, docs, dry_run=dry_run)


# ---------------------------------------------------------------- Harry: Carflex reports

def send_internal(subject, body_html, attachments=(), raw_html=None):
    """Internal mail to the Director only. External mail can only leave via approvals."""
    if not config.DIRECTOR_EMAIL:
        log.warning("DIRECTOR_EMAIL not set: internal email '%s' not sent", subject)
        return
    msg = emailfmt.build([config.DIRECTOR_EMAIL], subject, body_html, attachments=attachments,
                         agent="internal", kind="internal", raw_html=raw_html)
    for h in ("X-Priority", "X-MSMail-Priority", "Importance", "Priority",
              "Disposition-Notification-To", "Return-Receipt-To"):
        del msg[h]
    assert msg["To"] == config.DIRECTOR_EMAIL
    smtp_send(msg)


def forward_carflex(mail, t, folder, dry_run=False):
    if not t["is_carflex_engineer_report"]:
        return
    files = mail.attachments()
    points = "".join(f"<li>{p}</li>" for p in t["key_points"])
    body = (
        f"<p>{config.DIRECTOR_NAME},</p><p>Carflex engineer report received on "
        f"<strong>{label(folder)}</strong> for your review.</p>"
        f"<p><strong>Summary:</strong> {t['summary']}</p><ul>{points}</ul>"
        f"<p>From: {mail.from_name} &lt;{mail.from_addr}&gt;, {mail.date:%d %B %Y %H:%M}. "
        f"Original subject: {mail.subject}</p><p>Harry</p>"
    )
    if dry_run:
        log.info("  [dry run] Harry would forward the Carflex report to %s", config.DIRECTOR_EMAIL)
        return
    send_internal(f"Carflex engineer report - {label(folder)} - for review", body, files)
    log.info("  Harry forwarded the Carflex report (%d file(s)) to %s", len(files), config.DIRECTOR_NAME)

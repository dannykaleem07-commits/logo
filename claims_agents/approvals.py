"""The Director's approval queue - the ONLY path an external email can take out of the system.

Shahzaib, in IONOS webmail (claims@ mailbox):
  - drag a draft from "Awaiting Shahzaib" to "Approved - Send"  -> it is sent straight away
  - drag it to "Rejected"                                          -> it is dropped and logged
"""

import logging
from email.utils import formatdate, make_msgid

from . import config, emailfmt, store
from .mailbox import smtp_send

log = logging.getLogger("agents")


def process(box, dry_run=False):
    _send_approved(box, dry_run)
    _log_rejected(box, dry_run)
    if not dry_run:
        _forget_deleted(box)


def _forget_deleted(box):
    """A draft the Director deleted (instead of moving) frees its claim for new drafts."""
    present = set()
    for folder in (config.AWAITING_FOLDER, config.APPROVED_FOLDER, config.REJECTED_FOLDER):
        present.update(m.msg.get("X-CC-Draft-ID") for m in box.messages(folder))
    for d in store.drafts("awaiting"):
        if d["id"] not in present:
            store.set_draft_status(d["id"], "deleted")


def _send_approved(box, dry_run):
    for mail in box.messages(config.APPROVED_FOLDER):
        msg = mail.msg
        draft_id = msg.get("X-CC-Draft-ID")
        record = store.draft(draft_id) if draft_id else None
        if record is None or record["status"] != "awaiting":
            log.warning("Ignoring '%s' in %s: not a queued agent draft", mail.subject, config.APPROVED_FOLDER)
            continue
        if dry_run:
            log.info("[dry run] would send approved draft '%s'", mail.subject)
            continue
        for h in ("Date", "Message-ID", "X-CC-Note"):
            del msg[h]
        msg["Date"] = formatdate(localtime=True)
        msg["Message-ID"] = make_msgid(domain=config.MAILBOX.split("@")[-1])
        smtp_send(msg)
        store.set_draft_status(draft_id, "sent")
        store.mark_seen(msg["Message-ID"], "approved", record["folder"])
        folder = emailfmt.folder_of(msg) or record["folder"]
        box.store(box.sent_folder, msg, seen=True)
        if folder:
            box.store(folder, msg, seen=True)
            store.touch_claim(folder, "out", store.now(), msg.get("To"))
            if record["kind"] == "followup":
                store.bump_chase(folder)
        box.delete(mail)
        log.info("SENT (approved by %s): '%s' -> %s", config.DIRECTOR_NAME, mail.subject, msg.get("To"))


def _log_rejected(box, dry_run):
    for mail in box.messages(config.REJECTED_FOLDER):
        draft_id = mail.msg.get("X-CC-Draft-ID")
        record = store.draft(draft_id) if draft_id else None
        if record and record["status"] == "awaiting" and not dry_run:
            store.set_draft_status(draft_id, "rejected")
            log.info("Rejected by %s: '%s'", config.DIRECTOR_NAME, mail.subject)

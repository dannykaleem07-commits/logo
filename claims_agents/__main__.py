"""Start the claims team.

    python -m claims_agents check          test the IONOS login and Claude key; changes nothing
    python -m claims_agents run --dry-run  full pass, but moves/sends nothing (drafts saved to data/dry-run)
    python -m claims_agents run            one full pass now
    python -m claims_agents start          run all agents continuously (every SCAN_MINUTES)
    python -m claims_agents followups      Danny chases every overdue file now
    python -m claims_agents hemant [--research]   Hemant's audit report now
"""

import argparse
import html
import logging
import sys
import time
from datetime import datetime, timedelta, timezone

from . import approvals, brain, config, hemant, store, team
from .mailbox import Mailbox

log = logging.getLogger("agents")


def setup_logging():
    fmt = "%(asctime)s %(message)s"
    logging.basicConfig(level=logging.INFO, format=fmt, datefmt="%d/%m %H:%M",
                        handlers=[logging.StreamHandler(sys.stdout),
                                  logging.FileHandler(config.DATA_DIR / "agents.log", encoding="utf-8")])
    for noisy in ("httpx", "anthropic", "imapclient"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def check():
    box = Mailbox()
    print(f"IONOS login OK: {config.MAILBOX}  (folder separator '{box.delim}', sent folder '{box.sent_folder}')")
    print(f"Client folders so far: {len(box.client_folders())}")
    box.close()
    brain.knowledge()
    print(f"Playbooks loaded from {config.KNOWLEDGE_DIR}")
    reply = brain.ask_json("Reply with ok=true.", "ping", brain.obj({"ok": brain.B}), effort="low",
                           with_knowledge=False, max_tokens=2000)
    print(f"Claude OK ({config.MODEL}): {reply}")
    print(f"Director: {config.DIRECTOR_NAME} <{config.DIRECTOR_EMAIL or 'NOT SET'}>")


def digest(new_drafts):
    if not new_drafts:
        return
    rows = "".join(
        f"<li><strong>{html.escape(d['subject'])}</strong> to {html.escape(d['recipients'])}<br/>{html.escape(d['note'] or '')}</li>"
        for d in new_drafts)
    team.send_internal(
        f"{len(new_drafts)} draft(s) awaiting your approval",
        f"<p>{config.DIRECTOR_NAME},</p><p>New drafts are in the <strong>{config.AWAITING_FOLDER}</strong> "
        f"folder of {config.MAILBOX}. Move each one to <strong>{config.APPROVED_FOLDER}</strong> to send it "
        f"(it goes within {config.SCAN_MINUTES} minutes), or to <strong>{config.REJECTED_FOLDER}</strong>.</p><ul>{rows}</ul>")


def run_once(dry_run=False, followups=True):
    started = datetime.now()
    before = {d["id"] for d in store.drafts("awaiting")}
    box = Mailbox()
    try:
        approvals.process(box, dry_run)                     # 1. send what Shahzaib approved
        first_run = store.get("first_run_done") is None
        since = config.BACKFILL_DAYS if first_run else 7
        team.scan(box, box.sent_folder, since_days=since, dry_run=dry_run)   # 2. learn what we sent
        work = team.scan(box, "INBOX", since_days=since if first_run else None, dry_run=dry_run)  # 3. file inbox
        recent = datetime.now(timezone.utc) - timedelta(days=3)
        for mail, t, folder in work:                         # 4. Harry forwards reports, Danny/Harry draft
            if mail.date < recent:
                continue  # backlog: the follow-up pass below handles overdue files once each
            team._safe(team.forward_carflex, mail, t, folder, dry_run)
            team._safe(team.draft_reply, box, mail, t, folder, dry_run)
        if followups:
            team.followups(box, dry_run)                     # 5. Danny chases overdue files
        if not dry_run:
            store.put("first_run_done", "1")
            digest([d for d in store.drafts("awaiting") if d["id"] not in before])
    finally:
        box.close()
    log.info("Pass finished in %ds", (datetime.now() - started).seconds)


def hemant_due():
    today = datetime.now().strftime("%Y-%m-%d")
    if store.get("hemant_last") == today or datetime.now().strftime("%H:%M") < config.HEMANT_TIME:
        return None
    return today


def start():
    log.info("Claims team started: Danny, Harry (+6 helpers), Hemant. Scanning every %d min.", config.SCAN_MINUTES)
    while True:
        try:
            run_once()
            today = hemant_due()
            if today:
                box = Mailbox()
                try:
                    hemant.daily(box, with_research=datetime.now().weekday() == config.HEMANT_RESEARCH_WEEKDAY)
                finally:
                    box.close()
                store.put("hemant_last", today)
        except KeyboardInterrupt:
            raise
        except Exception:
            log.exception("Pass failed; retrying next cycle")
        time.sleep(config.SCAN_MINUTES * 60)


def main():
    setup_logging()
    p = argparse.ArgumentParser(prog="claims_agents")
    p.add_argument("command", choices=["check", "run", "start", "followups", "hemant"])
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--research", action="store_true")
    a = p.parse_args()
    if a.command == "check":
        check()
    elif a.command == "run":
        run_once(a.dry_run)
    elif a.command == "start":
        start()
    elif a.command == "followups":
        box = Mailbox()
        try:
            team.followups(box, a.dry_run)
        finally:
            box.close()
    elif a.command == "hemant":
        box = Mailbox()
        try:
            hemant.daily(box, with_research=a.research)
        finally:
            box.close()


if __name__ == "__main__":
    main()

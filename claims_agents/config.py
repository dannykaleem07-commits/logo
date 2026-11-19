"""Settings, read from the .env file next to the project (never committed)."""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _get(name, default=None, required=False):
    value = os.getenv(name, default)
    if required and not value:
        raise SystemExit(f"Missing setting {name} in .env (see .env.example).")
    return value


def _bool(name, default="false"):
    return str(_get(name, default)).strip().lower() in ("1", "true", "yes", "on")


def _list(name, default=""):
    return [x.strip().lower() for x in str(_get(name, default)).split(",") if x.strip()]


# Mailbox (IONOS)
MAILBOX = _get("MAILBOX", "claims@courtesycars.net")
MAIL_PASSWORD = _get("MAIL_PASSWORD")
IMAP_HOST = _get("IMAP_HOST", "imap.ionos.co.uk")
IMAP_PORT = int(_get("IMAP_PORT", "993"))
SMTP_HOST = _get("SMTP_HOST", "smtp.ionos.co.uk")
SMTP_PORT = int(_get("SMTP_PORT", "465"))
SENDER_NAME = _get("SENDER_NAME", "Danny Kaleem - Claims Manager")

# People
DIRECTOR_NAME = _get("DIRECTOR_NAME", "Shahzaib")
DIRECTOR_EMAIL = _get("DIRECTOR_EMAIL")

# Folders
CLIENTS_PARENT = _get("CLIENTS_PARENT", "Clients")
UNALLOCATED_FOLDER = _get("UNALLOCATED_FOLDER", "Unallocated - Needs Review")
AWAITING_FOLDER = _get("AWAITING_FOLDER", "Awaiting Shahzaib")
APPROVED_FOLDER = _get("APPROVED_FOLDER", "Approved - Send")
REJECTED_FOLDER = _get("REJECTED_FOLDER", "Rejected")
SENT_FOLDER = _get("SENT_FOLDER", "")  # blank = auto-detect
SPAM_FOLDER = _get("SPAM_FOLDER", "Marketing - Spam")

# Timing
SCAN_MINUTES = int(_get("SCAN_MINUTES", "15"))
FOLLOWUP_HOURS = int(_get("FOLLOWUP_HOURS", "48"))
BACKFILL_DAYS = int(_get("BACKFILL_DAYS", "60"))
HEMANT_TIME = _get("HEMANT_TIME", "17:30")
HEMANT_RESEARCH_WEEKDAY = int(_get("HEMANT_RESEARCH_WEEKDAY", "0"))  # 0 = Monday
HEMANT_MAX_CLAIMS = int(_get("HEMANT_MAX_CLAIMS", "40"))

# Other parties
CARFLEX_DOMAINS = _list("CARFLEX_DOMAINS", "")
INTERNAL_DOMAINS = _list("INTERNAL_DOMAINS", "courtesycars.net")

# Claude
MODEL = _get("CLAUDE_MODEL", "claude-opus-5-5")
KNOWLEDGE_DIR = Path(_get("KNOWLEDGE_DIR", str(ROOT / "knowledge")))
CASE_DOCS_DIR = Path(_get("CASE_DOCS_DIR", str(ROOT / "case-documents")))
FOOTER_FILE = Path(_get("FOOTER_FILE", str(ROOT / "footer.html")))
LOGO_FILE = Path(_get("LOGO_FILE", str(ROOT / "print" / "courtesy-cars-uk-logo-preview.png")))

# Boss Hub
HUB_PORT = int(_get("HUB_PORT", "8765"))
HUB_ALLOW_LAN = _bool("HUB_ALLOW_LAN", "false")  # true = other devices on the office network can open it

DATA_DIR = ROOT / "data"
REPORTS_DIR = ROOT / "reports"
DATA_DIR.mkdir(exist_ok=True)
REPORTS_DIR.mkdir(exist_ok=True)

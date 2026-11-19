"""IONOS mailbox: read, file into folders, store drafts, send."""

import email
import email.policy
import html
import re
import smtplib
import ssl
from datetime import date, datetime, timedelta, timezone
from email.utils import getaddresses, parseaddr, parsedate_to_datetime

from imapclient import IMAPClient
from imapclient.imapclient import SENT

from . import config

_BAD_CHARS = re.compile(r'[\\/.*%"<>|:?\r\n\t]+')


def clean_folder_name(name):
    name = _BAD_CHARS.sub(" ", name or "").strip()
    return re.sub(r"\s{2,}", " ", name)[:120]


class Mail:
    """One mail object per message, with the parts the agents need."""

    def __init__(self, uid, raw, folder):
        self.uid = uid
        self.folder = folder
        self.raw = raw
        self.msg = email.message_from_bytes(raw, policy=email.policy.default)
        self.message_id = (self.msg.get("Message-ID") or f"<uid-{folder}-{uid}>").strip()
        self.subject = str(self.msg.get("Subject", "")).strip()
        self.from_name, self.from_addr = parseaddr(str(self.msg.get("From", "")))
        self.from_addr = self.from_addr.lower()
        self.to = [a.lower() for _, a in getaddresses([str(self.msg.get("To", "")), str(self.msg.get("Cc", ""))]) if a]
        try:
            self.date = parsedate_to_datetime(str(self.msg.get("Date"))).astimezone(timezone.utc)
        except Exception:
            self.date = datetime.now(timezone.utc)

    @property
    def when(self):
        return self.date.replace(microsecond=0).isoformat()

    def text(self, limit=6000):
        body = self.msg.get_body(preferencelist=("plain", "html"))
        if body is None:
            return ""
        try:
            content = body.get_content()
        except Exception:
            return ""
        if body.get_content_type() == "text/html":
            content = re.sub(r"(?is)<(script|style).*?</\1>", " ", content)
            content = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", content)
            content = html.unescape(re.sub(r"<[^>]+>", " ", content))
        content = re.sub(r"[ \t]+", " ", content)
        content = re.sub(r"\n\s*\n+", "\n\n", content).strip()
        return content[:limit]

    def attachments(self):
        out = []
        for part in self.msg.iter_attachments():
            name = part.get_filename()
            if not name:
                continue
            try:
                data = part.get_content()
            except Exception:
                continue
            if isinstance(data, str):
                data = data.encode()
            out.append((name, part.get_content_type(), data))
        return out

    def brief(self, limit=3000):
        names = ", ".join(n for n, _, _ in self.attachments()) or "none"
        return (
            f"From: {self.from_name} <{self.from_addr}>\nTo/Cc: {', '.join(self.to)}\n"
            f"Date: {self.when}\nSubject: {self.subject}\nAttachments: {names}\n\n{self.text(limit)}"
        )


class Mailbox:
    def __init__(self):
        if not config.MAIL_PASSWORD:
            raise SystemExit("MAIL_PASSWORD is not set in .env")
        self.imap = IMAPClient(config.IMAP_HOST, port=config.IMAP_PORT, ssl=True, timeout=60)
        self.imap.login(config.MAILBOX, config.MAIL_PASSWORD)
        folders = self.imap.list_folders()
        self.delim = (folders[0][1].decode() if folders and folders[0][1] else "/")
        self.can_move = b"MOVE" in self.imap.capabilities()
        self.sent_folder = config.SENT_FOLDER or self.imap.find_special_folder(SENT) or "Sent Items"
        for f in (config.CLIENTS_PARENT, config.UNALLOCATED_FOLDER, config.AWAITING_FOLDER,
                  config.APPROVED_FOLDER, config.REJECTED_FOLDER, config.SPAM_FOLDER):
            self.ensure(f)

    def close(self):
        try:
            self.imap.logout()
        except Exception:
            pass

    # Folders
    def client_folder(self, client_name, reference):
        label = clean_folder_name(f"{client_name} - {reference}")
        return f"{config.CLIENTS_PARENT}{self.delim}{label}"

    def ensure(self, folder):
        if not self.imap.folder_exists(folder):
            self.imap.create_folder(folder)
            try:
                self.imap.subscribe_folder(folder)
            except Exception:
                pass
        return folder

    def client_folders(self):
        prefix = config.CLIENTS_PARENT + self.delim
        return [name for _, _, name in self.imap.list_folders(config.CLIENTS_PARENT) if name.startswith(prefix)]

    # Reading
    def messages(self, folder, since_days=None, limit=None, newest_first=False):
        self.imap.select_folder(folder)
        criteria = ["SINCE", date.today() - timedelta(days=since_days)] if since_days else ["ALL"]
        uids = sorted(self.imap.search(criteria))
        if newest_first:
            uids = uids[::-1]
        if limit:
            uids = uids[:limit]
        out = []
        for chunk in range(0, len(uids), 50):
            part = uids[chunk:chunk + 50]
            for uid, data in self.imap.fetch(part, ["BODY.PEEK[]"]).items():
                raw = data.get(b"BODY[]")
                if raw:
                    out.append(Mail(uid, raw, folder))
        return out

    def thread(self, folder, limit=12):
        """The latest messages in a client folder, oldest first."""
        mails = self.messages(folder, limit=limit, newest_first=True)
        return sorted(mails, key=lambda m: m.date)

    # Moving and storing
    def move(self, mail, target):
        self.ensure(target)
        self.imap.select_folder(mail.folder)
        if self.can_move:
            self.imap.move([mail.uid], target)
        else:
            self.imap.copy([mail.uid], target)
            self.imap.delete_messages([mail.uid])
            self.imap.expunge()

    def copy(self, mail, target):
        self.ensure(target)
        self.imap.select_folder(mail.folder)
        self.imap.copy([mail.uid], target)

    def delete(self, mail):
        self.imap.select_folder(mail.folder)
        self.imap.delete_messages([mail.uid])
        self.imap.expunge()

    def store(self, folder, msg, seen=False):
        self.ensure(folder)
        flags = [b"\\Seen"] if seen else []
        self.imap.append(folder, msg.as_bytes(), flags=flags, msg_time=datetime.now(timezone.utc))


def smtp_send(msg):
    """Send one message through IONOS. Only approvals.py and internal.py call this."""
    context = ssl.create_default_context()
    if config.SMTP_PORT == 465:
        with smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, context=context, timeout=60) as s:
            s.login(config.MAILBOX, config.MAIL_PASSWORD)
            s.send_message(msg)
    else:
        with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=60) as s:
            s.starttls(context=context)
            s.login(config.MAILBOX, config.MAIL_PASSWORD)
            s.send_message(msg)

"""Builds every outgoing email: footer, logo, high priority, read receipt, threading."""

import html
import mimetypes
import re
import uuid
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

from . import config

LOGO_CID = "cc-logo"
_ALLOWED = re.compile(r"</?(p|strong|b|em|i|u|ul|ol|li|br|table|tr|td|th|thead|tbody|h3|h4)(\s[^>]*)?/?>", re.I)


def _safe_html(fragment):
    """Keep simple formatting tags only."""
    out, pos = [], 0
    for m in re.finditer(r"<[^>]*>", fragment):
        out.append(html.escape(html.unescape(fragment[pos:m.start()]), quote=False))
        if _ALLOWED.fullmatch(m.group(0)):
            out.append(re.sub(r"\s[^>]*", "", m.group(0)).replace("<br>", "<br/>"))
        pos = m.end()
    out.append(html.escape(html.unescape(fragment[pos:]), quote=False))
    return "".join(out)


def _plain(fragment):
    text = re.sub(r"(?i)<br\s*/?>", "\n", fragment)
    text = re.sub(r"(?i)</p>|</li>|</h\d>", "\n\n", text)
    text = re.sub(r"(?i)<li[^>]*>", "• ", text)
    text = re.sub(r"(?i)</?(strong|b)>", "*", text)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def footer_html():
    if config.FOOTER_FILE.exists():
        return config.FOOTER_FILE.read_text(encoding="utf-8")
    example = config.ROOT / "footer.example.html"
    return example.read_text(encoding="utf-8") if example.exists() else ""


def build(to, subject, body_html, cc=(), attachments=(), in_reply_to=None, references=None, draft_id=None,
          agent="Danny", kind="reply", folder="", raw_html=None):
    msg = EmailMessage()
    msg["From"] = formataddr((config.SENDER_NAME, config.MAILBOX))
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=config.MAILBOX.split("@")[-1])
    # High priority (shows as "!" / priority in Outlook, IONOS and most clients)
    msg["X-Priority"] = "1 (Highest)"
    msg["X-MSMail-Priority"] = "High"
    msg["Importance"] = "High"
    msg["Priority"] = "urgent"
    # Read receipt request (the recipient's email program decides whether to send it)
    msg["Disposition-Notification-To"] = config.MAILBOX
    msg["Return-Receipt-To"] = config.MAILBOX
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = (references + " " if references else "") + in_reply_to
    # Internal tracking for the approval queue
    msg["X-CC-Draft-ID"] = draft_id or uuid.uuid4().hex
    msg["X-CC-Agent"] = agent
    msg["X-CC-Kind"] = kind
    if folder:
        msg["X-CC-Folder"] = folder.encode("unicode_escape").decode("ascii")

    if raw_html is not None:  # internal reports to the Director: sent exactly as built
        msg.set_content(_plain(body_html))
        msg.add_alternative(raw_html, subtype="html")
        for name, ctype, data in attachments:
            maintype, _, subtype = (ctype or "application/octet-stream").partition("/")
            msg.add_attachment(data, maintype=maintype, subtype=subtype or "octet-stream", filename=name)
        return msg
    body = _safe_html(body_html)
    footer = footer_html()
    logo = config.LOGO_FILE if config.LOGO_FILE.exists() else None
    page = (
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">'
        f"{body}<br/>{footer.replace('{{LOGO}}', f'cid:{LOGO_CID}' if logo else '')}</div>"
    )
    msg.set_content(_plain(body_html) + "\n\n--\n" + _plain(footer.replace("{{LOGO}}", "")))
    msg.add_alternative(page, subtype="html")
    if logo and "{{LOGO}}" in footer:
        msg.get_payload()[1].add_related(logo.read_bytes(), "image", "png", cid=f"<{LOGO_CID}>",
                                         filename="logo.png", disposition="inline")
    for name, ctype, data in attachments:
        maintype, _, subtype = (ctype or mimetypes.guess_type(name)[0] or "application/octet-stream").partition("/")
        msg.add_attachment(data, maintype=maintype, subtype=subtype or "octet-stream", filename=name)
    return msg


def folder_of(msg):
    raw = msg.get("X-CC-Folder", "")
    return raw.encode("ascii").decode("unicode_escape") if raw else ""

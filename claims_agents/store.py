"""Local memory: which emails were handled, every claim's chase status, every draft."""

import sqlite3
from datetime import datetime, timezone

from . import config

_DB = config.DATA_DIR / "agents.db"


def now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def db():
    conn = sqlite3.connect(_DB)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS processed (
            message_id TEXT PRIMARY KEY, source TEXT, folder TEXT, at TEXT);
        CREATE TABLE IF NOT EXISTS claims (
            folder TEXT PRIMARY KEY, client_name TEXT, reference TEXT,
            status TEXT DEFAULT 'open',
            last_inbound_at TEXT, last_outbound_at TEXT, last_outbound_to TEXT,
            chase_level INTEGER DEFAULT 0, last_summary TEXT, updated_at TEXT);
        CREATE TABLE IF NOT EXISTS drafts (
            id TEXT PRIMARY KEY, folder TEXT, agent TEXT, kind TEXT,
            recipients TEXT, subject TEXT, status TEXT, note TEXT,
            created_at TEXT, decided_at TEXT);
        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
        """
    )
    return conn


def seen(message_id):
    with db() as c:
        return c.execute("SELECT 1 FROM processed WHERE message_id=?", (message_id,)).fetchone() is not None


def mark_seen(message_id, source, folder):
    with db() as c:
        c.execute("INSERT OR REPLACE INTO processed VALUES (?,?,?,?)", (message_id, source, folder, now()))


def upsert_claim(folder, client_name, reference, summary=None):
    with db() as c:
        c.execute(
            """INSERT INTO claims (folder, client_name, reference, last_summary, updated_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(folder) DO UPDATE SET
                 last_summary=COALESCE(excluded.last_summary, claims.last_summary),
                 updated_at=excluded.updated_at""",
            (folder, client_name, reference, summary, now()),
        )


def touch_claim(folder, direction, when, counterparty=None):
    col = "last_inbound_at" if direction == "in" else "last_outbound_at"
    with db() as c:
        row = c.execute(f"SELECT {col} FROM claims WHERE folder=?", (folder,)).fetchone()
        if row is None:
            return
        if row[col] is None or when > row[col]:
            c.execute(f"UPDATE claims SET {col}=?, updated_at=? WHERE folder=?", (when, now(), folder))
            if direction == "out" and counterparty:
                c.execute("UPDATE claims SET last_outbound_to=? WHERE folder=?", (counterparty, folder))
        if direction == "in":
            # The other side replied, so the chase ladder restarts from that reply.
            c.execute("UPDATE claims SET chase_level=0 WHERE folder=? AND last_inbound_at=?", (folder, when))


def claims(status="open"):
    with db() as c:
        return [dict(r) for r in c.execute("SELECT * FROM claims WHERE status=? ORDER BY updated_at DESC", (status,))]


def known_folders():
    with db() as c:
        return [r["folder"] for r in c.execute("SELECT folder FROM claims")]


def bump_chase(folder):
    with db() as c:
        c.execute("UPDATE claims SET chase_level=chase_level+1 WHERE folder=?", (folder,))


def add_draft(draft_id, folder, agent, kind, recipients, subject, note):
    with db() as c:
        c.execute(
            "INSERT INTO drafts VALUES (?,?,?,?,?,?,?,?,?,NULL)",
            (draft_id, folder, agent, kind, ", ".join(recipients), subject, "awaiting", note, now()),
        )


def pending_draft(folder):
    with db() as c:
        return c.execute(
            "SELECT 1 FROM drafts WHERE folder=? AND status='awaiting'", (folder,)
        ).fetchone() is not None


def recent_draft(folder, since):
    """Any draft (sent, rejected or pending) for this file created after `since`."""
    with db() as c:
        return c.execute("SELECT 1 FROM drafts WHERE folder=? AND created_at>?", (folder, since)).fetchone() is not None


def draft(draft_id):
    with db() as c:
        r = c.execute("SELECT * FROM drafts WHERE id=?", (draft_id,)).fetchone()
        return dict(r) if r else None


def set_draft_status(draft_id, status):
    with db() as c:
        c.execute("UPDATE drafts SET status=?, decided_at=? WHERE id=?", (status, now(), draft_id))


def drafts(status="awaiting"):
    with db() as c:
        return [dict(r) for r in c.execute("SELECT * FROM drafts WHERE status=? ORDER BY created_at", (status,))]


def get(k, default=None):
    with db() as c:
        r = c.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return r["v"] if r else default


def put(k, v):
    with db() as c:
        c.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", (k, v))

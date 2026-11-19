"""Local memory: emails handled, claims, drafts, employees, tasks and the activity feed."""

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
        CREATE TABLE IF NOT EXISTS employees (
            id TEXT PRIMARY KEY, name TEXT, title TEXT, kind TEXT, role_prompt TEXT,
            enabled INTEGER DEFAULT 1, hue INTEGER, created_at TEXT, sort INTEGER DEFAULT 100);
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, employee TEXT, title TEXT, details TEXT,
            folder TEXT, status TEXT, result TEXT, summary TEXT, draft_id TEXT,
            created_at TEXT, started_at TEXT, finished_at TEXT);
        CREATE TABLE IF NOT EXISTS activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, employee TEXT, text TEXT);
        """
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(drafts)")}
    if "body_html" not in cols:
        conn.execute("ALTER TABLE drafts ADD COLUMN body_html TEXT")
    if conn.execute("SELECT COUNT(*) FROM employees").fetchone()[0] == 0:
        for i, (eid, name, title, hue) in enumerate(CORE_EMPLOYEES):
            conn.execute("INSERT INTO employees VALUES (?,?,?,?,?,?,?,?,?)",
                         (eid, name, title, "core", "", 1, hue, now(), i))
        conn.commit()
    return conn


CORE_EMPLOYEES = [
    ("danny", "Danny Kaleem", "Claims Manager", 215),
    ("harry", "Harry", "Claims Handler", 160),
    ("hemant", "Hemant", "Head of Legal & Audit", 265),
]


def use_db(path):
    global _DB
    _DB = path


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


def add_draft(draft_id, folder, agent, kind, recipients, subject, note, body_html=""):
    with db() as c:
        c.execute(
            "INSERT INTO drafts (id, folder, agent, kind, recipients, subject, status, note, created_at, body_html)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (draft_id, folder, agent, kind, ", ".join(recipients), subject, "awaiting", note, now(), body_html),
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


# ---------------------------------------------------------------- employees

def employees():
    with db() as c:
        return [dict(r) for r in c.execute("SELECT * FROM employees ORDER BY sort, created_at")]


def employee(eid):
    with db() as c:
        r = c.execute("SELECT * FROM employees WHERE id=?", (eid,)).fetchone()
        return dict(r) if r else None


def enabled(eid):
    e = employee(eid)
    return bool(e and e["enabled"])


def set_enabled(eid, on):
    with db() as c:
        c.execute("UPDATE employees SET enabled=? WHERE id=?", (1 if on else 0, eid))


def hire(name, title, role_prompt, hue):
    import re
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "employee"
    eid, n = base, 2
    while employee(eid):
        eid, n = f"{base}-{n}", n + 1
    with db() as c:
        c.execute("INSERT INTO employees VALUES (?,?,?,?,?,?,?,?,?)",
                  (eid, name, title, "custom", role_prompt, 1, hue, now(), 100))
    return eid


def update_employee(eid, **fields):
    allowed = {k: v for k, v in fields.items() if k in ("name", "title", "role_prompt", "hue")}
    if not allowed:
        return
    with db() as c:
        c.execute(f"UPDATE employees SET {', '.join(k + '=?' for k in allowed)} WHERE id=?", (*allowed.values(), eid))


def fire(eid):
    with db() as c:
        c.execute("DELETE FROM employees WHERE id=? AND kind='custom'", (eid,))


# ---------------------------------------------------------------- tasks

def add_task(employee_id, title, details="", folder=""):
    with db() as c:
        cur = c.execute(
            "INSERT INTO tasks (employee, title, details, folder, status, created_at) VALUES (?,?,?,?,?,?)",
            (employee_id, title, details, folder, "queued", now()))
        return cur.lastrowid


def tasks(limit=100):
    with db() as c:
        return [dict(r) for r in c.execute("SELECT * FROM tasks ORDER BY id DESC LIMIT ?", (limit,))]


def next_task():
    with db() as c:
        r = c.execute("""SELECT t.* FROM tasks t JOIN employees e ON e.id=t.employee
                         WHERE t.status='queued' AND e.enabled=1 ORDER BY t.id LIMIT 1""").fetchone()
        if r is None:
            return None
        c.execute("UPDATE tasks SET status='running', started_at=? WHERE id=?", (now(), r["id"]))
        return dict(r)


def finish_task(task_id, status, summary="", result="", draft_id=None):
    with db() as c:
        c.execute("UPDATE tasks SET status=?, summary=?, result=?, draft_id=?, finished_at=? WHERE id=?",
                  (status, summary, result, draft_id, now(), task_id))


def cancel_task(task_id):
    with db() as c:
        c.execute("UPDATE tasks SET status='cancelled', finished_at=? WHERE id=? AND status='queued'", (now(), task_id))


# ---------------------------------------------------------------- activity feed

def activity(employee_id, text):
    with db() as c:
        c.execute("INSERT INTO activity (ts, employee, text) VALUES (?,?,?)", (now(), employee_id, text[:500]))
        c.execute("DELETE FROM activity WHERE id < (SELECT MAX(id) - 2000 FROM activity)")


def recent_activity(limit=60):
    with db() as c:
        return [dict(r) for r in c.execute("SELECT * FROM activity ORDER BY id DESC LIMIT ?", (limit,))]


def count(sql, *args):
    with db() as c:
        return c.execute(sql, args).fetchone()[0]

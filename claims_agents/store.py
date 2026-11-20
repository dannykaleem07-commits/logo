"""Local memory: emails handled, claims, drafts, employees, tasks and the activity feed."""

import json
import sqlite3
from datetime import datetime, timedelta, timezone

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
        CREATE TABLE IF NOT EXISTS rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT, situation TEXT, instruction TEXT, source TEXT,
            decision_id INTEGER, active INTEGER DEFAULT 1, uses INTEGER DEFAULT 0, created_at TEXT);
        CREATE TABLE IF NOT EXISTS decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, employee TEXT, folder TEXT, situation TEXT,
            suggestion TEXT, status TEXT, answer TEXT, created_at TEXT, decided_at TEXT);
        CREATE TABLE IF NOT EXISTS turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, role TEXT, content TEXT,
            actions TEXT, anchors TEXT, voice INTEGER DEFAULT 0, ts TEXT);
        CREATE INDEX IF NOT EXISTS turns_session ON turns(session, id);
        CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT, due_ts TEXT, text TEXT, session TEXT,
            status TEXT DEFAULT 'open', created_at TEXT, done_at TEXT);
        """
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(drafts)")}
    if "body_html" not in cols:
        conn.execute("ALTER TABLE drafts ADD COLUMN body_html TEXT")
    if "gist" not in cols:
        conn.execute("ALTER TABLE drafts ADD COLUMN gist TEXT")
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


def add_draft(draft_id, folder, agent, kind, recipients, subject, note, body_html="", gist=""):
    with db() as c:
        c.execute(
            "INSERT INTO drafts (id, folder, agent, kind, recipients, subject, status, note, created_at, body_html, gist)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (draft_id, folder, agent, kind, ", ".join(recipients), subject, "awaiting", note, now(), body_html, gist or ""),
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


# ---------------------------------------------------------------- standing orders

def rules(active_only=False):
    with db() as c:
        q = "SELECT * FROM rules" + (" WHERE active=1" if active_only else "") + " ORDER BY id DESC"
        return [dict(r) for r in c.execute(q)]


def add_rule(situation, instruction, source, decision_id=None):
    with db() as c:
        return c.execute("INSERT INTO rules (situation, instruction, source, decision_id, created_at) VALUES (?,?,?,?,?)",
                         (situation, instruction, source, decision_id, now())).lastrowid


def set_rule(rule_id, **fields):
    allowed = {k: v for k, v in fields.items() if k in ("situation", "instruction", "active")}
    if allowed:
        with db() as c:
            c.execute(f"UPDATE rules SET {', '.join(k + '=?' for k in allowed)} WHERE id=?", (*allowed.values(), rule_id))


def delete_rule(rule_id):
    with db() as c:
        c.execute("DELETE FROM rules WHERE id=?", (rule_id,))


# ---------------------------------------------------------------- decisions

def add_decision(employee, folder, situation, suggestion):
    with db() as c:
        return c.execute(
            "INSERT INTO decisions (employee, folder, situation, suggestion, status, created_at) VALUES (?,?,?,?,?,?)",
            (employee, folder or "", situation, json.dumps(suggestion) if suggestion else None, "open", now())).lastrowid


def _dec(r):
    d = dict(r)
    try:
        d["suggestion"] = json.loads(d["suggestion"]) if d["suggestion"] else None
    except ValueError:
        d["suggestion"] = None
    return d


def decisions(status=None, limit=50):
    with db() as c:
        q = "SELECT * FROM decisions" + (" WHERE status=?" if status else "") + " ORDER BY id DESC LIMIT ?"
        return [_dec(r) for r in c.execute(q, ((status, limit) if status else (limit,)))]


def decision(decision_id):
    with db() as c:
        r = c.execute("SELECT * FROM decisions WHERE id=?", (decision_id,)).fetchone()
        return _dec(r) if r else None


def close_decision(decision_id, answer, status="decided"):
    with db() as c:
        c.execute("UPDATE decisions SET status=?, answer=?, decided_at=? WHERE id=?", (status, answer, now(), decision_id))


# ---------------------------------------------------------------- assistant memory (conversation turns)

def add_turn(session, role, content, actions=None, anchors=None, voice=False):
    """One line of the conversation with the assistant. `anchors` carries the ids it referred to."""
    with db() as c:
        rid = c.execute(
            "INSERT INTO turns (session, role, content, actions, anchors, voice, ts) VALUES (?,?,?,?,?,?,?)",
            (session or "default", role, (content or "")[:6000],
             json.dumps(actions) if actions else None, json.dumps(anchors) if anchors else None,
             1 if voice else 0, now())).lastrowid
        c.execute("DELETE FROM turns WHERE session=? AND id < (SELECT MAX(id) - 400 FROM turns WHERE session=?)",
                  (session or "default", session or "default"))
        return rid


def _turn(r):
    d = dict(r)
    for k in ("actions", "anchors"):
        try:
            d[k] = json.loads(d[k]) if d[k] else None
        except ValueError:
            d[k] = None
    return d


def turns(session, limit=40, after_id=0):
    """The last `limit` turns of a session, oldest first (only those after `after_id`)."""
    with db() as c:
        rows = c.execute("SELECT * FROM turns WHERE session=? AND id>? ORDER BY id DESC LIMIT ?",
                         (session or "default", after_id, limit)).fetchall()
        return [_turn(r) for r in reversed(rows)]


def turns_before(session, before_id, limit=20):
    """The `limit` oldest turns of a session with id <= before_id (for the summariser), oldest first."""
    with db() as c:
        rows = c.execute("SELECT * FROM turns WHERE session=? AND id<=? ORDER BY id ASC LIMIT ?",
                         (session or "default", before_id, limit)).fetchall()
        return [_turn(r) for r in rows]


def turn_count(session, after_id=0):
    return count("SELECT COUNT(*) FROM turns WHERE session=? AND id>?", session or "default", after_id)


def memory(session):
    """{"summary": str, "upto_turn_id": int, "facts": [str]} for a session (empty when none)."""
    try:
        m = json.loads(get(f"memory:{session or 'default'}") or "{}")
    except ValueError:
        m = {}
    return {"summary": m.get("summary") or "", "upto_turn_id": int(m.get("upto_turn_id") or 0),
            "facts": [f for f in (m.get("facts") or []) if isinstance(f, str)][:40]}


def put_memory(session, mem):
    put(f"memory:{session or 'default'}", json.dumps({
        "summary": (mem.get("summary") or "")[:1200], "upto_turn_id": int(mem.get("upto_turn_id") or 0),
        "facts": [f[:200] for f in (mem.get("facts") or []) if isinstance(f, str)][:40]}))


# ---------------------------------------------------------------- reminders (the assistant's own diary)

def add_reminder(due_ts, text, session="default"):
    with db() as c:
        return c.execute("INSERT INTO reminders (due_ts, text, session, status, created_at) VALUES (?,?,?,?,?)",
                         (due_ts, (text or "")[:300], session or "default", "open", now())).lastrowid


def reminders(status="open", limit=50):
    with db() as c:
        return [dict(r) for r in c.execute("SELECT * FROM reminders WHERE status=? ORDER BY due_ts LIMIT ?", (status, limit))]


def due_reminders():
    """Open reminders whose time has come (oldest first)."""
    return [r for r in reminders("open") if r["due_ts"] <= now()]


def dismiss_reminder(reminder_id, status="done"):
    with db() as c:
        c.execute("UPDATE reminders SET status=?, done_at=? WHERE id=? AND status='open'", (status, now(), reminder_id))
        return c.execute("SELECT changes()").fetchone()[0] > 0


def search_activity(query="", employee="", days=7, limit=15):
    """Activity lines matching a word or phrase, newest first."""
    since = (datetime.now(timezone.utc) - timedelta(days=max(1, int(days or 7)))).isoformat()
    q = f"%{(query or '').strip()}%"
    with db() as c:
        sql = "SELECT * FROM activity WHERE ts>=? AND text LIKE ?"
        args = [since, q]
        if employee:
            sql += " AND employee=?"
            args.append(employee)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        return [dict(r) for r in c.execute(sql, args)]

"""Tasks the Director assigns to any employee, the hub snapshot, and the personal assistant."""

import json
import logging
import os
import re
import threading
from datetime import datetime, timedelta, timezone

from . import brain, config, store
from .brain import B, LS, S, obj

log = logging.getLogger("agents")

# Set by the hub: wakes the agent loop for an immediate pass.
RUN_NOW = threading.Event()


# ---------------------------------------------------------------- employee prompts

def role_prompt(e):
    from . import hemant, team
    if e["id"] == "danny":
        base = team.DANNY
    elif e["id"] == "harry":
        base = team.HARRY
    elif e["id"] == "hemant":
        base = hemant.HEMANT
    else:
        base = (f"YOU ARE {e['name'].upper()}, {e['title']} at Courtesy Cars Group UK, part of the claims "
                f"team with Danny (Claims Manager), Harry (Claims Handler) and Hemant (Head of Legal & Audit).\n")
    return base + ("\nYOUR BRIEF FROM THE DIRECTOR:\n" + e["role_prompt"] if e.get("role_prompt") else "")


# ---------------------------------------------------------------- tasks

TASK_SCHEMA = obj({
    "summary_for_director": S,
    "result_html": S,
    "email_needed": B,
    "email": obj({"to": LS, "cc": LS, "subject": S, "body_html": S, "attach": LS}),
})


def run_task(task, box=None):
    from . import team
    e = store.employee(task["employee"])
    folder = task["folder"] or ""
    context, docs = "", {}
    if folder and box is not None:
        context = f"\n\nCLAIM FILE {folder} (latest emails, oldest first):\n{team._file_context(box, folder)}"
        docs = team._available_docs(box, folder)
        context += f"\n\nDocuments available to attach (exact names): {json.dumps(list(docs))}"
    elif folder:
        c = next((c for c in store.claims() if c["folder"] == folder), None)
        if c:
            context = f"\n\nCLAIM FILE {folder} (summary only): {json.dumps(c)}"
    text = (
        f"Today: {datetime.now():%d %B %Y}\nTASK FROM {config.DIRECTOR_NAME.upper()} (the Director): "
        f"{task['title']}\n{task['details'] or ''}{context}\n\n"
        "Do the task fully. result_html is your finished work product for the Director (simple HTML: "
        "<h3>, <p>, <ul>, <strong>, <table>). summary_for_director is one or two plain sentences he can "
        "hear read aloud. If the task needs an email to an outside party, set email_needed=true and draft "
        "it in email: it will wait for the Director's approval, never send it yourself."
        + brain.HTML_RULES
    )
    d = brain.ask_json(role_prompt(e), text, TASK_SCHEMA, effort="high")
    draft_id = None
    if d["email_needed"] and d["email"]["to"]:
        if box is None:
            d["summary_for_director"] += " (Email drafted in the result: connect the mailbox to queue it.)"
        else:
            em = d["email"]
            draft_id = team._queue(box, e["name"], "task", folder, {
                "skip": False, "skip_reason": "", "to": em["to"], "cc": em["cc"], "subject": em["subject"],
                "body_html": em["body_html"], "attach": em["attach"], "escalation_step": "task",
                "response_deadline": "", "note_for_director": f"Task #{task['id']}: {task['title']}"}, docs)
    from .emailfmt import _safe_html
    store.finish_task(task["id"], "done", d["summary_for_director"], _safe_html(d["result_html"]), draft_id)
    store.activity(e["id"], f"Finished task: {task['title']}")


# ---------------------------------------------------------------- hub snapshot

def mailbox_ready():
    return bool(config.MAIL_PASSWORD)


def ai_ready():
    return bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))


def ai_hint():
    """Why the assistant and tasks are off, in the Director's words (empty when they are on)."""
    if ai_ready():
        return ""
    if store.get("demo") == "1":
        return "The assistant and tasks are off in demo mode: add ANTHROPIC_API_KEY to .env and restart the hub to switch the team on."
    return "The assistant and tasks are off until ANTHROPIC_API_KEY is added to the .env file on this computer and the hub is restarted."


def tts_hint(status):
    if not status.get("ok") and status.get("fails"):
        return "The natural voice service is unreachable right now; the browser voice is used instead."
    return ""


def snapshot():
    from . import logic
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    week = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    acts = store.recent_activity(80)
    emps = []
    for e in store.employees():
        last = next((a for a in acts if a["employee"] == e["id"]), None)
        mine = [t for t in store.tasks(200) if t["employee"] == e["id"]]
        names = {e["name"], e["name"].split()[0]}
        emps.append({
            **{k: e[k] for k in ("id", "name", "title", "kind", "enabled", "hue", "role_prompt")},
            "last": last,
            "busy": bool(last and last["ts"] > (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()),
            "stats": {
                "drafts_today": sum(store.count("SELECT COUNT(*) FROM drafts WHERE agent=? AND created_at>?", n, today)
                                    for n in names),
                "tasks_open": sum(t["status"] in ("queued", "running") for t in mine),
                "tasks_done": sum(t["status"] == "done" for t in mine),
            },
        })
    claims = store.claims()
    return {
        "director": config.DIRECTOR_NAME,
        "assistant": store.get("assistant_name", "Aria"),
        "mailbox": config.MAILBOX,
        "mailbox_ready": mailbox_ready(),
        "ai_ready": ai_ready(),
        "demo": store.get("demo") == "1",
        "scan_minutes": config.SCAN_MINUTES,
        "last_pass": store.get("last_pass"),
        "employees": emps,
        "harry_helpers": _helpers(),
        "kpis": {
            "filed_today": store.count("SELECT COUNT(*) FROM processed WHERE at>? AND source='INBOX'", today),
            "awaiting": store.count("SELECT COUNT(*) FROM drafts WHERE status='awaiting'"),
            "sent_week": store.count("SELECT COUNT(*) FROM drafts WHERE status='sent' AND decided_at>?", week),
            "open_claims": len(claims),
            "overdue": sum(1 for c in claims if c["last_outbound_at"] and (not c["last_inbound_at"] or c["last_outbound_at"] > c["last_inbound_at"])
                           and c["last_outbound_at"] < (datetime.now(timezone.utc) - timedelta(hours=config.FOLLOWUP_HOURS)).isoformat()),
        },
        "drafts": store.drafts("awaiting"),
        "decisions": store.decisions("open"),
        "decisions_open": len(store.decisions("open")),
        "rules": store.rules()[:100],
        "ai_hint": ai_hint(),
        "tts_ready": logic.tts_ready(),
        "tts_ok": logic.tts_status()["ok"],
        "tts_hint": tts_hint(logic.tts_status()),
        "tts_voice": logic.current_voice(),
        "reminders": store.due_reminders(),
        "recent_sent": [d for d in _drafts_any(20) if d["status"] != "awaiting"],
        "claims": claims[:200],
        "tasks": store.tasks(80),
        "activity": acts,
        "hourly": _hourly(),
    }


def _helpers():
    from .team import HARRY_ROLES
    return HARRY_ROLES


def _drafts_any(limit):
    with store.db() as c:
        return [dict(r) for r in c.execute("SELECT * FROM drafts ORDER BY created_at DESC LIMIT ?", (limit,))]


def _hourly():
    """Activity count per hour for the last 24 hours (for the sparkline)."""
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    buckets = [0] * 24
    for a in store.recent_activity(2000):
        try:
            ts = datetime.fromisoformat(a["ts"])
        except ValueError:
            continue
        h = int((now - ts.replace(minute=0, second=0)).total_seconds() // 3600)
        if 0 <= h < 24:
            buckets[23 - h] += 1
    return buckets


# ---------------------------------------------------------------- personal assistant

YES = re.compile(r"^\s*(yes|yeah|yep|yup|sure|ok(ay)?|go ahead|go on|do it|do that|please do|confirmed|confirm|fine|"
                 r"agreed|that's right|correct|proceed|carry on|make it so)\b[\s.!,]*(please|thanks|thank you)?[\s.!]*$", re.I)
NO = re.compile(r"^\s*(no|nope|don't|do not|stop|wait|hold on|hang on|leave it|cancel|never ?mind|not now|not yet|scrap that)\b", re.I)
READ_ONLY = {"get_briefing", "find_claims", "get_task_result", "list_standing_orders", "open_view", "read_draft",
             "speak_draft", "get_draft", "get_decision", "find_activity", "search_activity", "list_overdue"}
SETUP_REPLY_SHORT = "I'm not connected to Claude yet. The setup note is in the chat."
SETUP_REPLY_LONG = ("I need a Claude API key before I can help. Add ANTHROPIC_API_KEY to the .env file on this "
                    "computer and restart the hub.")


def _find_employee(name):
    name = (name or "").lower().strip()
    for e in store.employees():
        if name in (e["id"], e["name"].lower()) or name == e["name"].split()[0].lower():
            return e
    for e in store.employees():
        if name and name in e["name"].lower():
            return e
    return None


def _plain(html_fragment):
    from .emailfmt import _plain as plain
    try:
        return plain(html_fragment or "")
    except Exception:
        return re.sub(r"<[^>]+>", " ", html_fragment or "")


def _gist(d, n=140):
    """One line about a draft: the stored gist, else the first sentences of the letter, else the note."""
    g = (d.get("gist") or "").strip()
    if not g:
        body = _plain(d.get("body_html") or "")
        body = re.sub(r"^(Dear [^\n]{0,60}\n+)", "", body).strip()
        g = re.sub(r"\s+", " ", body)
    if not g:
        g = (d.get("note") or "").strip()
    return g[:n].rstrip() + ("…" if len(g) > n else "")


def _days_ago(ts):
    try:
        return max(0, int((datetime.now(timezone.utc) - datetime.fromisoformat(ts)).total_seconds() // 86400))
    except (TypeError, ValueError):
        return 0


def _client_name(folder):
    m = re.search(r"/([^/]+?)\s+-\s+[A-Z]{2}\d+$", folder or "")
    return m.group(1) if m else (folder or "").split("/")[-1]


def _overdue(claims):
    limit = (datetime.now(timezone.utc) - timedelta(hours=config.FOLLOWUP_HOURS)).isoformat()
    out = []
    for c in claims:
        if c["last_outbound_at"] and (not c["last_inbound_at"] or c["last_outbound_at"] > c["last_inbound_at"]) \
                and c["last_outbound_at"] < limit:
            out.append(c)
    return sorted(out, key=lambda c: c["last_outbound_at"])


def _brief():
    s = snapshot()
    return json.dumps({
        "kpis": s["kpis"],
        "employees": [{"name": e["name"], "title": e["title"], "on": bool(e["enabled"]),
                       "last_activity": e["last"]["text"] if e["last"] else None, **e["stats"]} for e in s["employees"]],
        "awaiting_approval": [{"id": d["id"], "subject": d["subject"], "to": d["recipients"], "by": d["agent"], "note": d["note"],
                               "gist": _gist(d)} for d in s["drafts"][:15]],
        "recent_tasks": [{"id": t["id"], "for": t["employee"], "title": t["title"], "status": t["status"], "summary": t["summary"]} for t in s["tasks"][:12]],
        "recent_activity": [f"{a['ts'][11:16]} {a['employee']}: {a['text']}" for a in s["activity"][:25]],
        "open_decisions": [{"id": d["id"], "asked_by": d["employee"], "situation": d["situation"]} for d in s["decisions"][:10]],
        "overdue_files": [{"folder": c["folder"], "client": c["client_name"], "days": _days_ago(c["last_outbound_at"]),
                           "chase_step": c["chase_level"]} for c in _overdue(s["claims"])[:10]],
        "reminders": [{"id": r["id"], "due": r["due_ts"], "text": r["text"]} for r in store.reminders("open")[:10]],
        "standing_orders_count": len(s["rules"]),
        "mailbox_connected": s["mailbox_ready"], "last_pass": s["last_pass"],
    })


# ---- context pack: everything the assistant should already know, numbered so short references resolve

def _mentioned(session, n=6):
    ids = {}
    for t in store.turns(session, limit=n * 2)[-n:]:
        for k, v in ((t.get("anchors") or {}).get("mentioned") or {}).items():
            ids.setdefault(k, [])
            for x in (v if isinstance(v, list) else [v]):
                if x not in ids[k]:
                    ids[k].append(x)
    return ids


def _pending(session):
    for t in reversed(store.turns(session, limit=4)):
        if t["role"] == "assistant":
            return (t.get("anchors") or {}).get("pending_action")
        if t["role"] == "user":
            continue
    return None


def context_pack(session="default", anchors=None, client_time=None, snap=None, max_chars=14000):
    """The per-call state block (last system block). Returns (text, index) where index maps the
    labels D1/Q1/F1 to real ids so tools can resolve 'the second one'."""
    from . import logic
    s = snap or snapshot()
    anchors = anchors or {}
    k = s["kpis"]
    index = {}
    now = datetime.now()
    sec = []
    sec.append(("NOW", f"{now:%A %d %B %Y, %H:%M} (Europe/London)" + (f"; his device says {client_time}" if client_time else "")))
    sec.append(("TODAY", f"{k['awaiting']} draft{'s' if k['awaiting'] != 1 else ''} awaiting his approval, {k['overdue']} overdue "
                f"file{'s' if k['overdue'] != 1 else ''}, {s['decisions_open']} decision{'s' if s['decisions_open'] != 1 else ''} open, "
                f"{k['filed_today']} email{'s' if k['filed_today'] != 1 else ''} filed today, {k['sent_week']} sent this week, "
                f"{k['open_claims']} open files. Mailbox {'connected' if s['mailbox_ready'] else 'not connected'}"
                + ("; demo data" if s["demo"] else "") + "."))
    drafts = []
    for i, d in enumerate(s["drafts"][:12], 1):
        index[f"D{i}"] = d["id"]
        drafts.append(f"D{i} [{d['id']}] {d['agent']} -> {d['recipients']}: \"{d['subject']}\" (client: {_client_name(d['folder'])}; "
                      f"gist: {_gist(d)}; waiting {_days_ago(d['created_at'])} day(s))")
    sec.append(("DRAFTS AWAITING HIS APPROVAL (he approves in the hub; you cannot)", "\n".join(drafts) or "none"))
    decs = []
    for i, d in enumerate(s["decisions"][:6], 1):
        index[f"Q{i}"] = d["id"]
        sug = d.get("suggestion") or {}
        opts = "; ".join(f"{chr(97 + j)}) {o}" for j, o in enumerate((sug.get("options") or [])[:4]))
        decs.append(f"Q{i} [{d['id']}] from {d['employee']} on {_client_name(d['folder']) or 'no file'}: {d['situation'][:160]}"
                    + (f" Recommended: {sug.get('recommended', '')[:200]}" if sug.get("recommended") else "")
                    + (f" Options: {opts}" if opts else ""))
    sec.append(("DECISIONS WAITING ON HIM", "\n".join(decs) or "none"))
    over = []
    for i, c in enumerate(_overdue(s["claims"])[:8], 1):
        index[f"F{i}"] = c["folder"]
        over.append(f"F{i} {c['folder']} — {c['client_name']} — last outbound {_days_ago(c['last_outbound_at'])} days ago, "
                    f"chase step {c['chase_level']}/5; {(c['last_summary'] or '')[:100]}")
    sec.append(("OVERDUE FILES (the other side owes a reply)", "\n".join(over) or "none"))
    rems = [f"R{i} [{r['id']}] {r['due_ts'][:16].replace('T', ' ')}: {r['text']}" for i, r in enumerate(store.reminders("open")[:8], 1)]
    for i, r in enumerate(store.reminders("open")[:8], 1):
        index[f"R{i}"] = r["id"]
    sec.append(("REMINDERS", "\n".join(rems) or "none"))
    tasks = [f"T{t['id']} {t['employee']}: {t['title'][:70]} — {t['status']}" + (f" ({t['summary'][:80]})" if t.get("summary") else "")
             for t in s["tasks"][:8]]
    sec.append(("RECENT TASKS", "\n".join(tasks) or "none"))
    sec.append(("ACTIVITY (latest first)", "\n".join(f"{a['ts'][11:16]} {a['employee']}: {a['text'][:110]}" for a in s["activity"][:10]) or "none"))
    orders = logic.orders_text(limit=25).strip()
    sec.append(("STANDING ORDERS", orders or "none"))
    team = [f"{e['name']} ({e['title']}): {'on' if e['enabled'] else 'OFF'}{', busy' if e['busy'] else ''}"
            + (f"; last: {e['last']['text'][:40]}" if e["last"] else "") for e in s["employees"]]
    sec.append(("TEAM", "\n".join(team)))
    try:
        last = json.loads(store.get("assistant:last") or "{}")
    except ValueError:
        last = {}
    last_user = next((t["content"] for t in reversed(store.turns(session, limit=6)) if t["role"] == "user"), "")
    sec.append(("LAST SAID", f"You last said: {(last.get('text') or '')[:300] or 'nothing yet'}\nHe last said: {last_user[:200] or 'nothing yet'}"))
    screen = []
    if anchors.get("view"):
        screen.append(f"he is looking at the {anchors['view']} page")
    sheet = anchors.get("open_sheet") or {}
    if isinstance(sheet, dict) and sheet.get("kind"):
        screen.append(f"a {sheet['kind']} sheet is open ({sheet.get('id', '')})")
    if anchors.get("selected_draft"):
        screen.append(f"the selected draft is {anchors['selected_draft']}")
    sec.append(("SCREEN", "; ".join(screen) or "unknown"))
    mentioned = _mentioned(session)
    for x in (anchors.get("last_mentioned_ids") or [])[:10]:
        mentioned.setdefault("client", []).append(str(x)[:60])
    sec.append(("MENTIONED (ids and people from the last few turns)", "; ".join(f"{k}: {', '.join(map(str, v[:6]))}" for k, v in mentioned.items()) or "none"))
    pending = _pending(session)
    if pending:
        sec.append(("PENDING (you asked for his confirmation; if he says yes, call the tool again with the same arguments and do not ask again)",
                    f"{pending.get('tool')} {json.dumps(pending.get('args') or {})}"))
    mem = store.memory(session)
    try:
        shared = json.loads(store.get("memory:all") or "{}")
    except ValueError:
        shared = {}
    memo = []
    if mem["summary"]:
        memo.append("Earlier in this conversation: " + mem["summary"])
    if mem["facts"]:
        memo.append("Things to remember: " + "; ".join(mem["facts"][:20]))
    if shared.get("facts"):
        memo.append("About him (any device): " + "; ".join(shared["facts"][:20]))
    sec.append(("MEMORY", "\n".join(memo) or "nothing yet"))
    text = "\n\n".join(f"{h}:\n{b}" for h, b in sec)
    # Size cap: trim activity, then drafts, then orders, before anything else.
    for h in ("ACTIVITY (latest first)", "DRAFTS AWAITING HIS APPROVAL (he approves in the hub; you cannot)", "STANDING ORDERS"):
        if len(text) <= max_chars:
            break
        sec = [(hh, (b.split("\n")[0] + " …") if hh == h and len(b) > 200 else b) for hh, b in sec]
        text = "\n\n".join(f"{hh}:\n{b}" for hh, b in sec)
    return text[:max_chars], index


REF_KEYS = ("draft_id", "decision_id", "claim_folder", "reminder_id", "task_id", "rule_id", "id")


def _resolve_ref(args, index):
    """'D2' -> the second draft's id, 'Q1', 'F1', 'R1', 'T3' likewise, but only in the id-bearing arguments:
    free text (a reminder, a task title, an answer, a search query) is never rewritten."""
    for k in REF_KEYS:
        v = args.get(k)
        if isinstance(v, str) and re.fullmatch(r"[DQFRT]\d{1,2}", v.strip().upper()):
            label = v.strip().upper()
            if label in index:
                args[k] = index[label]
            elif label[0] == "T":
                args[k] = int(label[1:])
    for k in ("decision_id", "rule_id", "task_id", "reminder_id"):
        if k in args and isinstance(args[k], str) and args[k].isdigit():
            args[k] = int(args[k])
    return args


# ---- tools

def _tool(name, desc, props, required=None):
    return {"name": name, "description": desc, "input_schema": obj(props, required)}


def _confirmable(props):
    """A tool the gate guards. The model never sees a 'confirmed' flag: consent is mechanical (see _run_tool)."""
    return props, list(props)


TOOLS = [
    _tool("get_briefing", "Everything at once (KPIs, team, drafts, tasks, activity, decisions, overdue files, reminders). "
          "The context pack already has most of this: call it only for detail the pack lacks.", {}),
    _tool("find_claims", "Search claim files by client name or reference.", {"query": S}),
    _tool("list_overdue", "Overdue files: who we are waiting on, days silent, chase step.", {}),
    _tool("get_draft", "Subject, recipient, note and gist of a draft awaiting approval (read-only). draft_id may be a label like D2.",
          {"draft_id": S}),
    _tool("read_draft", "Read a draft letter to him: returns the gist and the letter text (<= 900 chars) and makes the hub speak it. "
          "Read-only: it never approves or sends. draft_id may be a label like D2.", {"draft_id": S}),
    _tool("get_decision", "The full recommendation, options and risk for an open decision (read-only). decision_id may be Q1.",
          {"decision_id": S}),
    _tool("find_activity", "Search the team's activity log for a word, a client or an employee over the last N days.",
          {"query": S, "employee": S, "days": {"type": "integer"}}, ["query"]),
    _tool("open_view", "Show something on his screen: a page (today, approvals, logic, team, files) and optionally a draft, "
          "file, person or report. Read-only.", {"view": S, "kind": S, "id": S}, ["view"]),
    _tool("set_reminder", "Remind him later: when = 'in 20 minutes', 'at 3pm', 'tomorrow 9', or ISO time; text = what to say.",
          {"when": S, "text": S}),
    _tool("dismiss_reminder", "Clear a reminder by id (or label R1).", {"reminder_id": S}),
    _tool("set_employee_status", "Switch an employee on or off. Switching OFF needs his confirmation: ask first, then call "
          "it again once he has said yes.", *_confirmable({"employee": S, "on": B})),
    _tool("assign_task", "Give an employee a task. claim_folder is optional (exact folder from find_claims, label F1, or ''). "
          "If the task means emailing anyone, confirm with him first and call it again once he has said yes.",
          *_confirmable({"employee": S, "title": S, "details": S, "claim_folder": S})),
    _tool("cancel_task", "Cancel a queued task by id. Needs his confirmation: ask, then call it again once he has said yes.",
          *_confirmable({"task_id": {"type": "integer"}})),
    _tool("run_now", "Start an immediate pass: send approved drafts, scan the inbox, draft replies and chase.", {}),
    _tool("get_task_result", "Read the full result of a task by id.", {"task_id": {"type": "integer"}}),
    _tool("list_standing_orders", "The Director's standing orders and the open decisions waiting on him.", {}),
    _tool("add_standing_order", "Save a direct order from the Director as a standing order the whole team follows "
          "from now on. situation = when it applies (the general pattern), instruction = what to do.",
          {"situation": S, "instruction": S}),
    _tool("remove_standing_order", "Retire a standing order by id. Needs his confirmation: ask, then call it again once he has said yes.",
          *_confirmable({"rule_id": {"type": "integer"}})),
    _tool("answer_decision", "Record the Director's decision on an open decision (id or label Q1). The employee who asked is "
          "told what to do; remember=true also saves it as a standing order. Needs his confirmation: state the decision "
          "in one sentence ending with a question, then call it again (same arguments) once he has said yes.",
          *_confirmable({"decision_id": S, "answer": S, "remember": B})),
]


def _needs_confirmation(name, args):
    """A one-line description of the destructive step, or None when the tool is safe."""
    if name == "set_employee_status" and not args.get("on"):
        e = _find_employee(args.get("employee"))
        return f"switch {e['name'] if e else args.get('employee')} off" if e else None
    if name == "remove_standing_order":
        return f"retire standing order #{args.get('rule_id')}"
    if name == "cancel_task":
        return f"cancel task #{args.get('task_id')}"
    if name == "answer_decision":
        return f"record his decision on #{args.get('decision_id')}: {str(args.get('answer') or '')[:80]}"
    if name == "assign_task":
        blob = f"{args.get('title', '')} {args.get('details', '')}".lower()
        if re.search(r"\b(e-?mail|send|write to|letter|chase them|reply to|respond to)\b", blob):
            e = _find_employee(args.get("employee"))
            return f"give {e['name'] if e else args.get('employee')} a task that involves emailing: {str(args.get('title') or '')[:60]}"
    return None


def _parse_when(text, now=None):
    """'in 20 minutes', 'in 2 hours', 'at 3pm', 'at 15:30', 'tomorrow 9', 'tomorrow at 9am', 'monday 10am', ISO."""
    now = now or datetime.now()
    t = (text or "").strip().lower()
    if not t:
        return None
    try:
        d = datetime.fromisoformat(t.upper().replace("Z", "+00:00"))
        if d.tzinfo:
            d = d.astimezone().replace(tzinfo=None)
        return d
    except ValueError:
        pass
    m = re.search(r"in\s+(\d+|an?|half an)\s*(min(ute)?s?|hour?s?|hr?s?|days?|weeks?)", t)
    if m:
        n = 0.5 if m.group(1).startswith("half") else 1 if m.group(1) in ("a", "an") else int(m.group(1))
        unit = m.group(2)
        delta = timedelta(minutes=n) if unit.startswith("m") else timedelta(hours=n) if unit.startswith("h") \
            else timedelta(days=n) if unit.startswith("d") else timedelta(weeks=n)
        return now + delta
    day = now.date()
    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    if "tomorrow" in t:
        day = day + timedelta(days=1)
    else:
        for i, name in enumerate(days):
            if name in t or t.startswith(name[:3] + " ") or f" {name[:3]} " in f" {t} ":
                ahead = (i - now.weekday()) % 7 or 7
                day = day + timedelta(days=ahead)
                break
    m = re.search(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm|o'?clock)?", t)
    if not m:
        if day != now.date():
            return datetime.combine(day, datetime.min.time()).replace(hour=9)
        return None
    hour, minute = int(m.group(1)), int(m.group(2) or 0)
    ap = m.group(3) or ""
    if ap == "pm" and hour < 12:
        hour += 12
    elif ap == "am" and hour == 12:
        hour = 0
    elif not ap and hour < 8 and "morning" not in t:
        hour += 12   # "at 3" in an office means 3pm
    if hour > 23 or minute > 59:
        return None
    d = datetime.combine(day, datetime.min.time()).replace(hour=hour, minute=minute)
    if d <= now and day == now.date():
        d += timedelta(days=1)
    return d


def _norm_args(args):
    """Arguments as the gate compares them: no consent flag, no empty or false values, strings trimmed and case-folded."""
    out = {}
    for k, v in (args or {}).items():
        if k == "confirmed" or v is None or v == "" or v is False:
            continue
        out[k] = v.strip().lower() if isinstance(v, str) else v
    return out


def _consented(name, args, ctx):
    """True only when the Director has said yes to THIS action: the mechanical YES path sets ctx['consent'],
    or the previous assistant turn left a pending action with the same tool and the same arguments.
    A 'confirmed' flag in the model's own arguments is never enough."""
    if ctx.get("consent"):
        return True
    prior = ctx.get("prior_pending")
    if prior is None and ctx.get("session"):
        prior = _pending(ctx["session"])
    return bool(prior and prior.get("tool") == name and _norm_args(prior.get("args")) == _norm_args(args))


def _run_tool(name, args, ctx=None):
    """Runs one tool; returns a string for the model. ctx = {index, ui, pending, session, consent, prior_pending} (optional)."""
    ctx = ctx if ctx is not None else {}
    args = dict(args or {})
    args.pop("confirmed", None)                      # the model's word is not consent: the gate below is
    args = _resolve_ref(args, ctx.get("index") or {})
    why = _needs_confirmation(name, args)
    if why and not _consented(name, args, ctx):
        ctx["pending"] = {"tool": name, "args": dict(args)}
        return (f"NEEDS_CONFIRMATION: you are about to {why}. Tell him in one sentence ending with a question and "
                "do nothing else; call this tool again with the same arguments only after he says yes.")
    if name == "get_briefing":
        return _brief()
    if name == "find_claims":
        q = (args.get("query") or "").lower()
        hits = [c for c in store.claims() if q in c["folder"].lower() or q in (c["last_summary"] or "").lower()]
        ctx.setdefault("mentioned", {}).setdefault("folder", []).extend(c["folder"] for c in hits[:3])
        return json.dumps(hits[:10]) if hits else "No matching claim files."
    if name == "list_overdue":
        rows = [{"folder": c["folder"], "client": c["client_name"], "days_silent": _days_ago(c["last_outbound_at"]),
                 "chase_step": c["chase_level"], "summary": c["last_summary"]} for c in _overdue(store.claims())[:12]]
        return json.dumps(rows) if rows else "No overdue files."
    if name in ("get_draft", "read_draft", "speak_draft"):
        d = store.draft(str(args.get("draft_id") or ""))
        if not d or d["status"] != "awaiting":
            return "That draft is not waiting for approval."
        ctx.setdefault("mentioned", {}).setdefault("draft", []).append(d["id"])
        out = {"id": d["id"], "subject": d["subject"], "to": d["recipients"], "by": d["agent"], "note": d["note"],
               "client": _client_name(d["folder"]), "gist": _gist(d, 220), "status": "awaiting his approval"}
        if name != "get_draft":
            from .emailfmt import _safe_html
            out["body_text"] = _plain(_safe_html(d.get("body_html") or ""))[:900]
            ctx["ui"] = {"action": "speak_draft", "id": d["id"]}
            out["note_to_assistant"] = ("The hub will read the letter aloud and show it in Approvals. Reply with one short "
                                        "sentence introducing it. You cannot approve or send it.")
        return json.dumps(out)
    if name == "get_decision":
        d = store.decision(args.get("decision_id"))
        if not d:
            return "No such decision."
        ctx.setdefault("mentioned", {}).setdefault("decision", []).append(d["id"])
        return json.dumps({k: d[k] for k in ("id", "employee", "folder", "situation", "suggestion", "status")})
    if name in ("find_activity", "search_activity"):
        e = _find_employee(args.get("employee")) if args.get("employee") else None
        rows = store.search_activity(args.get("query") or "", e["id"] if e else "", int(args.get("days") or 7))
        return "\n".join(f"{a['ts'][:16].replace('T', ' ')} {a['employee']}: {a['text']}" for a in rows) or "Nothing matching."
    if name == "open_view":
        view = (args.get("view") or "today").lower()
        if view not in ("today", "approvals", "logic", "team", "files"):
            view = "today"
        ctx["ui"] = {"action": "open_view", "view": view, "kind": (args.get("kind") or "")[:20], "id": str(args.get("id") or "")[:120]}
        return f"Opening {view}" + (f" ({args.get('kind')} {args.get('id')})" if args.get("kind") else "") + " on his screen."
    if name == "set_reminder":
        when = _parse_when(args.get("when"))
        if not when:
            return "I could not understand that time. Ask him for a time like 'in 20 minutes' or 'at 3pm'."
        due = when.astimezone(timezone.utc).replace(microsecond=0).isoformat() if when.tzinfo else \
            datetime.fromtimestamp(when.timestamp(), timezone.utc).replace(microsecond=0).isoformat()
        rid = store.add_reminder(due, args.get("text") or "Reminder", ctx.get("session") or "default")
        store.activity("director", f"Reminder #{rid} set for {when:%a %H:%M}: {(args.get('text') or '')[:60]}")
        return f"Reminder #{rid} set for {when:%A %d %B at %H:%M}."
    if name == "dismiss_reminder":
        ok = store.dismiss_reminder(int(args.get("reminder_id") or 0))
        return "Reminder cleared." if ok else "No open reminder with that id."
    if name == "set_employee_status":
        e = _find_employee(args.get("employee"))
        if not e:
            return f"No employee called {args.get('employee')}."
        store.set_enabled(e["id"], args.get("on"))
        store.activity(e["id"], f"Switched {'on' if args.get('on') else 'off'} by {config.DIRECTOR_NAME} (via assistant)")
        ctx.setdefault("mentioned", {}).setdefault("person", []).append(e["id"])
        return f"{e['name']} is now {'on' if args.get('on') else 'off'}."
    if name == "assign_task":
        e = _find_employee(args.get("employee"))
        if not e:
            return f"No employee called {args.get('employee')}."
        tid = store.add_task(e["id"], args.get("title", "Task"), args.get("details", ""), args.get("claim_folder", ""))
        store.activity(e["id"], f"New task #{tid} from {config.DIRECTOR_NAME}: {args.get('title')}")
        ctx.setdefault("mentioned", {}).setdefault("task", []).append(tid)
        ctx.setdefault("mentioned", {}).setdefault("person", []).append(e["id"])
        return f"Task #{tid} given to {e['name']}." + ("" if e["enabled"] else f" Note: {e['name']} is switched off.") + \
            ("" if ai_ready() else " Note: the team is off until the Claude key is added, so it waits as queued.")
    if name == "cancel_task":
        t = next((t for t in store.tasks(500) if t["id"] == args.get("task_id")), None)
        if not t:
            return "No such task."
        if t["status"] != "queued":
            return f"Task #{t['id']} is {t['status']}; only queued tasks can be cancelled."
        store.cancel_task(t["id"])
        store.activity("director", f"Cancelled task #{t['id']}: {t['title'][:60]}")
        return f"Task #{t['id']} cancelled."
    if name == "run_now":
        RUN_NOW.set()
        return "Pass started."
    if name == "get_task_result":
        t = next((t for t in store.tasks(500) if t["id"] == args.get("task_id")), None)
        return json.dumps(t) if t else "No such task."
    from . import logic
    if name == "list_standing_orders":
        return json.dumps({"standing_orders": store.rules(active_only=True)[:40],
                           "open_decisions": [{k: d[k] for k in ("id", "employee", "folder", "situation", "suggestion")}
                                              for d in store.decisions("open")]})
    if name == "add_standing_order":
        rid = logic.add_order(args.get("situation", ""), args.get("instruction", ""))
        return f"Standing order #{rid} saved. The whole team follows it from the next job."
    if name == "remove_standing_order":
        store.set_rule(args.get("rule_id"), active=0)
        return f"Standing order #{args.get('rule_id')} retired."
    if name == "answer_decision":
        r = logic.answer_decision(args.get("decision_id"), args.get("answer", ""), bool(args.get("remember", True)))
        if not r:
            return "That decision is not open."
        return f"Decision recorded. Task #{r['task_id']} created" + (f" and standing order #{r['rule_id']} saved." if r["rule_id"] else ".")
    return "Unknown tool."


# ---- the conversation

REPLY_SCHEMA = obj({"say": S, "show": S, "followups": LS, "ui": obj({"action": S, "id": S}), "needs_confirmation": B})

PERSONA = (
    "You are {name}, the personal assistant to {director}, the Director of Courtesy Cars Group UK (credit hire and "
    "motor claims). You run his AI claims team: Danny Kaleem (Claims Manager), Harry (Claims Handler, 6 helpers), "
    "Hemant (Head of Legal & Audit) and any staff he has hired. The context pack at the end of this prompt is live "
    "state: use it first and only call tools for detail it lacks or to change something. Never invent figures, claims "
    "or emails. You follow the Director's direct orders: when he tells you how something should be handled from now "
    "on, save it with add_standing_order (confirm in one line what you saved); when he decides an open decision, "
    "record it with answer_decision; when he asks for work to be done, assign it. If an order would be unlawful or "
    "dishonest, say so plainly and do not save it. Be warm, brisk and specific, like a sharp chief of staff: lead "
    "with what needs his decision, then what's moving, then risks.\n\n"
    "REFERENCES: He will use short references. Resolve them in this order: the numbered items in the context pack "
    "(D2 = the second draft, Q1 = the first decision, F1 = the first overdue file, R1 = the first reminder), then "
    "what is on his screen (SCREEN), then the people or files named in the last few turns (MENTIONED), then the most "
    "recent item of that kind. \"Him\"/\"her\" means the last person named. Tools accept the labels D2, Q1, F1 as ids. "
    "If two candidates fit, ask a one-line question naming both; never guess on anything that changes data.\n"
    "CLARIFY: Ask at most one short question when the request is ambiguous; when it is clear, act.\n"
    "CONFIRM: Before switching someone off, retiring a standing order, cancelling a task, recording a decision, or "
    "giving a task that sends an email, state what you are about to do in one sentence ending with a question, and "
    "do it only after he says yes (yes/go ahead/do it/confirmed = consent; no/stop/wait = refusal). The tools enforce "
    "this: they answer NEEDS_CONFIRMATION until he has said yes to that exact action. In voice mode the question is the whole "
    "reply. Never ask twice for the same action; when PENDING is in the context pack and he has said yes, do it.\n"
    "APPROVALS: You can never approve, send, or edit a draft: there is no tool for it and there never will be. If "
    "asked, say it needs his tap in Approvals and offer to open it (open_view approvals with the draft id). "
    "read_draft reads a letter to him; it changes nothing.\n"
    "REPLY FORMAT: answer as JSON with: say = what you say (spoken aloud in voice mode: plain words, no markdown, "
    "two sentences at most unless he asks for detail); show = optional longer text for the chat (light markdown; "
    "empty when say is enough); followups = up to three short follow-ups he might say next, five words each, as "
    "things HE would say (\"Open it\", \"Read me the second one\", \"Switch Harry back on\"); ui = a screen action "
    "the hub should perform ({{\"action\":\"open_view\",\"id\":\"approvals\"}} or {{\"action\":\"speak_draft\",\"id\":"
    "\"<draft id>\"}}; empty strings otherwise); needs_confirmation = true only when say asks him to confirm a "
    "destructive step.\n"
    "PRECISION: put the key fact last in the sentence and questions must end with '?'. Numbers under ten as words; "
    "money as 'eighty-five pounds a day'; dates as 'Tuesday the fourth'."
)
VOICE_RULES = (
    "VOICE MODE: you are speaking out loud. Answer first, in under 25 words when possible; never more than four "
    "sentences unless he asks for detail. Lead with the fact, then the context. Plain spoken English: no markdown, "
    "lists, symbols, ids, folder names, references, paths or email addresses; say the client's name instead. One idea "
    "per sentence. Never open with filler such as 'Absolutely', 'Great question' or 'Certainly'. End with one offer "
    "only when a next step is obvious ('Shall I open it?')."
)
TEXT_RULES = "CHAT MODE: keep it tight. say is the short answer; put any bullets or detail in show (light markdown)."


def _messages_from_turns(session, mem):
    out = []
    for t in store.turns(session, limit=40, after_id=mem["upto_turn_id"]):
        if t["role"] not in ("user", "assistant") or not (t.get("content") or "").strip():
            continue
        if not out and t["role"] != "user":
            continue
        out.append({"role": t["role"], "content": t["content"]})
    return out


def _parse_reply(text, voice):
    text = (text or "").strip()
    d = None
    if text.startswith("{"):
        try:
            d = json.loads(text)
        except ValueError:
            m = re.search(r"\{.*\}", text, re.S)
            try:
                d = json.loads(m.group(0)) if m else None
            except ValueError:
                d = None
    if not isinstance(d, dict):
        d = {"say": text}
    say = str(d.get("say") or "").strip()
    show = str(d.get("show") or "").strip()
    if not say and show:
        say = re.sub(r"[*_`#>]+", "", show).split("\n")[0][:300]
    ui = d.get("ui") if isinstance(d.get("ui"), dict) else {}
    ui = {k: str(v)[:120] for k, v in ui.items() if v} if ui.get("action") else {}
    fol = [str(f).strip()[:40] for f in (d.get("followups") or []) if str(f).strip()][:3]
    return {"say": say or "Done.", "show": show, "followups": fol, "ui": ui,
            "needs_confirmation": bool(d.get("needs_confirmation"))}


def assistant(session_or_history, text=None, voice=False, anchors=None, client_time=None, history=None):
    """Talk to the assistant. New form: assistant(session_id, text, voice, anchors, client_time) -> dict
    {reply, speak, show, suggestions, followups, actions, ui, needs_confirmation}. The old form
    assistant(history, voice) still works (session 'default', the last user line is the question)."""
    if isinstance(session_or_history, list):           # legacy callers: assistant(history, voice)
        history = session_or_history
        session = "default"
        if isinstance(text, bool):
            voice, text = text, None
        text = next((m["content"] for m in reversed(history) if m.get("role") == "user" and m.get("content")), "") if text is None else text
    else:
        session = re.sub(r"[^\w.-]", "", str(session_or_history or "default"))[:64] or "default"
    text = (text or "").strip()
    if not text:
        return _result("What would you like me to do?", actions=[])
    anchors = anchors if isinstance(anchors, dict) else {}
    name = store.get("assistant_name", "Aria")
    user_turn = store.add_turn(session, "user", text, anchors={"screen": anchors} if anchors else None, voice=voice)

    # Mechanical consent: a plain "yes" after a confirmation question runs the pending action without another model round.
    pending = _pending(session)
    if pending and pending.get("tool"):
        if YES.match(text):
            ctx = {"session": session, "index": {}, "ui": None, "mentioned": {}, "consent": True}
            out = _run_tool(pending["tool"], dict(pending.get("args") or {}), ctx)
            return _finish(session, name, {"say": out, "show": "", "followups": ["What's next?", "Brief me"], "ui": ctx.get("ui") or {},
                                           "needs_confirmation": False}, [out], ctx, voice, pending_cleared=True)
        if NO.match(text):
            return _finish(session, name, {"say": "Understood, I've left it as it was.", "show": "", "followups": ["Brief me"],
                                           "ui": {}, "needs_confirmation": False}, [], {"mentioned": {}}, voice, pending_cleared=True)

    mem = store.memory(session)
    if history and not store.turn_count(session, mem["upto_turn_id"]) - 1:
        for m in history[-20:]:          # a device with browser-only history: seed the session once
            if m.get("role") in ("user", "assistant") and m.get("content") and m["content"] != text:
                store.add_turn(session, m["role"], m["content"])
    pack, index = context_pack(session, anchors, client_time)
    system = [
        {"type": "text", "text": PERSONA.format(name=name, director=config.DIRECTOR_NAME), "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": (VOICE_RULES if voice else TEXT_RULES) + "\n\nCONTEXT PACK (live, read it before answering):\n" + pack},
    ]
    messages = _messages_from_turns(session, mem)
    if not messages or messages[-1]["role"] != "user" or messages[-1]["content"] != text:
        messages.append({"role": "user", "content": text})
    ctx = {"session": session, "index": index, "ui": None, "pending": None, "mentioned": {}, "prior_pending": pending or {}}
    actions = []
    out = None
    for _ in range(8):
        response = _call(system, messages, with_format=True)
        if response.stop_reason == "refusal":
            out = {"say": "Sorry, I can't help with that one.", "show": "", "followups": [], "ui": {}, "needs_confirmation": False}
            break
        if response.stop_reason != "tool_use":
            out = _parse_reply("".join(b.text for b in response.content if b.type == "text"), voice)
            break
        messages.append({"role": "assistant", "content": response.content})
        results = []
        for b in response.content:
            if b.type == "tool_use":
                res = _run_tool(b.name, b.input or {}, ctx)
                if b.name not in READ_ONLY and not res.startswith("NEEDS_CONFIRMATION"):
                    actions.append(res)
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": res})
        messages.append({"role": "user", "content": results})
    if out is None:
        out = {"say": "I ran out of steps on that one. Try asking it a simpler way.", "show": "", "followups": [], "ui": {},
               "needs_confirmation": False}
    if ctx.get("pending") and not actions:
        out["needs_confirmation"] = True
    return _finish(session, name, out, actions, ctx, voice)


def _call(system, messages, with_format=True):
    kw = dict(model=config.MODEL, max_tokens=4000, system=system, messages=messages, tools=TOOLS,
              output_config={"effort": "low"}, betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    if with_format:
        kw["output_config"]["format"] = {"type": "json_schema", "schema": REPLY_SCHEMA}
    try:
        return brain.client().beta.messages.create(**kw)
    except Exception as ex:   # a provider that refuses format+tools together: ask for the JSON in prose instead
        if with_format and "format" in str(ex).lower():
            log.debug("assistant: json format rejected (%s); retrying without", ex)
            return _call(system, messages, with_format=False)
        raise


def _result(say, show="", followups=None, actions=None, ui=None, needs_confirmation=False, voice=False):
    return {"reply": (show if (show and not voice) else say) or say, "speak": say, "show": show,
            "suggestions": followups or [], "followups": followups or [], "actions": actions or [], "ui": ui or {},
            "needs_confirmation": needs_confirmation}


def _finish(session, name, out, actions, ctx, voice, pending_cleared=False):
    ui = out.get("ui") or ctx.get("ui") or {}
    if ui and not ui.get("action"):
        ui = {}
    anchors = {"mentioned": ctx.get("mentioned") or {}}
    if ctx.get("pending"):
        anchors["pending_action"] = ctx["pending"]
    if ui:
        anchors["ui"] = ui
    store.add_turn(session, "assistant", out["say"] + (("\n\n" + out["show"]) if out.get("show") else ""),
                   actions=actions, anchors=anchors, voice=voice)
    store.put("assistant:last", json.dumps({"text": out["say"], "ts": store.now(), "session": session}))
    _maybe_summarise(session)
    return _result(out["say"], out.get("show", ""), out.get("followups"), actions, ui, out.get("needs_confirmation", False), voice)


# ---- memory: rolling summary of older turns (never in the request thread)

SUMMARY_SCHEMA = obj({"summary": S, "facts": LS})
_summarising = set()


def summarise(session):
    """Fold the oldest 20 unsummarised turns into memory.summary (<= 1200 chars) and facts. Returns the memory."""
    mem = store.memory(session)
    turns = store.turns(session, limit=400, after_id=mem["upto_turn_id"])[:20]
    if not turns:
        return mem
    convo = "\n".join(f"{t['role']}: {t['content'][:600]}" for t in turns)
    out = brain.ask_json(
        f"You keep the memory of {store.get('assistant_name', 'Aria')}, personal assistant to {config.DIRECTOR_NAME} at a UK claims firm. "
        "Rewrite the running summary of their conversation so far (what he asked, what was decided or done, what is still "
        "open) in under 1200 characters, and list durable facts worth remembering across devices (how he likes things "
        "done, names he uses for people, preferences) as short strings. No invented facts.",
        f"Existing summary:\n{mem['summary'] or 'none'}\n\nKnown facts:\n{json.dumps(mem['facts'])}\n\nOlder turns to fold in:\n{convo}",
        SUMMARY_SCHEMA, effort="low", with_knowledge=False, max_tokens=2000)
    new = {"summary": (out.get("summary") or "")[:1200], "upto_turn_id": turns[-1]["id"],
           "facts": [f for f in (out.get("facts") or []) if isinstance(f, str)][:40]}
    store.put_memory(session, new)
    try:
        shared = json.loads(store.get("memory:all") or "{}")
    except ValueError:
        shared = {}
    facts = [f for f in (shared.get("facts") or []) if isinstance(f, str)]
    for f in new["facts"]:
        if f not in facts:
            facts.append(f)
    store.put("memory:all", json.dumps({"facts": facts[-40:], "updated": store.now()}))
    return new


def _maybe_summarise(session, threshold=40):
    mem = store.memory(session)
    if store.turn_count(session, mem["upto_turn_id"]) <= threshold or session in _summarising or not ai_ready():
        return False
    _summarising.add(session)

    def go():
        try:
            summarise(session)
        except Exception as ex:
            log.debug("Memory summary failed: %s", ex)
        finally:
            _summarising.discard(session)
    threading.Thread(target=go, daemon=True, name="assistant-memory").start()
    return True


# ---------------------------------------------------------------- activity feed from the agents' log

class ActivityHandler(logging.Handler):
    """The agents' INFO lines become activity rows. Infrastructure trouble (voice, hub, tracebacks, failed
    tasks) never does: a warning is not something a member of staff did."""
    SKIP = re.compile(r"Pass finished|Follow-ups due: 0|^Claims team started|^Boss Hub running|MAIL_PASSWORD not set|"
                      r"Voice failed|Task \S+ failed|Traceback|Hub request failed|Greeting failed|Suggestion failed|"
                      r"Pass failed|Memory summary|tts |Connection from|^On your phone|^Settings -> Phone|^Secure address|"
                      r"Phones allowed|secure address needs", re.I)
    NAMED = re.compile(r"^(Harry|Hemant|Danny)\b")

    def emit(self, record):
        try:
            msg = record.getMessage().strip()
            if not msg or self.SKIP.search(msg) or record.exc_info:
                return
            if record.levelno >= logging.WARNING and not self.NAMED.match(msg):
                return   # plumbing warnings stay in the terminal and the log file
            who = ("harry" if "Harry" in msg else "hemant" if "Hemant" in msg
                   else "director" if msg.startswith(("SENT (approved", "Rejected by")) else "danny")
            text = re.sub(r"^(Harry|Hemant|Danny)\b:?\s*", "", msg.split("\n")[0]).strip()
            text = re.sub(r"<[^>]*object at 0x[0-9a-f]+>", "", text)
            store.activity(who, (text[:1].upper() + text[1:])[:300])
        except Exception:
            pass

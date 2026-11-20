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


def snapshot():
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
        "eleven_ready": bool(os.getenv("ELEVENLABS_API_KEY")),
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

def _find_employee(name):
    name = (name or "").lower().strip()
    for e in store.employees():
        if name in (e["id"], e["name"].lower()) or name == e["name"].split()[0].lower():
            return e
    for e in store.employees():
        if name and name in e["name"].lower():
            return e
    return None


def _brief():
    s = snapshot()
    return json.dumps({
        "kpis": s["kpis"],
        "employees": [{"name": e["name"], "title": e["title"], "on": bool(e["enabled"]),
                       "last_activity": e["last"]["text"] if e["last"] else None, **e["stats"]} for e in s["employees"]],
        "awaiting_approval": [{"subject": d["subject"], "to": d["recipients"], "by": d["agent"], "note": d["note"]} for d in s["drafts"][:15]],
        "recent_tasks": [{"id": t["id"], "for": t["employee"], "title": t["title"], "status": t["status"], "summary": t["summary"]} for t in s["tasks"][:12]],
        "recent_activity": [f"{a['ts'][11:16]} {a['employee']}: {a['text']}" for a in s["activity"][:25]],
        "open_decisions": [{"id": d["id"], "asked_by": d["employee"], "situation": d["situation"]} for d in s["decisions"][:10]],
        "standing_orders_count": len(s["rules"]),
        "mailbox_connected": s["mailbox_ready"], "last_pass": s["last_pass"],
    })


def _tool(name, desc, props, required=None):
    return {"name": name, "description": desc, "input_schema": obj(props, required)}


TOOLS = [
    _tool("get_briefing", "Current state of the firm: KPIs, every employee and whether they are on, drafts awaiting "
          "the Director's approval, recent tasks and recent activity. Call this before answering any status question.", {}),
    _tool("find_claims", "Search claim files by client name or reference.", {"query": S}),
    _tool("set_employee_status", "Switch an employee on or off.", {"employee": S, "on": B}),
    _tool("assign_task", "Give an employee a task. claim_folder is optional (use the exact folder from find_claims, or '').",
          {"employee": S, "title": S, "details": S, "claim_folder": S}),
    _tool("run_now", "Start an immediate pass: send approved drafts, scan the inbox, draft replies and chase.", {}),
    _tool("get_task_result", "Read the full result of a task by id.", {"task_id": {"type": "integer"}}),
    _tool("list_standing_orders", "The Director's standing orders (rules the whole team follows) and the open "
          "decisions waiting on him.", {}),
    _tool("add_standing_order", "Save a direct order from the Director as a standing order the whole team follows "
          "from now on. situation = when it applies (the general pattern), instruction = what to do.",
          {"situation": S, "instruction": S}),
    _tool("remove_standing_order", "Retire a standing order by id.", {"rule_id": {"type": "integer"}}),
    _tool("answer_decision", "Record the Director's decision on an open decision by id. The employee who asked is "
          "told what to do, and if remember=true it is saved as a standing order.",
          {"decision_id": {"type": "integer"}, "answer": S, "remember": B}),
]


def _run_tool(name, args):
    if name == "get_briefing":
        return _brief()
    if name == "find_claims":
        q = (args.get("query") or "").lower()
        hits = [c for c in store.claims() if q in c["folder"].lower() or q in (c["last_summary"] or "").lower()]
        return json.dumps(hits[:10]) if hits else "No matching claim files."
    if name == "set_employee_status":
        e = _find_employee(args.get("employee"))
        if not e:
            return f"No employee called {args.get('employee')}."
        store.set_enabled(e["id"], args.get("on"))
        store.activity(e["id"], f"Switched {'on' if args.get('on') else 'off'} by {config.DIRECTOR_NAME} (via assistant)")
        return f"{e['name']} is now {'on' if args.get('on') else 'off'}."
    if name == "assign_task":
        e = _find_employee(args.get("employee"))
        if not e:
            return f"No employee called {args.get('employee')}."
        tid = store.add_task(e["id"], args.get("title", "Task"), args.get("details", ""), args.get("claim_folder", ""))
        store.activity(e["id"], f"New task #{tid} from {config.DIRECTOR_NAME}: {args.get('title')}")
        return f"Task #{tid} given to {e['name']}." + ("" if e["enabled"] else f" Note: {e['name']} is switched off.")
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


def assistant(history, voice=False):
    """history: [{"role": "user"|"assistant", "content": str}, ...]. Returns (reply, actions_taken)."""
    name = store.get("assistant_name", "Aria")
    system = (
        f"You are {name}, the personal assistant to {config.DIRECTOR_NAME}, the Director of Courtesy Cars "
        "Group UK (credit hire and motor claims). You run his AI claims team: Danny Kaleem (Claims Manager), "
        "Harry (Claims Handler, 6 helpers), Hemant (Head of Legal & Audit) and any staff he has hired. "
        "Use your tools for facts; never invent figures, claims or emails. You follow the Director's direct "
        "orders: when he tells you how something should be handled from now on, save it with add_standing_order "
        "(confirm in one line what you saved); when he decides an open decision, record it with answer_decision; "
        "when he asks for work to be done, assign it. Switch employees on or off and start a pass when asked. "
        "You cannot approve or send emails yourself: he taps Approve on the draft in the hub. If an order would be "
        "unlawful or dishonest, say so plainly and do not save it. Be warm, brisk and specific, like a sharp chief "
        "of staff: lead with what needs his decision, then what's moving, then risks. "
        + ("You are speaking out loud. One or two sentences is ideal, never more than four unless he asks for "
           "detail. Lead with the fact, then the context. Plain spoken English: no markdown, lists, symbols, "
           "paths or long references. Never open with filler such as 'Absolutely', 'Great question' or 'Certainly'. "
           "Numbers under ten as words." if voice else
           "Keep it tight. Light markdown (bold, short bullet lists) is fine.")
        + f" Today is {datetime.now():%A %d %B %Y}, {datetime.now():%H:%M}."
    )
    messages = [{"role": m["role"], "content": m["content"]} for m in history[-20:] if m.get("content")]
    actions = []
    for _ in range(8):
        response = brain.client().beta.messages.create(
            model=config.MODEL, max_tokens=4000, system=system, messages=messages, tools=TOOLS,
            output_config={"effort": "low"}, betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        if response.stop_reason == "refusal":
            return "Sorry, I can't help with that one.", actions
        if response.stop_reason != "tool_use":
            text = "".join(b.text for b in response.content if b.type == "text").strip()
            return text or "Done.", actions
        messages.append({"role": "assistant", "content": response.content})
        results = []
        for b in response.content:
            if b.type == "tool_use":
                out = _run_tool(b.name, b.input or {})
                if b.name not in ("get_briefing", "find_claims", "get_task_result"):
                    actions.append(out)
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": out})
        messages.append({"role": "user", "content": results})
    return "I ran out of steps on that one. Try asking it a simpler way.", actions


# ---------------------------------------------------------------- activity feed from the agents' log

class ActivityHandler(logging.Handler):
    SKIP = re.compile(r"Pass finished|Follow-ups due: 0|^Claims team started|^Boss Hub running|MAIL_PASSWORD not set")

    def emit(self, record):
        try:
            msg = record.getMessage().strip()
            if not msg or self.SKIP.search(msg):
                return
            who = ("harry" if "Harry" in msg else "hemant" if "Hemant" in msg
                   else "director" if msg.startswith(("SENT (approved", "Rejected by")) else "danny")
            text = re.sub(r"^(Harry|Hemant|Danny)\b:?\s*", "", msg.split("\n")[0]).strip()
            store.activity(who, text[:1].upper() + text[1:])
        except Exception:
            pass

"""The Boss Hub: a local web app to run the team.

    python -m claims_agents hub           start the hub + all agents  ->  http://localhost:8765
    python -m claims_agents hub --demo    explore the hub with sample data (no mailbox needed)
"""

import json
import logging
import mimetypes
import re
import threading
import time
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import config, store, workers

log = logging.getLogger("agents")
STATIC = Path(__file__).parent / "static"


# ---------------------------------------------------------------- background workers

def agent_loop():
    from . import __main__ as cli, hemant
    from .mailbox import Mailbox
    while True:
        try:
            cli.run_once()
            today = cli.hemant_due()
            if today and store.enabled("hemant"):
                box = Mailbox()
                try:
                    hemant.daily(box, with_research=datetime.now().weekday() == config.HEMANT_RESEARCH_WEEKDAY)
                finally:
                    box.close()
                store.put("hemant_last", today)
        except Exception as e:
            log.exception("Pass failed: %s", e)
        workers.RUN_NOW.wait(config.SCAN_MINUTES * 60)
        workers.RUN_NOW.clear()


def task_loop():
    from .mailbox import Mailbox
    while True:
        task = store.next_task() if workers.ai_ready() else None
        if task is None:
            time.sleep(4)
            continue
        e = store.employee(task["employee"])
        store.activity(task["employee"], f"Working on task #{task['id']}: {task['title']}")
        box = None
        try:
            if workers.mailbox_ready() and store.get("demo") != "1":
                box = Mailbox()
            workers.run_task(task, box)
        except Exception as ex:
            log.exception("Task %s failed", task["id"])
            store.finish_task(task["id"], "failed", f"{e['name'] if e else 'Employee'} hit a problem: {ex}")
        finally:
            if box:
                box.close()


# ---------------------------------------------------------------- draft decisions

def decide_draft(draft_id, approve):
    d = store.draft(draft_id)
    if not d or d["status"] != "awaiting":
        return False, "That draft is no longer waiting."
    if store.get("demo") == "1" or not workers.mailbox_ready():
        store.set_draft_status(draft_id, "sent" if approve else "rejected")
        store.activity("director", f"{'Approved' if approve else 'Rejected'}: {d['subject']}")
        return True, "Done (demo mode: nothing was emailed)." if approve else "Rejected."
    from .mailbox import Mailbox
    box = Mailbox()
    try:
        box.imap.select_folder(config.AWAITING_FOLDER)
        uids = box.imap.search(["HEADER", "X-CC-Draft-ID", draft_id])
        if not uids:
            return False, "Couldn't find that draft in the mailbox. It may have been moved already."
        target = config.APPROVED_FOLDER if approve else config.REJECTED_FOLDER
        if box.can_move:
            box.imap.move(uids, target)
        else:
            box.imap.copy(uids, target)
            box.imap.delete_messages(uids)
            box.imap.expunge()
    finally:
        box.close()
    store.activity("director", f"{'Approved' if approve else 'Rejected'} in the hub: {d['subject']}")
    workers.RUN_NOW.set()  # send it now, not at the next scan
    return True, "Approved: sending now." if approve else "Rejected."


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "BossHub"

    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else (json.dumps(body, default=str) if ctype == "application/json" else body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith(("text", "application/json")) else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def _local_only(self, write=False):
        if self.client_address[0] not in ("127.0.0.1", "::1") and not config.HUB_ALLOW_LAN:
            self._send(403, {"error": "The hub only answers this computer."})
            return False
        # Block other websites (and DNS rebinding) from driving the hub through your browser.
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        if not config.HUB_ALLOW_LAN and host not in ("localhost", "127.0.0.1", "[::1]"):
            self._send(403, {"error": "Open the hub at http://localhost:%d" % config.HUB_PORT})
            return False
        origin = self.headers.get("Origin")
        if write and origin and re.sub(r"^https?://", "", origin).split(":")[0] != host:
            self._send(403, {"error": "Cross-site request blocked"})
            return False
        if write and "application/json" not in (self.headers.get("Content-Type") or "") and self.command == "POST":
            self._send(415, {"error": "JSON only"})
            return False
        return True

    def do_GET(self):
        if not self._local_only():
            return
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            return self._send(200, (STATIC / "hub.html").read_bytes(), "text/html")
        if path == "/api/state":
            return self._send(200, workers.snapshot())
        m = re.fullmatch(r"/api/drafts/([\w-]+)", path)
        if m:
            d = store.draft(m.group(1))
            return self._send(200 if d else 404, d or {"error": "not found"})
        if path == "/api/reports":
            files = sorted(config.REPORTS_DIR.glob("*.html"), reverse=True)[:30]
            return self._send(200, [f.name for f in files])
        m = re.fullmatch(r"/reports/([\w.-]+\.html)", path)
        if m and (config.REPORTS_DIR / m.group(1)).exists():
            return self._send(200, (config.REPORTS_DIR / m.group(1)).read_bytes(), "text/html")
        m = re.fullmatch(r"/static/([\w.-]+)", path)
        if m and (STATIC / m.group(1)).exists():
            return self._send(200, (STATIC / m.group(1)).read_bytes(),
                              mimetypes.guess_type(m.group(1))[0] or "application/octet-stream")
        if path == "/logo.png" and config.LOGO_FILE.exists():
            return self._send(200, config.LOGO_FILE.read_bytes(), "image/png")
        self._send(404, {"error": "not found"})

    def do_DELETE(self):
        if not self._local_only(write=True):
            return
        m = re.fullmatch(r"/api/employees/([\w-]+)", self.path)
        if m:
            store.fire(m.group(1))
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._local_only(write=True):
            return
        try:
            body = self._body()
            path = self.path.split("?")[0]
            m = re.fullmatch(r"/api/employees/([\w-]+)/toggle", path)
            if m:
                store.set_enabled(m.group(1), bool(body.get("on")))
                store.activity(m.group(1), f"Switched {'on' if body.get('on') else 'off'} by {config.DIRECTOR_NAME}")
                return self._send(200, {"ok": True})
            if path == "/api/employees":
                name = (body.get("name") or "").strip()
                if not name:
                    return self._send(400, {"error": "Name is required"})
                eid = store.hire(name, body.get("title") or "Claims Assistant", body.get("role_prompt") or "",
                                 int(body.get("hue") or 200))
                store.activity(eid, f"Joined the team as {body.get('title') or 'Claims Assistant'}")
                return self._send(200, {"ok": True, "id": eid})
            m = re.fullmatch(r"/api/employees/([\w-]+)", path)
            if m:
                store.update_employee(m.group(1), **body)
                return self._send(200, {"ok": True})
            if path == "/api/tasks":
                e = store.employee(body.get("employee"))
                if not e or not (body.get("title") or "").strip():
                    return self._send(400, {"error": "Pick an employee and give the task a title"})
                tid = store.add_task(e["id"], body["title"].strip(), body.get("details", ""), body.get("folder", ""))
                store.activity(e["id"], f"New task #{tid} from {config.DIRECTOR_NAME}: {body['title'].strip()}")
                return self._send(200, {"ok": True, "id": tid})
            m = re.fullmatch(r"/api/tasks/(\d+)/cancel", path)
            if m:
                store.cancel_task(int(m.group(1)))
                return self._send(200, {"ok": True})
            m = re.fullmatch(r"/api/drafts/([\w-]+)/(approve|reject)", path)
            if m:
                ok, msg = decide_draft(m.group(1), m.group(2) == "approve")
                return self._send(200 if ok else 409, {"ok": ok, "message": msg})
            if path == "/api/assistant":
                if not workers.ai_ready():
                    return self._send(200, {"reply": "I need a Claude API key before I can help. Add ANTHROPIC_API_KEY "
                                            "to the .env file on this computer and restart the hub.", "actions": []})
                reply, actions = workers.assistant(body.get("history") or [], bool(body.get("voice")))
                return self._send(200, {"reply": reply, "actions": actions})
            if path == "/api/run":
                workers.RUN_NOW.set()
                store.activity("director", "Started a pass now")
                return self._send(200, {"ok": True})
            if path == "/api/settings":
                if body.get("assistant_name"):
                    store.put("assistant_name", body["assistant_name"].strip()[:30])
                return self._send(200, {"ok": True})
            self._send(404, {"error": "not found"})
        except Exception as e:
            log.exception("Hub request failed")
            self._send(500, {"error": str(e)})


def serve(demo=False, open_browser=True):
    if demo:
        store.use_db(config.DATA_DIR / "demo.db")
        from . import demo as demo_data
        demo_data.seed()
    logging.getLogger("agents").addHandler(workers.ActivityHandler())
    if not demo and workers.mailbox_ready():
        threading.Thread(target=agent_loop, daemon=True, name="agents").start()
    elif not demo:
        log.warning("MAIL_PASSWORD not set: the hub runs, but the agents can't read the mailbox yet.")
    threading.Thread(target=task_loop, daemon=True, name="tasks").start()
    host = "0.0.0.0" if config.HUB_ALLOW_LAN else "127.0.0.1"
    httpd = ThreadingHTTPServer((host, config.HUB_PORT), Handler)
    url = f"http://localhost:{config.HUB_PORT}"
    log.info("Boss Hub running at %s%s", url, "  (demo data)" if demo else "")
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass

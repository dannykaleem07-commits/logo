"""The Boss Hub: a local web app to run the team.

    python -m claims_agents hub           start the hub + all agents  ->  http://localhost:8765
    python -m claims_agents hub --demo    explore the hub with sample data (no mailbox needed)
"""

import json
import logging
import mimetypes
import re
import ssl
import threading
import time
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import config, logic, phone, store, workers

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

    def _send(self, code, body, ctype="application/json", headers=None, cache=False):
        data = body if isinstance(body, bytes) else (json.dumps(body, default=str) if ctype == "application/json" else body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith(("text", "application/json")) else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=86400" if cache else "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    @property
    def _tls(self):
        return bool(getattr(self.server, "tls", False))

    @property
    def _local(self):
        return phone.is_loopback(self.client_address[0])

    def _paired(self):
        return self._local or phone.valid_session(phone.cookie_token(self.headers.get("Cookie")))

    def _pair_cookie(self):
        """Pairs this phone: a long-lived HttpOnly session cookie."""
        token = phone.new_session(self.headers.get("User-Agent", ""))
        store.activity("director", f"Paired a {phone.device_name(self.headers.get('User-Agent', ''))} with the hub")
        return {"Set-Cookie": phone.cookie_header(token, self._tls)}

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    PUBLIC = ("/", "/index.html", "/manifest.webmanifest", "/apple-touch-icon.png", "/favicon.ico", "/ca.crt", "/pair",
              "/api/unlock", "/api/phone", "/api/phone/forget")  # the two /api/phone routes answer 403 to phones themselves

    def _local_only(self, write=False):
        """Who may talk to the hub. This computer: always. A phone on the office network: only with
        HUB_ALLOW_LAN and once it has been paired (QR code or PIN); until then it only gets the page itself."""
        path = self.path.split("?")[0]
        if not self._local and not config.HUB_ALLOW_LAN:
            self._send(403, {"error": "The hub only answers this computer."})
            return False
        # Block other websites (and DNS rebinding) from driving the hub through your browser.
        host = phone.host_of(self.headers.get("Host"))
        if host not in phone.allowed_hosts():
            self._send(403, {"error": "Open the hub at http://localhost:%d (or its network address on a phone)" % config.HUB_PORT})
            return False
        origin = self.headers.get("Origin")
        if write and origin and phone.host_of(re.sub(r"^https?://", "", origin)) != host:
            self._send(403, {"error": "Cross-site request blocked"})
            return False
        if write and "application/json" not in (self.headers.get("Content-Type") or "") and self.command == "POST":
            self._send(415, {"error": "JSON only"})
            return False
        if not self._local and path not in self.PUBLIC and not path.startswith("/static/") and not self._paired():
            self._send(401, {"error": "locked", "pin": True})
            return False
        return True

    def do_GET(self):
        if not self._local_only():
            return
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            return self._send(200, (config.HUB_PAGE or STATIC / "hub.html").read_bytes(), "text/html")
        if path == "/api/state":
            return self._send(200, workers.snapshot())
        if path == "/manifest.webmanifest":
            return self._send(200, json.dumps(phone.manifest()).encode(), "application/manifest+json", cache=True)
        if path in ("/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"):
            return self._send(200, (STATIC / "icon-180.png").read_bytes(), "image/png", cache=True)
        if path == "/favicon.ico":
            return self._send(200, (STATIC / "icon-192.png").read_bytes(), "image/png", cache=True)
        if path == "/pair":
            q = dict(x.split("=", 1) for x in self.path.partition("?")[2].split("&") if "=" in x)
            if phone.redeem_pair_token(q.get("t", "")):
                return self._send(303, b"", "text/plain", headers={"Location": "/", **self._pair_cookie()})
            return self._send(303, b"", "text/plain", headers={"Location": "/#code-expired"})
        if path == "/ca.crt":
            files = getattr(self.server, "ca_file", None)
            if not files:
                return self._send(404, {"error": "The hub is not running its secure address (HUB_HTTPS=true)"})
            return self._send(200, Path(files).read_bytes(), "application/x-x509-ca-cert",
                              headers={"Content-Disposition": 'attachment; filename="boss-hub-ca.crt"'})
        if path == "/api/phone":
            if not self._local:
                return self._send(403, {"error": "Pair this phone from the office computer"})
            return self._send(200, phone.info(getattr(self.server, "ca_file", None) is not None))
        m = re.fullmatch(r"/api/drafts/([\w-]+)", path)
        if m:
            d = store.draft(m.group(1))
            return self._send(200 if d else 404, d or {"error": "not found"})
        if path == "/api/greeting":
            return self._send(200, {"text": logic.greeting(workers.snapshot())})
        if path == "/api/voices":
            return self._send(200, {"current": logic.current_voice(), "voices": logic.tts_voices()})
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
        m = re.fullmatch(r"/api/rules/(\d+)", self.path)
        if m:
            store.delete_rule(int(m.group(1)))
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
            if path == "/api/tts":
                if not logic.tts_ready():
                    return self._send(404, {"error": "Install edge-tts (pip install -r requirements.txt)"})
                try:
                    audio = logic.tts_speak((body.get("text") or "")[:2500], body.get("voice"))
                except Exception as e:
                    log.warning("Voice failed: %s", e)
                    return self._send(502, {"error": "Voice service unavailable"})
                return self._send(200, audio, "audio/mpeg")
            if path == "/api/rules":
                if not (body.get("situation") or "").strip() or not (body.get("instruction") or "").strip():
                    return self._send(400, {"error": "Both 'when' and 'do' are needed"})
                return self._send(200, {"ok": True, "id": logic.add_order(body["situation"], body["instruction"])})
            m = re.fullmatch(r"/api/rules/(\d+)", path)
            if m:
                store.set_rule(int(m.group(1)), **body)
                return self._send(200, {"ok": True})
            m = re.fullmatch(r"/api/decisions/(\d+)/answer", path)
            if m:
                r = logic.answer_decision(int(m.group(1)), body.get("answer", ""), bool(body.get("remember", True)), body.get("chosen"))
                return self._send(200 if r else 409, r or {"error": "That decision is no longer open"})
            m = re.fullmatch(r"/api/decisions/(\d+)/dismiss", path)
            if m:
                store.close_decision(int(m.group(1)), "", status="dismissed")
                return self._send(200, {"ok": True})
            if path == "/api/settings":
                if body.get("tts_voice"):
                    store.put("tts_voice", re.sub(r"[^A-Za-z0-9-]", "", str(body["tts_voice"]))[:60])
            if path == "/api/unlock":
                ok, retry = phone.check_pin(body.get("pin"))
                if not ok and retry:
                    return self._send(429, {"error": "Too many attempts", "retry_in": retry})
                if not ok:
                    return self._send(401, {"error": "Wrong PIN"})
                return self._send(200, {"ok": True}, headers=self._pair_cookie())
            if path == "/api/phone/forget":
                if not self._local:
                    return self._send(403, {"error": "Only from the office computer"})
                phone.forget_sessions()
                store.activity("director", "Signed every phone out of the hub")
                return self._send(200, {"ok": True})
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


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    tls = False
    ca_file = None

    def handle_error(self, request, client_address):
        log.debug("Connection from %s dropped", client_address[0])


def serve(demo=False, open_browser=True, allow_phone=False, https=False):
    if demo:
        store.use_db(config.DATA_DIR / "demo.db")
        from . import demo as demo_data
        demo_data.seed()
    if allow_phone:
        config.HUB_ALLOW_LAN = True
    if not demo and workers.mailbox_ready():
        threading.Thread(target=agent_loop, daemon=True, name="agents").start()
    elif not demo:
        log.warning("MAIL_PASSWORD not set: the hub runs, but the agents can't read the mailbox yet.")
    threading.Thread(target=task_loop, daemon=True, name="tasks").start()
    host = "0.0.0.0" if config.HUB_ALLOW_LAN else "127.0.0.1"
    httpd = _Server((host, config.HUB_PORT), Handler)
    url = f"http://localhost:{config.HUB_PORT}"
    log.info("Boss Hub running at %s%s", url, "  (demo data)" if demo else "")
    if config.HUB_ALLOW_LAN:
        ips = phone.local_ips()
        if ips:
            log.info("On your phone (same Wi-Fi):  http://%s:%d   PIN %s%s", ips[0], config.HUB_PORT, phone.pin(),
                     "" if phone.pin_fixed() else "   (set HUB_PIN in .env to choose your own)")
            log.info("Settings -> Phone in the hub shows a QR code that pairs the phone in one scan.")
        else:
            log.warning("Phones allowed, but no network address was found. Is this computer on the Wi-Fi?")
        if https or config.HUB_HTTPS:
            files = phone.tls_files()
            if not files:
                log.warning("The secure address needs the 'cryptography' package:  pip install cryptography")
            else:
                ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                ctx.minimum_version = ssl.TLSVersion.TLSv1_2
                ctx.load_cert_chain(files[0], files[1])
                tls_server = _Server((host, config.HUB_HTTPS_PORT), Handler)
                tls_server.socket = ctx.wrap_socket(tls_server.socket, server_side=True, do_handshake_on_connect=False)
                tls_server.tls = True
                tls_server.ca_file = httpd.ca_file = str(files[2])
                threading.Thread(target=tls_server.serve_forever, daemon=True, name="https").start()
                if ips:
                    log.info("Secure address for the microphone:  https://%s:%d   (trust http://%s:%d/ca.crt on the phone first)",
                             ips[0], config.HUB_HTTPS_PORT, ips[0], config.HUB_PORT)
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    # From here on, what the team logs shows in the hub's activity feed (the start-up lines above stay in the terminal).
    logging.getLogger("agents").addHandler(workers.ActivityHandler())
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass

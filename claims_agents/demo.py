"""Sample data for `python -m claims_agents hub --demo`. Every name and file here is fictional."""

from datetime import datetime, timedelta, timezone

from . import config, store


def _t(**ago):
    return (datetime.now(timezone.utc) - timedelta(**ago)).replace(microsecond=0).isoformat()


CLAIMS = [
    ("Amir Hussain", "CC10231", "Insurer disputes the hire rate and asks for earnings evidence; Danny has answered with the Hussain exception points.", dict(hours=60), dict(hours=70), 1),
    ("Jessica Lane", "CC10244", "Liability admitted. Repair estimate agreed; storage invoice outstanding with the insurer.", dict(hours=5), dict(days=2), 0),
    ("Mohammed Rafiq", "CC10252", "Fraud desk 'concerns' letter with no particulars. Particularisation demand sent; awaiting reply.", dict(days=6), dict(days=4), 2),
    ("Priya Patel", "CC10260", "New PCO claim. Client documents requested: licence, V5C, 12 weeks of platform statements.", dict(hours=20), dict(hours=3), 0),
    ("Daniel Okafor", "CC10263", "Carflex engineer report received: repair uneconomic. Total loss valuation challenge being prepared.", dict(hours=2), dict(days=1), 0),
    ("Sara Begum", "CC10271", "Third-party insurer silent for 9 days after claim notification. Final chaser drafted.", None, dict(days=9), 3),
    ("Tom Whitfield", "CC10275", "Split liability offer 50/50 received. Dashcam supports our client; Hemant reviewing.", dict(days=1), dict(hours=30), 0),
    ("Leah Kowalski", "CC10280", "Settlement offer on hire charges below GTA rate. Counter-offer awaiting Director.", dict(hours=8), dict(hours=26), 1),
]

DRAFTS = [
    ("danny", "Danny", "followup", "Sara Begum - CC10271", "Our ref CC10271 / Your ref TPI-55821 - Final chaser: claim notification of 10 November",
     "claims@insurer-b.example", "Danny | followup | step: 2 final chaser | deadline: 48 hours",
     "<p>Dear Sirs,</p><p>We wrote to you on <strong>10 November 2026</strong> notifying our client's claim arising from the collision on 3 November 2026. "
     "We have had no acknowledgement and no decision on liability.</p><p>Please provide, by <strong>4pm on 21 November 2026</strong>:</p>"
     "<ul><li>your acknowledgement and claim reference;</li><li>your position on liability; and</li><li>confirmation that your insured's account and any dashcam footage have been preserved.</li></ul>"
     "<p>If we do not receive a substantive reply by then, we will raise a <strong>formal complaint</strong> under your complaints procedure. Our client's hire and storage charges continue to accrue daily while this claim waits.</p><p>Yours faithfully</p>"),
    ("danny", "Danny", "reply", "Mohammed Rafiq - CC10252", "Our ref CC10252 / Your ref FD-2291 - Your letter of 14 November: particulars required",
     "fraud.unit@insurer-c.example", "Danny | reply | step: particularisation demand | deadline: 7 days | NOTE: Recommend DSAR to insurer in parallel",
     "<p>Dear Sirs,</p><p>We refer to your letter of 14 November 2026, which says you have <em>concerns</em> about this claim but identifies none.</p>"
     "<p>If you intend to allege that this claim is not genuine, the burden is yours, and the allegation must be put distinctly with the facts relied on. Please state by <strong>26 November 2026</strong>:</p>"
     "<ul><li>the precise allegation and who made the decision;</li><li>every fact and document relied on; and</li><li>whether you intend to plead fraud or fundamental dishonesty.</li></ul>"
     "<p>Until then, the claim stands to be dealt with on its merits, and we expect a reasoned decision within the time your regulator requires.</p><p>Yours faithfully</p>"),
    ("harry", "Harry", "reply", "Priya Patel - CC10260", "Your claim CC10260 - documents we need from you this week",
     "priya.patel@client.example", "Harry | reply | step: documents | deadline: 3 days",
     "<p>Dear Priya,</p><p>Thank you for your call this morning. To move your claim forward quickly, please send us the following by <strong>Friday 21 November</strong>:</p>"
     "<ul><li>your PCO licence (both sides);</li><li>the V5C for your vehicle;</li><li>your last <strong>12 weeks</strong> of platform earnings statements.</li></ul>"
     "<p>Photos taken on your phone are fine. Reply to this email with them attached and we will take it from there.</p><p>Kind regards</p>"),
]

ACTIVITY = [
    (dict(minutes=1), "danny", "Read and filed 3 new emails"),
    (dict(minutes=1), "danny", "handler@insurer-a.example | Re: CC10231 hire rate -> Clients/Amir Hussain - CC10231"),
    (dict(minutes=2), "harry", "Forwarded the Carflex report (2 files) to Shahzaib"),
    (dict(minutes=6), "danny", "Drafted 'Our ref CC10252 / Your ref FD-2291 - Your letter...' (awaiting Shahzaib)"),
    (dict(minutes=14), "hemant", "Reviewing split-liability offer on Whitfield - CC10275"),
    (dict(minutes=21), "director", "Approved: Our ref CC10244 - Storage invoice and release"),
    (dict(minutes=22), "danny", "SENT (approved by Shahzaib): storage invoice chaser -> claims@insurer-a.example"),
    (dict(minutes=38), "harry", "Drafted 'Your claim CC10260 - documents we need from you this week'"),
    (dict(hours=1), "danny", "Found 2 files overdue for a chase"),
    (dict(hours=1, minutes=5), "danny", "Drafted 'Final chaser: claim notification of 10 November' (awaiting Shahzaib)"),
    (dict(hours=2), "danny", "promo@newsletter.example | Webinar invite -> Marketing - Spam"),
    (dict(hours=3), "harry", "Working on task: request CCTV from the council for the Okafor junction"),
    (dict(hours=5), "danny", "Read and filed 6 new emails"),
    (dict(hours=7), "hemant", "Daily audit saved and emailed to Shahzaib"),
    (dict(hours=9), "danny", "Read and filed 4 new emails"),
    (dict(hours=13), "danny", "Read and filed 2 new emails"),
    (dict(hours=18), "harry", "Forwarded the Carflex report (1 file) to Shahzaib"),
    (dict(hours=20), "danny", "Read and filed 5 new emails"),
]


def seed():
    config.REPORTS_DIR = config.DATA_DIR / "demo-reports"
    config.REPORTS_DIR.mkdir(exist_ok=True)
    if store.get("demo") == "1":
        return
    store.put("demo", "1")
    store.put("first_run_done", "1")
    store.put("last_pass", _t(minutes=1))
    with store.db() as c:
        for i, (name, ref, summary, inbound, outbound, chase) in enumerate(CLAIMS):
            folder = f"{config.CLIENTS_PARENT}/{name} - {ref}"
            c.execute("INSERT OR REPLACE INTO claims VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (folder, name, ref, "open", _t(**inbound) if inbound else None,
                       _t(**outbound) if outbound else None, "claims@insurer-a.example", chase, summary, _t(minutes=i * 7)))
        for n in range(14):
            c.execute("INSERT OR REPLACE INTO processed VALUES (?,?,?,?)", (f"<demo-{n}>", "INBOX", "", _t(minutes=n * 37)))
        for n, (eid, agent, kind, label, subject, to, note, body) in enumerate(DRAFTS):
            c.execute("INSERT INTO drafts (id, folder, agent, kind, recipients, subject, status, note, created_at, body_html)"
                      " VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (f"demo{n}", f"{config.CLIENTS_PARENT}/{label}", agent, kind, to, subject, "awaiting", note, _t(minutes=6 + n * 30), body))
        for n in range(9):
            c.execute("INSERT INTO drafts (id, folder, agent, kind, recipients, subject, status, note, created_at, decided_at)"
                      " VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (f"demo-sent{n}", "", "Danny", "reply", "claims@insurer-a.example", f"Sent item {n}", "sent", "", _t(days=n % 6, hours=2), _t(days=n % 6)))
        for ago, who, text in ACTIVITY:
            c.execute("INSERT INTO activity (ts, employee, text) VALUES (?,?,?)", (_t(**ago), who, text))
    t1 = store.add_task("harry", "Request council CCTV for the Okafor junction", "Junction of the A4 and Syon Lane, 18 Nov 2026, 17:40-18:10.",
                        f"{config.CLIENTS_PARENT}/Daniel Okafor - CC10263")
    store.finish_task(t1, "done", "CCTV preservation and subject access request drafted to the council; it's in your approvals.",
                      "<h3>CCTV request</h3><p>Preservation and UK GDPR art 15 request drafted for the council's CCTV team, covering 17:30-18:20.</p><ul><li>Chaser diarised for day 3</li><li>Escalation before day 25 (overwrite risk)</li></ul>")
    t2 = store.add_task("hemant", "Audit the 50/50 offer on the Whitfield file", "Should we accept? Dashcam attached to the file.",
                        f"{config.CLIENTS_PARENT}/Tom Whitfield - CC10275")
    with store.db() as c:
        c.execute("UPDATE tasks SET status='running', started_at=? WHERE id=?", (_t(minutes=14), t2))
    store.add_task("danny", "Draft a letter before claim on the Begum file if they miss Friday's deadline", "", f"{config.CLIENTS_PARENT}/Sara Begum - CC10271")
    from .hemant import render
    sample = [dict(client="Mohammed Rafiq", reference="CC10252", stage="Fraud desk, no particulars", rag="red",
                   headline="Generic 'concerns' letter. Hold them to particulars and run the DSAR now.",
                   liability="Disputed (fraud desk)", money_at_stake="£11,840 hire + £1,320 storage",
                   validity_checks=["ID checked", "Dashcam on file"], weaknesses=["Hire started same day as notification"],
                   fraud_desk_risks=["Prior claim in 2024 to be disclosed first"], escalation_now="Particularisation demand sent",
                   strongest_next_move="DSAR to the insurer for the fraud referral and triage output",
                   next_actions=["Approve Danny's draft", "Send DSAR"], deadlines=["26 Nov: their reply due"]),
              dict(client="Jessica Lane", reference="CC10244", stage="Quantum", rag="green", headline="On track: storage invoice is the last item.",
                   liability="Admitted", money_at_stake="£2,410", validity_checks=["Invoice verified"], weaknesses=[], fraud_desk_risks=[],
                   escalation_now="Chaser sent", strongest_next_move="Interest claim if unpaid by 28 Nov", next_actions=["Diarise 28 Nov"], deadlines=["28 Nov"])]
    (config.REPORTS_DIR / f"hemant-{datetime.now():%Y-%m-%d}.html").write_text(render(sample, "", store.drafts("awaiting")), encoding="utf-8")

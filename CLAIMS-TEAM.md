# Claims team: Danny, Harry and Hemant

Three Claude-powered employees working the `claims@courtesycars.net` IONOS mailbox.

| Agent | Job |
|---|---|
| **Danny Kaleem, Claims Manager** | Reads every email and works out which claim it belongs to. Files it into `Clients/Client Full Name - Reference`. Drafts replies to insurers, fraud desks, solicitors and the MIB, and chases every overdue file up the escalation ladder (chaser → final chaser → formal complaint → letter before claim/action → FOS). |
| **Harry, Claims Handler** (6 helpers) | Takes over what Danny has no time for: Carflex engineer reports, client updates, document collection, CCTV and preservation requests, garages, recovery and storage, and deadlines. Forwards every Carflex engineer report to Shahzaib. |
| **Hemant, Head of Legal & Audit** | Every evening, audits each open file: validity, weaknesses, fraud-desk risks, and the strongest next move. Every Monday, he adds a legal and market research briefing. The report is emailed to Shahzaib as a colour-coded page (red, amber, green) and saved in `reports/`. |

All three follow the `danny-brain` and `danny-brain-supreme` playbooks, and Hemant also follows `hemant-audit`.

## Nothing leaves without Shahzaib

Agents never send anything to an outside party. Each draft lands in the IONOS folder **`Awaiting Shahzaib`**, and Shahzaib gets an email listing it. In IONOS webmail, Shahzaib then does one of three things:

- **Send it:** drag it to **`Approved - Send`**. It goes out at the next scan (within 15 minutes) with the footer, **high priority** and a **read-receipt request**.
- **Refuse it:** drag it to **`Rejected`**. It's logged, and Danny won't draft another chaser on that file for 48 hours.
- **Delete it:** it is simply dropped.

The only emails sent without approval go to Shahzaib himself: forwarded Carflex reports, Hemant's report, and the list of drafts awaiting approval.

## Set-up (once, on the office computer)

1. **Install Python 3.11 or newer** from python.org. On Windows, tick "Add Python to PATH" during install.
2. **Download this project.** On GitHub, use **Code → Download ZIP** and unzip it, or use `git clone`.
3. **Open a terminal in the project folder** and install the agents:

   ```bash
   python -m pip install -r requirements.txt
   ```

4. **Fill in the settings.** Copy `.env.example` to `.env` and fill in:
   - `ANTHROPIC_API_KEY`: create one at platform.claude.com → API keys.
   - `MAIL_PASSWORD`: the IONOS password for `claims@courtesycars.net`.
   - `DIRECTOR_EMAIL`: Shahzaib's email address.
   - `CARFLEX_DOMAINS`: the Carflex engineers' email domain.
5. **Add the playbooks** to the `knowledge/` folder, as described in `knowledge/README.md`.
6. **Add the footer.** Copy `footer.example.html` to `footer.html` and fill in your details. `{{LOGO}}` is replaced with the logo from `print/`.
7. **Test the connection** (this changes nothing):

   ```bash
   python -m claims_agents check
   ```

8. **Do a practice run.** This reads everything but moves and sends nothing. The drafts are saved to `data/dry-run/` so you can read them first.

   ```bash
   python -m claims_agents run --dry-run
   ```

9. **Start the team.** Leave this window open. The team scans every 15 minutes.

   ```bash
   python -m claims_agents start
   ```

## Other commands

| Command | What it does |
|---|---|
| `python -m claims_agents followups` | Danny chases every overdue file right now. |
| `python -m claims_agents hemant --research` | Hemant's audit and research report right now. |
| `python -m claims_agents run` | One full pass now: send approved drafts, file the inbox, draft replies, chase. |

## The first run

The first run reads the last 60 days of the inbox and sent items (`BACKFILL_DAYS`). It files everything into client folders and builds each claim's history. It drafts replies only to emails from the last 3 days. Older files are picked up by Danny's follow-up pass instead, one draft per overdue file, so Shahzaib isn't flooded.

## Notes

- **Costs (Claude API, estimate):** filing an email costs about 1p. A drafted reply or chaser costs roughly 5–40p, because each draft reads all the playbooks (about 58,000 tokens, cached where possible). Hemant's daily audit of 40 files costs a few pounds a day. Watch actual spend at platform.claude.com.
- **Security:** `.env`, `knowledge/`, `footer.html`, `data/` and `reports/` are never uploaded to GitHub. This repository is public, so keep it that way, or make the repository private.
- **Logs** are written to `data/agents.log`.

# Claims team: Danny, Harry and Hemant

Three Claude-powered employees working the `claims@courtesycars.net` IONOS mailbox.

| Agent | Job |
|---|---|
| **Danny Kaleem, Claims Manager** | Reads every email and works out which claim it belongs to. Files it into `Clients/Client Full Name - Reference`. Drafts replies to insurers, fraud desks, solicitors and the MIB, and chases every overdue file up the escalation ladder (chaser → final chaser → formal complaint → letter before claim/action → FOS). |
| **Harry, Claims Handler** (6 helpers) | Takes over what Danny has no time for: Carflex engineer reports, client updates, document collection, CCTV and preservation requests, garages, recovery and storage, and deadlines. Forwards every Carflex engineer report to Shahzaib. |
| **Hemant, Head of Legal & Audit** | Every evening, audits each open file: validity, weaknesses, fraud-desk risks, and the strongest next move. Every Monday, he adds a legal and market research briefing. The report is emailed to Shahzaib as a colour-coded page (red, amber, green) and saved in `reports/`. |

All three follow the `danny-brain` and `danny-brain-supreme` playbooks, and Hemant also follows `hemant-audit`.

## The Boss Hub

A web app on the office computer, used to run the whole team:

```bash
python -m claims_agents hub
```

This starts every agent and opens **http://localhost:8765** in your browser. In the hub you can:

- **See everything at a glance:** emails filed today, drafts awaiting approval, sent items, overdue files, and a live activity feed.
- **Switch staff on or off.** An employee who is off picks up no work. If Harry is off, Danny covers his emails.
- **Give any employee a task**, with or without a claim file. Results come back to the Tasks page. Any email they draft goes to your approvals.
- **Hire new employees.** Give them a name, a role and a brief. Edit anyone's brief, or remove a hired employee.
- **Approve or reject drafts** in a full email preview. An approved draft is sent straight away.
- **Search the claim files** to see who is waiting on whom and how far up the chase ladder each file is.
- **Read Hemant's reports.**
- **Use it on your iPhone** over the office Wi-Fi, as a Home Screen app (see *On your iPhone* below).
- **Talk to your personal assistant** (the blue orb, or Ctrl/⌘+K). Ask "brief me", "what needs my approval?", "read me the second one", "switch Harry off", "remind me at three to chase Patel" or "give Danny a task to…". Use voice mode to talk and hear the replies. Turn on hands-free for a back-and-forth conversation. You can rename the assistant in Settings. The assistant can't approve emails: you always tap Approve yourself.

Voice works in **Chrome or Microsoft Edge**. Edge's "Natural" voices sound the most human, so pick one in the voice menu. The first time you use voice, allow the microphone.

To look around first without connecting anything:

```bash
python -m claims_agents hub --demo
```

The hub only answers the computer it runs on.

### The assistant, the deck and the Logic page

- **Command deck.** When the hub opens, the assistant greets you by name with what matters right now (drafts, decisions, overdue files) and, if you allow it, says it out loud. The particle orb reacts to your voice and hers. **Talk** opens full-screen voice mode; **Brief me** gives a spoken briefing; **Again** repeats the greeting. You can also say "say that again".
- **She remembers.** The conversation is kept on the hub itself, not in the browser, so the phone and the computer share it: she knows what she said last, what you decided, and what is on your screen. Short references work: "the second one", "that file", "him". The last forty exchanges are kept word for word and older ones are folded into a short summary, with the things worth remembering (how you like things done) kept across every device.
- **She asks before anything serious.** Switching someone off, retiring a standing order, cancelling a task, recording a decision or giving a task that emails someone is read back to you as one question first; a plain "yes" does it, "no" or "leave it" drops it. She never approves, sends or edits a draft: there is no tool for it. "Read me the first draft" reads the letter out and shows it in Approvals; approving is still your tap.
- **Reminders.** "Remind me in twenty minutes to…" or "at three" or "tomorrow at nine" sets a reminder the hub announces when it is due (see them under `/api/reminders`, or just ask her).
- **Without a Claude key** the team and the assistant are off. The status line and the Today page say so, a task you give waits as "queued" until the key is added, and the assistant answers with a short line out loud and the setup note in the chat.
- **Natural voice.** The assistant speaks with Microsoft's neural voices (free, no account or key; installed by `pip install -r requirements.txt`). Pick a voice and preview it in Settings; British voices come first (Sonia is the default: warm and a touch unhurried; Libby brighter; Ryan and Thomas male), then Irish, Australian and American. Each voice has its own tuned pace and pitch (`TTS_RATE`, `TTS_PITCH`, `TTS_VOLUME` in `.env` override them). Spoken sentences are kept in `data/tts-cache` (200 MB, oldest dropped first), so the greeting, "say that again" and announcements play instantly: the greeting is prepared in the background as soon as it is written. If Microsoft's service is unreachable, the hub says so in Settings and the browser's built-in voice takes over; that never shows up as staff activity.
- **Announcements.** When a new draft, decision, task result or reminder arrives while the hub is open, the assistant tells you (on screen, and out loud if that's on in Settings).
- **Logic page: how the team thinks.**
  - **Decisions.** When an agent meets a situation your orders don't cover (a regulator contact, a complaint about the firm, an unusual settlement condition), it stops and asks you here instead of guessing. The assistant works out a recommendation and alternatives, with the risk of getting it wrong. Pick an option or type your own instruction, and the employee gets it as a task.
  - **Standing orders.** Your decisions are saved as "When X, do Y" rules (tick "Remember"), and you can add orders directly or just tell the assistant "From now on, when X happens, do Y." Every agent reads every active order on every job, so the team learns from each ruling. Orders can be paused or deleted.
  - Orders are followed within the law and the playbooks. An order that would need a false statement or an unlawful step is refused, and the assistant tells you why.

### On your iPhone

The hub works on your iPhone over the office Wi-Fi, as an app on your Home Screen.

1. **Start the hub so phones can reach it.** On the office computer run `python -m claims_agents hub --phone` (or put `HUB_ALLOW_LAN=true` in `.env`). If Windows Firewall asks, allow Python on **private** networks. The terminal prints the phone address and a PIN.
2. **Pair the phone.** In the hub on the office computer open **Settings → Phone** and scan the QR code with the iPhone camera. The hub opens in Safari already signed in. (Or type the address shown and enter the PIN.)
3. **Make it an app.** In Safari tap **Share → Add to Home Screen**. Open it from the Home Screen; if it asks for the PIN, enter it once. It stays signed in for 90 days.

Everything works on the phone exactly as on the computer: approvals (press and hold **Approve** to send), decisions, standing orders, switching staff on and off, tasks, the files, Hemant's reports and the spoken assistant.

**Talking to the assistant on the phone.** Spoken replies, "Brief me" and "Again" work everywhere. The microphone is stricter: iPhones only allow it on a secure address, and Apple does not allow it inside Home Screen web apps at all, so voice *input* is for a Safari tab on the hub's secure address. The hub can make that address itself:

1. Start the hub with `python -m claims_agents hub --phone --https` (or set `HUB_HTTPS=true`). The first time, it makes its own certificate authority in `data/tls/`.
2. On the iPhone, in **Safari** (not Chrome), open the `ca.crt` address shown in **Settings → Phone** and allow the download, then go to **Settings → Profile Downloaded → Install**.
3. Go to **Settings → General → About → Certificate Trust Settings** and switch on **Boss Hub Local CA**.
4. Open the **https** address from Settings → Phone in Safari. "Talk" now works there. Keep it as a Safari bookmark; use the Home Screen app for everything else.

Lockdown Mode on the iPhone blocks step 2, and the dictation service must be on (Settings → General → Keyboard → Enable Dictation).

Safety: a phone only gets in after the QR code or the PIN, the sign-in is a secure cookie the page cannot read, five wrong PINs lock the PIN for 30 seconds (doubling each time), and **Settings → Phone → Sign every phone out** removes every phone at once. The hub still refuses any address it does not recognise, and other websites cannot drive it. Choose your own PIN with `HUB_PIN` in `.env` (4 to 8 digits).

Phones are supported from iOS 16.4; Android phones work the same way (Chrome → menu → Add to Home screen).

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

9. **Start the team and the hub.** Leave this window open. The team scans every 15 minutes.

   ```bash
   python -m claims_agents hub
   ```

   To run the agents without the hub, use `python -m claims_agents start` instead.

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

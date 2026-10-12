# ClaimDesk 0.4 — what's new

**For:** Courtesy Cars Group UK Ltd. **Install:** run `ClaimDesk-Setup-0.4.<n>.exe` over your current ClaimDesk. Your
claims, documents and settings in `%LOCALAPPDATA%\ClaimDesk` are kept, and a backup of the database is made the first
time the new version starts. No administrator rights are needed.

## Big files upload now ("still can't upload — too large")

- **One upload can now be up to 2 GB** (it was 25 MB). Photos, videos, PDFs, Audatex `.cab` files — all fine.
- **Big files go in parts.** Anything over 64 MB is sent in 8 MB parts. You see a progress bar and a plain message,
  for example *"This file is 310 MB — it will upload in parts."* If the connection drops, ClaimDesk carries on from
  where it stopped instead of starting again.
- **Your computer stays quick.** ClaimDesk no longer reads a whole big file into memory to check it. For files over
  256 MB the fingerprint (SHA-256) is worked out by ClaimDesk itself and shown when the upload has finished.
- **Clear messages** when something goes wrong: the file is too large, there is not enough free disk space, or the
  upload stopped part-way (nothing half-finished is ever stored).
- Word templates keep their 15 MB limit; nothing else changes.

## The import folder — the easiest way to bring in big files

ClaimDesk now has a folder on your computer where you can drop files of **any size**:

`%LOCALAPPDATA%\ClaimDesk\inbox` (Start menu → **ClaimDesk import folder**, or Settings → **Import folder** → *Open folder*)

| Put files in… | What ClaimDesk does |
|---|---|
| `evidence\CCG-2026-00012\` (a folder named after the claim) | Adds the file to that claim as evidence, fingerprinted and stored write-once. |
| `evidence\` | Keeps it ready; attach it to a claim from Settings → Import folder. |
| `intake\` | Documents for ClaimDesk to read into a claim (V5C, licence, insurance certificate, estimates). |
| `mail\` | Emails saved as `.eml` files, filed to the right claim like any other email. |
| `brain-packs\` | Your private playbook packs. They stay on this computer and never go to GitHub. |
| `engineer-data\` | Audatex and other engineer data (`.cab`). |

ClaimDesk waits until a file has finished copying (about 10 seconds with no change), checks it, moves it into its own
data folder and lists it under **Settings → Import folder** (the last 20 files, with their status). Nothing in this
folder is sent anywhere.

Do **not** attach `.cab` files or private playbook files to a chat, and never put them in GitHub.

## ClaimDesk keeps running in the background

The ClaimDesk agents need ClaimDesk to be running even when its window is closed, so 0.4 can run it in the
background:

- The installer has a ticked box: **"Keep ClaimDesk running in the background (needed for the agents)"**. With it
  ticked, ClaimDesk starts by itself when you sign in to Windows, without any window, and a check every 15 minutes
  starts it again if it has stopped.
- Opening ClaimDesk from the Start menu just opens the window; **closing the window no longer stops ClaimDesk**.
  Use Start menu → **Stop ClaimDesk** to stop it completely.
- If ClaimDesk ever keeps failing (more than 20 restarts in an hour) it stops and tells you; the log files are in
  `%LOCALAPPDATA%\ClaimDesk\logs` (kept for 14 days).
- Links in ClaimDesk notifications (`claimdesk://…`) open the right page in ClaimDesk.
- Untick the box when you install if you do not want this; ClaimDesk then works exactly as 0.3 did.

For 24/7 running: turn off sleep in Windows power settings, and turn on Windows "Use my sign-in info to
automatically finish setting up after an update", so ClaimDesk comes back after an update restart.

## The agents (ClaimDesk Supreme, first phase)

0.4 also brings the first ClaimDesk agents: reading uploads and email, filing them to claims, preparing replies and
letters in the CCGUK templates, chasers, a **Needs you** inbox for anything that needs your decision, and a **daily
log** of everything done. Offers and settlements always come to you. Anything missing is prepared and shown to you
first.

**The agents stay off after the upgrade** until you finish **Settings → AI** and tick the checklist — nothing is sent
by surprise.

## Smart intake (case bundles)

**What it is:** a quicker way to start a claim from a pile of documents. Instead of uploading files one by one, you
give the case a temporary name and drop everything you have at once. ClaimDesk reads all the files together and
prepares one claim for you to check and register.

**How to use it**

1. Go to **Intake → Case bundles → New bundle**. Type a temporary name, for example *Jane Doe – Corsa crash*.
2. Drop the files: PDFs, photos, scans, Word files, emails (`.eml`, with their attachments) and `.zip` files — or a
   whole folder. Each file shows its progress. For very large files or a whole folder you can also copy them into
   `inbox\intake\<a name>\` in the import folder; that folder becomes a bundle by itself.
3. Wait a moment while ClaimDesk reads everything. Then check the bundle page:
   - **Files & cases** — if the pile holds more than one case, the files are sorted into *This case*, *New case B*,
     an existing claim (for example *CCG-2026-00003*) and *Not sure*, each with the reason (*Same registration
     KX21 ABC as the V5C*). Move any file with **Move to…**; your choice always wins. **Make a separate bundle**
     turns another case into its own bundle.
   - **Details that disagree** — when two documents say different things (two VINs, two dates of birth), you see
     both, with the more reliable document picked for you (the V5C beats an estimate for the VIN, the licence beats a
     claim form for the date of birth, the police report beats a letter for the accident time). Nothing is changed
     until you choose; **Accept all preselected** settles them in one go.
   - **Draft claim** — every detail shows where it came from (*V5C · page 1*). Click it to see the page with the line
     highlighted. Use the pencil to correct anything; your corrections teach ClaimDesk for next time.
   - **Missing documents** — what is still needed for this kind of claim (licence front and back, insurance
     certificate, four photos with the plate, bank details …) and the email to the client asking for them.
   - **Chronology** — dated events found in the documents, ticked to be added to the claim. Offers, settlements,
     payments, hire dates and legal steps are never added by intake — you record those.
   - **Worth a look** — only you see this, and nothing is declined or reported: for example a photo taken before the
     accident date (camera clocks are often wrong), a PDF re-saved with an editing tool, or a phone number already on
     another claim. Press **Noted** once you have checked.
   - **Photos** — the date and place each photo was taken, the number plates read from them and the damaged parts,
     which are put on the claim's damage model.
4. Press **Register claim**. The box tells you exactly what will happen. One click creates the claim, files every
   document under the right type (copies of the same photo or letter are filed once), adds the ticked chronology
   entries, records the damage, files any letters for other claims on those claims, and wakes the Autopilot.
5. You then see a **case brief**: a short summary, the key facts with their sources, a liability guide (your decision),
   what is still missing, *call the client first*, and the Autopilot's first steps. The brief also appears on the
   claim's Overview.

**Already have a claim for these documents?** Use **Attach to existing claim…** instead. The files are filed on that
claim; tick which details to copy across, and the rest wait for you in Needs you. ClaimDesk does not ask the client
again for things the claim already holds.

**When the agents are paused** everything still works from the documents' text, and you can register. Photos and
scans are read when the agents are back, and the draft improves by itself.

**Things that always stay with you:** opening a claim (unless you switch on automatic registration), the request to
the client for missing documents (it waits for your approval before it is sent), offers, settlements, money and legal
steps. Nothing is ever declined, and no one is ever accused of anything, automatically.

**Automatic registration (off unless you turn it on):** *Settings → Intake → Register automatically when there are no
conflicts and every key field is confident.* It only happens when every key detail is confident, nothing disagrees,
the AI has checked the bundle and nothing is worth a look — and you still get a card to look the new claim over.
Bundles that are not registered automatically wait in **Needs you** as prepared claims.

Every step is in the **daily log** (*Read 12 files for bundle …*, *Registered CCG-2026-00042 …*) and the audit trail.
Full details: `docs/SMART-INTAKE.md` and `docs/RELEASE-NOTES-0.5-SMART-INTAKE.md`.

## AI input on every claim

Every open claim now has an **AI input** button at the top (and its own **AI input** tab). It does two things.

**1. Catch up a claim from documents.** Opened a claim late, or posted or emailed letters without ClaimDesk? Drop the
files on the claim under **Catch-up documents** (any number, big files and folders too). ClaimDesk reads each one and:

- files it in the right place, and doesn't file it twice if you already have it;
- splits a scanned pack into its separate documents;
- dates it from what the letter itself says, never from the day you uploaded it;
- works out whether **you sent it** or **you received it**.

A letter you sent outside ClaimDesk is recorded as sent on its real date. For example, a New Claim Advice Form you
posted on 5 October is recorded as sent on 5 October, so the Autopilot and the agents know it went and **do not send
it again**. A letter you received is recorded on the day it is dated. Either way the chronology shows it as *recorded
late, source: <file>*.

The deadlines are worked out again from those real dates, so you may see that one was already met, or already missed.
Details read from the letters go through the same checks as intake: an empty field can be filled, but anything that
differs from the claim waits for your tick and is never silently overwritten. When ClaimDesk can't tell who wrote a
letter, it asks you *Who sent it?*. A **What changed** summary shows everything it did. The Autopilot and the case
manager then plan again from the updated file.

**2. Tell ClaimDesk what happened, or what to do.** Type it in your own words. Some examples:

- *client called, car repaired, hire ended yesterday*
- *TP insurer admitted liability today ref AB123*
- *don't chase the client until Monday*
- *send the engineer report to the insurer*
- *pause this claim until Friday*

You can also paste a call note. ClaimDesk takes facts from it, but never instructions.

You then see exactly what it will do before anything happens, and press **Do it**. Routine things are done straight
away: chronology entries with the date you gave, ending a hire, reminders, notes and details. Most lines have
**Undo**.

Some things are never done by ClaimDesk itself. **Offers, settlements, money, legal steps and closing or declining a
claim** always go to **Needs you** for your decision. If you type *accept their offer of 2000*, you get a card that
takes you to the Offers screen; nothing is accepted automatically. Changing liability, or overwriting a detail already
on file, needs your tick.

If your note is unclear, ClaimDesk asks you a short question instead of guessing. For example, *stop emailing the
insurer* gets *Until when?*.

Common phrases work even while the agents are paused. Anything else waits for the AI and carries on when it is back.

**Standing instructions.** *Don't chase the client until Monday* becomes a standing instruction on the claim, and it
is followed until Monday:

- the Autopilot holds its emails to the client;
- the signing reminders stop;
- any email to the client asks you first;
- every agent working on the claim is told about it.

You can see and remove standing instructions on the AI input tab. Each note you type is kept word for word in the
**history** on the tab, with what it did. Everything is in the audit trail under your name and in the **daily log**
under *Updates and catch-ups*. Suspicions about anyone stay as your private note: they never become an instruction, a
chronology entry or anything sent. Full details: `docs/CLAIM-AI-INPUT.md`.

## Good to know

- Windows may still say "Unknown publisher" until the installer is code-signed.
- Your existing data, templates and settings are untouched. To go back, run the 0.3.7 Setup (it asks first) — the
  backup made before the upgrade is in `%LOCALAPPDATA%\ClaimDesk\data\backups`.

## Also in 0.4

- **Light, dark or system theme.** Use the sun/moon button in the top bar, or Settings → Appearance.
- **3D damage model.** Claim → Engineering → *Damage model* shows a 3D car shaped for the claim vehicle's make and
  model, in its colour and with its number plate. You can upload a licensed exact 3D model (`.glb`/`.gltf`) under
  Settings → 3D models; ClaimDesk then uses it instead.
- **Settlement offers have their own register.** Offers from insurers to settle are no longer mixed in with hire
  intervention offers. Only you can accept, counter or reject an offer; the agents only record and analyse it.

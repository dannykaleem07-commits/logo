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

## Good to know

- Windows may still say "Unknown publisher" until the installer is code-signed.
- Your existing data, templates and settings are untouched. To go back, run the 0.3.7 Setup (it asks first) — the
  backup made before the upgrade is in `%LOCALAPPDATA%\ClaimDesk\data\backups`.

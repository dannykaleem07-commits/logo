# ClaimDesk 0.3 for Windows — release notes

**ClaimDesk 0.3 for Windows — update.** Download **ClaimDesk-Setup-0.3.x.exe** and run it. It updates
ClaimDesk in place: your claims, documents and settings in `%LOCALAPPDATA%\ClaimDesk` are kept, and a backup of the
database is made automatically the first time the new version starts. No administrator rights are needed. If
ClaimDesk is open, the installer asks to close it first.

## What's new in 0.3

- **Manager mode** — one click in the top bar (admin and approver users). Anything that would stop you can be
  overridden; every override is recorded with who, when and why. Switches itself off after 60 minutes without
  activity, and when you sign out.
- **Hire pricing guide** — when you pick a car for hire you see its daily rate, the GTA guide for the car you are
  giving and for the client's damaged car, the difference, and a warning when the car is a higher group. Pick the
  agreed rate with one click. (GTA rates are an industry benchmark only; CCGUK is not a subscriber.)
- **Edit hire dates** — change the start and end of any hire, including back-dating a hire an agent forgot to
  enter. Charges, clocks and the ledger are recalculated; every change is kept in the history.
- **Typing fixed** — fields in pop-up windows no longer lose the cursor after each letter.
- **Simpler screens** — fewer tabs, shorter forms, plain English.
- **Updates** — Settings → Updates shows your version and tells you when a newer one is out.

Windows may say "Unknown publisher" until the installer is code-signed. From 0.3 on, ClaimDesk tells you about new
versions itself (Settings → Updates).

## How to update

1. Download **ClaimDesk-Setup-0.3.x.exe** — from Settings → Updates (the **Download** button), or from the
   releases page: https://github.com/dannykaleem07-commits/logo/releases (the newest ClaimDesk release is at the
   top).
2. Run it. If Windows shows "Windows protected your PC", choose **More info → Run anyway** (the installer is not
   code-signed yet).
3. If ClaimDesk is open, the installer asks to close it: save anything you are typing, then click **OK**.
4. Click through the installer. It updates the copy you already have — same Start menu shortcuts, same place.
5. Start ClaimDesk. The first start of the new version takes a few seconds longer while it backs up and updates the
   database. Settings → Updates shows the new version number.

You can update from any earlier version (0.2.6 included) straight to the newest one. From 0.3 on, installing an older
Setup over a newer ClaimDesk asks first ("ClaimDesk X is installed, which is newer than this setup …"; the default is
No); the 0.2.6 Setup installs without asking. Your data is kept either way.

## Where your data is

Everything you enter lives in `%LOCALAPPDATA%\ClaimDesk` (type that into the Explorer address bar):

| Folder or file | What it holds |
|---|---|
| `data\claimdesk.sqlite` | The database: claims, parties, vehicles, hires, ledger, events, settings, users |
| `data\evidence\`, `data\documents\`, `data\templates\` | Uploaded evidence, generated documents, your uploaded Word templates |
| `data\backups\` | The automatic database backups made before each update (the newest 5 are kept) |
| `demo\` | The example claims (kept apart from your data) |
| `claimdesk.env` | Optional settings (API keys and similar) |

The program itself is in `%LOCALAPPDATA%\Programs\ClaimDesk`. Updating replaces only the program; uninstalling
keeps your data unless you answer **Yes** to "Also delete your ClaimDesk data?" (the default is No).

## If something goes wrong

- **The backup is in `%LOCALAPPDATA%\ClaimDesk\data\backups`**, named
  `claimdesk-before-<version>-<date>-<time>.sqlite` — the database exactly as it was before that version first
  started.
- To go back to it: Start menu → **Stop ClaimDesk**; in `%LOCALAPPDATA%\ClaimDesk\data` rename `claimdesk.sqlite`
  (and `claimdesk.sqlite-wal` / `claimdesk.sqlite-shm` if they are there) to keep them aside; copy the backup file into
  the same folder and rename it to `claimdesk.sqlite`; start ClaimDesk.
- To go back to the previous version of the program: run its Setup (from the releases page). Setups from 0.3 onwards
  first ask "ClaimDesk X is installed, which is newer than this setup" — answer **Yes**; the 0.2.6 Setup installs
  without asking. Version 0.2.6 can open a database that 0.3 has updated.
- "Could not check for updates (no internet?)" in Settings → Updates only means the check could not reach GitHub;
  ClaimDesk works normally. You can always download the latest version from the releases page.
- Still stuck: keep the `backups` folder safe and contact the person who looks after your ClaimDesk set-up.

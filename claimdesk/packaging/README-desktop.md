# ClaimDesk for Windows — building, signing and testing the desktop app

ClaimDesk ships as a normal Windows program published by **Courtesy Cars Group UK Ltd**:

| File | What it is |
|---|---|
| `ClaimDesk-Setup-<ver>.exe` | Inno Setup installer. Per-user, no administrator rights, installs to `%LOCALAPPDATA%\Programs\ClaimDesk`, upgrades in place. |
| `ClaimDesk-Windows-x64-<ver>.zip` | The same folder without an installer (portable). |

Design reference: `docs/TEMPLATES-VEHICLES-DESKTOP.md` §G (desktop) and §H (company details).

## How the pieces fit

```
ClaimDesk.exe            Node single-executable app (packaging/sea-bootstrap.cjs embedded), with Windows file details
ClaimDesk-Background.exe the same file with the PE Subsystem byte patched 3 → 2 (GUI): runs without a console window
app/launch.cjs           the launcher (packaging/launch.cjs): data folder, claimdesk.env, server, app window, --stop,
                         background mode, autostart tasks, claimdesk:// links
app/autostart/*.xml      scheduled-task templates (packaging/autostart) filled in by --install-autostart
app/version.json         { version, commit, builtAt } written by build-package.mjs
app/apps/api, app/apps/web/dist, app/packages/*, app/node_modules   the program itself (plain files)
```

- **Version.** Root `package.json` holds `<major>.<minor>.<patch>` (0.2.0). CI sets `CLAIMDESK_VERSION` to
  `<major>.<minor>.<run number>` (e.g. 0.2.57) in its first step; `build-package.mjs` uses it (or package.json), writes
  `app/version.json` and stamps the exe. The launcher sets `CLAIMDESK_VERSION` from `version.json`; `GET /api/health`
  reports `version`, `dataset` (`live`/`demo`), `pid` and `lookups.mode`; the sign-in screen and the side bar show
  "ClaimDesk <version>".
- **Exe details** (`rcedit`): CompanyName and LegalCopyright "Courtesy Cars Group UK Ltd", ProductName ClaimDesk,
  FileDescription "ClaimDesk - Courtesy Cars Group UK Ltd", file version `<ver>.0`. Node's own signature is removed
  first (`signtool remove /s`, when the Windows SDK is present) because the edits invalidate it.
- **App window.** The launcher opens `http://localhost:4000` in Microsoft Edge (or Chrome) in app mode with its own
  profile (`<home>\window`, `<home>\window-demo`). Browser lookup order: `CLAIMDESK_BROWSER_PATH` → Edge under Program
  Files (x86) / Program Files / `%LOCALAPPDATA%` → Edge's App Paths registry entry → Chrome (same) → the default browser.
  It must stay in step with `packages/documents/src/render.ts` `installedBrowserCandidates()` (PDFs use the same
  browser). `CLAIMDESK_BROWSER=tab` uses an ordinary browser tab instead.
- **Stopping.** Closing the last ClaimDesk window stops the server (`CLAIMDESK_STOP_ON_CLOSE=0` keeps it running). A
  window process that exits within 8 s handed over to an already-open window, so it does not stop anything.
  `ClaimDesk.exe --stop` (Start menu → Stop ClaimDesk) reads the pid from `/api/health`, checks the dataset and ends it.
- **Example claims.** `--demo` uses port **4001**, data in `<home>\demo`, `CLAIMDESK_DATASET=demo`. The "already
  running" check compares the dataset, so the example-claims shortcut can never open live data.
- **Data** lives in `%LOCALAPPDATA%\ClaimDesk` (`data\`, `demo\`, `claimdesk.env`, `secret.key`, `window\`). Upgrades
  never touch it; uninstalling asks (default **No**), and a silent uninstall never deletes it.

## Background mode, autostart and the import folder (0.4 — docs/SUPREME-DESIGN.md §0.3, §M.1–M.2)

The agents need ClaimDesk running 24/7, so 0.4 runs the server in the background:

| Command | What it does |
|---|---|
| `ClaimDesk-Background.exe --background` | Supervisor. Exits at once if ClaimDesk already answers on the port or `<home>\run\background.lock` names a live process. Otherwise writes the lock, starts `--server-child` hidden, logs to `<home>\logs\claimdesk-YYYY-MM-DD.log` (14 days kept) and restarts the server after a crash (5 s, 10 s, 20 s … 5 min). More than 20 restarts in an hour → it stops and shows a message box. A server that stops answering (3 missed health checks a minute apart) is restarted. |
| `… --server-child` | The API in-process with `JOBS_ENABLED=true`, `CLAIMDESK_STOP_ON_CLOSE=0`. |
| `… --ensure` | Health probe; if nothing answers, starts `--background` detached. The Watchdog task runs this every 15 minutes. |
| `ClaimDesk.exe --install-autostart` / `--remove-autostart` | `schtasks /Create /XML` for **ClaimDesk\Background** (at sign-in, InteractiveToken so notifications show, IgnoreNew, no time limit, restart on failure every minute ×999, hidden, runs on battery) and **ClaimDesk\Watchdog** (every 15 minutes → `--ensure`). No administrator rights. If Windows refuses the `ClaimDesk\` task folder the tasks are created as "ClaimDesk Background" / "ClaimDesk Watchdog". |
| `ClaimDesk.exe --open claimdesk://needs-you/<id>` | Opens that page (`/needs-you/<id>`, `/outbox/<id>?undo=1`, …) — the handler for `claimdesk://` links. Unknown links open the home page. |
| `ClaimDesk.exe --stop` | Stops the background supervisor (from the lock file) and then the server. |

With autostart installed, the Start-menu ClaimDesk makes sure the background server runs and only opens the window;
closing the window never stops the server. Without it, 0.3 behaviour is unchanged. The installer ticks "Keep ClaimDesk
running in the background (needed for the agents)" by default; unticking it on an upgrade removes the tasks.

The launcher creates the **import folder** `<home>\inbox\{evidence,intake,mail,brain-packs,engineer-data}` and passes
`CLAIMDESK_HOME` and `CLAIMDESK_INBOX_DIR` to the server. A file dropped there is taken once its size has been stable
for 10 seconds, moved into `DATA_DIR\imports\<purpose>\<id>\` with a `manifest.json`, and listed under Settings →
Import folder. `inbox\evidence\<CCG-YYYY-NNNNN>\<file>` is added to that claim as evidence. The Start menu has a
"ClaimDesk import folder" shortcut.

**Upload limits** (environment, `claimdesk.env`): `MAX_EVIDENCE_UPLOAD_MB` (default 2048) for one evidence upload,
`CHUNK_THRESHOLD_MB` (64) above which the browser sends the file in parts, `CHUNK_MB` (8) per part. Every other upload
route keeps its own limit (25 MiB default, Word templates 15 MiB).

## Build it

On Windows 10/11 x64 with Node 22 and pnpm 10, from `claimdesk/`:

```powershell
pnpm install --config.node-linker=hoisted          # flat node_modules: the folder is shipped as plain files
pnpm --filter @ccguk/web build
pnpm install --prod --config.node-linker=hoisted   # drop development-only packages
$env:CLAIMDESK_VERSION = '0.2.0'                   # optional; defaults to package.json
node packaging/build-package.mjs                   # → packaging\dist\ClaimDesk\
iscc /Qp /DAppVersion=$env:CLAIMDESK_VERSION /DSourceDir=$PWD\packaging\dist\ClaimDesk /O$PWD\packaging\dist packaging\installer\ClaimDesk.iss
                                                   # → packaging\dist\ClaimDesk-Setup-<ver>.exe
```

- `build-package.mjs` fails when a feature's files are missing from the package: the 10 Word templates, the vehicle
  catalogue makes, `gta-segment-defaults.json`, `docx-preview` and `jszip` browser bundles, `fflate`,
  `@xmldom/xmldom`, `version.json`. For a local partial build only, `SKIP_FEATURE_ASSERTS=1` turns the catalogue and
  docx-preview/jszip checks into warnings. `--no-exe` assembles the folder without the executable.
- On Linux/macOS the script assembles the folder and, without `--no-exe`, builds a native single executable (no
  Windows file details); it refuses pnpm's linked `node_modules` layout, as on Windows.
- Inno Setup: `choco install innosetup` or https://jrsoftware.org/isdl.php. If ISCC rejects `packaging\icon.ico`
  (PNG-compressed small entries), rebuild it with ImageMagick:
  `magick convert apps\web\public\icons\icon-512.png -define icon:auto-resize=48,32,24,16 packaging\icon.ico`.
- **AppId `{322DAE75-FC0F-4786-B2BB-62E4A6A3D59B}` must never change**: upgrades find the installed copy by it.

## Updating

ClaimDesk updates in place: download the newest `ClaimDesk-Setup-<version>.exe` and run it over the installed copy.

- **Where to get it.** Settings → Updates shows the installed version and, when a newer one is out, a **Download
  ClaimDesk-Setup-<version>.exe** link (the check asks GitHub at most once an hour through the local API; it never
  blocks the app and says "Could not check for updates" when offline). The side bar shows "Update available: <version>"
  under the version number. Every Setup is also on https://github.com/dannykaleem07-commits/logo/releases.
- **What the Setup does.** Same AppId, so it finds the installed copy (`UsePreviousAppDir`), asks to close a running
  ClaimDesk, replaces the program folder (`%LOCALAPPDATA%\Programs\ClaimDesk\app`) wholesale and leaves the data folder
  (`%LOCALAPPDATA%\ClaimDesk`) alone. No administrator rights. Installing an *older* Setup over a newer copy asks first
  (default No); silent installs carry on.
- **First start of the new version.** If the database has migrations to apply, it is copied first to
  `%LOCALAPPDATA%\ClaimDesk\data\backups\claimdesk-before-<version>-<yyyyMMdd-HHmmss>.sqlite` (`VACUUM INTO`; the
  newest 5 are kept), then migrated. A failed backup is logged as a warning and the start carries on. Later starts find
  nothing to migrate and make no backup.
- **Going back.** Run the older Setup. Setups from 0.3 onwards ask first ("ClaimDesk X is installed, which is newer
  than this setup") — answer Yes; the 0.2.6 Setup has no such question and installs without asking. An older version can open a newer
  database (new columns are unused by it). To restore the data as it was before an upgrade: Start menu → Stop
  ClaimDesk, rename `data\claimdesk.sqlite` (and any `-wal` / `-shm` next to it), copy the backup file in its place as
  `claimdesk.sqlite`, start ClaimDesk.
- **Turning the check off.** `CLAIMDESK_UPDATE_CHECK=off` in `%LOCALAPPDATA%\ClaimDesk\claimdesk.env` (Settings →
  Updates then says checks are off). `CLAIMDESK_UPDATE_URL` points the check at another releases list (tests).
- **CI proves it.** The Windows workflow installs the real published 0.2.6 Setup (SHA-256 pinned), creates a fleet
  car, a claim and a hire, upgrades it in place to the new Setup and checks the data, the migrations, the backup file
  and a back-dated hire edit (step "Upgrade the published 0.2.6 install").

## Sign it (when a certificate exists)

Without a code-signing certificate Windows SmartScreen shows "Unknown publisher" / "Windows protected your PC" (More
info → Run anyway). To sign:

1. Get an OV/EV code-signing certificate in the name of Courtesy Cars Group UK Ltd (or use Azure Trusted Signing).
2. Add repository secrets `CODESIGN_PFX_BASE64` (the .pfx, base64) and `CODESIGN_PASSWORD`.
3. In `.github/workflows/claimdesk-windows.yml` remove `if: false` from the two signing steps ("Sign ClaimDesk.exe"
   before the installer is built, "Sign the installer" after it).
4. Optionally let ISCC sign the uninstaller too: uncomment `SignTool=claimdesk` and `SignedUninstaller=yes` in
   `packaging/installer/ClaimDesk.iss` and pass `/Sclaimdesk=...` to `iscc` (the command is in the .iss comments).

## Test it

Automated (any OS): `node --check packaging/launch.cjs` and `node packaging/launch.test.cjs` (browser lookup order,
window arguments, ports, stop-on-close rule, health parsing, `claimdesk.env` template; 0.4: restart backoff and the
20-an-hour limit, lock staleness, log names and rotation, the scheduled-task XML built from `packaging/autostart`,
`claimdesk://` link mapping).

CI (`claimdesk-windows.yml`, every push to the branch that touches `claimdesk/`):

1. Portable smoke test on port 4001: health `version`/`dataset`/`lookups.mode`, sign-in, example claims, an HTML letter
   to PDF, ≥ 10 Word templates, CCGUK-01 values → acknowledge → generate → `.docx` (starts with `PK`) → approve →
   PDF (`%PDF-`, converter `browser`), ≥ 60 catalogue makes, unknown registration → `manual_required` with a Total Car
   Check link, then `ClaimDesk.exe --stop --demo`.
2. Installed-app test: silent per-user install; registry `Publisher` and `DisplayVersion`; Start menu shortcuts; exe
   VersionInfo; the installed exe serves live data with the right version; a marker file survives an upgrade; `--stop`;
   silent uninstall removes the program folder and keeps the data.
3. Upgrade the published 0.2.6 install: the real `ClaimDesk-Setup-0.2.6.exe` (SHA-256 checked) installed silently,
   a fleet unit, a claim and a hire created, then the new Setup installed over it: version, data, hire pricing and
   corrections, manager mode, `data\backups\claimdesk-before-<version>-*.sqlite`, a back-dated hire start, and a
   silent uninstall that keeps the data.

4. (0.4) Private-data guard (no `*.cab`, `*.ccbrain`, `brain-packs/`, `engineer-data/`, `inbox/`, `secrets/`,
   `*.dpapi` tracked); big uploads on the portable build (100 MiB multipart and 300 MiB in parts after sign-in);
   background mode (`ClaimDesk-Background.exe --background` → health → the server process killed → healthy again
   within 30 s → `--ensure` → `--stop`); the PE Subsystem of `ClaimDesk-Background.exe` is 2; the installer creates
   both scheduled tasks and the uninstaller removes them; upgrade from the published 0.3.7 Setup (data kept, backup made,
   agents off); agent smoke with the fake AI driver (an `.eml` in `inbox\mail` → a Needs-you item).

By hand on a Windows 11 PC (not automatable on the runner):

- Start menu → ClaimDesk: the console starts minimised and ClaimDesk opens in its own window titled "ClaimDesk —
  Courtesy Cars UK" with the ClaimDesk taskbar icon.
- Start it again while open: the existing window is reused, nothing else starts.
- Close the window: within a few seconds `http://localhost:4000` stops answering. Start menu → Stop ClaimDesk does the
  same when the window was left open.
- ClaimDesk (example claims) opens on port 4001 with the example data while the live one is running.
- Settings → Apps → Installed apps lists ClaimDesk, publisher Courtesy Cars Group UK Ltd, with the version.
- Uninstall interactively: the "Also delete your ClaimDesk data?" question defaults to No.
- (0.4) Sign out and in again: ClaimDesk answers on `http://localhost:4000` without opening it; no console window
  appears. Task Scheduler shows ClaimDesk\Background and ClaimDesk\Watchdog. Close the window: the server keeps
  running. Click a `claimdesk://needs-you/…` link in a notification: ClaimDesk opens on that item.
- (0.4) Drop a large file into Start menu → ClaimDesk import folder → engineer-data: it appears under Settings →
  Import folder within about a minute.

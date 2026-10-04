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
app/launch.cjs           the launcher (packaging/launch.cjs): data folder, claimdesk.env, server, app window, --stop
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
window arguments, ports, stop-on-close rule, health parsing, `claimdesk.env` template).

CI (`claimdesk-windows.yml`, every push to the branch that touches `claimdesk/`):

1. Portable smoke test on port 4001: health `version`/`dataset`/`lookups.mode`, sign-in, example claims, an HTML letter
   to PDF, ≥ 10 Word templates, CCGUK-01 values → acknowledge → generate → `.docx` (starts with `PK`) → approve →
   PDF (`%PDF-`, converter `browser`), ≥ 60 catalogue makes, unknown registration → `manual_required` with a Total Car
   Check link, then `ClaimDesk.exe --stop --demo`.
2. Installed-app test: silent per-user install; registry `Publisher` and `DisplayVersion`; Start menu shortcuts; exe
   VersionInfo; the installed exe serves live data with the right version; a marker file survives an upgrade; `--stop`;
   silent uninstall removes the program folder and keeps the data.

By hand on a Windows 11 PC (not automatable on the runner):

- Start menu → ClaimDesk: the console starts minimised and ClaimDesk opens in its own window titled "ClaimDesk —
  Courtesy Cars UK" with the ClaimDesk taskbar icon.
- Start it again while open: the existing window is reused, nothing else starts.
- Close the window: within a few seconds `http://localhost:4000` stops answering. Start menu → Stop ClaimDesk does the
  same when the window was left open.
- ClaimDesk (example claims) opens on port 4001 with the example data while the live one is running.
- Settings → Apps → Installed apps lists ClaimDesk, publisher Courtesy Cars Group UK Ltd, with the version.
- Uninstall interactively: the "Also delete your ClaimDesk data?" question defaults to No.

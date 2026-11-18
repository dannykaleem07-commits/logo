# Engineer Report Studio

Windows desktop software for producing **engineering & accident damage assessment reports** in the CarFlex 13-section format, with an AI damage assessor built in.

It is original software. It has its own parts catalogue, codes and guide times. It contains no Audatex, Thatcham or manufacturer program code or data.

## What it does

| Area | Features |
|---|---|
| **Vehicle lookup** | **Look up registration** runs DVLA and DVSA MOT History together. Either works on its own.<br>• **DVLA (Vehicle Enquiry Service):** make, colour, fuel, engine size, first registration, tax and MOT status, CO₂, Euro status, export/scrapped markers, import/re-registration flag, last V5C.<br>• **DVSA MOT History:** model, every MOT test with mileage, advisories and defects, and the recall status. Lookup by VIN is supported. The history prints in the report. |
| **Exact variant picker** | 58 UK model generations across 15 makes (all verified against Parkers UK derivative lists and Wikipedia), with 668 engines and 940 trims, including the line-up for each period of a generation.<br>• Pick make → model/generation → engine → trim → body → gearbox, e.g. **"Mercedes-Benz E-Class (W213) E 220 d AMG Line Premium Plus Saloon 9G-Tronic"**, a trim of the 2016–2020 pre-facelift line-up.<br>• Line-ups sold in the car's registration year are listed first.<br>• The picker fills fuel, cc and engine code, and links the vehicle to the OEM numbers for the correct generation only. |
| **AI assessor** | Upload photos and the AI labels the damage on them (pixel-accurate boxes, accident-related vs pre-existing) and writes captions.<br>• It recommends estimate lines: renew, repair light/medium/heavy, PDR, refinish new part, refinish repaired part, blend, R&I, diagnostics, ADAS calibration, geometry. Each line cites the photos, the operation and whether the hours are the guide or adjusted.<br>• Its instructions encode the engineer's method: the least invasive repair that works, blend for metallic paint, never omit structural or SRS parts, ADAS only for systems fitted, independence of the expert.<br>• Case text and web content are passed to the AI as data, never as instructions. |
| **AI valuation tool** | The standard follows the claim type: the Financial Ombudsman Service approach for own-insurer total losses (retail value at the date of loss, starting from the **highest** recognised guide, never averaged, no blanket deductions); for third-party and court claims, the cost of a replacement vehicle.<br>• It checks mileage against the MOT history.<br>• It can **search UK listing sites for comparable adverts** near the date of loss. A comparable keeps its link only if the link really appeared in the search results; the rest are marked unverified.<br>• It returns a recommended PAV, a range, the workings and report-ready comments. |
| **AI report writer** | Drafts every narrative section for side-by-side review. AI-drafted text is tracked, so later AI runs never treat it as the assessor's own words. |
| **Repair operations** | • Renew + refinish new part.<br>• Repair light / medium / heavy (per-part guide repair hours) + refinish repaired part (<50% / >50%).<br>• Plastic repair, paintless dent repair (outer metal panels only), smart repair, refinish, **blend**, remove & refit, inspect, refurbish, and operations/services.<br>• Guide times scale by vehicle size class and paint finish. Paint materials are calculated from paint hours, with the paint factor applied once. Operations that make no sense are refused, e.g. "repairing" a lamp or painting a sensor. |
| **Engineer checks** | • Structural repairs with Category N.<br>• Structural-damage wording vs category (reads negations correctly).<br>• No AQP ID; accreditation expired at the signature date.<br>• EV/hybrid battery assessment.<br>• Each ADAS sensor without its own calibration.<br>• SRS work without a diagnostic scan.<br>• Metallic paint with no blend; paint labour with no materials.<br>• Renewed part at £0.<br>• **MOT mileage:** inspection mileage lower than a pre-loss MOT reading, readings going down, and **an MOT after the date of loss** (the vehicle was presented or used after the accident).<br>• Desktop-assessment photo coverage.<br>• CPR 35 requirements (examiner, qualifications, range of opinion).<br>• Adopted PAV below the highest guide without a stated reason.<br>• Researched part numbers with variants (confirm by VIN).<br>• A salvage category on a repairable vehicle.<br>• DVLA details from DVLA's test service, or a DVLA make that disagrees with the vehicle.<br>• Negative PAV or discount; invalid dates.<br>• Adverts found by AI search whose link has not been verified.<br>• Unreviewed AI lines, labels and **AI-drafted text still unedited**, and the AI's own review flags. |
| **Court-ready option** | Tick *CPR Part 35 report* to address the report to the court. This adds:<br>• the expert's duty statement and the statement of truth (with the contempt wording);<br>• who carried out the examination, and whether it was under the expert's supervision (PD 35 para 3.2(5));<br>• the **material relied on** (PD 35 para 3.2(2));<br>• the PD 35 checks. Any unreviewed AI output is an error in this mode, because the statement of truth cannot cover it. |
| **Finalise / re-open** | Finalising **locks the whole report**: every field, the estimate and the photos become read-only. It also freezes the company details, declaration, signature, qualifications, AQP ID, labour rates and VAT, so later Settings changes can't alter an issued report. *Re-open* unlocks it for editing. A duplicate starts as a fresh, unsigned draft. |
| **Backup and safety** | **Settings → Export full backup** streams every job, photo, setting and your own part numbers into one `.ersbackup` file, whatever the size. Restore reads it, and backups from earlier versions (`.json`), adding your own part numbers rather than replacing them.<br>• A save that fails (for example, a full disk) is shown at once with *Retry*; nothing is silently lost.<br>• Edits from two windows never overwrite each other unnoticed.<br>• If the window crashes or stops responding, the app offers to reload with your saved work. |
| **AI and data-use log** | Every AI and data-service action is logged. The report includes a "Use of AI and data tools" statement, as the Civil Justice Council recommended in October 2026. It states accurately whether every AI output was reviewed, and names any AI-drafted text still unedited. |
| **Report** | A 13-section A4 PDF with running header and footer and "Page n of N". It includes:<br>• the valuation chart;<br>• the estimate (with discount);<br>• the cost summary;<br>• labelled photos (AI and pre-existing damage marked);<br>• DVLA/DVSA status and MOT history;<br>• the signed declaration. |

## Data connections

Open **Settings → Data connections**.

1. **DVLA Vehicle Enquiry Service:** paste the API key from your DVLA email and save it.
   - Set *DVLA service* to **Test** if DVLA gave you a test key. Test keys only work on DVLA's test service, with test registrations such as `AA19AAA`. Details from the test service are marked as such, and the pre-issue checks stop them reaching a report.
   - Use **Test DVLA** to check it.
2. **DVSA MOT History** (free): register on gov.uk. Copy into the matching fields the **Client ID**, **Client secret**, **API key**, **Token URL** (`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`) and **Scope URL** (`https://tapi.dvsa.gov.uk/.default`). They are all in DVSA's "Here are your credentials" email.
   - Use **Test MOT History** to check it.
   - Client secrets expire every 2 years, and DVSA revokes API keys unused for 90 days.
3. Keys are encrypted on the PC (Windows DPAPI). They are never saved in jobs, backups or reports, and they never reach the app's screens.

`estimator/LICENSING.md` lists the paid data sources and the enquiry text for each: exact derivative by VIN, write-off history, guide valuations, manufacturer parts and recognised labour times.

## Getting the Windows .exe

GitHub Actions builds it whenever `estimator/` changes (workflow: `.github/workflows/build-estimator.yml`). Every test runs first, including a full UI smoke test in Chromium and an end-to-end test of the real app in Electron on Windows.

1. Open the repository on GitHub, then **Actions → Build Engineer Report Studio (Windows)**.
2. Open the latest green run and download the **Engineer-Report-Studio-Windows** artifact.
3. It contains:
   - `engineer-report-studio-Setup-1.0.0.exe`, the installer;
   - `engineer-report-studio-1.0.0-portable.exe`, which runs without installing.

The exe is not code-signed, so Windows SmartScreen will warn on first run: choose *More info → Run anyway*. To sign it, add two repository secrets on GitHub (*Settings → Secrets and variables → Actions*): `CSC_LINK`, the base64-encoded .pfx certificate (or an https link to it), and `CSC_KEY_PASSWORD`, its password. The workflow passes them to electron-builder, which signs with SHA-256 and an RFC 3161 timestamp. Without them the build is unsigned. To sign a local build, set the same two environment variables.

To build it on a Windows PC yourself:

```
cd estimator
npm install
npm run dist:win
```

To run it without building: `npm install` then `npm start`.

## Turning on the AI

1. Create an API key at console.anthropic.com.
2. In the app, go to **Settings → AI assessor**, paste the key and click **Save key**, then **Test connection**.

The key is encrypted with Windows' own credential protection and is only ever used from the app's background process. That process uses Windows' own network settings (proxy and certificates). Photos and claim details are sent to Anthropic only when you press an AI button. Make sure your privacy notices to clients cover this.

The default model is `claude-opus-5-5` at "High" thoroughness. You can change both in Settings.

**AI output is a draft.**
- Every AI estimate line is marked *AI suggested* until you tick it as reviewed.
- Every field the AI filled in shows *✓ Confirm* until you edit or confirm it, including drop-downs such as the decision and the salvage category.
- AI photo labels count as unreviewed until you open and save them in the labelling tool.
- The pre-issue checks warn about anything unreviewed, PDF export asks for confirmation, and the report states it.
- The signed report is the assessor's opinion.

## Parts catalogue and OEM part numbers

- **Master catalogue:** `app/data/catalogue.js` holds 212 parts across 23 groups. They use this software's own codes (e.g. `DR001` front door shell), with guide renew, refinish and medium-repair hours, material and LH/RH handling. These guide values are this software's own, not manufacturer or Thatcham times. You can edit them on every line, and the report says where they come from.
- **Researched OEM numbers:** `research/*.json` holds **657 OEM part numbers for 23 popular UK vehicles**:
  - BMW 3 Series G20/G21
  - Ford Fiesta Mk7 and Mk8, Focus Mk3 and Mk4
  - Kia Sportage QL
  - Mercedes-Benz A-Class W177, C-Class W205 and E-Class W213
  - Nissan Juke F15 and F16, Qashqai J11 and J12
  - Skoda Octavia Mk3
  - Tesla Model 3
  - Toyota C-HR and Corolla E210
  - Vauxhall Astra K, Corsa E and Corsa F
  - VW Golf Mk7 and Mk8, Polo 6R/6C

  Each number has:
  - its source URL;
  - a confidence level: *confirmed* means two independent sources or the manufacturer's own UK parts shop; *single-source* means verify it;
  - where relevant, the market (UK / LHD / US), whether the number is variant-specific, and pre-facelift or facelift fitment.

  The numbers come from public listings found by web search: manufacturer UK shops, dealers, UK eBay listings, breakers and retailers. Parts-catalogue (EPC) mirror sites were not used. An independent check of a sample of 57 new numbers supported 50, found none contradicted, and could not decide 7; those were corrected, downgraded or removed.
- **What fills in automatically:** only *confirmed* numbers that are not variant-specific (155 of the 657). Single-source and variant-specific numbers (by colour, camera, sensors, lamp type, trim or facelift) are offered in the picker with their badges, for you to choose by VIN.
- **Prices are ex VAT.** Researched shop prices include VAT, so the build divides them by 1.2 and keeps the shop price for display. VAT is added once, on the estimate.
- **Build commands:** `npm run build:oem` compiles the research into `app/data/oem.js`, and `npm run build:variants` compiles `research/variants/*.json`. Both refuse invalid data, and `npm test` fails if either compiled file is out of date.
- **Your own numbers:**
  - Add them in **Parts catalogue → + Part number**, or import a CSV with the columns `code,side,oem,description,price`. The header row is optional, the price is **£ ex VAT**, and `side` is `L`, `R` or blank.
  - Add new vehicles with **+ Vehicle**.
  - Your numbers show a *your number* badge and fill in automatically only if you tick *auto-fill*.
  - You can edit or delete them in the parts catalogue, and importing the same CSV twice does not duplicate them.

**Coverage is partial, and every number must be checked by VIN.** Each vehicle has a different mix of parts (lamps, bumpers, grilles, wings, mirrors and mouldings are the best covered; doors, glass and cooling parts the least), and many numbers depend on facelift, trim or options. Confirm every number against the VIN with a dealer parts counter before ordering or quoting it in a report. Comprehensive OEM data for every vehicle needs a licensed parts data feed; the catalogue structure is ready to import one (see LICENSING.md).

## Tests

```
npm test                    # reference-report totals; 586 core checks (incl. storage upgrade, conflicts,
                            # quota errors and unsafe keys on an in-memory IndexedDB); 3,000-job fuzz test; 229 report checks;
                            # AI photo/narrative/valuation pipeline and DVLA/MOT connectors against mocked APIs
                            # (response shapes from the official specs); the desktop shell under a fake Electron;
                            # OEM and variant data in sync and reachable from the variant picker
node tools/ui-smoketest.js  # every screen and flow in Chromium with the desktop bridge mocked (99 checks,
                            # including keyboard-only use and accessible names)
npm run test:e2e            # the real app in real Electron (57 checks): bridge, key encryption, DVLA/MOT/AI calls
                            # through Windows networking (mocked servers), PDF export, streaming backup,
                            # crash/hang recovery, atomic saves, navigation and frame locks, second launch
                            # (on Linux: xvfb-run -a npx electron --no-sandbox tools/electron-e2e.js)
```

`npm test` also runs a fake-Electron proof of the desktop shell (`tools/main-mocktest.js`): IPC sender checks, key-file failures, save-dialog sanitising and PDF temp files. GitHub Actions runs all of these, on Linux and on Windows, before it builds the exe.

## Files

```
estimator/
  main.js, preload.js   Electron desktop shell (IPC with sender checks, encrypted key storage, PDF export)
  ai.js                 AI assessor, report writer and valuation tool (Anthropic SDK, vision, web search, structured JSON)
  vehicledata.js        DVLA Vehicle Enquiry Service + DVSA MOT History connectors
  app/                  The application (HTML/CSS/JS; also opens in a browser without the AI and lookup features)
    data/catalogue.js   Master parts catalogue (our own codes, guide times, materials)
    data/oem.js         Compiled OEM part numbers (generated)
    data/variants.js    Compiled UK variant line-ups (generated)
    js/core.js          Data model, calculations, VIN decoding, engineer checks
    js/report.js        Report renderer
    js/labeler.js       Photo labelling tool
    js/diagram.js       Damage-zone diagram
    js/app.js           Screens and workflow
  research/             Source research for OEM numbers and variants, with URLs and confidence
  tools/                Build scripts and tests (tools/tests, tools/ui)
```

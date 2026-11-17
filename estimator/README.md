# Engineer Report Studio

Windows desktop software for producing **engineering & accident damage assessment reports** in the CarFlex report format, with an AI damage assessor built in.

It is original software. It has its own parts catalogue, codes and guide times. It contains no Audatex, Thatcham or manufacturer program code or data.

## What it does

| Area | Features |
|---|---|
| **AI assessor** | Upload inspection photos and press **✦ AI assess & label photos**. The AI (Claude, Anthropic's vision model): <br>• draws labelled boxes on each damaged area (scoring, dents, cracks, deflated tyres and so on) <br>• writes the report title and caption for each photo <br>• identifies the impact type and direction, and whether the damage is consistent with the reported circumstances <br>• flags any structural concern, mechanical checks and ADAS calibration <br>• **recommends estimate lines** (replace / repair / refinish / strip & refit / diagnostics / geometry / wheels / tyres) from the parts catalogue, citing the photos as evidence |
| **AI report writer** | **✦ AI draft all narrative** writes every narrative section: summary, structural, mechanical, wheels, geometry, diagnostics, roadworthiness, estimate notes, valuation comments and engineer's opinion. It works from your photos, estimate and figures and quotes the exact totals and percentages. You compare each section side by side and apply only what you accept. |
| **Labelling tool** | Draw, move, resize, recolour and caption boxes on any photo. AI labels can be edited the same way. The labels are printed on the photos in the report. |
| **Estimate builder** | Search 212 catalogue parts by name, group, damage zone and side. Choose an operation: replace, repair, refinish, remove & refit, inspect or refurbish. <br>• Guide hours and refinish lines are added automatically. <br>• OEM part numbers and prices fill in when the vehicle is in the catalogue. <br>• 18 one-click labour-only operations. <br>• Labour rates per type, discount and VAT. |
| **Damage diagram** | Click the zones on a top-view car diagram. They feed the report and filter the parts picker. |
| **Valuation** | Any number of valuation sources with a comparison chart. Adopt the highest, average or lowest. Salvage % or an actual bid. Repair-to-PAV % net and gross, with a total-loss threshold warning. Category N / S selection. |
| **Pre-issue checks** | Flags a missing VIN or date of loss, an inspection dated before the loss, a VIN that doesn't match the make, AI lines not yet reviewed, a decision that contradicts the repair/PAV threshold, a category that contradicts the structural text, a missing signature, and more. |
| **Report** | A 13-section A4 PDF matching the CarFlex layout. It has your logo, header and footer on every page, "Page X of Y", the valuation chart, the estimate table, the cost summary, labelled photos and the signed declaration. |
| **Data** | Jobs are saved automatically on the PC. You can export or import single jobs and take full backups. |

## Getting the Windows .exe

GitHub Actions builds it every time `estimator/` changes (workflow: `.github/workflows/build-estimator.yml`).

1. Open the repository on GitHub, then **Actions → Build Engineer Report Studio (Windows)**.
2. Open the latest run and download the **Engineer-Report-Studio-Windows** artifact.
3. It contains:
   - `Engineer Report Studio-Setup-1.0.0.exe`, the installer;
   - `Engineer Report Studio-1.0.0-portable.exe`, which runs without installing.

The exe is not code-signed, so Windows SmartScreen will warn on first run: choose *More info → Run anyway*.

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

The key is encrypted with Windows' own credential protection, and it is only ever used from the app's background process. Photos and claim details are sent to Anthropic only when you press an AI button. Make sure your privacy notices to clients cover this.

The default model is `claude-opus-5-5` at "High" thoroughness. You can change both in Settings.

**AI output is a draft.** Every AI estimate line is marked *AI suggested* until you tick it as reviewed, and the pre-issue checks warn about any unreviewed line. The signed report is the assessor's opinion.

## Parts catalogue and OEM part numbers

- `app/data/catalogue.js` holds 212 master parts across 23 groups. They use this software's own codes (e.g. `DR001` front door shell, `MR001` door mirror assembly), with guide replace and refinish hours and LH/RH handling. The guide times are starting points and can be edited on every line.
- `research/*.json` holds the researched **OEM part numbers**: 111 numbers across 8 popular UK vehicles (Nissan Juke F15 and Qashqai J11, Ford Fiesta Mk7 and Focus Mk3, VW Golf Mk7 and Polo 6R, Vauxhall Corsa E and Astra K). Each one has its source URL, a confidence level (*confirmed* = two or more sources or an official listing, *single-source* = verify) and notes on variants.
- Run `npm run build:oem` to compile the research files into `app/data/oem.js`.
- Add your own numbers in **Parts catalogue → + Part number**, or import a CSV with the columns `code,side,oem,description,price`. Add new vehicles with **+ Vehicle**.

**Coverage is partial, and the numbers must be checked by VIN.** The research could only read search-engine results, because direct access to the parts-catalogue websites was blocked from the build environment. Large panels, doors, glass and cooling parts are mostly missing, and some numbers depend on facelift, trim or options. Confirm every number against the VIN with a dealer parts counter before ordering or quoting it in a report. Comprehensive OEM data for every vehicle requires a licensed parts data feed. The catalogue structure is ready to import one.

## Tests

```
npm test                    # sample job reproduces the reference report: £3,365.08 net, £4,038.10 gross, 59.22% / 71.07%
node tools/ai-mocktest.js   # AI request/response pipeline against a mocked API (no key needed)
```

## Files

```
estimator/
  main.js, preload.js   Electron desktop shell (PDF export, encrypted key storage)
  ai.js                 AI assessor and report writer (Anthropic SDK, vision + structured JSON output)
  app/                  The application (HTML/CSS/JS; also opens in a browser without the AI features)
    data/catalogue.js   Master parts catalogue (our own codes and guide times)
    data/oem.js         Compiled OEM part numbers (generated)
    js/core.js          Data model, calculations, VIN decoding, checks
    js/report.js        Report renderer
    js/labeler.js       Photo labelling tool
    js/diagram.js       Damage-zone diagram
    js/app.js           Screens and workflow
  research/             Source research for OEM numbers, with URLs and confidence
  tools/                OEM build script and tests
```

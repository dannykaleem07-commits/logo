# Engineer Report Studio

Windows desktop software for producing **engineering & accident damage assessment reports** in the CarFlex report format, with an AI damage assessor built in.

It is original software. It has its own parts catalogue, codes and guide times. It contains no Audatex, Thatcham or manufacturer program code or data.

## What it does

| Area | Features |
|---|---|
| **Vehicle lookup** | **DVLA lookup**: enter the registration and get make, colour, fuel, engine size, first registration, tax and MOT status, CO₂, Euro status, export marker and last V5C date. **MOT history**: every DVSA test with its mileage and advisories; the history prints in the report. |
| **Exact variant picker** | 58 model generations, 553 engines/badges and 543 trims across 13 makes. Pick make → model/generation → engine → trim → body → gearbox and you get, for example, **"Mercedes-Benz E-Class (W213) E 220 d AMG Line Premium Plus Saloon 9G-Tronic"**. The models sold in the car's registration year are listed first. The picker also fills fuel, cc and engine code and links the vehicle to its OEM part numbers (only the correct generation, so a W214 never picks up W213 numbers). |
| **AI assessor** | Upload photos and the AI labels the damage on them, writes captions and recommends estimate lines (renew / repair light-medium-heavy / PDR / refinish new part / refinish repaired part / blend / R&I / diagnostics / ADAS calibration / geometry), citing the photos. Its instructions encode the engineer's method: the least invasive repair that works, blend for metallic paint, never omit structural or SRS parts, ADAS triggers, independence of the expert. |
| **AI valuation tool** | Follows the Financial Ombudsman Service approach: retail value at the date of loss, starting from the **highest** guide (never averaged), with deductions only on evidence about that vehicle and mileage checked against the MOT history. It can **search the web for comparable UK adverts** and returns a recommended PAV, a range, the workings, the comparables with links, and report-ready comments. |
| **AI report writer** | Drafts every narrative section for side-by-side review. |
| **Repair operations** | Renew + refinish new part · Repair light / medium / heavy + refinish repaired part (<50% / >50%) · Paintless dent repair · Smart repair · Refinish · **Blend** · Remove & refit · Inspect · Refurbish. Guide times scale by vehicle size class and paint finish (solid / metallic / pearl / 3-stage / matt). Paint materials are calculated from paint hours. Mechanical parts can't be "repaired" or painted. |
| **Engineer checks** | • Structural parts in the estimate with Category N selected • no AQP ID • expired accreditation • EV/hybrid battery assessment • ADAS work without a calibration line • SRS work without a diagnostic scan • metallic paint with no blend • paint labour with no materials • **mileage lower than a previous MOT reading** • image-only assessment coverage (VIN plate, odometer, 8+ photos) • CPR 35 requirements • adopted PAV below the highest guide • unreviewed AI lines |
| **Court-ready option** | Tick *CPR Part 35 report* to add the expert's duty statement and the statement of truth (including the contempt wording) and to switch on the PD 35 checks. Add your qualifications, AQP ID and a conflict-of-interest declaration. |
| **AI-use log** | Every AI and data-service action is logged, and the report includes a "Use of AI and data tools" statement (as the Civil Justice Council recommended in October 2026). |
| **Labelling tool, estimate builder, damage diagram, valuation chart, PDF** | As before. |

## Data connections

1. **DVLA:** Settings → Data connections → paste your DVLA Vehicle Enquiry Service key → Save.
2. **MOT history (free):** register for the DVSA MOT History API on gov.uk. You'll get a client ID, client secret, API key and tenant ID; paste all four into Settings → Data connections.
3. Keys are encrypted on the PC and never saved in jobs or backups.

`estimator/LICENSING.md` lists the paid data sources and the enquiry text for each (exact derivative by VIN, write-off history, guide valuations, manufacturer parts and recognised labour times).

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
- `research/*.json` holds the researched **OEM part numbers**: 157 numbers across 9 popular UK vehicles (Mercedes-Benz E-Class W213, Nissan Juke F15 and Qashqai J11, Ford Fiesta Mk7 and Focus Mk3, VW Golf Mk7 and Polo 6R, Vauxhall Corsa E and Astra K).
- `research/variants/*.json` holds the variant line-ups. Run `npm run build:variants` to compile them into `app/data/variants.js`. Each model is marked *verified* (the core line-up was confirmed from UK sources) or *general knowledge*, with notes on any conflicts. Each one has its source URL, a confidence level (*confirmed* = two or more sources or an official listing, *single-source* = verify) and notes on variants.
- Run `npm run build:oem` to compile the research files into `app/data/oem.js`.
- Add your own numbers in **Parts catalogue → + Part number**, or import a CSV with the columns `code,side,oem,description,price`. Add new vehicles with **+ Vehicle**.

**Coverage is partial, and the numbers must be checked by VIN.** The research could only read search-engine results, because direct access to the parts-catalogue websites was blocked from the build environment. Large panels, doors, glass and cooling parts are mostly missing, and some numbers depend on facelift, trim or options. Confirm every number against the VIN with a dealer parts counter before ordering or quoting it in a report. Comprehensive OEM data for every vehicle requires a licensed parts data feed. The catalogue structure is ready to import one.

## Tests

```
npm test   # reference-report totals, catalogue/variant integrity, generation-safe OEM matching,
           # AI photo/narrative/valuation requests (mocked), DVLA + MOT History connectors (mocked)
```

## Files

```
estimator/
  main.js, preload.js   Electron desktop shell (PDF export, encrypted key storage)
  ai.js                 AI assessor, report writer and valuation tool (Anthropic SDK, vision, web search, structured JSON)
  vehicledata.js        DVLA Vehicle Enquiry Service + DVSA MOT History connectors
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

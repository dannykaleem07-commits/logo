# ClaimDesk — CCGUK Word templates, vehicle catalogue, manual vehicle search, fleet GTA pre-fill and the Windows desktop app

Design document (architect phase). Status: **agreed contract for the implementation slices in §J**. Date: 4 October 2026.

This document is the single source of truth for the build. Every slice brief points back to a section here. Where a
slice brief and this document disagree, this document wins; raise the conflict with the integrator.

Ground rules carried over from `docs/ARCHITECTURE.md` and the existing code (non-negotiable):

- TypeScript strict. NodeNext module resolution with `.js` suffixes on relative imports everywhere except `apps/web`
  (Bundler). Tests are vitest. No new runtime dependency without a line in this document (§0.3).
- Money is integer pence (`Pence`). Dates are stored as ISO strings in UTC and printed in `Europe/London`.
- Verification status is data. Code never upgrades it. A value typed or pasted by hand is `unverified`. A GTA rate is
  `verified` only when a person sets it with a source URL; the server stamps `verifiedBy`/`verifiedAt` from the session.
- GTA rates are an **industry benchmark only**. CCGUK is **not** a GTA subscriber. Every screen or document that shows a
  GTA group or rate carries that caveat (`GTA_NON_SUBSCRIBER_NOTE` / `GTA_RATES_BENCHMARK_NOTE`).
- ClaimDesk never scrapes a third-party website (convention 10). Total Car Check is opened in the user's own browser and
  the user copies the details back.
- No legacy company details (convention 9). Copy guards in `apps/web/src/screens/copyGuard.test.ts` and the document
  guards (`findBlockedStrings`, domain `legacyCheck`) stay green.
- The user's ten Word files are legal documents. **The engine fills blanks; it never rewrites printed wording.**

---

## 0. Overview

### 0.1 What the user asked for, and where it is designed

| # | Request | Design |
|---|---|---|
| 1 | Publisher "Courtesy Cars Group UK" and a proper installable Windows app | §G (installer, exe metadata, app window, CI), §H (company details) |
| 2 | Vehicle search must work in manual mode (no DVLA/DVSA keys) | §E |
| 3 | A button that opens Total Car Check for the registration | §E.2 (deep link) and §E.3 (paste parser) |
| 4 | Dropdowns of every make, model, trim, doors, features, extras | §D (catalogue data, API, `VehiclePicker`) |
| 5 | Fleet: pick make + model + reg and the GTA rate is already there | §F |
| 6 | Letter/document generation from the 10 Word templates, filled from the claim; add more templates later | §A (engine), §B (fields and mappings), §C (library, API, UI) |

### 0.2 Key decisions

| Decision | Choice | Why |
|---|---|---|
| Fill approach | Scan the .docx into **slots** (labelled blanks found by structure) and fill them in place in the XML. No pre-tokenising of the user's files. | The ten files have no merge fields, content controls or bookmarks. Their blanks are label cells, underscore/space patterns, `[brackets]` and `☐` glyphs. Filling in place keeps the formatting byte-for-byte outside the touched runs. Uploaded templates may also use `{{tokens}}`, content controls or MERGEFIELDs; the same scanner finds those. |
| Slot identity | Deterministic, section-aware ids: `section/@qualifier/label#n:sub=option` (§A.6) | "Registration" under *Replacement vehicle* must differ from the damaged vehicle's. Ids survive re-scans of the same file and mostly survive edits to unrelated parts. |
| Mapping storage | Built-in mappings are JSON data in `packages/documents/src/docx/fields/builtin/*.mapping.json`, written with **selectors** (section/qualifier/label/nth) resolved against the scan. Uploaded templates store exact slot ids in SQLite. | Data, not code; reviewable; robust to small template edits. |
| Where values come from | A pure resolver over a `MergeSource` object (§B.2) that the API builds from the claim bundle and repos | Pure → unit-testable without a DB; one data path for preview and generation. |
| Separate registry | DOCX templates do **not** go into the HTML template registry (`registerTemplate`). They live in the `document_templates` table plus a built-in list. | The HTML registry tests (`all-templates.test.ts`, `registry.test.ts`) require baseLayout markers and would fail. |
| Template ids | `<kind>.ccguk_NN_<name>` for built-ins (e.g. `agreement.ccguk_03_credit_hire`), `<kind>.user_<slug>_<4hex>` for uploads | Existing behaviour keys on id prefixes (`agreement.` e-sign checks, web `canSign`, `defaultRecipientRole`). Equivalences to the HTML ids are explicit (§C.8). |
| DOCX → PDF on the user's PC | Chain: **Microsoft Word (PowerShell COM)** → **LibreOffice** → **docx-preview in the headless Edge/Chromium the app already uses**. Default `auto`. | Word is exact (pagination, fonts, PAGE x OF y). LibreOffice is close. The browser path always works and was prototyped here (§A.11.5). |
| Zip / XML libraries | `fflate` (zip) and `@xmldom/xmldom` (DOM parse/serialise) in `@ccguk/documents`; `docx-preview` + `jszip` for the browser converter and the web preview | Pure JS, small, MIT/Apache, no native code, no network. |
| Catalogue | Bundled JSON per make in `packages/kb/data/vehicle-catalogue/makes/<slug>.json` (schema §D.2), loaded lazily; user additions in SQLite | Offline, upgrade-safe split between shipped data and user data. |
| GTA rates | KB file stays the base; a `gta_rates` table holds manual rows that override or hide KB rows per (group, period); one merge function feeds every caller | User-editable without touching the app folder (replaced on upgrade). |
| Desktop | Inno Setup per-user installer (no admin), fixed AppId, `AppPublisher=Courtesy Cars Group UK Ltd`; portable zip kept; Edge `--app` window; console started minimised | Matches what a small office expects from "an app"; CI already has ISCC. |
| Company details | Real details in `brand.ts` constants and `DEFAULT_SETTINGS.registeredOffice`; bank details stay a Settings input (§H) | The user gave office, phones, email, web; not bank/VAT/ICO (see §L). |

### 0.3 New dependencies (all from the npm registry; lockfile must be regenerated)

| Package | Where | Version | Licence | Use |
|---|---|---|---|---|
| `fflate` | `packages/documents` | `^0.8.3` | MIT | unzip/zip with size inspection before inflate (zip-bomb guard) |
| `@xmldom/xmldom` | `packages/documents` | `^0.9.12` | MIT | parse/serialise WordprocessingML |
| `docx-preview` | `packages/documents`, `apps/web` | `^0.4.1` | Apache-2.0 | browser PDF converter; in-app preview of .docx |
| `jszip` | `packages/documents`, `apps/web` | `^3.10.2` | MIT (dual) | peer of docx-preview |

No other runtime dependency is added. `@meterapp/vehicle-db` is **not** a dependency; it may be used once, offline, as a
coverage reference for the catalogue data (§D.4).

### 0.4 Repository map of new and changed areas

```
packages/documents/src/docx/           NEW  engine: zip, xml, scan, fill, text, props, convert/*   (slice docx-engine)
packages/documents/src/docx/fields/    NEW  dictionary, resolvers, mappings, letterhead compose     (slice docx-fields)
packages/documents/src/letterContent.ts NEW HTML letter → LetterContent                            (slice templates-api)
packages/documents/src/{brand,layout,common}.ts  company details + letterhead-style HTML header      (slice desktop-branding)
packages/documents/src/render.ts       PDF metadata stamping                                        (slice docx-engine)
packages/domain/src/vehicle/{external,parseCheckText}.ts  TCC link, paste parser                     (slice vehicles-backend)
packages/domain/src/gta/{suggest,merge}.ts  GTA suggestion, KB+manual merge                         (slice vehicles-backend)
packages/domain/src/templateIds.ts     canonical template ids                                       (slice templates-api)
packages/kb/data/vehicle-catalogue/**  catalogue data                                               (slice vehicle-catalogue-data)
packages/kb/src/catalogue/*            catalogue loader/query                                       (slice vehicles-backend)
packages/db/drizzle/0003_*, 0004_*     migrations                                                   (vehicles-backend, templates-api)
apps/api/src/routes/{catalogue,gtaRates,docxTemplates}.ts  new routes
apps/web/src/screens/{templates,vehicles,gta}/  new screens/components
packaging/installer/ClaimDesk.iss      installer                                                    (slice desktop-branding)
```

---

## A. DOCX template engine (`packages/documents/src/docx/`)

### A.1 Files

```
packages/documents/src/docx/
  index.ts            public surface (re-exported from packages/documents/src/index.ts)
  types.ts            all engine types (DocxSlot, SlotValue, FillInstruction, LetterContent, …)
  zip.ts              openDocx / writeDocx (fflate) + safety limits
  xml.ts              parse/serialise (@xmldom/xmldom), namespace helpers, run/paragraph utilities
  text.ts             normalise(), slugify(), paragraph text model with run map
  patterns.ts         blank / bracket / token / checkbox regexes and classifiers
  context.ts          structure walk: sections (headings), tables, header rows, cell headings, blocks
  scan.ts             scanDocx(): slots, blocks, outline, warnings, plain text
  fill.ts             fillDocx(): apply FillInstruction[] in place
  props.ts            core.xml / app.xml (creator, lastModifiedBy, title, keywords, dates)
  preview.ts          docxToPlainText(), docxToPreviewHtml(), extractHeaderFooter()
  safety.ts           checkDocxSafety() (upload gate) — shares limits with zip.ts
  convert/
    index.ts          convertDocxToPdf(), detectDocxConverters()
    word.ts           Microsoft Word via PowerShell COM
    libreoffice.ts    soffice --headless --convert-to pdf
    browser.ts        docx-preview in headless Edge/Chromium + CSS page margin boxes
    process.ts        spawn with timeout + kill helper (shared)
  pdfmeta.ts          stampPdfMetadata() (pdf-lib), also used by render.ts
  cli.ts              `pnpm --filter @ccguk/documents docx:scan <file>` outline/slot dump
  samples.ts          `pnpm --filter @ccguk/documents docx:samples` (scan + fill + convert the 10 files to out/docx)
  __fixtures__/       tiny synthetic .docx builders for unit tests (built in-test with fflate; no binary fixtures
                      except the 10 real assets, which tests read from ../../assets/docx)
```

### A.2 Package model and XML handling

```ts
// types.ts
export interface DocxPackage {
  /** Every zip entry, in original order. XML parts are kept as bytes until first parsed. */
  entries: Map<string, Uint8Array>;
  order: string[];
  /** Parsed DOM cache (part name → Document); written back by writeDocx. */
  dom: Map<string, Document>;
}
export function openDocx(bytes: Uint8Array, limits?: Partial<DocxLimits>): DocxPackage;          // zip.ts
export function writeDocx(pkg: DocxPackage, opts?: { mtime?: Date }): Uint8Array;                  // zip.ts
export function partDom(pkg: DocxPackage, part: string): Document;                                 // xml.ts
export function listParts(pkg: DocxPackage, re: RegExp): string[];                                 // e.g. /^word\/(header|footer)\d+\.xml$/
```

Rules:

- Parse with `new DOMParser({ onError })` from `@xmldom/xmldom`; any `error`/`fatalError` → `DocxError('INVALID_XML', part)`.
- Before parsing, refuse any XML part whose text contains `<!DOCTYPE` or `<!ENTITY` (`DocxError('XML_DTD_REFUSED')`).
- Serialise with `XMLSerializer`; keep the original XML declaration `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`.
- Only parts that were touched are re-serialised; untouched entries are written back byte-identical.
- `writeDocx` writes entries in the original order (`[Content_Types].xml` first), deflate level 6, and a fixed `mtime`
  (the document creation time) so the same inputs give the same bytes (deterministic sha256 in tests).
- Values are inserted as DOM text nodes, never by string concatenation, so `& < > " '` are escaped by the serialiser.
  Text containing XML-illegal control characters (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F) is stripped first.
- Every new `<w:t>` gets `xml:space="preserve"`.

### A.3 Safety limits (`safety.ts`, `zip.ts`)

```ts
export interface DocxLimits {
  maxCompressedBytes: number;     // 15 MiB (upload route limit)
  maxEntries: number;             // 1000
  maxTotalUncompressed: number;   // 60 MiB
  maxEntryUncompressed: number;   // 30 MiB
  maxRatio: number;               // 100 (only checked for entries whose uncompressed size > 1 MiB)
  maxParagraphs: number;          // 50 000 (scan guard)
}
export const DEFAULT_DOCX_LIMITS: DocxLimits;
export interface DocxSafetyReport { ok: boolean; errors: DocxIssue[]; warnings: DocxIssue[] }
export function checkDocxSafety(bytes: Uint8Array, limits?: Partial<DocxLimits>): DocxSafetyReport;
```

`openDocx` uses `fflate.unzipSync(bytes, { filter })`; the filter sees `originalSize` and `size` **before** inflating and
throws on any limit breach. Refusals (`errors`): not a zip (`PK\x03\x04` magic), entry name with `..`, leading `/`,
backslash or NUL, duplicate names, missing `[Content_Types].xml` or `word/document.xml`, main part content type not one of
`…wordprocessingml.document.main+xml` / `…wordprocessingml.template.main+xml` (a `.docm`/`.dotm` macro-enabled main part is
refused), any `word/vbaProject.bin`, any `activeX` part, `altChunk` relationships, external (`TargetMode="External"`)
relationships of type `attachedTemplate`, `oleObject`, `frame` or `subDocument`, DTDs/entities. Warnings: external images,
embedded OLE objects, legacy form fields (`w:ffData`), tracked changes (`w:ins`/`w:del`) and comments (filled output keeps
them; the UI tells the user to accept changes in Word first).

### A.4 Text model (`text.ts`)

```ts
export function normaliseText(s: string): string;   // NFC; U+00A0→space; U+2018/2019→'; U+201C/201D→"; trim; collapse runs of spaces
export function slugify(text: string, max = 48): string;
export interface RunPiece { run: Element; t: Element | null; start: number; end: number; text: string }
export interface ParaText { para: Element; text: string; pieces: RunPiece[] }   // text = concatenation of w:t (w:tab → '\t', w:br → '\n')
export function paragraphText(p: Element): ParaText;
/** Replace [start,end) of the paragraph text, keeping the rPr of the run that holds `start`; empties/removes the other runs it spans. */
export function replaceRange(pt: ParaText, start: number, end: number, value: string, opts?: { restyleHint?: boolean }): void;
```

`slugify` is normative (scanner ids and mapping selectors depend on it):

```ts
export function slugify(text: string, max = 48): string {
  const s = text
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚‛']/g, '')
    .replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/£/g, ' gbp ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = s.slice(0, max).replace(/-+$/g, '');
  return cut || 'x';
}
```

Split runs: Word splits typed placeholder text across runs (`proofErr`, `rsid` changes, spell-check). All pattern detection
runs on `ParaText.text` (the paragraph's joined text), and `replaceRange` edits the first run that holds the match and
trims the rest, so `{{claim.reference}}` split into three runs and `____` split by a proofing boundary are both handled.
`w:proofErr`, `w:bookmarkStart/End`, `w:rPrChange` inside the range are removed with the emptied runs.

### A.5 Structure walk (`context.ts`)

The scanner walks `word/document.xml` body children in order, then each `word/header*.xml` and `word/footer*.xml`.

**Headings → `sectionPath`.** A paragraph that is not inside a table and contains no checkbox glyph is a heading when:

| Level | Rule (first match wins) |
|---|---|
| 1 | `w:pStyle` is `Title`, `Heading1` (any locale alias with outline level 0), or text starts with a two-digit number token followed by 2+ spaces or a tab (`^\d{2}(\s{2,}\|\t)\S` — the CCGUK `«01»«     »«Customer & claim details»` pattern), or `^Part [A-C]\b`, or a banner table (below), or `^(Enforceability check\|Cancellation form\|Exhibit)\b` |
| 2 | `w:pStyle` `Heading2`/outline level 1, or `^[A-C]\d\.\d+\s` (02: `A1.1  THE SERVICES`), or `^\d+\.\d+\s` when all runs are bold, or a short (≤ 90 chars) paragraph whose runs are all bold (any size), that does not end with `.`, and that is followed (ignoring empty paragraphs) by a table or by a checkbox/label paragraph (03: `Replacement vehicle insurance`, `Authorised driver declaration` — bold, 9 pt, colour 04347F) |

**Banner tables are headings too** (CCGUK-02): a one-row table whose first cell is dark-filled (`0D1C50`) and holds
a short code — `PART` + `A`/`B`/`C`, or `^[A-C]\d$` (`A1`, `C2`) — is a level-1 heading; its title is the code plus
the first run of the next cell (`A1 CLIENT AUTHORISATION` → `a1-client-authorisation`; `PART A CLIENT AUTHORITY` →
`part-a-client-authority`, replaced by the following `A1` banner). Banner tables never yield slots.

Text before the first level-1 heading belongs to section `title`. `sectionPath` = `[level1Slug]` or
`[level1Slug, level2Slug]`; a new level-1 heading clears level 2. Slugs use the heading's full text
(`01     Customer & claim details` → `01-customer-and-claim-details`).

**Tables.** For every `w:tbl` (including nested ones) the walker records: grid widths, rows, and whether row 0 is a
**header row** (`w:tblHeader`, or every non-empty cell of row 0 is dark-filled and at least two are — the 06 matrix
has an empty white spacer cell in row 0). A header row gives each column a **qualifier** (`slugify(headerCellText)`),
e.g. `original-vehicle-pending-assessment`, `replacement-vehicle-credit-hire`, `lessor-credit-hire-provider`,
`hirer-client`, `out`, `in`, `amount-gbp`. In a table with a header row, a column whose data cells are non-empty in at
least half of the data rows is a **label column** (06 matrix columns 0 and 4 `Panel / item`; 09 CCTV sources; 07
income/outgoing row names).

**Cell headings.** Inside a cell, a first paragraph whose text is all caps or all bold and ≤ 60 chars, followed by label
paragraphs, is a **cell heading** and becomes the qualifier for slots in that cell (signature blocks: `client`, `hirer`,
`for-courtesy-cars-group-uk-ltd`, `hirer-at-release`).

**Label-like cell.** Non-empty text and any of: shading fill not `auto`/`FFFFFF`; all runs bold or caps; text ends with `:`
or `?`; it sits in a label column of a table with a header row.

**Value cell.** Text empty/whitespace, or text is exactly a blank pattern, `£`, `CCG-`, or a bracket placeholder.

**Not slots** (never produced): cells narrower than 400 twips (gutters 200, gold bar 130); cells in spacer rows (`trHeight`
≤ 200 and all cells empty); a column whose header cell is empty and whose cells are all empty (the 06 matrix spacer);
vMerge continuation cells; body paragraphs that are empty (page-break spacers such as the four `pageBreakBefore`
paragraphs in 03); any non-empty static text (pre-printed company data, `Shahzaib Ahmed Bari — Director`,
`COURTESY CARS GROUP UK LTD` account name); PAGE/NUMPAGES fields.

**Blocks.** A paragraph with `w:pageBreakBefore` (or a paragraph containing `<w:br w:type="page"/>`) starts a block that
runs to the next such paragraph or to `w:sectPr`. `DocxBlock.id = slugify(first heading text in the block)` (03:
`enforceability-check-internal-use-not-for-the-hirer` → mapping selectors match by prefix `enforceability-check`; 04:
`exhibit-sheet`). Blocks can be removed by a variant or a block rule (§B.7).

### A.6 Slot detection and ids (`scan.ts`, `patterns.ts`)

```ts
export type SlotKind =
  | 'cell'        // label cell → value cell (empty run, run-less paragraph, or empty cell)
  | 'inline'      // label run + empty value run in the same paragraph (03 Parties / Vehicle particulars)
  | 'line'        // bottom-bordered paragraph after a label paragraph (signature-style blocks)
  | 'blank'       // underscore/space pattern inside a run (date, money, reference, number+unit, text)
  | 'bracket'     // [placeholder] text
  | 'token'       // {{key}} or {{key|format}} (uploaded templates)
  | 'control'     // w:sdt content control (text) with w:tag / w:alias
  | 'mergefield'  // MERGEFIELD (simple or complex field)
  | 'checkbox'    // one ☐ that is a yes/no on its own (paragraph checkbox, single inline glyph, w14:checkbox)
  | 'choice'      // several ☐ options that belong together (one paragraph / one run)
  | 'block'       // single-cell box with a label (free text, big tcMar)
  | 'table'       // repeating rows: header row + ≥ 2 empty data rows (witnesses, damage log, chronology)
  | 'paragraphs'; // repeating numbered paragraphs (witness statement body, letterhead body)

export type BlankPattern = 'date' | 'datetime' | 'time' | 'month-year' | 'money' | 'reference' | 'number' | 'percent' | 'eighths' | 'page-of' | 'text';

export interface DocxSlot {
  id: string;
  kind: SlotKind;
  part: string;                 // 'word/document.xml' | 'word/header1.xml' …
  parts?: string[];             // same slot found in several byte-identical header/footer parts (02 header1/3/4)
  sectionPath: string[];        // slugs, outer → inner
  sectionTitles: string[];      // human titles
  qualifier?: string;           // column / cell-heading slug
  qualifierTitle?: string;
  label: string;                // decoded human label
  labelSlug: string;
  ordinal: number;              // 1-based among slots with the same (sectionPath, qualifier, labelSlug)
  sub?: string;                 // '1', '2' … for several blanks in one paragraph; 'date'/'time' never used (formatter splits)
  preview: string;              // current text of the target ('' when empty)
  blank?: { pattern: BlankPattern; text: string; hasCurrency: boolean; prefix?: string; unit?: string };
  options?: Array<{ slug: string; label: string; checked: boolean; blank?: { pattern: BlankPattern; text: string } }>;
  columns?: Array<{ slug: string; label: string }>;   // 'table'
  rowCount?: number;                                   // 'table' | 'paragraphs': template rows present
  fixedLead?: string;           // 'paragraphs': fixed text before the bracket in item 1 (letterhead opening sentence)
  token?: { key: string; format?: string };            // 'token'
  signature: boolean;           // label/heading matches SIGNATURE_RE → the engine never fills it
  hint: boolean;                // grey-italic placeholder styling (restyle on fill)
  widthTwips?: number;          // value cell width (UI uses it to warn about long values)
  multiline: boolean;           // 'block', gridSpan ≥ 3 cells, 'paragraphs'
  blockId?: string;             // DocxBlock the slot sits in
}

export interface DocxBlock { id: string; title: string; part: string; startIndex: number; endIndex: number }
export interface DocxScan {
  scannerVersion: number;       // SCANNER_VERSION, bump when ids could change
  sha256: string;
  slots: DocxSlot[];
  blocks: DocxBlock[];
  outline: Array<{ level: 1 | 2; title: string; slug: string }>;
  warnings: DocxIssue[];
  text: string;                 // plain text of the unfilled template (baseline for consistency checks, §C.6)
  stats: { paragraphs: number; tables: number; parts: number; ms: number };
}
export const SCANNER_VERSION = 1;
export function scanDocx(bytes: Uint8Array, opts?: { limits?: Partial<DocxLimits> }): DocxScan;
export const SIGNATURE_RE = /\b(signature|signed|sign here|initials?|initial here)\b/i;
```

**Id grammar** (normative):

```
id      := section '/' [ '@' qualifier '/' ] label [ '#' ordinal ] [ ':' sub ]
section := sectionPath joined with '/'        (e.g. 02-driver-and-insurance-record/replacement-vehicle-insurance)
label   := labelSlug                          (kind 'table': 'table-' + slug(first two column headers); 'paragraphs': 'paragraphs')
ordinal := 2, 3 …                            (omitted for the first occurrence)
sub     := 1, 2 …                            (several 'blank' slots in one paragraph; left-to-right; omitted when only one)
header/footer slots use section 'header' or 'footer'
```

Examples (from the real files): `title/reference`, `title/date`, `01-customer-and-claim-details/registration`,
`03-incident-and-vehicle-particulars/@replacement-vehicle-credit-hire/registration`,
`07-vehicle-handover-and-condition-summary/registration`, `13-client-authorisation/@client/full-name`,
`13-client-authorisation/@client/signature` (signature: true), `header/ref` (02, parts header1/3/4),
`03-condition-matrix/@out/front-bumper`, `07-police-witnesses-and-injury/table-name-contact`.
Checkbox options are addressed inside the slot (`options[].slug`), not by id.

**Detection order** inside each paragraph (a character range claimed by an earlier rule is not re-used):

1. `token` — `/\{\{\s*([A-Za-z][\w.\[\]]*)\s*(?:\|\s*([\w-]+)\s*)?\}\}/g` on joined paragraph text.
2. `control` — `w:sdt` with `w:sdtPr/w:tag/@w:val` or `w:alias/@w:val`; `w14:checkbox` inside → `checkbox`.
3. `mergefield` — `w:fldSimple[@w:instr~MERGEFIELD]` or complex field whose `instrText` starts with `MERGEFIELD`.
4. checkbox glyphs — `☐` U+2610, `☒` U+2612, `☑` U+2611 in text, and `w:sym` with `w:font` Wingdings/Wingdings 2 and
   `w:char` F06F/F0A8/F0A3 (unticked) or F0FD/F0FE/F078 (ticked). Grouping:
   - glyph alone in a run, one glyph in the paragraph → `checkbox`, label = paragraph text after the glyph;
   - several glyphs in a paragraph or run → `choice`; options = text after each glyph up to the next glyph, a ` · `
     separator, or a following blank; an option whose text holds a blank keeps it in `options[].blank`;
   - a run holding two groups separated by ` · ` or by prose (09 injury callout: `Client told on ____ · by ☐ telephone
     ☐ email ☐ in person · confirmed in writing ☐ YES ☐ NO`) yields one `blank` slot plus two `choice` slots whose labels
     are the prose before each group (`by`, `confirmed-in-writing`);
   - consecutive paragraph checkboxes under the same heading are separate `checkbox` slots (01 §05, 03 §05, 07 §06);
     exclusivity is mapping data (`when`), not scan output.
5. `bracket` — `/\[([^\[\]\n]{1,160})\]/g` where the inner text contains a letter and is not a citation year
   (`[2003] UKHL 64` in 07 is **not** a slot: inner must not match `/^\d{4}$/`). `hint` = run is italic and grey.
6. `blank` — patterns tried longest first on the paragraph text:

| Pattern | Regex (on joined text) | Example |
|---|---|---|
| `datetime` | `_{2,}\s*/\s*_{2,}\s*/\s*_{4,}\s+at\s+_{2,}\s*:\s*_{2,}` | `____ / ____ / ______  at  ____ : ____` |
| `date` | `_{2,}\s*/\s*_{2,}\s*/\s*_{4,}`; or whole-run `^\s{4,}/\s{4,}/\s{4,}$` (space box) | `___ / ___ / ______`, `        /         /              ` |
| `time` | `_{2,}\s*:\s*_{2,}` | `____ : ____` |
| `reference` | `CCG-(?:HIRE-)?[_\s]{3,}(?:-[_\s]{3,})?` (whole run when the blank part is spaces) | `CCG-____________-________`, `CCG-HIRE-____________`, `CCG-                    -            ` |
| `money` | `£\s?_{3,}` | `£______________` |
| `page-of` | `_{3,}\s+of\s+_{3,}` | `______ of ______` |
| `eighths` | `_{3,}\s*/\s*8` | `______ / 8` |
| `percent` | `_{3,}\s*%` | `______ %` |
| `number` | `_{3,}\s+(miles|days|years|mph)\b` (unit kept) | `__________ miles` |
| `text` | `_{3,}` | `____________________________` |

   A cell whose whole text is `£` is a `money` blank with `hasCurrency: true` (02 C1.4); a cell whose whole text is
   `CCG-` is a `reference` blank with `prefix: 'CCG-'` (02 cover). Several blanks in one paragraph get `sub` 1, 2, ….
   Label of a blank: the label of its value cell when it sits in one; else the prose before it in the paragraph since the
   previous slot (last ≤ 6 words, e.g. `i first appointed ccguk on`); else the prose after it (first ≤ 4 words); else
   `blank`.
7. Structural slots (only when the paragraph/cell yielded nothing above):
   - `cell`: value cell (§A.5) whose nearest preceding label-like sibling cell in the same row gives the label; if none,
     the header cell of its column (qualifier) and the row's first cell (label).
   - `inline`: a paragraph whose first run is label-styled (bold or caps, grey) with text and whose last run is empty
     (03 t2/t7). The label is the first run's text without trailing spaces/colon.
   - `line`: an empty paragraph with a bottom border (`w:pBdr/w:bottom`) directly after a non-empty label paragraph in
     the same container; label = that paragraph's text. Also a table value cell with only a bottom border (02 A1.4).
   - `block`: a one-row, one-cell table whose cell is empty, preceded by a label paragraph; `multiline: true`.
   - `table`: a table with a header row whose data rows (≥ 2) are empty except an optional numbering column; columns =
     header cells (the numbering column is excluded); a trailing row labelled `Total` is not a data row.
   - `paragraphs`: ≥ 2 consecutive paragraphs whose first run is a literal `N.` (bold) followed by a tab run and a
     bracket placeholder (04 body ×9, letterhead body ×4). `fixedLead` = fixed text before the bracket in the first
     paragraph (letterhead: `We act on behalf of our client in respect of …`).

**Header/footer.** Header/footer parts are scanned with section `header`/`footer`. Slots with identical id in
byte-identical parts are merged (`parts: [...]`). The ten templates have exactly one such slot (02 `header/ref`).

**Stability guarantees.** Same bytes → same ids (pure function). Editing text outside a section does not change that
section's ids. Changing a label changes that slot's id only. `SCANNER_VERSION` is stored with every cached scan; the API
re-scans when it changes.

### A.7 Fill (`fill.ts`)

```ts
export type SlotValue =
  | { type: 'text'; text: string }                                    // '\n' → <w:br/>
  | { type: 'check'; checked: boolean }
  | { type: 'choice'; selected: string[]; blanks?: Record<string, string> }   // option slugs; text for blanks inside options
  | { type: 'rows'; rows: Array<Record<string, string>> }            // keys = column slugs
  | { type: 'paragraphs'; items: string[]; replaceFixedLead?: boolean }
  | { type: 'remove'; scope: 'paragraph' | 'row' };                   // remove the containing paragraph / table row

export interface FillInstruction { slotId: string; value: SlotValue }
export interface FillOptions {
  removeBlocks?: string[];                        // DocxBlock ids (prefix match)
  coreProps: CorePropsInput;                      // §A.8
  now: Date;                                      // zip mtime + dcterms:modified
  valueRunStyle?: RunStyle;                       // default style for inserted runs (mapping 'style.valueRun')
  allowSignatureSlots?: false;                    // type-level guarantee: signature slots are never filled
}
export interface FillReport { filled: string[]; removed: string[]; skipped: Array<{ slotId: string; reason: FillSkipReason }> }
export type FillSkipReason = 'NOT_FOUND' | 'SIGNATURE_SLOT' | 'TYPE_MISMATCH' | 'OPTION_NOT_FOUND' | 'EMPTY_VALUE';
export function fillDocx(bytes: Uint8Array, instructions: FillInstruction[], opts: FillOptions): { docx: Uint8Array; sha256: string; report: FillReport };
export interface RunStyle { font?: string; sizeHalfPoints?: number; color?: string; bold?: boolean }
```

`fillDocx` re-scans the same bytes (deterministic) to locate each slot; an id that is not found is reported, never
guessed. Per kind:

| Kind | Fill rule |
|---|---|
| `cell`, `line`, `block` | If the target paragraph has a run with an empty `w:t`, set its text (keep `rPr`). If the paragraph has no run, insert one with style from, in order: the paragraph mark `w:pPr/w:rPr`; `valueRunStyle`; default `Calibri, 1A1A1A, sz 18`. Never copy a label run's style. `block`: if the cell has `tcMar` top/bottom ≥ 1000 twips, set both to 120 when the value is non-empty. Multi-line → `<w:br/>` between lines in one run. |
| `inline` | Fill the last (value) run; the label run, including its trailing spaces, is untouched. |
| `blank` | Replace only the pattern range (units, `£`, `approx.`, `at`, labels around it stay). `reference` replaces the **whole** match including the printed `CCG-`/`CCG-HIRE-` prefix so the result is never `CCG-CCG-…`. Space-box `date`/`reference` runs are replaced whole. A `£`-only cell becomes `£` + digits. |
| `bracket`, `token`, `mergefield`, `control` | Replace the placeholder text (brackets included). If `hint`, drop `w:i`/`w:iCs` and set colour `3F4552`, keep size. Merge fields are replaced by a plain run carrying the result run's `rPr`; content controls keep the `w:sdt` wrapper, clear `w:showingPlcHdr`, and replace the content runs. |
| `checkbox` | Swap the glyph in place: U+2610 ↔ U+2612 (Wingdings `w:sym`: F0A8/F06F ↔ F0FE; `w14:checkbox`: update `w14:checked` and the glyph). |
| `choice` | For each option: checked if its slug is in `selected` (U+2612), else U+2610 (a template's pre-ticked option is unticked only when another option is selected). `blanks[optionSlug]` fills the blank inside that option's text. Glyph is replaced by string index within the run, so the font of the run is kept (Calibri falls back for ☒ exactly as it does for ☐). |
| `table` | Fill existing empty rows top-down; when there are more rows than template rows, clone the last data row (or the last two rows when shading alternates) and insert before any `Total` row; surplus template rows stay empty. |
| `paragraphs` | Item *i* replaces the bracket in paragraph *i* (`fixedLead` kept unless `replaceFixedLead`); more items → clone the last paragraph; fewer → remove the surplus paragraphs (but never paragraph 1: an empty item 1 just removes its bracket and the space before it). Literal `N.` runs are renumbered from the first paragraph's number. |
| `remove` | Remove the paragraph (or table row) containing the slot — used for unused letterhead address lines, `BY EMAIL`, `Enc.`, `Cc.`, the reply-by sentence, empty `Your Ref` rows. |

Hard rules enforced by `fillDocx` (not just by the plan): a slot with `signature: true` is skipped with
`SIGNATURE_SLOT` whatever the instruction; text values are length-capped at 20 000 characters; `removeBlocks` removes whole
blocks (variants, e.g. the 03 internal enforceability page for the hirer copy).

### A.8 Document properties (`props.ts`)

```ts
export interface CorePropsInput { title: string; subject?: string; keywords?: string[]; description?: string; created: Date; modified: Date }
export function setDocxProperties(pkg: DocxPackage, input: CorePropsInput): void;
```

Writes `docProps/core.xml`: `dc:creator` = `cp:lastModifiedBy` = **`Courtesy Cars Group UK Ltd`**, `dc:title` (e.g.
`Vehicle Credit Hire Agreement — CCG-2026-00012`), `cp:keywords` (reference; template id), `dc:subject`,
`dcterms:created`/`dcterms:modified` (W3CDTF, `xsi:type="dcterms:W3CDTF"`), and removes `cp:revision`/`cp:lastPrinted`.
Writes `docProps/app.xml` `<Application>ClaimDesk</Application><Company>Courtesy Cars Group UK Ltd</Company>` (no
`AppVersion`; Word validates its format). Creates either part, its `[Content_Types].xml` override and its
`_rels/.rels` relationship when missing.

### A.9 Text and preview (`preview.ts`)

```ts
export function docxToPlainText(bytes: Uint8Array): string;   // body paragraphs + table cells in order; checkboxes as ☐/☒
export function docxToPreviewHtml(bytes: Uint8Array, meta: { title: string; kind: string; reference: string; date: string }): string;
export interface HeaderFooterText { firstHeader?: string; header?: string; firstFooter?: string; footer?: string; titlePage: boolean; hasPageFields: boolean }
export function extractHeaderFooter(bytes: Uint8Array): HeaderFooterText;
```

`docxToPreviewHtml` produces simple semantic HTML (`h2` for headings, `p`, `table`, bold/italic, ☐/☒) starting with
`<!DOCTYPE html>` and the `<meta name="ccguk:kind|reference|date">` tags that `readDocumentMeta` reads. It is stored in
`documents.html` (NOT NULL), shown as the fallback preview, and fed to `checkDraft` for the consistency engine.

### A.10 Letterhead composition (data: §B; code: `docx/fields/letterhead.ts`)

```ts
export interface LetterContent {
  privateAndConfidential?: boolean;                 // default true (template prints it)
  recipient: { attention?: string; department?: string; name: string; addressLines: string[]; email?: string };
  refs: { ourRef: string; yourRef?: string; claimNo?: string; client?: string; vehicle?: string; dateOfAccident?: string; date: string };  // display strings
  salutation: string;                               // 'Sir or Madam' | 'Ms Patel'
  subject: string; subjectClient?: string; subjectReg?: string;
  paragraphs: string[];                             // numbered automatically
  replaceFixedOpening: boolean;                     // true when the paragraphs already contain an opening (HTML letters)
  replyBy?: string;                                 // display date; sentence removed when absent
  valediction?: 'sincerely' | 'faithfully';         // derived from salutation when absent
  signatory: { name: string };
  enclosures?: string[]; cc?: string[];
}
export function composeLetterheadDocx(letterhead: Uint8Array, content: LetterContent, opts: { now: Date; reference: string; title: string }): { docx: Uint8Array; sha256: string; report: FillReport };
```

`LetterContent` is declared in `docx/types.ts` (engine slice) so other slices can import it early; the function lives in
the fields slice because it is "fill the built-in letterhead mapping with these values". Address lines map in order to
`[Address line 1]`, `[Address line 2]`, `[Town, POSTCODE]` (last line always goes to the town/postcode slot); unused
lines, `BY EMAIL`, `Your Ref`/`Claim No.` rows, the reply-by sentence, `Enc.` and `Cc.` are removed (`remove`). The
pre-printed signatory role `Claims Manager` is never changed (§B.7 guard `signatoryRole`).

### A.11 DOCX → PDF on the user's Windows PC (`convert/`)

#### A.11.1 Interface

```ts
export type DocxPdfConverterId = 'word' | 'libreoffice' | 'browser';
export type DocxPdfPreference = 'auto' | DocxPdfConverterId;
export interface ConverterStatus { ok: boolean; detail?: string; path?: string }
export interface DocxPdfConverter {
  id: DocxPdfConverterId;
  detect(): Promise<ConverterStatus>;
  convert(input: { docxPath: string; outDir: string; header: HeaderFooterText; timeoutMs: number }): Promise<string /* pdf path */>;
}
export interface PdfMetadata { title: string; subject?: string; keywords?: string[]; author?: string /* default registered name */ }
export interface ConvertDocxOptions {
  preference?: DocxPdfPreference;          // default from env DOCX_PDF_CONVERTER, else 'auto'
  workDir: string;                         // temp dir under DATA_DIR (API passes <DATA_DIR>/tmp/convert)
  timeoutMs?: number;                      // per attempt; default word 90 000, libreoffice 90 000, browser 60 000
  metadata: PdfMetadata;
  converters?: DocxPdfConverter[];         // test injection
}
export interface ConvertDocxResult {
  pdf: Buffer; sha256: string; pages: number; converter: DocxPdfConverterId;
  attempts: Array<{ id: DocxPdfConverterId; ok: boolean; ms: number; error?: string }>;
}
export function convertDocxToPdf(docx: Uint8Array, opts: ConvertDocxOptions): Promise<ConvertDocxResult>;
export function detectDocxConverters(opts?: { refresh?: boolean }): Promise<Record<DocxPdfConverterId, ConverterStatus>>;
export function stampPdfMetadata(pdf: Uint8Array, meta: PdfMetadata & { creator?: string; producer?: string; language?: string }): Promise<{ pdf: Buffer; pages: number }>;
```

`auto` order: `word` → `libreoffice` → `browser`. A named preference tries that converter first and still falls back
(the attempt log records why). Conversions are **serialised** (one at a time, in-process queue) because Word automation
is single-threaded and LibreOffice locks its profile. Detection results are cached for the process lifetime
(`refresh` re-detects). Every result goes through `stampPdfMetadata` (Author `Courtesy Cars Group UK Ltd`, Creator
`ClaimDesk`, Producer `ClaimDesk — Courtesy Cars Group UK Ltd`, Title, Subject, Keywords, Language `en-GB`) **before**
the sha256 is computed. The converter id is stored with the document (`documents.pdf_converter`) and audited.

#### A.11.2 Microsoft Word (preferred when installed)

- Detect (win32 only): `powershell.exe -NoProfile -NonInteractive -Command "[type]::GetTypeFromProgID('Word.Application') -ne $null"` → `True`.
- Convert: write a script to `workDir` and run `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File convert.ps1 -In <docx> -Out <pdf>`:

```powershell
param([string]$In, [string]$Out)
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$wordPid = $null
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0                      # wdAlertsNone
  $word.Options.UpdateLinksAtOpen = $false
  $doc = $word.Documents.Open($In, $false, $true, $false)   # ConfirmConversions, ReadOnly, AddToRecentFiles
  $doc.ExportAsFixedFormat($Out, 17, $false, 0, 0, 0, 0, 0, $true, $true, 0, $true, $true, $false)  # wdExportFormatPDF; DocStructureTags; BitmapMissingFonts
  $doc.Close(0)
} finally {
  $word.Quit(0)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
```

- Timeout: on expiry kill the PowerShell process tree **and** only the `WINWORD.EXE` process started by this run (record
  the set of WINWORD PIDs before start; kill PIDs that appeared and whose command line contains `/Automation` or
  `-Embedding`). Never kill a Word the user has open.
- PAGE/NUMPAGES fields are computed by Word on export. Fonts (Calibri, Segoe UI Symbol) are on every Windows PC.

#### A.11.3 LibreOffice

- Detect: `SOFFICE_PATH` env; `%ProgramFiles%\LibreOffice\program\soffice.exe`; `%ProgramFiles(x86)%\…`; on Linux/macOS
  `soffice`/`libreoffice` on PATH; `/Applications/LibreOffice.app/Contents/MacOS/soffice`.
- Convert: `soffice --headless --norestore --nolockcheck "-env:UserInstallation=file:///<workDir>/lo-profile" --convert-to pdf:writer_pdf_Export --outdir <outDir> <docx>`.
- Detection must also prove Writer exists: convert a 1-paragraph probe .docx once; failure → `ok:false, detail:'Writer component missing'`
  (the sandbox's system soffice has no Writer, exactly this case).

#### A.11.4 Browser (always available)

Uses the same browser lookup and shared instance as `renderPdf` (`resolveChromium()` → Edge first on Windows;
`getBrowser()`), so no new binary is needed:

1. `page.setContent()` a shell document with the print CSS below; `addScriptTag({ path })` for
   `jszip/dist/jszip.min.js` and `docx-preview/dist/docx-preview.min.js`, resolved with
   `createRequire(import.meta.url).resolve(...)` (packaging must ship both files — §G.6).
2. `docx.renderAsync(bytes, container, null, { inWrapper: true, ignoreHeight: true, breakPages: true, renderHeaders: true,
   renderFooters: false, experimental: true, useBase64URL: true })`.
3. Print CSS: page geometry from the first `w:sectPr` (`w:pgSz`, `w:pgMar`); running header and footer from
   `extractHeaderFooter()` as **CSS page margin boxes** with `counter(page)`/`counter(pages)` (Chromium ≥ 131; Edge on
   Windows 10/11 is current); `@page :first` suppresses the running header because docx-preview renders the first-page
   header (logo + contact block) inline at the top of the first section; explicit page breaks →
   `section.docx + section.docx { break-before: page }`; `tr { break-inside: avoid }`.

```css
@page { size: A4; margin: <top>mm 0 <bottom>mm 0;
  @top-left   { content: "<header text left>"; font: 7.5pt Calibri, Carlito, Arial, sans-serif; margin-left: <left>mm }
  @top-right  { content: "PAGE " counter(page) " OF " counter(pages); font: 7.5pt Calibri, Carlito, Arial, sans-serif; margin-right: <right>mm }
  @bottom-center { content: "<footer text>"; font: 6.5pt Calibri, Carlito, Arial, sans-serif } }
@page :first { @top-left { content: none } @top-right { content: none } }
.docx-wrapper { background: none !important; padding: 0 !important; display: block !important }
section.docx { box-shadow: none !important; margin: 0 !important; min-height: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important }
section.docx > header { position: static !important } section.docx ~ section.docx > header { display: none }
```

4. `page.pdf({ preferCSSPageSize: true, printBackground: true })`.

If margin boxes are unsupported (old Chromium; detected by rendering a probe with `@top-left { content: "x" }` and checking
the PDF text once per process), fall back to Playwright `headerTemplate`/`footerTemplate` with the same text (no
first-page distinction).

#### A.11.5 Evidence and how to test it here

- Prototyped in this sandbox (scratch `wf2/arch/`): Chromium 141 prints margin boxes with `counter(pages)` and honours
  `@page :first` (`mb.pdf`: pages 2–5 carry `COURTESY CARS GROUP UK LTD | …  PAGE n OF 5`, page 1 does not).
  docx-preview + that CSS rendered 01/03/05/Letterhead to 6/16/4/2 pages against the LibreOffice references 5/14/3/1;
  the overrun comes mostly from the sandbox having neither Calibri nor Carlito. **Acceptance for the browser
  converter:** page count within +25 % of the LibreOffice reference here; running header text and `PAGE n OF N` present
  on pages ≥ 2; first-page header text (`Case handler 07425 475922`) present on page 1; all filled values present in the
  PDF text (`pdftotext`).
- Reference renders: `soffice` on PATH lacks Writer. A Writer-enabled copy is at
  `/tmp/claude-0/-home-user-logo/811a135a-35cb-5723-858d-e84fbd9027fa/scratchpad/wf2/a135/lo/soffice.sh` (same
  arguments). Integration tests for the LibreOffice converter run only when `SOFFICE_PATH` is set:
  `SOFFICE_PATH=<that path> pnpm --filter @ccguk/documents test -- docx/convert`.
- Chromium for tests: `CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (or `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`).
- Word cannot run here. `word.ts` is unit-tested by asserting the generated script and spawn arguments with an injected
  `spawn`, and by the timeout/kill logic with a fake process. The Windows CI job (§G.7) exercises the browser converter
  for real; Word is verified by hand on a PC with Office (checklist in §K).
- `pnpm --filter @ccguk/documents docx:samples` writes, for each of the 10 files: `out/docx/<id>.scan.txt` (outline +
  slots), `<id>.filled.docx` (filled from the sample merge source), `<id>.browser.pdf`, and `<id>.lo.pdf` when
  `SOFFICE_PATH` is set, plus PNGs of page 1–2 via `pdftoppm` when available.

### A.12 PDF metadata for HTML documents (`render.ts`)

`RenderPdfOptions` gains `metadata?: PdfMetadata`. After `page.pdf()` and before hashing, `renderPdf` calls
`stampPdfMetadata` (defaults: Title = `<title>` of the HTML, Author = registered name, Creator `ClaimDesk`, Producer
`ClaimDesk — Courtesy Cars Group UK Ltd`, Language `en-GB`). `mergePdfs` also sets Author and copies the first
document's Title. pdf-lib writes these as UTF-16 hex strings; tests assert with `PDFDocument.getAuthor()`, not grep.

---

## B. Merge-field dictionary, resolvers and mappings (`packages/documents/src/docx/fields/`)

### B.1 Files

```
packages/documents/src/docx/fields/
  index.ts           public surface (re-exported from packages/documents/src/index.ts)
  types.ts           FieldDef, FieldValue, FillPolicy, FormatName, MappingEntry, TemplateMapping, PlanRow, …
  source.ts          MergeSource (the input the API builds) + sampleMergeSource()
  dictionary.ts      FIELD_DEFS: FieldDef[] (every key in Appendix 1) + getFieldDef(), listFieldGroups()
  resolve.ts         resolveField(key, source) and the helpers it uses (pure)
  format.ts          formatForSlot(value, slot, entry?) → SlotValue
  automap.ts         suggestMapping(scan) for uploaded templates
  mapping.ts         resolveSelectors(mapping, scan), mergeMappings(base, override), validateMapping()
  plan.ts            buildFillPlan(scan, mapping, source, inputs, opts) → FillPlan (rows for the UI + FillInstruction[])
  guards.ts          template guards (bank, rates, signatory, references)
  letterhead.ts      composeLetterheadDocx() (§A.10)
  builtin/
    index.ts         BUILTIN_DOCX_TEMPLATES (metadata) + builtinMapping(id) + builtinAssetPath(id)
    agreement.ccguk_01_customer_loa.mapping.json
    agreement.ccguk_02_recovery_storage_engineering.mapping.json
    agreement.ccguk_03_credit_hire.mapping.json
    statement.ccguk_04_witness.mapping.json
    form.ccguk_05_payment_direction.mapping.json
    form.ccguk_06_handover_condition.mapping.json
    form.ccguk_07_statement_of_means.mapping.json
    form.ccguk_08_intervention_mitigation.mapping.json
    form.ccguk_09_accident_report.mapping.json
    letter.ccguk_letterhead_formal.mapping.json
```

### B.2 The merge source (what the API hands the resolvers)

```ts
// source.ts — every type imported from @ccguk/domain unless declared here
export interface MergeCompany {
  registeredName: string;        // 'Courtesy Cars Group UK Ltd'
  tradingName: string;           // 'Courtesy Cars UK'
  companyNumber: string;         // '17430389'
  registeredOffice: string;      // '44 Syon Lane, Isleworth, London TW7 5NQ' (formatRegisteredOffice)
  caseHandlerPhone: string;      // '07425 475922'
  officePhone: string;           // '020 7052 5403'
  email: string;                 // 'claims@courtesycars.net'
  website: string;               // 'www.courtesycars.net'
  director: { name: string; role: string };   // 'Shahzaib Ahmed Bari', 'Director'
  vatNumber?: string; icoRegistration?: string;
  bank?: { accountName: string; bankName?: string; sortCode: string; accountNumber: string };
  rateCard: { recoveryCalloutPence: Pence; perMilePence: Pence; adminPence: Pence; storageDailyPence: Pence; engineerFeePence: Pence; vatRate: number };
}
export interface MergeUser { id: string; name: string; roleLabel: string; email?: string }
export interface MergeHead { head: string; label: string; claimedPence: Pence; invoicedPence: Pence; receivedPence: Pence; outstandingPence: Pence; invoiceReference?: string }
export interface MergeDocumentRef { id: string; templateId: string; canonicalTemplateId: string; title: string; status: DocumentStatus; createdAt: ISODateTime; approvedAt?: ISODateTime; sentAt?: ISODateTime; recipientPartyId?: string; signedAt?: ISODateTime; subjectPartyId?: string }
export interface MergeEvidenceRef { id: string; kind: string; filename: string; description?: string; capturedAt?: ISODateTime; uploadedAt: ISODateTime; exif?: { make?: string; model?: string; dateTimeOriginal?: string }; sourceUrl?: string; verification?: Verification }
export interface MergeHire { agreement: HireAgreement; fleetUnit?: FleetUnit; vehicle?: Vehicle; policy?: InsurancePolicy }
export interface MergeRecipient { partyId?: string; role?: RecipientRole; name: string; addressLines: string[]; attention?: string; email?: string; theirReference?: string }

export interface MergeSource {
  now: ISODateTime;                  // ctx.now() at plan time
  timeZone: 'Europe/London';
  company: MergeCompany;
  user: MergeUser;                   // the signed-in user generating the document
  caseHandler?: MergeUser;           // users[claim.handlerId]
  claim: Claim;                      // bundle.claim
  claimant: Party;                   // bundle.claimant
  driver?: Party;                    // bundle.driver
  keeper?: Party;                    // party with role 'keeper', if any
  vehicle: Vehicle;                  // bundle.vehicle — the client's damaged vehicle
  thirdPartyDrivers: Party[];        // bundle.thirdParties with role third_party_driver | third_party (not witness)
  thirdPartyVehicle?: Vehicle;       // bundle.thirdPartyVehicle
  atFaultInsurer?: Party;            // bundle.atFaultInsurer
  ownInsurer?: Party;                // repos.getParty(claim.clientInsurerId)
  witnesses: Party[];                // bundle.thirdParties with role witness
  witness?: Party;                   // subject.witnessPartyId (04)
  exhibits: MergeEvidenceRef[];      // subject.exhibitEvidenceIds (04), in order
  hire?: MergeHire;                  // subject.hireAgreementId or the latest HireAgreement (03, 06, 07, 08)
  hires: HireAgreement[];
  storage: StorageRecord[];
  recovery: RecoveryRecord[];
  report?: EngineerReport; engineer?: Party; estimate?: Estimate; pav?: PavAssessment;
  offers: InterventionOffer[];
  offer?: InterventionOffer;         // subject.offerId (08)
  events: ClaimEvent[];
  clocks: Clock[];
  ledger: LedgerEntry[];
  heads: MergeHead[];                // documentData headSummaries()
  evidence: MergeEvidenceRef[];
  documents: MergeDocumentRef[];
  gtaRates: GtaRate[];               // merged KB + manual rows (gtaRatesFor(ctx))
  recipient?: MergeRecipient;        // letters: resolveRecipient(...)
  responseDeadline?: ISODate;        // documentData deadline() — never before a running clock
}
export function sampleMergeSource(): MergeSource;   // deterministic fixture (claim CCG-2026-00012) for tests, samples and "test fill"
```

The API builds it in `apps/api/src/services/mergeSource.ts` (§C.6) from `loadBundle(ctx, claimId, true)` plus the repo
lookups the bundle does not carry (own insurer, users, fleet unit, fleet vehicle, policy). Data paths in Appendix 1 refer
to the bundle field names from the documents map (`bundle.claim.*`, `bundle.claimant.*`, …).

### B.3 Field definitions

```ts
export type FieldType = 'text' | 'multiline' | 'date' | 'datetime' | 'time' | 'money' | 'int' | 'bool' | 'choice' | 'list' | 'rows';
export type FillPolicy =
  | 'auto'        // always filled from data when present (inventory "auto")
  | 'auto-if-known' // filled when the data exists; otherwise left blank for the handler (inventory "auto-if-known")
  | 'suggest'     // pre-filled from data but the handler must tick "confirm" before it prints (client choices, same-day dates)
  | 'handler'     // only a value typed by the handler; no resolver output is ever printed
  | 'post-event'  // filled only from a recorded event (signature, sending, return); blank at first generation
  | 'signature'   // never filled (signatures, initials, dates signed, signing time)
  | 'never';      // left exactly as printed (revocation blocks, office receipts, static text)
export type FormatName =
  | 'auto' | 'date-boxes' | 'date-compact' | 'date-long' | 'datetime-boxes' | 'datetime-compact' | 'time'
  | 'month-year-boxes' | 'money' | 'money-digits' | 'reg' | 'upper' | 'title' | 'ordinal' | 'miles' | 'int' | 'lines' | 'inline';

export type FieldValue =
  | { t: 'text'; v: string }
  | { t: 'date'; v: ISODate; precision?: 'day' | 'month' }
  | { t: 'datetime'; v: ISODateTime }
  | { t: 'time'; v: string }                     // 'HH:MM' Europe/London
  | { t: 'money'; v: Pence; verification?: VerificationStatus }
  | { t: 'int'; v: number; unit?: string }
  | { t: 'bool'; v: boolean }
  | { t: 'choice'; v: string[] }                 // canonical option codes from FieldDef.choices
  | { t: 'list'; v: string[] }
  | { t: 'rows'; v: Array<Record<string, string>> };

export interface FieldDef {
  key: string;                       // 'claimant.dateOfBirth'
  group: FieldGroup;                 // 'Company' | 'Document' | 'Handler' | 'Claim' | 'Client' | 'Client vehicle' | 'Accident' | 'Third party' | 'Insurers' | 'Hire' | 'Hire vehicle' | 'Storage' | 'Recovery' | 'Engineer' | 'Payment' | 'Witness' | 'Intervention' | 'Means' | 'Evidence' | 'Diary' | 'Recipient'
  label: string;                     // shown in the mapping editor and the values form
  type: FieldType;
  policy: FillPolicy;                // default; a mapping entry may only make it stricter (auto → suggest/handler), never laxer
  synonyms: string[];                // normalised label phrases for auto-mapping uploaded templates
  sourcePath: string;                // documentation of where the value comes from ('bundle.claimant.dateOfBirth')
  choices?: Record<string, { label: string; matches: string[] }>;   // code → option-text matchers (slugified prefixes)
  overridable?: boolean;             // default true; false = handler input refused (bank details)
  requiresConfirmationUnlessVerified?: boolean;   // GTA rates
  resolve?(src: MergeSource): FieldValue | undefined;   // absent for 'handler' fields
}
export const FIELD_DEFS: readonly FieldDef[];
export function getFieldDef(key: string): FieldDef | undefined;   // also accepts the aliases in Appendix 1
```

Rules for resolvers: pure; never read the clock (use `src.now`); return `undefined` when the data is absent (never
`'unknown'`, `'n/a'`, `0` or today's date as a stand-in); dates converted to Europe/London before the date part is taken;
"open" records never produce an end date, a day count or a total (`documentData`'s `endAt ?? now` must not leak in);
verified/unverified status travels with GTA money values.

### B.4 Formatting (`format.ts`)

```ts
export function formatForSlot(value: FieldValue, slot: DocxSlot, def: FieldDef | undefined, format?: FormatName, when?: string): SlotValue | undefined;
```

| Slot | Value | Output |
|---|---|---|
| `blank` date (`____ / ____ / ______` or space box) | date | `04 / 10 / 2026` (two-digit day/month, spaces round slashes as printed) |
| `blank` date, `precision: 'month'` | `2019-03` | `____ / 03 / 2019` (day group kept as printed) |
| `blank` datetime | datetime | `04 / 10 / 2026  at  09 : 30` (two spaces either side of `at`, as printed) |
| `blank` time | time | `09 : 30` |
| `blank` money (`£____`), `£`-only cell | money | digits only after the printed `£`: `1,234.56` |
| `blank` reference (`CCG-____-____`, `CCG-HIRE-____`, `CCG-` cell, space box) | text | the whole match is replaced by the value (`CCG-2026-00012`, `CCG-H-000123`) |
| `blank` number + unit | int | digits with thousands separators; unit kept (`45,210` + ` miles`) |
| `blank` sort code `____  —  ____  —  ____` | text `040605` | `04  —  06  —  05` |
| `cell`/`inline`/`line` | date | `04/10/2026` (`date-compact`) unless the mapping says `date-long` |
| `cell`/`inline`/`line` | money | `£1,234.56` (`formatGBP`) |
| `bracket` `[dd Month yyyy]` | date | `4 October 2026` (`date-long`) |
| any | registration | `formatRegistration` (`AB12 CDE`) |
| any | address | one line, `, ` joined, postcode after the town with a space: `12 High Street, Hounslow TW3 1AB` |
| `checkbox` | bool, or choice/text equal to `when` | `{type:'check', checked}`; `false` and `undefined` leave the box as printed |
| `choice` | choice codes | option slugs whose slug starts with any of `choices[code].matches`; none → `undefined` (+ plan warning `OPTION_NOT_MATCHED`) |
| `table` | rows | `{type:'rows'}` keyed by column slug |
| `paragraphs` | list | `{type:'paragraphs'}` |

Narrow cells: when `slot.widthTwips < 1300` and the value is a date or date-time, use the compact forms.

### B.5 Rules for slots that are never auto-filled

Enforced in `plan.ts` (and the signature rule again in `fillDocx`):

1. **Signatures** — any slot with `signature: true`, any mapping entry with policy `signature`: never filled, never
   overridable. Covers Signature, Date signed, initials boxes, `YOUR INITIALS`, `Early start (Client to tick)`, `Time
   signed`, `[Date made]`, the exhibit "dated" date, cancellation-form signature/date, `initial here`.
2. **The signer's own declarations and words** (policy `handler`, and the values form labels them "the client completes
   this"): 03 §06 need statements and own-words boxes, §06/§08 tick boxes, the authorised-driver declaration, the 04
   witness paragraphs and relationship, 07 every figure and the £500 question, 01 §05/§08/§12 ticks (suggest only),
   05 §02 heads (suggest only). A resolver value is never printed for a `handler` field.
3. **Post-event blocks** (policy `post-event`/`never`): 05 revocation block and office-use log, 02 C2 office receipt
   line, 03 enforceability check (office copy only, still handler), 06 return stage in the release variant, 09 "Reviewed
   by"/date. Nothing in them is ever derived from "now".
4. **Fraud-critical** — `company.bank.*` come only from Settings; `overridable: false`; 05 refuses to generate when
   Settings has no bank details or the account name is not the registered name (guard `bankAccountName`).
5. **Printed contract figures** — rate tables (01 §06, 02 B1) are static text, never slots. If claim records use other
   rates the guard `printedRates` flags it (§B.7).
6. **Never invent** — no `unknown`, no `n/a`, no day for a month-only date, no "now" for an open hire/storage, no
   independence for a witness, no "not stated" for an insurer term.
7. **Exclusive choices never default to the stronger option** — settlement authority, contract channel, YES/NO
   declarations have no default.
8. **GTA** — benchmark rates print only when `verification.status === 'verified'` or the handler ticks confirm
   (`requiresConfirmationUnlessVerified`); every values-form row carrying a GTA figure shows the benchmark caveat.

### B.6 Mappings

```ts
export interface SlotSelector {
  id?: string;                  // exact slot id (uploaded templates always use this)
  section?: string;             // prefix match against any element of sectionPath (e.g. '03', '02-driver-and-insurance-record')
  qualifier?: string;           // prefix match against the slot qualifier ('replacement-vehicle' matches 'replacement-vehicle-credit-hire')
  label?: string;               // exact labelSlug
  kind?: SlotKind;
  nth?: number;                 // 1-based among the matches
  part?: 'header' | 'footer' | 'body';
}
export interface MappingEntry {
  slot: SlotSelector | string;  // string = exact id
  key?: string;                 // FieldDef key; absent = handler free text with `label`
  policy?: FillPolicy;          // may only be stricter than the FieldDef default
  format?: FormatName;
  when?: string;                // checkbox: tick when the field value equals/includes this code
  onlyIf?: { key: string; equals?: string | boolean };   // fill only when another field resolves to this
  required?: boolean;           // generation blocked (400 VALUES_REQUIRED) until a value exists
  requiredBeforeSigning?: boolean;  // warning only
  removeIfEmpty?: 'paragraph' | 'row';
  variants?: string[];          // only in these variants
  label?: string;               // values-form label override
  group?: string;               // values-form group override
  note?: string;                // shown under the row
}
export interface TemplateVariant { id: string; label: string; removeBlocks?: string[]; default?: boolean }
export type SubjectKind = 'witness' | 'offer' | 'hire' | 'recipient';
export type GuardId = 'bankAccountName' | 'bankRequired' | 'printedRates' | 'signatoryDirector' | 'signatoryRole' | 'openRecordsNoNow' | 'hireReference' | 'witnessRelationship' | 'ratePositionInstruction';
export interface BlockRule { block: string; removeWhen: { key: string; empty?: true; equals?: string | boolean } }
export interface TemplateMapping {
  schemaVersion: 1;
  templateId: string;
  sourceSha256?: string;        // built-ins: sha256 of the asset the mapping was curated against
  entries: MappingEntry[];
  ignore?: Array<SlotSelector | string>;   // slots shown as "left as printed"
  variants?: TemplateVariant[];
  blocks?: BlockRule[];
  guards?: GuardId[];
  subjects?: SubjectKind[];
  style?: { valueRun?: RunStyle };
}
export interface MappingIssue { code: 'SELECTOR_NO_MATCH' | 'SELECTOR_AMBIGUOUS' | 'UNKNOWN_KEY' | 'KIND_MISMATCH' | 'POLICY_LAXER' | 'DUPLICATE_SLOT'; entry: number; detail: string }
export function resolveSelectors(mapping: TemplateMapping, scan: DocxScan): { bySlot: Map<string, MappingEntry>; ignored: Set<string>; issues: MappingIssue[] };
export function mergeMappings(base: TemplateMapping, override: Partial<TemplateMapping>): TemplateMapping;   // override entries replace base entries for the same slot id
export function validateMapping(mapping: TemplateMapping, scan: DocxScan): MappingIssue[];
```

Built-in mapping JSON uses selectors (robust to small template edits); the API stores uploaded mappings and built-in
overrides with exact ids. **Every slot of a built-in template is either mapped or ignored**; the test suite asserts zero
`MappingIssue`s and zero unmapped slots against the real assets. The per-template content is in Appendix 2.

### B.7 Guards (`guards.ts`)

```ts
export interface GuardResult { code: string; severity: 'block' | 'warn'; message: string; slotId?: string }
export function runTemplateGuards(ids: GuardId[], ctx: { scan: DocxScan; source: MergeSource; values: Map<string, FieldValue | undefined> }): GuardResult[];
```

| Guard | Rule | Severity |
|---|---|---|
| `bankRequired` | `company.bank` present with sort code and account number | block |
| `bankAccountName` | `normalise(bank.accountName) === 'COURTESY CARS GROUP UK LTD'` (the printed Account name) | block |
| `printedRates` | recovery records use 9000/300/2500 pence, storage 4500, engineer fee 28500 and `vatRate` 0; else "the records use rates that differ from the printed contract" | warn (01), block for 02 C1 totals (`submission` variant) |
| `signatoryDirector` | `company.director` equals the pre-printed `Shahzaib Ahmed Bari — Director` | warn |
| `signatoryRole` | letterhead: user role label is `Claims Manager` (pre-printed under the name) | warn (the UI says "the letter prints 'Claims Manager' under your name") |
| `openRecordsNoNow` | no end date/days/total printed for an open hire or storage | block (defensive) |
| `hireReference` | 03/06 agreement reference replaced whole (no `CCG-HIRE-CCG-…`) | block (defensive) |
| `witnessRelationship` | 04 relationship entered | block (`required`) |
| `ratePositionInstruction` | 03 rate-position drafting sentence still printed | warn |

### B.8 Auto-mapping uploaded templates (`automap.ts`)

```ts
export interface SuggestedEntry { slotId: string; key?: string; policy: FillPolicy; score: number; reason: string }
export function suggestMapping(scan: DocxScan): { entries: SuggestedEntry[]; unmapped: string[] };
```

1. `token` slots: exact key (or alias) → score 1.0; unknown key → unmapped with reason `UNKNOWN_TOKEN`.
2. `signature: true` → policy `signature`, no key.
3. Candidate keys: FieldDefs whose `type` is compatible with the slot (date blanks ↔ date/datetime; money ↔ money;
   checkbox ↔ bool; choice ↔ choice with ≥ 1 option match; table ↔ rows; others ↔ text-like).
4. Score = best of: exact match of `labelSlug` (or bracket/control text slug) against a synonym slug → 1.0; token-set
   Jaccard ≥ 0.6 → 0.7 × Jaccard + 0.3; plus context: +0.2 when `sectionPath`/`qualifier` contains `hire`, `replacement`,
   `fleet` and the key starts with `hire`/`hireVehicle`; +0.2 for `third-party`, `other-vehicle`, `other-driver` with
   `tp`/`tpInsurer`; +0.2 for `own-insurer` with `ownInsurer`; −0.3 when the context says the opposite party.
5. Accept when score ≥ 0.75 and the runner-up is ≥ 0.1 lower; policy = the FieldDef default; else unmapped
   ("Handler fills"). The UI shows score and reason; nothing is saved until the user presses Save.

### B.9 Fill plan (`plan.ts`) — one function for preview and generation

```ts
export type SlotInput = string | number | boolean | string[] | Array<Record<string, string>> | null;   // null = leave blank
export interface PlanInputs { values?: Record<string, SlotInput>; confirm?: string[]; variant?: string }
export interface PlanRow {
  slotId: string; section: string; sectionTitle: string; label: string; kind: SlotKind;
  inputType: 'text' | 'multiline' | 'date' | 'datetime' | 'time' | 'money' | 'int' | 'checkbox' | 'choice' | 'rows' | 'paragraphs';
  options?: Array<{ value: string; label: string }>; multiple?: boolean; columns?: Array<{ id: string; label: string }>;
  key?: string; policy: FillPolicy; editable: boolean;
  value: SlotInput;              // raw (ISO date, pence, boolean, option slugs, text)
  display: string;               // exactly what will print ('' = left blank)
  origin: 'claim' | 'settings' | 'derived' | 'suggested' | 'handler' | 'none';
  sourcePath?: string; verification?: VerificationStatus;
  needsConfirmation: boolean; confirmed: boolean;
  required: boolean; missing: boolean;
  note?: string; widthTwips?: number; preview: string;
}
export interface FillPlan {
  templateId: string; variant?: string;
  rows: PlanRow[];
  instructions: FillInstruction[];
  removeBlocks: string[];
  issues: Array<{ code: string; severity: 'block' | 'warn'; message: string; slotId?: string }>;   // guards + VALUES_REQUIRED + SLOT_NOT_FILLABLE + mapping issues
}
export function buildFillPlan(scan: DocxScan, mapping: TemplateMapping, source: MergeSource, inputs: PlanInputs): FillPlan;
```

Precedence per slot: handler input (if the policy allows input: not `signature`/`never`, not `overridable: false`) →
resolver value (only for `auto`, `auto-if-known`, and `suggest` once confirmed) → blank. Inputs for a slot whose policy
forbids input produce issue `SLOT_NOT_FILLABLE` (block). `onlyIf` false → blank. Variant: entries with `variants` not
containing the chosen variant are blank; the variant's `removeBlocks` are applied; `BlockRule`s add more.

---

## C. Template library: storage, API, generation, UI

### C.1 Built-in templates

`BUILTIN_DOCX_TEMPLATES` (fields slice, `builtin/index.ts`):

| id | file (packages/documents/assets/docx/) | kind | title | recipientRole | subjects | variants |
|---|---|---|---|---|---|---|
| `agreement.ccguk_01_customer_loa` | CCGUK-01-Customer-Agreement-and-Letter-of-Authority.docx | agreement | Customer Agreement & Letter of Authority | client | — | — |
| `agreement.ccguk_02_recovery_storage_engineering` | CCGUK-02_Recovery_Storage_Engineering_Pack_TEMPLATE_v5.docx | agreement | Recovery, Storage & Engineering Pack | client | — | `instruction` (default: cover, A1, A2), `submission` (+ C1) |
| `agreement.ccguk_03_credit_hire` | CCGUK-03-Vehicle-Credit-Hire-Agreement.docx | agreement | Vehicle Credit Hire Agreement | client | hire | `hirer` (default; removes the internal enforceability page), `office` (full) |
| `statement.ccguk_04_witness` | CCGUK-04-Witness-Statement.docx | statement | Witness Statement | client | witness | — |
| `form.ccguk_05_payment_direction` | CCGUK-05-Payment-Authorisation-and-Settlement-Direction.docx | form | Payment Authorisation & Settlement Direction | client | — | — |
| `form.ccguk_06_handover_condition` | CCGUK-06-Vehicle-Handover-and-Condition-Report.docx | form | Vehicle Handover & Condition Report | client | hire | `release` (default), `return` |
| `form.ccguk_07_statement_of_means` | CCGUK-07-Statement-of-Means.docx | form | Statement of Means | client | hire | — |
| `form.ccguk_08_intervention_mitigation` | CCGUK-08-Intervention-and-Mitigation-Record.docx | form | Intervention & Mitigation Record | client | offer | — |
| `form.ccguk_09_accident_report` | CCGUK-09-Accident-Report-Form.docx | form | Accident Report Form | client | — | — |
| `letter.ccguk_letterhead_formal` | CCGUK-Letterhead-Formal.docx | letter | Letter on CCGUK letterhead | at_fault_insurer (changeable) | recipient | — |

`builtinAssetPath(id)` resolves the asset with `new URL('../../../../assets/docx/<file>', import.meta.url)` (works from
source and from the packaged `app/packages/documents`). Built-ins are read-only files that ship with the app; the database
row only caches their scan and holds a user override layer for the mapping.

### C.2 Uploaded templates on disk

`TEMPLATES_DIR` (config; default `<DATA_DIR>/templates`; the launcher sets it to `%LOCALAPPDATA%\ClaimDesk\data\templates`).
Files: `TEMPLATES_DIR/<templateId>/v<fileVersion>-<sha256[0..12]>.docx`. Files are immutable; a replacement upload adds a
new file and bumps `file_version`; older files stay for audit. Paths stored in the DB are relative to `TEMPLATES_DIR` and
resolved with `assertInsideStore`. Uploads never go under the app folder (replaced on upgrade).

### C.3 Database (migration `0004_document_templates.sql`, templates-api slice)

```sql
CREATE TABLE `document_templates` (
  `id` text PRIMARY KEY NOT NULL,
  `source` text NOT NULL,                       -- 'builtin' | 'uploaded'
  `kind` text NOT NULL,                         -- TemplateKind
  `title` text NOT NULL,
  `description` text,
  `recipient_role` text,
  `file_name` text NOT NULL,                    -- original upload name / asset name
  `file_path` text,                             -- uploads: relative to TEMPLATES_DIR; built-ins: NULL
  `sha256` text NOT NULL,
  `bytes` integer NOT NULL,
  `file_version` integer DEFAULT 1 NOT NULL,
  `mapping_revision` integer DEFAULT 0 NOT NULL,
  `scan_version` integer NOT NULL,
  `scan` text NOT NULL,                         -- JSON DocxScan without `text` (text is recomputed on demand)
  `mapping` text,                               -- JSON TemplateMapping (uploads) | override layer (built-ins) | NULL
  `warnings` text DEFAULT '[]' NOT NULL,        -- JSON TemplateWarning[]
  `warnings_acknowledged_at` text,
  `warnings_acknowledged_by` text,
  `active` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `created_by` text NOT NULL,
  `updated_at` text NOT NULL,
  `updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `document_templates_source_idx` ON `document_templates` (`source`);
--> statement-breakpoint
CREATE INDEX `document_templates_sha_idx` ON `document_templates` (`sha256`);
--> statement-breakpoint
ALTER TABLE `documents` ADD `format` text DEFAULT 'html' NOT NULL;
--> statement-breakpoint
ALTER TABLE `documents` ADD `docx_path` text;
--> statement-breakpoint
ALTER TABLE `documents` ADD `docx_sha256` text;
--> statement-breakpoint
ALTER TABLE `documents` ADD `pdf_converter` text;
```

Drizzle (`schema.ts`): `documentTemplates` table; `documents` gains `format` (`'html' | 'docx'`), `docxPath`,
`docxSha256`, `pdfConverter`. Domain `GeneratedDocument` gains `format?: 'html' | 'docx'; docxPath?: string;
docxSha256?: string; pdfConverter?: 'word' | 'libreoffice' | 'browser' | 'chromium-html'`.

`documents.html` stays NOT NULL: for DOCX documents it holds `docxToPreviewHtml(filled)`. `documents.sha256` keeps its
meaning (draft: hash of the primary artefact = the DOCX; after approval: hash of the PDF). `documents.data_snapshot._docx`
holds the reproducibility record:

```ts
interface DocxSnapshot {
  templateId: string; templateSha256: string; fileVersion: number; mappingRevision: number; scannerVersion: number;
  variant?: string; subject?: { witnessPartyId?: string; offerId?: string; hireAgreementId?: string; recipientPartyId?: string; exhibitEvidenceIds?: string[] };
  inputs: Record<string, SlotInput>;      // what the handler typed (re-used on supersede)
  confirm: string[];
  values: Array<{ slotId: string; key?: string; display: string; origin: PlanRow['origin']; verification?: VerificationStatus }>;
  removedBlocks: string[];
  docxSha256: string;
}
```

Repo `packages/db/src/repos/documentTemplates.ts`:

```ts
export interface DocumentTemplateRow { id: string; source: 'builtin' | 'uploaded'; kind: TemplateKind; title: string; description?: string; recipientRole?: RecipientRole; fileName: string; filePath?: string; sha256: string; bytes: number; fileVersion: number; mappingRevision: number; scanVersion: number; scan: unknown; mapping?: unknown; warnings: TemplateWarning[]; warningsAcknowledgedAt?: string; warningsAcknowledgedBy?: string; active: boolean; createdAt: string; createdBy: string; updatedAt: string; updatedBy: string }
export interface TemplateWarning { code: 'LEGACY_DETAIL' | 'BANNED_PHRASE' | 'REGULATED_STATUS' | 'BRAND_CLAIM_IMAGE' | 'TRACKED_CHANGES' | 'COMMENTS' | 'LEGACY_FORM_FIELDS' | 'EXTERNAL_IMAGE' | 'EMBEDDED_OBJECT' | 'UNMAPPED_SLOTS'; message: string; excerpt?: string }
export function listDocumentTemplates(db: Db, opts?: { includeInactive?: boolean }): DocumentTemplateRow[];
export function getDocumentTemplate(db: Db, id: string): DocumentTemplateRow | undefined;
export function requireDocumentTemplate(db: Db, id: string): DocumentTemplateRow;
export function upsertBuiltinTemplate(db: Db, row: Omit<DocumentTemplateRow, 'createdAt' | 'updatedAt' | 'mapping' | 'mappingRevision' | 'active' | 'warningsAcknowledgedAt' | 'warningsAcknowledgedBy'>, actor: Actor): DocumentTemplateRow;  // keeps mapping/ack/active; resets ack when sha256 changes
export function createUploadedTemplate(db: Db, row: …, actor: Actor): DocumentTemplateRow;
export function replaceTemplateFile(db: Db, id: string, file: { fileName; filePath; sha256; bytes; scan; scanVersion; warnings }, actor: Actor): DocumentTemplateRow;  // file_version+1, ack reset
export function saveTemplateMapping(db: Db, id: string, mapping: TemplateMapping | null, actor: Actor): DocumentTemplateRow;  // mapping_revision+1
export function patchDocumentTemplate(db: Db, id: string, patch: { title?: string; description?: string; active?: boolean; recipientRole?: RecipientRole | null }, actor: Actor): DocumentTemplateRow;
export function acknowledgeTemplateWarnings(db: Db, id: string, actor: Actor): DocumentTemplateRow;
```

All writes audit (`docx_template.create|replace|mapping|patch|acknowledge|sync`). `createDraft`/`supersedeDocument`
accept the new document columns.

### C.4 Upload pipeline

1. Route-level size limit 15 MiB (`request.file({ limits: { fileSize } })`); exactly one file part named `file`;
   extension `.docx` or `.dotx`.
2. `checkDocxSafety(bytes)` (§A.3) → 400 `INVALID_DOCX` with the issue list on any error.
3. `scanDocx(bytes)` (with the paragraph cap) → 400 `INVALID_DOCX` on `DocxError`; 422 `NO_FILLABLE_SLOTS` when it finds
   no slots ("Add `{{claim.reference}}`-style tokens, `[brackets]`, `____` blanks or empty cells next to labels").
4. Duplicate: an active uploaded template with the same sha256 → 409 `TEMPLATE_DUPLICATE` (`details.id`).
5. Warnings: `findBlockedStrings`/`findBannedPhrases` (documents guards) and domain `legacyCheck`/`bannedPhraseCheck` on
   `scan.text` → `TemplateWarning`s; tracked changes/comments/legacy fields/external images/embedded objects from the
   safety report; `UNMAPPED_SLOTS` after auto-mapping.
6. Store file, insert row with `mapping = suggestMapping(scan)` converted to exact-id entries **only for suggestions with
   score ≥ 0.75**, audited. Response: `DocxTemplateDetail` (§C.5).

Built-in sync at API boot (`syncBuiltinTemplates(ctx)` in `services/docxTemplates.ts`): for each built-in, hash the asset;
when the row is missing, the sha256 changed or `scan_version < SCANNER_VERSION`, re-scan and upsert; warnings include
`LEGACY_DETAIL` for 01/02 (`Car Flex Ltd`/`CarFlex …`), `REGULATED_STATUS` for the letterhead (`our client`) and
`BRAND_CLAIM_IMAGE` for every template whose first-page footer carries the accreditation strip (`Compliant with theGTA`;
declared in the built-in metadata as `knownWarnings`). Sync never throws at boot; failures log and mark the template
inactive with a warning.

### C.5 API routes (`apps/api/src/routes/docxTemplates.ts`, mounted under `/api`)

Schemas in `apps/api/src/schemas/docxTemplates.ts` (zod). All responses JSON unless stated. All writes audited.

| Method & path | Body / query | Response | Errors |
|---|---|---|---|
| `GET /docx-templates` | `?includeInactive=true` | `{ items: DocxTemplateSummary[] }` | — |
| `POST /docx-templates` | multipart: `file`, `title`, `kind` (`letter\|form\|agreement\|statement\|report\|notice`), `description?`, `recipientRole?` | 201 `DocxTemplateDetail` | 400 `INVALID_DOCX`, 409 `TEMPLATE_DUPLICATE`, 413, 422 `NO_FILLABLE_SLOTS` |
| `GET /docx-templates/:id` | — | `DocxTemplateDetail` | 404 |
| `PATCH /docx-templates/:id` | `{ title?, description?, active?, recipientRole? }` | `DocxTemplateSummary` | 404 |
| `POST /docx-templates/:id/acknowledge` | `{}` | `DocxTemplateSummary` | 404 |
| `PUT /docx-templates/:id/mapping` | `{ entries: MappingEntry[] (slot = exact id), ignore?: string[] }` | `DocxTemplateDetail` | 400 `MAPPING_INVALID` (`details.issues`) |
| `DELETE /docx-templates/:id/mapping` | — (built-ins: reset to default) | `DocxTemplateDetail` | 400 for uploads |
| `POST /docx-templates/:id/file` | multipart `file` (uploaded templates only: new version) | `DocxTemplateDetail` (+ `carriedOver`, `dropped` slot ids) | as POST |
| `GET /docx-templates/:id/file` | — | the original .docx (`content-disposition: attachment`) | 404 |
| `POST /docx-templates/:id/test-fill` | `{ claimId?: string, variant?: string }` | filled .docx, not stored (sample merge source when no claim) | 404 |
| `GET /claims/:id/docx-templates/:templateId/values` | `?variant&witnessPartyId&offerId&hireAgreementId&recipientPartyId&exhibitEvidenceIds=a,b` | `ClaimTemplateValues` | 404, 409 `TEMPLATE_WARNINGS_UNACKNOWLEDGED` (returned as an issue, not an error, here) |
| `POST /claims/:id/docx-documents` | `GenerateDocxBody` | 201 `GeneratedDocument` (format `docx`, status `draft` or `blocked`) | 400 `VALUES_REQUIRED`/`SLOT_NOT_FILLABLE`/`VALIDATION`, 409 `TEMPLATE_WARNINGS_UNACKNOWLEDGED`/`TEMPLATE_CHANGED`/`GUARD_BLOCKED`, 404 |
| `GET /documents/:id/docx` | — | the stored .docx, re-hashed (`x-sha256`), `content-disposition: attachment; filename="<reference> <title>.docx"` | 404, 409 `DOCUMENT_DOCX_TAMPERED` |
| `GET /documents/:id/letterhead.docx` | — | HTML letter recomposed on CCGUK-Letterhead-Formal (not stored; `x-sha256`; audit `document.letterhead_docx`) | 400 `NOT_A_LETTER`, 422 `LETTER_NOT_EXTRACTABLE` |
| `GET /docx-converters` | `?refresh=true` | `{ preference, order, available: Record<'word'\|'libreoffice'\|'browser', ConverterStatus> }` | — |

```ts
interface DocxTemplateSummary {
  id: string; format: 'docx'; source: 'builtin' | 'uploaded'; kind: string; title: string; description?: string;
  recipientRole?: string; fileName: string; fileVersion: number; mappingRevision: number; sha256: string; bytes: number;
  slotCount: number; mappedCount: number; ignoredCount: number; unmappedCount: number;
  warnings: TemplateWarning[]; warningsAcknowledged: boolean; active: boolean;
  subjects: SubjectKind[]; variants: Array<{ id: string; label: string; default?: boolean }>; updatedAt: string;
}
interface DocxTemplateDetail extends DocxTemplateSummary {
  slots: DocxSlot[]; blocks: DocxBlock[]; outline: DocxScan['outline'];
  mapping: Array<{ slotId: string; key?: string; policy: FillPolicy; format?: FormatName; when?: string; required?: boolean; removeIfEmpty?: 'paragraph' | 'row'; label?: string; origin: 'builtin' | 'saved' | 'suggested' | 'none'; score?: number; ignored: boolean }>;
  mappingIssues: MappingIssue[];
  fields: Array<{ key: string; group: string; label: string; type: FieldType; policy: FillPolicy }>;   // dictionary for the editor's select
}
interface ClaimTemplateValues {
  template: DocxTemplateSummary; claimId: string; variant?: string;
  subjects: { witnesses?: Array<{ id: string; name: string }>; offers?: Array<{ id: string; label: string }>; hires?: Array<{ id: string; label: string }>; recipients?: Array<{ partyId?: string; role: string; label: string }>; exhibits?: Array<{ id: string; label: string }> };
  groups: Array<{ section: string; title: string; rows: PlanRow[] }>;
  issues: FillPlan['issues'];
  summary: { fromClaim: number; toConfirm: number; toEnter: number; leftForSigning: number; leftAsPrinted: number };
}
interface GenerateDocxBody {
  templateId: string; variant?: string;
  subject?: { witnessPartyId?: string; offerId?: string; hireAgreementId?: string; recipientPartyId?: string; exhibitEvidenceIds?: string[] };
  values?: Record<string, SlotInput>;   // slotId → handler input; null = leave blank
  confirm?: string[];                   // slotIds of suggested rows the handler confirmed
}
```

### C.6 Generation pipeline (`apps/api/src/services/docxDocuments.ts`)

```ts
export function buildMergeSource(ctx: AppContext, claimId: string, user: DocUser, subject?: GenerateDocxBody['subject']): MergeSource;   // services/mergeSource.ts
export function claimTemplateValues(ctx: AppContext, claimId: string, templateId: string, user: DocUser, q: ValuesQuery): ClaimTemplateValues;
export async function createDocxClaimDocument(ctx: AppContext, input: { claimId: string; body: GenerateDocxBody; user: DocUser; actor: Actor; supersedes?: GeneratedDocument }): Promise<GeneratedDocument>;
```

1. Load the template row; refuse inactive (404) and unacknowledged warnings (409). Read bytes (built-in asset or
   `TEMPLATES_DIR` file) and verify `sha256` (409 `TEMPLATE_CHANGED` on mismatch). Re-scan if `scan_version` is stale.
2. Effective mapping: built-in JSON ⊕ override, or the saved upload mapping. `validateMapping` must be clean (issues →
   409 `TEMPLATE_CHANGED` with details; the Templates screen shows them).
3. `recomputeClocks`, then `buildMergeSource` (bundle + own insurer + users + fleet unit/vehicle/policy + merged GTA rates
   + recipient via `resolveRecipient` + `responseDeadline` via `deadline()`).
4. `buildFillPlan`; any `block` issue → 400 `VALUES_REQUIRED` / `SLOT_NOT_FILLABLE` or 409 `GUARD_BLOCKED` with the issue list.
5. `fillDocx` with `coreProps { title: `${template.title} — ${claim.reference}`, subject: template.title, keywords:
   [claim.reference, templateId] }` and the plan's `removeBlocks`.
6. `docxToPreviewHtml` → `html`; `runConsistency(ctx, html, bundle, canonicalTemplateId(templateId), role, now)`;
   **baseline suppression**: flags whose `code` and normalised excerpt also occur when the same check runs on the
   unfilled template's text are moved to the report's suppressed list with reason `TEMPLATE_BASELINE` (allowed only
   because the warnings were acknowledged; the acknowledgement user/time is recorded in the snapshot). Guard `warn`
   results become consistency flags (severity warn).
7. Write `DOCUMENTS_DIR/<claimId>/<docId>.docx`; one transaction: `repos.createDraft({ format: 'docx', html, sha256:
   docxSha, docxPath, docxSha256, dataSnapshot: { _docx, claim header, settings summary } })` (or `supersedeDocument`),
   `setConsistency`, audit `document.create` with `{ format: 'docx', templateSha256, docxSha256 }`.

Lifecycle changes in `services/documents.ts`:

- `renderDocumentPdf`: `format === 'docx'` → read and verify the DOCX (409 `DOCUMENT_DOCX_TAMPERED`) →
  `convertDocxToPdf(docx, { workDir: <DATA_DIR>/tmp/convert, metadata })` → write `<docId>.pdf` → return
  `{ pdf, sha256, converter }`; HTML documents unchanged except `metadata` passed to `renderPdf`. The registered office
  passed to `renderPdf` comes from `formatRegisteredOffice(settings.registeredOffice)` (branding slice helper).
- `approveDocument`: unchanged flow; stores `pdf_converter`; audit `document.pdf` includes the converter and the attempt log.
- `supersedeDocument`: for DOCX documents re-runs `createDocxClaimDocument` with the old `_docx.inputs`/`confirm`/subject
  merged with any new `values` in the request body.
- `sendDocument`, e-sign, `readDocumentPdf`: unchanged (they work on the PDF and `doc.sha256`).
- `SEMANTIC_SEND_EVENT`, `defaultRecipientRole`, `AT_FAULT_INSURER_TEMPLATES` look-ups go through
  `canonicalTemplateId` (§C.8).

### C.7 HTML letters on the letterhead and the restyled HTML header

- **DOCX on letterhead for every HTML letter** (`kind === 'letter'`): `GET /documents/:id/letterhead.docx` →
  `extractLetterContent(doc.html)` (`packages/documents/src/letterContent.ts`, templates-api slice) →
  `composeLetterheadDocx(letterheadBytes, content, { replaceFixedOpening: true })`. The HTML from `baseLayout` carries
  `data-letter-part` attributes (branding slice adds them, §H.3) so extraction is exact:
  `recipient` (with `data-line` children and `data-email`), `ref-our`, `ref-your`, `ref-claim`, `ref-client`,
  `ref-vehicle`, `ref-accident`, `ref-date`, `salutation`, `subject`, `body` (each top-level `<p>`/list item becomes one
  numbered paragraph; tables become tab-separated lines), `reply-by`, `valediction`, `signatory-name`, `enclosures`,
  `cc`.
  ```ts
  export function extractLetterContent(html: string): LetterContent | null;   // null when the HTML has no data-letter-part="body"
  ```
- **Restyled HTML header/footer** (branding slice): the HTML masthead mirrors the letterhead's first-page header — logo
  left; right block `COURTESY CARS GROUP UK LTD` / `44 Syon Lane, Isleworth, London TW7 5NQ` / `Case handler 07425 475922
  · Office 020 7052 5403` / `claims@courtesycars.net · www.courtesycars.net` / `Company no. 17430389`. The Playwright
  running header becomes `COURTESY CARS GROUP UK LTD | Our ref <ref>` left and `PAGE n OF N` right; the footer keeps the
  status line and the Part 6 disclosure (exact text "Registered in England and Wales, company number 17430389" stays —
  tests depend on it) and adds the letterhead contact line. The accreditation image is **not** used in HTML documents.

### C.8 Canonical template ids (`packages/domain/src/templateIds.ts`, templates-api slice)

```ts
export const DOCX_TEMPLATE_EQUIVALENTS: Readonly<Record<string, string>> = {
  'agreement.ccguk_03_credit_hire': 'agreement.credit_hire',
  'statement.ccguk_04_witness': 'statement.witness',
  'form.ccguk_07_statement_of_means': 'form.statement_of_means',
  'form.ccguk_08_intervention_mitigation': 'form.mitigation_questionnaire',
};
export function canonicalTemplateId(id: string): string;   // equivalent HTML id, else the id itself
```

Used by `acceptance/assess.ts` (the `form.statement_of_means` test), `gta/payment.ts` (payment-pack prefixes
`form.mitigation*`), the consistency at-fault-insurer template list, and the API's `SEMANTIC_SEND_EVENT`. E-sign rules
already key on the `agreement.` prefix, and the web `canSign` regex already accepts `agreement.|form.|statement.`.

### C.9 Web flows (templates-web slice)

**Settings → Document templates** (`/settings/templates`, linked from a card on the Settings page):

- Table: Title, Kind, Source (`Built-in` navy / `Uploaded` blue badge), Version, Mapped `x of y` (amber when unmapped > 0),
  Warnings (amber badge with count; "Needs review"), Active toggle, Updated. Row click → detail.
- "Upload a Word template" → Modal: file input (`accept=".docx,.dotx"`), Title, Kind select, Description, recipient
  select; inline guidance: "Put `{{claim.reference}}`-style fields, `[brackets]`, `____` blanks or empty cells next to
  labels where values should go. Signature and date-signed lines are always left blank." Submit (`FormData`) → detail page.
- Converter card: "PDFs are produced with: Microsoft Word (found) / LibreOffice (not found) / built-in browser (always
  available)" from `GET /docx-converters`.

**Template detail / mapping editor** (`/settings/templates/:id`):

- Header: title, kind, version, sha256 (first 12), buttons Download original, Upload new version (uploads), Download a
  test copy (claim picker: `Select` of recent claims or "Sample data") → `POST …/test-fill` blob download.
- Warnings card: each warning with excerpt; "I have reviewed this wording" → `POST …/acknowledge` (records who/when).
  Generation is disabled until acknowledged.
- Mapping table grouped by section (outline order): Slot (label, kind badge, qualifier chip, `preview` in mono), Field
  (`Select` grouped by field group with "Handler fills" and "Leave as printed"), Policy (`Select`; options stricter than
  the field default only), Options popover (`when` for checkboxes, format, required, remove-if-empty), Status badge
  (`Built-in`, `Saved`, `Suggested 0.82`, `Not mapped`), signature slots locked ("Signed by hand"). Save → `PUT …/mapping`;
  built-ins get "Reset to default". Mapping issues shown above the table.

**Claim → Documents → "Fill a CCGUK template"** (button next to "New document"):

1. **Choose** (Modal `lg`): template cards grouped Agreements / Forms / Statements / Letters / Your templates; variant
   `Select` when the template has variants (03: "Hirer copy (without the internal enforceability page)" / "Office copy");
   subject `Select`s when required (witness party, intervention offer or "No offer made", hire agreement, letter
   recipient, exhibit evidence multi-select).
2. **Check the values**: `GET …/values`. Summary line "18 filled from the claim · 4 to confirm · 6 to enter · 9 left
   for signing". Sections collapsible; each row: label, input by `inputType` (TextInput, TextArea, DateInput,
   DateTimeInput, MoneyInput, Checkbox, Select/multi-checkbox for choice, a small row editor for `rows`, a list editor for
   `paragraphs`), origin badge (`From claim` green, `Suggested — tick to confirm` amber with a Checkbox, `Enter` grey,
   `Signed by hand — left blank` disabled, `Left as printed` disabled), source path tooltip, verification badge for GTA
   figures with the benchmark caveat, required marker, narrow-cell hint ("This box is about 2 cm wide — keep it short").
   Issues panel at the top (blocks in red, warnings in amber). Edits are kept in component state; "Refresh from claim"
   re-fetches.
3. **Generate** → `POST /claims/:id/docx-documents` with `values` (only rows the handler changed or entered), `confirm`,
   `variant`, `subject` → navigate to `documents/:docId`.

**Document view** for `format === 'docx'`: lazy-loaded `docx-preview` renders `/api/documents/:id/docx` in a scrollable
paper-style container (fallback: the stored preview HTML in the existing sandboxed iframe); buttons "Download Word
(.docx)" and "Download PDF" (after approval; drafts show "The PDF is made when the document is approved"); "Values used"
panel from `dataSnapshot._docx.values`; converter badge after approval ("PDF made with Microsoft Word"). Approve / Send /
Sign / Supersede work as for HTML documents. HTML letters get "Download on letterhead (Word)" →
`/api/documents/:id/letterhead.docx`.

---

## D. Vehicle catalogue

### D.1 Files

```
packages/kb/data/vehicle-catalogue/
  README.md                  data notes, schema summary, sources/verification statement, attribution
  index.json                 generated: one summary row per make (built by scripts/build-catalogue-index.mjs)
  features.json              global features & extras vocabulary (§D.3)
  makes/<make-slug>.json     one file per make (§D.2), ~74 files (Appendix 3)
  reference/uk-licensing-models.json   OPTIONAL coverage reference extracted once from @meterapp/vehicle-db (OGL v3.0 attribution)
packages/kb/data/gta-segment-defaults.json   segment → GTA group starting suggestions (vehicles-backend slice)
packages/kb/scripts/check-catalogue.mjs      plain-Node validator + quality report (data slice)
packages/kb/scripts/build-catalogue-index.mjs
packages/kb/src/catalogue/                   types, normalise, load, query (vehicles-backend slice)
```

### D.2 Make file schema (normative)

The compact form below is what the data authors write; the loader normalises it (§D.5). A draft of nine makes in exactly
this schema already exists in scratch (`/tmp/claude-0/-home-user-logo/811a135a-35cb-5723-858d-e84fbd9027fa/scratchpad/catalogue/makes/`:
Audi, BMW, Cupra, Ford, Mini, SEAT, Skoda, Vauxhall, Volkswagen) and may be reviewed and adopted.

```ts
export type CatalogueVehicleType = 'car' | 'van' | 'pickup' | 'minibus' | 'camper';
export type CatalogueSegment =
  | 'city' | 'supermini' | 'small-family' | 'large-family' | 'executive' | 'luxury' | 'sports' | 'supercar'
  | 'mpv-small' | 'mpv-large' | 'suv-small' | 'suv-medium' | 'suv-large' | 'suv-luxury'
  | 'pickup' | 'van-small' | 'van-medium' | 'van-large' | 'minibus';
export type CatalogueBody =
  | 'hatchback' | 'saloon' | 'estate' | 'coupe' | 'convertible' | 'suv' | 'crossover' | 'mpv' | 'pickup' | 'panel-van'
  | 'crew-van' | 'chassis-cab' | 'minibus' | 'roadster' | 'fastback' | 'liftback' | 'shooting-brake' | 'camper';
export type CatalogueFuel = 'petrol' | 'diesel' | 'hybrid' | 'mild-hybrid' | 'plug-in-hybrid' | 'electric' | 'lpg' | 'hydrogen';
export type CatalogueTransmission = 'manual' | 'automatic';

export interface CatalogueMakeFile {
  make: string;                         // display name as on the V5C/brochure: 'Mercedes-Benz', 'SEAT', 'Citroën'
  slug: string;                         // slugify(make): 'mercedes-benz', 'seat', 'citroen'
  dvlaNames: string[];                  // upper-case spellings DVLA/VES/TCC use: ['MERCEDES-BENZ', 'MERCEDES']
  aliases: string[];                    // other spellings people type: ['Mercedes', 'Merc']
  verification: { status: 'unverified'; sourceNote: string };   // always unverified
  models: CatalogueModel[];
}
export interface CatalogueModel {
  name: string;                         // 'Golf', 'A-Class', '3 Series', 'Transit Custom'
  slug: string;                         // unique within the make
  aliases: string[];                    // 'Golf GTI', 'e-Golf', 'A180' … (used by matchCatalogue)
  vehicleType: CatalogueVehicleType;
  segment: CatalogueSegment;
  years: { from: number; to: number | null };   // UK new-sale years, clamped to ≥ 2000; null = still on sale (2026)
  gtaGroup?: string;                    // optional model-level suggestion (unverified)
  generations: CatalogueGeneration[];
}
export interface CatalogueGeneration {
  name: string;                         // 'Mk7 (2012–2020)' — code + real years (+ '; facelift 2017' if useful)
  id?: string;                          // optional; loader derives `${makeSlug}-${modelSlug}-${slugify(name)}`
  from: number; to: number | null;      // UK sale years for this generation, clamped to ≥ 2000
  bodies: Array<{ body: CatalogueBody; doors: number[]; seats: number[] }>;
  trims: Array<string | CatalogueTrim>; // UK trim names in brochure spelling: 'S', 'SE', 'Match', 'GT', 'R-Line', 'GTI'
  engines: Array<string | CatalogueEngine>;
  fuels: CatalogueFuel[];               // union of the engines' fuels
  transmissions: CatalogueTransmission[];
  gtaGroup?: string;                    // optional generation-level suggestion (unverified)
  note?: string;
}
export interface CatalogueTrim {
  name: string; from?: number; to?: number | null;
  bodies?: CatalogueBody[];             // when the trim is limited to some bodies
  engines?: string[];                   // engine labels (or ids) the trim was sold with
  features?: string[];                  // feature ids standard on the trim (features.json)
  gtaGroup?: string;
}
export interface CatalogueEngine {
  label: string;                        // '2.0 TDI 150PS diesel'
  cc?: number;                          // exact when known; else derived from litres (ccApprox)
  fuel: CatalogueFuel;
  powerPs?: number; powerKw?: number; batteryKwh?: number;
  transmissions?: CatalogueTransmission[];
  from?: number; to?: number | null;
}
```

**Engine string grammar** (compact form): `[<litres>] <name words…> <power>PS <fuel>` where `<litres>` is `\d\.\d`
(e.g. `1.6`), `<power>PS` is `\d+PS`, and `<fuel>` is the **last** token and one of the `CatalogueFuel` values
(`mild-hybrid petrol`/`mild-hybrid diesel` allowed as the last two tokens). Electric engines omit litres and may carry
`<n>kWh` (`ID.3 Pro 58kWh 204PS electric`). Examples: `1.0 EcoBoost 125PS petrol`, `2.0 TDI 150PS diesel`,
`1.4 TSI 204PS plug-in-hybrid`, `2.0 EcoBlue 130PS mild-hybrid diesel`, `Model 3 Long Range 498PS electric`.

Validation rules (`check-catalogue.mjs` and the loader enforce the same):

- `slug`s match `/^[a-z0-9]+(-[a-z0-9]+)*$/` and equal `slugify(name)` unless explicitly different and unique.
- `years.from` ≥ 2000, `to` ≤ 2026 or null; generation ranges inside the model range and ordered; a model's
  `years.from` = min of its generations.
- `bodies` non-empty; `doors` ⊂ {2,3,4,5}; `seats` ⊂ 1..9 (minibus up to 17).
- `trims` ≥ 1 per generation (cars), engines ≥ 1, every engine string parses, `fuels` = union of engine fuels,
  `transmissions` non-empty; electric engines → transmissions `automatic`.
- `gtaGroup` matches `/^[A-Z]{1,3}\d{0,2}$/`.
- No duplicate model slugs within a make; no duplicate aliases across models of a make.
- File size ≤ 600 KB per make.

### D.3 Features and extras (`features.json`)

```ts
export interface FeatureVocabulary {
  schemaVersion: 1;
  categories: Array<{ id: string; label: string; items: Array<{ id: string; label: string; aliases?: string[]; kind: 'feature' | 'extra' | 'both' }> }>;
}
```

Categories (ids fixed): `safety`, `driver_assistance`, `parking`, `lighting`, `climate`, `seats_interior`,
`infotainment`, `exterior`, `wheels_tyres`, `security`, `towing_load`, `ev_charging`, `accessibility`, `performance`,
`commercial` (van racking, ply lining, tail lift, bulkhead …). At least 150 items, e.g. `aeb` "Autonomous emergency
braking", `adaptive_cruise`, `lane_keep_assist`, `blind_spot`, `rear_camera`, `360_camera`, `parking_sensors_front`,
`led_headlights`, `matrix_led`, `climate_control_dual`, `heated_seats_front`, `heated_steering_wheel`, `leather`,
`electric_seats`, `sat_nav`, `apple_carplay`, `android_auto`, `dab`, `bluetooth`, `panoramic_roof`, `sunroof`,
`privacy_glass`, `alloy_wheels_17`, `alloy_wheels_18`, `run_flat_tyres`, `spare_wheel`, `alarm`, `tracker`,
`tow_bar`, `roof_rails`, `roof_bars`, `type2_cable`, `three_pin_cable`, `heat_pump`, `wheelchair_access`,
`hand_controls`, `swivel_seat`, `dash_cam`, `ply_lining`, `roof_rack`, `tail_lift`. `kind` says whether it is usually
standard (`feature`), an added option/after-market fit (`extra`), or either (`both`). Accessibility items matter for
like-for-like hire.

### D.4 Coverage and quality bar (data slice)

- **Every make** in Appendix 3 sold new in the UK in 2000–2026, **every model** (cars and light commercials ≤ 3.5 t,
  including EV/PHEV derivatives, UK-market RHD only, no grey imports), **every generation** with UK sale years,
  **body types with door and seat counts**, **UK trim names** for each generation (the main brochure grades plus
  performance and long-running named editions; not every limited run), **engines** with litres/cc, power (PS) and fuel,
  and **transmissions** (manual/automatic availability).
- `dvlaNames` must include the spelling DVLA prints (upper case, e.g. `LAND ROVER`, `MERCEDES-BENZ`, `CITROEN`,
  `SSANGYONG`, `KGM`); `aliases` include common spellings and former names (`KGM` ↔ `SsangYong`, `Opel` is **not** a UK
  make — Vauxhall).
- Segment per model (Appendix 3 lists defaults); optional `gtaGroup` only when there is a reason to differ from the
  segment default (§D.6).
- Coverage check: `check-catalogue.mjs --reference reference/uk-licensing-models.json` lists DfT/DVLA licensing models
  (2005–2025) with no catalogue match (by `matchCatalogue` aliases); the bar is ≤ 5 % of the reference models unmatched for each
  priority make (Appendix 3), and every unmatched entry has a reason in `README.md` (e.g. pre-2000 only, specialist
  conversion, heavy commercial).
  The reference is extracted once from `@meterapp/vehicle-db@2.14.0` (a tarball is in scratch:
  `wf2/meterapp-vehicle-db-2.14.0.tgz`; extraction script `wf2/vdbsize.mjs`) and is not a runtime dependency.
- Honesty: every file says `verification.status: 'unverified'` with a source note ("Compiled from general knowledge of
  the UK market 2000–2026; confirm against the V5C, DVLA record or Total Car Check"). No invented precision: use
  litres-only engine strings when the exact cc is not known.

### D.5 Loader and queries (`packages/kb/src/catalogue/`, vehicles-backend slice)

```ts
export interface CatalogueMakeSummary { slug: string; make: string; dvlaNames: string[]; aliases: string[]; modelCount: number; years: { from: number; to: number | null }; vehicleTypes: CatalogueVehicleType[]; custom?: boolean }
export interface NormalisedEngine extends CatalogueEngine { id: string; domainFuel: FuelType; mildHybrid?: boolean; ccApprox?: boolean }
export interface NormalisedTrim extends CatalogueTrim { id: string }
export interface NormalisedGeneration extends Omit<CatalogueGeneration, 'trims' | 'engines'> { id: string; trims: NormalisedTrim[]; engines: NormalisedEngine[] }
export interface NormalisedModel extends Omit<CatalogueModel, 'generations'> { makeSlug: string; generations: NormalisedGeneration[]; custom?: boolean }
export interface CatalogueModelSummary { makeSlug: string; slug: string; name: string; vehicleType: CatalogueVehicleType; segment: CatalogueSegment; years: { from: number; to: number | null }; bodies: CatalogueBody[]; custom?: boolean }
export interface CatalogueSearchHit { makeSlug: string; make: string; modelSlug?: string; model?: string; generationId?: string; trimId?: string; score: number; label: string }

export function parseEngineLabel(label: string): NormalisedEngine;          // grammar §D.2
export function catalogueFuelToDomain(f: CatalogueFuel): { fuel: FuelType; mildHybrid?: boolean };   // mild-hybrid → base fuel; plug-in-hybrid → plugin_hybrid; hydrogen → other
export function validateCatalogueMake(raw: unknown, file: string): CatalogueMakeFile;   // throws KbValidationError
export function listCatalogueMakes(): CatalogueMakeSummary[];                // from index.json; falls back to reading every file
export function getCatalogueMake(slug: string): (Omit<CatalogueMakeFile, 'models'> & { models: NormalisedModel[] }) | undefined;   // lazy, cached per make
export function listCatalogueModels(makeSlug: string, opts?: { year?: number; vehicleType?: CatalogueVehicleType }): CatalogueModelSummary[];
export function getCatalogueModel(makeSlug: string, modelSlug: string): NormalisedModel | undefined;
export function generationsForYear(model: NormalisedModel, year: number): NormalisedGeneration[];
export function matchCatalogue(make: string, model?: string): { make?: CatalogueMakeSummary; model?: CatalogueModelSummary; variantRemainder?: string; score: number };   // 'FORD','FIESTA ZETEC' → ford/fiesta + 'Zetec'
export function searchCatalogue(q: string, limit?: number): CatalogueSearchHit[];   // 'golf gti 2019', 'vw polo match'
export function loadFeatureVocabulary(): FeatureVocabulary;
export function loadGtaSegmentDefaults(): Record<CatalogueSegment, string>;
export function resetCatalogueCache(): void;
```

`DATA_FILES` gains `gtaSegmentDefaults: 'gta-segment-defaults.json'`; the catalogue directory is read with `readdirSync`
under `new URL('../../data/vehicle-catalogue/', import.meta.url)`.

### D.6 GTA suggestion

`packages/kb/data/gta-segment-defaults.json` (starting suggestions, unverified, editable in Settings):

```json
{ "schemaVersion": 1,
  "verification": { "status": "unverified", "sourceNote": "ClaimDesk starting suggestions from GTA group descriptions in gta-rates.json; not the GTA vehicle list. Confirm or change in Settings." },
  "defaults": { "city": "S1", "supermini": "S2", "small-family": "S3", "large-family": "S4", "executive": "S5", "luxury": "S6",
    "sports": "S6", "supercar": "S6", "mpv-small": "M", "mpv-large": "M2", "suv-small": "M1", "suv-medium": "M2",
    "suv-large": "M3", "suv-luxury": "F6", "pickup": "CP1", "van-small": "PV1", "van-medium": "PV2", "van-large": "PV3", "minibus": "PV3" } }
```

Domain (`packages/domain/src/gta/suggest.ts`, pure; kb is not imported by domain, so the API passes the catalogue facts):

```ts
export type GtaSuggestionBasis = 'recorded' | 'custom_override' | 'catalogue_trim' | 'catalogue_generation' | 'catalogue_model' | 'segment_default' | 'heuristic' | 'none';
export interface GtaSuggestInput {
  recordedGroup?: string;                          // vehicle.gtaGroup / fleet unit group already set
  customOverride?: string;                         // vehicle_catalogue_custom override row
  catalogue?: { trimGroup?: string; generationGroup?: string; modelGroup?: string; segment?: string };
  segmentDefaults: Record<string, string>;         // DB overrides ⊕ KB defaults
  vehicle: Pick<Vehicle, 'make' | 'model' | 'variant' | 'bodyType' | 'engineCapacityCc' | 'fuelType'>;   // for mapGtaGroup fallback
  date: ISODate;
  rates: GtaRate[];                                // merged rates
}
export interface GtaSuggestion {
  group: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  basis: GtaSuggestionBasis;
  reason: string;                                  // one plain sentence
  segment?: string;
  rate: (GtaRate & { origin?: 'kb' | 'manual' }) | null;   // gtaRate(group, date, rates)
  note: string;                                    // GTA_NON_SUBSCRIBER_NOTE + 'suggestion only — confirm the group'
}
export function suggestGtaGroup(input: GtaSuggestInput): GtaSuggestion;
```

Order: recorded (high) → custom override (medium) → catalogue trim → generation → model (medium) → segment default (low)
→ `mapGtaGroup` heuristic (low) → none. When the group has no rate on the date: `rate: null` and the reason says "No
benchmark rate is loaded for group X on <date> — add it in Settings → GTA benchmark rates".

### D.7 User additions (`vehicle_catalogue_custom`, migration 0003)

```sql
CREATE TABLE `vehicle_catalogue_custom` (
  `id` text PRIMARY KEY NOT NULL,
  `level` text NOT NULL,                 -- 'make' | 'model' | 'generation' | 'trim' | 'engine'
  `make` text NOT NULL, `make_slug` text NOT NULL,
  `model` text, `model_slug` text,
  `generation_id` text,
  `name` text NOT NULL,                  -- the new entry's display name / engine label
  `data` text NOT NULL,                  -- JSON: partial CatalogueModel | CatalogueGeneration | CatalogueTrim | CatalogueEngine
  `segment` text,
  `gta_group` text,
  `overrides_builtin` integer DEFAULT 0 NOT NULL,   -- 1 = adjusts segment/gta_group of a shipped model/generation/trim (no new entry)
  `created_at` text NOT NULL, `created_by` text NOT NULL,
  `deleted_at` text, `deleted_by` text
);
CREATE INDEX `vehicle_catalogue_custom_make_idx` ON `vehicle_catalogue_custom` (`make_slug`, `model_slug`);
```

Merge (API service `services/catalogue.ts`): custom makes appear in the make list (`custom: true`); custom models in the
model list; custom generations/trims/engines are appended to the shipped lists; override rows replace `segment`/`gtaGroup`
of the shipped entry. Deleting is soft (`deleted_at`). Audit `catalogue.custom.create|delete`.

### D.8 API (`apps/api/src/routes/catalogue.ts`)

| Method & path | Query / body | Response |
|---|---|---|
| `GET /catalogue/makes` | — | `{ items: CatalogueMakeSummary[] }` (shipped ⊕ custom), `cache-control: private, max-age=3600` |
| `GET /catalogue/makes/:make/models` | `?year&vehicleType` | `{ items: CatalogueModelSummary[] }` |
| `GET /catalogue/makes/:make/models/:model` | — | `NormalisedModel` (merged with custom entries) |
| `GET /catalogue/match` | `?make&model` | `{ makeSlug?, modelSlug?, variantRemainder?, score }` |
| `GET /catalogue/search` | `?q&limit` | `{ items: CatalogueSearchHit[] }` |
| `GET /catalogue/features` | — | `FeatureVocabulary` |
| `GET /catalogue/custom` | — | `{ items: CustomCatalogueEntry[] }` |
| `POST /catalogue/custom` | `{ level, make, model?, generationId?, name, data?, segment?, gtaGroup?, overridesBuiltin? }` | 201 `CustomCatalogueEntry` |
| `DELETE /catalogue/custom/:id` | — | 204 |
| `GET /gta/suggest` | `?make&model&generationId&trimId&segment&bodyType&engineCapacityCc&fuelType&recordedGroup&date` | `GtaSuggestion` |

### D.9 `VehiclePicker` (web, `apps/web/src/screens/vehicles/`)

```ts
export interface VehicleSourceInput { provider: 'manual' | 'catalogue' | 'totalcarcheck_manual'; url?: string; pastedText?: string; parsed?: Record<string, unknown>; appliedFields?: string[] }
export interface VehiclePickerValue {
  registration: string;
  make: string; model: string; variant: string;          // variant = trim name (Vehicle.variant)
  bodyType?: string; doors?: number; seats?: number;
  yearOfManufacture?: number; monthOfFirstRegistration?: string;   // 'YYYY-MM'
  fuelType?: FuelType; transmission?: Transmission; engineCapacityCc?: number; powerPs?: number;
  colour?: string; vin?: string; motExpiryDate?: string; taxDueDate?: string;
  catalogue?: VehicleSpec['catalogue']; segment?: string;
  features: string[]; extras: string[];
  source: VehicleSourceInput;
}
export interface VehiclePickerProps {
  value: VehiclePickerValue; onChange(next: VehiclePickerValue): void;
  mode: 'claim' | 'edit' | 'fleet';
  showRegistration?: boolean;            // false in the Vehicle tab (registration is fixed)
  lookupMode: 'live' | 'manual';
  onUseOnFile?(match: OnFileMatch): void;  // FNOL: reuse an existing vehicle
  errors?: Partial<Record<keyof VehiclePickerValue, string>>;
  disabled?: boolean;
}
export function VehiclePicker(props: VehiclePickerProps): JSX.Element;
```

Layout (one component, three uses):

1. **Registration** (when shown) + "Search" — on-file matches (§E.1) as cards with "Use this vehicle"; Total Car Check
   button and paste panel (§E.2–E.3) in `claim`/`edit` modes and in `fleet` mode too.
2. **Make → Year → Model → Generation → Body/doors → Fuel → Engine → Transmission → Trim** cascade: `Select`s fed by the
   catalogue endpoints; type-ahead with `TextInput list=` + `<datalist>` for make and model; each step offers
   "Not listed — type it" (free text) and "Add to catalogue" (posts a custom entry); changing a step clears the later
   ones; picking an engine sets `engineCapacityCc`, `fuelType`, `powerPs`; picking a trim sets `variant` and pre-ticks
   the trim's standard features.
3. **Details**: colour, VIN, first registered (month), MOT expiry, tax due.
4. **Features and extras**: two tabs ("Standard on this vehicle" / "Added extras"), category groups of `Checkbox`es in
   `.check-grid`, search box.

The pure state logic (cascade reset, options from a model detail, applying a parsed paste, applying an on-file match,
building `VehicleSpec` and the API body) lives in `vehiclePickerModel.ts` with unit tests. Uses: New Claim `StepVehicle`
(`claim`), claim Vehicle tab "Edit details" modal (`edit`), Fleet `UnitDialog` (`fleet`, plus the GTA panel §F.1).

### D.10 Persisting the specification

Domain `Vehicle` gains `spec?: VehicleSpec`; `vehicles` gains a JSON `spec` column (migration 0003).

```ts
export interface VehicleSpec {
  catalogue?: { makeSlug: string; modelSlug: string; generationId?: string; trimId?: string; engineId?: string; custom?: boolean };
  segment?: string;
  doors?: number; seats?: number; powerPs?: number;
  drivetrain?: 'fwd' | 'rwd' | 'awd' | '4wd';
  features: string[];   // feature ids
  extras: string[];     // feature ids
  notes?: string;
}
```

`make`, `model`, `variant` (trim), `bodyType`, `engineCapacityCc`, `fuelType`, `transmission`, `colour` stay in their
existing columns. `LookupProvider` gains `'totalcarcheck_manual' | 'catalogue'` (web `LOOKUP_PROVIDER_LABEL`: "Total Car
Check (copied by hand)", "Vehicle catalogue (ClaimDesk)").

---

## E. Vehicle search in manual mode (no DVLA/DVSA keys)

`lookupMode` = `'live'` when `apiKeysPresent.dvlaVes || apiKeysPresent.dvsaMot`, else `'manual'`. Exposed in
`GET /settings` (`lookupMode`) and `GET /health` (`lookups.mode`) by the branding slice; the lookup response carries it too.

### E.1 What a search returns without keys

`POST /vehicles/lookup` keeps its shape and adds fields in **both** branches:

```ts
type VehicleLookupResponse =
  | { status: 'manual_required'; lookupMode: 'manual'; registration: string; fields: readonly string[]; providers: Record<string, string>; vehicle?: Vehicle; onFile: OnFileMatch[]; externalLinks: ExternalVehicleLink[] }
  | { status: 'ok' | 'partial'; lookupMode: 'live'; registration: string; vehicle: Vehicle; providers: Record<string, string>; lookupIds: string[]; onFile: OnFileMatch[]; externalLinks: ExternalVehicleLink[] };

export interface OnFileMatch {
  vehicleId: string; registration: string; match: 'exact' | 'partial';
  make: string; model: string; variant?: string; colour?: string; yearOfManufacture?: number;
  fuelType?: FuelType; transmission?: Transmission; engineCapacityCc?: number; bodyType?: string; spec?: VehicleSpec;
  ownership: Vehicle['ownership'];
  claims: Array<{ id: string; reference: string; openedAt: string }>;
  fleetUnit?: { id: string; status: FleetUnit['status']; gtaGroup: string; dailyRatePence: number };
  lookups: Array<{ provider: LookupProvider; kind: LookupRecord['kind']; requestedAt: string; verification: Verification['status'] }>;
  updatedAt?: string;
}
```

`GET /vehicles/on-file?registration=&limit=10` returns `{ items: OnFileMatch[] }`: the exact normalised registration
first (the `vehicles` row, its claims via `listClaimsForRegistration`, its fleet unit via `findFleetUnitsByRegistration`,
its lookup history — previous manual entries and pastes included), then partial matches (`LIKE` on the normalised
registration, ≥ 4 characters). Read-only; nothing is written by a search.

### E.2 Total Car Check deep link (domain `vehicle/external.ts`)

```ts
export const TOTAL_CAR_CHECK_URL_TEMPLATE = 'https://totalcarcheck.co.uk/FreeCheck?regno={REG}';   // format UNVERIFIED (site unreachable from the build sandbox)
export interface ExternalVehicleLink { id: 'totalcarcheck' | 'gov_mot_history' | 'gov_vehicle_enquiry'; label: string; url: string; note: string; verified: false }
export function totalCarCheckUrl(registration: string, template?: string): string;   // {REG} = normaliseRegistration(reg), URI-encoded; '' for an empty reg
export function externalVehicleLinks(registration: string, opts?: { totalCarCheckTemplate?: string }): ExternalVehicleLink[];
```

Links: Total Car Check (`Open on Total Car Check`, note "Free check in your browser. Copy the details back into ClaimDesk;
they are saved as unverified."), GOV.UK MOT history (`https://www.check-mot.service.gov.uk/`), GOV.UK vehicle enquiry
(`https://vehicleenquiry.service.gov.uk/`). The template is overridable with the env `TOTALCARCHECK_URL_TEMPLATE`
(API config) so a wrong URL can be fixed without a release. The API never requests these URLs.

### E.3 Paste parser (domain `vehicle/parseCheckText.ts`, pure)

```ts
export interface ParsedVehicleCheck {
  fields: Partial<{
    registration: string; make: string; model: string; colour: string; bodyType: string; doors: number; seats: number;
    yearOfManufacture: number; monthOfFirstRegistration: string; firstRegisteredDate: ISODate;
    engineCapacityCc: number; fuelType: FuelType; transmission: Transmission; powerBhp: number; co2Gkm: number;
    euroStatus: string; vin: string; motStatus: string; motExpiryDate: ISODate; taxStatus: string; taxDueDate: ISODate;
    lastMotMileage: number; lastMotDate: ISODate;
  }>;
  matches: Array<{ field: string; label: string; raw: string; line: number }>;
  unmatchedLines: string[];
  warnings: string[];          // e.g. 'The pasted registration AB12CDE differs from CD34EFG'; 'Engine size given in litres — approximate'
}
export function parseVehicleCheckText(text: string, opts?: { expectedRegistration?: string; today?: ISODate }): ParsedVehicleCheck;
```

- Input normalisation: CRLF → LF, NBSP/tabs → spaces where not used as separators, strip zero-width characters, cap at
  20 000 characters.
- Layouts recognised: `Label: Value`; `Label<TAB>Value`; `Label` on one line and `Value` on the next (copying a web
  table); `Label Value` when the label is a known phrase at the start of the line.
- Label synonyms (case-insensitive, Appendix 4) map to fields; first match per field wins; later conflicting matches add a
  warning.
- Value parsers: registration (plate regex, `normaliseRegistration`), dates (`12 March 2027`, `12th Mar 2027`,
  `12/03/2027`, `2027-03-12`, `March 2019` → month precision), cc (`1,598 cc`, `1598cc`, `1.6 litres` → 1600 + warning),
  fuel (domain `mapVesFuelType` plus `Petrol/Electric`, `Hybrid Electric` → hybrid, `Plug-in`/`PHEV` →
  plugin_hybrid, `Electricity`/`EV` → electric, `Diesel/Electric` → hybrid), transmission (`Manual`, `6 Speed Manual` →
  manual; `Automatic`, `Auto`, `CVT`, `DSG`, `Semi-Auto` → automatic), power (`118 bhp`; `120 PS` → bhp × 0.986
  rounded), CO2 (`118 g/km`), colour (title case), year (1950 … today + 1), MOT (`Valid until 12 March 2027`, `Expires:`,
  `Expired`), tax (`Taxed`, `Untaxed`, `SORN` + due date), mileage (`48,210 miles`). A VIN is accepted only when it is a
  full 17-character VIN (partial/masked VINs are ignored with a warning).
- `model` is kept as printed (title case); the caller splits model and trim with `GET /catalogue/match`.
- Tests use synthetic fixtures (three layouts, cookie-banner noise, a different registration, masked VIN) clearly marked
  synthetic; a real pasted sample from the user should be added as a fixture when available (§L).

### E.4 Saving what the user copied

- `PATCH /vehicles/:id` (new) body:

```ts
interface VehiclePatchBody {
  make?: string; model?: string; variant?: string | null; bodyType?: string | null; yearOfManufacture?: number | null;
  monthOfFirstRegistration?: string | null; fuelType?: FuelType | null; transmission?: Transmission | null; colour?: string | null;
  engineCapacityCc?: number | null; vin?: string | null; co2Gkm?: number | null; euroStatus?: string | null;
  taxStatus?: string | null; taxDueDate?: string | null; motStatus?: string | null; motExpiryDate?: string | null;
  gtaGroup?: string | null; spec?: VehicleSpec | null;
  source: VehicleSourceInput;          // required: who/what supplied these values
}
```

  Effect (one transaction): `updateVehicle` with the provided fields; `addLookup` with
  `{ provider: source.provider, kind: source.provider === 'catalogue' ? 'spec' : 'vehicle', requestedAt: now,
  requestedBy: actor, registration, raw: { source: source.provider === 'totalcarcheck_manual' ? 'totalcarcheck_paste' : source.provider,
  url, pastedText (≤ 20 000 chars), parsed, appliedFields }, verification: { status: 'unverified', sourceUrl: url,
  sourceNote: 'Copied by hand from Total Car Check (free check). Not verified — back it with the V5C or MOT certificate.' } }`
  (catalogue: `sourceNote: 'Chosen from the ClaimDesk vehicle catalogue (unverified reference data).'`); audit
  `vehicle.update`. Fields that differ from a **verified** DVLA/DVSA lookup value are saved (handler intent) and returned
  as `warnings: [{ code: 'DIFFERS_FROM_VERIFIED', field, verifiedValue }]`; verified lookups are never changed.
- `POST /vehicles` and claim creation (`resolveVehicle` in `routes/claims.ts`) accept the same `source` and `spec` in the
  vehicle input and record the LookupRecord with that provider (default `manual`).
- The web never sends `verification`; the server sets it.

### E.5 UI flow

- **New Claim → Vehicle** (`StepVehicle`): registration + "Look up". In manual mode the button reads "Search" and the
  notice says "No DVLA/DVSA keys are set up, so ClaimDesk searches its own records. Use Total Car Check to read the
  details, then copy them in." Results panel: on-file matches (Use this vehicle → `{ id }` vehicle ref and a read-only
  summary with "Change details"), Total Car Check button (opens a new tab), paste panel (TextArea + "Read pasted
  details" → table of parsed fields with tick boxes, warnings, unmatched lines collapsible → "Use these details"), then
  the `VehiclePicker` for anything missing. `validateStep(3)` passes with make + model from any source. Live mode keeps
  today's flow and still shows on-file matches.
- **Claim → Vehicle tab**: "Edit details" opens a modal with the picker (`edit` mode) and the TCC/paste panel →
  `PATCH /vehicles/:id`. The "Lookup" button in manual mode opens that modal instead of a warning toast.

---

## F. Fleet: catalogue pick and GTA pre-fill; editable GTA rates

### F.1 Unit dialog

1. Registration (on-file check: a client vehicle on a claim shows the existing `REGISTRATION_ON_CLAIM` message before save).
2. `VehiclePicker` in `fleet` mode.
3. **GTA panel** (`screens/fleet/FleetGtaPanel.tsx`): when make + model (and optionally generation/trim/engine) are set,
   `GET /gta/suggest` with the picker facts and today's date → shows "Suggested GTA group **M1** — from the catalogue
   model (low confidence)" and "Benchmark daily rate **£65.49** (2026-27, unverified)". The GTA group field becomes a
   `Select` of groups that have rates plus "Other…" free entry; the daily rate `MoneyInput` is pre-filled from the
   benchmark. Both show a "pre-filled" hint and stop auto-updating as soon as the user edits them. Caveat under the
   panel: "GTA rates are an industry benchmark only. Courtesy Cars Group UK Ltd is not a GTA subscriber. Set your own
   daily rate if it differs." No rate for the group → field left empty with "No benchmark rate is loaded for group X —
   add one in Settings → GTA benchmark rates".
4. Policy: `Select` from `GET /fleet/policies` plus "Add policy" (small modal → `POST /fleet/policies`), replacing the
   free-text box that only worked with an existing id.
5. Save → `POST /fleet` with `vehicle` (picker fields + `spec` + `source`), `gtaGroup`, `dailyRatePence`, and
   `gtaSuggestion: { group, basis, rateGroup, ratePeriod }` (stored in the LookupRecord raw for provenance).
   Edit → `PATCH /fleet/:id` now applies vehicle changes (fixes the KNOWN-ISSUES item).

### F.2 Server side

- `fleetVehicleInput` gains `variant`, `bodyType`, `engineCapacityCc`, `spec`, `source`; `fleetUnitBody.gtaGroup` and
  `dailyRatePence` become optional: when omitted the server computes `suggestGtaGroup` and uses the suggestion; if no group
  or no rate results → 422 `GTA_SUGGESTION_UNAVAILABLE` ("Choose a GTA group and daily rate"). The repo still rejects
  `dailyRatePence <= 0`.
- `POST /fleet` records a LookupRecord (`catalogue` when catalogue ids are present, else `manual`), not `lookups: []`.
- `PATCH /fleet/:id` with `vehicle` → `updateVehicle` + LookupRecord + audit.
- The keeper-address fallback `['[registered office]']` in `routes/fleet.ts` becomes the formatted lines of
  `ctx.settings().registeredOffice` (defaults to 44 Syon Lane after §H).

### F.3 GTA rate table (migration 0003)

```sql
CREATE TABLE `gta_rates` (
  `id` text PRIMARY KEY NOT NULL,
  `group_code` text NOT NULL,
  `description` text,
  `daily_rate_pence` integer,             -- NULL only for a suppress row
  `period` text NOT NULL,                 -- 'YYYY-YY'
  `effective_from` text NOT NULL,
  `effective_to` text NOT NULL,
  `verification` text NOT NULL,           -- JSON Verification
  `suppressed` integer DEFAULT 0 NOT NULL,-- 1 = hide the KB row with the same group and period
  `note` text,
  `created_at` text NOT NULL, `created_by` text NOT NULL,
  `updated_at` text NOT NULL, `updated_by` text NOT NULL
);
CREATE UNIQUE INDEX `gta_rates_group_period_uq` ON `gta_rates` (`group_code`, `period`);
CREATE TABLE `gta_segment_defaults` (
  `segment` text PRIMARY KEY NOT NULL,
  `group_code` text NOT NULL,
  `updated_at` text NOT NULL, `updated_by` text NOT NULL
);
```

Merge (domain `gta/merge.ts`, pure):

```ts
export interface ManualGtaRateRow { id: string; group: string; description?: string; dailyRatePence?: Pence; period: string; effectiveFrom: ISODate; effectiveTo: ISODate; verification: Verification; suppressed: boolean; note?: string }
export type MergedGtaRate = GtaRate & { origin: 'kb' | 'manual'; id?: string; overridesKb?: boolean };
export function mergeGtaRates(kb: GtaRate[], manual: ManualGtaRateRow[]): MergedGtaRate[];   // manual replaces KB for the same (group, period); suppressed hides it; manual-only rows added
```

`gtaRatesFor(ctx)` (API `services/kb.ts`) returns `mergeGtaRates(kbRates, repos.listGtaRates(db))` and is the only
source for: `documentData.hireBlock`, `routes/engineering.ts` total-loss benchmark, `gtaRatesOn` (`GET /kb/gta-rates`),
`routes/hire.ts` (`calculateHire(..., { rates })` at its three call sites), `GET /gta/suggest`, the merge source. The web
`hireTotals` takes the rates from `useGtaRates()`.

Routes (`apps/api/src/routes/gtaRates.ts`):

| Method & path | Body | Response |
|---|---|---|
| `GET /settings/gta-rates` | — | `{ items: Array<MergedGtaRate & { kbRate?: GtaRate; suppressed?: boolean }>, note }` (KB rows, overrides, hidden rows, manual-only rows) |
| `POST /settings/gta-rates` | `{ group, description?, dailyRatePence, period, effectiveFrom, effectiveTo, verification?: { status: 'unverified' \| 'verified'; sourceUrl?; sourceNote? }, note? }` | 201 row; 409 `GTA_RATE_EXISTS` |
| `PUT /settings/gta-rates/:id` | same | row |
| `DELETE /settings/gta-rates/:id` | — | 204 (the KB row, if any, shows again) |
| `POST /settings/gta-rates/suppress` | `{ group, period, suppressed: boolean }` | row |
| `GET /settings/gta-segments` | — | `{ items: Array<{ segment, label, group, origin: 'kb' \| 'manual' }> }` |
| `PUT /settings/gta-segments/:segment` | `{ group }` | item |
| `DELETE /settings/gta-segments/:segment` | — | 204 (back to the KB default) |

Verification rule (server): `status: 'verified'` requires an `https://` `sourceUrl`; the server sets `verifiedBy` (session
user id) and `verifiedAt` (now); any client-sent `verifiedBy/verifiedAt` is ignored; KB rows are never changed. Group
codes match `/^[A-Z]{1,3}\d{0,2}$/`, periods `/^\d{4}-\d{2}$/`, `effectiveFrom ≤ effectiveTo`, pence integer > 0.
Audit `gta_rate.create|update|delete|suppress`, `gta_segment.update|reset`.

### F.4 Settings → GTA benchmark rates (`/settings/gta-rates`, vehicles-web slice)

Banner with the benchmark caveat. Table: Group, Description, Daily rate, Period, Effective, Origin badge (`Knowledge
base`, `Your rate`, `Overrides knowledge base`, `Hidden`), Verification badge, actions (Edit → modal; Hide/Show for KB
rows; Delete for your rows). "Add a rate" modal: group, description, `MoneyInput`, period, from/to `DateInput`s,
verification `Select` (Unverified default; Verified requires a source URL; the badge then shows "Verified by <you>"),
source URL, note. Second card "Segment defaults": segment label, group `TextInput` with datalist of known groups,
Reset. A note says vans and pick-ups have no 2026-27 rows in the shipped file.

---

## G. Desktop: installable Windows app (desktop-branding slice)

### G.1 Version plumbing

- Root `package.json`: `"version": "0.2.0"`, `"author": "Courtesy Cars Group UK Ltd"`.
- CI computes `VER = <major>.<minor from package.json>.<github.run_number>` (e.g. `0.2.57`) in the **first** step and
  exports `VER` and `CLAIMDESK_VERSION` to `GITHUB_ENV`. Local builds use `package.json` version.
- `build-package.mjs` writes `app/version.json` `{ version, commit, builtAt }`; `launch.cjs` reads it and sets
  `process.env.CLAIMDESK_VERSION`; `GET /api/health` adds `version`, `dataset: 'live' | 'demo'` (from `CLAIMDESK_DATASET`,
  set by the launcher) and `pid`; the web shows "ClaimDesk 0.2.57" in the AppShell footer and on the login page.

### G.2 Exe metadata (`build-package.mjs`, rcedit)

`rcedit(EXE, { icon, 'file-version': `${VER}.0`, 'product-version': VER, 'version-string': { CompanyName: 'Courtesy Cars
Group UK Ltd', ProductName: 'ClaimDesk', FileDescription: 'ClaimDesk - Courtesy Cars Group UK Ltd', LegalCopyright:
'Copyright © 2026 Courtesy Cars Group UK Ltd', OriginalFilename: 'ClaimDesk.exe', InternalName: 'ClaimDesk' } })`. Before
rcedit, try `signtool remove /s ClaimDesk.exe` (signtool found under `C:\Program Files (x86)\Windows Kits\10\bin\*\x64\`;
failure is a warning). Numeric parts of `VER` must be ≤ 65535.

### G.3 App window and console (`packaging/launch.cjs`)

- `openAppWindow(url, home, dataset)`: browser lookup order `CLAIMDESK_BROWSER_PATH` → Edge
  (`%ProgramFiles(x86)%`, `%ProgramFiles%`, `%LOCALAPPDATA%` `\Microsoft\Edge\Application\msedge.exe`) → `reg query`
  App Paths `msedge.exe` (HKCU, HKLM, WOW6432Node) → Chrome (same roots, `Google\Chrome\Application\chrome.exe`, App
  Paths `chrome.exe`) → `explorer.exe <url>`. Spawn detached:
  `[--app=<url>, --user-data-dir=<home>\window(-demo), --no-first-run, --no-default-browser-check, --disable-background-mode, --window-size=1440,900]`.
  `CLAIMDESK_BROWSER=tab` forces the old default-browser tab. Keep the list in sync with
  `packages/documents/src/render.ts installedBrowserCandidates` (comment in both files).
- Stop on last window close (`CLAIMDESK_STOP_ON_CLOSE`, default `1`): if the spawned window process exits after ≥ 8 s,
  close the Fastify server and exit; an exit in < 8 s means it handed over to an already-open ClaimDesk window, so keep
  running.
- `--stop`: read `pid` from `/api/health` (dataset must match) and terminate it; used by the "Stop ClaimDesk" shortcut.
- Console: shortcuts start it minimised (`runminimized`); `minimiseOwnConsole()` (PowerShell `GetConsoleWindow`/
  `ShowWindow(6)`) as a fallback; on a fatal error restore the console (`ShowWindow(9)`) and show a message box
  (`powershell -Command [System.Windows.Forms.MessageBox]::Show(...)`) before `pause(1)`.
- `--demo` uses port **4001**, data in `<home>\demo`, `CLAIMDESK_DATASET=demo`; the "already running" health check
  verifies `dataset` so the example-claims shortcut never opens live data.
- Environment additions: `TEMPLATES_DIR=<data>\templates`, `CLAIMDESK_DATASET`, `CLAIMDESK_VERSION`; the generated
  `claimdesk.env` template documents `DOCX_PDF_CONVERTER=auto|word|libreoffice|browser`, `SOFFICE_PATH`,
  `TOTALCARCHECK_URL_TEMPLATE`, `CLAIMDESK_BROWSER`, `CLAIMDESK_STOP_ON_CLOSE`.
- The window title comes from `document.title` ("ClaimDesk — Courtesy Cars UK"), the taskbar icon from the PWA icons.

### G.4 Installer (`packaging/installer/ClaimDesk.iss`)

Start from the reviewed draft `/tmp/claude-0/-home-user-logo/811a135a-35cb-5723-858d-e84fbd9027fa/scratchpad/wf2/ClaimDesk.iss.draft`. Required settings:

- `AppId={{322DAE75-FC0F-4786-B2BB-62E4A6A3D59B}` (never change), `AppName=ClaimDesk`, `AppVersion={#AppVersion}`,
  `AppPublisher=Courtesy Cars Group UK Ltd`, `AppPublisherURL=https://www.courtesycars.net`, `AppContact=claims@courtesycars.net`,
  `AppSupportPhone=020 7052 5403`, `AppCopyright=Copyright (C) 2026 Courtesy Cars Group UK Ltd`, `VersionInfo*` the same.
- Per-user, no admin: `PrivilegesRequired=lowest`, `DefaultDirName={autopf}\ClaimDesk` (=`%LOCALAPPDATA%\Programs\ClaimDesk`).
- `ArchitecturesAllowed=x64compatible`, `ArchitecturesInstallIn64BitMode=x64compatible`, `MinVersion=10.0`,
  `WizardStyle=modern`, `SetupIconFile=..\icon.ico`, `UninstallDisplayIcon={app}\ClaimDesk.exe`,
  `OutputBaseFilename=ClaimDesk-Setup-{#AppVersion}`, `Compression=lzma2/max`, `SolidCompression=yes`,
  `CloseApplications=force`.
- Shortcuts (`{autoprograms}`): **ClaimDesk** (`runminimized`), **ClaimDesk (example claims)** (`--demo`, `runminimized`),
  **Stop ClaimDesk** (`--stop`, `runminimized`); optional desktop shortcut task.
- Upgrade in place: `PrepareToInstall` runs `taskkill /F /IM ClaimDesk.exe`; `[InstallDelete] filesandordirs {app}\app`.
- Uninstall: taskkill, then an optional Yes/No (default **No**) to delete `%LOCALAPPDATA%\ClaimDesk` (data); silent
  uninstall never deletes data.
- `[Run]` "Start ClaimDesk now" (`postinstall skipifsilent runminimized`).
- If ISCC rejects `packaging/icon.ico` (PNG-compressed small entries), CI rebuilds it with ImageMagick (`magick convert`)
  into BMP entries before compiling.

### G.5 Portable zip

Kept: `ClaimDesk-Windows-x64-<VER>.zip` with the same folder layout, README.txt rewritten ("Prefer the installer. To run
without installing: unzip, double-click ClaimDesk.exe; the app opens in its own window").

### G.6 Packaging checks (`build-package.mjs`)

Assert the package contains: `app/packages/documents/assets/docx/*.docx` (10 files),
`app/packages/kb/data/vehicle-catalogue/makes/*.json`, `app/packages/kb/data/gta-segment-defaults.json`,
`app/node_modules/docx-preview/dist/docx-preview.min.js`, `app/node_modules/jszip/dist/jszip.min.js`,
`app/node_modules/fflate`, `app/node_modules/@xmldom/xmldom`, `app/version.json`. Fail the build otherwise.

### G.7 CI (`.github/workflows/claimdesk-windows.yml`)

1. **Version** (first step): compute `VER`, write `VER`, `CLAIMDESK_VERSION` to `GITHUB_ENV`.
2. Install, web build, prod install, `node packaging/build-package.mjs` (uses `CLAIMDESK_VERSION`).
3. **Portable smoke test** (existing) plus: `GET /api/health` shows `version == $VER`; `GET /api/docx-templates` returns
   ≥ 10 items; take the first claim; `GET /api/claims/<id>/docx-templates/agreement.ccguk_01_customer_loa/values`;
   acknowledge template warnings (`POST /api/docx-templates/<id>/acknowledge`); `POST /api/claims/<id>/docx-documents`
   with confirms for the suggested rows; `GET /api/documents/<docId>/docx` starts with `PK`; approve; the PDF starts with
   `%PDF-` and the document's `pdfConverter` is `browser` (no Word/LibreOffice on the runner); `GET
   /api/catalogue/makes` has ≥ 60 items; `POST /api/vehicles/lookup` for an unknown reg returns `manual_required` with a
   `totalcarcheck` link.
4. **Build installer**: resolve ISCC (`Get-Command iscc`, else `Program Files (x86)\Inno Setup *\ISCC.exe`, else
   `choco install innosetup -y --no-progress`), `iscc /Qp /DAppVersion=$env:VER /DSourceDir=$PWD\packaging\dist\ClaimDesk /O$PWD\packaging\dist packaging\installer\ClaimDesk.iss`.
5. **Installed-app smoke test**: run `ClaimDesk-Setup-$VER.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /LOG=…`
   (wait); assert `%LOCALAPPDATA%\Programs\ClaimDesk\ClaimDesk.exe` exists; registry
   `HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{322DAE75-FC0F-4786-B2BB-62E4A6A3D59B}_is1` has
   `Publisher -eq 'Courtesy Cars Group UK Ltd'` and `DisplayVersion -eq $VER`; Start Menu `ClaimDesk.lnk` exists under
   `$env:APPDATA\Microsoft\Windows\Start Menu\Programs`; `(Get-Item …\ClaimDesk.exe).VersionInfo` has CompanyName,
   ProductName, FileDescription, LegalCopyright and `FileVersion -eq "$VER.0"`; start the installed exe with
   `--no-browser` and `CLAIMDESK_HOME=$RUNNER_TEMP\installed-home`, check `/api/health` (`dataset: live`, `version`);
   create a marker file in the home, re-run the installer (upgrade), check the marker survives and the app starts again;
   run `unins000.exe /VERYSILENT`; check the program folder is gone and the data folder still exists.
6. Upload artifacts: `ClaimDesk-Setup-$VER.exe` and the portable zip. Release (`[windows-release]` or manual) lists both
   files; body: "Download **ClaimDesk-Setup-<ver>.exe**, run it (no administrator rights needed). Publisher: Courtesy Cars
   Group UK Ltd. Windows may show 'Unknown publisher' until the installer is code-signed."

### G.8 Code signing

Not possible without a certificate. The `.iss` has a commented `SignTool=` line and the workflow a disabled signing step
that reads secrets `CODESIGN_PFX_BASE64`/`CODESIGN_PASSWORD` (or Azure Trusted Signing). Open question §L.9.

---

## H. Company details everywhere (desktop-branding slice)

### H.1 Source of truth

`packages/documents/src/brand.ts`:

```ts
brand.company = {
  registeredName: 'Courtesy Cars Group UK Ltd', tradingName: 'Courtesy Cars UK', companyNumber: '17430389',
  registeredOffice: '44 Syon Lane, Isleworth, London TW7 5NQ',                       // was ''
  registeredOfficeAddress: { line1: '44 Syon Lane', line2: 'Isleworth', town: 'London', postcode: 'TW7 5NQ', country: 'GB' },
  caseHandlerPhone: '07425 475922', officePhone: '020 7052 5403', accidentLine24h: '020 7052 5403',   // keep the old key as an alias
  claimsEmail: 'claims@courtesycars.net', website: 'www.courtesycars.net',
  director: { name: 'Shahzaib Ahmed Bari', role: 'Director' },
  tagline, services, statusLine,                                                     // unchanged
};
export function formatRegisteredOffice(addr?: Address): string;   // '44 Syon Lane, Isleworth, London TW7 5NQ'; undefined → brand default
```

`formatRegisteredOffice` joins `line1, line2, town[, county]` with `, ` and appends ` <postcode>` to the last part.

### H.2 Defaults and data

- `packages/db/src/repos/settings.ts`: `DEFAULT_SETTINGS.registeredOffice = { line1: '44 Syon Lane', line2: 'Isleworth', town: 'London', postcode: 'TW7 5NQ' }`;
  `toSettings()` falls back to it when the saved row has `null`. Bank, VAT, ICO stay unset (Settings inputs).
- `apps/api/src/routes/settings.ts`: `GET /settings` adds `lookupMode`; the `REGISTERED_OFFICE_MISSING` warning no
  longer fires by default; add `BANK_NOT_SET` wording that points at the payment direction (05) needing it.
- `apps/api/src/seed/archetypes.ts`: real registered office; demo bank values stay visibly demo (`[demo bank — set in Settings]`).
- `apps/api/src/services/documentData.ts` `companySettings()`: `registeredOffice = formatRegisteredOffice(settings.registeredOffice)`.
- `apps/api/src/services/builders/correspondence.ts`: `handler.phone = brand.company.caseHandlerPhone` (letters print the
  case handler line, as the letterhead does).

### H.3 Documents (HTML)

- `layout.ts`: `companyBlock`/`contactStrip` print the letterhead block (§C.7); `headerTemplate`/`footerTemplate` restyled;
  no `'[registered office]'` literal remains (fallback = brand default); `data-letter-part` attributes on: the recipient
  `address` (`recipient`, lines `data-line`, email `data-email`), the ref table rows (`ref-our`, `ref-your`, `ref-claim`,
  `ref-client`, `ref-vehicle`, `ref-accident`, `ref-date`), `p.re`/subject block (`subject`), the salutation paragraph
  (`salutation`), `main.body` (`body`), the closing (`valediction`), `p.sig-name` (`signatory-name`), and enclosure/cc
  blocks when present (`enclosures`, `cc`). Reply-by sentences rendered by letter templates get `data-letter-part="reply-by"`
  where the template builds them through a layout partial; otherwise extraction leaves `replyBy` empty.
- `common.ts` `sampleSettings()`: real office; sample bank stays labelled sample; signatory `D. Kaleem, Claims Manager` may
  stay (sample only).
- `templates/agreements-forms.ts` (lines ~366, ~636): `'[registered office]'` → `formatRegisteredOffice(...)`.
- Tests that change: `layout.test.ts` (71, 93, 100), `templates/agreements-forms.test.ts:279`, `letters-a.test.ts:219`,
  `letters-b.test.ts:808`, `apps/web/src/screens/settings/settings.test.ts:17`.

### H.4 Web and docs

- `LoginPage.tsx` footer: "Courtesy Cars Group UK Ltd · Registered in England & Wales No. 17430389 · 44 Syon Lane,
  Isleworth, London TW7 5NQ" + version. `AppShell.tsx` footer adds the version. `manifest.webmanifest` description keeps
  the registered name. Settings page: Company details card shows the real defaults; a "More settings" card links to
  **Document templates** (`/settings/templates`) and **GTA benchmark rates** (`/settings/gta-rates`); the API keys card
  shows "Vehicle lookups: Manual (no DVLA/DVSA keys) — searches use ClaimDesk records and Total Car Check" or "Live".
- `README.md` (~95) and `docs/KNOWN-ISSUES.md` (~10) stop saying company details are placeholders; KNOWN-ISSUES drops the
  fleet vehicle-edit item once fixed (vehicles slice) — the branding slice edits only the company-details lines.
- `docs/SETUP-APIS.md`: a short "Manual mode" section (what works without keys).

---

## I. Shared files, migrations and dependency installs

| Shared file | Who may append | Rule |
|---|---|---|
| `apps/api/src/routes/index.ts` | vehicles-backend (`registerCatalogueRoutes`, `registerGtaRatesRoutes`), templates-api (`registerDocxTemplatesRoutes`) | add an import and one array entry each; keep it a plain array |
| `apps/web/src/app/router.tsx` | templates-web (`settings/templates`, `settings/templates/:id`), vehicles-web (`settings/gta-rates`) | add imports and child routes only |
| `packages/db/src/schema.ts` | vehicles-backend (vehicles.spec, gtaRates, gtaSegmentDefaults, vehicleCatalogueCustom), templates-api (documentTemplates, documents columns) | append new tables at the end; column additions in place |
| `packages/db/drizzle/meta/_journal.json` + SQL | vehicles-backend `0003_vehicle_catalogue_gta.sql` (idx 3, `when` 1791400000000); templates-api `0004_document_templates.sql` (idx 4, `when` 1791500000000) | generate with `pnpm --filter @ccguk/db exec drizzle-kit generate --name <name>` after editing `schema.ts` so the snapshot chain stays valid, then hand-check the SQL; templates-api runs after vehicles-backend |
| `packages/db/src/migrate.test.ts` | vehicles-backend (first), templates-api | replace the hard-coded `toBe(3)` with the journal entry count (`JSON.parse(readFileSync(<journal>)).entries.length`) — whoever comes first; each adds its tables to `EXPECTED_TABLES` |
| `packages/db/src/repos/index.ts` | vehicles-backend, templates-api | one `export *` line each |
| `packages/domain/src/types.ts` | vehicles-backend (VehicleSpec, Vehicle.spec, LookupProvider, VehicleSegment), templates-api (GeneratedDocument fields) | additive only |
| `packages/domain/src/index.ts` | templates-api (`templateIds.js`) | one export line (vehicles-backend exports through `vehicle/index.ts` and `gta/index.ts`) |
| `packages/documents/src/index.ts` | docx-engine (`./docx/index.js`), docx-fields (`./docx/fields/index.js`), templates-api (`./letterContent.js`) | one export line each |
| `packages/documents/package.json` | docx-engine (deps + `docx:scan`, `docx:samples` scripts), docx-fields (`docx:mappings` script) | |
| `packages/kb/src/index.ts` | vehicles-backend | catalogue exports |
| `apps/api/src/config.ts`, `apps/api/src/context.ts` | vehicles-backend (`totalCarCheckUrlTemplate`), templates-api (`templatesDir`, `docxPdfConverter`, `ensureDataDirs` adds templates and tmp/convert) | additive |
| `apps/web/src/api/client.ts` | templates-web (`GeneratedDocument.format/docx*`, `pdfConverter`), vehicles-web (`VehicleInput` fields, `Vehicle.spec`, lookup response fields, `normaliseLookupResult`) | additive; new API calls go in the slice's own module (`api/templatesApi.ts`, `api/vehiclesApi.ts`) |
| `apps/web/src/screens/claim/lib/vehicle.ts` | vehicles-backend (labels for the two new providers only), then vehicles-web | |
| `apps/web/package.json` | templates-web (`docx-preview`, `jszip`) | |
| `pnpm-lock.yaml` | docx-engine, templates-web | run `pnpm install` from `claimdesk/` after editing a package.json; if another slice's install runs at the same time, re-run; never `--frozen-lockfile` locally |

Everything else is owned by exactly one slice (§J). Before editing a shared file, re-read it (another slice may have
appended), and keep edits minimal and additive.

---

## J. Implementation slices (summary; the full briefs are the slice contracts)

| Key | Title | Depends on | Owns (main) |
|---|---|---|---|
| `docx-engine` | DOCX engine and PDF converters | — | `packages/documents/src/docx/*` (not `fields/`), `render.ts`, documents deps |
| `docx-fields` | Field dictionary, resolvers, built-in mappings, letterhead compose | docx-engine | `packages/documents/src/docx/fields/**` |
| `templates-api` | Template library DB/API, DOCX claim documents, letterhead DOCX for HTML letters | docx-engine, docx-fields, desktop-branding, vehicles-backend | migration 0004, repos/documentTemplates, routes/docxTemplates, services/{docxTemplates,docxDocuments,mergeSource}, services/documents.ts, routes/documents.ts, letterContent.ts, domain templateIds |
| `templates-web` | Templates manager, Fill-a-template flow, DOCX document view | — (HTTP contract) | `apps/web/src/screens/templates/**`, Documents tab/view, `api/templatesApi.ts` |
| `vehicle-catalogue-data` | Catalogue JSON for ~74 makes + features | — | `packages/kb/data/vehicle-catalogue/**`, `packages/kb/scripts/*catalogue*` |
| `vehicles-backend` | Domain parser/links/GTA suggest+merge, KB catalogue loader, DB 0003, vehicles/catalogue/GTA/fleet API | — | see brief |
| `vehicles-web` | VehiclePicker, manual search + TCC + paste, Vehicle tab edit, fleet dialog GTA pre-fill, GTA settings page | vehicles-backend | `apps/web/src/screens/vehicles/**`, `screens/gta/**`, fleet + FNOL + Vehicle tab edits |
| `desktop-branding` | Installer, app window, version, CI, company details, HTML restyle | — | `packaging/**`, workflow, brand/layout/common, settings defaults, health, branding tests |

Waves: (1) docx-engine, templates-web, vehicle-catalogue-data, vehicles-backend, desktop-branding; (2) docx-fields,
vehicles-web; (3) templates-api. Integration after wave 3: `pnpm -r typecheck`, `pnpm -r test`, web build,
`node packaging/build-package.mjs` on Linux (non-Windows path), `pnpm --filter @ccguk/documents docx:samples`.

---

## K. Verification matrix

| Area | Automated here | Manual / Windows |
|---|---|---|
| Scanner | unit tests on synthetic docx (split runs, tokens, brackets, blanks, glyph groups, header parts, spacer exclusion) + real-asset tests (slot counts, ids listed in Appendix 2 exist, no slot in the 03 page-break spacers, `[2003]` not a slot) | — |
| Fill | round-trip: fill → re-scan shows the values; untouched parts byte-identical; XML escaping (`Smith & Co <Ltd>`); multi-line → `w:br`; checkbox swap; reference whole-run; signature slots refused; LibreOffice reference render of filled 01/03/05 (when `SOFFICE_PATH`) | open filled files in Word on a PC |
| Mappings | zero `MappingIssue`s and zero unmapped slots for all 10 built-ins; every key exists; policies never laxer than defaults | — |
| Resolvers | each key against `sampleMergeSource()`; open hire/storage never produce end dates; GTA rates carry verification | — |
| Converters | chain selection with fake converters; Word script snapshot; LibreOffice integration (env-gated); browser converter on the real assets with the §A.11.5 acceptance | Word path on a PC with Office: 01/03 page counts match Word's own |
| API | `createTestApp` tests for every route in §C.5, §D.8, §E, §F.3; generation → approve → PDF; tamper → 409; supersede reuses inputs | CI smoke (§G.7) |
| Web | pure logic tests (`templates.ts`, `fillValues.ts`, `vehiclePickerModel.ts`, `gtaPanel.ts`), component smoke tests with mocked fetch; copy guard | click-through on the packaged app |
| Desktop | `node --check packaging/launch.cjs`; unit tests for the browser lookup/argument builder (pure helpers exported for tests) | CI installed-app smoke; Windows 11 console minimised check; stop-on-close |

---

## L. Open questions for CCGUK (defaults chosen so the build is not blocked)

1. **CarFlex wording in 01 and 02.** The templates name "Car Flex Ltd (company number 12640635, trading as CarFlex Secure
   Storage)" and a "CarFlex Ltd on CCGUK's instruction" option. ClaimDesk's legacy guard blocks those strings. Default:
   templates carry a `LEGACY_DETAIL` warning that an admin acknowledges once; matching flags on generated documents are
   suppressed as template baseline. Confirm this wording is intended, or supply corrected files.
2. **"Compliant with theGTA" accreditation strip** in the first-page footer image of the forms. CCGUK is not a GTA
   subscriber. Default: `BRAND_CLAIM_IMAGE` warning to acknowledge; image untouched. Confirm or supply files without it.
3. **Letterhead opening sentence** "We act on behalf of our client …" conflicts with the house style ("We are instructed to
   correspond on behalf of …"). Default: kept for letters started from the letterhead template (acknowledged warning);
   replaced by the HTML letter's own opening when an HTML letter is recomposed on the letterhead.
4. **Bank details.** CCGUK-02 prints "Pay to Courtesy Cars Group UK Ltd, 33492902 · 04-06-05". Settings has no bank
   details. Confirm these are the company's account (and the bank name) so they can be entered in Settings; the payment
   direction (05) cannot be generated until Settings has bank details whose account name is the registered name.
5. **Hire agreement numbers.** Templates print `CCG-HIRE-…`; ClaimDesk numbers agreements `CCG-H-000001`. Default: the
   whole printed reference is replaced by the stored number. Should new agreements be numbered `CCG-HIRE-000001`?
6. **Letterhead signatory role** is pre-printed "Claims Manager". Default: other users can generate it with a warning.
   Restrict to the Claims Manager role instead?
7. **Pre-printed CCGUK signatory** "Shahzaib Ahmed Bari — Director" (01, 03, 05, 07, 08). Confirm he is the authorised
   signatory for all of them.
8. **Total Car Check**: confirm the free-check URL format (`https://totalcarcheck.co.uk/FreeCheck?regno=<REG>`) and send one
   copied results page (any car) so the paste parser can be tested against the real layout.
9. **Code signing** for the installer (OV/EV certificate or Azure Trusted Signing) to remove "Unknown publisher".
10. **GTA groups**: the segment → group defaults (§D.6) are suggestions. Provide the GTA vehicle group list if CCGUK has it,
    and the 2026-27 van/pick-up rates (CP1/CP2/PV2 rows expired 30 June 2026).
11. **Ambiguous labels** to confirm: 09 §05 "Stored at" (photographs, assumed); 02 A2.3 "Own insurer ref" (assumed the
    own-insurer claim reference, handler-entered); 05 "Acknowledged by insurer on" (assumed the paying insurer).
12. **Rates "total amounts payable"** (01 §06, 02 B1) versus the rate card's 20 % VAT: confirm that recovery, storage and
    engineering invoices must not add VAT on top of the printed figures.
13. **Witness exhibits**: v1 fills one exhibit sheet (the first selected exhibit) and lists all exhibit references on page
    1; more sheets are added in Word. Is one sheet per exhibit needed in v1?
14. **Statement of Means / Mitigation**: the Word versions (07/08) are treated as equivalent to the existing HTML forms for
    the acceptance gate and the payment pack. Should the HTML versions be retired from the "New document" list?

---

## M. Risks

| Risk | Mitigation |
|---|---|
| Heuristic scanning mis-labels a slot in an uploaded template | Mapping editor shows every slot with context and preview; nothing prints without a mapping or a handler entry; test copy download |
| Browser converter pagination differs from Word | Word/LibreOffice preferred when present; converter recorded on the document; Word download always available |
| Word automation hangs (dialogs, activation) | Timeouts, kill only the automation instance, fall back to the next converter, attempt log stored |
| Legal wording altered by a bug | Fill touches only slot ranges; tests assert untouched XML parts are byte-identical and the template's static text is a subsequence of the filled text |
| Declarations pre-filled (statement of need, driver declarations) | `handler` policy + values-form labels + mapping tests assert those slots have no resolver output |
| Catalogue data errors | Marked unverified everywhere; free-text "Not listed" always available; coverage report; user additions |
| GTA rate wrongly treated as authoritative | Caveat everywhere, verification badges, rates print in documents only when verified or confirmed |
| Concurrent slices editing shared files | §I rules; dependency order for migrations |
| Installer blocked by SmartScreen | Documented; signing hook ready (§G.8) |

---

## Appendix 1 — Field dictionary (`FIELD_DEFS`)

Notation: **Policy** A = `auto`, K = `auto-if-known`, G = `suggest` (handler confirms), H = `handler`, P = `post-event`,
S = `signature`, N = `never`. **Source** paths use the bundle names from the documents map; "src.x" = `MergeSource.x`.
"Synonyms" are the label phrases used by auto-mapping (slugified before comparison; the label itself is always a
synonym). Aliases accepted by `getFieldDef` are listed as *alias*. All date/time values are converted to Europe/London.

### A1.1 Company, document, handler

| Key | Label | Type | Pol. | Source | Synonyms |
|---|---|---|---|---|---|
| `company.registeredName` | Company registered name | text | A | `brand.company.registeredName` | company name, registered name, lessor, credit hire provider, company |
| `company.tradingName` | Trading name | text | A | `brand.company.tradingName` | trading as, trading name |
| `company.number` | Company number | text | A | `settings.companyNumber ?? brand.company.companyNumber` | company no, company number, company registration number |
| `company.registeredOffice` | Registered office | text | A | `formatRegisteredOffice(settings.registeredOffice)` | registered office, company address, our address |
| `company.caseHandlerPhone` | Case handler telephone | text | A | `brand.company.caseHandlerPhone` | case handler, case handler telephone, our mobile |
| `company.officePhone` | Office telephone | text | A | `brand.company.officePhone` | office, office telephone, our telephone |
| `company.email` | Claims email | text | A | `brand.company.claimsEmail` | our email, claims email |
| `company.website` | Website | text | A | `brand.company.website` | website, web |
| `company.director` | Authorised signatory | text | N | `brand.company.director` (checks only) | director, authorised signatory |
| `company.vatNumber` | VAT number | text | K | `settings.vatNumber` | vat number, vat registration |
| `company.icoRegistration` | ICO registration | text | K | `settings.icoRegistration` | ico, ico registration |
| `company.bank.accountName` | Account name | text | A, not overridable | `settings.bank.accountName` | account name, payee |
| `company.bank.bankName` | Bank | text | A, not overridable | `settings.bank.bankName` | bank, bank name |
| `company.bank.sortCode` | Sort code | text | A, not overridable | `settings.bank.sortCode` | sort code |
| `company.bank.accountNumber` | Account number | text | A, not overridable | `settings.bank.accountNumber` | account number, account no |
| `doc.date` | Document date (today) | date | G | `src.now` | date, document date, today, date of form |
| `doc.dateLong` | Letter date | date (long) | A | `src.now` | date of letter |
| `doc.agreementRef` | Agreement reference | text | A | `bundle.claim.reference` (no separate series yet) | agreement ref, agreement reference |
| `doc.subject` | Subject line | text | H | handler | subject, re, subject of this letter |
| `doc.body.paragraphs` | Letter paragraphs | list | H | handler / extracted HTML letter | paragraphs, body |
| `doc.replyByDate` | Reply by | date | G | `src.responseDeadline` | reply by, respond by, deadline |
| `doc.valediction` | Yours … | text | A | `faithfully` when salutation is "Sir or Madam", else `sincerely` | yours, sincerely faithfully |
| `doc.enclosures` | Enclosures | list | H | handler | enc, enclosures |
| `doc.cc` | Copies to | list | H | handler | cc, copies |
| `doc.signedDate` | Date the form was signed | date | P | `SignatureRecord.signedAt` of this document (re-generation only) | date taken |
| `doc.copyToClientAt` | Copy given to client on | date | H | handler | copy given to client on |
| `doc.copyToClientMethod` | Copy given by | choice in_person/email/post | H | handler | method |
| `doc.sentToTpInsurerAt` / `doc.sentToOwnInsurerAt` / `doc.insurerAcknowledgedAt` | Office-use log dates | date | P | send/acknowledge events for this document | sent to third-party insurer on, sent to own insurer on, acknowledged by insurer on |
| `doc.reviewedBy` / `doc.reviewedOn` | Reviewed by / date | text/date | P | `approvedBy`/`approvedAt` on re-generation | reviewed by |
| `handler.name` | Your name (person producing the document) | text | A | `src.user.name` | form completed by, recorded by, form taken by, full name (ccguk), released by, checked by |
| `handler.position` | Your position | text | A | `src.user.roleLabel` (USER_ROLE_LABEL) | position, role |
| `handler.caseHandler` | Case handler | text | A | `src.caseHandler?.name ?? src.user.name` | case handler |
| `handler.contact` | Case handler contact | text | A | `` `${company.caseHandlerPhone} · ${company.email}` `` | contact |

### A1.2 Claim and client

| Key | Label | Type | Pol. | Source | Synonyms |
|---|---|---|---|---|---|
| `claim.reference` | Our reference | text | A | `bundle.claim.reference` | reference, our ref, ccguk reference, claim ref, file ref, ccguk reference allocated |
| `claim.openedAt` | File opened | date | K | `bundle.claim.openedAt` | file opened, date opened |
| `claim.firstInstructedAt` | First instructed on | date | K | first `bundle.events[type='services_agreed'].at`, else `bundle.claim.openedAt` | first appointed, instructed on |
| `claim.retrospectiveAppointment` | Signed after CCGUK began acting | bool | G | `date(src.now) > date(claim.firstInstructedAt)` | signed after ccguk began acting |
| `claim.liability` | Liability | choice admitted/disputed/awaited | K | `bundle.claim.liability`: admitted→admitted; denied, disputed→disputed; unknown→awaited; split→none (+warning) | liability |
| `claim.liabilityDate` | Liability decided on | date | K | latest `bundle.events[]` whose type starts `liability_` | liability date |
| `claim.settlementAuthority` | Settlement authority | choice standard/full | H | handler (client's choice; never defaulted) | settlement authority |
| `claim.agreementMadeAt` | How the agreement was made | choice premises/away/distance | H | handler | how this agreement was made |
| `claim.clientAuthoritySigned` | Signed client authority held | bool | K | a `bundle.documents[]` with canonical id `agreement.ccguk_01_customer_loa` and status `signed` | signed client authority held |
| `claim.clientAuthoritySignedOn` | Client authority signed on | date | K | that document's `signature.signedAt` | dated |
| `claim.ledgerOpened` | Ledger opened | bool | A | `true` | ledger opened |
| `claimant.name` *(alias `claimant.fullName`)* | Client full name | text | A | `bundle.claimant.name` | customer full name, client full name, client, full name, hirer full name, title and full name, name, full name of client |
| `claimant.initialsSurname` | Client initials and surname | text | A | derived from `bundle.claimant.name` (`J. Smith`) | initials and surname |
| `claimant.dateOfBirth` | Date of birth | date | K | `bundle.claimant.dateOfBirth` | date of birth, dob |
| `claimant.address` *(aliases `addressFull`, `addressInline`)* | Address with postcode | text | K | `formatAddressInline(bundle.claimant.address)` | address, address and postcode, home address, hirer address |
| `claimant.addressNoPostcode` | Address without postcode | text | K | address lines without postcode | address (when a postcode cell follows) |
| `claimant.postcode` | Postcode | text | K | `bundle.claimant.address.postcode` (upper case) | postcode |
| `claimant.phone` | Telephone | text | K | `bundle.claimant.phone` | telephone, mobile, phone, tel |
| `claimant.email` | Email | text | K | `bundle.claimant.email` | email, e-mail |
| `claimant.drivingLicenceNumber` | Driving licence number | text | K | `bundle.claimant.drivingLicenceNumber` | driving licence no, licence number, licence no |
| `claimant.licenceType` / `claimant.licenceHeldYears` / `claimant.licenceHeldSince` | Licence type / years held / held since | text/int/date | H | handler (data gap) | licence type, licence held for, licence held since |
| `claimant.occupation` | Occupation | text | H | handler | occupation |
| `claimant.isPcoDriver` + `claimant.pcoBadgeNumber` | PCO driver / badge | bool/text | H | handler | pco, private hire driver, badge no |
| `claimant.idSeen` | ID seen | choice driving_licence/passport | H | handler | id seen |
| `claimant.photoIdVerified` | Photo ID verified | bool | K | `true` only when an evidence item of kind licence/passport/photo ID has `verification.status === 'verified'`; otherwise undefined (never `false`) | photo id verified |
| `claimant.consentDisputeReferral` | Consents to dispute referral | bool | H | handler | i consent to ccguk sharing |

### A1.3 Client vehicle (the damaged vehicle, `bundle.vehicle`)

| Key | Label | Type | Pol. | Source | Synonyms |
|---|---|---|---|---|---|
| `vehicle.registration` | Registration | text (reg) | A | `formatRegistration(bundle.vehicle.registration)` | registration, reg, vehicle reg, reg no, registration number, vrm |
| `vehicle.make` / `vehicle.model` | Make / Model | text | A | `bundle.vehicle.make` / `.model` | make, model |
| `vehicle.makeModel` | Make & model | text | A | make + model (+ variant when ≤ 20 chars) | make and model, vehicle make model, vehicle, make model |
| `vehicle.makeModelReg` | Vehicle and registration | text | A | `Volkswagen Golf — AB12 CDE` | vehicle registration, claimant vehicle, make model reg |
| `vehicle.vin` | VIN | text | K | `bundle.vehicle.vin` | vin, chassis number |
| `vehicle.colour` | Colour | text | K | `bundle.vehicle.colour` (title case) | colour, color |
| `vehicle.fuelType` | Fuel | choice petrol/diesel/hybrid/plugin_hybrid/electric/lpg/other | K | `bundle.vehicle.fuelType`; matches: hybrid→`hybrid`; plugin_hybrid→`hybrid`,`plug-in`,`phev`; electric→`ev`,`electric` | fuel, fuel type |
| `vehicle.transmission` | Transmission | choice manual/automatic | K | `bundle.vehicle.transmission` (`unknown` → none) | transmission, gearbox, transmission required |
| `vehicle.engineFuel` | Engine / fuel | text | K | `1,798cc hybrid` from `engineCapacityCc` + fuel label | engine fuel, engine |
| `vehicle.firstRegistered` | First registered | date (month precision) | K | `bundle.vehicle.monthOfFirstRegistration` | first registered, date of first registration |
| `vehicle.yearOfManufacture` | Year | int | K | `bundle.vehicle.yearOfManufacture` | year, year of manufacture |
| `vehicle.mileageAtAccident` *(alias `vehicle.mileage`, `vehicle.odometerAtInstruction`)* | Mileage | int miles | K | latest `bundle.vehicle.odometer[]` dated on/before the accident, preferring source `accident_report`, then `client`; never a later reading | mileage, odometer |
| `vehicle.yearMileage` | Year / mileage | text | K | `2019 / 48,210 miles` (mileage omitted when unknown) | year mileage |
| `vehicle.gtaGroup` | GTA group (own class) | text | K | `bundle.vehicle.gtaGroup` | gta group, gta comparator group, own vehicle class |
| `vehicle.classDescription` | Class of damaged vehicle | text | G | `Group <gtaGroup> <bodyType>` | my damaged vehicle is |
| `vehicle.registeredKeeper` | Registered keeper | choice client/other | K | keeper party = claimant or `ownership === 'client'` → client; other keeper party → other | registered keeper |
| `vehicle.registeredKeeperName` | Registered keeper name | text | K | keeper party name, else claimant name when ownership is client | registered keeper |
| `vehicle.keeperNameRelationship` | Keeper name and relationship | text | H | handler | other name and relationship |
| `vehicle.financeOrLease` + `vehicle.financeLender` + `vehicle.financeOutstandingPence` | Finance | bool/text/money | H | handler | finance, lender, outstanding balance |
| `vehicle.ownerIfDifferent` | Owner if different | text | H | handler | owner if different |
| `vehicle.preExistingDamage` | Pre-existing damage | bool | H | handler | any pre-existing damage |
| `vehicle.panelsDamaged` | Panels damaged | text | G | `bundle.report.damageDescription` | panels damaged |

### A1.4 Accident, third party, insurers

| Key | Label | Type | Pol. | Source | Synonyms |
|---|---|---|---|---|---|
| `accident.date` | Date of accident | date | A | `bundle.claim.accident.occurredAt` | date of accident, accident date, date of collision, date of incident |
| `accident.time` | Time of accident | time | A | same | time |
| `accident.dateTime` | Date & time of accident | datetime | A | same | date and time |
| `accident.dateLong` | Date of accident (long) | date (long) | A | same | road traffic collision |
| `accident.dateTimeApprox` | Date & approximate time | text | A | `9 August 2026, about 14:30` | date and approximate time |
| `accident.location` | Accident location | text | A | `bundle.claim.accident.location` (+ `, ` postcode when not already in it) | location, accident location, road junction, location of collision |
| `accident.postcode` / `accident.townPostcode` | Postcode / Town & postcode | text | K | `bundle.claim.accident.postcode` | town and postcode |
| `accident.circumstances` | Client's account (verbatim) | multiline | K | `bundle.claim.accident.circumstances` exactly as stored | what happened, clients account, circumstances |
| `accident.policeAttended` | Police attended | bool | K | `bundle.claim.accident.policeAttended` | police attended |
| `accident.policeReference` | Police reference | text | K | `bundle.claim.accident.policeReference` | police ref, police reference |
| `accident.driveable` | Vehicle driveable | bool (choice driveable/not_driveable/unknown for 02) | K | `bundle.claim.accident.driveable` (tri-state) | vehicle driveable, vehicle condition |
| `accident.airbagsDeployed` | Airbags deployed | bool | K | `bundle.claim.accident.airbagsDeployed` | airbags deployed |
| `accident.injuries` | Anyone injured | bool | K | `bundle.claim.accident.injuries` | was anyone injured |
| `accident.witnesses` | Witnesses | rows name/contact | K | `src.witnesses` → `{ name, contact: phone ?? email }`; where/independent stay handler | witnesses |
| `accident.accountTakenBy` / `accident.accountTakenAt` | Account taken by / at | text/datetime | K | the `fnol` event's recording user / `recordedAt` | account taken by, date and time taken |
| `accident.cctv.<source>.requestSentOn` | CCTV request sent (per source) | date | K | first `cctv_request_sent` event with `data.source = <source>`; sources `client_dashcam`, `tp_dashcam`, `council`, `bus_operator`, `shops`, `petrol_station`, `doorbell`, `other` | request sent |
| `accident.cctv.<source>.contact` / `.overwriteDate` | Contact / overwrite date | text/date | H | handler (never assume 30 days) | contact address, overwrite date |
| handler-only accident facts | — | — | H | `directionOfTravel`, `weather`, `light` (daylight/dark/dusk_dawn), `roadSurface` (dry/wet/ice_snow), `speedLimitMph`, `numberOfLanes`, `clientLane`, `busLanePresent`+`busLaneHours`, `laneMarkings`, `clientSpeedMph`, `otherVehicleSpeedMph`, `clientVehicleOccupied`, `clientPassengers`, `sceneStatements`, `pointOfFirstImpact`, `directionOfForce`, `policeForceStation`, `reportedToPoliceWithin24h` (yes/no/na), `breathTest`+`breathTestResult`, `reportedForOffence`, `injuryAdviceGivenOn`, `injuryAdviceChannel` (telephone/email/in_person), `injuryAdviceConfirmedInWriting` | as labelled |
| `tp.driverName` | Other driver | text | K | first `src.thirdPartyDrivers` with role `third_party_driver`, else first `third_party` | other driver, driver name, third party driver |
| `tp.driverAddress` / `tp.driverPhone` | Other driver address / telephone | text | K | that party | driver address, driver telephone |
| `tp.vehicleRegistration` *(alias `tp.registration`)* | Other vehicle registration | text (reg) | K | `bundle.thirdPartyVehicle.registration` | other vehicle reg, registration (other vehicle) |
| `tp.vehicleDescription` / `tp.vehicleMakeModelReg` / `tp.vehicleMakeModelColour` | Other vehicle | text | K | `bundle.thirdPartyVehicle` | third party vehicle, other vehicle, make model and colour |
| `tp.policyNumber` | Third party's policy number | text | K | `fnol` event `data.thirdPartyPolicyNumber` | policy number (third party) |
| handler-only TP facts | — | — | H | `tp.detailsSource` (at_scene/police/insurer/askmid), `tp.askMidCheckedOn`, `tp.askMidResult`, `tp.vehicleDamage`, `tp.passengers` | as labelled |
| `tpInsurer.name` | Third-party insurer | text | K | `bundle.atFaultInsurer.name` | third party insurer, payable by, at fault insurer |
| `tpInsurer.claimRef` *(alias `tpInsurer.reference`)* | Third-party claim reference | text | K | `bundle.claim.atFaultInsurerRef` | third party claim ref, third party ref, claim no, their ref |
| `tpInsurer.firstContactedOn` | Insurer contacted on | date | K | earliest `ncaf_sent`/`letter_out`/`email_out` event addressed to the at-fault insurer | insurer contacted on |
| `ownInsurer.name` | Own insurer | text | K | `src.ownInsurer.name` (`repos.getParty(claim.clientInsurerId)`) | own insurer |
| `ownInsurer.policyNumber` | Own policy number | text | K | `bundle.claim.clientPolicyNumber` | policy number |
| `ownInsurer.namePolicy` | Own insurer / policy | text | K | `Aviva / POL123` | own insurer policy |
| `ownInsurer.claimRef` | Own insurer claim reference | text | H | handler (data gap; never the policy number) | own claim ref, own insurer ref |
| handler-only own-insurer facts | — | — | H | `ownInsurer.cover` (comprehensive/tpft/tpo), `ownInsurer.excessPence`, `ownInsurer.reportedOn` | cover, policy excess, reported to own insurer on |

### A1.5 Hire and hire vehicle (subject hire = selected or latest `HireAgreement`)

| Key | Label | Type | Pol. | Source | Synonyms |
|---|---|---|---|---|---|
| `hire.agreementNumber` | Hire agreement number | text | A | `agreement.agreementNumber` | agreement ref, hire agreement ref |
| `hire.startAt` *(alias `hire.startDate`)* | Hire start | datetime | K | `agreement.startAt` | agreement hire start, hire start, date hire began |
| `hire.endDate` | Hire ended on | date | K | `agreement.endAt` (only when set) | hire ended on |
| `hire.dailyRatePence` | Daily hire rate | money | A | `agreement.dailyRatePence` (no VAT added) | daily credit hire, per hire day, daily hire rate, rate charged |
| `hire.gtaGroup` | Replacement GTA group | text | K | `agreement.gtaGroup ?? fleetUnit.gtaGroup` | replacement vehicle class |
| `hire.excessPence` | Hire vehicle excess | money | K | `agreement.excessPence` | excess |
| `hire.odometerOut` / `hire.odometerIn` | Odometer out / in | int miles | K | `agreement.odometerOut` / `.odometerIn` | odometer out, recorded mileage, odometer in |
| `hire.milesCovered` | Miles covered | int miles | K | in − out when both present and in ≥ out | miles covered |
| `hire.releasedAt` | Released (date & time out) | datetime | K | `agreement.deliveredAt ?? agreement.startAt` when ≤ now | date and time out, handover date and time |
| `hire.releaseDate` | Release date | date | K | date of `hire.releasedAt` | date (06 header) |
| `hire.returnedAt` | Returned (date & time in) | datetime | K | `agreement.collectedAt ?? agreement.endAt`, only when `endAt` is set | date and time in |
| `hire.hirerName` | Hirer full name | text | A | `bundle.claimant.name` | hirer full name, hirer |
| `hire.cancellationInfoGiven` | Cancellation information given | choice yes/no | K | `yes` when `enforceability.cancellationInfoProvidedAt` set, else none | cancellation information given |
| `hire.cancellationInfoDate` | … on | date | K | `enforceability.cancellationInfoProvidedAt` | on |
| `hire.gta.ownClassGroup` | GTA group, own vehicle class | text | K | `vehicle.gtaGroup` | hirers own vehicle class |
| `hire.gta.ownClassRatePence` | GTA rate, own vehicle class | money | K + confirm unless verified | `gtaRate(vehicle.gtaGroup, date(hire.startAt), src.gtaRates)` | rate |
| `hire.gta.replacementClassGroup` | GTA group, replacement class | text | K | `hire.gtaGroup` | replacement vehicle class |
| `hire.gta.replacementClassRatePence` | GTA rate, replacement class | money | K + confirm unless verified | `gtaRate(hire.gtaGroup, date(hire.startAt), src.gtaRates)` | rate |
| `hire.insuranceBasis` | Basis of cover | choice ccguk_arranged/hirers_own/other | G | `ccguk_arranged` when `policy.coveredUses` includes `credit_hire` | basis of cover |
| `hire.collectionMethod` *(alias `hire.releaseMethod`)* | Collected or delivered | choice collected/delivered | G | `delivered` when `agreement.deliveredAt` set (never from `collectedAt`) | vehicle collected from, collection, collected or delivered |
| `hire.deliveryAddress` | Delivered to | text | G | `claimant.address` | delivered to hirer at, delivered to |
| `hire.releasedBy` | Released by | text | G | `handler.name` | released by |
| `hire.required` | Credit hire required | bool | K | a `HireAgreement` exists on the claim | replacement vehicle on credit hire |
| `hire.conditionReportRef` | Condition report ref. | text | K | latest document with canonical id `form.ccguk_06_handover_condition` (`<title> <id first 8>`) | condition report ref |
| handler-only hire facts | — | — | H | `deliveryChargePence` (required before signing), `adminFeePence` (required before signing), `driverDecl.{moreThan3Accidents3y,disqualified3y,majorConviction,fullValidLicence}` (yes/no), `contractChannel` (premises/away/distance), `signedPlace`, `cancellationInfoMedium` (paper/email), `substitutionReason`, `selectionReason` (suggest `hireVehicle.makeModelReg — `), `ratePositionStatement`, `fuelOutPercent`, `chargeOutPercent`, `keysSupplied` (1/2), `gta.ownClassAutoGroup`, `gta.ownClassAutoRatePence`, `enfCheck.*` (yes/no, checkedBy, checkedDate, defects), `release.*` and `return.*` items (yes/no, 1/2 sets, n/a/1/2 cables), `condition.<panel>.{out,in}` (OK/S/C/D/CR/M/P; panels as printed in 06), `releaseDamage`/`returnDamage` (rows panel/code/description/photoRef), `receivedBy`, `returnedBy`, `returnLocation`, `fuelOut`, `fuelIn`, `batteryOutPercent`, `batteryInPercent`, `return.newDamage`, `return.damageNotifiedDate`, `return.fuelShortfall`, `return.fuelChargePence`, `return.cleaningRequired`, `return.cleaningChargePence` | as labelled |
| `hire.release.photoCount` / `hire.return.photoCount` | Photographs taken (count) | int | K | evidence photos tagged release/return (`captureShot`) | number taken |
| `hire.release.photoStore` / `hire.return.photoStore` | Stored at | text | K | `ClaimDesk evidence store, claim <reference>` | stored at |
| `hireVehicle.registration` | Replacement vehicle registration | text (reg) | K | `src.hire.vehicle.registration` (fleet unit → vehicle) | registration (replacement), replacement vehicle |
| `hireVehicle.makeModel` / `.makeModelReg` / `.colour` / `.vin` / `.engineFuel` / `.transmission` | Replacement vehicle particulars | text/choice | K | `src.hire.vehicle` | make and model (replacement) … |
| `hireVehicle.insurerName` / `hireVehicle.policyNumber` | Replacement vehicle insurer / policy | text | K | `src.hire.policy.insurerName` / `.policyNumber` | insurance provider, policy fleet ref |

### A1.6 Storage, recovery, engineer, payment

| Key | Label | Type | Pol. | Source |
|---|---|---|---|---|
| `storage.currentLocation` | Vehicle now at | text | K | open `bundle.storage[].location`, else latest `bundle.recovery[].toLocation` |
| `storage.facility` | Storage facility | choice carflex/other (+blank) | K | `carflex` when the location matches `/carflex|stanwell|tw19\s?7pd/i`, else `other` with the location in the blank |
| `storage.enteredAt` / `storage.startDate` | Entered storage | datetime/date | K | latest record `startAt` |
| `storage.releasedAt` / `storage.endDate` | Released | datetime/date | K | `endAt` only (open → blank) |
| `storage.days` | Storage days (inclusive) | int | K | closed records only: inclusive day count |
| `storage.dailyRatePence` | Daily storage rate | money | K | record `dailyRatePence` |
| `storage.netPence` | Storage charge (net) | money | K | closed only: days × daily rate, no VAT |
| `storage.instructedDate` | Storage instructed | date | K | storage instruction event, else `startAt` |
| `storage.odometerOnEntry` | Odometer on entry | int miles | K | odometer reading with source `collection` |
| `storage.required` / `storage.carriedOut` | Storage required / carried out | bool | K | a record exists |
| `storage.log` | Storage log | rows from/to/days/reason/evidence | K | `storage_reason` events when present |
| `storage.invoiceRef` | Storage invoice | text | K | ledger `invoiced` entry, head `storage` |
| `storage.part3SignedOn` | Part 3 signed on | date | K | signed date of 02 (canonical `agreement.ccguk_02_…`) |
| handler-only storage | — | — | H | `conditionOnEntry`, `keys` (1/2/none), `personalItems`, `releasedTo`, `releaseCapacity` (client/authorised/salvage — suggest salvage when `endTrigger` is salvage release), `releaseIdChecked`, `releaseAuthority` |
| `recovery.date` *(alias `recovery.attendedAt`)* | Recovered on / attended | datetime | K | first `bundle.recovery[].at` |
| `recovery.fromLocation` / `recovery.toLocation` | From / To | text | K | record |
| `recovery.loadedMiles` | Loaded miles | int | K | record |
| `recovery.mileagePence` | Mileage charge | money | K | loadedMiles × perLoadedMilePence |
| `recovery.netPence` | Recovery charge (net) | money | K | callout + mileage + admin |
| `recovery.basisText` | Recovery basis | text | K | `£90 + 12 mi × £3 + £25` |
| `recovery.instructedDate` | Recovery instructed | date | K | instruction event, else `at` |
| `recovery.outcome` | Recovery outcome | choice carried_out/not_carried_out/cancelled | K | `carried_out` when a record exists, else none |
| `recovery.carriedOut` / `recovery.required` / `recovery.notCharged` | — | bool | K | record exists / not carried out |
| `recovery.agentName` | Recovered by | text | K | party with role `recovery_agent`, else company registered name |
| `recovery.invoiceRef` | Recovery invoice | text | K | ledger `invoiced`, head `recovery` |
| `recovery.part2SignedOn` | Part 2 signed on | date | K | signed date of 02 |
| handler-only recovery | — | — | H | `provider` (ccguk/carflex/other), `deliveredAt`, `jobRef` |
| `engineer.instructedDate` | Engineer instructed | date | K | `bundle.report.instructedAt` |
| `engineer.inspectionAt` / `.inspectionBasis` / `.inspectionPlace` | Inspected / type / location | datetime/choice physical,image_based/text | K | `bundle.report` (`desktop` → image_based) |
| `engineer.name` | Assessor | text | K | engineer party name + `engineerQualifications` |
| `engineer.reportRef` / `engineer.issuedDate` | Report ref / dated | text/date | K | report reference / `issuedAt` |
| `engineer.roadworthy` | Roadworthy | bool | K | `bundle.report.roadworthy` |
| `engineer.odometerMiles` | Odometer at inspection | int miles | K | `bundle.report.odometerMiles` |
| `engineer.repairCostPence` + `engineer.repairCostVatBasis` | Repair cost + VAT basis | money + choice inc/ex | K | `bundle.estimate.totals.netPence`, `ex` |
| `engineer.pavPence` | Pre-accident value | money | K | `bundle.pav.pavPence` |
| `engineer.decision` | Decision | choice repairable/total_loss | K | `report.totalLoss` / outcome |
| `engineer.salvageCategory` | Salvage category | choice N/S/B/A/na | K | `report.salvageCategory` (`na` when repairable) |
| `engineer.salvageValuePence` | Salvage value | money | K | `report.salvageValuePence` |
| `engineer.feePence` / `engineer.feeCharged` | Fee / charged | money / choice charged,not_charged | K | `report.feePence` |
| `engineer.reportSentToClientDate` / `engineer.reportSentToInsurerDate` | Report sent | date | K | `letter_out`/`email_out` events carrying the report document id, to claimant / at-fault insurer |
| `engineer.outcome` / `engineer.carriedOut` / `engineer.required` / `engineer.part4SignedOn` / `engineer.invoiceRef` | — | — | K | report exists / `issuedAt` / signed 02 / ledger head `engineer_fee` |
| `payment.reference` | Payment reference | text | A | `bundle.claim.reference` |
| `payment.directs.{hire,recovery,storage,engineering,repair,pav,excess,other}` | Heads directed to CCGUK | bool | G | ledger heads present (`hire`, `recovery`, `storage`, `engineer_fee`, `repair`, `pav`, `excess`, others → `other`) |
| `payment.totalPence` | Account total | money | K | recovery.netPence + storage.netPence + engineer.feePence (+ additional) |
| handler-only payment | — | — | H | `additionalDescription`, `additionalInvoiceRef`, `additionalPence` |
| `services.{recovery,storage,engineering,creditHire}` | Services authorised (01 §05) | bool | G | recovery/storage records or `fnol.data.services`; engineer instruction/report; hire exists or status `hire_active` |
| `services.{diagnostics,repairCoordination}` | — | bool | H | handler |

### A1.7 Witness, intervention, means, evidence, diary, recipient

| Key | Label | Type | Pol. | Source |
|---|---|---|---|---|
| `witness.fullName` / `witness.initialsSurname` / `witness.dateOfBirth` / `witness.address` / `witness.phone` / `witness.email` | Witness particulars | text/date | A/K | `src.witness` (subject party; may be the claimant, driver, passenger or an independent witness) |
| `witness.onBehalfOf` | Party on whose behalf made | text | K | `Claimant` |
| `witness.statementNumber` | Number of this statement | text (ordinal) | K | 1 + count of non-void documents with canonical id `statement.witness` for this witness (`1st`, `2nd`) |
| `witness.exhibitRefsList` | Exhibits referred to | text | K | `JS1–JS3` from initials + running numbers of `src.exhibits`; `None` when empty |
| `witness.exhibits` | Exhibits | rows ref/item/pageOfTotal/capturedAt/deviceSource/originalHeldBy | K | `src.exhibits`: `capturedAt = exif.dateTimeOriginal ?? capturedAt` (never `uploadedAt`); device = exif make/model ?? sourceUrl; held by = `Courtesy Cars Group UK Ltd — claim file <reference>` |
| `witness.relationshipToClaimant` | Relationship to claimant | text | H (required) | suggestion from `Party.notes` "Relationship to the claimant: …" shown as a hint only |
| `witness.paragraphs` | Statement paragraphs (own words) | list | H | handler, typed from the witness's own words |
| `intervention.offerMade` / `intervention.noOfferMade` | Offer made / no offer made | bool | K / G | subject offer present / no offers on file (handler confirms) |
| `intervention.receivedAt` | Date & time offer made | datetime | K | `offer.receivedAt` |
| `intervention.channel` | Method | choice letter/email/telephone/portal | K | `offer.channel` (`phone` → telephone; sms/whatsapp/via_client → none + warning) |
| `intervention.offerorName` / `.offerorOrganisation` | Made by / organisation | text | K | `offer.offerorName` / party name of `offerorPartyId` |
| `intervention.madeTo` | Made to | choice client/ccguk | K | `via_client` → client, else ccguk (G) |
| `intervention.writtenOfferLocation` | Where the written offer is filed | text | K | filenames of `offer.evidenceIds` |
| `intervention.vehicleClassOffered` / `.suitable` | Group / suitable | text/bool | K | `offer.vehicleClassOffered` / `offer.suitable` (tri-state) |
| `intervention.terms.excessPence` / `.mileageLimit` / `.durationStated` / `.otherTerms` | Offer terms | money/text | K | `offer.terms.*` (`N miles per day`) |
| `intervention.clientDecision` | Client's decision | choice accepted/declined | K | `offer.clientDecision` (`pending` → none) |
| `intervention.replySentAt` | Insurer notified of decision on | date | K | `offer.replySentAt` |
| `intervention.clientReasons` | Client's reasons (own words) | multiline | K | `offer.clientReasons` verbatim (never `suitabilityReasons`) |
| `intervention.chronology` | Chronology | rows date/who/text/daysLost | K | events with a verbatim `data.quote` (summaries never qualify); `daysLost` handler |
| handler-only intervention | — | — | H | `writtenTermsReceived`, `vehicleOffered`, `transmissionOffered`, `matchesClientVehicle`, `fuelTypeOffered`, `terms.depositPence`, `terms.depositNone`, `terms.excessNotStated`, `permittedDrivers`, `minimumDriverAge`, `excessMileageCharge`, `onExpiry`, `deliveryAt`, `deliveryAddress`, `repairOffered`+`repairerOffered`, `courtesyCarForFullRepair`, `costToClient`, `termsPutToClientAt`, `termsPutToClientBy`, `confirmedToClientOn`, `hireEndedAsResult`, `daysSaved`, `valueOfDaysSaved`, `calculatedBy` |
| `means.*` | Statement of means | various | H | every figure and answer: `employmentStatus`, `dependants`, `householdAdults`, `income.<line>.{amount,frequency}` (lines `employedNetPay`, `selfEmployedDrawings`, `universalCredit`, `pipDla`, `childBenefit`, `housingBenefit`, `pension`, `other`), `income.totalMonthly`, `outgoings.<line>.{amount,frequency}` (`rentMortgage`, `councilTax`, `utilities`, `foodHousehold`, `telecoms`, `vehicleInsurance`, `fuelTravel`, `loans`, `cardRepayments`, `childcare`, `other`), `outgoings.totalMonthly`, `currentAccountBalance`, `savingsTotal`, `overdraftLimit`, `overdraftUsed`, `creditCards[0..1].{provider,limitBalance}`, `otherCredit`, `couldPay500Upfront`, `sacrificesNarrative`, `otherVehicleInHousehold`+`otherVehicleDetails`, `otherVehicleAvailable`, `otherVehicleExplanation`, `publicTransportSuitable`, `publicTransportExplanation`, `docsReceivedOn`, `docsReceivedBy`, `docsOutstanding`, `docsChasedOn`, `completedWithClientBy`, `completedWithClientOn`, `figuresCrossChecked`, `checkedBy`, `discrepancies`, `impecuniosityReliedOn` (yes/no/alternative), `decisionBy`, `statementCompletedOn` |
| `means.docs.{bankStatements,payslips,benefitLetters,creditCardStatements,overdraftEvidence,rentCouncilTaxEvidence}` | Documents supplied | bool | G | evidence kinds `bank_statement`, `payslip`, … (handler confirms "three months / every account") |
| `evidence.photosTaken` / `evidence.photoCount` | Photographs taken / number | bool/int | K | evidence of kind `photo` |
| `evidence.photosStoredAt` | Stored at (photographs) | text | G | `ClaimDesk evidence store, claim <reference>` |
| `evidence.{signedPack,recoveryJobSheet,storageLog,photos,engineerReport,insurerCorrespondence,invoices,remittance}` | Evidence held (02 C1.5) | rows held/date/ref | G | matching evidence kinds / documents (first date, filename) |
| `clocks.cctvPreservation.startDate` / `.followUpDate` | CCTV day 1 / follow-up | date | K | clock `cctv_preservation` `startsAt` / `dueAt` |
| `clocks.chaser1.dueDate` / `clocks.chaser2.dueDate` | Chasers | date | K | clocks `chaser_day_7` / `chaser_day_14` `dueAt` |
| `clocks.icobs3Months.dueDate` | Three-month point | date | K | clock `icobs_8_2_6_three_months` `dueAt` |
| `clocks.limitation.dueDate` | Limitation date | date | K | clock `limitation_tort_6y` `dueAt` |
| `hire.agreementSignedOn` / `means.statementCompletedOn` | Signed on | date | K | `agreement.signedAt` / signed date of the 07 document |
| `recipient.name` | Recipient name | text | A | `src.recipient.name` |
| `recipient.attentionName` | For the attention of (person) | text | H | handler (the recipient's handler, not CCGUK's) |
| `recipient.department` | Department / team | text | K | `src.recipient.attention` (`Third Party Claims Team`) |
| `recipient.addressLines` | Address lines | list | K | `src.recipient.addressLines` (all but last) |
| `recipient.townPostcode` | Town, POSTCODE | text | K | last address line |
| `recipient.email` | By email | text | K | `src.recipient.email` |
| `recipient.theirReference` | Your ref | text | K | `src.recipient.theirReference` |
| `recipient.salutation` | Salutation | text | K | `Sir or Madam` unless a named addressee is entered |

---

## Appendix 2 — Built-in mappings (curation guide for the `*.mapping.json` files)

Condensed from the template inventories. Notation: `section › [@qualifier] label → key (policy; notes)`. Section names
are the printed headings (selectors use the slug prefix, e.g. `section: "01"`). "S" = signature (never filled), "N" =
left as printed. Every slot the scanner finds must be covered by an entry or an `ignore` selector; the fields slice
dumps the scan (`pnpm --filter @ccguk/documents docx:scan <file>`) and writes the exact selectors. Shared notes:

- Header Reference box (`title › reference`, space box `CCG-` + spaces) → `claim.reference` (A; whole run).
  Header `Date` box → `doc.date` (G: "Fill today only when the client signs today") unless stated otherwise.
- Every `Signature` / `Date signed` line, initials box and "Date made" → S. Every pre-printed CCGUK name line is static
  (not a slot).
- Section headings print as "NN     Title"; the scanner slug is `NN-title-in-kebab-case`.

### `agreement.ccguk_01_customer_loa` (CCGUK-01, 5 pages)

- title › Reference → `claim.reference` A; Date → `doc.date` G.
- 01 › Customer full name → `claimant.name` A · Date of birth → `claimant.dateOfBirth` K (date boxes) · Address →
  `claimant.addressNoPostcode` K · Postcode → `claimant.postcode` K · Date of accident → `accident.date` A · Telephone →
  `claimant.phone` K · Email → `claimant.email` K · Vehicle make / model → `vehicle.makeModel` A · Registration →
  `vehicle.registration` A · VIN → `vehicle.vin` K · Mileage → `vehicle.mileageAtAccident` K (`45,210 miles`) · Accident
  location → `accident.location` A · Other vehicle (reg.) → `tp.vehicleRegistration` K · Other driver → `tp.driverName`
  K · Own insurer → `ownInsurer.name` K · Own claim ref. → `ownInsurer.claimRef` H · Third-party insurer →
  `tpInsurer.name` K · Third-party claim ref. → `tpInsurer.claimRef` K.
- 02 › checkbox "Where this agreement is signed after CCGUK began acting …" → `claim.retrospectiveAppointment` G;
  inline blank "first appointed CCGUK on ____ / ____ / ______" → `claim.firstInstructedAt` K with
  `onlyIf: { key: 'claim.retrospectiveAppointment', equals: true }`.
- 05 › six paragraph checkboxes → `services.recovery`, `services.storage`, `services.engineering` (G),
  `services.diagnostics`, `services.repairCoordination` (H), `services.creditHire` (G).
- 06 rates table → not slots (static contract text).
- 08 › STANDARD AUTHORITY → `claim.settlementAuthority` H `when: "standard"`; FULL SETTLEMENT AUTHORITY → same key
  `when: "full"` (never defaulted; note "If neither box is ticked, Standard Authority applies").
- 12 › dispute-referral consent checkbox → `claimant.consentDisputeReferral` H.
- 13 › @client Full name → `claimant.name` K · @client Signature, Date signed → S · @for-courtesy-cars-group-uk-ltd
  Signature, Date signed → S.
- Guards: `printedRates` (warn), `signatoryDirector` (warn).

### `agreement.ccguk_02_recovery_storage_engineering` (CCG-02 v5, 12 pages)

Variants: `instruction` (default; C1 entries carry `variants: ["submission"]`), `submission`.

- Cover (section `title`) › Agreement ref (`CCG-` cell) → `doc.agreementRef` A · Claim ref → `claim.reference` A · Client →
  `claimant.name` A · Vehicle reg → `vehicle.registration` A · Accident date → `accident.date` A · Liability →
  `claim.liability` K (Admitted/Disputed/Awaited) · Case handler → `handler.caseHandler` A · Contact → `handler.contact` K.
- header › Ref (`Ref CCG-______________`, parts header1/3/4) → `doc.agreementRef` A.
- A1.1 › Recovery INSTRUCTED → `recovery.instructedDate` K `onlyIf services.recovery`; Storage INSTRUCTED →
  `storage.instructedDate` K; Engineering INSTRUCTED → `engineer.instructedDate` K; YOUR INITIALS ×3 → S.
- A1.2 › contract channel (premises / away / distance) → `claim.agreementMadeAt` H; Early start → S.
- A1.4 › Full name → `claimant.name` A; Signature, Date signed → S.
- A2.1 › Title & full name → `claimant.name` A · Date of birth K · Address & postcode → `claimant.address` K · Mobile →
  `claimant.phone` K · Email K · ID seen → `claimant.idSeen` H · Licence no. → `claimant.drivingLicenceNumber` K.
- A2.2 › Make & model → `vehicle.makeModel` A · Registration A · VIN K · Colour K · Fuel → `vehicle.fuelType` K ·
  Transmission → `vehicle.transmission` K (Manual, Automatic order) · First registered → `vehicle.firstRegistered` K
  (month-year) · Odometer → `vehicle.mileageAtAccident` K · Registered keeper → `vehicle.registeredKeeper` K, blank in
  "Other" → `vehicle.keeperNameRelationship` H · Finance → `vehicle.financeOrLease` H, lender blank →
  `vehicle.financeLender` H.
- A2.3 › Date & time → `accident.dateTime` A · Location → `accident.location` A · Third-party vehicle →
  `tp.vehicleDescription` K · Third-party insurer → `tpInsurer.name` K · Third-party ref → `tpInsurer.claimRef` K ·
  Police ref → `accident.policeReference` K · Own insurer → `ownInsurer.name` K · Own insurer ref → `ownInsurer.claimRef`
  H · Liability → `claim.liability` K, its "Date" blank → `claim.liabilityDate` K · Vehicle condition →
  `accident.driveable` K · Vehicle now at → `storage.currentLocation` K.
- C1.1 › Outcome → `recovery.outcome` K · Carried out by → `recovery.provider` H (+ Other blank H) · From/To →
  `recovery.fromLocation`/`toLocation` K · Attended → `recovery.date` K · Delivered → `recovery.deliveredAt` H · Loaded
  miles → `recovery.loadedMiles` K · Job ref → `recovery.jobRef` H · charge line blanks (sub 1 miles, sub 2 mileage £,
  sub 3 total £) → `recovery.loadedMiles`, `recovery.mileagePence`, `recovery.netPence` K · Not charged →
  `recovery.notCharged` K.
- C1.2 › Facility → `storage.facility` K (+ Other blank) · Entered storage → `storage.enteredAt` K · Released →
  `storage.releasedAt` K · Condition on entry, Keys, Personal items, Released to, Capacity, ID checked, Release
  authority → `storage.*` H · Odometer → `storage.odometerOnEntry` K · storage log table → `storage.log` K · Total row
  Days → `storage.days` K · STORAGE CHARGE blanks (start, end, days, total) → `storage.startDate`, `storage.endDate`,
  `storage.days`, `storage.netPence` K.
- C1.3 › Outcome → `engineer.outcome` K (+ reason blank H) · Inspected → `engineer.inspectionAt` K · Inspection type →
  `engineer.inspectionBasis` K · Location → `engineer.inspectionPlace` K · Assessor → `engineer.name` K · Report ref,
  Report dated → K · Roadworthy → `engineer.roadworthy` K · Odometer → `engineer.odometerMiles` K · Repair cost →
  `engineer.repairCostPence` K + VAT basis choice `engineer.repairCostVatBasis` K · Pre-accident value →
  `engineer.pavPence` K · Decision K · Salvage category K (N S B A n/a) · Salvage value K · Report sent Client →
  `engineer.reportSentToClientDate` K · Charge → `engineer.feeCharged` K · Insurer sent →
  `engineer.reportSentToInsurerDate` K.
- C1.4 › per row Carried out → `recovery|storage|engineer.carriedOut` K · Basis (recovery text, storage days) → K ·
  Invoice → `*.invoiceRef` K · Charge (`£` cells) → `recovery.netPence`, `storage.netPence`, `engineer.feePence` K ·
  Additional row → `payment.additional*` H · Total → `payment.totalPence` K · Payable by → `tpInsurer.name` K ·
  Reference (`Vehicle reg: ______________`) → `vehicle.registration` A.
- C1.5 › each evidence row (Held / Date / Reference) → `evidence.*` G.
- C1.6 › Full name → `handler.name` K · Position → `handler.position` K · Signature, Date signed → S.
- C2 › OFFICE USE "Not applicable" → `claim.agreementMadeAt` G `when: "premises"` · initial here → S · Services
  cancelled → N · Agreement reference → `doc.agreementRef` K · Ordered on → N · Name → `claimant.name` K · Address
  (two lines) → `claimant.address` K (first line; second line N) · Signature, Date → S · office receipt line → N.
- Guards: `printedRates` (block in `submission` when totals would contradict 9000/300/2500/4500/28500 or VAT > 0),
  `openRecordsNoNow`. Style: `valueRun = { font: 'Calibri', sizeHalfPoints: 18, color: '1A1A1A' }`.

### `agreement.ccguk_03_credit_hire` (CCGUK-03, 14 pages)

Subjects: hire. Variants: `hirer` (default; `removeBlocks: ["enforceability-check"]`), `office`.

- title › Reference → `claim.reference` A; Date → `doc.date` G.
- 01 Parties › @hirer-client Full name → `hire.hirerName` A · Date of birth → `claimant.dateOfBirth` K (compact) ·
  Address → `claimant.address` K · Telephone → `claimant.phone` K · Driving licence no. →
  `claimant.drivingLicenceNumber` K. (@lessor column is static.)
- 01 › Agreement / hire start → `hire.startAt` K (datetime boxes) · Agreement ref. (`CCG-HIRE-____________`) →
  `hire.agreementNumber` A (whole run).
- 02 › Licence type → `claimant.licenceType` H · Licence held for → `claimant.licenceHeldYears` H · Licence number →
  `claimant.drivingLicenceNumber` K · Date of birth → K · Own insurer / policy → `ownInsurer.namePolicy` K · Own claim
  ref. → `ownInsurer.claimRef` H.
- 02 › Replacement vehicle insurance › Insurance provider → `hireVehicle.insurerName` K · Policy / fleet ref. →
  `hireVehicle.policyNumber` K · Excess → `hire.excessPence` K · Basis of cover → `hire.insuranceBasis` G.
- 02 › Authorised driver declaration × 4 → `hire.driverDecl.*` H (YES/NO; never defaulted).
- 03 › @original-vehicle: Make & model → `vehicle.makeModel` A · Registration A · Engine / fuel → `vehicle.engineFuel` K ·
  Transmission → `vehicle.transmission` K (text) · Accident date → `accident.date` A (compact) · GTA comparator group →
  `vehicle.gtaGroup` K. @replacement-vehicle: Make & model → `hireVehicle.makeModel` K · Registration →
  `hireVehicle.registration` K · Engine / fuel → `hireVehicle.engineFuel` K · Transmission → `hireVehicle.transmission` K ·
  Hire start → `hire.startAt` K (compact date) · GTA comparator group → `hire.gtaGroup` K.
- 04 A › Daily credit hire → `hire.dailyRatePence` A (digits) · Vehicle delivery → `hire.deliveryChargePence` H
  (`requiredBeforeSigning`) · Administration & setup fee → `hire.adminFeePence` H (`requiredBeforeSigning`).
- 04 B › own class: GTA group → `hire.gta.ownClassGroup` K, Rate → `hire.gta.ownClassRatePence` K (confirm unless
  verified) · own class + automatic uplift: group/rate → `hire.gta.ownClassAutoGroup`/`…RatePence` H · replacement
  class: group → `hire.gta.replacementClassGroup` K, rate → `hire.gta.replacementClassRatePence` K (confirm unless
  verified) · Actual CCGUK rate → `hire.dailyRatePence` A.
- Rate position › `£__________ per day` → `hire.dailyRatePence` A. Guard `ratePositionInstruction` (warn) — the
  drafting sentence is printed text; v1 does not rewrite it.
- Signature blocks #1 (04), #2 (06), #3 (09): @hirer Full name → `claimant.name` K (identical in all three); every
  Signature/Date signed → S.
- 05 › three channel checkboxes → `hire.contractChannel` H (`when` premises / away / distance) · Place where signed →
  `hire.signedPlace` H · Time signed → S · Vehicle collected from → `hire.collectionMethod` G (`CCGUK premises` =
  collected, `delivered to Hirer at` = delivered) with its blank → `hire.deliveryAddress` G `onlyIf collectionMethod =
  delivered` · Cancellation info YES/NO → `hire.cancellationInfoGiven` K · "on" date → `hire.cancellationInfoDate` K ·
  "by paper / email" → `hire.cancellationInfoMedium` H.
- 06 › three need checkboxes → H · "What I need a vehicle for" and "Journeys I cannot make" → H (client's own words;
  never pre-filled) · My damaged vehicle is → `vehicle.classDescription` G · Transmission required →
  `vehicle.transmission` K · Why a direct equivalent was not supplied → `hire.substitutionReason` H · Vehicle actually
  supplied, and why → `hire.selectionReason` H · no-upgrade / accept checkboxes → H.
- 07 › Recorded mileage → `hire.odometerOut` K · Fuel level → `hire.fuelOutPercent` H · Battery / charge →
  `hire.chargeOutPercent` H · Keys supplied → `hire.keysSupplied` H · Handover date & time → `hire.releasedAt` K ·
  Collection → `hire.collectionMethod` G · Condition report ref. → `hire.conditionReportRef` K · Registration →
  `hireVehicle.registration` K.
- 08 › five acknowledgement checkboxes → H.
- Enforceability check (`variants: ["office"]`; the block is removed in `hirer`) › ten YES/NO → `hire.enfCheck.*` H ·
  Checked by, Date, Defects → H.
- Cancellation form › `CCG-HIRE-____________________` → `hire.agreementNumber` A · Name → `claimant.name` K · Address →
  `claimant.address` K · Signature, Date → S.
- Guards: `hireReference`, `openRecordsNoNow`, `ratePositionInstruction`.

### `statement.ccguk_04_witness` (CCGUK-04, 3 pages)

Subjects: witness (required), exhibits (optional). Block rule: remove `exhibit-sheet` when `witness.exhibitRefsList`
equals `None`.

- Corner block (page 1) › [Party on whose behalf made] → `witness.onBehalfOf` K · [Initials and surname of witness] →
  `witness.initialsSurname` A · [Number of this statement — 1st, 2nd] → `witness.statementNumber` K · [Exhibit(s)
  referred to] → `witness.exhibitRefsList` K · [Date made] → S.
- Title › [FULL NAME] → `witness.fullName` A · [dd Month yyyy] (occurrence 1) → `accident.dateLong` A.
- Witness details › Witness → `witness.fullName` A · Date of birth → `witness.dateOfBirth` K · Address →
  `witness.address` K · Telephone/Email → K · Claimant vehicle → `vehicle.makeModelReg` A · Other vehicle →
  `tp.vehicleMakeModelReg` K · Location of collision → `accident.location` A · Date & approximate time →
  `accident.dateTimeApprox` A · Relationship to claimant → `witness.relationshipToClaimant` H `required`.
- Statement body › "I, [FULL NAME], of [full address including postcode]" → `witness.fullName` A, `witness.address` K ·
  numbered paragraphs → `witness.paragraphs` H.
- Statement of truth › Signed → S · Full name → `witness.fullName` A · Date signed → S · Telephone/Email → K.
- Exhibit sheet › corner: party → `witness.onBehalfOf` K, initials → `witness.initialsSurname` A, [Exhibit reference —
  e.g. AB1] → `witness.exhibits[0].ref` K, [Date made] → S · heading [AB1] and certificate [AB1] →
  `witness.exhibits[0].ref` K · certificate [FULL NAME] → `witness.fullName` A · certificate [dd Month yyyy]
  (occurrence 2) → S · Item → `witness.exhibits[0].item` K · Exhibit page → `witness.exhibits[0].pageOfTotal` K
  (`1 of 1`) · What this shows → H · Taken / created by → H · Date & time → `witness.exhibits[0].capturedAt` K ·
  Device / source → K · Original held by → K · image area bracket → N (paste the image in Word).
- Guard: `witnessRelationship`.

### `form.ccguk_05_payment_direction` (CCGUK-05, 3 pages)

- title › Reference → `claim.reference` A; Date → `doc.date` G.
- 01 › Client full name → `claimant.name` A · Date of birth → K · Address → `claimant.address` K (postcode included) ·
  Telephone/Email → K · Vehicle make / model → `vehicle.makeModel` A · Registration → `vehicle.registration` A · Date of
  accident → `accident.date` A · CCGUK reference (`CCG-____________-________`) → `claim.reference` A (whole run) ·
  Third-party insurer → `tpInsurer.name` K · Third-party claim ref. → `tpInsurer.claimRef` K · Own insurer →
  `ownInsurer.name` K · Own claim ref. → `ownInsurer.claimRef` H.
- 02 › eight head checkboxes → `payment.directs.{hire,recovery,storage,engineering,repair,pav,excess,other}` G
  (note: "If no box is ticked, this direction covers every head").
- 03 › Bank → `company.bank.bankName` A · Sort code (`____  —  ____  —  ____`) → `company.bank.sortCode` A · Account
  number → `company.bank.accountNumber` A · Payment reference → `payment.reference` A. (Account name is static.)
- 05 › Revoked on, Revocation received by, Paying parties notified of revocation on, Notified by → N.
- 06 › @client Full name → `claimant.name` K; signatures/dates → S.
- 07 › Form taken by → `handler.name` G · Date taken → P (`doc.signedDate`) · Copy given to client on → H · Method → H
  · Sent to third-party insurer on, Sent to own insurer on, Acknowledged by insurer on → P · Acknowledgement held at → H.
- Guards: `bankRequired`, `bankAccountName` (block).

### `form.ccguk_06_handover_condition` (CCGUK-06, ~4 pages)

Subjects: hire (required). Variants: `release` (default), `return` (return-stage entries carry `variants: ["return"]`).

- title › Reference → `claim.reference` A · Date → `hire.releaseDate` K.
- 01 › Registration → `hireVehicle.registration` A · Hire agreement ref. → `hire.agreementNumber` A · Make & model →
  `hireVehicle.makeModel` A · Colour → `hireVehicle.colour` K · VIN → `hireVehicle.vin` K · Transmission →
  `hireVehicle.transmission` K (Automatic, Manual order) · Hirer full name → `hire.hirerName` A · Driving licence no. →
  `claimant.drivingLicenceNumber` K · Hirer address → `claimant.address` K · Telephone/Email → K.
- 02 › Date & time out → `hire.releasedAt` K · Released by → `hire.releasedBy` G · Odometer out → `hire.odometerOut` K ·
  Fuel out → `hire.fuelOut` H · Battery charge out → `hire.batteryOutPercent` H · Collected or delivered →
  `hire.collectionMethod` G (+ delivered-to blank `hire.deliveryAddress` G) · items handed over × 8 → `hire.release.*` H.
- 03 › matrix @out × 26 → `hire.condition.<panel>.out` H · @in × 26 → `hire.condition.<panel>.in` H (`return`).
- 04 › damage table → `hire.releaseDamage` H · Photographs taken at release → `hire.release.photoCount` K (tick +
  count) · Stored at (release) → `hire.release.photoStore` K · return photo row → `hire.return.*` K (`return`).
- 05 › @hirer-at-release Full name → `hire.hirerName` A · @for-ccguk-at-release Full name → `hire.releasedBy` G ·
  signatures/dates → S.
- 06–08 (`return` only) › Date & time in → `hire.returnedAt` K · Received by → H · Odometer in → `hire.odometerIn` K ·
  Miles covered → `hire.milesCovered` K · Fuel in, Battery, Returned by, Location of return, items returned × 8 → H ·
  new damage table → `hire.returnDamage` H · New damage identified? → `hire.return.newDamage` H (+ notified date H) ·
  Fuel / charge shortfall → H · both "Charge raised" → H (never computed) · Cleaning → H · return signatures: hirer
  Full name → `hire.hirerName` K, CCGUK Full name → `hire.receivedBy` H, signatures/dates → S.
- Guard: `openRecordsNoNow`, `hireReference`.

### `form.ccguk_07_statement_of_means` (CCGUK-07, 4 pages)

- title › Reference → `claim.reference` A · Date → `doc.date` H (only the day it is completed with the client).
- 01 › Client full name → `claimant.name` A · Date of birth → K · Address → `claimant.address` K · CCGUK reference →
  `claim.reference` A · Date hire began → `hire.startAt` K (date) · Employment status, Occupation, Number of dependants,
  Household adults → H.
- 02 › every income row @amount-gbp / @frequency → `means.income.<line>.amount|frequency` H · Total monthly income →
  `means.income.totalMonthly` H (the values form offers "Calculate", which sums lines converted to monthly only when every
  filled line has a frequency).
- 03 › outgoings rows likewise → `means.outgoings.*` H.
- 04 › balances, overdraft, cards, other credit, £500 question, "what would you have had to go without" → H.
- 05 › other vehicle, availability, public transport, both Explanation rows → H.
- 06 › six document checkboxes → `means.docs.*` G · Documents received on/by, outstanding, chased on → H.
- 07 › @client Full name → `claimant.name` A; signatures/dates → S.
- 08 › every office-use field → H (attestations; never ticked by code).

### `form.ccguk_08_intervention_mitigation` (CCGUK-08, 4 pages)

Subjects: offer (optional — none means a "No offer made" record).

- title › Reference → `claim.reference` A · Date → `doc.date` A ("complete this the day an offer is made").
- 01 › Client full name → `claimant.name` A · CCGUK reference → `claim.reference` A · Vehicle / registration →
  `vehicle.makeModelReg` A · Date of accident → `accident.date` A · Third-party insurer → `tpInsurer.name` K ·
  Third-party claim ref. → `tpInsurer.claimRef` K · Daily hire rate on this file → `hire.dailyRatePence` K · Daily storage
  rate → `storage.dailyRatePence` K.
- 02 › NO OFFER MADE → `intervention.noOfferMade` G · OFFER MADE → `intervention.offerMade` K · Position recorded as at
  → `doc.date` A · Recorded by → `handler.name` A.
- 03 › Date & time offer made → `intervention.receivedAt` K · Method → `intervention.channel` K · Made by — name →
  `intervention.offerorName` K · Organisation → `intervention.offerorOrganisation` K · Made to →
  `intervention.madeTo` K · Written terms received? → H · Where the written offer is filed →
  `intervention.writtenOfferLocation` K.
- 04 › Group / class → `intervention.vehicleClassOffered` K · Suitable for client's use? → `intervention.suitable` K ·
  Insurance excess amount → `intervention.terms.excessPence` K · Mileage limit → `intervention.terms.mileageLimit` K ·
  Duration offered → `intervention.terms.durationStated` K · Any condition attached → `intervention.terms.otherTerms` K ·
  every other row (vehicle offered, transmission, matches, fuel, excess not stated, deposit, drivers, age, excess mileage,
  expiry, delivery, repair, courtesy car, cost) → H.
- 05 › Terms put to client on, By → H · Client's decision → `intervention.clientDecision` K · Confirmed in writing → H ·
  Insurer notified → `intervention.replySentAt` K · Client's reasons → `intervention.clientReasons` K (verbatim) · Hire
  ended as a result → H with date blank `hire.endDate` K `onlyIf` yes · Days saved, Value of days saved, Calculated by → H.
- 06 › chronology table → `intervention.chronology` K.
- 07 › @client Full name → `claimant.name` A; signatures/dates → S.

### `form.ccguk_09_accident_report` (CCGUK-09, 6 pages)

- title › Reference → `claim.reference` A · Date → `doc.date` A.
- 01 › Full name → `claimant.name` A · Date of birth → K · Address → `claimant.address` K · Telephone/Email → K ·
  Driving licence number → K · Licence held since → H · Occupation → H · PCO / private hire driver? (+ badge) → H ·
  Signed client authority held? → `claim.clientAuthoritySigned` K, dated → `claim.clientAuthoritySignedOn` K · Photo ID
  verified? → `claimant.photoIdVerified` K.
- 02 › Make & model → `vehicle.makeModel` A · Registration → A · VIN, Colour → K · Year / mileage →
  `vehicle.yearMileage` K · Transmission → `vehicle.transmission` K · Registered keeper → `vehicle.registeredKeeperName`
  K · Owner if different → H · Finance or lease (+ provider), Outstanding balance → H · Own insurer → `ownInsurer.name` K
  · Policy number → `ownInsurer.policyNumber` K · Cover, Policy excess, Own claim reference, Reported to own insurer on → H.
- 03 › Date → `accident.date` A · Time → `accident.time` A · Road / junction → `accident.location` A · Town & postcode →
  `accident.townPostcode` K · every other row → H.
- 04 › client's account box → `accident.circumstances` K (verbatim; block margins shrink) · Account taken by →
  `accident.accountTakenBy` K · Date & time taken → `accident.accountTakenAt` K · apology/statements → H.
- 05 › Panels damaged → `vehicle.panelsDamaged` G · Point of first impact, Direction of force → H · Vehicle driveable? →
  `accident.driveable` K · Airbags deployed? → `accident.airbagsDeployed` K · Pre-existing damage → H · Current location
  → `storage.currentLocation` K · Recovered on → `recovery.date` K · Recovered by → `recovery.agentName` K · Photographs
  taken? (+ number) → `evidence.photosTaken`, `evidence.photoCount` K · Stored at → `evidence.photosStoredAt` G.
- 06 › Registration → `tp.vehicleRegistration` K · Make, model & colour → `tp.vehicleMakeModelColour` K · Driver name,
  address, telephone → `tp.driver*` K · Details obtained how? → H · Third-party insurer → K · Policy number →
  `tp.policyNumber` K · askMID checked on, askMID result → H · Third-party claim reference → K · Insurer contacted on →
  `tpInsurer.firstContactedOn` K · Damage to other vehicle, Passengers → H.
- 07 › Police attended? → K · Police reference → K · Force & station, within 24 hours, breath test (+ result), reported
  for offence → H · witnesses table → `accident.witnesses` K · Was anyone injured? → `accident.injuries` K · injury
  advice date / channel / in writing → H.
- 08 › CCTV table: Request sent column → `accident.cctv.<source>.requestSentOn` K; Contact / address and Overwrite date
  → H.
- 09 › Recovery / Storage / Engineering / Credit hire required? → `recovery.required`, `storage.required`,
  `engineer.required`, `hire.required` K with signed-on blanks → `recovery.part2SignedOn`, `storage.part3SignedOn`,
  `engineer.part4SignedOn`, `hire.agreementSignedOn` K · Impecuniosity → `means.impecuniosityReliedOn` H with
  `means.statementCompletedOn` K · diary dates → `clocks.*` K.
- 10 › Form completed by → `handler.name` A · Date (completed) → `doc.date` A · Reviewed by, Date (reviewed) → P ·
  CCGUK reference allocated → `claim.reference` A · Ledger opened? → `claim.ledgerOpened` A.

### `letter.ccguk_letterhead_formal` (Letterhead, 1 page)

Subjects: recipient (defaults to the at-fault insurer).

- Recipient block › [Name of handler] → `recipient.attentionName` H `removeIfEmpty: paragraph` · [Department / Team] →
  `recipient.department` K remove · [Insurer or company name] → `recipient.name` A · [Address line 1], [Address line 2]
  → `recipient.addressLines` K (items 0, 1) remove · [Town, POSTCODE] → `recipient.townPostcode` K remove · BY EMAIL
  [recipient@insurer.co.uk] → `recipient.email` K remove (paragraph).
- Reference panel › Our Ref → `claim.reference` A · Your Ref → `recipient.theirReference` K `removeIfEmpty: row` ·
  Claim No. → `tpInsurer.claimRef` K remove row · Client → `claimant.name` A · Vehicle → `vehicle.makeModelReg` A · Date
  of Accident ([dd Month yyyy] occurrence 1) → `accident.dateLong` A · Date (occurrence 2) → `doc.dateLong` A.
- Salutation [Sir or Madam] → `recipient.salutation` K · RE: [SUBJECT …] → `doc.subject` H `required` · [CLIENT] →
  `claimant.name` A · [REG] → `vehicle.registration` A.
- Body paragraphs → `doc.body.paragraphs` H (paragraph 1 keeps the printed opening sentence; see §L.3).
- Reply by ([dd Month yyyy] occurrence 3) → `doc.replyByDate` G `removeIfEmpty: paragraph`.
- Yours [sincerely / faithfully] → `doc.valediction` A · wet-signature spacer → not a slot · [Full name] →
  `handler.name` A · Enc. → `doc.enclosures` H remove · Cc. → `doc.cc` H remove.
- Guard: `signatoryRole` (warn).

---

## Appendix 3 — Catalogue make groups (fan-out for the data slice)

Each group writes `packages/kb/data/vehicle-catalogue/makes/<slug>.json` for its makes (slugs in brackets). Segment
hints are the defaults for the main model lines; the authors decide per model.

| Group | Makes |
|---|---|
| **G1 Volume European (VW Group, Ford, Vauxhall)** | Volkswagen [volkswagen] (incl. Commercial Vehicles: Caddy, Transporter, Crafter, Amarok, ID. Buzz), Skoda [skoda], SEAT [seat], Cupra [cupra], Ford [ford] (incl. Transit family, Ranger, Tourneo), Vauxhall [vauxhall] (incl. Combo, Vivaro, Movano) — *drafts exist in scratch* |
| **G2 German & Swedish premium** | Audi [audi], BMW [bmw], Mini [mini], Mercedes-Benz [mercedes-benz] (incl. Citan, Vito, Sprinter, X-Class, EQ models), Smart [smart], Porsche [porsche], Volvo [volvo], Polestar [polestar], Saab [saab] (2000–2011) — *Audi, BMW, Mini drafts exist* |
| **G3 Japanese** | Toyota [toyota] (incl. Hilux, Proace family, Land Cruiser), Lexus [lexus], Honda [honda], Nissan [nissan] (incl. Navara, NV200/NV300/NV400, Primastar, Interstar, Townstar), Mazda [mazda], Mitsubishi [mitsubishi] (incl. L200), Subaru [subaru], Suzuki [suzuki], Daihatsu [daihatsu] (to 2011), Infiniti [infiniti] (2009–2019), Isuzu [isuzu] (D-Max, Rodeo) |
| **G4 Korean, Chinese and other Asian** | Hyundai [hyundai], Kia [kia], Genesis [genesis], SsangYong / KGM [ssangyong] (dvlaNames SSANGYONG, KGM), Daewoo [daewoo] (to 2004), Chevrolet [chevrolet] (2005–2015 Europe range), MG [mg] (MG Rover era ZR/ZS/ZT/TF 2000–2011 and SAIC era 2011+), BYD [byd], Omoda [omoda], Jaecoo [jaecoo], GWM / Ora [gwm] (dvlaNames GWM, ORA), Great Wall [great-wall] (Steed), Proton [proton], Perodua [perodua], Tata [tata], Leapmotor [leapmotor], XPeng [xpeng], LDV / Maxus [ldv] (dvlaNames LDV, MAXUS) |
| **G5 French, Italian, US and Iveco** | Peugeot [peugeot] (incl. Partner, Expert, Boxer, Rifter, Traveller), Citroën [citroen] (incl. Berlingo, Dispatch, Relay, SpaceTourer; DS3/DS4/DS5 to 2015), DS Automobiles [ds] (2015+), Renault [renault] (incl. Kangoo, Trafic, Master), Dacia [dacia], Alpine [alpine], Fiat [fiat] (incl. Doblo, Scudo, Ducato, Fullback, Talento), Abarth [abarth], Alfa Romeo [alfa-romeo], Chrysler [chrysler] (incl. Ypsilon/Delta 2011–2015), Jeep [jeep], Dodge [dodge] (2006–2010), Cadillac [cadillac], Iveco [iveco] (Daily ≤ 3.5 t) |
| **G6 British, EV specialists and exotics** | Jaguar [jaguar], Land Rover [land-rover] (Range Rover models are models of Land Rover; dvlaNames LAND ROVER), Rover [rover] (2000–2005), LEVC [levc], Lotus [lotus], Aston Martin [aston-martin], Bentley [bentley], Rolls-Royce [rolls-royce], McLaren [mclaren], Morgan [morgan], Caterham [caterham], Ineos [ineos], Tesla [tesla], Ferrari [ferrari], Lamborghini [lamborghini], Maserati [maserati] |

74 makes. Coverage priorities inside each group: highest UK volume first (Ford, Vauxhall, VW, BMW, Mercedes-Benz, Audi,
Toyota, Nissan, Kia, Hyundai, Peugeot, Renault, Skoda, Honda, Citroën, Fiat, Mini, SEAT, Mazda, Land Rover, Volvo, MG,
Tesla, Dacia, Suzuki, Jaguar, Lexus, Cupra, Mitsubishi, Porsche, BYD, Polestar, DS).

---

## Appendix 4 — Paste parser label synonyms (case-insensitive; `:` optional)

| Field | Labels |
|---|---|
| registration | Registration, Reg, Registration Number, Reg Number, Vehicle Registration, Number Plate, VRM |
| make | Make, Manufacturer, Vehicle Make, Marque |
| model | Model, Vehicle Model, Model/Variant, Model Variant, Description |
| colour | Colour, Color, Vehicle Colour, Body Colour |
| bodyType | Body Style, Body Type, Body |
| doors | Doors, Number of Doors, No. of Doors |
| seats | Seats, Seating Capacity, Number of Seats |
| yearOfManufacture | Year of Manufacture, Year Manufactured, Manufactured, Year, Build Year, Model Year |
| firstRegisteredDate / monthOfFirstRegistration | Date of First Registration, Date First Registered, First Registered, Registered, Registration Date, First Registration |
| engineCapacityCc | Engine Size, Engine Capacity, Cylinder Capacity, Engine CC, Capacity |
| fuelType | Fuel Type, Fuel |
| transmission | Transmission, Gearbox, Gear Box, Transmission Type |
| powerBhp | Power, BHP, Engine Power, Max Power |
| co2Gkm | CO2 Emissions, CO2, Co2 Output, Emissions |
| euroStatus | Euro Status, Euro Emissions, Emission Standard |
| vin | VIN, VIN Number, Chassis Number, Vehicle Identification Number |
| motStatus / motExpiryDate | MOT, MOT Status, MOT Expiry, MOT Expiry Date, MOT Due, MOT Valid Until, MOT Expires |
| taxStatus / taxDueDate | Tax, Tax Status, Road Tax, Tax Due, Tax Due Date, Tax Expiry, VED |
| lastMotMileage / lastMotDate | Mileage, Last MOT Mileage, Recorded Mileage, Odometer, Last MOT Date, Last MOT |

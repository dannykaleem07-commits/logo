# DOCX template engine (`@ccguk/documents` → `docx/`)

Design: `docs/TEMPLATES-VEHICLES-DESKTOP.md` §A. The engine **fills blanks in the user's Word files in place; it
never rewrites printed wording.** DOCX templates are not registered in the HTML template registry.

```ts
import { scanDocx, fillDocx, convertDocxToPdf } from '@ccguk/documents';

const scan = scanDocx(bytes);                       // slots, blocks, outline, warnings, plain text
const { docx, sha256, report } = fillDocx(bytes, [{ slotId: 'title/reference', value: { type: 'text', text: 'CCG-2026-00012' } }],
  { coreProps: { title, subject, keywords, created: now, modified: now }, now, removeBlocks: ['enforceability-check'] });
const pdf = await convertDocxToPdf(docx, { workDir: `${DATA_DIR}/tmp/convert`, metadata: { title } });
```

## Files

| File | What |
|---|---|
| `types.ts` | every public type (incl. `LetterContent` for the fields slice) |
| `zip.ts` | `openDocx` / `writeDocx` (fflate) with the zip-bomb limits checked in the unzip filter before inflating |
| `xml.ts` | @xmldom/xmldom parse/serialise (DTD/ENTITY refused), `partDom`, `listParts`, element helpers |
| `safety.ts` | `checkDocxSafety` (upload gate) |
| `text.ts` | `normaliseText`, `slugify` (normative), paragraph text model, `replaceRange` |
| `patterns.ts` | blank / bracket / token regexes, label helpers, signature rule, colours, heading regexes |
| `context.ts` | structure walk helpers: styles, headings, banner tables, tables, header rows, label columns, cells |
| `scan.ts` | `scanDocx` (+ engine-internal `scanPackage` with live DOM targets) |
| `fill.ts` | `fillDocx` |
| `props.ts` | `setDocxProperties` (core.xml / app.xml) |
| `preview.ts` | `docxToPlainText`, `docxToPreviewHtml`, `extractHeaderFooter` |
| `pdfmeta.ts` | `stampPdfMetadata` (also used by `render.ts`) |
| `convert/` | `convertDocxToPdf`, `detectDocxConverters`; Word (PowerShell COM), LibreOffice, browser (docx-preview) |
| `cli.ts` | `pnpm --filter @ccguk/documents docx:scan <file.docx> [--json]` |
| `samples.ts` | `pnpm --filter @ccguk/documents docx:samples` → `out/docx/` |
| `__fixtures__/` | synthetic .docx builders and the test read-back helper |

## Scanner rules as implemented (and where the design was ambiguous)

Everything in §A.5/§A.6 is implemented. These are the decisions taken where the design left room, and the real slugs
that differ from examples in the design document:

- **Title section.** Text before the first level-1 heading is section `title`, and no level-2 heading is opened there
  (so the CCGUK-02 cover fields are `title/agreement-ref`, `title/claim-ref` … and the Letterhead is all `title/…`).
- **Heading slugs ignore placeholders.** `Exhibit  [AB1]` is the level-1 heading `exhibit`; the bracket is still a slot
  (`exhibit/ab1`). Filling a placeholder never changes a section id.
- **Block names.** A block is named by its first heading (slugify, max 48): the 03 block is
  `enforceability-check-internal-use-not-for-the-hi` (the design's `…-hirer` is longer than 48 characters; selectors
  match by prefix `enforceability-check`). The 04 exhibit page's heading slug is `exhibit`; the design names that block
  `exhibit-sheet`, so `patterns.ts` `BLOCK_ALIASES` maps `exhibit` → `exhibit-sheet`. A block ends before the next
  page-break paragraph or before a paragraph that carries a section break (`w:sectPr`, never removed).
- **Two-digit clause numbers.** `^\d{2}(\s{2,}|\t)\S` also matches the 02 B2 clauses `10   ACCESS …` – `20   …`; they
  appear in the outline as level-1 headings but hold no slots.
- **Header rows / label columns.** A label column must hold printed text only (no glyph, blank or bracket), so a
  `Basis` column with `______ days × £45.00` is a value column. In a table with a header row, a value cell's label is
  the left-most cell of the contiguous run of label-column cells to its left (spacer columns stop the search) — 06
  matrix `@in/bonnet`, 03 rate table `@rate/vehicle-delivery`.
- **Cell headings** need a label paragraph immediately after them (`CLIENT` → `Full name`), so `Signed` above a line
  (04) is a label, not a qualifier.
- **`line`** slots are only produced inside table cells (an empty bottom-bordered paragraph under a label paragraph), or
  for a value cell whose only border is the bottom one (02 A1.4).
- **`block`** label: the paragraph above when ≤ 90 characters, otherwise the section title without its number
  (09 → `04-what-happened-in-the-clients-own-words/what-happened-in-the-clients-own-words`).
- **Blank labels**, in order: the cell's label (label paragraph above it in the cell, or the label cell / column-row
  label) when no checkbox/bracket/… precedes the blank in its paragraph; a bold lead run directly in front of the
  blanks (`STORAGE CHARGE ___ to ___ = ___ days × £45.00 = £___` → `storage-charge:1…4`); the last ≤ 6 words of the
  prose since the previous slot, cut at `·`, tabs and wide gaps; the first ≤ 4 words after it; the previous paragraph's
  blank label for a blank-only continuation line (`address#2`); else `blank`. Several blanks with the same label in one
  paragraph get `sub` 1, 2, …. The 01 §02 blank is therefore `02-appointment-and-authority-to-act/that-i-first-appointed-ccguk-on`
  (six words; the design's example shows five).
- **Glyph groups.** An option runs from its glyph to the next glyph and stops early at `·`, a tab, a gap of 3+ spaces
  followed by text, or a sentence end (`N/A. Acknowledged …`). A blank inside an option's text belongs to the option
  (`options[].blank`); text after a group boundary is prose (`☐ Awaited     Date: ___` → choice `liability` + blank
  `date`). A group of one glyph is a `checkbox`. A lone checkbox's label is the text after it up to the first blank or
  boundary, or the cell label when the glyph opens a labelled cell.
- **Sort codes** `____  —  ____  —  ____` are one `text` blank (the formatter splits the digits).
- **Signature slots.** `SIGNATURE_RE` is applied to short labels: ≤ 3 words (`Signature`, `Date signed`, `YOUR INITIALS`,
  `Time signed`), or a label starting with Signature/Signed, or ending in "initial here"/"sign here"; never a question
  (`Signed client authority held?`), a label ending in "on"/"by" (`Part 2 signed on`), or a place (`Place where signed`).
  Long checkbox prose that merely mentions signing is not a signature slot.

## Fill notes

- `report.removed` lists `remove` slot ids and removed blocks as `block:<id>`.
- A `remove` never deletes a paragraph that holds a section break or the only paragraph of a cell (it is emptied), and
  never leaves a table without rows (the table goes).
- Choice: with `selected` empty only the option blanks are filled; the printed ticks stay.
- Money blanks: a leading `£` in the value is dropped when the template prints one (no `££`).

## DOCX → PDF

`auto` = Word → LibreOffice → browser; `DOCX_PDF_CONVERTER` sets the default preference; conversions are serialised and
detection is cached per process. Every PDF is stamped (`Courtesy Cars Group UK Ltd` / `ClaimDesk` /
`ClaimDesk — Courtesy Cars Group UK Ltd` / en-GB) before hashing.

The browser converter renders a copy of the .docx in which `w:lineRule="atLeast"` becomes exact
`max(line, 1.22 × largest run size)` and a missing `lineRule` becomes `auto` — docx-preview otherwise doubles every
"at least" line (`calc(100% + Npt)`). Calibri is aliased to Carlito / Liberation Sans / Arial with `@font-face local()`
when it is not installed. Measured here (Chromium 141, no Calibri/Carlito; labels fill) against LibreOffice with Writer:

| File | browser | LibreOffice |
|---|---|---|
| 01 | 5 | 5 |
| 02 | 14 | 15 |
| 03 | 14 | 15 |
| 04 | 3 | 3 |
| 05 | 3 | 3 |
| 06 | 5 | 6 |
| 07 | 4 | 5 |
| 08 | 4 | 4 |
| 09 | 6 | 6 |
| Letterhead | 1 | 1 |

Packaging must ship `docx-preview/dist/docx-preview.min.js` and `jszip/dist/jszip.min.js` (resolved with
`createRequire(import.meta.url)`).

## Tests

`pnpm --filter @ccguk/documents test` — the browser integration test runs when Chromium is found
(`CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`); the LibreOffice integration test runs only with
`SOFFICE_PATH` set to a Writer-enabled soffice. `__fixtures__/readback.ts` re-scans a filled document with the
template's slot map (a filled blank is no longer a blank, so a plain re-scan cannot find it again).

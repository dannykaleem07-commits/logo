# @ccguk/documents — template and renderer contract

Branded HTML documents → PDF for ClaimDesk. Every outgoing letter, invoice, report, notice, agreement, form,
statement, pack, bundle, schedule and certificate is a **template**: a pure function of a typed data object that
returns a complete HTML string. The API assembles the data from the ledger, events, offers, clocks and settings;
the template never retypes a figure, never reads the clock, and never fetches anything.

```
src/
  brand.ts          company details, palette, typography, page margins, legacy block list, status line
  format.ts         date / money / HTML formatters — the ONLY way to print a date or an amount
  common.ts         shared data shapes (CompanySettings, RecipientBlock, ClaimHeader, BaseDocumentData) + sample*() fixtures
  logo.ts           inline SVG lockup (read once, minified, cached)
  layout.ts         baseLayout() + partials + Playwright headerTemplate()/footerTemplate()
  registry.ts       Template<TData>, registerTemplate, getTemplate, listTemplates, renderTemplate, DocumentDataError
  render.ts         renderPdf(html, opts) → {pdf, sha256, pages}; mergePdfs; resolveChromium; closeBrowser
  guards.ts         findBlockedStrings / findBannedPhrases (legacy details, banned disclaimer phrases)
  hash.ts           sha256Hex, htmlSha256
  samples.ts        `pnpm --filter @ccguk/documents samples` → out/<id>.html + .pdf for every production template, table of id/version/pages/sha256/bytes
  all-templates.test.ts  whole-registry checks: ARCHITECTURE.md coverage, perimeter wording, FOS rule, purity of template sources
  templates/
    index.ts        re-exports every template file (evaluating them registers the set; names must be unique across files)
    _example.ts     THE PATTERN TO COPY (letter.example — not imported by index.ts)
    letters-a.ts    letters-b.ts  invoices.ts  reports.ts  agreements-forms.ts  packs-bundles.ts  notices.ts  certificate.ts
```

## Using it (API side)

```ts
import { renderTemplate, renderPdf, listTemplates, DocumentDataError } from '@ccguk/documents';

listTemplates();                                   // [{ id, version, kind, title, recipientRole?, requiredData }]
const r = renderTemplate('letter.ncaf', data);     // throws DocumentDataError { missing: [...] } if requiredData is absent
// r = { templateId, templateVersion, kind, title, html, htmlSha256 }
const { pdf, sha256, pages } = await renderPdf(r.html, { reference: data.claim.ourReference });
// optional: statusLine, tradingDisclosure, registeredOffice, landscape, timeoutMs
await closeBrowser();                              // on shutdown
```

`renderPdf` prints A4 with `brand.page` margins, `headerTemplate(reference)` (registered name · "Our ref: … · Page X of Y")
and `footerTemplate(statusLine, tradingDisclosure)` on every page. If you do not pass `tradingDisclosure`, it is
built from `registeredOffice`, falling back to the `<meta name="ccguk:registered-office">` that `baseLayout` embeds.
Chromium: `CHROMIUM_PATH` → scan `PLAYWRIGHT_BROWSERS_PATH` (default `~/.cache/ms-playwright`) → `chromium`/`google-chrome`
on PATH. Running as root (containers) or `CHROMIUM_NO_SANDBOX=1` adds `--no-sandbox --disable-dev-shm-usage`.

`mergePdfs([a, b, …])` concatenates PDFs for packs and bundles. `pdfPageCount(buf)` counts pages.

## Adding a template (one pattern, no exceptions)

1. **Open `templates/_example.ts` and copy its shape** into the right file (`letters-a.ts`, `invoices.ts`, …).
   One `registerTemplate({...})` call per template, at module top level. Named exports only; export the data
   interface and the template object so tests and the API can import them.
2. **Define the data interface** — extend `BaseDocumentData` (`settings`, `date`, `claim`, `recipient?`, `signatory?`)
   and add only what the template prints. Money is `Pence` (integer); dates are ISO strings. If the ledger knows it,
   the API supplies it: totals, VAT, deadlines, days of hire, amounts received. Do not compute a deadline or a total
   in a template unless a partial does it from the data you were given (`scheduleTable` sums lines when no ledger
   totals are passed — prefer passing them).
3. **`id` and `version`.** `id` is `<kind>.<name>` and must match ARCHITECTURE.md's list (e.g. `letter.ncaf`,
   `invoice.hire`, `report.engineer`). `version` is semver; bump it when the wording or structure changes — it is
   stored on every generated document.
4. **`requiredData`** lists every key the render reads (dot paths: `'claim.ourReference'`, `'hire.totalPence'`).
   `renderTemplate` refuses to render without them. A key is missing when undefined, null or `''`.
5. **`sample()`** returns a complete fixture built from `sampleBaseData()` / `sampleSettings()` / `sampleClaim()` /
   `sampleRecipient()`. Never a real client, never a legacy address or number. Keep the brief's own figures where
   relevant (£1,287 vs £1,112; S1 £42.32; storage £45/day; recovery £90 + £3/mile + £25).
6. **`render(data)`** builds the body with partials and returns `baseLayout({...})`:

   ```ts
   render: (d) => baseLayout({
     title: 'New Claim Advice Form',           // H1 on non-letters; <title> everywhere
     kind: 'letter',
     reference: d.claim.ourReference,
     theirReference: d.claim.theirReference,
     date: d.date,
     recipient: d.recipient,
     settings: d.settings,                     // registered office for the company block / disclosure
     signatory: d.signatory ?? { name: d.settings.signatoryName, role: d.settings.signatoryRole },
     meta: [{ label: 'Invoice number', value: d.invoiceNumber }],   // optional extra reference rows
     showCompanyBlock: true,                   // default: kind === 'invoice'
     bodyHtml,
   })
   ```
7. **Import the file in `templates/index.ts`** (the eight listed files already are). Never import `../index.js` from a
   template — import `../registry.js`, `../layout.js`, `../format.js`, `../common.js` directly.
8. Run `pnpm --filter @ccguk/documents typecheck && pnpm --filter @ccguk/documents test`. `registry.test.ts`
   automatically renders **every** registered template's sample and fails on legacy strings, banned phrases,
   `Invalid Date`, `NaN` or `undefined` in the output; `all-templates.test.ts` adds the ARCHITECTURE.md coverage check (add a
   new id there or to its `KNOWN_EXTRA_TEMPLATE_IDS`), the perimeter wording rules and the no-FOS-to-the-at-fault-insurer rule. `pnpm --filter @ccguk/documents samples` writes HTML and PDF
   for each template to `out/` for eyeballing.

## Partials (layout.ts)

| Partial | Use |
|---|---|
| `subjectBlock(claim)` | Claimant / vehicle / accident date / your insured / your reference table at the top of a letter |
| `standardOpener(claim)` | "We are instructed to correspond on behalf of … in connection with the road traffic accident on …" |
| `reLine(text)` | Bold "Re:" line |
| `letterBlock({reference, theirReference, date, recipient, meta})` | Our ref / Your ref / Date + recipient (baseLayout calls it for you) |
| `figuresTable(rows)` | `{label, valuePence \| text, note?, emphasis?}` — money via formatGBP; `emphasis` = total row |
| `chronologyTable(events)` | `{date, description, attributableTo?, source?}` — dated chronology |
| `scheduleTable(lines, {totals?, showVat?, caption?, totalLabel?})` | Invoice / schedule-of-loss lines with net, VAT, gross |
| `keyValueTable(rows)` | Particulars (vehicle, bank, policy) |
| `callout(html, title?)` | Tinted box with gold rule — deadline, payment details, "what we require" |
| `signatureBlock(signatory, date?, {closing?, onBehalfOf?, signedAt?})` | CCGUK staff signature; baseLayout adds one when `signatory` is set |
| `statementOfTruth({kind: 'claimant' \| 'witness' \| 'expert', signatoryName?, documentNoun?, date?})` | CPR wording (PD 22 / PD 32 / PD 35) with signature fields — the claimant, witness or expert signs, never CCGUK |
| `reExecutionLine(date, supersedesVersion)` | BLUEPRINT §3.8 re-execution line |
| `companyBlock(settings)`, `contactStrip()`, `partnerMarkSlot()` | Masthead pieces (partner mark renders nothing while disabled) |
| `pageBreak()` | Forced page break; CSS classes `.page-break`, `.avoid-break`, `.right`, `.center`, `.small`, `.muted` |

Formatters (format.ts): `formatDateLong` (4 October 2026), `formatDateShort` (04/10/2026), `formatDateWithDay`
(Sunday 4 October 2026 — use for deadlines), `formatDateTime` (4 October 2026, 14:35, Europe/London), `formatPeriod`
(10 August 2026 to 2 September 2026 (24 days) — inclusive), `daysInclusive`, `formatGBP`/`formatMoney`,
`formatMoneyWhole`, `formatRate`, `formatPercent`, `formatNumber`, `formatMiles`, `plural`, `ordinal`,
`formatRegistration` (AB12 CDE), `addressLines`, `escapeHtml`, `nl2p`, `numberedList`, `bulletList`, `joinAnd`.
Invalid dates throw — a document never prints "Invalid Date".

## Voice and perimeter (non-negotiable)

- Register: calm, specific, dated. Short sentences, one point per paragraph. Every request numbered. A specific
  deadline and a specific consequence (`formatDateWithDay` + `callout`). State the other side's position fairly, then why it fails.
- "We are instructed to correspond on behalf of …". Never "our solicitors", "we act as your solicitors", "legal advice".
  The claimant is the litigant in person; litigation documents are drafts for the claimant or an instructed solicitor to sign.
- GTA is an **industry benchmark** for a non-subscriber — never an entitlement or "under the GTA you must".
- No FOS threat to the at-fault insurer (a third-party claimant cannot go to FOS against it, DISP 2.7). Escalation
  for an at-fault insurer: chaser → complaint under DISP 1 (eight weeks) → letter before claim → proceedings.
- Injury → referral out, no fee. Never tell a client to ignore an insurer's offer.
- Legacy strings (`brand.legacy.blockedStrings`) and banned phrases (`brand.legacy.bannedPhrases`) never appear;
  the tests enforce it. The mandatory status line ("…is not regulated by the SRA") is whitelisted by the guard.
- The status line and the Part 6 trading disclosure are printed by the layout (screen footer) and by the PDF footer
  on every page — do not add them to the body.

# ClaimDesk architecture and build contract

ClaimDesk is the Courtesy Cars Group UK Ltd ("CCGUK") accident claims, credit hire and accident management platform specified in `docs/BLUEPRINT.md`. This file is the contract every package is built against.

## Layout (pnpm workspace)

```
claimdesk/
  packages/domain      @ccguk/domain     pure TypeScript engines, no I/O, vitest
  packages/kb          @ccguk/kb         knowledge base content (JSON) + retrieval + advisor
  packages/documents   @ccguk/documents  branded HTML templates → PDF (playwright-core / Chromium)
  packages/db          @ccguk/db         Drizzle ORM (sqlite-core) schema, migrations, repositories
  apps/api             @ccguk/api        Fastify REST API, lookups, evidence store, e-sign, jobs
  apps/web             @ccguk/web        React + Vite PWA
  docs/                                  BLUEPRINT (spec), this file, setup guides, legal caveats
```

Node 22+, pnpm 10, TypeScript 5.9 (strict, NodeNext, `.js` suffix on relative imports), vitest 3.
Packages are consumed from source (`main: ./src/index.ts`) — no build step is required to run.

## Non-negotiable conventions

1. **Money is integer pence** (`Pence`). Format with `formatGBP`. Never floats of pounds.
2. **Dates are ISO strings.** `ISODate` = `YYYY-MM-DD`; `ISODateTime` = ISO 8601. Working-day arithmetic uses `packages/domain/src/calendar` (England & Wales bank holidays).
3. **Append-only**: ledger entries, events and evidence are never updated or deleted. Corrections are new rows that reference the superseded row (`supersedesId`).
4. **One source of truth**: documents render from a `dataSnapshot` assembled from the ledger, events, offers and clocks. Templates never accept free-typed amounts or dates for things the ledger knows.
5. **Nothing is sent automatically.** Every outgoing document is `draft` → consistency check → `approved` by a human → `sent`. A `block` flag stops approval until cleared with a reason, which is logged.
6. **Verification is data.** Anything the brief marks "verify"/"UNVERIFIED" carries a `Verification` object. Code never upgrades `unverified` → `verified`; only a human with a source URL does. Unverified directory numbers are shown with a warning; unverified citations are flagged by the consistency engine (`UNVERIFIED_CITATION`).
7. **GTA is a benchmark, not law** for a non-subscriber (GTA 2.7(j)). Templates say "industry benchmark"; the consistency engine flags `GTA_CITED_AS_LAW` if a draft asserts GTA terms as legal entitlement.
8. **Perimeter**: no document implies regulated status (`REGULATED_STATUS_IMPLIED`). Litigation documents are drafts for the claimant (litigant in person) or an instructed solicitor to sign. Injury → referral out, no fee. Never name a forum that is not open (third-party claimant cannot go to FOS against the at-fault insurer: DISP 2.7) → `FORUM_NOT_OPEN`.
9. **Legacy details are blocked** (`brand.legacy`): "Car Flex", "Carflex Ltd" (unless exactly `CARFLEX LTD`), 17360033, 66 Paul Street, EC2A 4PX, courtesycarsuk.co.uk, and the banned disclaimer phrases.
10. **Scraping is not a feature.** Comparables, rate evidence and adverts are captured manually (URL + screenshot/PDF + timestamp + hash). Live lookups only call documented APIs (DVLA VES, DVSA MOT, Companies House, a licensed gateway).
11. **Tests**: every domain function has vitest coverage with the brief's own numbers as fixtures (e.g. £1,287 stated vs £1,112 received must block; S1 £42.32; storage £45/day; recovery £90 + £3/mile + £25).
12. **No new dependencies** without noting it in the build report; the dependency set is fixed in each `package.json`.
13. **Named exports only**, no default exports in packages. Keep each module's public API in its `index.ts`.

## Domain modules (`packages/domain/src/<module>/index.ts`)

| Module | Responsibility (BLUEPRINT §) | Key exports (names are the contract) |
|---|---|---|
| `calendar` | E&W working days, bank holidays 2024–2030, `addWorkingDays`, `addCalendarMonths`, `workingDaysBetween`, `isWorkingDay`, `endOfWorkingDay` | |
| `clocks` | §3.3, §3.4, §3.6, §7: derive every `Clock` from a claim's events (`deriveClocks(claim, events, now)`), GTA 4.1/4.2/3.6/4.8/4.9/4.14/4.10/4.11/6.7/6.8, intervention reply 1 WD, storage report+48h, ICOBS 8.2.6 3 months, chasers 7/14/21/28, DISP 8 weeks, FOS 6 months, DSAR 1 month, NIP 14 days, s.172 28 days, PCN stages, limitation, Part 36 21 days, default judgment 14 days | `deriveClocks`, `clockDefinitions` |
| `gta` | §2 finding 2, §3.3, §7: rates lookup (`gtaRate(group, date)`), group mapping from vehicle, hire charge calculation with additional-driver £5.50/day cap £110 (5.4), off-hire triggers, monitoring diary (4.10–4.11 delay ≥2 WD or >20%), late-payment uplift 10%/20% (6.8.6, benchmark only), payment-pack validator (6.1–6.3: covering letter, mitigation questionnaire, advice form, hire period validation form, engineer's report, storage and recovery accounts) | `gtaRate`, `mapGtaGroup`, `calculateHire`, `offHireDeadline`, `monitoringDiary`, `latePaymentUplift`, `validatePaymentPack` |
| `consistency` | §3.7, §3.8, §3.10: `checkDraft(draftHtmlOrText, context) → ConsistencyReport`; extract amounts/dates/deadlines/assertions; compare to ledger, offers register, storage/hire records, prior outgoing letters; legacy and banned phrases; regulated-status wording; forum-not-open; GTA-as-law; date-before-creation; duplicate signature dates | `checkDraft`, `extractAmounts`, `extractDates`, `legacyCheck`, `bannedPhraseCheck` |
| `vehicle` | §3.2: `normaliseRegistration`, UK plate format validation, `mileageConflicts(readings, tolerance)`, `projectOdometer(motHistory, atDate)`, `crossFileRegistrationCheck`, DVLA VES/DVSA MOT payload → `Vehicle` mappers (pure) | |
| `linkage` | §3.9: `findConnections(parties, staff, suppliers, previousClients)` on names (fuzzy), phones (normalised), emails, addresses, bank details, vehicles; witness independence score | `findConnections`, `witnessIndependence` |
| `evidence` | §3.8, §6: `sha256Hex`, evidence-gate evaluation (`evaluateGates(claimBundle) → GateResult[]`) for need/use/period/rate/impecuniosity/mitigation/enforceability/liability; guided-shot checklist | `evaluateGates`, `guidedShotList`, `sha256Hex` |
| `esign` | §3.8: OTP generate/verify (HMAC, 6 digits, expiry), certificate payload assembly, signature-date sanity (never before creation; duplicate-date alert) | `generateOtp`, `verifyOtp`, `buildCertificate`, `signatureDateChecks` |
| `pav` | §4.3–4.4: comparables filter (year ±1, mileage ±25%, same fuel/transmission, radius widening), normalisation via price-to-mileage regression (fallback band £0.05–£0.10/mile flagged), options and condition adjustments, 1.5×IQR outliers, Cat S/N & ex-fleet & POA exclusions, median + IQR band, reasoning paragraph, audit trail | `assessPav`, `normaliseComparables`, `regressPerMile`, `pavReasoning` |
| `estimate` | §4.5: totals (`computeTotals`), paint/materials methods, pre-existing separation, reconciliation vs imported total, labour library (`labourLibrary.add/median`) built from own approved estimates, text-line parser for imported estimates (`parseEstimateText`) | `computeTotals`, `reconcile`, `LabourLibrary`, `parseEstimateText` |
| `totalloss` | §4.7–4.8: `assessTotalLoss` (repair + projected hire + storage vs PAV − salvage), `predictTotalLoss` (rules-first logistic score; `calibrated:false` <100 outcomes), ABI salvage categories with descriptions and EV notes | `assessTotalLoss`, `predictTotalLoss`, `salvageCategories` |
| `quantum` | §5.2, money.md §3–4: schedule of loss from ledger, interest (s.69 CCA 1984 simple at a given rate; ICOBS 8.2.9–11 base+4% from the 3-month breach; LPCDIA 8% over base B2B only), Part 36 helper, court fee lookup (from kb fees, with verification), track allocation, settlement arithmetic (accept-now vs fight-on), expected value | `scheduleOfLoss`, `interest`, `courtFee`, `allocateTrack`, `settlementArithmetic` |
| `acceptance` | §2 finding 4, §3.1, money.md §1: liability score (Highway Code rules, CCTV/dashcam, independent witness, contradiction, prior claim), Tescher costs exposure from hire:other-heads ratio, impecuniosity & enforceability readiness, perimeter flags, decision | `scoreLiability`, `assessAcceptance` |
| `playbook` | §7: `nextActions(claimBundle, now) → PlaybookAction[]` — the get-paid-faster engine: NCAF day 1, CCTV days 1–7, payment pack on hire end, split heads/interim, chaser cadence → complaint day 28, DSAR for call recordings, LBC/Part 36/default judgment, vendor-verification pack; blocked by gates | `nextActions` |
| `intake` | §3.1: FNOL validation (mandatory fields), script guard (never tell client to ignore an offer; ask what/who/when → intervention register), injury routing (referral task, no fee), call-recording disclosure text | `validateFnol`, `intakeScript`, `routeInjury` |
| `fleet` | §3.12: compliance alerts (MOT/tax/insurance/service/keeper address/PHV eligibility), class-of-use allocation guard (`canAllocate(unit, use, policies)`), PCN/NIP workflow transitions, liability-transfer particulars (Road Traffic (Owner Liability) Regs 2000 Sch 2), s.172 response data | `complianceAlerts`, `canAllocate`, `penaltyTransition`, `liabilityTransferParticulars` |

A "claim bundle" is the plain object `{ claim, claimant, vehicle, events, ledger, offers, hire, storage, recovery, evidence, documents, clocks, pav?, estimate?, report? }` — defined in `packages/domain/src/types.ts` consumers as `ClaimBundle` (export it from `playbook` or `evidence`; whichever agent gets there first, the other imports it).

## Knowledge base (`packages/kb`)

- `data/cases.json` — `KbEntry[]` for every case in BLUEPRINT §5.1 plus any added during research, with `verification` reflecting what was actually checked (Find Case Law / BAILII / secondary).
- `data/statutes.json`, `data/cpr.json`, `data/gta.json` (paragraph-level: 2.7(j), 3.6, 4.1, 4.2, 4.7–4.11, 4.14, 5.4, 6.1–6.3, 6.7, 6.8.6, Appendix C), `data/fca.json` (ICOBS 8.1, 8.2.1R, 8.2.6R, 8.2.9R–8.2.11R; DISP 1, 2.7), `data/fos.json`, `data/guidance.json` (ABI salvage code, PD 27A fees cap, Lay Representatives Order 1999, TfL PHV).
- `data/gta-rates.json` — `GtaRate[]` 2026–27 (and 2025–26 where known), each with verification.
- `data/court-fees.json` — issue and hearing fees with verification (EX50).
- `data/insurer-directory.json` — `InsurerDirectoryEntry[]`: third-party lines, IVR option paths, emails, portals, copycat blacklist, verification.
- `data/playbook-rules.json` — codified get-paid-faster steps with basis citations (consumed by `domain/playbook` at runtime via injection, not import, to keep domain pure).
- `src/search.ts` — `search(query, {types?, topics?, limit?}) → ranked KbEntry[]` (BM25 over citation/title/principle/text/tags).
- `src/advisor.ts` — `advise(topic|claimState) → {summary, points:[{text, citations:[KbEntry.id]}], caveats}`; marks unverified citations; includes "forum not open" and perimeter checks.
- Licence rules: legislation.gov.uk (OGL) may be quoted; Find Case Law → principle + link only unless computational-analysis licence recorded; BAILII → link only; CPR/FCA → short quotes + link.

## Documents (`packages/documents`)

- `render.ts`: `renderPdf(html, opts) → {pdf: Buffer, sha256, pages}` via playwright-core using `CHROMIUM_PATH` or `PLAYWRIGHT_BROWSERS_PATH` discovery; header/footer templates with reference and "Page X of Y"; footer carries Part 6 disclosure + status line.
- `registry.ts`: `templates: Record<TemplateId, Template>` where `Template = { id, version, title, kind: 'letter'|'invoice'|'report'|'notice'|'agreement'|'form'|'statement'|'pack'|'bundle', render(data) → html, requiredData: string[] }`.
- Template set (minimum): `letter.ncaf`, `letter.handling_ref_request`, `letter.intervention_reply`, `letter.collect_or_pay`, `letter.delay_notice_gta_4_10`, `letter.chaser_7`, `letter.chaser_14`, `letter.chaser_21`, `letter.complaint_disp`, `letter.dsar`, `letter.cctv_preservation`, `letter.letter_before_claim`, `letter.part36_offer`, `letter.vendor_verification_pack`, `letter.pav_challenge`, `letter.particularisation_demand`, `invoice.hire`, `invoice.storage`, `invoice.recovery`, `invoice.engineer_fee`, `report.engineer`, `report.pav`, `agreement.credit_hire`, `form.cancellation_sch3`, `form.express_request_to_start`, `form.mitigation_questionnaire`, `form.statement_of_means`, `form.statement_of_need`, `statement.witness`, `pack.gta_payment`, `bundle.litigation_index`, `notice.pcn_liability_transfer`, `notice.s172_response`, `schedule.loss`, `certificate.signature`.
- Every template renders from a typed data object and includes the data it needs for the consistency engine (amounts and dates rendered via the shared formatters only).

## API (`apps/api`) — route contract

Base `/api`. JSON bodies validated with zod. Errors `{error:{code,message,details?}}`.

- `GET /health`
- Claims: `GET/POST /claims`, `GET /claims/:id` (full bundle), `PATCH /claims/:id`, `POST /claims/:id/status`, `GET /claims/:id/clocks`, `GET /claims/:id/gates`, `GET /claims/:id/actions` (playbook), `GET /claims/:id/acceptance`
- Parties: `GET/POST /parties`, `GET/PATCH /parties/:id`, `GET /parties/:id/connections`
- Vehicles: `GET/POST /vehicles`, `GET /vehicles/:id`, `POST /vehicles/lookup` `{registration}` → VES + MOT (live if keys, else `manual_required`), `POST /vehicles/:id/odometer`, `GET /vehicles/:id/mileage-conflicts`
- Ledger & events: `GET/POST /claims/:id/ledger`, `GET/POST /claims/:id/events`
- Hire/storage/recovery: `GET/POST /claims/:id/hire`, `POST /claims/:id/hire/:hireId/end`, `GET/POST /claims/:id/storage`, `POST /claims/:id/storage/:sid/end`, `GET/POST /claims/:id/recovery`
- Intervention: `GET/POST /claims/:id/offers`, `PATCH /claims/:id/offers/:oid`
- Evidence: `POST /claims/:id/evidence` (multipart; hashes, EXIF, write-once), `GET /evidence/:id`, `GET /evidence/:id/file`
- Documents: `GET /templates`, `POST /claims/:id/documents` `{templateId, data?}` → draft + consistency report, `GET /documents/:id`, `GET /documents/:id/pdf`, `POST /documents/:id/clear-flag`, `POST /documents/:id/approve`, `POST /documents/:id/send`, `POST /documents/:id/sign/start`, `POST /documents/:id/sign/verify`
- Engineering: `GET/POST /claims/:id/estimate`, `POST /claims/:id/estimate/import` (text/PDF lines), `GET/POST /claims/:id/pav`, `POST /claims/:id/pav/comparables`, `POST /claims/:id/pav/assess`, `GET/POST /claims/:id/engineer-report`, `POST /claims/:id/total-loss/assess`, `POST /claims/:id/total-loss/predict`
- Fleet: `GET/POST /fleet`, `GET /fleet/alerts`, `POST /fleet/:id/allocate-check`, `GET/POST /fleet/penalties`, `POST /fleet/penalties/:id/transition`
- Directory & KB: `GET /directory?q=`, `PATCH /directory/:id/verify`, `POST /directory/:id/report-failed`, `GET /kb/search?q=&type=&topic=`, `GET /kb/advise?topic=`, `GET /kb/gta-rates?date=`
- Monitoring: `GET /watch`, `POST /watch`, `POST /watch/poll` (Companies House)
- Analytics: `GET /analytics/overview`, `GET /analytics/debtor-days`, `GET /analytics/reductions`, `GET /analytics/cycle-times`, `GET /analytics/interventions`
- Settings: `GET/PATCH /settings` (registered office, bank, VAT, ICO, rate card, API key presence)

Seed (`pnpm seed`): the four live-file archetypes from the brief (File 1 "£1,287 vs £1,112 / bank validation", File 2 "storage capped at report+48h / engineer fee refused", File 3 "lane-merge liability dispute", File 4 "non-independent witness"), CARFLEX LTD (12640635) on the watch list as high risk, fleet units with declared uses, directory and rates from kb.

## Web (`apps/web`)

React 19 + React Router 7 + TanStack Query. Brand: logo colours (navy `#072647`, blue `#1466D2`) in the shell; document palette for previews. Screens: Dashboard (clocks due, blocked documents, actions, debtor days), Claims list, New claim (FNOL wizard with script guard and injury routing), Claim file tabs (Overview · Chronology · Ledger · Clocks · Evidence gates · Documents · Intervention register · Vehicle & lookups · Engineering (estimate, PAV, total loss, report) · Next actions · Flags), Fleet (units, alerts, penalties), Directory (search, IVR path, verification badge, "report failed"), Knowledge base (search + advisor), Analytics, Settings, Guided capture (camera, 8–12 shot overlay, hashes before upload). PWA manifest + service worker (offline shell).

## Live-file lessons → feature map

| Lesson | Failure seen | Feature |
|---|---|---|
| a | Letter stated £1,287 paid when £1,112 received; deadlines inconsistent | Position-consistency engine blocks approval |
| b | Dates on agreements not credible | Document hashing, creation-timestamp floor, re-execution line, duplicate-date alert |
| c | Insurer alleged offer was ignored | Intervention register + 1-WD written reply clock |
| d | Hire/storage ran past the trigger | Off-hire and storage end triggers with GTA basis |
| e | Mileage figures disagreed across documents | Mileage conflict engine |
| f, h | Same registration on two files; fleet unit used as "client" vehicle | Cross-file registration check; hard stop |
| g | Witness connected to claimant | Connected-party checker |
| i | Legacy name/address/company number leaked into letters | Legacy-detail checker |
| j | Injury element handled in-house | Injury referral routing, no fee |
| k | Supplier CARFLEX in strike-off | Companies House watch, supplier risk banner |
| l | Fleet PCNs sent to stale V5C address; cover mismatch | Fleet compliance, keeper-address flag, class-of-use guard |
| m | Client told to ignore courtesy-car offer | Script guard |

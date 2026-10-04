# @ccguk/api — ClaimDesk REST API

Fastify 5 + SQLite (via `@ccguk/db`) + the pure engines in `@ccguk/domain` + the templates in `@ccguk/documents` + the
knowledge base in `@ccguk/kb`. Base path `/api`. JSON bodies are validated with zod; errors are
`{ error: { code, message, details?, requestId } }`. Money is integer pence, dates are ISO strings, the ledger / events /
evidence / audit log are append-only, every mutation writes an `audit_log` row, and **nothing is ever sent
automatically** — a `send` records `sentAt`/`sentVia` and hands the PDF back for the handler to send.

## Run

```bash
pnpm --filter @ccguk/api dev        # tsx watch src/server.ts  (migrations run on boot; data dirs are created)
pnpm --filter @ccguk/api start
pnpm --filter @ccguk/api seed       # users, settings, the four live-file archetypes, fleet, watch list (idempotent)
pnpm --filter @ccguk/api typecheck && pnpm --filter @ccguk/api test
```

Environment (`.env` in `apps/api/` or the repo root; every variable is optional):

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `3000`, `0.0.0.0` | listen address |
| `DATA_DIR` | `apps/api/data` | parent of the defaults below |
| `DATABASE_PATH` | `$DATA_DIR/claimdesk.sqlite` | SQLite file (`:memory:` in tests) |
| `EVIDENCE_DIR`, `DOCUMENTS_DIR` | `$DATA_DIR/evidence`, `$DATA_DIR/documents` | write-once evidence store, rendered PDFs |
| `CHROMIUM_PATH` | — | passed through to `@ccguk/documents` `renderPdf` (tests use `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` when present) |
| `WEB_DIST_DIR` | `apps/web/dist` | when `index.html` exists it is served at `/` with SPA fallback |
| `DVLA_VES_API_KEY` | — | DVLA Vehicle Enquiry Service |
| `DVSA_MOT_CLIENT_ID`, `DVSA_MOT_CLIENT_SECRET`, `DVSA_MOT_API_KEY`, `DVSA_MOT_TOKEN_URL`, `DVSA_MOT_SCOPE_URL` | scope defaults to `https://tapi.dvsa.gov.uk/.default` | DVSA MOT History (OAuth2 client credentials) |
| `COMPANIES_HOUSE_API_KEY` | — | Companies House (watch list). Without it the poll marks rows `unverified` and skips |
| `ESIGN_SECRET` (alias `SIGNING_SECRET`) | dev-only fallback; required in production | HMAC secret for the e-signature OTP |
| `JOBS_ENABLED` | unset | `true` starts the schedulers (nightly watch poll, hourly clocks refresh); never in tests |
| `DEFAULT_USER_ID` | `handler` | user assumed when `X-User-Id` is absent (dev/test only) |
| `LOOKUP_TIMEOUT_MS` | `10000` | outbound lookup timeout |

Keys never leave the process: only presence flags are exposed (`/api/health`, `Settings.apiKeys`).

## Auth placeholder

`X-User-Id: <users.id>` identifies the caller; the hook loads the user and sets `request.user` and `request.actor`
(`{ userId, ip }`) which every audited mutation records. Without the header, development and test fall back to the
seeded `handler` user (`DEFAULT_USER_ID`); production returns `401 UNAUTHENTICATED`. Unknown ids are 401. Replace the
`onRequest` hook in `src/app.ts` with the real identity layer — nothing downstream changes.

Every response carries `x-request-id` (honours an inbound `X-Request-Id`).

## Error mapping (`src/app.ts` → `mapError`)

| Thrown | Status / code |
|---|---|
| `ZodError` | `400 VALIDATION` with `details[{path,message,code}]` |
| `@ccguk/db` `ValidationError` | `400 VALIDATION` |
| `NotFoundError` | `404 NOT_FOUND` |
| `ImmutableError` (`LedgerImmutableError`, `EventImmutableError`, `EvidenceImmutableError`, …) | `409 IMMUTABLE` |
| `DocumentStateError` / `VerificationError` | `409` |
| `HttpError` (`src/errors.ts`) | as given (`HARD_STOP`, `ALLOCATION_REFUSED`, `WRONG_CLAIM`, `DOCUMENT_BLOCKED`, `EXTRA_OVERRIDES_LEDGER`, `S172_REFUSAL`, `HASH_MISMATCH`, …) |
| anything else | `500 INTERNAL` (logged with the request id) |

## Layout

```
src/
  config.ts            loadConfig()/testConfig() — env, data dirs, key presence
  context.ts           AppContext { config, handle, db, repos, settings(), kb, now(), engines(), logger, close() }
  app.ts               buildApp(ctx): cors, multipart (25 MB), static web + SPA fallback, error handler, auth placeholder
  server.ts            start(): migrations on boot, data dirs, listen
  seed.ts, seed/       dev seed (archetypes.ts: the four live files; png.ts: programmatic PNG evidence)
  engines.ts           typed adapters to the @ccguk/domain engines (see "Engines")
  jobs.ts              JOBS_ENABLED schedulers + POST /jobs/run
  errors.ts            HttpError helpers
  schemas/             zod schemas mirroring packages/domain/src/types.ts (services.ts: the services half)
  services/
    intake.ts          FNOL normalisation (API ⇄ web-client body) → domain FnolInput
    claimView.ts       bundle + clocks/gates/actions/acceptance, insurerPaidBefore
    sideEffects.ts     event → side effects (off-hire clocks, storage report+48h, offers)
    lookup.ts          DVLA/DVSA/Companies House clients + mapping
    fallbacks.ts       API-side clock supplement (off-hire triggers from the hire record)
    evidence.ts        write-once content-addressed evidence store (sha256, EXIF, manifest, verify)
    documentData.ts    one-source-of-truth template data per template id
    documents.ts       draft → consistency → approve (PDF) → send (record) → supersede → sign
    consistencyReconcile.ts  system clearance of engine misreads on ledger-written table figures
    engineeringFallbacks.ts  total-loss / checklist adapters + estimate text-extraction provider
    fleetFallbacks.ts  compliance / penalty / notice-data adapters
    companiesHouse.ts  Companies House client (profile + gazette filings)
    kb.ts              knowledge-base access: search, advise, GTA rates, directory status, citations
    analytics.ts       debtor days, reductions, cycle times, interventions, overview
  routes/              one module per resource + index.ts registry
  test/                fastify-inject integration tests on an in-memory database
```

## Route-module convention

A module is `src/routes/<name>.ts` exporting `register<Name>Routes(app: FastifyInstance, ctx: AppContext): void`,
appended to the `routeModules` array in `src/routes/index.ts` (a plain array; every module is mounted under `/api`):

```ts
app.post('/claims/:id/thing', async (request, reply) => {
  const { id } = params<{ id: string }>(request);        // routes/helpers.ts
  requireClaim(ctx, id);                                 // 404 when missing
  const body = parse(thingBody, request.body);           // zod → 400 on failure
  const row = ctx.db.transaction((tx) => {               // repos accept the tx
    const r = ctx.repos.createThing(tx, { ...body, claimId: id });
    ctx.repos.appendAudit(tx, { actor: request.actor, action: 'thing.create', entity: 'things', entityId: r.id, after: r, at: ctx.now() });
    return r;
  });
  recomputeClocks(ctx, id);                              // services/claimView.ts — whenever the chronology changed
  return reply.status(201).send(row);
});
```

Rules: every mutation writes an `audit_log` row; use `ctx.now()` (injectable) not `new Date()`; never update or delete
ledger / events / evidence (append a correcting row with `supersedesId`); `send` endpoints only record `sentAt`/`sentVia`
and return the PDF — the handler sends it.

## Routes

### Core

- `GET /health` — db, key presence, kb data, and which domain export each engine is wired to.
- Claims: `GET /claims` (`status` (comma list), `handlerId`, `atFaultInsurerId`, `claimantId`, `search`/`q`, `flagged`, `limit`, `offset` → `{items, total, byStatus}`),
  `POST /claims` (FNOL, see below), `GET /claims/:id` (ClaimBundle + `gates`, `actions`, `acceptance`, `position`, `linkedClaims`; clocks recomputed and cached),
  `PATCH /claims/:id` (incl. `injuryReferral`), `POST /claims/:id/status` (409 `HARD_STOP` while a block flag is uncleared), `POST /claims/:id/flags/:code/clear`,
  `GET /claims/:id/clocks|gates|actions|acceptance|audit`
- Parties: `GET/POST /parties` (`roles` optional, default `other`), `GET/PATCH /parties/:id`, `GET /parties/:id/connections` (`linkage.findConnections`; `witnessIndependence` per claim)
- Vehicles: `GET/POST /vehicles`, `GET /vehicles/:id`, `POST /vehicles/lookup`, `POST /vehicles/:id/odometer`, `GET /vehicles/:id/mileage-conflicts`
- Ledger: `GET/POST /claims/:id/ledger` (`PATCH`/`PUT`/`DELETE` → 409 `IMMUTABLE`)
- Events: `GET/POST /claims/:id/events` (side effects: offers, off-hire clocks, storage report+48h + `SEND_COLLECT_OR_PAY`); `PATCH`/`DELETE` → 409
- Hire / storage / recovery / offers: `GET/POST /claims/:id/hire`, `POST …/hire/:hireId/end`; `GET/POST /claims/:id/storage`, `POST …/storage/:sid/end`;
  `GET/POST /claims/:id/recovery` (`gta.recoveryCharge`); `GET/POST /claims/:id/offers`, `PATCH /claims/:id/offers/:oid`

**`POST /claims` (FNOL).** Two body spellings are accepted and normalised by `services/intake.ts`: the API's native
shape (`claimant`/`driver`/`vehicle`/`thirdParties`/`thirdPartyVehicle`/`atFaultInsurer`/`clientInsurer`/`accident`/
`interventionOffer`/…) and the web client's wizard shape (`channel`, `disclosure`, `thirdParty{registration, driverName,
insurerName|insurerId, insurerPolicyNumber}`, `witnesses[]`, `clientInsurer{name, policyNumber}`, `injury`, `services`).
The domain `validateFnol` runs on the merged facts: hard errors (`accident.occurredAt|location|circumstances` (≥ 40 chars,
the client's own words), an account not taken cold, a supplied third-party plate in a bad format, witnesses without a
name, an offer disclosed without what/who/when) → `400 BAD_REQUEST` with `details.{missing, errors, incomplete, warnings}`;
the mandatory *questions* a handler may still have open (client insurer and policy, the witnesses question, injuries,
roadworthiness, third-party plate, "has anyone offered you a vehicle?") open the claim with an `INTAKE_INCOMPLETE`
flag listing them. Witnesses become `witness` parties on `thirdPartyIds`; one linked to the claimant/driver (shared
phone/email/address/bank, a stated relationship, or `independent: false`) raises `NON_INDEPENDENT_WITNESS` (lesson g).
Also: `crossFileRegistrationCheck` (duplicate link + `DUPLICATE_REGISTRATION`; `FLEET_UNIT_AS_CLIENT_VEHICLE` block),
`scoreLiability` (factors recorded on the FNOL event), `routeInjury` (flag + task event, `feeTaken: false`), script-guard
offer capture into the intervention register. Response: the `Claim` (top level, as the web client reads it) plus
`intake` (validation, cross-file, liability, injury, offer, witnesses, flags) and the same claim under `claim`.

### Evidence (`routes/evidence.ts`, `services/evidence.ts`)

- `POST /claims/:id/evidence` — multipart `file` + fields `kind`, `description`, `capturedAt`, `captureShot`, `sourceUrl`,
  `sha256` (device hash; `409 HASH_MISMATCH` when it differs). The stream is hashed while it is written to a staging
  file; images are read with exifr (`dateTimeOriginal`, make/model, GPS, dimensions); the bytes land at
  `EVIDENCE_DIR/<claimId>/<sha256[0..2]>/<sha256>.<ext>` chmod `0444` with a sidecar `.json` manifest written `wx`
  (never overwritten: `409 EVIDENCE_WRITE_ONCE`). The same bytes on the same claim return the existing row (`200`,
  `deduped: true`; `alsoOnClaims` lists other claims holding the hash). `201` otherwise.
- `GET /claims/:id/evidence?kind=`, `GET /evidence/:id` (immutable row), `GET /evidence/:id/file` (streams with
  `content-disposition`, `?download=1` for attachment, `x-sha256`), `POST|GET /evidence/:id/verify` → `{status:
  'intact'|'tampered'|'missing', manifest: 'ok'|…}` by re-hashing the stored file. `PATCH`/`DELETE` → `409 IMMUTABLE`.

### Documents (`routes/documents.ts`, `services/documents.ts`, `services/documentData.ts`)

- `GET /templates` → `{items: TemplateMeta[]}` with `requiredData` and `recipientRole`.
- `POST /claims/:id/documents {templateId, data?, recipientPartyId?}` → `201` draft. The template data is assembled
  from the bundle — ledger, events, offers, hire, storage, recovery, PAV, estimate, report, settings and the recipient
  party — by `documentData.ts` (one builder per template id). Handlers may supply only the extra free-text fields a
  template declares; any supplied amount/date the ledger knows is refused (`400 EXTRA_OVERRIDES_LEDGER`). The rendered
  HTML goes through `consistency.checkDraft` with the bundle, prior outgoing documents, the template's recipient role,
  KB citation verification status and the registered name; the draft stores the `ConsistencyReport` and `dataSnapshot`
  and is `blocked` while any block flag is open, `draft` otherwise.
  *System reconciliation* (`consistencyReconcile.ts`): the engine reads the letter as text and can classify a
  ledger-written table figure by its neighbouring label ("Claimed £151.00; received £0.00 | £151.00" reads the
  outstanding column as a payment). Only `AMOUNT_PAID_MISMATCH` blocks on figures the API itself derived from the
  ledger, that also arise on a render without any handler text, are cleared — `clearedBy: 'system'` with the reason
  and listed in the audit row — so a reviewer still sees every engine complaint and a handler-typed figure is never
  cleared (the "£1,287 was received" draft stays blocked).
- `POST /documents/:id/clear-flag {code, excerpt?|index?, reason}` → `clearFlag` (audited). `POST /documents/:id/approve
  {note?}` → `409 DOCUMENT_BLOCKED` while blocked; sets `approvedBy/At`, renders the PDF (`renderPdf` with the claim
  reference header and status footer) under `DOCUMENTS_DIR/<claimId>/<docId>.pdf` with its sha256; `pack.gta_payment`
  also `mergePdfs` the component documents. `GET /documents/:id` (`?html=false`), `GET /documents/:id/pdf`.
- `POST /documents/:id/send {via, to?, note?}` — approved or signed only; records `sentAt`/`sentVia`, writes an
  `email_out`/`letter_out` event plus the semantic event (`ncaf_sent`, `payment_pack_sent`, `chaser_sent`, …) and
  returns the document with `send.{events, pdfUrl, note}` and `pdfBase64`. **Nothing is transmitted.**
- `POST /documents/:id/supersede {data?, reason?, reExecutedOn?}` → `201` new draft carrying the re-execution line;
  the old document becomes `superseded`.
- Signatures: `POST /documents/:id/sign/start {signerPartyId, signerName?, contact, channel}` → `esign.generateOtp`
  (`ESIGN_SECRET`/`SIGNING_SECRET`), stores the challenge, returns `{challengeId, channel, expiresAt, contactMasked,
  devCode, debugCode}` (codes only when `NODE_ENV !== 'production'`). `POST /documents/:id/sign/verify {challengeId,
  code}` → `verifyOtp` (`400 OTP_INVALID`), `signatureDateChecks` (a signature dated before the document's creation is
  refused), attaches the `SignatureRecord`, renders `certificate.signature`, status `signed`; two agreements on the
  claim sharing a signature date raise `DUPLICATE_SIGNATURE_DATE` on the claim.

### Engineering (`routes/engineering.ts`)

- Estimates: `GET /claims/:id/estimate` (latest or `null`), `GET /claims/:id/estimates`, `POST /claims/:id/estimate`
  and `PATCH /claims/:id/estimate/:eid` (lines; `computeTotals` with pre-existing damage excluded and the paint/materials
  method stated), `POST /claims/:id/estimate/import {text?|evidenceId?}` → `parseEstimateText` through the
  `ExtractLinesProvider` (default `text-only`; PDF→text runs in the browser or via an optional provider — the API never
  guesses figures from a PDF), `POST …/estimate/:eid/reconcile`, `POST …/estimate/:eid/approve` (feeds the labour
  library from approved estimates only). Labour library: `GET /engineering/labour-library`, `GET
  …/labour-library/suggest?make&model&panel&operation`, `POST …/labour-library {estimateId}`.
- PAV: `GET /claims/:id/pav`, `POST /claims/:id/pav`, `POST /claims/:id/pav/comparables` (each comparable needs an
  `evidenceId` or `url + capturedAt`; nothing is scraped), `POST /claims/:id/pav/assess` → `assessPav`, `POST
  /claims/:id/pav/:pid/approve`.
- Engineer's report: `GET/POST /claims/:id/engineer-report`, `PATCH …/engineer-report/:rid`, `GET
  …/engineer-report/checklist` (domain `engineerReportChecklist` verdict + display items), `POST
  …/engineer-report/:rid/issue` → `report_issued` event (storage report+48h side effects) + `report.engineer` document.
- Total loss: `POST /claims/:id/total-loss/assess` → domain `assessTotalLoss` (repair + projected hire + storage vs
  PAV − salvage, salvage from an actual bid/offer/estimate), `POST /claims/:id/total-loss/predict` → `predictTotalLoss`
  (`calibrated: false` until 100 outcomes).

### Fleet (`routes/fleet.ts`)

- Units: `GET /fleet` (rows with `vehicle`, `registration`, `policy`, `alerts`), `POST /fleet` (`vehicleId` or
  `vehicle`; a client vehicle on an open claim is refused, lessons f/h), `GET/PATCH/DELETE /fleet/:id` (delete =
  `disposed`), `GET /fleet/alerts` (domain `complianceAlerts` over units + vehicles + policies + open penalties),
  `POST /fleet/:id/allocate-check {use, claimId?, at?}` → `{allowed, reasons, warnings, policy}` (domain `canAllocate`
  with the unit's linked policy; on hire / client vehicle on the claim are added).
- Policies: `GET/POST /fleet/policies`.
- Penalties: `GET/POST /fleet/penalties`, `GET/PATCH /fleet/penalties/:id` (`allowedTransitions`), `POST
  /fleet/penalties/:id/transition {stage, note?, hireAgreementId?}` (domain `penaltyTransition` by action; a hirer is
  only ever identified from an agreement covering the contravention), `POST /fleet/penalties/:id/documents {templateId:
  'notice.pcn_liability_transfer'|'notice.s172_response', data?}` → standalone document via the documents service.
  s.172: pleading s.172(4) while naming a driver, naming a driver no covering hire supports, or pleading (4) when the
  records identify the driver → `400 S172_REFUSAL`.

### Directory & knowledge base (`routes/directory.ts`, `services/kb.ts`)

- `GET /directory?q=&status=` merges `kb.loadDirectory()` with `directory_overrides` and computes `directoryStatus`
  (`verified` → `stale` after 180 days → `failed` on a report), `GET /directory/:id`, `PATCH /directory/:id/verify
  {sourceUrl, verifiedBy}`, `POST /directory/:id/report-failed {field?, note?}`, `POST /directory/:id/used-ok`.
- `GET /kb/search?q=&type=&topic=`, `GET /kb/entries/:id`, `GET /kb/advise?topic=` (summary, points with citations and
  their verification status, caveats: DISP 2.7 forum, GTA benchmark, perimeter), `GET /kb/get-paid-faster`,
  `GET /kb/gta-rates?date=&group=` (benchmark note), `GET /kb/court-fees`, `GET /kb/directory-raw`.

### Watch list & jobs (`routes/watch.ts`, `jobs.ts`)

- `GET /watch`, `POST /watch {companyNumber, name?, role, riskLevel?}`, `GET/DELETE /watch/:number`, `POST /watch/poll`
  → Companies House profile per company (without a key: `unverified`, skipped gracefully), status / accounts overdue /
  Gazette notices from the filing history, `riskLevel` (dissolved, liquidation, strike-off, overdue accounts → `high`),
  `SUPPLIER_HIGH_RISK` flag on claims that have the company as a supplier party.
- `GET /jobs`, `POST /jobs/run {job: 'watch_poll'|'clocks_refresh'}`. With `JOBS_ENABLED=true`: nightly watch poll and
  hourly clocks refresh (recompute + cache per open claim), `setInterval` timers stopped on close.

### Analytics (`routes/analytics.ts`, `services/analytics.ts`)

- `GET /analytics/overview` — claims by status, clocks due today / overdue / upcoming, blocked documents, next actions,
  debtor days, fleet alerts, high-risk suppliers, interventions.
- `GET /analytics/debtor-days` — per insurer (and handler): average days from `payment_pack_sent` to `payment_received`,
  outstanding by insurer.
- `GET /analytics/reductions` — by head and insurer: claimed vs paid; `reducedPence` = explicit `reduced` ledger entries
  plus short payments on heads the insurer has paid against; `outstandingPence` = not yet paid and not refused.
- `GET /analytics/cycle-times` — fnol→ncaf_sent, hire end→pack sent, pack sent→payment (median, p90, mean).
- `GET /analytics/interventions` — offers accepted/declined/pending, suitable rates, replies within one working day,
  average reply time, by insurer.

### Settings (`routes/settings.ts`)

`GET /settings`, `PATCH /settings` — registered office, bank, VAT, ICO, rate card (`recoveryCalloutPence`,
`perMilePence`/`recoveryPerLoadedMilePence`, `adminPence`/`recoveryAdminPence`, `storageDailyPence`, `engineerFeePence`,
`vatRate`), API key presence. Warnings: `CONFIRMATION_OF_PAYEE` when `bank.accountName` ≠ `Courtesy Cars Group UK Ltd`
(File 1: "bank details could not be validated"), missing office / bank / ICO / VAT. Legacy details are refused
(`400 LEGACY_DETAIL`); `companyName` must be the registered name.

## Engines

`src/engines.ts` imports the `@ccguk/domain` engines directly and adapts their signatures to the API's shapes, so a
domain change breaks the typecheck rather than failing at runtime:

| API | Domain |
|---|---|
| `validateFnolInput(FnolInput)` → `{ok, missing, errors, incomplete, warnings}` | `validateFnol` — hard errors vs open intake questions (`INTAKE_INCOMPLETE`) |
| `scoreLiabilityFor(accident, {liability, priorClaimsOnRegistration, …})` | `scoreLiability(accident, LiabilityExtras)` (admitted → `thirdPartyAdmitted`, denied/disputed → contradiction, Highway Code rules, prior claims) |
| `routeInjuryFor(accident, referredTo?)` | `routeInjury({accident})` → referral task, `feeTaken: false` |
| `canAllocateFor(unit, use, policies, now, vehicle)` | `canAllocate(unit, use, policy, now, vehicle)` |
| `nextActionsFor(bundle, {now, gates, clocks, rules, insurerPaidBefore})` | `nextActions(bundle, PlaybookContext)` (`insurerPaidBefore` from other files with the insurer) |
| `assessAcceptanceFor(bundle, gates, now)` | `assessAcceptance(bundle, {gates, now})` |
| `deriveClocksFor(bundle, now)` | `deriveClocks(bundle, now)` + the API supplement in `services/fallbacks.ts` for off-hire triggers |
| `services/fleetFallbacks.ts` | `complianceAlerts(records, now, opts)`, `penaltyTransition(notice, action, ctx)` (stage → action), `liabilityTransferParticulars`, `s172ResponseData`, `hireCovers` |
| `services/engineeringFallbacks.ts` | `assessTotalLoss(TotalLossInput)`, `predictTotalLoss`, `engineerReportChecklist(report, opts)` |

Imported directly in the routes: `evaluateGates`, `crossFileRegistrationCheck`, `mileageConflicts`, `findConnections`,
`witnessIndependence`, `recoveryCharge`, `storageCharge`, `calculateHire`, `offHireDeadline`, `computeTotals`,
`reconcile`, `assessPav`, `checkDraft`, `clearFlag`, `legacyCheck`, `generateOtp`, `verifyOtp`, `signatureDateChecks`.

Known engine behaviours the API works around (for the domain owner): `consistency.ledgerSets` counts `claimed` and
`invoiced` entries on the same head twice, so totals in `AMOUNT_CLAIMED_MISMATCH` warnings overstate the position
(warn only); amount context is taken from a ±40/80-character window, so table rows need the reconciliation above.

## Web-client contract (`apps/web/src/api/client.ts`)

Paths and bodies match the client. Notes: list endpoints return `{items, …}` (the client's `asList` reads `items`);
`POST /claims` answers with the `Claim` plus `intake` and `claim`; `SignStartResult` carries both `devCode` and
`debugCode`; `clear-flag` accepts `excerpt` or `index`; `allocate-check` returns `allowed` (and `ok`).

## Seed (`pnpm --filter @ccguk/api seed`)

Users `handler` / `approver` / `admin` / `engineer`; settings with the rate card (£90 / £3 per loaded mile / £25,
£45/day storage, £285 engineer) and the registered name on the bank account; the four live-file archetypes with full
chronologies, ledgers, offers, hire/storage/recovery and PNG evidence generated in code (`seed/png.ts`): File 1 "£1,287
stated vs £1,112 received" (`@ccguk/db` fixture), File 2 storage capped at report + 48 h / engineer fee refused / CARFLEX
LTD supplier, File 3 lane-merge liability dispute with hire running and a PCN during the hire, File 4 non-independent
witness; CARFLEX LTD (12640635) on the watch list as high risk (the poll raises `SUPPLIER_HIGH_RISK` on File 2); two
fleet units declared for `credit_hire`, one Collingwood policy covering `credit_hire` only; no directory overrides.
Idempotent: skipped when the database already has claims.

## Tests

`vitest` on `createDatabase(':memory:')` with `app.inject`, each app in its own scratch directory under the OS temp dir
(removed on close). `api.test.ts`: FNOL → bundle → clocks/gates/actions; list/search/status; cross-file duplicate link +
fleet hard stop; injury referral and script-guard offer capture; ledger immutability and supersession; recovery ledger
entry; hire allocation guard and off-hire clock; storage report+48h; vehicle lookups and odometer conflicts; party
connections. `services.test.ts`: evidence upload hashing, write-once store, dedupe, verify + tamper, immutability;
`letter.chaser_7` on File 1 → unblocked draft (system-reconciled table figures), a draft stating "£1,287 was received"
blocked until cleared, approve → PDF (Chromium), send (recorded only) and the OTP sign round trip to a certificate,
supersede; web-client FNOL body with witness linkage and `INTAKE_INCOMPLETE`, hard stops (plate, short account, not
taken cold); estimate totals / reconcile / labour library / total-loss predict + assess; s.172 refusal and fleet alerts;
directory ageing and verification, KB search/advise/GTA rates/ladder; watch poll without a key; analytics on File 1 and
on the full seed; settings Confirmation-of-Payee warning and legacy refusal. Lookup mappers and clients are unit-tested
with fixture payloads and a fake `fetch` (no network).

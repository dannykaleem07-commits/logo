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
pnpm --filter @ccguk/api seed       # sign-in account, users, settings, the four live-file archetypes, fleet, watch list (idempotent)
pnpm --filter @ccguk/api typecheck && pnpm --filter @ccguk/api test
```

Environment (`.env` in `apps/api/` or the repo root; every variable is optional):

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `4000`, `127.0.0.1` | listen address. Loopback by default; before setting `HOST=0.0.0.0` change the default password (or set `LOGIN_PREFILL=false`) — see "Authentication" |
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
| `AUTH_MODE` | `session` (`header` when `NODE_ENV=test`) | `session`: the `claimdesk_session` cookie. `header`: legacy `X-User-Id` (tests); refused in production |
| `DEFAULT_LOGIN_USERNAME`, `DEFAULT_LOGIN_PASSWORD` | `courtesycars`, `CourtesyCars123!` | the owner's account, created on boot / seed when no user has that username (never overwrites an existing password) |
| `LOGIN_PREFILL` | `true` | the login screen pre-fills the default username + password (password only while it is still the default) |
| `SESSION_TTL_HOURS` | `12` | absolute session lifetime (cookie `Max-Age`) |
| `TRUST_PROXY` | `loopback` | Fastify `trustProxy`: which hops may set `X-Forwarded-For` (decides the IP used by the login rate limiter and recorded on audit rows). `true` trusts any client's header (spoofable); a comma list of proxy addresses/CIDRs for a remote reverse proxy |
| `DEFAULT_USER_ID` | `handler` | header mode only: user assumed when `X-User-Id` is absent (never in production) |
| `LOOKUP_TIMEOUT_MS` | `10000` | outbound lookup timeout |
| `TEMPLATES_DIR` | `$DATA_DIR/templates` | uploaded Word templates (`<templateId>/v<n>-<sha12>.docx`, immutable). Never under the app folder (an upgrade replaces it); the desktop launcher sets `%LOCALAPPDATA%\ClaimDesk\data\templates` |
| `DOCX_PDF_CONVERTER` | `auto` | DOCX → PDF: `auto` (Microsoft Word → LibreOffice → built-in browser), or `word` / `libreoffice` / `browser` tried first (the others still fall back). Conversions run in `$DATA_DIR/tmp/convert` |
| `SOFFICE_PATH` | — | LibreOffice `soffice` for the DOCX converter (otherwise the usual install paths / PATH) |
| `CORS_ORIGINS` | localhost only | browser origins allowed by CORS (credentials on). Unset → `http(s)://localhost`, `127.0.0.1`, `[::1]` on any port; a comma list replaces that; `*` reflects any origin (explicit opt-in only) |

Keys never leave the process: only presence flags are exposed (`/api/health`, `Settings.apiKeys`).

## Authentication

Username + password sign-in with a server-side session (no new dependencies: `node:crypto`, Cookie header parsed and set
by hand). Code: `src/services/auth.ts`, `src/routes/auth.ts`, the `onRequest` hook in `src/app.ts`.

**Default account.** On boot (`src/server.ts`) and in `pnpm seed`, `ensureDefaultLogin` creates the owner's account when
no user has the username `DEFAULT_LOGIN_USERNAME`: username `courtesycars`, password `CourtesyCars123!`, id
`courtesycars`, name "Courtesy Cars", email `claims@courtesycars.net`, role `admin` (audited
`auth.default_login_created`). It never touches an existing account's password. The login screen pre-fills both boxes
while `LOGIN_PREFILL` is on **and** the password is still the default; once it is changed (Settings → Change password)
the password is no longer offered. Anyone who can reach the login page can read the default password until then — keep
`HOST` on loopback, or change the password / set `LOGIN_PREFILL=false`, before exposing the server.

**Passwords** are stored only as `scrypt$16384$8$1$<salt b64>$<hash b64>` (scrypt N=16384, r=8, p=1, 16-byte random
salt, 64-byte key) and checked with `crypto.timingSafeEqual`. They are never logged or audited.

**Sessions.** A successful login creates a 32-byte random token (base64url) and sets
`claimdesk_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` (`; Secure` when `NODE_ENV=production` —
production therefore needs HTTPS). The `sessions` table stores only `sha256(token)` with `user_id`, `created_at`,
`expires_at` (absolute, 12 h; activity does not extend it), `last_seen_at`, `ip`, `user_agent`. Expired rows are
rejected and deleted. A new login discards the browser's previous session.

**The hook.** In `session` mode every `/api/*` route needs a valid session except `GET /api/health` and
`/api/auth/{login,logout,me,login-defaults}`; the check uses the matched route pattern, and unknown `/api` paths are
`401` too. Requests outside `/api` (the built web app) are public — the app's screens call `/api/auth/me` and send the
user to `/login`. The session's user becomes `request.user` and `request.actor` (`{ userId, ip }`), so every existing
audit row records who did it. `X-User-Id` is ignored. In `header` mode (the default only when `NODE_ENV=test`, so the
existing integration tests keep using `X-User-Id` / the seeded `handler`), the old behaviour is unchanged.

| Endpoint | Auth | Request → response |
|---|---|---|
| `GET /auth/login-defaults` | public | `200 { username, password?, prefill }` — `password` only while `LOGIN_PREFILL` is on and the default account still has the default password (checked once per stored hash, then cached). With `LOGIN_PREFILL=false`: `{ username: "", prefill: false }` |
| `POST /auth/login` | public | `{ username, password }` → `200 { user: { id, name, username, email, role } }` + `Set-Cookie`. Usernames compare case-insensitively after trim. Unknown user and wrong password both `401 INVALID_CREDENTIALS` "Username or password is incorrect" (an unknown user is verified against a dummy hash, so the timing matches). 10 failures for the same username + IP within 15 minutes → `429 LOGIN_RATE_LIMITED` (+ `Retry-After`) until the oldest failure leaves the window (in memory, per process). Each attempt is counted before the password check, so a parallel burst gets at most 10 checks; a correct password clears the count. When the table is full, unlocked keys are evicted before locked ones |
| `POST /auth/logout` | public | `204`; deletes the session row and expires the cookie (`Max-Age=0`). A no-op without a session |
| `GET /auth/me` | public | `200 { user }` or `401 UNAUTHENTICATED` (a stale cookie is expired) |
| `POST /auth/change-password` | session | `{ currentPassword, newPassword }` → `204`. Wrong current → `400 INVALID_CREDENTIALS`; `newPassword` shorter than 10 characters, equal to the current one, or equal to the default password → `400 VALIDATION`. Signs out every other session of the user |

All auth responses carry `Cache-Control: no-store`. Audit (append-only `audit_log`): `auth.login`,
`auth.login_failed` (actor `anonymous`; the username tried and the reason, never the password), `auth.logout`,
`auth.password_changed`, `auth.password_change_failed`. `GET /users` lists each user's `username` — never a hash.

Every response carries `x-request-id` (honours an inbound `X-Request-Id`).

## Error mapping (`src/app.ts` → `mapError`)

| Thrown | Status / code |
|---|---|
| `ZodError` | `400 VALIDATION` with `details[{path,message,code}]` |
| `@ccguk/db` `ValidationError` | `400 VALIDATION` |
| `NotFoundError` | `404 NOT_FOUND` |
| `ImmutableError` (`LedgerImmutableError`, `EventImmutableError`, `EvidenceImmutableError`, …) | `409 IMMUTABLE` |
| `DocumentStateError` / `VerificationError` | `409` |
| `HttpError` (`src/errors.ts`) | as given (`HARD_STOP`, `ALLOCATION_REFUSED`, `WRONG_CLAIM`, `DOCUMENT_BLOCKED`, `EXTRA_OVERRIDES_LEDGER`, `S172_REFUSAL`, `HASH_MISMATCH`, `EVIDENCE_TAMPERED`, `DOCUMENT_PDF_TAMPERED`, `DOCUMENT_PDF_MISSING`, `STORE_PATH_INVALID`, …) |
| anything else | `500 INTERNAL` (logged with the request id) |

## Layout

```
src/
  config.ts            loadConfig()/testConfig() — env, data dirs (incl. TEMPLATES_DIR), key presence, DOCX_PDF_CONVERTER
  context.ts           AppContext { config, handle, db, repos, settings(), kb, now(), engines(), logger, close() }
  app.ts               buildApp(ctx, { logger? }): cors (localhost origins unless CORS_ORIGINS), multipart (25 MB), static web + SPA fallback (never for /api), error handler, auth hook (session / header mode)
  server.ts            start(): migrations on boot, data dirs, ensureDefaultLogin, listen
  seed.ts, seed/       dev seed (archetypes.ts: the four live files; png.ts: programmatic PNG evidence)
  engines.ts           typed adapters to the @ccguk/domain engines (see "Engines")
  jobs.ts              JOBS_ENABLED schedulers + POST /jobs/run
  errors.ts            HttpError helpers
  schemas/             zod schemas mirroring packages/domain/src/types.ts (services.ts: the services half)
  services/
    auth.ts            scrypt hashPassword/verifyPassword, session token + cookie helpers, resolveSession, LoginRateLimiter, ensureDefaultLogin
    intake.ts          FNOL normalisation (API ⇄ web-client body) → domain FnolInput
    claimView.ts       bundle + clocks/gates/actions/acceptance, insurerPaidBefore
    sideEffects.ts     event → side effects (off-hire clocks, storage report+48h, offers)
    lookup.ts          DVLA/DVSA/Companies House clients + mapping
    fallbacks.ts       API-side clock supplement (off-hire triggers from the hire record)
    evidence.ts        write-once content-addressed evidence store (sha256, EXIF, manifest, verify)
    documentData.ts    one-source-of-truth template data per template id
    documents.ts       draft → consistency → approve (PDF) → send (record) → supersede → sign
    consistencyReconcile.ts  system clearance of engine misreads on ledger-written table figures
    mergeSource.ts     buildMergeSource(): the claim → MergeSource the DOCX field resolvers read
    docxTemplates.ts   Word template library: boot sync of the built-ins, upload pipeline, summary/detail, mapping, test fill
    docxDocuments.ts   values form + DOCX claim document generation (baseline suppression, _docx snapshot)
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

- `GET /health` — db, key presence, kb data, and which domain export each engine is wired to. Public.
- Auth: `GET /auth/login-defaults`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password` — see "Authentication".
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
- `GET /claims/:id/evidence?kind=`, `GET /evidence/:id` (immutable row), `GET /evidence/:id/file` (`content-disposition`,
  `?download=1` for attachment, `x-sha256`; **the bytes are re-hashed on every read** — a file that no longer hashes to the
  row is refused with `409 EVIDENCE_TAMPERED` and the attempt is audited as `evidence.read.tampered`), `POST|GET
  /evidence/:id/verify` → `{status: 'intact'|'tampered'|'missing', manifest: 'ok'|…}` by re-hashing the stored file.
  `PATCH`/`DELETE` → `409 IMMUTABLE`. Store paths come only from our own rows and are resolved inside `EVIDENCE_DIR`
  (`409 STORE_PATH_INVALID` otherwise).

### Documents (`routes/documents.ts`, `services/documents.ts`, `services/documentData.ts`)

- `GET /templates` → `{items: TemplateMeta[]}` with `requiredData`, `recipientRole` and `format: 'html'` (the Word
  templates are listed by `GET /docx-templates`, below).
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
  also `mergePdfs` the component documents. `GET /documents/:id` (`?html=false`), `GET /documents/:id/pdf` (the stored
  PDF is re-hashed on every read and refused with `409 DOCUMENT_PDF_TAMPERED` when it no longer matches the sha256
  recorded at approval), `GET /documents/:id/certificate` (the e-signature certificate PDF of a signed document,
  `x-certificate-id`). PDF paths are resolved inside `DOCUMENTS_DIR` only (`409 STORE_PATH_INVALID`).
- `POST /documents/:id/send {via, to?, note?}` — approved or signed only; records `sentAt`/`sentVia`, writes an
  `email_out`/`letter_out` event plus the semantic event (`ncaf_sent`, `payment_pack_sent`, `chaser_sent`, …) and
  returns the document with `send.{events, pdfUrl, note}` and `pdfBase64`. **Nothing is transmitted** (the audit row
  carries `transmitted: false`). An approved document whose PDF was never rendered is rendered now (audited
  `document.pdf`); a tampered PDF is refused (`409 DOCUMENT_PDF_TAMPERED`) and a signed document whose PDF has gone is
  never re-rendered (`409 DOCUMENT_PDF_MISSING` — supersede and re-execute), so the signature's hash chain holds.
- `POST /documents/:id/supersede {data?, reason?, reExecutedOn?}` → `201` new draft carrying the re-execution line;
  the old document becomes `superseded`. A Word (`format: 'docx'`) document is re-generated from its template with the
  previous `_docx.inputs`, `confirm`, `variant` and subject; `values?` / `confirm?` in the body are merged over them.
- `GET /documents/:id/docx` — the filled Word file of a DOCX document, re-hashed on every read (`x-sha256`;
  `content-disposition: attachment; filename="<reference> <title>.docx"`); `404` for HTML documents, `409
  DOCUMENT_DOCX_TAMPERED` when the bytes no longer match `docxSha256`.
- `GET /documents/:id/letterhead.docx` — any HTML letter recomposed on the CCGUK formal Word letterhead
  (`extractLetterContent` reads the layout's `data-letter-part` attributes, `composeLetterheadDocx` fills the built-in
  letterhead). Not stored; `x-sha256`; audited `document.letterhead_docx` with the sha256. `400 NOT_A_LETTER` for
  anything but an HTML letter, `422 LETTER_NOT_EXTRACTABLE` when the HTML carries no letter parts.
- PDFs record which converter made them: `pdfConverter` is `chromium-html` for HTML documents and `word` /
  `libreoffice` / `browser` for Word documents (the `document.pdf` audit row also lists every attempt). HTML PDFs carry
  document metadata (title, author `Courtesy Cars Group UK Ltd`) and the registered office from Settings
  (`formatRegisteredOffice`).
- Template-id rules go through `canonicalTemplateId` (domain `templateIds.ts`): CCGUK-03/04/07/08 count as
  `agreement.credit_hire`, `statement.witness`, `form.statement_of_means`, `form.mitigation_questionnaire` for the
  semantic send events, default recipient roles, acceptance, the GTA payment pack and the consistency engine.

### Word templates and DOCX claim documents (`routes/docxTemplates.ts`, `services/docxTemplates.ts`, `services/docxDocuments.ts`, `services/mergeSource.ts`)

Design: `docs/TEMPLATES-VEHICLES-DESKTOP.md` §A–§C. The engine fills blanks in the user's Word files; it never rewrites
printed wording and never fills a signature box. Built-ins are the ten CCGUK files shipped in
`packages/documents/assets/docx/`; the `document_templates` row (migration 0004) caches their scan and holds a mapping
override layer. At boot `syncBuiltinTemplates` hashes each asset and re-scans when the row is missing, the file changed
or the scanner version moved on; it never throws (a failure marks the template inactive with a `SYNC_FAILED` warning).
The first fill of a fresh database is not audited; every later refresh is (`docx_template.sync`).

| Method & path | Body / query | Response | Errors |
|---|---|---|---|
| `GET /docx-templates` | `?includeInactive=true` | `{items: DocxTemplateSummary[]}` | — |
| `POST /docx-templates` | multipart: `file` (.docx/.dotx, ≤ 15 MiB), `title`, `kind` (`letter\|form\|agreement\|statement\|report\|notice`), `description?`, `recipientRole?` | `201 DocxTemplateDetail` | `400 INVALID_DOCX` (`details.issues`), `409 TEMPLATE_DUPLICATE` (`details.id`), `413`, `422 NO_FILLABLE_SLOTS` |
| `GET /docx-templates/:id` | — | `DocxTemplateDetail` (slots, blocks, outline, per-slot mapping with origin `builtin\|saved\|suggested\|none`, `mappingIssues`, field dictionary) | `404` |
| `PATCH /docx-templates/:id` | `{title?, description?, active?, recipientRole?}` | `DocxTemplateSummary` | `404` |
| `POST /docx-templates/:id/acknowledge` | `{}` | `DocxTemplateSummary` (records who/when) | `404` |
| `PUT /docx-templates/:id/mapping` | `{entries: MappingEntry[] (slot = exact id), ignore?: string[]}` | `DocxTemplateDetail` (`mappingRevision + 1`) | `400 MAPPING_INVALID` (`details.issues`) |
| `DELETE /docx-templates/:id/mapping` | — | `DocxTemplateDetail` (built-in back to its curated mapping) | `400` for uploads |
| `POST /docx-templates/:id/file` | multipart `file` (uploads only) | `DocxTemplateDetail` + `carriedOver`, `dropped` slot ids | as `POST /docx-templates`; `400` for built-ins |
| `GET /docx-templates/:id/file` | — | the original .docx (`attachment`, `x-sha256`) | `404` |
| `POST /docx-templates/:id/test-fill` | `{claimId?, variant?}` | a filled .docx, not stored (sample data when no claim) | `404` |
| `GET /claims/:id/docx-templates/:templateId/values` | `?variant&witnessPartyId&offerId&hireAgreementId&recipientPartyId&exhibitEvidenceIds=a,b` | `ClaimTemplateValues` (groups of `PlanRow`s, subjects, issues, summary) | `404`; unacknowledged warnings / a changed file are returned as block issues (`TEMPLATE_WARNINGS_UNACKNOWLEDGED`, `TEMPLATE_CHANGED`) |
| `POST /claims/:id/docx-documents` | `GenerateDocxBody {templateId, variant?, subject?, values?, confirm?}` | `201 GeneratedDocument` (`format: 'docx'`, status `draft` or `blocked`) | `400 VALUES_REQUIRED` / `SLOT_NOT_FILLABLE` / `VALIDATION`, `409 TEMPLATE_WARNINGS_UNACKNOWLEDGED` / `TEMPLATE_CHANGED` / `GUARD_BLOCKED`, `404` (unknown or switched-off template) |
| `GET /docx-converters` | `?refresh=true` | `{preference, order, available: {word, libreoffice, browser}}` | — |

- **Upload pipeline**: one `file` part (route limit 15 MiB → `413`), `.docx`/`.dotx` only; `checkDocxSafety` refuses
  non-zips, macro-enabled main parts, `vbaProject.bin`, ActiveX, altChunk, external template/OLE/frame links and DTDs
  (`400 INVALID_DOCX`); `scanDocx` must find at least one slot (`422 NO_FILLABLE_SLOTS`); an active upload with the same
  sha256 is a `409 TEMPLATE_DUPLICATE`. Warnings: legacy details and banned phrases in the wording (documents guards +
  domain `legacyCheck`/`bannedPhraseCheck`), "our client" (`REGULATED_STATUS`), tracked changes / comments / legacy
  form fields / external images / embedded objects, and `UNMAPPED_SLOTS`. The stored mapping holds only auto-mapper
  suggestions scoring ≥ 0.75 (exact slot ids; shown as `suggested` with the score until a person saves). Files are
  written under `TEMPLATES_DIR` and always resolved with `assertInsideStore`.
- **Generation** (`services/docxDocuments.ts`): active template, warnings acknowledged, bytes re-hashed against the row,
  effective mapping (built-in JSON ⊕ override, or the saved upload mapping) valid → clocks recomputed → `MergeSource`
  (`services/mergeSource.ts`: bundle + own insurer, users, hire fleet unit/vehicle/policy, KB ⊕ manual GTA rates,
  recipient via `resolveRecipient`, response deadline via `deadline()`, company details from Settings + brand; bank
  details only from Settings) → `buildFillPlan` (block issues stop it) → `fillDocx` (core properties `<template title>
  — <reference>`) → the preview HTML is stored in `documents.html` and checked by the consistency engine under the
  canonical template id. Flags that the unfilled template raises too (same code and wording) are cleared by the system
  with reason `TEMPLATE_BASELINE` (one-for-one, so a legacy name typed by a handler stays blocked); plan warnings become
  warn flags. The .docx is written to `DOCUMENTS_DIR/<claimId>/<docId>.docx`; one transaction creates (or supersedes)
  the draft (`templateVersion` `<fileVersion>.<mappingRevision>.0`, `sha256 = docxSha256`), stores the report and audits
  `document.create` with `format`, `templateSha256`, `docxSha256`. `dataSnapshot._docx` keeps the reproducibility record
  (template sha/version, scanner version, variant, subject, inputs, confirmations, printed values, removed blocks,
  acknowledgement).
- **Approval** converts the verified .docx with `convertDocxToPdf` (preference `DOCX_PDF_CONVERTER`), stamps PDF
  metadata, stores the PDF and its sha256 as for HTML documents and records `pdfConverter`; send, e-sign and PDF reads
  are unchanged.
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

### Vehicles in manual mode, catalogue and GTA benchmark rates (`routes/vehicles.ts`, `routes/catalogue.ts`, `routes/gtaRates.ts`)

Design: `docs/TEMPLATES-VEHICLES-DESKTOP.md` §D–§F. ClaimDesk never requests a third-party site; everything typed,
picked or pasted is saved `unverified`. GTA rates are an industry benchmark only (CCGUK is not a GTA subscriber).

- `POST /vehicles/lookup` — both branches add `lookupMode` (`live`/`manual`), `onFile` (vehicles already held for the
  registration) and `externalLinks` (Total Car Check free check — template `TOTALCARCHECK_URL_TEMPLATE`, default
  `https://totalcarcheck.co.uk/FreeCheck?regno={REG}` — GOV.UK MOT history, GOV.UK vehicle enquiry). Without keys:
  `manual_required` and nothing is written.
- `GET /vehicles/on-file?registration=&limit=10` — exact registration, then partial matches (≥ 4 characters), with
  claims, fleet unit and lookup history. Read-only.
- `PATCH /vehicles/:id` — `{ …fields (null clears), spec?, source: { provider: manual | catalogue | totalcarcheck_manual,
  url?, pastedText?, parsed?, appliedFields? } }` → the vehicle plus `vehicle`, `lookupId`, `warnings`
  (`DIFFERS_FROM_VERIFIED` against verified DVLA/DVSA values). Appends an unverified LookupRecord; audit `vehicle.update`.
  `POST /vehicles` and FNOL vehicle input accept the same `spec` and `source`.
- `GET /catalogue/makes`, `/catalogue/makes/:make/models?year&vehicleType`, `/catalogue/makes/:make/models/:model`,
  `/catalogue/match?make&model`, `/catalogue/search?q&limit`, `/catalogue/features` (all `cache-control: private,
  max-age=3600`; add `?v=` after a custom change), `GET|POST /catalogue/custom`, `DELETE /catalogue/custom/:id` (soft;
  audit `catalogue.custom.*`), `GET /gta/suggest?make&model&generationId&trimId&segment&bodyType&engineCapacityCc&fuelType&recordedGroup&date`.
  The catalogue directory is `packages/kb/data/vehicle-catalogue/` (env `CATALOGUE_DATA_DIR` overrides it).
- `GET|POST /settings/gta-rates`, `PUT|DELETE /settings/gta-rates/:id`, `POST /settings/gta-rates/suppress`,
  `GET /settings/gta-segments`, `PUT|DELETE /settings/gta-segments/:segment`. `verified` needs an https source URL;
  the server stamps `verifiedBy`/`verifiedAt`. `gtaRatesFor(ctx)` (KB ⊕ these rows) feeds `/kb/gta-rates`, hire
  calculations, the engineering benchmark, documents and the suggestion.
- Fleet: `POST /fleet` may omit `gtaGroup`/`dailyRatePence` (filled from the suggestion, else `422
  GTA_SUGGESTION_UNAVAILABLE`) and records a catalogue/manual LookupRecord; `PATCH /fleet/:id` accepts `vehicle` changes.

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

The owner's sign-in account (`ensureDefaultLogin`; runs even when the database already has claims); users
`handler` / `approver` / `admin` / `engineer` (no passwords — they cannot sign in until given one); settings with the rate card (£90 / £3 per loaded mile / £25,
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
on the full seed; settings Confirmation-of-Payee warning and legacy refusal. `hardening.test.ts`: CORS default (localhost
only, lookalike hosts refused), `/api` 404s never fall through to the SPA shell, zod on `force` and list filters, store
path containment, evidence and PDF reads re-hashed (tampered bytes → 409 + audit), certificate route, and a signed PDF
is never re-rendered. `docxTemplates.test.ts`: the ten built-ins (warnings on 01, 02 and the letterhead; zero mapping
issues), synthetic uploads built in-test with fflate (suggested mapping, refusals: not a zip, macro content type, DTD,
oversize, no slots, extension; duplicate), mapping save/reset, replacement files, test fill, converters, the values form
on File 1, generation (acknowledgement gate, baseline suppression, `GUARD_BLOCKED` for 05 without bank details,
`SLOT_NOT_FILLABLE` for a signature box, `VALUES_REQUIRED`), the stored .docx (`PK`, `x-sha256`, tamper → 409), approval
to PDF with the browser converter, supersede re-using and merging inputs, and `letterhead.docx` for an approved
`letter.chaser_7` (`NOT_A_LETTER` for an invoice). `auth.test.ts` (built with `authMode: 'session'`): scrypt format and verification, cookie parsing,
the default account, login → HttpOnly cookie → `/auth/me`, wrong password and unknown user both `401
INVALID_CREDENTIALS`, protected routes `401` without a cookie (and with only `X-User-Id`), the `claim.create` audit row
records `courtesycars`, logout, the `429` rate limit (and that a spoofed `X-Forwarded-For` does not reset it),
login-defaults before/after change-password, change-password validation and signing out other sessions, 12-hour expiry,
the `Secure` flag in production, and that no password or token reaches `audit_log`, any table, or the captured logger
output. `auth-security.test.ts` walks `app.printRoutes()` and asserts `401 UNAUTHENTICATED` for every non-public `/api`
route and method with no cookie, a forged cookie and `X-User-Id`; checks that a parallel burst of 40 wrong passwords
gets exactly 10 password checks (the rest `429`), the same for change-password, that a flood of junk usernames cannot
evict a locked key, and that CORS grants credentials to localhost origins only. Lookup mappers and clients are unit-tested with fixture payloads and a fake `fetch` (no network).

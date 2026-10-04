# @ccguk/api — ClaimDesk REST API

Fastify 5 + SQLite (via `@ccguk/db`) + the pure engines in `@ccguk/domain`. Base path `/api`. JSON bodies are validated
with zod; errors are `{ error: { code, message, details?, requestId } }`. Money is integer pence, dates are ISO strings,
the ledger / events / evidence / audit log are append-only, and nothing is ever sent automatically.

## Run

```bash
pnpm --filter @ccguk/api dev        # tsx watch src/server.ts  (migrations run on boot; data dirs are created)
pnpm --filter @ccguk/api start
pnpm --filter @ccguk/api seed       # default handler + File 1 archetype (idempotent: skipped when claims exist)
pnpm --filter @ccguk/api typecheck && pnpm --filter @ccguk/api test
```

Environment (`.env` in `apps/api/` or the repo root; every variable is optional):

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `3000`, `0.0.0.0` | listen address |
| `DATA_DIR` | `apps/api/data` | parent of the defaults below |
| `DATABASE_PATH` | `$DATA_DIR/claimdesk.sqlite` | SQLite file (`:memory:` in tests) |
| `EVIDENCE_DIR`, `DOCUMENTS_DIR` | `$DATA_DIR/evidence`, `$DATA_DIR/documents` | write-once evidence store, rendered PDFs |
| `CHROMIUM_PATH` | — | passed through to `@ccguk/documents` `renderPdf` |
| `WEB_DIST_DIR` | `apps/web/dist` | when `index.html` exists it is served at `/` with SPA fallback |
| `DVLA_VES_API_KEY` | — | DVLA Vehicle Enquiry Service |
| `DVSA_MOT_CLIENT_ID`, `DVSA_MOT_CLIENT_SECRET`, `DVSA_MOT_API_KEY`, `DVSA_MOT_TOKEN_URL`, `DVSA_MOT_SCOPE_URL` | scope defaults to `https://tapi.dvsa.gov.uk/.default` | DVSA MOT History (OAuth2 client credentials) |
| `COMPANIES_HOUSE_API_KEY` | — | Companies House |
| `ESIGN_SECRET` | — | OTP HMAC secret (services agent) |
| `DEFAULT_USER_ID` | `handler` | user assumed when `X-User-Id` is absent (dev/test only) |
| `LOOKUP_TIMEOUT_MS` | `10000` | outbound lookup timeout |

Keys never leave the process: only presence flags are exposed (`/api/health`, `Settings.apiKeysPresent`).

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
| `ImmutableError` (`LedgerImmutableError`, `EventImmutableError`, …) | `409 IMMUTABLE` |
| `DocumentStateError` / `VerificationError` | `409` |
| `HttpError` (`src/errors.ts`) | as given (`HARD_STOP`, `ALLOCATION_REFUSED`, `WRONG_CLAIM`, …) |
| anything else | `500 INTERNAL` (logged with the request id) |

## Layout

```
src/
  config.ts        loadConfig()/testConfig() — env, data dirs, key presence
  context.ts       AppContext { config, handle, db, repos, settings(), kb, now(), engines(), logger, close() }
  app.ts           buildApp(ctx): cors, multipart (25 MB), static web + SPA fallback, error handler, auth placeholder
  server.ts        start(): migrations on boot, data dirs, listen
  seed.ts          dev seed
  engines.ts       typed runtime resolution of @ccguk/domain engines (see "Engines" below)
  errors.ts        HttpError helpers
  schemas/         zod schemas mirroring packages/domain/src/types.ts
  services/        claimView (bundle + clocks/gates/actions/acceptance), sideEffects (event → effects),
                   lookup (DVLA/DVSA/Companies House clients + mapping), fallbacks (rules-first engine stand-ins)
  routes/          one module per resource + index.ts registry
  test/            fastify-inject integration tests on an in-memory database
```

## Route-module convention (where the services agent adds modules)

A module is `src/routes/<name>.ts` exporting `register<Name>Routes(app: FastifyInstance, ctx: AppContext): void`.
Register it by appending to the `routeModules` array in `src/routes/index.ts` — it is a plain array and every module
is mounted under `/api`. Inside a handler:

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

## Routes implemented here

- `GET /health`
- Claims: `GET /claims` (`status` (comma list), `handlerId`, `atFaultInsurerId`, `claimantId`, `search`/`q`, `flagged`, `limit`, `offset` → `{items, total, byStatus}`),
  `POST /claims` (FNOL → `{claim, intake}`: `validateFnol`, `crossFileRegistrationCheck` (links duplicates, `DUPLICATE_REGISTRATION` warn, `FLEET_UNIT_AS_CLIENT_VEHICLE` block), `scoreLiability`, `routeInjury` (flag + task event, `feeTaken: false`), script-guard offer capture into the intervention register),
  `GET /claims/:id` (ClaimBundle + `gates`, `actions`, `acceptance`, `position`, `linkedClaims`; clocks recomputed and cached),
  `PATCH /claims/:id`, `POST /claims/:id/status` (409 `HARD_STOP` while a block flag is uncleared), `POST /claims/:id/flags/:code/clear`,
  `GET /claims/:id/clocks|gates|actions|acceptance|audit`
- Parties: `GET/POST /parties`, `GET/PATCH /parties/:id`, `GET /parties/:id/connections` (`linkage.findConnections` against staff = users, suppliers, previous clients, witnesses; `witnessIndependence` per claim the party sits on)
- Vehicles: `GET/POST /vehicles` (manual entry stores an `unverified` lookup record), `GET /vehicles/:id`, `POST /vehicles/lookup` (`{registration}` → `manual_required` + `fields` when keys are missing, otherwise VES + MOT mapped via `mapDvlaVes`/`mapDvsaMotHistory`, upserted, raw payloads stored as `verified` LookupRecords), `POST /vehicles/:id/odometer`, `GET /vehicles/:id/mileage-conflicts`
- Ledger: `GET/POST /claims/:id/ledger` (`PATCH`/`PUT`/`DELETE` → 409)
- Events: `GET/POST /claims/:id/events` — side effects: `intervention_offer` creates the offer; `report_issued` with open storage adds `storage_report_plus_48h` and flags `SEND_COLLECT_OR_PAY`; `repair_completed` / `tl_payment_received` / `insurer_termination_notice` / `cash_in_lieu_received` compute `gta.offHireDeadline` and record the expected end trigger on open hires
- Hire: `GET/POST /claims/:id/hire` (`fleet.canAllocate` guard, enforceability gaps → `HIRE_ENFORCEABILITY_GAP`), `POST /claims/:id/hire/:hireId/end` (trigger + date required; `hire_ended` event; clock met)
- Storage: `GET/POST /claims/:id/storage`, `POST /claims/:id/storage/:sid/end`
- Recovery: `GET/POST /claims/:id/recovery` (`gta.recoveryCharge` → ledger `claimed` under `recovery`: £90 + £3/loaded mile + £25, VAT separate)
- Offers: `GET/POST /claims/:id/offers`, `PATCH /claims/:id/offers/:oid` (decision/reply; `replySentAt` writes `intervention_reply_sent`)

Still to add (services agent, per ARCHITECTURE): evidence, templates/documents, engineering, fleet, directory, kb, watch, analytics, settings.

## Engines

`src/engines.ts` resolves `deriveClocks`, `nextActions`, `assessAcceptance`, `scoreLiability`, `validateFnol`,
`routeInjury` and `canAllocate` from `@ccguk/domain` by name at runtime. Where a domain module has not landed yet the
API uses the rules-first stand-ins in `src/services/fallbacks.ts` (same output shapes); `/api/health` → `engines`
shows which are live. Clocks: the domain `deriveClocks(bundle, now)` output is cached via `replaceClocks`, supplemented
only with kinds it does not emit. `evaluateGates`, `crossFileRegistrationCheck`, `mileageConflicts`, `findConnections`,
`witnessIndependence`, `recoveryCharge`, `storageCharge`, `calculateHire` and `offHireDeadline` are imported directly.

## Tests

`vitest` on `createDatabase(':memory:')` with `app.inject`: FNOL → bundle → clocks/gates/actions; list/search/status;
cross-file duplicate link + fleet hard stop; injury referral and script-guard offer capture (reply clock met);
ledger immutability (409 + DB trigger) and correction by supersession; recovery ledger entry = 9000 + 300×miles + 2500
(+VAT); hire allocation guard, off-hire clock met on repair completion; storage report+48h clock and flag; manual
vehicle lookups and odometer conflicts; party connections and witness independence. Lookup mappers and clients are
unit-tested with fixture payloads and a fake `fetch` (no network).

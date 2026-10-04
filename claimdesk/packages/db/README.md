# @ccguk/db

SQLite persistence for ClaimDesk: Drizzle (`sqlite-core`) schema, SQL migrations, plain-function repositories and the `ClaimBundle` assembler. Consumed from source (`main: ./src/index.ts`), no build step.

```ts
import { createDatabase, runMigrations, createClaim, loadClaimBundle } from '@ccguk/db';

const { db, sqlite } = createDatabase({ path: 'data/claimdesk.sqlite' }); // or ':memory:'
runMigrations(db);
const claim = createClaim(db, { accident, liability: 'unknown', claimantId, clientVehicleId });
const bundle = loadClaimBundle(db, claim.id); // → ClaimBundle for the domain engines
```

## Conventions (from docs/ARCHITECTURE.md)

- Text primary keys (`crypto.randomUUID()`), ISO text dates, **integer pence** for money, JSON text columns typed with `$type<>()`.
- **Append-only**: `ledger_entries`, `claim_events`, `evidence`, `audit_log`. The repos' `update*/delete*` functions throw `LedgerImmutableError` / `EventImmutableError` / `EvidenceImmutableError` / `AuditImmutableError` (all extend `ImmutableError`, `code: 'IMMUTABLE'`), and migration `0001` adds `BEFORE UPDATE/DELETE` triggers so raw SQL is refused too. Corrections are new rows with `supersedesId`; superseded ledger rows are hidden from `listLedger`/`sumLedger` by default.
- Documents: `draft → (blocked) → approved → sent`; `approveDocument` refuses blocked drafts and `system` actors; flag clearances, approvals, sends, supersessions and signatures are audited.
- Verification is data: `upsertDirectoryOverride` refuses `status: 'verified'` unless a human supplies a `sourceUrl` (`verifyDirectoryEntry`).
- The cross-file registration rule is a **flag** (`addClaimFlag`), not a constraint; `listClaimsForRegistration` and `findFleetUnitsByRegistration` feed the domain check.
- **Credentials**: `users.password_hash` only ever holds a self-describing hash (`scrypt$N$r$p$salt$hash`, made by the API with `node:crypto`); `createUser`/`setPassword` refuse anything else. User records returned by the repos never carry the hash — `getPasswordHash(userId)` is the one read path, for sign-in. `users.username` is stored trimmed and lower-cased (case-insensitive unique; null for staff who cannot sign in).
- **Sessions** (`sessions`, migration `0002`): the id is the sha256 hex digest of the session token — the token itself never reaches the database (`createSession` refuses anything that is not 64 hex characters). Rows carry an absolute `expires_at` and are deleted on logout, password change and expiry, so `sessions` is deliberately **not** append-only; it cascades with its user.

## Layout

| Path | Contents |
|---|---|
| `src/schema.ts` | 27 tables + `$inferSelect`/`$inferInsert` types (`ClaimRow`, `ClaimInsert`, …), `RateCard`, `ApiKeysPresent` |
| `drizzle/` | `0000_init.sql` (drizzle-kit generated), `0001_append_only_triggers.sql` (hand-written custom migration), `0002_auth_sessions.sql` (drizzle-kit generated: `users.username`/`password_hash`/`password_changed_at`, `sessions`), `meta/` journal + snapshots |
| `drizzle.config.ts` | `pnpm --filter @ccguk/db exec drizzle-kit generate` regenerates after a schema change |
| `src/client.ts` | `createDatabase({ path, busyTimeoutMs?, readonly? })` → `{ sqlite, db, path }` (WAL, `foreign_keys=ON`, busy timeout); `closeDatabase()`; `Db` (repo parameter type: works for connections and transactions), `DbClient` |
| `src/migrate.ts` | `runMigrations(db)` — folder resolved from `import.meta.url`; `migrationsFolder` |
| `src/repos/*.ts` | one module per aggregate (below) |
| `src/bundle.ts` | `loadClaimBundle(db, claimId, { includeHtml?, includeSupersededLedger? })` |
| `src/errors.ts` | `DbError` (`code`), `NotFoundError`, `ImmutableError` family, `DocumentStateError`, `VerificationError`, `ValidationError` |
| `src/testing.ts` | `createTestDatabase()` — in-memory, migrated |
| `src/fixtures/fileOne.ts` | `seedFileOne(db)` + `FILE_ONE` constants — the "£1,287 stated / £1,112 received" live-file archetype |

## Repositories (all `(db, …)` plain functions, return domain types)

| Module | Functions |
|---|---|
| `claims` | `createClaim` (reference `CCG-YYYY-NNNNN`, sequential per year via `claim_sequences`), `getClaim`, `getClaimByReference`, `requireClaim`, `listClaims({status, handlerId, atFaultInsurerId, claimantId, search, flagged, limit, offset})`, `updateClaim`, `setClaimStatus(db, id, status, actor, reason?)` (audited), `addClaimFlag`, `clearClaimFlag` (audited), `linkClaims`, `countClaimsByStatus`, `nextClaimReference` |
| `parties` | `createParty`, `getParty`, `getParties`, `requireParty`, `updateParty`, `searchParties(q, {roles})` (name/trading name/email/phone/company no./registration via claims), `listParties`, `findConnections({partyId | name, phone, email, postcode, bank})` → `{ party, matchedOn[] }[]` for the linkage engine |
| `vehicles` | `upsertVehicle` (by normalised registration; merges odometer/lookups), `getVehicle`, `findByRegistration`, `updateVehicle`, `addOdometer`, `addLookup`, `searchVehicles`, `listVehicles`, `listClaimsForRegistration` |
| `fleet` | units `createFleetUnit`/`getFleetUnit`/`listFleetUnits`/`updateFleetUnit`/`deleteFleetUnit`/`findFleetUnitsByRegistration`; policies `createPolicy`/`getPolicy`/`listPolicies`/`updatePolicy`; penalties `createPenalty`/`getPenalty`/`listPenalties({fleetUnitId, stage, open})`/`updatePenalty`/`setPenaltyStage` |
| `ledger` | `appendLedgerEntry` (validates integer pence, `supersedesId` same claim), `getLedgerEntry`, `listLedger(claimId, {head, kind, includeSuperseded})`, `sumLedger` (by head × kind), `ledgerPosition` (per-head claimed/invoiced/offered/reduced/paid/writtenOff/adjustment/outstanding + totals), `totalPaid`, `listSupersededLedger`; `updateLedgerEntry`/`deleteLedgerEntry` throw |
| `events` | `appendEvent`, `getEvent`, `listEvents(claimId, {type, from, to})` ordered by `at`, `latestEventOfType`, `firstEventOfType`; `updateEvent`/`deleteEvent` throw |
| `clocks` | `replaceClocks(claimId, clocks, computedAt?)` (materialised cache of `deriveClocks`), `listClocks`, `listDueClocks({dueBefore, status})` |
| `offers` | `createOffer`, `getOffer`, `listOffers`, `updateOffer`, `recordOfferDecision`, `recordOfferReply` |
| `hire` | `createHire` (agreement no. `CCG-H-NNNNNN`), `getHire`, `listHire`, `listHireForFleetUnit`, `activeHireForFleetUnit`, `updateHire`, `endHire({endAt, endTrigger, collectedAt?, odometerIn?})` |
| `storage` | `createStorage`, `getStorage`, `listStorage`, `updateStorage`, `endStorage({endAt, endTrigger})` |
| `recovery` | `createRecovery`, `getRecovery`, `listRecovery`, `updateRecovery`, `recoveryNetPence` (£90 + £3 × miles + £25) |
| `evidence` | `insertEvidence` (sha256 validated), `getEvidence`, `getEvidenceMany`, `listEvidenceForClaim({kind})`, `findEvidenceBySha256`; `updateEvidence`/`deleteEvidence` throw |
| `documents` | `createDraft`, `getDocument(id, {includeHtml})`, `listDocuments({claimId, templateId, status, includeHtml})`, `listSentDocuments`, `setConsistency`, `clearDocumentFlag` (audited), `approveDocument` (audited), `markDocumentSent` (audited), `setDocumentPdf`, `supersedeDocument` (audited; `reExecutedOn`), `voidDocument`, `attachSignature` (hash + creation-floor checks; writes `signatures`), `listSignaturesForClaim`, `updateDraft` |
| `engineering` | PAV `createPav` (override reason required when `pavPence ≠ medianPence`)/`getPav`/`getLatestPav`/`listPav`/`approvePav`; estimates `createEstimate`/`getEstimate`/`getLatestEstimate`/`listEstimates`/`updateEstimate`; reports `createEngineerReport`/`getEngineerReport`/`getLatestEngineerReport`/`listEngineerReports`/`updateEngineerReport`/`issueEngineerReport` |
| `watch` | `upsertCompanyWatch`, `getCompanyWatch`, `listCompanyWatch({riskLevel})`, `recordCompanyPoll` (merges gazette notices / officer changes), `removeCompanyWatch`, `normaliseCompanyNumber` |
| `directoryOverrides` | `getDirectoryOverride`, `listDirectoryOverrides`, `upsertDirectoryOverride` (audited), `verifyDirectoryEntry`, `reportDirectoryFailed`, `reportDirectoryUsedOk`, `applyDirectoryOverrides(kbEntries, overrides)` (pure) |
| `settings` | `getSettings` (defaults: Courtesy Cars Group UK Ltd, rate card £90/£3/£25, £45/day, £285), `patchSettings` (audited), `DEFAULT_RATE_CARD`, `DEFAULT_SETTINGS` |
| `audit` | `appendAudit({actor, action, entity, entityId, before, after})`, `listAudit({entity, entityId, userId, action})`; `Actor = { userId, ip? }`, `SYSTEM_ACTOR` |
| `labourLibrary` | `addLabourEntry`, `listLabourEntries`, `labourStats` (medians per make/model/panel/operation), `countLabourEntries` |
| `users` | `createUser` (optional `username`, `passwordHash`), `getUser`, `requireUser`, `getUserByEmail`, `getUserByUsername` (case-insensitive), `getPasswordHash`, `setPassword(userId, hash, at?)` (stamps `passwordChangedAt`), `listUsers`, `updateUser`, `normaliseUsername`, `assertPasswordHash` |
| `sessions` | `createSession({tokenHash, userId, expiresAt, createdAt?, ip?, userAgent?})`, `getSessionByTokenHash`, `touchSession`, `deleteSession`, `deleteUserSessions(userId, exceptId?)`, `deleteExpiredSessions(now)`, `listUserSessions` |

All mutating functions can run inside `db.transaction((tx) => …)` by passing `tx` as the `db` argument.

## Scripts

```
pnpm --filter @ccguk/db typecheck
pnpm --filter @ccguk/db test
pnpm --filter @ccguk/db exec drizzle-kit generate            # after editing src/schema.ts
pnpm --filter @ccguk/db exec drizzle-kit generate --custom   # for hand-written SQL (triggers, data fixes)
```

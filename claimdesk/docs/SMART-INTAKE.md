# ClaimDesk Smart Intake — case bundles (design and build spec)

Status: server slice (intake-server: domain, db, api) built and tested; web slice (intake-web) built in parallel — see
`docs/RELEASE-NOTES-0.5-SMART-INTAKE.md`. Originally: design, ready to build in two parallel slices (§17). Builds on Supreme phase 1, Autopilot and the Knowledge
Builder, all green. Read with `docs/SUPREME-DESIGN.md` (SD, especially §C, §D, §G), `docs/SUPREME-AUTOPILOT.md` (AP)
and `docs/SUPREME-KNOWLEDGE-BUILDER.md` (KB). Where this document names an existing function, file or table, that is
what the code holds today (checked against the code, not only the docs).

---

## 0. The owner's request and what changes

> "update the intake logic so that itll think smartly about all th files that are uploaded and update eahc one to eahc
> case, like i can write a claim name temporarily then upload files and then itll read and understand the logic of all
> uploaded files together then register claim or make it much more advanced think of 10 other improvemebnts"

Today (code, `apps/api/src/intake/**`): every file becomes an `intake_items` row and is read **on its own**
(`intake.process` → `intake.extract` (AI) → `intake.apply`). With no claim, an FNOL-like document raises one
`new_claim` card per file; "Start a claim from these" (`buildNewClaimDraft`, `intake/newClaimDraft.ts`) merges several
items with "higher confidence wins" and opens the New Claim wizard. Nothing reads the files **together**, nothing sorts
a mixed drop into cases, ZIP files are skipped, multi-document scans stay one document, duplicates are not linked,
photos are not checked, there is no timeline, no missing-documents list, nothing works when the AI is paused, and a
claim is never registered in one step.

After this change:

1. The owner types a temporary name ("Jane Doe – Corsa crash"), drops any number of files (PDF, photos, Word, `.eml`
   with attachments, `.zip`, scans) — or drops a folder into `inbox\intake\<name>\`. That is a **case bundle**.
2. Every file is read by the existing per-file pipeline, extended (ZIP unpacking, page splitting, photo facts, a
   deterministic reading that works with the AI paused).
3. A **bundle-level step** reads all files together: sorts them into cases (this case / another new case / an existing
   claim / not sure), reconciles one draft claim with per-field provenance and source ranking, lists conflicts, the
   missing documents, a proposed chronology and owner-only risk signals; an AI reasoning pass (queued when the AI is
   paused) improves it.
4. The owner reviews and presses **Register claim**: one click creates the claim, files every document as evidence of
   the right kind, applies the fields, writes the chronology, records photo damage zones, prepares the request for
   missing documents (sent only through the normal outbox approval) and nudges the Autopilot. A one-glance **case
   brief** follows. Or the bundle is **attached to an existing claim** instead.
5. A Settings option (off by default) registers automatically when there are no conflicts, every key field is
   confident and nothing needs the owner; otherwise the bundle waits in Needs-you as a prepared claim.

The ten improvements (§0.1) are all in scope. Owner's rules are kept exactly (§10): routine work automatic and in the
daily log; anything missing prepared and confirmed with the owner; offers, settlements, money and legal always ask;
nothing is ever declined or accused automatically — risk signals are for the owner's eyes only.

### 0.1 The ten improvements → where they live

| # | Improvement | Domain (pure) | API | Web |
|---|---|---|---|---|
| 1 | Mixed-upload auto-sorting into existing claim / new case A / new case B / unsure, with reasons; drag to move | `smart/keys.ts`, `smart/group.ts` | `bundles/claimIndex.ts`, `bundles/recompute.ts`, move route | `FilesBoard.tsx` |
| 2 | Cross-document conflicts with source ranking, best preselected, never silently overwritten | `smart/ranking.ts`, `smart/compat.ts`, `smart/reconcile.ts` | `bundles/candidates.ts`, conflict routes | `ConflictsPanel.tsx` |
| 3 | Field provenance (file / page / quote / confidence; open at that page) | `smart/types.ts` (`FieldSource`) | `bundles/views.ts` | `ProvenanceDrawer.tsx` |
| 4 | Missing-documents checklist per case kind + prepared client request email | `smart/checklist.ts` | `bundles/requestDocs.ts` (outbox policy) | `ChecklistCard.tsx` |
| 5 | Duplicate / near-duplicate detection (hash, perceptual hash, same letter twice) — linked, not double-filed | `smart/phash.ts`, `smart/duplicates.ts` | `intake/image.ts` | badges in `FilesBoard.tsx` |
| 6 | Scanned-pack splitting into page ranges, each classified | `smart/split.ts`, `smart/classify.ts` | `intake/split.ts`, job `intake.split` | nested segments in `FilesBoard.tsx` |
| 7 | Photo intelligence: EXIF date/GPS vs accident, plates read and matched, damage zones → claim damage model | `smart/photo.ts` | extraction `photo`, `bundles/damage.ts`, `GET /claims/:id/damage-zones` | `PhotoStrip.tsx`, `DamageModelPanel.tsx` |
| 8 | Timeline builder (chronology proposals with sources, applied on register) | `smart/timeline.ts` | `bundles/register.ts` (`appendClaimEvent`) | `TimelineCard.tsx` |
| 9 | Risk signals at intake (owner-only; never decline) | `smart/signals.ts` | `bundles/signalsInput.ts` (clash/identity/linkage reuse) | `RiskPanel.tsx` |
| 10 | One-glance case brief + next actions; owner corrections captured for the Knowledge Builder | `smart/briefText.ts` | `bundles/brief.ts`, `bundles/corrections.ts`, `knowledge/learners/corrections.ts` | `CaseBriefView.tsx`, `IntakeBriefCard.tsx` |

Also in scope: `.zip` and `.eml` attachments unpacked into the bundle; progress per file; works with the AI paused;
everything audited; daily-log lines.

---

## 1. Overview

### 1.1 Flow

```
 owner: "New bundle" + name ──► POST /intake/bundles ──► intake_bundles row
 drop files / folder        ──► POST /intake/bundles/:id/files (multipart ≤10/req, or {uploadId}/{importId}/{evidenceId})
 inbox\intake\<name>\       ──► imports scan → staged import with bundleFolder ─► bundle (find-or-create by folder)
                                      │
            per file (existing pipeline, extended)                     ▼
   intake.process (cpu) : sniff → normalise (+ZIP unpack, +PDF metadata, +image pHash, +EXIF from evidence row)
                          → RULES reading (classify + regex fields) stored as an extraction row (engine 'rules')
                          → text-PDF pack? → intake.split (cpu) → segment PDFs → child items
                          → hooks.onItemSettled ─────────────────────────────┐
   intake.extract (ai)  : AI reading (+docSide, documentDate, photo{plates,zones}, segments) │ queued while AI paused
                          → hooks.onItemSettled ; AI segments → intake.split                 │
   intake.apply (io)    : unchanged for claim-linked items; bundle items with no claim: no per-file card
                                                                                              ▼
   intake.bundle_reconcile (cpu, deterministic, debounced per revision)
        duplicates → keys → groups → candidates → ranking/conflicts → owner decisions → checklist → timeline
        → signals → liability preview → registrability → bundle.computed ; Needs-you `new_claim` (bundle) or auto path
        → when every file has settled: intake.bundle_reason (ai) ──► result validated (quotes, ids, validators)
                                                                     → reconcile again (AI candidates added)
   owner: Register ─► registerBundle (createClaimFromFnol, copyEvidenceToClaim with kinds, appendClaimEvent,
                      damage observations, leftover groups split off, request-docs draft → outbox policy,
                      claimChanged → clash.check + Autopilot nudge, corrections) ─► case brief
   setting on + eligible ─► intake.bundle_register (io) as agent:intake, same service
```

### 1.2 Key decisions

| Decision | Choice | Why |
|---|---|---|
| Per-file reading | Keep `intake.process/extract/apply`; extend, do not fork | One reader; existing fixtures, tests, proposals, confirm cards keep working |
| Bundle model | New tables `intake_bundles`, `intake_bundle_files`, append-only `intake_bundle_decisions`, `intake_bundle_reasonings`; derived state cached as JSON (`computed`) | Owner choices are the durable truth (append-only); everything else is recomputable |
| AI paused | A deterministic **rules reading** for every file + deterministic bundle reconcile; AI per-file extraction and AI bundle reasoning queue and improve the draft later | Owner can register with the AI paused; auto-register only after AI reasoning |
| New Needs-you kinds | **None.** Reuse `new_claim` (bundle payload variant, intake resolver), `confirm_fields` (bundle variant), `missing_info` (mail's outbox flow), `question` | No lockstep edit of `KIND_LABEL` (web) / `NEEDS_YOU_KIND_LABEL` (api); no resolver ownership clash (`which_claim` belongs to mail) |
| Register path | One service `registerBundle(ctx, bundleId, actor, opts)`, called by the owner route (owner actor) and the auto job (`agent:intake`); claim creation through the route's own core `createClaimFromFnol` (FNOL validation unchanged, STRICT gate) | Same validation, flags, cross-file check, liability score, injury routing as a person creating a claim |
| Evidence filing | `copyEvidenceToClaim` (mail/common.ts) with a new optional `kind`; originals stay claimless and immutable | Evidence is write-once; the claim gets its own rows with the right kind (feeds gates) |
| Risk signals | Stored per bundle (computed), shown only in the bundle, the Needs-you panel and the owner's brief; never in agent prompts, documents, chronology or outbound | Owner rule: signals only, never accuse or decline |
| Corrections | Through the existing path: `runtimeServices(ctx).recordCorrection` → `memory_items(kind:'correction')` → `knowledge.observe` capture (`knowledge/learners/corrections.ts`, extended for intake fields) | "corrections path that already exists" (KB §6.4) |
| Dependencies | `apps/api` adds `pdf-lib@1.17.1` (already in the lockfile via `@ccguk/documents`), `jpeg-js@0.4.4` (BSD-3-Clause), `pngjs@7.0.0` (MIT) — pure JS, no native code | Page splitting writes PDFs; perceptual hash needs pixels |

### 1.3 Reused, not duplicated (existing code this feature calls)

| Need | Existing code |
|---|---|
| Sniff, normalise, PDF text, EML parse, DOCX text | `intake/sniff.ts`, `intake/normalise.ts` (`pdfText`, `parseEmail`, `docxToPlainText`) |
| Items, staged imports, chunked uploads | `intake/items.ts` (`createItemFromStaged`, `consumeUpload`, `consumeStagedImport`), `services/imports.ts`, `services/uploads.ts` |
| Validators (VRM, VIN, DVLA licence, dates, phone, email, address) | `intake/validators.ts` via `targetDef(target).validate` (`intake/targets.ts`) |
| Proposals, policy, apply as owner / agent | `intake/proposals.ts` (`proposeField`, `proposalPolicy`, `vinElsewhere`), `intake/apply.ts` (`applyProposals`, `ownerApplier`, `agentApplier`), `intake/callerContext.ts` |
| Claim creation + FNOL validation + cross-file + liability + injury | `routes/claims.ts` `createClaimFromFnol`, `services/intake.ts` `normaliseFnol`/`toFnolInput`, `engines.ts` `validateFnolInput`, `scoreLiabilityFor` |
| Clash / identity / linkage | `@ccguk/domain` `crossFileRegistrationCheck`, `personMatch`, `vehicleMatch`, `normaliseVin`, `normalisePersonName`, `findConnections`, `normalisePhone/Email/Postcode/AddressKey/BankKey`; `apps/api/src/clash/service.ts` `queueClashCheck` (via `claimChanged`) |
| Chronology write with audit + clocks | `mail/common.ts` `appendClaimEvent` |
| Evidence copy onto a claim | `mail/common.ts` `copyEvidenceToClaim` |
| Prepared email → review → policy → Needs-you | `mail/outbox.ts` `createEmailDraft` (kind `doc_request` ⇒ `missingInfo` ⇒ always asks) |
| Autopilot nudge + clash check | `autopilot/claimChanged.ts` `claimChanged`; plan view `autopilot/service.ts` `autopilotView` |
| Next actions | `casework/caseBrief.ts` `buildCaseBrief(...).nextActions` |
| Quote verification | `@ccguk/domain` `findQuote` (knowledge/quotes.ts) |
| Damage zones taxonomy | `@ccguk/domain` `VEHICLE_ZONES`, `isZoneId`, `zoneForPanelName` (engineering/panels.ts) |
| New-claim wizard prefill | `intake/newClaimDraft.ts` `saveDraft` + web `?intakeDraft=<id>` |
| Policy | `@ccguk/domain` `decide()`; `agent/core.ts` `getAutonomy`, `autonomyState`, `createNeedsYou`, `enqueueJob` |

---

## 2. Concepts and lifecycle

* **Bundle** — a named working set of files that the owner believes is (mostly) one case. Starts claimless.
* **Bundle file** — one intake item inside a bundle (an item may be in several bundles: same bytes dropped twice).
  Children (EML attachments, ZIP entries, split segments) join the bundle of their parent automatically.
* **Group** — computed partition of the bundle's files: `main` (this case), `case:B`, `case:C` … (other new cases),
  `claim:<claimId>` (an existing claim), `unsure`, `excluded`. The owner can move files; a moved file is pinned.
* **Candidate** — one reading of one field from one file (engine `ai`, `rules`, `exif`, `plate`, `owner`,
  `name_hint`, `ai_reasoning`).
* **Draft field** — the reconciled value for a `BundleFieldKey` with its provenance, alternatives and status.
* **Conflict** — two or more incompatible readings of one key with confidence ≥ 0.5. Best preselected by source
  rank; stays `open` until the owner confirms (or accepts all preselected).
* **Decision** — an append-only owner (or agent) action on the bundle; the computed state is re-derived from files +
  readings + decisions every time.

Bundle `status` (stored):

```
open ──(files added)──► reading ──(all files settled)──► reconciling ──► ready ─┬─► needs_you (card raised)
  ▲                         ▲                                              │     │
  └──── new files / reopen ─┴──────────────────────────────────────────────┘     ├─► registering ─► registered
                                                                                  ├─► attached
                                                                                  └─► cancelled
```

`reading` while any file is `queued|normalising|splitting` or its rules reading is not stored; `reconciling` while the
reconcile job for the current revision has not run; `ready` when computed for the current revision (AI reasoning may
still be queued — shown separately as `reasoning.status`). `needs_you` = ready + an open `new_claim` card. Registered /
attached / cancelled are terminal (a cancelled bundle can be reopened; files never disappear).

`revision` increments on every file added/removed/moved and every decision; jobs carry the revision they were queued
for and exit early when stale.

---

## 3. Data model

### 3.1 Migration `packages/db/drizzle/0015_smart_intake.sql`

Next free file number is **0015** (0000–0014 exist). Journal entry (append to `packages/db/drizzle/meta/_journal.json`):

```json
{ "idx": 15, "version": "6", "when": 1792450000000, "tag": "0015_smart_intake", "breakpoints": true }
```

`1792450000000` > every existing `when` (largest today: `0014_knowledge` = `1792350000000`). Add a guard test in
`packages/db/src/migrationOrder.test.ts`: `0015_smart_intake` has `when` 1792450000000 and is last.

```sql
-- Smart intake (docs/SMART-INTAKE.md §3). Journal `when` 1792450000000 (after 0014_knowledge 1792350000000).
-- Case bundles: owner decisions and AI reasoning results are append-only (triggers below). Bundle files carry
-- derived per-file facts (duplicates, split ranges, photo facts, filing result) that are re-derivable.
CREATE TABLE `intake_bundles` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('open','reading','reconciling','ready','needs_you','registering','registered','attached','cancelled')),
  `source` text NOT NULL CHECK (`source` IN ('upload','folder','split')),
  `folder_key` text, `parent_bundle_id` text, `split_from_group` text,
  `claim_id` text, `outcome` text CHECK (`outcome` IS NULL OR `outcome` IN ('registered','attached')),
  `revision` integer NOT NULL DEFAULT 0, `computed_revision` integer, `computed` text,
  `reasoning_status` text NOT NULL DEFAULT 'none' CHECK (`reasoning_status` IN ('none','queued','waiting_ai','done','failed','skipped')),
  `reasoning_fileset` text, `auto_eligible` integer NOT NULL DEFAULT 0, `needs_you_id` text, `error` text,
  `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL,
  `closed_by` text, `closed_at` text);
--> statement-breakpoint
CREATE INDEX `intake_bundles_status_idx` ON `intake_bundles` (`status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `intake_bundles_claim_idx` ON `intake_bundles` (`claim_id`);
--> statement-breakpoint
-- One open bundle per inbox folder (Windows is case-insensitive: compare lower-case).
CREATE UNIQUE INDEX `intake_bundles_folder_open_uq` ON `intake_bundles` (lower(`folder_key`))
  WHERE `folder_key` IS NOT NULL AND `status` NOT IN ('registered','attached','cancelled');
--> statement-breakpoint
CREATE TABLE `intake_bundle_files` (`id` text PRIMARY KEY NOT NULL, `bundle_id` text NOT NULL, `intake_item_id` text NOT NULL,
  `evidence_id` text NOT NULL, `parent_file_id` text, `position` integer NOT NULL,
  `role` text NOT NULL DEFAULT 'document' CHECK (`role` IN ('document','pack','segment','attachment','archive','email')),
  `page_from` integer, `page_to` integer,
  `phash` text, `facts` text,
  `filed_evidence_id` text, `filed_claim_id` text, `filed_kind` text, `filed_at` text,
  `added_by` text NOT NULL, `added_at` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `intake_bundle_files_item_uq` ON `intake_bundle_files` (`bundle_id`, `intake_item_id`);
--> statement-breakpoint
CREATE INDEX `intake_bundle_files_bundle_idx` ON `intake_bundle_files` (`bundle_id`, `position`);
--> statement-breakpoint
CREATE INDEX `intake_bundle_files_item_idx` ON `intake_bundle_files` (`intake_item_id`);
--> statement-breakpoint
CREATE TABLE `intake_bundle_decisions` (`id` text PRIMARY KEY NOT NULL, `bundle_id` text NOT NULL, `revision` integer NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('create','rename','add_files','move_file','exclude_file','include_file','unsplit',
    'set_field','clear_field','choose_conflict','accept_preselected','confirm_new','link_party','tick_timeline','untick_timeline',
    'ack_signal','split_off','think_again','register','attach','cancel','reopen')),
  `subject` text, `before` text, `after` text, `note` text, `actor` text NOT NULL, `run_id` text, `at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `intake_bundle_decisions_bundle_idx` ON `intake_bundle_decisions` (`bundle_id`, `at`);
--> statement-breakpoint
CREATE TABLE `intake_bundle_reasonings` (`id` text PRIMARY KEY NOT NULL, `bundle_id` text NOT NULL, `fileset` text NOT NULL,
  `engine` text NOT NULL CHECK (`engine` IN ('ai')), `run_id` text, `result` text NOT NULL, `checks` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `intake_bundle_reasonings_bundle_idx` ON `intake_bundle_reasonings` (`bundle_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `claim_damage_observations` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `evidence_id` text,
  `zone_id` text NOT NULL, `severity` integer NOT NULL CHECK (`severity` BETWEEN 0 AND 3), `confidence` real NOT NULL,
  `source` text NOT NULL CHECK (`source` IN ('ai_photo','estimate_text','owner')), `bundle_id` text, `run_id` text,
  `created_by` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_damage_obs_uq` ON `claim_damage_observations` (`claim_id`, coalesce(`evidence_id`, ''), `zone_id`, `source`, coalesce(`bundle_id`, ''));
--> statement-breakpoint
CREATE INDEX `claim_damage_obs_claim_idx` ON `claim_damage_observations` (`claim_id`, `created_at`);
--> statement-breakpoint
-- Per-file extras of an extraction: {engine:'ai'|'rules', documentDate, docSide, photo, segments, pdfMeta}.
ALTER TABLE `intake_extractions` ADD COLUMN `extras` text;
--> statement-breakpoint
-- Settings > Intake (merged over DEFAULT_INTAKE_SETTINGS on read).
ALTER TABLE `agent_settings` ADD COLUMN `intake` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE TRIGGER `intake_bundle_decisions_no_update` BEFORE UPDATE ON `intake_bundle_decisions`
BEGIN SELECT RAISE(ABORT, 'intake_bundle_decisions is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `intake_bundle_decisions_no_delete` BEFORE DELETE ON `intake_bundle_decisions`
BEGIN SELECT RAISE(ABORT, 'intake_bundle_decisions is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `intake_bundle_reasonings_no_update` BEFORE UPDATE ON `intake_bundle_reasonings`
BEGIN SELECT RAISE(ABORT, 'intake_bundle_reasonings is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `intake_bundle_reasonings_no_delete` BEFORE DELETE ON `intake_bundle_reasonings`
BEGIN SELECT RAISE(ABORT, 'intake_bundle_reasonings is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `claim_damage_obs_no_update` BEFORE UPDATE ON `claim_damage_observations`
BEGIN SELECT RAISE(ABORT, 'claim_damage_observations is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `claim_damage_obs_no_delete` BEFORE DELETE ON `claim_damage_observations`
BEGIN SELECT RAISE(ABORT, 'claim_damage_observations is append-only'); END;
```

Notes: `intake_items` is unchanged (no CHECK change: a ZIP container keeps status `skipped` with
`normalised.kind = 'archive'`; the UI labels it "Unpacked"). `intake_extractions` stays append-only (ADD COLUMN is
allowed; triggers block UPDATE/DELETE only). `corrections` is unchanged (its `source` CHECK already allows
`memory_item`, which is how intake corrections arrive, §6.12).

### 3.2 `packages/db/src/schema.ts`

Add `intakeBundles`, `intakeBundleFiles`, `intakeBundleDecisions`, `intakeBundleReasonings`,
`claimDamageObservations` (JSON columns `mode: 'json'`), `intakeExtractions.extras` (json, nullable) and
`agentSettings.intake` (json, `.notNull().default({})`, `$type<Partial<IntakeSettings>>()`), row/insert types.

### 3.3 Repo `packages/db/src/repos/intakeBundles.ts` (export from `repos/index.ts`)

```ts
export type BundleStatus = 'open'|'reading'|'reconciling'|'ready'|'needs_you'|'registering'|'registered'|'attached'|'cancelled';
export type BundleFileRole = 'document'|'pack'|'segment'|'attachment'|'archive'|'email';
export type BundleDecisionKind = /* the CHECK list above */;
export interface IntakeBundleRecord { id; name; status: BundleStatus; source: 'upload'|'folder'|'split'; folderKey?; parentBundleId?;
  splitFromGroup?; claimId?; outcome?: 'registered'|'attached'; revision: number; computedRevision?: number; computed?: unknown;
  reasoningStatus: 'none'|'queued'|'waiting_ai'|'done'|'failed'|'skipped'; reasoningFileset?: string; autoEligible: boolean;
  needsYouId?: string; error?: string; createdBy; createdAt; updatedAt; closedBy?; closedAt? }
export interface IntakeBundleFileRecord { id; bundleId; intakeItemId; evidenceId; parentFileId?; position: number; role: BundleFileRole;
  pageFrom?: number; pageTo?: number; phash?: string; facts?: unknown; filedEvidenceId?; filedClaimId?; filedKind?; filedAt?;
  addedBy; addedAt; updatedAt }
export interface IntakeBundleDecisionRecord { id; bundleId; revision: number; kind: BundleDecisionKind; subject?: string;
  before?: unknown; after?: unknown; note?: string; actor: string; runId?: string; at: string }

createIntakeBundle(db, {name, source, folderKey?, parentBundleId?, splitFromGroup?, createdBy, now}): IntakeBundleRecord
getIntakeBundle(db, id) / requireIntakeBundle(db, id)
listIntakeBundles(db, {status?: BundleStatus[], claimId?, limit?, offset?}): IntakeBundleRecord[]; countIntakeBundles(db, filter)
findOpenBundleByFolder(db, folderKey): IntakeBundleRecord | undefined          // lower() compare
updateIntakeBundle(db, id, patch: Partial<...>, now)                           // not for revision
bumpBundleRevision(db, id, now): number                                         // UPDATE … SET revision = revision + 1 RETURNING
casBundleStatus(db, id, from: BundleStatus[], to: BundleStatus, now): boolean  // compare-and-set (register lock)
addBundleFile(db, input): { file: IntakeBundleFileRecord; created: boolean }  // idempotent on (bundle, item)
listBundleFiles(db, bundleId): IntakeBundleFileRecord[]  (position order)
bundleFilesByItem(db, itemId): IntakeBundleFileRecord[]
updateBundleFile(db, id, patch, now)
appendBundleDecision(db, input): IntakeBundleDecisionRecord ; listBundleDecisions(db, bundleId, {sinceRevision?}): …
appendBundleReasoning(db, {bundleId, fileset, runId, result, checks, now}); latestBundleReasoning(db, bundleId, fileset?)
insertDamageObservation(db, input): { created: boolean }  (ON CONFLICT DO NOTHING) ; listDamageObservations(db, claimId)
bestIntakeExtraction(db, itemId): IntakeExtractionRecord | undefined   // in repos/intake.ts: latest engine 'ai' row, else latest row
```

`IntakeExtractionRecord` gains `extras?: unknown`; `appendIntakeExtraction` accepts `extras`. Existing callers of
`latestIntakeExtraction` that must prefer the AI row (`intake/pipeline.ts` `applyItem`, `intake/newClaimDraft.ts`,
`intake/views.ts`) switch to `bestIntakeExtraction` (a retry from `process` appends a newer **rules** row; it must
not displace the AI reading).

`repos/agentSettings.ts`: add section `'intake'` (audit action `intake.settings`), merged with `mergeIntakeSettings`
from `@ccguk/domain`.

---

## 4. Domain pure modules — `packages/domain/src/intake/smart/`

Pure, deterministic, no I/O, no clock reads (time passed in). Exported through `packages/domain/src/intake/index.ts`
(`export * from './smart/index.js'`). Each module has a `*.test.ts` next to it.

### 4.1 `types.ts` (contracts used by both the API and its view layer)

```ts
export const BUNDLE_FIELD_KEYS = [
  'client.name','client.dateOfBirth','client.address','client.phone','client.email','client.drivingLicenceNumber',
  'driver.name','driver.dateOfBirth','driver.address','driver.phone','driver.drivingLicenceNumber',
  'vehicle.registration','vehicle.vin','vehicle.make','vehicle.model','vehicle.colour','vehicle.firstRegistered',
  'clientInsurer.name','clientInsurer.policyNumber',
  'tp.name','tp.phone','tp.address','tp.registration','tp.make','tp.model','tp.insurerName','tp.policyNumber','tp.insurerRef',
  'accident.occurredAt','accident.location','accident.postcode','accident.circumstances','accident.policeAttended',
  'accident.policeReference','accident.injuries','accident.driveable',
  'hire.needed','repairer.name','repairer.phone','engineer.name','engineer.reference',
] as const;
export type BundleFieldKey = (typeof BUNDLE_FIELD_KEYS)[number];

/** BundleFieldKey ↔ FieldTarget (null = bundle-only key, used at register through CreateClaimBody / parties). */
export const BUNDLE_KEY_TARGET: Readonly<Record<BundleFieldKey, FieldTarget | null>>;
/** Inverse for per-file extractions: FieldTarget → BundleFieldKey (claimant/client both → client.*). */
export function bundleKeyForTarget(t: FieldTarget): BundleFieldKey | null;

export const KEY_FIELDS: readonly BundleFieldKey[] = ['client.name','vehicle.registration','accident.occurredAt',
  'accident.location','accident.circumstances','tp.registration'];   // + one of client.phone / client.email
export const SENSITIVE_BUNDLE_KEYS: ReadonlySet<BundleFieldKey>;    // DOB, licence numbers, policy numbers, injuries, circumstances

export type CandidateEngine = 'ai' | 'rules' | 'exif' | 'plate' | 'owner' | 'name_hint' | 'ai_reasoning';
export interface FieldSource { fileId: string; itemId: string; evidenceId: string; filename: string; docType: DocType | null;
  page: number | null; quote: string | null; confidence: number; engine: CandidateEngine; rank: number; label: string /* "V5C, page 1" */ }
export interface Candidate { key: BundleFieldKey; value: string /* normalised by the API */; display: string; source: FieldSource;
  validatorOk: boolean; validatorMessage: string | null }

export type GroupKind = 'main' | 'new_case' | 'existing_claim' | 'unsure' | 'excluded';
export type GroupReasonCode = 'shared_ccg_ref'|'shared_vin'|'shared_vrm'|'shared_insurer_ref'|'shared_policy'|'shared_licence'
  |'shared_name_dob'|'shared_phone'|'shared_email'|'shared_postcode'|'shared_accident_date'|'same_file_on_claim'|'plate_in_photo'
  |'photo_date_near_accident'|'attachment_of'|'segment_of'|'only_case_in_upload'|'name_hint'|'moved_by_owner'|'no_identifiers'
  |'conflicting_identifiers'|'matches_claim'|'possible_claim_match';
export interface GroupReason { code: GroupReasonCode; text: string; fileId?: string; key?: string }

export type DraftFieldStatus = 'ok' | 'low_confidence' | 'conflict' | 'missing' | 'owner_set' | 'invalid';
export type TimelineClass = 'record' | 'clock' | 'owner_only';
export type RiskSeverity = 'info' | 'warn';
export type RiskSignalCode = 'PHOTO_BEFORE_ACCIDENT'|'PHOTO_LONG_AFTER'|'PHOTO_GPS_OUTLIER'|'PHOTO_EDITED_SOFTWARE'|'PHOTO_ON_OTHER_CLAIM'
  |'PLATE_NOT_ON_CASE'|'DOC_DATED_BEFORE_ACCIDENT'|'KEEPER_AFTER_ACCIDENT'|'INSURANCE_NOT_IN_FORCE'|'LICENCE_EXPIRED'
  |'MOT_EXPIRED'|'ACCIDENT_IN_FUTURE'|'VEHICLE_ON_OTHER_CLAIM'|'FLEET_VEHICLE_AS_CLIENT'|'CONTACT_ON_OTHER_CLAIM'
  |'DUPLICATE_CLAIMANT'|'PDF_EDITED_AFTER_CREATION'|'PDF_EDITOR_PRODUCER'|'PDF_INCREMENTAL_UPDATES'|'FILE_TYPE_MISMATCH'
  |'INSTRUCTIONS_IN_DOCUMENT';
export type CaseKind = 'non_fault_credit_hire' | 'non_fault_repair_only' | 'total_loss' | 'untraced' | 'unknown';
export type PhotoScene = 'damage'|'vehicle_whole'|'number_plate'|'document'|'scene'|'other';   // re-exported by photo.ts
```

The full view interfaces (`DraftField`, `Conflict`, `BundleGroup`, `ChecklistItem`, `TimelineProposal`, `RiskSignal`,
`BundleComputed`) are the JSON shapes of §8 and are declared here once (API returns them as-is).

### 4.2 `classify.ts` — deterministic document classifier

`classifyText(text: string, opts: { filename: string; fingerprintTemplateId: string | null; isEmail: boolean; isImage: boolean; insurerNames: string[] }):
{ docType: DocType; confidence: number; scores: Partial<Record<DocType, number>> }`

Weighted phrase/regex table per `DocType` (case-insensitive, whole-word; weights 1–5), e.g.
`v5c`: "V5C" 5, "registration certificate" 4, "registered keeper" 3, "DVLA" 1; `driving_licence`: DVLA licence-number
regex `\b[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}\b` 5, "DRIVING LICENCE" 4; `insurance_certificate`: "certificate of motor
insurance" 5, "persons or classes of persons entitled to drive" 4; `police_report`: "collision report|incident report"
3, "police" 2, "crime reference|incident number|CAD" 3; `fnol_form`: "accident report|claim form|details of the
accident" 4; `insurer_letter`: "our ref|your ref" 2, "dear" 1, "liability" 2, an insurer name from `opts.insurerNames`
(the API passes the insurer directory names) 3; `engineer_report`:
"engineer'?s report|assessment report|pre-accident value|repair method" 4; `bodyshop_estimate`: "estimate|labour|paint
& materials|parts" 3 + "VAT|total" 1; `audatex_estimate`: "audatex|audaenterprise" 5; `invoice`: "invoice (no|number)|amount
due" 4; `bank_statement`: "sort code" 3 + "balance" 2; `payslip`: "payslip|gross pay|NI number" 4; `mot_certificate`:
"MOT test certificate|VT20" 5; `witness_statement`: "witness statement|statement of truth" 4; `proof_of_address`:
"council tax|utility bill|electricity|gas bill" 3; `signed_ccguk_form`: fingerprint present 6. Email → `correspondence`
unless another type scores ≥ 6. Images with no text → `vehicle_photo_other` at 0.3 (the AI decides photos).
Confidence = top / (top + second + 2), capped at **0.85** (rules never reach the 0.9 auto-apply line on their own).

`DocType` gains `'witness_statement'` and `'proof_of_address'` (`agents/types.ts`, `DOC_TYPES`); labels in
`intake/proposals.ts` `DOC_TYPE_LABELS`.

### 4.3 `ruleExtract.ts` — deterministic field reading

`ruleExtract(pages: string[], docType: DocType, opts: { insurerNames: string[] }): ExtractedField[]` (same
`ExtractedField` shape as the AI, `target` from the existing union or `null`, `name` the label matched, `page`,
`quote` = the matched line, confidence 0.6 bare pattern / 0.8 label + valid pattern, never above 0.85). Patterns:
VRM (current, prefix, suffix, dateless — reuse `isValidRegistrationLocal`/`normaliseRegistrationLocal`), VIN
`\b[A-HJ-NPR-Z0-9]{17}\b`, DVLA licence number, UK postcode, UK phone, email, dates near labels ("date of birth",
"date of accident|incident|loss", "date of first registration", "valid from/until", "expiry"), "Registered keeper:",
"Policyholder:", "Name:", "Our ref:/Your ref:/Claim (no|number|ref):", "Policy (no|number):", police "reference|incident
no|crime no|CAD", CCG references `CCG-\d{4}-\d{5}`, sort code `\d{2}-\d{2}-\d{2}` + account `\b\d{8}\b` (as target `null`,
name "Sort code"/"Account number" — bank details are never applied, only used for a signal), "Witness(es): none|no".
Role assignment by doc type: on `v5c`/`driving_licence`/`insurance_certificate` the person is `client`; on
`insurer_letter` from the other side, "your client" → `client`, "our policyholder|our insured" → `third_party`.

Fields that map to bundle-only keys are returned with `target: null` and a stable `name` from
`RULE_FIELD_NAMES` (e.g. `"Police reference"`, `"Insurer name"`, `"Accident postcode"`, `"Witnesses"`,
`"Vehicle driveable"`), which `candidates.ts` maps to `BundleFieldKey` (§6.4). The AI uses the same names (prompt
lists them).

### 4.4 `keys.ts` — identity keys per file (for grouping and matching)

```ts
export type KeyKind = 'ccg_ref'|'vin'|'vrm'|'insurer_ref'|'policy'|'licence'|'name_dob'|'name'|'postcode'|'phone'|'email'
  |'accident_date'|'police_ref'|'sha_on_claim'|'plate';
export type KeyStrength = 'strong'|'medium'|'weak';
export interface FileKey { kind: KeyKind; value: string /* normalised */; strength: KeyStrength; role: 'client'|'third_party'|'unknown'; source: CandidateEngine | 'sha' }
export interface FileKeys { fileId: string; position: number; parentFileId: string | null; role: BundleFileRole; isPhoto: boolean;
  takenAt: string | null; keys: FileKey[] }
export const KEY_STRENGTH: Record<KeyKind, KeyStrength> = { ccg_ref:'strong', vin:'strong', insurer_ref:'strong', licence:'strong',
  name_dob:'strong', police_ref:'strong', sha_on_claim:'strong', vrm:'medium', plate:'medium', policy:'medium', phone:'medium',
  email:'medium', name:'weak', postcode:'weak', accident_date:'weak' };
export function keysFromCandidates(fileId: string, candidates: Candidate[], extra: { shaOnClaims: string[]; plates: string[];
  takenAt: string | null }, stop: StopList): FileKeys;
export interface StopList { vrms: string[]; policies: string[]; phones: string[]; emails: string[]; emailDomains: string[]; postcodes: string[]; names: string[] }
```

The **stop list** removes identifiers that appear across many cases: the company's own name/office postcode/phone/
email/bank (from `settings`), fleet-unit VRMs and fleet policy numbers (from the fleet tables), the mail account
address, and phone/email lines on an insurer's letterhead (values on `insurer_letter`/`correspondence` files are
downgraded to `weak` unless their label says client/policyholder). Built by the API (`bundles/claimIndex.ts`), passed in.

### 4.5 `group.ts` — mixed-upload sorting (improvement 1)

```ts
export interface ClaimKeyIndex { claims: Array<{ claimId: string; reference: string; clientName: string | null; status: string;
  keys: Array<{ kind: KeyKind; value: string }> }> }
export interface GroupingInput { files: FileKeys[]; index: ClaimKeyIndex; nameHint: string; pins: Record<string /*fileId*/, string /*groupKey*/>;
  excluded: string[]; accidentDates: Record<string /*clusterSeed*/, string> }
export interface GroupingResult { groups: BundleGroupComputed[]; fileGroup: Record<string, string>; warnings: string[] }
export function groupFiles(input: GroupingInput): GroupingResult;
```

Algorithm (deterministic, file order = `position`):

1. **Edges.** Two files are linked when they share ≥1 strong key, or ≥2 medium keys, or 1 medium + ≥2 weak keys
   (same kind+value). A child (EML attachment, ZIP entry) gets a medium edge to its parent; a segment gets a medium
   edge to its pack; an EML attachment with a strong key that contradicts its parent's strong key of the same kind and
   role (two different client VINs) loses the parent edge. Union-find → clusters.
2. **Contradictions.** A cluster with two different `name_dob` (role client) or two different `vin` (role client)
   gets warning `conflicting_identifiers` ("these files may be two cases") — not auto-split.
3. **Existing claims.** Score each cluster against each indexed claim: strong 10, medium 4, weak 1 per shared key
   (`sha_on_claim` counts strong). Best ≥ 10 and ≥ 2× the second → group `claim:<id>` (`matches_claim`); best in
   [5, 10) → stays a new case with reason `possible_claim_match` naming the claim.
4. **Unkeyed files** (photos with no plate, files with no identifiers): exactly one non-claim cluster → join it
   (`only_case_in_upload`); else photo `takenAt` within ±2 days of one cluster's accident date → join
   (`photo_date_near_accident`); else `unsure` (`no_identifiers`).
5. **Main group.** Score clusters by the bundle name hint (tokens matched against client name +3 each, vehicle
   make/model +2, VRM +5); highest wins; ties → most non-photo documents, then earliest position. A cluster matched to
   an existing claim can be main (then the register panel says "This looks like CCG-…" and the owner must confirm new
   or attach — blocker `MATCHES_EXISTING_CLAIM`, §6.7).
6. **Labels/keys.** Main → `main` ("This case"); other new clusters → `case:B`, `case:C` … by earliest file
   (label "New case B — <client name or VRM>", `suggestedName` = client name + VRM); claims → reference + client name.
7. **Pins** (owner moves) override everything for that file (`moved_by_owner`); `excluded` files → `excluded`.

Each group carries `reasons[]` (first 5, plain words: "Same VIN WVW…001 as the V5C", "Insurer reference
TPI/778812 is on CCG-2026-00031"), `confidence` (min(1, score/20)) and `fileIds`.

### 4.6 `ranking.ts` — source ranking (improvement 2)

`sourceRank(key: BundleFieldKey, docType: DocType | null, engine: CandidateEngine): number` (0–100), from a table
`SOURCE_RANKS` (excerpt — the module holds every key; default for unlisted doc types 30, photos/EXIF 20, name hint 10,
owner 1000):

| Key | Ranking (high → low) |
|---|---|
| `vehicle.vin` | v5c 100 · engineer_report 85 · audatex_estimate 80 · bodyshop_estimate 75 · mot_certificate 70 · insurance_certificate 60 · photo (VIN plate, AI) 50 · fnol/signed form 40 · letters 30 |
| `vehicle.registration` | v5c 100 · insurance_certificate 90 · mot_certificate 85 · engineer_report 80 · estimates 75 · police_report 70 · fnol/signed form 60 · photo plate 50 · letters 50 |
| `vehicle.make/model/colour/firstRegistered` | v5c 100 · engineer_report 80 · estimates 75 · mot 70 · insurance 60 · fnol 40 |
| `client.dateOfBirth`, `*.drivingLicenceNumber` | driving_licence 100 · insurance_certificate 70 · signed_ccguk_form 60 · fnol_form 50 · other 30 |
| `client.name` | driving_licence 95 · insurance_certificate 85 · v5c 80 (keeper may differ) · signed_ccguk_form 80 · fnol_form 70 · letters 40 · name hint 10 |
| `client.address` | proof_of_address 95 · driving_licence 85 · v5c 80 · insurance_certificate 75 · fnol 60 · letters 50 |
| `client.phone/email` | signed_ccguk_form 90 · fnol_form 85 · email From header of the client 80 · letters 40 |
| `accident.occurredAt` | police_report 100 · fnol_form 90 · signed_ccguk_form 88 · insurer_letter 70 · engineer_report 60 · estimates 40 · correspondence 40 · photo EXIF 20 (date only) |
| `accident.location/postcode` | police_report 100 · fnol 90 · signed form 88 · insurer_letter 60 · photo GPS 30 |
| `accident.circumstances` | client-authored fnol_form / signed_ccguk_form 100 · witness_statement 60 · police_report 70 · insurer_letter 30 |
| `tp.*` (name, registration, make/model) | police_report 95 · insurer_letter 90 · fnol/signed form 70 · photos 40 |
| `tp.insurerName/policyNumber/insurerRef` | insurer_letter 100 · correspondence 80 · police_report 70 · fnol 60 |
| `accident.policeReference/policeAttended` | police_report 100 · fnol 70 · letters 60 |

Engine factor: `ai` and `rules` from the same file → AI first (ties broken by engine order `owner > ai > ai_reasoning >
rules > plate > exif > name_hint`). Explanation strings: `rankWhy(key, winner, loser)` → "The V5C outranks the
bodyshop estimate for the VIN".

### 4.7 `compat.ts` — when two readings are "the same"

`compatible(key, a: Candidate, b: Candidate): { same: boolean; prefer?: 'a'|'b'; why?: string }`:
exact normalised equality; names: same surname and initials consistent ("J Doe" ⊂ "Jane Doe" → prefer fuller);
addresses: same postcode and one's lines ⊂ other's; dates vs datetimes on the same London day → prefer datetime;
VRM/VIN: normalised equality only (one character different is a **conflict**, never compatible); phone: same
`normalisePhone`; make/model: case-insensitive, model prefix ("Corsa" vs "Corsa SE") → prefer longer.

### 4.8 `reconcile.ts` — one draft from many readings

```ts
export interface ReconcileInput { candidates: Candidate[]; decisions: DecisionView[]; minConflictConfidence: number /* 0.5 */;
  lowConfidence: number /* 0.75 */ }
export interface ReconcileResult { fields: DraftField[]; conflicts: Conflict[]; witnesses: WitnessDraft[] }
export function reconcile(input: ReconcileInput): ReconcileResult;
```

Per key: drop invalid candidates into `alternatives` (status `invalid` if nothing valid); cluster candidates by
`compatible`; each cluster's best source = highest (rank, engine order, confidence); the winning cluster = highest
best-source rank; **conflict** when ≥2 clusters each have a candidate with confidence ≥ 0.5 → `Conflict{ id:'c:'+key,
options (each with value, sources, rank, preselected = winner), why = rankWhy }`; field `status`: owner decision
(`set_field`) → `owner_set` (owner value wins, other readings kept as alternatives, conflict auto-resolved with
`resolvedBy` the owner); `choose_conflict` / `accept_preselected` → resolved with the chosen value; open conflict →
`conflict` (value = preselected, **not** final); confidence < 0.75 → `low_confidence`; none → `missing`. Witnesses:
list merged by `normalisePersonName`; `witnessesAnswered` true when any client-authored document states witnesses
(names or "none").

### 4.9 `checklist.ts` — missing documents (improvement 4)

```ts
export function caseKindOf(d: { hireNeeded: boolean | null; totalLoss: boolean; repair: boolean; tpRegistrationUnknown: boolean }): CaseKind;
export interface ChecklistInput { caseKind: CaseKind; files: Array<{ fileId: string; docType: DocType | null; docSide: 'front'|'back'|null;
  formTemplateId: string | null; scene: PhotoScene | null; excluded: boolean }>; fields: Record<BundleFieldKey, string | null>;
  witnesses: number; accidentDate: string | null; firstRegistered: string | null; policeAttended: boolean | null }
export function buildChecklist(input: ChecklistInput): ChecklistItem[];
export function requestEmailText(items: ChecklistItem[], clientFirstName: string | null, reference: string | null): { subject: string; body: string };
```

Items (id · label · applies when · satisfied by):

| id | Label | Applies | Satisfied by |
|---|---|---|---|
| `v5c` | V5C (logbook) for the client's car | always | `v5c` |
| `licence_front` / `licence_back` | Driving licence, front / back (the driver's) | always | `driving_licence` with `docSide` front / back (unknown side counts as front, back stays `partial`) |
| `insurance_certificate` | Client's insurance certificate | always | `insurance_certificate` |
| `damage_photos` | Photos of the damage (at least 4, one showing the number plate) | always | photos with scene `damage`; `partial` 1–3 or no plate visible |
| `tp_details` | Other side's details (registration and insurer or name + phone) | not untraced | fields `tp.registration` + (`tp.insurerName`/`tp.policyNumber` or `tp.name`+`tp.phone`) |
| `accident_account` | Client's own account of the accident | always | client-authored `fnol_form` / `signed_ccguk_form` (`form.ccguk_09_accident_report`); else "take it on the call" |
| `estimate_or_report` | Repair estimate or engineer's report | repair or total loss | `bodyshop_estimate`, `audatex_estimate`, `engineer_report` |
| `bank_details` | Bank details for payment (payment direction form or statement header) | always | `form.ccguk_05_payment_direction`, `bank_statement` |
| `signed_hire_docs` | Signed hire paperwork (letter of authority, credit hire agreement) | hire needed | `signed_ccguk_form` with `agreement.ccguk_01_customer_loa` and `agreement.ccguk_03_credit_hire` (`partial` if one) |
| `police_report` | Police report / reference | police attended or untraced | `police_report` or field `accident.policeReference` |
| `mot_certificate` | MOT certificate | vehicle first registered > 3 years before the accident | `mot_certificate` |
| `witness_statements` | Witness statements | witnesses listed | `witness_statement` / `statement.ccguk_04_witness` (partial when fewer than witnesses) |
| `proof_of_address` | Proof of address | licence and V5C addresses differ | `proof_of_address` |

`requestEmailText` builds a short plain-English request (greeting, "to deal with your claim we still need:", one
bullet per missing/partial item with what is acceptable, "reply to this email with photos or scans", sign-off left to
the mail signature). No figures, no advice about insurers' offers (copy guard, §15).

### 4.10 `timeline.ts` — chronology proposals (improvement 8)

```ts
export const TIMELINE_EVENT_CLASS: Readonly<Partial<Record<EventType, TimelineClass>>> = {
  letter_in:'record', email_in:'record', note:'record', inspection:'record', engineer_instructed:'record', recovery:'record',
  vehicle_collected:'record', estimate_received:'clock', handling_ref_received:'clock', storage_started:'clock',
  intervention_offer:'owner_only', pav_offer_received:'owner_only', settlement_offer_received:'owner_only', part36_received:'owner_only',
  report_issued:'owner_only', hire_started:'owner_only', hire_ended:'owner_only', payment_received:'owner_only',
  total_loss_confirmed:'owner_only', defence_received:'owner_only', final_response_received:'owner_only' };
export interface TimelineInput { files: Array<{ fileId; docType; documentDate: string | null; emailDate: string | null; from: string | null;
  subject: string | null; facts: { insurerName?: string; policeRef?: string; inspectionDate?: string; offerFound?: boolean } }>;
  aiItems: AiTimelineItem[]; accidentAt: string | null; ticks: Record<string, boolean>; minAutoTick: number /* 0.8 */ }
export function proposeTimeline(input: TimelineInput): TimelineProposal[];
```

Rules: `insurer_letter` → `letter_in` "Letter from <insurer>" at `documentDate`; the first letter carrying a new
`tp.insurerRef` from the at-fault insurer → `handling_ref_received` (clock); `.eml` → `email_in` at the Date header
("Email from <from>: <subject>"); `police_report` → `note` "Police report <ref>"; `engineer_report` → `note` "Engineer
report dated …" (+ `inspection` when an inspection date is read); estimates → `estimate_received`; recovery invoice →
`recovery`; storage invoice → `storage_started`; a letter whose AI reading or rules say an offer/payment/settlement is
made → the matching `owner_only` type (never ticked; the UI says "Record it in Offers yourself"). AI timeline items are
merged (same type + same London day + same file = one). Ids: `t:` + sha1(type|day|fileId) first 12 hex. Default
`ticked`: class `record`/`clock`, confidence ≥ 0.8, date not before the accident −1 day (documents dated before the
accident are flagged and unticked); owner ticks override. The accident itself is not proposed (POST /claims writes the
`fnol` event).

### 4.11 `signals.ts` — risk signals (improvement 9)

```ts
export interface SignalsInput { accidentAt: string | null; accidentDay: string | null; photos: Array<{ fileId; takenAt: string | null; gps: {lat:number;lon:number} | null;
  software: string | null; plates: string[]; scene: PhotoScene | null; onOtherClaims: Array<{ claimId; reference; how: 'same_file'|'near_same_photo' }> }>;
  documents: Array<{ fileId; docType; documentDate: string | null; validFrom?: string; validTo?: string; keeperSince?: string;
  pdfMeta?: PdfMeta | null; extensionMatches: boolean; injection: boolean }>; clientVrm: string | null; tpVrm: string | null;
  otherClaims: { vehicle: Array<{ claimId; reference; how: 'registration'|'vin'; open: boolean }>; fleetUnit: boolean;
  contacts: Array<{ claimId; reference; field: 'phone'|'email'|'address'|'bank'; open: boolean }>;
  claimant: Array<{ claimId; reference; how: 'licence'|'name_dob'; open: boolean; daysApart: number | null }> };
  settings: { beforeAccidentToleranceHours: number; gpsOutlierKm: number }; acks: Record<string, { by: string; note: string | null }> }
export function riskSignals(input: SignalsInput): RiskSignal[];
export const SIGNAL_TEXT: Readonly<Record<RiskSignalCode, { title: string; severity: RiskSeverity; template: string }>>;
```

| Code | Severity | Rule | Owner-facing wording (neutral, always with the innocent explanation) |
|---|---|---|---|
| `PHOTO_BEFORE_ACCIDENT` | warn | EXIF taken > tolerance (2 h) before `accidentAt` | "Photo taken on {date}, before the accident date. Camera clocks are often wrong — worth checking with the client." |
| `PHOTO_LONG_AFTER` | info | > 30 days after | "May show the car's later condition." |
| `PHOTO_GPS_OUTLIER` | info | ≥ 3 photos with GPS and this one > 2 km from their median (and coordinates in the documents, when present) | "Taken about {km} km from the other photos." |
| `PHOTO_EDITED_SOFTWARE` | info | EXIF Software matches editor list (Photoshop, Snapseed, Lightroom, PicsArt, GIMP) | "Saved by {software}; editing apps also just resize photos." |
| `PHOTO_ON_OTHER_CLAIM` | warn | same sha256 (`alsoOnClaims`) or pHash distance ≤ 6 to a photo filed on another claim | "The same photo is on {ref}." |
| `PLATE_NOT_ON_CASE` | warn | a damage photo's plate is neither the client's nor the TP's registration | "Plate {vrm} in this photo is not a registration on this case." |
| `DOC_DATED_BEFORE_ACCIDENT` | warn | letter/estimate/report/police/hire document dated > 1 day before the accident | "{doc} is dated {date}, before the accident on {accident}." |
| `KEEPER_AFTER_ACCIDENT` | warn | V5C acquisition/keeper-since date after the accident | "The V5C shows the client as keeper from {date}." |
| `INSURANCE_NOT_IN_FORCE` | warn | certificate period does not cover the accident date | "The certificate covers {from}–{to}." |
| `LICENCE_EXPIRED` | warn | licence photocard expiry (4b) before the accident | "The photocard expired on {date} (the entitlement may still be valid)." |
| `MOT_EXPIRED` | info | MOT expiry before the accident on a car > 3 years old | "MOT expired on {date}." |
| `ACCIDENT_IN_FUTURE` | warn | accident date after the newest upload | "The accident date is after the documents were received." |
| `VEHICLE_ON_OTHER_CLAIM` | warn (open) / info | client VRM/VIN on another claim (`crossFileRegistrationCheck`, `vinElsewhere`) | "This car is also on {ref} ({status})." |
| `FLEET_VEHICLE_AS_CLIENT` | warn | client VRM is one of our fleet units | "This registration is one of our own fleet cars." |
| `CONTACT_ON_OTHER_CLAIM` | warn (open) / info | phone/email/address/bank of the client on another claim's party (`findConnections`, insurers/companies excluded) | "Same {field} as a party on {ref}." |
| `DUPLICATE_CLAIMANT` | warn (open claim within 30 days) / info | `personMatch` licence / name+DOB with a claimant on another claim | "The client also has {ref} ({status})." |
| `PDF_EDITED_AFTER_CREATION` | info | ModDate − CreationDate > 1 day | "Modified {n} days after it was created — normal for many offices." |
| `PDF_EDITOR_PRODUCER` | info | Producer/Creator matches an editor list (Acrobat edit, iLovePDF, Sejda, PDFescape, Smallpdf, PDF-XChange) | "Last saved with {producer}." |
| `PDF_INCREMENTAL_UPDATES` | info | > 1 `%%EOF` marker (incremental saves) | "Saved {n} times after it was first made." |
| `FILE_TYPE_MISMATCH` | info | `extensionMatches === false` | "Named .{ext} but is a {kind}." |
| `INSTRUCTIONS_IN_DOCUMENT` | warn | AI `injectionSuspected` or `injectionFlags(text)` | "Contains text aimed at an AI; it was treated as data only." |

Ids: `s:` + sha1(code|sorted fileIds|subject). Acknowledged signals stay listed (greyed) with the owner's note.
Wording rule (enforced by a test in domain and api): no message, title or template matches
`/fraud|fraudulent|fake|forg|dishonest|\blie\b|lying|scam|suspicious|staged/i`.

### 4.12 `phash.ts` — perceptual hash (improvement 5)

`toGray(rgba: Uint8Array, w: number, h: number): Uint8Array`; `areaResize(gray, w, h, tw, th): Uint8Array`;
`dHash64(gray, w, h): string` (resize to 9×8, compare horizontal neighbours → 64 bits → 16 hex chars);
`hamming(a: string, b: string): number`. Tests: identical → 0; resized/recompressed synthetic image ≤ 6;
different images > 20.

### 4.13 `duplicates.ts`

```ts
export interface DupInput { files: Array<{ fileId; position; sha256; textSha256: string | null; text: string | null; phash: string | null;
  pixels: number | null; role: BundleFileRole; parentFileId: string | null }>; nearMaxDistance: number; shingleMin: number /* 0.9 */ }
export interface DupResult { links: Array<{ fileId; of: string; kind: 'same_file'|'same_text'|'near_photo'|'near_text'; similarity: number }> }
export function findDuplicates(input: DupInput): DupResult;
```

Same sha256 (e.g. a photo also inside the ZIP) → `same_file`; same `textSha256` → `same_text` (same letter re-saved);
pHash ≤ distance → `near_photo` (primary = most pixels, then earliest); 5-word shingle Jaccard ≥ 0.9 on texts > 400
chars → `near_text`. Primary is the earliest top-level file unless another has more pixels (photos). Duplicates are
**linked**: shown under their primary, excluded from grouping keys (they inherit the primary's group), from
candidates (no double counting), from the checklist count and from filing (§6.8).

### 4.14 `split.ts` — scanned-pack splitting (improvement 6)

```ts
export interface PageSignal { index: number /* 1-based */; chars: number; text: string; widthPt: number; heightPt: number;
  topType: DocType | null; topScore: number; secondScore: number; pageOfTotal: { n: number; m: number } | null; headerKey: string }
export interface Segment { fromPage: number; toPage: number; docType: DocType; confidence: number; title: string; why: string }
export function splitPages(pages: PageSignal[], opts: { minPages: number; minMargin: number /* 2 */ }): Segment[];
export function validateSegments(segs: Segment[], pageCount: number): Segment[] | null;   // for AI segments
```

Start a new segment when: "Page 1 of M" (or the previous segment reached its M); the top type changes with margin ≥
`minMargin` and the header line changes; the page size changes (A4 ↔ smaller, e.g. a licence scan); a blank page
(chars = 0 in a text PDF) separates documents (blank pages are dropped). Adjacent segments of the same type without an
explicit break merge. Result with < 2 segments → `[]` (not a pack). AI segments (scanned PDFs, §5.4) must be
contiguous, non-overlapping, cover 1..N, ≥ 2 segments, else rejected.

### 4.15 `photo.ts` — photo intelligence (improvement 7)

```ts
export function plateMatches(plates: string[], vrms: { client: string | null; tp: string | null }): Array<{ text; normalised; matches: 'client'|'third_party'|null }>;
export function distanceKm(a: {lat;lon}, b: {lat;lon}): number;                     // haversine
export function gpsOutliers(points: Array<{ fileId; lat; lon }>, km: number): string[];
export function zonesFromEstimateText(lines: string[], body?: VehicleBodyType): Array<{ zoneId: string; severity: 1|2|3; line: string }>;
// uses zoneForPanelName; operation words → severity: repair/paint/blend 1, replace 2, structural/chassis/airbag 3
export function damageMapFromObservations(obs: Array<{ zoneId; severity; confidence; source; createdAt }>):
  Record<string, { severity: 0|1|2|3; confidence: number; source: 'ai'; evidenceIds: string[] }>;   // owner rows win, then max severity
```

### 4.16 `registrable.ts` — can it be registered? automatically?

```ts
export interface RegistrableInput { filesInProgress: number; conflictsOpen: number; missingKey: BundleFieldKey[]; lowKey: BundleFieldKey[];
  contactMissing: boolean; fnolErrors: string[]; fnolWarnings: string[]; mainMatchesClaim: { reference: string } | null; confirmedNew: boolean;
  signalsWarn: number; signalsOpen: number; unsureFiles: number; otherGroups: number; reasoningDone: boolean; injection: boolean;
  duplicateOpenClaim: boolean; settingOn: boolean; minConfidence: number; policy: { outcome: 'auto'|'auto_held'|'ask'|'deny'; reasons: string[] } }
export interface Blocker { code: string; text: string; for: 'owner'|'auto' }
export function registrable(i: RegistrableInput): { canRegister: boolean; autoEligible: boolean; blockers: Blocker[] };
```

Owner blockers: `FILES_IN_PROGRESS` (a file still `queued|normalising|splitting`; files waiting only for the AI do not
block), `OPEN_CONFLICTS`, `MISSING_REQUIRED` (key fields missing / invalid; witnesses with blank relationship),
`FNOL_INCOMPLETE` (the FNOL validation errors of the body that would be sent, §6.7), `MATCHES_EXISTING_CLAIM`
(unless `confirm_new`). Auto blockers (in addition): `SETTING_OFF`, `AI_REASONING_NOT_DONE`, `LOW_CONFIDENCE` (any key
field below `minConfidence`, or no contact), `SIGNALS_PRESENT` (any unacknowledged signal of any severity),
`UNSURE_FILES`, `OTHER_GROUPS_PRESENT`, `INSTRUCTIONS_IN_DOCUMENT`, `DUPLICATE_OPEN_CLAIM`, `POLICY_ASKS` (`decide()`
not `auto`, with its reasons), `FNOL_WARNINGS_NEED_CALL` is **not** a blocker (takenCold / disclosure warnings are
expected for a document-led claim; they show in the brief as the call to make).

### 4.17 `briefText.ts`, `settings.ts`

`caseSummaryTemplate(d): string` — 3–6 plain sentences from draft values only ("Jane Doe's blue Vauxhall Corsa
(KX21 ABC) was hit by LM19 XYZ at … on 7 October 2026. The other driver is insured by …; their reference is ….
The car is not driveable and Jane needs a replacement car. Police attended (ref …). 2 documents are still needed.").
`verifySummary(text, draftValues): boolean` — every VRM, date, money figure and reference in an AI summary must appear
in the draft values, else the template is used.

```ts
export interface IntakeSettings {
  bundles: { autoRegister: boolean; autoRegisterMinConfidence: number; prepareMissingDocsRequest: boolean; quietSeconds: number;
    folderBundles: boolean; aiReasoningRunsPerBundlePerDay: number };
  split: { enabled: boolean; minPages: number };
  duplicates: { nearPhotoMaxDistance: number; nearTextMinJaccard: number };
  photos: { beforeAccidentToleranceHours: number; gpsOutlierKm: number };
  archives: { maxEntries: number; maxTotalBytes: number; maxDepth: number; maxRatio: number };
}
export const DEFAULT_INTAKE_SETTINGS: IntakeSettings = {
  bundles: { autoRegister: false, autoRegisterMinConfidence: 0.9, prepareMissingDocsRequest: true, quietSeconds: 20, folderBundles: true, aiReasoningRunsPerBundlePerDay: 3 },
  split: { enabled: true, minPages: 2 },
  duplicates: { nearPhotoMaxDistance: 6, nearTextMinJaccard: 0.9 },
  photos: { beforeAccidentToleranceHours: 2, gpsOutlierKm: 2 },
  archives: { maxEntries: 200, maxTotalBytes: 2 * 1024 ** 3, maxDepth: 2, maxRatio: 200 },
};
export function mergeIntakeSettings(stored: unknown): IntakeSettings;   // clamps: minConfidence 0.8..1, quietSeconds 0..600, …
```

---

## 5. Per-file pipeline changes (`apps/api/src/intake/`)

### 5.1 Extraction contract (domain `agents/results.ts`, `agents/types.ts`)

`IntakeExtraction` gains four required properties (strict schema: every property required; values may be null/empty):

```ts
documentDate: string | null;                     // the date printed on the document (letter date, report date), ISO date
docSide: 'front' | 'back' | null;                // licences / cards
photo: { scene: PhotoScene; plates: Array<{ text: string; confidence: number }>;
         damageZones: Array<{ zoneId: string; severity: number /* 1..3 */; confidence: number }>; notes: string | null } | null;
segments: Array<{ fromPage: number; toPage: number; docType: DocType; confidence: number; title: string }>;  // [] unless several documents
```

`INTAKE_EXTRACTION_SCHEMA` extended accordingly (`anyOf [object, null]` for `photo`; `zoneId` is a plain string — the
brief lists the allowed ids; code drops ids failing `isZoneId`). Stays far below `MAX_RESULT_SCHEMA_BYTES` (today
2.5 KB of 16 KB). The zod twin is generated (`ai/strictSchema.ts`), nothing to hand-write.

`FieldTarget` (`ClaimFieldTarget`) gains: `'claim.accident.circumstances' | 'claim.accident.postcode' |
'claim.accident.policeReference' | 'claim.accident.injuries' | 'claim.atFaultInsurerName' | 'claim.clientInsurerName'
| 'claim.clientPolicyNumber'`. `SENSITIVE_FIELD_TARGETS` adds `circumstances`, `injuries`, `clientPolicyNumber`.
`intake/targets.ts` defines each: read current value from the claim / its insurer parties; validators (free text ≤
4000, UK postcode, reference ≤ 60, boolean `yes|no|true|false`, insurer name ≤ 120); apply through existing routes
(`PATCH /claims/:id {accident:{…}}`, `{clientPolicyNumber}`; insurer names: find the insurer party by directory match
or `POST /parties {kind:'company', roles:['insurer']}` then `PATCH /claims/:id {atFaultInsurerId|clientInsurerId}` — the
same "create then link" builder chain already used for third parties). `intake/newClaimDraft.ts` `PATHS` adds the new
targets (accident.postcode/policeReference/circumstances; thirdParty.insurerName; clientInsurer.name/policyNumber).

**Every existing fixture** with `"jobType": "intake.extract"` (`ai/fixtures/intake/intake-extract.json` ×7,
`ai/fixtures/intake/ci-smoke.json` ×1, and any other found by grep) gets `"documentDate": null, "docSide": null,
"photo": null, "segments": []` (the V5C fixture may set `documentDate`). The prompt `agent/prompts/intake.md` adds the
four properties, the bundle-only field names (`RULE_FIELD_NAMES`), the zone id list (from the brief) and: "for photos
read every number plate exactly as printed; never guess a character".

`extractionInput` (`intake/spec.ts`) adds to the brief: `allowedZoneIds` (VEHICLE_ZONES ids), `bundle: {name} | null`,
`fieldNames: RULE_FIELD_NAMES`. The task tag stays `[intake:<kind>]`.

### 5.2 `normalise.ts` and new helpers

* **ZIP** (`intake/archive.ts`, new): `kind: 'archive'` (no longer skipped). Streaming unpack with fflate `Unzip` +
  `UnzipInflate` reading the stored file in 1 MiB chunks; each entry streamed into a staged temp file (sha256 while
  writing) and handed to `createItemFromStaged({ parentItemId, source: item.source, … })`. Limits from settings:
  ≤ `maxEntries` entries, ≤ `maxTotalBytes` uncompressed, nested ZIP depth ≤ `maxDepth`, per-entry ratio ≤ `maxRatio`
  (else that entry is skipped and listed), encrypted entries (general-purpose flag bit 0) skipped, `__MACOSX/`,
  dot-files, `Thumbs.db`, `desktop.ini`, directories skipped; entry names reduced to `safeFilename(basename)`. The
  archive item ends `skipped` with `normalised = {kind:'archive', entries:[{name, bytes, outcome:'item'|'skipped', reason?}]}`
  and `error = null`. Audit `intake.unpack` (entries, skipped).
* **PDF metadata** (in `pdfText` → `pdfInfo`): pdfjs `getMetadata()` Producer, Creator, CreationDate, ModDate (PDF
  date strings → ISO); `%%EOF` count from the bytes; page sizes (`getViewport({scale:1})`) per page. Stored as
  `normalised.pdfMeta` and `normalised.pageSizes`.
* **Images** (`intake/image.ts`, new): `decodeForHash(buffer, sniffed)`: JPEG → try the EXIF thumbnail first
  (`exifr.thumbnail`), else `jpeg-js` decode (`maxResolutionInMP: 50`, `maxMemoryUsageInMB: 512`, `formatAsRGBA`);
  PNG → `pngjs` `PNG.sync.read`; GIF/WebP/HEIC → no hash. Files > 40 MB are not decoded. `dHash64` stored on the
  bundle file (`phash`) and in `normalised.phash`; pixel count in `normalised.pixels`. EXIF comes from the evidence
  row (`storeEvidence` already parsed it).
* **EML** unchanged; attachments become child items (existing) and, for bundle items, bundle files (§5.5).

### 5.3 Rules reading (`intake/rules.ts`, new)

At the end of `processItem` (for every item that has text, and for images): `classifyText` + `ruleExtract` → append
an `intake_extractions` row `{ schemaId: 'intake_rules/1', runId: null, fields, summary: '<label> (read without AI)',
warnings: [], extras: { engine: 'rules', documentDate, docSide, photo: null, segments: [], pdfMeta } }`; set
`item.docType/docTypeConfidence` only if the item has no AI classification yet. The AI row later (extras
`engine: 'ai'`) wins through `bestIntakeExtraction`. Rules readings never create proposals on claims by themselves
(the existing `intake.apply` still runs after the AI extract only).

### 5.4 Splitting (`intake/split.ts`, new; job `intake.split`)

* Text PDFs: `processItem` builds `PageSignal[]` (per-page `classifyText`, `Page n of m`, header line, page size) →
  `splitPages`; ≥ 2 segments and `settings.split.enabled` → follow-up `intake.split {itemId, segments, source:'rules'}`.
* Scanned PDFs: the AI extraction's `segments` (validated by `validateSegments`) → follow-up `intake.split {…,
  source:'ai'}`.
* `intake.split` (cpu, det): pdf-lib `PDFDocument.load` (ignoreEncryption false; encrypted → no split) →
  `copyPages` per segment → `save()` → `storeEvidenceBuffer` (claimless, filename `<base> (pages 3-4).pdf`, description
  "Pages 3–4 of <file>") → `createItemFromStaged`-equivalent with `parentItemId = pack item` (new items go through the
  normal pipeline). The pack's bundle file role becomes `pack`; children `segment` with `page_from/page_to`. Idempotency
  `intake.split:<itemId>:<sha1(segments)>`. Audit `intake.split_pack` {segments}. A pack is split at most once per
  segment set; `POST …/files/:fileId/unsplit` records decision `unsplit` → segment files are excluded from the bundle
  (evidence stays) and the pack is treated as one document again.

### 5.5 Hooks (`intake/bundles/hooks.ts`, new) and pipeline edits

* `processItem`: after children are created (EML/ZIP), `hooks.childrenAdded(ctx, item, childIds, role)` inserts bundle
  files (`attachment` / role per kind) in every bundle the parent belongs to; after the rules reading,
  `hooks.itemSettled(ctx, itemId)`.
* `extractItem`: after the AI row, `hooks.itemSettled`; when `wait_usage` / `auth_failed` / AI off, the item already
  shows `waiting` (existing `itemWaiting`); the hook is also called so the bundle shows "waiting for AI".
* `applyItem`: if the item has no claim **and** belongs to an open bundle → `status 'proposed'`, no `new_claim` card,
  `hooks.itemSettled`; otherwise unchanged.
* `hooks.itemSettled(ctx, itemId)`: for each bundle of the item: `bumpBundleRevision`, status → `reading` /
  `reconciling`, enqueue `intake.bundle_reconcile {bundleId, revision}` with `runAfter = now + quietSeconds` and key
  `intake.bundle_reconcile:<bundleId>:r<revision>` (each new event re-keys; stale jobs exit).

### 5.6 With the AI paused

Per-file AI extraction and bundle reasoning queue exactly as today (`wait_usage`, AI off, kill switch). Everything
else is deterministic: rules readings, splitting of text PDFs, duplicates, EXIF checks, grouping, reconcile,
checklist, timeline (documents' dates), signals, registrability. The bundle shows `reasoning.status = 'waiting_ai'`
with the existing `itemWaiting` reasons and the banner "Agents are paused — this draft is from the documents' text;
the AI will check it when they are back". The owner may register; auto-register waits for the AI reasoning.

---

## 6. Bundle engine (`apps/api/src/intake/bundles/`)

| File | Purpose |
|---|---|
| `service.ts` | create / rename / add files / list / cancel / reopen; decision helper `decide(ctx, bundle, kind, …)` (append + bump revision + audit) |
| `hooks.ts` | §5.5 |
| `claimIndex.ts` | `ClaimKeyIndex` + `StopList` from claims, vehicles, parties, events (TP policy), evidence sha256s, fleet units, fleet policies, settings, mail account (cached per reconcile run) |
| `candidates.ts` | best extraction per item → `Candidate[]` (validated/normalised through `targetDef(target).validate` or bundle-key validators), EXIF / plates / name hint candidates, AI reasoning candidates |
| `recompute.ts` | the pure pipeline: duplicates → keys → groups → reconcile (main group) → checklist → timeline → signals → liability → registrable → `BundleComputed`; stores `computed`, `computed_revision`, `auto_eligible`, status; raises/updates the Needs-you card; triggers reasoning / auto-register |
| `signalsInput.ts` | builds `SignalsInput` (crossFile, vinElsewhere, findConnections over other claims' parties, personMatch, evidence `alsoOnClaims`, pHash index of claim photos) |
| `reason.ts` | `INTAKE_BUNDLE_SPEC`, `bundleReasoningInput`, `validateReasoning` |
| `register.ts` | `registerBundle` (§6.7) |
| `attach.ts` | `attachBundle` (§6.9) |
| `file.ts` | `fileBundleEvidence` — evidence kinds, duplicates skipped, intake items linked (§6.8) |
| `splitOff.ts` | group → new bundle (`source:'split'`, `parentBundleId`, files moved by decisions) |
| `folder.ts` | inbox folder → bundle (§6.11) |
| `requestDocs.ts` | missing-documents request (§6.10) |
| `damage.ts` | damage observations + `GET /claims/:id/damage-zones` aggregation |
| `brief.ts` | case brief (§6.13) |
| `corrections.ts` | owner corrections → `recordCorrection` (§6.12) |
| `dailyLog.ts` | `intakeDailyLogSection(ctx, day, bounds)` (§12) |
| `views.ts` | `bundleSummary`, `bundleDetail`, `fileView` (JSON of §8) |

### 6.1 `intake.bundle_reconcile` (cpu, deterministic)

Payload `{bundleId, revision}`. Exit `done {stale:true}` when `revision < bundle.revision`. Runs `recompute`; then:
* if every file has settled (no item `queued|normalising`, no pending `intake.split`, every item has a rules or AI
  reading or is skipped/failed) **and** the main-group fileset hash ≠ `reasoning_fileset` **and** the per-bundle
  daily cap is not reached → enqueue `intake.bundle_reason {bundleId, fileset}` (key
  `intake.bundle_reason:<bundleId>:<fileset>`), `reasoning_status = 'queued'`;
* if `autoEligible` and settings on → enqueue `intake.bundle_register {bundleId, revision}`;
* else if status `ready` and no open card → raise Needs-you `new_claim` (bundle variant, §9).
Audit `intake.bundle.reconcile` (agent:intake) `{bundleId, revision, files, groups, conflicts, missing, signals}`.

### 6.2 `intake.bundle_reason` (ai)

```ts
export const INTAKE_BUNDLE_SPEC: AgentSpec = {
  name: 'intake', jobType: 'intake.bundle_reason', title: 'Intake: read the case bundle together',
  promptFiles: ['intake-bundle.md'], tools: [], allowRead: false, resultSchemaId: 'intake_bundle_reasoning',
  defaults: { model: 'claude-opus-5-5', effort: 'medium', maxTurns: 1, timeoutMs: 8 * 60_000 },
};
```

`AI_JOB_DEFAULTS['intake.bundle_reason']` added (editable in Settings > AI per job). Input (`bundleReasoningInput`):
task line `Read these documents together and reconcile one claim [intake-bundle] — <bundle name>`; brief =
`{ bundleId, name, files: [{fileId, filename, docType, docTypeLabel, documentDate, summary, fields (best reading),
photo, groupKey}], groups (keys + reasons), deterministicDraft (fields + open conflicts), allowedKeys:
BUNDLE_FIELD_KEYS, timelineEventTypes, today }`; untrusted = page texts of the main group's non-photo files
(priority: client-authored forms, police reports, insurer letters, engineer reports, emails; then the rest), each file
capped at 20 000 chars, total ≤ 150 000 chars (each as `{kind:'document', id:fileId, text}`). No signals, no other
claims' data. Result `IntakeBundleReasoning` (§7.1). Outcomes as `extractItem`: `usage_limited` → `wait_usage`
(`reasoning_status 'waiting_ai'`); `auth_failed` → `authFailedWait`; AI off → `reasoning_status 'waiting_ai'`,
`done`; retryable → retry; else `failed` (bundle keeps the deterministic draft).

`validateReasoning(result, files)` (all code): every `fileId` must be in the bundle (else dropped); every `quote` must
be found in that file's text (`findQuote` ≠ `not_found`), else the item's confidence is capped at 0.5 and flagged
`unverified_quote`; values pass the same validators as candidates; `timeline.eventType` must be in
`TIMELINE_EVENT_CLASS`; `caseSummary` must pass `verifySummary` else dropped; `fileAdvice` may only *suggest* (shown as
reasons; it moves a file only out of `unsure` into a group when no strong key contradicts); `injectionSuspected` → the
signal `INSTRUCTIONS_IN_DOCUMENT`. Stored append-only in `intake_bundle_reasonings` with `checks` (dropped / capped
counts). AI field choices become candidates with engine `ai_reasoning` and the cited file's rank — they never
override an owner decision and never resolve a conflict by themselves (their `why` is shown next to the options).
Then enqueue `intake.bundle_reconcile` for the current revision.

### 6.3 Owner decisions

All decision routes: validate → `appendBundleDecision` (actor = owner, `before`/`after`) → `bumpBundleRevision` →
synchronous `recompute` (pure, fast) → return `BundleDetail`. Audit `intake.bundle.<kind>`.

### 6.4 Candidates mapping

* AI/rules fields with a `target` → `bundleKeyForTarget(target)`; with `target: null` → by `name` in
  `RULE_FIELD_NAMES` (e.g. "Police reference" → `accident.policeReference`, "Insurer name" (on a TP-insurer letter) →
  `tp.insurerName`, "Witnesses" → witness list, "Vehicle driveable" → `accident.driveable`, "Hire needed" →
  `hire.needed`).
* EXIF `dateTimeOriginal` of damage photos → `accident.occurredAt` candidate, engine `exif`, confidence 0.3, date-only
  display.
* Plates read in photos matching nothing yet → `vehicle.registration` / `tp.registration` candidates engine `plate`
  (confidence = read confidence × 0.8), assigned by which registration the other files already hold.
* Bundle name hint: text before " – " / " - " parsed as a person name → `client.name` engine `name_hint`, 0.3.
* Values normalised with `targetDef(target).validate(raw, {now, holder})` (VRM spacing, VIN, dates to ISO, phones,
  addresses via `parseUkAddress`), so comparisons are on normalised values.

### 6.5 Liability preview

`scoreLiabilityFor(draft accident details, {liability:'unknown', priorClaimsOnRegistration})` (engines.ts) → score,
band, reasons; plus `liabilityStatements` from the AI reasoning (verified quotes only) and rules phrases ("we accept
liability", "liability is denied", "our insured accepts responsibility") as statements with their source. Displayed
as a guide: "Liability is your decision." Never written to the claim by intake (claim `liability` stays `unknown` as
POST /claims defaults it).

### 6.6 Body for POST /claims (`buildCreateClaimBody(computed, decisions)`)

```
claimant: { kind:'individual', name, phone?, email?, dateOfBirth?, drivingLicenceNumber?, address?, roles:[claimant(,driver)] }
            or { id } when the owner chose "use the existing client record" (decision link_party)
driver?:  (only when driver.name differs from client.name)
vehicle:  { registration, vin?, make?, model?, colour?, monthOfFirstRegistration?, ownership:'client' }
thirdPartyVehicle?: { registration, make?, model?, ownership:'third_party' }
thirdParties: [ { name, phone?, address?, roles:['third_party_driver'] }?, { name, phone?, roles:['repairer'] }?, { name, roles:['engineer'] }? ]
thirdParty: { registration?, registrationUnknown?, insurerName?, insurerPolicyNumber?, contact? }      // wizard spelling, merged by normaliseFnol
atFaultInsurerRef?, clientInsurer?: { name, policyNumber? }
accident: { occurredAt, location, postcode?, circumstances, policeAttended?, policeReference?, injuries?, driveable?, independentWitness? }
witnesses?: [ { name, phone?, relationship } ]           // only when witnessesAnswered (documents state them or "none")
injury?: { reported: true } when accident.injuries        // routeInjury refers it out — no fee taken (existing)
services: { hire: hire.needed === 'yes', recovery?, storage?, engineer? }
channel: 'email', fnolAt: now, notes: "Opened from intake bundle '<name>' (<n> documents)."
```

`circumstances` is the client's own written words (client-authored form, quoted verbatim) or the owner's text; when
it comes from another source (police report) the field shows "From the police report — not the client's own account"
and needs the owner to set or confirm it (`MISSING_REQUIRED` until then). `takenCold` and `callRecordingDisclosed` are
left unset (FNOL warnings → the brief's first action "Call the client: confirm their account (taken cold), read the
recording disclosure, ask the script questions").

### 6.7 `registerBundle(ctx, bundleId, actor, opts)` (owner route and auto job)

```ts
interface RegisterOptions { mode: 'owner' | 'auto'; acceptPreselected?: boolean; confirmNew?: boolean;
  timeline?: { tick: string[]; untick: string[] }; requestMissingDocs?: boolean;
  groups?: Record<string, 'split_off' | 'attach' | 'exclude'> }
```

1. `casBundleStatus(from: ['ready','needs_you','open','reconciling'], to: 'registering')`; else 409 `BUNDLE_BUSY`.
2. Record the option decisions (`accept_preselected`, `confirm_new`, ticks); `recompute`; blockers for the mode
   (owner: owner blockers; auto: all) → status back, 409 `BUNDLE_NOT_READY {blockers}`.
3. Auto mode only: `decide({class:'internal', kind:'intake.register', confidence: min key confidence, sensitive:false,
   overwrites:false}, getAutonomy(ctx), autonomyState(ctx, {agent:'intake'}))` must be `auto`.
4. `createClaimFromFnol(ctx, body, actor)` (STRICT gate). FNOL refusal → status back, 400 passthrough
   (`FNOL_INCOMPLETE` with `missing/errors`).
5. File evidence (`file.ts`, §6.8) for the main group; link intake items to the claim (`updateIntakeItem claimId` +
   audit `intake.attach_claim`; **no** `intake.apply` re-run for bundle items).
6. Fields that `CreateClaimBody` cannot carry (none today besides insurer details already mapped; future keys) →
   `proposeField` with the bundle provenance → owner mode: `applyProposals(ownerApplier)`; auto mode:
   `applyProposals(agentApplier)` for `auto` policy, the rest into one bundle `confirm_fields` card (§9).
7. Ticked timeline items → `appendClaimEvent(ctx, claimId, {type, at, summary, attributableTo, evidenceIds (filed ids
   of its sources), data:{intakeBundleId, intakeTimelineId, sourceFileId, page, quote}}, actor)` — skip when an event
   with the same `data.intakeTimelineId` exists (retry-safe). Auto mode applies only `record` and `clock` items with
   confidence ≥ `autoRegisterMinConfidence`; `owner_only` items are never applied by intake.
8. Damage observations (`damage.ts`): AI photo zones of filed photos (`ai_photo`, evidenceId = filed id) and estimate
   text zones (`estimate_text`), `insertDamageObservation` (idempotent unique index). Audit
   `intake.damage_observation` (count).
9. Leftover groups: `groups[...]` choices (`split_off` → new bundle, `attach` → `attachBundle` for that group's claim,
   `exclude` → decision); any other non-main group (and `unsure` files) → split off automatically into new bundles
   (nothing is lost; each shows in the list).
10. Missing documents (`requestDocs.ts`, §6.10) when `requestMissingDocs ?? settings.prepareMissingDocsRequest`.
11. `claimChanged(ctx, [claimId], actor.userId, 'registered from intake bundle')` (clash check + Autopilot nudge).
12. Bundle → `registered`, `outcome`, `claim_id`, `closed_by/at`; decision `register`; supersede the open
    `new_claim` card (`transitionNeedsYou … 'superseded'`, note "registered as CCG-…"); audit
    `intake.bundle.register {claimId, reference, mode, files, duplicatesSkipped, events, conflictsResolved,
    signals, splitOff}`.
13. Corrections (§6.12). 14. Auto mode: Needs-you `question` "Registered automatically from '<name>': CCG-… — please
    look it over" (options `ok` / `fix` — generic resolve, no resolver), low priority, dedupe
    `intake:auto_registered:<bundleId>`.

Steps 5–10 are idempotent; a failure after step 4 leaves the bundle `registered` with `error` naming the failed step
and `POST …/register/retry` re-runs 5–10 (owner only).

### 6.8 Filing (`file.ts`)

`copyEvidenceToClaim(ctx, evidenceId, claimId, actor, description, kind)` — **new optional 6th parameter `kind`**
(mail/common.ts; default stays `src.kind`). Kind by doc type: `v5c→v5c`, `driving_licence→licence`,
`insurance_certificate→insurance_certificate`, `police_report|fnol_form|proof_of_address→document`,
`insurer_letter|correspondence→correspondence` (the `.eml` itself too), `engineer_report→engineer_report`,
`bodyshop_estimate|audatex_estimate→estimate`, `invoice→invoice`, `damage_photo|vehicle_photo_other→photo`,
`signed_ccguk_form→signed_document`, `bank_statement→bank_statement`, `payslip→payslip`,
`mot_certificate→mot_certificate`, `witness_statement→witness_statement`, `other→kindFromMime(mime)`.
Description: "<DocType label> — read by intake (bundle '<name>')" (+ " — pages 3–4 of <pack>" for segments).
Filed: documents, segments, packs (as `pdf`, "original scanned pack, split into N documents"), attachments, emails.
**Not filed**: `same_file` / `same_text` / `near_photo` / `near_text` duplicates (linked; the bundle view offers "File
this copy too" which files it with "copy of <primary>" in the description), `archive` containers (their entries are
filed), excluded files. `updateBundleFile filed_*`. Evidence store dedupe (same sha on the claim) still applies.

### 6.9 `attachBundle(ctx, bundleId, actor, { claimId, groupKey = 'main', apply?: BundleFieldKey[] })`

File the group's evidence on the claim (§6.8); for every draft field with a target: `proposeField` against the claim
snapshot (existing policy: auto / confirm / never) with source `{intakeItemId, evidenceId, page, quote, label,
via:'extraction'}`; owner mode applies the keys in `apply` with `ownerApplier`; everything else pending goes into one
bundle `confirm_fields` card. Ticked timeline items, damage observations, request for documents still missing on the
claim (checklist recomputed against the claim's existing evidence kinds), `claimChanged`, decision `attach`, audit
`intake.bundle.attach`. For `groupKey ≠ 'main'` only that group's files and readings are used and the bundle stays
open for the rest.

### 6.10 Missing documents request (`requestDocs.ts`)

After register/attach, if the checklist has `missing|partial` items: client email known and mail set up →
`createEmailDraft(ctx, {claimId, kind:'doc_request', to:[clientEmail], cc:[], subject, bodyText, attach:[],
inReplyToMessageId:null}, 'agent:intake', {loop:0})` → `review.check` → `outbox.after_review` → `describeOutbox` sets
`missingInfo` for `doc_request` → policy **asks** → Needs-you `missing_info` (mail's resolver approves/edits/rejects;
the owner's edits are already captured for learning). Otherwise → Needs-you `question` "Ask <client> for the missing
documents" with the prepared text in the summary (options `done` / `not_needed`). Audit `intake.bundle.request_docs
{claimId, items, outboxId|null}`. Nothing is ever sent without the owner (doc_request is always-ask).

### 6.11 Folder bundles (`folder.ts`, `services/imports.ts`)

`candidates()` in `services/imports.ts`: a subfolder of `inbox\intake\` whose name is **not** a claim reference →
files inside are staged with `bundleFolder: <folder name>` (new optional `StagedImport.bundleFolder`) instead of
being reported as unread (when `settings.bundles.folderBundles`; deeper subfolders are still reported). After staging,
the imports scan (`scanStagedIntakeImports`, 60 s, JOBS_ENABLED) for imports with `bundleFolder`:
`findOpenBundleByFolder` (case-insensitive) or `createIntakeBundle({name: folder, source:'folder', folderKey: folder,
createdBy:'agent:intake'})` → `consumeStagedImport` → `addBundleFile`. A folder reused after its bundle closed starts
a new bundle "<folder> (2)". Folder bundles follow the same reading/reconcile; the quiet period means the bundle is
reasoned once the drop has settled. Audit `intake.bundle.create {source:'folder'}`.

### 6.12 Corrections for the Knowledge Builder (`corrections.ts`)

At register/attach, for every key where the owner's final value (decision `set_field`, or a `choose_conflict`
different from the preselected) differs from the top reading: `runtimeServices(ctx).recordCorrection?.(ctx, {
needsYouId: bundle.needsYouId ?? 'intake-bundle:'+bundleId, kind: 'new_claim', claimId, optionId: 'register',
before: { intakeField: { key, value: top.value, docType: top.source.docType, engine: top.source.engine } },
after: { intakeField: { key, value: final } }, actor })` (the existing casework callback masks personal data into a
proposed `memory_items(kind:'correction')`). `knowledge/learners/corrections.ts` section 3 gains a branch: memory
corrections whose `data.before.intakeField` exists → `corrections` row `{source:'memory_item', targetKind:'intake_field',
agent:'intake', templateId: 'intake:'+docType, emailKind:null, beforeText: key+': '+masked before, afterText: key+':
'+masked after}` with `categoriseCorrection` + cluster key (so ≥ 3 similar corrections — e.g. VINs misread on V5Cs —
queue `knowledge.curate`). The confirm_fields resolver path already records corrections when the owner edits values.

### 6.13 Case brief (`brief.ts`) — improvement 10

`bundleBrief(ctx, bundleId)` / `claimIntakeBrief(ctx, claimId)` → `CaseBriefView` (§8): summary (verified AI
`caseSummary` or `caseSummaryTemplate`), key facts with sources, liability preview + statements, missing items +
request status, Autopilot (`autopilotView(ctx, claimId)`: `stopped`, first 5 of `plan.due` with catalogue title, mode,
status and the step's plain sentence), next actions (`buildCaseBrief(ctx, claimId, {mask:false}).nextActions`, first
5), FNOL call reminder when FNOL warnings exist, signals (owner-only), filed counts. Computed on demand, not stored.

---

## 7. AI job types, result schemas, FakeDriver fixtures

### 7.1 Job types (`packages/domain/src/agents/types.ts` `JOB_TYPES` + `JOB_TYPE_INFO`; handlers in `agent/handlers/intake.ts`)

| Type | Lane | AI | Mutates claim | Prio | Max attempts | Idempotency key | Trigger |
|---|---|---|---|---|---|---|---|
| `intake.split` | cpu | – | – | 3 | 3 | `intake.split:<itemId>:<sha1(segments)>` | process (text pack) / extract (AI segments) |
| `intake.bundle_reconcile` | cpu | – | – | 3 | 3 | `intake.bundle_reconcile:<bundleId>:r<revision>` | hooks, decisions, reasoning done |
| `intake.bundle_reason` | ai | yes | – | 3 | 3 | `intake.bundle_reason:<bundleId>:<fileset>` (+`:o<ts>` owner "Think again") | reconcile when all settled |
| `intake.bundle_register` | io | – | yes | 2 | 2 | `intake.bundle_register:<bundleId>:r<revision>` | reconcile, auto-eligible + setting on |

All four `agent: 'intake'`. `intake.bundle_register` has no `claimId` at enqueue (claim does not exist yet).
`supreme-contracts.test.ts` keeps passing (every JobType has a handler).

`IntakeBundleReasoning` (`agents/results.ts`, schema id `intake_bundle_reasoning`, added to `ResultSchemaId`,
`RESULT_SCHEMA_IDS`, `ResultTypes`, `RESULT_SCHEMAS`):

```ts
export interface IntakeBundleReasoning {
  caseSummary: string;
  fieldChoices: Array<{ key: BundleFieldKey; value: string | null; fileId: string | null; page: number | null; quote: string | null; confidence: number; why: string }>;
  fileAdvice: Array<{ fileId: string; group: 'main' | 'other_case' | 'existing_claim' | 'unsure' | 'not_relevant'; otherCaseLabel: string | null; claimReference: string | null; why: string; confidence: number }>;
  circumstances: { text: string | null; fileId: string | null; page: number | null; authoredBy: 'client' | 'police' | 'insurer' | 'witness' | 'other' | null };
  witnesses: Array<{ name: string; phone: string | null; relationship: string | null; fileId: string | null; page: number | null; quote: string | null }>;
  witnessesAnswered: boolean;
  hireNeed: { needed: 'yes' | 'no' | 'unknown'; why: string; fileId: string | null; page: number | null; quote: string | null };
  liabilityStatements: Array<{ text: string; party: 'insurer' | 'client' | 'third_party' | 'police' | 'other'; fileId: string; page: number | null; quote: string }>;
  timeline: Array<{ at: string; eventType: string; summary: string; fileId: string; page: number | null; quote: string | null; confidence: number }>;
  warnings: string[];
  injectionSuspected: boolean;
}
```

Strict schema (every property required; `key` = `strEnum(BUNDLE_FIELD_KEYS)`; `eventType` = `strEnum(Object.keys(TIMELINE_EVENT_CLASS))`).
Size ≈ 4 KB. Prompt `apps/api/src/agent/prompts/intake-bundle.md`: role (read several documents about one accident
together; you decide nothing — code checks every value, the owner registers), untrusted-data rules (`_base`), what
each output means, "cite fileId + page + exact quote for every value; never invent a value; prefer the source a
person would trust (V5C for VIN, licence for date of birth, police report for accident time)"; "the client's account
must be quoted from a document the client wrote; otherwise set circumstances.authoredBy accordingly"; "never comment
on honesty, fraud or credibility; say only what the documents say"; "never decide liability, money or offers".

### 7.2 Fixtures (`apps/api/src/ai/fixtures/intake/`)

* `intake-extract.json`, `ci-smoke.json` — add the four new properties (§5.1).
* `smart-extract.json` (new) — per synthetic file of §16.3, matched by `userContains` on a fixture marker printed in
  the synthetic file name (e.g. `SMART-A-V5C`, `SMART-A-LICENCE-FRONT`, `SMART-A-PHOTO-2041`, `SMART-A-PHOTO-1999`,
  `SMART-A-PACK-SCAN` (returns `segments` for the blank 3-page PDF), `SMART-B-V5C`, …) — the task line includes the
  filename (`extractionInput` already prints `— <filename>`). Photo fixtures return `photo.scene`, `plates`
  (`"KX21 ABC"`) and `damageZones` (`front_bumper`, `bonnet` etc. — ids must exist in `VEHICLE_ZONES`; the builder
  checks with `isZoneId`).
* `bundle-reason.json` (new) — `jobType: 'intake.bundle_reason'`, `userContains: ['[intake-bundle]', '<bundle name
  marker>']`: one `ok` result for scenario A (quotes copied verbatim from the synthetic texts so `findQuote` passes; one
  deliberate unverifiable quote to test capping), one `usage_limited` (`resetsInMinutes: 30`) for the paused test,
  one with `injectionSuspected: true`, one for the clean auto-register bundle. File ids are generated at runtime, so the reasoning brief also lists `fileRef`
  (`<position>:<filename>`) and the result may cite either; `validateReasoning` resolves `fileRef` → `fileId`
  (fixtures use `fileRef`, e.g. `"2:SMART-A-V5C.pdf"`). Schema field name stays `fileId` (value may be a `fileRef`).
* A fixture match miss fails loudly (`invalid_output` listing ids) — tests assert no such outcome.

---

## 8. API contract (complete; both slices build against this)

All routes under `/api`, owner session required (existing auth). Agent principals cannot call any of them (no tool
declares them → `route_allowlist`); additionally `HUMAN_ONLY_ROUTES` gains `POST /api/intake/bundles/:id/register`,
`POST /api/intake/bundles/:id/register/retry`, `POST /api/intake/bundles/:id/attach`, `PATCH /api/settings/intake`.
Errors use the existing `{error:{code, message, details?}}` envelope. Dates are ISO strings; ids strings.

### 8.1 Shared JSON types

```ts
type BundleStatus = 'open'|'reading'|'reconciling'|'ready'|'needs_you'|'registering'|'registered'|'attached'|'cancelled';
type Readiness = 'reading'|'needs_review'|'ready_to_register'|'registered'|'attached'|'cancelled';
type FileStage = 'stored'|'reading'|'splitting'|'waiting_ai'|'reading_ai'|'read'|'read_rules_only'|'unpacked'|'skipped'|'failed';
type WaitingReason = 'agents_off'|'kill_switch'|'usage'|'sign_in';

interface BundleSummary {
  id: string; name: string; status: BundleStatus; readiness: Readiness; source: 'upload'|'folder'|'split';
  folderKey: string | null; parentBundleId: string | null; revision: number; computedRevision: number | null;
  createdAt: string; updatedAt: string; createdBy: string;
  fileCounts: { total: number; read: number; inProgress: number; waitingAi: number; failed: number; skipped: number; duplicates: number };
  groupCount: number; conflictsOpen: number; missingDocs: number; signals: { warn: number; info: number };
  reasoning: { status: 'none'|'queued'|'waiting_ai'|'done'|'failed'|'skipped'; at: string | null; waiting: { reason: WaitingReason; until?: string } | null };
  autoRegister: { settingOn: boolean; eligible: boolean; blockers: Blocker[] };
  claim: { id: string; reference: string } | null; needsYouId: string | null; error: string | null;
}
interface Blocker { code: string; text: string; for: 'owner'|'auto' }

interface FieldSource { fileId: string; itemId: string; evidenceId: string; filename: string; docType: string | null; docTypeLabel: string | null;
  page: number | null; quote: string | null; confidence: number; engine: 'ai'|'rules'|'exif'|'plate'|'owner'|'name_hint'|'ai_reasoning';
  rank: number; label: string; quoteVerified: boolean | null }

interface BundleFileView {
  id: string; itemId: string; evidenceId: string; filename: string; mime: string; bytes: number; sha256: string; addedAt: string;
  position: number; role: 'document'|'pack'|'segment'|'attachment'|'archive'|'email'; parentFileId: string | null;
  segment: { fromPage: number; toPage: number } | null;
  stage: FileStage; stageLabel: string; waiting: { reason: WaitingReason; until?: string } | null; error: string | null;
  docType: string | null; docTypeLabel: string | null; docTypeConfidence: number | null; docSide: 'front'|'back'|null;
  documentDate: string | null; pages: number | null; summary: string | null; engine: 'ai'|'rules'|null;
  groupKey: string; pinned: boolean; excluded: boolean;
  duplicate: { of: string; kind: 'same_file'|'same_text'|'near_photo'|'near_text'; similarity: number } | null;
  photo: { takenAt: string | null; gps: { lat: number; lon: number } | null; software: string | null; scene: string | null;
    plates: Array<{ text: string; normalised: string; confidence: number; matches: 'client'|'third_party'|null }>;
    zones: Array<{ zoneId: string; label: string; severity: 1|2|3; confidence: number }> } | null;
  pdfMeta: { producer: string | null; creator: string | null; createdAt: string | null; modifiedAt: string | null; incrementalUpdates: number } | null;
  archive: { entries: number; skipped: Array<{ name: string; reason: string }> } | null;
  filed: { evidenceId: string; claimId: string; kind: string; at: string } | null;
  fileUrl: string;            // "/api/evidence/<evidenceId>/file"
}

interface BundleGroup {
  key: string;                // 'main' | 'case:B' | 'claim:<claimId>' | 'unsure' | 'excluded'
  kind: 'main'|'new_case'|'existing_claim'|'unsure'|'excluded';
  label: string; claim: { id: string; reference: string; clientName: string | null; status: string } | null;
  fileIds: string[]; reasons: Array<{ code: string; text: string; fileId?: string }>; confidence: number;
  suggestedName: string | null; warnings: string[];
  defaultAction: 'register'|'attach'|'split_off'|'exclude'|'decide';
}

interface DraftField {
  key: string; label: string; section: 'client'|'driver'|'vehicle'|'third_party'|'accident'|'insurers'|'hire_repair';
  value: string | null; display: string | null; confidence: number; sensitive: boolean; required: boolean; keyField: boolean;
  status: 'ok'|'low_confidence'|'conflict'|'missing'|'owner_set'|'invalid';
  validator: { ok: boolean; message: string | null }; source: FieldSource | null;
  alternatives: Array<{ value: string; display: string; sources: FieldSource[] }>; conflictId: string | null; note: string | null;
}
interface Conflict {
  id: string; key: string; label: string; status: 'open'|'resolved';
  options: Array<{ value: string; display: string; sources: FieldSource[]; rank: number; preselected: boolean; aiWhy: string | null }>;
  why: string; chosenValue: string | null; resolvedBy: string | null; resolvedAt: string | null;
}
interface WitnessDraft { name: string; phone: string | null; relationship: string | null; source: FieldSource | null }
interface ChecklistItem { id: string; label: string; status: 'have'|'missing'|'partial'|'not_needed'; why: string; fileIds: string[] }
interface TimelineProposal { id: string; at: string; precision: 'date'|'datetime'; eventType: string; eventLabel: string;
  class: 'record'|'clock'|'owner_only'; summary: string; attributableTo: string; sources: FieldSource[]; confidence: number;
  ticked: boolean; tickedBy: 'default'|'owner'; note: string | null }
interface RiskSignal { id: string; code: string; severity: 'info'|'warn'; title: string; message: string; fileIds: string[];
  claims: Array<{ id: string; reference: string }>; basis: Array<{ fileId: string; page: number | null; quote: string | null }>;
  acknowledged: { by: string; at: string; note: string | null } | null }

interface BundleDetail extends BundleSummary {
  files: BundleFileView[]; groups: BundleGroup[];
  draft: { fields: DraftField[]; witnesses: WitnessDraft[]; witnessesAnswered: boolean;
    circumstances: { attribution: 'client'|'police'|'insurer'|'witness'|'owner'|'other'|null; fromFileId: string | null };
    existingParty: { partyId: string; name: string; claims: Array<{ id: string; reference: string }>; how: 'licence'|'name_dob' } | null };
  conflicts: Conflict[];
  checklist: { caseKind: string; caseKindLabel: string; items: ChecklistItem[]; request: { to: string | null; subject: string; body: string } | null };
  timeline: TimelineProposal[]; signals: RiskSignal[];
  liability: { score: number | null; band: string | null; reasons: string[]; statements: Array<{ text: string; party: string; source: FieldSource }>; note: string };
  register: { canRegister: boolean; blockers: Blocker[]; fnolWarnings: string[]; willDo: string[] };
  aiSummary: string | null;
  decisions: Array<{ id: string; kind: string; subject: string | null; before: unknown; after: unknown; note: string | null; actor: string; at: string }>; // newest 50
}

interface CaseBriefView {
  claim: { id: string; reference: string; status: string; createdAt: string }; bundle: { id: string; name: string } | null;
  generatedAt: string; summary: string; summarySource: 'ai'|'template';
  facts: Array<{ label: string; value: string; source: string | null }>;
  liability: { position: string; score: number | null; band: string | null; reasons: string[]; statements: Array<{ text: string; source: string }>; note: string };
  missing: ChecklistItem[]; request: { status: 'waiting_for_you'|'sent'|'not_prepared'|'prepared_no_email'; outboxId: string | null; needsYouId: string | null; reason: string | null };
  callReminder: string | null;
  autopilot: { stopped: string | null; firstSteps: Array<{ id: string; title: string; mode: string; status: string; sentence: string }> };
  nextActions: Array<{ code: string; title: string; why: string; dueAt: string | null }>;
  signals: RiskSignal[];
  filed: { documents: number; photos: number; duplicatesSkipped: number; events: number; damageZones: number };
}

interface IntakeSettingsView { settings: IntakeSettings /* §4.17 shape */; defaults: IntakeSettings }
```

### 8.2 Routes (`apps/api/src/routes/intakeBundles.ts`, registered in `routes/index.ts`)

| Method + path | Body / query | 2xx response |
|---|---|---|
| `GET /intake/bundles` | `?status=open\|done\|cancelled\|all` (default open = not registered/attached/cancelled), `limit` ≤ 200, `offset` | `{ items: BundleSummary[], total: number }` |
| `POST /intake/bundles` | `{ name: string (1..120, trimmed) }` | 201 `BundleSummary` |
| `GET /intake/bundles/:id` | – | `BundleDetail` (recomputes first if `computedRevision < revision`) |
| `GET /intake/bundles/:id/progress` | – | `{ bundle: BundleSummary, files: Array<{ id, filename, stage, stageLabel, waiting }> }` (cheap; for polling every 3 s) |
| `PATCH /intake/bundles/:id` | `{ name }` | `BundleSummary` |
| `POST /intake/bundles/:id/files` | multipart: up to 10 `file` parts, 512 MiB each (same limits/errors as `POST /intake`); or JSON exactly one of `{uploadId}` / `{importId}` / `{evidenceId}` | 201 `{ files: Array<{ fileId: string, itemId: string, filename: string, outcome: 'added'\|'already_in_bundle' }>, bundle: BundleSummary }` |
| `POST /intake/bundles/:id/files/:fileId/move` | `{ groupKey: string }` (an existing key, or `'new'` for a fresh `case:X`) | `BundleDetail` |
| `POST /intake/bundles/:id/files/:fileId/exclude` | `{ excluded: boolean, reason?: string }` | `BundleDetail` |
| `POST /intake/bundles/:id/files/:fileId/unsplit` | – | `BundleDetail` |
| `POST /intake/bundles/:id/files/:fileId/file-copy` | – (registered/attached bundles: file a duplicate too) | `BundleDetail` |
| `POST /intake/bundles/:id/fields` | `{ key: string, value: string \| null, note?: string }` (null = clear owner value) | `BundleDetail` (400 `VALIDATION` with the validator message) |
| `POST /intake/bundles/:id/witnesses` | `{ witnesses: Array<{name, phone?, relationship}>, answered: boolean }` | `BundleDetail` |
| `POST /intake/bundles/:id/conflicts/:conflictId/choose` | `{ value: string }` (one of the options) | `BundleDetail` |
| `POST /intake/bundles/:id/conflicts/accept-preselected` | – | `BundleDetail` |
| `POST /intake/bundles/:id/confirm-new` | `{ note?: string }` (main group matches an existing claim; owner says it is new) | `BundleDetail` |
| `POST /intake/bundles/:id/link-party` | `{ partyId: string \| null }` | `BundleDetail` |
| `POST /intake/bundles/:id/timeline/:proposalId` | `{ ticked: boolean }` (400 for `owner_only`) | `BundleDetail` |
| `POST /intake/bundles/:id/signals/:signalId/ack` | `{ note?: string }` | `BundleDetail` |
| `POST /intake/bundles/:id/groups/:groupKey/split-off` | `{ name?: string }` | 201 `{ bundle: BundleSummary /* new */, source: BundleDetail }` |
| `POST /intake/bundles/:id/think-again` | – (owner; exempt from the daily cap) | 202 `BundleSummary` |
| `POST /intake/bundles/:id/register` | `{ acceptPreselected?: boolean, confirmNew?: boolean, timeline?: { tick: string[], untick: string[] }, requestMissingDocs?: boolean, groups?: Record<string,'split_off'\|'attach'\|'exclude'> }` | 201 `RegisterResult` (409 `BUNDLE_NOT_READY {blockers}`, 409 `BUNDLE_BUSY`, 400 `FNOL_INCOMPLETE`) |
| `POST /intake/bundles/:id/register/retry` | – | `RegisterResult` |
| `POST /intake/bundles/:id/attach` | `{ claimId: string, groupKey?: string, apply?: string[] }` | `AttachResult` |
| `POST /intake/bundles/:id/cancel` | `{ reason: string (3..2000) }` | `BundleSummary` |
| `POST /intake/bundles/:id/reopen` | – | `BundleSummary` |
| `POST /intake/bundles/:id/wizard-draft` | – | 201 `NewClaimDraft` (existing type, `intake/newClaimDraft.ts`; open `/claims/new?intakeDraft=<id>`) |
| `GET /intake/bundles/:id/brief` | – (registered/attached only; 404 otherwise) | `CaseBriefView` |
| `GET /claims/:id/intake-brief` | – | `CaseBriefView` or 404 `NO_INTAKE_BUNDLE` |
| `GET /claims/:id/damage-zones` | – | `{ zones: Record<string, { severity: 0\|1\|2\|3, confidence: number, source: 'ai', evidenceIds: string[] }>, observations: Array<{ id, zoneId, severity, confidence, source, evidenceId: string \| null, createdAt }> }` |
| `GET /settings/intake` | – | `IntakeSettingsView` |
| `PATCH /settings/intake` | deep-partial `IntakeSettings` | `IntakeSettingsView` (audit `intake.settings`) |

```ts
interface RegisterResult {
  claim: { id: string; reference: string }; bundle: BundleSummary;
  filed: { evidence: number; duplicatesSkipped: number }; events: number;
  proposals: { applied: number; pending: number; needsYouId: string | null };
  request: { outboxId: string | null; needsYouId: string | null; reason: string | null };
  splitOff: BundleSummary[]; attached: Array<{ claimId: string; reference: string; files: number }>;
  brief: CaseBriefView; error: string | null;
}
interface AttachResult {
  claim: { id: string; reference: string }; bundle: BundleSummary; filed: { evidence: number; duplicatesSkipped: number };
  events: number; proposals: { applied: number; pending: number; needsYouId: string | null };
  request: { outboxId: string | null; needsYouId: string | null; reason: string | null };
}
```

Existing routes unchanged except: `GET /intake` rows' `doc.kind` may be `'archive'`; `GET /intake/:id` unchanged
(the provenance drawer uses its `pageTexts`); `GET /daily-log` gains `sections.intake?: LogLine[]` (§12).

---

## 9. Needs-you kinds and resolvers (no new kinds)

| Kind | Raised by | Payload | Options | Resolver (intake, as the owner) |
|---|---|---|---|---|
| `new_claim` (bundle variant) | `recompute` when `ready`, setting off or not eligible | `{ bundleId, name, revision, keyFields: Array<{label, value}>, counts: {files, conflicts, missing, signalsWarn}, blockers: Blocker[] }` (dedupe `new_claim:bundle:<id>`; summary lists key fields, "3 conflicts to check", "2 documents missing", "1 thing worth a look") | `register` (primary), `attach` (requiresEdit `{claimId}`), `cancel` (danger, requiresReason) | `resolveNewClaim` gains a branch on `payload.bundleId`: `register` → `registerBundle(mode 'owner', {acceptPreselected:false})` (fails with the blockers → item stays open, error shown); `attach` → `attachBundle`; `cancel` → cancel. The old per-item variant (`payload.itemId`) is unchanged |
| `confirm_fields` (bundle variant) | attach / auto register leftovers | `ConfirmCardPayload` + `bundleId` (proposals of several items; `itemId` = first) — dedupe `confirm_fields:bundle:<id>:<claimId>` | `apply`, `reject` | `resolveConfirmFields`: when `payload.bundleId`, pending = proposals whose ids are in `payload.proposals` (not "by itemId"); then `settleItemStatus` per item |
| `missing_info` | outbox policy for the `doc_request` draft (§6.10) | mail's payload | mail's | mail (unchanged) |
| `question` | auto-registered check (§6.7 step 14), request with no email (§6.10), HEIC (existing) | `{ bundleId, claimId?, text }` | `ok`/`fix`, `done`/`not_needed` | none (generic resolve records the choice) |

When the bundle changes after the card is raised, the card is kept (dedupe) and its payload is not rewritten; the web
panel always reads the live bundle. Register/attach/cancel supersede the open card.

---

## 10. Autonomy rules

| Action | Who | Rule |
|---|---|---|
| Read files, unpack, split, classify, rules reading, grouping, reconcile, checklist, timeline proposals, signals, AI reasoning | `agent:intake` | Automatic (`read`/`draft` classes; nothing changes a claim). Daily log. |
| Move / exclude files, set fields, choose conflicts, tick timeline, acknowledge signals, split off, cancel | owner | Owner only (routes; agents have no tool for them). |
| **Register claim** | owner | Default. A new client relationship is confirmed by the owner (SD §G.3; AP step basis). |
| Register claim automatically | `agent:intake` | Only when `settings.bundles.autoRegister` **and** `registrable().autoEligible` **and** `decide({class:'internal', kind:'intake.register', …})` is `auto` (kill switch → deny; shadow mode / paused → ask). Followed by a `question` card to look it over. |
| Attach bundle to existing claim | owner | Owner only (route human-only). The auto path never attaches; strong matches are shown as suggestions. |
| Field values on an existing claim | per existing proposal policy | `proposalPolicy` unchanged (auto only: empty, ≥ 0.9, valid, not sensitive, `decide` auto). |
| Chronology events | owner at register (ticked) / auto register: `record` + `clock` ≥ threshold | `owner_only` types (offers, settlements, payments, reports issued, hire start/end, legal) are **never** written by intake. |
| Client request for missing documents | prepared by `agent:intake` | Always asks (`doc_request` ⇒ `missingInfo` ⇒ Needs-you `missing_info`). |
| Liability, ledger, status, offers | – | Never touched by intake (FieldTarget union stays closed to them; liability preview is display only). |
| Risk signals | – | Never decline, never block the owner, never reach agents' prompts, documents, chronology or outbound mail. Block auto-register only. |

---

## 11. Web screens (`apps/web`)

Web never imports API code and must not depend on new `@ccguk/domain` exports (types of §8 are declared in
`apps/web/src/api/bundlesApi.ts`); existing domain exports (`VEHICLE_ZONES`, `getZone`) may be used for labels.

### 11.1 Routes and navigation (`app/router.tsx`)

`/intake` → `IntakeHome` (tabs **Case bundles** (default) | **Single files** — the existing `IntakePage` rendered as
is); `/intake/bundles/new` → `NewBundlePage`; `/intake/bundles/:id` → `BundlePage`; `/settings/intake` →
`IntakeSettingsPage`. Nav item "Intake" unchanged.

### 11.2 Bundles list (`BundlesListPage.tsx`)

Header "Intake — case bundles", button **New bundle**. Filter chips Open / Registered / Cancelled / All. Rows: name,
readiness chip (Reading 5/12 · Needs review · Ready to register · Registered CCG-… · Attached · Cancelled), files
progress bar, groups ("2 cases + 1 existing claim"), conflicts, missing documents, owner-only flag icon with the
signal count, updated time, source (folder icon). Polls `GET /intake/bundles` every 4 s while any is reading.

### 11.3 New bundle (`NewBundlePage.tsx`, `uploadQueue.ts`)

Name field (placeholder "e.g. Jane Doe – Corsa crash"; required) and a large drop zone accepting files **and
folders** (`DataTransferItem.webkitGetAsEntry()` recursion; `<input webkitdirectory>` "Choose a folder"; hidden
files and `Thumbs.db`/`desktop.ini` skipped). On first drop/selection: `POST /intake/bundles` then navigate to the
bundle page, where the upload queue continues: batches of ≤ 10 files per multipart request (≤ 64 MiB each); larger
files via `uploadInChunks` (purpose `intake`) then `{uploadId}`; > server limit → refused message pointing at the
import folder (`inbox\intake\<bundle name>\`). Per-file progress: client upload %, then the server `stage`. Concurrency
2 requests. Retry button per failed file.

### 11.4 Bundle page (`BundlePage.tsx`)

* **Header**: inline-editable name, readiness chip, reasoning chip ("AI checked" / "AI check queued — agents are
  paused" with the waiting reason / "Rules only"), actions: **Register claim** (primary; disabled with the first
  blocker as tooltip), **Attach to existing claim…** (`AttachDialog` — claim search, diff of on-file vs documents
  with ticks → `apply`), **Open in New Claim wizard** (`wizard-draft` → `/claims/new?intakeDraft=`), **Think again**,
  **Cancel bundle**. Banner when the main group matches an existing claim ("This looks like CCG-… — same VIN and
  insurer reference") with **Attach instead** / **It's a new claim** (`confirm-new`).
* **Files & cases board** (`FilesBoard.tsx`): one column per group (This case · New case B · CCG-2026-00031 · Not sure
  · Excluded), each with its reasons ("Same VIN as the V5C"), file cards (thumbnail or type icon, filename, doc-type
  chip with confidence, pages, stage, "read without AI" marker, duplicate badge "copy of IMG_2041" collapsed under the
  primary, pack with nested segments "pages 1–2 Police report"). Drag a card to another column → `move`; keyboard /
  test path: card menu **Move to…** (select) and **Exclude**. Group header actions: **Make a separate bundle**
  (`split-off`, suggested name), **Attach to CCG-…**.
* **Draft claim** (`DraftPanel.tsx`): sections Client · Driver · Client's car · Other side · Accident · Insurers ·
  Hire & repair · Witnesses. Each row: label, value, confidence bar, status chip (Conflict / Low confidence / Missing
  / Set by you / Invalid), source chip "V5C · p1" → provenance drawer, pencil to edit (`fields`). Circumstances shows
  its attribution ("Client's own words — accident report form, page 2" or "From the police report — not the client's
  account: please confirm"). Existing-person banner ("Same person as the client on CCG-… (licence) — use that record?"
  → `link-party`).
* **Conflicts** (`ConflictsPanel.tsx`, above the draft when any): per conflict the options as radio cards with value,
  every source chip, rank text ("best source: V5C"), the AI's note; **Use this**; panel button **Accept all
  preselected**. Register stays disabled while any is open.
* **Provenance drawer** (`ProvenanceDrawer.tsx`): file preview at the page (PDF `<iframe src="<fileUrl>#page=<n>">`,
  image `<img>`), the page text (`GET /intake/:itemId` `pageTexts[page-1]`) with the quote highlighted, confidence,
  engine (AI / read without AI / photo data / you), and all readings of this field across files.
* **Missing documents** (`ChecklistCard.tsx`): case kind, items with have / partial / missing and the file that
  satisfies each; preview of the request email; note "It is prepared after you register and waits for your approval".
* **Chronology** (`TimelineCard.tsx`): proposals with checkbox (`timeline/:id`), class badge (Record · Starts a
  deadline · You record this yourself — disabled, link "Offers" after register), sources.
* **Worth a look** (`RiskPanel.tsx`): "Only you see this. Nothing has been declined or reported." Signals with
  severity, plain message, files, claim links, **Noted** (ack with optional note).
* **Photos** (`PhotoStrip.tsx`): thumbnails with taken date/time (red outline when before the accident), plate chips
  (matched client / other side / not on this case), zone chips.
* **Register dialog** (`RegisterDialog.tsx`): "Register claim for Jane Doe" with `register.willDo` lines (creates the
  claim with N details · files M documents (K copies not filed twice) · adds T chronology entries · records damage on
  Z parts · prepares a request for X documents (you approve it before it is sent) · New case B becomes its own bundle ·
  2 files go to CCG-…), owner blockers with links, checkbox per group action, **Register**. On success: replace the
  page body with the **case brief**.
* **Case brief** (`CaseBriefView.tsx`): summary paragraph; key facts with sources; liability guide ("Your decision")
  with reasons and statements; missing documents + request status (link to the Needs-you item / outbox); "Call the
  client" reminder; Autopilot first steps (mode, status, sentence; "Autopilot is off" text when stopped); next
  actions; worth-a-look list; counts; **Open claim**.
* Polling: `GET …/progress` every 3 s while `readiness = 'reading'` or any file stage is in progress; refetch the
  detail when `revision` / `computedRevision` changes.

### 11.5 Other web insertions

* Needs-you panel `screens/needsYou/panels/BundleReadyPanel.tsx`, registered for `new_claim` in `kindPanels.ts`:
  renders only when `payload.bundleId` (else `null` → generic view for old per-item cards); shows the live
  `BundleSummary` (fetch), key fields, counts, blockers, **Open bundle**; the generic option buttons remain.
* Settings: `screens/settings/intake/IntakeSettingsPage.tsx` (all §4.17 settings in plain words; auto-register toggle
  with the explanation "Only when every key detail is confident, nothing conflicts, the AI has checked the bundle and
  nothing is worth a look. You still get a card to look it over."); link card in `SettingsPage.tsx` "Agents & AI".
* Claim Overview: `screens/claim/components/IntakeBriefCard.tsx` in `OverviewTab.tsx` (renders when
  `GET /claims/:id/intake-brief` is 200; collapsible).
* Damage model: `screens/claim/tabs/engineering/DamageModelPanel.tsx` passes `damage` built from
  `GET /claims/:id/damage-zones` (`{severity, confidence, source:'ai'}` per zone) instead of `NO_DAMAGE`. **No edit
  under `screens/engineer/damage3d/**`.**
* Daily log: `screens/dailyLog/DailyLogPage.tsx` renders `sections.intake` ("Intake") like the other optional
  sections; `api/agentsApi.ts` `DailyLog.sections.intake?: LogLine[]`.
* `api/intakeApi.ts`: `IntakeDocSummary.kind` adds `'archive'`; the Single files tab shows "Unpacked (n files)".
* Copy guard: `screens/copyGuard.test.ts` adds folder `intake` and a pattern list that fails on
  `/fraud|fraudulent|fake|forg|dishonest|\blie\b|lying|scam|suspicious|staged/i` in intake screens.

---

## 12. Daily log

`apps/api/src/intake/bundles/dailyLog.ts` `intakeDailyLogSection(ctx, day, {start, end}) → { intake?: LogLine[] }`,
spread into `compileDailyLog` sections (`agent/dailyLog.ts`, beside the Autopilot/Knowledge sections; `DailyLog`
type gains `intake?: LogLine[]`). One line per bundle per event (agent `intake`, link `/intake/bundles/<id>` or the
claim):

* "Read 12 files for bundle 'Jane Doe – Corsa crash': 2 cases found, 1 file belongs to CCG-2026-00031."
* "Bundle 'Jane Doe – Corsa crash' is ready for you: 2 details conflict, 3 documents missing." (waiting)
* "Registered CCG-2026-00042 from 'Jane Doe – Corsa crash' (9 documents filed, 2 copies not filed twice, 5
  chronology entries)." — `why` = "you pressed Register" / "registered automatically (Settings > Intake)".
* "Attached 2 files to CCG-2026-00031."
* "Prepared a request for 3 missing documents on CCG-2026-00042 — waiting for your approval."
* "AI check of 'X' waiting: agents are paused." (problems section when > 24 h)
* "Unpacked photos.zip (6 files, 1 skipped)", "Split scan.pdf into 3 documents".

`RECORD_LABEL` gains `'intake.bundle.register': 'claim registered from documents'`, `'intake.bundle.attach':
'documents attached to the claim'`, `'intake.damage_observation': 'damage recorded from photos'`. The headline is
unchanged; registered-claim counts appear in the section only.

---

## 13. Audit actions

All through `appendAudit` (actor = owner or `agent:intake`, `runId` for AI runs):
`intake.bundle.create`, `intake.bundle.rename`, `intake.bundle.add_files`, `intake.bundle.move_file`,
`intake.bundle.exclude_file`, `intake.bundle.include_file`, `intake.bundle.unsplit`, `intake.bundle.set_field`,
`intake.bundle.clear_field`, `intake.bundle.choose_conflict`, `intake.bundle.accept_preselected`,
`intake.bundle.confirm_new`, `intake.bundle.link_party`, `intake.bundle.tick_timeline`,
`intake.bundle.untick_timeline`, `intake.bundle.ack_signal`, `intake.bundle.split_off`, `intake.bundle.think_again`,
`intake.bundle.reconcile`, `intake.bundle.reason`, `intake.bundle.register`, `intake.bundle.register_retry`,
`intake.bundle.attach`, `intake.bundle.cancel`, `intake.bundle.reopen`, `intake.bundle.request_docs`,
`intake.bundle.file_copy`, `intake.unpack`, `intake.split_pack`, `intake.damage_observation`, `intake.settings`.
Existing actions continue to fire underneath (`evidence.upload`, `claim.create`, `event.append`, `intake.apply`,
`intake.attach_claim`, `outbox.draft`, `needs_you.resolve`, `memory.create`). Audit `after` never contains page text;
values only where the existing `intake.apply` already records them.

---

## 14. Settings

`GET/PATCH /settings/intake` (§8.2), stored in `agent_settings.intake`, merged by `mergeIntakeSettings`, audited
`intake.settings`, human-only. Defaults §4.17: auto-register **off**; prepare missing-documents request **on**; folder
bundles **on**; quiet period 20 s; AI reasoning ≤ 3 runs per bundle per day (owner "Think again" exempt); split on
(≥ 2 pages); near-duplicate photo distance 6, near-text Jaccard 0.9; photo tolerance 2 h; GPS outlier 2 km; archives
≤ 200 entries, ≤ 2 GiB, depth 2, ratio 200. Per-job AI model/effort for `intake.bundle_reason` in Settings > AI (existing
per-job mechanism via `AI_JOB_DEFAULTS`).

---

## 15. Security and privacy

* Every document reaches a model only inside untrusted blocks (gateway escaping, `_base/untrusted.md`); bundle
  reasoning has **no tools** and **no read access**; it never sees other claims, signals or settings.
* ZIP limits (§5.2), no filesystem paths from archives, entries staged like uploads; encrypted PDFs are not split.
* Image decoding bounded (`maxResolutionInMP`, `maxMemoryUsageInMB`, size cap); HEIC never decoded.
* Private data never in the repo: all test documents are generated at test time with invented names ("Jane Doe",
  "Ali Example"), invented references and `example.test` addresses; no binary fixtures; no real plates beyond the
  existing synthetic ones used in fixtures.
* Tests never call a real model or network: `AI_DRIVER=fake`, `CLAIMDESK_FORBID_REAL_AI=1`, FakeDriver fixtures,
  injected transports (existing test harness); no geocoding.
* Copy: no screen or server message may advise on insurers' offers (existing guard) or describe the client or a
  document as fraudulent/fake (new guard, §11.5, §4.11).
* Append-only: `intake_bundle_decisions`, `intake_bundle_reasonings`, `claim_damage_observations`,
  `intake_extractions`; evidence write-once (originals stay claimless; the claim gets copies via the evidence store).

---

## 16. Test plan

All tests run with the existing harness (`createTestApp(now, {config:{aiDriverOverride:'fake'}})`, worker drain helpers
in `apps/api/src/test/fixtures/intake/helpers.ts`, `JOBS_ENABLED` never set). New helpers in
`apps/api/src/test/fixtures/smartIntake/files.ts` and `scenario.ts`.

### 16.1 Domain (`packages/domain/src/intake/smart/*.test.ts`)

* `classify`: each doc type from a synthetic text; email defaults to correspondence; confidence ≤ 0.85.
* `ruleExtract`: VRM/VIN/licence/postcode/phone/email/date/refs/police ref/CCG ref/bank detection with page + quote;
  roles per doc type; no value above 0.85.
* `keys` + `group`: two cases mixed (strong keys) → main + case:B; an insurer letter with a CCG ref → `claim:<id>`;
  a possible match (score 5–9) stays new with reason; unkeyed photos → only case / near accident date / unsure; pins
  and exclusions win; stop list removes company/fleet identifiers; contradiction warning; deterministic ordering.
* `ranking` + `compat` + `reconcile`: VIN V5C vs estimate → conflict, V5C preselected, why text; "J Doe" vs "Jane
  Doe" compatible; date vs datetime same day compatible; VRM one char off = conflict; owner `set_field` wins and
  resolves; `accept_preselected`; low-confidence status; invalid values kept as alternatives only.
* `checklist`: each case kind; licence back partial; damage photos partial; signed hire docs partial; MOT age rule;
  request text contains every missing item and no banned phrases.
* `timeline`: letter_in / email_in / handling_ref_received / estimate_received / owner_only never ticked; pre-accident
  dated docs unticked; AI merge by day; stable ids.
* `signals`: every code positive and negative; tolerance boundaries; acknowledgements; banned-word test over all
  templates and titles.
* `phash`: identical 0; resized/requantised synthetic gradient ≤ 6; different > 20. `duplicates`: four link kinds;
  primaries. `split`: page-of-total, type change, size change, blank separators, merge, `< 2 → []`;
  `validateSegments` rejects gaps/overlaps. `photo`: plate matching, haversine, outliers, estimate lines → zones.
  `registrable`: every blocker. `briefText`: template; `verifySummary` rejects an invented plate. `settings`: merge
  + clamps.

### 16.2 DB (`packages/db/src/repos/intakeBundles.test.ts`, `migrationOrder.test.ts`)

Migration applies on a fresh DB and on a DB at 0014; journal order guard incl. 0015; triggers refuse UPDATE/DELETE on
the three append-only tables; folder-key unique index is case-insensitive and ignores closed bundles; `casBundleStatus`
only one winner; `addBundleFile` idempotent; `bestIntakeExtraction` prefers AI rows; `agent_settings.intake` default
`{}`.

### 16.3 Synthetic files (`apps/api/src/test/fixtures/smartIntake/files.ts`, generated at test time)

* Text PDFs through `@ccguk/documents`'s pdf-lib (the existing `makeTextPdf` / `makeBlankPdf` pattern): V5C (A),
  claim form / accident report signed by the client with circumstances ≥ 40 chars and "Witnesses: none" (A), police
  report + bodyshop estimate (VIN one char different) + MOT certificate as **one 4-page text pack** (A), insurer
  acknowledgement letter (TP insurer ref `TPI/778812`, policy, TP driver, LM19 XYZ) (A), V5C + insurer letter (B:
  "Ali Example", YB68 KDL), insurer letter quoting `CCG-2026-00001` and that claim's registration (existing claim).
* An "edited" estimate PDF: generated, then `stampPdfMetadata` (documents) with Producer "iLovePDF" and ModDate 30 days
  after CreationDate, plus an incremental save (append an update section with pdf-lib `save({useObjectStreams:false})`
  on load+modify) → `PDF_*` info signals.
* An insurer letter rendered with `renderPdf` (documents, Chromium at `CHROMIUM_PATH`; the test is skipped with a
  logged reason only when no Chromium is resolvable — the existing `resolveChromium()`), so one PDF has a real
  producer string.
* A **blank 3-page "scanned" pack** (`makeBlankPdf(3)`) whose fixture returns `segments` (licence p1, insurance
  certificate p2–3).
* PNGs with EXIF: `pngjs` encodes a synthetic picture (drawn rectangles/gradients), then an `eXIf` chunk (TIFF header
  + IFD0 → ExifIFD `DateTimeOriginal`, GPS IFD lat/lon) is inserted before `IEND` with the CRC from `zlib.crc32`
  (Node ≥ 22.2; else a 20-line table CRC). Unit test first asserts `extractExif` reads it; if exifr cannot read PNG
  `eXIf`, the helper emits a JPEG (`jpeg-js` encode + APP1 EXIF) instead and the test says so. Photos: `IMG_2041`
  (accident day +20 min, GPS near the others), a **resized copy** `IMG_2041 (1)` (half size, re-encoded → near
  duplicate), `IMG_1999` (3 days before the accident → `PHOTO_BEFORE_ACCIDENT`), `IMG_2050`, a licence-front
  photo (A).
* A `.zip` (fflate `zipSync`) with `IMG_2041.png` (exact duplicate), `IMG_2050.png`, `__MACOSX/._IMG_2050.png`
  (ignored), `notes.txt` (client phone number).
* An `.eml` (existing `makeEml`) from `claims@tp-insurer.example.test` with the acknowledgement PDF attached and a body.
* For `CONTACT_ON_OTHER_CLAIM`: a claim created first via `POST /claims` (FNOL fixture variant) whose claimant has
  Jane's phone number.

### 16.4 API tests (`apps/api/src/test/smart-intake-*.test.ts`)

* `smart-intake-bundles.test.ts` — create/list/rename; multipart ≤ 10 + JSON `{uploadId}` / `{importId}` /
  `{evidenceId}`; `already_in_bundle`; same file in two bundles; progress endpoint; cancel/reopen; 404/400 shapes.
* `smart-intake-pipeline.test.ts` — ZIP unpack (limits: too many entries, ratio, encrypted entry, nested depth;
  `__MACOSX` skipped); EML attachments join the bundle; PDF metadata; pHash stored; rules reading row
  (`schemaId intake_rules/1`, extras engine rules) for every text item; `bestIntakeExtraction` keeps the AI row after a
  process retry; text-pack split → 3 segment items/evidence with page ranges; AI segments split; unsplit; existing
  `intake-pipeline.test.ts` and `intake-apply.test.ts` stay green (claim-linked behaviour unchanged).
* `smart-intake-reconcile.test.ts` — grouping (main / case:B / claim / unsure) with reasons; move + exclude pins;
  duplicates linked; conflicts VIN + DOB preselected by rank; provenance (file, page, quote) for registration; checklist
  missing items + request text; timeline proposals; signals (before-accident photo, PDF edited, contact on another
  claim, plate not on case); liability preview; blockers; stale revision jobs exit.
* `smart-intake-ai-paused.test.ts` — agents off: per-file AI and reasoning wait (`reasoning.status waiting_ai`,
  reason `agents_off`); draft from rules; owner can register; auto never; switching agents on drains and improves the
  draft (AI candidates, verified quotes, capped unverifiable quote); `usage_limited` fixture → `wait_usage`; kill switch.
* `smart-intake-register.test.ts` — blockers (409 with list); accept preselected; FNOL_INCOMPLETE passthrough when
  witnesses unanswered; register → claim fields, evidence kinds, duplicates not filed, segments filed, chronology
  events with evidence ids, damage observations + `GET /claims/:id/damage-zones`, leftover groups split off, request
  draft → drain review → Needs-you `missing_info`; no email → `question`; `claimChanged` queued `clash.check` and
  `autopilot.tick`; audit rows; retry after an injected failure in step 7 is idempotent; corrections recorded (memory
  item) and `knowledge.observe` capture produces a `corrections` row (`target_kind intake_field`).
* `smart-intake-attach.test.ts` — attach main / a claim group; proposals auto vs confirm; one bundle `confirm_fields`
  card; resolver applies by proposal ids; checklist against claim evidence.
* `smart-intake-auto.test.ts` — setting off → `new_claim` card (bundle payload), resolver `register` works; setting on
  + clean bundle (fixture) → `intake.bundle_register` as `agent:intake`, `question` card raised, daily log line; with a
  signal / conflict / AI not done / kill switch / shadow mode → not registered and blockers explain why.
* `smart-intake-folder.test.ts` — `inbox\intake\Jane Folder Test\` (temp `CLAIMDESK_INBOX_DIR`) scanned twice with
  injected `nowMs` → bundle (source folder) with all files; folder names differing only by case join the same open
  bundle; closed bundle → "(2)"; claim-reference folders keep today's behaviour.
* `smart-intake-perimeter.test.ts` — an agent run token gets `AGENT_FORBIDDEN` on every bundle route; register /
  attach / settings are in `HUMAN_ONLY_ROUTES`; signals never appear in `buildCaseBrief` or any outbox body; banned
  words absent from every signal/blocker/daily-log string produced in the scenario.
* `daily-log.test.ts` (extended) — `sections.intake` lines.
* `strict-schema.test.ts` / `supreme-contracts.test.ts` keep passing with the new schema and job types.

### 16.5 Web tests (`apps/web`)

`bundleModel.test.ts` (readiness text, group labels, blocker text, conflict option ordering, provenance label,
checklist summary, `willDo` lines, upload batching ≤ 10 + chunk threshold), `uploadQueue.test.ts` (batching,
concurrency 2, folder entry walk with a fake `FileSystemEntry`), `BundlesListPage.test.tsx`, `BundlePage.test.tsx`
(mocked fetch with a full `BundleDetail` JSON fixture: board renders groups; **Move to…** calls `move`; Register
disabled while a conflict is open, **Accept all preselected** calls the route; provenance drawer shows the quote;
risk panel copy; register success shows the brief), `BundleReadyPanel.test.tsx` (renders only for `bundleId`),
`IntakeSettingsPage.test.tsx` (PATCH body), `IntakeBriefCard.test.tsx`, DamageModelPanel test (zones passed; damage3d
untouched), DailyLog intake section, copy guard. Existing `IntakePage.test.tsx` / `intake.test.ts` unchanged and green.

### 16.6 End-to-end scenario (`apps/api/src/test/smart-intake-e2e.test.ts`)

1. Seed: claim `CCG-2026-00001` (existing FNOL fixture); a second claim whose claimant has Jane's phone. Agents
   **off**.
2. `POST /intake/bundles {name:'Jane Doe – Corsa crash'}`; upload batch 1 (10 files: V5C, claim form, licence photo,
   IMG_2041, IMG_2041 (1), IMG_1999, text pack, edited estimate, `.eml`, `photos.zip`), batch 2 (blank scanned pack,
   B-V5C, B-letter, letter for CCG-2026-00001, rendered insurer letter) — one of them via the chunked upload
   (`{uploadId}`).
3. Drain (cpu/io only). Assert: ZIP unpacked (duplicate IMG_2041 linked `same_file`), resized copy `near_photo`, text
   pack split in 3, EML attachment in the bundle, rules draft has `vehicle.registration` KX21ABC from the V5C (page 1,
   quote) and the VIN conflict (V5C vs estimate, V5C preselected); groups: main, `case:B` ("Ali Example — YB68 KDL"),
   `claim:<CCG-2026-00001>`; reasoning `waiting_ai` (`agents_off`); `canRegister` false only because of conflicts;
   auto not eligible.
4. Switch agents on (fake). Drain all. Assert: AI extractions (photo plates `KX21 ABC` matched client; zones), blank
   pack split into licence + insurance certificate by AI segments, bundle reasoning stored with checks (1 capped
   quote), DOB conflict (licence vs claim form) preselected licence, timeline proposals (police note, letter_in,
   email_in, estimate_received; owner_only none ticked), signals: `PHOTO_BEFORE_ACCIDENT`, `PDF_EDITED_AFTER_CREATION`,
   `PDF_EDITOR_PRODUCER`, `CONTACT_ON_OTHER_CLAIM` — and **no** auto-registration (setting off); Needs-you `new_claim`
   with `bundleId`.
5. Owner: corrects `client.phone` (correction), acks one signal, unticks one timeline item, `split-off` group B (new
   bundle "Ali Example"), then `POST …/register {acceptPreselected:true, groups:{'claim:<id>':'attach'}}`.
6. Assert register result and the claim: claimant, DOB from the licence, vehicle KX21ABC + V5C VIN, TP LM19XYZ,
   at-fault insurer + ref, accident time from the police report, injuries false, services.hire; evidence kinds (v5c,
   licence, photo ×3 (no duplicates), estimate, correspondence, document, signed_document, mot_certificate,
   insurance_certificate); chronology `fnol` + ticked events with evidence ids; damage zones endpoint; the letter for
   CCG-2026-00001 filed there; bundle B open; outbox `doc_request` draft → after drain Needs-you `missing_info`;
   `clash.check` + `autopilot.tick` queued; brief: summary, liability guide, missing list, call reminder, Autopilot
   steps, signals; memory correction + (after `knowledge.observe`) a `corrections` row; daily log `sections.intake`
   lines; audit trail complete; append-only tables refuse UPDATE.
7. Second bundle "Clean Case" (consistent documents, no signals, fixture reasoning) with auto-register **on** →
   registered by `agent:intake`, `question` card, daily log "registered automatically"; same bundle with the kill
   switch on → not registered, blocker `POLICY_ASKS`.

### 16.7 Verification (both slices; from `/home/user/logo/claimdesk`)

`pnpm install --frozen-lockfile` (server slice updates the lockfile for the three dependencies; retry on install
collisions); `pnpm -r typecheck`; `pnpm -r --no-bail test` (counts ≥ the baseline recorded before changes plus the new
tests; report any failure honestly — never skip or disable a test); `pnpm --filter @ccguk/web exec vite build --outDir
<scratch>/webdist`; `node packaging/launch.test.cjs`. Manual run: own `PORT` and `DATA_DIR` under
`/tmp/claude-0/-home-user-logo/811a135a-35cb-5723-858d-e84fbd9027fa/scratchpad/intake2/<slice-key>/`, login
`courtesycars` / `CourtesyCars123!`, Playwright via `playwright-core` resolved from `packages/documents` with
`CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; kill only PIDs you started; no state-changing git.

---

## 17. Build slices (exactly two, disjoint file ownership)

Both slices start from the same green tree and build **in parallel** against §8 (API contract) — the web slice never
needs server code to compile or test (it mocks HTTP). Integration: run the full verification (§16.7) after both land;
the server slice owns the E2E. Neither slice edits `apps/web/src/screens/engineer/damage3d/**`.

### 17.1 `intake-server` — `packages/domain`, `packages/db`, `apps/api` (+ lockfile, docs)

**New files**
* `packages/domain/src/intake/smart/{types,classify,ruleExtract,keys,group,ranking,compat,reconcile,checklist,timeline,signals,phash,duplicates,split,photo,registrable,briefText,settings,index}.ts` + tests.
* `packages/db/drizzle/0015_smart_intake.sql`; `packages/db/src/repos/intakeBundles.ts` (+ test).
* `apps/api/src/intake/{archive,image,rules,split}.ts`; `apps/api/src/intake/bundles/{service,hooks,claimIndex,candidates,recompute,signalsInput,reason,register,attach,file,splitOff,folder,requestDocs,damage,brief,corrections,dailyLog,views}.ts`.
* `apps/api/src/routes/intakeBundles.ts`; `apps/api/src/agent/prompts/intake-bundle.md`.
* `apps/api/src/ai/fixtures/intake/{smart-extract,bundle-reason}.json`.
* `apps/api/src/test/smart-intake-*.test.ts`; `apps/api/src/test/fixtures/smartIntake/{files,scenario}.ts`.
* `docs/RELEASE-NOTES-0.5-SMART-INTAKE.md` (what changed, settings, honest limits).

**Shared files this slice edits** (no other slice touches them)
* `packages/domain/src/agents/types.ts` (JOB_TYPES + JOB_TYPE_INFO ×4, DocType +2, ClaimFieldTarget +7,
  SENSITIVE_FIELD_TARGETS), `agents/results.ts` (IntakeExtraction +4 properties, new schema), `agents/settings.ts`
  (`AI_JOB_DEFAULTS['intake.bundle_reason']`), `packages/domain/src/intake/index.ts`.
* `packages/db/drizzle/meta/_journal.json`, `packages/db/src/schema.ts`, `packages/db/src/repos/index.ts`,
  `packages/db/src/repos/intake.ts` (`extras`, `bestIntakeExtraction`), `packages/db/src/repos/agentSettings.ts`,
  `packages/db/src/migrationOrder.test.ts`.
* `apps/api/src/intake/{pipeline,normalise,spec,targets,proposals,newClaimDraft,views,items}.ts`,
  `apps/api/src/agent/handlers/intake.ts` (handlers ×4, resolver branches), `apps/api/src/agent/prompts/intake.md`,
  `apps/api/src/agent/perimeter.ts` (`HUMAN_ONLY_ROUTES` +4), `apps/api/src/agent/dailyLog.ts` (section + labels),
  `apps/api/src/routes/index.ts` (register routes), `apps/api/src/routes/claims.ts` (export
  `previewFnolValidation(ctx, body)` reusing `resolveRefsForValidation`), `apps/api/src/mail/common.ts`
  (`copyEvidenceToClaim` optional `kind`), `apps/api/src/services/imports.ts` (`bundleFolder`),
  `apps/api/src/knowledge/learners/corrections.ts` (intake-field branch), `apps/api/src/ai/fixtures/intake/{intake-extract,ci-smoke}.json`,
  `apps/api/src/test/daily-log.test.ts` (extension), `apps/api/package.json` (+`pdf-lib@1.17.1`, `jpeg-js@0.4.4`,
  `pngjs@7.0.0`, `@types/pngjs` dev if needed), `pnpm-lock.yaml`.
* `docs/SMART-INTAKE.md` (status line only when done).

### 17.2 `intake-web` — `apps/web`

**New files**
* `apps/web/src/api/bundlesApi.ts` (all §8 types, client functions, React Query hooks/keys, polling rules) + test.
* `apps/web/src/screens/intake/IntakeHome.tsx`; `apps/web/src/screens/intake/bundles/{BundlesListPage,NewBundlePage,BundlePage,FilesBoard,DraftPanel,ConflictsPanel,ProvenanceDrawer,ChecklistCard,TimelineCard,RiskPanel,PhotoStrip,RegisterDialog,AttachDialog,CaseBriefView}.tsx`, `bundleModel.ts`, `uploadQueue.ts`, `bundles.css`, tests and a JSON fixture `__fixtures__/bundleDetail.json` (synthetic).
* `apps/web/src/screens/needsYou/panels/BundleReadyPanel.tsx` (+ test).
* `apps/web/src/screens/settings/intake/IntakeSettingsPage.tsx` (+ test).
* `apps/web/src/screens/claim/components/IntakeBriefCard.tsx` (+ test).

**Shared files this slice edits** (no other slice touches them)
* `apps/web/src/app/router.tsx` (routes of §11.1), `apps/web/src/screens/needsYou/kindPanels.ts` (`new_claim:
  BundleReadyPanel`), `apps/web/src/screens/settings/SettingsPage.tsx` (link), `apps/web/src/screens/claim/tabs/OverviewTab.tsx`
  (card), `apps/web/src/screens/claim/tabs/engineering/DamageModelPanel.tsx` (zones), `apps/web/src/screens/dailyLog/DailyLogPage.tsx`,
  `apps/web/src/api/agentsApi.ts` (`DailyLog.sections.intake`), `apps/web/src/api/intakeApi.ts` (`'archive'`),
  `apps/web/src/screens/copyGuard.test.ts`.

### 17.3 Contract freeze

§8 (routes + JSON), §9 payloads and `GET /daily-log` `sections.intake` are frozen for the build. A slice that needs a
change records it in its report as "contract change requested" instead of editing the other slice's files. The web
slice's mocked fixture must type-check against `bundlesApi.ts`; the server slice adds one API test that serialises a
real `BundleDetail` and checks every key of §8.1 is present (snapshot of key paths, not values), so drift is caught.

---

## 18. Honest limits

1. **Reading is not knowing.** Rules readings are pattern matches; AI readings can be wrong; scanned photos of
   documents may be unreadable. Every value shows its source and confidence; conflicts are never resolved silently.
2. **Sorting mixed uploads depends on identifiers.** Photos with no readable plate and no EXIF date land in "Not sure";
   two cases sharing a vehicle or a person may be joined — the warning says so and the owner moves files.
3. **No OCR without the AI.** With the AI paused, scanned PDFs and photos are stored and grouped by what can be known
   (EXIF, hashes), but not read; scanned packs are split only by the AI.
4. **Photo checks are hints.** Camera clocks are wrong, GPS is often stripped, editors resize photos innocently; no
   geocoding is bundled, so the place check compares photos with each other (and with coordinates printed in the
   documents) rather than with the accident address.
5. **PDF "edited" hints are weak.** Many genuine letters are produced or re-saved by editing tools.
6. **Registration still needs the call.** A document-led claim opens with the FNOL call items (account taken cold,
   recording disclosure, script questions) flagged; the brief puts the call first.
7. **Automatic registration is opt-in** and narrow by design; an automatically registered claim cannot be "un-created"
   (claims are never deleted) — it can be declined/closed by the owner like any claim.
8. **Large files.** ZIPs are streamed; PDFs are parsed up to 64 MiB and 200 pages of text (existing limits); images
   over 40 MB are stored but not hashed; photos over 20 MB are not sent to the AI (existing limit).
9. Everything in SD §T and AP §M still applies.

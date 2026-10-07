# ClaimDesk Supreme — Autopilot (claim lifecycle, fleet booking, clash detection, hire offers, signing, eligibility)

Design document (architect phase). Status: **agreed contract for the Autopilot slices in §K**. Date: 7 October 2026.
Baseline: ClaimDesk 0.4.x with **Supreme phase 1 landed** (`docs/SUPREME-DESIGN.md` §Q.1: `foundation`, `gateway`,
`runtime`, `mail`, `intake`, `casework`, `uploads-desktop`). Migrations at baseline: `0000`–`0011`.

This document is **additive** to `docs/SUPREME-DESIGN.md` (called "SD" below). It builds on SD's job queue (§C.3),
tool registry and dispatcher (§B.3), autonomy policy `decide()` (§D.2), Needs-you (§C.7), mail and outbox (§F, §D.3),
intake (§G), Case Brief and placeholders (§E.2, §E.3) and daily log (§J.2), and uses their names exactly. Where this
document changes an SD contract, the change is listed in §0.6 and nowhere else; everything not listed there is
unchanged. On any other conflict SD wins. The ground rules of `docs/ARCHITECTURE.md`,
`docs/TEMPLATES-VEHICLES-DESKTOP.md` and `docs/V03-MANAGER-MODE-HIRE-PRICING.md` still apply: TypeScript strict, NodeNext
`.js` import suffixes everywhere except `apps/web`, integer pence, ISO UTC dates printed in Europe/London, append-only
ledger/events/evidence/audit, GTA is a **benchmark only** (CCGUK is not a subscriber), no legacy company details, the
Word templates are filled and never rewritten, manager-mode overrides are audited and never available to agents.

**Privacy rule.** This file and every file it asks for contain no private data (no real claimant, insurer contact,
policy wording, password or key). Insurance criteria below are generic defaults the owner must check against the
real fleet policy wording in Settings.

**Tests never call a model.** Every test uses the `FakeDriver` (SD §A.4) and the fake mail transport
(`MAIL_TRANSPORT=fake`, SD §R.2); `CLAIMDESK_FORBID_REAL_AI=1` stays set in every vitest config.

---

## 0. The request and what we build

### 0.1 The owner's request

> "The software automation should be so good it should be like an employee: after getting all the details, check
> which cars are available for hire, offer hire, do whatever is required, create all necessary paperwork, check it
> doesn't clash (e.g. another car on hire with the same reg), like a proper system."

### 0.2 What "like an employee" means here, concretely

A competent CCGUK claims handler, given a new claim, would: take the details; decide whether the claim is worth
taking; check the driver can be insured on our cars; work out what car the client is entitled to (like for like) and
what they actually need; look at the fleet diary and find a car that is free, legal and insured for the **whole**
expected hire; hold it; offer it to the client; when the client says yes, book delivery, prepare the hire paperwork,
get it signed at handover; tell the other side's insurer; keep the hire reasonable; get the car back when the repair is
done; invoice; send the payment pack; chase; and put every offer and every payment in front of the owner. At every
step they would notice clashes: the same car booked twice, the same registration already on another hire, the same
person driving two of our cars, a policy that runs out mid-hire.

Autopilot gives ClaimDesk that behaviour with four pieces of new machinery, all on top of phase 1:

1. **Claim Autopilot** (§A): the lifecycle written down as data — 14 stages, ~45 steps with entry/exit criteria,
   required facts and documents, and deadlines — plus a pure state machine that says, for every claim at every moment,
   what is done, what is due, what is allowed and who we are waiting on. Code decides what is due and allowed; the
   model only fills judgement (wording, reading replies, choosing between options code has already allowed); every
   action goes through SD's autonomy policy with a per-step mode: **auto**, **ask me** (prepare and confirm) or **I do
   it** (owner/person only).
2. **Fleet booking system** (§B): reservations with periods (provisional hold with expiry → confirmed → on hire →
   returned), a fleet calendar, delivery and collection scheduling, readiness (valet, inspection, service, damage
   repair, MOT), and an **availability search** that ranks cars for a claim by like-for-like match, needs, readiness,
   insurance cover and class of use, compliance across the whole period, location and cost — reusing `canAllocate`
   and `hirePeriodsOverlap`.
3. **Clash detection** (§C): a complete catalogue of 34 pure checks, each classified block / warn / info and by
   override class (A manager override with audit, B relaxable, C never), run on every booking/hire/claim change and
   nightly, shown in the booking dialog, on the claim and in the daily log.
4. **Hire offer → acceptance → paperwork → signing** (§D, §E) and **eligibility** (§F): the autopilot proposes the
   best car, holds it, emails the offer with a like-for-like explanation, reads the client's reply, confirms the
   booking, schedules delivery, prepares every document for the stage, gets it signed in person on the PC (or by
   emailed PDF with automatic chasing and filing), creates the hire record from the signed paperwork, notifies the
   at-fault insurer, and later raises invoices, the payment pack and chasers — owner confirmation wherever the policy
   or the perimeter requires it.

### 0.3 What stays with people (honest)

* **Physical things**: handing over and collecting the car, looking at the licence, the condition walk-round. The
  system schedules them, prepares every form and records the result; a person does them and clicks "Handover done".
* **Signatures**: the client signs (in person on the PC/tablet, or wet ink on a printed PDF). E-signature stays
  human-only (`assertHuman`, SD §B.2 rule 5). There is no remote "sign on your phone" link without a public server
  (§E.6).
* **Agreements, forms, invoices, payment packs** are always-ask templates (SD §D.2): the autopilot prepares and
  reviews the whole pack; the owner approves it with one click.
* **Money, offers, settlements, legal**: always the owner (SD §D.1). Declining a claim and closing a file are
  owner-only status changes (SD §B.2 rule 4).
* **New client relationships** created from email are confirmed by the owner (SD §G.3, Needs-you `new_claim`).
* **Manager overrides** of any clash: a person in manager mode, with a reason, audited. Never an agent.

### 0.4 Key decisions

| Decision | Choice | Why |
|---|---|---|
| Lifecycle engine | Pure `planAutopilot(facts)` in `@ccguk/domain/autopilot` over a step catalogue held as data; plan is **derived** from records every tick, never the source of truth | Cannot drift from the file; testable; byte-identical for identical state |
| Who acts | A deterministic agent principal **`agent:autopilot`** (no model) executes due steps through the same dispatcher, tools, `decide()`, perimeter and routes as every other agent (SD §1.1 principle 2) | One door for every action; attributable in audit and daily log |
| Where the model is used | `autopilot.judge` (case manager: pick one of the options code allowed, write wording with `{{fact:…}}` placeholders), `hire_offer.parse_reply` (mail agent, no tools), and the existing drafter/reviewer | "Code decides what is due and allowed; AI fills judgement" |
| Booking truth | New `fleet_reservations` table is the single diary for every car (legacy hires back-filled); `hire_agreements` stays the legal/financial record created **at handover** from a confirmed reservation | Holds and future bookings without inventing agreement numbers or flipping cars to on-hire early |
| Race safety | Hold/confirm run in one synchronous `better-sqlite3` IMMEDIATE transaction **and** a SQLite trigger refuses overlapping committed periods for a car | Two claims (or the agent and the owner) can never get the same car for the same time |
| Clash checks | Pure `detectClashes(subject, world)`; findings persisted with dedupe keys; block findings enforced in routes through the existing manager-mode gate (`gateFor().refuse`) | Same override UX and audit as 0.3; agents get Needs-you `override_needed` |
| Hire offer to the client | Auto-sent only when the step is **green** (like for like, all checks pass, acceptance `accept`, driver eligible, need strong/moderate) and the commitment is verified by code against the held reservation; otherwise prepared and confirmed | Owner wants employee-like speed; the risky cases still come to the owner |
| Paperwork | Stage **packs** (data: which templates, variants, signer, when) generated by code from the claim, reviewed by the reviewer, approved by the owner in one Needs-you card | Agreements/forms are always-ask by perimeter; one click instead of ten |
| Signing on localhost | In-person kiosk on the PC (or a LAN tablet, off by default) with OTP to the client's email or shown to the handler, typed name + drawn signature; or emailed PDFs for wet/scanned signature with automatic chasing and matching of returns | No public URL needed; remote e-sign is listed as not built (§E.6) |
| Eligibility | Driver vs **per-policy** criteria (defaults editable), need, means, roadworthiness, PI referral — pure functions; result feeds availability (policy filter), green test and step gating | Uninsured driving is a hard stop; referrals go to the owner with evidence |
| Migrations | One file `0012_autopilot.sql`, journal `when` **1792250000000** (between phase 1's last and phase 2's reserved value) + an order guard so no migration is ever silently skipped | drizzle applies only `when` > last applied (verified in `drizzle-orm` sqlite dialect) |

### 0.5 Architecture

```
  inbound email ─▶ mail.ingest ─▶ mail.triage ─▶ (event) ───────────┐            owner (web app)
  intake file  ─▶ intake.* ─────────────────────────────────────────┤            │ Autopilot tab · Booking dialog
  owner/routes ─▶ bookings · hire-offers · packs · events ──nudge──┤            │ Fleet calendar · Movements
                                                                    ▼            │ Needs-you · Daily log · Kiosk
             ┌──────────── autopilot.sweep (5 min) / nudges ──▶ autopilot.tick(claim) ───────────────────────────┐
             │   facts = bundle + acceptance + gates + playbook + needs + eligibility + reservations + offers +  │
             │           packs + signatures + clash findings + outbox + open Needs-you/jobs + settings           │
             │   plan  = planAutopilot(facts)   (pure, @ccguk/domain/autopilot)                                  │
             │   diff  → autopilot_log (append-only)                                                              │
             │   for each due step (deadline order, ≤ 5 per tick):                                                │
             │     mode = effectiveMode(step, settings, claim overrides, green)                                    │
             │     auto    → executeTool(rc{agent:'autopilot', step}) → decide() → perimeter → route ─┐            │
             │     judge   → enqueue autopilot.judge (case_manager, options fixed by code) ──────────┤            │
             │     confirm → prepare drafts/pack → createNeedsYou(kind…)                             │            │
             │     owner   → createNeedsYou(autopilot_step, informational) + task                     │            │
             └─────────────────────────────────────────────────────────────────────────────────────────┘            │
     booking service (one IMMEDIATE txn + overlap trigger) ◀── booking_hold / confirm / movement / handover ◀──────┘
     clash service: detectClashes() on every write + clash.check jobs + clash.sweep 02:30
     pack.prepare → document_draft / docx_document_draft → review.check → approve_pack (owner) → outbox → SMTP
```

### 0.6 Changes to SD contracts (the complete list)

All are additive or optional; phase-1 tests must pass unchanged except where a test enumerates a list that grows.

| SD section | Change |
|---|---|
| §C.1 `AgentName` | add `'autopilot'` (deterministic; never runs a model) |
| §C.2 job types | add the 13 types in §H.1 to `JOB_TYPES` / `JOB_TYPE_INFO`; `AI_JOB_DEFAULTS` gains `autopilot.judge`, `hire_offer.parse_reply` |
| §C.7 `NeedsYouKind` | add `choose_car`, `approve_pack`, `confirm_signed`, `clash_review`, `eligibility_review`, `autopilot_step` |
| §D.2 `EmailKind` | add `hire_offer`, `booking_update`, `signature_request`, `insurer_notice`; default `autoSendEmailKinds` gains `booking_update`, `insurer_notice`, `hire_offer` (the last only passes with a verified commitment, §D.3) |
| §D.2 `autoSendTemplates` | default gains `letter.hire_start_notice`, `letter.booking_confirmation`, `letter.signature_chase` |
| §D.2 `ActionDescriptor` | optional `step?: { id: string; mode: StepMode; green: boolean }` and `commitment?: { kind: 'hire_offer' \| 'delivery_slot'; refId: string; verified: boolean; reasons: string[] }` — set by code only (dispatcher / outbox decision path), never from model input |
| §D.2 rules | new rule 4a `step_owner_only` (deny) and 4b `step_confirm` (ask) after `untrusted_source`; rule 13 `touches` ignores `newCommitment` when `commitment.verified && step.mode === 'auto'` |
| §B.3 `RunContext` | optional `step?: { id: string; mode: StepMode; green: boolean }`; `executeTool` copies it onto the descriptor |
| §B.2 perimeter | new human-only routes and claim-scope resolution for booking/offer/pack/movement ids (§H.5) |
| §B.4 tool catalogue | new tools in §H.2; `offer_record` re-pointed to the settlement-offer register (§D.9) |
| §E.2 Case Brief | optional `autopilot` section and `booking.*`/`offer.*` facts (§A.10) |
| §J.2 `DailyLog` | optional sections `autopilot`, `fleet`, `clashes` (§I.9) |
| §N migrations | `0012_autopilot` takes journal `when` 1792250000000; phase 2 and 3 keep their `when` values (1792300000000, 1792400000000) and take the next free file numbers (`0013_engineer_calls_sms`, `0014_learning`) — the `when` values are the contract, tags are file names (§G.1) |
| SD outbox table | `ALTER TABLE outbox ADD autopilot_step_id text` (which step created a draft) |

---

## A. Claim Autopilot

### A.1 Lifecycle stages

The stage is **derived** (the first stage, in order, whose exit criteria are not met among the applicable ones). Hire
stages (6–11) are skipped when no hire is needed (client has another car, accepted the insurer's car, or only repair
is claimed); `vehicle_secured` runs in parallel with the hire stages and is shown as the stage only when there is no
hire. Deadlines use `@ccguk/domain` calendar functions (`addWorkingDays`, bank holidays, Europe/London).

| # | Stage | Entry | Exit (all) | Required facts / documents | Deadlines (clock or rule) | Status set by autopilot |
|---|---|---|---|---|---|---|
| 1 | `enquiry` | inbound email/call/intake item with FNOL-like content | claim exists (owner confirmed `new_claim`) | contact, accident date, client registration | acknowledge same day (4 business hours) | — |
| 2 | `intake` | claim created | `validateFnol` passes; injury routed (`routeInjury`); cross-file clash check run with no open **block**; hire needs captured (§F.3) | cold account, place/time, TP reg/insurer, driveable?, need answers, client email/phone | CCTV request within 7 days (`cctv_preservation`) | `fnol` |
| 3 | `qualification` | intake exit | acceptance decision recorded (`accept`, or `accept_with_conditions` with conditions tracked, or owner `decline`); driver eligibility `eligible` (or `refer` resolved by owner); need assessed | driver profile (DOB, full licence since, points), liability evidence | same working day (soft) | `triage` |
| 4 | `sign_up` | accepted | CCGUK-01 signed (+ CCGUK-09; + CCGUK-02 when recovery/storage/engineer needed); `services_agreed` event; NCAF sent | signed documents | NCAF 1 WD from services agreed (`gta_4_1_ncaf_1wd`); handling ref 5 WD (`gta_4_2_handling_ref_5wd`) | `accepted` |
| 5 | `vehicle_secured` | accepted | car located; recovery/storage recorded if not driveable; engineer instructed (`engineer_instructed` event) | car location, supplier | engineer instruction 1 WD after sign-up; inspection chase 3 WD after instruction | — |
| 6 | `hire_search` | qualification exit, hire needed, need date within the look-ahead (default 3 days) | a reservation held or confirmed for the claim | needs, projected period, client car GTA group | hire need date | — |
| 7 | `hire_offer` | reservation `held` | offer accepted (reply or phone) — or declined → back to 6 | client contact | hold expiry (default 24 h), reminder at 4 h | — |
| 8 | `hire_booked` | offer accepted | reservation `confirmed`; delivery movement planned and client told; hire-start pack approved and given to the client | delivery address, slot | delivery date | — |
| 9 | `handover` | delivery due | pack signed; release condition report done; hire record created (`hire_started`); at-fault insurer notified | signed CCGUK-03 (hirer), Sch 3 form, express request, CCGUK-06 release, licence evidence, DVLA check ≤ 14 days | insurer notice 1 WD after start | `hire_active` |
| 10 | `on_hire` | hire started | an off-hire trigger recorded (repair complete, TL payment, termination notice, cash in lieu, client returned, replacement bought) | — | GTA 4.10 3 WD, 4.11 5 WD monitoring; weekly client check | `hire_active` / `repair` / `total_loss` |
| 11 | `off_hire` | off-hire trigger | car collected; return condition report; hire ended at the trigger-correct time; reservation `returned` | odometer in, fuel, damage | `offHireDeadline` (24 h / 1 WD / 5 WD) | `payment_pack` |
| 12 | `billing` | all hires ended, storage ended or none, report issued (or interim allowed) | invoices approved; `claimed`/`invoiced` ledger rows written (by the owner); payment pack sent | invoices, hire period validation, payment direction | send pack within 2 WD of hire end (default) | `payment_pack` |
| 13 | `recovery` | payment pack sent | every head paid, settled or written off (owner) | — | chasers 7/14/21, complaint 28, ICOBS 3 months, GTA 6.7/6.8 | `chasing` |
| 14 | `closure` | heads resolved | `closureReadiness` true and owner closes | client paid (PAV/excess), fleet car back, storage ended, no open PCN for the hire period | — | (owner sets `settled`/`closed`) |

Terminal and side stages: `declined` (owner), `closed` (owner), `legal` (status `pre_action`/`litigation`, owner;
autopilot only drafts and asks). While `legal`, the autopilot keeps clocks, chasers and hire housekeeping but never
sends anything to the other side automatically.

### A.2 Data model (`packages/domain/src/autopilot/types.ts`, created by `ap-foundation`)

```ts
import type { ClaimStatus, ClockKind, ISODateTime, Id } from '../types.js';
import type { EmailKind, NeedsYouKind, ToolName, Basis } from '../agents/types.js';
import type { ClashCode } from '../clash/types.js';
import type { PackStage } from '../signing/types.js';

export type StageId = 'enquiry' | 'intake' | 'qualification' | 'sign_up' | 'vehicle_secured' | 'hire_search' | 'hire_offer'
  | 'hire_booked' | 'handover' | 'on_hire' | 'off_hire' | 'billing' | 'recovery' | 'closure';
export type TerminalStage = 'declined' | 'closed' | 'legal';
export const STAGE_ORDER: readonly StageId[];                       // the 14 in table order

export type TrackId = 'intake' | 'qualify' | 'signup' | 'notify' | 'vehicle' | 'hire' | 'money' | 'close';
/** auto = act (still through decide()); confirm = prepare + Needs-you; owner = a person does it (agents denied). */
export type StepMode = 'auto' | 'confirm' | 'owner';
export const STEP_MODE_RANK: Readonly<Record<StepMode, number>> = { auto: 0, confirm: 1, owner: 2 };
export type Performer = 'code' | 'ai_wording' | 'ai_judgement' | 'person';
export type StepStatus = 'not_applicable' | 'upcoming' | 'due' | 'in_progress' | 'waiting' | 'blocked' | 'done'
  | 'skipped' | 'paused' | 'failed';
export type WaitingOn = 'client' | 'insurer' | 'engineer' | 'repairer' | 'supplier' | 'owner' | 'handler' | 'time' | 'agent';

export type AutopilotStepId = (typeof AUTOPILOT_STEP_IDS)[number];   // the ids in §A.3, as a const list

export type PredicateId = string;     // key into PREDICATES (autopilot/predicates.ts); unknown id = test failure
export type RequirementId = string;   // key into REQUIREMENTS (what is missing, in plain English, and how to ask)

export interface StepDeadline {
  clock?: ClockKind;                                   // use the claim's running clock of this kind
  fromFact?: string;                                   // else: from this fact (e.g. 'event.engineer_instructed.at')
  workingDays?: number; hours?: number; days?: number;
  businessHoursOnly?: boolean;
}

export type StepAction =
  | { kind: 'tool'; tool: ToolName; build: string }                   // build = InputBuilderId (code builds the input)
  | { kind: 'draft'; templateId: string | null; emailKind: EmailKind | null; actionCode: string; recipient: 'client' | 'at_fault_insurer' | 'supplier' | 'engineer' }
  | { kind: 'pack'; stage: PackStage }
  | { kind: 'judge'; question: JudgeQuestionId; options: string }     // options = OptionBuilderId
  | { kind: 'needs_you'; needsYouKind: NeedsYouKind }
  | { kind: 'status'; status: ClaimStatus }
  | { kind: 'none' };

export interface StepDef {
  id: AutopilotStepId; track: TrackId; stage: StageId; title: string; performer: Performer;
  floor: StepMode;                 // settings can never make the step less strict than this
  defaultMode: StepMode;           // ≥ floor
  appliesWhen: PredicateId;        // false → not_applicable
  after: AutopilotStepId[];        // dependencies (must be done/skipped/not_applicable)
  readyWhen: PredicateId[];        // entry criteria (all)
  doneWhen: PredicateId;           // exit criterion (re-evaluated every tick; a done step can re-open)
  waitingOn?: { who: WaitingOn; when: PredicateId };
  requires: RequirementId[];       // missing → blocked + missing_info preparation
  blockingClashes: ClashCode[];    // open block findings with these codes block the step
  deadline?: StepDeadline;
  action: StepAction;
  actionCode?: string;             // playbook code shared with case.review / drafter (§A.10)
  templateIds?: string[];
  basis: string[];                 // citations; GTA always labelled as benchmark
}

export type JudgeQuestionId = 'choose_car' | 'offer_wording' | 'repair_status_from_message' | 'need_still_exists'
  | 'delivery_slot_from_reply' | 'choose_recovery_supplier';

export interface StepOption { id: string; label: string; detail: string; recommended: boolean }

export interface StepState {
  id: AutopilotStepId; status: StepStatus; mode: StepMode; modeReasons: string[]; green: boolean;
  waitingOn?: WaitingOn; dueAt?: ISODateTime; overdue: boolean; since?: ISODateTime;
  missing: string[];
  blockedBy: Array<{ kind: 'clash' | 'step' | 'requirement' | 'eligibility' | 'acceptance' | 'gate' | 'paused'; code: string; message: string }>;
  options?: StepOption[];          // for judge / choose_car steps
  refs: { reservationId?: Id; hireOfferId?: Id; packId?: Id; movementId?: Id; hireId?: Id; outboxIds?: Id[];
          documentIds?: Id[]; needsYouId?: Id; jobId?: Id };
  next: string;                    // one plain-English sentence: what happens next / what we are waiting for
}

export interface AutopilotPlan {
  version: 'autopilot/1'; claimId: Id; evaluatedAt: ISODateTime;
  stage: StageId | TerminalStage; stageIndex: number;            // 1..14, 0 for terminal
  mode: 'on' | 'paused' | 'off';
  steps: StepState[];               // catalogue order
  due: AutopilotStepId[];           // ordered: overdue first, then dueAt, then catalogue order
  waiting: AutopilotStepId[]; done: AutopilotStepId[];
  nextCheckAt: ISODateTime;         // earliest of: next deadline, next wait timeout, now + 6 h
  planHash: string;                 // sha256 of the stable JSON (sorted keys) without evaluatedAt
}

export interface AutopilotOverride { action: 'skip' | 'ask' | 'auto' | 'done' | 'snooze'; until?: ISODateTime; reason: string; by: string; at: ISODateTime }
```

### A.3 Step catalogue (`packages/domain/src/autopilot/steps.ts`, data; owned by `ap-autopilot`)

Mode column: default / floor (`A` auto, `C` confirm, `O` owner). "Green" (§D.1) can only *raise* a mode. Templates in
`code` font exist today unless marked **new** (§D.6).

| Step id | Track · stage | Performer | Mode | Ready when → done when | Waiting on / deadline | Action |
|---|---|---|---|---|---|---|
| `intake.new_claim` | intake · enquiry | person | O/O | intake `new_claim` item open → claim exists | owner | SD Needs-you `new_claim` (existing) |
| `intake.acknowledge` | intake · intake | ai_wording | A/A | claim + client email, no ack → `email_out` kind `ack` | 4 business hours | draft `ack` to client |
| `intake.complete_fnol` | intake · intake | code | A/A (asks via missing_info) | claim → `validateFnol` ok and needs captured | client / same day | missing → drafter `doc_request` → Needs-you `missing_info` |
| `intake.cross_file` | intake · intake | code | A/A | claim, vehicles, parties changed → no open block clash | — | tool `clash_check` |
| `intake.injury_referral` | intake · intake | ai_wording | C/C | `accident.injuries` → `injuryReferral` set | owner | `legal_escalate` matter `injury` (existing) |
| `intake.cctv` | notify · intake | ai_wording | A/A | `REQUEST_CCTV` condition → `cctv_request_sent` | 7 days | draft `letter.cctv_preservation` (code `REQUEST_CCTV`) |
| `qualify.acceptance` | qualify · qualification | code | A/A | intake exit → assessment recorded | — | tool `eligibility_assess` (records acceptance + eligibility) |
| `qualify.decline` | qualify · qualification | person | O/O | decision `decline` → status `declined` | owner | Needs-you `autopilot_step` with prepared **new** `letter.decline` |
| `qualify.driver` | qualify · qualification | code | A/A (refer → C) | driver profile complete → outcome `eligible` (or owner-resolved `refer`) | client (licence, DVLA code) | missing → `doc_request`; refer → Needs-you `eligibility_review` |
| `qualify.need` | qualify · qualification | code | A/A (weak → C) | needs captured → `NeedAssessment` ≠ unknown | client | weak/none → Needs-you `autopilot_step` |
| `qualify.means` | qualify · qualification | code | A/C* | impecuniosity relied on → SoM + statements on file | client | `doc_request` for CCGUK-07 + 3 months' statements (*doc_request always asks) |
| `qualify.roadworthiness` | qualify · qualification | code | A/A | driveable answered → hire-from date set (now / repair start) | — | optional `vehicle_lookup` for client car MOT/tax on accident date |
| `signup.pack` | signup · sign_up | code | C/C | acceptance accept(/conditions) → pack approved and given | owner | `pack.prepare signup` → `approve_pack` |
| `signup.signed` | signup · sign_up | person | O/O | pack sent → CCGUK-01 (+09/+02) signed | client; chase 2/5 days | `signing.chase`; on signature code appends `services_agreed` |
| `notify.ncaf` | notify · sign_up | ai_wording | A/A | `services_agreed` → `ncaf_sent` | `gta_4_1_ncaf_1wd` | draft `letter.ncaf` (`SEND_NCAF`) |
| `notify.handling_ref` | notify · sign_up | ai_wording | A/A | NCAF sent → `handling_ref_received` | `gta_4_2_handling_ref_5wd` | draft `letter.handling_ref_request` (`REQUEST_HANDLING_REF`) |
| `notify.intervention` | notify · (any) | ai_wording | C/C | intervention offer without reply → `intervention_reply_sent` | **1 WD** (`intervention_reply_1wd`) | client told neutrally (`client_update`, script guard) + `letter.intervention_reply` + CCGUK-08 → Needs-you (urgent) |
| `vehicle.recovery` | vehicle · vehicle_secured | code | C/C | not driveable, not in our storage → recovery recorded | supplier | **new** `letter.recovery_storage_instruction` (`ARRANGE_RECOVERY`); judge `choose_recovery_supplier` |
| `vehicle.storage` | vehicle · vehicle_secured | code | A/A | recovered to storage → storage record open; ends on report+48 h / TL / salvage | — | existing storage routes; `SEND_COLLECT_OR_PAY` |
| `vehicle.engineer` | vehicle · vehicle_secured | ai_wording | A/A | authority signed → `engineer_instructed` | 1 WD | draft `letter.supplier_instruction_engineer` (`INSTRUCT_ENGINEER`) |
| `vehicle.inspection` | vehicle · vehicle_secured | code | A/A | instructed → `inspection` event | engineer; chase 3 WD | chaser email `supplier_instruction` |
| `vehicle.report` | vehicle · on_hire | person | O/O | inspected → `report_issued` | engineer / owner (issue is human) | Needs-you `autopilot_step` when draft report waits |
| `vehicle.repair_track` | vehicle · on_hire | ai_judgement | A/A | repair route → `repair_completed` | repairer; 4.10 3 WD, 4.11 5 WD | judge `repair_status_from_message` → `event_append` (repair_started / repair_delay / repair_completed); delay notices `letter.delay_notice_gta_4_10` |
| `vehicle.total_loss_track` | vehicle · on_hire | code | A/O* | `total_loss_confirmed` → `tl_payment_received` | insurer | chasers; PAV challenge is owner (*) |
| `hire.search` | hire · hire_search | code | A/A | qualification exit, hire needed, need date ≤ now + look-ahead → reservation held/confirmed | — | in-process availability search (§B.5) |
| `hire.choose` | hire · hire_search | ai_judgement | A/A (not green → C) | search done → car chosen | — | clear winner: code picks; else judge `choose_car`; not green → Needs-you `choose_car` |
| `hire.hold` | hire · hire_search | code | A/A | car chosen → reservation `held` | hold 24 h | tool `booking_hold` |
| `hire.offer` | hire · hire_offer | ai_wording | A/A (not green → C) | held → offer `sent` | — | tool `hire_offer_prepare` + `email_draft` kind `hire_offer` (`OFFER_HIRE`) |
| `hire.acceptance` | hire · hire_offer | ai_judgement | A/A | offer sent → offer `accepted` | **client**; reminder 4 h; expiry → Needs-you `question` + task `call` | deterministic reply parse, else `hire_offer.parse_reply`; "accepted by phone" button |
| `hire.confirm` | hire · hire_booked | code | A/A | accepted → reservation `confirmed` (agreement number allocated) | — | tool `booking_confirm` (`CONFIRM_BOOKING`) |
| `hire.delivery` | hire · hire_booked | code | A/A | confirmed → delivery movement `planned` + client told | — | tools `movement_schedule` + `email_draft` kind `booking_update` (`SCHEDULE_DELIVERY`) |
| `hire.pack` | hire · hire_booked | code | C/C | confirmed → hire-start pack approved and sent to client (durable medium) | owner | `pack.prepare hire_start` → `approve_pack` (`PREPARE_HIRE_PACK`) |
| `hire.handover` | hire · handover | person | O/O | delivery due + pack approved → reservation `on_hire` | handler | Needs-you `autopilot_step` (what to bring, kiosk link) + movements board |
| `hire.start_notice` | notify · handover | ai_wording | A/A | hire started → `hire_start_notice_sent` | 1 WD | draft **new** `letter.hire_start_notice` (`NOTIFY_HIRE_START`) |
| `hire.monitor` | hire · on_hire | code | A/A | on hire → (never done while on hire) | weekly | client check-in `client_update`; judge `need_still_exists` on replies; compliance watch |
| `hire.offhire` | hire · off_hire | code | A/A | off-hire trigger → collection movement planned, expected end = deadline | `offHireDeadline` | tools `booking_update_period` + `movement_schedule` + `booking_update` email (`BOOK_COLLECTION`) |
| `hire.return` | hire · off_hire | person | O/O | collection due → reservation `returned`, hire ended | handler | Needs-you `autopilot_step` + movements board |
| `money.invoices` | money · billing | code | C/C | hires ended (or interim), storage ended → invoices approved + ledger rows | owner | `pack.prepare billing` + `ledger_propose` → `approve_pack` (`RAISE_INVOICES`) |
| `money.payment_pack` | money · billing | code | C/C | invoices approved → `payment_pack_sent` | owner; 2 WD after hire end | `pack.prepare payment` → `approve_pack` (`SEND_PAYMENT_PACK`) |
| `money.chasers` | money · recovery | ai_wording | A/A | pack sent → paid | insurer; day 7/14/21 | existing `CHASER_7/14/21` |
| `money.complaint` | money · recovery | ai_wording | C/C | day 28 unpaid → `complaint_sent` | owner | `letter.complaint_disp` (always-ask) |
| `money.offer` | money · recovery | person | O/O | settlement offer open → owner decision | owner | `offer_record` → `offer.analyse` → `offer_decision` (existing) |
| `money.payment` | money · recovery | code | C/C | remittance in → `paid` row (owner) | owner | `payment_received_propose` (existing) |
| `money.client_payout` | money · recovery | person | O/O | PAV/excess due to client → paid | owner | Needs-you `money` (`PAY_CLIENT`) |
| `close.readiness` | close · closure | code | C/O* | heads resolved → owner closes | owner | `closureReadiness` → Needs-you `autopilot_step` + **new** `letter.closure` (`CLOSE_FILE`) |
| `status.sync` | close · (any) | code | A/A | stage changed → claim status matches the stage map | — | tool `claim_status_set` (never `declined/settled/closed/pre_action/litigation`) |

New playbook codes (added to `defaultPlaybookRules` so `PLAYBOOK_ACTION_CODES` accepts them in hand-offs; the
`nextActions` engine itself is unchanged): `OFFER_HIRE`, `CONFIRM_BOOKING`, `SCHEDULE_DELIVERY`, `PREPARE_HIRE_PACK`,
`SIGNUP_PACK`, `CHASE_SIGNATURES`, `NOTIFY_HIRE_START`, `INSTRUCT_ENGINEER`, `ARRANGE_RECOVERY`, `BOOK_COLLECTION`,
`RAISE_INVOICES`, `PAY_CLIENT`, `CLOSE_FILE`, `CHECK_NEED`, `DRIVER_ELIGIBILITY`.

### A.4 Facts and predicates (`autopilot/facts.ts`, `autopilot/predicates.ts`, pure)

```ts
export interface AutopilotFacts {
  now: ISODateTime;
  bundle: ClaimBundle;                                   // existing loadBundle()
  acceptance: AcceptanceAssessment;                      // assessAcceptance(bundle, { gates, now })
  gates: GateResult[];                                   // evaluateGates(bundle)
  playbook: PlaybookAction[];                            // nextActions(bundle, ctx)
  needs: HireNeeds | null;                               // claim_hire_needs (§F.3)
  eligibility: EligibilitySummary;                       // §F.7
  reservations: Reservation[]; hireOffers: HireOffer[]; movements: Movement[];
  packs: DocumentPack[]; signatures: SignatureRequest[];
  clashes: ClashFinding[];                               // open findings for this claim (incl. its reservations)
  availability: AvailabilityResult | null;               // computed by the API only when hire.search/choose is due
  outbox: Array<{ id: Id; kind: string; status: string; autopilotStepId: string | null; createdAt: ISODateTime; sentAt: ISODateTime | null }>;
  openNeedsYou: Array<{ id: Id; kind: NeedsYouKind; dedupeKey: string | null }>;
  openJobs: Array<{ id: Id; type: JobType; idempotencyKey: string | null; status: JobStatus }>;
  settlementOffers: SettlementOffer[];
  lastInbound: { at: ISODateTime; intent: MailIntent; messageId: Id } | null;
  claimAutopilot: { mode: 'on' | 'paused' | 'off'; overrides: Record<string, AutopilotOverride> };
  agentPaused: boolean;                                  // SD claim_agent_state.paused
  settings: AutopilotSettings;
}
export const PREDICATES: Readonly<Record<PredicateId, (f: AutopilotFacts) => boolean>>;
export const REQUIREMENTS: Readonly<Record<RequirementId, { label: string; present: (f: AutopilotFacts) => boolean; ask: 'client' | 'insurer' | 'owner' }>>;
```

Predicate examples (each a one-liner in code, each with a unit test): `hireNeeded` = needs.clientWantsHire !== false
&& eligibility.need.level ∉ {none} && no intervention offer with clientDecision `accepted` && no open reservation
`cancelled` with reason `client_declined_hire`; `servicesAgreed` = event `services_agreed` exists;
`offHireTrigger` = an event in `repair_completed | tl_payment_received | insurer_termination_notice |
cash_in_lieu_received` after the hire start, or the hire has `endTrigger` `client_returned | replacement_purchased`;
`heldReservation`, `offerSent`, `offerAccepted`, `packApproved(stage)`, `packSigned(stage)`, `hireStarted`,
`hireEnded`, `allHiresEnded`, `storageEnded`, `reportIssued`, `invoicesApproved`, `paymentPackSent`,
`headsResolved` (every head with a `claimed` row has `paid ≥ claimed` or a `written_off`/`settled` resolution by the
owner).

### A.5 State machine and plan evaluation (`autopilot/plan.ts`, pure)

`planAutopilot(f: AutopilotFacts): AutopilotPlan` evaluates every `StepDef` in catalogue order:

1. `appliesWhen` false → `not_applicable`.
2. Claim override `skip` → `skipped`; `done` → `done` (with the reason); `snooze` until a future time → `waiting`
   (`waitingOn: 'time'`).
3. `doneWhen` true → `done`. A step that was `done` in the stored plan and is no longer done (e.g. a signed document
   superseded) is reported `reopened` in `autopilot_log` and evaluated again.
4. Any `after` dependency not done/skipped/not_applicable → `upcoming`.
5. Any `readyWhen` false → `upcoming`.
6. Missing `requires` → `blocked` (kind `requirement`; the step's next sentence names what is missing and who we ask).
7. An open **block** finding whose code is in `blockingClashes` → `blocked` (kind `clash`).
8. An open job, open Needs-you or held/queued outbox item referencing the step (`refs`, `autopilot_step_id`,
   Needs-you `dedupeKey` `autopilot:<claimId>:<stepId>:*`) → `in_progress` (or `waiting` with `waitingOn: 'owner'`
   when it is a Needs-you item).
9. `waitingOn.when` true → `waiting` (client/insurer/engineer/repairer/supplier/handler).
10. Otherwise `due`; `dueAt` from `deadline`; `overdue` when `dueAt < now`.
11. Claim `mode` `paused` (or SD `claim_agent_state.paused`) → every `due` becomes `paused` (still shown with its
    deadline; the deadline guard below still applies).

Effective mode: `mode = max(step.floor, settings.stepModes[id] ?? step.defaultMode, override ask → confirm,
override auto → (never below floor), green ? none : 'confirm' for steps marked green-gated)`. Green-gated steps:
`hire.choose`, `hire.offer`, `qualify.driver` (refer), `qualify.need` (weak). `modeReasons` lists every reason the
mode was raised (shown in the UI).

Stage: first `STAGE_ORDER` entry with at least one applicable step not done/skipped; terminal when status is
`declined`/`closed` or `pre_action`/`litigation` (→ `legal`).

### A.6 Step modes and the autonomy policy

Every action a step takes is a tool call through SD's dispatcher with `rc.step = { id, mode, green }`. Two rules are
added to `decide()` after rule 4 `untrusted_source` (SD §D.2), and rule 13 is refined:

| # | Rule id | Condition | Outcome |
|---|---|---|---|
| 4a | `step_owner_only` | `a.step?.mode === 'owner'` and class not `read`/`draft` | deny ("a person does this step") |
| 4b | `step_confirm` | `a.step?.mode === 'confirm'` and class not `read`/`draft` | ask |
| 13 | `touches` (refined) | as SD, except `newCommitment` is ignored when `a.commitment?.verified === true && a.step?.mode === 'auto'` | ask |

So: an `auto` step still meets every SD rule (kill switch, pause, untrusted source, money/settlement/legal always
ask, shadow mode, confidence thresholds, reviewer pass, allow-lists, recipient checks, rate limits, quiet hours and
the hold window). A `confirm` step never acts without the owner. An `owner` step is never attempted by an agent.
Rule ids appear in `agent.policy` audit rows and the daily log as in SD §D.4. Existing tests are unaffected because
the new fields are absent on every phase-1 descriptor.

### A.7 The runner and the Case Manager

**`autopilot.tick`** (`apps/api/src/autopilot/runner.ts`, deterministic, agent `autopilot`):

1. `facts = loadAutopilotFacts(ctx, claimId)` (computes availability only if `hire.search`/`hire.choose` is due).
2. `plan = planAutopilot(facts)`; diff against `claim_autopilot.plan`; append one `autopilot_log` row per status
   change (`from_status → to_status`, refs).
3. If the kill switch is on, the claim is paused, or `claim_autopilot.mode !== 'on'`: store the plan and stop
   (holds still expire; clash sweeps still run — they are housekeeping, not agent actions).
4. For up to `settings.maxActionsPerTick` (5) due steps in `plan.due` order, run `executeStep(step)`:
   * `tool` / `draft` / `pack` actions with effective mode `auto` → mint a run (an `agent_runs` row with
     `driver:'deterministic'`, `model:'none'`, `prompt_version:'autopilot/1:<planHash>'`) and a claim-scoped run
     token for `agent:autopilot`, then `executeTool(ctx, rc, tool, input)` — input built by code (`InputBuilders`),
     never by a model. A `draft` action enqueues SD's `draft.compose` hand-off with the step's `actionCode` (same
     idempotency key format, so the case manager and the autopilot can never both draft it).
   * `judge` actions → enqueue `autopilot.judge` with the options code computed; the result comes back as a choice
     that must be one of the offered option ids (else Needs-you `question`), then the runner executes it.
   * effective mode `confirm` → prepare (drafts/pack) and `createNeedsYou` (kind per step; `dedupeKey`
     `autopilot:<claimId>:<stepId>:<n>`; `resumesJobId` unset — the next tick sees the resolution).
   * effective mode `owner` → `createNeedsYou(kind 'autopilot_step')` telling the owner exactly what to do, with
     links; a `task` (`task_schedule`) for the physical job.
5. Tool errors: `RESERVATION_OVERLAP` on `booking_hold` → re-search excluding that car (max 2 retries in the tick);
   an error carrying `error.override` → Needs-you `override_needed` (SD §B.2); other errors → step `failed` for this
   tick, retried next tick; the same step failing 3 times in 24 h → Needs-you `failure` ("loop guard").
6. Store plan + `next_check_at`.

**`autopilot.judge`** (agent `case_manager`, model per Settings > AI, default Sonnet 5.5 effort `medium`, tools: read
only — `claim_brief`, `autopilot_plan`, `fleet_search`, `kb_search`, `brain_search`, `memory_recall`). Prompt file
`apps/api/src/agent/prompts/autopilot-judge.md`: "Choose one of the options given. Explain why. Write any wording
with `{{fact:…}}` placeholders only. If none is right, choose `ask_owner`." Result schema (strict, SD §B.5):

```ts
export interface AutopilotJudgeResult {
  questionId: JudgeQuestionId; stepId: string;
  choice: string;                                         // must equal one of the offered option ids, or 'ask_owner'
  why: string; basis: Basis[]; confidence: number;
  wording: { offerIntro: string | null; clientNote: string | null };   // {{fact:…}} placeholders only
}
```

Confidence below `thresholds.internal` (0.85) or `ask_owner` → the step goes to `confirm` with the judge's
recommendation on the Needs-you card. **Deterministic fallback**: if AI is paused (usage window, kill switch for AI
only, auth failure) and the step's deadline is within 24 h, the runner uses the code's top-ranked option and default
wording, in `confirm` mode (SD §C.6 deadline guard). The core booking path (search → hold → offer with default wording
→ confirm → schedule → pack) therefore works without any model.

`case.review` (SD §C.5) is unchanged except that the Case Brief carries the plan (§A.10) and the prompt
`case-manager.md` gains one paragraph: "The autopilot owns the steps listed in `autopilot.steps`; do not duplicate
them; propose `CUSTOM` only for things outside the plan; you may recommend pausing the autopilot on this claim."

### A.8 Pause, overrides, guards

* **Per-claim pause** (`POST /claims/:id/autopilot/pause|resume`, one click in the timeline): sets
  `claim_autopilot.mode`, audits `autopilot.pause`/`autopilot.resume` with a reason; the runner treats the claim as
  paused (`AutonomyState.claimPaused = true` for autopilot runs). "Pause all agents on this claim" (SD) also pauses
  the autopilot.
* **Per-step overrides** (`POST /claims/:id/autopilot/steps/:stepId/{run|skip|ask|auto|done|snooze}`): stored in
  `claim_autopilot.step_overrides`; `skip`/`done` need a reason; `auto` cannot go below the floor; every change is
  audited (`autopilot.step_override`) and logged in `autopilot_log`. "Run now" enqueues a tick with the step forced
  due (still through `decide()`).
* **Global**: Settings > Autopilot master switch; new claims start `on` (owner's "fully automatic" choice) or
  `paused` (setting).
* **Guards**: ≤ 5 actions per tick; per-claim `autopilot.judge` runs count against SD's per-claim AI budget
  (8/day); the same step executed 3 times in 24 h without progress → Needs-you `failure`; `maxAutoOffersPerDay`
  (10) across the fleet; every tick idempotent per minute.

### A.9 Claim status

`status.sync` sets the status that matches the stage (`fnol`, `triage`, `accepted`, `hire_active`, `repair`,
`total_loss`, `payment_pack`, `chasing`) through `claim_status_set` (internal) → `POST /claims/:id/status`. The
perimeter already refuses `settled | closed | declined | pre_action | litigation` for agents (SD §B.2 rule 4).
A status set by a person within the last 24 h is never changed by the autopilot (the person wins; logged).

### A.10 Case Brief, facts and prompts

`buildCaseBrief` (casework) gains an optional section (built by `apps/api/src/autopilot/brief.ts`):

```ts
autopilot?: { stage: string; mode: string; due: Array<{ id: string; title: string; dueAt: string | null }>;
  waiting: Array<{ id: string; title: string; on: string }>; blocked: Array<{ id: string; reason: string }> };
```

and facts usable as `{{fact:…}}`: `booking.unit.registration`, `booking.unit.makeModel`, `booking.unit.transmission`,
`booking.unit.seats`, `booking.unit.gtaGroup`, `booking.startAt`, `booking.delivery.window`,
`booking.delivery.addressShort`, `booking.collection.window`, `booking.agreementNumber`, `offer.expiresAt`,
`offer.likeForLike` (code-built sentence), `client.vehicle.gtaGroup`, `hire.offHireDeadline`, `pack.documentList`.

---

## B. Fleet booking system

### B.1 Reservations (`packages/domain/src/booking/types.ts` by `ap-foundation`; `booking/reservation.ts` by `ap-booking`)

One row per car per claim per period. It is the fleet diary: every hire, held car and future booking appears here.
`hire_agreements` keeps its job (the signed credit hire contract and its charges) and is created at handover from a
confirmed reservation (§B.9). Legacy hires are back-filled by the migration (`source: 'backfill'`).

```ts
export type ReservationStatus = 'held' | 'confirmed' | 'on_hire' | 'returned' | 'cancelled' | 'expired';
/** Statuses that occupy the car for their period (a returned hire still occupied it — history clashes are real). */
export const BLOCKING_RESERVATION_STATUSES: readonly ReservationStatus[] = ['held', 'confirmed', 'on_hire', 'returned'];

export interface Reservation {
  id: Id; fleetUnitId: Id; claimId: Id; status: ReservationStatus; use: FleetUse;
  startAt: ISODateTime;
  expectedEndAt: ISODateTime;          // projected end (§B.6); moves as facts arrive
  endAt?: ISODateTime;                 // hire end (contractual), set at return
  collectedAt?: ISODateTime;           // car physically back
  holdExpiresAt?: ISODateTime;         // held only
  hirerPartyId: Id; driverPartyIds: Id[];      // main driver first; additional drivers after
  agreementNumber?: string;            // allocated at confirmation (CCG-H-NNNNNN, same sequence as hire_agreements)
  hireAgreementId?: Id; hireOfferId?: Id;
  dailyRatePence: Pence; gtaGroup: string; clientGtaGroup?: string; pricingNote?: string;
  substitutionReason?: string;         // required when the group is above like for like (clash GROUP_ABOVE_LFL)
  ranking?: AvailabilityCandidate;     // snapshot at hold time (why this car)
  source: 'autopilot' | 'handler' | 'backfill';
  overlapOverrideAuditId?: Id;         // a manager override let this period overlap another
  createdBy: string; createdAt: ISODateTime; updatedAt: ISODateTime; cancelledReason?: string;
}

/** The period a reservation occupies, in epoch ms (stored as block_start_ms / block_end_ms; null end = open). */
export function occupiedPeriod(r: Reservation, now: ISODateTime): { startMs: number; endMs: number | null };
//  held/confirmed: [startAt, expectedEndAt)
//  on_hire:        [startAt, max(expectedEndAt, now)) — a car overdue back keeps occupying until returned
//                  (legacy on-hire rows with no expected end: open, exactly like today's HIRE_OVERLAP)
//  returned:       [startAt, max(endAt, collectedAt ?? endAt))  — collectedAt now counts (today it is ignored)

export const RESERVATION_TRANSITIONS: Readonly<Record<ReservationStatus, readonly ReservationStatus[]>> = {
  held: ['confirmed', 'cancelled', 'expired'], confirmed: ['on_hire', 'cancelled'], on_hire: ['returned'],
  returned: [], cancelled: [], expired: [],
};
export function assertTransition(from: ReservationStatus, to: ReservationStatus): void;  // throws RESERVATION_STATE
```

Guards per transition (the API enforces; clash codes in §C.2):

| Transition | Who | Guards |
|---|---|---|
| → `held` | agent `booking_hold` or person | `detectClashes(proposed_booking)` has no **block**; hold expiry = now + `holdHours` (24) |
| `held` → `confirmed` | agent `booking_confirm` (offer accepted) or person ("client in the office") | hold not expired (else re-hold if still free); fresh clash check; agreement number allocated |
| `held/confirmed` → `cancelled` | agent `booking_release` (offer declined/expired, client took insurer's car) or person | reason required |
| `held` → `expired` | `booking.expire_holds` | `holdExpiresAt ≤ now` |
| `confirmed` → `on_hire` | **person only** (`POST /bookings/:id/handover`) | hire-start pack signed (`SIGNATURES_MISSING` class A), driver eligible (`DRIVER_INELIGIBLE` C / `DRIVER_REFERRAL` A), unit ready (`UNIT_NOT_READY` A), licence evidence on file and DVLA check ≤ 14 days (`LICENCE_CHECK_STALE` A); creates the hire (§B.9) |
| `on_hire` → `returned` | **person only** (`POST /bookings/:id/return`) | odometer in ≥ out; end time vs off-hire deadline (`HIRE_PAST_OFFHIRE` warn) |

A vehicle swap mid-hire is two reservations: the first returned and the second on hire at the same instant
(touching periods are allowed, as in `hirePeriodsOverlap`); two hire agreements; the payment pack sums both.

### B.2 Readiness, damage and turnaround

```ts
export type ReadinessKind = 'valet' | 'inspection' | 'service' | 'damage_repair' | 'mot' | 'tax' | 'tyres' | 'keys' | 'phv_licence' | 'other';
export interface ReadinessTask {
  id: Id; fleetUnitId: Id; kind: ReadinessKind; status: 'open' | 'done' | 'cancelled';
  blocksHire: boolean;                 // damage_repair (major/unroadworthy), mot, tax, phv_licence → true by default
  dueAt?: ISODateTime; readyByAt?: ISODateTime;      // when the car will be ready (estimate)
  reservationId?: Id; damageId?: Id; note?: string; createdBy: string; createdAt: ISODateTime; doneBy?: string; doneAt?: ISODateTime;
}
export interface FleetDamage {
  id: Id; fleetUnitId: Id; panel: string; description: string;
  severity: 'cosmetic' | 'minor' | 'major' | 'unroadworthy';
  foundAt: ISODateTime; foundBy: string; reservationId?: Id; movementId?: Id; evidenceIds: Id[];
  repairedAt?: ISODateTime; repairTaskId?: Id; chargeable: 'none' | 'hirer' | 'third_party' | 'tbc';
}
export type UnitReadiness = { state: 'ready' } | { state: 'ready_by'; at: ISODateTime; tasks: Id[] } | { state: 'not_ready'; blocking: Id[] };
export function unitReadiness(tasks: ReadinessTask[], damage: FleetDamage[], at: ISODateTime): UnitReadiness;
```

On every return the booking service creates `valet` and `inspection` tasks (`readyByAt = collectedAt +
turnaroundMinutes`, default 120), plus `damage_repair` for each damage row (blocking when `major`/`unroadworthy`).
`fleet.compliance_watch` creates `mot`/`tax`/`service`/`phv_licence` tasks 30 days before each due date. The legacy
`status: 'off_road'` stays as the manual "out of service" switch and is treated as not ready with no end date.

### B.3 Locations, mileage, PCO licence

`fleet_locations` (name, address, postcode, optional lat/lon, one default). Fleet units gain `location_id`,
`current_mileage` + `mileage_at`, `service_due_miles`, `phv_licence_number` + `phv_licence_expiry` (a TfL PHV
vehicle licence must be in force for `pco` use), `turnaround_minutes` (override). Insurance policies gain
`driver_criteria` (JSON, §F.2; null = Settings default) and `renews_policy_id` (the policy that continues cover after
this one ends, so whole-period cover can chain).

### B.4 Whole-period compliance (`booking/periodCompliance.ts`)

```ts
export interface PeriodAllocationCheck extends AllocationCheck {
  /** Dates inside [startAt, expectedEndAt) when something lapses (MOT, tax, policy, service, PHV licence). */
  lapses: Array<{ kind: 'policy' | 'mot' | 'tax' | 'service' | 'phv_licence'; date: ISODate; renewal?: string }>;
  marginDays: number;                  // min days between expectedEnd and the next lapse (∞ → 365)
}
export function canAllocateForPeriod(unit: FleetUnit, use: FleetUse, policies: InsurancePolicy[], period: { startAt: ISODateTime; expectedEndAt: ISODateTime },
  vehicle: Vehicle | undefined, ctx: { now: ISODateTime; phvLicenceExpiry?: ISODate }): PeriodAllocationCheck;
```

It calls the existing `canAllocate(unit with on_hire treated as available, use, policy, startAt, vehicle)` exactly as
`POST /claims/:id/hire` does today (status, declared use, Collingwood one-use-per-policy, MOT/tax at the start), then
adds the period: the linked policy (or its `renews_policy_id` chain) must be in force and cover `use` on every day of
the period, else reason `POLICY_ENDS_IN_PERIOD` (block, class A); MOT/tax lapsing inside the period → `lapses` +
warn (`MOT_LAPSES_IN_PERIOD`, `TAX_LAPSES_IN_PERIOD`; the booking service creates the readiness task); service due in
the period → warn; `pco` use needs `phvLicensed` and a PHV licence in force for the period (`PHV_LICENCE`, block, C).

### B.5 Availability search and ranking (`booking/availability.ts`, `booking/likeForLike.ts`)

```ts
export interface HireNeeds {                                  // §F.3, stored per claim
  neededFrom: ISODateTime | null; deliveryAddress: Address | null; deliveryPostcode: string | null;
  seatsMin: number | null; automaticOnly: boolean; automaticPreferred: boolean;
  towbar: boolean; wheelchairAccessible: boolean; handControls: boolean; isofixCount: number;
  evOk: boolean | null; phvWork: boolean; largeBoot: boolean;
  occupation: string | null; journeys: string | null; dependants: string | null;
  otherVehicles: 'none' | 'available' | 'unknown';
  ownInsurerCourtesyCar: 'offered' | 'accepted' | 'not_offered' | 'unknown';
  clientCoverType: 'comprehensive' | 'tpft' | 'tpo' | 'unknown';
  clientWantsHire: boolean | null; notes: string | null;
  source: Record<string, 'intake_script' | 'intake_extract' | 'handler' | 'client_reply'>;
}
export interface AvailabilityQuery {
  claimId: Id | null; use: FleetUse; startAt: ISODateTime; expectedEndAt: ISODateTime;
  needs: HireNeeds; clientVehicle: Pick<Vehicle, 'gtaGroup' | 'bodyType' | 'fuelType' | 'transmission' | 'spec'> | null;
  clientGroup: string | null; clientGroupSource: ClientGroupSource;       // gta/pricing.ts
  drivers: Array<{ partyId: Id; profile?: DriverProfile; party: Pick<Party, 'dateOfBirth' | 'drivingLicenceNumber' | 'name'> }>;
  excludeReservationIds: Id[];        // the claim's own hold when re-searching
  limit: number;                      // default 10
}
export interface UnitSnapshot {
  unit: FleetUnit; vehicle: Vehicle; policies: InsurancePolicy[]; reservations: Reservation[];
  readiness: ReadinessTask[]; damage: FleetDamage[]; penalties: PenaltyNotice[]; location: FleetLocation | null;
}
export type RankFactor = 'likeForLike' | 'needsFit' | 'readiness' | 'compliance' | 'cost' | 'location';
export interface RankingWeights extends Record<RankFactor, number> {}
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = { likeForLike: 35, needsFit: 15, readiness: 15, compliance: 10, cost: 20, location: 5 };
export interface AvailabilityCandidate {
  fleetUnitId: Id; registration: string; label: string;          // "Ford Focus 1.0 auto, 5 seats, petrol (C2)"
  score: number;                                                  // 0..100
  factors: Record<RankFactor, { score: number; weight: number; note: string }>;
  likeForLike: LikeForLikeResult; pricing: HirePricingGuide;      // hirePricingGuide() as today
  readyBy: ISODateTime; marginDays: number; lapses: PeriodAllocationCheck['lapses'];
  warnings: ClashFinding[];                                       // warn/info findings for this car + period
  driverOutcome: EligibilityOutcome;                              // against THIS car's policy criteria
}
export interface ExcludedUnit { fleetUnitId: Id; registration: string; reasons: Array<{ code: string; message: string }> }
export interface AvailabilityResult {
  period: { startAt: ISODateTime; expectedEndAt: ISODateTime }; use: FleetUse;
  ranked: AvailabilityCandidate[]; excluded: ExcludedUnit[];
  clearWinner: boolean;              // ranked[0].score − ranked[1].score ≥ settings.clearWinnerGap (8)
  green: boolean;                    // ranked[0] passes the green test (§D.1)
  explanation: string[];             // plain-English, most important first
}
export function searchAvailability(q: AvailabilityQuery, units: UnitSnapshot[], env: { rates: GtaRate[]; weights: RankingWeights;
  turnaroundMinutes: number; clearWinnerGap: number; criteria: (policyId: Id | undefined) => DriverCriteria; now: ISODateTime }): AvailabilityResult;
```

**Hard filters** (each exclusion lists every reason, so the owner sees *why* a car is not offered):

1. `disposed` → excluded; `off_road` → excluded unless a readiness `readyByAt` ≤ start exists.
2. `canAllocateForPeriod` reasons (status at start, declared use, policy/whole-period cover, MOT/tax at start, PHV).
3. Occupied: any blocking reservation of another claim overlapping `[start, expectedEnd)` (`hirePeriodsOverlap`
   on `occupiedPeriod`), excluding `excludeReservationIds`.
4. Not ready: a blocking readiness task or unrepaired `major`/`unroadworthy` damage whose `readyByAt` > start (or
   none).
5. Needs: `automaticOnly` (or licence restriction code 78) → transmission `automatic`; `seatsMin` → `spec.seats`;
   `wheelchairAccessible`/`handControls`/`towbar` → feature ids `wheelchair_access`, `hand_controls*`, `tow_bar*`/
   `aftermarket_towbar` (catalogue `features.json`); `evOk === false` → not `electric`; `phvWork` → use `pco`.
6. Driver: any named driver `ineligible` against the car's policy criteria (§F.1) → excluded (a `refer` keeps the
   car with a warning).
7. The client's own vehicle or a vehicle on this claim (clash `UNIT_IS_CLAIM_VEHICLE`, C).

**Scores** (each 0..1, weighted, summed to 0..100):

* `likeForLike` = 0.5·group + 0.2·body + 0.1·seats + 0.1·transmission + 0.1·fuel. *Group*: compare benchmark daily
  rates (never codes, as `hirePricingGuide` does): same group 1.0; lower by ≤ 10 % 0.8; lower by more 0.5; higher
  group 0.4 (plus warn `GROUP_ABOVE_LFL`: only the like-for-like rate is recoverable); unknown client group 0.5.
  *Body*: same family (hatch/saloon/estate/SUV/MPV/van from `bodyType` or catalogue segment) 1, adjacent 0.5, else 0.
  *Seats*: ≥ client's 1, else 0. *Transmission*: same 1, automatic for a manual client 0.8, manual for an automatic
  client 0. *Fuel*: same family 1 (EV↔EV, hybrid↔hybrid/petrol), else 0.5.
* `needsFit` = share of soft preferences met (`automaticPreferred`, `isofixCount`, `largeBoot`, `evOk` true and EV).
* `readiness` = ready now 1.0; ready by start with tasks 0.7; ready within 2 h of start 0.4.
* `compliance` = `marginDays` ≥ 30 → 1.0; 7–29 → 0.6; < 7 → 0.2; a lapse inside the period → 0.
* `cost` = fleet daily rate vs the client's like-for-like guide rate (`hirePricingGuide().clientCar`): ≤ guide 1.0;
  ≤ +10 % 0.6; above 0.2; no guide 0.5.
* `location` = lat/lon on both → 1 − min(km/50, 1); else same postcode district 1.0, same area 0.6, different 0.3,
  unknown 0.5. (No geocoding service is bundled; distance is "if known".)

Ties: earlier `readyBy`, then lower mileage, then registration (stable). Weights are editable (Settings >
Autopilot) and normalised to 100.

### B.6 Projected period (`booking/projection.ts`)

`projectHirePeriod(bundle, needs, roadworthiness, settings, now)`: start = `needs.neededFrom` ?? (driveable →
repair start date if booked, else now + 1 business day; not driveable → now rounded up to the next delivery slot).
Expected end = start + (engineer report repair days + 2 WD parts buffer) when a report exists, else
`acceptanceHireProjection` (existing; default 14 days), else `settings.projection.defaultHireDays` (14); total loss
(predicted or confirmed) → start + `settings.projection.totalLossDays` (21). The expected end is updated by the
autopilot when the report, repair booking or off-hire trigger arrives (`booking_update_period`, clash re-check).

### B.7 Holds, confirmation and agreement numbers

* `placeHold(ctx, actor, {claimId, fleetUnitId, use, startAt, expectedEndAt, hirerPartyId, driverPartyIds, ranking})`
  runs **one** `ctx.db.transaction(...).immediate()` with no `await` inside: expire stale holds for that car →
  load the car's blocking reservations → `detectClashes(proposed_booking)` → block findings refuse through
  `gateFor(ctx, request).refuse(conflict(code, …), target)` (manager override for class A only; agents never) →
  insert the row (the trigger in §G.2 is the second line of defence) → `fleet_reservation_events` row → audit
  `booking.hold` → event-free (holds are not claim chronology). Returns the reservation plus warn findings.
* Error to an agent: `409 RESERVATION_OVERLAP` "The car is held or booked for another claim for part of this period"
  — **no** other claim's reference is revealed to a claim-scoped run (SD §K.3); a person sees the other reference.
* `confirm` allocates the agreement number from the same sequence as `hire_agreements` (the repo's generator is
  moved to a shared `nextAgreementNumber(tx)`), so the CCGUK-03 printed before handover carries the final number;
  appends event `booking_confirmed` (data: reservation, car, period). One claim may have only one `held`/`confirmed`
  reservation at a time (`CLAIM_SECOND_HIRE`, block).

### B.8 Delivery and collection scheduling (`booking/delivery.ts`)

```ts
export interface Movement {
  id: Id; reservationId: Id; claimId: Id; fleetUnitId: Id;
  kind: 'delivery' | 'collection' | 'swap_out' | 'swap_in' | 'transfer';
  windowStart: ISODateTime; windowEnd: ISODateTime; address: Address | null; postcode: string | null;
  assignedTo: string | null; status: 'planned' | 'confirmed' | 'done' | 'failed' | 'cancelled';
  doneAt?: ISODateTime; odometer?: number; fuelEighths?: number; conditionDocumentId?: Id; evidenceIds: Id[];
  clientNotifiedAt?: ISODateTime; notes?: string;
}
export function proposeSlots(input: { earliest: ISODateTime; readyBy: ISODateTime; businessHours: BusinessHours; windowMinutes: number;
  leadMinutes: number; existing: Movement[]; maxPerWindow: number; preferred?: { date: ISODate | null; part: 'morning' | 'afternoon' | 'evening' | null } }, n: number): Array<{ windowStart: ISODateTime; windowEnd: ISODateTime }>;
```

Slots: inside business hours (default Mon–Sat 08:00–18:00 London, no bank holidays), 2-hour windows, at least 2 h
lead time and after the car is ready, at most 2 movements per window across the fleet (warn
`DELIVERY_CAPACITY`). The client's preferred time from a reply (judge `delivery_slot_from_reply` maps free text to
one of the code-proposed slots). The client is told by `booking_update` email (auto) and reminded the day before at
16:00 (`movement.remind`). Collection is planned at the off-hire deadline (`offHireDeadline`) or the client's
preferred earlier time.

### B.9 Handover and return (people) → hire record

`POST /bookings/:id/handover` (human-only; Handover dialog or Movements board): body `{ at, odometerOut, fuelEighths,
conditionDocumentId, licenceEvidenceId, dvlaCheck: { checkedAt, summary, evidenceId? } | null, keys: number, notes }`.
The service:

1. Re-runs `detectClashes(reservation)`; enforces `SIGNATURES_MISSING`, `DRIVER_*`, `UNIT_NOT_READY`,
   `LICENCE_CHECK_STALE`, `UNIT_DOUBLE_BOOKED` through the override gate.
2. Calls `createHireRecord(ctx, request, gate, input)` — the body of today's `POST /claims/:id/hire` extracted into
   `apps/api/src/services/hireCreate.ts` unchanged in behaviour (hard stop, end before start, `canAllocate`,
   `refuseOverlap`, pricing snapshot, `hire_started` event, enforceability flag, audit, clocks) — with the
   reservation's agreement number, `use`, hirer, drivers, rate/groups, `deliveredAt = at`, `odometerOut`,
   `expectedEndAt`, and `signedAt`/`documentId`/`enforceability.*` taken from the signed pack (§E.5).
3. Reservation → `on_hire` (`hire_agreement_id` set), delivery movement → `done`, event `hire_vehicle_delivered`,
   fleet status sync.

`POST /claims/:id/hire` (the manual path in the Hire tab) keeps working: it now also creates an `on_hire`
reservation in the same transaction (`source: 'handler'`) so the diary stays complete.

`POST /bookings/:id/return` (human-only): `{ collectedAt, endAt, endTrigger, odometerIn, fuelEighths,
conditionDocumentId, damage: Array<{ panel, description, severity, evidenceIds }> }` → existing hire-end logic
(`POST /claims/:id/hire/:hireId/end` body extracted into `services/hireEnd.ts`) → reservation `returned`, collection
movement `done`, damage rows, readiness tasks, event `hire_vehicle_collected`, `HIRE_PAST_OFFHIRE` warning if `endAt`
is after the deadline for the recorded trigger (those days are not recoverable; the owner sees it before billing).

### B.10 Fleet status and housekeeping jobs

`fleet_units.status` becomes derived from reservations: `fleetStatusFromReservations(unit, reservations, now)` →
`on_hire` iff an `on_hire` reservation covers now; future confirmed bookings no longer flip a car to on-hire (today's
`fleetStatusFromHires` does). `off_road`/`disposed` stay manual. `fleet.status_sync` (hourly and after every booking
write) applies it; `POST /fleet/:id/allocate-check` is made period-aware (it runs the single-car availability
search, fixing the today-only `activeHireForFleetUnit` check).

### B.11 Race safety

1. **Single writer, synchronous transaction.** better-sqlite3 transactions are synchronous; the hold/confirm/
   handover services do their read-check-insert inside one `transaction(...).immediate()` with no `await`, so two
   Fastify requests (two claims, or the agent and the owner) cannot interleave between the check and the insert.
2. **Database trigger** (§G.2): an INSERT, or an UPDATE into `held`/`confirmed`, whose occupied period overlaps
   another blocking reservation of the same car aborts with `RESERVATION_OVERLAP` unless the row carries
   `overlap_override_audit_id` (manager override) or `source = 'backfill'`. Periods are compared as integer epoch
   milliseconds (`block_start_ms`, `block_end_ms`), never as ISO text (mixed `…00Z` / `…00.000Z` strings do not sort).
3. **Losers re-plan**: the autopilot runner catches `RESERVATION_OVERLAP`, re-searches excluding that car and holds
   the next best (§A.7 step 5); a person in the booking dialog sees "taken a moment ago" and the refreshed list.
4. Physical reality is never refused: updates of `on_hire`/`returned` rows (an overdue car, a late collection) are
   not blocked by the trigger; the overlap they cause is reported by clash detection (`UNIT_DOUBLE_BOOKED` on the
   future booking, `RETURN_OVERDUE` on the hire) so the autopilot can move the future booking to another car.

---

## C. Clash detection

### C.1 Contract (`packages/domain/src/clash/types.ts` by `ap-foundation`; `clash/catalogue.ts`, `clash/detect.ts`, `clash/identity.ts` by `ap-clash`)

```ts
export type ClashSeverity = 'block' | 'warn' | 'info';
export type ClashOverrideClass = 'A' | 'B' | 'C';            // A manager override + reason + audit; B relaxed in manager mode; C never
export type ClashSubject =
  | { kind: 'proposed_booking'; claimId: Id; fleetUnitId: Id; use: FleetUse; startAt: ISODateTime; expectedEndAt: ISODateTime;
      hirerPartyId: Id; driverPartyIds: Id[]; excludeReservationId?: Id; stage: 'hold' | 'confirm' | 'handover' }
  | { kind: 'reservation'; reservationId: Id; stage: 'hold' | 'confirm' | 'handover' | 'return' | 'period_change' }
  | { kind: 'hire'; hireId: Id }
  | { kind: 'claim'; claimId: Id }
  | { kind: 'fleet_unit'; fleetUnitId: Id };
export interface ClashDef {
  code: ClashCode; severity: ClashSeverity; overrideClass: ClashOverrideClass;
  overrideCode: string | null;         // OVERRIDE_RULES code used by gate.refuse (§C.4); null for warn/info
  label: string; basis: string;
  subjects: ClashSubject['kind'][];    // where it is checked
  greenBlocking: boolean;              // a warn that still stops the autopilot acting alone (→ confirm)
}
export interface ClashFinding {
  code: ClashCode; severity: ClashSeverity; overrideClass: ClashOverrideClass; message: string;
  claimId?: Id; fleetUnitId?: Id; reservationId?: Id; hireId?: Id;
  related: { claimIds: Id[]; reservationIds: Id[]; hireIds: Id[]; fleetUnitIds: Id[]; partyIds: Id[] };
  dedupeKey: string;                   // code + sorted subject ids — stable across runs
  data?: Record<string, unknown>;
}
export interface ClashWorld { /* the rows detectClashes needs, assembled by the API for the subject's time window */
  claims: Claim[]; vehicles: Vehicle[]; parties: Party[]; driverProfiles: DriverProfile[];
  fleetUnits: FleetUnit[]; policies: InsurancePolicy[]; reservations: Reservation[]; hires: HireAgreement[];
  readiness: ReadinessTask[]; damage: FleetDamage[]; penalties: PenaltyNotice[];
  eventsByClaim: Record<Id, ClaimEvent[]>; acceptanceByClaim: Record<Id, AcceptanceAssessment>;
  interventionOffers: InterventionOffer[]; signedPackByReservation: Record<Id, { signed: boolean; missing: string[] }>;
}
export function detectClashes(subject: ClashSubject, world: ClashWorld, opts: { now: ISODateTime; settings: AutopilotSettings }): ClashFinding[];
```

Person identity (`clash/identity.ts`): two party rows are the same person when the ids match, or the normalised
licence numbers match, or (casefolded, whitespace-collapsed full name **and** date of birth) match. Registrations use
the existing `normaliseRegistration`; VINs are upper-cased with spaces removed.

### C.2 The catalogue (complete)

Severity: **B** block, **W** warn, **I** info. Override: A/B/C as above. "Existing" names today's code it replaces
or wraps. Subjects: P proposed booking / R reservation / H hire / Cl claim / U fleet unit.

| # | Code | Sev | Ovr | Override code | What it catches | Subjects |
|---|---|---|---|---|---|---|
| 1 | `UNIT_DOUBLE_BOOKED` | B | A | `HIRE_OVERLAP` (existing) | the car's occupied periods overlap another blocking reservation (incl. collectedAt and overdue returns) | P R H U |
| 2 | `TURNAROUND_SHORT` | W | – | – | less than `turnaroundMinutes` between a return and the next start (no time to valet/inspect) | P R U |
| 3 | `UNIT_NOT_READY` | B | A | `UNIT_NOT_READY` (new) | blocking readiness task or unrepaired major/unroadworthy damage at the start | P R U |
| 4 | `UNIT_OFF_ROAD` | B | A | `ALLOCATION_REFUSED` (existing) | car marked off road for the period | P R U |
| 5 | `UNIT_DISPOSED` | B | C | – | car disposed | P R U |
| 6 | `USE_NOT_DECLARED` | B | A | `ALLOCATION_REFUSED` | use not declared on the car (Collingwood) | P R |
| 7 | `POLICY_NOT_IN_FORCE` | B | A | `ALLOCATION_REFUSED` | no policy, policy not started/expired at the start, or not covering the use | P R H U |
| 8 | `POLICY_ENDS_IN_PERIOD` | B | A | `POLICY_ENDS_IN_PERIOD` (new) | cover ends before the expected end and no renewal policy is recorded | P R H U |
| 9 | `MOT_INVALID_AT_START` | B | A | `ALLOCATION_REFUSED` | MOT expired / not valid at the start | P R U |
| 10 | `MOT_LAPSES_IN_PERIOD` | W | – | – (green-blocking) | MOT expires during the period (task created) | P R H U |
| 11 | `TAX_INVALID_AT_START` | B | A | `ALLOCATION_REFUSED` | untaxed/SORN/expired at the start | P R U |
| 12 | `TAX_LAPSES_IN_PERIOD` | W | – | – | tax due during the period (task created) | P R H U |
| 13 | `SERVICE_DUE_IN_PERIOD` | W | – | – | service date or mileage due during the period | P R U |
| 14 | `PHV_LICENCE` | B | C | – | `pco` use without a PHV-licensed car / licence expiring in the period / TfL ZEC fail | P R |
| 15 | `KEEPER_ADDRESS_STALE` | W | – | – | V5C keeper address not current (PCNs go astray) | P R U |
| 16 | `OPEN_PENALTY_ON_UNIT` | I | – | – | open PCN/NIP with a deadline in the period | P R U |
| 17 | `UNIT_IS_CLAIM_VEHICLE` | B | C | – | the car being booked is this claim's client or third-party vehicle | P R |
| 18 | `FLEET_REG_AS_CLAIM_VEHICLE` | B | A | `HARD_STOP` (existing flag `FLEET_UNIT_AS_CLIENT_VEHICLE`) | a fleet registration recorded as a client/TP vehicle on any claim — use the "our hire car in an accident" path (§C.6) | Cl U |
| 19 | `SAME_REG_ON_HIRE` | B | A | `SAME_REG_ON_HIRE` (new) | **the client's damaged-car registration (or VIN) is the client vehicle on another claim that has an open or overlapping hire/booking** — the owner's example | P R Cl |
| 20 | `DUPLICATE_CLAIM_OPEN` | B | A | `DUPLICATE_CLAIM_OPEN` (new) | same client registration/VIN on another **open** claim with an accident date within 30 days (double recovery risk) | P Cl |
| 21 | `DUPLICATE_REGISTRATION` | W | – | – (existing flag) | same registration on another claim otherwise (closed, or accidents far apart) | Cl |
| 22 | `VIN_REG_MISMATCH` | W | – | – | same VIN under a different registration on another claim (cherished plate) | Cl |
| 23 | `CLAIM_SECOND_HIRE` | B | A | `CLAIM_SECOND_HIRE` (new) | this claim already has another held/confirmed/on-hire reservation overlapping the period (swaps are touching periods) | P R |
| 24 | `HIRER_ON_OTHER_HIRE` | B | A | `HIRER_ON_OTHER_HIRE` (new) | the hirer (same person by identity rules) has an overlapping booking/hire on another claim | P R H |
| 25 | `DRIVER_ON_OTHER_HIRE` | W | – | – (green-blocking) | an additional driver is also named on another overlapping hire | P R H |
| 26 | `DRIVER_INELIGIBLE` | B | C | – | main or additional driver `ineligible` against the car's policy (disqualified, no full licence, excluded code…) | P R |
| 27 | `DRIVER_REFERRAL` | B | A | `DRIVER_REFERRAL` (new; override needs an evidence id of the insurer's acceptance) | driver `refer` outcome | P R |
| 28 | `LICENCE_CHECK_STALE` | B | A | `LICENCE_CHECK_STALE` (new) | at handover: no licence evidence, or DVLA check older than 14 days | R (handover) |
| 29 | `HIRE_BEFORE_ACCIDENT` | B (new booking) / W (backdated hire) | B | `HIRE_BEFORE_ACCIDENT` (new) | start before the accident | P R H |
| 30 | `HIRE_BEFORE_SERVICES` | W | – | – | start before FNOL / services agreed | P R H |
| 31 | `HIRE_PAST_OFFHIRE` | W | – | – (green-blocking for extensions) | expected end / end after the off-hire deadline for the recorded trigger (days beyond are unrecoverable) | R H |
| 32 | `RETURN_OVERDUE` | W | – | – | on hire past its expected end and not returned | R H U |
| 33 | `CLAIM_STATUS_NO_HIRE` | B | C | – | claim `declined`, `settled` or `closed` | P R |
| 34 | `ACCEPTANCE_CONDITIONS_UNMET` | B | A | `ACCEPTANCE_CONDITIONS_UNMET` (new) | acceptance decision `decline`, or `accept_with_conditions` with a condition not met (e.g. "no hire until liability evidence obtained") | P R |
| 35 | `HARD_STOP_FLAG` | B | A | `HARD_STOP` (existing) | uncleared block flag on the claim | P R |
| 36 | `SIGNATURES_MISSING` | B | A | `SIGNATURES_MISSING` (new) | at handover: CCGUK-03, Sch 3 form or express request not signed / provided | R (handover) |
| 37 | `GROUP_ABOVE_LFL` | W | – | – (green-blocking) | car group above the client's like-for-like with no substitution reason | P R |
| 38 | `NEED_WEAK` | W | – | – (green-blocking) | need weak/none (another household car, own insurer's courtesy car) | P Cl |
| 39 | `INTERVENTION_UNANSWERED` | W | – | – (green-blocking) | an insurer intervention offer without a written reply | P Cl |
| 40 | `CLIENT_CAR_NOT_LEGAL` | W | – | – (green-blocking) | client's car had no MOT/tax on the accident date (insurance unknown is not flagged) | Cl |
| 41 | `INJURY_NOT_REFERRED` | I | – | – | injury on file with no PI referral | Cl |
| 42 | `DELIVERY_BEFORE_READY` | B | A | `UNIT_NOT_READY` | delivery window before the car is ready | R |
| 43 | `DELIVERY_CAPACITY` | W | – | – | more movements in a window than `maxPerWindow` | R |
| 44 | `HOLD_EXPIRED` | B | C | – | confirming or offering a hold that has expired (re-hold instead) | R |

(The table has 44 rows: 34 distinct business checks plus the split start/period variants of policy, MOT and tax and
the delivery/handover variants.) Labels and override warnings for the new override codes are added to
`OVERRIDE_RULES` (class A): `UNIT_NOT_READY`, `POLICY_ENDS_IN_PERIOD` ("the car would be uninsured after <date>"),
`SAME_REG_ON_HIRE` ("possible double hire for one accident — fraud risk"), `DUPLICATE_CLAIM_OPEN`,
`CLAIM_SECOND_HIRE`, `HIRER_ON_OTHER_HIRE`, `DRIVER_REFERRAL` ("only with the insurer's written acceptance"),
`LICENCE_CHECK_STALE`, `ACCEPTANCE_CONDITIONS_UNMET`, `SIGNATURES_MISSING` ("an unsigned hire is unenforceable — W v
Veolia"); class B: `HIRE_BEFORE_ACCIDENT`.

### C.3 When it runs

| Trigger | Subject | Effect |
|---|---|---|
| Booking dialog (live, read-only `POST /clashes/check`) | proposed_booking | panel shows findings before submit |
| `booking_hold`, `booking_confirm`, `booking_update_period`, handover, return, `POST /claims/:id/hire`, `PATCH /claims/:id/hire/:hireId` | proposed_booking / reservation / hire | **block** findings refuse through the gate; warn findings stored and returned |
| Claim changes: `PATCH /vehicles/:id` (registration/VIN), `PATCH /claims/:id` (accident date, vehicles), party DOB/licence edits, driver profile edits, acceptance/eligibility recorded, status change, off-hire trigger events | claim (+ its reservations) | `clash.check` job (io, idempotent per minute) → findings upserted; a new block finding on a claim with a future booking → Needs-you `clash_review` |
| Every autopilot step that holds, offers, confirms, schedules or hands over | reservation | fresh check inside the step; findings decide green |
| Nightly `clash.sweep` 02:30 London | every open claim with a reservation or hire, every fleet unit | findings upserted; resolved ones closed; daily-log lines; new **block** findings within 48 h of a start → urgent Needs-you |

`crossFileRegistrationCheck` now also runs on `PATCH /vehicles/:id` when the registration or VIN changes (gap:
today it runs only at FNOL), and `DUPLICATE_CLAIM_OPEN` compares open claims and accident dates (today all claims,
including closed ones, count the same).

### C.4 Persistence, resolution and overrides

* `clash_findings` holds open findings keyed by `dedupe_key` (unique while open). A run that no longer sees a finding
  marks it `resolved` (`resolved_by: 'system'`). A person may `acknowledge` a warn (reason) — it stops counting as
  green-blocking for that claim — or `resolve` a finding manually (reason; audited).
* **Block findings are enforced in the routes** through the existing manager-mode gate:
  `gate.refuse(conflict(<overrideCode>, message, { findings }), { claimId, entity: 'fleet_reservations', entityId })`.
  Class A: a manager in manager mode with `X-Manager-Override` proceeds; the reservation stores
  `overlap_override_audit_id` for `UNIT_DOUBLE_BOOKED`, the finding becomes `overridden` with the reason; the
  `override.<CODE>` audit row is written by the existing `onSend` hook. Class C codes are thrown as plain conflicts
  and are never overridable. Class B (`HIRE_BEFORE_ACCIDENT`) is relaxable in manager mode like other B codes.
* **Agents** never override (SD §B.2 rule 2): a refusal carrying `error.override` becomes Needs-you
  `override_needed`; the autopilot step is `blocked` with the clash code.

### C.5 Where clashes are shown

* **Booking dialog**: a Clash panel under the ranked list — block findings red with "Override as manager" (class A,
  only in manager mode, reason box), warn amber with "I've read this" (acknowledge), info grey.
* **Claim**: a Clashes card at the top of the Autopilot tab and in the Flags tab; blocked steps link to the finding;
  the claim header banner shows the count of open block findings.
* **Fleet calendar**: red outline on overlapping bars, amber markers for lapses inside bookings; `/fleet/clashes`
  lists all open findings with filters (code, severity, unit, claim).
* **Daily log**: section `clashes` — new, overridden and resolved findings of the day with rule codes.

### C.6 Our hire car in a new accident (sanctioned path)

Today a fleet registration entered as a client/TP vehicle is a hard stop (`FLEET_UNIT_AS_CLIENT_VEHICLE`). Autopilot
adds an explicit path: in the New Claim wizard (and intake), when the registration is a fleet unit with a hire or
reservation covering the accident time, ClaimDesk offers **"Record an incident on hire CCG-H-…"**: it appends a
`note` event and a `fleet_damage` row on the fleet unit (chargeable `tbc`), links the hire, the hirer and the fleet
policy, raises Needs-you `autopilot_step` ("Notify the fleet insurer; decide whether the hirer's own claim is a new
file"), and keeps the hard stop for creating a client claim *on our own car* (class A override remains for genuine
exceptions).

---

## D. Hire offer, acceptance and paperwork

### D.1 Flow and the "green" test

```
hire.search ─▶ ranked list ─┬─ green & clear winner ───────────────▶ hold (auto) ─▶ offer (auto, held 10 min for Undo)
                            ├─ green, close call ─▶ autopilot.judge ─▶ hold (auto) ─▶ offer (auto)
                            └─ not green ─▶ hold top car (auto) + Needs-you choose_car (ranked list, recommendation)
                                              owner picks ─▶ hold moves if needed ─▶ offer (auto: owner-authorised)
offer sent ─▶ reply "yes" (code) / unclear (hire_offer.parse_reply) / "accepted by phone" (person)
          ─▶ booking_confirm ─▶ movement_schedule + booking_update email ─▶ pack.prepare hire_start ─▶ approve_pack (owner)
          ─▶ pack emailed to client (durable medium, CCR 2013) ─▶ handover (person; kiosk signing) ─▶ hire started
          ─▶ letter.hire_start_notice to the at-fault insurer (auto) ─▶ on hire …
```

**Green** (all must hold; `booking/green.ts`, pure, each failure is a plain-English reason on the card):

1. Top candidate `likeForLike.score ≥ settings.booking.minLikeForLike` (0.8) and not above the client's group.
2. Every hard need met (§B.5 filter 5) and no green-blocking warn finding (§C.2 column "green-blocking").
3. `assessAcceptance().decision === 'accept'`, or `accept_with_conditions` with every condition met.
4. Driver(s) `eligible` against this car's policy (a `refer` is never green).
5. Need `strong` or `moderate`; no intervention offer unanswered; client wants hire.
6. Client email on file and not bounced; the claim is not paused; daily auto-offer cap not reached.

### D.2 Hire offers (`hire_offers`, `apps/api/src/autopilot/hireOffers.ts`)

```ts
export interface HireOfferTerms {
  reservationId: Id; fleetUnitId: Id; registration: string; makeModel: string; transmission: string; seats: number | null;
  fuel: string | null; gtaGroup: string; clientGtaGroup: string | null; likeForLike: string;      // code-built sentence
  startAt: ISODateTime; expectedEndAt: ISODateTime;
  delivery: { windowStart: ISODateTime; windowEnd: ISODateTime; addressShort: string } | null;
  expiresAt: ISODateTime; alternatives: Array<{ fleetUnitId: Id; label: string }>;              // shown, not held
}
export interface HireOffer {
  id: Id; claimId: Id; reservationId: Id; status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'withdrawn' | 'superseded';
  channel: 'email' | 'sms' | 'phone' | 'in_person'; terms: HireOfferTerms; termsSha256: string;
  outboxId?: Id; authorisedBy: 'autopilot_green' | string /* owner user id */; sentAt?: ISODateTime; expiresAt: ISODateTime;
  response?: { at: ISODateTime; how: 'email_reply' | 'phone' | 'in_person' | 'sms'; decision: 'accept' | 'decline';
    messageId?: Id; recordedBy: string; chosenFleetUnitId?: Id; note?: string; confidence?: number };
  createdBy: string; createdAt: ISODateTime; updatedAt: ISODateTime;
}
```

**The offer email** (`email_draft` kind `hire_offer`, from "Claims Team, Courtesy Cars Group UK Ltd", subject
`Your replacement car — {{fact:booking.unit.makeModel}}` + the claim reference). Body built by code from the terms;
the judge may replace the introduction paragraph (`wording.offerIntro`, placeholders only):

1. Greeting; one sentence on the accident date (fact).
2. The car: make/model, transmission, seats, fuel; the like-for-like sentence, e.g. "It is in the same hire group as
   your own car ({{fact:client.vehicle.gtaGroup}}) and is an automatic, as you need."
3. Delivery: date/window and address (facts), or "we will call to arrange delivery".
4. How it works, plainly: a credit hire agreement; the charges are claimed from the at-fault driver's insurer; the
   client signs the agreement and a condition report at handover; they will receive the pre-contract information and a
   cancellation form first and have a 14-day right to cancel; they will be asked to request that the hire starts
   straight away.
5. The neutral intervention sentence (script-guard compliant): "If the other driver's insurer offers you a car
   directly, please tell us straight away so we can record it and help you decide — you are free to consider their
   offer."
6. "To accept, reply YES to this email or call us. This car is held for you until {{fact:offer.expiresAt}}."
7. Signature block (SD §F.6).

Reviewer additions (tier a, `apps/api/src/autopilot/offerChecks.ts`, registered for kind `hire_offer`):
`HIRE_OFFER_FREE_WORDING` (block: "free", "no cost to you" or similar), `HIRE_OFFER_INTERVENTION_GUARD` (block:
`assertScriptGuard` on the text — never tell the client to ignore/decline an insurer's offer),
`HIRE_OFFER_TERMS_MISMATCH` (block: any registration, date or window in the text differs from the bound terms),
`HIRE_OFFER_RATE_STATED` (warn: daily rates belong in the agreement, not the offer).

### D.3 Commitment verification (the one exception to `touches.newCommitment`)

A hire offer and a delivery-slot confirmation create a commitment. They may go automatically only when code verifies
the commitment at decision time. `applyAutopilotCommitment(ctx, outbox, descriptor)` (exported by
`apps/api/src/autopilot/commitment.ts`) is called by the mail slice's external-send decision path (`outbox.after_review`
and `send_request`) immediately before `decide()`; it sets `descriptor.step` from `outbox.autopilot_step_id` and,
for kinds `hire_offer` / `booking_update`, `descriptor.commitment = { kind, refId, verified, reasons }` where
`verified` requires all of:

* exactly one `hire_offers` row in `draft` (or one `fleet_movements` row in `planned`) bound to this outbox id;
* its reservation is `held` (offer) / `confirmed` (slot) for the same claim, hold not expiring within 30 minutes;
* `termsSha256` equals the hash recomputed from the current reservation and movement (nothing changed since drafting);
* a fresh `detectClashes(reservation)` has no block and no green-blocking warn;
* the offer is `authorisedBy` an owner (owner chose the car) **or** the step is green and its effective mode `auto`.

Anything else → `verified: false` → SD rule 13 asks (Needs-you `approve_send` with the reasons). On send, the offer
becomes `sent` (`sentAt`, `expiresAt` = hold expiry), event `hire_offered` is appended (chronology evidence of
mitigation and promptness).

### D.4 Acceptance

* **Email reply**: the autopilot tick sees a new inbound message on the claim whose `In-Reply-To`/`References` hit
  the offer's SMTP message id (or whose subject carries the claim reference and "replacement car") and whose sender
  equals the client's email on file. Code first: the first non-quoted line matching
  `/^\s*(yes|yes please|yes thanks|i accept|accept(ed)?|ok(ay)?|that'?s fine|go ahead|perfect)\b/i` → accept
  (confidence 0.95); `/^\s*(no|no thanks|decline|not needed|don'?t need)\b/i` → decline (0.95). Otherwise enqueue
  `hire_offer.parse_reply` (mail agent, no tools, untrusted email block, result below). Sender not the client →
  Needs-you `question` ("Someone else replied to the offer").
* **Phone / in person**: "Accepted by phone" on the offer card (Autopilot tab, Hire tab, Needs-you) →
  `POST /hire-offers/:id/accept { how: 'phone', note }` as the person; a `call` event is appended.
* `hire_acceptance_record` (internal) writes the response; confidence < 0.9 or `change_request`/`question` →
  Needs-you `question` with the parsed points and a prepared reply.
* Reminder at `offerReminderHours` (4) by `booking_update` email; at expiry the hold expires, the offer becomes
  `expired`, Needs-you `question` "Client has not replied — call them?" plus a `call` task; a later "yes" re-holds the
  car if still free, else re-searches.
* Decline → reservation `cancelled` (reason `client_declined_hire`), event `hire_offer_declined`; if the reply says
  why (needs changed), the needs are updated (proposal, confirm when sensitive) and `hire.search` re-runs.

```ts
export interface HireReplyResult {                       // result schema id 'hire_reply'
  decision: 'accept' | 'decline' | 'question' | 'change_request' | 'unclear';
  chosenOptionId: string | null;                         // which car, when alternatives were listed
  preferredDelivery: { date: string | null; part: 'morning' | 'afternoon' | 'evening' | null; text: string | null };
  needsChanged: string[]; questions: string[]; confidence: number; injectionSuspected: boolean;
}
```

### D.5 Confirm → delivery → paperwork

On acceptance: `booking_confirm` (agreement number), `movement_schedule` (delivery slot from the reply or the first
proposed slot), `email_draft` kind `booking_update` with **new** `letter.booking_confirmation` content (auto,
commitment verified), then `pack.prepare` for `hire_start`. When the owner approves the pack (`approve_pack`, one
click: approves every document as the owner and queues the email), the client receives the hirer copy of CCGUK-03,
the Sch 3 cancellation form, the express request form and the cover confirmation as PDFs — this is the durable-medium
pre-contract information under CCR 2013 and sets `cancellationInfoProvidedAt` on the reservation's pack record (copied
to the hire at handover).

### D.6 Stage packs (`packages/domain/src/signing/packs.ts`, data; owned by `ap-paperwork`)

| Stage | Items (template · variant · purpose · signer · when) |
|---|---|
| `signup` | `agreement.ccguk_01_customer_loa` · sign · client; `form.ccguk_09_accident_report` · sign · client; `agreement.ccguk_02_recovery_storage_engineering` · `instruction` · sign · client · when recovery, storage or engineer needed; outgoing (separate steps): `letter.ncaf`, `letter.cctv_preservation`, `letter.handling_ref_request` |
| `hire_offer` | `form.statement_of_need` · sign · client (prefilled from need answers, verbatim); `form.ccguk_07_statement_of_means` · sign · client · when impecuniosity relied on; `form.ccguk_08_intervention_mitigation` · sign · client |
| `hire_start` | `agreement.ccguk_03_credit_hire` · `hirer` · sign · hirer; `agreement.ccguk_03_credit_hire` · `office` · internal; `form.cancellation_sch3` · give · hirer; `form.express_request_to_start` · sign · hirer; `form.ccguk_06_handover_condition` · `release` · sign · hirer (completed at handover); **new** `form.hire_cover_confirmation` · give · hirer; checklist (not documents): licence evidence, DVLA check ≤ 14 days, proof of address |
| `off_hire` | `form.ccguk_06_handover_condition` · `return` · sign · hirer; `letter.booking_confirmation` (collection slot) |
| `billing` | `invoice.hire`; `invoice.storage` · when storage; `invoice.recovery` · when recovery; `invoice.engineer_fee` · when engineer; **new** `form.hire_period_validation` (the id `validatePaymentPack` already expects); `form.ccguk_05_payment_direction` · sign · client |
| `payment` | `pack.gta_payment`; `schedule.loss`; `statement.ccguk_04_witness` · sign · client; covering letter on `letter.ccguk_letterhead_formal` |
| `closure` | **new** `letter.closure` to the client |

```ts
export type PackStage = 'signup' | 'hire_offer' | 'hire_start' | 'off_hire' | 'billing' | 'payment' | 'closure';
export interface PackItemDef { templateId: string; variant?: string; format: 'html' | 'docx'; purpose: 'sign' | 'give' | 'send_insurer' | 'internal';
  signer?: 'client' | 'hirer' | 'driver'; when?: string /* PredicateId over AutopilotFacts */ }
export interface DocumentPack {
  id: Id; claimId: Id; stage: PackStage; reservationId?: Id;
  items: Array<PackItemDef & { documentId?: Id; status: 'pending' | 'drafted' | 'reviewed' | 'approved' | 'sent' | 'signed' | 'not_needed'; reviewId?: Id }>;
  status: 'preparing' | 'reviewing' | 'awaiting_approval' | 'approved' | 'sent' | 'signed' | 'superseded' | 'cancelled';
  approvedBy?: string; approvedAt?: ISODateTime; sentAt?: ISODateTime; outboxId?: Id;
  createdBy: string; createdAt: ISODateTime; updatedAt: ISODateTime;
}
```

`pack.prepare` (cpu lane, agent `autopilot`) creates each document through the existing tools as `agent:autopilot`:
Word templates via `docx_document_draft` (values from `GET /claims/:id/docx-templates/:templateId/values`, never
typed by a model), HTML templates via `document_draft`; each enqueues SD's `review.check`; when every item has a
`pass` review the pack becomes `awaiting_approval` and Needs-you `approve_pack` is created with a preview of every
document, the reviewer verdicts, and options **Approve and send** / **Approve only** (to sign in person) / **Edit** /
**Reject**. The resolver runs as the owner: `approveDocument` for each (human — the §D.5 auto-approval never applies
to `agreement.*`/`form.*`/`invoice.*`/`pack.*`), then creates/approves the outbox (kind `signature_request` to the
client, or the payment pack to the insurer) straight to `queued` (SD §D.3 owner approval).

**New templates** (`packages/documents/src/templates/letters-c.ts` and `forms-c.ts`, owned by `ap-paperwork`):
`letter.hire_offer` (the printable/HTML twin of the offer email), `letter.booking_confirmation`,
`letter.hire_start_notice`, `letter.signature_request`, `letter.signature_chase`, `letter.recovery_storage_instruction`,
`letter.decline`, `letter.closure`, `form.hire_period_validation`, `form.hire_cover_confirmation` ("Hire vehicle
insurance confirmation — this is not a certificate of motor insurance": insurer, policy number, permitted drivers,
use, period; the insurer's certificate is attached as evidence when the policy holds one). All follow the existing
registry pattern, letterhead and consistency rules (no legacy details, GTA as benchmark only, registered name).

### D.7 Third-party insurer notification and intervention

* **NCAF** (`notify.ncaf`): unchanged template and clock; the autopilot appends `services_agreed` when CCGUK-01 is
  signed (or when the booking is confirmed, whichever is first) so the GTA 4.1 clock starts from a recorded event.
* **Hire start notice** (`hire.start_notice`): **new** `letter.hire_start_notice` to the at-fault insurer within 1 WD
  of the start — vehicle group, start date, agreement number, the handling reference, an invitation to contact us
  about the hire; no daily rate (rates go with invoices), so it does not touch money and is in the default auto-send
  allow-list. Semantic send event `hire_start_notice_sent`.
* **Intervention** (`notify.intervention`): when an `intervention_offer` event arrives (from triage intent
  `intervention_offer`), the autopilot (a) tells the client neutrally what was offered (`client_update`, auto, script
  guard enforced), (b) prepares `letter.intervention_reply` and the CCGUK-08 record for the 1-WD clock → urgent
  Needs-you (`letter.intervention_reply` is always-ask), (c) if the client accepts the insurer's car, proposes
  releasing our hold/booking (auto for a hold, confirm for a confirmed booking, owner for a car on hire).
* `letter.supplier_instruction_engineer` gains semantic send event `engineer_instructed` (gap: today none), so the
  period gate and the autopilot see it.

### D.8 Billing and the ledger

`money.invoices` prepares the billing pack and, in the same Needs-you card, the ledger rows to write:
`claimed` per head (hire from `calculateHire` to the contractual end; storage; recovery as today) and `invoiced` per
approved invoice (`ledger_propose`, class `money`, always asks). The owner's approval writes them as the owner through
`POST /claims/:id/ledger`. The payment pack follows (`money.payment_pack`), then chasers (auto), offers and payments
(owner).

### D.9 Settlement offers (fix for a phase-1 defect)

If, when `ap-autopilot` starts, the gateway tool `offer_record` still posts insurer **settlement** offers to
`POST /claims/:id/offers` (the **intervention** register — which starts an `intervention_reply_1wd` clock and pollutes
the mitigation gate), it is re-pointed to a new register: table `settlement_offers` (§G.2), routes
`GET/POST /claims/:id/settlement-offers`, `PATCH /claims/:id/settlement-offers/:oid` (decision fields human-only);
`offers_list` returns both registers; `offer.analyse` and Needs-you `offer_decision` read the new register. Triage
intent `intervention_offer` keeps going to the intervention register. A test asserts that recording a settlement offer
creates no `intervention_reply_1wd` clock and leaves the mitigation gate unchanged.

---

## E. Signing on a localhost app

### E.1 What works without a public server

The API listens on `127.0.0.1` (config `HOST`), so a client cannot open a link on their own phone. Three ways work
without a public server; all keep e-signature human-only (`assertHuman`):

| Method | Where | Evidence strength | Default |
|---|---|---|---|
| **Kiosk, OTP by email** | client at the office PC (or a tablet on the LAN, §E.3) | strong: OTP to the client's own email + typed name + drawn signature + IP/UA + doc hash | on when the IONOS mailbox is configured |
| **Kiosk, code shown to handler** | same | weaker: the handler passes the code (audited `document.sign.code_shown_to_handler`, as today) | fallback when mail is not configured |
| **Wet ink / scan** | PDFs emailed or printed; client signs on paper; scan or photo returned by email or brought in | ordinary wet signature; the scan is write-once evidence | always available |

### E.2 In-person kiosk (`apps/web/src/screens/sign/KioskPage.tsx`, `apps/api/src/signing/kiosk.ts`)

1. The handler opens the approved pack and clicks **Sign in person** → `POST /packs/:id/kiosk` (human-only) →
   `kiosk_sessions` row: 32 random bytes token (sha256 stored), 30-minute TTL, bound to the pack, the signer party and
   the creating user.
2. The browser goes full screen at `/sign/kiosk/:token` — a page outside the app shell with no navigation; it calls
   only `/api/kiosk/:token/*` (token auth, not the session): pack summary (signer name, document list), each document
   as PDF (`GET /api/kiosk/:token/documents/:docId/pdf`), "I have read this" per document (scroll to end required),
   typed full name, a drawn signature (canvas → PNG, size-limited 200 KB), and the one-time code.
3. `POST /api/kiosk/:token/otp/start` → existing `startSignature` per document (actor = the kiosk creator — a human;
   channel `email` to the signer's email on file). With mail configured the code is emailed immediately through the
   mail slice's SMTP sender (transactional, not the outbox hold; audited `document.sign.otp_sent`); without, the code
   is shown on the handler's screen (`esignDelivery: 'handler'` behaviour, audited).
4. `POST /api/kiosk/:token/sign { typedName, drawnSignaturePngBase64, code, consent: true }` → existing
   `verifySignature` per document with the drawn signature stored as evidence (`kind: 'signature_image'`) and its
   sha256 added to the certificate (`SignatureRecord.method: 'kiosk_otp_email' | 'kiosk_handler_code'`,
   `drawnSignatureSha256`). Each document becomes `signed`; certificates as today.
5. **Exit** requires the handler's password (`POST /api/kiosk/:token/close { password }` checks the creator's
   password with the existing auth service); idle 5 minutes → the page blanks and asks for the handler.

### E.3 Optional tablet on the office network (off by default)

`SIGNING_LAN=1` (Settings > Autopilot > Signing, with a plain warning) starts a **second** Fastify listener on
`SIGNING_LAN_HOST` (default the PC's LAN address) and `SIGNING_LAN_PORT` (default 5181) that serves only the kiosk
page bundle and `/api/kiosk/*`. Nothing else of the API is reachable from the LAN. The kiosk URL with its token is shown
as a QR code on the PC. Limits stated in the UI: plain HTTP on the local network (no TLS) — use only on a trusted
office Wi-Fi or the PC's own hotspot; Windows Firewall asks once; tokens expire in 30 minutes, are single-pack and are
pinned to the first device that opens them.

### E.4 Emailed PDFs for wet or scanned signature

* **Send**: from the approved pack, **Approve and send** emails the PDFs (`letter.signature_request` as the cover)
  — owner-approved, because the attachments are always-ask templates. One `signature_requests` row per document to
  sign, status `sent`.
* **Chase**: `signing.chase` (daily 09:15) sends `letter.signature_chase` (auto-send allow-listed, kind `chaser`) after
  2 and 5 days; after 7 days → Needs-you `question` ("call the client") and a `call` task. Each chase increments
  `chase_count`.
* **Return and filing**: a returned scan arrives by email (mail ingest stores it as evidence; intake classifies it as
  `signed_ccguk_form` by the template fingerprint, SD §G.2) or is uploaded/dropped in the import folder.
  `signing.match_return` (every 15 minutes) matches new evidence on claims with open requests (doc type, template
  fingerprint, page count, signer name in text) → Needs-you `confirm_signed` showing the scan beside the generated PDF.
  The owner/handler confirms → `POST /documents/:id/mark-signed { evidenceId, signerPartyId, signedOn, method:
  'wet_ink' | 'scan' }` (human-only; new) → document `signed` with `SignatureRecord.method` and the evidence id; the
  request becomes `signed`. Agents never mark anything signed.

### E.5 Signed paperwork → hire enforceability (fixes the wiring gap)

`syncEnforceabilityFromPack(ctx, tx, reservationId | hireId)` (`apps/api/src/signing/enforceability.ts`) runs when a
pack document is signed/sent and at handover:

| Evidence | Field |
|---|---|
| CCGUK-03 hirer copy (canonical `agreement.credit_hire`) signed | `signedAt`, `documentId` |
| Pack with CCGUK-03 + Sch 3 sent to the client (durable medium) or handed over in the kiosk | `enforceability.cancellationInfoProvidedAt` |
| `form.cancellation_sch3` given (sent or kiosk-read) | `enforceability.schedule3FormProvidedAt` |
| `form.express_request_to_start` signed | `enforceability.expressRequestToStartAt`, `expressRequestEvidenceId` |
| CCGUK-03 template marked art 60F-compliant in its built-in metadata (≤ 12 payments within 12 months, no interest or charges) | `enforceability.cca60fCompliant = true` (otherwise the owner confirms) |

A hire created from a reservation therefore starts with no `HIRE_ENFORCEABILITY_GAP` when the pack was done properly;
for existing hires a new human route `PATCH /claims/:id/hire/:hireId/paperwork` lets the owner link signed documents
and re-run the sync.

### E.6 What needs a public server (not built; optional later)

* The client signing **remotely** on their own device (an e-sign link) needs an internet-reachable HTTPS endpoint
  (a tunnel or a small hosted signing page). Not built; ClaimDesk works fully without it.
* A third-party e-signature provider could be added later **without** a public URL by polling the provider for
  completion (no inbound webhook). Not built.
* Inbound SMS replies (phase 2) would need a webhook or polling the provider's message list; polling works without a
  public URL. Not built here.

---

## F. Eligibility

### F.1 Driver eligibility (`packages/domain/src/eligibility/driver.ts`, pure)

```ts
export interface DriverProfile {
  partyId: Id; licenceNumber?: string; licenceCountry: 'GB' | 'NI' | 'EU_EEA' | 'OTHER' | 'unknown';
  licenceType: 'full' | 'provisional' | 'international' | 'unknown';
  fullLicenceSince?: ISODate; licenceExpiry?: ISODate; categories: string[]; restrictionCodes: string[];   // e.g. '78' automatic only
  points: number | null; endorsements: Array<{ code: string; offenceDate: ISODate; points: number }>;
  disqualifiedUntil?: ISODate; disqualifications5y: number | null; faultAccidents3y: number | null;
  unspentConvictions: string[] | null; medicalConditionsDeclared: boolean | null; occupation?: string;
  dvlaCheck?: { checkedAt: ISODateTime; checkedBy: string; summary: string; evidenceId?: Id };
  source: 'declared' | 'dvla_check' | 'licence_scan' | 'mixed'; updatedBy: string; updatedAt: ISODateTime;
}
export type EligibilityOutcome = 'eligible' | 'refer' | 'ineligible' | 'unknown';
export interface DriverEligibility {
  partyId: Id; outcome: EligibilityOutcome; reasons: Array<{ code: string; outcome: EligibilityOutcome; message: string }>;
  missing: string[]; criteriaSource: 'policy' | 'settings_default'; policyId?: Id;
  ageAtStart?: number; yearsFullLicence?: number; automaticOnly: boolean; youngDriverExcessPence?: Pence;
}
export function assessDriver(profile: DriverProfile | undefined, party: Pick<Party, 'dateOfBirth' | 'drivingLicenceNumber' | 'name'>,
  criteria: DriverCriteria, at: ISODate): DriverEligibility;
```

The licence number is cross-checked against surname/DOB encoding (SD §G.2 validators) → `LICENCE_NUMBER_MISMATCH`
(refer). The outcome is the worst reason. Missing DOB, licence type, full-licence date or points → `unknown` with
`missing`, which makes `qualify.driver` ask the client (prepared `doc_request`: photo of both sides of the licence and
a DVLA "share your licence" check code). ClaimDesk cannot query DVLA itself (no API access); the handler records the
check result (date, summary, optional screenshot evidence). Additional drivers are assessed with the same criteria.

### F.2 Criteria (per insurance policy; defaults in Settings > Fleet > Driver criteria)

```ts
export interface DriverCriteria {
  minAge: number; referBelowAge: number; maxAge: number; referAboveAge: number;
  minYearsFullLicence: number; referBelowYearsFullLicence: number;
  maxPointsEligible: number; maxPointsRefer: number;                 // above refer band → ineligible
  excludedEndorsementPrefixes: string[]; excludedLookbackYears: number;
  referEndorsementPrefixes: string[];
  maxFaultAccidents3yEligible: number; maxFaultAccidents3yRefer: number;
  disqualificationLookbackYears: number;
  licenceCountriesEligible: Array<DriverProfile['licenceCountry']>; licenceCountriesRefer: Array<DriverProfile['licenceCountry']>;
  provisionalAllowed: false; requireDvlaCheckWithinDays: number; unspentConvictionsRefer: boolean;
  youngDriverExcessPence: Pence | null;
}
```

Default values (generic UK hire-insurer norms — **the owner must check them against the real policy wording**):
ages 25–75 eligible, 21–24 and 76–79 refer, under 21 or 80+ ineligible; full licence ≥ 2 years eligible, 1–2 years
refer, < 1 year ineligible; points 0–6 eligible, 7–9 refer, ≥ 10 ineligible; endorsement codes starting `DR`, `IN`,
`UT`, `CD4`, `CD7`, `DD`, `BA`, `AC`, `TT99` within 5 years ineligible; `CD1`–`CD3`, `MS`, `SP50`+ refer;
disqualification within 5 years ineligible; fault accidents in 3 years 0–1 eligible, 2 refer, ≥ 3 ineligible; GB/NI
eligible, EU/EEA eligible, other countries refer; provisional never; DVLA check within 14 days of handover; unspent
motoring or dishonesty convictions refer; young-driver excess not set (owner enters).

### F.3 Client need (`eligibility/need.ts`)

`HireNeeds` (§B.5) is captured from the intake script answers (`need.occupation`, `need.journeys`,
`need.dependants`, `need.otherVehicles`), intake extraction, client replies and the handler (`claim_hire_needs`).
`assessNeed(needs, bundle) → { level: 'strong' | 'moderate' | 'weak' | 'none' | 'unknown', reasons, missing,
mitigationRisks }`: strong = no other vehicle and car used for work/caring/school/medical journeys; moderate = regular
journeys, no other vehicle; weak = another household vehicle available, or own insurer's courtesy car offered/accepted;
none = client says no car needed; unknown = need answers missing (→ ask the client). `phvWork` → PCO use;
licence restriction 78 → `automaticOnly`. Weak need is not a refusal — it makes the offer step `confirm` and warns
that hire may be challenged (`NEED_WEAK`).

### F.4 Means (`eligibility/means.ts`)

`assessMeans(bundle, gates)` reuses `impecuniosityReadiness`: `impecunious` (CCGUK-07 and statements show no
reasonable alternative), `not_impecunious`, `unknown`. It does **not** stop the offer by default
(`settings.eligibility.requireMeansBeforeOffer = false`); when `not_impecunious`/`unknown` the offer card and the
billing step carry the warning that recovery may be limited to a basic hire rate (Dimond v Lovell; Lagden v O'Connor).

### F.5 Roadworthiness and the hire start (`eligibility/roadworthiness.ts`)

From `accident.driveable`/`roadworthyAfter`, the engineer's findings and the repair booking: not driveable → hire
from now; driveable → hire from the repair start (mitigation), unless the owner confirms otherwise. Optional DVLA/DVSA
lookup of the client's car (`vehicle_lookup`, existing, rate-limited) records MOT/tax status on the accident date
(`CLIENT_CAR_NOT_LEGAL` warn). Client-car insurance on the day is not verifiable by ClaimDesk and is not flagged.

### F.6 Personal injury

`routeInjury` (existing) decides referral; `intake.injury_referral` prepares `legal_escalate` (matter `injury`;
always asks; no referral fee — LASPO 2012 ss.56–60). PI never blocks hire; `INJURY_NOT_REFERRED` is info.

### F.7 Overall eligibility and where it is used

```ts
export interface EligibilitySummary {
  overall: EligibilityOutcome; driver: DriverEligibility; additionalDrivers: DriverEligibility[];
  need: NeedAssessment; means: MeansAssessment; roadworthiness: RoadworthinessAssessment;
  injury: { referralNeeded: boolean; referred: boolean }; green: boolean; reasons: string[];
}
```

Recorded (append-only `eligibility_assessments`) by `eligibility_assess` whenever an input changes. Used by: the
availability filter (per-car policy criteria), the green test, the `qualify.*` steps, clash codes 26–27, the handover
guard, and the CCGUK-03 driver declarations (prefilled from the profile through the docx value resolver, still shown
to the client to confirm at signing).

---

## G. Data model and migration

### G.1 Migration numbering and the order guard

SD §N: "the drizzle migrator only applies a migration whose `when` is greater than the last applied one" — confirmed
in `drizzle-orm`'s sqlite dialect (`lastDbMigration.created_at < migration.folderMillis`). Autopilot therefore uses:

| Migration file | Journal `when` | Owner |
|---|---|---|
| `0012_autopilot.sql` | **1792250000000** | `ap-foundation` |
| phase 2 `0013_engineer_calls_sms.sql` (renamed from SD's `0012_…`) | 1792300000000 (unchanged) | `p2-foundation` |
| phase 3 `0014_learning.sql` (renamed from SD's `0013_…`) | 1792400000000 (unchanged) | `p3-foundation` |

A Knowledge Builder migration landing after Autopilot and before phase 2 takes the next free file number and a `when`
in 1792260000000–1792290000000. Two guards make a silent skip impossible:

1. `packages/db/src/migrationOrder.test.ts`: journal `when` values strictly increase in array order; file numbers are
   unique; every journal tag has a file.
2. `runMigrations` (boot): before calling drizzle, read the journal and `__drizzle_migrations`; if any journal entry
   has `when` < the largest applied `created_at` and is not itself applied → throw `MIGRATION_ORDER` naming the file
   (the app refuses to start rather than run with a missing table; the pre-migration backup from 0.4 is untouched).

### G.2 `0012_autopilot.sql`

Conventions as SD §N: text ids, ISO text dates, integer pence, JSON text, `--> statement-breakpoint` separators,
append-only triggers in the 0001 form. Booking periods are additionally stored as integer epoch milliseconds for the
overlap trigger.

```sql
CREATE TABLE `claim_autopilot` (`claim_id` text PRIMARY KEY NOT NULL,
  `mode` text NOT NULL DEFAULT 'on' CHECK (`mode` IN ('on','paused','off')), `paused_by` text, `paused_reason` text, `paused_at` text,
  `step_overrides` text NOT NULL DEFAULT '{}', `stage` text, `plan` text, `plan_hash` text, `plan_version` text,
  `last_evaluated_at` text, `next_check_at` text, `updated_at` text NOT NULL);
CREATE INDEX `claim_autopilot_next_idx` ON `claim_autopilot` (`mode`, `next_check_at`);
CREATE TABLE `autopilot_log` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `step_id` text NOT NULL, `from_status` text,
  `to_status` text NOT NULL, `action` text, `actor` text NOT NULL, `decision` text, `job_id` text, `run_id` text, `needs_you_id` text,
  `refs` text NOT NULL DEFAULT '{}', `note` text, `at` text NOT NULL);                                           -- append-only
CREATE INDEX `autopilot_log_claim_idx` ON `autopilot_log` (`claim_id`, `at`);

CREATE TABLE `fleet_locations` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `address` text, `postcode` text, `lat` real, `lon` real,
  `is_default` integer NOT NULL DEFAULT 0, `created_at` text NOT NULL, `updated_at` text NOT NULL);
ALTER TABLE `fleet_units` ADD `location_id` text;
ALTER TABLE `fleet_units` ADD `current_mileage` integer;
ALTER TABLE `fleet_units` ADD `mileage_at` text;
ALTER TABLE `fleet_units` ADD `service_due_miles` integer;
ALTER TABLE `fleet_units` ADD `phv_licence_number` text;
ALTER TABLE `fleet_units` ADD `phv_licence_expiry` text;
ALTER TABLE `fleet_units` ADD `turnaround_minutes` integer;
ALTER TABLE `insurance_policies` ADD `driver_criteria` text;
ALTER TABLE `insurance_policies` ADD `renews_policy_id` text;

CREATE TABLE `fleet_readiness_tasks` (`id` text PRIMARY KEY NOT NULL, `fleet_unit_id` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('valet','inspection','service','damage_repair','mot','tax','tyres','keys','phv_licence','other')),
  `status` text NOT NULL CHECK (`status` IN ('open','done','cancelled')), `blocks_hire` integer NOT NULL DEFAULT 0,
  `due_at` text, `ready_by_at` text, `reservation_id` text, `damage_id` text, `note` text,
  `created_by` text NOT NULL, `created_at` text NOT NULL, `done_by` text, `done_at` text);
CREATE INDEX `fleet_readiness_unit_idx` ON `fleet_readiness_tasks` (`fleet_unit_id`, `status`);
CREATE TABLE `fleet_damage` (`id` text PRIMARY KEY NOT NULL, `fleet_unit_id` text NOT NULL, `panel` text NOT NULL, `description` text NOT NULL,
  `severity` text NOT NULL CHECK (`severity` IN ('cosmetic','minor','major','unroadworthy')), `found_at` text NOT NULL, `found_by` text NOT NULL,
  `reservation_id` text, `movement_id` text, `evidence_ids` text NOT NULL DEFAULT '[]', `repaired_at` text, `repair_task_id` text,
  `chargeable` text NOT NULL DEFAULT 'tbc' CHECK (`chargeable` IN ('none','hirer','third_party','tbc')), `created_at` text NOT NULL);
CREATE INDEX `fleet_damage_unit_idx` ON `fleet_damage` (`fleet_unit_id`, `repaired_at`);

CREATE TABLE `fleet_reservations` (`id` text PRIMARY KEY NOT NULL, `fleet_unit_id` text NOT NULL, `claim_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('held','confirmed','on_hire','returned','cancelled','expired')),
  `use` text NOT NULL CHECK (`use` IN ('credit_hire','self_drive','pco')),
  `start_at` text NOT NULL, `expected_end_at` text, `end_at` text, `collected_at` text,
  `block_start_ms` integer NOT NULL, `block_end_ms` integer,                     -- NULL = open-ended (legacy hire with no end)
  `hold_expires_at` text, `hold_expires_ms` integer,
  `hirer_party_id` text NOT NULL, `driver_party_ids` text NOT NULL DEFAULT '[]',
  `agreement_number` text, `hire_agreement_id` text, `hire_offer_id` text,
  `daily_rate_pence` integer NOT NULL, `gta_group` text NOT NULL, `client_gta_group` text, `pricing_note` text, `substitution_reason` text,
  `ranking` text, `clash_report` text, `overlap_override_audit_id` text,
  `source` text NOT NULL CHECK (`source` IN ('autopilot','handler','backfill')),
  `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, `cancelled_reason` text);
CREATE INDEX `fleet_reservations_unit_idx` ON `fleet_reservations` (`fleet_unit_id`, `status`, `block_start_ms`);
CREATE INDEX `fleet_reservations_claim_idx` ON `fleet_reservations` (`claim_id`, `status`);
CREATE UNIQUE INDEX `fleet_reservations_agreement_uq` ON `fleet_reservations` (`agreement_number`) WHERE `agreement_number` IS NOT NULL;
CREATE UNIQUE INDEX `fleet_reservations_hire_uq` ON `fleet_reservations` (`hire_agreement_id`) WHERE `hire_agreement_id` IS NOT NULL;
CREATE TABLE `fleet_reservation_events` (`id` text PRIMARY KEY NOT NULL, `reservation_id` text NOT NULL, `from_status` text,
  `to_status` text NOT NULL, `actor` text NOT NULL, `reason` text, `data` text, `at` text NOT NULL);           -- append-only

-- Overlap guard: a committed period of a car may not overlap another (§B.11). Physical-reality updates of on_hire/returned rows are not refused.
CREATE TRIGGER `fleet_reservations_overlap_ins` BEFORE INSERT ON `fleet_reservations`
WHEN NEW.`status` IN ('held','confirmed','on_hire','returned') AND NEW.`overlap_override_audit_id` IS NULL AND NEW.`source` <> 'backfill'
BEGIN
  SELECT RAISE(ABORT, 'RESERVATION_OVERLAP') WHERE EXISTS (SELECT 1 FROM `fleet_reservations` r
    WHERE r.`fleet_unit_id` = NEW.`fleet_unit_id` AND r.`id` <> NEW.`id` AND r.`status` IN ('held','confirmed','on_hire','returned')
      AND r.`block_start_ms` < COALESCE(NEW.`block_end_ms`, 9007199254740991)
      AND NEW.`block_start_ms` < COALESCE(r.`block_end_ms`, 9007199254740991));
END;
CREATE TRIGGER `fleet_reservations_overlap_upd` BEFORE UPDATE OF `status`, `fleet_unit_id`, `block_start_ms`, `block_end_ms` ON `fleet_reservations`
WHEN NEW.`status` IN ('held','confirmed') AND NEW.`overlap_override_audit_id` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'RESERVATION_OVERLAP') WHERE EXISTS (SELECT 1 FROM `fleet_reservations` r
    WHERE r.`fleet_unit_id` = NEW.`fleet_unit_id` AND r.`id` <> NEW.`id` AND r.`status` IN ('held','confirmed','on_hire','returned')
      AND r.`block_start_ms` < COALESCE(NEW.`block_end_ms`, 9007199254740991)
      AND NEW.`block_start_ms` < COALESCE(r.`block_end_ms`, 9007199254740991));
END;

CREATE TABLE `fleet_movements` (`id` text PRIMARY KEY NOT NULL, `reservation_id` text NOT NULL, `claim_id` text NOT NULL, `fleet_unit_id` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('delivery','collection','swap_out','swap_in','transfer')),
  `window_start` text NOT NULL, `window_end` text NOT NULL, `address` text, `postcode` text, `assigned_to` text,
  `status` text NOT NULL CHECK (`status` IN ('planned','confirmed','done','failed','cancelled')), `done_at` text, `odometer` integer,
  `fuel_eighths` integer, `condition_document_id` text, `evidence_ids` text NOT NULL DEFAULT '[]', `client_notified_at` text, `notes` text,
  `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL);
CREATE INDEX `fleet_movements_window_idx` ON `fleet_movements` (`status`, `window_start`);

CREATE TABLE `hire_offers` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `reservation_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('draft','sent','accepted','declined','expired','withdrawn','superseded')),
  `channel` text NOT NULL CHECK (`channel` IN ('email','sms','phone','in_person')), `terms` text NOT NULL, `terms_sha256` text NOT NULL,
  `outbox_id` text, `authorised_by` text NOT NULL, `sent_at` text, `expires_at` text NOT NULL, `response` text, `responded_at` text,
  `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL);
CREATE INDEX `hire_offers_claim_idx` ON `hire_offers` (`claim_id`, `status`);
CREATE UNIQUE INDEX `hire_offers_outbox_uq` ON `hire_offers` (`outbox_id`) WHERE `outbox_id` IS NOT NULL;

CREATE TABLE `driver_profiles` (`party_id` text PRIMARY KEY NOT NULL, `profile` text NOT NULL, `source` text NOT NULL,
  `updated_by` text NOT NULL, `updated_at` text NOT NULL);
CREATE TABLE `claim_hire_needs` (`claim_id` text PRIMARY KEY NOT NULL, `needs` text NOT NULL, `updated_by` text NOT NULL, `updated_at` text NOT NULL);
CREATE TABLE `eligibility_assessments` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `party_id` text, `policy_id` text,
  `kind` text NOT NULL CHECK (`kind` IN ('driver','need','means','roadworthiness','injury','acceptance','overall')),
  `outcome` text NOT NULL, `reasons` text NOT NULL, `inputs_sha256` text NOT NULL, `created_by` text NOT NULL, `created_at` text NOT NULL); -- append-only
CREATE INDEX `eligibility_claim_idx` ON `eligibility_assessments` (`claim_id`, `kind`, `created_at`);

CREATE TABLE `clash_findings` (`id` text PRIMARY KEY NOT NULL, `code` text NOT NULL,
  `severity` text NOT NULL CHECK (`severity` IN ('block','warn','info')), `override_class` text,
  `claim_id` text, `fleet_unit_id` text, `reservation_id` text, `hire_id` text, `related` text NOT NULL DEFAULT '{}',
  `message` text NOT NULL, `data` text, `dedupe_key` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('open','acknowledged','overridden','resolved')),
  `first_seen_at` text NOT NULL, `last_seen_at` text NOT NULL, `resolved_at` text, `resolved_by` text, `resolution_note` text, `override_audit_id` text);
CREATE UNIQUE INDEX `clash_findings_open_uq` ON `clash_findings` (`dedupe_key`) WHERE `status` IN ('open','acknowledged');
CREATE INDEX `clash_findings_claim_idx` ON `clash_findings` (`claim_id`, `status`);
CREATE INDEX `clash_findings_unit_idx` ON `clash_findings` (`fleet_unit_id`, `status`);

CREATE TABLE `document_packs` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL,
  `stage` text NOT NULL CHECK (`stage` IN ('signup','hire_offer','hire_start','off_hire','billing','payment','closure')),
  `reservation_id` text, `items` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('preparing','reviewing','awaiting_approval','approved','sent','signed','superseded','cancelled')),
  `approved_by` text, `approved_at` text, `sent_at` text, `outbox_id` text, `created_by` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL);
CREATE INDEX `document_packs_claim_idx` ON `document_packs` (`claim_id`, `stage`, `status`);
CREATE TABLE `signature_requests` (`id` text PRIMARY KEY NOT NULL, `pack_id` text, `document_id` text NOT NULL, `claim_id` text NOT NULL,
  `signer_party_id` text NOT NULL, `method` text NOT NULL CHECK (`method` IN ('kiosk_otp_email','kiosk_handler_code','wet_email','wet_post')),
  `status` text NOT NULL CHECK (`status` IN ('prepared','sent','chased','returned','signed','declined','cancelled')),
  `sent_at` text, `chase_count` integer NOT NULL DEFAULT 0, `last_chased_at` text, `next_chase_at` text, `returned_evidence_id` text,
  `signed_at` text, `confirmed_by` text, `created_at` text NOT NULL, `updated_at` text NOT NULL);
CREATE INDEX `signature_requests_open_idx` ON `signature_requests` (`status`, `next_chase_at`);
CREATE TABLE `signature_request_events` (`id` text PRIMARY KEY NOT NULL, `signature_request_id` text NOT NULL, `from_status` text,
  `to_status` text NOT NULL, `actor` text NOT NULL, `note` text, `at` text NOT NULL);                            -- append-only
CREATE TABLE `kiosk_sessions` (`id` text PRIMARY KEY NOT NULL, `pack_id` text NOT NULL, `claim_id` text NOT NULL, `signer_party_id` text NOT NULL,
  `token_sha256` text NOT NULL, `lan` integer NOT NULL DEFAULT 0, `created_by` text NOT NULL, `created_at` text NOT NULL, `expires_at` text NOT NULL,
  `opened_at` text, `opened_ip` text, `opened_user_agent` text, `completed_at` text, `closed_reason` text);
CREATE UNIQUE INDEX `kiosk_sessions_token_uq` ON `kiosk_sessions` (`token_sha256`);

CREATE TABLE `settlement_offers` (`id` text PRIMARY KEY NOT NULL, `claim_id` text NOT NULL, `head` text NOT NULL, `amount_pence` integer,
  `received_at` text NOT NULL, `offeror_name` text NOT NULL, `channel` text NOT NULL, `terms` text, `evidence_ids` text NOT NULL DEFAULT '[]',
  `mail_message_id` text, `status` text NOT NULL CHECK (`status` IN ('open','accepted','countered','rejected','lapsed','superseded')),
  `decided_by` text, `decided_at` text, `decision_note` text, `created_by` text NOT NULL, `created_at` text NOT NULL);
CREATE INDEX `settlement_offers_claim_idx` ON `settlement_offers` (`claim_id`, `status`);

ALTER TABLE `hire_agreements` ADD `use` text;
ALTER TABLE `hire_agreements` ADD `hirer_party_id` text;
ALTER TABLE `hire_agreements` ADD `driver_party_ids` text;
ALTER TABLE `hire_agreements` ADD `reservation_id` text;
ALTER TABLE `hire_agreements` ADD `expected_end_at` text;
ALTER TABLE `agent_settings` ADD `autopilot` text NOT NULL DEFAULT '{}';
ALTER TABLE `outbox` ADD `autopilot_step_id` text;

-- Back-fill: one reservation per existing hire (keeps the diary complete; legacy overlaps are kept, never refused).
INSERT INTO `fleet_reservations` (`id`, `fleet_unit_id`, `claim_id`, `status`, `use`, `start_at`, `expected_end_at`, `end_at`, `collected_at`,
  `block_start_ms`, `block_end_ms`, `hirer_party_id`, `driver_party_ids`, `agreement_number`, `hire_agreement_id`, `daily_rate_pence`, `gta_group`,
  `client_gta_group`, `pricing_note`, `source`, `created_by`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), h.`fleet_unit_id`, h.`claim_id`,
  CASE WHEN h.`end_at` IS NULL OR h.`end_at` > strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 'on_hire' ELSE 'returned' END,
  COALESCE((SELECT json_extract(e.`data`, '$.use') FROM `events` e WHERE e.`claim_id` = h.`claim_id` AND e.`type` = 'hire_started'
            AND json_extract(e.`data`, '$.hireId') = h.`id` ORDER BY e.`recorded_at` LIMIT 1), 'credit_hire'),
  h.`start_at`, h.`end_at`, h.`end_at`, h.`collected_at`,
  CAST(unixepoch(h.`start_at`, 'subsec') * 1000 AS INTEGER),
  CASE WHEN h.`end_at` IS NULL THEN NULL ELSE CAST(unixepoch(COALESCE(MAX(h.`end_at`, COALESCE(h.`collected_at`, h.`end_at`)), h.`end_at`), 'subsec') * 1000 AS INTEGER) END,
  c.`claimant_id`, '[]', h.`agreement_number`, h.`id`, h.`daily_rate_pence`, h.`gta_group`, h.`client_gta_group`, h.`pricing_note`,
  'backfill', 'system', h.`created_at`, h.`created_at`
FROM `hire_agreements` h JOIN `claims` c ON c.`id` = h.`claim_id`;
UPDATE `hire_agreements` SET `reservation_id` = (SELECT r.`id` FROM `fleet_reservations` r WHERE r.`hire_agreement_id` = `hire_agreements`.`id`),
  `use` = (SELECT r.`use` FROM `fleet_reservations` r WHERE r.`hire_agreement_id` = `hire_agreements`.`id`),
  `hirer_party_id` = (SELECT c.`claimant_id` FROM `claims` c WHERE c.`id` = `hire_agreements`.`claim_id`), `driver_party_ids` = '[]';
-- BEFORE UPDATE / BEFORE DELETE RAISE(ABORT) triggers on: autopilot_log, fleet_reservation_events, eligibility_assessments, signature_request_events
```

`ap-foundation` checks the real column names (`claims.claimant_id`, `events.recorded_at`, `events.data`) against
`schema.ts` before writing the file and adjusts the back-fill if they differ; `unixepoch(…, 'subsec')` needs SQLite
≥ 3.42 (bundled 3.53.2). Test: a 0.4 database with three hires (one open, one ended, two overlapping under a past
manager override) migrates; the back-fill creates three reservations; the overlap triggers then refuse a new
overlapping hold and accept a touching one.

### G.3 Additions to existing domain types (`packages/domain/src/types.ts`, by `ap-foundation`)

* `EventType` += `services_agreed` (exists) is now appended by code; new: `hire_offered`, `hire_offer_accepted`,
  `hire_offer_declined`, `booking_confirmed`, `booking_cancelled`, `hire_vehicle_delivered`, `hire_vehicle_collected`,
  `hire_start_notice_sent`, `documents_signed`.
* `HireAgreement` += optional `use?: FleetUse; hirerPartyId?: Id; driverPartyIds?: Id[]; reservationId?: Id;
  expectedEndAt?: ISODateTime`.
* `FleetUnit` += optional `locationId`, `currentMileage`, `mileageAt`, `serviceDueMiles`, `phvLicenceNumber`,
  `phvLicenceExpiry`, `turnaroundMinutes`; `InsurancePolicy` += optional `driverCriteria?: DriverCriteria;
  renewsPolicyId?: Id`.
* `EvidenceKind` += `signature_image`, `signed_document`.
* `SignatureRecord` += optional `method?: 'otp' | 'kiosk_otp_email' | 'kiosk_handler_code' | 'wet_ink' | 'scan';
  drawnSignatureSha256?: string; evidenceId?: Id` (absent = today's `otp`).
* No database CHECK constraint exists on `events.type` or `evidence.kind` (verified in `0000_init.sql`), so the unions
  grow without a table rebuild.

---

## H. Jobs, tools, Needs-you, routes and perimeter

### H.1 Job types (added to `JOB_TYPES` / `JOB_TYPE_INFO`)

| Type | Lane | AI | Agent | Mutates | Priority | Idempotency key | Trigger / schedule |
|---|---|---|---|---|---|---|---|
| `autopilot.tick` | io | – | autopilot | yes | 2 | `autopilot.tick:<claimId>:<London minute>` | sweep; nudges from booking/offer/pack/sign/event routes; Needs-you resolutions; "Run now" |
| `autopilot.sweep` | io | – | autopilot | – | 4 | `autopilot.sweep:<5-min slot>` | every 5 min: claims with `next_check_at ≤ now`, or with events/mail/evidence recorded since `last_evaluated_at`, or with a new claim |
| `autopilot.judge` | ai | yes | case_manager | – | 2 | `autopilot.judge:<claimId>:<stepId>:<planHash>` | tick |
| `hire_offer.parse_reply` | ai | yes | mail | – | 1 | `hire_offer.parse_reply:<messageId>` | tick (reply not matched by code) |
| `pack.prepare` | cpu | – | autopilot | yes | 3 | `pack.prepare:<claimId>:<stage>:<reservationId or '-'>:<revision>` | tick |
| `booking.expire_holds` | io | – | autopilot | yes | 1 | `booking.expire_holds:<5-min slot>` | every 5 min |
| `fleet.status_sync` | io | – | autopilot | – | 5 | `fleet.status_sync:<hour>` | hourly + after booking writes |
| `fleet.compliance_watch` | io | – | autopilot | – | 5 | `fleet.compliance_watch:<date>` | 06:30 daily |
| `clash.check` | io | – | autopilot | – | 2 | `clash.check:<subjectKind>:<id>:<minute>` | claim/vehicle/party/driver changes |
| `clash.sweep` | io | – | autopilot | – | 6 | `clash.sweep:<date>` | 02:30 daily |
| `signing.chase` | io | – | autopilot | yes | 4 | `signing.chase:<date>` | 09:15 weekdays |
| `signing.match_return` | io | – | autopilot | – | 3 | `signing.match_return:<15-min slot>` | every 15 min |
| `movement.remind` | io | – | autopilot | – | 4 | `movement.remind:<date>` | 16:00 daily (next day's movements) |

Schedules are appended to `DEFAULT_SCHEDULES` (`apps/api/src/agent/scheduler.ts`) by `ap-foundation`.
`AI_JOB_DEFAULTS` gains `autopilot.judge` (case_manager, `claude-sonnet-5-5`, effort `medium`, 6 turns, 5 min) and
`hire_offer.parse_reply` (mail, `claude-sonnet-5-5`, effort `low`, 1 turn, 2 min); both appear in Settings > AI.
Result schema ids `autopilot_judge` and `hire_reply` are added to `RESULT_SCHEMAS` (strict, < 16 KB).

### H.2 MCP tools

Tool → dispatcher → `decide()` → perimeter → route as the agent (SD §B.3). Inputs `zod/v4` strict, nullable-required.
Tools whose class is not `read` carry `describe()` with `kind` and `step` from `rc.step`.

| Tool | Class | Input | Route / effect | Owner slice |
|---|---|---|---|---|
| `autopilot_plan` | read | `{claimId}` | `GET /claims/:id/autopilot` (plan, trimmed) | ap-autopilot |
| `fleet_search` | read | `{claimId, startAt?, expectedEndAt?, use?, limit?}` | `POST /fleet/availability` (ranked + excluded, reasons) | ap-booking |
| `fleet_unit_get` | read | `{fleetUnitId}` | `GET /fleet/:id` + readiness + bookings | ap-booking |
| `fleet_calendar` | read | `{fleetUnitId?, from, to}` | `GET /fleet/calendar` | ap-booking |
| `bookings_list` | read | `{claimId}` | `GET /claims/:id/bookings` (reservations, movements) | ap-booking |
| `clash_check` | read* | `{claimId, fleetUnitId?, startAt?, expectedEndAt?}` | `POST /clashes/check` (*persists findings for the claim; class read because it changes nothing the claim relies on) | ap-clash |
| `eligibility_get` | read | `{claimId}` | `GET /claims/:id/eligibility` | ap-clash |
| `hire_offers_list` | read | `{claimId}` | `GET /claims/:id/hire-offers` | ap-autopilot |
| `signatures_list` | read | `{claimId}` | `GET /claims/:id/signatures` + packs | ap-paperwork |
| `eligibility_assess` | internal | `{claimId}` | `POST /claims/:id/eligibility/assess` (records the computed assessment) | ap-clash |
| `booking_hold` | internal | `{claimId, fleetUnitId, use, startAt, expectedEndAt, rankingRef}` | `POST /claims/:id/bookings` | ap-booking |
| `booking_release` | internal | `{reservationId, reason}` | `POST /bookings/:id/release` | ap-booking |
| `booking_confirm` | internal | `{reservationId, hireOfferId?}` | `POST /bookings/:id/confirm` (requires an accepted offer for agents) | ap-booking |
| `booking_update_period` | internal | `{reservationId, expectedEndAt, reason}` | `PATCH /bookings/:id` (clash re-check) | ap-booking |
| `movement_schedule` | internal | `{reservationId, kind, windowStart, windowEnd, address: 'client_home' \| 'delivery_address'}` | `POST /bookings/:id/movements` | ap-booking |
| `readiness_task_create` | internal | `{fleetUnitId, kind, dueAt?, note}` | `POST /fleet/:id/readiness` | ap-booking |
| `hire_offer_prepare` | draft | `{claimId, reservationId, outboxId, alternatives: Id[]}` | `POST /claims/:id/hire-offers` (binds offer ↔ outbox, computes terms hash) | ap-autopilot |
| `hire_acceptance_record` | internal | `{hireOfferId, decision, messageId, chosenFleetUnitId?, confidence}` | `POST /hire-offers/:id/response` (`sensitive` when confidence < 0.9 → asks) | ap-autopilot |
| `claim_status_set` | internal | `{claimId, status}` | `POST /claims/:id/status` (perimeter refuses final statuses) | ap-autopilot |
| `pack_prepare` | draft | `{claimId, stage, reservationId?}` | enqueue `pack.prepare` (in-process `run`) | ap-paperwork |
| existing `email_draft`, `document_draft`, `docx_document_draft`, `event_append`, `send_request`, `ledger_propose`, `payment_received_propose`, `task_schedule`, `needs_you_create`, `legal_escalate`, `vehicle_lookup` | as SD | as SD | as SD; `event_append`'s allowed types gain nothing (repair events are already allowed) | — |

Tool subsets: **autopilot** (deterministic principal) = all tools above plus the listed existing ones; **case_manager**
in `autopilot.judge` = `claim_brief`, `autopilot_plan`, `fleet_search`, `bookings_list`, `eligibility_get`,
`kb_search`, `brain_search`, `memory_recall` (read only); **case_manager** in `case.review` gains `autopilot_plan`,
`bookings_list`, `eligibility_get`, `hire_offers_list` (read); **mail** in `hire_offer.parse_reply` = none (`--tools ""`).

### H.3 Needs-you kinds and resolvers

| Kind | Raised by | Options | Resolver (runs as the owner) | Owner slice |
|---|---|---|---|---|
| `choose_car` | `hire.choose` not green / judge `ask_owner` | `unit:<id>` × top 3 (recommended marked), `search_again` (edit needs/period), `no_hire` (reason) | moves/places the hold as the owner; marks the offer `authorisedBy` owner; nudges the tick | ap-autopilot |
| `autopilot_step` | any confirm/owner step | `do_it` (runs the prepared action as the owner), `skip` (reason), `snooze` (until), `open` | as chosen; audited `autopilot.step_resolve` | ap-autopilot |
| `approve_pack` | `pack.prepare` complete | `approve_send`, `approve_only`, `edit` (opens the document editor; edits saved as corrections), `reject` (reason) | approves each document (human), queues the outbox | ap-paperwork |
| `confirm_signed` | `signing.match_return` | `confirm` (signed on date X), `not_signed`, `wrong_document` | `POST /documents/:id/mark-signed` as the owner; enforceability sync | ap-paperwork |
| `clash_review` | new block finding on a booked/hired claim; nightly sweep | `resolved` (reason), `acknowledge` (warn), `cancel_booking`, `open_booking` (override in the dialog as manager) | updates the finding; never overrides by itself | ap-clash |
| `eligibility_review` | driver `refer`, need weak, means unknown when required | `insurer_accepted` (evidence id required), `decline_hire` (reason), `request_info` (prepared doc_request) | records the decision as an assessment; `insurer_accepted` lets the booking override `DRIVER_REFERRAL` | ap-clash |

Existing kinds used: `missing_info`, `approve_send`, `question`, `override_needed`, `offer_decision`, `money`,
`legal_review`, `failure`, `new_claim`. The Needs-you page gets a kind → panel registry
(`apps/web/src/screens/needsYou/kindPanels.ts`, created by `ap-foundation`); each slice provides its panels.

### H.4 Routes (all under `/api`, session auth; human-only marked H)

| Slice | Routes |
|---|---|
| ap-foundation | `GET/PATCH /settings/autopilot` |
| ap-autopilot | `GET /claims/:id/autopilot`; `POST /claims/:id/autopilot/evaluate`; `POST /claims/:id/autopilot/pause` (H), `…/resume` (H); `POST /claims/:id/autopilot/steps/:stepId/:action` (H; run/skip/ask/auto/done/snooze); `GET /claims/:id/hire-offers`, `POST /claims/:id/hire-offers`, `POST /hire-offers/:id/response`, `POST /hire-offers/:id/accept` (H, phone/in person), `POST /hire-offers/:id/withdraw`; `GET/POST /claims/:id/settlement-offers`, `PATCH /claims/:id/settlement-offers/:oid` (decision fields H) |
| ap-booking | `POST /fleet/availability`; `GET /fleet/calendar?from&to&unitIds&group&use`; `GET /claims/:id/bookings`; `POST /claims/:id/bookings`; `GET /bookings/:id`; `PATCH /bookings/:id`; `POST /bookings/:id/confirm`; `POST /bookings/:id/release`; `POST /bookings/:id/handover` (H); `POST /bookings/:id/return` (H); `POST /bookings/:id/movements`; `PATCH /movements/:id`; `GET /fleet/movements?day&range`; `GET/POST /fleet/:id/readiness`, `PATCH /fleet/readiness/:taskId`; `POST /fleet/:id/damage`, `PATCH /fleet/damage/:id`; `GET/POST /fleet/locations`, `PATCH /fleet/locations/:id`; `POST /fleet/:id/allocate-check` (made period-aware) |
| ap-clash | `POST /clashes/check`; `GET /claims/:id/clashes`; `GET /fleet/clashes`; `POST /clashes/:id/acknowledge` (H), `POST /clashes/:id/resolve` (H); `GET/PUT /parties/:id/driver-profile` (PUT H); `GET/PUT /fleet/policies/:id/criteria` (PUT H); `GET/PUT /claims/:id/hire-needs`; `GET /claims/:id/eligibility`; `POST /claims/:id/eligibility/assess` |
| ap-paperwork | `GET /claims/:id/packs`; `POST /claims/:id/packs` (prepare); `POST /packs/:id/approve` (H); `POST /packs/:id/send-for-signature` (H); `POST /packs/:id/kiosk` (H); `GET /api/kiosk/:token`, `GET /api/kiosk/:token/documents/:docId/pdf`, `POST /api/kiosk/:token/read`, `POST /api/kiosk/:token/otp/start`, `POST /api/kiosk/:token/sign`, `POST /api/kiosk/:token/close` (token auth, not session; never agent-reachable); `GET /claims/:id/signatures`; `POST /documents/:id/mark-signed` (H); `PATCH /claims/:id/hire/:hireId/paperwork` (H) |

### H.5 Perimeter additions (`apps/api/src/agent/perimeter.ts`, by `ap-foundation`)

* `HUMAN_ONLY_ROUTES` += `POST /api/bookings/:id/handover`, `POST /api/bookings/:id/return`,
  `POST /api/documents/:id/mark-signed`, `POST /api/packs/:id/approve`, `POST /api/packs/:id/send-for-signature`,
  `POST /api/packs/:id/kiosk`, `POST /api/hire-offers/:id/accept`, `POST /api/clashes/:id/acknowledge`,
  `POST /api/clashes/:id/resolve`, `PUT /api/parties/:id/driver-profile`, `PUT /api/fleet/policies/:id/criteria`,
  `POST /api/claims/:id/autopilot/pause|resume`, `POST /api/claims/:id/autopilot/steps/:stepId/:action`,
  `PATCH /api/claims/:id/hire/:hireId/paperwork`; the `/api/kiosk/*` routes refuse any run token outright.
* Money/settlement rule 4 += `PATCH /api/claims/:id/settlement-offers/:oid` with decision fields.
* Claim scope (rule 3): `namedClaimIds` resolves the claim of `/api/bookings/:id`, `/api/hire-offers/:id`,
  `/api/packs/:id`, `/api/movements/:id`, `/api/clashes/:id` (as it does for `/api/documents/:id`); fleet-wide
  routes (`/fleet/availability`, `/fleet/calendar`) are reachable by claim-scoped runs only with the run's own
  `claimId` and return no other claim's references or party names (reservations of other claims appear as "booked").
* `CLAIMDESK_ALLOW_FAKE_AI` and the kill switch behave as SD; the autopilot principal is a normal agent principal
  (`role: 'handler'`, never manager).

---

## I. User interface (apps/web)

### I.1 Claim tab **Autopilot** (`screens/claim/tabs/AutopilotTab.tsx`, ap-autopilot)

Placed after Overview. Top: a 14-stage progress bar with the current stage; mode chip (**On** / **Paused** /
**Off**) and one-click **Pause autopilot on this claim** (reason prompt) / **Resume**; a **Next** card ("Next: send the
hire offer for AB12 CDE — automatic, held 10 minutes for Undo") and **Waiting on** chips (client since 2 h, insurer
since 3 days). Clash card (open block/warn findings). Then the timeline: one lane per track (Intake, Qualify, Sign-up,
Notify, Vehicle, Hire, Money, Close); each step row shows a status icon (✓ done, ● due, ◷ waiting, ⛔ blocked, ⏸
paused, – n/a), title, mode chip (**Auto** / **Ask me** / **I do it**, with "raised because …" tooltip from
`modeReasons`), due date with countdown (red when overdue), what we wait for, links (document, email, booking, Needs-you
card), and a menu: **Run now**, **Always ask me on this claim**, **Skip** (reason), **Mark done** (reason), **Snooze**.
Done steps collapse into a "Done (23)" group with dates and who/what did them (from `autopilot_log`). Polls every 15 s.

### I.2 Booking dialog (`screens/claim/booking/BookingDialog.tsx`, ap-booking)

Opened by **Find a car** (Hire tab, Autopilot tab, `choose_car` card) and from an empty calendar cell. Left: period
(start; expected end prefilled from §B.6 with "why"), use (prefilled from needs), needs checklist (prefilled; edits
saved to the claim's needs). Right: ranked cars — score bar, factor chips (Like for like 0.9, Needs ✓, Ready now,
Cover +62 days, £/day vs guide, Distance), the pricing guide (existing `PricingGuidePanel`), driver outcome; a
collapsible **Not available (7)** list with every reason. Bottom: the Clash panel (§C.5) for the selected car; actions
**Hold for 24 h**, **Hold and offer to client** (opens the prepared offer for edit/approve), **Book now** (client
present: confirm directly), and the manager override when a class A finding blocks. Keyboard accessible; works at
phone width.

### I.3 Fleet calendar (`/fleet/calendar`, ap-booking)

Rows = cars (group, registration, location), columns = days (2 / 4 / 8 weeks; today line). Bars: held (striped,
with expiry), confirmed (solid), on hire (dark), returned (grey), cancelled hidden; readiness blocks (hatched:
valet, service, repair); compliance markers (MOT ▲, tax ■, policy end │, service ●) — amber when inside a booking;
movements (delivery ↓, collection ↑); red outline for clash findings. Filters: group, use, location, "free between
dates". Click a bar → booking card; click an empty cell → Booking dialog for that car and date (claim picker). An
accessible table view for screen readers and printing.

### I.4 Movements board (`/fleet/movements`, ap-booking)

Today / Tomorrow / This week: deliveries and collections with slot, address, car, client name and phone (owner view),
status buttons (**Confirmed**, **On the way**, **Done** → Handover or Return dialog, **Failed** → reason and re-slot),
"Print run sheet".

### I.5 Handover and Return dialogs (ap-booking)

Handover: checklist (pack signed ✓ / **Sign now in kiosk**; licence evidence ✓ / **Capture** via the existing capture
page; DVLA check date and summary; driver eligibility ✓), odometer out, fuel (eighths), keys, condition report (opens
the CCGUK-06 release values form; photos via capture), **Start hire**. Return: odometer in, fuel, damage rows with
severity and photos, collected time, contractual end (prefilled with the off-hire deadline and its basis), **End
hire**; amber warning when the end is past the deadline.

### I.6 Kiosk (`/sign/kiosk/:token`, ap-paperwork)

Full screen, large type, one document at a time with progress ("2 of 5"), "I have read this" enabled at the end of the
document, typed name, signature pad (clear/redo), code entry, **Sign**; "Hand back to the Claims Team" exit with the
handler's password. No navigation; no other claim data.

### I.7 Needs-you panels

`choose_car` (ranked table with factor chips and the judge's recommendation), `approve_pack` (document list with PDF
previews, reviewer verdicts, signer, "send to"), `confirm_signed` (scan beside the generated PDF, page by page),
`clash_review` (finding, related bookings/claims, actions), `eligibility_review` (criteria table, outcome reasons,
evidence upload), `autopilot_step` (what, why, prepared items, the button that does it).

### I.8 Settings

**Settings > Autopilot** (`/settings/autopilot`, ap-autopilot): master switch, new-claims default; step modes table
(Auto / Ask me / I do it; floors greyed with the reason, e.g. "Agreements always need you"); booking timings (hold
hours, offer reminder, turnaround, lead time, window length, max per window, business hours); green thresholds
(like-for-like minimum, clear-winner gap, daily auto-offer cap); ranking weights (sliders, normalised); projection
defaults; signing (OTP by email / handler code, chase days, LAN tablet on/off with warning); eligibility options
(require means before offer). **Settings > Fleet > Driver criteria** (`/settings/fleet/criteria`, ap-clash): defaults
and per-policy criteria with "check against your policy wording" notice. **Fleet > Locations** (ap-booking).

### I.9 Daily log

New sections (additive to SD §J.2 `DailyLog.sections`): `autopilot` (steps done automatically, holds placed/expired,
offers sent/accepted/declined, bookings confirmed, packs prepared/approved/signed, status changes), `fleet` (today's
and tomorrow's movements, cars returned, readiness tasks due, compliance lapses ahead), `clashes` (new / overridden /
resolved findings with codes). Every line has the claim reference, the step id or clash code, the rule ids of the
policy decision, and a link — built from `autopilot_log`, `fleet_reservation_events`, `clash_findings` and audit rows
by `apps/api/src/autopilot/dailyLog.ts`.

# ClaimDesk 0.3 — Manager mode, hire pricing guide, editable and backdated hire dates, the typing fix, a simpler app and the update installer

Design document (architect phase). Status: **agreed contract for the implementation slices in §H**. Date: 5 October 2026.
Baseline: release **0.2.6** (`claimdesk-v0.2.6`, commit `04566ad`, = HEAD when this was written). All six suites green at
baseline: domain 756, kb 225 (+1 skipped), db 91, web 373, documents 1018 (+1 skipped), api 177.

This document is the single source of truth for 0.3. Where a slice brief and this document disagree, this document wins.
The ground rules of `docs/ARCHITECTURE.md` and `docs/TEMPLATES-VEHICLES-DESKTOP.md` still apply: TypeScript strict,
NodeNext `.js` import suffixes everywhere except `apps/web`, integer pence, ISO UTC dates printed in Europe/London,
append-only ledger/events/evidence/audit, GTA is a **benchmark only** (CCGUK is not a subscriber), no legacy company
details, no scraping, the Word templates are filled and never rewritten.

---

## 0. Overview

### 0.1 What the owner asked for and where it is designed

| # | Request (owner's words, condensed) | Design | Slices |
|---|---|---|---|
| 1 | "Remake an update exe that I can download to update" | §F: 0.3.x Setup that upgrades 0.2.6 in place, data kept, automatic migrations with a backup first, CI upgrade test from the real 0.2.6 installer, in-app **Updates** card with a Download button | updates-desktop |
| 2 | "Manual override on a click of a button — a MANAGER MODE — bypass anything stopping me (adding cars or anything)" | §A: one-click Manager mode, one central server gate, audit of every override, global "Override as manager" prompt, web blocks lifted | override-api, manager-web (+ hire-web, focus-simplify for their screens) |
| 3 | "If I get a car with a higher GTA rate, when I select it for hire tell me the daily rate and show the guides for the accident-damaged car and the car we give, so we can decide pricing" | §B: pricing guide on Start hire and on every hire card; agreed rate with one-click chips | hire-api, hire-web |
| 4 | "Edit hire start and end manually; backdate, because agents forget to upload" | §C: edit any time, backdating allowed, audited, clocks and charges recalculated, ledger corrected with new rows only | hire-api, hire-web |
| 5 | "Simplify" | §E: 15 low-risk simplifications | all web slices |
| 6 | "Every time I type it clicks off per character" | §D: root cause in `Modal.tsx`, fixes, a vitest guard and a Playwright sweep over every input on every screen | focus-simplify |

### 0.2 Key decisions

| Decision | Choice | Why |
|---|---|---|
| Who can use Manager mode | Roles **admin** and **approver** (`MANAGER_ROLES`). `courtesycars` is admin. No password prompt. | The domain has no "manager" role; approver is the existing senior role. Being signed in is the credential. |
| Where Manager mode lives | Server: a per-session flag `sessions.manager_mode_until` (sliding idle expiry). Request: header `X-Manager-Override: <reason>` on every mutation the web sends while it is on. | The server decides; the session flag dies with sign-out and expires when idle even if the window is closed; the header binds each override to a request and carries the reason. |
| How refusals become overrides | **One** gate object per request (`gateFor(ctx, request)`), used by every class A/B guard: `gate.refuse(error, target)`. Class C call sites keep `throw`. The registry of overridable codes is data in `@ccguk/domain` (`OVERRIDE_RULES`). | Central, auditable, testable; no ad-hoc `if (manager)` anywhere. |
| When the audit row is written | In a global `onSend` hook after a **2xx** response: one `audit_log` row per applied override (`action: override.<CODE>`, keyed to the claim when there is one). | Every guard is covered without each route remembering to write it; a request that later fails writes nothing because nothing was overridden. |
| Web behaviour | When ON, every mutation carries the header (so nothing is refused) and the response header `X-Manager-Overrides` produces an "Overridden: …" toast. When OFF and the server refuses with an overridable code, a **global prompt** offers "Override as manager" (admin/approver only), turns Manager mode on and retries the same request; the caller's `onSuccess` runs as if nothing happened. | Zero per-screen plumbing for server refusals; works for every current and future mutation. |
| Web-only checks | `relaxErrors(errors, on, hardKeys)` turns client validation errors into amber warnings in Manager mode; the relaxed rule keys travel to the server in `X-Manager-Relaxed` and are audited as `override.WEB_VALIDATION`. | Disabled buttons and blocked wizard steps open up, and still leave an audit trail. |
| Hire dates | `PATCH /claims/:id/hire/:hireId` (reason required) + `POST` accepts an end for a forgotten past hire. Events are never edited: a correcting `hire_started`/`hire_ended` (or `note`) event carries `data.correctsEventId`; `liveEvents()` drops the corrected ones everywhere the bundle is read. Ledger: a correcting `claimed` row with `supersedesId`; invoiced/paid rows are never touched (a warn flag asks for a corrected invoice). | Append-only integrity is kept; clocks and documents read the corrected period. |
| "Unit already on hire" | Replaced by a **period overlap** check (`HIRE_OVERLAP`, overridable). Unit status is **derived** from its hires. | A backdated, finished hire on a car that is out today is legitimate. |
| "Higher group" | Decided by comparing **benchmark daily rates**, never group codes (S/M/F/CP codes do not order across families). | Correct for every family. |
| Pricing snapshot | Four nullable columns on `hire_agreements` record the guides at the time of the decision. | The agreed price stays explainable after rates change. |
| Focus bug | `Modal` effect keyed on `[open]` only; `onClose` in a ref; initial focus only on the open transition and only when focus is not already inside. Plus `DateTimeInput` draft state. | Root cause verified in Chromium (§D.1). One file fixes every dialog. |
| Update check | Server-side `GET /api/updates/check` (the page's CSP only allows `connect-src 'self'`), GitHub releases list (prereleases included, tag prefix `claimdesk-v`), 6 s timeout, 1 h cache, quiet failure. Download = the release asset link opened in the browser. | Works on the user's PC, never blocks the app offline. No self-launching installer (the Inno `taskkill /T` would kill a child installer). |
| Version | Root `package.json` → `0.3.0`; CI makes `0.3.<run number>`. Inno **AppId unchanged**. | In-place upgrade of 0.2.6. |
| New dependencies | `apps/web` devDependencies only: `jsdom ^26.1.0`, `@testing-library/react ^16.3.0`, `@testing-library/dom ^10.4.0`, `@testing-library/user-event ^14.6.1`. No runtime dependency. | Real DOM focus tests. Owned by focus-simplify (only slice that touches manifests/lockfile). |

### 0.3 Slice map (details §H)

| Key | Title | Main areas |
|---|---|---|
| `override-api` | Manager mode on the server and the central override gate | domain `override/`, db sessions/settings/audit + migration 0006, `app.ts`, `errors.ts`, `services/override.ts`, auth/claims/fleet/vehicles/engineering/settings/documents/docx routes and services |
| `hire-api` | Hire pricing guide and editable, backdatable hire dates (server) | domain `gta/pricing.ts`, `gta/hire.ts`, `events/`, `fleet/hireOverlap.ts`, `clocks/derive.ts`; db hire repo, bundle, migration 0007; `routes/hire.ts`, `schemas/hire.ts`, `services/hirePricing.ts`, `services/hireCorrection.ts` |
| `manager-web` | Manager mode in the app | `app/managerMode.tsx`, `lib/managerMode.ts`, `api/client.ts`, `api/managerApi.ts`, prompt, AppShell toggle/banner, ApiErrorNotice details, FNOL wizard, DocumentView, EngineerReportForm, StatusControl, FlagsTab audit trail |
| `hire-web` | Hire screens: pricing panel, edit dates, simpler Start hire | `HireTab.tsx`, `tabs/hire/*`, `lib/hire.ts`, `lib/hirePricing.ts`, `api/hireApi.ts`, Chronology corrections |
| `focus-simplify` | The typing fix, focus guards and most simplifications | `Modal.tsx`, `Form.tsx`, web test harness + devDeps, `scripts/focus-sweep.mjs`, claim tabs, claims list (+ API service), fleet and vehicle forms, documents/actions/vehicle tabs |
| `updates-desktop` | Update installer, Updates card, Settings and other page simplifications | version, `routes/updates.ts`, backup-before-migrate, CI real-0.2.6 upgrade test, Inno downgrade guard, release notes, Settings/GTA rates/Directory/Dashboard |

---

## A. Manager mode

### A.1 What the user sees

1. **Header button.** In the top bar, next to the user box, a button **"Manager mode"** (shield icon) is shown to admin and
   approver users only. One click turns it on; no password, no dialog.
2. **ON state.** The button turns red and reads **"Manager mode ON"**. A full-width banner appears under the top bar:
   > **Manager mode is on.** Anything that would normally stop you can be overridden, and every override is recorded in the
   > audit log. Reason: `[Manager override]` · Switches off after 60 minutes without activity · **Turn off**

   The `<body>` gets class `manager-mode` (a 4 px red bar along the top of the window and red focus rings on the banner).
   The reason box is a plain text input (max 500 characters), pre-filled **"Manager override"**; whatever it says is sent
   with every override. Light and dark themes both defined (`styles/manager.css`, tokens `--manager-bg`, `--manager-fg`,
   `--manager-border`).
3. **Auto-off.** After *N* minutes without keyboard, mouse, wheel or touch activity (Settings → Manager mode, default
   **60**, range 1–480) the app turns it off and shows a toast "Manager mode switched off after 60 minutes without
   activity". Signing out always ends it. If the window is closed, the server's own expiry ends it.
4. **While ON.** Nothing is refused for a class A/B rule. Each overridden rule gives a small toast:
   "Overridden: *Uncleared hard-stop flag* — Manager override". Disabled buttons and blocked steps listed in §A.7 are
   enabled; client-side checks show amber warnings ("Allowed in manager mode: …") instead of red errors.
5. **While OFF**, when the server refuses with an overridable rule:
   * admin/approver: a dialog **"This is blocked — override as manager?"** shows the plain-English rule, the server's
     message, the details (reasons, flags, missing items — §A.6), any extra warning (e.g. payment-misdirection risk) in
     red, and a Reason box pre-filled "Manager override". Buttons **Cancel** and **Override as manager**. Override turns
     Manager mode on and re-sends exactly the same request.
   * other roles: the normal error notice with the details and "A manager (admin or approver) can override this in
     manager mode."
6. **Audit.** Settings → Manager mode lists recent overrides (when, who, what, reason, claim link). Each claim's Flags
   tab shows an **Audit trail** card (overrides, hire corrections, flag clearances and other audited actions for that
   claim — §A.8).

### A.2 Classes

* **A** — a business rule a manager may override; audited with the rule code, the refusal details and the reason.
* **B** — a data-shape or required-answer check that is relaxed in manager mode (something is still stored: `Unknown`,
  `UNGROUPED`, a warn flag); audited the same way.
* **C** — never bypassed: security (auth, rate limits, roles, upload safety, path traversal, XML/zip, macros),
  append-only integrity (ledger, events, evidence, audit), signature and hash cryptography, cross-claim id integrity
  (`WRONG_CLAIM`), document state machines tied to PDF hashes and signatures, legal impossibility (s.172 driver
  nomination, CPR 36.5 21-day period, VAT without a VAT number, a company DSAR), and type/format checks that protect the
  data model (integer pence, ISO dates). A "C-input" is a value the user simply has to type (e.g. a daily rate); nothing
  stops them typing it.

### A.3 Shared registry — `packages/domain/src/override/codes.ts` (override-api writes it first, verbatim)

```ts
/**
 * Manager-mode override registry (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A). Pure data shared by the API (which refusals
 * the central gate may turn into an audited override) and the web (labels). Class A: a business rule a manager may
 * override with an audited reason. Class B: a data-shape or required-answer check relaxed in manager mode. Every code
 * that is not listed here is class C and is never overridable.
 */
export type OverrideClass = 'A' | 'B';

export interface OverrideRule {
  code: string;
  class: OverrideClass;
  /** Plain-English name shown in the prompt and in the "Overridden: …" toast. */
  label: string;
  /** Extra caution shown in red in the prompt (legal, payment or fraud risk). */
  warning?: string;
}

export const MANAGER_ROLES = ['admin', 'approver'] as const;
export const MANAGER_MODE_DEFAULT_IDLE_MINUTES = 60;
export const MANAGER_MODE_MIN_IDLE_MINUTES = 1;
export const MANAGER_MODE_MAX_IDLE_MINUTES = 480;
export const DEFAULT_OVERRIDE_REASON = 'Manager override';
export const OVERRIDE_REASON_MAX = 500;
/** Request header: present (URI-encoded reason) = "override if manager mode is on". */
export const MANAGER_OVERRIDE_HEADER = 'x-manager-override';
/** Request header: URI-encoded comma list of web-only rule keys the user relaxed in manager mode (max 20). */
export const MANAGER_RELAXED_HEADER = 'x-manager-relaxed';
/** Response header: URI-encoded JSON `Array<{ code, label, reason }>` of the overrides applied by a 2xx response. */
export const MANAGER_OVERRIDES_RESPONSE_HEADER = 'x-manager-overrides';

/** Word-template guard codes that GUARD_BLOCKED may override (all other guard codes, e.g. BANK_DETAILS_PLACEHOLDER, are C). */
export const OVERRIDABLE_TEMPLATE_GUARDS = ['PRINTED_RATES_DIFFER', 'OPEN_RECORD_END', 'BANK_ACCOUNT_NAME_MISMATCH', 'REFERENCE_DOUBLED', 'WITNESS_RELATIONSHIP_REQUIRED', 'BANK_DETAILS_REQUIRED'] as const;

const r = (code: string, cls: OverrideClass, label: string, warning?: string): OverrideRule => (warning ? { code, class: cls, label, warning } : { code, class: cls, label });

export const OVERRIDE_RULES: Readonly<Record<string, OverrideRule>> = Object.freeze({
  // ---- class A: business rules
  HARD_STOP: r('HARD_STOP', 'A', 'Uncleared hard-stop flag on the claim', 'The flag stays on the file until someone clears it with a reason.'),
  ALLOCATION_REFUSED: r('ALLOCATION_REFUSED', 'A', 'Fleet car not cleared for this hire (status, use, policy, MOT or tax)', 'Check the car is insured for this use before it goes out.'),
  HIRE_OVERLAP: r('HIRE_OVERLAP', 'A', 'Fleet car is on another hire for part of this period'),
  REGISTRATION_ON_CLAIM: r('REGISTRATION_ON_CLAIM', 'A', 'Registration is a client vehicle on a claim'),
  UNIT_ON_HIRE: r('UNIT_ON_HIRE', 'A', 'Fleet car is still on hire', 'The open hire is left running and flagged: end it with its real date.'),
  TRANSITION_REFUSED: r('TRANSITION_REFUSED', 'A', 'Penalty notice stage change out of order'),
  CHECKLIST_INCOMPLETE: r('CHECKLIST_INCOMPLETE', 'A', "Engineer's report checklist incomplete"),
  LINES_UNCONFIRMED: r('LINES_UNCONFIRMED', 'A', 'Estimate lines not confirmed by the engineer'),
  TOO_FEW_COMPARABLES: r('TOO_FEW_COMPARABLES', 'A', 'Fewer than three comparables for the pre-accident value'),
  DOCUMENT_BLOCKED: r('DOCUMENT_BLOCKED', 'A', 'Document has uncleared consistency flags', 'Each flag is cleared with your reason. Read any flag about regulated status or old company details before approving.'),
  TEMPLATE_WARNINGS_UNACKNOWLEDGED: r('TEMPLATE_WARNINGS_UNACKNOWLEDGED', 'A', 'Template wording not yet reviewed'),
  GUARD_BLOCKED: r('GUARD_BLOCKED', 'A', 'Word template check failed (rates, open hire end, payee name, reference, witness)', 'A bank account name that is not "Courtesy Cars Group UK Ltd" fails Confirmation of Payee and risks money going to the wrong account.'),
  HIRE_OPEN: r('HIRE_OPEN', 'A', 'Hire still running (interim invoice to today)'),
  STORAGE_OPEN: r('STORAGE_OPEN', 'A', 'Storage still running (interim invoice to today)'),
  NO_PAYMENT_PACK: r('NO_PAYMENT_PACK', 'A', 'No payment pack sent yet'),
  EXTRA_OVERRIDES_LEDGER: r('EXTRA_OVERRIDES_LEDGER', 'A', 'Typed figure replaces the ledger figure'),
  LEGACY_DETAIL: r('LEGACY_DETAIL', 'A', 'Old company details', 'Old company details on letters and forms are a misrepresentation and fraud risk.'),
  COMPANY_NAME_NOT_REGISTERED: r('COMPANY_NAME_NOT_REGISTERED', 'A', 'Company name is not the registered name', 'Letters must show the registered name Courtesy Cars Group UK Ltd.'),
  // ---- class B: data shape / required answers
  FNOL_INCOMPLETE: r('FNOL_INCOMPLETE', 'B', 'New claim is missing intake answers', 'The claim opens with an "intake incomplete" flag listing what is missing. Call-recording disclosure is a legal duty: record it as soon as it is given.'),
  REGISTRATION_FORMAT: r('REGISTRATION_FORMAT', 'B', 'Registration is not a UK format'),
  GTA_SUGGESTION_UNAVAILABLE: r('GTA_SUGGESTION_UNAVAILABLE', 'B', 'No GTA group found for the fleet car (saved as UNGROUPED)'),
  VALUES_REQUIRED: r('VALUES_REQUIRED', 'B', 'Word template has blank required values (left blank to complete by hand)'),
  HIRE_END_BEFORE_START: r('HIRE_END_BEFORE_START', 'B', 'Hire ends before it starts', 'Charged as 0 days and flagged on the claim until the dates are corrected.'),
  WEB_VALIDATION: r('WEB_VALIDATION', 'B', 'On-screen checks relaxed'),
});

export function overrideRule(code: string): OverrideRule | undefined {
  return Object.prototype.hasOwnProperty.call(OVERRIDE_RULES, code) ? OVERRIDE_RULES[code] : undefined;
}
export function isOverridable(code: string): boolean {
  return overrideRule(code) !== undefined;
}
export function isManagerRole(role: string | undefined | null): boolean {
  return role === 'admin' || role === 'approver';
}
```

`packages/domain/src/override/index.ts`: `export * from './codes.js';`. `packages/domain/src/index.ts` gains
`export * from './override/index.js';` (shared-file rule §G.3).

### A.4 Server: state, routes, gate, error contract, audit (override-api)

#### A.4.1 State

* Migration **0006** (§G.2): `sessions.manager_mode_until text` (nullable), `settings.manager_mode_idle_minutes integer`
  (nullable → default 60).
* `packages/db/src/repos/sessions.ts`: `SessionRecord.managerModeUntil?: ISODateTime`;
  `setSessionManagerMode(db, sessionId, until: ISODateTime | null): void`.
* `packages/db/src/repos/settings.ts`: `Settings.managerModeIdleMinutes: number` (default
  `MANAGER_MODE_DEFAULT_IDLE_MINUTES`); `SettingsPatch` accepts it; validated integer 1–480 (`ValidationError`).
  `apps/api/src/schemas/services.ts` `settingsPatchBody` gains `managerModeIdleMinutes: z.number().int().min(1).max(480).optional()`.
* Header auth mode (tests only): an in-memory `WeakMap<AppContext, Map<userId, until>>` inside `services/override.ts`
  gives identical semantics without a session.
* `on` ⇔ `managerModeUntil > now`. An expired value found on read is cleared and audited once as `manager_mode.off`
  `{ why: 'expired' }`.
* Sliding expiry: `until = now + idleMinutes` on `POST /auth/manager-mode {on:true}` (also the client heartbeat) and on
  every request where the gate is active (throttled: at most one write per 30 s per session).

#### A.4.2 Routes (`apps/api/src/routes/auth.ts`)

```ts
interface ManagerModeView { allowed: boolean; on: boolean; until?: string; idleMinutes: number; defaultReason: 'Manager override' }
```

| Route | Rules |
|---|---|
| `GET /auth/me` | adds `managerMode: ManagerModeView` next to `user` |
| `GET /auth/manager-mode` | → `ManagerModeView` (session required like every non-public route) |
| `POST /auth/manager-mode` `{ on: boolean, why?: 'user' \| 'idle' }` | `on:true`: 403 `FORBIDDEN` unless `isManagerRole(role)` (the header-mode assumed dev user is allowed, like `requireRole`); sets `until`; audit `manager_mode.on` `{ until, idleMinutes }` only on an off→on transition (heartbeats are silent). `on:false`: clears; audit `manager_mode.off` `{ why }` when it was on. → `ManagerModeView` |
| `GET /auth/manager-mode/log?limit=50` | admin/approver (`requireRole(request, MANAGER_ROLES)`); → `{ items: Array<AuditEntry & { userName?: string; claimReference?: string }> }`, newest first, actions `override.%`, `manager_mode.on`, `manager_mode.off` (new repo fn `listAuditByActions(db, { prefixes: ['override.'], actions: ['manager_mode.on','manager_mode.off'], limit })`) |
| `POST /auth/logout` | when the session had manager mode on, also audit `manager_mode.off` `{ why: 'sign_out' }` |

`PATCH /settings` gets `preHandler: configRolesOnly` (security gap B42: any handler could change the bank details) and
accepts `managerModeIdleMinutes`; `GET /settings` returns it.

#### A.4.3 The gate — `apps/api/src/services/override.ts` (exact exports; written first)

```ts
import type { FastifyRequest } from 'fastify';
import type { Id, ISODateTime, OverrideClass } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { HttpError } from '../errors.js';

/** What an override was about. With a claimId the audit row is keyed to the claim (shows in the claim's audit trail). */
export interface OverrideTarget { claimId?: Id; entity: string; entityId: Id }
/** Placeholder entityId for something created by this request (bindClaim fills it). */
export const NEW_ENTITY = '(new)';

export interface AppliedOverride { code: string; class: OverrideClass; label: string; message: string; details?: unknown; target: OverrideTarget; reason: string }

export interface ManagerModeState { allowed: boolean; on: boolean; until?: ISODateTime; idleMinutes: number }

export interface OverrideGate {
  /** The signed-in user may use manager mode (admin/approver, or the header-mode assumed dev user). */
  readonly allowed: boolean;
  /** allowed && manager mode is on for this session && the request carries X-Manager-Override. */
  readonly active: boolean;
  /** Decoded X-Manager-Override (trimmed, ≤ 500 chars) or 'Manager override'. */
  readonly reason: string;
  /**
   * The ONLY way a class A/B guard refuses. Code not in OVERRIDE_RULES → throws `error` unchanged (class C).
   * Overridable and active → records an AppliedOverride and returns (the caller carries on).
   * Overridable, not active → sets `error.override` (OverrideInfo) and throws.
   */
  refuse(error: HttpError, target: OverrideTarget): void;
  /** Point overrides recorded with entityId NEW_ENTITY (or no claimId) at the claim this request created. */
  bindClaim(claimId: Id): void;
  readonly applied: readonly AppliedOverride[];
}

export function gateFor(ctx: AppContext, request: FastifyRequest): OverrideGate;      // memoised per request
export function peekGate(request: FastifyRequest): OverrideGate | undefined;           // for the onSend hook
export const STRICT_GATE: OverrideGate;                                                 // never active; refuse() always throws
export function managerModeState(ctx: AppContext, request: FastifyRequest): ManagerModeState;
export function setManagerMode(ctx: AppContext, request: FastifyRequest, on: boolean, why?: 'user' | 'idle' | 'sign_out'): ManagerModeState;
```

`apps/api/src/errors.ts`:

```ts
export interface OverrideInfo { code: string; class: 'A' | 'B'; label: string; warning?: string; allowed: boolean; managerMode: 'on' | 'off' }
// HttpError gains:  override?: OverrideInfo   (mutable, set by gate.refuse)
```

`mapError` copies it: the error body becomes `{ error: { code, message, details?, requestId, override? } }`. Class C
errors never carry `override`.

Gate algorithm (per request, memoised in a `WeakMap<FastifyRequest, OverrideGate>`):

1. `allowed = user.assumed || isManagerRole(user.role)`.
2. `requested` = header `x-manager-override` present; `reason = decodeURIComponent(value).trim().slice(0, 500) || DEFAULT_OVERRIDE_REASON`
   (a malformed encoding falls back to the raw value).
3. `state = managerModeState(ctx, request)`; `active = allowed && state.on && requested`; when active, extend the expiry
   (throttled).
4. When active and `x-manager-relaxed` is present: record one `WEB_VALIDATION` override with
   `details: { rules: string[] }` (decoded, split on `,`, trimmed, max 20 keys of max 80 chars) and the default target.
5. Default target: route pattern starting `/api/claims/:id` → `{ claimId: params.id, entity: 'claims', entityId: params.id }`;
   otherwise `{ entity: 'request', entityId: <route pattern> }`.

`app.ts` (override-api):

* `cors` `exposedHeaders` gains `x-manager-overrides`.
* `preHandler` hook: for non-GET requests that carry either manager header, call `gateFor(ctx, request)` (so relaxed
  rules are recorded even on routes that never call the gate).
* `onSend` hook: `const gate = peekGate(request)`; when `gate?.applied.length && reply.statusCode < 400`, in one
  transaction append per override:

  ```ts
  ctx.repos.appendAudit(tx, {
    actor: request.actor,
    action: `override.${o.code}`,
    entity: o.target.claimId ? 'claims' : o.target.entity,
    entityId: o.target.claimId ?? o.target.entityId,
    before: { code: o.code, message: o.message, details: o.details ?? null },
    after: { reason: o.reason, class: o.class, label: o.label, target: { entity: o.target.entity, entityId: o.target.entityId }, method: request.method, route: request.routeOptions.url, requestId: request.requestId },
    at: ctx.now(),
  });
  ```

  then `reply.header('x-manager-overrides', encodeURIComponent(JSON.stringify(gate.applied.map(o => ({ code: o.code, label: o.label, reason: o.reason })))))`.
  Note: unlike route audits these rows are written right after the change commits, not inside its transaction — a
  deliberate trade for having one writer for every guard (documented in `services/override.ts`).

Security notes: the custom request header needs a CORS pre-flight, so a cross-site page cannot send it (CORS allows
localhost origins only); the session cookie is `SameSite=Lax`; the role is re-read from the database on every request.

`routes/helpers.ts`: `assertNoHardStop(claim: Claim, gate: OverrideGate = STRICT_GATE): void` — builds the same 409
`HARD_STOP` error and calls `gate.refuse(error, { claimId: claim.id, entity: 'claims', entityId: claim.id })`.
Existing one-argument calls keep compiling (strict).

### A.5 Web: provider, client, prompt, relaxations (manager-web)

#### A.5.1 Contract files (manager-web writes these first)

`apps/web/src/lib/managerMode.ts` (pure, unit-tested):

```ts
export interface RelaxedResult { errors: Record<string, string>; warnings: Record<string, string> }
/** In manager mode every error whose key is not in `hardKeys` becomes a warning; otherwise unchanged (warnings = {}). */
export function relaxErrors(errors: Record<string, string>, managerOn: boolean, hardKeys?: readonly string[]): RelaxedResult;
/** Prefix shown before a relaxed message: "Allowed in manager mode: ". */
export const MANAGER_WARNING_PREFIX: string;
/** Rule keys for the X-Manager-Relaxed header: `${form}.${key}` for each warning key. */
export function relaxedKeys(form: string, warnings: Record<string, string>): string[];
```

`apps/web/src/app/managerMode.tsx`:

```tsx
export interface ManagerModeApi {
  allowed: boolean;          // signed-in role is admin or approver
  on: boolean;
  until?: string;
  idleMinutes: number;
  reason: string;            // banner reason box, default 'Manager override'
  setReason(reason: string): void;
  turnOn(): Promise<void>;
  turnOff(why?: 'user' | 'idle'): Promise<void>;
  pending: boolean;
}
export function ManagerModeProvider({ children }: { children: ReactNode }): JSX.Element;
export function useManagerMode(): ManagerModeApi;   // outside the provider: { allowed:false, on:false, … } no-op stub
```

`apps/web/src/api/client.ts` additions:

```ts
export interface OverrideInfo { code: string; class: 'A' | 'B'; label: string; warning?: string; allowed: boolean; managerMode: 'on' | 'off' }
// ApiError gains: readonly override?: OverrideInfo   (parsed from body.error.override)
export interface AppliedOverrideNotice { code: string; label: string; reason: string }
export function setManagerOverrideReason(reason: string | null): void;          // non-null = manager mode on: send X-Manager-Override on non-GET
export function onManagerOverrides(listener: (applied: AppliedOverrideNotice[]) => void): () => void;
export type OverrideDecision = { action: 'override'; reason: string } | { action: 'cancel' };
export function setOverridePromptHandler(handler: ((error: ApiError) => Promise<OverrideDecision>) | null): () => void;
export function setManagerModeReactivator(fn: (() => Promise<boolean>) | null): () => void;
/** Attach web-only relaxed rule keys to a request body (a Symbol property: never serialised, invisible to TS excess checks). */
export function withRelaxed<T extends object>(body: T, keys: readonly string[]): T;
```

`request()` behaviour (the whole override UX hangs off this one function):

1. Non-GET and `managerOverrideReason !== null` → header `X-Manager-Override: encodeURIComponent(reason)`.
2. Body object carrying the `withRelaxed` symbol → header `X-Manager-Relaxed: encodeURIComponent(keys.join(','))`
   (only sent when manager mode is on).
3. 2xx with `x-manager-overrides` → decode, JSON-parse, notify listeners (the provider toasts
   "Overridden: <label> — <reason>", one toast per response, labels joined with "; ").
4. Error with `error.override?.allowed === true` on a non-GET request that has not already been retried:
   * manager mode believed on (the server says `managerMode: 'off'`, i.e. it expired) → call the reactivator (POST on),
     retry once, toast "Manager mode was switched back on".
   * otherwise, when a prompt handler is registered → await it; `override` → the provider has turned manager mode on
     with the chosen reason → retry once; `cancel` → throw the original error.
   * The retry re-sends the same method, URL, JSON body or `FormData`.
5. Requests from `templatesApi.ts` already use `request()` (JSON); `fetchBinary` is GET only — nothing to change there.

#### A.5.2 Provider behaviour

* Mounted in `main.tsx` inside `QueryClientProvider` and `ToastProvider`, around `RouterProvider`; renders the
  `OverridePrompt` (a `Modal`) and registers the client hooks above.
* Query `['auth', 'manager-mode']` → `GET /auth/manager-mode` (401 → off), `staleTime 30 s`, refetch on window focus
  and every 60 s while on. `allowed` from the response.
* `on` → `setManagerOverrideReason(reason)`; off → `null`; `document.body.classList.toggle('manager-mode', on)`.
* Idle: passive listeners on `window` for `pointerdown`, `keydown`, `wheel`, `touchstart` update `lastActivity`; a 30 s
  interval turns it off (`why: 'idle'`) when `now - lastActivity ≥ idleMinutes × 60 000` and shows the toast;
  activity while on sends a heartbeat (`POST {on:true}`) at most every 5 minutes. Fake-timer unit tests cover both.
* Sign-out (`AppShell.useSignOut`): unchanged server call; the provider resets on `me` → null.

#### A.5.3 Error details (`apps/web/src/lib/errorDetails.ts`, manager-web)

`describeErrorDetails(code: string, details: unknown): string[]` turns every known detail shape into plain lines:
`reasons: string[]` (ALLOCATION_REFUSED), `flags: Array<{code,message}>` (HARD_STOP, DOCUMENT_BLOCKED), `missing: string[]`
(CHECKLIST_INCOMPLETE, FNOL), `errors|incomplete: Array<{field,message}>` (FNOL), `issues: Array<{code?,message}>` (Word
templates, mappings), zod `Array<{path,message}>` (VALIDATION → "path: message"), `overlaps: Array<{agreementNumber,
startAt, endAt?, claimReference?}>` (HIRE_OVERLAP), `rules: string[]`. Unknown shapes → []. Used by `ApiErrorNotice`
(now lists the lines under the message, plus the "a manager can override" sentence for `override.allowed === false`) and
by the prompt. `ErrorAlert` unchanged.

### A.6 Block inventory — class and handling in 0.3

"Gate" = `gate.refuse(...)` at the named site. Web items say which screen is opened up in manager mode. Slice:
OA override-api, HA hire-api, MW manager-web, HW hire-web, FS focus-simplify, UD updates-desktop.

| ID | Block (code) | Class | Handling in 0.3 | Slice |
|---|---|---|---|---|
| B01 | `HARD_STOP` — uncleared block flag stops Start hire and status ≥ accepted | A | Gate in `assertNoHardStop` (status route OA; hire create HA). Status dialog says "Manager mode will override this" when on (MW). Flag clearing unchanged (any role, reason ≥ 3, audited). | OA, HA, MW |
| B02 | `ALLOCATION_REFUSED` — status, use, policy, MOT, tax at `startAt` | A | Gate (HA). `body.overrideAllocation` no longer bypasses on its own; if present its reason is recorded in `hire.create` audit. Details `reasons[]` shown (MW). | HA, MW |
| B03 | Unit already on hire — never overridable, checks today not the period | A | Replaced by `HIRE_OVERLAP` period check (gate); `on_hire` status no longer refuses by itself (§C.3). | HA |
| B04 | Web disables on_hire/off_road units; free-text override box | A (web) | Units enabled in manager mode with a status badge; override box removed (the prompt replaces it). | HW |
| B05 | No hire edit; re-end refused | — | New feature §C (PATCH). | HA, HW |
| B06 | Hire end before start | B | `HIRE_END_BEFORE_START` gate on create, end and PATCH (HA); web error → warning in manager mode (HW). Claim gets warn flag `HIRE_DATES_INVALID`. Storage end-before-start stays C. | HA, HW |
| B07 | Web refuses a future end; £0 rate | B / C-input | Future end = **warning for everyone** (pre-booked return). Daily rate > 0 stays (type a rate). | HW |
| B08 | `REGISTRATION_ON_CLAIM` — fleet unit for a client's registration | A | Gate (OA). Web pre-warning in VehiclePicker shows "allowed in manager mode" (FS). | OA, FS |
| B09 | `GTA_SUGGESTION_UNAVAILABLE` | B | When a daily rate is supplied and no group can be found: gate, group stored `UNGROUPED` (OA). No rate → still 422 (C-input). Web GTA panel: group optional in manager mode (FS). | OA, FS |
| B10 | `UNIT_ON_HIRE` — dispose a car on hire | A | Gate; car disposed; the open hire stays open; its claim gets warn flag `HIRE_ON_DISPOSED_UNIT` (OA). | OA |
| B11 | Fleet form rules (postcode format, postcode required with address, credit hire + self-drive needs a policy, declaredUses ≥ 1, rate > 0, delete with hires, policy end < start) | B / C | Web: the first three relaxed via `relaxErrors` + `withRelaxed` (FS); declaredUses defaults to credit hire; rate > 0, delete-with-hires (referential), policy dates (logic) stay C. | FS |
| B12 | `REGISTRATION_FORMAT` — non-UK plate (POST /vehicles, /vehicles/lookup); length 2–10 | B | Gate; lookup skips live providers and answers `manual_required` (OA). Schema max raised to 15 for everyone. Web FNOL/picker plate checks relaxed (MW, FS). | OA, MW, FS |
| B13 | `FNOL_INCOMPLETE` — validateFnol hard errors | B | Gate (code changes from VALIDATION to FNOL_INCOMPLETE, same 400 and details); claim opens with warn flag `INTAKE_INCOMPLETE` "(opened in manager mode)" listing missing/errors; `gate.bindClaim(newId)`. The 5 zod-required fields stay C-input: claimant name, vehicle registration, accident date-time, location, circumstances (non-empty). | OA |
| B14 | Script guard: client told to ignore an offer | C | Zod `literal(false)`; no screen can send it; compliance guard (lesson m). Remedy text only. | — |
| B15 | Reason required for pre_action / litigation | B | When active and no reason given, the override reason is used as the status reason (OA). | OA |
| B16 | Wizard step validation; steps disabled until reached | B | `relaxErrors` with the 5 hard keys of B13; all steps clickable in manager mode (MW). | MW |
| B17 | Fleet registration as client vehicle (web hard stop) | A (web) | Allowed in manager mode with a warning; the server still raises the `FLEET_UNIT_AS_CLIENT_VEHICLE` block flag (then B01). Wizard MW; OnFileMatches/VehiclePicker FS. | MW, FS |
| B18 | `DOCUMENT_BLOCKED` — approve with block flags; Approve button disabled | A | Gate; each open block flag cleared through `clearConsistencyFlag` with reason `Manager override: <reason>`, then approved (OA). Button reads **"Clear flags and approve"** in manager mode (MW). | OA, MW |
| B19 | Consistency block codes (clearable with a reason) | A | Unchanged single clear; bulk via B18. Prompt shows the DOCUMENT_BLOCKED warning. | OA |
| B20 | Document state machine (draft/approved/sent/signed/superseded) | C | Never; the manager path is Supersede. | — |
| B21 | `VALUES_REQUIRED` / `SLOT_NOT_FILLABLE` / `UNKNOWN_VARIANT` | B / C / C | VALUES_REQUIRED: gate, generated with the slots left blank for hand completion (OA). SLOT_NOT_FILLABLE: C (typing into a signature box is forging; other non-fillable slots are simply left unfilled — nothing stops generation). UNKNOWN_VARIANT: C (programming error). | OA |
| B22 | Template guards (`GUARD_BLOCKED`) | A / C | Gate only when every block issue code ∈ `OVERRIDABLE_TEMPLATE_GUARDS`; `BANK_DETAILS_PLACEHOLDER` (00-00-00) stays C (never print a placeholder account). | OA |
| B23 | `TEMPLATE_WARNINGS_UNACKNOWLEDGED` | A | Gate (OA). | OA |
| B24 | `TEMPLATE_CHANGED` (sha / mapping) | C | Never — re-upload or remap. | — |
| B25 | `HIRE_OPEN`, `STORAGE_OPEN`, `NO_PAYMENT_PACK`, `EXTRA_OVERRIDES_LEDGER` | A | Gate (OA). `hireBlock`/`storageBlock` already cost an open record to now, so the result is an interim invoice dated today. EXTRA_OVERRIDES_LEDGER becomes its own code (was VALIDATION + details.code). | OA |
| B25b | `NO_NCAF`, `NO_OFFER`, `OFFER_DECISION_PENDING` | C-data | Remedy: log the missing event/decision (backdating allowed). Deferred to 0.3.1 if the owner asks. | — |
| B26 | `NO_HIRE`, `NO_REPORT`, `NO_STORAGE`, `NO_RECOVERY`, `NO_PAV`, recipient missing, `TEMPLATE_DATA_MISSING` | C-data | Nothing to compute from; create the record (now backdatable) or type the values. | — |
| B27 | Builder facts: `DATE_IN_FUTURE`, `INVALID_*`, `OFFER_TERMS_EXPLAINED_REQUIRED` | C-input | Deferred (0.3.1). Remedy text shown with details. | — |
| B28 | Litigation/correspondence preconditions (`NOTHING_OUTSTANDING`, `NO_ALLEGATION_LETTER`, `FORUM_*`, `NO_NOTIFICATION`, `OFFER_EXCEEDS_CLAIM`, `NO_BUNDLE_DOCUMENTS`, `NO_SIGNED_AUTHORITY`, `BANK_NAME_NOT_REGISTERED_NAME`, `NO_VENDOR_REQUEST`) | A (deferred) | Not overridden in 0.3: each builder needs its own tested fallback. Remedy shown with details. | — |
| B29 | Part 36 < 21 days, company DSAR, party not on claim | C | Never. | — |
| B30 | `NO_HIRER`, `S172_REFUSAL` | C | Never (s.172). Attaching a (backdated) hire clears it legitimately. | — |
| B31 | `TRANSITION_REFUSED` (penalty stage) | A / C | Gate unless the target stage is `hirer_identified` or `liability_transferred` (then C). Web penalty date checks relaxed (FS). | OA, FS |
| B32 | `CHECKLIST_INCOMPLETE` | A | Gate; `body.force` alone no longer bypasses (it is accepted and ignored without manager mode); event records `forced: true, overrideReason` (OA). "Generate & issue" enabled in manager mode (MW). | OA, MW |
| B33 | `LINES_UNCONFIRMED`, `TOO_FEW_COMPARABLES`; required figures; `NO_COMPARABLES`, `PDF_TEXT_REQUIRED` | A / C-input / C | Gate for the first two (OA). | OA |
| B34 | Approved estimate / issued report / recorded reply | C | Supersede pattern. | — |
| B35 | `WRONG_CLAIM` | C | Never. | — |
| B36 | Append-only ledger/events/evidence/audit | C | Never; corrections are new rows (§C). | — |
| B37 | Upload/storage safety, tamper detection | C | Never. | — |
| B38 | Template upload safety, built-ins | C | Never. `NO_FILLABLE_SLOTS` deferred; `TEMPLATE_DUPLICATE` is UX. | — |
| B39 | E-signature / OTP | C | Never. | — |
| B40 | Auth, rate limit, password policy, roles | C | Never; Manager mode itself is role-gated. | — |
| B41 | GTA rate provenance / uniqueness | C | Save as unverified; duplicates → edit the existing row. | — |
| B42 | Settings: `LEGACY_DETAIL`, `COMPANY_NAME_NOT_REGISTERED`, VAT without number, rate card shape, PATCH role gap | A / A / C / C / fix | Gate for the first two with strong warnings (OA). PATCH /settings now admin/approver only. | OA |
| B43 | Zod shape checks; storage already ended | C / deferred | Unchanged. | — |
| B44 | Claim audit view misses hire/document rows | fix | `GET /claims/:id/audit` returns rows whose `entityId` is the claim or any of its hires, storage, recovery, offers, documents, estimates, PAVs or reports, or whose `after.claimId` is the claim (repo `listAuditForClaim(db, claimId, relatedIds, limit)`). Flags tab shows it (MW). | OA, MW |
| B45 | Web shows only `code — message` | fix | §A.5.3. | MW |
| H3 | Allocation override ignored for an active unit; unit status written blindly | fix | §C.3. | HA |
| H6 | No late-entry marking | fix | `lateEntry` on events + "Entered late" badge (§C). | HA, HW |

### A.7 Web places opened up in manager mode

| Screen | Normal | Manager mode | Slice |
|---|---|---|---|
| Start hire: car select | on hire / off road disabled | enabled, badge "on hire" / "off road" | HW |
| Start/Edit hire: end before start | red error | amber warning (server gate + flag) | HW |
| Document view: Approve | disabled while block flags | enabled: "Clear flags and approve" | MW |
| Engineering: Generate & issue | disabled while checklist incomplete | enabled: "Issue anyway" | MW |
| New claim wizard | steps disabled until reached; every step validated | all steps clickable; only the 5 hard fields block | MW |
| Wizard / picker: fleet registration as client vehicle | hard stop | warning | MW, FS |
| Fleet unit dialog / GTA panel | postcode format, postcode with address, credit hire + self-drive needs a policy, group required | warnings; group optional (`UNGROUPED`) | FS |
| Penalty dialog | contravention not in future, received after contravention, deadlines in order | warnings | FS |
| Status change dialog | "Hard stop open" red notice | "Manager mode will override the hard stop" amber notice | MW |

Not opened (C): Send before approval, re-approve/sign, Fill dialog "Next" without a required subject (it is an input).

### A.8 Settings card and claim audit trail (manager-web components)

* `apps/web/src/screens/settings/ManagerModeCard.tsx` (manager-web; rendered by SettingsPage, owned by updates-desktop):
  a number input "Switch manager mode off after [60] minutes without activity" (PATCH /settings
  `managerModeIdleMinutes`, admin/approver only), the on/off state with the same toggle, and "Recent overrides" (table
  from `GET /auth/manager-mode/log`: When · Who · Rule · Reason · Claim link).
* Flags tab: card **Audit trail** below the flags — `GET /claims/:id/audit` rows, newest first, columns When · Who (user
  name via `/users`) · What (`override.HARD_STOP` → "Override: Uncleared hard-stop flag"; `hire.correct` → "Hire dates
  corrected"; others humanised from the action) · Reason/details. Read-only.

---

## B. Hire pricing guide

### B.1 What the user sees

On **Start hire**, as soon as a fleet car is chosen (and again when the start date or the client's group changes), a
**Pricing guide** panel appears above the agreed rate:

```
Pricing guide (hire starting 5 Oct 2026)
 Fleet car daily rate        FL25 MXX · Nissan Qashqai           £74.68 / day
 ┌─────────────────────────────┬────────────────────────────────────────────┐
 │ Car we give                 │ Client's damaged car                         │
 │ Group M2 · GTA guide £74.68 │ Vauxhall Astra DK18 WRE · Group S1 [change ▾]│
 │                             │ GTA guide £42.32 · group recorded on the car │
 └─────────────────────────────┴────────────────────────────────────────────┘
 Difference  +£32.36 / day (car we give − client's car)
 ⚠ Higher group than the damaged car: the car you are giving (M2, £74.68/day guide) is in a higher group than the
   client's damaged car (S1, £42.32/day guide). Like-for-like guide £42.32/day; difference £32.36/day.
 GTA rates are an industry benchmark only. CCGUK is not a GTA subscriber …

 Agreed daily rate (£, ex VAT) [ 74.68 ]
   [Fleet rate £74.68]  [Car we give — guide £74.68]  [Client's car — guide £42.32 (like for like)]
```

* The fleet select labels read `FL33 EET · VW Golf · S1 · £49.80/day` (+ " · on hire" / " · off road").
* "[change ▾]" is a select of the groups in force on the start date (`groupsOnDate`); choosing one saves it to the
  client's vehicle (`PATCH /vehicles/:id { gtaGroup }`) and refreshes the panel. When the client's car has no group the
  panel says "The client's car has no GTA group yet — choose one to see the like-for-like guide."
* Chips fill the agreed rate; the default agreed rate is the fleet rate (today's behaviour).
* Each **hire card** shows the same figures read-only from the snapshot: "Agreed £74.68/day · Car we give M2 guide
  £74.68 · Client's car S1 guide £42.32 · +£32.36/day" with the higher-group notice, and the charges card gains a second
  benchmark line "At the like-for-like guide (S1): £…, difference £…".

### B.2 Domain — `packages/domain/src/gta/pricing.ts` (hire-api, written first; exported from `gta/index.ts`)

```ts
import type { GtaRate, ISODate, Pence, Verification } from '../types.js';

export type ClientGroupSource = 'recorded' | 'manual' | 'suggested' | 'none';

export interface PricingGuideLine {
  group: string | null;
  dailyRatePence: Pence | null;
  period?: string;
  verification?: Verification['status'];
  /** Why there is no rate (no group, or noBenchmarkRateReason()). */
  missingReason?: string;
}

export interface PricingSuggestion { id: 'fleet' | 'hire_guide' | 'like_for_like'; label: string; dailyRatePence: Pence }

export interface HirePricingGuide {
  date: ISODate;
  fleetDailyRatePence: Pence;
  /** GTA guide for the car we give (the fleet car's group). */
  hireCar: PricingGuideLine;
  /** GTA guide for the client's accident-damaged car (like for like). */
  clientCar: PricingGuideLine & { source: ClientGroupSource };
  /** hireCar − clientCar guide, null when either is missing. */
  differencePerDayPence: Pence | null;
  /** True when the car we give has a higher benchmark rate than the client's car (rates compared, never codes). */
  higherGroup: boolean;
  /** Fleet rate − client's guide (positive = above like for like), null without a client guide. */
  fleetAboveLikeForLikePence: Pence | null;
  /** Plain-English sentences, most important first. */
  notices: string[];
  suggestions: PricingSuggestion[];
  /** GTA_NON_SUBSCRIBER_NOTE. */
  note: string;
}

export interface HirePricingGuideInput {
  date: ISODate;
  fleetDailyRatePence: Pence;
  hireGroup: string;
  clientGroup: string | null;
  clientGroupSource: ClientGroupSource;
  rates: GtaRate[];
}

export function hirePricingGuide(input: HirePricingGuideInput): HirePricingGuide;
```

Rules (unit-tested in `pricing.test.ts`): rates from `gtaRate(group, date, rates)`; `UNGROUPED`/empty → missing;
`higherGroup = diff > 0`; notices in this order: higher group (exact sentence in §B.1), lower group ("…is in a lower
group than…"), fleet above like for like ("Your fleet rate £X/day is £D/day above the like-for-like guide."), missing
rates (`noBenchmarkRateReason`), unverified rates ("The guide rate for group G (period P) is unverified."); suggestions:
fleet always, the two guides when present, labels exactly "Fleet rate", "Car we give — guide", "Client's car — guide
(like for like)". Money formatting via `formatGBP`.

`calculateHire` (`gta/hire.ts`): `HireCalculationOptions.likeForLikeGroup?: string` → `HireCalculation.likeForLike?:
HireBenchmark` computed exactly like `benchmark` but for that group (`differencePence = hirePence − days × rate`). The
breakdown and existing fields are unchanged.

`HireAgreement` (`types.ts`, additive, all optional): `clientGtaGroup?: string; clientGtaDailyRatePence?: Pence;
hireGtaDailyRatePence?: Pence; fleetDailyRatePence?: Pence; pricingNote?: string`.

### B.3 Server (hire-api)

* Migration **0007** (§G.2): the five columns above on `hire_agreements` (`client_gta_group`,
  `client_gta_daily_rate_pence`, `hire_gta_daily_rate_pence`, `fleet_daily_rate_pence`, `pricing_note`).
* `apps/api/src/services/hirePricing.ts`:

```ts
export interface HirePricingGuideResponse extends HirePricingGuide {
  fleetUnit: { id: Id; registration?: string; make?: string; model?: string; status: FleetUnit['status']; gtaGroup: string; dailyRatePence: Pence };
  clientVehicle: { id: Id; registration: string; make?: string; model?: string; gtaGroup?: string };
  /** The full suggestion behind clientCar (confidence, basis, reason) — shown under the group. */
  clientSuggestion: GtaSuggestion;
  /** Groups with a rate in force on `date`, for the "change group" select. */
  groupsOnDate: string[];
}
export function hirePricingFor(ctx: AppContext, claimId: Id, unit: FleetUnit, startAt: ISODateTime, clientGroupOverride?: string): HirePricingGuideResponse;
```

  Client group: `clientGroupOverride` (source `manual`) → else `gtaSuggestionFor(ctx, { make: spec.catalogue?.makeSlug ??
  v.make, model: spec.catalogue?.modelSlug ?? v.model, generationId, trimId, segment: spec.segment, bodyType,
  engineCapacityCc, fuelType, variant, recordedGroup: v.gtaGroup, yearOfManufacture, date })` → source `recorded` when
  `basis === 'recorded'`, `suggested` when a group came back, else `none`.
* `GET /claims/:id/hire/pricing-guide?fleetUnitId=<id>&startAt=<iso>&clientGroup=<G>` → `HirePricingGuideResponse`
  (`startAt` default now; `clientGroup` regex `^[A-Z]{1,3}\d{0,2}$` after upper-casing).
* `POST /claims/:id/hire` stores the snapshot: `fleetDailyRatePence = unit.dailyRatePence`, `hireGtaDailyRatePence`,
  `clientGtaGroup`, `clientGtaDailyRatePence`, `pricingNote = notices.join(' ')` (≤ 1000 chars). Body may carry
  `clientGtaGroup` (the manual choice). Response adds `pricing: HirePricingGuideResponse`.
* `GET /claims/:id/hire` items add `pricing: HirePricingSnapshot` and `calculation` is computed with
  `likeForLikeGroup = h.clientGtaGroup`:

```ts
interface HirePricingSnapshot {
  snapshot: boolean;                 // false for pre-0.3 hires: figures computed now from the client car's current group
  agreedDailyRatePence: Pence;       // h.dailyRatePence
  fleetDailyRatePence: Pence | null;
  hireGroup: string; hireGtaDailyRatePence: Pence | null;
  clientGtaGroup: string | null; clientGtaDailyRatePence: Pence | null;
  differencePerDayPence: Pence | null; higherGroup: boolean;
  notices: string[]; note: string;
}
```

---

## C. Editable and backdated hire dates

### C.1 What the user sees

* **Start hire** has no minimum date. Under "Hire started" the hint reads "Past dates are fine — late entries are
  recorded as such." An optional **"Hire ended (only if it has already ended)"** date-time plus "What ended it" lets a
  forgotten hire be entered in one go.
* Every hire card (running or ended) has **Edit dates & rate**. The dialog: Hire started · Hire ended (blank = still
  running) · What ended it (when ended) · Agreed daily rate · Car we give group · Client's car group · **Reason
  (required)** (placeholder "e.g. agent forgot to upload the hire on time") · **Update the claimed hire amount on the
  ledger** (checkbox, default on) · a live preview "Now 12 days · £597.60 net → after 10 days · £498.00 net (−£99.60)".
* Warnings (amber, never blocking): end in the future ("the hire will show as running until then"), start before the
  accident date, start more than a year ago, overlap with another hire of the same car (server refusal → prompt, or
  silent override in manager mode). End before start: red error, amber warning in manager mode.
* After saving: toast "Hire CCG-H-000004 updated — 10 days, £498.00 net. Clocks recalculated." plus the ledger outcome
  ("Claimed hire amount corrected on the ledger" / "Check the claimed hire amount on the ledger" / "Already invoiced —
  issue a corrected invoice or credit note").
* Cards show **"Entered late"** (start more than 24 h before it was recorded): "Started 1 Sep 10:00 · recorded 5 Oct by
  Courtesy Cars", and "Corrected 2×" with the list (when, who, reason, from → to).
* Chronology: corrected events stay visible, struck through, badge "Corrected", tooltip "Replaced by the entry recorded
  <date>"; attributable-days figures use the live events only.

### C.2 Domain (hire-api)

`packages/domain/src/events/corrections.ts` (+ `events/index.ts`; `packages/domain/src/index.ts` gains
`export * from './events/index.js';`):

```ts
import type { ClaimEvent, Id } from '../types.js';
/** `data.correctsEventId` on an event marks the event it replaces (append-only correction, like ledger supersedesId). */
export const CORRECTS_EVENT_KEY = 'correctsEventId';
export function correctedEventId(e: ClaimEvent): Id | undefined;          // string data.correctsEventId or undefined
export function supersededEventIds(events: readonly ClaimEvent[]): Set<Id>;
/** Events with every corrected one removed (chains: A corrected by B corrected by C → only C). Order preserved. */
export function liveEvents<T extends ClaimEvent>(events: readonly T[]): T[];
```

`packages/domain/src/fleet/hireOverlap.ts` (+ export from `fleet/index.ts`):

```ts
export interface HirePeriod { startAt: ISODateTime; endAt?: ISODateTime | null }
/** Half-open [start, end); an open end is +∞. Touching periods (one ends when the next starts) do not overlap. */
export function hirePeriodsOverlap(a: HirePeriod, b: HirePeriod): boolean;
export function overlappingHires<T extends HirePeriod & { id: Id }>(candidate: HirePeriod, hires: readonly T[], excludeId?: Id): T[];
/** off_road / disposed are kept; otherwise 'on_hire' iff some hire is not over at `now` (no end, or end > now) —
 *  a hire booked to start later also counts (today's behaviour: creating a hire puts the car on hire); else 'available'. */
export function fleetStatusFromHires(unit: Pick<FleetUnit, 'status'>, hires: readonly HirePeriod[], now: ISODateTime): FleetUnit['status'];
```

`clocks/derive.ts`: `deriveClocks` applies `liveEvents(bundle.events)` before filtering by `now`;
`earliestHireStart` uses the hire records when there are any and only falls back to the first live `hire_started`
event when there are none. New tests in `derive.test.ts`: a start moved later moves the NCAF clock; a corrected
`hire_ended` moves the off-hire clock; a re-opened hire (`note` correcting `hire_ended`) is running again.

### C.3 Server (hire-api)

`packages/db/src/repos/hire.ts`:

* `CreateHireInput` accepts the five pricing fields; `createHire(db, input, opts?: { allowEndBeforeStart?: boolean })`.
* `correctHire(db, id, patch: { startAt?: ISODateTime; endAt?: ISODateTime | null; endTrigger?: HireEndTrigger | null; dailyRatePence?: Pence; gtaGroup?: string; clientGtaGroup?: string | null; clientGtaDailyRatePence?: Pence | null; hireGtaDailyRatePence?: Pence | null; pricingNote?: string | null }, opts?: { allowEndBeforeStart?: boolean }): HireAgreement` — writes explicit nulls (clears the end), validates `dailyRatePence > 0`.
* `endHire(db, id, input, opts?: { allowEndBeforeStart?: boolean })`.
* `bundle.ts`: `events: options.includeSupersededEvents ? all : liveEvents(all)` (new option, default false).
* `apps/api/src/services/analytics.ts`: wrap `listEvents` results in `liveEvents` (one-line change, hire-api).

`apps/api/src/schemas/hire.ts`:

```ts
createHireBody  += { endAt?: isoDateTime, endTrigger?: hireEndTrigger, endReason?: string, clientGtaGroup?: gtaGroupCode }
// overrideAllocation stays accepted (reason ≥ 3) — recorded only
export const correctHireBody = z.object({
  startAt: isoDateTime.optional(),
  endAt: isoDateTime.nullable().optional(),        // null = re-open (still running)
  endTrigger: hireEndTrigger.optional(),           // default: existing trigger, else 'manual' when an end is set
  dailyRatePence: pence.refine((p) => p > 0, 'Daily rate must be more than £0').optional(),
  gtaGroup: gtaGroupCode.optional(),
  clientGtaGroup: gtaGroupCode.nullable().optional(),
  reason: z.string().trim().min(3, 'Give the reason for the change'),
  ledger: z.enum(['auto', 'skip']).default('auto'),
});
```

`POST /claims/:id/hire` (replaces today's handler):

1. `gate = gateFor(ctx, request)`; `assertNoHardStop(claim, gate)`.
2. `endAt < startAt` → `gate.refuse(new HttpError(400, 'HIRE_END_BEFORE_START', …), target)`.
3. `allocation = canAllocateFor({ ...unit, status: unit.status === 'on_hire' ? 'available' : unit.status }, use, policies, startAt, vehicle)`.
4. `overlaps = overlappingHires({ startAt, endAt }, listHireForFleetUnit(unit.id))` → when any:
   `gate.refuse(conflict('HIRE_OVERLAP', 'FL33 EET is on hire CCG-H-000002 (claim CCG-2026-00003) from … to …', { overlaps: [{ hireId, agreementNumber, claimId, claimReference, startAt, endAt }] }), target)`.
5. `!allocation.ok` → `gate.refuse(conflict('ALLOCATION_REFUSED', …, { reasons }), target)`.
   Target for 2–5: `{ claimId: id, entity: 'fleet_units', entityId: unit.id }`.
6. Transaction: `createHire` (+ snapshot, + `endAt/endTrigger` when given); unit status
   `fleetStatusFromHires(unit, [...unitHires, h], now)` (written only when it changes); `hire_started` event at
   `startAt` with `data { hireId, fleetUnitId, use, allocation, lateEntry }` (`lateEntry = startAt < now − 24 h`); when
   ended, `hire_ended` at `endAt` with the usual data and `lateEntry`; `HIRE_ENFORCEABILITY_GAP` as today; warn flag
   `HIRE_DATES_INVALID` when end < start; audit `hire.create` (`after` adds `pricing`, `lateEntry`,
   `override: body.overrideAllocation ?? null`).
7. `recomputeClocks`; 201 `{ hire, allocation, enforceabilityGaps, pricing, warnings }` — `warnings` (strings): end in
   the future, start before the accident, start > 365 days ago, allocation warnings.

`POST /claims/:id/hire/:hireId/end`: unchanged contract; end < start → gate `HIRE_END_BEFORE_START`; already ended →
409 `HIRE_ALREADY_ENDED` "Use Edit dates to change the end" (C); unit status via `fleetStatusFromHires`; `lateEntry`
on the event.

`PATCH /claims/:id/hire/:hireId` (`services/hireCorrection.ts` `correctHireDates(ctx, request, claimId, hireId, body)`):

1. `WRONG_CLAIM` (C). Merge `next = { startAt, endAt, endTrigger, dailyRatePence, gtaGroup, clientGtaGroup }`.
   Nothing changed → 200 with `changed: false`.
2. `next.endAt < next.startAt` → gate `HIRE_END_BEFORE_START`. Overlap of `next` with the car's other hires → gate
   `HIRE_OVERLAP`. (Allocation is **not** re-checked on a date correction.)
3. `before = calculateHire(current, current.endAt ?? now, { rates, likeForLikeGroup })`; `after` likewise for `next`.
4. One transaction:
   * `correctHire(...)`; when `clientGtaGroup` or the start date changed, refresh the pricing snapshot via `hirePricingFor`.
   * Events (never edited): start changed → find the live `hire_started` with `data.hireId === hire.id` (fallback: the
     first live `hire_started` when the hire is the only one on the claim) and append a `hire_started` at the new start,
     `data { hireId, fleetUnitId, correctsEventId: old?.id, correction: true, reason, lateEntry }`, summary "Hire
     CCG-H-000004 start corrected from 1 Sep 10:00 to 3 Sep 10:00 — <reason>". End changed: old live `hire_ended`
     exists and new end set → `hire_ended` correcting it; old exists and new end null → `note` event at now with
     `correctsEventId` "Hire … re-opened — end removed: <reason>"; no old and new end set → plain `hire_ended`.
     Rate/group only → `note` event "Hire … daily rate corrected from £x to £y — <reason>".
   * Unit status via `fleetStatusFromHires`.
   * Ledger (`ledger: 'auto'`), only when net or VAT changed — `correctHireLedger()`:
     - live `hire` rows of kind `invoiced`, `paid`, `interim_paid`, `reduced` or `written_off` → warn flag
       `HIRE_PERIOD_CHANGED_AFTER_INVOICE` "Hire … changed after it was invoiced (was N days £A, now M days £B): issue a
       corrected invoice or a credit note." (those rows are never touched);
     - exactly one hire on the claim and exactly one live `hire`/`claimed` row → append `{ head: 'hire', kind:
       'claimed', amountPence: after.netPence, vatPence: after.vatPence, date: londonDate(now), description: "Credit
       hire M days × £r (corrected: <reason>)", supersedesId: <that row> }` → `superseded`;
     - otherwise, live `claimed` hire rows exist → warn flag `HIRE_LEDGER_REVIEW` → `review`; none → `none`.
   * End < start → warn flag `HIRE_DATES_INVALID`; when corrected later, the flag is cleared by the system with reason
     "Dates corrected".
   * Audit `hire.correct` (entity `hire_agreements`, entityId hire id) `before`/`after` = the changed fields + days and
     net, `after.reason`, `after.claimId`, `after.ledger`.
5. `recomputeClocks`. Response:

```ts
interface CorrectHireResponse {
  changed: boolean;
  hire: HireAgreement;
  calculation: HireCalculation;
  before: { startAt: string; endAt?: string; dailyRatePence: number; days: number; netPence: number; grossPence: number };
  after:  { startAt: string; endAt?: string; dailyRatePence: number; days: number; netPence: number; grossPence: number };
  warnings: string[];
  ledger: { action: 'none' | 'superseded' | 'review' | 'invoiced'; entryId?: string; message: string };
  clocks: Clock[];
}
```

`GET /claims/:id/hire` items (full shape, used by hire-web):

```ts
type HireListItem = HireAgreement & {
  calculation: HireCalculation;                 // asOf now for running hires; likeForLike when clientGtaGroup set
  enforceabilityGaps: string[];
  pricing: HirePricingSnapshot;                 // §B.3
  recordedAt: string;                           // hire row createdAt
  recordedBy?: string; recordedByName?: string; // hire_started event createdBy / user name
  backdated: boolean;                           // startAt more than 24 h before recordedAt
  corrections: Array<{ at: string; by: string; byName?: string; reason: string; changes: Record<string, { from: unknown; to: unknown }> }>; // from hire.correct audit rows
};
```

Documents: drafts already made from the old dates will raise `HIRE_PERIOD_MISMATCH` on their next consistency check;
the remedy is Supersede (unchanged).

---

## D. The typing bug ("clicks off per character")

### D.1 Root causes (verified in Chromium by two independent runs)

1. **`apps/web/src/components/Modal.tsx:15-28`.** The effect depends on `[open, onClose]` and calls
   `ref.current?.focus()`. Most dialogs pass a `close` function created on every render (`HireTab.tsx` End hire, End
   storage, Start hire, Add storage, Add recovery; `ReasonDialog.tsx:35`; `StatusControl.tsx:55`; `FlagsBanner.tsx:47`;
   `DocumentView.tsx:308`; `UnitDialog.tsx:181` nested Add policy; every parent that passes `onClose={() => …}` and
   re-renders on a query refetch). Each keystroke → `setForm` → re-render → new `onClose` → the effect re-runs → focus
   jumps to the dialog `<div tabIndex=-1>`. Evidence: "12345" into Odometer out left "1"; "49.99" into Daily rate left
   "4.00" (the blur reformatted "4"); the override box got "m"; the End-hire note got "c".
2. **`MoneyInput` blur reformat** amplified it (a side effect of 1, harmless once focus stays).
3. **`DateTimeInput`** is fully controlled from the model; while a datetime-local value is incomplete the browser reports
   `''`, which is pushed to the model and back, so a parent re-render can wipe half-typed segments. This matters for
   typing backdated dates (§C).

### D.2 Fixes (focus-simplify)

`Modal.tsx`:

```tsx
const onCloseRef = useRef(onClose);
useLayoutEffect(() => { onCloseRef.current = onClose; });
// Escape + scroll lock: [open] only; Escape closes only the top-most open modal (nested Add policy).
useEffect(() => {
  if (!open) return;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && isTopmost(ref.current)) onCloseRef.current(); };
  document.addEventListener('keydown', onKey);
  const prev = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
}, [open]);
// Initial focus once per opening, never while focus is already inside; restore focus to the opener on close.
useEffect(() => {
  if (!open) return;
  const el = ref.current;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (el && !el.contains(document.activeElement)) el.focus();
  return () => { if (opener && opener.isConnected && !opener.closest('.modal')) opener.focus(); };
}, [open]);
```

(React's `autoFocus` runs during commit, before the effect, so an `autoFocus` field keeps focus.) Backdrop
`onMouseDown` and the ✕ button call `onCloseRef.current()`.

`Form.tsx`:

* `Field` and every input accept `warning?: ReactNode`, shown as `<div className="field-warning">` (amber, icon ⚠,
  `role="status"`) when there is no `error`; error > warning > hint. CSS in `components.css` using the existing
  `--amber` / `--amber-bg` tokens.
* `DateTimeInput` keeps a local `draft` (`useState(toDateTimeLocalValue(value))`); `onChange` stores the draft and calls
  the model `onChange` only with a complete value; an empty draft is pushed (`''`) on **blur**, not while typing; a model
  change from outside (reset) resyncs the draft only when it differs from the parsed draft and the input is not
  focused. Same pattern for `DateInput`.
* `MoneyInput`: unchanged behaviour; add a test that typing "49.99" in a modal keeps "49.99".

### D.3 Permanent guards

**Vitest (jsdom).** devDeps (§0.2) + `apps/web/src/test/harness.tsx` (focus-simplify, written first; it registers
`afterEach(cleanup)` itself because vitest globals are off, so no global setup file is needed):

```tsx
/** Render with QueryClient (retry off), MemoryRouter, ToastProvider and optional pre-seeded query data. */
export function renderWithProviders(ui: ReactElement, opts?: { route?: string; queryData?: Array<[QueryKey, unknown]> }): RenderResult & { queryClient: QueryClient; user: UserEvent };
/** Click `el`, type `text` one key at a time; after EVERY key assert document.activeElement === el; finally assert el.value === expected (default text). */
export async function typeAndExpectFocus(user: UserEvent, el: HTMLInputElement | HTMLTextAreaElement, text: string, expected?: string): Promise<void>;
```

Test files start with `// @vitest-environment jsdom`; the default environment stays `node`, so the 41 existing
`renderToString` test files are untouched. Required tests:

* `src/test/focusGuard.test.tsx` (focus-simplify): a Modal whose `onClose` is an inline closure over the form state, with
  TextInput, TextArea, MoneyInput ("49.99"), numeric TextInput ("12345") → focus kept and values exact; the parent
  re-rendering with a new `onClose` every 50 ms while typing → focus kept; nested modals: Escape closes only the inner
  one; opener regains focus on close; `DateTimeInput` partial edit is not wiped by a parent re-render; the real
  `UnitDialog`, `ReasonDialog` and `StatusControl` dialogs typed into.
* `src/screens/claim/tabs/HireTab.focus.test.tsx` (hire-web): Start hire (odometer, rate, reason fields), Edit dates
  (reason, rate), End hire (note, odometer), Add storage (location), Add recovery (from, to, miles).

**Playwright sweep** `claimdesk/scripts/focus-sweep.mjs` (focus-simplify; root script `"focus:sweep": "node scripts/focus-sweep.mjs"`):

* Resolves `playwright-core` through `createRequire(<repo>/claimdesk/packages/documents/package.json)`; browser from
  `CHROMIUM_PATH`; options `--base http://localhost:PORT --user courtesycars --password CourtesyCars123! --out <dir>`.
* Signs in, turns Manager mode **on** via `POST /api/auth/manager-mode` (so every wizard step is reachable), reads claim
  ids from `/api/claims`.
* Visits: `/`, `/claims`, `/claims/new` (clicks each of the 5 steps), every claim tab URL for every seeded claim
  (`/claims/<id>/<tab>` for all 13 tab ids), `/fleet`, `/directory`, `/kb`, `/analytics`, `/watch`, `/settings`,
  `/settings/templates`, `/settings/gta-rates`, `/capture`.
* On each page, sweeps every visible, enabled, editable `input` (types text, search, email, tel, url, password, number,
  and `inputmode=decimal|numeric`) and `textarea`; then opens each dialog it can find by clicking visible buttons whose
  name matches `/^(Start hire|End hire|Edit dates|Add storage|End storage|Add recovery|Add unit|Edit|Allocation check|Add penalty|New document|Fill a|Upload|Add offer|Record|Log|Add comparable|Import|Edit vehicle|Add reading|Clear|Verify|Report|Add rate|Add)/`
  (never `/Delete|Remove|Sign out|Dispose|Approve|Send|Issue|Generate|Turn off/`), plus the status select (choosing
  the first option opens the status dialog); sweeps the dialog's inputs the same way, closes it with Escape.
* For each field: click, select-all + Backspace, type the probe one character at a time (`delay 15`) — `Ab1 9.5x` for
  text, `12345` for numeric, `49.99` for decimal — and after **each** character check
  `el === document.activeElement`; then check the value contains the probe (decimal may be reformatted on blur to
  `49.99`). Date-time fields: type `05102026` Tab `1030` and check the value is complete.
* Writes `<out>/focus-report.json` `{ checked, failures: [{ route, dialog?, label, typed, got, activeElement }] }` and
  a screenshot per failure; exit code 1 when any failure. Never submits a form (no Enter, no submit buttons).

---

## E. Simplify — the 15 changes

All keep every capability one click away (`<details>`, a "More" menu, a toggle). A collapsed section that holds a
validation error opens itself. Each is low risk (layout/copy) unless marked.

| # | Change | Exact spec | Slice |
|---|---|---|---|
| E1 | Claim file tabs | Primary row: **Overview · Hire** (was "Hire · Storage · Recovery") **· Documents · Evidence · Vehicle · Next actions (n)**. A **More ▾** button (menu, keyboard accessible) holds Chronology, Ledger, Clocks, Evidence gates, **Offers** (was "Intervention register"), Engineering, Flags (n). When the current tab is in More, the More button shows its name. Open-flag count badge on More. URLs unchanged. | FS |
| E2 | Claims list | API `services/claimList.ts` enriches each row: `insurerName` (at-fault insurer party), `handlerName` (users), `outstandingPence` (`ledgerPosition`), `oldestOverdueClock` (from the clocks cache). Web: Handler filter shows names; under 640 px rows become cards (ref · name · reg · status · overdue pill · outstanding) and the 3 filters sit behind a **Filters** toggle. | FS |
| E3 | Directory | Compact card: name + verification badge, third-party claims number (large) with "Copy", portal link, copycat warning (kept visible). Address, group, source note and notes in a closed `<details>` "More about this insurer". Remove the duplicate UNVERIFIED banner (badge stays). Cards with a TP number first. | UD |
| E4 | Fleet unit dialog | Order: Registration + Search → Make/Model/Year → GTA group + Daily rate → Declared use + Policy + Status → closed sections "More vehicle details", "Features & extras (n selected)", "Keeper address" (one-line summary when filled). | FS |
| E5 | Vehicle picker (FNOL vehicle step and fleet) | After Search: Make, Model, Year, Fuel, Transmission, Odometer. "Paste from Total Car Check" is a button that opens the paste panel. Details and Features collapsed by default. | FS |
| E6 | New-claim wizard: 5 steps (medium risk) | Disclosure → Claimant & driver → Vehicle → **Accident & offers** (the "Has anyone offered the client a vehicle?" block at the end of the accident step, same Yes-expands behaviour) → Services & review. Validation keys unchanged; `fnol.test.ts` updated. | MW |
| E7 | Handler pre-filled | `handlerId` defaults to the signed-in user; a select of users with the current user first. | MW |
| E8 | Plain English | Remove spec references, enum codes and API routes from visible text: "On submit: one POST /claims" → "Opening the claim saves it. Nothing is sent to the insurer."; "BLUEPRINT §3.1 … INTAKE_INCOMPLETE flag" → "If unknown, the claim opens with a reminder to get it."; "Missing items raise a HIRE_ENFORCEABILITY_GAP warning" → "Anything missing is flagged on the claim so it can be added later."; "lessons f, h", "lesson i", "BLUEPRINT §7.7", "BLUEPRINT principle 2" removed; top-bar pill "Clocks due today 1+11" → "11 overdue · 1 due today"; mobile top-bar search placeholder "Search". Legal citations move into an (i) `title` tooltip. Each slice edits only its own files; the copy-guard tests (benchmark wording in `lib/hire.ts`, "not a GTA subscriber" in `BasisText.tsx`) stay green. | all web slices |
| E9 | Documents tab | One **New document** button → chooser with sections: CCGUK Word templates (opens the Fill dialog) · Letters · Invoices · Forms · Reports & packs (optgroups by template id prefix). Recipients de-duplicated by party id; roles humanised ("third party driver"). Table: user names instead of UUIDs; Hash column removed (kept on the document view). | FS |
| E10 | Start hire | §B/§C layout: Fleet car → Class of use → Hire started (+ optional Hire ended) → Pricing guide → Agreed daily rate with chips. Closed sections "Handover (optional)" (excess, waiver, delivered, odometer) and "Paperwork — can be added later" with a **"Paperwork signed now"** button that stamps the four enforceability times and the signed time with the hire start; the 60F checkbox and statement of need inside. No override box. | HW |
| E11 | Dashboard | Next actions: one line each (title · ref · due · £ protected) with a "Why" disclosure; identical actions grouped ("Collect the Statement of Means — 3 claims"). Clocks: one row per claim with its worst clock and "+6 more". Phones: KPI tiles 2×2. | UD |
| E12 | Next actions tab | Title, one-sentence reason, due pill, £ protected, "Generate document". Codes, template ids and KB slugs under a closed "Sources (n)" disclosure linking to the KB. | FS |
| E13 | Vehicle tab | Identification card hides empty rows ("Show all fields" toggle); odometer form behind an "Add reading" button; mileage explanation one line with (i). | FS |
| E14 | GTA benchmark rates | Default view: the current period, grouped S/M/F/CP/PV, "Show previous periods" toggle; one disclaimer line; Edit/Hide as icon buttons on one line. | UD |
| E15 | Settings | Sub-nav at the top: Company · Bank · Rates · Manager mode · Updates · Templates · GTA rates · Lookups · Password. API keys collapsed to one status line ("Lookups: manual — 0 of 5 keys set ▸"). One sticky Save button. Users card hidden when the list is empty. | UD |

---

## F. The update installer (0.3.x) and the in-app Updates card

### F.1 Upgrade path (verified by reading `packaging/installer/ClaimDesk.iss` at `04566ad`, the 0.2.6 commit)

* `AppId={{322DAE75-FC0F-4786-B2BB-62E4A6A3D59B}` — **unchanged**; per-user (`PrivilegesRequired=lowest`),
  `UsePreviousAppDir=yes`, program in `%LOCALAPPDATA%\Programs\ClaimDesk`, `[InstallDelete] {app}\app` replaces the
  program files wholesale, `PrepareToInstall` asks to close a running ClaimDesk then `taskkill /F /T`.
* Data in `%LOCALAPPDATA%\ClaimDesk` (`launch.cjs homeDir()`), never touched by install/upgrade; silent uninstall never
  deletes it.
* Migrations run on start (`buildContext` → `runMigrations`). Drizzle applies a journal entry when its `when` is later
  than the last applied one: 0.2.6 databases end at `0005` (`when 1791600000000`), so **0006 must use
  `1791700000000` and 0007 `1791800000000`** (§G.2).
* The service worker serves navigations network-first and hashed assets cache-first, so the new UI loads after an
  upgrade; `CACHE_VERSION` is bumped to `claimdesk-shell-v3` anyway (`apps/web/public/sw.js`).
* Downgrade: 0.2.6 code can open a 0.3 database (new columns are nullable and unused by its explicit selects; its
  migrator finds nothing newer to run).

### F.2 Changes (updates-desktop)

1. Root `package.json` `"version": "0.3.0"` → CI `VER = 0.3.<run number>`.
2. **Backup before migrating.** `packages/db/src/backup.ts`:
   `pendingMigrationCount(handle, folder = migrationsFolder): number` (journal entries with `when` > the last
   `__drizzle_migrations.created_at`; all when the table is missing) and
   `backupDatabase(handle, destFile): void` (`VACUUM INTO`, which is WAL-safe). Exported from `packages/db/src/index.ts`.
   `apps/api/src/context.ts` `buildContext`: if the database file existed before opening, is not `:memory:` and
   `pendingMigrationCount > 0` → write `<dirname(databasePath)>/backups/claimdesk-before-<appVersion()>-<yyyyMMdd-HHmmss>.sqlite`,
   keep the newest 5, log it; a backup failure is logged as a warning and the start continues.
3. **Installer** (`ClaimDesk.iss`): an `InitializeSetup` downgrade guard — reads `DisplayVersion` from
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{322DAE75-…}_is1`; when it is newer than `{#AppVersion}` and
   the setup is not silent, asks "ClaimDesk X is installed, which is newer than this setup (Y). Install the older version
   anyway? Your data is kept either way." (default No). Welcome text: "This updates ClaimDesk in place. Your claims and
   settings in %LOCALAPPDATA%\ClaimDesk are kept, and a backup of the database is made the first time the new version
   starts." Everything else unchanged.
4. **CI** (`.github/workflows/claimdesk-windows.yml`):
   * Portable smoke test adds: after sign-in `GET /api/auth/manager-mode` → `allowed == true`, `on == false`;
     `POST /api/auth/manager-mode {on:true}` then `{on:false}` → 200; `GET /api/updates/check` → 200, `current == $VER`,
     `status` in `ok|offline|error`; for file 3 `GET /api/claims/<id>/hire/pricing-guide?fleetUnitId=<first unit>` → 200
     with `hireCar` and `clientCar`.
   * Existing installed-app test (0.0.1 → VER, reinstall over running, silent uninstall) unchanged.
   * **New step "Upgrade the published 0.2.6 install"** (after the uninstall of the previous step, home
     `$RUNNER_TEMP\upgrade-home`):
     1. Download `https://github.com/dannykaleem07-commits/logo/releases/download/claimdesk-v0.2.6/ClaimDesk-Setup-0.2.6.exe`
        and check SHA-256 `316865366b2a45da83f967ddb9f86a886177199ae910a54e843bd5c18f85c2b7`.
     2. Install it silently; start `ClaimDesk.exe --no-browser`; health `version == '0.2.6'`.
     3. Sign in; create a fleet unit (`POST /api/fleet` with `vehicle {registration:'FL25 UPG', make:'NISSAN', model:'QASHQAI'}`,
        `gtaGroup:'M2'`, `dailyRatePence:7468`, `declaredUses:['credit_hire']`); create a claim (`POST /api/claims` with
        the FNOL body of `apps/api/src/test/helpers.ts`); start a hire with `overrideAllocation {reason:'CI upgrade test'}`
        (no policy in a new database; 0.2.6 honours the body override); note the claim id, hire id and claim count;
        `ClaimDesk.exe --stop`.
     4. Run `ClaimDesk-Setup-$VER.exe` silently over it. Start; health `version == $VER`; the claim and hire are still
        there; `GET /api/claims/<id>/hire` item has `pricing` and `corrections`; `GET /api/auth/manager-mode` → 200;
        `<home>\data\backups\claimdesk-before-$VER-*.sqlite` exists; `PATCH /api/claims/<id>/hire/<hireId>` with
        `{ startAt: <2 days earlier>, reason: 'CI backdate' }` → 200 and `after.days` greater than before; `--stop`;
        silent uninstall; the home folder still exists.
   * Release job: `prerelease: false`, `make_latest: 'true'`; body (plain English):

     > **ClaimDesk <ver> for Windows — update.** Download **ClaimDesk-Setup-<ver>.exe** and run it. It updates
     > ClaimDesk in place: your claims, documents and settings in `%LOCALAPPDATA%\ClaimDesk` are kept, and a backup of the
     > database is made automatically the first time the new version starts. No administrator rights are needed. If
     > ClaimDesk is open, the installer asks to close it first.
     >
     > **What's new in 0.3**
     > - **Manager mode** — one click in the top bar (admin and approver users). Anything that would stop you can be
     >   overridden; every override is recorded with who, when and why. Switches itself off after 60 minutes without
     >   activity, and when you sign out.
     > - **Hire pricing guide** — when you pick a car for hire you see its daily rate, the GTA guide for the car you are
     >   giving and for the client's damaged car, the difference, and a warning when the car is a higher group. Pick the
     >   agreed rate with one click. (GTA rates are an industry benchmark only; CCGUK is not a subscriber.)
     > - **Edit hire dates** — change the start and end of any hire, including back-dating a hire an agent forgot to
     >   enter. Charges, clocks and the ledger are recalculated; every change is kept in the history.
     > - **Typing fixed** — fields in pop-up windows no longer lose the cursor after each letter.
     > - **Simpler screens** — fewer tabs, shorter forms, plain English.
     > - **Updates** — Settings → Updates shows your version and tells you when a newer one is out.
     >
     > Windows may say "Unknown publisher" until the installer is code-signed. From 0.3 on, ClaimDesk tells you about new
     > versions itself (Settings → Updates).
5. **Docs**: `claimdesk/docs/RELEASE-NOTES-0.3.md` (the text above plus "How to update", "Where your data is", "If
   something goes wrong: the backup is in `%LOCALAPPDATA%\ClaimDesk\data\backups`"), and an "Updating" section in
   `packaging/README-desktop.md`.

### F.3 In-app Updates (updates-desktop)

* `apps/api/src/services/updates.ts`:

```ts
export interface UpdateCheck {
  status: 'ok' | 'offline' | 'error' | 'disabled';
  current: string;
  latest?: string;
  updateAvailable: boolean;
  release?: { tag: string; name: string; publishedAt?: string; htmlUrl: string; notes?: string /* body, ≤ 4000 chars */ };
  download?: { name: string; url: string; size?: number; sha256?: string };
  checkedAt: string;
  message?: string;
}
export function parseClaimDeskTag(tag: string): string | undefined;            // 'claimdesk-v0.3.12' → '0.3.12'
export function compareVersions(a: string, b: string): number;                  // numeric per part
export async function checkForUpdates(opts: { current: string; url: string; fetchImpl?: typeof fetch; timeoutMs?: number; now: () => string }): Promise<UpdateCheck>;
export function updatesServiceFor(ctx: AppContext): { check(force?: boolean): Promise<UpdateCheck> };   // 1 h cache, forced re-check at most once a minute
```

  `url` = `CLAIMDESK_UPDATE_URL` or `https://api.github.com/repos/dannykaleem07-commits/logo/releases?per_page=30`;
  `CLAIMDESK_UPDATE_CHECK=off` → `disabled`. Headers `Accept: application/vnd.github+json`, `User-Agent:
  ClaimDesk/<current>`. Keep non-draft releases whose tag parses (prereleases included — 0.1.x/0.2.x were published as
  prereleases; `/releases/latest` would skip them); highest version wins; asset `ClaimDesk-Setup-<version>.exe`
  (`browser_download_url`, `size`, `digest` "sha256:…"). Network error/timeout (6 s) → `offline`; non-200/invalid JSON →
  `error`; never throws.
* `GET /api/updates/check?force=1` (signed-in users) in `apps/api/src/routes/updates.ts`, registered in
  `routes/index.ts`.
* Web: `apps/web/src/api/updatesApi.ts`; `screens/settings/UpdatesCard.tsx` (anchor `#updates`): "Installed: ClaimDesk
  0.3.12" · "Up to date (checked 10:42)" / "**ClaimDesk 0.3.15 is available** — published 12 Oct" + "What's new"
  (release notes as plain text, collapsed) + **Download ClaimDesk-Setup-0.3.15.exe (42 MB)** (a link to the asset URL,
  `target="_blank" rel="noopener noreferrer"`) + "Run it once downloaded. Your data is kept." · "Check now" button ·
  offline: "Could not check for updates (no internet?). You can always download the latest version from the ClaimDesk
  releases page." with a link to `https://github.com/dannykaleem07-commits/logo/releases`.
  `screens/settings/UpdateNotice.tsx`: in the side-bar footer under the version, a small link "Update available:
  0.3.15" to `/settings#updates`, from a query with `staleTime` 6 h; renders nothing otherwise or on failure.

---

## G. Shared files, migrations and parallel-work rules

### G.1 Ownership (non-overlapping)

Every file belongs to exactly one slice (§H lists them). A slice may **read** anything. A slice may edit a file it does
not own only where §G.3 says so, and only additively at the named anchor.

### G.2 Migrations (hand-written SQL, no snapshot files — same as 0005)

`packages/db/drizzle/0006_manager_mode.sql` (override-api):

```sql
ALTER TABLE `sessions` ADD `manager_mode_until` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `manager_mode_idle_minutes` integer;
```

`packages/db/drizzle/0007_hire_pricing.sql` (hire-api):

```sql
ALTER TABLE `hire_agreements` ADD `client_gta_group` text;--> statement-breakpoint
ALTER TABLE `hire_agreements` ADD `client_gta_daily_rate_pence` integer;--> statement-breakpoint
ALTER TABLE `hire_agreements` ADD `hire_gta_daily_rate_pence` integer;--> statement-breakpoint
ALTER TABLE `hire_agreements` ADD `fleet_daily_rate_pence` integer;--> statement-breakpoint
ALTER TABLE `hire_agreements` ADD `pricing_note` text;
```

`packages/db/drizzle/meta/_journal.json` final `entries` (ordered by `idx`):

```json
{ "idx": 6, "version": "6", "when": 1791700000000, "tag": "0006_manager_mode", "breakpoints": true },
{ "idx": 7, "version": "6", "when": 1791800000000, "tag": "0007_hire_pricing", "breakpoints": true }
```

override-api inserts entry 6 **immediately after the idx 5 entry**; hire-api appends entry 7 **as the last element**.
Whoever lands second re-reads the file and makes sure the order is 0…7.

### G.3 Shared-file rules (additive edits at an anchor; never reformat the file)

| File | Owner | Others allowed | Rule |
|---|---|---|---|
| `packages/domain/src/index.ts` | — | override-api, hire-api | add one line each after `export * from './templateIds.js';`: `export * from './override/index.js';` (OA), `export * from './events/index.js';` (HA) |
| `packages/domain/src/types.ts` | hire-api | — | HireAgreement optional fields only |
| `packages/db/src/schema.ts` | — | override-api (sessions + settings columns), hire-api (hire_agreements columns) | add columns at the end of the named table's column list only |
| `packages/db/drizzle/meta/_journal.json` | — | override-api, hire-api | §G.2 |
| `apps/api/src/routes/claims.ts` | override-api | focus-simplify | FS replaces only the `return { items: …, total, byStatus }` statement of the `GET /claims` handler with `return listClaimsResponse(ctx, items, ctx.repos.countClaimsByStatus(ctx.db));` and adds its import line |
| `apps/api/src/routes/index.ts` | updates-desktop | — | import + array entry `registerUpdatesRoutes` |
| `apps/web/src/app/AppShell.tsx` | manager-web | updates-desktop | UD adds one import line and `<UpdateNotice />` directly after the `app-version` div in `SideNav` |
| `package.json` (root) | updates-desktop | focus-simplify | FS adds `"focus:sweep": "node scripts/focus-sweep.mjs"` to `scripts` |
| `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/vitest.config.ts` | focus-simplify | — | only FS installs packages (`pnpm --filter @ccguk/web add -D …` from `claimdesk/`) |

### G.4 Contract-first files (write these in your first minutes; others compile against them)

| File | Owner | Used by |
|---|---|---|
| `packages/domain/src/override/{codes,index}.ts` + index line | override-api | hire-api (types), tests |
| `apps/api/src/services/override.ts` (exports §A.4.3; `gateFor` may start as strict) + `errors.ts` `override` field + `helpers.ts` `assertNoHardStop(claim, gate?)` | override-api | hire-api |
| `packages/domain/src/gta/pricing.ts`, `events/corrections.ts`, `fleet/hireOverlap.ts`, `types.ts` fields | hire-api | hire-api only (web copies the HTTP types) |
| `apps/web/src/lib/managerMode.ts`, `apps/web/src/app/managerMode.tsx` (stub provider allowed), `client.ts` `withRelaxed` + `ApiError.override`, `screens/settings/ManagerModeCard.tsx` (stub allowed) | manager-web | hire-web, focus-simplify, updates-desktop |
| `Form.tsx` `warning` prop; `apps/web/src/test/harness.tsx` + devDeps + lockfile | focus-simplify | hire-web, manager-web |

If a contract file you need is not there yet, wait for it (poll with Monitor, up to 20 minutes) — **never create or edit
another slice's file**. Web code never imports API code; hire-web declares the HTTP response types of §B.3/§C.3 in
`api/hireApi.ts`, like `templatesApi.ts` does.

### G.5 Working rules for every slice

* Scratch only under `/tmp/claude-0/-home-user-logo/811a135a-35cb-5723-858d-e84fbd9027fa/scratchpad/v03/<slice-key>/`.
* Own port and data: override-api 4511, hire-api 4512, manager-web 4513, hire-web 4514, focus-simplify 4515,
  updates-desktop 4516. Run the API with `DATA_DIR=<scratch>/data PORT=<port> WEB_DIST_DIR=<scratch>/webdist
  CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; seed with `pnpm --filter @ccguk/api seed` (same
  env), start with `pnpm --filter @ccguk/api start`. Build the web into scratch:
  `pnpm --filter @ccguk/web exec vite build --outDir <scratch>/webdist --emptyOutDir` (never into `apps/web/dist` while
  others work).
* Never run state-changing git commands; never `pkill`/`killall` by pattern — kill only PIDs you started.
* Before finishing: `pnpm --filter <your packages> typecheck` and `test` green; no new `any`; copy-guard tests green.

---

## H. Implementation slices

| Key | Owns (summary) | Contract-first deliverable | Tests it adds |
|---|---|---|---|
| override-api | domain `override/`; db `repos/sessions.ts`, `repos/settings.ts`, `repos/audit.ts`, migration 0006; api `errors.ts`, `app.ts`, `services/override.ts`, `routes/auth.ts`, `routes/helpers.ts`, `routes/claims.ts` (not the GET /claims return), `routes/fleet.ts`, `routes/vehicles.ts`, `routes/engineering.ts`, `routes/settings.ts`, `routes/documents.ts`, `routes/docxTemplates.ts`, `services/documents.ts`, `services/docxDocuments.ts`, `services/documentData.ts`, `schemas/vehicles.ts`, `schemas/services.ts` | §A.3, §A.4.3 | `codes.test.ts`, db sessions/settings/audit tests, `apps/api/src/test/manager-mode.test.ts` (matrix §I.3) |
| hire-api | domain `gta/pricing.ts`, `gta/hire.ts`, `gta/index.ts`, `events/*`, `fleet/hireOverlap.ts`, `fleet/index.ts`, `clocks/derive.ts`, `types.ts` (HireAgreement); db `repos/hire.ts`, `bundle.ts`, migration 0007; api `routes/hire.ts`, `schemas/hire.ts`, `services/hirePricing.ts`, `services/hireCorrection.ts`, `services/analytics.ts` (liveEvents line) | §B.2, §C.2 | `pricing.test.ts`, `hire.test.ts` additions, `corrections.test.ts`, `hireOverlap.test.ts`, `derive.test.ts` additions, db `hire.test.ts`, `bundle.test.ts` addition, `apps/api/src/test/hire-dates-pricing.test.ts` |
| manager-web | `app/managerMode.tsx`, `lib/managerMode.ts`, `lib/errorDetails.ts`, `api/managerApi.ts`, `api/client.ts`, `main.tsx`, `app/AppShell.tsx`, `app/Icons.tsx`, `components/ApiErrorNotice.tsx`, `components/OverridePrompt.tsx`, `styles/manager.css`, `screens/settings/ManagerModeCard.tsx`, `screens/claims/new/**`, `screens/claim/tabs/DocumentView.tsx`, `screens/claim/lib/documents.ts`, `screens/claim/tabs/engineering/EngineerReportForm.tsx`, `screens/claim/tabs/FlagsTab.tsx`, `screens/claim/components/StatusControl.tsx` | §A.5.1 | `managerMode.test.ts`, `errorDetails.test.ts`, `client.test.ts` additions (header, retry, prompt), `managerMode.provider.test.tsx` (jsdom, fake timers), `fnol.test.ts` updates, `documents.test.ts` additions |
| hire-web | `screens/claim/tabs/HireTab.tsx`, `screens/claim/tabs/hire/**`, `screens/claim/lib/hire.ts`, `screens/claim/lib/hirePricing.ts`, `api/hireApi.ts`, `screens/claim/tabs/ChronologyTab.tsx`, `screens/claim/lib/chronology.ts` | — | `hire.test.ts` additions, `hirePricing.test.ts`, `chronology.test.ts` additions, `HireTab.focus.test.tsx` |
| focus-simplify | `components/Modal.tsx`, `components/Form.tsx`, `components/Tabs.tsx`, `styles/components.css`, web `package.json`, `vitest.config.ts`, lockfile, `src/test/**`, `scripts/focus-sweep.mjs`, `screens/claim/ClaimFilePage.tsx`, `screens/claim/claimFile.ts`, `screens/claim/claim.css`, `tabs/DocumentsTab.tsx`, `screens/claim/lib/documentChooser.ts` (new), `tabs/ActionsTab.tsx`, `tabs/VehicleTab.tsx`, `tabs/OverviewTab.tsx`, `screens/claims/ClaimsListPage.tsx`, `screens/claims/claimsFilter.ts`, `screens/fleet/**`, `screens/vehicles/**`, api `services/claimList.ts` | §D.2 `warning` prop, §D.3 harness | `focusGuard.test.tsx`, `claimList.test.ts` (api), fleet/vehicle model tests for relaxations, tab/More test |
| updates-desktop | root `package.json` version, api `routes/updates.ts`, `services/updates.ts`, `context.ts`, `routes/index.ts`; db `backup.ts`, `index.ts`; web `api/updatesApi.ts`, `screens/settings/**` (except ManagerModeCard), `screens/gta/**`, `screens/directory/**`, `screens/dashboard/**`, `public/sw.js`; `packaging/**`; `.github/workflows/claimdesk-windows.yml`; `docs/RELEASE-NOTES-0.3.md` | — | `updates.test.ts` (api, stub server/fetch), `backup.test.ts` + `upgrade.test.ts` (db: migrate a 0.2.6-shape DB), settings/gta/dashboard model tests |

---

## I. Verification plan (the verify phase must prove each ask)

### I.1 Build and tests

From `/home/user/logo/claimdesk`: `pnpm install --frozen-lockfile` (lockfile includes the new web devDeps);
`pnpm -r typecheck`; `pnpm -r --no-bail test` — every suite green and counts ≥ baseline (domain 756, kb 225, db 91, web
373, documents 1018, api 177) plus the new tests; `pnpm --filter @ccguk/web exec vite build --outDir <scratch>/webdist`.

### I.2 Running app

Seed a fresh `DATA_DIR`, start the API on its own port with `WEB_DIST_DIR=<scratch>/webdist`, drive Chromium
(`CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, playwright-core resolved from
`packages/documents`). Screenshots of every step into the scratch folder. Kill only the PIDs started.

### I.3 Manager mode (#2)

* **Toggle.** Sign in as courtesycars → top bar shows "Manager mode" → click → button red "Manager mode ON", banner with
  the reason box and "Turn off", body has class `manager-mode`; `GET /api/auth/manager-mode` `on:true`; audit has
  `manager_mode.on`. Sign out, sign in → OFF. Settings → Manager mode: set 1 minute; turn on; wait 70 s without input →
  OFF + toast; audit `manager_mode.off {why:'idle'}`. Handler role: `manager-mode.test.ts` covers it (header mode
  `X-User-Id: handler`, and a session-mode test that creates a handler with a username and password through the repos);
  in the browser, a handler created the same way by a small script against the scratch database sees no button and gets
  403 from `POST /api/auth/manager-mode`.
* **Bypass matrix (API, `manager-mode.test.ts`, also re-run by the verifier against the running app with curl).** For
  each class A/B code — HARD_STOP, ALLOCATION_REFUSED, HIRE_OVERLAP, REGISTRATION_ON_CLAIM, UNIT_ON_HIRE,
  TRANSITION_REFUSED (non-hirer stage), CHECKLIST_INCOMPLETE, LINES_UNCONFIRMED, TOO_FEW_COMPARABLES, DOCUMENT_BLOCKED,
  TEMPLATE_WARNINGS_UNACKNOWLEDGED, GUARD_BLOCKED (PRINTED_RATES_DIFFER or REFERENCE_DOUBLED), HIRE_OPEN, STORAGE_OPEN,
  NO_PAYMENT_PACK, EXTRA_OVERRIDES_LEDGER, LEGACY_DETAIL, COMPANY_NAME_NOT_REGISTERED, FNOL_INCOMPLETE,
  REGISTRATION_FORMAT, GTA_SUGGESTION_UNAVAILABLE, VALUES_REQUIRED, HIRE_END_BEFORE_START, WEB_VALIDATION:
  1. manager mode off, header absent → the refusal with its HTTP status, and `error.override = { code, allowed: true, managerMode: 'off' }`;
  2. manager mode on + header (`X-Manager-Override: Verify%20test`) → 2xx, the change happened, response header
     `x-manager-overrides` lists the code, and exactly one `audit_log` row `override.<CODE>` with `after.reason ==
     'Verify test'`, the actor, and (when on a claim) entity `claims`/claim id — visible in `GET /claims/:id/audit`;
  3. handler role with header → refusal, `override.allowed == false`, no audit row;
  4. class C spot checks stay refused even with manager mode on: `WRONG_CLAIM`, `IMMUTABLE` (PATCH a ledger row),
     `DOCUMENT_STATE` (send a draft), `S172_REFUSAL`, `TRANSITION_REFUSED` to `liability_transferred` without a hire,
     `BANK_DETAILS_PLACEHOLDER`, `TEMPLATE_CHANGED`, 401 without session.
* **Browser click-throughs.** Manager mode OFF unless stated:
  1. File with a hard stop (create via FNOL with a fleet registration in manager mode, or use a seeded block flag):
     change status to Accepted → prompt "This is blocked — override as manager?" with the flag listed → Override →
     status changes, toast "Overridden: Uncleared hard-stop flag — Manager override", header button now ON.
  2. Fleet: set a unit off road; Start hire with manager mode ON → the unit is selectable with "off road" badge → hire
     starts, toast "Overridden: Fleet car not cleared…".
  3. Fleet → Add unit with a client's registration (e.g. `KR20 VXA`) → prompt (OFF) → Override → unit created.
  4. Add unit with a non-UK plate `B 123 XYZ` and no GTA group but a typed rate, manager mode ON → saved as UNGROUPED.
  5. Document with a block flag: Approve is disabled (OFF); turn ON → "Clear flags and approve" → approved; flags show
     cleared with "Manager override: …".
  6. Engineering report with an incomplete checklist: ON → "Issue anyway" → issued.
  7. New claim wizard ON: jump to step 5, open the claim with only the 5 hard fields → created; INTAKE_INCOMPLETE flag
     lists the gaps; audit shows `override.FNOL_INCOMPLETE` and `override.WEB_VALIDATION`.
  8. Flags tab → Audit trail lists the overrides of that claim with reasons.

### I.4 Hire pricing panel (#3)

1. **Higher-group car.** Create a fleet unit via the API: `FL25 MXX`, NISSAN QASHQAI, group `M2`, £74.68/day,
   credit hire, the seeded Collingwood policy. Open file 4 (client VAUXHALL ASTRA `DK18 WRE`, group S1) → Start hire →
   choose `FL25 MXX` → panel shows fleet rate £74.68, car we give M2 guide £74.68, client's car S1 guide £42.32 ("group
   recorded on the car"), difference +£32.36/day, the amber higher-group sentence, the benchmark caveat, three chips;
   click "Client's car — guide (like for like)" → agreed rate 42.32; start → the card shows agreed £42.32, both guides
   and the difference; `GET /claims/:id/hire` item `pricing.snapshot == true`, `clientGtaGroup == 'S1'`;
   `calculation.likeForLike.group == 'S1'`.
2. **Same group.** Polo `FL44 EET` (S1) on file 4 → no higher-group notice; difference £0.00.
3. **Lower group.** Polo (S1) on file 3 (QASHQAI, M £56.66) → "lower group" sentence.
4. **No client group.** Clear the client vehicle's group (`PATCH /vehicles/:id {gtaGroup:null}`) on a file whose make
   and model give no suggestion → panel says the client's car has no group; choose M from "change" → the vehicle is
   updated and the panel recomputes.
5. **Missing rate.** A unit with group `UNGROUPED` → "No benchmark rate is loaded for group UNGROUPED …".

### I.5 Hire dates (#4)

1. **Backdated start and end in one step.** File 4, unit `FL25 MXX`: start = today −10 days 09:00, end = today −3 days
   09:00, trigger "Client returned" → card: 7 days, net 7 × rate; the unit stays **available**; "Entered late" badge;
   chronology shows `hire_started`/`hire_ended` at those times; NCAF clock state matches the backdated start.
2. **Edit dates.** Post a ledger row `hire`/`claimed` for the 7-day net (Ledger tab). Edit dates: start +2 days, reason
   "agent forgot to upload" → preview 5 days; save → card 5 days, charges recalculated; chronology shows the old
   `hire_started` struck through "Corrected" and the new one; ledger shows the old claimed row superseded and a new
   claimed row for 5 days; audit trail shows `hire.correct` with from/to and reason; clocks recomputed.
3. **Invoiced.** Add an `invoiced` hire row, edit again → flag "changed after it was invoiced"; the invoiced row is
   untouched.
4. **Re-open.** Clear the end → card running; unit `on_hire`; chronology note "re-opened".
5. **End before start.** OFF → red error (client) / prompt (server); ON → saved with amber warning, flag
   `HIRE_DATES_INVALID`, charged 0 days; correcting the dates clears the flag.
6. **Overlap.** Backdate a hire on `FL33 EET` into the period of its seeded hire → refused `HIRE_OVERLAP` listing the
   other agreement → Override as manager → saved.
7. **Future end** → amber warning only.

### I.6 Typing (#6)

* Vitest guards green (`focusGuard.test.tsx`, `HireTab.focus.test.tsx`).
* `pnpm focus:sweep -- --base http://localhost:<port> --out <scratch>/focus` → `failures: []`, `checked` ≥ 150 fields,
  covering every route and dialog of §D.3; the report is attached to the verify notes.
* Manual repeat of the original evidence: Start hire → type "12345" into Odometer out and "49.99" into the agreed rate →
  exact values, focus stays.

### I.7 Simplify (#5)

Screenshots at 1440×900 and 390×844 of: claim file tabs (More menu open), claims list (names, outstanding, overdue),
directory, Add unit, FNOL vehicle step, wizard (5 steps), documents chooser, Start hire, dashboard, actions tab, vehicle
tab, GTA rates, settings. Check each item of §E against its spec; no "BLUEPRINT", "lesson", flag codes or API routes
in visible text on those screens (`grep` the built HTML text via Playwright `innerText`).

### I.8 Update installer (#1)

* Linux, before CI: `packages/db` `upgrade.test.ts` (migrations 0000–0005 into a file DB, seed rows with the 0.2.6
  shape, open with the new code → backup file created, 0006/0007 applied, data intact) green; `actionlint` (or
  `npx --yes @action-validator/cli`) on the workflow if available, else a YAML parse.
* Updates card against a local stub (`CLAIMDESK_UPDATE_URL=http://127.0.0.1:<stub>/releases`) returning a
  `claimdesk-v0.3.99` release → "0.3.99 is available" + Download link to the stub asset URL; stub down → the quiet
  offline message; `CLAIMDESK_UPDATE_CHECK=off` → card says checks are off.
* Windows CI (workflow_dispatch, or the integration commit): all steps green, including **"Upgrade the published 0.2.6
  install"** (§F.2.4) — 0.2.6 installed from the real release asset (SHA-256 checked), data created, upgraded in place
  to 0.3.x, data kept, migrations applied, backup present, hire date edit works, uninstall keeps data. The `[windows-release]`
  integration commit publishes `ClaimDesk-Setup-0.3.<n>.exe` as the latest release with the notes of §F.2.

---

## J. Risks and open questions

| # | Item | Default chosen |
|---|---|---|
| 1 | Overrides are audited after commit (onSend), not inside the route transaction. | Accepted for central coverage; a crash between commit and audit is the only gap (single local process). |
| 2 | Manager mode makes it easy to override payment-safety guards. | Strong warnings in the prompt for GUARD_BLOCKED, LEGACY_DETAIL, DOCUMENT_BLOCKED; BANK_DETAILS_PLACEHOLDER stays C. |
| 3 | Hire ledger auto-correction picks the claimed row only when unambiguous. | Otherwise a review flag; never touches invoiced/paid rows. |
| 4 | Pre-0.3 hires have no pricing snapshot. | Computed at read time, `snapshot: false`. |
| 5 | The real-0.2.6 CI test downloads from GitHub. | Pinned SHA-256; the step fails loudly if the asset changes or is unreachable. |
| 6 | B25b/B27/B28 document preconditions are not overridable yet. | Remedy text and details shown; 0.3.1 if the owner asks. |
| 7 | Storage start/end correction is not in scope. | Same pattern as hire; 0.3.1. |
| 8 | Unsigned installer ("Unknown publisher", Smart App Control). | Unchanged until a code-signing certificate exists (§G.8 of the 0.2 design). |
| 9 | No separate "manager" role. | admin + approver; a role can be added later without changing the gate. |

# @ccguk/web — ClaimDesk PWA

React 19 + React Router 7 + TanStack Query 5, built with Vite 7. No UI library: plain CSS with design tokens.
TypeScript strict, `moduleResolution: Bundler` — relative imports take **no** `.js` suffix here (unlike the packages).

```
pnpm --filter @ccguk/web dev        # http://localhost:5173, /api proxied to the Fastify app on :4000
pnpm --filter @ccguk/web typecheck
pnpm --filter @ccguk/web build      # tsc --noEmit && vite build → dist/  (works without the API running)
pnpm --filter @ccguk/web test       # vitest, environment node (no jsdom): pure-logic tests only
```

## Structure

```
apps/web/
  index.html                      shell page; manifest + icons linked here
  vite.config.ts                  React plugin, /api proxy, node:crypto → src/shims alias (see "Domain package")
  public/
    logo.png                      brand logo (copy of logo-preview.png) — never recoloured
    icons/                        square PWA icons generated from the logo (192, 512, 512-maskable, apple-touch)
    manifest.webmanifest          name ClaimDesk, theme #072647
    sw.js                         service worker: caches the app shell only; /api is never cached
  src/
    main.tsx                      entry: ErrorBoundary › QueryClientProvider › ToastProvider › RouterProvider; SW registered in PROD
    api/
      client.ts                   typed fetch client for EVERY route in docs/ARCHITECTURE.md; ApiError; request shapes
      hooks.ts                    React Query hooks (one per route), key factory `qk`, invalidation, useDashboardData
    app/
      router.tsx                  createBrowserRouter route map
      AppShell.tsx                left nav (drawer < 900px), top bar: global search + "blocked documents" / "clocks" badges
      nav.ts, Icons.tsx           nav entries and inline SVG icons
    components/                   Button, Card, Badge(+StatusBadge, DocumentStatusBadge, VerificationBadge, GateBadge …),
                                  Table, Tabs, Modal, Form (TextInput, TextArea, Select, MoneyInput, DateInput,
                                  DateTimeInput, Checkbox, YesNo), Toast, EmptyState, Spinner/Loading, ErrorBoundary,
                                  PageHeader, KeyValue, ClockPill, Money, DateText, ApiErrorNotice — exported from index.ts
    lib/
      money.ts                    pounds-text ⇄ pence for inputs (display uses formatGBP from @ccguk/domain)
      dates.ts                    en-GB formatting, datetime-local ⇄ ISO, describeDue
      status.ts                   status → badge tone/label maps (green / amber / red / blue / grey)
      clocks.ts                   dueState buckets, oldestOverdue, groupByClaim (presentation only — clocks come from the API)
    screens/
      dashboard/DashboardPage.tsx clocks due today / overdue grouped by claim, blocked documents, next actions,
                                  debtor days, fleet alerts — all from the API with loading + empty states
      claims/ClaimsListPage.tsx   filters (status / handler / insurer / ?q=), columns per the brief; claimsFilter.ts is pure
      claims/new/                 FNOL wizard: fnol.ts (pure model, validation, body builders) + NewClaimPage + Step*.tsx
      claim/ClaimFilePage.tsx     claim-file shell: header, linked-file banner, tab strip, nested routes (tabs are stubs)
      placeholders/               PlaceholderPage for Fleet / Directory / KB / Analytics / Settings / Capture; NotFoundPage
    shims/node-crypto.ts          browser stand-in so the domain package bundles (throws if actually called)
    styles/
      tokens.css                  colours (shell = logo palette; --doc-* = letterhead palette for previews), type, spacing
      base.css                    reset, typography, layout helpers (.page, .grid-*, .row, .stack), notices
      components.css              one block per component, plus wizard / stat / list / reg-plate / doc-preview
      shell.css                   sidebar, top bar, responsive drawer
```

## Conventions (follow these in the next stages)

1. **Money is integer pence** everywhere in state and API bodies. Render with `<Money pence={…}/>` (wraps `formatGBP`).
   Only `MoneyInput` converts pounds text → pence (`lib/money.ts`). Never hold pounds as a number.
2. **Dates are ISO strings.** `ISODate` for `<DateInput>`, `ISODateTime` (UTC, `Z`) for `<DateTimeInput>`.
   Render with `<DateText value time/>`. Working-day arithmetic is the domain's job, not the web's.
3. **The API is the source of truth.** Clocks, gates, actions, acceptance and consistency reports are fetched, never
   recomputed in the browser. `lib/clocks.ts` only buckets due dates for display.
4. **One hook per route** in `api/hooks.ts`, keyed through `qk`. Mutations call `useInvalidateClaim()` which
   invalidates `['claim', id, …]`, `['claims']` and `['analytics']` — nearly every write moves a clock or a gate.
5. **Append-only UX.** Ledger, events and evidence screens offer "add" and "supersede", never edit/delete.
6. **Verification is data.** Show `<VerificationBadge verification={…}/>` next to any directory number, rate, citation
   or manual vehicle entry. Code never upgrades a status; only a person with a source URL does (PATCH /directory/:id/verify).
7. **Nothing is sent automatically.** Document screens must go draft → consistency check → approve (human) → send.
   A `blocked` document shows its flags; each is cleared via `useClearFlag` with a reason.
8. **GTA is a benchmark**: label GTA-derived figures "industry benchmark (CCGUK is not a subscriber)".
9. **Perimeter and script guard.** No screen copy may advise a client to ignore or decline an insurer's offer, imply
   regulated status, or carry legacy details (Car Flex, 17360033, 66 Paul Street, EC2A 4PX, courtesycarsuk.co.uk).
   `screens/claims/new/fnol.test.ts` scans the wizard sources for these; extend that guard to new screens.
10. **Named exports only**, no default exports. Components live in `src/components/` and are re-exported from `index.ts`.
11. **Phone-width first.** Every screen uses `.page`, `.grid-*` and `.form-grid` which collapse at 640/900px; tables
    sit in `.table-wrap` (horizontal scroll). The nav becomes a drawer under 900px.
12. **Loading / empty / error** states on every query: `<Loading/>`, `<EmptyState/>`, `<ApiErrorNotice error={…}/>`.
13. **Tests are pure logic** (vitest, node). Put testable logic in `lib/` or a sibling `*.ts` beside the screen
    (`claimsFilter.ts`, `fnol.ts`) and keep components thin.

## Domain package in the browser

`@ccguk/domain` is consumed from source. Three of its modules import `node:crypto` (evidence/hash, esign/otp,
esign/certificate). `vite.config.ts` aliases `node:crypto` to `src/shims/node-crypto.ts`, whose exports throw if
called, so Rollup can bind the names and tree-shake the unused code. The web app uses only pure domain helpers
(`formatGBP`, `normaliseRegistration`, `isValidUkRegistration`, `formatRegistration`, `clockDefinitions`…).
Hashing in the browser (guided capture) must use Web Crypto (`crypto.subtle.digest('SHA-256', …)`), never `sha256Hex`.
Vitest runs in node (real `node:crypto`), so tests may import anything from the domain.

## API shapes the contract leaves open (documented in `api/client.ts`)

- `GET /claims` → `ClaimSummary[]` (a `Claim` plus optional denormalised `claimantName`, `registration`, `insurerName`,
  `handlerName`, `outstandingPence`, `oldestOverdueClock`, `nextDueClock`, `blockedDocuments`, `openFlags`).
  The client sends both `q`/`search` and `insurerId`/`atFaultInsurerId`; the list page re-applies the filters client-side.
- `POST /claims` ← `CreateClaimBody` (channel, disclosure, claimant, driver?, vehicle, accident, thirdParty?, witnesses,
  clientInsurer?, injury?, services, handlerId?, gtaSubscriber:false). The wizard then posts a `services_agreed` event
  (when any service is agreed), the intervention offer (when the script-guard answer is "yes"), a `note` event and
  `PATCH /claims/:id { injuryReferral }` when injuries were reported (no fee).
- `POST /vehicles/lookup` → `VehicleLookupResult`: `{status:'ok', vehicle, ves?, mot?, motHistory?, linkedClaims?, fleetUnit?}`
  or `{status:'manual_required', reason?, partial?, linkedClaims?, fleetUnit?}`. An `ApiError` whose code contains
  `manual_required` is normalised to the latter. `linkedClaims` → duplicate banner; `fleetUnit` → hard stop.
- `GET /analytics/overview` → `AnalyticsOverview`; every aggregate (`clocks`, `blockedDocuments`, `nextActions`,
  `debtorDays`, `fleetAlerts`) is optional. When missing, `useDashboardData` walks the open claims (≤30) with
  `GET /claims/:id/clocks` and `/actions`, and reads `blockedDocuments` counts from the list rows.
- Lists may come back as `[...]` or `{items:[...]}`; `asList` normalises.

`TODO wire when @ccguk/api lands`: align these with the API's zod schemas and drop the fallbacks that are no longer needed.
`TODO wire when @ccguk/domain intake lands`: replace the script text constants in `fnol.ts` with `intakeScript` and run
`validateFnol` before submit.

## Next stages — where things go

| Screen | Route | Put it in | Hooks already there |
|---|---|---|---|
| Claim file tabs | `/claims/:id/<tab>` | `screens/claim/tabs/*.tsx`, swap the `ComingSoon` elements in `ClaimFilePage.tsx` | `useClaim` (bundle), `useClocks`, `useGates`, `useActions`, `useAcceptance`, `useLedger`, `useEvents`, `useOffers`, `useHire/useStorage/useRecovery`, document hooks, engineering hooks |
| Fleet | `/fleet/*` | `screens/fleet/` | `useFleet`, `useFleetAlerts`, `usePenalties`, `useAllocateCheck`, `useTransitionPenalty` |
| Directory | `/directory` | `screens/directory/` | `useDirectory(q)`, `useVerifyDirectoryEntry`, `useReportDirectoryFailed` |
| Knowledge base | `/kb` | `screens/kb/` | `useKbSearch`, `useKbAdvise`, `useGtaRates` |
| Analytics | `/analytics` | `screens/analytics/` | `useAnalyticsOverview`, `useDebtorDays`, `useReductions`, `useCycleTimes`, `useInterventionsAnalytics` |
| Settings | `/settings` | `screens/settings/` | `useSettings`, `useUpdateSettings` |
| Guided capture | `/capture/*` | `screens/capture/` | `useUploadEvidence` (FormData; compute SHA-256 with Web Crypto first and pass `sha256`) |
| Watch list | inside Settings or Directory | — | `useWatch`, `useAddWatch`, `usePollWatch` |

Replace a placeholder by editing the matching route element in `app/router.tsx` (keep the path) and add the nav
entry to `app/nav.ts` only if it is a new top-level area. Document previews should use `.doc-preview` (letterhead
palette from `packages/documents/src/brand.ts`, mirrored as `--doc-*` tokens) inside an `<iframe srcDoc>` or a
sandboxed container — never inject the document HTML into the shell DOM unsanitised.

## PWA

`public/sw.js` pre-caches the shell (`/`, `/index.html`, manifest, logo, icons), serves navigations network-first with
a cached-index fallback, static assets cache-first, and never touches `/api`. Bump `CACHE_VERSION` when the shell
changes shape. Registration happens only in production builds (`import.meta.env.PROD`) so dev HMR is never cached.
Icons are the logo padded onto white (ImageMagick) — regenerate from `logo-preview.png` if the logo changes.

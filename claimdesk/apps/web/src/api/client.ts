/**
 * Typed fetch client for the ClaimDesk API (docs/ARCHITECTURE.md → "API (apps/api) — route contract").
 *
 * - Base path `/api` (proxied to the Fastify app by vite.config.ts in dev; same origin in production).
 * - Every function returns the parsed JSON body or throws `ApiError` ({ status, code, message, details }).
 * - Money is integer pence and dates are ISO strings on both sides: nothing is converted here.
 * - Request bodies the contract leaves open are typed here (`CreateClaimBody`, `VehicleLookupResult`, …) and
 *   described in apps/web/README.md. Where the API shape is not final, the client normalises defensively
 *   (`asList`) so screens never crash on `{items:[...]}` vs `[...]`.
 *
 * TODO wire when @ccguk/api lands: confirm the zod schemas for POST /claims, POST /vehicles/lookup,
 * GET /analytics/* against the types below and remove the `asList` normalisation if the API always returns arrays.
 */
import type {
  Address,
  CaseAcceptance,
  Claim,
  ClaimBundle,
  ClaimEvent,
  ClaimFlag,
  ClaimStatus,
  Clock,
  Comparable,
  ComplianceAlert,
  CompanyWatch,
  EngineerReport,
  Estimate,
  Evidence,
  FleetUnit,
  FleetUse,
  GateResult,
  GeneratedDocument,
  GtaRate,
  HireAgreement,
  Id,
  InsurerDirectoryEntry,
  InterventionOffer,
  ISODate,
  ISODateTime,
  KbEntry,
  KbEntryType,
  LedgerEntry,
  LookupRecord,
  Party,
  PavAssessment,
  PenaltyNotice,
  Pence,
  PlaybookAction,
  RecoveryRecord,
  StorageRecord,
  TotalLossAssessment,
  TotalLossPrediction,
  TotalLossPredictionInput,
  Vehicle,
  Verification
} from '@ccguk/domain';

// ---------------------------------------------------------------------------
// Errors and transport
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly url: string;
  constructor(status: number, code: string, message: string, url: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.url = url;
    this.details = details;
  }
  /** True for a network failure (no HTTP response at all). */
  get isNetwork(): boolean {
    return this.status === 0;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export const API_BASE = '/api';

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

/** Build `/api/<path>?a=1&b=x`, skipping undefined/null/'' values. Pure; unit-tested. */
export function buildUrl(path: string, query?: Query, base: string = API_BASE): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const params = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      params.append(k, String(v));
    }
  }
  const qs = params.toString();
  return `${base}${cleanPath}${qs ? `?${qs}` : ''}`;
}

/** Encode a path segment (ids, registrations) safely. */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Query;
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Normalise `[...]` or `{ items: [...] }` / `{ data: [...] }` responses to an array. */
export function asList<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === 'object') {
    const r = res as Record<string, unknown>;
    for (const key of ['items', 'data', 'results', 'claims', 'entries', 'rows', 'clocks', 'gates', 'actions', 'events', 'offers', 'hire', 'storage', 'recovery', 'templates', 'documents']) {
      if (Array.isArray(r[key])) return r[key] as T[];
    }
  }
  return [];
}

async function parseError(res: Response, url: string): Promise<ApiError> {
  let body: unknown = undefined;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const err = (body as Partial<ApiErrorBody> | undefined)?.error;
  if (err && typeof err === 'object' && typeof err.message === 'string') {
    return new ApiError(res.status, err.code ?? `HTTP_${res.status}`, err.message, url, err.details);
  }
  const message = typeof body === 'string' && body ? body.slice(0, 300) : `${res.status} ${res.statusText || 'request failed'}`;
  return new ApiError(res.status, `HTTP_${res.status}`, message, url, body);
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query);
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData; // browser sets multipart boundary
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: opts.signal, credentials: 'same-origin' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', `Cannot reach the ClaimDesk API (${(e as Error).message})`, url);
  }
  if (!res.ok) throw await parseError(res, url);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

const get = <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>(path, { method: 'GET', query, signal });
const post = <T>(path: string, body?: unknown, query?: Query) => request<T>(path, { method: 'POST', body: body ?? {}, query });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body });

// ---------------------------------------------------------------------------
// Shapes the contract leaves open (documented in apps/web/README.md)
// ---------------------------------------------------------------------------

export interface Health {
  ok: boolean;
  version?: string;
  time?: ISODateTime;
  lookups?: { dvlaVes?: boolean; dvsaMot?: boolean; companiesHouse?: boolean; gateway?: boolean };
}

export interface ClaimListFilters {
  q?: string; // registration / claim ref / name
  status?: ClaimStatus | ClaimStatus[];
  handlerId?: Id;
  insurerId?: Id;
  registration?: string;
  limit?: number;
  offset?: number;
}

/** Row of GET /claims. The API may return bare `Claim`s; the denormalised fields are optional for that reason. */
export interface ClaimSummary extends Claim {
  claimantName?: string;
  registration?: string;
  vehicleDescription?: string;
  insurerName?: string;
  handlerName?: string;
  claimedPence?: Pence;
  paidPence?: Pence;
  outstandingPence?: Pence;
  oldestOverdueClock?: Pick<Clock, 'id' | 'kind' | 'label' | 'basis' | 'dueAt' | 'status'> | null;
  nextDueClock?: Pick<Clock, 'id' | 'kind' | 'label' | 'basis' | 'dueAt' | 'status'> | null;
  blockedDocuments?: number;
  openFlags?: number;
}

export interface PartyInput {
  kind?: Party['kind'];
  name: string;
  tradingName?: string;
  dateOfBirth?: ISODate;
  address?: Party['address'];
  email?: string;
  phone?: string;
  companyNumber?: string;
  drivingLicenceNumber?: string;
  roles?: Party['roles'];
  notes?: string;
}

export interface VehicleInput {
  registration: string;
  make?: string;
  model?: string;
  variant?: string;
  colour?: string;
  fuelType?: Vehicle['fuelType'];
  transmission?: Vehicle['transmission'];
  yearOfManufacture?: number;
  engineCapacityCc?: number;
  vin?: string;
  motExpiryDate?: ISODate;
  taxDueDate?: ISODate;
  odometerMiles?: number;
  ownership?: Vehicle['ownership'];
  /** Id of the lookup record returned by POST /vehicles/lookup, when one exists. */
  lookupId?: Id;
  /** true when keyed by hand (lookup unavailable or manual_required). Stored as an unverified LookupRecord. */
  manual?: boolean;
}

export interface WitnessInput {
  name: string;
  phone?: string;
  email?: string;
  relationshipToClaimant?: string; // feeds the connected-party checker (§3.9)
  independent?: boolean;
}

/** An existing party by id, or the details for a new one (apps/api schemas/parties.ts `partyRef`). */
export type PartyRef = { id: Id } | PartyInput;

/** Vehicle details for POST /claims (apps/api schemas/vehicles.ts `vehicleInput`); `manual`/`lookupId` are web hints the API ignores. */
export interface ClaimVehicleInput extends VehicleInput {
  odometer?: Array<{ source: Vehicle['odometer'][number]['source']; date: ISODate; miles: number; note?: string }>;
}
export type VehicleRef = { id: Id } | ClaimVehicleInput;

/**
 * The intervention offer captured by the script-guard question, sent inline with the FNOL
 * (apps/api schemas/claims.ts `fnolOffer`). The client's decision is recorded afterwards with PATCH offers.
 */
export interface FnolOfferInput {
  offerorName: string;
  receivedAt?: ISODateTime;
  channel: InterventionOffer['channel'];
  offerorPartyId?: Id;
  vehicleClassOffered?: string;
  dailyRatePence?: Pence;
  rateIncludesVat?: boolean;
  terms?: InterventionOffer['terms'];
  /** Script guard (lesson m): the API refuses `true`; the web never sets it. */
  clientToldToIgnore?: false;
}

/**
 * POST /claims — mirrors apps/api schemas/claims.ts `createClaimBody`. The descriptive web fields at the end
 * (`channel`, `disclosure`, `witnesses`, `services`) are additive: zod strips unknown keys, and the wizard
 * records witnesses and services through their own routes after the claim exists.
 */
export interface CreateClaimBody {
  claimant: PartyRef;
  driver?: PartyRef; // omitted when the claimant drove
  vehicle: VehicleRef;
  thirdParties?: PartyRef[];
  thirdPartyVehicle?: VehicleRef;
  atFaultInsurer?: PartyRef;
  atFaultInsurerRef?: string;
  clientInsurer?: PartyRef;
  clientPolicyNumber?: string;
  accident: Claim['accident'];
  liability?: Claim['liability'];
  handlerId?: Id;
  /** Injury → referral out, no fee (lesson j). The API routes the referral when `accident.injuries` is true. */
  injuryReferralTo?: string;
  interventionOffer?: FnolOfferInput;
  /** Set when any service is agreed at FNOL: the API appends `services_agreed` (starts the GTA 4.1 NCAF clock). */
  servicesAgreedAt?: ISODateTime;
  fnolAt?: ISODateTime;
  /** Call-recording disclosure (BLUEPRINT §3.1) read and acknowledged before any detail was taken. */
  callRecordingDisclosed?: boolean;
  notes?: string;
  // --- descriptive web fields (ignored by the API today; documented in apps/web/README.md) ---
  channel?: 'phone' | 'whatsapp' | 'web_form' | 'in_person' | 'email';
  disclosure?: { callRecordingReadAt: ISODateTime; acknowledged: true; acknowledgedBy?: string };
  witnesses?: WitnessInput[];
  services?: { hire: boolean; recovery: boolean; storage: boolean; engineer: boolean; notes?: string };
}

/** `PATCH /claims/:id` is strict: only these keys are accepted (apps/api schemas/claims.ts `claimPatchBody`). */
export interface ClaimPatchBody {
  accident?: Partial<Claim['accident']>;
  liability?: Claim['liability'];
  liabilityScore?: number;
  driverId?: Id | null;
  thirdPartyIds?: Id[];
  thirdPartyVehicleId?: Id | null;
  atFaultInsurerId?: Id | null;
  atFaultInsurerRef?: string | null;
  clientInsurerId?: Id | null;
  clientPolicyNumber?: string | null;
  handlerId?: Id | null;
  track?: Claim['track'] | null;
}

/** What the API learned at intake (apps/api routes/claims.ts `IntakeReport`); every field optional for older builds. */
export interface IntakeReport {
  validation?: { ok: boolean; missing: string[]; warnings?: string[] };
  crossFile?: { severity?: string; message?: string; duplicateClaimIds?: Id[]; isFleetUnit?: boolean };
  liability?: { score: number; reasons: string[] };
  injury?: { referredTo: string; message: string; feeTaken: false };
  offer?: { id: Id; replyDueBy: string };
  flags?: ClaimFlag[];
}

export interface CreateClaimResult {
  claim: Claim;
  intake?: IntakeReport;
}

/**
 * POST /claims replies `{ claim, intake }` (201). Older or alternative builds may reply with the bare claim or
 * `{ ...claim, intake }`; all three normalise to `CreateClaimResult`. Pure; unit-tested.
 */
export function normaliseCreateClaimResult(res: unknown): CreateClaimResult {
  if (!res || typeof res !== 'object') throw new ApiError(502, 'BAD_RESPONSE', 'POST /claims returned no claim', '/api/claims', res);
  const r = res as Record<string, unknown>;
  const inner = r.claim;
  if (inner && typeof inner === 'object' && typeof (inner as Claim).id === 'string') {
    return { claim: inner as Claim, intake: (r.intake as IntakeReport | undefined) ?? undefined };
  }
  if (typeof r.id === 'string' && typeof r.reference === 'string') {
    const { intake, ...claim } = r;
    return { claim: claim as unknown as Claim, intake: (intake as IntakeReport | undefined) ?? undefined };
  }
  throw new ApiError(502, 'BAD_RESPONSE', 'POST /claims returned an unexpected shape', '/api/claims', res);
}

export type InterventionOfferInput = Omit<InterventionOffer, 'id' | 'claimId' | 'evidenceIds'> & { evidenceIds?: Id[] };

/** `PATCH /claims/:id/offers/:oid` is strict (apps/api schemas/offers.ts `patchOfferBody`). */
export interface OfferPatchBody {
  clientDecision?: 'accepted' | 'declined';
  clientReasons?: string;
  clientDecisionAt?: ISODateTime;
  suitable?: boolean;
  suitabilityReasons?: string[];
  replySentAt?: ISODateTime;
  replyDocumentId?: Id;
  evidenceIds?: Id[];
}

/**
 * Many write routes reply with an envelope (`{ event, effects, clocks }`, `{ offer, replyClock }`, `{ hire, … }`).
 * Return the named entity when present, otherwise the body itself (an API that replies with the bare entity).
 */
export function unwrap<T>(res: unknown, key: string): T {
  if (res && typeof res === 'object' && !Array.isArray(res)) {
    const inner = (res as Record<string, unknown>)[key];
    if (inner && typeof inner === 'object') return inner as T;
  }
  return res as T;
}

export interface CreateEventBody {
  type: ClaimEvent['type'];
  at: ISODateTime;
  summary: string;
  data?: Record<string, unknown>;
  attributableTo?: ClaimEvent['attributableTo'];
  evidenceIds?: Id[];
  documentId?: Id;
}

export interface CreateLedgerBody {
  head: LedgerEntry['head'];
  kind: LedgerEntry['kind'];
  amountPence: Pence;
  vatPence?: Pence;
  date: ISODate;
  description: string;
  counterpartyId?: Id;
  reference?: string;
  sourceDocumentId?: Id;
  sourceEvidenceId?: Id;
  supersedesId?: Id;
}

export interface LinkedClaimRef {
  claimId: Id;
  reference: string;
  status: ClaimStatus;
  openedAt?: ISODateTime;
  claimantName?: string;
  relation?: 'same_registration' | 'fleet_unit' | 'connected_party' | string;
}

/** POST /vehicles/lookup. `status:'manual_required'` when no keys are configured or the services failed. */
export type VehicleLookupResult =
  | {
      status: 'ok';
      registration: string;
      vehicle: Partial<Vehicle> & { registration: string };
      ves?: LookupRecord;
      mot?: LookupRecord;
      motHistory?: Vehicle['motHistory'];
      linkedClaims?: LinkedClaimRef[];
      fleetUnit?: { id: Id; registration: string; status?: FleetUnit['status'] } | null;
      warnings?: string[];
    }
  | {
      status: 'manual_required';
      registration: string;
      reason?: string;
      partial?: Partial<Vehicle>;
      linkedClaims?: LinkedClaimRef[];
      fleetUnit?: { id: Id; registration: string; status?: FleetUnit['status'] } | null;
      warnings?: string[];
    };

/** The API's own reply shape (apps/api services/lookup.ts `VehicleLookupResponse`). */
export type ApiLookupResponse =
  | { status: 'manual_required'; registration: string; fields?: readonly string[]; providers?: Record<string, string>; vehicle?: Vehicle; reason?: string }
  | { status: 'ok' | 'partial'; registration: string; vehicle: Vehicle; providers?: Record<string, string>; lookupIds?: Id[] };

const PROVIDER_LABEL: Record<string, string> = { dvla_ves: 'DVLA VES', dvsa_mot: 'DVSA MOT history' };
const FAILURE_LABEL: Record<string, string> = { no_key: 'no API key configured', network: 'network error', rate_limited: 'rate limited', invalid_payload: 'unexpected payload' };

function describeProviders(providers: Record<string, string> | undefined): string[] {
  if (!providers) return [];
  return Object.entries(providers)
    .filter(([, state]) => state !== 'ok')
    .map(([p, state]) => `${PROVIDER_LABEL[p] ?? p}: ${FAILURE_LABEL[state] ?? state.replace(/^http_/, 'HTTP ')}`);
}

/**
 * API lookup reply → the web's `VehicleLookupResult`. `partial` (one provider answered) is treated as `ok` with a
 * warning per failed provider; `manual_required` carries the reasons and any vehicle already on file. The fleet
 * hard stop (lessons f, h) comes from `vehicle.ownership === 'fleet'`; `linkedClaims` are passed in by the caller
 * (GET /vehicles/:id lists the claims on the registration). Pure; unit-tested.
 */
export function normaliseLookupResult(raw: ApiLookupResponse | VehicleLookupResult, registration: string, linkedClaims?: LinkedClaimRef[]): VehicleLookupResult {
  const r = raw as ApiLookupResponse & { ves?: unknown; linkedClaims?: unknown };
  // Already in the web shape (an API that mirrors apps/web/README.md)? Pass it through.
  if (r.status === 'ok' && ('ves' in r || 'linkedClaims' in r) && !('providers' in r)) return raw as VehicleLookupResult;
  const vehicle = r.vehicle;
  const fleetUnit = vehicle && vehicle.ownership === 'fleet' ? { id: vehicle.id, registration: vehicle.registration } : null;
  const warnings = describeProviders(r.providers);
  if (r.status === 'manual_required') {
    const reason = (r as { reason?: string }).reason ?? (warnings.length ? warnings.join('; ') : 'The lookup services did not return this registration.');
    return { status: 'manual_required', registration: r.registration || registration, reason, partial: vehicle, linkedClaims, fleetUnit, warnings };
  }
  const lookups = vehicle?.lookups ?? [];
  const latest = (provider: string) => [...lookups].filter((l) => l.provider === provider).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  return {
    status: 'ok',
    registration: r.registration || registration,
    vehicle: vehicle!,
    ves: latest('dvla_ves'),
    mot: latest('dvsa_mot'),
    motHistory: vehicle?.motHistory,
    linkedClaims,
    fleetUnit,
    warnings: r.status === 'partial' ? ['Partial lookup — one provider did not answer.', ...warnings] : warnings
  };
}

export interface TemplateMeta {
  id: string;
  version: string;
  kind: string;
  title: string;
  recipientRole?: string;
  description?: string;
  requiredData: string[];
}

export interface CreateDocumentBody {
  templateId: string;
  data?: Record<string, unknown>;
  recipientPartyId?: Id;
}

export interface SignStartBody {
  signerPartyId: Id;
  signerName?: string;
  contact: string; // email or mobile
  channel: 'email' | 'sms';
}

export interface SignStartResult {
  challengeId: Id;
  channel: 'email' | 'sms';
  expiresAt: ISODateTime;
  /** Dev/test only: the API may echo the code when no mail/SMS provider is configured. */
  debugCode?: string;
}

export interface SignVerifyBody {
  challengeId: Id;
  code: string;
}

export interface EvidenceUploadFields {
  kind: Evidence['kind'];
  description?: string;
  capturedAt?: ISODateTime;
  captureShot?: Evidence['captureShot'];
  sourceUrl?: string;
  /** SHA-256 computed on the device before upload (guided capture); the API verifies it matches. */
  sha256?: string;
}

export interface FleetUnitRow extends FleetUnit {
  vehicle?: Vehicle;
  registration?: string;
  alerts?: ComplianceAlert[];
}

export interface AllocateCheckResult {
  allowed: boolean;
  reasons: string[];
  policy?: { id: Id; insurerName: string; coveredUses: FleetUse[] };
}

export interface KbAdvice {
  summary: string;
  points: Array<{ text: string; citations: string[] }>;
  caveats: string[];
  entries?: KbEntry[];
}

export interface DashboardClock extends Clock {
  claimReference?: string;
  claimantName?: string;
}
export interface DashboardAction extends PlaybookAction {
  claimId: Id;
  claimReference?: string;
}
export interface DashboardDocument {
  id: Id;
  claimId?: Id;
  claimReference?: string;
  templateId: string;
  title: string;
  status: GeneratedDocument['status'];
  blockedFlags?: number;
  createdAt: ISODateTime;
}

export interface DebtorDaysSummary {
  overallDays?: number;
  outstandingPence?: Pence;
  byInsurer?: Array<{ insurerId?: Id; insurerName: string; days: number; outstandingPence: Pence; claims: number }>;
  byHandler?: Array<{ handlerId?: Id; handlerName: string; days: number; outstandingPence: Pence; claims: number }>;
}

/** GET /analytics/overview. Every aggregate is optional: the dashboard falls back to per-claim queries. */
export interface AnalyticsOverview {
  asOf?: ISODateTime;
  claims?: { open: number; total?: number; byStatus?: Partial<Record<ClaimStatus, number>> };
  clocks?: { dueToday: DashboardClock[]; overdue: DashboardClock[]; upcoming?: DashboardClock[] };
  blockedDocuments?: DashboardDocument[];
  nextActions?: DashboardAction[];
  debtorDays?: DebtorDaysSummary;
  fleetAlerts?: number | ComplianceAlert[];
  outstandingPence?: Pence;
  interventions?: { open: number; repliesOverdue: number };
}

export interface ReductionsAnalytics {
  byHead: Array<{ head: LedgerEntry['head']; claimedPence: Pence; paidPence: Pence; reducedPence: Pence; reductionPct: number }>;
  byInsurer?: Array<{ insurerName: string; claimedPence: Pence; paidPence: Pence; reductionPct: number }>;
}
export interface CycleTimesAnalytics {
  stages: Array<{ from: string; to: string; medianDays: number; p90Days?: number; claims: number }>;
}
export interface InterventionsAnalytics {
  offers: number;
  accepted: number;
  declined: number;
  repliedWithin1Wd: number;
  byInsurer?: Array<{ insurerName: string; offers: number; accepted: number }>;
}

/**
 * GET/PATCH /settings (apps/api routes/settings.ts over @ccguk/db `Settings`). The registered office is an
 * `Address`; the rate card uses `perMilePence` / `adminPence` on the way out and accepts the web spellings
 * (`recoveryPerLoadedMilePence` / `recoveryAdminPence`) on the way in — both are typed here.
 */
export interface RateCardView {
  recoveryCalloutPence: Pence;
  perMilePence?: Pence;
  adminPence?: Pence;
  recoveryPerLoadedMilePence?: Pence;
  recoveryAdminPence?: Pence;
  storageDailyPence: Pence;
  engineerFeePence: Pence;
  vatRate: number;
}
export interface Settings {
  companyName?: string;
  registeredName?: string;
  registeredOffice?: Address | string;
  companyNumber?: string;
  vatNumber?: string;
  icoRegistration?: string;
  bank?: { accountName: string; sortCode: string; accountNumber: string; bankName?: string };
  rateCard?: RateCardView;
  apiKeys?: { dvlaVes: boolean; dvsaMot: boolean; companiesHouse: boolean; gateway: boolean; esign?: boolean; anthropic?: boolean };
  warnings?: Array<{ code: string; message: string }>;
  [key: string]: unknown;
}

/** GET /engineering/labour-library/suggest → one row per make/model/panel/operation group. */
export interface LabourSuggestionRow {
  make?: string;
  model?: string;
  panel?: string;
  operation?: string;
  count: number;
  medianHours: number;
  minHours?: number;
  maxHours?: number;
  /** null until the library holds enough approved observations for the group. */
  suggestedHours: number | null;
  note: string;
}

export interface WatchPollResult {
  polled: number;
  changed: CompanyWatch[];
  at: ISODateTime;
}

export interface PenaltyTransitionBody {
  stage: PenaltyNotice['stage'];
  note?: string;
  hireAgreementId?: Id;
}

export interface EstimateImportBody {
  text?: string;
  evidenceId?: Id;
  importedTotalPence?: Pence;
  labourRatePence?: Pence;
}

/** POST /claims/:id/pav and /pav/assess (apps/api schemas/services.ts `pavBody`). */
export interface PavBody {
  subject?: Partial<PavAssessment['subject']>;
  comparables?: Array<Omit<Comparable, 'id'> & { id?: Id }>;
  tradeGuidePence?: Pence;
  tradeGuideSource?: string;
  /** Departing from the median needs a reason, which is audited. */
  override?: { pavPence: Pence; reason: string };
  iqrMultiplier?: number;
  filter?: Record<string, unknown>;
}

export interface SupersedeDocumentBody {
  reason?: string;
  reExecutedOn?: ISODate;
  data?: Record<string, unknown>;
}

export interface IssueReportResult {
  report: EngineerReport;
  event?: ClaimEvent;
  document?: GeneratedDocument | null;
  documentNote?: string;
  clocks?: Clock[];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const api = {
  // health
  health: (signal?: AbortSignal) => get<Health>('/health', undefined, signal),

  // claims
  getClaims: async (filters: ClaimListFilters = {}, signal?: AbortSignal) => {
    const status = Array.isArray(filters.status) ? filters.status.join(',') : filters.status;
    // `q` and `insurerId` are the web names; `search` / `atFaultInsurerId` mirror the db repo filter so either API spelling works.
    const res = await get<unknown>('/claims', { ...filters, status, search: filters.q, atFaultInsurerId: filters.insurerId }, signal);
    return asList<ClaimSummary>(res);
  },
  getClaim: (id: Id, signal?: AbortSignal) => get<ClaimBundle>(`/claims/${seg(id)}`, undefined, signal),
  createClaim: async (body: CreateClaimBody): Promise<CreateClaimResult> => normaliseCreateClaimResult(await post<unknown>('/claims', body)),
  updateClaim: (id: Id, body: ClaimPatchBody) => patch<Claim>(`/claims/${seg(id)}`, body),
  setClaimStatus: (id: Id, body: { status: ClaimStatus; reason?: string }) => post<Claim>(`/claims/${seg(id)}/status`, body),
  getClocks: async (id: Id, signal?: AbortSignal) => asList<Clock>(await get<unknown>(`/claims/${seg(id)}/clocks`, undefined, signal)),
  getGates: async (id: Id, signal?: AbortSignal) => asList<GateResult>(await get<unknown>(`/claims/${seg(id)}/gates`, undefined, signal)),
  getActions: async (id: Id, signal?: AbortSignal) => asList<PlaybookAction>(await get<unknown>(`/claims/${seg(id)}/actions`, undefined, signal)),
  getAcceptance: (id: Id, signal?: AbortSignal) => get<CaseAcceptance>(`/claims/${seg(id)}/acceptance`, undefined, signal),

  // parties
  getParties: async (query: { q?: string; role?: Party['roles'][number]; limit?: number } = {}, signal?: AbortSignal) =>
    asList<Party>(await get<unknown>('/parties', query, signal)),
  createParty: (body: PartyInput) => post<Party>('/parties', body),
  getParty: (id: Id, signal?: AbortSignal) => get<Party>(`/parties/${seg(id)}`, undefined, signal),
  updateParty: (id: Id, body: Partial<PartyInput>) => patch<Party>(`/parties/${seg(id)}`, body),
  getPartyConnections: (id: Id, signal?: AbortSignal) => get<unknown>(`/parties/${seg(id)}/connections`, undefined, signal),

  // vehicles
  getVehicles: async (query: { registration?: string; q?: string; limit?: number } = {}, signal?: AbortSignal) =>
    asList<Vehicle>(await get<unknown>('/vehicles', query, signal)),
  createVehicle: (body: VehicleInput) => post<Vehicle>('/vehicles', body),
  getVehicle: (id: Id, signal?: AbortSignal) => get<Vehicle>(`/vehicles/${seg(id)}`, undefined, signal),
  /**
   * POST /vehicles/lookup `{registration}` → DVLA VES + DVSA MOT (live if keys, else manual_required). The API's
   * reply is normalised (see normaliseLookupResult) and, when the vehicle is already on file, enriched with the
   * claims on that registration (GET /vehicles/:id → `claims`) so the wizard can show the cross-file banner and the
   * fleet hard stop before anything is posted.
   */
  lookupVehicle: async (registration: string): Promise<VehicleLookupResult> => {
    let raw: ApiLookupResponse;
    try {
      raw = await post<ApiLookupResponse>('/vehicles/lookup', { registration });
    } catch (e) {
      // Some API builds signal manual entry with an error code rather than a 200 body; normalise both.
      if (isApiError(e) && /manual_required/i.test(e.code)) {
        return { status: 'manual_required', registration, reason: e.message };
      }
      throw e;
    }
    let linkedClaims: LinkedClaimRef[] | undefined;
    const vehicleId = raw.vehicle?.id;
    if (vehicleId) {
      try {
        const detail = await get<Vehicle & { claims?: Array<{ id: Id; reference: string; status: ClaimStatus }> }>(`/vehicles/${seg(vehicleId)}`);
        linkedClaims = (detail.claims ?? []).map((c) => ({ claimId: c.id, reference: c.reference, status: c.status, relation: 'same_registration' as const }));
      } catch {
        linkedClaims = undefined; // enrichment only; the API re-runs the cross-file check on POST /claims
      }
    }
    return normaliseLookupResult(raw, registration, linkedClaims);
  },
  addOdometer: async (vehicleId: Id, body: Vehicle['odometer'][number]) => unwrap<Vehicle>(await post<unknown>(`/vehicles/${seg(vehicleId)}/odometer`, body), 'vehicle'),
  getMileageConflicts: (vehicleId: Id, signal?: AbortSignal) => get<unknown>(`/vehicles/${seg(vehicleId)}/mileage-conflicts`, undefined, signal),

  // ledger & events
  getLedger: async (claimId: Id, signal?: AbortSignal) => asList<LedgerEntry>(await get<unknown>(`/claims/${seg(claimId)}/ledger`, undefined, signal)),
  postLedger: (claimId: Id, body: CreateLedgerBody) => post<LedgerEntry>(`/claims/${seg(claimId)}/ledger`, body),
  getEvents: async (claimId: Id, signal?: AbortSignal) => asList<ClaimEvent>(await get<unknown>(`/claims/${seg(claimId)}/events`, undefined, signal)),
  postEvent: async (claimId: Id, body: CreateEventBody) => unwrap<ClaimEvent>(await post<unknown>(`/claims/${seg(claimId)}/events`, body), 'event'),

  // hire / storage / recovery
  getHire: async (claimId: Id, signal?: AbortSignal) => asList<HireAgreement>(await get<unknown>(`/claims/${seg(claimId)}/hire`, undefined, signal)),
  postHire: async (claimId: Id, body: Partial<HireAgreement> & { use?: FleetUse; overrideAllocation?: { reason: string } }) =>
    unwrap<HireAgreement>(await post<unknown>(`/claims/${seg(claimId)}/hire`, body), 'hire'),
  endHire: async (claimId: Id, hireId: Id, body: { endAt: ISODateTime; endTrigger: HireAgreement['endTrigger']; odometerIn?: number; collectedAt?: ISODateTime; reason?: string }) =>
    unwrap<HireAgreement>(await post<unknown>(`/claims/${seg(claimId)}/hire/${seg(hireId)}/end`, body), 'hire'),
  getStorage: async (claimId: Id, signal?: AbortSignal) => asList<StorageRecord>(await get<unknown>(`/claims/${seg(claimId)}/storage`, undefined, signal)),
  postStorage: (claimId: Id, body: Partial<StorageRecord>) => post<StorageRecord>(`/claims/${seg(claimId)}/storage`, body),
  endStorage: async (claimId: Id, storageId: Id, body: { endAt: ISODateTime; endTrigger: StorageRecord['endTrigger']; reason?: string }) =>
    unwrap<StorageRecord>(await post<unknown>(`/claims/${seg(claimId)}/storage/${seg(storageId)}/end`, body), 'storage'),
  getRecovery: async (claimId: Id, signal?: AbortSignal) => asList<RecoveryRecord>(await get<unknown>(`/claims/${seg(claimId)}/recovery`, undefined, signal)),
  postRecovery: async (claimId: Id, body: Partial<RecoveryRecord> & { counterpartyId?: Id }) => unwrap<RecoveryRecord>(await post<unknown>(`/claims/${seg(claimId)}/recovery`, body), 'recovery'),

  // intervention register
  getOffers: async (claimId: Id, signal?: AbortSignal) => asList<InterventionOffer>(await get<unknown>(`/claims/${seg(claimId)}/offers`, undefined, signal)),
  postOffer: async (claimId: Id, body: InterventionOfferInput) => unwrap<InterventionOffer>(await post<unknown>(`/claims/${seg(claimId)}/offers`, body), 'offer'),
  updateOffer: async (claimId: Id, offerId: Id, body: OfferPatchBody) => unwrap<InterventionOffer>(await patch<unknown>(`/claims/${seg(claimId)}/offers/${seg(offerId)}`, body), 'offer'),

  // evidence
  uploadEvidence: (claimId: Id, file: File | Blob, fields: EvidenceUploadFields) => {
    const fd = new FormData();
    fd.append('file', file, file instanceof File ? file.name : 'upload');
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.append(k, String(v));
    return request<Evidence>(`/claims/${seg(claimId)}/evidence`, { method: 'POST', formData: fd });
  },
  getEvidence: (id: Id, signal?: AbortSignal) => get<Evidence>(`/evidence/${seg(id)}`, undefined, signal),
  evidenceFileUrl: (id: Id) => buildUrl(`/evidence/${seg(id)}/file`),

  // documents
  listTemplates: async (signal?: AbortSignal) => asList<TemplateMeta>(await get<unknown>('/templates', undefined, signal)),
  createDocument: (claimId: Id, body: CreateDocumentBody) => post<GeneratedDocument>(`/claims/${seg(claimId)}/documents`, body),
  getDocument: (id: Id, signal?: AbortSignal) => get<GeneratedDocument>(`/documents/${seg(id)}`, undefined, signal),
  documentPdfUrl: (id: Id) => buildUrl(`/documents/${seg(id)}/pdf`),
  clearFlag: (id: Id, body: { code: string; reason: string; index?: number }) => post<GeneratedDocument>(`/documents/${seg(id)}/clear-flag`, body),
  approveDocument: (id: Id, body: { note?: string } = {}) => post<GeneratedDocument>(`/documents/${seg(id)}/approve`, body),
  sendDocument: (id: Id, body: { via: NonNullable<GeneratedDocument['sentVia']>; to?: string; note?: string }) =>
    post<GeneratedDocument>(`/documents/${seg(id)}/send`, body),
  startSign: (id: Id, body: SignStartBody) => post<SignStartResult>(`/documents/${seg(id)}/sign/start`, body),
  verifySign: (id: Id, body: SignVerifyBody) => post<GeneratedDocument>(`/documents/${seg(id)}/sign/verify`, body),
  /** POST /documents/:id/supersede — new version carrying "re-executed on [date], supersedes version [n]" (lesson b). */
  supersedeDocument: (id: Id, body: SupersedeDocumentBody) => post<GeneratedDocument>(`/documents/${seg(id)}/supersede`, body),

  // engineering
  getEstimate: (claimId: Id, signal?: AbortSignal) => get<Estimate | null>(`/claims/${seg(claimId)}/estimate`, undefined, signal),
  postEstimate: (claimId: Id, body: Partial<Estimate>) => post<Estimate>(`/claims/${seg(claimId)}/estimate`, body),
  importEstimate: async (claimId: Id, body: EstimateImportBody) => unwrap<Estimate>(await post<unknown>(`/claims/${seg(claimId)}/estimate/import`, body), 'estimate'),
  /** GET /engineering/labour-library/suggest?make=&model=&panel=&operation= — medians of CCGUK's own approved estimates. */
  labourSuggest: async (q: { make?: string; model?: string; panel?: string; operation?: string }, signal?: AbortSignal) =>
    asList<LabourSuggestionRow>(await get<unknown>('/engineering/labour-library/suggest', q, signal)),
  getPav: (claimId: Id, signal?: AbortSignal) => get<PavAssessment | null>(`/claims/${seg(claimId)}/pav`, undefined, signal),
  postPav: (claimId: Id, body: PavBody) => post<PavAssessment>(`/claims/${seg(claimId)}/pav`, body),
  addComparable: (claimId: Id, body: Omit<Comparable, 'id'>) => post<PavAssessment>(`/claims/${seg(claimId)}/pav/comparables`, body),
  assessPav: (claimId: Id, body: PavBody = {}) => post<PavAssessment>(`/claims/${seg(claimId)}/pav/assess`, body),
  /** POST /claims/:id/pav/:pid/approve — a person approves the assessment (the API needs ≥3 retained comparables). */
  approvePav: (claimId: Id, pavId: Id) => post<PavAssessment>(`/claims/${seg(claimId)}/pav/${seg(pavId)}/approve`, {}),
  getEngineerReport: (claimId: Id, signal?: AbortSignal) => get<EngineerReport | null>(`/claims/${seg(claimId)}/engineer-report`, undefined, signal),
  postEngineerReport: (claimId: Id, body: Partial<EngineerReport>) => post<EngineerReport>(`/claims/${seg(claimId)}/engineer-report`, body),
  /** PATCH /claims/:id/engineer-report/:rid — edits an unissued report (an issued report is never edited). */
  updateEngineerReport: (claimId: Id, reportId: Id, body: Partial<EngineerReport>) => patch<EngineerReport>(`/claims/${seg(claimId)}/engineer-report/${seg(reportId)}`, body),
  /** POST /claims/:id/engineer-report/:rid/issue → report_issued event, storage/off-hire triggers, report.engineer draft. */
  issueEngineerReport: (claimId: Id, reportId: Id, body: { force?: boolean } = {}) =>
    post<IssueReportResult>(`/claims/${seg(claimId)}/engineer-report/${seg(reportId)}/issue`, body),
  assessTotalLoss: (claimId: Id, body: Record<string, unknown> = {}) => post<TotalLossAssessment>(`/claims/${seg(claimId)}/total-loss/assess`, body),
  predictTotalLoss: (claimId: Id, body: TotalLossPredictionInput) => post<TotalLossPrediction>(`/claims/${seg(claimId)}/total-loss/predict`, body),

  // fleet
  getFleet: async (signal?: AbortSignal) => asList<FleetUnitRow>(await get<unknown>('/fleet', undefined, signal)),
  createFleetUnit: (body: Partial<FleetUnit> & { vehicle?: VehicleInput }) => post<FleetUnitRow>('/fleet', body),
  getFleetAlerts: async (signal?: AbortSignal) => asList<ComplianceAlert>(await get<unknown>('/fleet/alerts', undefined, signal)),
  allocateCheck: (unitId: Id, body: { use: FleetUse; claimId?: Id }) => post<AllocateCheckResult>(`/fleet/${seg(unitId)}/allocate-check`, body),
  getPenalties: async (signal?: AbortSignal) => asList<PenaltyNotice>(await get<unknown>('/fleet/penalties', undefined, signal)),
  createPenalty: (body: Omit<PenaltyNotice, 'id' | 'documentIds' | 'stage'> & { stage?: PenaltyNotice['stage'] }) => post<PenaltyNotice>('/fleet/penalties', body),
  transitionPenalty: (id: Id, body: PenaltyTransitionBody) => post<PenaltyNotice>(`/fleet/penalties/${seg(id)}/transition`, body),

  // directory & knowledge base
  searchDirectory: async (q: string, signal?: AbortSignal) => asList<InsurerDirectoryEntry>(await get<unknown>('/directory', { q }, signal)),
  verifyDirectoryEntry: (id: string, body: { sourceUrl: string; verifiedBy: string; note?: string; field?: string }) =>
    patch<InsurerDirectoryEntry>(`/directory/${seg(id)}/verify`, body),
  reportDirectoryFailed: (id: string, body: { field: string; note?: string; reportedBy?: string }) =>
    post<InsurerDirectoryEntry>(`/directory/${seg(id)}/report-failed`, body),
  kbSearch: async (query: { q: string; type?: KbEntryType; topic?: string; limit?: number }, signal?: AbortSignal) =>
    asList<KbEntry>(await get<unknown>('/kb/search', query, signal)),
  kbAdvise: (topic: string, signal?: AbortSignal) => get<KbAdvice>('/kb/advise', { topic }, signal),
  gtaRates: async (date?: ISODate, signal?: AbortSignal) => asList<GtaRate>(await get<unknown>('/kb/gta-rates', { date }, signal)),

  // monitoring
  getWatch: async (signal?: AbortSignal) => asList<CompanyWatch>(await get<unknown>('/watch', undefined, signal)),
  addWatch: (body: { companyNumber: string; name?: string; role: CompanyWatch['role'] }) => post<CompanyWatch>('/watch', body),
  pollWatch: () => post<WatchPollResult>('/watch/poll', {}),

  // analytics
  analyticsOverview: (signal?: AbortSignal) => get<AnalyticsOverview>('/analytics/overview', undefined, signal),
  analyticsDebtorDays: (signal?: AbortSignal) => get<DebtorDaysSummary>('/analytics/debtor-days', undefined, signal),
  analyticsReductions: (signal?: AbortSignal) => get<ReductionsAnalytics>('/analytics/reductions', undefined, signal),
  analyticsCycleTimes: (signal?: AbortSignal) => get<CycleTimesAnalytics>('/analytics/cycle-times', undefined, signal),
  analyticsInterventions: (signal?: AbortSignal) => get<InterventionsAnalytics>('/analytics/interventions', undefined, signal),

  // settings
  getSettings: (signal?: AbortSignal) => get<Settings>('/settings', undefined, signal),
  updateSettings: (body: Partial<Settings>) => patch<Settings>('/settings', body)
};

export type Api = typeof api;
export type { Verification };

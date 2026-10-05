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
  User,
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
  UserRole,
  Vehicle,
  Verification,
  VehicleSpec,
  VehicleSourceInput,
  OnFileMatch,
  ExternalVehicleLink
} from '@ccguk/domain';

// ---------------------------------------------------------------------------
// Errors and transport
// ---------------------------------------------------------------------------

/**
 * What the server says about an overridable refusal (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.4.3). Present only on
 * class A/B refusals; class C errors never carry it.
 */
export interface OverrideInfo {
  code: string;
  class: 'A' | 'B';
  label: string;
  warning?: string;
  /** The signed-in user may override it in manager mode (admin or approver). */
  allowed: boolean;
  /** Manager mode as the server saw it for this request. */
  managerMode: 'on' | 'off';
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; override?: OverrideInfo };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly url: string;
  /** Parsed from `body.error.override`: the refusal can be overridden in manager mode. */
  readonly override?: OverrideInfo;
  constructor(status: number, code: string, message: string, url: string, details?: unknown, override?: OverrideInfo) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.url = url;
    this.details = details;
    if (override) this.override = override;
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

/** Validate `body.error.override` defensively (an unexpected shape is ignored, never trusted). */
export function parseOverrideInfo(raw: unknown): OverrideInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.code !== 'string' || typeof o.label !== 'string' || typeof o.allowed !== 'boolean') return undefined;
  const info: OverrideInfo = {
    code: o.code,
    class: o.class === 'B' ? 'B' : 'A',
    label: o.label,
    allowed: o.allowed,
    managerMode: o.managerMode === 'on' ? 'on' : 'off',
  };
  if (typeof o.warning === 'string' && o.warning) info.warning = o.warning;
  return info;
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
    return new ApiError(res.status, err.code ?? `HTTP_${res.status}`, err.message, url, err.details, parseOverrideInfo(err.override));
  }
  const message = typeof body === 'string' && body ? body.slice(0, 300) : `${res.status} ${res.statusText || 'request failed'}`;
  return new ApiError(res.status, `HTTP_${res.status}`, message, url, body);
}

// ---------------------------------------------------------------------------
// Session expiry (401)
// ---------------------------------------------------------------------------

/**
 * The public auth routes. A 401 from one of these is an answer ("wrong password", "not signed in"), not an
 * expired session, so it never triggers the sign-in redirect. POST /auth/change-password needs a session, so a
 * 401 from it does redirect like any other route.
 */
export const PUBLIC_AUTH_PATHS = ['/auth/login', '/auth/logout', '/auth/me', '/auth/login-defaults'] as const;

/** True when a 401 from `path` (API path without the /api base, query ignored) should send the user to /login. */
export function redirectsOn401(path: string): boolean {
  const clean = (path.startsWith('/') ? path : `/${path}`).split(/[?#]/)[0]!.replace(/\/+$/, '');
  return !(PUBLIC_AUTH_PATHS as readonly string[]).includes(clean);
}

type UnauthorizedHandler = (error: ApiError) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Register what the app does when any non-auth request comes back 401 (main.tsx sends the user to
 * /login?next=<current path>). The error is still thrown to the caller. Returns a function that unregisters.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

// ---------------------------------------------------------------------------
// Manager mode (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.5.1) — the whole override UX hangs off request()
// ---------------------------------------------------------------------------

/** Request header: URI-encoded reason; present = "override if manager mode is on" (non-GET only). */
export const MANAGER_OVERRIDE_HEADER = 'X-Manager-Override';
/** Request header: URI-encoded comma list of web-only rule keys relaxed in manager mode (max 20). */
export const MANAGER_RELAXED_HEADER = 'X-Manager-Relaxed';
/** Response header: URI-encoded JSON `Array<{ code, label, reason }>` of the overrides a 2xx response applied. */
export const MANAGER_OVERRIDES_RESPONSE_HEADER = 'x-manager-overrides';
const MAX_RELAXED_KEYS = 20;

/** One override the server applied, from the `x-manager-overrides` response header. */
export interface AppliedOverrideNotice {
  code: string;
  label: string;
  reason: string;
}

export type OverrideDecision = { action: 'override'; reason: string } | { action: 'cancel' };

let managerOverrideReason: string | null = null;
const overrideListeners = new Set<(applied: AppliedOverrideNotice[]) => void>();
let overridePromptHandler: ((error: ApiError) => Promise<OverrideDecision>) | null = null;
let managerModeReactivator: (() => Promise<boolean>) | null = null;

/** Non-null = manager mode is on: every non-GET request carries `X-Manager-Override: <reason>`. */
export function setManagerOverrideReason(reason: string | null): void {
  managerOverrideReason = reason === null ? null : reason.trim() || 'Manager override';
}

/** The reason currently sent with mutations, or null when manager mode is off (for tests and the provider). */
export function getManagerOverrideReason(): string | null {
  return managerOverrideReason;
}

/** Listen for the overrides a successful response applied. Returns a function that unsubscribes. */
export function onManagerOverrides(listener: (applied: AppliedOverrideNotice[]) => void): () => void {
  overrideListeners.add(listener);
  return () => {
    overrideListeners.delete(listener);
  };
}

/**
 * Register who asks the user whether to override an overridable refusal (the provider's OverridePrompt). On
 * `override` the handler must have turned manager mode on (setManagerOverrideReason) before it resolves; the request is
 * then re-sent once. Returns a function that unregisters.
 */
export function setOverridePromptHandler(handler: ((error: ApiError) => Promise<OverrideDecision>) | null): () => void {
  overridePromptHandler = handler;
  return () => {
    if (overridePromptHandler === handler) overridePromptHandler = null;
  };
}

/**
 * Register what turns manager mode back on when the client believed it on but the server says it expired. Resolves
 * true when it is on again (the request is then re-sent once). Returns a function that unregisters.
 */
export function setManagerModeReactivator(fn: (() => Promise<boolean>) | null): () => void {
  managerModeReactivator = fn;
  return () => {
    if (managerModeReactivator === fn) managerModeReactivator = null;
  };
}

const RELAXED_KEYS = Symbol('claimdesk.managerRelaxedKeys');

/**
 * Attach web-only relaxed rule keys to a request body (a Symbol property: never serialised, invisible to TS excess
 * checks). Returns a shallow copy; the keys are sent as X-Manager-Relaxed only while manager mode is on.
 */
export function withRelaxed<T extends object>(body: T, keys: readonly string[]): T {
  const copy = (Array.isArray(body) ? [...body] : { ...body }) as T;
  const clean = keys.map((k) => k.trim()).filter(Boolean);
  if (clean.length) Object.defineProperty(copy, RELAXED_KEYS, { value: clean, enumerable: false });
  return copy;
}

/** The relaxed rule keys attached by `withRelaxed` (empty when none). */
export function relaxedKeysOf(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const keys = (body as { [RELAXED_KEYS]?: unknown })[RELAXED_KEYS];
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
}

/** Decode the `x-manager-overrides` response header; a malformed value yields []. */
export function parseAppliedOverrides(header: string | null): AppliedOverrideNotice[] {
  if (!header) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(header));
  } catch {
    try {
      parsed = JSON.parse(header);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: AppliedOverrideNotice[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.code !== 'string') continue;
    out.push({ code: o.code, label: typeof o.label === 'string' && o.label ? o.label : o.code, reason: typeof o.reason === 'string' ? o.reason : '' });
  }
  return out;
}

function notifyOverrides(applied: AppliedOverrideNotice[]): void {
  for (const listener of [...overrideListeners]) {
    try {
      listener(applied);
    } catch (e) {
      console.warn('[ClaimDesk] manager override listener failed', e);
    }
  }
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query);
  const method = opts.method ?? (opts.formData || opts.body !== undefined ? 'POST' : 'GET');
  const relaxed = relaxedKeysOf(opts.body).slice(0, MAX_RELAXED_KEYS);

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
    let body: BodyInit | undefined;
    if (opts.formData) {
      body = opts.formData; // browser sets multipart boundary
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    if (method !== 'GET' && managerOverrideReason !== null) {
      headers[MANAGER_OVERRIDE_HEADER] = encodeURIComponent(managerOverrideReason);
      if (relaxed.length) headers[MANAGER_RELAXED_HEADER] = encodeURIComponent(relaxed.join(','));
    }
    try {
      return await fetch(url, { method, headers, body, signal: opts.signal, credentials: 'same-origin' });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new ApiError(0, 'NETWORK', `Cannot reach the ClaimDesk API (${(e as Error).message})`, url);
    }
  };

  /** The second attempt after an override decision; null when the refusal is not one the user can override now. */
  const retryAfterOverride = async (error: ApiError): Promise<Response | null> => {
    if (method === 'GET' || error.override?.allowed !== true) return null;
    if (managerOverrideReason !== null && error.override.managerMode === 'off' && managerModeReactivator) {
      // The client believed manager mode on but the server let it expire: switch it back on and re-send once.
      let back = false;
      try {
        back = await managerModeReactivator();
      } catch (e) {
        console.warn('[ClaimDesk] manager mode reactivation failed', e);
      }
      return back ? send() : null;
    }
    if (!overridePromptHandler) return null;
    const decision = await overridePromptHandler(error);
    if (decision.action !== 'override') return null;
    if (managerOverrideReason === null) setManagerOverrideReason(decision.reason);
    return send();
  };

  let res = await send();
  if (!res.ok) {
    let error = await parseError(res, url);
    const retried = await retryAfterOverride(error);
    if (retried) {
      res = retried;
      if (!res.ok) error = await parseError(res, url);
    }
    if (!res.ok) {
      if (error.status === 401 && redirectsOn401(path) && unauthorizedHandler) {
        try {
          unauthorizedHandler(error);
        } catch (e) {
          console.warn('[ClaimDesk] unauthorized handler failed', e);
        }
      }
      throw error;
    }
  }
  const applied = parseAppliedOverrides(res.headers.get(MANAGER_OVERRIDES_RESPONSE_HEADER));
  if (applied.length) notifyOverrides(applied);
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

// ---------------------------------------------------------------------------
// Authentication (docs/ARCHITECTURE.md auth contract; cookie session, HttpOnly — the browser never sees the token)
// ---------------------------------------------------------------------------

/** The signed-in user as `GET /auth/me` and `POST /auth/login` return it. */
export interface AuthUser {
  id: Id;
  name: string;
  username: string;
  email: string;
  role: UserRole;
}

/** `GET /auth/me` → 200 `{user}` (401 `UNAUTHENTICATED` without a session). */
export interface MeResponse {
  user: AuthUser;
}

/**
 * `GET /auth/login-defaults` → what the sign-in screen pre-fills. `password` is present only while LOGIN_PREFILL is
 * on and the default account still has its default password (the pre-fill stops once the owner changes it).
 */
export interface LoginDefaults {
  username: string;
  password?: string;
  prefill: boolean;
}

export interface LoginBody {
  username: string;
  password: string;
}

/** `POST /auth/login` → 200 `{user}` and the `claimdesk_session` cookie. */
export interface LoginResult {
  user: AuthUser;
}

/** `POST /auth/change-password` → 204; every other session of the user is signed out. */
export interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

/** GET /health (apps/api routes/health.ts). */
export interface Health {
  ok: boolean;
  service?: string;
  version?: string;
  /** 'demo' only when the desktop launcher started the example-claims dataset. */
  dataset?: 'live' | 'demo';
  pid?: number;
  time?: ISODateTime;
  env?: string;
  database?: 'ok' | 'error';
  /** Key-presence flags plus the derived lookup mode ('manual' when no DVLA/DVSA key is configured). */
  lookups?: { dvlaVes?: boolean; dvsaMot?: boolean; companiesHouse?: boolean; gateway?: boolean; mode?: LookupMode };
  kbData?: boolean;
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
  // --- docs/TEMPLATES-VEHICLES-DESKTOP.md §D.10, §E.4 (vehicles-web) ---
  bodyType?: string;
  monthOfFirstRegistration?: string;
  co2Gkm?: number;
  euroStatus?: string;
  taxStatus?: string;
  motStatus?: string;
  gtaGroup?: string;
  /** Catalogue pick, segment, doors/seats, power, features and extras (unverified reference data). */
  spec?: VehicleSpec;
  /** Who/what supplied the values; the server records an unverified LookupRecord with this provider. */
  source?: VehicleSourceInput;
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
  // --- intake questions (@ccguk/domain validateFnol, run by the API) ---
  /** The handler confirms the account was taken cold (open questions, verbatim). Never sent as `false`. */
  takenCold?: true;
  /** "Has anyone offered you a vehicle?" — the script-guard question, always answered. */
  offerDisclosed?: boolean;
  offerDetails?: { what?: string; byWhom?: string; when?: string };
  // --- descriptive web fields the API folds in (apps/api services/intake.ts normaliseFnol) ---
  channel?: 'phone' | 'whatsapp' | 'web_form' | 'in_person' | 'email';
  /** `acknowledged: false` only when a manager opened the claim without the disclosure (it is then flagged). */
  disclosure?: { callRecordingReadAt?: ISODateTime; acknowledged: boolean; acknowledgedBy?: string };
  /** `[]` = the witnesses question was asked and there were none. The API creates the witness parties (role `witness`). */
  witnesses?: WitnessInput[];
  /** Only `registrationUnknown` is sent here (the other third-party facts go in the native fields, or they would be duplicated). */
  thirdParty?: { registrationUnknown?: boolean };
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
export interface FnolIssueView {
  field: string;
  message: string;
}
export interface IntakeReport {
  validation?: { ok: boolean; missing: string[]; errors?: FnolIssueView[]; incomplete?: FnolIssueView[]; warnings?: string[] };
  crossFile?: { severity?: string; message?: string; duplicateClaimIds?: Id[]; isFleetUnit?: boolean };
  liability?: { score: number; reasons: string[]; band?: string };
  injury?: { referredTo: string; message: string; feeTaken: false };
  offer?: { id: Id; replyDueBy: string };
  witnesses?: Array<{ partyId: Id; name: string; independent: boolean; reasons: string[] }>;
  flags?: ClaimFlag[];
}

/** Lines for a 400 from POST /claims: the API answers `{ missing, errors, incomplete, warnings }` in `details`. */
export function fnolErrorLines(e: unknown): string[] {
  if (!isApiError(e) || !e.details || typeof e.details !== 'object') return [];
  const d = e.details as { errors?: FnolIssueView[]; missing?: string[] };
  if (Array.isArray(d.errors) && d.errors.length) return d.errors.map((i) => `${i.field}: ${i.message}`);
  if (Array.isArray(d.missing) && d.missing.length) return d.missing;
  return [];
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

/** 'live' when a DVLA VES or DVSA MOT key is set, else 'manual' (docs/TEMPLATES-VEHICLES-DESKTOP.md §E). */
export type LookupMode = 'live' | 'manual';

/** Fields both lookup branches carry since §E.1 (absent on older API builds). */
export interface LookupSearchFields {
  /** What ClaimDesk already holds for the registration (exact first, then partial matches). */
  onFile?: OnFileMatch[];
  /** Links the handler opens in their own browser (Total Car Check, GOV.UK); ClaimDesk never requests them. */
  externalLinks?: ExternalVehicleLink[];
  lookupMode?: LookupMode;
}

/** POST /vehicles/lookup. `status:'manual_required'` when no keys are configured or the services failed. */
export type VehicleLookupResult =
  | ({
      status: 'ok';
      registration: string;
      vehicle: Partial<Vehicle> & { registration: string };
      ves?: LookupRecord;
      mot?: LookupRecord;
      motHistory?: Vehicle['motHistory'];
      linkedClaims?: LinkedClaimRef[];
      fleetUnit?: { id: Id; registration: string; status?: FleetUnit['status'] } | null;
      warnings?: string[];
    } & LookupSearchFields)
  | ({
      status: 'manual_required';
      registration: string;
      reason?: string;
      partial?: Partial<Vehicle>;
      linkedClaims?: LinkedClaimRef[];
      fleetUnit?: { id: Id; registration: string; status?: FleetUnit['status'] } | null;
      warnings?: string[];
    } & LookupSearchFields);

/** The API's own reply shape (apps/api services/lookup.ts `VehicleLookupResponse`). */
export type ApiLookupResponse =
  | ({ status: 'manual_required'; registration: string; fields?: readonly string[]; providers?: Record<string, string>; vehicle?: Vehicle; reason?: string } & LookupSearchFields)
  | ({ status: 'ok' | 'partial'; registration: string; vehicle: Vehicle; providers?: Record<string, string>; lookupIds?: Id[] } & LookupSearchFields);

/** The §E.1 search fields of an API reply, only those present (so older replies normalise exactly as before). */
function searchFieldsOf(r: LookupSearchFields): LookupSearchFields {
  const out: LookupSearchFields = {};
  if (Array.isArray(r.onFile)) out.onFile = r.onFile;
  if (Array.isArray(r.externalLinks)) out.externalLinks = r.externalLinks;
  if (r.lookupMode === 'live' || r.lookupMode === 'manual') out.lookupMode = r.lookupMode;
  return out;
}

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
  const search = searchFieldsOf(r);
  if (r.status === 'manual_required') {
    const reason = (r as { reason?: string }).reason ?? (warnings.length ? warnings.join('; ') : 'The lookup services did not return this registration.');
    return { status: 'manual_required', registration: r.registration || registration, reason, partial: vehicle, linkedClaims, fleetUnit, warnings, ...search };
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
    warnings: r.status === 'partial' ? ['Partial lookup — one provider did not answer.', ...warnings] : warnings,
    ...search
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

/** Which program made a document's PDF (docs/TEMPLATES-VEHICLES-DESKTOP.md §C.3); the domain type's union. */
export type PdfConverterId = NonNullable<GeneratedDocument['pdfConverter']>;

/** Document fields added for Word (.docx) documents (§C.3), taken from the domain record; absent = 'html'. */
export type DocumentFormatFields = Pick<GeneratedDocument, 'format' | 'docxSha256' | 'pdfConverter'>;

/** A generated document as the web reads it: the domain record plus the DOCX format fields. */
export type ClaimDocument = GeneratedDocument & DocumentFormatFields;

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
  /** The packaged desktop app has no email/SMS sender: the code to pass to the signer. */
  handlerCode?: string;
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

/** What the fleet GTA panel suggested (§F.1); the API keeps it in the LookupRecord raw for provenance. */
export interface FleetGtaSuggestionInput {
  group: string | null;
  basis: string;
  rateGroup?: string | null;
  ratePeriod?: string | null;
}

/**
 * POST /fleet (and PATCH /fleet/:id) body as the web sends it (§F.1, §F.2). `gtaGroup` and `dailyRatePence` are
 * optional: when omitted the API uses its GTA suggestion (or answers 422 GTA_SUGGESTION_UNAVAILABLE).
 */
export type FleetUnitWriteBody = Omit<Partial<FleetUnit>, 'gtaGroup' | 'dailyRatePence'> & {
  vehicle?: VehicleInput;
  gtaGroup?: string;
  /** POST only: the group was left as "no group yet" — save UNGROUPED (manager mode), never a guessed group. */
  gtaGroupUnknown?: boolean;
  dailyRatePence?: Pence;
  gtaSuggestion?: FleetGtaSuggestionInput;
};

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
  /** Manager mode switches itself off after this many minutes without activity (1–480, default 60; 0.3 §A.4.1). */
  managerModeIdleMinutes?: number;
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

  // auth (public: login-defaults, login, logout, me; change-password needs a session)
  loginDefaults: (signal?: AbortSignal) => get<LoginDefaults>('/auth/login-defaults', undefined, signal),
  login: (body: LoginBody) => post<LoginResult>('/auth/login', body),
  logout: () => post<void>('/auth/logout', {}),
  me: (signal?: AbortSignal) => get<MeResponse>('/auth/me', undefined, signal),
  changePassword: (body: ChangePasswordBody) => post<void>('/auth/change-password', body),

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
  createFleetUnit: (body: FleetUnitWriteBody) => post<FleetUnitRow>('/fleet', body),
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
  getUsers: async (signal?: AbortSignal) => asList<User>(await get<unknown>('/users', undefined, signal)),
  updateSettings: (body: Partial<Settings>) => patch<Settings>('/settings', body)
};

export type Api = typeof api;
export type { Verification };

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

export interface CreateClaimBody {
  /** Channel the FNOL came through. */
  channel: 'phone' | 'whatsapp' | 'web_form' | 'in_person' | 'email';
  /** Call-recording disclosure (BLUEPRINT §3.1): read and acknowledged before any detail is taken. */
  disclosure: { callRecordingReadAt: ISODateTime; acknowledged: true; acknowledgedBy?: string };
  claimant: PartyInput;
  driver?: PartyInput; // omitted when the claimant drove
  vehicle: VehicleInput;
  accident: Claim['accident'];
  thirdParty?: {
    registration?: string;
    driverName?: string;
    insurerName?: string;
    insurerId?: Id;
    insurerPolicyNumber?: string;
    contact?: string;
  };
  witnesses: WitnessInput[];
  clientInsurer?: { name?: string; policyNumber?: string };
  /** Injury → referral out, no fee (lesson j). */
  injury?: { reported: boolean; referralTo?: string; notes?: string };
  services: { hire: boolean; recovery: boolean; storage: boolean; engineer: boolean; notes?: string };
  handlerId?: Id;
  gtaSubscriber?: false;
}

export type InterventionOfferInput = Omit<InterventionOffer, 'id' | 'claimId' | 'evidenceIds'> & { evidenceIds?: Id[] };

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

export interface Settings {
  registeredOffice?: string;
  companyNumber?: string;
  vatNumber?: string;
  icoRegistration?: string;
  bank?: { accountName: string; sortCode: string; accountNumber: string; bankName?: string };
  rateCard?: {
    recoveryCalloutPence: Pence;
    recoveryPerLoadedMilePence: Pence;
    recoveryAdminPence: Pence;
    storageDailyPence: Pence;
    engineerFeePence: Pence;
    vatRate: number;
  };
  apiKeys?: { dvlaVes: boolean; dvsaMot: boolean; companiesHouse: boolean; gateway: boolean; anthropic?: boolean };
  [key: string]: unknown;
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
  createClaim: (body: CreateClaimBody) => post<Claim>('/claims', body),
  updateClaim: (id: Id, body: Partial<Claim> & { flags?: ClaimFlag[] }) => patch<Claim>(`/claims/${seg(id)}`, body),
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
  lookupVehicle: async (registration: string): Promise<VehicleLookupResult> => {
    try {
      return await post<VehicleLookupResult>('/vehicles/lookup', { registration });
    } catch (e) {
      // Some API builds signal manual entry with an error code rather than a 200 body; normalise both.
      if (isApiError(e) && /manual_required/i.test(e.code)) {
        return { status: 'manual_required', registration, reason: e.message };
      }
      throw e;
    }
  },
  addOdometer: (vehicleId: Id, body: Vehicle['odometer'][number]) => post<Vehicle>(`/vehicles/${seg(vehicleId)}/odometer`, body),
  getMileageConflicts: (vehicleId: Id, signal?: AbortSignal) => get<unknown>(`/vehicles/${seg(vehicleId)}/mileage-conflicts`, undefined, signal),

  // ledger & events
  getLedger: async (claimId: Id, signal?: AbortSignal) => asList<LedgerEntry>(await get<unknown>(`/claims/${seg(claimId)}/ledger`, undefined, signal)),
  postLedger: (claimId: Id, body: CreateLedgerBody) => post<LedgerEntry>(`/claims/${seg(claimId)}/ledger`, body),
  getEvents: async (claimId: Id, signal?: AbortSignal) => asList<ClaimEvent>(await get<unknown>(`/claims/${seg(claimId)}/events`, undefined, signal)),
  postEvent: (claimId: Id, body: CreateEventBody) => post<ClaimEvent>(`/claims/${seg(claimId)}/events`, body),

  // hire / storage / recovery
  getHire: async (claimId: Id, signal?: AbortSignal) => asList<HireAgreement>(await get<unknown>(`/claims/${seg(claimId)}/hire`, undefined, signal)),
  postHire: (claimId: Id, body: Partial<HireAgreement>) => post<HireAgreement>(`/claims/${seg(claimId)}/hire`, body),
  endHire: (claimId: Id, hireId: Id, body: { endAt: ISODateTime; endTrigger: HireAgreement['endTrigger']; odometerIn?: number; collectedAt?: ISODateTime }) =>
    post<HireAgreement>(`/claims/${seg(claimId)}/hire/${seg(hireId)}/end`, body),
  getStorage: async (claimId: Id, signal?: AbortSignal) => asList<StorageRecord>(await get<unknown>(`/claims/${seg(claimId)}/storage`, undefined, signal)),
  postStorage: (claimId: Id, body: Partial<StorageRecord>) => post<StorageRecord>(`/claims/${seg(claimId)}/storage`, body),
  endStorage: (claimId: Id, storageId: Id, body: { endAt: ISODateTime; endTrigger: StorageRecord['endTrigger'] }) =>
    post<StorageRecord>(`/claims/${seg(claimId)}/storage/${seg(storageId)}/end`, body),
  getRecovery: async (claimId: Id, signal?: AbortSignal) => asList<RecoveryRecord>(await get<unknown>(`/claims/${seg(claimId)}/recovery`, undefined, signal)),
  postRecovery: (claimId: Id, body: Partial<RecoveryRecord>) => post<RecoveryRecord>(`/claims/${seg(claimId)}/recovery`, body),

  // intervention register
  getOffers: async (claimId: Id, signal?: AbortSignal) => asList<InterventionOffer>(await get<unknown>(`/claims/${seg(claimId)}/offers`, undefined, signal)),
  postOffer: (claimId: Id, body: InterventionOfferInput) => post<InterventionOffer>(`/claims/${seg(claimId)}/offers`, body),
  updateOffer: (claimId: Id, offerId: Id, body: Partial<InterventionOffer>) => patch<InterventionOffer>(`/claims/${seg(claimId)}/offers/${seg(offerId)}`, body),

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

  // engineering
  getEstimate: (claimId: Id, signal?: AbortSignal) => get<Estimate | null>(`/claims/${seg(claimId)}/estimate`, undefined, signal),
  postEstimate: (claimId: Id, body: Partial<Estimate>) => post<Estimate>(`/claims/${seg(claimId)}/estimate`, body),
  importEstimate: (claimId: Id, body: EstimateImportBody) => post<Estimate>(`/claims/${seg(claimId)}/estimate/import`, body),
  getPav: (claimId: Id, signal?: AbortSignal) => get<PavAssessment | null>(`/claims/${seg(claimId)}/pav`, undefined, signal),
  postPav: (claimId: Id, body: Partial<PavAssessment>) => post<PavAssessment>(`/claims/${seg(claimId)}/pav`, body),
  addComparable: (claimId: Id, body: Omit<Comparable, 'id'>) => post<PavAssessment>(`/claims/${seg(claimId)}/pav/comparables`, body),
  assessPav: (claimId: Id, body: Record<string, unknown> = {}) => post<PavAssessment>(`/claims/${seg(claimId)}/pav/assess`, body),
  getEngineerReport: (claimId: Id, signal?: AbortSignal) => get<EngineerReport | null>(`/claims/${seg(claimId)}/engineer-report`, undefined, signal),
  postEngineerReport: (claimId: Id, body: Partial<EngineerReport>) => post<EngineerReport>(`/claims/${seg(claimId)}/engineer-report`, body),
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

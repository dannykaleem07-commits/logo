/**
 * Vehicle and company lookups (BLUEPRINT §3.2, ARCHITECTURE convention 10: documented APIs only, never scraping).
 *
 *  - DVLA Vehicle Enquiry Service: POST /vehicle-enquiry/v1/vehicles  (x-api-key)
 *  - DVSA MOT History API v1:      OAuth2 client-credentials token, then GET /v1/trade/vehicles/registration/{reg}
 *                                  (Authorization: Bearer + X-API-Key)
 *  - Companies House:              GET /company/{number}  (basic auth, key as username)
 *
 * Every client returns `{ok:true, data}` or `{ok:false, reason}` and never throws into a route. A token bucket
 * (per provider) and a hard timeout guard the outbound calls. Live responses are stored as LookupRecords with
 * verification 'verified' (the provider is the source); manual entries are 'unverified' until a document backs them.
 */
import {
  dvlaVesExtras,
  externalVehicleLinks,
  mapDvlaVes,
  mapDvsaMotHistory,
  normaliseRegistration,
  type DvlaVesPayload,
  type DvsaMotVehicle,
  type ExternalVehicleLink,
  type Id,
  type ISODateTime,
  type LookupRecord,
  type OdometerReading,
  type OnFileMatch,
  type Vehicle,
  type VehicleSourceInput,
} from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { ApiKeys } from '../config.js';
import type { AppContext } from '../context.js';
import { onFileMatches } from './vehicleSearch.js';

export type LookupFailure = 'no_key' | `http_${number}` | 'network' | 'rate_limited' | 'invalid_payload';
export type LookupResult<T> = { ok: true; data: T; status: number } | { ok: false; reason: LookupFailure; message?: string };

export const DVLA_VES_URL = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
export const DVSA_MOT_URL = 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/';
export const COMPANIES_HOUSE_URL = 'https://api.company-information.service.gov.uk/company/';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Simple token bucket: `capacity` calls, refilled at `refillPerSecond`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.tokens = capacity;
    this.last = clock();
  }
  take(): boolean {
    const now = this.clock();
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface LookupClientOptions {
  keys: ApiKeys;
  timeoutMs?: number;
  fetch?: FetchLike;
  /** Per-provider bucket; default 10 calls burst, 1/s refill. */
  buckets?: Partial<Record<'dvla_ves' | 'dvsa_mot' | 'companies_house', TokenBucket>>;
}

export interface CompaniesHouseCompany {
  company_number?: string;
  company_name?: string;
  company_status?: string;
  company_status_detail?: string;
  date_of_creation?: string;
  registered_office_address?: Record<string, unknown>;
  accounts?: { overdue?: boolean; next_due?: string; [k: string]: unknown };
  confirmation_statement?: { overdue?: boolean; next_due?: string; [k: string]: unknown };
  has_insolvency_history?: boolean;
  has_charges?: boolean;
  [k: string]: unknown;
}

export interface LookupClients {
  dvlaVes(registration: string): Promise<LookupResult<DvlaVesPayload>>;
  dvsaMot(registration: string): Promise<LookupResult<DvsaMotVehicle | DvsaMotVehicle[]>>;
  companiesHouse(companyNumber: string): Promise<LookupResult<CompaniesHouseCompany>>;
  presence(): { dvlaVes: boolean; dvsaMot: boolean; companiesHouse: boolean };
}

async function request<T>(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<LookupResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      let message: string | undefined;
      try {
        message = (await res.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      return { ok: false, reason: `http_${res.status}`, message };
    }
    try {
      const data = (await res.json()) as T;
      return { ok: true, data, status: res.status };
    } catch {
      return { ok: false, reason: 'invalid_payload' };
    }
  } catch (err) {
    return { ok: false, reason: 'network', message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function createLookupClients(opts: LookupClientOptions): LookupClients {
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const buckets = {
    dvla_ves: opts.buckets?.dvla_ves ?? new TokenBucket(10, 1),
    dvsa_mot: opts.buckets?.dvsa_mot ?? new TokenBucket(10, 1),
    companies_house: opts.buckets?.companies_house ?? new TokenBucket(10, 1),
  };
  const keys = opts.keys;
  let motToken: { value: string; expiresAt: number } | undefined;

  const motHasKeys = () => Boolean(keys.dvsaMotClientId && keys.dvsaMotClientSecret && keys.dvsaMotApiKey && keys.dvsaMotTokenUrl);

  async function motBearer(): Promise<LookupResult<string>> {
    if (motToken && motToken.expiresAt > Date.now() + 30_000) return { ok: true, data: motToken.value, status: 200 };
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: keys.dvsaMotClientId!,
      client_secret: keys.dvsaMotClientSecret!,
      scope: keys.dvsaMotScopeUrl ?? 'https://tapi.dvsa.gov.uk/.default',
    });
    const r = await request<{ access_token?: string; expires_in?: number }>(
      fetchImpl,
      keys.dvsaMotTokenUrl!,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      timeoutMs,
    );
    if (!r.ok) return r;
    if (!r.data.access_token) return { ok: false, reason: 'invalid_payload', message: 'token response had no access_token' };
    motToken = { value: r.data.access_token, expiresAt: Date.now() + (r.data.expires_in ?? 3600) * 1000 };
    return { ok: true, data: motToken.value, status: 200 };
  }

  return {
    presence: () => ({ dvlaVes: Boolean(keys.dvlaVesApiKey), dvsaMot: motHasKeys(), companiesHouse: Boolean(keys.companiesHouseApiKey) }),
    async dvlaVes(registration) {
      if (!keys.dvlaVesApiKey) return { ok: false, reason: 'no_key' };
      if (!buckets.dvla_ves.take()) return { ok: false, reason: 'rate_limited' };
      return request<DvlaVesPayload>(
        fetchImpl,
        DVLA_VES_URL,
        {
          method: 'POST',
          headers: { 'x-api-key': keys.dvlaVesApiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ registrationNumber: normaliseRegistration(registration) }),
        },
        timeoutMs,
      );
    },
    async dvsaMot(registration) {
      if (!motHasKeys()) return { ok: false, reason: 'no_key' };
      if (!buckets.dvsa_mot.take()) return { ok: false, reason: 'rate_limited' };
      const token = await motBearer();
      if (!token.ok) return token;
      return request<DvsaMotVehicle | DvsaMotVehicle[]>(
        fetchImpl,
        `${DVSA_MOT_URL}${encodeURIComponent(normaliseRegistration(registration))}`,
        { method: 'GET', headers: { authorization: `Bearer ${token.data}`, 'x-api-key': keys.dvsaMotApiKey!, accept: 'application/json' } },
        timeoutMs,
      );
    },
    async companiesHouse(companyNumber) {
      if (!keys.companiesHouseApiKey) return { ok: false, reason: 'no_key' };
      if (!buckets.companies_house.take()) return { ok: false, reason: 'rate_limited' };
      const number = companyNumber.trim().toUpperCase().padStart(8, '0');
      const auth = Buffer.from(`${keys.companiesHouseApiKey}:`).toString('base64');
      return request<CompaniesHouseCompany>(fetchImpl, `${COMPANIES_HOUSE_URL}${encodeURIComponent(number)}`, { method: 'GET', headers: { authorization: `Basic ${auth}`, accept: 'application/json' } }, timeoutMs);
    },
  };
}

// ---------------------------------------------------------------------------
// Payload → vehicle mapping (pure; unit-tested with fixtures)
// ---------------------------------------------------------------------------

export interface VehicleUpsertFromLookups {
  registration: string;
  fields: Partial<Vehicle>;
  odometer: OdometerReading[];
  lookups: Array<Omit<LookupRecord, 'id'>>;
  extras: Record<string, unknown>;
}

export const MANUAL_FIELDS = ['registration', 'make', 'model', 'yearOfManufacture', 'fuelType', 'transmission', 'colour', 'engineCapacityCc', 'motExpiryDate', 'taxDueDate', 'vin', 'odometer'] as const;

/** Pure: fold provider payloads into vehicle fields plus LookupRecords. `verified` marks live provider responses. */
export function mapLookupsToVehicle(
  registration: string,
  payloads: { ves?: DvlaVesPayload; mot?: DvsaMotVehicle | DvsaMotVehicle[] },
  meta: { requestedAt: ISODateTime; requestedBy: Id },
): VehicleUpsertFromLookups {
  const reg = normaliseRegistration(registration);
  const fields: Partial<Vehicle> = {};
  const odometer: OdometerReading[] = [];
  const lookups: Array<Omit<LookupRecord, 'id'>> = [];
  const extras: Record<string, unknown> = {};
  const verification = (provider: string): LookupRecord['verification'] => ({
    status: 'verified',
    sourceNote: `Live ${provider} response received ${meta.requestedAt}`,
    verifiedAt: meta.requestedAt.slice(0, 10),
    verifiedBy: meta.requestedBy,
  });
  if (payloads.ves) {
    Object.assign(fields, mapDvlaVes(payloads.ves));
    Object.assign(extras, { ves: dvlaVesExtras(payloads.ves) });
    lookups.push({ provider: 'dvla_ves', kind: 'vehicle', requestedAt: meta.requestedAt, requestedBy: meta.requestedBy, registration: reg, raw: payloads.ves, verification: verification('DVLA VES') });
  }
  if (payloads.mot) {
    const mapped = mapDvsaMotHistory(payloads.mot);
    if (mapped.make && !fields.make) fields.make = mapped.make;
    if (mapped.model) fields.model = mapped.model;
    fields.motHistory = mapped.motHistory;
    odometer.push(...mapped.odometer);
    lookups.push({ provider: 'dvsa_mot', kind: 'mot', requestedAt: meta.requestedAt, requestedBy: meta.requestedBy, registration: reg, raw: payloads.mot, verification: verification('DVSA MOT History') });
  }
  fields.registration = reg;
  return { registration: reg, fields, odometer, lookups, extras };
}

/** A manual entry LookupRecord (verification 'unverified' until a document backs it). */
export function manualLookupRecord(raw: unknown, registration: string, meta: { requestedAt: ISODateTime; requestedBy: Id }): Omit<LookupRecord, 'id'> {
  return {
    provider: 'manual',
    kind: 'vehicle',
    requestedAt: meta.requestedAt,
    requestedBy: meta.requestedBy,
    registration: normaliseRegistration(registration),
    raw,
    verification: { status: 'unverified', sourceNote: 'Keyed in manually; back it with the V5C / MOT certificate before relying on it' },
  };
}

// ---------------------------------------------------------------------------
// Hand-entered details with provenance (TEMPLATES-VEHICLES-DESKTOP §E.4)
// ---------------------------------------------------------------------------

export const PASTED_TEXT_LIMIT = 20_000;
export const TOTAL_CAR_CHECK_SOURCE_NOTE = 'Copied by hand from Total Car Check (free check). Not verified — back it with the V5C or MOT certificate.';
export const CATALOGUE_SOURCE_NOTE = 'Chosen from the ClaimDesk vehicle catalogue (unverified reference data).';
export const MANUAL_SOURCE_NOTE = 'Keyed in manually; back it with the V5C / MOT certificate before relying on it';

/**
 * The LookupRecord for values a person supplied (typed, picked from the catalogue or pasted from Total Car Check).
 * Always `unverified`; the client never sends a verification.
 */
export function sourceLookupRecord(source: VehicleSourceInput, registration: string, meta: { requestedAt: ISODateTime; requestedBy: Id }): Omit<LookupRecord, 'id'> {
  const raw: Record<string, unknown> = { source: source.provider === 'totalcarcheck_manual' ? 'totalcarcheck_paste' : source.provider };
  if (source.url) raw.url = source.url;
  if (source.pastedText) raw.pastedText = source.pastedText.slice(0, PASTED_TEXT_LIMIT);
  if (source.parsed) raw.parsed = source.parsed;
  if (source.appliedFields) raw.appliedFields = source.appliedFields;
  const sourceNote = source.provider === 'totalcarcheck_manual' ? TOTAL_CAR_CHECK_SOURCE_NOTE : source.provider === 'catalogue' ? CATALOGUE_SOURCE_NOTE : MANUAL_SOURCE_NOTE;
  const verification: LookupRecord['verification'] = { status: 'unverified', sourceNote };
  if (source.url) verification.sourceUrl = source.url;
  return {
    provider: source.provider,
    kind: source.provider === 'catalogue' ? 'spec' : 'vehicle',
    requestedAt: meta.requestedAt,
    requestedBy: meta.requestedBy,
    registration: normaliseRegistration(registration),
    raw,
    verification,
  };
}

/** Fields compared with the latest verified DVLA/DVSA lookup (§E.4 DIFFERS_FROM_VERIFIED). */
const VERIFIED_COMPARE_FIELDS = ['make', 'model', 'colour', 'fuelType', 'yearOfManufacture', 'monthOfFirstRegistration', 'engineCapacityCc', 'co2Gkm', 'euroStatus', 'taxStatus', 'taxDueDate', 'motStatus', 'motExpiryDate'] as const;
type VerifiedField = (typeof VERIFIED_COMPARE_FIELDS)[number];

/** Values from the vehicle's verified live lookups (latest per provider; DVLA wins over DVSA for shared fields). */
export function verifiedLookupValues(vehicle: Pick<Vehicle, 'lookups'>): Partial<Record<VerifiedField, string | number>> {
  const latest = (provider: LookupRecord['provider']) =>
    vehicle.lookups.filter((l) => l.provider === provider && l.verification.status === 'verified').sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  const out: Partial<Record<VerifiedField, string | number>> = {};
  const take = (fields: Partial<Vehicle>) => {
    for (const f of VERIFIED_COMPARE_FIELDS) {
      const v = fields[f];
      if ((typeof v === 'string' && v.trim()) || typeof v === 'number') if (out[f] === undefined) out[f] = v as string | number;
    }
  };
  const ves = latest('dvla_ves');
  if (ves) {
    try {
      take(mapDvlaVes(ves.raw as DvlaVesPayload));
    } catch {
      /* unreadable payload: nothing to compare */
    }
  }
  const mot = latest('dvsa_mot');
  if (mot) {
    try {
      const m = mapDvsaMotHistory(mot.raw as DvsaMotVehicle | DvsaMotVehicle[]);
      take({ make: m.make, model: m.model });
    } catch {
      /* unreadable payload */
    }
  }
  return out;
}

export interface DiffersFromVerifiedWarning {
  code: 'DIFFERS_FROM_VERIFIED';
  field: string;
  verifiedValue: string | number;
}

const sameValue = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' ? a.trim().toLowerCase() === b.trim().toLowerCase() : a === b;

/** Hand-entered values that differ from a verified DVLA/DVSA value (saved anyway — handler intent — and reported). */
export function differsFromVerified(vehicle: Pick<Vehicle, 'lookups'>, values: Record<string, unknown>): DiffersFromVerifiedWarning[] {
  const verified = verifiedLookupValues(vehicle);
  const out: DiffersFromVerifiedWarning[] = [];
  for (const f of VERIFIED_COMPARE_FIELDS) {
    const mine = values[f];
    const theirs = verified[f];
    if (mine === undefined || mine === null || theirs === undefined) continue;
    if (!sameValue(mine, theirs)) out.push({ code: 'DIFFERS_FROM_VERIFIED', field: f, verifiedValue: theirs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration (route-facing)
// ---------------------------------------------------------------------------

export type LookupMode = 'live' | 'manual';

/**
 * Both branches carry `lookupMode`, the on-file matches and the external links (§E.1). `lookupMode` on
 * `manual_required` is 'manual' when no DVLA/DVSA key is configured; it reads 'live' when keys exist but both calls
 * failed (the providers map says why).
 */
export type VehicleLookupResponse =
  | { status: 'manual_required'; lookupMode: LookupMode; registration: string; fields: readonly string[]; providers: Record<string, LookupFailure>; vehicle?: Vehicle; onFile: OnFileMatch[]; externalLinks: ExternalVehicleLink[] }
  | { status: 'ok' | 'partial'; lookupMode: 'live'; registration: string; vehicle: Vehicle; providers: Record<string, 'ok' | LookupFailure>; lookupIds: Id[]; onFile: OnFileMatch[]; externalLinks: ExternalVehicleLink[] };

/** 'live' when a DVLA VES or DVSA MOT key is configured, else 'manual'. */
export function lookupModeFor(ctx: AppContext): LookupMode {
  return ctx.config.keysPresent.dvlaVes || ctx.config.keysPresent.dvsaMot ? 'live' : 'manual';
}

export async function lookupVehicle(
  ctx: AppContext,
  clients: LookupClients,
  input: { registration: string; ownership?: Vehicle['ownership']; providers?: Array<'dvla_ves' | 'dvsa_mot'> },
  actor: Actor,
): Promise<VehicleLookupResponse> {
  const reg = normaliseRegistration(input.registration);
  const wanted = new Set(input.providers ?? ['dvla_ves', 'dvsa_mot']);
  const existing = ctx.repos.findByRegistration(ctx.db, reg);
  const requestedAt = ctx.now();
  const [ves, mot] = await Promise.all([
    wanted.has('dvla_ves') ? clients.dvlaVes(reg) : Promise.resolve<LookupResult<DvlaVesPayload>>({ ok: false, reason: 'no_key' }),
    wanted.has('dvsa_mot') ? clients.dvsaMot(reg) : Promise.resolve<LookupResult<DvsaMotVehicle | DvsaMotVehicle[]>>({ ok: false, reason: 'no_key' }),
  ]);
  const providers: Record<string, 'ok' | LookupFailure> = { dvla_ves: ves.ok ? 'ok' : ves.reason, dvsa_mot: mot.ok ? 'ok' : mot.reason };
  const externalLinks = externalVehicleLinks(reg, { totalCarCheckTemplate: ctx.config.totalCarCheckUrlTemplate });
  if (!ves.ok && !mot.ok) {
    ctx.logger.info('vehicle lookup: manual entry required', { registration: reg, providers });
    // Read-only: nothing is written when no provider answered (no LookupRecord, no audit row).
    return { status: 'manual_required', lookupMode: lookupModeFor(ctx), registration: reg, fields: MANUAL_FIELDS, providers: providers as Record<string, LookupFailure>, vehicle: existing, onFile: onFileMatches(ctx, reg, 10), externalLinks };
  }
  const mapped = mapLookupsToVehicle(reg, { ves: ves.ok ? ves.data : undefined, mot: mot.ok ? mot.data : undefined }, { requestedAt, requestedBy: actor.userId });
  const vehicle = ctx.db.transaction((tx) => {
    const v = ctx.repos.upsertVehicle(tx, {
      ...(existing ?? {}),
      ...mapped.fields,
      registration: reg,
      make: mapped.fields.make ?? existing?.make ?? 'UNKNOWN',
      model: mapped.fields.model ?? existing?.model ?? 'UNKNOWN',
      ownership: input.ownership ?? existing?.ownership ?? 'client',
      odometer: mapped.odometer,
      lookups: mapped.lookups.map((l) => ({ ...l, id: ctx.repos.newId() })),
    });
    ctx.repos.appendAudit(tx, {
      actor,
      action: existing ? 'vehicle.lookup.update' : 'vehicle.lookup.create',
      entity: 'vehicles',
      entityId: v.id,
      after: { registration: reg, providers, extras: mapped.extras },
      at: requestedAt,
    });
    return v;
  });
  const lookupIds = vehicle.lookups.filter((l) => l.requestedAt === requestedAt).map((l) => l.id);
  return { status: ves.ok && mot.ok ? 'ok' : 'partial', lookupMode: 'live', registration: reg, vehicle, providers, lookupIds, onFile: onFileMatches(ctx, reg, 10), externalLinks };
}

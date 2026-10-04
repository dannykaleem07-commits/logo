/**
 * Vehicle catalogue, manual vehicle search, GTA suggestion and GTA benchmark-rate settings
 * (docs/TEMPLATES-VEHICLES-DESKTOP.md §D.8, §E.1–E.4, §F.2, §F.3). Typed calls plus react-query hooks.
 *
 * The web cannot import @ccguk/kb, so the catalogue response shapes are copied here (`NormalisedModel`,
 * `CatalogueMakeSummary`, `CatalogueModelSummary`, `FeatureVocabulary` …). Catalogue data is unverified reference
 * data; GTA rates are an industry benchmark only (Courtesy Cars Group UK Ltd is not a GTA subscriber) and their
 * verification status is data the server sets — nothing here upgrades it.
 *
 * Query keys: ['catalogue', …], ['vehicles', 'on-file', reg], ['gta', 'suggest', params], ['settings', 'gta-rates'],
 * ['settings', 'gta-segments'], ['fleet', 'policies']. Writes invalidate ['kb', 'gta-rates'] (hire benchmark lines),
 * ['gta'], ['fleet'] and the settings keys they change.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  FleetUse,
  FuelType,
  GtaRate,
  GtaSuggestion,
  Id,
  InsurancePolicy,
  ISODate,
  ISODateTime,
  MergedGtaRate,
  OnFileMatch,
  Pence,
  Transmission,
  Vehicle,
  VehicleSourceInput,
  VehicleSpec
} from '@ccguk/domain';
import { normaliseRegistration } from '@ccguk/domain';
import { api, asList, request, seg, type LookupMode, type Settings } from './client';

// ---------------------------------------------------------------------------
// Catalogue shapes (copies of @ccguk/kb catalogue/types.ts)
// ---------------------------------------------------------------------------

export type CatalogueVehicleType = 'car' | 'van' | 'pickup' | 'minibus' | 'camper';
export type CatalogueSegment =
  | 'city' | 'supermini' | 'small-family' | 'large-family' | 'executive' | 'luxury' | 'sports' | 'supercar'
  | 'mpv-small' | 'mpv-large' | 'suv-small' | 'suv-medium' | 'suv-large' | 'suv-luxury'
  | 'pickup' | 'van-small' | 'van-medium' | 'van-large' | 'minibus';
export type CatalogueBody =
  | 'hatchback' | 'saloon' | 'estate' | 'coupe' | 'convertible' | 'suv' | 'crossover' | 'mpv' | 'pickup' | 'panel-van'
  | 'crew-van' | 'chassis-cab' | 'minibus' | 'roadster' | 'fastback' | 'liftback' | 'shooting-brake' | 'camper';
export type CatalogueFuel = 'petrol' | 'diesel' | 'hybrid' | 'mild-hybrid' | 'plug-in-hybrid' | 'electric' | 'lpg' | 'hydrogen';
export type CatalogueTransmission = 'manual' | 'automatic';

export const CATALOGUE_SEGMENTS: readonly CatalogueSegment[] = [
  'city', 'supermini', 'small-family', 'large-family', 'executive', 'luxury', 'sports', 'supercar',
  'mpv-small', 'mpv-large', 'suv-small', 'suv-medium', 'suv-large', 'suv-luxury',
  'pickup', 'van-small', 'van-medium', 'van-large', 'minibus'
];

/** Same wording as the API (apps/api services/kb.ts SEGMENT_LABELS). */
export const SEGMENT_LABEL: Record<CatalogueSegment, string> = {
  city: 'City car',
  supermini: 'Supermini',
  'small-family': 'Small family car',
  'large-family': 'Large family car',
  executive: 'Executive car',
  luxury: 'Luxury car',
  sports: 'Sports car',
  supercar: 'Supercar',
  'mpv-small': 'Small MPV',
  'mpv-large': 'Large MPV',
  'suv-small': 'Small SUV',
  'suv-medium': 'Medium SUV',
  'suv-large': 'Large SUV',
  'suv-luxury': 'Luxury SUV',
  pickup: 'Pick-up',
  'van-small': 'Small van',
  'van-medium': 'Medium van',
  'van-large': 'Large van',
  minibus: 'Minibus'
};

export function segmentLabel(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  return SEGMENT_LABEL[segment as CatalogueSegment] ?? segment;
}

export interface CatalogueTrim {
  name: string;
  from?: number;
  to?: number | null;
  bodies?: CatalogueBody[];
  engines?: string[];
  features?: string[];
  gtaGroup?: string;
}

export interface CatalogueEngine {
  label: string;
  cc?: number;
  fuel: CatalogueFuel;
  powerPs?: number;
  powerKw?: number;
  batteryKwh?: number;
  transmissions?: CatalogueTransmission[];
  from?: number;
  to?: number | null;
}

export interface CatalogueMakeSummary {
  slug: string;
  make: string;
  dvlaNames: string[];
  aliases: string[];
  modelCount: number;
  years: { from: number; to: number | null };
  vehicleTypes: CatalogueVehicleType[];
  custom?: boolean;
}

export interface NormalisedEngine extends CatalogueEngine {
  id: string;
  domainFuel: FuelType;
  mildHybrid?: boolean;
  ccApprox?: boolean;
}

export interface NormalisedTrim extends CatalogueTrim {
  id: string;
}

export interface NormalisedGeneration {
  id: string;
  name: string;
  from: number;
  to: number | null;
  bodies: Array<{ body: CatalogueBody; doors: number[]; seats: number[] }>;
  trims: NormalisedTrim[];
  engines: NormalisedEngine[];
  fuels: CatalogueFuel[];
  transmissions: CatalogueTransmission[];
  gtaGroup?: string;
  note?: string;
}

export interface NormalisedModel {
  name: string;
  slug: string;
  aliases: string[];
  vehicleType: CatalogueVehicleType;
  segment: CatalogueSegment;
  years: { from: number; to: number | null };
  gtaGroup?: string;
  makeSlug: string;
  generations: NormalisedGeneration[];
  custom?: boolean;
}

export interface CatalogueModelSummary {
  makeSlug: string;
  slug: string;
  name: string;
  vehicleType: CatalogueVehicleType;
  segment: CatalogueSegment;
  years: { from: number; to: number | null };
  bodies: CatalogueBody[];
  custom?: boolean;
}

export interface CatalogueSearchHit {
  makeSlug: string;
  make: string;
  modelSlug?: string;
  model?: string;
  generationId?: string;
  trimId?: string;
  score: number;
  label: string;
}

/** GET /catalogue/match → which catalogue make/model a DVLA or pasted make/model names, and the trim left over. */
export interface CatalogueMatchView {
  makeSlug?: string;
  modelSlug?: string;
  variantRemainder?: string;
  score: number;
}

export interface FeatureItem {
  id: string;
  label: string;
  aliases?: string[];
  kind: 'feature' | 'extra' | 'both';
}

export interface FeatureVocabulary {
  schemaVersion: 1;
  categories: Array<{ id: string; label: string; items: FeatureItem[] }>;
}

export type CustomCatalogueLevel = 'make' | 'model' | 'generation' | 'trim' | 'engine';

export interface CustomCatalogueBody {
  level: CustomCatalogueLevel;
  make: string;
  model?: string;
  generationId?: string;
  name: string;
  data?: Record<string, unknown>;
  segment?: CatalogueSegment;
  gtaGroup?: string;
  overridesBuiltin?: boolean;
}

export interface CustomCatalogueEntry {
  id: Id;
  level: CustomCatalogueLevel;
  make: string;
  makeSlug: string;
  model?: string;
  modelSlug?: string;
  generationId?: string;
  name: string;
  data: Record<string, unknown>;
  segment?: string;
  gtaGroup?: string;
  overridesBuiltin: boolean;
  createdAt: ISODateTime;
  createdBy: string;
  deletedAt?: ISODateTime;
}

// ---------------------------------------------------------------------------
// Vehicles (§E.1, §E.4)
// ---------------------------------------------------------------------------

/** PATCH /vehicles/:id — `null` clears a field; `source` is required; registration cannot change. */
export interface VehiclePatchBody {
  make?: string;
  model?: string;
  variant?: string | null;
  bodyType?: string | null;
  yearOfManufacture?: number | null;
  monthOfFirstRegistration?: string | null;
  fuelType?: FuelType | null;
  transmission?: Transmission | null;
  colour?: string | null;
  engineCapacityCc?: number | null;
  vin?: string | null;
  co2Gkm?: number | null;
  euroStatus?: string | null;
  taxStatus?: string | null;
  taxDueDate?: ISODate | null;
  motStatus?: string | null;
  motExpiryDate?: ISODate | null;
  gtaGroup?: string | null;
  spec?: VehicleSpec | null;
  source: VehicleSourceInput;
}

/** A value that differs from a verified DVLA/DVSA lookup: saved (handler intent) and reported back. */
export interface DiffersFromVerifiedWarning {
  code: 'DIFFERS_FROM_VERIFIED' | string;
  field: string;
  verifiedValue?: unknown;
}

export interface VehiclePatchResult {
  vehicle: Vehicle;
  lookupId?: Id;
  warnings: DiffersFromVerifiedWarning[];
}

/** The API answers `{ ...vehicle, vehicle, lookupId, warnings }`; older builds may answer the bare vehicle. */
export function normaliseVehiclePatchResult(res: unknown): VehiclePatchResult {
  const r = (res && typeof res === 'object' ? res : {}) as Record<string, unknown>;
  const inner = r.vehicle && typeof r.vehicle === 'object' ? (r.vehicle as Vehicle) : (r as unknown as Vehicle);
  const warnings = Array.isArray(r.warnings) ? (r.warnings as DiffersFromVerifiedWarning[]) : [];
  const out: VehiclePatchResult = { vehicle: inner, warnings };
  if (typeof r.lookupId === 'string') out.lookupId = r.lookupId;
  return out;
}

// ---------------------------------------------------------------------------
// GTA (§D.6, §F.3)
// ---------------------------------------------------------------------------

/** GET /gta/suggest query. `make`/`model` may be catalogue slugs or names. */
export interface GtaSuggestQuery {
  make?: string;
  model?: string;
  generationId?: string;
  trimId?: string;
  segment?: string;
  bodyType?: string;
  engineCapacityCc?: number;
  fuelType?: FuelType;
  variant?: string;
  recordedGroup?: string;
  date?: ISODate;
}

/** One row of GET /settings/gta-rates (KB rows, your overrides, hidden rows and your own rows). */
export type GtaRateListItem = MergedGtaRate & { kbRate?: GtaRate; suppressed?: boolean; note?: string };

export interface GtaRateListing {
  items: GtaRateListItem[];
  note?: string;
}

/** POST /settings/gta-rates and PUT /settings/gta-rates/:id. The server sets verifiedBy/verifiedAt; never sent. */
export interface GtaRateBody {
  group: string;
  description?: string;
  dailyRatePence: Pence;
  period: string;
  effectiveFrom: ISODate;
  effectiveTo: ISODate;
  verification?: { status: 'unverified' | 'verified'; sourceUrl?: string; sourceNote?: string };
  note?: string;
}

export interface GtaSuppressBody {
  group: string;
  period: string;
  suppressed: boolean;
}

export interface GtaSegmentItem {
  segment: string;
  label: string;
  group: string;
  origin: 'kb' | 'manual';
  kbGroup?: string;
}

// ---------------------------------------------------------------------------
// Fleet policies (GET/POST /fleet/policies)
// ---------------------------------------------------------------------------

export interface PolicyBody {
  insurerName: string;
  policyNumber: string;
  coveredUses: FleetUse[];
  startDate: ISODate;
  endDate: ISODate;
  evidenceId?: Id;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * The read-only catalogue routes answer with `cache-control: private, max-age=3600`. After a custom entry is added or
 * removed the next catalogue reads carry `?v=<stamp>` so the browser cache cannot serve the old list.
 */
let catalogueStamp = '';
export function bumpCatalogueStamp(now: number = Date.now()): string {
  catalogueStamp = String(now);
  return catalogueStamp;
}
const v = () => (catalogueStamp ? { v: catalogueStamp } : {});

export const vehiclesApi = {
  // catalogue
  catalogueMakes: async (signal?: AbortSignal) => asList<CatalogueMakeSummary>(await request<unknown>('/catalogue/makes', { query: v(), signal })),
  catalogueModels: async (makeSlug: string, opts: { year?: number; vehicleType?: CatalogueVehicleType } = {}, signal?: AbortSignal) =>
    asList<CatalogueModelSummary>(await request<unknown>(`/catalogue/makes/${seg(makeSlug)}/models`, { query: { ...opts, ...v() }, signal })),
  catalogueModel: (makeSlug: string, modelSlug: string, signal?: AbortSignal) =>
    request<NormalisedModel>(`/catalogue/makes/${seg(makeSlug)}/models/${seg(modelSlug)}`, { query: v(), signal }),
  catalogueMatch: (make: string, model?: string, signal?: AbortSignal) => request<CatalogueMatchView>('/catalogue/match', { query: { make, model, ...v() }, signal }),
  catalogueSearch: async (q: string, limit = 20, signal?: AbortSignal) => asList<CatalogueSearchHit>(await request<unknown>('/catalogue/search', { query: { q, limit, ...v() }, signal })),
  catalogueFeatures: (signal?: AbortSignal) => request<FeatureVocabulary>('/catalogue/features', { signal }),
  listCustomCatalogue: async (signal?: AbortSignal) => asList<CustomCatalogueEntry>(await request<unknown>('/catalogue/custom', { signal })),
  createCustomCatalogue: (body: CustomCatalogueBody) => request<CustomCatalogueEntry>('/catalogue/custom', { method: 'POST', body }),
  deleteCustomCatalogue: (id: Id) => request<void>(`/catalogue/custom/${seg(id)}`, { method: 'DELETE' }),

  // vehicles
  onFile: async (registration: string, limit = 10, signal?: AbortSignal) =>
    asList<OnFileMatch>(await request<unknown>('/vehicles/on-file', { query: { registration: normaliseRegistration(registration), limit }, signal })),
  patchVehicle: async (id: Id, body: VehiclePatchBody) => normaliseVehiclePatchResult(await request<unknown>(`/vehicles/${seg(id)}`, { method: 'PATCH', body })),

  // GTA suggestion and rates
  gtaSuggest: (q: GtaSuggestQuery, signal?: AbortSignal) => request<GtaSuggestion>('/gta/suggest', { query: { ...q }, signal }),
  gtaRateSettings: async (signal?: AbortSignal): Promise<GtaRateListing> => {
    const res = await request<unknown>('/settings/gta-rates', { signal });
    const note = res && typeof res === 'object' && typeof (res as { note?: unknown }).note === 'string' ? (res as { note: string }).note : undefined;
    return { items: asList<GtaRateListItem>(res), ...(note ? { note } : {}) };
  },
  createGtaRate: (body: GtaRateBody) => request<unknown>('/settings/gta-rates', { method: 'POST', body }),
  updateGtaRate: (id: Id, body: GtaRateBody) => request<unknown>(`/settings/gta-rates/${seg(id)}`, { method: 'PUT', body }),
  deleteGtaRate: (id: Id) => request<void>(`/settings/gta-rates/${seg(id)}`, { method: 'DELETE' }),
  suppressGtaRate: (body: GtaSuppressBody) => request<unknown>('/settings/gta-rates/suppress', { method: 'POST', body }),
  gtaSegments: async (signal?: AbortSignal) => asList<GtaSegmentItem>(await request<unknown>('/settings/gta-segments', { signal })),
  setGtaSegment: (segment: string, group: string) => request<GtaSegmentItem>(`/settings/gta-segments/${seg(segment)}`, { method: 'PUT', body: { group } }),
  resetGtaSegment: (segment: string) => request<void>(`/settings/gta-segments/${seg(segment)}`, { method: 'DELETE' }),

  // fleet policies
  fleetPolicies: async (signal?: AbortSignal) => asList<InsurancePolicy>(await request<unknown>('/fleet/policies', { signal })),
  createFleetPolicy: (body: PolicyBody) => request<InsurancePolicy>('/fleet/policies', { method: 'POST', body })
};

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const vk = {
  catalogue: ['catalogue'] as const,
  makes: ['catalogue', 'makes'] as const,
  models: (makeSlug: string, year?: number) => ['catalogue', 'models', makeSlug, year ?? 'any'] as const,
  model: (makeSlug: string, modelSlug: string) => ['catalogue', 'model', makeSlug, modelSlug] as const,
  match: (make: string, model?: string) => ['catalogue', 'match', make, model ?? ''] as const,
  search: (q: string) => ['catalogue', 'search', q] as const,
  features: ['catalogue', 'features'] as const,
  custom: ['catalogue', 'custom'] as const,
  onFile: (registration: string) => ['vehicles', 'on-file', normaliseRegistration(registration)] as const,
  gta: ['gta'] as const,
  gtaSuggest: (q: GtaSuggestQuery) => ['gta', 'suggest', q] as const,
  gtaRateSettings: ['settings', 'gta-rates'] as const,
  gtaSegments: ['settings', 'gta-segments'] as const,
  kbGtaRates: ['kb', 'gta-rates'] as const,
  policies: ['fleet', 'policies'] as const
};

const HOUR = 60 * 60_000;

// ---------------------------------------------------------------------------
// Hooks — catalogue
// ---------------------------------------------------------------------------

export function useCatalogueMakes() {
  return useQuery({ queryKey: vk.makes, queryFn: ({ signal }) => vehiclesApi.catalogueMakes(signal), staleTime: HOUR });
}

export function useCatalogueModels(makeSlug: string | undefined, year?: number) {
  return useQuery({
    queryKey: vk.models(makeSlug ?? '', year),
    queryFn: ({ signal }) => vehiclesApi.catalogueModels(makeSlug!, year ? { year } : {}, signal),
    enabled: Boolean(makeSlug),
    staleTime: HOUR
  });
}

export function useCatalogueModel(makeSlug: string | undefined, modelSlug: string | undefined) {
  return useQuery({
    queryKey: vk.model(makeSlug ?? '', modelSlug ?? ''),
    queryFn: ({ signal }) => vehiclesApi.catalogueModel(makeSlug!, modelSlug!, signal),
    enabled: Boolean(makeSlug && modelSlug),
    staleTime: HOUR,
    retry: 0
  });
}

export function useCatalogueFeatures() {
  return useQuery({ queryKey: vk.features, queryFn: ({ signal }) => vehiclesApi.catalogueFeatures(signal), staleTime: 6 * HOUR });
}

export function useCatalogueSearch(q: string) {
  const term = q.trim();
  return useQuery({ queryKey: vk.search(term), queryFn: ({ signal }) => vehiclesApi.catalogueSearch(term, 20, signal), enabled: term.length >= 2, staleTime: HOUR });
}

export function useCatalogueCustom() {
  return useQuery({ queryKey: vk.custom, queryFn: ({ signal }) => vehiclesApi.listCustomCatalogue(signal) });
}

/** Add a make/model/generation/trim/engine the catalogue does not list. Unverified, like the rest of the catalogue. */
export function useCreateCustomCatalogue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CustomCatalogueBody) => vehiclesApi.createCustomCatalogue(body),
    onSuccess: () => {
      bumpCatalogueStamp();
      void qc.invalidateQueries({ queryKey: vk.catalogue });
      void qc.invalidateQueries({ queryKey: vk.gta });
    }
  });
}

export function useDeleteCustomCatalogue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => vehiclesApi.deleteCustomCatalogue(id),
    onSuccess: () => {
      bumpCatalogueStamp();
      void qc.invalidateQueries({ queryKey: vk.catalogue });
      void qc.invalidateQueries({ queryKey: vk.gta });
    }
  });
}

// ---------------------------------------------------------------------------
// Hooks — vehicles
// ---------------------------------------------------------------------------

/** What ClaimDesk already holds for a registration (read-only; nothing is written by a search). */
export function useOnFile(registration: string | undefined, opts: { enabled?: boolean } = {}) {
  const reg = normaliseRegistration(registration ?? '');
  return useQuery({
    queryKey: vk.onFile(reg),
    queryFn: ({ signal }) => vehiclesApi.onFile(reg, 10, signal),
    enabled: reg.length >= 2 && (opts.enabled ?? true),
    staleTime: 30_000
  });
}

/** PATCH /vehicles/:id; refreshes the vehicle, the claim files that show it, the fleet and on-file searches. */
export function usePatchVehicle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: Id; body: VehiclePatchBody }) => vehiclesApi.patchVehicle(id, body),
    onSuccess: (_res, { id }) => {
      void qc.invalidateQueries({ queryKey: ['vehicle', id] });
      void qc.invalidateQueries({ queryKey: ['vehicles'] });
      void qc.invalidateQueries({ queryKey: ['claim'] });
      void qc.invalidateQueries({ queryKey: ['fleet'] });
    }
  });
}

/** 'live' / 'manual' from GET /settings (`lookupMode`, else derived from the API key flags); undefined until known. */
export function lookupModeFromSettings(settings: Settings | undefined): LookupMode | undefined {
  const m = settings?.lookupMode;
  if (m === 'live' || m === 'manual') return m;
  const keys = settings?.apiKeys;
  if (!keys) return undefined;
  return keys.dvlaVes || keys.dvsaMot ? 'live' : 'manual';
}

export function useLookupMode(): LookupMode | undefined {
  const q = useQuery({ queryKey: ['settings'], queryFn: ({ signal }) => api.getSettings(signal), staleTime: 5 * 60_000 });
  return lookupModeFromSettings(q.data);
}

// ---------------------------------------------------------------------------
// Hooks — GTA
// ---------------------------------------------------------------------------

/** GET /gta/suggest for the vehicle facts. Disabled until make and model are known (pass null). */
export function useGtaSuggest(q: GtaSuggestQuery | null) {
  return useQuery({
    queryKey: vk.gtaSuggest(q ?? {}),
    queryFn: ({ signal }) => vehiclesApi.gtaSuggest(q!, signal),
    enabled: Boolean(q),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev
  });
}

export function useGtaRateSettings() {
  return useQuery({ queryKey: vk.gtaRateSettings, queryFn: ({ signal }) => vehiclesApi.gtaRateSettings(signal) });
}

export function useGtaSegments() {
  return useQuery({ queryKey: vk.gtaSegments, queryFn: ({ signal }) => vehiclesApi.gtaSegments(signal) });
}

function useInvalidateGta() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: vk.gtaRateSettings });
    void qc.invalidateQueries({ queryKey: vk.gtaSegments });
    void qc.invalidateQueries({ queryKey: vk.kbGtaRates });
    void qc.invalidateQueries({ queryKey: vk.gta });
    void qc.invalidateQueries({ queryKey: ['fleet'] });
  };
}

export function useCreateGtaRate() {
  const invalidate = useInvalidateGta();
  return useMutation({ mutationFn: (body: GtaRateBody) => vehiclesApi.createGtaRate(body), onSuccess: invalidate });
}

export function useUpdateGtaRate() {
  const invalidate = useInvalidateGta();
  return useMutation({ mutationFn: ({ id, body }: { id: Id; body: GtaRateBody }) => vehiclesApi.updateGtaRate(id, body), onSuccess: invalidate });
}

export function useDeleteGtaRate() {
  const invalidate = useInvalidateGta();
  return useMutation({ mutationFn: (id: Id) => vehiclesApi.deleteGtaRate(id), onSuccess: invalidate });
}

export function useSuppressGtaRate() {
  const invalidate = useInvalidateGta();
  return useMutation({ mutationFn: (body: GtaSuppressBody) => vehiclesApi.suppressGtaRate(body), onSuccess: invalidate });
}

export function useSetGtaSegment() {
  const invalidate = useInvalidateGta();
  return useMutation({ mutationFn: ({ segment, group }: { segment: string; group: string }) => vehiclesApi.setGtaSegment(segment, group), onSuccess: invalidate });
}

export function useResetGtaSegment() {
  const invalidate = useInvalidateGta();
  return useMutation({ mutationFn: (segment: string) => vehiclesApi.resetGtaSegment(segment), onSuccess: invalidate });
}

// ---------------------------------------------------------------------------
// Hooks — fleet policies
// ---------------------------------------------------------------------------

export function useFleetPolicies() {
  return useQuery({ queryKey: vk.policies, queryFn: ({ signal }) => vehiclesApi.fleetPolicies(signal), staleTime: 60_000 });
}

export function useCreateFleetPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PolicyBody) => vehiclesApi.createFleetPolicy(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fleet'] })
  });
}

/**
 * Vehicle catalogue types (TEMPLATES-VEHICLES-DESKTOP §D.2, §D.3, §D.5).
 *
 * The compact make-file form is what the data authors write (`trims`/`engines` may be plain strings); the loader
 * normalises it into the `Normalised*` shapes with stable ids. Everything in the catalogue is unverified reference
 * data: the V5C, the DVLA record or Total Car Check is the authority for a particular vehicle.
 */
import type { FuelType } from '@ccguk/domain';

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

export const CATALOGUE_VEHICLE_TYPES: readonly CatalogueVehicleType[] = ['car', 'van', 'pickup', 'minibus', 'camper'];
export const CATALOGUE_SEGMENTS: readonly CatalogueSegment[] = [
  'city', 'supermini', 'small-family', 'large-family', 'executive', 'luxury', 'sports', 'supercar',
  'mpv-small', 'mpv-large', 'suv-small', 'suv-medium', 'suv-large', 'suv-luxury',
  'pickup', 'van-small', 'van-medium', 'van-large', 'minibus',
];
export const CATALOGUE_BODIES: readonly CatalogueBody[] = [
  'hatchback', 'saloon', 'estate', 'coupe', 'convertible', 'suv', 'crossover', 'mpv', 'pickup', 'panel-van',
  'crew-van', 'chassis-cab', 'minibus', 'roadster', 'fastback', 'liftback', 'shooting-brake', 'camper',
];
export const CATALOGUE_FUELS: readonly CatalogueFuel[] = ['petrol', 'diesel', 'hybrid', 'mild-hybrid', 'plug-in-hybrid', 'electric', 'lpg', 'hydrogen'];
export const CATALOGUE_TRANSMISSIONS: readonly CatalogueTransmission[] = ['manual', 'automatic'];

export interface CatalogueMakeFile {
  /** Display name as on the V5C/brochure: 'Mercedes-Benz', 'SEAT', 'Citroën'. */
  make: string;
  /** slugify(make): 'mercedes-benz', 'seat', 'citroen'. */
  slug: string;
  /** Upper-case spellings DVLA/VES/TCC use: ['MERCEDES-BENZ', 'MERCEDES']. */
  dvlaNames: string[];
  /** Other spellings people type: ['Mercedes', 'Merc']. */
  aliases: string[];
  /** Always unverified. */
  verification: { status: 'unverified'; sourceNote: string };
  models: CatalogueModel[];
}

export interface CatalogueModel {
  name: string;
  /** Unique within the make. */
  slug: string;
  aliases: string[];
  vehicleType: CatalogueVehicleType;
  segment: CatalogueSegment;
  /** UK new-sale years, clamped to ≥ 2000; null = still on sale. */
  years: { from: number; to: number | null };
  /** Optional model-level suggestion (unverified). */
  gtaGroup?: string;
  generations: CatalogueGeneration[];
}

export interface CatalogueGeneration {
  /** 'Mk7 (2012–2020)'. */
  name: string;
  /** Optional; the loader derives `${makeSlug}-${modelSlug}-${slugify(name)}`. */
  id?: string;
  from: number;
  to: number | null;
  bodies: Array<{ body: CatalogueBody; doors: number[]; seats: number[] }>;
  trims: Array<string | CatalogueTrim>;
  engines: Array<string | CatalogueEngine>;
  fuels: CatalogueFuel[];
  transmissions: CatalogueTransmission[];
  gtaGroup?: string;
  note?: string;
}

export interface CatalogueTrim {
  name: string;
  from?: number;
  to?: number | null;
  bodies?: CatalogueBody[];
  /** Engine labels (or ids) the trim was sold with. */
  engines?: string[];
  /** Feature ids standard on the trim (features.json). */
  features?: string[];
  gtaGroup?: string;
}

export interface CatalogueEngine {
  /** '2.0 TDI 150PS diesel'. */
  label: string;
  /** Exact when known; else derived from litres (ccApprox). */
  cc?: number;
  fuel: CatalogueFuel;
  powerPs?: number;
  powerKw?: number;
  batteryKwh?: number;
  transmissions?: CatalogueTransmission[];
  from?: number;
  to?: number | null;
}

// ---------------------------------------------------------------------------
// Features and extras (§D.3)
// ---------------------------------------------------------------------------

export interface FeatureVocabulary {
  schemaVersion: 1;
  categories: Array<{ id: string; label: string; items: Array<{ id: string; label: string; aliases?: string[]; kind: 'feature' | 'extra' | 'both' }> }>;
}

// ---------------------------------------------------------------------------
// Loader / query shapes (§D.5)
// ---------------------------------------------------------------------------

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

export interface NormalisedGeneration extends Omit<CatalogueGeneration, 'trims' | 'engines'> {
  id: string;
  trims: NormalisedTrim[];
  engines: NormalisedEngine[];
}

export interface NormalisedModel extends Omit<CatalogueModel, 'generations'> {
  makeSlug: string;
  generations: NormalisedGeneration[];
  custom?: boolean;
}

export type NormalisedMake = Omit<CatalogueMakeFile, 'models'> & { models: NormalisedModel[] };

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

export interface CatalogueMatch {
  make?: CatalogueMakeSummary;
  model?: CatalogueModelSummary;
  variantRemainder?: string;
  score: number;
}

/** `packages/kb/data/gta-segment-defaults.json` (§D.6). */
export interface GtaSegmentDefaultsFile {
  schemaVersion: 1;
  verification: { status: 'unverified'; sourceNote: string };
  defaults: Record<CatalogueSegment, string>;
}

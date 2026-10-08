/**
 * Vehicle dimensions (packages/kb/data/vehicle-dimensions/<make>.json): the real exterior proportions the damage model
 * uses to build a recognisable 3D body for a specific make / model / generation / body style.
 *
 * File shape (every field below `bodies.<body>` is optional — missing or invalid values are filled from body-type
 * defaults and listed in `filled`):
 *
 *   { make, slug, verification, models: { [modelSlug]: { [generationName]: { bodies: { [body]: BodyDimensionsInput } } } } }
 *
 * Ratio conventions (what the generator assumes):
 *  - frontOverhangRatio / rearOverhangRatio: overhang (bumper face to wheel centre) ÷ overall length.
 *  - bonnetRatio: nose to windscreen base (along the car) ÷ overall length.
 *  - glasshouseHeightRatio: beltline-to-roof height ÷ overall height.
 *  - roofTaper: 0–1 index of how much the glasshouse tapers toward the rear (0 = boxy, roof runs straight back, e.g.
 *    vans and estates ≈ 0.05–0.12; 0.25 hatch; 0.3 saloon; 0.45 coupe / fastback).
 *  - doors: the door counts the body is sold with ([3, 5]); a single number is accepted too.
 *
 * Profiles seen in the data: hatch, notchback, liftback, fastback, estate, coupe, convertible, roadster, suv-rounded,
 * suv-boxy, suv-coupe, mpv, taxi, van-low, van-high, minibus, pickup-single, pickup-double — normalised below.
 */

/** Silhouette family. Free text in the data; normalised to one of these. */
export const DIMENSION_PROFILES = [
  'hatch',
  'saloon',
  'fastback',
  'estate',
  'coupe',
  'convertible',
  'suv',
  'suv-boxy',
  'suv-coupe',
  'mpv',
  'van',
  'van-high-roof',
  'pickup'
] as const;
export type DimensionProfile = (typeof DIMENSION_PROFILES)[number];

export const LAMP_STYLES = ['slim', 'swept', 'round', 'square', 'tall', 'light-bar', 'split'] as const;
export type LampStyle = (typeof LAMP_STYLES)[number];

export const GRILLE_STYLES = ['wide', 'trapezoid', 'hexagonal', 'kidney', 'slim', 'large', 'closed', 'split', 'shield'] as const;
export type GrilleStyle = (typeof GRILLE_STYLES)[number];

/** As written in a data file (anything may be missing). */
export interface BodyDimensionsInput {
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  wheelbaseMm?: number;
  groundClearanceMm?: number;
  wheelDiameterIn?: number;
  profile?: string;
  bonnetRatio?: number;
  rearOverhangRatio?: number;
  frontOverhangRatio?: number;
  glasshouseHeightRatio?: number;
  roofTaper?: number;
  doors?: number | number[];
  roofRails?: boolean;
  spareOnTailgate?: boolean;
  slidingSideDoor?: boolean;
  lampStyle?: string;
  grilleStyle?: string;
  note?: string;
}

/** Fully resolved: every field present and inside a sane range. */
export interface BodyDimensions {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  wheelbaseMm: number;
  groundClearanceMm: number;
  wheelDiameterIn: number;
  profile: DimensionProfile;
  bonnetRatio: number;
  rearOverhangRatio: number;
  frontOverhangRatio: number;
  glasshouseHeightRatio: number;
  roofTaper: number;
  /** The door count drawn (the query's when it is one of `doorOptions`, else the largest). */
  doors: number;
  /** Every door count the body is sold with. */
  doorOptions: number[];
  roofRails: boolean;
  spareOnTailgate: boolean;
  slidingSideDoor: boolean;
  lampStyle: LampStyle;
  grilleStyle: GrilleStyle;
  note?: string;
}

export interface DimensionsMakeFile {
  make: string;
  slug: string;
  verification?: { status?: string; sourceNote?: string; [k: string]: unknown };
  models: Record<string, Record<string, { bodies?: Record<string, BodyDimensionsInput> }>>;
}

/** A lookup result: which entry matched and the resolved dimensions. */
export interface ResolvedDimensions {
  make: string;
  makeSlug: string;
  model: string;
  generation: string;
  body: string;
  dims: BodyDimensions;
  /** Fields that were missing/invalid in the file and came from body-type defaults. */
  filled: Array<keyof BodyDimensions>;
  /** 'exact' = make/model/generation/body all matched; 'generation' = body fell back; 'model' = generation fell back. */
  match: 'exact' | 'generation' | 'model';
  verification: { status: string; sourceNote?: string };
}

export interface DimensionsQuery {
  make: string;
  model: string;
  generation?: string;
  /** Body style (catalogue body or damage-model body type). */
  body?: string;
  doors?: number;
  /** Model year, used to pick a generation when `generation` is missing. */
  year?: number;
}

export interface DimensionsLoadIssue {
  file: string;
  level: 'error' | 'warning';
  message: string;
}

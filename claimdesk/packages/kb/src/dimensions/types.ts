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
 *  - roofTaper: roof width at its rear ÷ roof width at the windscreen (0.8–1). A value ≤ 0.5 is read as a fractional
 *    narrowing (1 − value).
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
  'suv-coupe',
  'mpv',
  'van',
  'van-high-roof',
  'pickup'
] as const;
export type DimensionProfile = (typeof DIMENSION_PROFILES)[number];

export const LAMP_STYLES = ['slim', 'swept', 'round', 'square', 'tall', 'light-bar'] as const;
export type LampStyle = (typeof LAMP_STYLES)[number];

export const GRILLE_STYLES = ['wide', 'trapezoid', 'hexagonal', 'kidney', 'slim', 'large', 'closed', 'split'] as const;
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
  doors?: number;
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
  doors: number;
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

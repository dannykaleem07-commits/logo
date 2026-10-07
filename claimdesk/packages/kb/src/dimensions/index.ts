// Vehicle dimensions for the parametric 3D damage model. Named exports only.
export { DIMENSION_PROFILES, LAMP_STYLES, GRILLE_STYLES } from './types.js';
export type {
  DimensionProfile,
  LampStyle,
  GrilleStyle,
  BodyDimensionsInput,
  BodyDimensions,
  DimensionsMakeFile,
  ResolvedDimensions,
  DimensionsQuery,
  DimensionsLoadIssue
} from './types.js';
export {
  PROFILE_DEFAULTS,
  normaliseProfile,
  normaliseLampStyle,
  normaliseGrilleStyle,
  normaliseBodyDimensions,
  defaultBodyDimensions,
  makeSlug,
  generationCode,
  generationYears,
  bodyCandidates
} from './normalise.js';
export {
  setDimensionsDataDir,
  dimensionsDataDir,
  resetDimensionsCache,
  dimensionsLoadIssues,
  dimensionsMakeFiles,
  getDimensionsMake,
  findVehicleDimensions,
  vehicleDimensionsOrDefault,
  listDimensionModels
} from './load.js';

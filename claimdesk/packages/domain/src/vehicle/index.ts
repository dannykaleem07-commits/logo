// vehicle module — BLUEPRINT §3.2, §4.1, §4.4. Named exports only.
export {
  normaliseRegistration,
  isValidUkRegistration,
  registrationFormat,
  formatRegistration,
  type RegistrationFormat
} from './registration.js';
export {
  mileageConflicts,
  projectOdometer,
  type MileageConflict,
  type MileageConflictCode,
  type MileageConflictOptions,
  type OdometerProjection
} from './mileage.js';
export { crossFileRegistrationCheck, type CrossFileRegistrationResult, type CrossFileOptions } from './crossfile.js';
export {
  mapDvlaVes,
  dvlaVesExtras,
  mapVesFuelType,
  mapDvsaMotHistory,
  kmToMiles,
  type DvlaVesPayload,
  type DvlaVesExtras,
  type DvsaMotDefect,
  type DvsaMotTest,
  type DvsaMotVehicle,
  type MappedMotHistory
} from './mappers.js';
export {
  TOTAL_CAR_CHECK_URL_TEMPLATE,
  GOV_MOT_HISTORY_URL,
  GOV_VEHICLE_ENQUIRY_URL,
  totalCarCheckUrl,
  externalVehicleLinks
} from './external.js';
export {
  PASTE_MAX_CHARS,
  PS_TO_BHP,
  parseVehicleCheckText,
  parseLooseDate,
  parseFuel,
  parseTransmission,
  type ParsedVehicleCheck,
  type ParsedDate
} from './parseCheckText.js';

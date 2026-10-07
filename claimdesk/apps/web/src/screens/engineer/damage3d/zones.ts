/**
 * Single import point for the vehicle zone taxonomy. It lives in @ccguk/domain (engineering/panels.ts) but is not yet
 * exported from the package index; once the integrator adds `export * from './engineering/panels'` there, switch this
 * relative path to `@ccguk/domain` — nothing else in damage3d needs to change.
 */
export {
  VEHICLE_BODY_TYPES,
  VEHICLE_BODY_LABELS,
  VEHICLE_ZONES,
  ZONE_OPERATION_LABELS,
  ZONE_AREA_LABELS,
  DAMAGE_SEVERITIES,
  DAMAGE_SEVERITY_LABELS,
  getZone,
  isZoneId,
  zoneAppliesToBody,
  zonesForBody,
  zonesByArea,
  mirrorZoneId,
  mapZoneToBody,
  normaliseBodyType,
  suggestOperation,
  severityFromFinding,
  zoneForPanelName
} from '../../../../../../packages/domain/src/engineering/panels';
export type { VehicleBodyType, VehicleZone, ZoneOperation, ZoneArea, ZoneKind, ZoneSide, DamageSeverity } from '../../../../../../packages/domain/src/engineering/panels';

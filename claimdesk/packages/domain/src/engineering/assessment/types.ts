/**
 * AI visual damage assessment — shared types (ENGINEER-MODE requirements, SUPREME-DESIGN §H.3).
 *
 * The engineer agent looks at photos and returns an `AssessmentResult` (JSON Schema in `schema.ts`). Pure code then
 * expands it: knock-on parts (`knockOn.ts`), hidden-damage checks (`checks.ts`), consistency notes for the engineer
 * (`consistency.ts`) and itemised-schedule lines (`schedule.ts`). Every figure produced from an AI result is an
 * estimate: `source: 'ai_estimate'`, `verified: false`, until a person confirms it.
 *
 * Zone ids are the ClaimDesk taxonomy in `../panels.ts` (VEHICLE_ZONES).
 */
import type { DamageSeverity, VehicleBodyType, ZoneOperation } from '../panels.js';

export type { DamageSeverity, VehicleBodyType, ZoneOperation } from '../panels.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const DAMAGE_TYPES = ['dent', 'scratch', 'crack', 'tear', 'misalignment', 'missing', 'deployed'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];
export const DAMAGE_TYPE_LABELS: Record<DamageType, string> = {
  dent: 'Dent / deformation',
  scratch: 'Scratch / scuff',
  crack: 'Crack / broken',
  tear: 'Tear / split',
  misalignment: 'Misalignment / gaps',
  missing: 'Missing / detached',
  deployed: 'Deployed (airbag / pretensioner)'
};

/** Direction of the impact force as reported (or inferred), vehicle-relative: left = nearside (N/S) in the UK. */
export const IMPACT_DIRECTIONS = ['front', 'front_left', 'front_right', 'left', 'right', 'rear', 'rear_left', 'rear_right', 'top', 'underside', 'rollover', 'multiple', 'unknown'] as const;
export type ImpactDirection = (typeof IMPACT_DIRECTIONS)[number];
export const IMPACT_DIRECTION_LABELS: Record<ImpactDirection, string> = {
  front: 'front',
  front_left: 'front nearside (left) corner',
  front_right: 'front offside (right) corner',
  left: 'nearside (left) side',
  right: 'offside (right) side',
  rear: 'rear',
  rear_left: 'rear nearside (left) corner',
  rear_right: 'rear offside (right) corner',
  top: 'roof / top',
  underside: 'underside',
  rollover: 'rollover',
  multiple: 'multiple impacts',
  unknown: 'unknown direction'
};

/** Coarse regions of the vehicle used to compare reported impacts with damaged zones. */
export const VEHICLE_REGIONS = ['front', 'rear', 'left', 'right', 'top', 'under', 'interior'] as const;
export type VehicleRegion = (typeof VEHICLE_REGIONS)[number];

/** Where a photo was taken from. `close_up` / `unknown` give no region coverage of their own. */
export const PHOTO_VIEWS = ['front', 'front_left', 'front_right', 'left', 'right', 'rear', 'rear_left', 'rear_right', 'top', 'underside', 'interior', 'close_up', 'document', 'unknown'] as const;
export type PhotoView = (typeof PHOTO_VIEWS)[number];

export const PHOTO_QUALITY_ISSUES = [
  'blurred',
  'too_dark',
  'overexposed',
  'glare_or_reflection',
  'too_far',
  'too_close',
  'obstructed',
  'wet_or_dirty',
  'partial_view',
  'low_resolution',
  'not_a_vehicle',
  'possible_duplicate',
  'possible_different_vehicle'
] as const;
export type PhotoQualityIssue = (typeof PHOTO_QUALITY_ISSUES)[number];
export const PHOTO_QUALITY_LABELS: Record<PhotoQualityIssue, string> = {
  blurred: 'Blurred / out of focus',
  too_dark: 'Too dark',
  overexposed: 'Overexposed',
  glare_or_reflection: 'Glare or reflections hide the surface',
  too_far: 'Taken too far away',
  too_close: 'Taken too close to judge the panel',
  obstructed: 'View obstructed',
  wet_or_dirty: 'Wet or dirty surface hides damage',
  partial_view: 'Only part of the area is shown',
  low_resolution: 'Low resolution',
  not_a_vehicle: 'Does not show a vehicle',
  possible_duplicate: 'Possible duplicate of another photo',
  possible_different_vehicle: 'May show a different vehicle'
};

/** Typical drivetrains; used by a few rules (EV high-voltage checks, coolant). */
export const POWERTRAINS = ['petrol', 'diesel', 'hybrid', 'phev', 'electric', 'other'] as const;
export type Powertrain = (typeof POWERTRAINS)[number];

// ---------------------------------------------------------------------------
// AI result (what the model returns; see ASSESSMENT_RESULT_SCHEMA)
// ---------------------------------------------------------------------------

export interface AssessmentZone {
  /** Taxonomy zone id (`../panels.ts`). */
  zoneId: string;
  /** Visible damage types (at least one when severity > 0). */
  damageTypes: DamageType[];
  /** 0 none (inspected, no visible damage) · 1 light · 2 medium · 3 heavy. */
  severity: DamageSeverity;
  /** Suggested operation; null when severity is 0. Always one of the zone's typical operations after normalising. */
  operation: ZoneOperation | null;
  /** 0..1 — how sure the model is about this zone's damage and severity from the photos. */
  confidence: number;
  /** Photo references (as supplied) the damage is visible in. */
  photoRefs: string[];
  /** Plain-English observations supporting the finding ("crease running through the swage line"). */
  reasons: string[];
  /** Signs the damage may predate the incident (rust in the damage, dirt, weathered edges). */
  preExistingSuspect: boolean;
}

export interface PhotoAssessment {
  ref: string;
  view: PhotoView;
  qualityIssues: PhotoQualityIssue[];
  /** false = cannot be relied on for any finding. */
  usable: boolean;
  note: string | null;
}

export interface AssessmentResult {
  /** `DAMAGE_ASSESSMENT_PROMPT.version` the result was produced with. */
  promptVersion: string;
  zones: AssessmentZone[];
  photos: PhotoAssessment[];
  /** Airbags or pretensioners visibly deployed in the photos. */
  deploymentVisible: boolean;
  /** Fluid on the ground / under the vehicle visible in the photos. */
  fluidLeakVisible: boolean;
  /** Impact direction suggested by the damage pattern, or 'unknown'. */
  apparentImpactDirection: ImpactDirection;
  overallConfidence: number;
  /** Short neutral summary of what is visible. */
  summary: string;
  /** What the photos do not show (areas not photographed, interior not visible, …). */
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Inputs from the claim file
// ---------------------------------------------------------------------------

/** The vehicle as known from the catalogue / DVLA / V5C. */
export interface AssessmentVehicle {
  bodyType?: VehicleBodyType;
  /**
   * Catalogue feature ids (packages/kb/data/vehicle-catalogue/features.json) recorded as fitted.
   * `undefined` = not known → feature-dependent parts are suggested "if fitted". An array (even empty) = known list:
   * feature-dependent parts whose features are absent are left out and reported as not applicable.
   */
  features?: readonly string[];
  powertrain?: Powertrain;
  make?: string;
  model?: string;
  generation?: string;
  year?: number;
}

/** The impact as reported (claim form, statement, call notes). Every field is optional. */
export interface ReportedImpact {
  direction?: ImpactDirection | null;
  /** Zone id, region ('front', 'left', …) or free-text panel name ("O/S/F wing"). */
  primaryArea?: string | null;
  secondaryAreas?: readonly string[];
  speedMph?: number | null;
  /** Reported airbag deployment. */
  airbagsDeployed?: boolean | null;
  description?: string | null;
}

// ---------------------------------------------------------------------------
// Rule sets (packages/kb/data/engineering/*.json)
// ---------------------------------------------------------------------------

export interface RuleVerification {
  status: 'unverified' | 'verified';
  sourceNote: string;
}

/** Conditions shared by knock-on and check rules. Every listed condition must hold. */
export interface RuleWhen {
  /** Severity of the triggering zone (global rules: the highest severity in the result). */
  minSeverity?: DamageSeverity;
  maxSeverity?: DamageSeverity;
  /** Operation suggested for the triggering zone. */
  operationsAny?: ZoneOperation[];
  damageTypesAny?: DamageType[];
  /** Reported impact direction (or the direction inferred from the damage when none is reported). */
  impactDirectionsAny?: ImpactDirection[];
  /** Catalogue feature ids: fitment decides whether the item applies (see AssessmentVehicle.features). */
  featuresAny?: string[];
  bodyTypesAny?: VehicleBodyType[];
  powertrainsAny?: Powertrain[];
  /** Deployment indicated (seen in photos, a 'deployed' zone, or reported). */
  deploymentIndicated?: boolean;
  /** Reported speed at or above (rules with this condition never fire when no speed is reported). */
  minSpeedMph?: number;
  /** At least one of these zones is also damaged (severity ≥ 1). */
  alsoDamagedAny?: string[];
  /** At least this many zones damaged (severity ≥ 1) in total. */
  minDamagedZones?: number;
  /** The result reports fluid visible on the ground / under the vehicle. */
  fluidLeakVisible?: boolean;
}

export const KNOCK_ON_CATEGORIES = [
  'clips',
  'bracket',
  'absorber',
  'reinforcement',
  'moulding',
  'emblem',
  'grille',
  'parking_sensor',
  'sensor_bracket',
  'radar',
  'camera',
  'adas_calibration',
  'headlamp_washer',
  'fog_lamp',
  'lamp',
  'number_plate',
  'wheel_arch_liner',
  'splash_shield',
  'airbag',
  'seatbelt_pretensioner',
  'srs_module',
  'coolant',
  'air_conditioning',
  'cooling_component',
  'glass',
  'trim',
  'mechanical',
  'consumable'
] as const;
export type KnockOnCategory = (typeof KNOCK_ON_CATEGORIES)[number];

export const ADAS_SYSTEMS = ['front_radar', 'front_camera', 'rear_radar', 'surround_cameras', 'rear_camera', 'parking_sensors', 'night_vision', 'headlamps'] as const;
export type AdasSystem = (typeof ADAS_SYSTEMS)[number];
export const ADAS_SYSTEM_LABELS: Record<AdasSystem, string> = {
  front_radar: 'Front radar (adaptive cruise / emergency braking)',
  front_camera: 'Windscreen camera (lane keeping / sign recognition / emergency braking)',
  rear_radar: 'Rear corner radar (blind spot / rear cross-traffic)',
  surround_cameras: '360° surround-view cameras',
  rear_camera: 'Reversing camera',
  parking_sensors: 'Parking sensors',
  night_vision: 'Night-vision camera',
  headlamps: 'Adaptive / matrix headlamps'
};

export interface AdasRequirement {
  system: AdasSystem;
  /** Generic description only — the method is always the manufacturer's procedure. */
  method: 'static' | 'dynamic' | 'static_or_dynamic' | 'coding_or_initialisation' | 'aim';
}

/** Operation on a knock-on item (maps to the schedule's repair / replace / R&I / check). */
export type KnockOnOperation = 'replace' | 'r_and_i' | 'repair' | 'check';

export interface KnockOnItemDef {
  /** Stable key used to merge the same item suggested by several rules; may contain `{side}` (l / r). */
  key: string;
  /** May contain `{sideLabel}` (N/S / O/S). */
  label: string;
  category: KnockOnCategory;
  operation: KnockOnOperation;
  quantity?: number;
  /** Taxonomy zone this item is (if any) — the item is skipped when that zone is already in the result. */
  zoneId?: string;
  /** Item-level feature condition (in addition to the rule's `when.featuresAny`). */
  featuresAny?: string[];
  /** Equipment the catalogue does not record (fog lamps, plate holders): always suggested "if fitted". */
  ifFitted?: boolean;
  adas?: AdasRequirement;
  /** Generic labour hours for this item (overrides the category default in `labour.ts`). Not manufacturer time. */
  genericHours?: number;
}

export interface KnockOnRule {
  id: string;
  /** Triggering zones (any). Omitted = a global rule evaluated once against the whole result. */
  zones?: string[];
  when?: RuleWhen;
  items: KnockOnItemDef[];
  /** Plain-English reason shown to the engineer. */
  reason: string;
}

export interface KnockOnRuleSet {
  schemaVersion: 1;
  id: 'engineering.knock_on_parts';
  version: string;
  verification: RuleVerification;
  rules: KnockOnRule[];
}

export const CHECK_KINDS = [
  'structural_measurement',
  'wheel_alignment',
  'suspension_inspection',
  'steering_inspection',
  'diagnostics_scan',
  'adas_calibration',
  'airbag_srs_check',
  'seatbelt_inspection',
  'cooling_system_check',
  'air_conditioning_check',
  'high_voltage_system_check',
  'panel_gap_check',
  'underbody_inspection',
  'wheel_tyre_inspection',
  'headlamp_aim',
  'glass_inspection'
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export type CheckPriority = 'required' | 'recommended' | 'consider';
export const CHECK_PRIORITY_RANK: Record<CheckPriority, number> = { required: 3, recommended: 2, consider: 1 };

export interface CheckRule {
  id: string;
  check: CheckKind;
  /** Label for the check line; may contain `{sideLabel}`. */
  label: string;
  /** Merge key; may contain `{side}`. Defaults to `check`. */
  key?: string;
  zones?: string[];
  when?: RuleWhen;
  priority: CheckPriority;
  adas?: AdasRequirement;
  reason: string;
  genericHours?: number;
}

export interface CheckRuleSet {
  schemaVersion: 1;
  id: 'engineering.hidden_damage_checks';
  version: string;
  verification: RuleVerification;
  rules: CheckRule[];
}

export const CONSISTENCY_RULE_KINDS = [
  'damage_outside_reported_direction',
  'opposite_side_damage',
  'reported_area_undamaged',
  'reported_area_not_photographed',
  'low_speed_heavy_damage',
  'high_speed_light_damage',
  'deployment_with_light_damage',
  'deployment_reported_not_seen',
  'deployment_seen_not_reported',
  'pre_existing_suspected',
  'unusable_photos'
] as const;
export type ConsistencyRuleKind = (typeof CONSISTENCY_RULE_KINDS)[number];

export interface ConsistencyRule {
  id: string;
  kind: ConsistencyRuleKind;
  /** Zone severity at or above which damage counts for this rule (default 1). */
  minSeverity?: DamageSeverity;
  /** Speed thresholds for the speed rules. */
  maxSpeedMph?: number;
  minSpeedMph?: number;
  /** Highest severity in the result at or below which the rule fires (light-damage rules). */
  maxOverallSeverity?: DamageSeverity;
  /** Zone kinds the rule looks at (panels.ts ZoneKind); omitted = all. */
  zoneKinds?: string[];
  /**
   * Neutral message for the engineer. Placeholders: {zones} {direction} {area} {speed} {count} {photos}.
   * Never accusatory: "for the engineer to consider".
   */
  message: string;
}

export interface ConsistencyRuleSet {
  schemaVersion: 1;
  id: 'engineering.consistency_rules';
  version: string;
  verification: RuleVerification;
  /** Regions a reported direction is expected to damage. */
  directionRegions: Record<ImpactDirection, VehicleRegion[]>;
  /** Regions that never count as "outside the reported direction" (interior, underside). */
  neutralRegions: VehicleRegion[];
  rules: ConsistencyRule[];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** How sure we are an item exists on this vehicle. */
export type Fitment = 'standard' | 'fitted' | 'if_fitted';

export interface Trigger {
  ruleId: string;
  /** Triggering zone, or null for a global rule. */
  zoneId: string | null;
}

export interface KnockOnSuggestion {
  key: string;
  label: string;
  category: KnockOnCategory;
  operation: KnockOnOperation;
  quantity: number;
  zoneId: string | null;
  fitment: Fitment;
  adas: AdasRequirement | null;
  genericHours: number | null;
  triggers: Trigger[];
  reasons: string[];
  /** Highest confidence among the triggering zones (1 for global deployment rules, scaled by overall confidence). */
  confidence: number;
  source: 'ai_estimate';
  verified: false;
}

export interface NotApplicableItem {
  key: string;
  label: string;
  ruleId: string;
  reason: string;
}

export interface KnockOnExpansion {
  suggestions: KnockOnSuggestion[];
  /** Feature-dependent items left out because the vehicle's recorded features do not include them. */
  notApplicable: NotApplicableItem[];
}

export interface RecommendedCheck {
  key: string;
  check: CheckKind;
  label: string;
  priority: CheckPriority;
  adas: AdasRequirement | null;
  fitment: Fitment;
  genericHours: number | null;
  triggers: Trigger[];
  reasons: string[];
  source: 'ai_estimate';
  verified: false;
}

export interface ConsistencyFinding {
  ruleId: string;
  kind: ConsistencyRuleKind;
  /** Always a point for the engineer to consider — never a conclusion. */
  level: 'consider';
  message: string;
  zoneIds: string[];
}

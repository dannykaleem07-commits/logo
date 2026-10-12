// Smart intake — case bundles (docs/SMART-INTAKE.md §4). Pure modules; the API's bundle engine composes them.
export * from './types.js';
export * from './settings.js';
export { classifyText, scoreText, topTypeOf, DVLA_LICENCE_RE, RULES_MAX_CONFIDENCE, type ClassifyOptions, type ClassifyResult } from './classify.js';
export { ruleExtract, ruleDocumentDate, ruleDocSide, postcodesIn, RULE_FIELD_NAMES, RULE_FIELD_NAME_LIST, type RuleExtractOptions } from './ruleExtract.js';
export { keysFromCandidates, normaliseKeyValue, personKey, KEY_STRENGTH, EMPTY_STOP_LIST, type KeyKind, type KeyStrength, type KeyRole, type FileKey, type FileKeys, type StopList, type KeyExtras } from './keys.js';
export { groupFiles, nextCaseKey, type ClaimKeyIndex, type GroupingInput, type GroupingResult } from './group.js';
export { sourceRank, rankWhy, SOURCE_RANKS, ENGINE_ORDER, DOC_TYPE_PLAIN, OWNER_RANK } from './ranking.js';
export { compatible, type CompatResult } from './compat.js';
// `reconcile` / `ReconcileResult` are taken by the estimate module: exported under bundle names.
export { reconcile as reconcileBundle, preselectedChoices, ownerSource, type ReconcileInput as BundleReconcileInput, type ReconcileResult as BundleReconcileResult, type WitnessReading } from './reconcile.js';
export { buildChecklist, caseKindOf, requestEmailText, CHECKLIST_LABELS, type ChecklistInput } from './checklist.js';
export { proposeTimeline, timelineId, TIMELINE_EVENT_CLASS, TIMELINE_EVENT_TYPES, TIMELINE_EVENT_LABEL, type AiTimelineItem, type TimelineFile, type TimelineInput } from './timeline.js';
export { riskSignals, signalId, SIGNAL_TEXT, type SignalsInput } from './signals.js';
export { toGray, areaResize, dHash64, hamming } from './phash.js';
export { findDuplicates, jaccard, type DupInput, type DupResult, type DupKind } from './duplicates.js';
export { splitPages, validateSegments, pageOfTotal, headerKeyOf, type PageSignal, type Segment } from './split.js';
export { plateMatches, distanceKm, gpsOutliers, zonesFromEstimateText, damageMapFromObservations, isDamageScene } from './photo.js';
export { registrable, type RegistrableInput } from './registrable.js';
export { caseSummaryTemplate, verifySummary, type SummaryInput } from './briefText.js';
export { parseLooseDate as parseIntakeDate, parseLooseTime, findDateTime, londonDayOf, daysBetween, displayPlate, isPlate, normVrm, sha1Hex } from './text.js';
// The claim damage model's zone taxonomy (engineering/panels.ts) for photo zones and estimate lines.
export { VEHICLE_ZONES, isZoneId, getZone, zoneForPanelName, type VehicleZone, type VehicleBodyType } from '../../engineering/panels.js';

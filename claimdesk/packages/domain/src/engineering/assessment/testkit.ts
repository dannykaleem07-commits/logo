/**
 * Test helpers for the assessment module (used by *.test.ts only): load the kb rule sets from disk and build results.
 * The kb package depends on domain, so domain reads the JSON by path rather than importing @ccguk/kb.
 */
import { readFileSync } from 'node:fs';
import type { DamageSeverity, ZoneOperation } from '../panels.js';
import type { AssessmentResult, AssessmentZone, CheckRuleSet, ConsistencyRuleSet, DamageType, KnockOnRuleSet, PhotoAssessment } from './types.js';

const KB_ENGINEERING = new URL('../../../../kb/data/engineering/', import.meta.url);
const KB_CATALOGUE = new URL('../../../../kb/data/vehicle-catalogue/', import.meta.url);

export function readKbJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(new URL(file, KB_ENGINEERING), 'utf8')) as T;
}
export const loadKnockOnRules = (): KnockOnRuleSet => readKbJson<KnockOnRuleSet>('knock-on-parts.json');
export const loadCheckRules = (): CheckRuleSet => readKbJson<CheckRuleSet>('hidden-damage-checks.json');
export const loadConsistencyRules = (): ConsistencyRuleSet => readKbJson<ConsistencyRuleSet>('consistency-rules.json');

/** Every feature id in the vehicle catalogue's features.json. */
export function catalogueFeatureIds(): Set<string> {
  const f = JSON.parse(readFileSync(new URL('features.json', KB_CATALOGUE), 'utf8')) as { categories: Array<{ items: Array<{ id: string }> }> };
  return new Set(f.categories.flatMap((c) => c.items.map((i) => i.id)));
}

export function zone(zoneId: string, severity: DamageSeverity, operation: ZoneOperation | null = null, over: Partial<AssessmentZone> = {}): AssessmentZone {
  const damageTypes: DamageType[] = severity === 0 ? [] : severity >= 3 ? ['dent', 'tear'] : ['dent'];
  return { zoneId, damageTypes, severity, operation: severity === 0 ? null : operation, confidence: 0.8, photoRefs: ['p1'], reasons: [`${zoneId} visibly damaged`], preExistingSuspect: false, ...over };
}

export function photo(ref: string, view: PhotoAssessment['view'], over: Partial<PhotoAssessment> = {}): PhotoAssessment {
  return { ref, view, qualityIssues: [], usable: true, note: null, ...over };
}

export function result(zones: AssessmentZone[], over: Partial<AssessmentResult> = {}): AssessmentResult {
  return {
    promptVersion: '2026-10-07.1',
    zones,
    photos: [photo('p1', 'front'), photo('p2', 'front_right'), photo('p3', 'rear')],
    deploymentVisible: false,
    fluidLeakVisible: false,
    apparentImpactDirection: 'unknown',
    overallConfidence: 0.75,
    summary: 'Test assessment.',
    limitations: [],
    ...over
  };
}

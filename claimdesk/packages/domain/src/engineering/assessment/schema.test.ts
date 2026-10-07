import { describe, expect, it } from 'vitest';
import { compactSchemaBytes, strictSchemaProblems } from '../../agents/results.js';
import { VEHICLE_ZONES } from '../panels.js';
import { ASSESSMENT_RESULT_SCHEMA, ASSESSMENT_ZONE_IDS, normaliseAssessmentResult, scrubFigures } from './schema.js';
import { DAMAGE_TYPES } from './types.js';

type S = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('ASSESSMENT_RESULT_SCHEMA', () => {
  it('obeys the strict structured-output rules used by every agent schema', () => {
    expect(strictSchemaProblems(ASSESSMENT_RESULT_SCHEMA)).toEqual([]);
  });
  it('is small enough to pass on the CLI command line (< 16 KB compact)', () => {
    expect(compactSchemaBytes(ASSESSMENT_RESULT_SCHEMA)).toBeLessThan(16 * 1024);
  });
  it('enumerates exactly the taxonomy zone ids, the seven damage types and severities 0–3', () => {
    const zone = (ASSESSMENT_RESULT_SCHEMA as S).properties.zones.items as S;
    expect(zone.properties.zoneId.enum).toEqual(VEHICLE_ZONES.map((z) => z.id));
    expect(ASSESSMENT_ZONE_IDS).toHaveLength(VEHICLE_ZONES.length);
    expect(zone.properties.damageTypes.items.enum).toEqual(['dent', 'scratch', 'crack', 'tear', 'misalignment', 'missing', 'deployed']);
    expect(zone.properties.damageTypes.items.enum).toEqual([...DAMAGE_TYPES]);
    expect(zone.properties.severity.enum).toEqual([0, 1, 2, 3]);
    expect(zone.required).toEqual(['zoneId', 'damageTypes', 'severity', 'operation', 'confidence', 'photoRefs', 'reasons', 'preExistingSuspect']);
  });
  it('has no field for part numbers, prices or labour times', () => {
    const text = JSON.stringify(ASSESSMENT_RESULT_SCHEMA);
    expect(text).not.toMatch(/"(partNumber|price|pricePence|hours|labourHours)"/);
  });
});

describe('scrubFigures', () => {
  it('removes prices, part numbers and labour times and keeps ordinary words', () => {
    const r = scrubFigures('Bumper 5Q0807221 cracked, about £245.60 new, 1.5 hours to fit; 360 camera and A-pillar fine; 2019 model');
    expect(r.removed).toBe(true);
    expect(r.text).not.toMatch(/5Q0807221|245|1\.5 hours/);
    expect(r.text).toMatch(/360 camera and A-pillar fine; 2019 model/);
    expect(scrubFigures('Crease through the swage line of the O/S front door.')).toEqual({ text: 'Crease through the swage line of the O/S front door.', removed: false });
    expect(scrubFigures('costs 300 pounds').removed).toBe(true);
    expect(scrubFigures('part A2058850100 needed').text).toBe('part [removed] needed');
  });
});

describe('normaliseAssessmentResult', () => {
  const raw = {
    promptVersion: '2026-10-07.1',
    zones: [
      { zoneId: 'front_bumper', damageTypes: ['crack', 'scratch', 'scorch'], severity: 2, operation: 'replace', confidence: 0.9, photoRefs: ['p1', 'p9'], reasons: ['Cracked lower edge, part 5Q0807221 £245'], preExistingSuspect: false },
      { zoneId: 'front_bumper', damageTypes: ['dent'], severity: 3, operation: 'replace', confidence: 0.6, photoRefs: ['p2'], reasons: ['Pushed in at centre'], preExistingSuspect: true },
      { zoneId: 'bonnet', damageTypes: ['dent'], severity: 7, operation: 'polish', confidence: 1.4, photoRefs: ['p1'], reasons: [], preExistingSuspect: false },
      { zoneId: 'flux_capacitor', damageTypes: ['dent'], severity: 1, operation: 'repair', confidence: 0.5, photoRefs: [], reasons: [], preExistingSuspect: false },
      { zoneId: 'grille', damageTypes: [], severity: 0, operation: 'replace', confidence: 0.7, photoRefs: [], reasons: [], preExistingSuspect: false },
      { zoneId: 'headlamp_r', damageTypes: ['crack'], severity: 2, operation: null, confidence: -0.2, photoRefs: [], reasons: ['Lens cracked'], preExistingSuspect: false },
      { zoneId: 'tailgate', damageTypes: ['dent'], severity: 1, operation: 'repair', confidence: 0.5, photoRefs: ['p3'], reasons: [], preExistingSuspect: false },
      { zoneId: 'rear_door_l', damageTypes: ['scratch'], severity: 1, operation: 'paint', confidence: 0.5, photoRefs: ['p3'], reasons: [], preExistingSuspect: false },
      { zoneId: 'airbags', damageTypes: ['deployed'], severity: 3, operation: 'repair', confidence: 0.9, photoRefs: ['p2'], reasons: [], preExistingSuspect: false }
    ],
    photos: [
      { ref: 'p1', view: 'front', qualityIssues: ['blurred', 'sepia'], usable: true, note: null },
      { ref: 'p2', view: 'sideways', qualityIssues: [], usable: true, note: 'Interior, £50 of trim' },
      { ref: 'p3', view: 'rear', qualityIssues: [], usable: false, note: null },
      { ref: 'p1', view: 'front', qualityIssues: [], usable: true, note: null },
      { ref: 'zz', view: 'rear', qualityIssues: [], usable: true, note: null }
    ],
    deploymentVisible: true,
    fluidLeakVisible: 'yes',
    apparentImpactDirection: 'sideways',
    overallConfidence: 0.8,
    summary: 'Front end damage. Bumper 5Q0807221 about £245.',
    limitations: ['Underside not shown']
  };
  const { result, issues } = normaliseAssessmentResult(raw, { bodyType: 'saloon', photoRefs: ['p1', 'p2', 'p3'], promptVersion: '2026-10-07.1' });
  const codes = issues.map((i) => i.code);
  const z = (id: string) => result.zones.find((x) => x.zoneId === id);

  it('drops unknown zones and unknown damage types', () => {
    expect(z('flux_capacitor')).toBeUndefined();
    expect(codes).toContain('unknown_zone');
    expect(z('front_bumper')!.damageTypes).not.toContain('scorch');
    expect(codes).toContain('damage_type_dropped');
  });
  it('merges duplicate zones keeping the heavier entry and the union of evidence', () => {
    const fb = z('front_bumper')!;
    expect(fb.severity).toBe(3);
    expect(fb.confidence).toBe(0.9);
    expect(fb.photoRefs).toEqual(['p1', 'p2']);
    expect(fb.damageTypes).toEqual(expect.arrayContaining(['crack', 'scratch', 'dent']));
    expect(fb.preExistingSuspect).toBe(true);
    expect(codes).toContain('duplicate_zone_merged');
  });
  it('clamps severity and confidence and replaces an untypical operation', () => {
    const b = z('bonnet')!;
    expect(b.severity).toBe(3);
    expect(b.confidence).toBe(1);
    expect(b.operation).toBe('replace'); // heavy panel → replace
    expect(z('headlamp_r')!.confidence).toBe(0);
    expect(z('headlamp_r')!.operation).toBe('replace'); // lamps: replace
    expect(codes).toEqual(expect.arrayContaining(['severity_clamped', 'confidence_clamped', 'operation_adjusted']));
  });
  it('a deployed airbag is replaced, never repaired', () => {
    expect(z('airbags')!.operation).toBe('replace');
  });
  it('clears the operation on undamaged zones', () => {
    expect(z('grille')!.operation).toBeNull();
    expect(codes).toContain('operation_cleared');
  });
  it('maps zones across body types (tailgate on a saloon is the boot lid) and drops zones the body lacks', () => {
    expect(z('tailgate')).toBeUndefined();
    expect(z('boot_lid')?.severity).toBe(1);
    expect(codes).toContain('zone_mapped_to_body');
    const coupe = normaliseAssessmentResult({ zones: [{ zoneId: 'rear_door_l', damageTypes: ['dent'], severity: 2, operation: 'repair', confidence: 0.7, photoRefs: [], reasons: [], preExistingSuspect: false }] }, { bodyType: 'coupe' });
    expect(coupe.result.zones).toEqual([]);
    expect(coupe.issues.map((i) => i.code)).toContain('zone_not_on_body');
  });
  it('drops photo references that were not supplied and flags damage without a photo', () => {
    expect(z('front_bumper')!.photoRefs).not.toContain('p9');
    expect(codes).toContain('unknown_photo_ref');
    expect(issues.some((i) => i.code === 'no_photo_reference' && i.zoneId === 'headlamp_r')).toBe(true);
  });
  it('strips prices and part numbers from reasons, notes and the summary', () => {
    expect(z('front_bumper')!.reasons.join(' ')).not.toMatch(/5Q0807221|£/);
    expect(result.summary).not.toMatch(/5Q0807221|£/);
    expect(result.photos.find((p) => p.ref === 'p2')!.note).not.toMatch(/£/);
    expect(codes).toContain('price_or_part_number_removed');
  });
  it('cleans photos: de-duplicates, rejects unknown refs, views and quality issues', () => {
    expect(result.photos.map((p) => p.ref)).toEqual(['p1', 'p2', 'p3']);
    expect(result.photos[0]!.qualityIssues).toEqual(['blurred']);
    expect(result.photos[1]!.view).toBe('unknown');
    expect(result.photos[2]!.usable).toBe(false);
    expect(codes).toEqual(expect.arrayContaining(['unknown_photo_view', 'quality_issue_dropped']));
  });
  it('coerces flags and the direction, and sorts zones heaviest first', () => {
    expect(result.deploymentVisible).toBe(true);
    expect(result.fluidLeakVisible).toBe(false); // only literal true counts
    expect(result.apparentImpactDirection).toBe('unknown');
    const sev = result.zones.map((x) => x.severity);
    expect([...sev].sort((a, b) => b - a)).toEqual(sev);
  });
  it('never throws on garbage and reports the shape problem', () => {
    for (const bad of [null, 'text', 42, [], { zones: 'nope', photos: {} }]) {
      const n = normaliseAssessmentResult(bad);
      expect(n.result.zones).toEqual([]);
      expect(n.result.overallConfidence).toBe(0);
    }
    expect(normaliseAssessmentResult('x').issues[0]!.code).toBe('invalid_shape');
  });
  it('reports a prompt version mismatch', () => {
    const n = normaliseAssessmentResult({ promptVersion: 'old' }, { promptVersion: '2026-10-07.1' });
    expect(n.issues.map((i) => i.code)).toContain('prompt_version_mismatch');
  });
});

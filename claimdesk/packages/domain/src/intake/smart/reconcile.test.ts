import { describe, expect, it } from 'vitest';
import { compatible } from './compat.js';
import { rankWhy, sourceRank, SOURCE_RANKS } from './ranking.js';
import { preselectedChoices, reconcile } from './reconcile.js';
import { BUNDLE_FIELD_KEYS, type DecisionView } from './types.js';
import { cand } from './testHelpers.js';

const base = { decisions: [] as DecisionView[], minConflictConfidence: 0.5, lowConfidence: 0.75 };
const field = (r: ReturnType<typeof reconcile>, key: string) => r.fields.find((f) => f.key === key)!;
const dec = (kind: string, subject: string | null, after: unknown, at = '2026-10-08T10:00:00Z'): DecisionView => ({ id: `${kind}-${subject}-${at}`, kind, subject, before: null, after, note: null, actor: 'owner-1', at });

describe('ranking', () => {
  it('every bundle key has a rank table', () => {
    for (const k of BUNDLE_FIELD_KEYS) expect(SOURCE_RANKS[k]).toBeTruthy();
  });
  it('V5C > estimate for the VIN; licence > form for DOB; police > FNOL for the time', () => {
    expect(sourceRank('vehicle.vin', 'v5c', 'rules')).toBeGreaterThan(sourceRank('vehicle.vin', 'bodyshop_estimate', 'ai'));
    expect(sourceRank('client.dateOfBirth', 'driving_licence', 'ai')).toBeGreaterThan(sourceRank('client.dateOfBirth', 'fnol_form', 'ai'));
    expect(sourceRank('accident.occurredAt', 'police_report', 'rules')).toBeGreaterThan(sourceRank('accident.occurredAt', 'fnol_form', 'rules'));
    expect(sourceRank('accident.occurredAt', null, 'exif')).toBe(20);
    expect(sourceRank('client.name', null, 'name_hint')).toBe(10);
    expect(sourceRank('client.name', null, 'owner')).toBe(1000);
    expect(sourceRank('vehicle.vin', 'payslip', 'rules')).toBe(30);
  });
  it('explains the ranking in plain words', () => {
    expect(rankWhy('vehicle.vin', { docType: 'v5c', engine: 'rules' }, { docType: 'bodyshop_estimate', engine: 'ai' })).toBe('The V5C outranks the bodyshop estimate for the VIN');
  });
});

describe('compatible', () => {
  it('names: initials consistent → same, prefer the fuller', () => {
    expect(compatible('client.name', { value: 'J Doe' }, { value: 'Jane Doe' })).toMatchObject({ same: true, prefer: 'b' });
    expect(compatible('client.name', { value: 'Jane Mary Doe' }, { value: 'Jane Doe' })).toMatchObject({ same: true, prefer: 'a' });
    expect(compatible('client.name', { value: 'Jane Doe' }, { value: 'John Doe' }).same).toBe(false);
    expect(compatible('client.name', { value: 'Jane Doe' }, { value: 'Jane Smith' }).same).toBe(false);
  });
  it('date vs datetime on the same London day → same, prefer the datetime', () => {
    expect(compatible('accident.occurredAt', { value: '2026-10-07' }, { value: '2026-10-07T16:45:00.000Z' })).toMatchObject({ same: true, prefer: 'b' });
    expect(compatible('accident.occurredAt', { value: '2026-10-07T16:45:00.000Z' }, { value: '2026-10-07T16:40:00.000Z' }).same).toBe(false);
  });
  it('VRM and VIN: one character different is a conflict', () => {
    expect(compatible('vehicle.registration', { value: 'KX21 ABC' }, { value: 'KX21ABC' }).same).toBe(true);
    expect(compatible('vehicle.registration', { value: 'KX21 ABC' }, { value: 'KX21 ABD' }).same).toBe(false);
    expect(compatible('vehicle.vin', { value: 'WVWZZZ1KZAW000001' }, { value: 'WVWZZZ1KZAW000007' }).same).toBe(false);
  });
  it('addresses, phones, models', () => {
    expect(compatible('client.address', { value: '12 High Street, Reading, RG1 1AA' }, { value: '12 High Street, RG1 1AA' }).same).toBe(true);
    expect(compatible('client.address', { value: '12 High Street, RG1 1AA' }, { value: '12 High Street, RG2 1AA' }).same).toBe(false);
    expect(compatible('client.phone', { value: '07700 900123' }, { value: '+44 7700 900123' }).same).toBe(true);
    expect(compatible('vehicle.model', { value: 'Corsa' }, { value: 'Corsa SE' })).toMatchObject({ same: true, prefer: 'b' });
  });
});

describe('reconcile', () => {
  const vinV5c = cand('vehicle.vin', 'WVWZZZ1KZAW000001', 'v5c', 'v5c', { rank: 100, confidence: 0.8, page: 1, quote: 'VIN: WVWZZZ1KZAW000001' });
  const vinEst = cand('vehicle.vin', 'WVWZZZ1KZAW000007', 'est', 'bodyshop_estimate', { rank: 75, confidence: 0.9, engine: 'ai' });

  it('VIN V5C vs estimate → a conflict with the V5C preselected and the why', () => {
    const r = reconcile({ ...base, candidates: [vinEst, vinV5c] });
    const f = field(r, 'vehicle.vin');
    expect(f.status).toBe('conflict');
    expect(f.value).toBe('WVWZZZ1KZAW000001');
    expect(f.source).toMatchObject({ fileId: 'v5c', page: 1, quote: 'VIN: WVWZZZ1KZAW000001' });
    const c = r.conflicts[0]!;
    expect(c.id).toBe('c:vehicle.vin');
    expect(c.options[0]).toMatchObject({ value: 'WVWZZZ1KZAW000001', preselected: true, rank: 100 });
    expect(c.options[1]).toMatchObject({ value: 'WVWZZZ1KZAW000007', preselected: false });
    expect(c.why).toMatch(/V5C outranks the bodyshop estimate/);
    expect(c.status).toBe('open');
  });

  it('readings below 0.5 do not make a conflict (kept as alternatives)', () => {
    const r = reconcile({ ...base, candidates: [vinV5c, { ...vinEst, source: { ...vinEst.source, confidence: 0.4 } }] });
    expect(r.conflicts).toEqual([]);
    expect(field(r, 'vehicle.vin').alternatives[0]!.value).toBe('WVWZZZ1KZAW000007');
  });

  it('compatible readings merge; the fuller name is kept', () => {
    const r = reconcile({ ...base, candidates: [cand('client.name', 'J Doe', 'lic', 'driving_licence', { rank: 95 }), cand('client.name', 'Jane Doe', 'form', 'fnol_form', { rank: 70 })] });
    expect(r.conflicts).toEqual([]);
    expect(field(r, 'client.name')).toMatchObject({ value: 'Jane Doe', status: 'ok' });
  });

  it('the owner value wins and resolves the conflict; others stay as alternatives', () => {
    const r = reconcile({ ...base, candidates: [vinEst, vinV5c], decisions: [dec('set_field', 'vehicle.vin', { value: 'WVWZZZ1KZAW000009' })] });
    const f = field(r, 'vehicle.vin');
    expect(f).toMatchObject({ value: 'WVWZZZ1KZAW000009', status: 'owner_set' });
    expect(f.source!.engine).toBe('owner');
    expect(f.alternatives.map((a) => a.value)).toEqual(['WVWZZZ1KZAW000001', 'WVWZZZ1KZAW000007']);
    expect(r.conflicts[0]).toMatchObject({ status: 'resolved', resolvedBy: 'owner-1', chosenValue: 'WVWZZZ1KZAW000009' });
  });

  it('clear_field removes the owner value', () => {
    const r = reconcile({ ...base, candidates: [vinV5c], decisions: [dec('set_field', 'vehicle.vin', { value: 'X' }), dec('clear_field', 'vehicle.vin', null, '2026-10-08T11:00:00Z')] });
    expect(field(r, 'vehicle.vin').value).toBe('WVWZZZ1KZAW000001');
  });

  it('choose_conflict resolves with the chosen option; accept_preselected records each value', () => {
    let r = reconcile({ ...base, candidates: [vinEst, vinV5c], decisions: [dec('choose_conflict', 'c:vehicle.vin', { value: 'WVWZZZ1KZAW000007' })] });
    expect(field(r, 'vehicle.vin')).toMatchObject({ value: 'WVWZZZ1KZAW000007', status: 'ok' });
    expect(r.conflicts[0]!.status).toBe('resolved');
    const open = reconcile({ ...base, candidates: [vinEst, vinV5c] });
    const choices = preselectedChoices(open.conflicts);
    expect(choices).toEqual([{ id: 'c:vehicle.vin', value: 'WVWZZZ1KZAW000001' }]);
    r = reconcile({ ...base, candidates: [vinEst, vinV5c], decisions: [dec('accept_preselected', null, { conflicts: choices })] });
    expect(field(r, 'vehicle.vin')).toMatchObject({ value: 'WVWZZZ1KZAW000001', status: 'ok' });
  });

  it('a conflict that appears after "accept all" stays open', () => {
    const r = reconcile({ ...base, candidates: [vinEst, vinV5c, cand('client.dateOfBirth', '1990-03-12', 'lic', 'driving_licence', { rank: 100 }), cand('client.dateOfBirth', '1990-12-03', 'form', 'fnol_form', { rank: 50 })], decisions: [dec('accept_preselected', null, { conflicts: [{ id: 'c:vehicle.vin', value: 'WVWZZZ1KZAW000001' }] })] });
    expect(r.conflicts.find((c) => c.key === 'client.dateOfBirth')!.status).toBe('open');
    expect(field(r, 'client.dateOfBirth').value).toBe('1990-03-12');
  });

  it('low confidence, missing and invalid statuses', () => {
    const r = reconcile({ ...base, candidates: [cand('client.phone', '07700900123', 'f', 'fnol_form', { confidence: 0.6 }), cand('vehicle.registration', 'ZZ99', 'f', 'fnol_form', { validatorOk: false })] });
    expect(field(r, 'client.phone').status).toBe('low_confidence');
    expect(field(r, 'client.email').status).toBe('missing');
    expect(field(r, 'vehicle.registration')).toMatchObject({ status: 'invalid', value: null });
    expect(field(r, 'vehicle.registration').alternatives[0]!.value).toBe('ZZ99');
  });

  it('the AI reasoning never resolves a conflict; its why shows on the option', () => {
    const ai = { ...cand('vehicle.vin', 'WVWZZZ1KZAW000007', 'est', 'bodyshop_estimate', { rank: 75, engine: 'ai_reasoning' }), aiWhy: 'the estimate is newer' };
    const r = reconcile({ ...base, candidates: [vinEst, vinV5c, ai] });
    expect(r.conflicts[0]!.status).toBe('open');
    expect(r.conflicts[0]!.options[1]!.aiWhy).toBe('the estimate is newer');
  });

  it('circumstances attribution: client form vs police report', () => {
    const r = reconcile({ ...base, candidates: [cand('accident.circumstances', 'Vehicle 2 struck vehicle 1 from behind at the lights.', 'pol', 'police_report', { rank: 70, confidence: 0.4 })] });
    expect(r.circumstances.attribution).toBe('police');
    expect(field(r, 'accident.circumstances').note).toMatch(/not the client’s own account/);
    const r2 = reconcile({ ...base, candidates: [cand('accident.circumstances', 'I was waiting at the lights when the other car hit me.', 'form', 'fnol_form', { rank: 100 })] });
    expect(r2.circumstances.attribution).toBe('client');
  });

  it('witnesses: merged by name; answered when the client wrote "none" or names', () => {
    const src = cand('client.name', 'x', 'form', 'fnol_form').source;
    const r = reconcile({ ...base, candidates: [], witnessReadings: [{ witnesses: 'none', source: src, clientAuthored: true }] });
    expect(r.witnessesAnswered).toBe(true);
    expect(r.witnesses).toEqual([]);
    const r2 = reconcile({ ...base, candidates: [], witnessReadings: [{ witnesses: [{ name: 'Pat Witness', phone: null, relationship: null, source: null }], source: src, clientAuthored: false }, { witnesses: [{ name: 'pat witness', phone: '07700900999', relationship: 'none', source: null }], source: src, clientAuthored: false }] });
    expect(r2.witnessesAnswered).toBe(false);
    expect(r2.witnesses).toHaveLength(1);
    expect(r2.witnesses[0]).toMatchObject({ name: 'Pat Witness', phone: '07700900999', relationship: 'none' });
    const r3 = reconcile({ ...base, candidates: [], decisions: [dec('set_field', 'witnesses', { witnesses: [{ name: 'Sam', relationship: 'friend' }], answered: true })] });
    expect(r3.witnesses[0]).toMatchObject({ name: 'Sam', relationship: 'friend' });
  });

  it('lists every bundle key once', () => {
    const r = reconcile({ ...base, candidates: [] });
    expect(r.fields.map((f) => f.key)).toEqual([...BUNDLE_FIELD_KEYS]);
    expect(field(r, 'client.name')).toMatchObject({ required: true, keyField: true, section: 'client' });
    expect(field(r, 'client.dateOfBirth').sensitive).toBe(true);
  });
});

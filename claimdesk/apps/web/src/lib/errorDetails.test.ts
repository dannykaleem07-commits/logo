import { describe, expect, it } from 'vitest';
import { describeErrorDetails } from './errorDetails';

describe('describeErrorDetails', () => {
  it('lists allocation reasons', () => {
    expect(describeErrorDetails('ALLOCATION_REFUSED', { reasons: ['MOT expired on 2026-09-30', 'Status is off_road'] })).toEqual(['MOT expired on 2026-09-30', 'Status is off_road']);
  });
  it('lists hard-stop and document flags by message (code when no message)', () => {
    expect(describeErrorDetails('HARD_STOP', { flags: [{ code: 'FLEET_UNIT_AS_CLIENT_VEHICLE', message: 'Fleet unit entered as the client vehicle' }, { code: 'OTHER' }] })).toEqual(['Fleet unit entered as the client vehicle', 'OTHER']);
  });
  it('lists missing checklist items and FNOL field errors', () => {
    expect(describeErrorDetails('CHECKLIST_INCOMPLETE', { missing: ['Engineer identity', 'Missing: salvage category'] })).toEqual(['Missing: Engineer identity', 'Missing: salvage category']);
    expect(describeErrorDetails('FNOL_INCOMPLETE', { errors: [{ field: 'clientInsurer', message: 'required' }], incomplete: [{ field: 'third_party.registration', message: 'not asked' }] })).toEqual(['clientInsurer: required', 'third party.registration: not asked']);
  });
  it('lists Word-template issues', () => {
    expect(describeErrorDetails('GUARD_BLOCKED', { issues: [{ code: 'PRINTED_RATES_DIFFER', message: 'Printed rates differ from the hire' }, { message: 'Reference doubled' }] })).toEqual(['Printed rates differ from the hire', 'Reference doubled']);
  });
  it('turns zod issues into "path: message"', () => {
    expect(describeErrorDetails('VALIDATION', [{ path: 'accident.location', message: 'Required', code: 'too_small' }, { path: ['vehicle', 'registration'], message: 'Too long' }, { path: '', message: 'Bad body' }])).toEqual(['accident.location: Required', 'vehicle.registration: Too long', 'Bad body']);
  });
  it('describes hire overlaps', () => {
    const lines = describeErrorDetails('HIRE_OVERLAP', { overlaps: [{ agreementNumber: 'HA-0007', startAt: '2026-09-01T09:00:00Z', endAt: '2026-09-05T17:00:00Z', claimReference: 'CCG-2026-00003' }, { agreementNumber: 'HA-0009', startAt: '2026-09-10T09:00:00Z' }] });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^HA-0007 on CCG-2026-00003 from .*2026.* to .*2026/);
    expect(lines[1]).toMatch(/^HA-0009 from .* \(still on hire\)$/);
  });
  it('lists relaxed rule keys', () => {
    expect(describeErrorDetails('WEB_VALIDATION', { rules: ['fnol.claimant.contact'] })).toEqual(['Relaxed: fnol.claimant.contact']);
  });
  it('gives nothing for unknown shapes (never "[object Object]")', () => {
    expect(describeErrorDetails('X', undefined)).toEqual([]);
    expect(describeErrorDetails('X', null)).toEqual([]);
    expect(describeErrorDetails('X', 'text')).toEqual([]);
    expect(describeErrorDetails('NOT_FOUND', { entity: 'claims', id: 'x' })).toEqual([]);
    expect(describeErrorDetails('X', { reasons: [{ nested: true }], flags: 'no' })).toEqual([]);
  });
  it('de-duplicates and caps the list', () => {
    expect(describeErrorDetails('X', { reasons: ['a', 'a'] })).toEqual(['a']);
    expect(describeErrorDetails('X', { reasons: Array.from({ length: 50 }, (_, i) => `r${i}`) })).toHaveLength(30);
  });
});

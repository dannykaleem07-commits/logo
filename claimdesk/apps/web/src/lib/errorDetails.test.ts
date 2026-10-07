import { describe, expect, it } from 'vitest';
import { describeErrorDetails, uploadErrorLines } from './errorDetails';

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

describe('upload refusals in plain English', () => {
  it('FILE_TOO_LARGE names the limit and the way round it', () => {
    const lines = describeErrorDetails('FILE_TOO_LARGE', { limitBytes: 25 * 1024 * 1024, useChunked: true });
    expect(lines[0]).toBe('The file is too large: the most one upload can take is 25 MB.');
    expect(lines[1]).toMatch(/sends big files in parts/);
    expect(describeErrorDetails('FILE_TOO_LARGE', { limitBytes: 2048 * 1024 * 1024, useImportFolder: true })).toEqual([
      'The file is too large: the most one upload can take is 2 GB.',
      'Put the file in the ClaimDesk import folder instead (Settings → Import folder) — any size works there.',
    ]);
    expect(describeErrorDetails('FILE_TOO_LARGE', undefined)).toEqual(['The file is too large for one upload.']);
    expect(uploadErrorLines('FILE_TOO_LARGE', { limitBytes: 9 * 1024 * 1024, chunk: true })[0]).toBe('The file is too large: one part can be at most 9 MB.');
  });
  it('OFFSET_MISMATCH and INSUFFICIENT_STORAGE', () => {
    expect(describeErrorDetails('OFFSET_MISMATCH', { receivedBytes: 4 * 1024 * 1024 })).toEqual(['The upload got out of step with ClaimDesk (it has 4 MB so far). Try again — it carries on from where it stopped.']);
    expect(describeErrorDetails('INSUFFICIENT_STORAGE', { needBytes: 3.3 * 1024 ** 3, freeBytes: 1.2 * 1024 ** 3 })).toEqual(['This computer does not have enough free disk space for the file (3.3 GB needed, 1.2 GB free). Free some space and try again.']);
  });
  it('dropped and unfinished uploads', () => {
    expect(describeErrorDetails('UPLOAD_ABORTED', undefined)[0]).toMatch(/Nothing was stored/);
    expect(describeErrorDetails('UPLOAD_INCOMPLETE', { receivedBytes: 1, bytes: 2 })[0]).toMatch(/carries on/);
  });
});

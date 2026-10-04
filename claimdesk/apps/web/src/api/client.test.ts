import { describe, expect, it } from 'vitest';
import type { Vehicle } from '@ccguk/domain';
import { ApiError, asList, buildUrl, isApiError, normaliseCreateClaimResult, normaliseLookupResult, seg, unwrap } from './client';

describe('buildUrl', () => {
  it('prefixes the base and skips empty query values', () => {
    expect(buildUrl('/claims')).toBe('/api/claims');
    expect(buildUrl('claims')).toBe('/api/claims');
    expect(buildUrl('/claims', { q: 'AB12CDE', status: undefined, handlerId: null, insurerId: '' })).toBe('/api/claims?q=AB12CDE');
  });
  it('encodes values and keeps insertion order', () => {
    expect(buildUrl('/kb/search', { q: 'credit hire & impecuniosity', type: 'case', limit: 10 })).toBe('/api/kb/search?q=credit+hire+%26+impecuniosity&type=case&limit=10');
    expect(buildUrl('/kb/gta-rates', { date: '2026-10-04' })).toBe('/api/kb/gta-rates?date=2026-10-04');
  });
  it('serialises booleans and numbers', () => {
    expect(buildUrl('/x', { a: true, b: 0 })).toBe('/api/x?a=true&b=0');
  });
  it('accepts a custom base', () => {
    expect(buildUrl('/health', undefined, 'http://localhost:4000/api')).toBe('http://localhost:4000/api/health');
  });
});

describe('seg', () => {
  it('encodes path segments', () => {
    expect(seg('CCG-2026-00012')).toBe('CCG-2026-00012');
    expect(seg('a/b c')).toBe('a%2Fb%20c');
    expect(buildUrl(`/claims/${seg('id with space')}/clocks`)).toBe('/api/claims/id%20with%20space/clocks');
  });
});

describe('asList', () => {
  it('normalises arrays and wrapped collections', () => {
    expect(asList([1, 2])).toEqual([1, 2]);
    expect(asList({ items: [1] })).toEqual([1]);
    expect(asList({ data: [2] })).toEqual([2]);
    expect(asList({ claims: [3] })).toEqual([3]);
    expect(asList({ total: 0 })).toEqual([]);
    expect(asList(null)).toEqual([]);
    expect(asList('nope')).toEqual([]);
  });
});

describe('ApiError', () => {
  it('carries status, code and flags', () => {
    const e = new ApiError(404, 'NOT_FOUND', 'Claim not found', '/api/claims/x', { id: 'x' });
    expect(isApiError(e)).toBe(true);
    expect(e.isNotFound).toBe(true);
    expect(e.isNetwork).toBe(false);
    expect(e.details).toEqual({ id: 'x' });
    expect(new ApiError(0, 'NETWORK', 'down', '/api/health').isNetwork).toBe(true);
    expect(isApiError(new Error('x'))).toBe(false);
  });
});

describe('normaliseCreateClaimResult (POST /claims)', () => {
  const claim = { id: 'c1', reference: 'CCG-2026-00001', status: 'fnol', flags: [] };
  it('accepts { claim, intake }, { ...claim, intake } and the bare claim', () => {
    const intake = { flags: [{ code: 'DUPLICATE_REGISTRATION', severity: 'warn' }], offer: { id: 'o1', replyDueBy: '2026-10-05T17:00:00Z' } };
    expect(normaliseCreateClaimResult({ claim, intake })).toEqual({ claim, intake });
    expect(normaliseCreateClaimResult({ ...claim, intake })).toEqual({ claim, intake });
    expect(normaliseCreateClaimResult(claim)).toEqual({ claim, intake: undefined });
  });
  it('refuses a body without a claim (so the wizard never navigates to /claims/undefined)', () => {
    expect(() => normaliseCreateClaimResult({ ok: true })).toThrow(ApiError);
    expect(() => normaliseCreateClaimResult(null)).toThrow(ApiError);
  });
});

describe('normaliseLookupResult (POST /vehicles/lookup)', () => {
  const vehicle = {
    id: 'v1',
    registration: 'AB12CDE',
    make: 'VOLKSWAGEN',
    model: 'GOLF',
    ownership: 'client',
    odometer: [],
    motHistory: [{ completedDate: '2026-03-01', result: 'PASSED', odometerMiles: 49980, defects: [] }],
    lookups: [
      { id: 'l-old', provider: 'dvla_ves', kind: 'vehicle', requestedAt: '2026-01-01T00:00:00Z', requestedBy: 'u', raw: {}, verification: { status: 'verified' } },
      { id: 'l-ves', provider: 'dvla_ves', kind: 'vehicle', requestedAt: '2026-10-04T09:00:00Z', requestedBy: 'u', raw: {}, verification: { status: 'verified' } },
      { id: 'l-mot', provider: 'dvsa_mot', kind: 'mot', requestedAt: '2026-10-04T09:00:00Z', requestedBy: 'u', raw: {}, verification: { status: 'verified' } }
    ],
    createdAt: '2026-10-04T09:00:00Z'
  } as unknown as Vehicle;
  it('maps ok → ok with the latest VES/MOT records and the linked claims passed in', () => {
    const r = normaliseLookupResult({ status: 'ok', registration: 'AB12CDE', vehicle, providers: { dvla_ves: 'ok', dvsa_mot: 'ok' }, lookupIds: ['l-ves', 'l-mot'] }, 'AB12CDE', [{ claimId: 'c9', reference: 'CCG-2026-00009', status: 'hire_active', relation: 'same_registration' }]);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.vehicle.id).toBe('v1');
    expect(r.ves?.id).toBe('l-ves');
    expect(r.mot?.id).toBe('l-mot');
    expect(r.motHistory).toHaveLength(1);
    expect(r.linkedClaims?.[0]?.reference).toBe('CCG-2026-00009');
    expect(r.fleetUnit).toBeNull();
    expect(r.warnings).toEqual([]);
  });
  it('maps partial → ok with a warning per failed provider', () => {
    const r = normaliseLookupResult({ status: 'partial', registration: 'AB12CDE', vehicle, providers: { dvla_ves: 'ok', dvsa_mot: 'no_key' } }, 'AB12CDE');
    expect(r.status).toBe('ok');
    expect(r.warnings).toEqual(['Partial lookup — one provider did not answer.', 'DVSA MOT history: no API key configured']);
  });
  it('maps manual_required → reason from the providers and the vehicle already on file as partial', () => {
    const r = normaliseLookupResult({ status: 'manual_required', registration: 'AB12CDE', fields: ['make'], providers: { dvla_ves: 'no_key', dvsa_mot: 'http_404' }, vehicle }, 'AB12CDE');
    expect(r.status).toBe('manual_required');
    if (r.status !== 'manual_required') throw new Error('expected manual_required');
    expect(r.reason).toBe('DVLA VES: no API key configured; DVSA MOT history: HTTP 404');
    expect(r.partial?.id).toBe('v1');
    const bare = normaliseLookupResult({ status: 'manual_required', registration: 'AB12CDE' }, 'AB12CDE');
    expect(bare.status === 'manual_required' && bare.reason).toMatch(/did not return/);
  });
  it('raises the fleet hard stop when the registration is a fleet unit (lessons f, h)', () => {
    const r = normaliseLookupResult({ status: 'ok', registration: 'AB12CDE', vehicle: { ...vehicle, ownership: 'fleet' } }, 'AB12CDE');
    expect(r.fleetUnit).toEqual({ id: 'v1', registration: 'AB12CDE' });
  });
  it('passes a reply already in the web shape straight through', () => {
    const web = { status: 'ok' as const, registration: 'AB12CDE', vehicle: { registration: 'AB12CDE' }, ves: undefined, linkedClaims: [] };
    expect(normaliseLookupResult(web, 'AB12CDE')).toBe(web);
  });
});

describe('unwrap (enveloped write replies)', () => {
  it('returns the named entity or the body itself', () => {
    expect(unwrap({ event: { id: 'e1' }, effects: [], clocks: [] }, 'event')).toEqual({ id: 'e1' });
    expect(unwrap({ offer: { id: 'o1' }, replyClock: undefined }, 'offer')).toEqual({ id: 'o1' });
    expect(unwrap({ id: 'h1', startAt: 'x' }, 'hire')).toEqual({ id: 'h1', startAt: 'x' });
    expect(unwrap([1], 'event')).toEqual([1]);
  });
});

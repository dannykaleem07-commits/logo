import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vehicle } from '@ccguk/domain';
import {
  ApiError,
  asList,
  buildUrl,
  isApiError,
  normaliseCreateClaimResult,
  normaliseLookupResult,
  onManagerOverrides,
  parseAppliedOverrides,
  parseOverrideInfo,
  relaxedKeysOf,
  request,
  seg,
  setManagerModeReactivator,
  setManagerOverrideReason,
  setOverridePromptHandler,
  unwrap,
  withRelaxed,
  type AppliedOverrideNotice,
  type OverrideInfo
} from './client';

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

// ---------------------------------------------------------------------------
// Manager mode in request() (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.5.1)
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const HARD_STOP: OverrideInfo = { code: 'HARD_STOP', class: 'A', label: 'Uncleared hard-stop flag on the claim', warning: 'The flag stays on the file until someone clears it with a reason.', allowed: true, managerMode: 'off' };
const refusal = (override?: OverrideInfo) => json(409, { error: { code: 'HARD_STOP', message: 'Claim has an uncleared hard stop', details: { flags: [{ code: 'FLEET_UNIT_AS_CLIENT_VEHICLE', message: 'Fleet unit' }] }, requestId: 'r1', ...(override ? { override } : {}) } });

describe('request() in manager mode', () => {
  let calls: Call[];
  let replies: Array<() => Response>;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    calls = [];
    replies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: String(init.method), headers: { ...(init.headers as Record<string, string>) }, body: init.body });
        const next = replies.shift();
        if (!next) throw new Error(`unexpected fetch ${String(init.method)} ${url}`);
        return next();
      })
    );
  });
  afterEach(() => {
    setManagerOverrideReason(null);
    while (cleanups.length) cleanups.pop()!();
    vi.unstubAllGlobals();
  });

  it('sends X-Manager-Override on non-GET requests only while manager mode is on', async () => {
    replies.push(() => json(200, { ok: true }), () => json(200, { ok: true }), () => json(200, { ok: true }), () => json(200, { ok: true }));
    await request('/claims/c1/status', { method: 'POST', body: { status: 'accepted' } });
    setManagerOverrideReason('Agent forgot — backdated');
    await request('/claims/c1/status', { method: 'POST', body: { status: 'accepted' } });
    await request('/claims', { method: 'GET' });
    await request('/fleet/u1', { method: 'DELETE' });
    expect(calls[0]!.headers['X-Manager-Override']).toBeUndefined();
    expect(calls[1]!.headers['X-Manager-Override']).toBe(encodeURIComponent('Agent forgot — backdated'));
    expect(calls[2]!.headers['X-Manager-Override']).toBeUndefined();
    expect(calls[3]!.headers['X-Manager-Override']).toBe(encodeURIComponent('Agent forgot — backdated'));
  });

  it('withRelaxed keys travel as X-Manager-Relaxed only while on, and never in the JSON body', async () => {
    const body = withRelaxed({ status: 'pre_action' }, ['status.reason', 'fnol.claimant.contact']);
    expect(relaxedKeysOf(body)).toEqual(['status.reason', 'fnol.claimant.contact']);
    expect(JSON.stringify(body)).toBe('{"status":"pre_action"}');
    replies.push(() => json(200, {}), () => json(200, {}));
    await request('/claims/c1/status', { method: 'POST', body });
    setManagerOverrideReason('Manager override');
    await request('/claims/c1/status', { method: 'POST', body });
    expect(calls[0]!.headers['X-Manager-Relaxed']).toBeUndefined();
    expect(calls[1]!.headers['X-Manager-Relaxed']).toBe(encodeURIComponent('status.reason,fnol.claimant.contact'));
    expect(calls[1]!.body).toBe('{"status":"pre_action"}');
  });

  it('passes the x-manager-overrides response header to the listeners', async () => {
    const seen: AppliedOverrideNotice[][] = [];
    cleanups.push(onManagerOverrides((a) => seen.push(a)));
    const applied = [{ code: 'HARD_STOP', label: 'Uncleared hard-stop flag on the claim', reason: 'Manager override' }];
    replies.push(() => json(200, { id: 'c1' }, { 'x-manager-overrides': encodeURIComponent(JSON.stringify(applied)) }), () => json(200, { id: 'c1' }));
    setManagerOverrideReason('Manager override');
    await expect(request('/claims/c1/status', { method: 'POST', body: {} })).resolves.toEqual({ id: 'c1' });
    await request('/claims/c1/status', { method: 'POST', body: {} });
    expect(seen).toEqual([applied]);
  });

  it('parses ApiError.override from the error body', async () => {
    replies.push(() => refusal(HARD_STOP));
    const err = await request('/claims/c1/status', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    expect((err as ApiError).override).toEqual(HARD_STOP);
    expect((err as ApiError).details).toEqual({ flags: [{ code: 'FLEET_UNIT_AS_CLIENT_VEHICLE', message: 'Fleet unit' }] });
    expect(parseOverrideInfo({ code: 'X' })).toBeUndefined();
    expect(parseOverrideInfo({ code: 'X', label: 'L', allowed: false, class: 'B', managerMode: 'on', warning: '' })).toEqual({ code: 'X', label: 'L', allowed: false, class: 'B', managerMode: 'on' });
  });

  it('prompt → override re-sends the same request once and resolves the caller', async () => {
    const asked: ApiError[] = [];
    cleanups.push(
      setOverridePromptHandler(async (e) => {
        asked.push(e);
        setManagerOverrideReason('Customer waiting'); // what the provider does when it turns manager mode on
        return { action: 'override', reason: 'Customer waiting' };
      })
    );
    replies.push(() => refusal(HARD_STOP), () => json(200, { status: 'accepted' }));
    await expect(request('/claims/c1/status', { method: 'POST', body: { status: 'accepted' } })).resolves.toEqual({ status: 'accepted' });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.override?.code).toBe('HARD_STOP');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.url).toBe(calls[0]!.url);
    expect(calls[1]!.body).toBe(calls[0]!.body);
    expect(calls[0]!.headers['X-Manager-Override']).toBeUndefined();
    expect(calls[1]!.headers['X-Manager-Override']).toBe('Customer%20waiting');
  });

  it('re-sends FormData uploads unchanged', async () => {
    cleanups.push(
      setOverridePromptHandler(async () => {
        setManagerOverrideReason('Manager override');
        return { action: 'override', reason: 'Manager override' };
      })
    );
    const fd = new FormData();
    fd.append('kind', 'photo');
    replies.push(() => refusal(HARD_STOP), () => json(201, { id: 'e1' }));
    await expect(request('/claims/c1/evidence', { method: 'POST', formData: fd })).resolves.toEqual({ id: 'e1' });
    expect(calls[1]!.body).toBe(fd);
    expect(calls[1]!.headers['Content-Type']).toBeUndefined();
  });

  it('cancel rethrows the original refusal, and a second refusal is not prompted again', async () => {
    let asked = 0;
    cleanups.push(
      setOverridePromptHandler(async () => {
        asked++;
        return { action: 'cancel' };
      })
    );
    replies.push(() => refusal(HARD_STOP));
    const err = await request('/claims/c1/status', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('HARD_STOP');
    expect(calls).toHaveLength(1);
    expect(asked).toBe(1);

    // override chosen, but the retry is refused again → that error is thrown, no third attempt
    cleanups.push(
      setOverridePromptHandler(async () => {
        asked++;
        setManagerOverrideReason('Manager override');
        return { action: 'override', reason: 'Manager override' };
      })
    );
    replies.push(() => refusal(HARD_STOP), () => json(403, { error: { code: 'FORBIDDEN', message: 'Not allowed' } }));
    const again = await request('/claims/c1/status', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect((again as ApiError).code).toBe('FORBIDDEN');
    expect(calls).toHaveLength(3);
    expect(asked).toBe(2);
  });

  it('never prompts for GET, class C errors or a refusal the user may not override', async () => {
    let asked = 0;
    cleanups.push(
      setOverridePromptHandler(async () => {
        asked++;
        return { action: 'override', reason: 'x' };
      })
    );
    replies.push(
      () => refusal(HARD_STOP),
      () => json(409, { error: { code: 'IMMUTABLE', message: 'Ledger rows are append-only' } }),
      () => refusal({ ...HARD_STOP, allowed: false })
    );
    await expect(request('/claims/c1', { method: 'GET' })).rejects.toBeInstanceOf(ApiError);
    await expect(request('/claims/c1/ledger/l1', { method: 'PATCH', body: {} })).rejects.toMatchObject({ code: 'IMMUTABLE' });
    await expect(request('/claims/c1/status', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'HARD_STOP', override: { allowed: false } });
    expect(asked).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it('expired on the server while the client believed it on → reactivate and re-send once, without a prompt', async () => {
    let prompted = 0;
    let reactivated = 0;
    cleanups.push(
      setOverridePromptHandler(async () => {
        prompted++;
        return { action: 'cancel' };
      })
    );
    cleanups.push(
      setManagerModeReactivator(async () => {
        reactivated++;
        return true;
      })
    );
    setManagerOverrideReason('Manager override');
    replies.push(() => refusal({ ...HARD_STOP, managerMode: 'off' }), () => json(200, { ok: true }));
    await expect(request('/claims/c1/status', { method: 'POST', body: {} })).resolves.toEqual({ ok: true });
    expect(reactivated).toBe(1);
    expect(prompted).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers['X-Manager-Override']).toBe('Manager%20override');

    // reactivation refused (e.g. the role changed) → the original error
    cleanups.push(setManagerModeReactivator(async () => false));
    replies.push(() => refusal({ ...HARD_STOP, managerMode: 'off' }));
    await expect(request('/claims/c1/status', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'HARD_STOP' });
    expect(calls).toHaveLength(3);
  });

  it('decodes the applied-overrides header defensively', () => {
    expect(parseAppliedOverrides(null)).toEqual([]);
    expect(parseAppliedOverrides('not json')).toEqual([]);
    expect(parseAppliedOverrides(encodeURIComponent('{"a":1}'))).toEqual([]);
    expect(parseAppliedOverrides(encodeURIComponent(JSON.stringify([{ code: 'X' }, 'junk', { code: 'Y', label: 'Why', reason: 'r' }])))).toEqual([
      { code: 'X', label: 'X', reason: '' },
      { code: 'Y', label: 'Why', reason: 'r' }
    ]);
  });
});

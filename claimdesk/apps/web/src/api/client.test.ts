import { describe, expect, it } from 'vitest';
import { ApiError, asList, buildUrl, isApiError, seg } from './client';

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

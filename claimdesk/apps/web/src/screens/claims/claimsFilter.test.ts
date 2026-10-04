import { describe, expect, it } from 'vitest';
import type { ClaimSummary } from '../../api/client';
import { distinctOptions, filterClaims, matchesSearch } from './claimsFilter';

const base = (over: Partial<ClaimSummary>): ClaimSummary =>
  ({
    id: over.id ?? 'id',
    reference: over.reference ?? 'CCG-2026-00001',
    status: over.status ?? 'hire_active',
    openedAt: '2026-10-01T09:00:00Z',
    accident: { occurredAt: '2026-09-30T08:00:00Z', location: 'A40', circumstances: 'x' },
    liability: 'unknown',
    claimantId: 'p1',
    clientVehicleId: 'v1',
    thirdPartyIds: [],
    gtaSubscriber: false,
    linkedClaimIds: [],
    flags: [],
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-01T09:00:00Z',
    ...over
  }) as ClaimSummary;

const rows = [
  base({ id: '1', reference: 'CCG-2026-00001', claimantName: 'Jane Smith', registration: 'AB12CDE', insurerName: 'esure', atFaultInsurerId: 'esure', handlerId: 'DK', handlerName: 'Danny' }),
  base({ id: '2', reference: 'CCG-2026-00002', claimantName: 'Omar Khan', registration: 'LK19XYZ', insurerName: 'Aviva', atFaultInsurerId: 'aviva', status: 'chasing', handlerId: 'AS' }),
  base({ id: '3', reference: 'CCG-2026-00003', claimantName: 'Priya Patel', status: 'settled' })
];

describe('matchesSearch', () => {
  it('matches ref, name and registration, ignoring case and spaces', () => {
    expect(matchesSearch(rows[0]!, 'ab12 cde')).toBe(true);
    expect(matchesSearch(rows[0]!, 'smith')).toBe(true);
    expect(matchesSearch(rows[0]!, '00001')).toBe(true);
    expect(matchesSearch(rows[0]!, 'esure')).toBe(true);
    expect(matchesSearch(rows[0]!, 'khan')).toBe(false);
    expect(matchesSearch(rows[0]!, '')).toBe(true);
  });
});

describe('filterClaims', () => {
  it('applies status, handler and insurer filters', () => {
    expect(filterClaims(rows, { q: '', status: '', handler: '', insurer: '' }).length).toBe(3);
    expect(filterClaims(rows, { q: '', status: 'chasing', handler: '', insurer: '' }).map((c) => c.id)).toEqual(['2']);
    expect(filterClaims(rows, { q: '', status: '', handler: 'DK', insurer: '' }).map((c) => c.id)).toEqual(['1']);
    expect(filterClaims(rows, { q: '', status: '', handler: '', insurer: 'aviva' }).map((c) => c.id)).toEqual(['2']);
    expect(filterClaims(rows, { q: 'priya', status: 'settled', handler: '', insurer: '' }).map((c) => c.id)).toEqual(['3']);
  });
});

describe('distinctOptions', () => {
  it('builds sorted id→label options and falls back to the id', () => {
    expect(distinctOptions(rows, (c) => c.handlerId, (c) => c.handlerName)).toEqual([
      { value: 'AS', label: 'AS' },
      { value: 'DK', label: 'Danny' }
    ]);
    expect(distinctOptions(rows, (c) => c.atFaultInsurerId, (c) => c.insurerName)).toEqual([
      { value: 'aviva', label: 'Aviva' },
      { value: 'esure', label: 'esure' }
    ]);
  });
});

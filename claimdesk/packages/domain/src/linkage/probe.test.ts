import { describe, it, expect } from 'vitest';
import { normalisePhone, normaliseAddressKey, witnessIndependence } from './index.js';
import type { Party } from '../types.js';

const party = (id: string, name: string, extra: Partial<Party> = {}): Party => ({ id, kind: 'individual', name, roles: ['other'], createdAt: '2026-01-01T00:00:00Z', ...extra });

describe('PROBE linkage', () => {
  it('L1 +44 (0) phone', () => {
    console.log('L1', normalisePhone('+44 (0)7700 900123'));
    expect(normalisePhone('+44 (0)7700 900123')).toBe('07700900123');
  });
  it('L2 flats in same block are not the same address', () => {
    const a = normaliseAddressKey({ line1: 'Flat 2, Rose Court', postcode: 'E1 6AN' });
    const b = normaliseAddressKey({ line1: 'Flat 7, Rose Court', postcode: 'E1 6AN' });
    console.log('L2', a, b);
    expect(a).not.toBe(b);
    const w = witnessIndependence(party('w', 'Tariq Khan', { address: { line1: 'Flat 7, Rose Court', postcode: 'E1 6AN' } }), party('c', 'Amir Hussain', { address: { line1: 'Flat 2, Rose Court', postcode: 'E1 6AN' } }));
    console.log('L2b', w);
    expect(w.independent).toBe(true);
  });
});

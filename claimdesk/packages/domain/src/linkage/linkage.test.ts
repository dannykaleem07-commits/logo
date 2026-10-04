import { describe, it, expect } from 'vitest';
import type { Party } from '../types.js';
import {
  findConnections,
  witnessIndependence,
  normalisePhone,
  normaliseEmail,
  normaliseAddressKey,
  normaliseBankKey,
  nameTokens,
  tokenJaccard,
  jaro,
  jaroWinkler,
  nameSimilarity,
  CORROBORATION_SUGGESTIONS,
  type LinkableParty
} from './index.js';

const party = (id: string, name: string, extra: Partial<LinkableParty> = {}): LinkableParty => ({
  id,
  kind: 'individual',
  name,
  roles: ['other'],
  createdAt: '2026-01-01T00:00:00Z',
  ...extra
});

describe('normalisers', () => {
  it('normalises UK phone numbers', () => {
    expect(normalisePhone('+44 7700 900123')).toBe('07700900123');
    expect(normalisePhone('0044 7700 900123')).toBe('07700900123');
    expect(normalisePhone('447700900123')).toBe('07700900123');
    expect(normalisePhone('07700 900 123')).toBe('07700900123');
    expect(normalisePhone('(020) 7052 5403')).toBe('02070525403');
    expect(normalisePhone('123')).toBeUndefined();
    expect(normalisePhone(undefined)).toBeUndefined();
  });

  it('normalises emails, addresses and bank keys', () => {
    expect(normaliseEmail('  Danny@Example.COM ')).toBe('danny@example.com');
    expect(normaliseEmail('not-an-email')).toBeUndefined();
    expect(normaliseAddressKey({ line1: '66 Paul Street', postcode: 'ec2a 4px' })).toBe('EC2A4PX|66');
    expect(normaliseAddressKey({ line1: 'Flat 2, Rose Court', postcode: 'E1 6AN' })).toBe('E16AN|flat');
    expect(normaliseAddressKey({ line1: '12 High Street', town: 'Barking', postcode: '' })).toBe('12 high street|barking');
    expect(normaliseAddressKey(undefined)).toBeUndefined();
    expect(normaliseBankKey({ accountName: 'x', sortCode: '20-00-00', accountNumber: '12345678' })).toBe('20000012345678');
    expect(normaliseBankKey({ accountName: 'x', sortCode: '2000', accountNumber: '12345678' })).toBeUndefined();
  });

  it('tokenises names without titles and corporate suffixes', () => {
    expect(nameTokens('Mr Daniel Kaleem')).toEqual(['daniel', 'kaleem']);
    expect(nameTokens('CARFLEX LTD')).toEqual(['carflex']);
    expect(nameTokens('Courtesy Cars Group UK Ltd')).toEqual(['courtesy', 'cars']);
    expect(tokenJaccard(['a', 'b'], ['b', 'c'])).toBe(1 / 3);
    expect(tokenJaccard([], ['a'])).toBe(0);
  });

  it('implements Jaro and Jaro-Winkler to the textbook values', () => {
    expect(jaro('martha', 'marhta')).toBeCloseTo(0.9444, 4);
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler('dwayne', 'duane')).toBeCloseTo(0.84, 2);
    expect(jaro('dixon', 'dicksonx')).toBeCloseTo(0.7667, 4);
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.8133, 4);
    expect(jaro('abc', 'xyz')).toBe(0);
    expect(jaroWinkler('same', 'same')).toBe(1);
  });

  it('scores names: exact, reordered, misspelt, unrelated', () => {
    expect(nameSimilarity('Daniel Kaleem', 'Kaleem Daniel').score).toBe(1);
    expect(nameSimilarity('Mr Daniel Kaleem', 'daniel kaleem').exact).toBe(true);
    const typo = nameSimilarity('Daniel Kaleem', 'Daniel Kalem');
    expect(typo.jaccard).toBe(1 / 3); // shares 'daniel' of {daniel, kaleem, kalem}
    expect(typo.jaroWinkler).toBeGreaterThan(0.9);
    expect(typo.score).toBeGreaterThan(0.6);
    expect(nameSimilarity('Daniel Kaleem', 'Zara Patel').score).toBeLessThan(0.5);
    expect(nameSimilarity('', 'x').score).toBe(0);
  });
});

describe('findConnections', () => {
  const claimant = party('claimant', 'Amir Hussain', {
    phone: '07700 900123',
    email: 'amir@example.com',
    address: { line1: '14 Elm Road', town: 'Ilford', postcode: 'IG1 1AA' },
    bank: { accountName: 'A Hussain', sortCode: '20-00-00', accountNumber: '12345678' },
    registrations: ['AB12 CDE']
  });

  it('matches phone, email, address, bank, vehicle and name across registers', () => {
    const staff = party('staff1', 'Zara Patel', { phone: '+447700900123' });
    const relative = party('rel1', 'Sana Hussain', { address: { line1: '14a Elm Road', postcode: 'ig11aa' } }); // first token '14a' ≠ '14' → no address match
    const relative2 = party('rel2', 'Bilal Hussain', { address: { line1: '14 Elm Rd', postcode: 'IG1 1AA' } });
    const supplier = party('sup1', 'Elm Motors Ltd', { bank: { accountName: 'Elm Motors', sortCode: '200000', accountNumber: '12345678' } });
    const previous = party('prev1', 'Mr Amir Hussain', { email: 'AMIR@example.com' });
    const witness = party('wit1', 'Tariq Khan', { registrations: ['ab12cde'] });

    const out = findConnections([claimant], {
      staff: [staff],
      relatives: [relative, relative2],
      suppliers: [supplier],
      previousClients: [previous],
      witnesses: [witness]
    });
    const by = (id: string, field: string) => out.find((c) => c.bId === id && c.field === field);

    expect(by('staff1', 'phone')?.confidence).toBe(0.9);
    expect(by('staff1', 'phone')?.detail).toBe('Same phone number 07700900123');
    expect(by('staff1', 'phone')?.bRegister).toBe('staff');
    expect(by('rel1', 'address')).toBeUndefined();
    expect(by('rel2', 'address')?.confidence).toBe(0.7);
    expect(by('sup1', 'bank')?.confidence).toBe(0.95);
    expect(by('sup1', 'bank')?.detail).toContain('account ending 5678');
    expect(by('prev1', 'email')?.confidence).toBe(0.9);
    expect(by('prev1', 'name')?.confidence).toBe(0.9); // exact name, capped at 0.9
    expect(by('prev1', 'name')?.detail).toBe('Same name "Amir Hussain"');
    expect(by('wit1', 'vehicle')?.confidence).toBe(0.8);
    expect(by('wit1', 'vehicle')?.detail).toBe('Both associated with vehicle AB12CDE');
    // sorted by confidence descending
    expect(out[0]!.field).toBe('bank');
    // shared surname only is below the default threshold (jaccard 1/3, JW ~0.6)
    expect(by('rel1', 'name')).toBeUndefined();
    expect(by('rel2', 'name')).toBeUndefined();
  });

  it('compares subjects with one another and de-duplicates', () => {
    const witness = party('wit1', 'Tariq Khan', { phone: '07700900123' });
    const out = findConnections([claimant, witness], { staff: [], suppliers: [], previousClients: [], witnesses: [witness] });
    const phoneLinks = out.filter((c) => c.field === 'phone');
    expect(phoneLinks).toHaveLength(1); // not duplicated via the witnesses register
    expect(phoneLinks[0]!.aId).toBe('claimant');
    expect(phoneLinks[0]!.bId).toBe('wit1');
    expect(findConnections([claimant, witness], { staff: [], suppliers: [], previousClients: [] }, { compareSubjects: false })).toEqual([]);
  });

  it('returns nothing for unconnected parties', () => {
    const stranger = party('s1', 'Olu Adebayo', { phone: '07000000000', email: 'olu@example.org' });
    expect(findConnections([claimant], { staff: [stranger], suppliers: [], previousClients: [] })).toEqual([]);
  });
});

describe('witnessIndependence', () => {
  const claimant: Party = party('claimant', 'Amir Hussain', { phone: '07700 900123', email: 'amir@example.com' });

  it('a witness sharing the claimant phone is not independent (live File 4)', () => {
    const witness: Party = party('wit1', 'Tariq Khan', { phone: '+44 7700 900123' });
    const r = witnessIndependence(witness, claimant, []);
    expect(r.independent).toBe(false);
    expect(r.score).toBe(0.4); // 1 − 0.6 phone penalty
    expect(r.reasons).toEqual(["Witness Tariq Khan shares the claimant's phone number: Same phone number 07700900123."]);
    expect(r.suggestedCorroboration).toEqual(CORROBORATION_SUGGESTIONS);
    expect(r.suggestedCorroboration.join(' ')).toMatch(/CCTV/);
    expect(r.suggestedCorroboration.join(' ')).toMatch(/Dashcam/);
    expect(r.suggestedCorroboration.join(' ')).toMatch(/third party's own admission/);
    expect(r.suggestedCorroboration.join(' ')).toMatch(/Police collision report/);
    expect(r.suggestedCorroboration.join(' ')).toMatch(/Telematics/);
  });

  it('uses precomputed connections to the staff and relatives registers', () => {
    const witness: Party = party('wit2', 'Sana Hussain');
    const connections = findConnections([claimant, witness], {
      staff: [party('staff1', 'Sana Hussain', { phone: '07111222333' })],
      relatives: [],
      suppliers: [],
      previousClients: []
    });
    // witness matches a staff member by exact name
    expect(connections.some((c) => c.aId === 'wit2' && c.bId === 'staff1' && c.field === 'name')).toBe(true);
    const r = witnessIndependence(witness, claimant, connections);
    expect(r.independent).toBe(false);
    expect(r.score).toBe(0.3); // 1 − 0.7 staff register penalty
    expect(r.reasons[0]).toContain('matches the staff register on name');
  });

  it('a shared surname alone lowers the score but keeps independence', () => {
    const witness: Party = party('wit3', 'Bilal Hussain', { phone: '07999888777' });
    // force a name connection via a low threshold to show the penalty path
    const connections = findConnections([claimant, witness], { staff: [], suppliers: [], previousClients: [] }, { nameThreshold: 0.4 });
    expect(connections.some((c) => c.field === 'name')).toBe(true);
    const r = witnessIndependence(witness, claimant, connections);
    expect(r.independent).toBe(true);
    expect(r.score).toBe(0.7); // 1 − 0.3 name penalty
    expect(r.suggestedCorroboration).toEqual([]);
  });

  it('a stranger is independent with a clean reason', () => {
    const witness: Party = party('wit4', 'Olu Adebayo', { phone: '07000000000', email: 'olu@example.org' });
    const r = witnessIndependence(witness, claimant);
    expect(r).toEqual({
      independent: true,
      score: 1,
      reasons: ['No connection found between witness Olu Adebayo and the claimant on phone, email, address, bank, vehicle or name.'],
      suggestedCorroboration: []
    });
  });

  it('stacks penalties and floors at zero', () => {
    const witness: Party = party('wit5', 'Amir Hussain', {
      phone: '07700900123',
      email: 'amir@example.com',
      address: { line1: '1 A Road', postcode: 'E1 6AN' }
    });
    const withAddress: Party = { ...claimant, address: { line1: '1 A Road', postcode: 'E16AN' } };
    const r = witnessIndependence(witness, withAddress);
    // 1 − 0.6 (phone) − 0.6 (email) − 0.5 (address) − 0.3 (name) < 0 → 0
    expect(r.score).toBe(0);
    expect(r.independent).toBe(false);
    expect(r.reasons).toHaveLength(4);
  });
});

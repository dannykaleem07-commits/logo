import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { seedFileOne } from '../fixtures/fileOne.js';
import { createTestDatabase } from '../testing.js';
import { createParty, findConnections, getParty, searchParties, updateParty } from './parties.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

describe('parties', () => {
  it('create/get/update round-trip JSON fields and strip internal match keys', () => {
    const p = createParty(h.db, { kind: 'individual', name: 'Jane Doe', phone: '+44 7700 900123', email: 'Jane@Example.test', address: { line1: '1 St', postcode: 'e1 6an' }, bank: { accountName: 'Jane Doe', sortCode: '12-34-56', accountNumber: '12345678' }, roles: ['claimant'] });
    expect(p).not.toHaveProperty('phoneNormalised');
    expect(getParty(h.db, p.id)?.bank?.sortCode).toBe('12-34-56');
    const u = updateParty(h.db, p.id, { phone: '07700 900999', notes: 'n' });
    expect(u.phone).toBe('07700 900999');
    expect(u.notes).toBe('n');
  });

  it('search matches name, email, phone (normalised) and registration (via claims)', () => {
    const ids = seedFileOne(h.db);
    expect(searchParties(h.db, 'jane').map((p) => p.id)).toEqual([ids.claimantId]);
    expect(searchParties(h.db, '+44 7700 900123').map((p) => p.id)).toEqual([ids.claimantId]);
    expect(searchParties(h.db, 'example-insurer').map((p) => p.id)).toEqual([ids.insurerId]);
    const viaReg = searchParties(h.db, 'ab12 cde').map((p) => p.id);
    expect(viaReg).toEqual(expect.arrayContaining([ids.claimantId, ids.thirdPartyId]));
    expect(searchParties(h.db, 'smith', { roles: ['witness'] })).toEqual([]);
    expect(searchParties(h.db, '   ')).toEqual([]);
  });

  it('findConnections returns candidates by normalised phone / email / postcode / bank / name', () => {
    const claimant = createParty(h.db, { kind: 'individual', name: 'Jane Doe', phone: '07700 900123', email: 'jane@example.test', address: { line1: '1 St', postcode: 'E1 6AN' }, bank: { accountName: 'J Doe', sortCode: '12-34-56', accountNumber: '12345678' }, roles: ['claimant'] });
    const witness = createParty(h.db, { kind: 'individual', name: 'Wit Ness', phone: '+447700900123', address: { line1: '1 St', postcode: 'e16an' }, roles: ['witness'] });
    const stranger = createParty(h.db, { kind: 'individual', name: 'Some One', phone: '07000 000000', roles: ['witness'] });
    const sameBank = createParty(h.db, { kind: 'company', name: 'Garage Ltd', bank: { accountName: 'Garage', sortCode: '123456', accountNumber: '12345678' }, roles: ['repairer'] });

    const found = findConnections(h.db, { partyId: claimant.id });
    const byId = Object.fromEntries(found.map((f) => [f.party.id, f.matchedOn]));
    expect(byId[witness.id]).toEqual(['phone', 'postcode']);
    expect(byId[sameBank.id]).toEqual(['bank']);
    expect(byId[stranger.id]).toBeUndefined();
    expect(byId[claimant.id]).toBeUndefined(); // self excluded

    // ad-hoc check for a witness being keyed in, before saving
    const adHoc = findConnections(h.db, { email: 'JANE@example.test', name: 'jane doe' });
    expect(adHoc.map((f) => f.party.id)).toEqual([claimant.id]);
    expect(adHoc[0]!.matchedOn).toEqual(['email', 'name']);
    expect(findConnections(h.db, {})).toEqual([]);
  });
});

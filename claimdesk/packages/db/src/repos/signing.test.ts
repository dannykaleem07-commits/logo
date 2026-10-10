// owned by ap-paperwork
/** document_packs, signature_requests (+ append-only events) and kiosk_sessions (docs/SUPREME-AUTOPILOT.md §D.6, §E). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { createTestDatabase } from '../testing.js';
import {
  createDocumentPack,
  createKioskSession,
  createSignatureRequest,
  getKioskSessionByTokenSha256,
  listDocumentPacks,
  listDocumentPacksWithDocument,
  listDueSignatureRequests,
  listSignatureRequestEvents,
  listSignatureRequests,
  transitionSignatureRequest,
  updateDocumentPack,
  updateKioskSession,
} from './signing.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

describe('document packs', () => {
  it('creates, lists, patches and finds packs by member document', () => {
    const pack = createDocumentPack(h.db, {
      claimId: 'c1',
      stage: 'signup',
      items: [{ templateId: 'agreement.ccguk_01_customer_loa', format: 'docx', purpose: 'sign', signer: 'client', status: 'pending' }],
      createdBy: 'agent:autopilot',
      at: '2026-10-10T09:00:00.000Z',
    });
    expect(pack.status).toBe('preparing');
    expect(listDocumentPacks(h.db, { claimId: 'c1', stage: 'signup' })).toHaveLength(1);
    const items = pack.items.map((i) => ({ ...i, documentId: 'd1', status: 'drafted' as const }));
    const next = updateDocumentPack(h.db, pack.id, { items, status: 'reviewing' }, '2026-10-10T09:05:00.000Z');
    expect(next.status).toBe('reviewing');
    expect(next.updatedAt).toBe('2026-10-10T09:05:00.000Z');
    expect(listDocumentPacksWithDocument(h.db, 'c1', 'd1').map((p) => p.id)).toEqual([pack.id]);
    expect(listDocumentPacks(h.db, { status: ['approved', 'sent'] })).toHaveLength(0);
  });
});

describe('signature requests', () => {
  it('records every status change in the append-only history and lists due chases', () => {
    const r = createSignatureRequest(h.db, { claimId: 'c1', documentId: 'd1', signerPartyId: 'p1', method: 'wet_email', status: 'sent', sentAt: '2026-10-01T09:00:00.000Z', nextChaseAt: '2026-10-03T09:00:00.000Z', actor: 'owner', at: '2026-10-01T09:00:00.000Z' });
    expect(listDueSignatureRequests(h.db, '2026-10-02T09:00:00.000Z')).toHaveLength(0);
    expect(listDueSignatureRequests(h.db, '2026-10-03T09:15:00.000Z').map((x) => x.id)).toEqual([r.id]);
    const chased = transitionSignatureRequest(h.db, r.id, 'chased', { chaseCount: 1, lastChasedAt: '2026-10-03T09:15:00.000Z', nextChaseAt: '2026-10-06T09:00:00.000Z' }, 'agent:autopilot', 'chase 1', '2026-10-03T09:15:00.000Z');
    expect(chased.chaseCount).toBe(1);
    const signed = transitionSignatureRequest(h.db, r.id, 'signed', { signedAt: '2026-10-04T10:00:00.000Z', confirmedBy: 'owner', nextChaseAt: null }, 'owner');
    expect(signed.nextChaseAt).toBeUndefined();
    expect(listDueSignatureRequests(h.db, '2026-10-30T00:00:00.000Z')).toHaveLength(0);
    expect(listSignatureRequestEvents(h.db, r.id).map((e) => [e.fromStatus ?? null, e.toStatus])).toEqual([
      [null, 'sent'],
      ['sent', 'chased'],
      ['chased', 'signed'],
    ]);
    expect(listSignatureRequests(h.db, { claimId: 'c1', status: 'signed' })).toHaveLength(1);
  });

  it('refuses to update or delete history rows', () => {
    const r = createSignatureRequest(h.db, { claimId: 'c1', documentId: 'd1', signerPartyId: 'p1', method: 'wet_email', actor: 'owner' });
    expect(() => h.db.run(sql`UPDATE signature_request_events SET note = 'x' WHERE signature_request_id = ${r.id}`)).toThrow();
    expect(() => h.db.run(sql`DELETE FROM signature_request_events WHERE signature_request_id = ${r.id}`)).toThrow();
  });
});

describe('kiosk sessions', () => {
  it('stores the token hash only and looks sessions up by it', () => {
    const s = createKioskSession(h.db, { packId: 'k1', claimId: 'c1', signerPartyId: 'p1', tokenSha256: 'a'.repeat(64), lan: false, createdBy: 'u1', createdAt: '2026-10-10T09:00:00.000Z', expiresAt: '2026-10-10T09:30:00.000Z' });
    expect(getKioskSessionByTokenSha256(h.db, 'a'.repeat(64))?.id).toBe(s.id);
    expect(getKioskSessionByTokenSha256(h.db, 'b'.repeat(64))).toBeUndefined();
    const opened = updateKioskSession(h.db, s.id, { openedAt: '2026-10-10T09:01:00.000Z', openedIp: '127.0.0.1', openedUserAgent: 'test' });
    expect(opened.openedIp).toBe('127.0.0.1');
    expect(opened.lan).toBe(false);
    expect(() => createKioskSession(h.db, { packId: 'k2', claimId: 'c1', signerPartyId: 'p1', tokenSha256: 'a'.repeat(64), lan: true, createdBy: 'u1', createdAt: '2026-10-10T09:00:00.000Z', expiresAt: '2026-10-10T09:30:00.000Z' })).toThrow();
  });
});

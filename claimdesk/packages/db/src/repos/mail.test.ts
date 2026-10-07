// owned by mail
/**
 * Mail persistence (docs/SUPREME-DESIGN.md §F, §D.3, §N.2): append-only matches, classifications and outbox events
 * through the repositories; raw-sha dedupe; the outbox state machine (only transitionOutbox moves a row).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { createTestDatabase } from '../testing.js';
import {
  appendMailClassification,
  appendMailMatch,
  findMailMessageByRawSha,
  findMailMessagesByMessageId,
  getDefaultMailAccount,
  getMailFolderState,
  insertMailMessage,
  latestMailMatch,
  listMailMatches,
  normaliseMessageId,
  saveMailFolderState,
  updateMailMessageRouting,
  upsertMailAccount,
  MAIL_FROM_NAME,
} from './mail.js';
import { OUTBOX_TRANSITIONS, OutboxStateError, countSentOutboxTo, createOutbox, findOutboxBySmtpMessageId, listOutboxEvents, transitionOutbox } from './outbox.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const T0 = '2026-10-07T09:00:00.000Z';

function account() {
  return upsertMailAccount(h.db, { imapHost: 'imap.ionos.co.uk', imapPort: 993, smtpHost: 'smtp.ionos.co.uk', smtpPort: 465, smtpSecurity: 'tls', username: 'claims@example.test', fromAddress: 'claims@example.test', now: T0 });
}

function message(accountId: string, sha: string, extra: Partial<Parameters<typeof insertMailMessage>[1]> = {}) {
  return insertMailMessage(h.db, { accountId, threadKey: 't1', direction: 'in', to: ['claims@example.test'], cc: [], receivedAt: T0, rawEvidenceId: `ev-${sha}`, rawSha256: sha, source: 'imap', messageId: '<ABC@Insurer.example>', ...extra });
}

describe('mail accounts', () => {
  it('fixes the From name and keeps one account updated in place', () => {
    const a = account();
    expect(a.fromName).toBe(MAIL_FROM_NAME);
    expect(a.moveAfterIngest).toBe(true);
    expect(a.enabled).toBe(false);
    const b = upsertMailAccount(h.db, { imapHost: 'imap.ionos.co.uk', imapPort: 993, smtpHost: 'smtp.ionos.co.uk', smtpPort: 587, smtpSecurity: 'starttls', username: 'claims@example.test', fromAddress: 'claims@example.test', enabled: true, moveAfterIngest: false });
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ smtpPort: 587, smtpSecurity: 'starttls', enabled: true, moveAfterIngest: false, fromName: MAIL_FROM_NAME });
    expect(getDefaultMailAccount(h.db)?.id).toBe(a.id);
    // Only the name of the DPAPI secret is stored, never a password column or value.
    expect(b.secretRef).toBe('imap_password');
    expect((h.sqlite.prepare('pragma table_info(mail_accounts)').all() as Array<{ name: string }>).map((c) => c.name).filter((n) => /pass/i.test(n))).toEqual([]);
  });

  it('stores per-folder sync state', () => {
    const a = account();
    saveMailFolderState(h.db, { accountId: a.id, folder: 'INBOX', uidvalidity: 7, lastUid: 12 });
    saveMailFolderState(h.db, { accountId: a.id, folder: 'INBOX', lastUid: 15 });
    expect(getMailFolderState(h.db, a.id, 'INBOX')).toMatchObject({ uidvalidity: 7, lastUid: 15 });
  });
});

describe('mail messages', () => {
  it('dedupes on raw sha256 per account and finds by normalised Message-ID', () => {
    const a = account();
    const m = message(a.id, 'aa');
    expect(m.messageIdNorm).toBe('abc@insurer.example');
    expect(() => message(a.id, 'aa')).toThrow(/UNIQUE/);
    expect(findMailMessageByRawSha(h.db, a.id, 'aa')?.id).toBe(m.id);
    expect(findMailMessagesByMessageId(h.db, 'abc@INSURER.example').map((x) => x.id)).toEqual([m.id]);
    expect(normaliseMessageId(' <X@Y> ')).toBe('x@y');
  });

  it('changes only routing fields', () => {
    const a = account();
    const m = message(a.id, 'bb');
    const r = updateMailMessageRouting(h.db, m.id, { status: 'matched', claimId: 'c1', folder: 'ClaimDesk-Processed' });
    expect(r).toMatchObject({ status: 'matched', claimId: 'c1', folder: 'ClaimDesk-Processed', rawSha256: 'bb', rawEvidenceId: 'ev-bb' });
  });
});

describe('append-only mail tables', () => {
  it('mail_matches: the newest row decides; rows never change', () => {
    const a = account();
    const m = message(a.id, 'cc');
    const first = appendMailMatch(h.db, { mailMessageId: m.id, claimId: null, score: 60, signals: { signals: [] }, decidedBy: 'auto', now: T0 });
    const second = appendMailMatch(h.db, { mailMessageId: m.id, claimId: 'c1', score: 60, signals: { reason: 'owner chose' }, decidedBy: 'owner', now: '2026-10-07T09:05:00.000Z' });
    expect(latestMailMatch(h.db, m.id)?.id).toBe(second.id);
    expect(listMailMatches(h.db, m.id).map((x) => x.id)).toEqual([first.id, second.id]);
    expect(() => h.sqlite.prepare('update mail_matches set claim_id = ? where id = ?').run('c2', first.id)).toThrow('mail_matches is append-only');
    expect(() => h.sqlite.prepare('delete from mail_matches where id = ?').run(first.id)).toThrow('mail_matches is append-only');
  });

  it('mail_classifications refuse UPDATE and DELETE', () => {
    const a = account();
    const m = message(a.id, 'dd');
    const c = appendMailClassification(h.db, { mailMessageId: m.id, intent: 'acknowledgement', secondary: [], confidence: 0.9, extracted: {}, summary: 'ack', injection: { suspected: false }, deterministic: {} });
    expect(() => h.sqlite.prepare('update mail_classifications set intent = ? where id = ?').run('other', c.id)).toThrow('mail_classifications is append-only');
    expect(() => h.sqlite.prepare('delete from mail_classifications where id = ?').run(c.id)).toThrow('mail_classifications is append-only');
    expect(() => appendMailClassification(h.db, { mailMessageId: m.id, intent: 'x', secondary: [], confidence: 2, extracted: {}, summary: '', injection: {}, deterministic: {} })).toThrow(/confidence/);
  });

  it('outbox_events refuse UPDATE and DELETE', () => {
    const a = account();
    const o = createOutbox(h.db, { accountId: a.id, kind: 'ack', to: ['x@insurer.example'], subject: 'Hello', bodyText: 'Hi', createdBy: 'agent:mail', now: T0 });
    const [ev] = listOutboxEvents(h.db, o.id);
    expect(ev).toMatchObject({ toStatus: 'draft', actor: 'agent:mail' });
    expect(ev!.fromStatus).toBeUndefined();
    expect(() => h.sqlite.prepare('update outbox_events set actor = ? where id = ?').run('x', ev!.id)).toThrow('outbox_events is append-only');
    expect(() => h.sqlite.prepare('delete from outbox_events where id = ?').run(ev!.id)).toThrow('outbox_events is append-only');
  });
});

describe('outbox state machine', () => {
  it('walks draft → reviewing → held → queued → sending → sent and records every step', () => {
    const a = account();
    const o = createOutbox(h.db, { claimId: 'c1', accountId: a.id, kind: 'ack', to: ['Handler@Insurer.example'], subject: 'Re: claim', bodyText: 'Thanks', createdBy: 'agent:mail', now: T0 });
    transitionOutbox(h.db, o.id, 'reviewing', 'agent:mail', 'review requested', { now: T0 });
    const held = transitionOutbox(h.db, o.id, 'held', 'agent:mail', 'auto_held', { patch: { holdUntil: '2026-10-07T09:10:00.000Z', policy: { outcome: 'auto_held', ruleIds: ['external_ok'] } }, now: T0 });
    expect(held).toMatchObject({ status: 'held', holdUntil: '2026-10-07T09:10:00.000Z', policy: { outcome: 'auto_held' } });
    transitionOutbox(h.db, o.id, 'queued', 'agent:mail', 'released', { from: 'held' });
    transitionOutbox(h.db, o.id, 'sending', 'agent:mail', 'smtp');
    const sent = transitionOutbox(h.db, o.id, 'sent', 'agent:mail', 'accepted', { patch: { smtpMessageId: '<u1@example.test>' } });
    expect(sent.status).toBe('sent');
    expect(listOutboxEvents(h.db, o.id).map((e) => `${e.fromStatus ?? '∅'}→${e.toStatus}`)).toEqual(['∅→draft', 'draft→reviewing', 'reviewing→held', 'held→queued', 'queued→sending', 'sending→sent']);
    expect(findOutboxBySmtpMessageId(h.db, 'U1@example.test')?.id).toBe(o.id);
    expect(countSentOutboxTo(h.db, 'c1', 'handler@insurer.example')).toBe(1);
    expect(countSentOutboxTo(h.db, 'c1', 'handler@insurer.example', o.id)).toBe(0);
  });

  it('refuses transitions the machine does not allow, final states, edits once sending, and stale expectations', () => {
    const a = account();
    const o = createOutbox(h.db, { accountId: a.id, kind: 'ack', to: ['x@insurer.example'], subject: 'S', bodyText: 'B', createdBy: 'agent:mail' });
    expect(() => transitionOutbox(h.db, o.id, 'sent', 'agent:mail', 'skip')).toThrow(OutboxStateError);
    transitionOutbox(h.db, o.id, 'held', 'courtesycars', 'owner compose');
    // Undo wins: the release expecting 'held' after the cancel is refused.
    transitionOutbox(h.db, o.id, 'cancelled', 'courtesycars', 'undo', { from: 'held' });
    expect(() => transitionOutbox(h.db, o.id, 'queued', 'agent:mail', 'release', { from: 'held' })).toThrow(/cancelled/);
    expect(OUTBOX_TRANSITIONS.sent).toEqual([]);
    expect(OUTBOX_TRANSITIONS.cancelled).toEqual([]);
    const b = createOutbox(h.db, { accountId: a.id, kind: 'ack', to: ['x@insurer.example'], subject: 'S', bodyText: 'B', createdBy: 'agent:mail' });
    transitionOutbox(h.db, b.id, 'queued', 'courtesycars', 'approved');
    transitionOutbox(h.db, b.id, 'sending', 'agent:mail', 'smtp');
    expect(() => transitionOutbox(h.db, b.id, 'queued', 'agent:mail', 'retry', { patch: { bodyText: 'changed' } })).toThrow(/no longer be edited/);
    expect(h.sqlite.prepare('select status from outbox where id = ?').get(b.id)).toEqual({ status: 'sending' });
  });
});

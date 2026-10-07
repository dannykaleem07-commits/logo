// owned by mail
/**
 * Mail sync and ingest (docs/SUPREME-DESIGN.md §F.3, §C.5 step 1) on the in-memory FakeMailbox: the durability order
 * (raw evidence → attachments → rows → only then MOVE), raw-sha / Message-ID dedupe, a UIDVALIDITY change rescans
 * without duplicates, a failed ingest never moves and is retried by its own job, a failed move is retried on the next
 * sync, spoof suspects go to quarantine, `.eml` files from the import folder, and the IDLE loop / offline alert.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { stageImportFromFile } from '../services/imports.js';
import { FakeMailbox } from '../mail/transport.js';
import { startIdleLoop, OFFLINE_AFTER_FAILURES } from '../mail/sync.js';
import { INSURER_DOMAIN, PDF_BYTES, eml, queued, run, runJob, setUpMail } from './fixtures/mail/helpers.js';

const T0 = '2026-10-07T09:00:00.000Z';

let t: TestApp;
let claimId: string;
let reference: string;
beforeEach(async () => {
  t = await createTestApp(T0);
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  claimId = ids.claimId;
  reference = t.ctx.repos.requireClaim(t.ctx.db, claimId).reference;
});
afterEach(async () => {
  await t.close();
});

const messages = () => t.ctx.repos.listMailMessages(t.ctx.db, { limit: 100 });
const sync = () => run(t.ctx, 'mail.sync', {});

describe('ingest order and filing', () => {
  it('stores the raw message and each attachment as evidence, commits the rows, files on the matched claim, then moves', async () => {
    const { mailbox } = await setUpMail(t.ctx);
    // Assert the durability order from inside the server: when MOVE runs, the row and the evidence already exist.
    const seenAtMove: Array<{ rows: number; evidence: number }> = [];
    const origMove = mailbox.move.bind(mailbox);
    mailbox.move = async (folder, uid, to) => {
      const rawRows = (t.ctx.handle.sqlite.prepare("select count(*) as n from evidence where mime = 'message/rfc822'").get() as { n: number }).n;
      seenAtMove.push({ rows: messages().length, evidence: rawRows });
      return origMove(folder, uid, to);
    };
    mailbox.deliver(eml({ subject: `Your client — ${reference}`, body: 'Please find our engineer report attached.', attachments: [{ filename: 'report.pdf', mime: 'application/pdf', content: PDF_BYTES }] }));

    const r = await sync();
    expect(r.outcome.kind).toBe('done');
    const [m] = messages();
    expect(m).toMatchObject({ status: 'matched', claimId, direction: 'in', source: 'imap', hasAttachments: true, folder: 'ClaimDesk-Processed' });
    // raw evidence: write-once, message/rfc822, no claim
    const raw = t.ctx.repos.requireEvidence(t.ctx.db, m!.rawEvidenceId);
    expect(raw).toMatchObject({ mime: 'message/rfc822', kind: 'correspondence' });
    expect(raw.claimId).toBeUndefined();
    // attachment evidence + the claim-side copies (same bytes, on the claim)
    const [att] = t.ctx.repos.listMailAttachments(t.ctx.db, m!.id);
    expect(att).toMatchObject({ filename: 'report.pdf', mime: 'application/pdf' });
    const onClaim = t.ctx.repos.listEvidenceForClaim(t.ctx.db, claimId).filter((e) => e.sha256 === att!.sha256 || e.sha256 === raw.sha256);
    expect(onClaim).toHaveLength(2);
    // match row (append-only), audit, and MOVE only after the commit
    const match = t.ctx.repos.latestMailMatch(t.ctx.db, m!.id)!;
    expect(match).toMatchObject({ decidedBy: 'auto', claimId });
    expect(match.score).toBeGreaterThanOrEqual(100);
    expect((match.signals as { because: string[] }).because.join(' ')).toContain(reference);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'mail.ingest' })).toHaveLength(1);
    // the unassigned raw copy and its claim-side copy both exist before the MOVE
    expect(seenAtMove).toEqual([{ rows: 1, evidence: 2 }]);
    expect(mailbox.log.filter((l) => l.startsWith('fetch') || l.startsWith('move'))).toEqual(['fetch INBOX:1', 'move INBOX:1->ClaimDesk-Processed']);
    expect(mailbox.messages('INBOX')).toHaveLength(0);
    // \Seen is never set by ClaimDesk
    expect(mailbox.messages('ClaimDesk-Processed')[0]!.flags).toEqual([]);
    // triage follows a matched message
    expect(queued(t.ctx, 'mail.triage').map((j) => j.payload)).toEqual([{ messageId: m!.id }]);
    expect(t.ctx.repos.getMailFolderState(t.ctx.db, t.ctx.repos.getDefaultMailAccount(t.ctx.db)!.id, 'INBOX')).toMatchObject({ lastUid: 1, uidvalidity: 1 });
  });

  it('copy-only mode leaves the message in INBOX', async () => {
    const { mailbox } = await setUpMail(t.ctx, { moveAfterIngest: false });
    mailbox.deliver(eml({ subject: reference }));
    await sync();
    expect(mailbox.messages('INBOX')).toHaveLength(1);
    expect(messages()[0]).toMatchObject({ status: 'matched', folder: 'INBOX' });
  });

  it('an unmatched email goes to intake (possible new claim), a which_claim one raises Needs-you', async () => {
    const { mailbox } = await setUpMail(t.ctx);
    mailbox.deliver(eml({ subject: 'New accident', body: 'My car was hit yesterday.', from: 'someone@elsewhere.example' }));
    await sync();
    expect(messages()[0]).toMatchObject({ status: 'unmatched' });
    expect(queued(t.ctx, 'intake.process')[0]?.payload).toMatchObject({ claimId: null, source: 'email', mailMessageId: messages()[0]!.id });
    expect(queued(t.ctx, 'mail.triage')).toHaveLength(0);
  });
});

describe('dedupe', () => {
  it('the same raw bytes delivered twice make one message; the duplicate is still moved', async () => {
    const { mailbox } = await setUpMail(t.ctx);
    const raw = eml({ subject: reference });
    mailbox.deliver(raw);
    mailbox.deliver(raw);
    const r = await sync();
    expect(messages()).toHaveLength(1);
    expect((r.outcome.result as { folders: Array<{ ingested: number; duplicates: number; moved: number }> }).folders[0]).toMatchObject({ ingested: 1, duplicates: 1, moved: 2 });
    expect(mailbox.messages('INBOX')).toHaveLength(0);
  });

  it('the same Message-ID with different bytes (a re-export) is a duplicate', async () => {
    const { mailbox } = await setUpMail(t.ctx);
    mailbox.deliver(eml({ subject: reference, messageId: '<same-1@example-insurer.test>', body: 'one' }));
    mailbox.deliver(eml({ subject: reference, messageId: '<same-1@example-insurer.test>', body: 'one ' }));
    await sync();
    expect(messages()).toHaveLength(1);
  });
});

describe('UIDVALIDITY change', () => {
  it('rescans the folder from UID 1 and dedupes on raw sha256 / Message-ID', async () => {
    const { mailbox, accountId } = await setUpMail(t.ctx, { moveAfterIngest: false });
    mailbox.deliver(eml({ subject: `${reference} one` }));
    mailbox.deliver(eml({ subject: `${reference} two` }));
    await sync();
    expect(messages()).toHaveLength(2);
    expect(t.ctx.repos.getMailFolderState(t.ctx.db, accountId, 'INBOX')).toMatchObject({ uidvalidity: 1, lastUid: 2 });

    mailbox.resetUidValidity();
    mailbox.deliver(eml({ subject: `${reference} three` }));
    const r = await sync();
    const f = (r.outcome.result as { folders: Array<Record<string, unknown>> }).folders[0]!;
    expect(f).toMatchObject({ rescanned: true, fetched: 3, ingested: 1, duplicates: 2, uidvalidity: 2 });
    expect(messages()).toHaveLength(3);
    expect(t.ctx.repos.getMailFolderState(t.ctx.db, accountId, 'INBOX')).toMatchObject({ uidvalidity: 2, lastUid: 3 });
  });
});

describe('move only after commit', () => {
  it('a failed ingest is never moved; its own mail.ingest job retries and then moves it', async () => {
    const { mailbox } = await setUpMail(t.ctx);
    mailbox.deliver(eml({ subject: reference }));
    const real = t.ctx.repos;
    t.ctx.repos = { ...real, insertMailMessage: () => { throw new Error('disk full (simulated)'); } } as typeof real;
    const r = await sync();
    t.ctx.repos = real;
    expect((r.outcome.result as { folders: Array<Record<string, unknown>> }).folders[0]).toMatchObject({ failed: 1, moved: 0 });
    expect(messages()).toHaveLength(0);
    expect(mailbox.messages('INBOX')).toHaveLength(1);
    expect(mailbox.log.some((l) => l.startsWith('move'))).toBe(false);
    const [retry] = queued(t.ctx, 'mail.ingest');
    expect(retry?.payload).toMatchObject({ folder: 'INBOX', uidvalidity: 1, uid: 1 });
    const done = await runJob(t.ctx, retry!);
    expect(done.outcome.result).toMatchObject({ status: 'ingested' });
    expect(messages()).toHaveLength(1);
    expect(mailbox.messages('INBOX')).toHaveLength(0);
  });

  it('a failed MOVE keeps last_uid back so the next sync moves it (as a duplicate)', async () => {
    const { mailbox, accountId } = await setUpMail(t.ctx);
    mailbox.deliver(eml({ subject: reference }));
    mailbox.failMove = new Error('server busy');
    await sync();
    expect(messages()).toHaveLength(1);
    expect(mailbox.messages('INBOX')).toHaveLength(1);
    expect(t.ctx.repos.getMailFolderState(t.ctx.db, accountId, 'INBOX')).toMatchObject({ lastUid: 0 });
    await sync();
    expect(messages()).toHaveLength(1);
    expect(mailbox.messages('INBOX')).toHaveLength(0);
    expect(t.ctx.repos.getMailFolderState(t.ctx.db, accountId, 'INBOX')).toMatchObject({ lastUid: 1 });
  });
});

describe('spoof suspects', () => {
  it('a copycat insurer domain is quarantined with a Needs-you warning and never triaged', async () => {
    const { mailbox } = await setUpMail(t.ctx);
    mailbox.deliver(eml({ from: 'claims@examp1e-insurer.test', subject: `${reference} — new bank details`, body: 'Please pay to our new account.' }));
    await sync();
    const [m] = messages();
    expect(m).toMatchObject({ status: 'quarantined', spoofSuspect: true, folder: 'ClaimDesk-Quarantine' });
    expect(m!.claimId).toBeUndefined();
    expect(mailbox.messages('ClaimDesk-Quarantine')).toHaveLength(1);
    const ny = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: ['spoof_warning'] });
    expect(ny).toHaveLength(1);
    expect(ny[0]).toMatchObject({ priority: 'urgent', claimId });
    expect(queued(t.ctx, 'mail.triage')).toHaveLength(0);
  });

  it('a real insurer domain that fails DMARC is a suspect; passing DMARC is not', async () => {
    const { mailbox } = await setUpMail(t.ctx);
    mailbox.deliver(eml({ from: `claims@${INSURER_DOMAIN}`, subject: reference, authResults: `mx.ionos.co.uk; spf=fail smtp.mailfrom=${INSURER_DOMAIN}; dkim=none; dmarc=fail (p=reject) header.from=${INSURER_DOMAIN}` }));
    mailbox.deliver(eml({ from: `claims@${INSURER_DOMAIN}`, subject: `${reference} again`, authResults: `mx.ionos.co.uk; spf=pass; dkim=pass header.d=${INSURER_DOMAIN}; dmarc=pass header.from=${INSURER_DOMAIN}` }));
    await sync();
    const all = messages().sort((a, b) => (a.subject ?? '').localeCompare(b.subject ?? ''));
    expect(all.map((m) => [m.spoofSuspect, m.status])).toEqual([
      [true, 'quarantined'],
      [false, 'matched'],
    ]);
    expect((all[0]!.authJson as { dmarc?: string }).dmarc).toBe('fail');
  });
});

describe('import folder', () => {
  it('a staged .eml goes through the same ingest (mail.ingest_file) and the import is consumed', async () => {
    await setUpMail(t.ctx);
    const dir = path.join(t.ctx.config.dataDir, 'drop');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'forwarded.eml');
    writeFileSync(file, eml({ subject: `Fwd: ${reference}`, from: 'jane.doe@example.test' }));
    const imp = await stageImportFromFile(t.ctx, file, 'mail', 'folder');
    await sync();
    const [job] = queued(t.ctx, 'mail.ingest_file');
    expect(job?.payload).toEqual({ importId: imp.id });
    expect(job?.idempotencyKey).toBe(`mail.ingest_file:${imp.sha256}`);
    const r = await runJob(t.ctx, job!);
    expect(r.outcome.result).toMatchObject({ duplicate: false, status: 'matched' });
    expect(messages()[0]).toMatchObject({ source: 'file', claimId });
    const { getStagedImport } = await import('../services/imports.js');
    expect(getStagedImport(t.ctx, imp.id)).toMatchObject({ status: 'consumed', consumedBy: 'mail' });
    // running it again is a no-op
    expect((await run(t.ctx, 'mail.ingest_file', { importId: imp.id })).outcome.result).toMatchObject({ skipped: 'already consumed' });
  });
});

describe('IDLE loop and connection health', () => {
  it('new mail during IDLE queues a sync; a reconnect queues one too', async () => {
    const { mailbox } = await setUpMail(t.ctx);
    const loop = startIdleLoop(t.ctx, { sleep: async () => undefined });
    await new Promise((r) => setTimeout(r, 20));
    expect(queued(t.ctx, 'mail.sync')).toHaveLength(1); // on connect
    t.setNow('2026-10-07T09:01:00.000Z');
    mailbox.deliver(eml({ subject: reference }));
    await new Promise((r) => setTimeout(r, 20));
    expect(queued(t.ctx, 'mail.sync').length).toBe(2);
    await loop.stop();
    expect(loop.running).toBe(false);
  });

  it(`${OFFLINE_AFTER_FAILURES} failed connections in a row raise Needs-you "Email offline"`, async () => {
    const { mailbox } = await setUpMail(t.ctx);
    mailbox.failConnect = new Error('ECONNREFUSED (simulated)');
    for (let i = 0; i < OFFLINE_AFTER_FAILURES; i++) await sync();
    const ny = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: ['failure'] });
    expect(ny.map((n) => n.title)).toEqual(['Email offline']);
    expect(mailbox instanceof FakeMailbox).toBe(true);
  });
});

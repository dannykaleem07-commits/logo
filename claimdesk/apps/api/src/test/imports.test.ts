/**
 * The import folder (SUPREME-DESIGN §0.3 point 3, §R.2 point 1): the 10-second stability window (clock injected),
 * `inbox\evidence\<CCG-YYYY-NNNNN>\` attaching itself to the claim, unknown references staying staged, attaching a
 * staged import by hand, consumed / failed marking and the folder routes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import {
  getStagedImport,
  ignoredInboxName,
  inboxDir,
  kindFromMime,
  listStagedImports,
  markImportConsumed,
  markImportFailed,
  resetInboxTracking,
  scanInboxOnce,
  stagedImportPath,
  stageImportFromFile,
} from '../services/imports.js';
import { makePng } from '../seed/png.js';

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };

let t: TestApp;
let inbox: string;
const savedInbox = process.env.CLAIMDESK_INBOX_DIR;

beforeEach(async () => {
  t = await createTestApp('2026-10-05T09:00:00.000Z');
  inbox = path.join(os.tmpdir(), 'claimdesk-inbox-tests', randomUUID());
  process.env.CLAIMDESK_INBOX_DIR = inbox;
  resetInboxTracking();
});
afterEach(async () => {
  if (savedInbox === undefined) delete process.env.CLAIMDESK_INBOX_DIR;
  else process.env.CLAIMDESK_INBOX_DIR = savedInbox;
  rmSync(inbox, { recursive: true, force: true });
  await t.close();
});

function drop(rel: string, data: Buffer | string): string {
  const p = path.join(inbox, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
}

const T0 = Date.parse('2026-10-05T09:00:00.000Z');

describe('inbox location', () => {
  it('uses CLAIMDESK_INBOX_DIR, else <dirname(DATA_DIR)>/inbox', () => {
    expect(inboxDir(t.ctx)).toBe(inbox);
    delete process.env.CLAIMDESK_INBOX_DIR;
    expect(inboxDir(t.ctx)).toBe(path.join(path.dirname(t.ctx.config.dataDir), 'inbox'));
    process.env.CLAIMDESK_INBOX_DIR = inbox;
  });

  it('GET /imports/folder creates the five subfolders; opening it is Windows-only (501 elsewhere)', async () => {
    const res = await t.api<{ path: string; subfolders: Array<{ purpose: string; path: string }> }>('GET', '/imports/folder');
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(inbox);
    expect(res.body.subfolders.map((s) => s.purpose)).toEqual(['evidence', 'intake', 'mail', 'brain-packs', 'engineer-data']);
    for (const s of res.body.subfolders) expect(existsSync(s.path)).toBe(true);
    if (process.platform !== 'win32') {
      const open = await t.api<ErrorBody>('POST', '/imports/folder/open', {});
      expect(open.status).toBe(501);
    }
  });
});

describe('stability window', () => {
  it('takes a file only after its size and mtime are unchanged for 10 seconds', async () => {
    const file = drop('intake/statement.pdf', '%PDF-1.4 part one');
    expect(await scanInboxOnce(t.ctx, T0)).toEqual([]); // first sight
    expect(await scanInboxOnce(t.ctx, T0 + 5_000)).toEqual([]); // stable for 5 s only
    appendFileSync(file, ' and part two\n%%EOF\n'); // still being copied
    expect(await scanInboxOnce(t.ctx, T0 + 11_000)).toEqual([]); // changed → the clock restarts
    expect(await scanInboxOnce(t.ctx, T0 + 20_000)).toEqual([]); // 9 s stable
    const taken = await scanInboxOnce(t.ctx, T0 + 21_000);
    expect(taken).toHaveLength(1);
    const imp = taken[0]!;
    const bytes = readFileSync(stagedImportPath(t.ctx, imp.id));
    expect(imp).toMatchObject({ purpose: 'intake', filename: 'statement.pdf', source: 'folder', status: 'staged', mime: 'application/pdf', bytes: bytes.length });
    expect(imp.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(existsSync(file)).toBe(false); // moved, not copied
    expect(stagedImportPath(t.ctx, imp.id).startsWith(path.join(t.ctx.config.dataDir, 'imports', 'intake', imp.id))).toBe(true);
    expect(existsSync(path.join(t.ctx.config.dataDir, 'imports', 'intake', imp.id, 'manifest.json'))).toBe(true);
    expect(t.ctx.repos.listAudit(t.ctx.db, { entity: 'imports', entityId: imp.id }).map((a) => a.action)).toContain('import.staged');
    // nothing left to take
    expect(await scanInboxOnce(t.ctx, T0 + 40_000)).toEqual([]);
  });

  it('never takes partial downloads, lock files or hidden files', async () => {
    for (const n of ['x.crdownload', '~$letter.docx', '.hidden', 'copy.tmp', 'a.part', 'desktop.ini']) expect(ignoredInboxName(n)).toBe(true);
    expect(ignoredInboxName('AUDATEX.cab')).toBe(false);
    drop('engineer-data/AUDATEX.cab.crdownload', 'partial');
    drop('mail/~$draft.eml', 'lock');
    await scanInboxOnce(t.ctx, T0);
    expect(await scanInboxOnce(t.ctx, T0 + 60_000)).toEqual([]);
  });

  it('stages mail, brain packs and engineer data for the slices that consume them', async () => {
    drop('mail/message.eml', 'From: a@example.com\r\nSubject: test\r\n\r\nbody');
    drop('brain-packs/rules.ccbrain', 'synthetic');
    drop('engineer-data/sample.cab', 'MSCF synthetic');
    await scanInboxOnce(t.ctx, T0);
    const taken = await scanInboxOnce(t.ctx, T0 + 10_000);
    expect(taken.map((i) => i.purpose).sort()).toEqual(['brain-packs', 'engineer-data', 'mail']);
    expect(listStagedImports(t.ctx, { purpose: 'mail' })[0]?.mime).toBe('message/rfc822');
    expect(listStagedImports(t.ctx, { purpose: 'engineer-data' })[0]?.mime).toBe('application/vnd.ms-cab-compressed');
    expect(listStagedImports(t.ctx, { status: 'staged' })).toHaveLength(3);
  });
});

describe('evidence by claim reference', () => {
  it('inbox\\evidence\\<CCG-ref>\\ attaches to that claim as evidence (system, audited evidence.import_folder)', async () => {
    const ids = t.ctx.repos.seedFileOne(t.ctx.db);
    recomputeClocks(t.ctx, ids.claimId);
    const claim = t.ctx.repos.requireClaim(t.ctx.db, ids.claimId);
    const png = makePng({ seed: 77 });
    const file = drop(`evidence/${claim.reference}/front left.png`, png);
    const before = t.ctx.repos.listEvidenceForClaim(t.ctx.db, claim.id, {}).length;
    await scanInboxOnce(t.ctx, T0);
    const taken = await scanInboxOnce(t.ctx, T0 + 10_000);
    expect(taken).toHaveLength(1);
    const imp = taken[0]!;
    expect(imp.status).toBe('consumed');
    expect(imp.consumedBy).toBe('evidence');
    expect(imp.claimRef).toBe(claim.reference);
    const rows = t.ctx.repos.listEvidenceForClaim(t.ctx.db, claim.id, {});
    expect(rows.length).toBe(before + 1);
    const ev = rows.find((e) => e.sha256 === createHash('sha256').update(png).digest('hex'))!;
    expect(ev).toMatchObject({ kind: 'photo', uploadedBy: 'system', mime: 'image/png', filename: 'front left.png' });
    expect((imp.result as { evidenceId: string }).evidenceId).toBe(ev.id);
    expect(t.ctx.repos.listAudit(t.ctx.db, { entity: 'evidence', entityId: ev.id }).map((a) => a.action)).toEqual(expect.arrayContaining(['evidence.upload', 'evidence.import_folder']));
    expect(existsSync(file)).toBe(false);
    // the stored file verifies
    const verify = await t.api<{ status: string }>('POST', `/evidence/${ev.id}/verify`);
    expect(verify.body.status).toBe('intact');
    // GET /imports shows it as consumed
    const list = await t.api<{ items: Array<{ id: string; status: string }> }>('GET', '/imports?purpose=evidence&status=consumed');
    expect(list.body.items.map((i) => i.id)).toContain(imp.id);
  });

  it('an unknown reference stays staged; attaching it by hand stores it on the chosen claim', async () => {
    const ids = t.ctx.repos.seedFileOne(t.ctx.db);
    drop('evidence/CCG-2099-99999/invoice.pdf', '%PDF-1.4 synthetic invoice\n%%EOF\n');
    drop('evidence/loose.txt', 'no claim folder');
    await scanInboxOnce(t.ctx, T0);
    const taken = await scanInboxOnce(t.ctx, T0 + 10_000);
    expect(taken).toHaveLength(2);
    const unknown = taken.find((i) => i.filename === 'invoice.pdf')!;
    expect(unknown).toMatchObject({ status: 'staged', claimRef: 'CCG-2099-99999', purpose: 'evidence' });
    expect(taken.find((i) => i.filename === 'loose.txt')?.claimRef).toBeUndefined();

    const attached = await t.api<{ id: string; claimId: string; kind: string; importId: string; deduped: boolean }>('POST', `/imports/${unknown.id}/attach-evidence`, { claimId: ids.claimId, kind: 'invoice' });
    expect(attached.status).toBe(201);
    expect(attached.body).toMatchObject({ claimId: ids.claimId, kind: 'invoice', importId: unknown.id, deduped: false });
    expect(getStagedImport(t.ctx, unknown.id)?.status).toBe('consumed');
    const twice = await t.api<ErrorBody>('POST', `/imports/${unknown.id}/attach-evidence`, { claimId: ids.claimId, kind: 'invoice' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('IMPORT_CONSUMED');
    expect((await t.api('POST', '/imports/00000000-0000-0000-0000-000000000000/attach-evidence', { claimId: ids.claimId })).status).toBe(404);
    expect((await t.api('POST', `/imports/${unknown.id}/attach-evidence`, { kind: 'invoice' })).status).toBe(400);
  });
});

describe('consumed / failed marking', () => {
  it('marks an import failed, then consumed; the same consumer is idempotent, another is refused', async () => {
    const src = path.join(inbox, 'scratch', 'x.eml');
    mkdirSync(path.dirname(src), { recursive: true });
    writeFileSync(src, 'Subject: hi\r\n\r\nhello');
    const imp = await stageImportFromFile(t.ctx, src, 'mail', 'folder');
    expect(imp.status).toBe('staged');
    const failed = markImportFailed(t.ctx, imp.id, 'Could not parse the message');
    expect(failed).toMatchObject({ status: 'failed', error: 'Could not parse the message' });
    expect(listStagedImports(t.ctx, { status: 'failed' }).map((i) => i.id)).toEqual([imp.id]);
    const consumed = markImportConsumed(t.ctx, imp.id, 'mail.ingest_file', { messageId: 'm1' });
    expect(consumed).toMatchObject({ status: 'consumed', consumedBy: 'mail.ingest_file', result: { messageId: 'm1' }, consumedAt: '2026-10-05T09:00:00.000Z' });
    expect(consumed.error).toBeUndefined();
    expect(markImportConsumed(t.ctx, imp.id, 'mail.ingest_file').status).toBe('consumed');
    expect(() => markImportConsumed(t.ctx, imp.id, 'intake')).toThrowError(/already used/);
    expect(() => markImportFailed(t.ctx, imp.id, 'late')).toThrowError(/already used/);
    expect(() => markImportConsumed(t.ctx, 'no-such-import-id', 'x')).toThrowError(/not found/);
  });

  it('guesses the evidence kind from the MIME type', () => {
    expect(kindFromMime('image/jpeg')).toBe('photo');
    expect(kindFromMime('video/mp4')).toBe('video');
    expect(kindFromMime('audio/mpeg')).toBe('call_recording');
    expect(kindFromMime('application/pdf')).toBe('pdf');
    expect(kindFromMime('message/rfc822')).toBe('correspondence');
    expect(kindFromMime('application/zip')).toBe('document');
  });
});

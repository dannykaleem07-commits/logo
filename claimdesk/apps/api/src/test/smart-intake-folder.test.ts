// owned by intake-server
/**
 * Folder bundles (docs/SMART-INTAKE.md §6.11): a subfolder of inbox\intake\ that is not a claim reference becomes a
 * bundle; folder names differing only by case join the same open bundle (Windows); a folder reused after its bundle
 * closed starts "<folder> (2)"; claim-reference folders keep today's behaviour.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import { resetInboxTracking, scanInboxOnce } from '../services/imports.js';
import { scanStagedIntakeImports } from '../intake/items.js';
import { NOW, setAgents } from './fixtures/smartIntake/scenario.js';
import { textPdf } from './fixtures/smartIntake/files.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let t: TestApp;
let inbox: string;
const before = process.env.CLAIMDESK_INBOX_DIR;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
  setAgents(t.ctx, false);
  inbox = path.join(t.ctx.config.dataDir, 'inbox-test');
  process.env.CLAIMDESK_INBOX_DIR = inbox;
  resetInboxTracking();
});
afterEach(async () => {
  if (before === undefined) delete process.env.CLAIMDESK_INBOX_DIR;
  else process.env.CLAIMDESK_INBOX_DIR = before;
  resetInboxTracking();
  await t.close();
});

async function drop(folder: string, name: string, lines: string[]): Promise<void> {
  const dir = path.join(inbox, 'intake', folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), await textPdf([lines]));
}

async function scan(): Promise<void> {
  const now = Date.parse(t.ctx.now());
  await scanInboxOnce(t.ctx, now);
  await scanInboxOnce(t.ctx, now + 11_000);
  await scanStagedIntakeImports(t.ctx);
}

describe('folder bundles', () => {
  it('turns an inbox subfolder into a bundle; same name in another case joins it; a closed one starts (2)', async () => {
    await drop('Jane Folder Test', 'v5c.pdf', ['DVLA V5C Registration Certificate', 'Registration number: KX21 ABC']);
    await drop('jane folder test', 'letter.pdf', ['Our ref: TPI/778812', 'Dear Sirs']);
    await scan();
    let list = (await t.api<Any>('GET', '/intake/bundles')).body;
    expect(list.total).toBe(1);
    const b = list.items[0];
    // whichever spelling the folder scan meets first names the bundle; the other joins it
    expect(b.source).toBe('folder');
    expect(b.name.toLowerCase()).toBe('jane folder test');
    expect(b.folderKey).toBe(b.name);
    expect(b.fileCounts.total).toBe(2);
    expect((await t.api<Any>('POST', `/intake/bundles/${b.id}/cancel`, { reason: 'test folder' })).status).toBe(200);
    await drop('Jane Folder Test', 'more.pdf', ['A later letter']);
    await scan();
    list = (await t.api<Any>('GET', '/intake/bundles')).body;
    expect(list.items.map((x: Any) => x.name)).toEqual(['Jane Folder Test (2)']);
    expect(list.items[0].folderKey).toBe('Jane Folder Test');
    const audit = t.ctx.handle.sqlite.prepare(`SELECT after FROM audit_log WHERE action = 'intake.bundle.create'`).all() as Array<{ after: string }>;
    expect(audit.map((a) => JSON.parse(a.after).source)).toEqual(['folder', 'folder']);
  });

  it('a claim-reference folder is read for that claim as before', async () => {
    const claim = (await t.api<{ id: string; reference: string }>('POST', '/claims', FNOL)).body;
    await drop(claim.reference, 'letter.pdf', ['A letter for the claim']);
    await scan();
    expect((await t.api<Any>('GET', '/intake/bundles')).body.total).toBe(0);
    const items = t.ctx.repos.listIntakeItems(t.ctx.db, { claimId: claim.id });
    expect(items).toHaveLength(1);
  });
});

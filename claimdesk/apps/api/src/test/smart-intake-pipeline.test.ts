// owned by intake-server
/**
 * Smart intake — the per-file pipeline (docs/SMART-INTAKE.md §5): ZIP unpacking and its limits, EML attachments
 * joining the bundle, PDF metadata, photo hashes, the rules reading, the AI reading kept as the best one after a
 * re-read, text-pack splitting and keeping a pack whole. Every file is generated here; no model is called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { drain, editedEstimateA, emlA, NOW, photo2041, setAgents, textPackA, uploadToBundle, v5cA } from './fixtures/smartIntake/scenario.js';
import { zipOf } from './fixtures/smartIntake/files.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let t: TestApp;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
  setAgents(t.ctx, false);
});
afterEach(async () => {
  await t.close();
});

const bundle = async (name = 'Jane Doe – Corsa crash') => (await t.api<Any>('POST', '/intake/bundles', { name })).body.id as string;
const detail = async (id: string) => (await t.api<Any>('GET', `/intake/bundles/${id}`)).body;

/** Mark an entry of a ZIP as encrypted (general purpose flag bit 0 in its central directory record). */
function encrypt(zip: Buffer, name: string): Buffer {
  const out = Buffer.from(zip);
  for (let i = 0; i + 46 < out.length; i += 1) {
    if (out.readUInt32LE(i) !== 0x02014b50) continue;
    const n = out.readUInt16LE(i + 28);
    if (out.subarray(i + 46, i + 46 + n).toString('utf8') === name) out.writeUInt16LE(out.readUInt16LE(i + 8) | 1, i + 8);
  }
  return out;
}

describe('ZIP archives', () => {
  it('unpacks within the limits and says why each skipped entry was skipped', async () => {
    expect((await t.api('PATCH', '/settings/intake', { archives: { maxEntries: 2, maxDepth: 0 } })).status).toBe(200);
    const zip = encrypt(
      zipOf({
        'zeros.bin': Buffer.alloc(2 * 1024 * 1024),
        'secret.txt': Buffer.from('a secret\n'),
        'a.txt': Buffer.from('first note: Registration: KX21 ABC\n'),
        'b.txt': Buffer.from('second note\n'),
        'c.txt': Buffer.from('third note\n'),
        '__MACOSX/._a.txt': Buffer.from('resource fork'),
      }),
      'secret.txt',
    );
    const inner = zipOf({ 'deep.zip': zipOf({ 'x.txt': Buffer.from('too deep\n') }) });
    const id = await bundle();
    await uploadToBundle(t, id, [
      { filename: 'notes.zip', mime: 'application/zip', content: zip },
      { filename: 'nested.zip', mime: 'application/zip', content: inner },
    ]);
    await drain(t);
    const d = await detail(id);
    const z = d.files.find((f: Any) => f.filename === 'notes.zip');
    expect(z.stage).toBe('unpacked');
    expect(z.role).toBe('archive');
    expect(z.archive.entries).toBe(2);
    const reasons = z.archive.skipped.map((s: Any) => `${s.name}: ${s.reason}`).join('\n');
    expect(reasons).toMatch(/zeros\.bin: compression ratio \d+:1 is above 200:1/);
    expect(reasons).toMatch(/secret\.txt: encrypted/);
    expect(reasons).toMatch(/c\.txt: more than 2 files/);
    expect(reasons).toMatch(/\._a\.txt/);
    const children = d.files.filter((f: Any) => f.parentFileId === z.id);
    expect(children.map((f: Any) => f.filename).sort()).toEqual(['a.txt', 'b.txt']);
    // nested: the ZIP inside the ZIP is unpacked, the one inside it is not (depth 0)
    const deep = d.files.find((f: Any) => f.filename === 'deep.zip');
    expect(deep).toBeTruthy();
    expect(deep.error).toMatch(/ZIP inside 1 other ZIP/);
    expect(d.files.some((f: Any) => f.filename === 'x.txt')).toBe(false);
    expect(t.ctx.handle.sqlite.prepare(`SELECT count(*) AS n FROM audit_log WHERE action = 'intake.unpack'`).get()).toMatchObject({ n: 2 });
  });
});

describe('per-file facts', () => {
  it('EML attachments join the bundle; PDF metadata, photo hashes and the rules reading are stored', async () => {
    const id = await bundle();
    await uploadToBundle(t, id, [await emlA(), await editedEstimateA(), photo2041(), await v5cA()]);
    await drain(t);
    const d = await detail(id);
    const eml = d.files.find((f: Any) => f.filename === 'SMART-A-EMAIL.eml');
    expect(eml.role).toBe('email');
    const att = d.files.find((f: Any) => f.filename === 'SMART-A-TP-LETTER.pdf');
    expect(att).toMatchObject({ role: 'attachment', parentFileId: eml.id });
    const est = d.files.find((f: Any) => f.filename === 'SMART-A-ESTIMATE-EDITED.pdf');
    expect(est.pdfMeta).toMatchObject({ producer: 'iLovePDF' });
    expect(est.pdfMeta.incrementalUpdates).toBeGreaterThanOrEqual(1);
    const photo = d.files.find((f: Any) => f.filename === 'SMART-A-PHOTO-2041.png');
    expect(t.ctx.repos.getBundleFile(t.ctx.db, photo.id)?.phash).toMatch(/^[0-9a-f]{16}$/);
    expect(photo.photo.takenAt).toBe('2026-10-01T09:05:00.000Z');
    expect(photo.photo.gps).toMatchObject({ lat: 51.5 });
    for (const f of d.files.filter((x: Any) => x.mime === 'application/pdf')) {
      const rows = t.ctx.repos.listIntakeExtractions(t.ctx.db, f.itemId);
      expect(rows.some((r) => r.schemaId === 'intake_rules/1' && (r.extras as Any)?.engine === 'rules')).toBe(true);
    }
    expect(d.files.find((f: Any) => f.filename === 'SMART-A-V5C.pdf')).toMatchObject({ docType: 'v5c', engine: 'rules', stage: 'waiting_ai' });
  });

  it('keeps the AI reading as the best one after a re-read', async () => {
    setAgents(t.ctx, true);
    const id = await bundle();
    const up = await uploadToBundle(t, id, [await v5cA()]);
    await drain(t);
    const itemId = up.body.files[0]!.itemId;
    expect(t.ctx.repos.extractionEngine(t.ctx.repos.bestIntakeExtraction(t.ctx.db, itemId)!)).toBe('ai');
    expect((await t.api('POST', `/intake/${itemId}/retry`, { from: 'process' })).status).toBeLessThan(300);
    await drain(t, { ai: false });
    const rows = t.ctx.repos.listIntakeExtractions(t.ctx.db, itemId);
    expect(rows.filter((r) => t.ctx.repos.extractionEngine(r) === 'rules').length).toBeGreaterThanOrEqual(2);
    expect(t.ctx.repos.extractionEngine(t.ctx.repos.bestIntakeExtraction(t.ctx.db, itemId)!)).toBe('ai');
  });
});

describe('scanned packs', () => {
  it('splits a text pack into documents and keeps it whole when the owner says so', async () => {
    const id = await bundle();
    await uploadToBundle(t, id, [await textPackA()]);
    await drain(t);
    let d = await detail(id);
    const pack = d.files.find((f: Any) => f.filename === 'SMART-A-PACK.pdf');
    expect(pack.role).toBe('pack');
    const segs = d.files.filter((f: Any) => f.parentFileId === pack.id);
    expect(segs.map((f: Any) => [f.docType, f.segment.fromPage, f.segment.toPage])).toEqual([
      ['police_report', 1, 1],
      ['bodyshop_estimate', 2, 3],
      ['mot_certificate', 4, 4],
    ]);
    expect(t.ctx.handle.sqlite.prepare(`SELECT count(*) AS n FROM audit_log WHERE action = 'intake.split_pack'`).get()).toMatchObject({ n: 1 });
    expect((await t.api<Any>('POST', `/intake/bundles/${id}/files/${segs[0].id}/unsplit`, {})).status).toBe(400);
    const r = await t.api<Any>('POST', `/intake/bundles/${id}/files/${pack.id}/unsplit`, {});
    expect(r.status).toBe(200);
    d = r.body;
    expect(d.files.filter((f: Any) => f.parentFileId === pack.id).every((f: Any) => f.excluded)).toBe(true);
    expect(d.files.find((f: Any) => f.id === pack.id).excluded).toBe(false);
    // the evidence of the segments stays
    for (const s of segs) expect(t.ctx.repos.getEvidence(t.ctx.db, s.evidenceId)).toBeTruthy();
  });
});

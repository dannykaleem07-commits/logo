// owned by casework
/**
 * Brain packs (docs/SUPREME-DESIGN.md §E.1, §E.4, §E.5, §E.6, §L.10): a synthetic `.ccbrain` (built here — no pack file
 * is tracked) and the synthetic skill folder in test/fixtures/brain import with per-file sha256 checks into
 * DATA_DIR/brain/packs, versions sit side by side, activation / rollback, precedence + the CCGUK business filter,
 * FTS search, the versioned digest, staged imports (brain.import) and memory approvals. All content is invented.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { packDigest, brainSearch, activeRedLines } from '../brain/search.js';
import { packsRoot, parsePack, readCcbrain, splitMarkdown } from '../brain/packs.js';
import { recordCorrection } from '../brain/memory.js';
import { stageImport } from '../services/imports.js';
import { run } from './fixtures/mail/helpers.js';

const SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'brain', 'skill-folder');
const T0 = '2026-10-07T09:00:00.000Z';

let t: TestApp;
let work: string;
beforeEach(async () => {
  t = await createTestApp(T0);
  work = path.join(path.dirname(t.ctx.config.dataDir), 'pack-sources');
  mkdirSync(work, { recursive: true });
});
afterEach(async () => {
  await t.close();
});

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

interface PackSpec {
  id?: string;
  version?: string;
  business?: string[];
  precedence?: number;
  kind?: string;
  entries?: Array<Record<string, unknown>>;
  docs?: Record<string, string>;
  tamper?: boolean;
}

/** A synthetic .ccbrain with a valid manifest (sha256 per file). */
function ccbrain(spec: PackSpec = {}): Uint8Array {
  const entries = spec.entries ?? [
    { id: 'storage-delay', kind: 'strategy', title: 'Storage while the insurer delays', body: 'Invented: storage keeps running while the insurer delays inspection; record each delay.', tags: ['storage'] },
    { id: 'no-threats', kind: 'redLine', title: 'No threats', pattern: 'we will issue proceedings', action: 'block', message: 'Never threaten proceedings without the owner', scope: 'all' },
    { id: 'insurer-style', kind: 'letterStyle', title: 'Writing to insurers', recipientRole: 'at_fault_insurer', register: 'formal', do: ['be brief'], dont: ['use jargon'], signoff: 'Claims Team, Courtesy Cars Group UK Ltd', exemplars: [] },
    { id: 'kb-like', kind: 'knowledge', title: 'Mitigation of storage', body: 'Invented knowledge about mitigation of storage charges.', verification: 'unverified' },
  ];
  const files: Record<string, Uint8Array> = {
    'entries/main.jsonl': strToU8(entries.map((e) => JSON.stringify(e)).join('\n')),
    ...Object.fromEntries(Object.entries(spec.docs ?? { 'docs/guide.md': '# Guide\n\nInvented storage guidance.\n\n## Sample wording\n\nInvented letter wording.' }).map(([k, v]) => [k, strToU8(v)])),
  };
  const manifest = {
    schema: 'claimdesk.brainpack/1',
    id: spec.id ?? 'synthetic-ccguk',
    name: 'Synthetic CCGUK rules',
    version: spec.version ?? '1.0.0',
    publisher: 'test',
    kind: spec.kind ?? 'ccguk',
    business: spec.business ?? ['ccguk'],
    topics: ['storage'],
    precedence: spec.precedence ?? 30,
    requiresApp: '>=0.4.0',
    licence: 'private',
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, spec.tamper ? '0'.repeat(64) : sha(v)])),
  };
  return zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), ...files });
}

function writePack(name: string, bytes: Uint8Array): string {
  const p = path.join(work, name);
  writeFileSync(p, bytes);
  return p;
}

const importPath = (p: string) => t.api<Record<string, any>>('POST', '/brain/packs/import', { path: p }); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('parsing', () => {
  it('splits Markdown at headings and reads a skill folder as strategy / knowledge / snippet entries', () => {
    expect(splitMarkdown('intro\n# A\none\n## B\ntwo\n```\n# not a heading\n```', 'Doc').map((s) => s.title)).toEqual(['Doc', 'A', 'B']);
    const files = new Map<string, Uint8Array>([['SKILL.md', strToU8('---\nname: X Pack\n---\n## Do this\nsteps')], ['references/r.md', strToU8('# Ref\ntext\n## Email template\nwording')]]);
    const p = parsePack(files);
    expect(p.sourceKind).toBe('skill');
    expect(p.manifest.id).toBe('x-pack');
    expect(p.entries.map((e) => `${e.kind}:${e.id}`)).toEqual(['strategy:skill/do-this', 'knowledge:ref/r/ref', 'snippet:ref/r/email-template']);
  });

  it('refuses unsafe zip paths, tampered files and invalid manifests', () => {
    expect(() => readCcbrain(zipSync({ '../evil.txt': strToU8('x') }))).toThrow(/Unsafe path/);
    expect(() => parsePack(readCcbrain(ccbrain({ tamper: true })))).toThrow(/does not match its sha256/);
    const bad = zipSync({ 'manifest.json': strToU8(JSON.stringify({ schema: 'nope', id: 'Bad Id' })) });
    expect(() => parsePack(readCcbrain(bad))).toThrow(/manifest.json/);
    const red = ccbrain({ entries: [{ id: 'r', kind: 'redLine', title: 'R', action: 'maybe' }] });
    expect(() => parsePack(readCcbrain(red))).toThrow(/redLine/);
  });
});

describe('import, versions and activation', () => {
  it('imports a .ccbrain from a path into DATA_DIR/brain/packs (inactive), de-duplicates, and audits', async () => {
    const res = await importPath(writePack('rules-1.ccbrain', ccbrain()));
    expect(res.status).toBe(201);
    expect(res.body.preview).toMatchObject({ packId: 'synthetic-ccguk', version: '1.0.0', kind: 'ccguk', entries: 6, byKind: { knowledge: 2, letterStyle: 1, redLine: 1, snippet: 1, strategy: 1 } });
    expect(res.body.version.storagePath.startsWith(packsRoot(t.ctx))).toBe(true);
    expect(packsRoot(t.ctx).startsWith(t.ctx.config.dataDir)).toBe(true);
    expect(res.body.pack.activeVersion).toBeUndefined();
    const again = await importPath(writePack('rules-1-copy.ccbrain', ccbrain()));
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'brain.pack.import' })).toHaveLength(1);
    expect((await importPath('relative/path.ccbrain')).status).toBe(400);
    expect((await importPath(writePack('bad.ccbrain', ccbrain({ tamper: true })))).body.error.code).toBe('BRAIN_PACK_INVALID');
  });

  it('activates, rolls back to an older version and deactivates', async () => {
    await importPath(writePack('v1.ccbrain', ccbrain()));
    await importPath(writePack('v2.ccbrain', ccbrain({ version: '1.1.0', entries: [{ id: 'storage-delay', kind: 'strategy', title: 'Storage v2', body: 'Invented second version about chasers only.' }] })));
    const a2 = await t.api<Record<string, unknown>>('POST', '/brain/packs/synthetic-ccguk/activate', { version: '1.1.0' });
    expect(a2.status).toBe(200);
    expect(a2.body.activeVersion).toBe('1.1.0');
    expect(new Set(brainSearch(t.ctx, { q: 'storage' }).map((h) => h.version))).toEqual(new Set(['1.1.0']));
    const rb = await t.api<Record<string, unknown>>('POST', '/brain/packs/synthetic-ccguk/activate', { version: '1.0.0' });
    expect(rb.body.activeVersion).toBe('1.0.0');
    expect(brainSearch(t.ctx, { q: 'inspection' })[0]).toMatchObject({ version: '1.0.0', entryId: 'storage-delay', ref: 'pack:synthetic-ccguk@1.0.0#storage-delay' });
    const audits = t.ctx.repos.listAudit(t.ctx.db, { action: 'brain.pack.activate' });
    expect(audits.map((x) => (x.after as { rollback: boolean }).rollback)).toEqual(expect.arrayContaining([true, false]));
    const list = await t.api<{ packs: Array<{ id: string; versions: unknown[]; activeVersion?: string }> }>('GET', '/brain/packs');
    expect(list.body.packs[0]).toMatchObject({ id: 'synthetic-ccguk', activeVersion: '1.0.0' });
    expect(list.body.packs[0]!.versions).toHaveLength(2);
    await t.api('POST', '/brain/packs/synthetic-ccguk/deactivate', {});
    expect(brainSearch(t.ctx, { q: 'storage' })).toEqual([]);
    expect((await t.api('POST', '/brain/packs/synthetic-ccguk/activate', { version: '9.9.9' })).status).toBe(404);
  });

  it('imports the synthetic skill folder; business tags must be chosen before activation', async () => {
    const res = await importPath(SKILL_DIR);
    expect(res.status).toBe(201);
    expect(res.body.preview).toMatchObject({ packId: 'synthetic-playbook', version: '0.1.0', kind: 'playbook', sourceKind: 'skill', business: [], precedence: 40 });
    expect(res.body.preview.byKind).toMatchObject({ strategy: 2, snippet: 1, knowledge: 3 });
    expect((await t.api<{ error: { message: string } }>('POST', '/brain/packs/synthetic-playbook/activate', {})).body.error.message).toMatch(/business/);
    const ok = await t.api<Record<string, unknown>>('POST', '/brain/packs/synthetic-playbook/activate', { business: ['fixmyfile'] });
    expect(ok.body).toMatchObject({ activeVersion: '0.1.0', business: ['fixmyfile'], useForCcguk: false });
  });
});

describe('retrieval: precedence, business filter, FTS, digest', () => {
  beforeEach(async () => {
    await importPath(writePack('rules.ccbrain', ccbrain()));
    await t.api('POST', '/brain/packs/synthetic-ccguk/activate', {});
    await importPath(SKILL_DIR);
    await t.api('POST', '/brain/packs/synthetic-playbook/activate', { business: ['fixmyfile'] });
  });

  it('keeps Fixmyfile-only strategy out of CCGUK work unless the owner allows it; precedence orders the merge', async () => {
    const ccguk = brainSearch(t.ctx, { q: 'storage inspection delay', business: 'ccguk' });
    expect(new Set(ccguk.map((h) => h.packId))).toEqual(new Set(['synthetic-ccguk']));
    expect(brainSearch(t.ctx, { q: 'ombudsman consumer', business: 'ccguk' })).toEqual([]);
    expect(brainSearch(t.ctx, { q: 'ombudsman consumer', business: 'fixmyfile' }).map((h) => h.packId)).toEqual(['synthetic-playbook']);
    await t.api('POST', '/brain/packs/synthetic-playbook/activate', { business: ['fixmyfile'], useForCcguk: true });
    const both = brainSearch(t.ctx, { q: 'storage delay inspection', business: 'ccguk', limit: 20 });
    expect(new Set(both.map((h) => h.packId))).toEqual(new Set(['synthetic-ccguk', 'synthetic-playbook']));
    const firstPlaybook = both.findIndex((h) => h.packId === 'synthetic-playbook');
    expect(both.slice(0, firstPlaybook).every((h) => h.packId === 'synthetic-ccguk')).toBe(true);
    const route = await t.api<{ hits: Array<{ ref: string }> }>('GET', '/brain/search?q=storage&kinds=strategy');
    expect(route.body.hits.map((h) => h.ref)).toContain('pack:synthetic-ccguk@1.0.0#storage-delay');
  });

  it('the digest is stable, versioned and lists every red line', async () => {
    const d1 = packDigest(t.ctx)!;
    expect(d1.id).toBe('pack:synthetic-ccguk@1.0.0+synthetic-playbook@0.1.0');
    expect(packDigest(t.ctx)).toEqual(d1);
    expect(d1.text).toContain('Never threaten proceedings without the owner');
    expect(d1.text).toContain('Letter style (at_fault_insurer)');
    expect(d1.text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(activeRedLines(t.ctx).map((r) => r.ref)).toEqual(['pack:synthetic-ccguk@1.0.0#no-threats']);
    await t.api('POST', '/brain/packs/synthetic-playbook/deactivate', {});
    expect(packDigest(t.ctx)!.id).toBe('pack:synthetic-ccguk@1.0.0');
  });
});

describe('staged imports (brain.import) and memory', () => {
  it('a .ccbrain dropped in the import folder is imported by the brain.import job (inactive)', async () => {
    const src = writePack('dropped.ccbrain', ccbrain({ id: 'dropped-pack' }));
    const imp = await stageImport(t.ctx, src, { purpose: 'brain-packs', source: 'folder' });
    const r = await run(t.ctx, 'brain.import', { importId: imp.id });
    expect(r.outcome).toMatchObject({ kind: 'done', result: { packId: 'dropped-pack', version: '1.0.0', active: null } });
    expect(t.ctx.repos.getBrainPack(t.ctx.db, 'dropped-pack')?.activeVersion).toBeUndefined();
    const again = await run(t.ctx, 'brain.import', { importId: imp.id });
    expect(again.outcome.result).toMatchObject({ skipped: 'already imported' });
  });

  it('the owner approves or retires memory; corrections are stored as proposed items', async () => {
    const claimId = t.ctx.repos.seedFileOne(t.ctx.db).claimId;
    const c = recordCorrection(t.ctx, { needsYouId: 'ny-1', kind: 'approve_send', claimId, optionId: 'edit', before: { bodyText: 'Old text' }, after: { bodyText: 'New text' }, actor: { userId: 'owner' } });
    expect(c).toMatchObject({ kind: 'correction', status: 'proposed', scope: `claim:${claimId}` });
    expect(c.text).toContain('bodyText');
    const list = await t.api<{ items: Array<{ id: string }>; counts: { proposed: number } }>('GET', '/memory');
    expect(list.body.items.map((i) => i.id)).toEqual([c.id]);
    expect((await t.api<Record<string, unknown>>('POST', `/memory/${c.id}/approve`, {})).body.status).toBe('approved');
    expect((await t.api<Record<string, unknown>>('POST', `/memory/${c.id}/retire`, {})).body.status).toBe('retired');
    expect((await t.api('POST', `/memory/${c.id}/approve`, {})).status).toBe(400);
  });
});

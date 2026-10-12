// owned by intake-web
/** Case bundles client (docs/SMART-INTAKE.md §8.2): paths, methods, bodies; detail normalising; polling rules. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundlesApi, bundleInProgress, detailIsStale, listRefetchMs, normaliseDetail, signalCounts, type BundleSummary } from './bundlesApi';
import { bundleDetail, mockApi } from '../screens/intake/bundles/__fixtures__/mockApi';

afterEach(() => vi.unstubAllGlobals());

describe('bundlesApi routes', () => {
  it('calls every route of §8.2 with the right method and body', async () => {
    const d = bundleDetail();
    const api = mockApi({
      'GET /intake/bundles': () => ({ items: [], total: 0 }),
      'POST /intake/bundles': (c) => ({ status: 201, body: { ...d, name: (c.body as { name: string }).name } }),
      'GET /intake/bundles/:id': () => d,
      'POST /intake/bundles/:id/:a': () => d,
      'POST /intake/bundles/:id/:a/:b': () => d,
      'POST /intake/bundles/:id/:a/:b/:c': () => d,
      'PATCH /intake/bundles/:id': () => d,
      'PATCH /settings/intake': () => ({ settings: {}, defaults: {} }),
    });
    vi.stubGlobal('fetch', vi.fn(api.fetch));
    await bundlesApi.list('done');
    await bundlesApi.create('  Jane Doe – Corsa crash ');
    await bundlesApi.get('b1');
    await bundlesApi.rename('b1', 'New name');
    await bundlesApi.addFromUpload('b1', 'up-1');
    await bundlesApi.addFromImport('b1', 'imp-1');
    await bundlesApi.addFromEvidence('b1', 'ev-1');
    await bundlesApi.moveFile('b1', 'f9', 'new');
    await bundlesApi.excludeFile('b1', 'f12', true, 'not ours');
    await bundlesApi.unsplit('b1', 'f6');
    await bundlesApi.fileCopy('b1', 'f4');
    await bundlesApi.setField('b1', 'client.phone', '07700 900123');
    await bundlesApi.setWitnesses('b1', [{ name: 'Ali Example', relationship: 'passer-by' }], true);
    await bundlesApi.chooseConflict('b1', 'c:vehicle.vin', 'WVWZZZ1JZXW000001');
    await bundlesApi.acceptPreselected('b1');
    await bundlesApi.confirmNew('b1');
    await bundlesApi.linkParty('b1', null);
    await bundlesApi.tickTimeline('b1', 't:aaa', false);
    await bundlesApi.ackSignal('b1', 's:1', 'camera clock');
    await bundlesApi.thinkAgain('b1');
    await bundlesApi.register('b1', { acceptPreselected: true, groups: { 'case:B': 'split_off' } });
    await bundlesApi.registerRetry('b1');
    await bundlesApi.attach('b1', { claimId: 'c-old', groupKey: 'main', apply: ['client.phone'] });
    await bundlesApi.cancel('b1', 'Duplicate upload');
    await bundlesApi.reopen('b1');
    await bundlesApi.wizardDraft('b1');
    await bundlesApi.patchSettings({ bundles: { autoRegister: true } });
    const seen = api.calls.map((c) => `${c.method} ${c.path}`);
    expect(seen).toEqual([
      'GET /intake/bundles',
      'POST /intake/bundles',
      'GET /intake/bundles/b1',
      'PATCH /intake/bundles/b1',
      'POST /intake/bundles/b1/files',
      'POST /intake/bundles/b1/files',
      'POST /intake/bundles/b1/files',
      'POST /intake/bundles/b1/files/f9/move',
      'POST /intake/bundles/b1/files/f12/exclude',
      'POST /intake/bundles/b1/files/f6/unsplit',
      'POST /intake/bundles/b1/files/f4/file-copy',
      'POST /intake/bundles/b1/fields',
      'POST /intake/bundles/b1/witnesses',
      'POST /intake/bundles/b1/conflicts/c%3Avehicle.vin/choose',
      'POST /intake/bundles/b1/conflicts/accept-preselected',
      'POST /intake/bundles/b1/confirm-new',
      'POST /intake/bundles/b1/link-party',
      'POST /intake/bundles/b1/timeline/t%3Aaaa',
      'POST /intake/bundles/b1/signals/s%3A1/ack',
      'POST /intake/bundles/b1/think-again',
      'POST /intake/bundles/b1/register',
      'POST /intake/bundles/b1/register/retry',
      'POST /intake/bundles/b1/attach',
      'POST /intake/bundles/b1/cancel',
      'POST /intake/bundles/b1/reopen',
      'POST /intake/bundles/b1/wizard-draft',
      'PATCH /settings/intake',
    ]);
    const body = (path: string, i = 0) => api.calls.filter((c) => c.method !== 'GET' && c.path === path)[i]!.body;
    expect(api.calls[0]!.query).toMatchObject({ status: 'done' });
    expect(body('/intake/bundles')).toEqual({ name: 'Jane Doe – Corsa crash' });
    expect(body('/intake/bundles/b1/files', 0)).toEqual({ uploadId: 'up-1' });
    expect(body('/intake/bundles/b1/files', 1)).toEqual({ importId: 'imp-1' });
    expect(body('/intake/bundles/b1/files', 2)).toEqual({ evidenceId: 'ev-1' });
    expect(body('/intake/bundles/b1/files/f9/move')).toEqual({ groupKey: 'new' });
    expect(body('/intake/bundles/b1/files/f12/exclude')).toEqual({ excluded: true, reason: 'not ours' });
    expect(body('/intake/bundles/b1/fields')).toEqual({ key: 'client.phone', value: '07700 900123' });
    expect(body('/intake/bundles/b1/witnesses')).toEqual({ witnesses: [{ name: 'Ali Example', relationship: 'passer-by' }], answered: true });
    expect(body('/intake/bundles/b1/link-party')).toEqual({ partyId: null });
    expect(body('/intake/bundles/b1/timeline/t%3Aaaa')).toEqual({ ticked: false });
    expect(body('/intake/bundles/b1/signals/s%3A1/ack')).toEqual({ note: 'camera clock' });
    expect(body('/intake/bundles/b1/register')).toEqual({ acceptPreselected: true, groups: { 'case:B': 'split_off' } });
    expect(body('/intake/bundles/b1/attach')).toEqual({ claimId: 'c-old', groupKey: 'main', apply: ['client.phone'] });
    expect(body('/intake/bundles/b1/cancel')).toEqual({ reason: 'Duplicate upload' });
    expect(body('/settings/intake')).toEqual({ bundles: { autoRegister: true } });
  });

  it('claim brief and damage zones', async () => {
    const api = mockApi({ 'GET /claims/:id/intake-brief': () => ({ status: 404, body: { error: { code: 'NO_INTAKE_BUNDLE', message: 'none' } } }), 'GET /claims/:id/damage-zones': () => ({ zones: {}, observations: [] }) });
    vi.stubGlobal('fetch', vi.fn(api.fetch));
    await expect(bundlesApi.claimBrief('c1')).rejects.toMatchObject({ status: 404, code: 'NO_INTAKE_BUNDLE' });
    expect(await bundlesApi.damageZones('c1')).toEqual({ zones: {}, observations: [] });
  });
});

describe('normaliseDetail', () => {
  it('keeps a full detail as it is', () => {
    const d = bundleDetail();
    expect(normaliseDetail(d)).toEqual(d);
  });
  it('fills missing lists (e.g. signals sent as counts) so the page never breaks', () => {
    const n = normaliseDetail({ id: 'b9', name: 'x', signals: { warn: 1, info: 0 } });
    expect(n.signals).toEqual([]);
    expect(n.files).toEqual([]);
    expect(n.draft.fields).toEqual([]);
    expect(n.register).toEqual({ canRegister: false, blockers: [], fnolWarnings: [], willDo: [] });
    expect(n.checklist.items).toEqual([]);
  });
  it('signal counts', () => {
    expect(signalCounts(bundleDetail().signals)).toEqual({ warn: 2, info: 1 });
  });
});

describe('polling rules', () => {
  const s = (readiness: BundleSummary['readiness']) => ({ readiness }) as BundleSummary;
  it('the list polls every 4 s while any bundle is reading', () => {
    expect(listRefetchMs([s('needs_review'), s('reading')])).toBe(4000);
    expect(listRefetchMs([s('needs_review')])).toBe(30_000);
    expect(listRefetchMs(undefined)).toBe(30_000);
  });
  it('the page polls progress while reading or any file is moving (waiting for the AI alone does not count)', () => {
    const bundle = { readiness: 'needs_review' as const, status: 'needs_you' as const, revision: 1, computedRevision: 1 };
    expect(bundleInProgress({ bundle, files: [{ stage: 'read' }, { stage: 'waiting_ai' }] })).toBe(false);
    expect(bundleInProgress({ bundle, files: [{ stage: 'splitting' }] })).toBe(true);
    expect(bundleInProgress({ bundle: { ...bundle, readiness: 'reading' }, files: [] })).toBe(true);
    expect(bundleInProgress(undefined)).toBe(false);
  });
  it('refetch the detail when the revision or computed revision moved', () => {
    expect(detailIsStale({ revision: 3, computedRevision: 3 }, { revision: 4, computedRevision: 3 })).toBe(true);
    expect(detailIsStale({ revision: 4, computedRevision: 3 }, { revision: 4, computedRevision: 4 })).toBe(true);
    expect(detailIsStale({ revision: 4, computedRevision: 4 }, { revision: 4, computedRevision: 4 })).toBe(false);
    expect(detailIsStale(undefined, { revision: 4, computedRevision: 4 })).toBe(false);
  });
});

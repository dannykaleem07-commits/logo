// owned by intake-web
/** Case bundle screen model (docs/SMART-INTAKE.md §11, §16.5). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BundleDetail, BundleFileView, Conflict } from '../../../api/bundlesApi';
import { DEFAULT_LIMITS } from '../../../api/uploads';
import { BUNDLE_DETAIL, CASE_BRIEF, summaryOf } from './__fixtures__/bundleDetail';
import { bundleDetail } from './__fixtures__/mockApi';
import {
  checklistSummary,
  chipSources,
  requestedDocsCount,
  circumstancesNote,
  defaultGroupActions,
  fieldsBySection,
  fileNodes,
  firstBlockerText,
  groupCountText,
  groupsText,
  mainClaimMatch,
  moveTargets,
  orderGroups,
  orderedOptions,
  pagesText,
  photoBeforeAccident,
  provenanceLabel,
  readinessText,
  readingsOf,
  reasoningChip,
  registerTitle,
  signalsText,
  sortSignals,
  splitOnQuote,
  waitingSentence,
  whenText,
  willDoLines,
} from './bundleModel';
import { importFolderHint, MAX_FILES_PER_REQUEST, planBundleUpload } from './uploadQueue';

const MIB = 1024 * 1024;
const here = dirname(fileURLToPath(import.meta.url));

describe('the JSON fixture follows the frozen contract (§17.3)', () => {
  it('is exactly the typed fixture (so it type-checks against bundlesApi.ts)', () => {
    const json = JSON.parse(readFileSync(join(here, '__fixtures__', 'bundleDetail.json'), 'utf8')) as unknown;
    expect(json).toEqual(JSON.parse(JSON.stringify(BUNDLE_DETAIL)));
  });
  it('carries every top-level key of §8.1 BundleDetail', () => {
    const d = bundleDetail();
    for (const k of ['id', 'name', 'status', 'readiness', 'source', 'folderKey', 'parentBundleId', 'revision', 'computedRevision', 'createdAt', 'updatedAt', 'createdBy', 'fileCounts', 'groupCount', 'conflictsOpen', 'missingDocs', 'signals', 'reasoning', 'autoRegister', 'claim', 'needsYouId', 'error', 'files', 'groups', 'draft', 'conflicts', 'checklist', 'timeline', 'liability', 'register', 'aiSummary', 'decisions'])
      expect(d, k).toHaveProperty(k);
    for (const k of ['id', 'itemId', 'evidenceId', 'filename', 'mime', 'bytes', 'sha256', 'addedAt', 'position', 'role', 'parentFileId', 'segment', 'stage', 'stageLabel', 'waiting', 'error', 'docType', 'docTypeLabel', 'docTypeConfidence', 'docSide', 'documentDate', 'pages', 'summary', 'engine', 'groupKey', 'pinned', 'excluded', 'duplicate', 'photo', 'pdfMeta', 'archive', 'filed', 'fileUrl'])
      expect(d.files[0], k).toHaveProperty(k);
  });
  it('summaryOf turns the signal list into counts', () => {
    expect(summaryOf(BUNDLE_DETAIL).signals).toEqual({ warn: 2, info: 1 });
  });
});

describe('readiness and reasoning', () => {
  it('readiness text', () => {
    const s = summaryOf(BUNDLE_DETAIL);
    expect(readinessText({ ...s, readiness: 'reading', fileCounts: { ...s.fileCounts, read: 5, total: 12 } })).toBe('Reading 5/12');
    expect(readinessText(s)).toBe('Needs review');
    expect(readinessText({ ...s, readiness: 'ready_to_register' })).toBe('Ready to register');
    expect(readinessText({ ...s, readiness: 'registered', claim: { id: 'c', reference: 'CCG-2026-00042' } })).toBe('Registered CCG-2026-00042');
    expect(readinessText({ ...s, readiness: 'cancelled' })).toBe('Cancelled');
  });
  it('reasoning chip says why the AI check waits', () => {
    expect(reasoningChip({ status: 'done', at: null, waiting: null }).label).toBe('AI checked');
    expect(reasoningChip({ status: 'waiting_ai', at: null, waiting: { reason: 'agents_off' } }).label).toBe('AI check queued — agents are switched off');
    expect(reasoningChip({ status: 'none', at: null, waiting: null }).label).toBe('Rules only');
    expect(waitingSentence({ reason: 'usage', until: '2026-10-07T15:00:00.000Z' })).toBe('the AI usage limit is reached (resets at 16:00)');
  });
});

describe('groups', () => {
  it('orders columns: this case, new cases, claims, not sure, excluded', () => {
    expect(orderGroups([...BUNDLE_DETAIL.groups].reverse()).map((g) => g.key)).toEqual(['main', 'case:B', 'claim:c-old', 'unsure', 'excluded']);
  });
  it('labels the groups in plain words', () => {
    expect(groupsText(BUNDLE_DETAIL.groups)).toBe('2 cases + 1 existing claim + 1 not sure');
    expect(groupCountText(1)).toBe('One case');
    expect(groupCountText(4)).toBe('4 groups');
  });
  it('move targets exclude the current column and offer a new case', () => {
    expect(moveTargets(BUNDLE_DETAIL.groups, 'main').map((t) => t.value)).toEqual(['case:B', 'claim:c-old', 'unsure', 'new']);
  });
  it('default group actions for the Register dialog', () => {
    expect(defaultGroupActions(BUNDLE_DETAIL.groups)).toEqual({ 'case:B': 'split_off', 'claim:c-old': 'attach', unsure: 'split_off' });
  });
  it('nests duplicates under their primary and segments under their pack', () => {
    const nodes = fileNodes(BUNDLE_DETAIL.files, 'main');
    expect(nodes.map((n) => n.file.id)).toEqual(['f1', 'f2', 'f3', 'f5', 'f6', 'f13']);
    expect(nodes.find((n) => n.file.id === 'f3')!.copies.map((c) => c.id)).toEqual(['f4']);
    expect(nodes.find((n) => n.file.id === 'f6')!.segments.map((c) => c.id)).toEqual(['f7', 'f8']);
  });
  it('a copy whose primary sits in another column stands on its own', () => {
    const files: BundleFileView[] = BUNDLE_DETAIL.files.map((f) => (f.id === 'f4' ? { ...f, groupKey: 'unsure' } : f));
    expect(fileNodes(files, 'unsure').map((n) => n.file.id)).toEqual(['f4', 'f11']);
  });
  it('pages text', () => {
    expect(pagesText({ fromPage: 1, toPage: 2 })).toBe('pages 1–2');
    expect(pagesText({ fromPage: 3, toPage: 3 })).toBe('page 3');
    expect(pagesText(null)).toBeNull();
  });
});

describe('draft, provenance, conflicts', () => {
  it('sections in order, empty ones dropped', () => {
    expect(fieldsBySection(BUNDLE_DETAIL.draft.fields).map((s) => s.label)).toEqual(['Client', 'Client’s car', 'Other side', 'Accident', 'Insurers', 'Hire & repair']);
  });
  it('provenance label', () => {
    const s = BUNDLE_DETAIL.draft.fields.find((f) => f.key === 'vehicle.registration')!.source!;
    expect(provenanceLabel(s)).toBe('V5C · p1');
    expect(provenanceLabel({ ...s, engine: 'owner' })).toBe('You');
    expect(provenanceLabel({ ...s, docTypeLabel: null, page: null })).toBe('SMART-A-V5C.pdf');
  });
  it('conflict options: preselected first, then by rank', () => {
    const c = BUNDLE_DETAIL.conflicts[0] as Conflict;
    expect(orderedOptions(c).map((o) => o.value)).toEqual(['WVWZZZ1JZXW000001', 'WVWZZZ1JZXW000007']);
  });
  it('every reading of a field (for the drawer)', () => {
    const f = BUNDLE_DETAIL.draft.fields.find((x) => x.key === 'vehicle.vin')!;
    expect(readingsOf(f).map((r) => [r.value, r.source.docTypeLabel])).toEqual([
      ['WVWZZZ1JZXW000001', 'V5C'],
      ['WVWZZZ1JZXW000007', 'Bodyshop estimate'],
    ]);
  });
  it('circumstances attribution', () => {
    expect(circumstancesNote(BUNDLE_DETAIL)).toEqual({ text: 'Client’s own words — Signed accident report, page 2', tone: 'green' });
    const police: BundleDetail = { ...BUNDLE_DETAIL, draft: { ...BUNDLE_DETAIL.draft, circumstances: { attribution: 'police', fromFileId: 'f7' } } };
    expect(circumstancesNote(police)!.text).toBe('From the police report — not the client’s account: please confirm');
  });
  it('quote highlighting is exact first, then case- and space-tolerant', () => {
    expect(splitOnQuote('Registration mark KX21 ABC\nMake VAUXHALL', 'Registration mark KX21 ABC')).toEqual(['', 'Registration mark KX21 ABC', '\nMake VAUXHALL']);
    expect(splitOnQuote('VIN:  wvwzzz1jzxw000001 end', 'VIN: WVWZZZ1JZXW000001')).toEqual(['', 'VIN:  wvwzzz1jzxw000001', ' end']);
    expect(splitOnQuote('nothing here', 'absent')).toBeNull();
    expect(splitOnQuote('text', null)).toBeNull();
  });
});

describe('register', () => {
  it('first owner blocker is the Register tooltip; automatic blockers are not', () => {
    expect(firstBlockerText(BUNDLE_DETAIL.register.blockers)).toBe('2 details conflict — choose which is right.');
    expect(firstBlockerText([{ code: 'SETTING_OFF', text: 'x', for: 'auto' }])).toBeNull();
  });
  it('title names the client', () => {
    expect(registerTitle(BUNDLE_DETAIL)).toBe('Register claim for Jane Doe');
  });
  it('willDo lines come from the server, or are derived', () => {
    expect(willDoLines(BUNDLE_DETAIL)).toBe(BUNDLE_DETAIL.register.willDo);
    const derived = willDoLines({ ...BUNDLE_DETAIL, register: { ...BUNDLE_DETAIL.register, willDo: [] } });
    expect(derived).toEqual([
      'Creates the claim with 10 details',
      'Files 8 documents (1 copy not filed twice)',
      'Adds 2 chronology entries',
      'Records damage on 2 parts',
      'Prepares a request for 3 documents (you approve it before it is sent)',
      'New case B — Ali Example becomes its own bundle',
      '1 file goes to CCG-2026-00001',
      'Not sure becomes its own bundle',
    ]);
  });
  it('main group matched to an existing claim', () => {
    expect(mainClaimMatch(BUNDLE_DETAIL)).toBeNull();
    const d: BundleDetail = {
      ...BUNDLE_DETAIL,
      groups: BUNDLE_DETAIL.groups.map((g) => (g.key === 'main' ? { ...g, kind: 'existing_claim' as const, claim: { id: 'c9', reference: 'CCG-2026-00031', clientName: null, status: 'open' }, reasons: [{ code: 'matches_claim', text: 'Same VIN and insurer reference' }] } : g)),
    };
    expect(mainClaimMatch(d)).toEqual({ claimId: 'c9', reference: 'CCG-2026-00031', reasons: ['Same VIN and insurer reference'] });
  });
});

describe('checklist, signals, photos, dates', () => {
  it('checklist summary', () => {
    expect(checklistSummary(BUNDLE_DETAIL.checklist.items)).toBe('2 missing · 1 partly there');
    expect(checklistSummary([])).toBe('Nothing missing');
  });
  it('signals: unacknowledged warnings first; plain counts', () => {
    expect(sortSignals([...BUNDLE_DETAIL.signals].reverse()).map((s) => s.id)).toEqual(['s:1', 's:2', 's:3']);
    expect(signalsText({ warn: 1, info: 0 })).toBe('1 thing worth a look');
    expect(signalsText({ warn: 2, info: 1 })).toBe('3 things worth a look');
    expect(signalsText({ warn: 0, info: 0 })).toBeNull();
  });
  it('a photo before the accident is outlined (signal, or its own time)', () => {
    const accident = '2026-10-07T14:20:00.000Z';
    const f5 = BUNDLE_DETAIL.files.find((f) => f.id === 'f5')!;
    const f3 = BUNDLE_DETAIL.files.find((f) => f.id === 'f3')!;
    expect(photoBeforeAccident(f5, BUNDLE_DETAIL.signals, accident)).toBe(true);
    expect(photoBeforeAccident(f5, [], accident)).toBe(true);
    expect(photoBeforeAccident(f3, BUNDLE_DETAIL.signals, accident)).toBe(false);
  });
  it('dates in London time', () => {
    expect(whenText('2026-10-07T14:20:00.000Z')).toBe('7 Oct 2026, 15:20');
    expect(whenText('2026-10-08', 'date')).toBe('8 Oct 2026');
    expect(whenText(null)).toBe('—');
  });
  it('the brief fixture is complete', () => {
    expect(CASE_BRIEF.claim.reference).toBe('CCG-2026-00042');
  });
});

describe('upload batching (§11.3)', () => {
  const f = (name: string, size: number) => ({ name, size });
  it('≤ 10 files per multipart request; above the chunk threshold goes in parts; above the limit is refused', () => {
    const files = [...Array.from({ length: 23 }, (_, i) => f(`p${i}.jpg`, 2 * MIB)), f('big.pdf', 300 * MIB), f('huge.mov', 3000 * MIB)];
    const plan = planBundleUpload(files, DEFAULT_LIMITS, importFolderHint('Jane Doe – Corsa crash'));
    expect(plan.batches.map((b) => b.length)).toEqual([10, 10, 3]);
    expect(Math.max(...plan.batches.map((b) => b.length))).toBe(MAX_FILES_PER_REQUEST);
    expect(plan.chunked.map((x) => x.name)).toEqual(['big.pdf']);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]!.message).toContain('inbox\\intake\\Jane Doe – Corsa crash\\');
  });
  it('a file exactly at the threshold still goes in a batch', () => {
    const plan = planBundleUpload([f('edge.pdf', DEFAULT_LIMITS.chunkThresholdBytes)], DEFAULT_LIMITS, 'x');
    expect(plan.batches).toHaveLength(1);
    expect(plan.chunked).toHaveLength(0);
  });
  it('import folder hint drops characters Windows cannot use', () => {
    expect(importFolderHint('A/B: C?')).toBe('inbox\\intake\\A B C\\');
    expect(importFolderHint('  ')).toBe('inbox\\intake\\bundle\\');
  });

  it('one source chip per file and page, keeping the most confident reading', () => {
    const base = BUNDLE_DETAIL.conflicts[0]!.options[0]!.sources[0]!;
    const a = { ...base, fileId: 'f1', page: 1, confidence: 0.8, engine: 'rules' as const };
    const b = { ...base, fileId: 'f1', page: 1, confidence: 0.95, engine: 'ai' as const };
    const c = { ...base, fileId: 'f2', page: 1, confidence: 0.7 };
    const d = { ...base, fileId: 'f1', page: 2, confidence: 0.6 };
    expect(chipSources([a, c, b, d]).map((x) => [x.fileId, x.page, x.confidence])).toEqual([['f1', 1, 0.95], ['f2', 1, 0.7], ['f1', 2, 0.6]]);
  });

  it('counts the documents the client is asked for (not the hire paperwork the Autopilot prepares)', () => {
    const item = (id: string, status: 'have' | 'missing' | 'partial' | 'not_needed') => ({ id, label: id, status, why: '', fileIds: [] });
    expect(requestedDocsCount([item('bank_details', 'missing'), item('damage_photos', 'partial'), item('signed_hire_docs', 'missing'), item('v5c', 'have')])).toBe(2);
  });
});

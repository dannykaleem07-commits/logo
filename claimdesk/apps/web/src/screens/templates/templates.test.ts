import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanSubject, fileNameFromDisposition, subjectKey, valuesQuery, type DocxSlot } from '../../api/templatesApi';
import {
  allowedPolicyOptions,
  applyFieldSelection,
  applyPolicy,
  buildMappingPutBody,
  converterLines,
  converterSentence,
  defaultVariant,
  FIELD_HANDLER,
  FIELD_IGNORE,
  FIELD_NONE,
  fieldSelectGroups,
  fieldSelectValue,
  formatBytes,
  groupSlotsBySection,
  isPolicyLaxer,
  mappedBadge,
  mappingDraftCounts,
  mappingDraftFromDetail,
  mappingStatusBadge,
  pickerGroups,
  POLICY_ORDER,
  shortSha,
  sortTemplates,
  sourceBadge,
  stricterPolicy,
  templateCounts,
  templateStatusBadge,
  titleFromFileName,
  validateUpload,
  warningsBadge
} from './templates';
import { detail01, summary, T01, T03, T04, TEMPLATE_LIST, TLH } from './testFixtures';

describe('fill policies are never laxer than the field default', () => {
  it('orders auto < auto-if-known < suggest < handler < post-event < never / signature', () => {
    expect(POLICY_ORDER).toEqual(['auto', 'auto-if-known', 'suggest', 'handler', 'post-event', 'never', 'signature']);
  });
  it('offers only the default and stricter policies', () => {
    expect(allowedPolicyOptions('auto')).toHaveLength(7);
    expect(allowedPolicyOptions('suggest')).toEqual(['suggest', 'handler', 'post-event', 'never', 'signature']);
    expect(allowedPolicyOptions('handler')).toEqual(['handler', 'post-event', 'never', 'signature']);
    expect(allowedPolicyOptions('signature')).toEqual(['never', 'signature']);
    expect(allowedPolicyOptions(undefined)).toHaveLength(7);
  });
  it('detects a laxer policy and picks the stricter of two', () => {
    expect(isPolicyLaxer('auto', 'suggest')).toBe(true);
    expect(isPolicyLaxer('auto-if-known', 'handler')).toBe(true);
    expect(isPolicyLaxer('handler', 'suggest')).toBe(false);
    expect(isPolicyLaxer('auto', undefined)).toBe(false);
    expect(stricterPolicy('auto', 'handler')).toBe('handler');
    expect(stricterPolicy('never', 'auto')).toBe('never');
  });
});

describe('template list badges and counts', () => {
  it('source, mapped and warnings badges', () => {
    expect(sourceBadge('builtin')).toEqual({ label: 'Built-in', tone: 'navy' });
    expect(sourceBadge('uploaded')).toEqual({ label: 'Uploaded', tone: 'blue' });
    const t01 = TEMPLATE_LIST.find((t) => t.id === T01)!;
    expect(mappedBadge(t01)).toMatchObject({ label: '38 of 40', tone: 'amber' });
    expect(mappedBadge(summary({ id: 'x', title: 'X', kind: 'form' }))).toMatchObject({ label: '40 of 40', tone: 'green' });
    expect(warningsBadge(t01)).toBeUndefined();
    const lh = TEMPLATE_LIST.find((t) => t.id === TLH)!;
    expect(warningsBadge(lh)).toMatchObject({ label: '1 · Needs review', tone: 'amber' });
    expect(warningsBadge({ ...lh, warningsAcknowledged: true })).toMatchObject({ label: '1 reviewed', tone: 'grey' });
  });
  it('status badge: inactive, needs review, not fully mapped, ready', () => {
    expect(templateStatusBadge({ ...TEMPLATE_LIST[0]!, active: false }).label).toBe('Inactive');
    expect(templateStatusBadge(TEMPLATE_LIST.find((t) => t.id === TLH)!).label).toBe('Needs review');
    expect(templateStatusBadge(TEMPLATE_LIST.find((t) => t.id === T01)!).label).toBe('Not fully mapped');
    expect(templateStatusBadge(TEMPLATE_LIST.find((t) => t.id === T03)!)).toEqual({ label: 'Ready', tone: 'green' });
  });
  it('counts the library', () => {
    expect(templateCounts(TEMPLATE_LIST)).toEqual({ total: 7, active: 6, builtin: 5, uploaded: 2, needsReview: 1, notFullyMapped: 1 });
  });
  it('sorts built-ins by CCGUK number, then uploads by title', () => {
    expect(sortTemplates(TEMPLATE_LIST).map((t) => t.id)).toEqual([T01, T03, T04, 'form.ccguk_09_accident_report', TLH, 'letter.user_chaser_1a2b', 'form.user_old_9f9f']);
  });
  it('groups the picker Agreements / Forms / Statements / Letters / Your templates and hides inactive templates', () => {
    const groups = pickerGroups(TEMPLATE_LIST);
    expect(groups.map((g) => g.label)).toEqual(['Agreements', 'Forms', 'Statements', 'Letters', 'Your templates']);
    expect(groups[0]!.templates.map((t) => t.id)).toEqual([T01, T03]);
    expect(groups[4]!.templates.map((t) => t.id)).toEqual(['letter.user_chaser_1a2b']);
    expect(groups.flatMap((g) => g.templates).some((t) => !t.active)).toBe(false);
  });
  it('default variant: the one marked default, else the first, else none', () => {
    expect(defaultVariant(TEMPLATE_LIST.find((t) => t.id === T03))).toBe('hirer');
    expect(defaultVariant({ variants: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })).toBe('a');
    expect(defaultVariant(TEMPLATE_LIST.find((t) => t.id === T01))).toBeUndefined();
    expect(defaultVariant(undefined)).toBeUndefined();
  });
});

const slot = (id: string, sectionPath: string[], extra: Partial<DocxSlot> = {}): DocxSlot => ({
  id,
  kind: 'cell',
  part: 'word/document.xml',
  sectionPath,
  sectionTitles: [],
  label: id.split('/').pop()!,
  labelSlug: id.split('/').pop()!,
  ordinal: 1,
  preview: '',
  signature: false,
  hint: false,
  multiline: false,
  ...extra
});

describe('slots grouped by section in outline order', () => {
  it('header and title first, outline order next (deepest outline entry wins), unknown sections after, footer last', () => {
    const outline = [
      { level: 1 as const, title: '01 Customer', slug: '01-customer' },
      { level: 1 as const, title: '02 Driver', slug: '02-driver' },
      { level: 2 as const, title: 'Replacement vehicle insurance', slug: 'replacement-vehicle-insurance' },
      { level: 1 as const, title: '03 Hire', slug: '03-hire' }
    ];
    const slots = [
      slot('footer/page', ['footer']),
      slot('03-hire/rate', ['03-hire'], { sectionTitles: ['03 Hire'] }),
      slot('02-driver/replacement-vehicle-insurance/insurer', ['02-driver', 'replacement-vehicle-insurance'], { sectionTitles: ['02 Driver', 'Replacement vehicle insurance'] }),
      slot('02-driver/name', ['02-driver'], { sectionTitles: ['02 Driver'] }),
      slot('appendix/x', ['appendix']),
      slot('01-customer/name', ['01-customer'], { sectionTitles: ['01 Customer'] }),
      slot('title/reference', ['title']),
      slot('header/ref', ['header']),
      slot('01-customer/dob', ['01-customer'], { sectionTitles: ['01 Customer'] })
    ];
    const groups = groupSlotsBySection(slots, outline);
    expect(groups.map((g) => g.key)).toEqual(['header', 'title', '01-customer', '02-driver', '02-driver/replacement-vehicle-insurance', '03-hire', 'appendix', 'footer']);
    expect(groups.map((g) => g.title)).toEqual(['Page header', 'Title block', '01 Customer', '02 Driver', '02 Driver › Replacement vehicle insurance', '03 Hire', 'Appendix', 'Page footer']);
    expect(groups[2]!.slots.map((s) => s.id)).toEqual(['01-customer/name', '01-customer/dob']);
  });
});

describe('mapping editor draft', () => {
  const d = detail01();
  const draft = mappingDraftFromDetail(d);
  it('reads each slot as mapped, handler, ignored, signature or not mapped', () => {
    expect(draft['header/ref']).toMatchObject({ mode: 'ignore', policy: 'never' });
    expect(draft['title/reference']).toMatchObject({ mode: 'field', key: 'claim.reference', origin: 'builtin' });
    expect(draft['01-customer-and-claim-details/own-claim-ref']).toMatchObject({ mode: 'field', origin: 'suggested', score: 0.82 });
    expect(draft['01-customer-and-claim-details/notes']).toMatchObject({ mode: 'none' });
    expect(draft['13-client-authorisation/@client/signature']).toMatchObject({ mode: 'signature', policy: 'signature' });
    expect(mappingDraftCounts(d.slots, draft)).toEqual({ mapped: 4, handler: 0, ignored: 1, signature: 1, unmapped: 1, changed: 0 });
  });
  it('field select values', () => {
    expect(fieldSelectValue(draft['title/reference']!)).toBe('claim.reference');
    expect(fieldSelectValue(draft['header/ref']!)).toBe(FIELD_IGNORE);
    expect(fieldSelectValue(draft['01-customer-and-claim-details/notes']!)).toBe(FIELD_NONE);
  });
  it('choosing a field starts at its default policy; handler / leave as printed / not mapped; signature stays locked', () => {
    const notes = draft['01-customer-and-claim-details/notes']!;
    expect(applyFieldSelection(notes, 'services.recovery', d.fields)).toMatchObject({ mode: 'field', key: 'services.recovery', policy: 'suggest', changed: true });
    expect(applyFieldSelection(notes, FIELD_HANDLER, d.fields)).toMatchObject({ mode: 'handler', key: undefined, policy: 'handler' });
    expect(applyFieldSelection(notes, FIELD_IGNORE, d.fields)).toMatchObject({ mode: 'ignore', policy: 'never' });
    expect(applyFieldSelection(draft['title/reference']!, FIELD_NONE, d.fields)).toMatchObject({ mode: 'none', key: undefined });
    const sig = draft['13-client-authorisation/@client/signature']!;
    expect(applyFieldSelection(sig, 'claim.reference', d.fields, { signature: true })).toBe(sig);
  });
  it('a laxer policy is refused, a stricter one accepted', () => {
    const own = draft['01-customer-and-claim-details/own-claim-ref']!; // ownInsurer.claimRef default 'handler'
    expect(applyPolicy(own, 'auto', d.fields)).toBe(own);
    expect(applyPolicy(own, 'never', d.fields)).toMatchObject({ policy: 'never', changed: true });
    const reg = draft['01-customer-and-claim-details/registration']!;
    expect(applyPolicy(reg, 'suggest', d.fields)).toMatchObject({ policy: 'suggest' });
  });
  it('status badges', () => {
    expect(mappingStatusBadge(draft['title/reference'], { signature: false })).toMatchObject({ label: 'Built-in', tone: 'navy' });
    expect(mappingStatusBadge(draft['01-customer-and-claim-details/registration'], { signature: false })).toMatchObject({ label: 'Saved' });
    expect(mappingStatusBadge(draft['01-customer-and-claim-details/own-claim-ref'], { signature: false })).toMatchObject({ label: 'Suggested 0.82', tone: 'amber' });
    expect(mappingStatusBadge(draft['01-customer-and-claim-details/notes'], { signature: false })).toMatchObject({ label: 'Not mapped' });
    expect(mappingStatusBadge(draft['13-client-authorisation/@client/signature'], { signature: true })).toMatchObject({ label: 'Signed by hand' });
    expect(mappingStatusBadge({ ...draft['title/reference']!, changed: true }, { signature: false })).toMatchObject({ label: 'Changed' });
  });
  it('builds the PUT body with exact slot ids: entries, ignore list, signature entries; not mapped omitted', () => {
    const edited = {
      ...draft,
      '01-customer-and-claim-details/notes': { ...applyFieldSelection(draft['01-customer-and-claim-details/notes']!, FIELD_HANDLER, d.fields), label: '  Handler notes ', required: true },
      'title/reference': { ...draft['title/reference']!, format: 'auto' as const, removeIfEmpty: 'paragraph' as const },
      'not/a-slot': { ...draft['title/reference']!, slotId: 'not/a-slot' }
    };
    const body = buildMappingPutBody(d.slots, edited);
    expect(body.ignore).toEqual(['header/ref']);
    expect(body.entries).toEqual([
      { slot: 'title/reference', key: 'claim.reference', policy: 'auto', removeIfEmpty: 'paragraph' },
      { slot: '01-customer-and-claim-details/registration', key: 'vehicle.registration', policy: 'auto' },
      { slot: '01-customer-and-claim-details/own-claim-ref', key: 'ownInsurer.claimRef', policy: 'handler' },
      { slot: '01-customer-and-claim-details/notes', policy: 'handler', required: true, label: 'Handler notes' },
      { slot: '13-client-authorisation/@client/signature', policy: 'signature' },
      { slot: '05-services/recovery', key: 'services.recovery', policy: 'suggest', when: 'yes' }
    ]);
    for (const e of body.entries) expect(typeof e.slot).toBe('string');
  });
  it('a duplicate slot id in the scan is written once; a not-mapped slot is omitted', () => {
    const body = buildMappingPutBody([...d.slots, d.slots[1]!], draft);
    expect(body.entries.filter((e) => e.slot === 'title/reference')).toHaveLength(1);
    expect(body.entries.some((e) => e.slot === '01-customer-and-claim-details/notes')).toBe(false);
  });
  it('field select groups: handler and leave-as-printed first, then the dictionary groups in order', () => {
    const groups = fieldSelectGroups(d.fields);
    expect(groups.map((g) => g.label)).toEqual(['Not from the claim', 'Claim', 'Client vehicle', 'Insurers']);
    expect(groups[0]!.options.map((o) => o.label)).toEqual(['Handler fills', 'Leave as printed']);
    expect(groups[1]!.options.map((o) => o.value)).toEqual(['claim.reference', 'services.recovery']);
  });
});

describe('upload form', () => {
  const base = { title: 'Chaser', kind: 'letter', description: '', recipientRole: '' };
  it('needs a .docx/.dotx under 15 MB, a title and a kind', () => {
    expect(validateUpload({ ...base, file: null })).toHaveProperty('file');
    expect(validateUpload({ ...base, file: { name: 'a.pdf', size: 10 } }).file).toMatch(/docx/);
    expect(validateUpload({ ...base, file: { name: 'a.docx', size: 16 * 1024 * 1024 } }).file).toMatch(/15 MB/);
    expect(validateUpload({ ...base, file: { name: 'a.DOTX', size: 10 } })).toEqual({});
    expect(validateUpload({ ...base, title: ' ', kind: 'invoice', file: { name: 'a.docx', size: 10 } })).toEqual({ title: expect.any(String), kind: expect.any(String) });
  });
  it('suggests a title from the file name', () => {
    expect(titleFromFileName('Client-Update_Letter  v2.docx')).toBe('Client Update Letter v2');
  });
});

describe('PDF converters card', () => {
  const res = { preference: 'auto' as const, order: ['word', 'libreoffice', 'browser'] as Array<'word' | 'libreoffice' | 'browser'>, available: { word: { ok: true, path: 'WINWORD.EXE' }, libreoffice: { ok: false, detail: 'soffice not found' }, browser: { ok: true } } };
  it('one line per converter in order, the first available marked as used first', () => {
    const lines = converterLines(res);
    expect(lines.map((l) => [l.name, l.state, l.preferred])).toEqual([
      ['Microsoft Word', 'found', true],
      ['LibreOffice', 'not found', false],
      ['built-in browser', 'always available', false]
    ]);
    expect(converterSentence(res)).toBe('PDFs are produced with: Microsoft Word (found) / LibreOffice (not found) / built-in browser (always available)');
  });
  it('before the API answers', () => {
    expect(converterLines(undefined).map((l) => l.state)).toEqual(['checking…', 'checking…', 'checking…']);
  });
  it('without Word the browser is used first', () => {
    const lines = converterLines({ ...res, available: { ...res.available, word: { ok: false } } });
    expect(lines.find((l) => l.preferred)?.id).toBe('browser');
  });
});

describe('small helpers', () => {
  it('sha, bytes and download names', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456789ab');
    expect(shortSha(undefined)).toBe('—');
    expect(formatBytes(48_000)).toBe('47 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(fileNameFromDisposition('attachment; filename="CCG-2026-00012 Witness Statement.docx"')).toBe('CCG-2026-00012 Witness Statement.docx');
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''CCG%20test.docx")).toBe('CCG test.docx');
    expect(fileNameFromDisposition(null)).toBeUndefined();
  });
  it('subject key and values query', () => {
    expect(subjectKey(undefined)).toBe('');
    expect(subjectKey({ witnessPartyId: 'w', exhibitEvidenceIds: ['b', 'a'] })).toBe('w:w|e:a,b');
    expect(cleanSubject({ offerId: '', exhibitEvidenceIds: [] })).toBeUndefined();
    expect(valuesQuery('hirer', { hireAgreementId: 'h1', exhibitEvidenceIds: ['e1', 'e2'] })).toEqual({ variant: 'hirer', witnessPartyId: undefined, offerId: undefined, hireAgreementId: 'h1', recipientPartyId: undefined, exhibitEvidenceIds: 'e1,e2' });
  });
});

describe('copy in the template screens', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    ...readdirSync(here)
      .map((f) => join(here, f))
      .filter((p) => statSync(p).isFile() && /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)),
    join(here, '..', '..', 'api', 'templatesApi.ts')
  ];
  const BANNED = ['ignore any offer of a courtesy car', 'do not accept a vehicle from the insurer', 'our solicitors', 'legal advice from our lawyers', '17360033', '66 paul st', 'courtesycarsuk.co.uk'];
  const ADVICE = [/(?<!not )regulated by the sra/i, /ignore (the|their|any) offer/i, /(decline|refuse|reject|turn down) (the|their|any|that) (offer|vehicle|courtesy car)/i];
  it('carries no legacy detail, no supplier name and no advice on insurer offers', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const phrase of BANNED) expect(text.toLowerCase().includes(phrase), `${file}: ${phrase}`).toBe(false);
      for (const re of ADVICE) expect(re.test(text), `${file}: ${re}`).toBe(false);
      expect(/car ?flex/i.test(text), `${file}: legacy supplier name`).toBe(false);
    }
  });
});

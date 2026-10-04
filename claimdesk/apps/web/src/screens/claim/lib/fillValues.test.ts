import { describe, expect, it } from 'vitest';
import type { PlanRow } from '../../../api/templatesApi';
import { claimView, docxDocument, row, T01, T03, T04, TEMPLATE_LIST, values01, values03 } from '../../templates/testFixtures';
import {
  buildGenerateBody,
  computeSummary,
  effectiveInput,
  fillReducer,
  generateBlocker,
  groupRows,
  groupsOf,
  GTA_BENCHMARK_CAVEAT,
  initialFillState,
  isEmptyInput,
  isGtaRow,
  isLocked,
  missingRequired,
  narrowCellHint,
  normaliseInput,
  openBlockingIssues,
  originLabel,
  rowBadge,
  rowsOf,
  subjectBlocker,
  subjectOptions,
  summaryLine,
  toIsoDate,
  toTime,
  type FillState
} from './fillValues';
import { docxValuesUsed, documentKindLabel, hasApprovedPdf, isDocx, isHtmlLetter, pdfConverterLabel, pdfConverterNote, slotLabelFromId } from './documents';

const t01 = TEMPLATE_LIST.find((t) => t.id === T01)!;
const t03 = TEMPLATE_LIST.find((t) => t.id === T03)!;

function stateFor(templateId: string, extra: Partial<FillState> = {}): FillState {
  return { ...initialFillState({ templateId, step: 'check' }), ...extra };
}

describe('grouping value rows', () => {
  it('groups by section in first-appearance order', () => {
    const rows = rowsOf(values01());
    const groups = groupRows(rows);
    expect(groups.map((g) => g.section)).toEqual(['title', '01-customer-and-claim-details', '08-settlement-authority', '13-client-authorisation']);
    expect(groups[1]!.title).toBe('01 Customer and claim details');
    expect(rows).toHaveLength(11);
  });
  it('uses the API groups when present, else groups the rows', () => {
    expect(groupsOf(values01()).map((g) => g.title)).toEqual(['Title block', '01 Customer and claim details', '08 Settlement authority', '13 Client authorisation']);
    const v = { ...values01(), groups: [] };
    expect(groupsOf(v)).toEqual([]);
    expect(rowsOf({ rows: [row({ slotId: 'a/b', label: 'B' })] })).toHaveLength(1);
    expect(rowsOf(undefined)).toEqual([]);
  });
});

describe('normalising inputs to the API shapes', () => {
  const r = (inputType: PlanRow['inputType'], extra: Partial<PlanRow> = {}) => row({ slotId: 'x/y', label: 'Y', inputType, ...extra });
  it('dates become YYYY-MM-DD; impossible dates are refused', () => {
    expect(normaliseInput(r('date'), '04/10/2026')).toBe('2026-10-04');
    expect(normaliseInput(r('date'), '4/1/2026')).toBe('2026-01-04');
    expect(normaliseInput(r('date'), '2026-10-04')).toBe('2026-10-04');
    expect(normaliseInput(r('date'), '31/02/2026')).toBeNull();
    expect(normaliseInput(r('date'), '')).toBeNull();
    expect(toIsoDate('yesterday')).toBeNull();
  });
  it('date-times become ISO 8601 (UTC); times HH:MM', () => {
    expect(normaliseInput(r('datetime'), '2026-10-04T09:30:00.000Z')).toBe('2026-10-04T09:30:00.000Z');
    expect(normaliseInput(r('datetime'), 'not a date')).toBeNull();
    expect(normaliseInput(r('time'), '9:30')).toBe('09:30');
    expect(toTime('0930')).toBe('09:30');
    expect(toTime('25:00')).toBeNull();
  });
  it('money becomes integer pence (typed pounds or pence from the API)', () => {
    expect(normaliseInput(r('money'), '1,234.56')).toBe(123456);
    expect(normaliseInput(r('money'), '£86.5')).toBe(8650);
    expect(normaliseInput(r('money'), 8650)).toBe(8650);
    expect(normaliseInput(r('money'), 'abc')).toBeNull();
  });
  it('whole numbers, tick boxes and choices', () => {
    expect(normaliseInput(r('int'), '45,210')).toBe(45210);
    expect(normaliseInput(r('int'), '4.5')).toBeNull();
    expect(normaliseInput(r('checkbox'), true)).toBe(true);
    expect(normaliseInput(r('checkbox'), false)).toBe(false);
    expect(normaliseInput(r('choice'), 'standard')).toEqual(['standard']);
    expect(normaliseInput(r('choice'), ['a', 'b', 'a'])).toEqual(['a']);
    expect(normaliseInput(r('choice', { multiple: true }), ['a', 'b', 'a', ' '])).toEqual(['a', 'b']);
    expect(normaliseInput(r('choice', { multiple: true }), [])).toBeNull();
  });
  it('rows keep known columns and drop empty rows; paragraphs drop empty items; text is trimmed', () => {
    const rowsRow = r('rows', { columns: [{ id: 'name', label: 'Name' }, { id: 'contact', label: 'Contact' }] });
    expect(normaliseInput(rowsRow, [{ name: ' Wendy ', contact: '', extra: 'x' }, { name: '', contact: '' }])).toEqual([{ name: 'Wendy' }]);
    expect(normaliseInput(rowsRow, [{ name: '' }])).toBeNull();
    expect(normaliseInput(r('paragraphs'), [' First. ', '', 'Second.'])).toEqual(['First.', 'Second.']);
    expect(normaliseInput(r('text'), '  hello ')).toBe('hello');
    expect(normaliseInput(r('text'), '   ')).toBeNull();
    expect(normaliseInput(r('multiline'), 'line 1\nline 2\n\n')).toBe('line 1\nline 2');
  });
  it('empty inputs', () => {
    expect(isEmptyInput(null)).toBe(true);
    expect(isEmptyInput('  ')).toBe(true);
    expect(isEmptyInput([])).toBe(true);
    expect(isEmptyInput([{ a: '' }])).toBe(true);
    expect(isEmptyInput(false)).toBe(false);
    expect(isEmptyInput(0)).toBe(false);
  });
});

describe('dialog state', () => {
  it('choosing a template sets its default variant and clears what was typed for another template', () => {
    let s = initialFillState();
    s = fillReducer(s, { type: 'chooseTemplate', template: t03 });
    expect(s).toMatchObject({ templateId: T03, variant: 'hirer', step: 'choose' });
    s = fillReducer(s, { type: 'edit', slotId: 'a', value: 'x' });
    expect(fillReducer(s, { type: 'chooseTemplate', template: t03 })).toBe(s);
    s = fillReducer(s, { type: 'chooseTemplate', template: t01 });
    expect(s).toMatchObject({ templateId: T01, variant: undefined, edits: {}, confirmed: [] });
  });
  it('next needs a template; back returns to the choice', () => {
    expect(fillReducer(initialFillState(), { type: 'next' }).step).toBe('choose');
    const s = fillReducer(fillReducer(initialFillState(), { type: 'chooseTemplate', template: t01 }), { type: 'next' });
    expect(s.step).toBe('check');
    expect(fillReducer(s, { type: 'back' }).step).toBe('choose');
  });
  it('subjects merge; edits revert; confirmations toggle; sections collapse', () => {
    let s = initialFillState({ templateId: T04 });
    s = fillReducer(s, { type: 'setSubject', subject: { witnessPartyId: 'p-w1' } });
    s = fillReducer(s, { type: 'setSubject', subject: { exhibitEvidenceIds: ['ev-1'] } });
    expect(s.subject).toEqual({ witnessPartyId: 'p-w1', exhibitEvidenceIds: ['ev-1'] });
    s = fillReducer(s, { type: 'edit', slotId: 'a', value: 'x' });
    s = fillReducer(s, { type: 'revert', slotId: 'a' });
    expect(s.edits).toEqual({});
    s = fillReducer(s, { type: 'confirm', slotId: 'title/date', confirmed: true });
    expect(s.confirmed).toEqual(['title/date']);
    expect(fillReducer(s, { type: 'confirm', slotId: 'title/date', confirmed: true })).toBe(s);
    s = fillReducer(s, { type: 'confirm', slotId: 'title/date', confirmed: false });
    expect(s.confirmed).toEqual([]);
    s = fillReducer(s, { type: 'toggleSection', section: 'title' });
    expect(s.collapsed).toEqual(['title']);
    expect(fillReducer(s, { type: 'toggleSection', section: 'title' }).collapsed).toEqual([]);
  });
});

describe('the generate body', () => {
  const rows = rowsOf(values01());
  it('sends only changed or entered values plus the confirmed suggestions', () => {
    const s = stateFor(T01, {
      edits: {
        '01-customer-and-claim-details/own-claim-ref': ' OWN-123 ',
        '01-customer-and-claim-details/date-of-birth': '02/03/1985',
        '01-customer-and-claim-details/mileage': '45,210',
        '01-customer-and-claim-details/customer-full-name': 'Amelia Hart', // unchanged → not sent
        '08-settlement-authority/standard-authority': false, // as printed → not sent
        '13-client-authorisation/@client/signature': 'A. Hart' // signature → never sent
      },
      confirmed: ['title/date', 'title/reference']
    });
    expect(buildGenerateBody(s, rows)).toEqual({
      templateId: T01,
      values: {
        '01-customer-and-claim-details/date-of-birth': '1985-03-02',
        '01-customer-and-claim-details/mileage': 45210,
        '01-customer-and-claim-details/own-claim-ref': 'OWN-123'
      },
      confirm: ['title/date']
    });
  });
  it('unticking a box the claim ticked is sent; ticking and unticking an unticked box is not', () => {
    const box = row({ slotId: 'r/box', label: 'Box', inputType: 'checkbox', value: true, origin: 'claim' });
    expect(buildGenerateBody(stateFor(T01, { edits: { 'r/box': false } }), [box]).values).toEqual({ 'r/box': false });
    expect(buildGenerateBody(stateFor(T01, { edits: { 'r/box': true } }), [box]).values).toEqual({});
    expect(buildGenerateBody(stateFor(T01, { edits: { 'r/box': false } }), [{ ...box, value: null }]).values).toEqual({});
    expect(buildGenerateBody(stateFor(T01, { edits: { 'r/box': true } }), [{ ...box, value: null }]).values).toEqual({ 'r/box': true });
  });
  it('a cleared planned value is sent as null (leave blank); an overwritten suggestion needs no confirmation', () => {
    const s = stateFor(T01, { edits: { '01-customer-and-claim-details/registration': '', 'title/date': '2026-10-05' }, confirmed: ['title/date'] });
    expect(buildGenerateBody(s, rows)).toEqual({ templateId: T01, values: { '01-customer-and-claim-details/registration': null, 'title/date': '2026-10-05' }, confirm: [] });
  });
  it('carries the variant and the cleaned subject', () => {
    const s = stateFor(T03, { variant: 'office', subject: { hireAgreementId: 'hire-1', offerId: '', exhibitEvidenceIds: [] } });
    expect(buildGenerateBody(s, [])).toEqual({ templateId: T03, variant: 'office', subject: { hireAgreementId: 'hire-1' }, values: {}, confirm: [] });
  });
  it('effective input is the edit when there is one', () => {
    const r = rows.find((x) => x.slotId === '01-customer-and-claim-details/registration')!;
    expect(effectiveInput(r, { edits: {} })).toBe('AB12 CDE');
    expect(effectiveInput(r, { edits: { [r.slotId]: 'XY99 ZZZ' } })).toBe('XY99 ZZZ');
  });
});

describe('required values, blocking issues and the Generate button', () => {
  it('a required row is missing until entered; the VALUES_REQUIRED issue then clears', () => {
    const v = values03();
    const rows = rowsOf(v);
    let s = stateFor(T03, { variant: 'hirer' });
    expect(missingRequired(rows, s).map((r) => r.slotId)).toEqual(['04-charges/hire-reference']);
    expect(openBlockingIssues(v.issues, rows, s)).toHaveLength(1);
    expect(generateBlocker(v, s)).toMatch(/1 blocking issue/);
    s = fillReducer(s, { type: 'edit', slotId: '04-charges/hire-reference', value: 'CCG-HIRE-000123' });
    expect(missingRequired(rows, s)).toEqual([]);
    expect(openBlockingIssues(v.issues, rows, s)).toEqual([]);
    expect(generateBlocker(v, s)).toBeUndefined();
  });
  it('a required suggestion counts as missing until confirmed', () => {
    const r = row({ slotId: 'a/b', label: 'B', required: true, policy: 'suggest', value: 'x', needsConfirmation: true, origin: 'suggested' });
    expect(missingRequired([r], stateFor('t'))).toHaveLength(1);
    expect(missingRequired([r], stateFor('t', { confirmed: ['a/b'] }))).toHaveLength(0);
    const v = { ...values01(), groups: [{ section: 'a', title: 'A', rows: [r] }], issues: [] };
    expect(generateBlocker(v, stateFor(T01))).toMatch(/1 required value is missing: B/);
  });
  it('other blocking issues stay; warnings never block', () => {
    const v = { ...values01(), issues: [{ code: 'TEMPLATE_WARNINGS_UNACKNOWLEDGED', severity: 'block' as const, message: 'Review the wording first' }, ...values01().issues] };
    expect(generateBlocker(v, stateFor(T01))).toMatch(/1 blocking issue/);
    expect(generateBlocker(values01(), stateFor(T01))).toBeUndefined();
    expect(generateBlocker(undefined, stateFor(T01))).toMatch(/Waiting/);
    expect(generateBlocker(values01(), initialFillState())).toMatch(/Choose a template/);
  });
});

describe('summary line and row badges', () => {
  const rows = rowsOf(values01());
  it('counts what comes from the claim, what to confirm, what to enter and what is left for signing', () => {
    const s0 = stateFor(T01);
    expect(computeSummary(rows, s0)).toEqual({ fromClaim: 4, toConfirm: 1, toEnter: 4, entered: 0, leftForSigning: 2, leftAsPrinted: 0 });
    expect(summaryLine(computeSummary(rows, s0))).toBe('4 filled from the claim · 1 to confirm · 4 to enter · 2 left for signing');
    const s1 = stateFor(T01, { confirmed: ['title/date'], edits: { '01-customer-and-claim-details/own-claim-ref': 'OWN-1' } });
    expect(summaryLine(computeSummary(rows, s1))).toBe('5 filled from the claim · 0 to confirm · 3 to enter · 2 left for signing · 1 entered by you');
  });
  it('badges: From claim, Suggested — tick to confirm, Enter, Signed by hand — left blank, Left as printed', () => {
    const s = stateFor(T01);
    const by = (id: string) => rowBadge(rows.find((r) => r.slotId === id)!, s);
    expect(by('title/reference')).toMatchObject({ label: 'From claim', tone: 'green', locked: false });
    expect(by('title/date')).toMatchObject({ label: 'Suggested — tick to confirm', tone: 'amber', confirm: true });
    expect(by('01-customer-and-claim-details/own-claim-ref')).toMatchObject({ label: 'Enter', tone: 'grey' });
    expect(by('13-client-authorisation/@client/signature')).toMatchObject({ label: 'Signed by hand — left blank', locked: true });
    expect(rowBadge(row({ slotId: 'r/x', label: 'X', policy: 'never', editable: false }), s)).toMatchObject({ label: 'Left as printed', locked: true });
    expect(rowBadge(row({ slotId: 'r/x', label: 'X', origin: 'settings', value: 'v' }), s).label).toBe('From settings');
    expect(rowBadge(rows[2]!, stateFor(T01, { edits: { [rows[2]!.slotId]: 'Someone Else' } })).label).toBe('Entered by you');
    expect(isLocked(row({ slotId: 'r/x', label: 'X', policy: 'post-event', editable: false }))).toBe(true);
  });
  it('origin labels for the Values used panel', () => {
    expect(originLabel('claim')).toBe('From claim');
    expect(originLabel('handler')).toBe('Entered by the handler');
    expect(originLabel(undefined)).toBe('Left blank');
  });
});

describe('hints and caveats', () => {
  it('narrow cells get a size hint for typed text only', () => {
    expect(narrowCellHint({ widthTwips: 1134, inputType: 'text' })).toBe('This box is about 2 cm wide — keep it short');
    expect(narrowCellHint({ widthTwips: 400, inputType: 'int' })).toBe('This box is about 1 cm wide — keep it short');
    expect(narrowCellHint({ widthTwips: 3000, inputType: 'text' })).toBeUndefined();
    expect(narrowCellHint({ widthTwips: 1000, inputType: 'date' })).toBeUndefined();
    expect(narrowCellHint({ inputType: 'text' })).toBeUndefined();
  });
  it('GTA rows carry the benchmark caveat', () => {
    const gta = rowsOf(values03())[0]!;
    expect(isGtaRow(gta)).toBe(true);
    expect(isGtaRow(rowsOf(values01())[0]!)).toBe(false);
    expect(GTA_BENCHMARK_CAVEAT).toBe('GTA rates are an industry benchmark only. Courtesy Cars Group UK Ltd is not a GTA subscriber.');
  });
});

describe('subjects', () => {
  const view = claimView();
  it('built from the claim file when the API sends no lists', () => {
    const o = subjectOptions(undefined, view);
    expect(o.witnesses).toEqual([{ value: 'p-w1', label: 'Wendy Witness' }]);
    expect(o.hires.map((h) => h.value)).toEqual(['hire-1']);
    expect(o.hires[0]!.label).toContain('(open)');
    expect(o.recipients.map((r) => r.value)).toEqual(['p-ins', 'p-client', 'p-tp', 'p-w1']);
    expect(o.exhibits).toEqual([{ value: 'ev-1', label: 'dashcam.mp4 — Dashcam clip' }]);
  });
  it('the API lists win when present', () => {
    expect(subjectOptions(values03(), view).hires).toEqual([{ value: 'hire-1', label: 'CCG-H-000123 — from 2026-09-01' }]);
  });
  it('a witness statement needs its witness', () => {
    expect(subjectBlocker(['witness'], {})).toBe('Choose the witness.');
    expect(subjectBlocker(['witness'], { witnessPartyId: 'p-w1' })).toBeUndefined();
    expect(subjectBlocker(['hire'], {})).toBeUndefined();
  });
});

describe('document format helpers (lib/documents.ts)', () => {
  it('Word documents, HTML letters and kind labels', () => {
    const d = docxDocument();
    expect(isDocx(d)).toBe(true);
    expect(isDocx({ ...d, format: 'html' })).toBe(false);
    expect(isDocx({})).toBe(false);
    expect(isHtmlLetter({ templateId: 'letter.ncaf' })).toBe(true);
    expect(isHtmlLetter({ ...d, templateId: 'letter.ccguk_letterhead_formal' })).toBe(false);
    expect(documentKindLabel(d)).toBe('Agreement (Word)');
    expect(documentKindLabel({ templateId: 'invoice.hire' })).toBe('Invoice');
  });
  it('the PDF exists after approval and records its converter', () => {
    expect(hasApprovedPdf({ status: 'draft' })).toBe(false);
    expect(hasApprovedPdf({ status: 'signed' })).toBe(true);
    expect(pdfConverterNote(docxDocument())).toBeUndefined();
    expect(pdfConverterNote(docxDocument({ status: 'approved', pdfConverter: 'word' }))).toBe('PDF made with Microsoft Word');
    expect(pdfConverterNote(docxDocument({ status: 'approved', pdfConverter: 'libreoffice' }))).toBe('PDF made with LibreOffice');
    expect(pdfConverterNote(docxDocument({ status: 'sent', pdfConverter: 'browser' }))).toBe('PDF made with the built-in browser');
    expect(pdfConverterNote({ ...docxDocument({ status: 'approved', pdfConverter: 'word' }), format: 'html' })).toBeUndefined();
    expect(pdfConverterLabel(undefined)).toBeUndefined();
  });
  it('values used come from dataSnapshot._docx.values with readable labels', () => {
    const used = docxValuesUsed(docxDocument());
    expect(used.map((v) => [v.label, v.display, v.origin])).toEqual([
      ['Reference', 'CCG-2026-00012', 'claim'],
      ['Full name (client)', 'Amelia Hart', 'claim'],
      ['Own claim ref', 'OWN-123', 'handler']
    ]);
    expect(docxValuesUsed(docxDocument({ dataSnapshot: {} }))).toEqual([]);
    expect(docxValuesUsed(docxDocument({ dataSnapshot: { _docx: { values: 'nope' } } }))).toEqual([]);
  });
  it('slot labels from ids', () => {
    expect(slotLabelFromId('title/date')).toBe('Date');
    expect(slotLabelFromId('03-incident/@replacement-vehicle-credit-hire/registration')).toBe('Registration (replacement vehicle credit hire)');
    expect(slotLabelFromId('02/i-first-appointed-ccguk-on#2:1')).toBe('I first appointed ccguk on 2 (1)');
  });
});

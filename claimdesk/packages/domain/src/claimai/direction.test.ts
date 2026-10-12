// owned by claimai-server
import { describe, expect, it } from 'vitest';
import { directionOf, type DirectionInput, type Identity, type PartyHints } from './direction.js';

const ID: Identity = { companyNames: ['Courtesy Cars Group UK Ltd', 'CCGUK'], ourEmails: ['claims@ccguk.example.test'], ourDomains: ['ccguk.example.test'], ourPostcodes: ['RG1 1ZZ'], ourPhones: [], ourRefPattern: /CCG-\d{4}-\d{5}/ };
const P: PartyHints = { client: { names: ['Jane Doe'], emails: ['jane.doe@example.test'] }, insurer: { names: ['Example Mutual Insurance'], emails: [], domains: ['example-mutual.example.test'], postcodes: ['LS1 2AB'] }, others: [] };
const base: DirectionInput = { docType: 'correspondence', role: 'document', isPhoto: false, email: null, head: '', tail: '', formTemplateId: null, signed: null, override: null };
const d = (x: Partial<DirectionInput>) => directionOf({ ...base, ...x }, ID, P);

const ourLetter = {
  head: 'Courtesy Cars Group UK Ltd\n1 Depot Road, Reading RG1 1ZZ\nclaims@ccguk.example.test\nExample Mutual Insurance\nClaims Department\nLeeds LS1 2AB\n2 October 2026\nOur ref: CCG-2026-00001\nDear Sirs\nNew Claim Advice Form',
  tail: 'Yours faithfully\n\nClaims Team\nCourtesy Cars Group UK Ltd',
};
const insurerLetter = {
  head: 'Example Mutual Insurance\nPO Box 1, Leeds LS1 2AB\n\nCourtesy Cars Group UK Ltd\n1 Depot Road\nReading RG1 1ZZ\n6 October 2026\nOur ref: TPI/778812\nYour ref: CCG-2026-00001\nDear Courtesy Cars',
  tail: 'Yours faithfully\nClaims Handler\nExample Mutual Insurance',
};

describe('directionOf (§3.6)', () => {
  it('the owner override wins', () => {
    expect(d({ ...insurerLetter, override: 'out' })).toMatchObject({ direction: 'out', confidence: 1, why: 'Set by you' });
  });
  it('documents that are not correspondence and photos are for the file', () => {
    expect(d({ docType: 'v5c' }).direction).toBe('none');
    expect(d({ docType: null, isPhoto: true }).direction).toBe('none');
    expect(d({ docType: 'engineer_report' }).direction).toBe('none');
  });
  it('emails: from our mailbox → out (counterparty = first To); to us → in; neither → unknown', () => {
    expect(d({ role: 'email', email: { from: 'Claims <claims@ccguk.example.test>', to: ['claims@example-mutual.example.test'], cc: [] } })).toMatchObject({ direction: 'out', confidence: 0.98, counterparty: { role: 'at_fault_insurer' } });
    expect(d({ role: 'email', email: { from: 'jane.doe@example.test', to: ['claims@ccguk.example.test'], cc: [] } })).toMatchObject({ direction: 'in', confidence: 0.98, counterparty: { role: 'client', name: 'Jane Doe' } });
    const n = d({ role: 'email', email: { from: 'a@x.example.test', to: ['b@y.example.test'], cc: [] } });
    expect(n).toMatchObject({ direction: 'unknown', confidence: 0.3 });
    expect(n.why).toMatch(/neither is our mailbox/);
  });
  it('a CCGUK form: signed → returned to us; unsigned → sent out', () => {
    expect(d({ formTemplateId: 'form.statement_of_means', signed: true })).toMatchObject({ direction: 'in', confidence: 0.85 });
    expect(d({ formTemplateId: 'form.statement_of_means', signed: false })).toMatchObject({ direction: 'out', confidence: 0.7 });
  });
  it('letters: our letterhead + sign-off + our ref → out; the insurer letterhead + your ref + Dear Courtesy Cars → in', () => {
    const o = d(ourLetter);
    expect(o.direction).toBe('out');
    expect(o.confidence).toBe(0.95);
    expect(o.counterparty).toMatchObject({ role: 'at_fault_insurer' });
    expect(o.why).toMatch(/our letterhead/);
    const i = d(insurerLetter);
    expect(i.direction).toBe('in');
    expect(i.counterparty).toMatchObject({ role: 'at_fault_insurer', name: 'Example Mutual Insurance' });
  });
  it('our invoice → out; no clues → unknown ("pick one")', () => {
    expect(d({ docType: 'invoice', head: 'INVOICE\nCourtesy Cars Group UK Ltd\nInvoice no 12', tail: '' }).direction).toBe('out');
    expect(d({ head: 'To whom it may concern\n5 October 2026\nThe car was returned.', tail: 'Thanks' })).toMatchObject({ direction: 'unknown', why: 'Could not tell who wrote it — pick one' });
  });
});

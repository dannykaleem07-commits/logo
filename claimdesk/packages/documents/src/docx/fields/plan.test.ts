import { describe, expect, it } from 'vitest';
import { scanDocx } from '../scan.js';
import type { DocxScan } from '../types.js';
import { builtinAssetBytes, builtinMapping } from './builtin/index.js';
import { buildFillPlan } from './plan.js';
import { sampleMergeSource, type MergeSource } from './source.js';
import type { FillPlan, PlanInputs } from './types.js';

const scans = new Map<string, DocxScan>();
const scanOf = (id: string): DocxScan => {
  let s = scans.get(id);
  if (!s) {
    s = scanDocx(builtinAssetBytes(id));
    scans.set(id, s);
  }
  return s;
};
const plan = (id: string, inputs: PlanInputs = {}, src: MergeSource = sampleMergeSource()): FillPlan => buildFillPlan(scanOf(id), builtinMapping(id), src, inputs);
const row = (p: FillPlan, slotId: string) => {
  const r = p.rows.find((x) => x.slotId === slotId);
  if (!r) throw new Error(`no row ${slotId}`);
  return r;
};
const ins = (p: FillPlan, slotId: string) => p.instructions.find((i) => i.slotId === slotId)?.value;
const codes = (p: FillPlan) => p.issues.map((i) => i.code);
const blocks = (p: FillPlan) => p.issues.filter((i) => i.severity === 'block').map((i) => i.code);

const L01 = 'agreement.ccguk_01_customer_loa';
const L02 = 'agreement.ccguk_02_recovery_storage_engineering';
const H03 = 'agreement.ccguk_03_credit_hire';
const W04 = 'statement.ccguk_04_witness';
const P05 = 'form.ccguk_05_payment_direction';
const C06 = 'form.ccguk_06_handover_condition';
const LH = 'letter.ccguk_letterhead_formal';
const BANK = { accountName: 'Courtesy Cars Group UK Ltd', bankName: 'Test Bank (fixture)', sortCode: '040605', accountNumber: '00000000' };

describe('buildFillPlan — precedence (§B.9)', () => {
  it('auto values print; handler input beats the resolver; null leaves the box blank', () => {
    const p = plan(L01);
    expect(row(p, '01-customer-and-claim-details/registration')).toMatchObject({ display: 'AB12 CDE', origin: 'claim', editable: true, policy: 'auto' });
    expect(ins(p, 'title/reference')).toEqual({ type: 'text', text: 'CCG-2026-00012' });
    const typed = plan(L01, { values: { '01-customer-and-claim-details/registration': 'XY99 ZZZ', '01-customer-and-claim-details/vin': null } });
    expect(row(typed, '01-customer-and-claim-details/registration')).toMatchObject({ display: 'XY99 ZZZ', origin: 'handler', value: 'XY99 ZZZ' });
    expect(row(typed, '01-customer-and-claim-details/vin').display).toBe('');
    expect(ins(typed, '01-customer-and-claim-details/vin')).toBeUndefined();
  });

  it('the same function serves preview and generation: identical inputs give identical plans', () => {
    const a = plan(H03, { values: { '02-driver-and-insurance-record/licence-type': 'Full UK' }, confirm: ['title/date'] });
    const b = plan(H03, { values: { '02-driver-and-insurance-record/licence-type': 'Full UK' }, confirm: ['title/date'] });
    expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)));
  });

  it('suggest needs confirm: shown as a suggestion, printed only once confirmed', () => {
    const p = plan(L01);
    const d = row(p, 'title/date');
    expect(d).toMatchObject({ policy: 'suggest', needsConfirmation: true, confirmed: false, display: '', value: '2026-10-04', origin: 'suggested' });
    expect(ins(p, 'title/date')).toBeUndefined();
    const c = plan(L01, { confirm: ['title/date'] });
    expect(row(c, 'title/date').confirmed).toBe(true);
    expect((ins(c, 'title/date') as { text: string }).text.replace(/\s+/g, '')).toBe('04/10/2026');
  });

  it('handler policy prints only handler input (01 settlement authority never set without input)', () => {
    const p = plan(L01);
    expect(ins(p, '08-settlement-authority/standard-authority-ccguk-may-negotiate-and-prese')).toBeUndefined();
    expect(ins(p, '08-settlement-authority/full-settlement-authority-i-authorise-ccguk-to-n')).toBeUndefined();
    expect(ins(p, '01-customer-and-claim-details/own-claim-ref')).toBeUndefined();
    const chosen = plan(L01, { values: { '08-settlement-authority/standard-authority-ccguk-may-negotiate-and-prese': true } });
    expect(ins(chosen, '08-settlement-authority/standard-authority-ccguk-may-negotiate-and-prese')).toEqual({ type: 'check', checked: true });
    expect(ins(chosen, '08-settlement-authority/full-settlement-authority-i-authorise-ccguk-to-n')).toBeUndefined();
  });

  it('SLOT_NOT_FILLABLE for signature, never and bank inputs; the input is not used', () => {
    const p = plan(P05, {
      values: {
        '06-client-declaration-and-signature/@client/signature': 'Priya Patel',
        '05-duration-and-revocation/revoked-on': '2026-10-01',
        '03-payment-details/sort-code': '112233'
      }
    }, { ...sampleMergeSource(), company: { ...sampleMergeSource().company, bank: BANK } });
    const nf = p.issues.filter((i) => i.code === 'SLOT_NOT_FILLABLE');
    expect(nf.map((i) => i.slotId).sort()).toEqual(['03-payment-details/sort-code', '05-duration-and-revocation/revoked-on', '06-client-declaration-and-signature/@client/signature']);
    expect(nf.every((i) => i.severity === 'block')).toBe(true);
    expect(ins(p, '06-client-declaration-and-signature/@client/signature')).toBeUndefined();
    expect(ins(p, '05-duration-and-revocation/revoked-on')).toBeUndefined();
    expect(ins(p, '03-payment-details/sort-code')).toEqual({ type: 'text', text: '04  —  06  —  05' }); // from Settings, not the input
    for (const r of p.rows.filter((x) => x.policy === 'signature' || x.policy === 'never')) expect(r.editable, r.slotId).toBe(false);
  });

  it('post-event fields are blank at first generation', () => {
    const p = plan(P05, {}, { ...sampleMergeSource(), company: { ...sampleMergeSource().company, bank: BANK } });
    for (const sid of ['07-for-office-use/date-taken', '07-for-office-use/sent-to-third-party-insurer-on', '07-for-office-use/acknowledged-by-insurer-on']) {
      expect(row(p, sid).policy).toBe('post-event');
      expect(ins(p, sid), sid).toBeUndefined();
    }
  });

  it('VALUES_REQUIRED until a required value exists (04 relationship)', () => {
    const p = plan(W04);
    expect(blocks(p)).toContain('VALUES_REQUIRED');
    expect(row(p, 'title/relationship-to-claimant')).toMatchObject({ required: true, missing: true, editable: true });
    expect(p.issues.find((i) => i.code === 'WITNESS_RELATIONSHIP_REQUIRED')?.slotId).toBe('title/relationship-to-claimant');
    const ok = plan(W04, { values: { 'title/relationship-to-claimant': 'None — independent passer-by', 'title/paragraphs': ['I saw the blue van pull out.'] } });
    expect(blocks(ok)).toEqual([]);
    expect(row(ok, 'title/relationship-to-claimant').missing).toBe(false);
  });

  it('onlyIf: 01 first-appointed date prints only with the retrospective tick; 03 delivery address only when delivered', () => {
    const p = plan(L01);
    expect(ins(p, '02-appointment-and-authority-to-act/that-i-first-appointed-ccguk-on')).toBeUndefined();
    const c = plan(L01, { confirm: ['02-appointment-and-authority-to-act/where-this-agreement-is-signed-after-ccguk-began'] });
    expect(ins(c, '02-appointment-and-authority-to-act/where-this-agreement-is-signed-after-ccguk-began')).toEqual({ type: 'check', checked: true });
    expect(ins(c, '02-appointment-and-authority-to-act/that-i-first-appointed-ccguk-on')).toEqual({ type: 'text', text: '10 / 08 / 2026' });
    const id = '05-how-and-where-this-agreement-was-made/vehicle-collected-from';
    const delivered = plan(H03, { confirm: [id, `${id}|delivered-to-hirer-at`] });
    expect(ins(delivered, id)).toEqual({ type: 'choice', selected: ['delivered-to-hirer-at'], blanks: { 'delivered-to-hirer-at': '12 High Street, Hounslow TW3 1AB' } });
    const collected = plan(H03, { values: { [id]: ['ccguk-premises'] }, confirm: [`${id}|delivered-to-hirer-at`] });
    expect(ins(collected, id)).toEqual({ type: 'choice', selected: ['ccguk-premises'] });
  });

  it('variants: 03 hirer copy removes the enforceability block, office keeps it; unknown variant blocks', () => {
    const hirer = plan(H03);
    expect(hirer.variant).toBe('hirer');
    expect(hirer.removeBlocks).toEqual(['enforceability-check']);
    expect(hirer.rows.some((r) => r.slotId.startsWith('enforceability-check'))).toBe(false);
    const office = plan(H03, { variant: 'office', values: { 'enforceability-check-internal-use-not-for-the-hi/agreement-signed-and-dated-by-the-hirer-in-the-h': ['yes'] } });
    expect(office.removeBlocks).toEqual([]);
    expect(ins(office, 'enforceability-check-internal-use-not-for-the-hi/agreement-signed-and-dated-by-the-hirer-in-the-h')).toEqual({ type: 'choice', selected: ['yes'] });
    expect(blocks(plan(H03, { variant: 'nope' }))).toContain('UNKNOWN_VARIANT');
  });

  it('variants: 02 instruction leaves C1 blank, submission fills it; 06 return-stage rows print only in the return copy', () => {
    const i = plan(L02);
    expect(i.variant).toBe('instruction');
    expect(ins(i, 'c1-service-record/c1-1-recovery/attended')).toBeUndefined();
    expect(row(i, 'c1-service-record/c1-1-recovery/attended').editable).toBe(false);
    const s = plan(L02, { variant: 'submission' });
    expect(ins(s, 'c1-service-record/c1-1-recovery/attended')).toEqual({ type: 'text', text: '10 / 08 / 2026  at  12 : 00' });
    expect(ins(s, 'c1-service-record/c1-4-account/@charge/total')).toEqual({ type: 'text', text: '1,111.00' });
    const closed = sampleMergeSource();
    closed.hire = { ...closed.hire!, agreement: { ...closed.hire!.agreement, endAt: '2026-08-30T16:00:00Z', odometerIn: 13034 } };
    expect(ins(plan(C06, {}, closed), '06-return-vehicle-in/odometer-in')).toBeUndefined();
    expect(ins(plan(C06, { variant: 'return' }, closed), '06-return-vehicle-in/odometer-in')).toEqual({ type: 'text', text: '13,034' });
  });

  it('05 is blocked without bank details or with another account name, and generates with the registered name', () => {
    expect(blocks(plan(P05))).toContain('BANK_DETAILS_REQUIRED');
    const other = sampleMergeSource();
    other.company = { ...other.company, bank: { ...BANK, accountName: 'Courtesy Cars Ltd' } };
    expect(blocks(plan(P05, {}, other))).toContain('BANK_ACCOUNT_NAME_MISMATCH');
    const placeholder = sampleMergeSource();
    placeholder.company = { ...placeholder.company, bank: { ...BANK, sortCode: '00-00-00' } };
    expect(blocks(plan(P05, {}, placeholder))).toContain('BANK_DETAILS_PLACEHOLDER');
    const good = sampleMergeSource();
    good.company = { ...good.company, bank: { ...BANK, accountName: 'COURTESY CARS GROUP UK LIMITED' } };
    const p = plan(P05, {}, good);
    expect(blocks(p)).toEqual([]);
    expect(row(p, '03-payment-details/account-number').display).toBe('00000000');
  });

  it('GTA benchmark rates print only when verified or confirmed, with the benchmark caveat', () => {
    const p = plan(H03);
    const own = row(p, '04-hire-charges-and-gta-rate-benchmarking/a-contractual-hire-charges/@rate/comparator-hirers-own-vehicle-class');
    expect(own).toMatchObject({ display: '65.12', verification: 'verified', needsConfirmation: false });
    expect(own.note).toMatch(/benchmark/);
    const repl = row(p, '04-hire-charges-and-gta-rate-benchmarking/a-contractual-hire-charges/@rate/comparator-replacement-vehicle-class');
    expect(repl).toMatchObject({ display: '', verification: 'unverified', needsConfirmation: true, value: 7120 });
    const c = plan(H03, { confirm: [repl.slotId] });
    expect(row(c, repl.slotId).display).toBe('71.20');
  });

  it('a carried-over confirmation stands only while the confirmed figure is unchanged', () => {
    const slot = '04-hire-charges-and-gta-rate-benchmarking/a-contractual-hire-charges/@rate/comparator-replacement-vehicle-class';
    const same = plan(H03, { confirm: [slot], confirmedDisplay: { [slot]: '71.20' } });
    expect(row(same, slot)).toMatchObject({ display: '71.20', confirmed: true });
    const changed = plan(H03, { confirm: [slot], confirmedDisplay: { [slot]: '55.00' } });
    expect(row(changed, slot)).toMatchObject({ display: '', confirmed: false, needsConfirmation: true });
    expect(row(changed, slot).note).toMatch(/Previously confirmed as "55.00"/);
    expect(changed.issues.find((i) => i.code === 'CONFIRMATION_STALE')).toMatchObject({ severity: 'warn', slotId: slot });
  });

  it('02 C1.4 total adds the Additional (clause 5) line and typed line charges; a typed total wins', () => {
    const base = 'c1-service-record/c1-4-account/@charge/';
    const add = plan(L02, { variant: 'submission', values: { 'c1-service-record/c1-4-account/@carried-out/additional-clause-5': 'Specialist lifting equipment', [`${base}additional-clause-5`]: '£120.00' } });
    expect(ins(add, `${base}additional-clause-5`)).toEqual({ type: 'text', text: '120.00' });
    expect(ins(add, `${base}total`)).toEqual({ type: 'text', text: '1,231.00' });
    const typedLine = plan(L02, { variant: 'submission', values: { [`${base}recovery`]: '£100.00' } });
    expect(ins(typedLine, `${base}total`)).toEqual({ type: 'text', text: '1,060.00' });
    const typedTotal = plan(L02, { variant: 'submission', values: { [`${base}additional-clause-5`]: '£120.00', [`${base}total`]: '£999.00' } });
    expect(ins(typedTotal, `${base}total`)).toEqual({ type: 'text', text: '999.00' });
  });

  it('an impossible date typed by the handler is refused, never printed', () => {
    for (const bad of ['31/02/2026', '2026-13-45']) {
      const p = plan(L01, { values: { 'title/date': bad } });
      expect(row(p, 'title/date').inputType).toBe('date');
      expect(p.issues.find((i) => i.code === 'INVALID_INPUT' && i.slotId === 'title/date'), bad).toBeDefined();
      expect(row(p, 'title/date').display, bad).not.toMatch(/31 \/ 02|45/);
    }
    expect(row(plan(L01, { values: { 'title/date': '28/02/2026' } }), 'title/date').display.replace(/\s+/g, '')).toBe('28/02/2026');
  });

  it('the letterhead and witness statement bodies are required: drafting placeholders never print', () => {
    const lh = plan(LH);
    expect(row(lh, 'title/paragraphs')).toMatchObject({ label: 'Letter paragraphs', required: true, missing: true });
    expect(lh.issues.find((i) => i.code === 'VALUES_REQUIRED' && i.slotId === 'title/paragraphs')).toBeDefined();
    const w = plan(W04, { values: { 'title/relationship-to-claimant': 'None' } });
    expect(row(w, 'title/paragraphs')).toMatchObject({ label: 'Statement paragraphs', required: true, missing: true });
    expect(blocks(w)).toEqual(['VALUES_REQUIRED']);
  });

  it('a date-and-time blank in a narrow cell is filled compactly so it does not wrap (03 hire start, 06 time out)', () => {
    const hireStart = plan(H03).rows.find((r) => r.slotId.startsWith('01-parties-and-agreement-details/agreement-hire-st'))!;
    expect(hireStart.display).toBe('11/08/2026 at 10:00');
    const out = plan(C06).rows.find((r) => r.slotId === '02-release-vehicle-out/date-and-time-out')!;
    expect(out.display).toBe('11/08/2026 at 11:15');
    // a wide cell keeps the printed spacing
    expect(row(plan(L02, { variant: 'submission' }), 'c1-service-record/c1-1-recovery/attended').display).toBe('10 / 08 / 2026  at  12 : 00');
  });

  it('a named addressee is greeted by name and signed off "sincerely"; a team stays "Sir or Madam"', () => {
    const p = plan(LH, { values: { 'title/name-of-handler': 'Ms Priya Patel', 'title/paragraphs': ['x'] } });
    expect(row(p, 'title/sir-or-madam').display).toBe('Ms Patel');
    expect(row(p, 'title/sincerely-faithfully').display).toBe('sincerely');
    const team = plan(LH, { values: { 'title/name-of-handler': 'Third Party Claims Team', 'title/paragraphs': ['x'] } });
    expect(row(team, 'title/sir-or-madam').display).toBe('Sir or Madam');
    expect(row(team, 'title/sincerely-faithfully').display).toBe('faithfully');
    const client = sampleMergeSource();
    client.recipient = { name: 'Ms Jane Example', addressLines: ['1 Road'], role: 'client' };
    const c = plan(LH, { values: { 'title/paragraphs': ['x'] } }, client);
    expect(row(c, 'title/sir-or-madam').display).toBe('Ms Example');
    expect(row(c, 'title/sincerely-faithfully').display).toBe('sincerely');
  });

  it('option blanks are separate rows and merge into the choice instruction', () => {
    const id = 'a2-client-vehicle-and-claim/a2-2-the-vehicle/registered-keeper';
    const p = plan(L02, { values: { [id]: ['other-name-and-relationship'], [`${id}|other-name-and-relationship`]: 'Raj Patel (husband)' } });
    expect(row(p, `${id}|other-name-and-relationship`)).toMatchObject({ key: 'vehicle.keeperNameRelationship', display: 'Raj Patel (husband)', origin: 'handler' });
    expect(ins(p, id)).toEqual({ type: 'choice', selected: ['other-name-and-relationship'], blanks: { 'other-name-and-relationship': 'Raj Patel (husband)' } });
  });

  it('printedRates warns (01, 02 instruction) and blocks the 02 submission totals', () => {
    const s = sampleMergeSource();
    s.storage = [{ ...s.storage[0]!, dailyRatePence: 5000 }];
    expect(p01Codes(s)).toContain('PRINTED_RATES_DIFFER');
    expect(plan(L02, {}, s).issues.find((i) => i.code === 'PRINTED_RATES_DIFFER')?.severity).toBe('warn');
    expect(blocks(plan(L02, { variant: 'submission' }, s))).toContain('PRINTED_RATES_DIFFER');
    expect(codes(plan(L02, { variant: 'submission' }))).not.toContain('PRINTED_RATES_DIFFER');
  });

  it('open records never print an end date or total; a handler-typed end date is the handler’s statement', () => {
    const s = sampleMergeSource();
    s.storage = [{ ...s.storage[0]!, endAt: undefined }];
    const p = plan(L02, { variant: 'submission' }, s);
    expect(blocks(p)).toEqual([]);
    for (const sid of ['c1-service-record/c1-2-storage/released', 'c1-service-record/c1-2-storage-log-why-the-vehicle-remained-in-sto/storage-charge:2', 'c1-service-record/c1-2-storage-log-why-the-vehicle-remained-in-sto/storage-charge:4', 'c1-service-record/c1-4-account/@charge/total']) expect(ins(p, sid), sid).toBeUndefined();
  });

  it('hireReference blocks a doubled CCG-HIRE- prefix', () => {
    const p = plan(H03, { values: { '01-parties-and-agreement-details/agreement-ref': 'CCG-HIRE-CCG-H-000123' } });
    expect(blocks(p)).toContain('REFERENCE_DOUBLED');
  });

  it('04 exhibit sheet is removed when there are no exhibits', () => {
    const s = sampleMergeSource();
    s.exhibits = [];
    const p = plan(W04, { values: { 'title/relationship-to-claimant': 'None' } }, s);
    expect(p.removeBlocks).toContain('exhibit-sheet');
    expect(row(p, 'title/exhibit-s-referred-to').display).toBe('None');
    expect(p.rows.some((r) => r.slotId.startsWith('exhibit/'))).toBe(false);
    expect(plan(W04).removeBlocks).toEqual([]);
  });

  it('letterhead: valediction follows the salutation; empty recipient lines are removed', () => {
    const p = plan(LH, { values: { 'title/sir-or-madam': 'Ms Jones', 'title/subject-of-this-letter': 'Hire charges', 'title/paragraphs': ['We write about the hire charges.'] } });
    expect(row(p, 'title/sincerely-faithfully').display).toBe('sincerely');
    expect(blocks(p)).toEqual([]);
    const bare = sampleMergeSource();
    bare.recipient = { name: 'Example Insurance plc', addressLines: [] };
    const q = plan(LH, { values: { 'title/subject-of-this-letter': 'Hire charges' } }, bare);
    for (const sid of ['title/name-of-handler', 'title/department-team', 'title/address-line-1', 'title/address-line-2', 'title/town-postcode', 'title/recipient-insurer-co-uk', 'title/dd-month-yyyy#3', 'title/list-every-enclosure-numbered']) expect(ins(q, sid), sid).toEqual({ type: 'remove', scope: 'paragraph' });
    expect(ins(q, 'title/insurer-reference')).toEqual({ type: 'remove', scope: 'row' });
    expect(row(q, 'title/sincerely-faithfully').display).toBe('faithfully');
  });

  it('rows carry what the values form needs and are JSON-serialisable', () => {
    const p = plan(L02);
    const r = row(p, 'a2-client-vehicle-and-claim/a2-2-the-vehicle/fuel');
    expect(r).toMatchObject({ inputType: 'choice', multiple: false, key: 'vehicle.fuelType', value: ['petrol'] });
    expect(r.options?.map((o) => o.value)).toEqual(['petrol', 'diesel', 'hybrid', 'ev']);
    expect(row(p, 'c1-service-record/c1-2-storage-log-why-the-vehicle-remained-in-sto/table-from-to').columns?.map((c) => c.id)).toEqual(['from', 'to', 'days', 'why-the-vehicle-remained-in-storage', 'evidence']);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});

function p01Codes(s: MergeSource): string[] {
  return codes(plan(L01, {}, s));
}

import { existsSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { listTemplates } from '../../registry.js';
import { scanDocx } from '../scan.js';
import type { DocxScan } from '../types.js';
import { BUILTIN_DOCX_TEMPLATES, builtinAssetBytes, builtinAssetPath, builtinMapping } from './builtin/index.js';
import { getFieldDef } from './dictionary.js';
import { mergeMappings, resolveSelectors, unmappedSlots, validateMapping } from './mapping.js';
import type { TemplateMapping } from './types.js';

const scans = new Map<string, DocxScan>();
const scanOf = (id: string): DocxScan => {
  let s = scans.get(id);
  if (!s) {
    s = scanDocx(builtinAssetBytes(id));
    scans.set(id, s);
  }
  return s;
};
const IDS = BUILTIN_DOCX_TEMPLATES.map((t) => t.id);

/** Effective policy of the entry mapped to a slot. */
function policyOf(id: string, slotId: string): string | undefined {
  const m = builtinMapping(id);
  const { bySlot } = resolveSelectors(m, scanOf(id));
  const e = bySlot.get(slotId);
  if (!e) return undefined;
  return e.policy ?? (e.key ? getFieldDef(e.key)?.policy : 'handler') ?? 'handler';
}

describe('BUILTIN_DOCX_TEMPLATES (§C.1)', () => {
  it('lists the ten templates with ids, files, kinds, titles, roles, subjects and variants as designed', () => {
    const rows = BUILTIN_DOCX_TEMPLATES.map((t) => [t.id, t.file, t.kind, t.title, t.recipientRole, t.subjects.join(','), t.variants.map((v) => `${v.id}${v.default ? '*' : ''}`).join(',')]);
    expect(rows).toEqual([
      ['agreement.ccguk_01_customer_loa', 'CCGUK-01-Customer-Agreement-and-Letter-of-Authority.docx', 'agreement', 'Customer Agreement & Letter of Authority', 'client', '', ''],
      ['agreement.ccguk_02_recovery_storage_engineering', 'CCGUK-02_Recovery_Storage_Engineering_Pack_TEMPLATE_v5.docx', 'agreement', 'Recovery, Storage & Engineering Pack', 'client', '', 'instruction*,submission'],
      ['agreement.ccguk_03_credit_hire', 'CCGUK-03-Vehicle-Credit-Hire-Agreement.docx', 'agreement', 'Vehicle Credit Hire Agreement', 'client', 'hire', 'hirer*,office'],
      ['statement.ccguk_04_witness', 'CCGUK-04-Witness-Statement.docx', 'statement', 'Witness Statement', 'client', 'witness', ''],
      ['form.ccguk_05_payment_direction', 'CCGUK-05-Payment-Authorisation-and-Settlement-Direction.docx', 'form', 'Payment Authorisation & Settlement Direction', 'client', '', ''],
      ['form.ccguk_06_handover_condition', 'CCGUK-06-Vehicle-Handover-and-Condition-Report.docx', 'form', 'Vehicle Handover & Condition Report', 'client', 'hire', 'release*,return'],
      ['form.ccguk_07_statement_of_means', 'CCGUK-07-Statement-of-Means.docx', 'form', 'Statement of Means', 'client', 'hire', ''],
      ['form.ccguk_08_intervention_mitigation', 'CCGUK-08-Intervention-and-Mitigation-Record.docx', 'form', 'Intervention & Mitigation Record', 'client', 'offer', ''],
      ['form.ccguk_09_accident_report', 'CCGUK-09-Accident-Report-Form.docx', 'form', 'Accident Report Form', 'client', '', ''],
      ['letter.ccguk_letterhead_formal', 'CCGUK-Letterhead-Formal.docx', 'letter', 'Letter on CCGUK letterhead', 'at_fault_insurer', 'recipient', '']
    ]);
    expect(BUILTIN_DOCX_TEMPLATES.find((t) => t.id === 'agreement.ccguk_03_credit_hire')!.variants[0]!.removeBlocks).toEqual(['enforceability-check']);
  });

  it('known warnings: LEGACY_DETAIL for 01/02, REGULATED_STATUS for the letterhead, BRAND_CLAIM_IMAGE exactly where footer2 carries the accreditation strip', () => {
    for (const t of BUILTIN_DOCX_TEMPLATES) {
      const codes = t.knownWarnings.map((w) => w.code);
      expect(codes.includes('LEGACY_DETAIL'), t.id).toBe(t.id.includes('_01_') || t.id.includes('_02_'));
      expect(codes.includes('REGULATED_STATUS'), t.id).toBe(t.id === 'letter.ccguk_letterhead_formal');
      const zip = unzipSync(builtinAssetBytes(t.id));
      const rels = zip['word/_rels/footer2.xml.rels'];
      const strip = !!rels && /media\/ad2896[0-9a-f]*\.png/.test(strFromU8(rels));
      expect(codes.includes('BRAND_CLAIM_IMAGE'), t.id).toBe(strip);
      for (const w of t.knownWarnings) expect(/car flex|carflex ltd/i.test(w.message), w.message).toBe(false);
    }
  });

  it('resolves asset paths that exist; DOCX templates are not in the HTML registry', () => {
    for (const id of IDS) expect(existsSync(builtinAssetPath(id)), id).toBe(true);
    expect(listTemplates().some((t) => /ccguk_|docx/i.test(t.id))).toBe(false);
    expect(() => builtinMapping('nope')).toThrow();
  });
});

describe('built-in mappings against the real assets (§B.6)', () => {
  it.each(IDS)('%s: zero mapping issues, zero unmapped slots, sourceSha256 matches', (id) => {
    const scan = scanOf(id);
    const m = builtinMapping(id);
    expect(m.schemaVersion).toBe(1);
    expect(m.templateId).toBe(id);
    expect(validateMapping(m, scan)).toEqual([]);
    expect(unmappedSlots(m, scan)).toEqual([]);
    expect(m.sourceSha256).toBe(scan.sha256);
    const meta = BUILTIN_DOCX_TEMPLATES.find((t) => t.id === id)!;
    expect((m.variants ?? []).map((v) => v.id)).toEqual(meta.variants.map((v) => v.id));
    expect(m.subjects ?? []).toEqual(meta.subjects);
  });

  it.each(IDS)('%s: signature slots carry no key and are policy signature', (id) => {
    const scan = scanOf(id);
    const { bySlot } = resolveSelectors(builtinMapping(id), scan);
    for (const s of scan.slots.filter((x) => x.signature)) {
      const e = bySlot.get(s.id);
      expect(e, s.id).toBeDefined();
      expect(e!.key, s.id).toBeUndefined();
      expect(e!.policy, s.id).toBe('signature');
    }
    for (const [slotId, e] of bySlot) if (e.policy === 'signature') expect(e.key, slotId).toBeUndefined();
  });

  it('client declarations, own words, means figures and acknowledgements are handler-only (Appendix 2 H fields)', () => {
    const h = (id: string, pred: (slotId: string) => boolean): void => {
      const ids = scanOf(id).slots.map((s) => s.id).filter(pred);
      expect(ids.length, id).toBeGreaterThan(0);
      for (const sid of ids) expect(policyOf(id, sid), sid).toBe('handler');
    };
    h('agreement.ccguk_03_credit_hire', (s) => s.startsWith('06-statement-of-need-and-mitigation-of-loss/') && !s.includes('/@') && !s.includes('my-damaged-vehicle-is') && !s.includes('transmission-required'));
    h('agreement.ccguk_03_credit_hire', (s) => s.includes('/authorised-driver-declaration/'));
    h('agreement.ccguk_03_credit_hire', (s) => s.startsWith('08-client-acknowledgements/'));
    h('statement.ccguk_04_witness', (s) => s === 'title/paragraphs' || s === 'title/relationship-to-claimant');
    h('form.ccguk_07_statement_of_means', (s) => /^(02|03)-/.test(s) && !s.includes('@frequency/total'));
    h('form.ccguk_07_statement_of_means', (s) => s.startsWith('04-savings-credit-and-available-funds/') || s.startsWith('05-other-transport-available/') || s.startsWith('08-for-office-use/'));
    h('agreement.ccguk_01_customer_loa', (s) => s.startsWith('08-settlement-authority/') || s.startsWith('12-'));
  });

  it('the statement of need and own-words boxes are never pre-filled from data', () => {
    const { bySlot } = resolveSelectors(builtinMapping('agreement.ccguk_03_credit_hire'), scanOf('agreement.ccguk_03_credit_hire'));
    for (const [sid, e] of bySlot) if (sid.includes('in-my-own-words') || sid.includes('journeys-i-cannot-make')) expect(e.key).toBeUndefined();
  });

  it('notes explain ambiguous labels', () => {
    const notes = IDS.flatMap((id) => builtinMapping(id).entries.filter((e) => e.note).map((e) => e.note));
    expect(notes.length).toBeGreaterThan(40);
    const m01 = builtinMapping('agreement.ccguk_01_customer_loa');
    expect(m01.entries.find((e) => e.key === 'claim.settlementAuthority')?.note).toMatch(/Standard Authority applies/);
    expect(builtinMapping('form.ccguk_05_payment_direction').entries.find((e) => e.key === 'payment.directs.hire')?.note).toMatch(/every head/);
  });
});

describe('selectors, validation and merge', () => {
  const scan = (): DocxScan => scanOf('agreement.ccguk_03_credit_hire');
  const base = (entries: TemplateMapping['entries'], extra: Partial<TemplateMapping> = {}): TemplateMapping => ({ schemaVersion: 1, templateId: 't', entries, ...extra });

  it('section and qualifier match by prefix, label exactly, nth among matches', () => {
    // qualifier 'hirer' also matches 'hirer-client' (01), so the 06 block is the third match.
    const { bySlot, issues } = resolveSelectors(
      base([
        { slot: { section: '03', qualifier: 'replacement-vehicle', label: 'registration' }, key: 'hireVehicle.registration' },
        { slot: { section: '03', qualifier: 'original', label: 'registration' }, key: 'vehicle.registration' },
        { slot: { label: 'full-name', qualifier: 'hirer', nth: 3 }, key: 'claimant.name' }
      ]),
      scan()
    );
    expect(issues).toEqual([]);
    expect(bySlot.get('03-incident-and-vehicle-particulars/@replacement-vehicle-credit-hire/registration')?.key).toBe('hireVehicle.registration');
    expect(bySlot.get('03-incident-and-vehicle-particulars/@original-vehicle-pending-assessment/registration')?.key).toBe('vehicle.registration');
    expect(bySlot.get('06-statement-of-need-and-mitigation-of-loss/vehicle-selection-and-availability/@hirer/full-name')?.key).toBe('claimant.name');
  });

  it('reports no-match, ambiguous, unknown key, kind mismatch, laxer policy and duplicates', () => {
    const issues = validateMapping(
      base([
        { slot: { label: 'no-such-label' }, key: 'claim.reference' },
        { slot: { section: '03', label: 'registration' }, key: 'vehicle.registration' },
        { slot: 'title/reference', key: 'no.such.key' },
        { slot: '07-vehicle-handover-and-condition-summary/keys-supplied', key: 'claim.reference' },
        { slot: { section: 'title', label: 'date' }, key: 'doc.date', policy: 'auto' },
        { slot: { section: 'title', label: 'date', kind: 'blank' }, key: 'doc.date' }
      ]),
      scan()
    );
    expect(issues.map((i) => i.code).sort()).toEqual(['DUPLICATE_SLOT', 'KIND_MISMATCH', 'POLICY_LAXER', 'SELECTOR_AMBIGUOUS', 'SELECTOR_NO_MATCH', 'UNKNOWN_KEY']);
  });

  it('an exact-id override entry replaces the curated selector entry; mergeMappings keeps the rest', () => {
    const builtin = builtinMapping('agreement.ccguk_03_credit_hire');
    const merged = mergeMappings(builtin, { entries: [{ slot: 'title/date', key: 'doc.date', policy: 'handler', note: 'office override' }], guards: ['hireReference'] });
    expect(merged.guards).toEqual(['hireReference']);
    expect(merged.variants).toEqual(builtin.variants);
    const { bySlot, issues } = resolveSelectors(merged, scan());
    expect(issues).toEqual([]);
    expect(bySlot.get('title/date')?.note).toBe('office override');
    // An exact-id override of an exact-id entry replaces it in the merged list.
    const twice = mergeMappings(merged, { entries: [{ slot: 'title/date', key: 'doc.date', note: 'second' }] });
    expect(twice.entries.filter((e) => e.slot === 'title/date')).toHaveLength(1);
  });

  it('an ignore selector may cover several slots; an exact entry beats a selector ignore', () => {
    const m = base([{ slot: '13-client-authorisation/@client/signature', policy: 'signature' }], { ignore: [{ label: 'signature' }] });
    const { bySlot, ignored, issues } = resolveSelectors(m, scanOf('agreement.ccguk_01_customer_loa'));
    expect(issues).toEqual([]);
    expect(bySlot.has('13-client-authorisation/@client/signature')).toBe(true);
    expect(ignored.has('13-client-authorisation/@for-courtesy-cars-group-uk-ltd/signature')).toBe(true);
  });

  it('flags variant blocks and block rules that do not exist', () => {
    const issues = validateMapping(base([], { variants: [{ id: 'x', label: 'x', removeBlocks: ['no-such-block'] }], blocks: [{ block: 'nope', removeWhen: { key: 'claim.reference', empty: true } }] }), scan());
    expect(issues.map((i) => i.code)).toEqual(['SELECTOR_NO_MATCH', 'SELECTOR_NO_MATCH']);
  });
});

import { describe, expect, it } from 'vitest';
import { chooserGroups, humaniseRole, recipientOptions, sectionForTemplateId, userLabel, wordTemplateOf, WORD_SECTION_LABEL } from '../screens/claim/lib/documentChooser';

/** Documents tab "New document" chooser (docs/V03-MANAGER-MODE-HIRE-PRICING.md §E9). */
describe('documentChooser', () => {
  it('sections by template-id prefix', () => {
    expect(sectionForTemplateId('letter.ncaf')).toBe('letters');
    expect(sectionForTemplateId('notice.s172_response')).toBe('letters');
    expect(sectionForTemplateId('invoice.hire')).toBe('invoices');
    expect(sectionForTemplateId('form.mitigation')).toBe('forms');
    expect(sectionForTemplateId('agreement.credit_hire')).toBe('forms');
    expect(sectionForTemplateId('statement.witness')).toBe('forms');
    expect(sectionForTemplateId('report.engineer')).toBe('reports');
    expect(sectionForTemplateId('pack.gta_payment')).toBe('reports');
    expect(sectionForTemplateId('bundle.litigation_index')).toBe('reports');
    expect(sectionForTemplateId('mystery.thing')).toBe('reports');
  });

  it('groups: Word templates first, then Letters · Invoices · Forms · Reports & packs, empty sections dropped, titles sorted', () => {
    const groups = chooserGroups(
      [
        { id: 'invoice.hire', title: 'Hire invoice' },
        { id: 'letter.ncaf', title: 'NCAF' },
        { id: 'letter.chaser', title: 'Chaser' },
        { id: 'pack.gta_payment', title: 'Payment pack' }
      ],
      [
        { id: 'w2', title: 'Zeta letter', active: true },
        { id: 'w1', title: 'Alpha letter' },
        { id: 'w3', title: 'Hidden', active: false }
      ]
    );
    expect(groups.map((g) => g.label)).toEqual([WORD_SECTION_LABEL, 'Letters', 'Invoices', 'Reports & packs']);
    expect(groups[0]!.options).toEqual([
      { value: 'docx:w1', label: 'Alpha letter (Word)' },
      { value: 'docx:w2', label: 'Zeta letter (Word)' }
    ]);
    expect(groups[1]!.options.map((o) => o.label)).toEqual(['Chaser', 'NCAF']);
  });

  it('with no Word templates loaded the Fill dialog is still one click away', () => {
    const groups = chooserGroups([], []);
    expect(groups).toEqual([{ label: WORD_SECTION_LABEL, options: [{ value: 'docx:', label: 'Fill a CCGUK Word template…' }] }]);
    expect(wordTemplateOf('docx:')).toBe('');
    expect(wordTemplateOf('docx:abc')).toBe('abc');
    expect(wordTemplateOf('letter.ncaf')).toBeNull();
  });

  it('recipients: one per party id, roles humanised and merged', () => {
    const insurer = { id: 'i', name: 'Example Insurance plc', roles: ['insurer'] as never[] };
    const client = { id: 'c', name: 'Amina Yusuf', roles: ['claimant', 'driver'] as never[] };
    const tp = { id: 't', name: 'Tom Third', roles: ['third_party_driver'] as never[] };
    const opts = recipientOptions([insurer, client, { ...client, roles: ['driver', 'keeper'] as never[] }, undefined, tp, null]);
    expect(opts).toEqual([
      { value: 'i', label: 'Example Insurance plc (insurer)' },
      { value: 'c', label: 'Amina Yusuf (claimant, driver, keeper)' },
      { value: 't', label: 'Tom Third (third party driver)' }
    ]);
    expect(humaniseRole('at_fault_insurer')).toBe('at-fault insurer');
  });

  it('user names instead of ids', () => {
    const users = [{ id: '3f1c-uuid', name: 'Danny Kaleem' }];
    expect(userLabel('3f1c-uuid', users)).toBe('Danny Kaleem');
    expect(userLabel('system', users)).toBe('ClaimDesk');
    expect(userLabel('unknown-id', users)).toBe('unknown-id');
    expect(userLabel(undefined, users)).toBe('');
  });
});

describe('Next actions text (0.3 §E12, §E8)', () => {
  it('shows one sentence, capped, without internal references', async () => {
    const { firstSentence, plainText } = await import('../screens/claim/tabs/ActionsTab');
    expect(plainText('Witness shares the address (lesson g).')).toBe('Witness shares the address.');
    expect(plainText('Gates must be green (BLUEPRINT principle 2). Next.')).toBe('Gates must be green. Next.');
    expect(firstSentence('Send it today. It starts the clock.')).toBe('Send it today.');
    const long = `${'word '.repeat(60)}end.`;
    const s = firstSentence(long);
    expect(s.length).toBeLessThanOrEqual(181);
    expect(s.endsWith('…')).toBe(true);
  });
});

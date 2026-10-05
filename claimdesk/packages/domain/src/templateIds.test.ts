import { describe, expect, it } from 'vitest';
import { canonicalTemplateId, DOCX_TEMPLATE_EQUIVALENTS } from './templateIds.js';
import * as domain from './index.js';
import { validatePaymentPack } from './gta/payment.js';
import { impecuniosityReadiness } from './acceptance/assess.js';
import { mkBundle, mkDoc } from './gta/fixtures.js';

describe('canonicalTemplateId', () => {
  it('maps the four CCGUK Word templates to their HTML equivalents', () => {
    expect(canonicalTemplateId('agreement.ccguk_03_credit_hire')).toBe('agreement.credit_hire');
    expect(canonicalTemplateId('statement.ccguk_04_witness')).toBe('statement.witness');
    expect(canonicalTemplateId('form.ccguk_07_statement_of_means')).toBe('form.statement_of_means');
    expect(canonicalTemplateId('form.ccguk_08_intervention_mitigation')).toBe('form.mitigation_questionnaire');
  });

  it('returns any other id unchanged', () => {
    for (const id of ['letter.ncaf', 'agreement.ccguk_01_customer_loa', 'form.ccguk_05_payment_direction', 'letter.ccguk_letterhead_formal', 'form.user_my_form_ab12', '', 'toString', '__proto__', 'constructor']) {
      expect(canonicalTemplateId(id)).toBe(id);
    }
  });

  it('is idempotent and its targets are HTML ids (never another CCGUK id)', () => {
    for (const [from, to] of Object.entries(DOCX_TEMPLATE_EQUIVALENTS)) {
      expect(from).toMatch(/^(agreement|statement|form)\.ccguk_\d{2}_/);
      expect(to).not.toMatch(/ccguk_/);
      expect(canonicalTemplateId(canonicalTemplateId(from))).toBe(to);
      // the kind prefix is preserved (e-sign rules and the web canSign regex key on it)
      expect(to.split('.')[0]).toBe(from.split('.')[0]);
    }
    expect(Object.isFrozen(DOCX_TEMPLATE_EQUIVALENTS)).toBe(true);
  });

  it('is exported from the package root', () => {
    expect(domain.canonicalTemplateId).toBe(canonicalTemplateId);
    expect(domain.DOCX_TEMPLATE_EQUIVALENTS).toBe(DOCX_TEMPLATE_EQUIVALENTS);
  });
});

describe('rules that key on template ids accept the CCGUK Word equivalents', () => {
  it('acceptance: a signed CCGUK-07 counts as the signed statement of means', () => {
    const without = impecuniosityReadiness(mkBundle({ documents: [] }));
    expect(without.missing.some((m) => m.includes('statement of means'))).toBe(true);
    const withDocx = impecuniosityReadiness(mkBundle({ documents: [mkDoc('form.ccguk_07_statement_of_means', 'signed')] }));
    expect(withDocx.missing.some((m) => m.includes('statement of means'))).toBe(false);
  });

  it('GTA payment pack: an approved CCGUK-08 satisfies the mitigation questionnaire item', () => {
    const v = validatePaymentPack(mkBundle({ documents: [mkDoc('form.ccguk_08_intervention_mitigation', 'approved')] }));
    expect(v.present).toContain('mitigation_questionnaire');
    const none = validatePaymentPack(mkBundle({ documents: [mkDoc('form.ccguk_09_accident_report', 'approved')] }));
    expect(none.missing).toContain('mitigation_questionnaire');
  });
});

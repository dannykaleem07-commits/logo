import { describe, expect, it } from 'vitest';
import { plainText } from './plainText';

describe('plainText', () => {
  it('drops design references from server text', () => {
    expect(plainText('Witness shares the address (lesson g).')).toBe('Witness shares the address.');
    expect(plainText('Gates must be green (BLUEPRINT principle 2). Next.')).toBe('Gates must be green. Next.');
    expect(plainText('become charge certificates unanswered (RENTX, lesson l). Update the V5C.')).toBe('become charge certificates unanswered. Update the V5C.');
    expect(plainText('FNOL questions still open (BLUEPRINT §3.1): phone')).toBe('FNOL questions still open: phone');
    expect(plainText('Do not guess (lesson l: do not guess)')).toBe('Do not guess');
    expect(plainText('active proposal to strike off — live file lesson k; legacy supplier')).toBe('active proposal to strike off; legacy supplier');
  });
  it('turns template ids into words, and drops a bracket that only names the template', () => {
    expect(plainText('Signed statement of means: income, outgoings, savings, credit limits and balances, dependants (form.statement_of_means)')).toBe('Signed statement of means: income, outgoings, savings, credit limits and balances, dependants');
    expect(plainText('mobility needs (form.statement_of_need or a witness statement tagged "need")')).toBe('mobility needs (statement of need form or a witness statement tagged "need")');
    expect(plainText('Draft the report.engineer document')).toBe('Draft the engineer report document');
    expect(plainText('see claimdesk.net and v0.3.7')).toBe('see claimdesk.net and v0.3.7');
  });
  it('leaves ordinary text and brackets alone', () => {
    expect(plainText('Hire ended (client returned the car).')).toBe('Hire ended (client returned the car).');
  });
});

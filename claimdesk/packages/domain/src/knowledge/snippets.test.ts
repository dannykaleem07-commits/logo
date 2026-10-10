// owned by knowledge-learners
import { describe, expect, it } from 'vitest';
import { generaliseSnippet, paragraphsOf, shingleJaccard } from './snippets.js';

describe('generaliseSnippet', () => {
  it('replaces amounts, dates, references and names', () => {
    const r = generaliseSnippet('Mr Sample: we claim £1,234.56 for hire from 3 March 2026 to 12/04/2026 under our ref CCG-2026-0012 (vehicle AB12 CDE).', ['Mr Sample']);
    expect(r.text).toBe('[name]: we claim [amount] for hire from [date] to [date] under our ref [ref] (vehicle [ref]).');
    expect(r.tokens).toEqual(['[name]', '[amount]', '[date]', '[ref]']);
    expect(r.literalsRemain).toBe(false);
  });
  it('flags literals that remain (emails, long numbers, postcodes)', () => {
    expect(generaliseSnippet('Write to claims@example-insurer.test please.', []).literalsRemain).toBe(true);
    expect(generaliseSnippet('Call 01614960000 today.', []).literalsRemain).toBe(true);
    expect(generaliseSnippet('Our office is at M1 1AA.', []).literalsRemain).toBe(true);
    expect(generaliseSnippet('Please respond within 14 days.', []).literalsRemain).toBe(false);
  });
});

describe('shingleJaccard', () => {
  it('1 for identical, 0 for disjoint, in between otherwise', () => {
    const a = 'we look forward to receiving payment of the outstanding balance within fourteen days';
    expect(shingleJaccard(a, a)).toBe(1);
    expect(shingleJaccard(a, 'completely different words that share nothing at all here')).toBe(0);
    const s = shingleJaccard(a, `${a} of this letter`);
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
    expect(shingleJaccard('', '')).toBe(1);
    expect(shingleJaccard('a', '')).toBe(0);
    expect(shingleJaccard('short text', 'short text', 5)).toBe(1);
  });
});

describe('paragraphsOf', () => {
  it('keeps body paragraphs, drops greetings and sign-offs', () => {
    const text = 'Dear Sirs,\n\nWe write further to our payment pack and ask that you settle the outstanding hire charges without further delay please.\n\nKind regards,\nClaims Team';
    expect(paragraphsOf(text)).toEqual(['We write further to our payment pack and ask that you settle the outstanding hire charges without further delay please.']);
  });
});

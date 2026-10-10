import { describe, expect, it } from 'vitest';
import { amountRange, buildClaimDictionary, containsPii, egressGuard, perimeterTopic, scrubForResearch } from './scrub.js';

const dict = buildClaimDictionary({ name: ['Jane Testperson', 'Mr Quentin Exampleby'], vrm: ['ZZ99 ZZZ'], claim_ref: ['CCG-2026-00042'], insurer_ref: ['TPC/778899/A'] });
const empty = buildClaimDictionary({});

describe('scrubForResearch (§7.6, KR-7)', () => {
  it('replaces dictionary names, VRMs and refs, and regex personal data', () => {
    const r = scrubForResearch('Does jane testperson (ZZ99ZZZ, ref CCG-2026-00042, their ref TPC/778899/A) need a V5C? Call 07700 900123 or jane@example.com, postcode E6 5LF, born 01/02/1980.', dict);
    expect(r.text).not.toMatch(/jane|testperson|ZZ99|00042|778899|07700|example\.com|E6 5LF|1980/i);
    expect(r.removed).toEqual(expect.arrayContaining(['name', 'vrm', 'claim_ref', 'insurer_ref', 'phone', 'email', 'postcode', 'dob']));
    expect(r.text).toContain('V5C');
  });
  it('scrubs a surname on its own and keeps insurer names and ordinary words', () => {
    const r = scrubForResearch('How does Admiral handle Exampleby\'s storage claim under Part 36?', dict);
    expect(r.text).toContain('Admiral');
    expect(r.text).toContain('Part 36');
    expect(r.text).not.toContain('Exampleby');
  });
  it('turns amounts into ranges', () => {
    expect(scrubForResearch('An offer of £1,450.00 on hire', empty).text).toBe('An offer of about £1–2k on hire');
    expect(amountRange('£250')).toBe('a few hundred pounds');
    expect(amountRange('£12k')).toBe('about £12–13k');
  });
  it('leaves a clean legal question untouched', () => {
    const q = 'What does section 148 of the Road Traffic Act 1988 say about policy conditions?';
    expect(scrubForResearch(q, dict)).toEqual({ text: q, removed: [] });
    expect(containsPii(q, dict)).toEqual([]);
  });
});

describe('egressGuard', () => {
  it('refuses queries and URLs carrying a seeded name, VRM or claim ref', () => {
    expect(egressGuard('jane testperson credit hire', dict)).toEqual({ ok: false, kinds: ['name'] });
    expect(egressGuard('https://www.gov.uk/search?q=ZZ99+ZZZ', dict)).toMatchObject({ ok: false });
    expect(egressGuard('https://www.gov.uk/api/search.json?q=Jane%20Testperson', dict)).toMatchObject({ ok: false, kinds: ['name'] });
    expect(egressGuard('CCG-2026-00042 storage', dict)).toMatchObject({ ok: false });
  });
  it('allows official URLs and ordinary queries (amounts alone are not personal)', () => {
    expect(egressGuard('https://www.legislation.gov.uk/ukpga/1988/52/section/148/data.xml', dict)).toEqual({ ok: true });
    expect(egressGuard('credit hire rates storage charges', dict)).toEqual({ ok: true });
    expect(egressGuard('storage charges over £1500', dict)).toEqual({ ok: true });
  });
});

describe('perimeterTopic (§7.1 triage)', () => {
  it('sends injury out, regulated advice to the owner, FOS to Fixmyfile', () => {
    expect(perimeterTopic('How are whiplash claims valued?')).toBe('injury');
    expect(perimeterTopic('Should the client sue the insurer for the balance?')).toBe('regulated_advice');
    expect(perimeterTopic('What does the Financial Ombudsman say about delays?')).toBe('fos');
    expect(perimeterTopic('Which documents does an insurer need for a storage claim?')).toBeNull();
  });
});

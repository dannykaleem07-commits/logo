// owned by knowledge-learners
import { describe, expect, it } from 'vitest';
import { categoriseCorrection, clusterKeyOf, diffStats, recurringEdits, tokenDiff, type DiffOp } from './textDiff.js';

const rebuild = (ops: DiffOp[], side: 'before' | 'after'): string =>
  ops
    .filter((o) => o.op === 'eq' || (side === 'before' ? o.op === 'del' : o.op === 'ins'))
    .map((o) => o.text)
    .join(' ');

describe('tokenDiff (Myers over words)', () => {
  it('reconstructs both sides and is minimal on a simple edit', () => {
    const before = 'I hope this email finds you well. Please find attached our invoice.';
    const after = 'Please find attached our invoice for hire.';
    const ops = tokenDiff(before, after);
    expect(rebuild(ops, 'before')).toBe(before);
    expect(rebuild(ops, 'after')).toBe(after);
    expect(ops[0]).toEqual({ op: 'del', text: 'I hope this email finds you well.' });
    expect(ops.slice(-2)).toEqual([{ op: 'del', text: 'invoice.' }, { op: 'ins', text: 'invoice for hire.' }]);
  });

  it('is deterministic and handles empty sides', () => {
    expect(tokenDiff('a b c', 'a x c')).toEqual(tokenDiff('a b c', 'a x c'));
    expect(tokenDiff('', 'new text')).toEqual([{ op: 'ins', text: 'new text' }]);
    expect(tokenDiff('old text', '')).toEqual([{ op: 'del', text: 'old text' }]);
    expect(tokenDiff('', '')).toEqual([]);
    expect(tokenDiff('same  words\nhere', 'same words here')).toEqual([{ op: 'eq', text: 'same words here' }]);
  });

  it('random pairs always reconstruct (property check, fixed seed)', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const vocab = ['a', 'b', 'c', 'd', 'e'];
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 12) }, () => vocab[Math.floor(rnd() * 5)]).join(' ');
      const b = Array.from({ length: Math.floor(rnd() * 12) }, () => vocab[Math.floor(rnd() * 5)]).join(' ');
      const ops = tokenDiff(a, b);
      expect(rebuild(ops, 'before')).toBe(a);
      expect(rebuild(ops, 'after')).toBe(b);
    }
  });

  it('diffStats counts words and the changed share', () => {
    expect(diffStats([{ op: 'eq', text: 'a b' }, { op: 'del', text: 'c' }, { op: 'ins', text: 'd e' }])).toEqual({ inserted: 2, deleted: 1, changedRatio: 0.429 });
    expect(diffStats([])).toEqual({ inserted: 0, deleted: 0, changedRatio: 0 });
  });
});

describe('categoriseCorrection', () => {
  it('names the kinds of edit in a fixed order', () => {
    const before = 'Dear Sir, we claim £1,200 for hire. Kind regards';
    const after = 'Dear Sirs, we claim £1,250 for hire under the GTA. Regards';
    const cats = categoriseCorrection(before, after, tokenDiff(before, after));
    expect(cats).toEqual(['figures', 'greeting_signoff', 'legal_terms']);
  });
  it('spots placeholders, recipients, attachments, structure and length', () => {
    const before = 'Please see [amount] attached.';
    const after = 'Please see the enclosed invoice sent to claims@example-insurer.test.\n\nWe look forward to hearing from you and to prompt payment of the balance.';
    const cats = categoriseCorrection(before, after, tokenDiff(before, after));
    for (const c of ['placeholders', 'recipient', 'attachments', 'structure', 'length'] as const) expect(cats).toContain(c);
  });
});

describe('clustering', () => {
  it('cluster keys ignore the insurer unless the edit is insurer-specific', () => {
    const base = { agent: 'drafter', templateId: null, emailKind: 'chaser', categories: ['greeting_signoff' as const], recurringEdits: [] };
    expect(clusterKeyOf({ ...base, insurerSlug: 'a' })).toBe(clusterKeyOf({ ...base, insurerSlug: 'b' }));
    expect(clusterKeyOf({ ...base, insurerSlug: 'a' })).toBe('corr:drafter:chaser:greeting_signoff');
    expect(clusterKeyOf({ ...base, categories: ['facts'], insurerSlug: 'a' })).toBe('corr:drafter:chaser:facts:a');
    expect(clusterKeyOf({ ...base, insurerSlug: null, recurringEdits: ['I hope this email finds you well.'] })).toMatch(/^corr:drafter:chaser:greeting_signoff:[0-9a-f]{8}$/);
  });

  it('recurringEdits counts each correction once and keeps those with enough support', () => {
    const c = (b: string, a: string) => ({ ops: tokenDiff(b, a) });
    const list = [
      c('I hope this email finds you well. Please pay.', 'Please pay.'),
      c('I hope this email finds you well. Please pay now.', 'Please pay now.'),
      c('I hope this email finds you well! We await payment.', 'We await payment.'),
      c('Please pay.', 'Please pay promptly.'),
    ];
    const r = recurringEdits(list, 3);
    expect(r).toEqual([{ phrase: 'i hope this email finds you well', op: 'del', support: 3 }]);
    expect(recurringEdits(list, 1).length).toBeGreaterThan(1);
  });
});

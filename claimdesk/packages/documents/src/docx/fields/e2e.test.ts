import { describe, expect, it } from 'vitest';
import { fillDocx } from '../fill.js';
import { docxToPlainText } from '../preview.js';
import { scanDocx } from '../scan.js';
import { BUILTIN_DOCX_TEMPLATES, builtinAssetBytes, builtinMapping } from './builtin/index.js';
import { buildFillPlan } from './plan.js';
import { sampleMergeSource, type MergeSource } from './source.js';
import type { PlanInputs } from './types.js';

const NOW = new Date('2026-10-04T08:30:00Z');

function sourceFor(id: string): MergeSource {
  const s = sampleMergeSource();
  if (id === 'statement.ccguk_04_witness') s.witness = s.claimant; // the client giving their own statement
  if (id === 'form.ccguk_05_payment_direction') s.company = { ...s.company, bank: { accountName: 'Courtesy Cars Group UK Ltd', bankName: 'Test Bank (fixture)', sortCode: '040605', accountNumber: '00000000' } };
  return s;
}

const INPUTS: Record<string, PlanInputs> = {
  'statement.ccguk_04_witness': { values: { 'title/relationship-to-claimant': 'The claimant', 'title/paragraphs': ['I was driving my car on London Road.', 'The Ford hit the back of my car.'] } },
  'letter.ccguk_letterhead_formal': { values: { 'title/subject-of-this-letter': 'Credit hire charges', 'title/paragraphs': ['We enclose our invoice.', 'Please pay within 14 days.'] } }
};

describe.each(BUILTIN_DOCX_TEMPLATES.map((t) => [t.id, t] as const))('end to end: %s', (id, t) => {
  const variants = t.variants.length ? t.variants.map((v) => v.id) : [undefined];
  it.each(variants)('variant %s: plan → fillDocx → text carries the reference and the client, no doubled prefix, auto brackets filled, signatures untouched', (variant) => {
    const bytes = builtinAssetBytes(id);
    const scan = scanDocx(bytes);
    const mapping = builtinMapping(id);
    const src = sourceFor(id);
    const plan = buildFillPlan(scan, mapping, src, { ...(INPUTS[id] ?? {}), ...(variant ? { variant } : {}) });
    expect(plan.issues.filter((i) => i.severity === 'block')).toEqual([]);
    const { docx, report } = fillDocx(bytes, plan.instructions, {
      removeBlocks: plan.removeBlocks,
      coreProps: { title: `${t.title} — CCG-2026-00012`, keywords: ['CCG-2026-00012', id], created: NOW, modified: NOW },
      now: NOW,
      ...(mapping.style?.valueRun ? { valueRunStyle: mapping.style.valueRun } : {})
    });
    expect(report.skipped).toEqual([]);
    const sigIds = new Set(scan.slots.filter((s) => s.signature).map((s) => s.id));
    expect(report.filled.filter((x) => sigIds.has(x))).toEqual([]);
    const text = docxToPlainText(docx);
    expect(text).toContain('CCG-2026-00012');
    expect(text).toContain('Priya Patel');
    expect(text).not.toMatch(/CCG-(HIRE-)?CCG-/);
    expect(text).not.toMatch(/\b(undefined|NaN|Invalid Date|\[object Object\])\b/);
    // Every bracket the plan filled automatically is gone (count-based: identical brackets may remain elsewhere).
    const filledAuto = plan.rows.filter((r) => r.kind === 'bracket' && (r.policy === 'auto' || r.policy === 'auto-if-known') && r.display !== '');
    for (const r of filledAuto) {
      const same = scan.slots.filter((s) => s.kind === 'bracket' && s.preview === r.preview);
      const stillThere = same.filter((s) => !plan.instructions.some((i) => i.slotId === s.id) && !plan.removeBlocks.some((b) => s.blockId?.startsWith(b))).length;
      expect(text.split(r.preview).length - 1, r.slotId).toBeLessThanOrEqual(stillThere);
    }
  });
});

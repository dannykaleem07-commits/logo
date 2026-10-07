import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTONOMY, ALWAYS_ASK_TEMPLATES, ALWAYS_ASK_EMAIL_KINDS } from '@ccguk/domain';
import { autonomyPatch, autonomyProblems, CLASS_ROWS, isAlwaysAsk, toggleApproveTemplate, toggleEmailKind, toggleSendTemplate } from './autonomy';

const AA = [...ALWAYS_ASK_TEMPLATES];
const AAK = [...ALWAYS_ASK_EMAIL_KINDS];

describe('autonomy settings helpers', () => {
  it('money, settlement and legal are read-only always-ask rows', () => {
    for (const id of ['money', 'settlement', 'legal', 'destructive']) expect(CLASS_ROWS.find((r) => r.id === id)?.editable).toBe(false);
  });

  it('always-ask entries cannot be switched on', () => {
    expect(isAlwaysAsk('invoice.hire', AA)).toBe(true);
    expect(isAlwaysAsk('letter.chaser_7', AA)).toBe(false);
    const s = toggleSendTemplate(DEFAULT_AUTONOMY, 'letter.part36_offer', true, AA);
    expect(s.autoSendTemplates).not.toContain('letter.part36_offer');
    expect(toggleEmailKind(DEFAULT_AUTONOMY, 'offer_response', true, AAK).autoSendEmailKinds).not.toContain('offer_response');
    expect(toggleApproveTemplate(DEFAULT_AUTONOMY, 'form.client_authority', true, AA).autoApproveTemplates).not.toContain('form.client_authority');
  });

  it('switching a template off for sending also stops auto-approval; approval needs sending', () => {
    const off = toggleSendTemplate(DEFAULT_AUTONOMY, 'letter.chaser_7', false, AA);
    expect(off.autoSendTemplates).not.toContain('letter.chaser_7');
    expect(off.autoApproveTemplates).not.toContain('letter.chaser_7');
    expect(toggleApproveTemplate(off, 'letter.chaser_7', true, AA).autoApproveTemplates).not.toContain('letter.chaser_7');
  });

  it('flags problems and builds a minimal patch', () => {
    expect(autonomyProblems(DEFAULT_AUTONOMY, AA, AAK)).toEqual([]);
    const bad = { ...DEFAULT_AUTONOMY, holdMinutes: 0, thresholds: { internal: 1.2, external: 0.9 }, quietHours: { start: '8pm', end: '07:30' } };
    expect(autonomyProblems(bad, AA, AAK).length).toBe(3);
    const changed = { ...DEFAULT_AUTONOMY, holdMinutes: 15, mode: 'shadow' as const };
    expect(autonomyPatch(DEFAULT_AUTONOMY, changed)).toEqual({ holdMinutes: 15, mode: 'shadow' });
  });
});

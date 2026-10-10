// owned by ap-paperwork
import { describe, expect, it } from 'vitest';
import { AUTOPILOT_STEP_IDS } from '../autopilot/types.js';
import {
  activePackItems,
  chaseAction,
  derivePackStatus,
  isDocxTemplateId,
  nextChaseAt,
  PACK_PREDICATE_IDS,
  PACK_STAGE_STEP,
  packItemKey,
  packSendGroups,
  resolvePackItems,
  STAGE_PACKS,
  type PackItem,
} from './packs.js';
import { PACK_STAGES } from './types.js';

describe('STAGE_PACKS integrity (§D.6)', () => {
  it('defines every stage, with unique item keys per stage', () => {
    expect(Object.keys(STAGE_PACKS).sort()).toEqual([...PACK_STAGES].sort());
    for (const stage of PACK_STAGES) {
      const keys = STAGE_PACKS[stage].map(packItemKey);
      expect(new Set(keys).size, stage).toBe(keys.length);
      expect(keys.length, stage).toBeGreaterThan(0);
    }
  });

  it('gives Word templates format docx and HTML templates format html', () => {
    for (const stage of PACK_STAGES) for (const item of STAGE_PACKS[stage]) expect(item.format, item.templateId).toBe(isDocxTemplateId(item.templateId) ? 'docx' : 'html');
  });

  it('names a signer for every document to sign and none for internal or insurer items', () => {
    for (const stage of PACK_STAGES)
      for (const item of STAGE_PACKS[stage]) {
        if (item.purpose === 'sign') expect(item.signer, item.templateId).toBeDefined();
        if (item.purpose === 'internal' || item.purpose === 'send_insurer') expect(item.signer, item.templateId).toBeUndefined();
      }
  });

  it('uses only listed predicate ids and maps each stage to a real step', () => {
    for (const stage of PACK_STAGES) for (const item of STAGE_PACKS[stage]) if (item.when) expect(PACK_PREDICATE_IDS as readonly string[]).toContain(item.when);
    for (const stage of PACK_STAGES) expect(AUTOPILOT_STEP_IDS as readonly string[]).toContain(PACK_STAGE_STEP[stage]);
  });

  it('carries the hire-start durable-medium set: CCGUK-03 hirer + office, Sch 3, express request, CCGUK-06 release, cover confirmation', () => {
    expect(STAGE_PACKS.hire_start.map(packItemKey)).toEqual([
      'agreement.ccguk_03_credit_hire:hirer',
      'agreement.ccguk_03_credit_hire:office',
      'form.cancellation_sch3:-',
      'form.express_request_to_start:-',
      'form.ccguk_06_handover_condition:release',
      'form.hire_cover_confirmation:-',
    ]);
  });
});

describe('resolvePackItems', () => {
  it('marks conditional items not_needed when the predicate is false, and keeps unknown predicates', () => {
    const items = resolvePackItems('billing', (p) => (p === 'storage.claimed' ? false : p === 'recovery.claimed' ? true : undefined));
    const byKey = Object.fromEntries(items.map((i) => [packItemKey(i), i.status]));
    expect(byKey['invoice.storage:-']).toBe('not_needed');
    expect(byKey['invoice.recovery:-']).toBe('pending');
    expect(byKey['invoice.engineer_fee:-']).toBe('pending');
    expect(byKey['invoice.hire:-']).toBe('pending');
    expect(activePackItems(items).length).toBe(items.length - 1);
  });
});

describe('derivePackStatus', () => {
  const base = resolvePackItems('signup', () => true);
  const all = (status: PackItem['status']): PackItem[] => base.map((i) => ({ ...i, status }));

  it('follows the slowest item', () => {
    expect(derivePackStatus('preparing', all('pending'))).toBe('preparing');
    expect(derivePackStatus('preparing', [{ ...base[0]!, status: 'reviewed' }, ...all('drafted').slice(1)])).toBe('reviewing');
    expect(derivePackStatus('reviewing', all('reviewed'))).toBe('awaiting_approval');
    expect(derivePackStatus('awaiting_approval', all('approved'))).toBe('approved');
    expect(derivePackStatus('approved', all('sent'))).toBe('sent');
    expect(derivePackStatus('sent', all('signed'))).toBe('signed');
  });

  it('never moves a superseded or cancelled pack, and ignores not_needed items', () => {
    expect(derivePackStatus('superseded', all('signed'))).toBe('superseded');
    expect(derivePackStatus('cancelled', all('approved'))).toBe('cancelled');
    const items = [...all('reviewed').slice(0, 2), { ...base[2]!, status: 'not_needed' as const }];
    expect(derivePackStatus('reviewing', items)).toBe('awaiting_approval');
  });

  it('is signed only when every document to sign is signed', () => {
    const items = resolvePackItems('hire_start', () => true).map((i) => ({ ...i, status: (i.purpose === 'sign' ? 'signed' : 'sent') as PackItem['status'] }));
    expect(derivePackStatus('sent', items)).toBe('signed');
    items[0] = { ...items[0]!, status: 'sent' };
    expect(derivePackStatus('sent', items)).toBe('sent');
  });
});

describe('packSendGroups', () => {
  it('sends sign/give items to the client, insurer items to the insurer, and never internal items', () => {
    const groups = packSendGroups(resolvePackItems('payment', () => true));
    expect(groups.map((g) => g.target)).toEqual(['client', 'at_fault_insurer']);
    expect(groups[0]!.items.map((i) => i.templateId)).toEqual(['statement.ccguk_04_witness']);
    expect(groups[1]!.items.map((i) => i.templateId)).toEqual(['letter.ccguk_letterhead_formal', 'pack.gta_payment', 'schedule.loss']);
    const hire = packSendGroups(resolvePackItems('hire_start', () => true));
    expect(hire).toHaveLength(1);
    expect(hire[0]!.items.some((i) => i.variant === 'office')).toBe(false);
  });
});

describe('wet-signature chase schedule (§E.4)', () => {
  const sentAt = '2026-10-01T09:00:00.000Z';

  it('chases after 2 and 5 days and asks for a call after 7', () => {
    expect(nextChaseAt(sentAt, 0)).toBe('2026-10-03T09:00:00.000Z');
    expect(nextChaseAt(sentAt, 1)).toBe('2026-10-06T09:00:00.000Z');
    expect(nextChaseAt(sentAt, 2)).toBe('2026-10-08T09:00:00.000Z');
    expect(nextChaseAt(sentAt, 3)).toBeUndefined();
  });

  it('decides chase / call / wait / none', () => {
    expect(chaseAction({ status: 'sent', sentAt, chaseCount: 0 }, '2026-10-02T09:00:00.000Z')).toEqual({ action: 'wait', until: '2026-10-03T09:00:00.000Z' });
    expect(chaseAction({ status: 'sent', sentAt, chaseCount: 0 }, '2026-10-03T09:15:00.000Z')).toEqual({ action: 'chase', chaseNumber: 1 });
    expect(chaseAction({ status: 'chased', sentAt, chaseCount: 1 }, '2026-10-06T09:15:00.000Z')).toEqual({ action: 'chase', chaseNumber: 2 });
    expect(chaseAction({ status: 'chased', sentAt, chaseCount: 2 }, '2026-10-08T09:15:00.000Z')).toEqual({ action: 'call' });
    expect(chaseAction({ status: 'chased', sentAt, chaseCount: 3 }, '2026-10-20T09:15:00.000Z')).toEqual({ action: 'none' });
    expect(chaseAction({ status: 'signed', sentAt, chaseCount: 0 }, '2026-10-20T09:15:00.000Z')).toEqual({ action: 'none' });
    expect(chaseAction({ status: 'returned', sentAt, chaseCount: 1 }, '2026-10-20T09:15:00.000Z')).toEqual({ action: 'none' });
    expect(chaseAction({ status: 'prepared', sentAt: null, chaseCount: 0 }, '2026-10-20T09:15:00.000Z')).toEqual({ action: 'none' });
  });

  it('honours a custom schedule from Settings', () => {
    expect(chaseAction({ status: 'sent', sentAt, chaseCount: 0 }, '2026-10-02T09:15:00.000Z', { chaseAfterDays: [1], callAfterDays: 3 })).toEqual({ action: 'chase', chaseNumber: 1 });
    expect(chaseAction({ status: 'chased', sentAt, chaseCount: 1 }, '2026-10-04T09:15:00.000Z', { chaseAfterDays: [1], callAfterDays: 3 })).toEqual({ action: 'call' });
  });
});

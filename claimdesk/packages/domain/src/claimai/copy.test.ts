// owned by claimai-server
/** Every server-side sentence template is free of accusation words and banned phrases (docs/CLAIM-AI-INPUT.md §3.9). */
import { describe, expect, it } from 'vitest';
import { BANNED_PHRASES } from '../consistency/index.js';
import { BANNED_INTAKE_WORDS } from '../intake/smart/types.js';
import { ACTION_TYPES } from './types.js';
import { COPY, EVENT_LABEL, JOB_KIND_LABEL, STATUS_LABEL, TASK_KIND_LABEL, WAITING_LABEL, actionTitle, fieldLabel } from './copy.js';
import { TIER_LABEL } from './tiers.js';
import { CORRESPONDENCE_KIND_LABEL } from './outbound.js';
import { AGENT_SCOPE_LABEL, CONTACT_LABEL } from './instructions.js';

const ADVICE = /\b(you should (accept|reject)|we recommend (accepting|rejecting)|good offer|bad offer)\b/i;

function strings(): string[] {
  const out: string[] = [];
  for (const v of Object.values(COPY)) out.push(typeof v === 'function' ? (v as (...a: string[]) => string)('X', 'Y') : v);
  for (const t of ACTION_TYPES) out.push(actionTitle(t, { amountPence: 100, eventType: 'call', at: '2026-10-12T09:00:00.000Z', text: 't', summary: 's', jobKind: 'chase', recipient: 'client', status: 'repair', current: 'triage', value: 'admitted', target: 'claim.atFaultInsurerRef' }));
  for (const m of [EVENT_LABEL, JOB_KIND_LABEL, STATUS_LABEL, TASK_KIND_LABEL, WAITING_LABEL, TIER_LABEL, CORRESPONDENCE_KIND_LABEL, AGENT_SCOPE_LABEL, CONTACT_LABEL]) out.push(...Object.values(m));
  return out;
}

describe('copy', () => {
  it('no accusation words, no banned phrases, no offer advice', () => {
    const all = strings();
    expect(all.length).toBeGreaterThan(80);
    for (const s of all) {
      expect(BANNED_INTAKE_WORDS.test(s), s).toBe(false);
      for (const p of BANNED_PHRASES) expect(s.toLowerCase().includes(p.toLowerCase()), s).toBe(false);
      expect(ADVICE.test(s), s).toBe(false);
    }
  });
  it('every action type has a title', () => {
    for (const t of ACTION_TYPES) expect(actionTitle(t, {}).length, t).toBeGreaterThan(3);
  });
});

describe('fieldLabel', () => {
  it('plain words for every target shape', () => {
    expect(fieldLabel('claim.atFaultInsurerRef')).toBe('Their reference');
    expect(fieldLabel('vehicle:client.make')).toBe('Client’s car make');
    expect(fieldLabel('vehicle:client.firstRegistered')).toBe('Client’s first registration');
    expect(fieldLabel('vehicle:third_party.registration')).toBe('Their registration');
    expect(fieldLabel('party:driver.dateOfBirth')).toBe('Driver’s date of birth');
  });
});

describe('field values in titles', () => {
  it('a stored ISO date or date-time reads as a London date, other values unchanged', () => {
    expect(actionTitle('field_update', { target: 'claim.accident.occurredAt', current: '2026-09-27T20:10:00.000Z', value: '2026-09-28' })).toBe(
      'Accident date: Sun 27 Sep 2026 21:10 → Mon 28 Sep 2026',
    );
    expect(actionTitle('field_update', { target: 'claim.atFaultInsurerRef', current: 'TPI/778812', value: 'AB123' })).toBe('Their reference: TPI/778812 → AB123');
  });
});

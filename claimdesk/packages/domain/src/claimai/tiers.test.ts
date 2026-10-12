// owned by claimai-server
/** Perimeter invariants (docs/CLAIM-AI-INPUT.md §3.4): code assigns tiers; money / settlement / legal never apply. */
import { describe, expect, it } from 'vitest';
import { ACTION_CLASS, DEFAULT_TIER, DEFAULT_TIER_CONTEXT, TIER_LABEL, tierFor, type TierContext } from './tiers.js';
import { ACTION_TYPES, AI_ACTION_TYPES, CLAIM_AI_FORBIDDEN_STATUSES, type ActionParams, type ActionType } from './types.js';

const contexts: TierContext[] = [];
for (const from of ['owner_text', 'transcript', 'document'] as const)
  for (const overwrites of [false, true])
    for (const sensitive of [false, true])
      for (const quoteVerified of [null, true, false])
        for (const confidence of [0.2, 0.75, 1])
          for (const datedInFuture of [false, true])
            contexts.push({ ...DEFAULT_TIER_CONTEXT, from, overwrites, sensitive, quoteVerified, confidence, datedInFuture, validatorOk: !overwrites || !sensitive });

const paramsFor = (t: ActionType): ActionParams[] => [
  {},
  { eventType: 'total_loss_confirmed' },
  { status: 'settled' },
  { status: 'repair' },
  { amountPence: 1000 },
  { jobKind: 'chase', recipient: 'client' },
  { text: 'call the client weekly' },
  t === 'field_update' ? { target: 'claim.atFaultInsurerRef', value: 'AB1', current: 'TPI/1' } : {},
];

describe('tierFor', () => {
  it('the tables cover every action type and AI types exclude the catch-up-only ones', () => {
    for (const t of ACTION_TYPES) {
      expect(ACTION_CLASS[t], t).toBeDefined();
      expect(DEFAULT_TIER[t], t).toBeDefined();
    }
    expect(AI_ACTION_TYPES).not.toContain('file_evidence');
    expect(AI_ACTION_TYPES).not.toContain('record_correspondence');
    expect(AI_ACTION_TYPES).not.toContain('unsupported');
    expect(TIER_LABEL.confirm).toBe('Needs your tick');
  });

  it('no money / settlement / legal type ever produces apply', () => {
    for (const t of ACTION_TYPES.filter((x) => ['money', 'settlement', 'legal'].includes(ACTION_CLASS[x])))
      for (const p of paramsFor(t)) for (const c of contexts) expect(tierFor(t, p, c).tier, `${t} ${JSON.stringify(c)}`).not.toBe('apply');
    expect(tierFor('offer_received', { amountPence: 1 }, DEFAULT_TIER_CONTEXT).tier).toBe('confirm');
    expect(tierFor('money', { amountPence: 1 }, DEFAULT_TIER_CONTEXT)).toMatchObject({ tier: 'needs_you', ticked: true, tickable: true });
  });

  it('no FORBIDDEN_STATUSES target can produce anything but needs_you', () => {
    for (const status of CLAIM_AI_FORBIDDEN_STATUSES) for (const c of contexts.filter((x) => x.from !== 'transcript')) expect(tierFor('status_change', { status }, c).tier).toBe('needs_you');
    expect(tierFor('status_change', { status: 'repair' }, DEFAULT_TIER_CONTEXT).tier).toBe('confirm');
  });

  it('transcript actions never exceed confirm and only facts are allowed', () => {
    for (const t of ACTION_TYPES)
      for (const p of paramsFor(t))
        for (const c of contexts.filter((x) => x.from === 'transcript')) {
          const r = tierFor(t, p, c);
          expect(r.tier, `${t}`).not.toBe('apply');
          if (!['event', 'note', 'field_update', 'private_note', 'unsupported'].includes(t)) expect(r.tier, t).toBe('refused');
        }
  });

  it('overwrites, sensitive values, invalid values, low confidence and unverified quotes → confirm', () => {
    const base = { target: 'claim.atFaultInsurerRef', value: 'AB1', current: 'TPI/1' };
    expect(tierFor('field_update', base, { ...DEFAULT_TIER_CONTEXT, overwrites: true })).toMatchObject({ tier: 'confirm', ticked: false, tickable: true, why: 'On file: TPI/1 — tick to replace' });
    expect(tierFor('field_update', base, { ...DEFAULT_TIER_CONTEXT, sensitive: true }).tier).toBe('confirm');
    expect(tierFor('field_update', base, { ...DEFAULT_TIER_CONTEXT, validatorOk: false }).tier).toBe('confirm');
    expect(tierFor('event', { eventType: 'call' }, { ...DEFAULT_TIER_CONTEXT, confidence: 0.5 }).tier).toBe('confirm');
    expect(tierFor('event', { eventType: 'call' }, { ...DEFAULT_TIER_CONTEXT, quoteVerified: false }).tier).toBe('confirm');
    expect(tierFor('event', { eventType: 'call' }, DEFAULT_TIER_CONTEXT)).toMatchObject({ tier: 'apply', ticked: true });
    expect(tierFor('liability_position', { value: 'admitted' }, DEFAULT_TIER_CONTEXT).tier).toBe('confirm');
    expect(tierFor('hire_correct', {}, DEFAULT_TIER_CONTEXT).tier).toBe('confirm');
    expect(tierFor('event', { eventType: 'total_loss_confirmed' }, DEFAULT_TIER_CONTEXT).tier).toBe('confirm');
  });

  it('accusation words → private; a held contact refuses a job; no running hire refuses hire_end; hire_start opens the screen', () => {
    expect(tierFor('instruction', { text: 'the client is lying' }, DEFAULT_TIER_CONTEXT)).toMatchObject({ tier: 'private', ticked: false, tickable: false });
    expect(tierFor('note', { summary: 'looks like a scam' }, DEFAULT_TIER_CONTEXT).tier).toBe('private');
    expect(tierFor('run_job', { jobKind: 'chase' }, { ...DEFAULT_TIER_CONTEXT, holdBlocks: "Don't chase the client" })).toMatchObject({ tier: 'refused', why: "You asked: Don't chase the client" });
    expect(tierFor('hire_end', {}, { ...DEFAULT_TIER_CONTEXT, openHires: 0 }).tier).toBe('refused');
    expect(tierFor('hire_start', {}, DEFAULT_TIER_CONTEXT)).toMatchObject({ tier: 'open_screen', ticked: false, tickable: false });
    expect(tierFor('unsupported', { reason: 'x' }, DEFAULT_TIER_CONTEXT)).toMatchObject({ tier: 'refused', why: 'x' });
  });
});

// owned by ap-foundation
/** Autopilot contracts (docs/SUPREME-AUTOPILOT.md §A.2, §A.11, §C.1, §F.2, §H.1, §0.6). */
import { describe, expect, it } from 'vitest';
import { AUTOPILOT_JOB_TYPES, AUTOPILOT_NEEDS_YOU_KINDS, AGENT_NAMES, EMAIL_KINDS, JOB_TYPE_INFO, NEEDS_YOU_KINDS } from '../agents/types.js';
import { AI_JOB_DEFAULTS } from '../agents/settings.js';
import { RESULT_SCHEMAS, strictSchemaProblems } from '../agents/results.js';
import { DEFAULT_AUTONOMY } from '../autonomy/settings.js';
import { CLASH_CODES } from '../clash/types.js';
import { detectClashes } from '../clash/detect.js';
import { DEFAULT_DRIVER_CRITERIA } from '../eligibility/types.js';
import { assessDriver } from '../eligibility/driver.js';
import { BLOCKING_RESERVATION_STATUSES, DEFAULT_RANKING_WEIGHTS, RESERVATION_STATUSES, RESERVATION_TRANSITIONS } from '../booking/types.js';
import { OVERRIDE_RULES } from '../override/codes.js';
import { AUTOPILOT_STEP_IDS, STAGE_ORDER, STEP_MODE_RANK, stricterMode } from './types.js';
import { DEFAULT_AUTOPILOT_SETTINGS, STEP_FLOORS, autopilotSettingsProblems, configuredStepMode, mergeAutopilotSettings } from './settings.js';

describe('autopilot vocabulary', () => {
  it('has the 14 stages and the 46 steps of §A.3, unique', () => {
    expect(STAGE_ORDER).toHaveLength(14);
    expect(AUTOPILOT_STEP_IDS).toHaveLength(46);
    expect(new Set(AUTOPILOT_STEP_IDS).size).toBe(46);
    expect(Object.keys(STEP_FLOORS).sort()).toEqual([...AUTOPILOT_STEP_IDS].sort());
  });
  it('orders modes auto < confirm < owner', () => {
    expect(STEP_MODE_RANK.auto).toBeLessThan(STEP_MODE_RANK.confirm);
    expect(STEP_MODE_RANK.confirm).toBeLessThan(STEP_MODE_RANK.owner);
    expect(stricterMode('auto', 'confirm')).toBe('confirm');
    expect(stricterMode('owner', 'confirm')).toBe('owner');
  });
  it('keeps people on the physical, signing, money and closing steps (perimeter floors)', () => {
    for (const id of ['hire.handover', 'hire.return', 'signup.signed', 'qualify.decline', 'close.readiness', 'money.offer', 'money.client_payout'] as const) expect(STEP_FLOORS[id]).toBe('owner');
    for (const id of ['signup.pack', 'hire.pack', 'money.invoices', 'money.payment_pack', 'money.payment', 'notify.intervention'] as const) expect(STEP_FLOORS[id]).toBe('confirm');
  });
});

describe('autopilot settings', () => {
  it('defaults match §A.11 / §L', () => {
    expect(DEFAULT_AUTOPILOT_SETTINGS).toMatchObject({ enabled: true, newClaims: 'on', maxActionsPerTick: 5, loopGuard: { repeats: 3, hours: 24 } });
    expect(DEFAULT_AUTOPILOT_SETTINGS.booking.holdHours).toBe(24);
    expect(DEFAULT_AUTOPILOT_SETTINGS.green).toEqual({ minLikeForLike: 0.8, clearWinnerGap: 8, maxAutoOffersPerDay: 10, protectiveHold: true });
    expect(DEFAULT_RANKING_WEIGHTS).toEqual({ likeForLike: 35, needsFit: 15, readiness: 15, compliance: 10, cost: 20, location: 5 });
    expect(Object.values(DEFAULT_RANKING_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
  it('merges stored JSON over the defaults and raises modes below a floor', () => {
    const s = mergeAutopilotSettings({ booking: { holdHours: 12 }, stepModes: { 'hire.handover': 'auto', 'hire.offer': 'confirm', 'not.a.step': 'auto' } });
    expect(s.booking.holdHours).toBe(12);
    expect(s.booking.offerReminderHours).toBe(4);
    expect(s.stepModes).toEqual({ 'hire.handover': 'owner', 'hire.offer': 'confirm' });
    expect(mergeAutopilotSettings(undefined)).toEqual(DEFAULT_AUTOPILOT_SETTINGS);
    expect(configuredStepMode(s, 'hire.offer', 'auto')).toBe('confirm');
    expect(configuredStepMode(s, 'money.invoices', 'auto')).toBe('confirm');
  });
  it('reports modes below a floor, unknown steps and unknown modes (PATCH refuses them)', () => {
    expect(autopilotSettingsProblems({ stepModes: { 'hire.pack': 'auto' } })[0]).toMatch(/hire\.pack cannot be set to auto: Agreements and forms always need you/);
    expect(autopilotSettingsProblems({ stepModes: { 'money.offer': 'confirm' } })[0]).toMatch(/Money and offers always need you/);
    expect(autopilotSettingsProblems({ stepModes: { 'x.y': 'auto' } })).toEqual(['Unknown autopilot step x.y']);
    expect(autopilotSettingsProblems({ stepModes: { 'hire.offer': 'sometimes' } })).toEqual(['hire.offer: unknown mode sometimes']);
    expect(autopilotSettingsProblems({ stepModes: { 'hire.offer': 'confirm', 'hire.pack': 'owner' } })).toEqual([]);
  });
});

describe('booking, clash and eligibility contracts', () => {
  it('reservation transitions only name known statuses; terminal states go nowhere', () => {
    for (const [from, tos] of Object.entries(RESERVATION_TRANSITIONS)) {
      expect(RESERVATION_STATUSES).toContain(from);
      for (const to of tos) expect(RESERVATION_STATUSES).toContain(to);
    }
    expect(RESERVATION_TRANSITIONS.returned).toEqual([]);
    expect(BLOCKING_RESERVATION_STATUSES).toEqual(['held', 'confirmed', 'on_hire', 'returned']);
  });
  it('lists the 44 clash codes of §C.2 once each; every new override code is registered', () => {
    expect(CLASH_CODES).toHaveLength(44);
    expect(new Set(CLASH_CODES).size).toBe(44);
    for (const code of ['UNIT_NOT_READY', 'POLICY_ENDS_IN_PERIOD', 'SAME_REG_ON_HIRE', 'DUPLICATE_CLAIM_OPEN', 'CLAIM_SECOND_HIRE', 'HIRER_ON_OTHER_HIRE', 'DRIVER_REFERRAL', 'LICENCE_CHECK_STALE', 'ACCEPTANCE_CONDITIONS_UNMET', 'SIGNATURES_MISSING'])
      expect(OVERRIDE_RULES[code]?.class, code).toBe('A');
    expect(OVERRIDE_RULES.HIRE_BEFORE_ACCIDENT?.class).toBe('B');
  });
  it('the driver criteria defaults follow §F.2', () => {
    expect(DEFAULT_DRIVER_CRITERIA).toMatchObject({ minAge: 21, referBelowAge: 25, referAboveAge: 75, maxAge: 79, maxPointsEligible: 6, maxPointsRefer: 9, provisionalAllowed: false, requireDvlaCheckWithinDays: 14 });
    expect(DEFAULT_DRIVER_CRITERIA.excludedEndorsementPrefixes).toContain('DR');
    expect(DEFAULT_DRIVER_CRITERIA.referEndorsementPrefixes).toEqual(['CD1', 'CD2', 'CD3', 'MS']);
  });
  it('stubs are safe until their slices land: no findings, drivers unknown', () => {
    expect(detectClashes({ kind: 'claim', claimId: 'c1' }, { claims: [], vehicles: [], parties: [], driverProfiles: [], fleetUnits: [], policies: [], reservations: [], hires: [], readiness: [], damage: [], penalties: [], eventsByClaim: {}, acceptanceByClaim: {}, interventionOffers: [], signedPackByReservation: {} }, { now: '2026-10-10T09:00:00.000Z', settings: DEFAULT_AUTOPILOT_SETTINGS })).toEqual([]);
    expect(assessDriver(undefined, { name: 'A Client' }, DEFAULT_DRIVER_CRITERIA, '2026-10-10').outcome).toBe('unknown');
  });
});

describe('SD contract changes (§0.6)', () => {
  it('adds the autopilot agent, 13 job types, 6 Needs-you kinds and 4 email kinds', () => {
    expect(AGENT_NAMES).toContain('autopilot');
    expect(AUTOPILOT_JOB_TYPES).toHaveLength(13);
    for (const t of AUTOPILOT_JOB_TYPES) expect(JOB_TYPE_INFO[t], t).toBeDefined();
    expect(JOB_TYPE_INFO['autopilot.judge']).toMatchObject({ lane: 'ai', usesAi: true, agent: 'case_manager' });
    expect(JOB_TYPE_INFO['autopilot.tick']).toMatchObject({ lane: 'io', usesAi: false, agent: 'autopilot', mutatesClaim: true });
    expect(AUTOPILOT_NEEDS_YOU_KINDS.every((k) => NEEDS_YOU_KINDS.includes(k))).toBe(true);
    for (const k of ['hire_offer', 'booking_update', 'signature_request', 'insurer_notice'] as const) expect(EMAIL_KINDS).toContain(k);
    expect(AI_JOB_DEFAULTS['autopilot.judge']).toMatchObject({ agent: 'case_manager', model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 6, timeoutMs: 300_000 });
    expect(AI_JOB_DEFAULTS['hire_offer.parse_reply']).toMatchObject({ agent: 'mail', effort: 'low', maxTurns: 1, timeoutMs: 120_000 });
  });
  it('autonomy defaults: 6 sends per claim per day; booking_update / insurer_notice / hire_offer and the three letters auto-send', () => {
    expect(DEFAULT_AUTONOMY.limits.perClaimPerDay).toBe(6);
    expect(DEFAULT_AUTONOMY.autoSendEmailKinds).toEqual(expect.arrayContaining(['booking_update', 'insurer_notice', 'hire_offer']));
    expect(DEFAULT_AUTONOMY.autoSendTemplates).toEqual(expect.arrayContaining(['letter.hire_start_notice', 'letter.booking_confirmation', 'letter.signature_chase']));
    expect(DEFAULT_AUTONOMY.autoSendEmailKinds).not.toContain('signature_request');
  });
  it('the judge and reply result schemas are strict', () => {
    expect(strictSchemaProblems(RESULT_SCHEMAS.autopilot_judge)).toEqual([]);
    expect(strictSchemaProblems(RESULT_SCHEMAS.hire_reply)).toEqual([]);
  });
});

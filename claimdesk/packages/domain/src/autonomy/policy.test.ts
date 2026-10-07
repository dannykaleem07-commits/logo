import { describe, expect, it } from 'vitest';
import type { ActionClass } from '../agents/types.js';
import { AUTONOMY_RULE_IDS, decide, inQuietHours, minutesUntil, type ActionDescriptor, type AutonomyState } from './policy.js';
import { ALWAYS_ASK_EMAIL_KINDS, ALWAYS_ASK_TEMPLATES, DEFAULT_AUTONOMY, isAlwaysAskTemplate, mayAutoApproveTemplate, type AutonomySettings } from './settings.js';

const S: AutonomySettings = DEFAULT_AUTONOMY;
const ST: AutonomyState = { killSwitch: false, agentPaused: false, claimPaused: false, sends: { claimToday: 0, lastHour: 0, today: 0 }, nowLocal: '10:00' };

/** An external send that passes every check → external_ok. */
const SEND: ActionDescriptor = {
  class: 'external_send',
  kind: 'email.chaser',
  claimId: 'c1',
  emailKind: 'chaser',
  recipient: { address: 'handler@insurer.example', role: 'at_fault_insurer', verified: true, firstContact: false, onClaim: true },
  confidence: 0.95,
  review: { verdict: 'pass', touches: { money: false, liability: false, settlement: false, legal: false, newCommitment: false } },
  consistencyBlocked: false,
  missingInfo: false,
  attachmentsAllowed: true,
};
const INTERNAL: ActionDescriptor = { class: 'internal', kind: 'field.vehicle.vin', claimId: 'c1', confidence: 0.95 };
const d = (a: Partial<ActionDescriptor>, s: Partial<AutonomySettings> = {}, st: Partial<AutonomyState> = {}) => decide({ ...SEND, ...a }, { ...S, ...s }, { ...ST, ...st });
const di = (a: Partial<ActionDescriptor>, s: Partial<AutonomySettings> = {}, st: Partial<AutonomyState> = {}) => decide({ ...INTERNAL, ...a }, { ...S, ...s }, { ...ST, ...st });

describe('decide() — one test per rule (§D.2)', () => {
  it('1 destructive → deny', () => {
    expect(d({ class: 'destructive' })).toMatchObject({ outcome: 'deny', ruleIds: ['destructive'] });
  });
  it('2 kill_switch → deny for non read/draft', () => {
    expect(d({}, {}, { killSwitch: true })).toMatchObject({ outcome: 'deny', ruleIds: ['kill_switch'] });
    expect(di({}, { killSwitch: true })).toMatchObject({ outcome: 'deny', ruleIds: ['kill_switch'] });
  });
  it('3 paused (agent or claim) → ask', () => {
    expect(d({}, {}, { agentPaused: true })).toMatchObject({ outcome: 'ask', ruleIds: ['paused'] });
    expect(di({}, {}, { claimPaused: true })).toMatchObject({ outcome: 'ask', ruleIds: ['paused'] });
  });
  it('4 untrusted_source → ask', () => {
    expect(d({ injectionSuspected: true })).toMatchObject({ outcome: 'ask', ruleIds: ['untrusted_source'] });
    expect(di({ spoofSuspected: true })).toMatchObject({ outcome: 'ask', ruleIds: ['untrusted_source'] });
  });
  it('5 always_ask_classes: money, settlement, legal → ask', () => {
    for (const c of ['money', 'settlement', 'legal'] as ActionClass[]) expect(d({ class: c, confidence: 1 })).toMatchObject({ outcome: 'ask', ruleIds: ['always_ask_classes'] });
  });
  it('6 shadow → ask for internal and external_send', () => {
    expect(d({}, { mode: 'shadow' })).toMatchObject({ outcome: 'ask', ruleIds: ['shadow'] });
    expect(di({}, { mode: 'shadow' })).toMatchObject({ outcome: 'ask', ruleIds: ['shadow'] });
  });
  it('7 internal_sensitive → ask when sensitive or overwriting', () => {
    expect(di({ sensitive: true })).toMatchObject({ outcome: 'ask', ruleIds: ['internal_sensitive'] });
    expect(di({ overwrites: true })).toMatchObject({ outcome: 'ask', ruleIds: ['internal_sensitive'] });
  });
  it('8 internal_confidence → ask below 0.85', () => {
    expect(di({ confidence: 0.84 })).toMatchObject({ outcome: 'ask', ruleIds: ['internal_confidence'] });
    expect(di({ confidence: Number.NaN })).toMatchObject({ outcome: 'ask', ruleIds: ['internal_confidence'] });
    expect(di({ confidence: 0.85 })).toMatchObject({ outcome: 'auto', ruleIds: ['internal_ok'] });
  });
  it('9 internal_ok → auto', () => {
    expect(di({})).toMatchObject({ outcome: 'auto', ruleIds: ['internal_ok'] });
  });
  it('10 not_reviewed → deny unless the review passed', () => {
    expect(d({ review: undefined })).toMatchObject({ outcome: 'deny', ruleIds: ['not_reviewed'] });
    expect(d({ review: { ...SEND.review!, verdict: 'repair' } })).toMatchObject({ outcome: 'deny', ruleIds: ['not_reviewed'] });
    expect(d({ review: { ...SEND.review!, verdict: 'escalate' } })).toMatchObject({ outcome: 'deny', ruleIds: ['not_reviewed'] });
  });
  it('11 consistency_blocked → deny', () => {
    expect(d({ consistencyBlocked: true })).toMatchObject({ outcome: 'deny', ruleIds: ['consistency_blocked'] });
  });
  it('12 missing_info → ask', () => {
    expect(d({ missingInfo: true })).toMatchObject({ outcome: 'ask', ruleIds: ['missing_info'] });
  });
  it('13 touches → ask when any touch is true', () => {
    for (const k of ['money', 'liability', 'settlement', 'legal', 'newCommitment'] as const) {
      expect(d({ review: { verdict: 'pass', touches: { ...SEND.review!.touches, [k]: true } } })).toMatchObject({ outcome: 'ask', ruleIds: ['touches'] });
    }
  });
  it('14 recipient → ask when unverified, first contact, not on the claim, or absent', () => {
    const r = SEND.recipient!;
    expect(d({ recipient: { ...r, verified: false } })).toMatchObject({ outcome: 'ask', ruleIds: ['recipient'] });
    expect(d({ recipient: { ...r, firstContact: true } })).toMatchObject({ outcome: 'ask', ruleIds: ['recipient'] });
    expect(d({ recipient: { ...r, onClaim: false } })).toMatchObject({ outcome: 'ask', ruleIds: ['recipient'] });
    expect(d({ recipient: undefined })).toMatchObject({ outcome: 'ask', ruleIds: ['recipient'] });
  });
  it('15 attachments → ask when an attachment is not allowed', () => {
    expect(d({ attachmentsAllowed: false })).toMatchObject({ outcome: 'ask', ruleIds: ['attachments'] });
    expect(d({ attachmentsAllowed: undefined })).toMatchObject({ outcome: 'auto_held', ruleIds: ['external_ok'] });
  });
  it('16 allowlist → ask for kinds/templates not allow-listed and for the always-ask lists', () => {
    expect(d({}, { autoSendEmailKinds: [] })).toMatchObject({ outcome: 'ask', ruleIds: ['allowlist'] });
    for (const k of ALWAYS_ASK_EMAIL_KINDS) expect(d({ emailKind: k }, { autoSendEmailKinds: [k] })).toMatchObject({ outcome: 'ask', ruleIds: ['allowlist'] });
    expect(d({ emailKind: undefined, templateId: 'letter.chaser_7' })).toMatchObject({ outcome: 'auto_held', ruleIds: ['external_ok'] });
    expect(d({ emailKind: undefined, templateId: 'letter.letter_before_claim' }, { autoSendTemplates: ['letter.letter_before_claim'] })).toMatchObject({ outcome: 'ask', ruleIds: ['allowlist'] });
    expect(d({ emailKind: undefined, templateId: 'invoice.hire' }, { autoSendTemplates: ['invoice.hire'] })).toMatchObject({ outcome: 'ask', ruleIds: ['allowlist'] });
    expect(d({ emailKind: undefined, templateId: 'letter.unknown' })).toMatchObject({ outcome: 'ask', ruleIds: ['allowlist'] });
    expect(d({ emailKind: undefined, templateId: undefined })).toMatchObject({ outcome: 'ask', ruleIds: ['allowlist'] });
    expect(d({ emailKind: 'chaser', templateId: 'statement.witness' }, { autoSendTemplates: ['statement.witness'] })).toMatchObject({ outcome: 'ask', ruleIds: ['allowlist'] });
  });
  it('17 external_confidence → ask below 0.9', () => {
    expect(d({ confidence: 0.89 })).toMatchObject({ outcome: 'ask', ruleIds: ['external_confidence'] });
    expect(d({ confidence: 0.9 })).toMatchObject({ outcome: 'auto_held', ruleIds: ['external_ok'] });
  });
  it('18 rate_limits → ask at 3 per claim per day, 20 per hour, 100 per day', () => {
    expect(d({}, {}, { sends: { claimToday: 3, lastHour: 0, today: 0 } })).toMatchObject({ outcome: 'ask', ruleIds: ['rate_limits'] });
    expect(d({}, {}, { sends: { claimToday: 0, lastHour: 20, today: 0 } })).toMatchObject({ outcome: 'ask', ruleIds: ['rate_limits'] });
    expect(d({}, {}, { sends: { claimToday: 0, lastHour: 0, today: 100 } })).toMatchObject({ outcome: 'ask', ruleIds: ['rate_limits'] });
    expect(d({}, {}, { sends: { claimToday: 2, lastHour: 19, today: 99 } })).toMatchObject({ outcome: 'auto_held', ruleIds: ['external_ok'] });
  });
  it('19 quiet_hours → auto_held until the end of quiet hours', () => {
    expect(d({}, {}, { nowLocal: '21:00' })).toMatchObject({ outcome: 'auto_held', ruleIds: ['quiet_hours'], holdUntilLocal: '07:30', holdMinutes: 630 });
    expect(d({}, {}, { nowLocal: '07:25' })).toMatchObject({ outcome: 'auto_held', ruleIds: ['quiet_hours'], holdMinutes: 10 });
    expect(d({}, {}, { nowLocal: '07:30' })).toMatchObject({ outcome: 'auto_held', ruleIds: ['external_ok'] });
    expect(d({}, { quietHours: null }, { nowLocal: '23:00' })).toMatchObject({ outcome: 'auto_held', ruleIds: ['external_ok'] });
  });
  it('20 external_ok → auto_held with holdMinutes', () => {
    expect(d({})).toEqual({ outcome: 'auto_held', holdMinutes: 10, reasons: ['Allowed: held 10 minutes for Undo'], ruleIds: ['external_ok'] });
    expect(d({}, { holdMinutes: 3 })).toMatchObject({ holdMinutes: 3 });
  });
  it('21 read_draft → auto', () => {
    expect(d({ class: 'read' })).toMatchObject({ outcome: 'auto', ruleIds: ['read_draft'] });
    expect(d({ class: 'draft' })).toMatchObject({ outcome: 'auto', ruleIds: ['read_draft'] });
  });
});

describe('decide() — ordering', () => {
  it('lists exactly 21 rule ids in order', () => {
    expect(AUTONOMY_RULE_IDS).toHaveLength(21);
    expect(AUTONOMY_RULE_IDS[0]).toBe('destructive');
    expect(AUTONOMY_RULE_IDS[20]).toBe('read_draft');
  });
  it('destructive wins over the kill switch', () => {
    expect(d({ class: 'destructive' }, {}, { killSwitch: true })).toMatchObject({ ruleIds: ['destructive'] });
  });
  it('the kill switch wins over pauses and untrusted sources; read/draft are never stopped', () => {
    expect(d({ injectionSuspected: true }, {}, { killSwitch: true, agentPaused: true })).toMatchObject({ outcome: 'deny', ruleIds: ['kill_switch'] });
    expect(d({ class: 'read' }, {}, { killSwitch: true, claimPaused: true })).toMatchObject({ outcome: 'auto', ruleIds: ['read_draft'] });
    expect(d({ class: 'draft', injectionSuspected: true }, {}, { agentPaused: true })).toMatchObject({ outcome: 'auto', ruleIds: ['read_draft'] });
  });
  it('pause wins over untrusted source; untrusted source wins over always-ask classes', () => {
    expect(d({ spoofSuspected: true }, {}, { claimPaused: true })).toMatchObject({ ruleIds: ['paused'] });
    expect(d({ class: 'money', injectionSuspected: true })).toMatchObject({ ruleIds: ['untrusted_source'] });
  });
  it('money asks even in shadow mode and with perfect confidence', () => {
    expect(d({ class: 'money', confidence: 1 }, { mode: 'shadow' })).toMatchObject({ ruleIds: ['always_ask_classes'] });
  });
  it('shadow wins over internal rules', () => {
    expect(di({ sensitive: true, confidence: 0.1 }, { mode: 'shadow' })).toMatchObject({ ruleIds: ['shadow'] });
  });
  it('sensitive wins over low confidence for internal', () => {
    expect(di({ sensitive: true, confidence: 0.1 })).toMatchObject({ ruleIds: ['internal_sensitive'] });
  });
  it('not reviewed (deny) wins over every later external rule', () => {
    expect(d({ review: undefined, consistencyBlocked: true, missingInfo: true, recipient: undefined, confidence: 0 }, {}, { nowLocal: '22:00' })).toMatchObject({ outcome: 'deny', ruleIds: ['not_reviewed'] });
  });
  it('consistency block (deny) wins over missing info (ask); missing info wins over touches', () => {
    expect(d({ consistencyBlocked: true, missingInfo: true })).toMatchObject({ outcome: 'deny', ruleIds: ['consistency_blocked'] });
    expect(d({ missingInfo: true, review: { verdict: 'pass', touches: { ...SEND.review!.touches, money: true } } })).toMatchObject({ ruleIds: ['missing_info'] });
  });
  it('touches → recipient → attachments → allowlist → confidence → rate limits → quiet hours', () => {
    const all: Partial<ActionDescriptor> = {
      review: { verdict: 'pass', touches: { ...SEND.review!.touches, liability: true } },
      recipient: { ...SEND.recipient!, verified: false },
      attachmentsAllowed: false,
      emailKind: 'legal',
      confidence: 0.5,
    };
    const st: Partial<AutonomyState> = { sends: { claimToday: 9, lastHour: 0, today: 0 }, nowLocal: '22:00' };
    expect(d(all, {}, st)).toMatchObject({ ruleIds: ['touches'] });
    expect(d({ ...all, review: SEND.review }, {}, st)).toMatchObject({ ruleIds: ['recipient'] });
    expect(d({ ...all, review: SEND.review, recipient: SEND.recipient }, {}, st)).toMatchObject({ ruleIds: ['attachments'] });
    expect(d({ ...all, review: SEND.review, recipient: SEND.recipient, attachmentsAllowed: true }, {}, st)).toMatchObject({ ruleIds: ['allowlist'] });
    expect(d({ ...all, review: SEND.review, recipient: SEND.recipient, attachmentsAllowed: true, emailKind: 'chaser' }, {}, st)).toMatchObject({ ruleIds: ['external_confidence'] });
    expect(d({ ...all, review: SEND.review, recipient: SEND.recipient, attachmentsAllowed: true, emailKind: 'chaser', confidence: 0.99 }, {}, st)).toMatchObject({ ruleIds: ['rate_limits'] });
    expect(d({ ...all, review: SEND.review, recipient: SEND.recipient, attachmentsAllowed: true, emailKind: 'chaser', confidence: 0.99 }, {}, { ...st, sends: ST.sends })).toMatchObject({ ruleIds: ['quiet_hours'] });
  });
  it('every decision carries exactly one rule id and at least one reason', () => {
    const classes: ActionClass[] = ['read', 'draft', 'internal', 'external_send', 'money', 'settlement', 'legal', 'destructive'];
    for (const c of classes) {
      const r = d({ class: c });
      expect(r.ruleIds).toHaveLength(1);
      expect(AUTONOMY_RULE_IDS).toContain(r.ruleIds[0]);
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('autonomy defaults and lists', () => {
  it('defaults match the owner choices (§D.1, §D.2)', () => {
    expect(DEFAULT_AUTONOMY).toMatchInlineSnapshot(`
      {
        "autoApproveTemplates": [
          "letter.ncaf",
          "letter.handling_ref_request",
          "letter.cctv_preservation",
          "letter.chaser_7",
          "letter.chaser_14",
          "letter.chaser_21",
          "letter.client_update",
          "letter.delay_notice_gta_4_10",
          "letter.supplier_instruction_engineer",
        ],
        "autoSendEmailKinds": [
          "ack",
          "info_provided",
          "doc_request_fulfil",
          "chaser",
          "handling_ref_request",
          "ncaf_cover",
          "cctv_request",
          "client_update",
          "supplier_instruction",
          "reply_general",
        ],
        "autoSendTemplates": [
          "letter.ncaf",
          "letter.handling_ref_request",
          "letter.cctv_preservation",
          "letter.chaser_7",
          "letter.chaser_14",
          "letter.chaser_21",
          "letter.client_update",
          "letter.delay_notice_gta_4_10",
          "letter.supplier_instruction_engineer",
        ],
        "holdMinutes": 10,
        "killSwitch": false,
        "limits": {
          "perClaimPerDay": 3,
          "perDay": 100,
          "perHour": 20,
        },
        "mode": "automatic",
        "quietHours": {
          "end": "07:30",
          "start": "20:00",
        },
        "thresholds": {
          "external": 0.9,
          "internal": 0.85,
        },
      }
    `);
  });
  it('always-ask templates include the prefixes and no default auto-send template is always-ask', () => {
    for (const p of ['invoice.', 'statement.', 'agreement.', 'form.', 'notice.']) expect(ALWAYS_ASK_TEMPLATES).toContain(p);
    expect(isAlwaysAskTemplate('invoice.hire')).toBe(true);
    expect(isAlwaysAskTemplate('notice.s172_response')).toBe(true);
    expect(isAlwaysAskTemplate('form.claim_form')).toBe(true);
    expect(isAlwaysAskTemplate('letter.chaser_7')).toBe(false);
    for (const t of DEFAULT_AUTONOMY.autoSendTemplates) expect(isAlwaysAskTemplate(t)).toBe(false);
    expect(ALWAYS_ASK_EMAIL_KINDS).toEqual(['offer_response', 'complaint', 'legal', 'doc_request']);
  });
  it('mayAutoApproveTemplate requires the allow-list and refuses always-ask templates', () => {
    expect(mayAutoApproveTemplate(DEFAULT_AUTONOMY, 'letter.chaser_7')).toBe(true);
    expect(mayAutoApproveTemplate(DEFAULT_AUTONOMY, 'letter.part36_offer')).toBe(false);
    expect(mayAutoApproveTemplate({ autoApproveTemplates: ['pack.gta_payment'] }, 'pack.gta_payment')).toBe(false);
  });
  it('quiet hours cross midnight', () => {
    const q = { start: '20:00', end: '07:30' };
    expect(inQuietHours(q, '19:59')).toBe(false);
    expect(inQuietHours(q, '20:00')).toBe(true);
    expect(inQuietHours(q, '00:10')).toBe(true);
    expect(inQuietHours(q, '07:30')).toBe(false);
    expect(inQuietHours({ start: '12:00', end: '13:00' }, '12:30')).toBe(true);
    expect(inQuietHours(null, '23:00')).toBe(false);
    expect(minutesUntil('21:00', '07:30')).toBe(630);
  });
});

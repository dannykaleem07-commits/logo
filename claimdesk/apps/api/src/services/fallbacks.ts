/**
 * Conservative, rules-first implementations used while the corresponding @ccguk/domain engines are still being
 * built (see ../engines.ts). Each mirrors the ARCHITECTURE contract's output shape so routes do not change when the
 * real engine lands. Nothing here is a legal entitlement: GTA references are benchmark only (GTA 2.7(j)).
 */
import {
  addCalendarDays,
  addWorkingDays,
  compareIso,
  offHireDeadline,
  isoToMs,
  msToUtcIso,
  MS_PER_HOUR,
  type AccidentDetails,
  type CaseAcceptance,
  type Claim,
  type ClaimBundle,
  type ClaimEvent,
  type Clock,
  type FleetUnit,
  type FleetUse,
  type GateResult,
  type HireEndTrigger,
  type InsurancePolicy,
  type ISODateTime,
  type PlaybookAction,
} from '@ccguk/domain';
import type { AllocationCheck, FnolValidation, InjuryRouting, LiabilityScore } from '../engines.js';
import type { CreateClaimBody } from '../schemas/claims.js';

export const GTA_BENCHMARK = 'benchmark only — CCGUK is not a GTA subscriber (GTA 2.7(j))';

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export function validateFnolFallback(body: CreateClaimBody): FnolValidation {
  const missing: string[] = [];
  const warnings: string[] = [];
  const claimant = body.claimant;
  if (!('id' in claimant)) {
    if (!claimant.name?.trim()) missing.push('claimant.name');
    if (!claimant.phone && !claimant.email) missing.push('claimant.phone|claimant.email');
    if (!claimant.address) warnings.push('claimant.address');
  }
  if (!('id' in body.vehicle) && !body.vehicle.registration?.trim()) missing.push('vehicle.registration');
  if (!body.accident.occurredAt) missing.push('accident.occurredAt');
  if (!body.accident.location?.trim()) missing.push('accident.location');
  if ((body.accident.circumstances ?? '').trim().length < 20) missing.push('accident.circumstances (client account, taken cold, at least a full sentence)');
  if (body.accident.injuries === undefined) warnings.push('accident.injuries (ask: was anyone injured? — injury is referred out, no fee)');
  if (!body.thirdPartyVehicle && !body.atFaultInsurer) warnings.push('thirdPartyVehicle or atFaultInsurer (askMID once the registration is known)');
  if (body.callRecordingDisclosed !== true) warnings.push('callRecordingDisclosed (tell the client calls are recorded)');
  return { ok: missing.length === 0, missing, warnings };
}

export function scoreLiabilityFallback(accident: AccidentDetails, liability: Claim['liability'] = 'unknown'): LiabilityScore {
  const reasons: string[] = [];
  let score = 50;
  switch (liability) {
    case 'admitted':
      score = 90;
      reasons.push('Liability admitted by the third party / insurer');
      break;
    case 'denied':
      score = 30;
      reasons.push('Liability denied — expect a contested file');
      break;
    case 'split':
      score = 50;
      reasons.push('Split liability proposed');
      break;
    case 'disputed':
      score = 40;
      reasons.push('Liability in dispute');
      break;
    default:
      reasons.push('Liability position not yet known (starting at 50)');
  }
  if (accident.cctvAvailable) {
    score += 10;
    reasons.push('CCTV believed available (+10) — send a preservation request now');
  }
  if (accident.dashcamAvailable) {
    score += 10;
    reasons.push('Dashcam footage available (+10)');
  }
  if (accident.independentWitness) {
    score += 10;
    reasons.push('Independent witness (+10) — run the connected-party check before relying on it');
  }
  if (accident.policeReference?.trim()) {
    score += 5;
    reasons.push(`Police reference ${accident.policeReference} (+5)`);
  }
  if (accident.highwayCodeRules?.length) {
    score += 5;
    reasons.push(`Highway Code rules engaged: ${accident.highwayCodeRules.join(', ')} (+5)`);
  }
  if (accident.thirdPartyAccount?.trim()) {
    score -= 5;
    reasons.push('Third-party account on file (−5): compare for contradictions before correspondence');
  }
  score = Math.max(0, Math.min(100, score));
  return { score, reasons };
}

export function routeInjuryFallback(accident: AccidentDetails, referredTo?: string): InjuryRouting | undefined {
  if (!accident.injuries) return undefined;
  return {
    refer: true,
    referredTo: referredTo?.trim() || 'External personal-injury solicitor (FCA-regulated CMC perimeter — to be selected)',
    message:
      'Injury element reported. Personal injury is outside the CCGUK perimeter (FSMA 2000 s.19; FCA claims management regulation): refer out, take no fee, record the referral on the file. The vehicle-damage, hire, recovery and storage heads continue here.',
    feeTaken: false,
  };
}

export function canAllocateFallback(unit: FleetUnit, use: FleetUse, policies: InsurancePolicy[], at: ISODateTime): AllocationCheck {
  const reasons: string[] = [];
  if (unit.status !== 'available') reasons.push(`Fleet unit is ${unit.status}, not available`);
  if (!unit.declaredUses.includes(use)) reasons.push(`Fleet unit is not declared for ${use} (declared: ${unit.declaredUses.join(', ') || 'none'})`);
  const policy = unit.policyId ? policies.find((p) => p.id === unit.policyId) : undefined;
  const day = at.slice(0, 10);
  if (!policy) reasons.push('No insurance policy linked to the fleet unit');
  else {
    if (!policy.coveredUses.includes(use)) reasons.push(`Policy ${policy.policyNumber} does not cover ${use} (covers: ${policy.coveredUses.join(', ')})`);
    if (day < policy.startDate || day > policy.endDate) reasons.push(`Policy ${policy.policyNumber} is not in force on ${day} (${policy.startDate} to ${policy.endDate})`);
  }
  if (!unit.keeperAddressCurrent) reasons.push('Keeper address on the V5C is stale — PCNs/NIPs would go to the wrong address (lesson l)');
  if (use === 'pco' && unit.phvLicensed !== true) reasons.push('Unit is not PHV licensed for PCO use');
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Clocks (API-side supplement; replaced by domain deriveClocks when present)
// ---------------------------------------------------------------------------

type DerivedClock = Omit<Clock, 'id' | 'claimId'>;

function statusFor(dueAt: ISODateTime, metAt: ISODateTime | undefined, now: ISODateTime): Pick<Clock, 'status' | 'metAt'> {
  if (metAt) return compareIso(metAt, dueAt) <= 0 ? { status: 'met', metAt } : { status: 'breached', metAt };
  return compareIso(now, dueAt) > 0 ? { status: 'breached' } : { status: 'running' };
}

function firstEvent(events: ClaimEvent[], type: ClaimEvent['type'], after?: ISODateTime): ClaimEvent | undefined {
  return events.filter((e) => e.type === type && (!after || compareIso(e.at, after) >= 0)).sort((a, b) => compareIso(a.at, b.at))[0];
}

function latestEvent(events: ClaimEvent[], type: ClaimEvent['type']): ClaimEvent | undefined {
  return events.filter((e) => e.type === type).sort((a, b) => compareIso(b.at, a.at))[0];
}

const OFFHIRE_TRIGGER_EVENT: Array<{ event: ClaimEvent['type']; trigger: HireEndTrigger; kind: Clock['kind']; label: string }> = [
  { event: 'repair_completed', trigger: 'repair_complete_24h', kind: 'gta_4_8_offhire_repair_24h', label: 'Off-hire within 24 hours of repair completion' },
  { event: 'tl_payment_received', trigger: 'tl_payment_5wd', kind: 'gta_4_14_offhire_tl_payment_5wd', label: 'Off-hire within 5 working days of total-loss payment' },
  { event: 'insurer_termination_notice', trigger: 'insurer_termination_1wd', kind: 'gta_4_9_termination_1wd', label: 'Off-hire within 1 working day of insurer termination notice' },
];

/** The off-hire trigger event type for a given trigger (used by hire end to find the deadline). */
export function offHireEventFor(trigger: HireEndTrigger): ClaimEvent['type'] | undefined {
  return OFFHIRE_TRIGGER_EVENT.find((t) => t.trigger === trigger)?.event;
}

export function deriveClocksFallback(bundle: ClaimBundle, now: ISODateTime): DerivedClock[] {
  const { claim, events, offers, storage, hire } = bundle;
  const out: DerivedClock[] = [];

  // GTA 4.1 — NCAF within 1 working day of FNOL (benchmark).
  const fnol = firstEvent(events, 'fnol');
  const fnolAt = fnol?.at ?? claim.openedAt;
  const ncaf = firstEvent(events, 'ncaf_sent');
  out.push({
    kind: 'gta_4_1_ncaf_1wd',
    label: 'New Claim Advice Form to the at-fault insurer',
    basis: `GTA 4.1 (16 March 2026 wording) — ${GTA_BENCHMARK}`,
    startsAt: fnolAt,
    dueAt: addWorkingDays(fnolAt, 1),
    attributableTo: 'ccguk',
    sourceEventId: fnol?.id,
    ...statusFor(addWorkingDays(fnolAt, 1), ncaf?.at, now),
  });

  // GTA 4.2 — handling reference within 5 working days of the NCAF.
  if (ncaf) {
    const ref = firstEvent(events, 'handling_ref_received', ncaf.at);
    const due = addWorkingDays(ncaf.at, 5);
    out.push({
      kind: 'gta_4_2_handling_ref_5wd',
      label: 'Insurer handling reference expected',
      basis: `GTA 4.2 — ${GTA_BENCHMARK}`,
      startsAt: ncaf.at,
      dueAt: due,
      attributableTo: 'insurer',
      sourceEventId: ncaf.id,
      ...statusFor(due, ref?.at, now),
    });
  }

  // Intervention register — written reply within 1 working day of every offer (lesson c).
  for (const offer of offers) {
    const due = addWorkingDays(offer.receivedAt, 1);
    const sourceEvent = events.find((e) => e.type === 'intervention_offer' && e.data?.offerId === offer.id);
    out.push({
      kind: 'intervention_reply_1wd',
      label: `Written reply to ${offer.offerorName}'s intervention offer`,
      basis: 'BLUEPRINT §3.6 intervention register — reply in writing within 1 working day (mitigation record)',
      startsAt: offer.receivedAt,
      dueAt: due,
      attributableTo: 'ccguk',
      sourceEventId: sourceEvent?.id,
      ...statusFor(due, offer.replySentAt, now),
    });
  }

  // Storage — report issued + 48 h while storage is open (lesson d, File 2).
  const report = latestEvent(events, 'report_issued');
  if (report) {
    for (const s of storage) {
      if (compareIso(s.startAt, report.at) > 0) continue;
      const due = msToUtcIso(isoToMs(report.at) + 48 * MS_PER_HOUR);
      out.push({
        kind: 'storage_report_plus_48h',
        label: `Storage at ${s.location}: collect-or-pay notice / release within 48 h of the engineer's report`,
        basis: "Engineer's report issued — storage beyond report + 48 h needs a collect-or-pay notice (mitigation); insurer practice caps storage at report + 48 h",
        startsAt: report.at,
        dueAt: due,
        attributableTo: 'ccguk',
        sourceEventId: report.id,
        ...statusFor(due, s.endAt, now),
      });
    }
  }

  // Off-hire triggers (GTA 4.8 / 4.14 / 4.9, benchmark) against every hire running at the trigger.
  for (const t of OFFHIRE_TRIGGER_EVENT) {
    const ev = latestEvent(events, t.event);
    if (!ev) continue;
    const deadline = offHireDeadline(t.trigger, ev.at);
    for (const h of hire) {
      if (compareIso(h.startAt, ev.at) > 0) continue;
      if (h.endAt && compareIso(h.endAt, ev.at) < 0) continue;
      out.push({
        kind: t.kind,
        label: `${t.label} (${h.agreementNumber})`,
        basis: deadline.basis,
        startsAt: ev.at,
        dueAt: deadline.dueAt,
        attributableTo: 'ccguk',
        sourceEventId: ev.id,
        ...statusFor(deadline.dueAt, h.endAt, now),
      });
    }
  }

  // Chaser cadence after the payment pack: 7 / 14 / 21 days, complaint at day 28 (DISP 1 route for an at-fault insurer).
  const pack = latestEvent(events, 'payment_pack_sent');
  if (pack) {
    const paid = firstEvent(events, 'payment_received', pack.at);
    const cadence: Array<{ kind: Clock['kind']; days: number; label: string; met: ClaimEvent['type'] }> = [
      { kind: 'chaser_day_7', days: 7, label: 'Chaser 1 (day 7)', met: 'chaser_sent' },
      { kind: 'chaser_day_14', days: 14, label: 'Chaser 2 (day 14)', met: 'chaser_sent' },
      { kind: 'chaser_day_21', days: 21, label: 'Chaser 3 (day 21)', met: 'chaser_sent' },
      { kind: 'complaint_day_28', days: 28, label: 'Formal complaint (day 28, DISP 1)', met: 'complaint_sent' },
    ];
    const chasers = events.filter((e) => e.type === 'chaser_sent' && compareIso(e.at, pack.at) >= 0).sort((a, b) => compareIso(a.at, b.at));
    cadence.forEach((c, i) => {
      const due = addCalendarDays(pack.at, c.days);
      let metAt: ISODateTime | undefined;
      if (paid) metAt = paid.at;
      else if (c.met === 'chaser_sent') metAt = chasers[i]?.at;
      else metAt = firstEvent(events, 'complaint_sent', pack.at)?.at;
      const base = statusFor(due, metAt, now);
      out.push({
        kind: c.kind,
        label: c.label,
        basis: 'BLUEPRINT §7 get-paid-faster cadence; GTA 6.7 one-month settlement expectation (benchmark only); DISP 1 complaint route',
        startsAt: pack.at,
        dueAt: due,
        attributableTo: 'insurer',
        sourceEventId: pack.id,
        ...(paid ? { status: 'stopped' as const, stoppedAt: paid.at, stoppedReason: 'Payment received' } : base),
      });
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Playbook and acceptance
// ---------------------------------------------------------------------------

export function nextActionsFallback(bundle: ClaimBundle, gates: GateResult[], now: ISODateTime): PlaybookAction[] {
  const { claim, events, offers, hire, storage } = bundle;
  const has = (type: ClaimEvent['type']) => events.some((e) => e.type === type);
  const redGates = gates.filter((g) => g.status === 'red').map((g) => g.gate);
  const actions: PlaybookAction[] = [];
  const hardStops = claim.flags.filter((f) => f.severity === 'block' && !f.clearedAt);
  if (hardStops.length) {
    actions.push({
      code: 'RESOLVE_HARD_STOP',
      title: `Resolve hard stop: ${hardStops.map((f) => f.code).join(', ')}`,
      why: 'A block flag stops the file progressing until it is cleared with a logged reason.',
      basis: ['BLUEPRINT §3.2 cross-file registration check', 'ARCHITECTURE convention 5'],
      priority: 'now',
    });
  }
  if (claim.injuryReferral || claim.accident.injuries) {
    actions.push({
      code: 'REFER_INJURY',
      title: claim.injuryReferral ? `Confirm injury referral to ${claim.injuryReferral.referredTo}` : 'Refer the injury element out (no fee)',
      why: 'Personal injury is outside the CCGUK perimeter; it is referred out and no fee is taken.',
      basis: ['FSMA 2000 s.19', 'FCA claims management perimeter'],
      priority: claim.injuryReferral ? 'this_week' : 'now',
    });
  }
  if (!has('ncaf_sent')) {
    actions.push({
      code: 'SEND_NCAF',
      title: 'Send the New Claim Advice Form to the at-fault insurer',
      why: 'Day-1 notification starts the insurer clock and defeats the "we were never told" reduction.',
      basis: [`GTA 4.1 — ${GTA_BENCHMARK}`],
      dueAt: addWorkingDays(claim.openedAt, 1),
      priority: 'now',
      templateId: 'letter.ncaf',
      blockedBy: hardStops.length ? ['RESOLVE_HARD_STOP'] : undefined,
    });
  }
  if (claim.accident.cctvAvailable && !has('cctv_request_sent')) {
    actions.push({
      code: 'REQUEST_CCTV',
      title: 'Send CCTV / dashcam preservation requests',
      why: 'Council and private CCTV is typically overwritten within 7–31 days; a dated request is the only way to keep it.',
      basis: ['Evidence preservation — BLUEPRINT §7'],
      dueAt: addCalendarDays(claim.openedAt, 7),
      priority: 'today',
      templateId: 'letter.cctv_preservation',
    });
  }
  for (const o of offers) {
    if (o.clientDecision === 'pending') {
      actions.push({
        code: 'LOG_OFFER_DECISION',
        title: `Record the client's decision on ${o.offerorName}'s offer (${o.receivedAt.slice(0, 10)})`,
        why: 'An undocumented offer becomes a failure-to-mitigate reduction; the register must show what, who, when and why.',
        basis: ['BLUEPRINT §3.6 intervention register', 'Copley v Lawn [2009] EWCA Civ 580'],
        priority: 'today',
      });
    }
    if (!o.replySentAt) {
      actions.push({
        code: 'SEND_INTERVENTION_REPLY',
        title: `Reply in writing to ${o.offerorName}'s intervention offer`,
        why: 'The written reply within one working day is the evidence that the offer was considered, not ignored (lesson c).',
        basis: ['BLUEPRINT §3.6 — 1 working day reply'],
        dueAt: addWorkingDays(o.receivedAt, 1),
        priority: 'now',
        templateId: 'letter.intervention_reply',
      });
    }
  }
  const openStorage = storage.filter((s) => !s.endAt);
  if (openStorage.length && has('report_issued') && !has('collect_or_pay_notice_sent')) {
    actions.push({
      code: 'SEND_COLLECT_OR_PAY',
      title: 'Send the collect-or-pay notice — storage is running past the engineer report',
      why: 'Storage beyond report + 48 h is routinely refused unless the insurer was put on notice to collect or pay (File 2).',
      basis: ['Mitigation — storage after report', 'BLUEPRINT §3.4'],
      priority: 'now',
      templateId: 'letter.collect_or_pay',
    });
  }
  const endedHire = hire.filter((h) => h.endAt);
  if (endedHire.length && !has('payment_pack_sent')) {
    actions.push({
      code: 'SEND_PAYMENT_PACK',
      title: 'Assemble and send the payment pack',
      why: 'The pack (covering letter, mitigation questionnaire, hire period validation, engineer report, storage and recovery accounts) is what gets paid.',
      basis: [`GTA 6.1–6.3 — ${GTA_BENCHMARK}`],
      priority: 'now',
      templateId: 'pack.gta_payment',
      blockedBy: redGates.length ? redGates : undefined,
      valuePence: bundle.ledger.filter((l) => l.kind === 'claimed').reduce((a, l) => a + l.amountPence + (l.vatPence ?? 0), 0) || undefined,
    });
  }
  const pack = events.filter((e) => e.type === 'payment_pack_sent').sort((a, b) => compareIso(b.at, a.at))[0];
  if (pack && !events.some((e) => e.type === 'payment_received' && compareIso(e.at, pack.at) >= 0)) {
    const chasers = events.filter((e) => e.type === 'chaser_sent' && compareIso(e.at, pack.at) >= 0).length;
    const steps = [
      { day: 7, code: 'CHASER_7', template: 'letter.chaser_7' },
      { day: 14, code: 'CHASER_14', template: 'letter.chaser_14' },
      { day: 21, code: 'CHASER_21', template: 'letter.chaser_21' },
    ];
    const next = steps[chasers];
    if (next) {
      const due = addCalendarDays(pack.at, next.day);
      actions.push({
        code: next.code,
        title: `Chaser ${chasers + 1} (day ${next.day})`,
        why: 'Dated chasers build the delay chronology that supports the complaint and interest claim.',
        basis: [`GTA 6.7 one-month expectation — ${GTA_BENCHMARK}`],
        dueAt: due,
        priority: compareIso(now, due) >= 0 ? 'now' : 'scheduled',
        templateId: next.template,
      });
    } else if (!has('complaint_sent')) {
      actions.push({
        code: 'SEND_COMPLAINT',
        title: 'Send the formal complaint (DISP 1) — eight-week clock',
        why: 'A third-party claimant cannot go to FOS against the at-fault insurer (DISP 2.7); the complaint route is DISP 1 then letter before claim.',
        basis: ['DISP 1.6 eight-week final response', 'DISP 2.7'],
        dueAt: addCalendarDays(pack.at, 28),
        priority: 'now',
        templateId: 'letter.complaint_disp',
      });
    }
  }
  return actions;
}

export function assessAcceptanceFallback(bundle: ClaimBundle, gates: GateResult[]): CaseAcceptance {
  const { claim, ledger } = bundle;
  const liabilityScore = claim.liabilityScore ?? scoreLiabilityFallback(claim.accident, claim.liability).score;
  const claimed = (head: string) => ledger.filter((l) => l.kind === 'claimed' && l.head === head).reduce((a, l) => a + l.amountPence, 0);
  const hirePence = claimed('hire');
  const other = ledger.filter((l) => l.kind === 'claimed' && l.head !== 'hire').reduce((a, l) => a + l.amountPence, 0);
  const ratio = other > 0 ? Math.round((hirePence / other) * 100) / 100 : undefined;
  const costsExposure: CaseAcceptance['costsExposure'] = ratio === undefined ? (hirePence > 0 ? 'high' : 'low') : ratio > 3 ? 'high' : ratio > 1.5 ? 'medium' : 'low';
  const gate = (name: string) => gates.find((g) => g.gate === name)?.status;
  const readiness = (s: string | undefined): CaseAcceptance['impecuniosityReadiness'] => (s === 'green' ? 'ready' : s === 'amber' ? 'partial' : 'none');
  const perimeterFlags: string[] = [];
  if (claim.accident.injuries || claim.injuryReferral) perimeterFlags.push('INJURY_REFER_OUT');
  const reasons: string[] = [];
  const conditions: string[] = [];
  const hardStops = claim.flags.filter((f) => f.severity === 'block' && !f.clearedAt);
  let decision: CaseAcceptance['decision'] = 'accept';
  if (hardStops.length) {
    decision = 'decline';
    reasons.push(`Hard stop: ${hardStops.map((f) => f.code).join(', ')}`);
  } else if (liabilityScore < 40) {
    decision = 'decline';
    reasons.push(`Liability score ${liabilityScore} is below the acceptance threshold of 40`);
  } else {
    if (liabilityScore < 60) {
      decision = 'accept_with_conditions';
      conditions.push('Obtain an independent liability source (CCTV, dashcam, independent witness or police report) before hire starts');
    }
    if (costsExposure === 'high') {
      decision = 'accept_with_conditions';
      conditions.push('Hire dominates the claim: keep hire proportionate and evidence need daily (Tescher-type non-party costs exposure)');
    }
    if (perimeterFlags.includes('INJURY_REFER_OUT')) {
      decision = 'accept_with_conditions';
      conditions.push('Injury element referred out, no fee; vehicle heads only handled here');
    }
    reasons.push(`Liability score ${liabilityScore}; costs exposure ${costsExposure}`);
  }
  return {
    liabilityScore,
    costsExposure,
    hireToOtherHeadsRatio: ratio,
    impecuniosityReadiness: readiness(gate('impecuniosity')),
    enforceabilityReadiness: readiness(gate('enforceability')),
    perimeterFlags,
    decision,
    conditions,
    reasons,
  };
}

/**
 * Case acceptance (BLUEPRINT §2 finding 4 "case-acceptance scoring must be strict"; §10 "weak-liability
 * files (e.g. File 3's lane-merge dispute) should not run on hire without strong evidence"; money.md §1).
 *
 * The Tescher test: where an impecunious claimant's hire charges dwarf the other heads, the litigation is
 * "for all practical purposes" driven by the hire provider, which opens the door to a non-party costs
 * order (Tescher v Direct Accident Management / AXA v Spectra Drive [2025] EWCA Civ 733; Kindertons Ltd v
 * Murtagh [2024] EWHC 471 (KB)). So costs exposure is a function of liability strength and the
 * hire : other-heads ratio, and the decision follows from it.
 *
 * Gates (impecuniosity, enforceability) are accepted as inputs so this module stays decoupled from the
 * evidence module; when they are not supplied a minimal local check runs on the bundle.
 */
import type { CaseAcceptance, ClaimBundle, GateResult, GeneratedDocument, HireAgreement, ISODateTime, Pence } from '../types.js';
import { formatGBP } from '../money.js';
import { canonicalTemplateId } from '../templateIds.js';
import { isoToMs } from '../calendar/index.js';
import { LIABILITY_DECLINE_THRESHOLD, LIABILITY_WEAK_THRESHOLD, scoreLiability, type LiabilityExtras, type LiabilityScore } from './liability.js';

export const TESCHER_RATIO = 2;
export const ACCEPTANCE_DEFAULT_HIRE_DAYS = 14;

export const CITATIONS = {
  tescher: 'Tescher v Direct Accident Management / AXA v Spectra Drive [2025] EWCA Civ 733',
  kindertons: 'Kindertons Ltd v Murtagh [2024] EWHC 471 (KB)',
  diriye: 'Diriye v Bojaj [2020] EWCA Civ 1400',
  lagden: 'Lagden v O’Connor [2003] UKHL 64',
  houston: 'MIB v Houston [2025] EWHC 3178 (KB)',
  veolia: 'W v Veolia [2011] EWHC 2020 (QB)',
  dimond: 'Dimond v Lovell [2002] 1 AC 384',
  laspo: 'LASPO 2012 ss.56–60',
  lsa: 'Legal Services Act 2007 s.12',
} as const;

export const PERIMETER_FLAG_INJURY = 'PERSONAL_INJURY_REFER_OUT';
export const PERIMETER_FLAG_LSA = 'LSA_LITIGATION_DRAFTS_ONLY';

export const CONDITIONS = {
  noHireUntilLiability: 'no hire until liability evidence obtained',
  cctv: 'obtain CCTV/dashcam within 7 days',
  impecuniosity: 'collect statement of means and 3 months bank statements before hire',
  enforceability: 'issue the CCR 2013-compliant hire agreement (Sch 2 information, Sch 3 cancellation form, express request to start) and confirm the art 60F fit before hire',
  interventionReply: 'send the written reply to every intervention offer within 1 working day',
  injury: 'refer the personal injury element to a PI solicitor; no referral fee (LASPO 2012 ss.56–60)',
} as const;

export interface AcceptanceOptions {
  /** Evidence-gate results from the evidence module (impecuniosity and enforceability are read). */
  gates?: GateResult[];
  /** Override the computed liability score (e.g. a handler's assessment). */
  liabilityScore?: number;
  /** Extra inputs for scoreLiability. Defaults are derived from the bundle. */
  liability?: LiabilityExtras;
  /** Projected or agreed hire (gross) when the ledger has no hire line yet. */
  projectedHirePence?: Pence;
  /** Days to project an open-ended hire over (default: report repair duration, else 14). */
  acceptanceHireProjection?: number;
  /** Override the sum of the other heads (gross). */
  otherHeadsPence?: Pence;
  /** For projecting open storage; optional. */
  now?: ISODateTime;
}

export interface AcceptanceAssessment extends CaseAcceptance {
  liability: LiabilityScore;
  hirePence: Pence;
  otherHeadsPence: Pence;
}

const ON_FILE = new Set<GeneratedDocument['status']>(['approved', 'sent', 'signed']);
const MS_PER_DAY = 86_400_000;
const INCOME = /payslip|income|sa302|tax return|accounts|universal credit|benefit|pension|p60|wage/i;

/** Each 24-hour period started counts as a day (same convention as the hire engine), minimum 1. */
export function acceptanceHireDays(startAt: ISODateTime, endAt: ISODateTime): number {
  const ms = isoToMs(endAt) - isoToMs(startAt);
  return Math.max(1, Math.ceil(ms / MS_PER_DAY));
}

function gross(net: Pence, vatRate: number): Pence {
  return net + Math.round(net * vatRate);
}

export function acceptanceHireProjection(h: HireAgreement, bundle: ClaimBundle, opts: AcceptanceOptions): { days: number; basis: string } {
  if (h.endAt) return { days: acceptanceHireDays(h.startAt, h.endAt), basis: 'agreement period' };
  if (opts.acceptanceHireProjection !== undefined) return { days: opts.acceptanceHireProjection, basis: 'projected days supplied' };
  const repairWd = bundle.report?.repairDurationWorkingDays;
  if (repairWd && repairWd > 0) return { days: Math.ceil((repairWd * 7) / 5) + 3, basis: `engineer's ${repairWd} working-day repair estimate plus 3 days for authorisation and collection` };
  return { days: ACCEPTANCE_DEFAULT_HIRE_DAYS, basis: `${ACCEPTANCE_DEFAULT_HIRE_DAYS}-day default projection` };
}

/** Hire figure for the Tescher ratio: supplied projection → ledger claimed hire → agreement projection → 0. */
export function hireFigure(bundle: ClaimBundle, opts: AcceptanceOptions): { pence: Pence; basis: string } {
  if (opts.projectedHirePence !== undefined) return { pence: opts.projectedHirePence, basis: 'projected hire supplied' };
  const claimed = bundle.ledger.filter((e) => e.head === 'hire' && e.kind === 'claimed');
  if (claimed.length > 0) return { pence: claimed.reduce((a, e) => a + e.amountPence + (e.vatPence ?? 0), 0), basis: 'ledger claimed hire' };
  if (bundle.hire.length > 0) {
    let total = 0;
    const bases: string[] = [];
    for (const h of bundle.hire) {
      const p = acceptanceHireProjection(h, bundle, opts);
      total += gross(p.days * h.dailyRatePence, h.vatRate);
      bases.push(`${h.agreementNumber}: ${p.days} days × ${formatGBP(h.dailyRatePence)} + VAT (${p.basis})`);
    }
    return { pence: total, basis: bases.join('; ') };
  }
  return { pence: 0, basis: 'no hire on the file' };
}

/** Sum of the heads other than hire (gross; salvage negative; interest/fees excluded). */
export function otherHeadsFigure(bundle: ClaimBundle, opts: AcceptanceOptions): { pence: Pence; basis: string } {
  if (opts.otherHeadsPence !== undefined) return { pence: opts.otherHeadsPence, basis: 'other heads supplied' };
  const excluded = new Set(['hire', 'interest', 'court_fee', 'fixed_costs']);
  const claimed = bundle.ledger.filter((e) => e.kind === 'claimed' && !excluded.has(e.head));
  if (claimed.length > 0) {
    const total = claimed.reduce((a, e) => a + (e.head === 'salvage' ? -1 : 1) * (e.amountPence + (e.vatPence ?? 0)), 0);
    return { pence: Math.max(0, total), basis: `ledger claimed heads: ${Array.from(new Set(claimed.map((e) => e.head))).join(', ')}` };
  }
  let total = 0;
  const parts: string[] = [];
  const tl = bundle.report?.totalLoss;
  if (tl && tl.decision === 'total_loss') {
    total += tl.pavPence - tl.salvagePence;
    parts.push(`PAV ${formatGBP(tl.pavPence)} less salvage ${formatGBP(tl.salvagePence)}`);
  } else if (bundle.estimate) {
    total += bundle.estimate.totals.grossPence;
    parts.push(`repair estimate ${formatGBP(bundle.estimate.totals.grossPence)}`);
  } else if (bundle.pav) {
    total += bundle.pav.pavPence;
    parts.push(`PAV ${formatGBP(bundle.pav.pavPence)}`);
  }
  if (bundle.report) {
    total += bundle.report.feePence;
    parts.push(`engineer fee ${formatGBP(bundle.report.feePence)}`);
  }
  for (const s of bundle.storage) {
    const end = s.endAt ?? opts.now;
    if (!end) continue;
    const days = acceptanceHireDays(s.startAt, end);
    const g = gross(days * s.dailyRatePence, s.vatRate);
    total += g;
    parts.push(`storage ${days} days ${formatGBP(g)}`);
  }
  for (const r of bundle.recovery) {
    const g = gross(r.calloutPence + r.loadedMiles * r.perLoadedMilePence + r.adminPence, r.vatRate);
    total += g;
    parts.push(`recovery ${formatGBP(g)}`);
  }
  return { pence: total, basis: parts.length > 0 ? parts.join('; ') : 'no other heads known yet' };
}

function readinessFromGate(gate: GateResult | undefined): CaseAcceptance['impecuniosityReadiness'] | undefined {
  if (!gate) return undefined;
  return gate.status === 'green' ? 'ready' : gate.status === 'amber' ? 'partial' : 'none';
}

export function impecuniosityReadiness(bundle: ClaimBundle, gates?: GateResult[]): { readiness: CaseAcceptance['impecuniosityReadiness']; missing: string[] } {
  const fromGate = readinessFromGate(gates?.find((g) => g.gate === 'impecuniosity'));
  if (fromGate) return { readiness: fromGate, missing: gates!.find((g) => g.gate === 'impecuniosity')!.missing };
  const statement = bundle.documents.some((d) => canonicalTemplateId(d.templateId) === 'form.statement_of_means' && ON_FILE.has(d.status)) || bundle.hire.some((h) => !!h.statementOfMeansDocumentId);
  const bank = bundle.evidence.filter((e) => e.kind === 'bank_statement').length;
  const income = bundle.evidence.some((e) => e.kind === 'payslip' || INCOME.test(e.description ?? ''));
  const missing: string[] = [];
  if (!statement) missing.push('signed statement of means (form.statement_of_means)');
  if (bank < 3) missing.push(`3 months' bank statements for every account (${bank} on file)`);
  if (!income) missing.push('income evidence (payslip, SA302, accounts or benefit letter)');
  const present = 3 - missing.length;
  return { readiness: present === 3 ? 'ready' : present >= 1 ? 'partial' : 'none', missing };
}

export function enforceabilityReadiness(bundle: ClaimBundle, gates?: GateResult[]): { readiness: CaseAcceptance['enforceabilityReadiness']; missing: string[] } {
  const g = gates?.find((x) => x.gate === 'enforceability');
  const fromGate = readinessFromGate(g);
  if (fromGate && g) return { readiness: fromGate, missing: g.missing };
  if (bundle.hire.length === 0) {
    return { readiness: 'none', missing: ['no hire agreement yet: use the CCR 2013 / art 60F-compliant agreement with Sch 2 information, Sch 3 cancellation form and an express request to start'] };
  }
  let present = 0;
  let total = 0;
  const missing: string[] = [];
  for (const h of bundle.hire) {
    const items: Array<[boolean, string]> = [
      [!!h.enforceability.cancellationInfoProvidedAt, 'cancellation information (CCR 2013 Sch 2)'],
      [!!h.enforceability.schedule3FormProvidedAt, 'Sch 3 cancellation form'],
      [!!h.enforceability.expressRequestToStartAt, 'express request to start during the cancellation period (reg 36)'],
      [!!h.signedAt, 'signed agreement'],
      [h.enforceability.cca60fCompliant === true, 'CCA 1974 / RAO art 60F fit (≤12 payments within 12 months, no interest or charges)'],
    ];
    for (const [ok, label] of items) {
      total += 1;
      if (ok) present += 1;
      else missing.push(`${bundle.hire.length > 1 ? `${h.agreementNumber}: ` : ''}${label}`);
    }
  }
  return { readiness: present === total ? 'ready' : present > 0 ? 'partial' : 'none', missing };
}

export function assessAcceptance(bundle: ClaimBundle, opts: AcceptanceOptions = {}): AcceptanceAssessment {
  const accident = bundle.claim.accident;
  const extras: LiabilityExtras = {
    priorClaimsOnRegistration: bundle.claim.linkedClaimIds.length,
    footageObtained: bundle.evidence.some((e) => e.kind === 'cctv' || e.kind === 'dashcam'),
    ...(bundle.claim.liability === 'admitted' ? { thirdPartyAdmitted: true } : {}),
    ...(opts.liability ?? {}),
  };
  const liability = scoreLiability(accident, extras);
  const liabilityScore = opts.liabilityScore ?? bundle.claim.liabilityScore ?? liability.score;

  const hire = hireFigure(bundle, opts);
  const other = otherHeadsFigure(bundle, opts);
  const ratio = hire.pence > 0 && other.pence > 0 ? Math.round((hire.pence / other.pence) * 100) / 100 : undefined;
  const ratioHigh = hire.pence > 0 && (other.pence === 0 || hire.pence / other.pence > TESCHER_RATIO);
  const weak = liabilityScore < LIABILITY_WEAK_THRESHOLD;
  const costsExposure: CaseAcceptance['costsExposure'] = weak && ratioHigh ? 'high' : weak || ratioHigh ? 'medium' : 'low';

  const imp = impecuniosityReadiness(bundle, opts.gates);
  const enf = enforceabilityReadiness(bundle, opts.gates);

  const perimeterFlags: string[] = [];
  if (accident.injuries) perimeterFlags.push(PERIMETER_FLAG_INJURY);
  perimeterFlags.push(PERIMETER_FLAG_LSA);

  const conditions: string[] = [];
  const reasons: string[] = [];

  reasons.push(`Liability score ${liabilityScore}/100 (${liability.band}): ${liability.factors.filter((f) => f.factor !== 'baseline').map((f) => `${f.factor} ${f.delta >= 0 ? '+' : ''}${f.delta}`).join(', ') || 'no factors beyond the baseline'}.`);

  if (ratio !== undefined || hire.pence > 0) {
    const ratioText = ratio !== undefined ? `${ratio}× the other heads (${formatGBP(hire.pence)} hire v ${formatGBP(other.pence)}; ${hire.basis}; ${other.basis})` : `${formatGBP(hire.pence)} with no other heads known (${hire.basis})`;
    if (costsExposure === 'high') {
      reasons.push(`Costs exposure high: hire is ${ratioText} and liability is weak. A failed claim would be "for all practical purposes" driven by the hire provider, so a non-party costs order is a live risk (${CITATIONS.tescher}; ${CITATIONS.kindertons}).`);
    } else if (ratioHigh) {
      reasons.push(`Costs exposure medium: hire is ${ratioText}. Liability is adequate, but the Tescher ratio means the file must be evidenced as if it will be litigated (${CITATIONS.tescher}).`);
    } else {
      reasons.push(`Hire is ${ratioText}: within the Tescher ratio of ${TESCHER_RATIO}.`);
    }
  } else {
    reasons.push(`No hire projected or claimed yet (${other.basis}); the Tescher ratio cannot be tested until a hire is proposed.`);
  }
  if (weak && !ratioHigh) reasons.push(`Costs exposure medium: liability is weak (${liabilityScore} < ${LIABILITY_WEAK_THRESHOLD}) even though hire is proportionate; strengthen liability before hire starts.`);

  if (weak && ratioHigh) conditions.push(CONDITIONS.noHireUntilLiability);
  const footageAvailable = accident.cctvAvailable === true || accident.dashcamAvailable === true;
  if ((footageAvailable && !extras.footageObtained) || weak) conditions.push(CONDITIONS.cctv);

  if (imp.readiness !== 'ready') {
    conditions.push(CONDITIONS.impecuniosity);
    reasons.push(`Impecuniosity readiness ${imp.readiness}: ${imp.missing.join('; ')}. Impecuniosity must be pleaded and proved by the claimant (${CITATIONS.diriye}); it is the difference between the credit rate (${CITATIONS.lagden}) and the basic hire rate, and a debarring order can take it away (${CITATIONS.houston}). Collect it at sign-up, not after a defence.`);
  } else {
    reasons.push(`Impecuniosity evidence ready (statement of means, 3 months' bank statements, income evidence) so the claimant can plead it from day one (${CITATIONS.diriye}).`);
  }

  if (enf.readiness !== 'ready') {
    conditions.push(CONDITIONS.enforceability);
    reasons.push(`Enforceability readiness ${enf.readiness}: ${enf.missing.join('; ')}. A hire agreement that fails the cancellation rules or the CCA recovers nothing (${CITATIONS.veolia}; ${CITATIONS.dimond}).`);
  } else {
    reasons.push(`Hire agreement enforceable on its face: cancellation information, Sch 3 form, express request to start, signature and art 60F fit all recorded (${CITATIONS.veolia} and ${CITATIONS.dimond} risks addressed).`);
  }

  if (bundle.offers.some((o) => !o.replySentAt)) conditions.push(CONDITIONS.interventionReply);

  if (accident.injuries) {
    conditions.push(CONDITIONS.injury);
    reasons.push(`Injury reported: the personal injury element is referred out with no referral fee (${CITATIONS.laspo}; FCA claims-management perimeter, RAO art 89G onwards). CCGUK runs the damage-only claim.`);
  }
  reasons.push(`Litigation documents are drafts for the claimant as litigant in person or an instructed solicitor (${CITATIONS.lsa}).`);

  let decision: CaseAcceptance['decision'];
  if (liabilityScore < LIABILITY_DECLINE_THRESHOLD && ratioHigh) {
    decision = 'decline';
    reasons.push(`Decision: decline. Liability ${liabilityScore} is below ${LIABILITY_DECLINE_THRESHOLD} and hire would dwarf the other heads — the Tescher scenario. Reconsider only if the conditions are met (independent liability evidence first).`);
  } else if (costsExposure !== 'low' || imp.readiness !== 'ready' || enf.readiness !== 'ready') {
    decision = 'accept_with_conditions';
    reasons.push(`Decision: accept with ${conditions.length} condition${conditions.length === 1 ? '' : 's'}.`);
  } else {
    decision = 'accept';
    reasons.push('Decision: accept. Liability adequate, hire proportionate, impecuniosity and enforceability evidence ready.');
  }

  const out: AcceptanceAssessment = {
    liabilityScore,
    costsExposure,
    impecuniosityReadiness: imp.readiness,
    enforceabilityReadiness: enf.readiness,
    perimeterFlags,
    decision,
    conditions: Array.from(new Set(conditions)),
    reasons,
    liability,
    hirePence: hire.pence,
    otherHeadsPence: other.pence,
  };
  if (ratio !== undefined) out.hireToOtherHeadsRatio = ratio;
  return out;
}

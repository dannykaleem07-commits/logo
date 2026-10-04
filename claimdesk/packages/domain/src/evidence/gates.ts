/**
 * Evidence gates (BLUEPRINT §1 principle 2, §3.8, §6): need, use, period, rate, impecuniosity, mitigation,
 * enforceability, liability. A claim cannot move to "payment pack" until its gates are green.
 *
 * Status: green = every item present; amber = at least half present; red otherwise.
 * `missing` is written as what to collect, in plain English.
 */
import type { ClaimBundle, Evidence, EvidenceGate, GateResult, GeneratedDocument, HireAgreement, ISODate, ISODateTime } from '../types.js';
import { formatGBP } from '../money.js';
import { londonDate } from '../calendar/index.js';

/** The England & Wales calendar date an instant falls on (labels must not print the UTC date of a BST evening). */
function day(iso: ISODateTime): ISODate {
  try {
    return londonDate(iso);
  } catch {
    return iso.slice(0, 10);
  }
}

export const EVIDENCE_GATES: EvidenceGate[] = ['need', 'use', 'period', 'rate', 'impecuniosity', 'mitigation', 'enforceability', 'liability'];

/** Documents that count as "on file" for a gate: signed, sent or approved (a draft proves nothing yet). */
const COUNTS_AS_ON_FILE = new Set<GeneratedDocument['status']>(['approved', 'sent', 'signed']);

interface Item {
  label: string;
  present: boolean;
  /** Shown in `missing` instead of the label when absent (what to collect). */
  collect?: string;
}

function docOnFile(bundle: ClaimBundle, templateId: string): GeneratedDocument | undefined {
  return bundle.documents.find((d) => d.templateId === templateId && COUNTS_AS_ON_FILE.has(d.status));
}

function docDrafted(bundle: ClaimBundle, templateId: string): boolean {
  return bundle.documents.some((d) => d.templateId === templateId && d.status === 'draft');
}

function hasEvent(bundle: ClaimBundle, ...types: Array<ClaimBundle['events'][number]['type']>): boolean {
  return bundle.events.some((e) => types.includes(e.type));
}

function text(s: string | undefined): string {
  return (s ?? '').toLowerCase();
}

const MS_PER_DAY = 86_400_000;
function withinDays(a: ISODateTime | undefined, b: ISODateTime | undefined, days: number): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= days * MS_PER_DAY;
}

function odometerPhotos(bundle: ClaimBundle): Evidence[] {
  return bundle.evidence.filter((e) => e.kind === 'photo' && e.captureShot === 'odometer');
}

function hireLabel(h: HireAgreement, many: boolean): string {
  return many ? `Agreement ${h.agreementNumber}: ` : '';
}

function toResult(gate: EvidenceGate, items: Item[]): GateResult {
  const present = items.filter((i) => i.present).map((i) => i.label);
  const missing = items.filter((i) => !i.present).map((i) => i.collect ?? i.label);
  let status: GateResult['status'];
  if (items.length === 0 || missing.length === 0) status = 'green';
  else if (present.length >= items.length / 2) status = 'amber';
  else status = 'red';
  return { gate, status, missing, present };
}

export function evaluateGate(bundle: ClaimBundle, gate: EvidenceGate): GateResult {
  switch (gate) {
    case 'need':
      return toResult(gate, needItems(bundle));
    case 'use':
      return toResult(gate, useItems(bundle));
    case 'period':
      return toResult(gate, periodItems(bundle));
    case 'rate':
      return toResult(gate, rateItems(bundle));
    case 'impecuniosity':
      return toResult(gate, impecuniosityItems(bundle));
    case 'mitigation':
      return toResult(gate, mitigationItems(bundle));
    case 'enforceability':
      return toResult(gate, enforceabilityItems(bundle));
    case 'liability':
      return toResult(gate, liabilityItems(bundle));
  }
}

export function evaluateGates(bundle: ClaimBundle): GateResult[] {
  return EVIDENCE_GATES.map((g) => evaluateGate(bundle, g));
}

// ---------------------------------------------------------------------------

function needItems(bundle: ClaimBundle): Item[] {
  const statement = docOnFile(bundle, 'form.statement_of_need');
  const needEvidenceIds = new Set(bundle.hire.map((h) => h.needStatementEvidenceId).filter((x): x is string => !!x));
  const needStatementEvidence = bundle.evidence.some(
    (e) => needEvidenceIds.has(e.id) || (e.kind === 'witness_statement' && /\bneed\b/.test(text(e.description)))
  );
  const present = !!statement || needStatementEvidence;
  return [
    {
      label: 'Signed statement of need (occupation, journeys, dependants, other household vehicles, mobility needs)',
      present,
      collect: docDrafted(bundle, 'form.statement_of_need')
        ? 'Statement of need is drafted but not signed: get it signed (form.statement_of_need) or upload a signed need witness statement'
        : 'Signed statement of need: occupation, journeys, dependants, other vehicles in the household (none or unavailable), mobility needs (form.statement_of_need or a witness statement tagged "need")'
    }
  ];
}

function useItems(bundle: ClaimBundle): Item[] {
  if (bundle.hire.length === 0) {
    return [{ label: 'Hire agreement on file', present: false, collect: 'No hire agreement on file: record the hire before the use gate can be assessed' }];
  }
  const photos = odometerPhotos(bundle);
  const many = bundle.hire.length > 1;
  const items: Item[] = [];
  for (const h of bundle.hire) {
    const p = hireLabel(h, many);
    const deliveredAt = h.deliveredAt ?? h.startAt;
    const ended = !!(h.collectedAt ?? h.endAt);
    const collectedAt = h.collectedAt ?? h.endAt;
    items.push({
      label: `${p}Odometer at delivery recorded on the agreement (${h.odometerOut?.toLocaleString('en-GB') ?? '—'} miles)`,
      present: typeof h.odometerOut === 'number' && h.odometerOut >= 0,
      collect: `${p}Record the odometer reading at delivery on the hire agreement`
    });
    items.push({
      label: `${p}Odometer photo at delivery`,
      present: photos.some((e) => withinDays(e.capturedAt ?? e.uploadedAt, deliveredAt, 1)),
      collect: `${p}Take a guided odometer photo at delivery (captureShot "odometer", within a day of handover)`
    });
    if (ended) {
      items.push({
        label: `${p}Odometer at collection recorded on the agreement (${h.odometerIn?.toLocaleString('en-GB') ?? '—'} miles)`,
        present: typeof h.odometerIn === 'number' && h.odometerIn >= 0,
        collect: `${p}Record the odometer reading at collection on the hire agreement`
      });
      items.push({
        label: `${p}Odometer photo at collection`,
        present: photos.some((e) => withinDays(e.capturedAt ?? e.uploadedAt, collectedAt, 1)),
        collect: `${p}Take a guided odometer photo at collection (captureShot "odometer", within a day of collection)`
      });
    }
  }
  return items;
}

function periodItems(bundle: ClaimBundle): Item[] {
  const report = bundle.report;
  const roadworthyRecorded = !!report && typeof report.roadworthy === 'boolean' && report.roadworthyReason.trim().length > 0;
  const outcome = hasEvent(bundle, 'repair_authorised', 'total_loss_confirmed');
  return [
    { label: 'Engineer instructed (dated event)', present: hasEvent(bundle, 'engineer_instructed'), collect: 'Log the engineer_instructed event with the instruction date' },
    { label: 'Inspection (dated event)', present: hasEvent(bundle, 'inspection'), collect: 'Log the inspection event with the date and place of inspection' },
    { label: 'Engineer report issued (dated event)', present: hasEvent(bundle, 'report_issued'), collect: 'Log the report_issued event when the engineer issues the report' },
    { label: 'Repair authorised or total loss confirmed (dated event)', present: outcome, collect: 'Log repair_authorised (with the authorising insurer) or total_loss_confirmed' },
    {
      label: `Roadworthiness recorded on the engineer report (${report ? (report.roadworthy ? 'roadworthy' : 'unroadworthy') : '—'})`,
      present: roadworthyRecorded,
      collect: 'Engineer report must state whether the vehicle was roadworthy and why (period depends on it)'
    }
  ];
}

const BHR_PATTERN = /\bbhr\b|basic hire rate/i;

function rateItems(bundle: ClaimBundle): Item[] {
  if (bundle.hire.length === 0) {
    return [{ label: 'Hire agreement on file', present: false, collect: 'No hire agreement on file: record the hire before the rate gate can be assessed' }];
  }
  const many = bundle.hire.length > 1;
  const items: Item[] = [];
  for (const h of bundle.hire) {
    const p = hireLabel(h, many);
    items.push({
      label: `${p}Agreement daily rate recorded (${h.dailyRatePence > 0 ? `${formatGBP(h.dailyRatePence)}/day ex VAT` : '—'})`,
      present: h.dailyRatePence > 0,
      collect: `${p}Record the agreed daily rate (ex VAT) on the hire agreement`
    });
    items.push({
      label: `${p}GTA group recorded (${h.gtaGroup || '—'})`,
      present: !!h.gtaGroup && h.gtaGroup.trim().length > 0,
      collect: `${p}Map the hire vehicle to its GTA group (benchmark only; CCGUK is not a subscriber)`
    });
  }
  const bhr = bundle.evidence.filter((e) => (e.kind === 'screenshot' || e.kind === 'pdf' || e.kind === 'document') && BHR_PATTERN.test(e.description ?? ''));
  items.push({
    label: `BHR comparator evidence (${bhr.length} date-stamped screenshot${bhr.length === 1 ? '' : 's'})`,
    present: bhr.length >= 1,
    collect: 'Capture at least one basic hire rate comparator: date-stamped screenshot of a mainstream local supplier quote for a like-for-like vehicle, description containing "BHR" or "basic hire rate"'
  });
  return items;
}

const INCOME_PATTERN = /payslip|income|sa302|tax return|accounts|universal credit|benefit|pension|p60|wage/i;

function impecuniosityItems(bundle: ClaimBundle): Item[] {
  const statement = docOnFile(bundle, 'form.statement_of_means');
  const bankStatements = bundle.evidence.filter((e) => e.kind === 'bank_statement');
  // a bank statement is not income evidence however it is described ("accounts", "benefit" credits)
  const income = bundle.evidence.filter((e) => e.kind === 'payslip' || (e.kind !== 'bank_statement' && INCOME_PATTERN.test(e.description ?? '')));
  return [
    {
      label: 'Signed statement of means (form.statement_of_means)',
      present: !!statement,
      collect: docDrafted(bundle, 'form.statement_of_means')
        ? 'Statement of means is drafted but not signed: get it signed (form.statement_of_means)'
        : 'Signed statement of means: income, outgoings, savings, credit limits and balances, dependants (form.statement_of_means)'
    },
    {
      label: `Bank statements for all accounts (${bankStatements.length} of 3 months on file)`,
      present: bankStatements.length >= 3,
      collect: `Upload 3 months' bank statements for every account (${bankStatements.length} on file, ${Math.max(0, 3 - bankStatements.length)} more needed)`
    },
    {
      label: `Income evidence (${income.length} item${income.length === 1 ? '' : 's'})`,
      present: income.length >= 1,
      collect: 'Upload at least one item of income evidence: payslip, SA302/tax return, accounts or benefit award letter'
    }
  ];
}

function mitigationItems(bundle: ClaimBundle): Item[] {
  const questionnaire = docOnFile(bundle, 'form.mitigation_questionnaire');
  const offers = bundle.offers;
  const undecided = offers.filter((o) => o.clientDecision === 'pending');
  const unanswered = offers.filter((o) => !o.replySentAt);
  return [
    {
      label: 'Mitigation questionnaire with statement of truth signed (GTA Appendix C format, benchmark only)',
      present: !!questionnaire,
      collect: docDrafted(bundle, 'form.mitigation_questionnaire')
        ? 'Mitigation questionnaire is drafted but not signed: get it signed (form.mitigation_questionnaire)'
        : 'Signed mitigation questionnaire recording every offer, the client decision and reasons (form.mitigation_questionnaire)'
    },
    {
      label: offers.length === 0 ? 'No intervention offers logged (client asked at FNOL: what, by whom, when)' : `Client decision recorded for every logged offer (${offers.length})`,
      present: undecided.length === 0,
      collect: `Record the client's decision and reasons for ${undecided.length} pending intervention offer${undecided.length === 1 ? '' : 's'} (${undecided.map((o) => `${o.offerorName} ${day(o.receivedAt)}`).join('; ')})`
    },
    {
      label: offers.length === 0 ? 'No intervention offers awaiting a written reply' : `Written reply sent for every logged offer (${offers.length})`,
      present: unanswered.length === 0,
      collect: `Send and log a written reply (within 1 working day) to ${unanswered.length} offer${unanswered.length === 1 ? '' : 's'} (${unanswered.map((o) => `${o.offerorName} ${day(o.receivedAt)}`).join('; ')})`
    }
  ];
}

function enforceabilityItems(bundle: ClaimBundle): Item[] {
  if (bundle.hire.length === 0) {
    return [{ label: 'Hire agreement on file', present: false, collect: 'No hire agreement on file: record the hire before enforceability can be assessed' }];
  }
  const many = bundle.hire.length > 1;
  const items: Item[] = [];
  for (const h of bundle.hire) {
    const p = hireLabel(h, many);
    const e = h.enforceability;
    items.push({
      label: `${p}Cancellation information provided (CCR 2013 Sch 2)${e.cancellationInfoProvidedAt ? ` on ${day(e.cancellationInfoProvidedAt)}` : ''}`,
      present: !!e.cancellationInfoProvidedAt,
      collect: `${p}Provide and record the pre-contract cancellation information (Consumer Contracts Regulations 2013 Sch 2)`
    });
    items.push({
      label: `${p}Schedule 3 cancellation form provided${e.schedule3FormProvidedAt ? ` on ${day(e.schedule3FormProvidedAt)}` : ''}`,
      present: !!e.schedule3FormProvidedAt,
      collect: `${p}Provide and record the Sch 3 model cancellation form (form.cancellation_sch3)`
    });
    items.push({
      label: `${p}Express request to start during the cancellation period${e.expressRequestToStartAt ? ` on ${day(e.expressRequestToStartAt)}` : ''}`,
      present: !!e.expressRequestToStartAt,
      collect: `${p}Obtain the client's express written request to start the hire within the 14-day cancellation period (reg 36; form.express_request_to_start)`
    });
    items.push({
      label: `${p}Agreement signed${h.signedAt ? ` on ${day(h.signedAt)}` : ''}`,
      present: !!h.signedAt,
      collect: `${p}Get the hire agreement e-signed (OTP, hash and certificate)`
    });
    items.push({
      label: `${p}CCA 1974 / RAO art 60F exemption met (≤12 payments within 12 months, no interest or charges)`,
      present: e.cca60fCompliant === true,
      collect: `${p}Confirm the agreement fits the art 60F exemption: repayable in 12 or fewer payments within 12 months with no interest or charges`
    });
  }
  return items;
}

function liabilityItems(bundle: ClaimBundle): Item[] {
  const acc = bundle.claim.accident;
  const circumstances = (acc.circumstances ?? '').trim().length >= 20;
  const tpReg = !!bundle.thirdPartyVehicle?.registration;
  const tpInsurer = !!bundle.atFaultInsurer || !!bundle.claim.atFaultInsurerId;
  const cctv = acc.cctvAvailable === true || bundle.evidence.some((e) => e.kind === 'cctv');
  const dashcam = acc.dashcamAvailable === true || bundle.evidence.some((e) => e.kind === 'dashcam');
  const witness = acc.independentWitness === true;
  const police = !!acc.policeReference && acc.policeReference.trim().length > 0;
  const sources = [cctv && 'CCTV', dashcam && 'dashcam', witness && 'independent witness', police && `police reference ${acc.policeReference}`].filter((x): x is string => !!x);
  return [
    { label: "Client's account of the circumstances recorded verbatim", present: circumstances, collect: "Record the client's own account of the circumstances, taken cold and verbatim (at least a full sentence)" },
    {
      label: `Third party identified (${[tpReg && `registration ${bundle.thirdPartyVehicle?.registration}`, tpInsurer && 'insurer known'].filter(Boolean).join(', ') || '—'})`,
      present: tpReg || tpInsurer,
      collect: 'Identify the third party: vehicle registration (then askMID for the insurer) or the at-fault insurer'
    },
    {
      label: `Independent source of liability evidence (${sources.join(', ') || '—'})`,
      present: sources.length >= 1,
      collect: 'Obtain at least one independent source: CCTV (preservation request now), dashcam, an independent witness, or a police reference'
    }
  ];
}

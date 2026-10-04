/**
 * Codified get-paid-faster rules (BLUEPRINT §7; playbooks.md §3). The knowledge base mirrors this list in
 * `kb/data/playbook-rules.json` and may inject it back through `nextActions(…, { rules })` so titles,
 * citations and template ids can be maintained without touching the engine. The engine's triggers are
 * code; `trigger` here is the plain-English description of them.
 *
 * GTA paragraphs are a commercial benchmark for a non-subscriber (GTA 2.7(j)) — never cited as law.
 */
import type { PlaybookAction } from '../types.js';

export interface PlaybookRule {
  code: string;
  title: string;
  basis: string[];
  templateId?: string;
  /** Plain-English description of when the engine raises the action. */
  trigger: string;
  /** Minimum urgency when the action is raised (the engine may raise it further from the due date). */
  defaultPriority?: PlaybookAction['priority'];
}

export const GTA_BENCHMARK = 'GTA (16 March 2026 wording) — industry benchmark only; CCGUK is not a subscriber (GTA 2.7(j))';
export const REGISTERED_NAME = 'Courtesy Cars Group UK Ltd';
export const COMPANY_NUMBER = '17430389';

export const defaultPlaybookRules: PlaybookRule[] = [
  {
    code: 'SEND_NCAF',
    title: 'Send the New Claim Advice Form to the at-fault insurer',
    basis: ['GTA 4.1 — NCAF within 1 working day of agreeing services', GTA_BENCHMARK, 'ICOBS 8.2.6R — the three-month clock runs from notification', 'BLUEPRINT §7.1'],
    templateId: 'letter.ncaf',
    trigger: 'No ncaf_sent event. Due per the gta_4_1_ncaf_1wd clock (fallback: 1 working day from services agreed / hire start / FNOL).',
    defaultPriority: 'today',
  },
  {
    code: 'REQUEST_HANDLING_REF',
    title: 'Obtain the handling centre and claim reference',
    basis: ['GTA 4.2 — insurer provides handling centre and reference within 5 working days of the NCAF', GTA_BENCHMARK, 'BLUEPRINT §7.1'],
    templateId: 'letter.handling_ref_request',
    trigger: 'NCAF sent and no handling_ref_received. Due per the gta_4_2_handling_ref_5wd clock.',
  },
  {
    code: 'REQUEST_CCTV',
    title: 'Send CCTV / dashcam preservation request',
    basis: ['BLUEPRINT §7.2 — CCTV requests within days 1–7; footage is overwritten within weeks', 'evidence.md — preservation first: the single highest-value action on a disputed-liability file'],
    templateId: 'letter.cctv_preservation',
    trigger: 'Within 7 days of the accident when CCTV or dashcam is available, or the location is a junction, roundabout or high street, and no cctv_request_sent event exists.',
    defaultPriority: 'today',
  },
  {
    code: 'REPLY_TO_INTERVENTION_OFFER',
    title: 'Written reply to the insurer’s intervention offer',
    basis: ['BLUEPRINT §3.6 — written reply within 1 working day of every offer', 'Copley v Lawn [2009] EWCA Civ 580', 'Opoku v Tintas [2013] EWCA Civ 1299', 'playbooks.md §3 — silence loses cases that reasons would have won'],
    templateId: 'letter.intervention_reply',
    trigger: 'Each intervention offer without replySentAt. Due 1 working day from receipt. Never blocked.',
    defaultPriority: 'now',
  },
  {
    code: 'COLLECT_IMPECUNIOSITY_EVIDENCE',
    title: 'Collect statement of means, 3 months’ bank statements and income evidence',
    basis: ['Diriye v Bojaj [2020] EWCA Civ 1400 — impecuniosity must be pleaded and proved by the claimant', 'Lagden v O’Connor [2003] UKHL 64', 'MIB v Houston [2025] EWHC 3178 (KB) — debarring-order wording', 'BLUEPRINT §2 finding 5, §6'],
    templateId: 'form.statement_of_means',
    trigger: 'Impecuniosity gate not green. Due before the hire starts where possible; otherwise now.',
  },
  {
    code: 'FIX_ENFORCEABILITY',
    title: 'Cure the hire agreement’s cancellation / CCA defects',
    basis: ['W v Veolia [2011] EWHC 2020 (QB)', 'Dimond v Lovell [2002] 1 AC 384', 'Consumer Contracts Regulations 2013 regs 29–36, Sch 2, Sch 3', 'CCA 1974 / RAO art 60F', 'BLUEPRINT §5.2'],
    trigger: 'Enforceability gate not green while a hire agreement exists. Value at risk: the whole hire.',
  },
  {
    code: 'SEND_COLLECT_OR_PAY',
    title: 'Send collect-or-pay notice to insurer and client',
    basis: ['BLUEPRINT §3.4 — insurers cap storage at report + 48 hours (live File 2)', 'Storage end triggers: report issued, total loss confirmed, payment, collection'],
    templateId: 'letter.collect_or_pay',
    trigger: 'report_issued while storage is open and no collect_or_pay_notice_sent since the report. Due report + 48 hours.',
    defaultPriority: 'today',
  },
  {
    code: 'SEND_DELAY_NOTICE',
    title: 'Send delay notice (repair authorisation / monitoring)',
    basis: ['GTA 4.10 — authorisation check 3 working days after the estimate', 'GTA 4.11 — delay notice where the delay is ≥2 working days or >20% of the estimate', GTA_BENCHMARK, 'BLUEPRINT §3.3'],
    templateId: 'letter.delay_notice_gta_4_10',
    trigger: 'gta_4_10 or gta_4_11 clock breached, or a repair_delay event without a delay notice after it.',
    defaultPriority: 'now',
  },
  {
    code: 'END_HIRE_NOW',
    title: 'End the hire — off-hire trigger has fired',
    basis: ['GTA 4.8 — off-hire within 24 hours of repair completion', 'GTA 4.9 — within 1 working day of insurer termination notice', 'GTA 4.14 — within 5 working days of total-loss payment', GTA_BENCHMARK, 'BLUEPRINT §3.3 (lesson d)'],
    trigger: 'An off-hire clock (gta_4_8 / 4_9 / 4_14) is running or breached while a hire agreement is open.',
    defaultPriority: 'today',
  },
  {
    code: 'SEND_PAYMENT_PACK',
    title: 'Send the clean payment pack',
    basis: ['GTA 6.1–6.3 — covering letter, mitigation questionnaire, advice form, hire period validation form, engineer’s report, storage and recovery accounts', 'GTA 6.7 — settlement within one calendar month of a clean pack', GTA_BENCHMARK, 'BLUEPRINT §7.3'],
    templateId: 'pack.gta_payment',
    trigger: 'All hire agreements ended and no payment_pack_sent. Blocked by every gate that is not green.',
  },
  {
    code: 'SPLIT_HEADS_INTERIM',
    title: 'Demand payment of the undisputed heads now; interim payment on hire',
    basis: ['BLUEPRINT §7.4 — pay undisputed heads (PAV, recovery) now and dispute hire separately', 'CPR 25.6–25.9 (r.25.7 interim payment once litigated)', 'money.md §4 — never concede a head to buy speed'],
    templateId: 'letter.chaser_7',
    trigger: 'A reduction_received event disputes hire only (data.disputedHeads = ["hire"]) and the undisputed heads are unpaid.',
    defaultPriority: 'today',
  },
  {
    code: 'CHASER_7',
    title: 'Chaser 1 (day 7)',
    basis: ['BLUEPRINT §7.8 — chaser cadence day 7, 14, 21 → complaint day 28', 'GTA 6.7 — one calendar month to settle a clean pack', GTA_BENCHMARK],
    templateId: 'letter.chaser_7',
    trigger: 'chaser_day_7 clock running or breached.',
  },
  {
    code: 'CHASER_14',
    title: 'Chaser 2 — team leader (day 14)',
    basis: ['BLUEPRINT §7.8 — escalate to team leader at day 14'],
    templateId: 'letter.chaser_14',
    trigger: 'chaser_day_14 clock running or breached and chaser 1 sent.',
  },
  {
    code: 'CHASER_21',
    title: 'Chaser 3 — claims manager (day 21)',
    basis: ['BLUEPRINT §7.8 — escalate to claims manager at day 21'],
    templateId: 'letter.chaser_21',
    trigger: 'chaser_day_21 clock running or breached and chaser 2 sent.',
  },
  {
    code: 'COMPLAINT_28',
    title: 'Formal complaint to the insurer (DISP 1)',
    basis: ['DISP 1 — eight-week final response', 'ICOBS 8.1 — prompt and fair claims handling', 'ICOBS 8.2.6R — reasoned offer or reply within three months', 'DISP 2.7 — a third-party claimant cannot refer the at-fault insurer to the FOS: do not threaten it', 'BLUEPRINT §7.5, §7.8'],
    templateId: 'letter.complaint_disp',
    trigger: 'complaint_day_28 clock running or breached.',
  },
  {
    code: 'SEND_DSAR',
    title: 'DSAR to the insurer for call recordings of the alleged offer',
    basis: ['UK GDPR Art 15 — one calendar month', 'BLUEPRINT §7.5', 'playbooks.md §9 — draft wide and specific: call recordings, notes, decision rationale'],
    templateId: 'letter.dsar',
    trigger: 'An inbound event alleges an intervention offer that is not in the register (data.allegedOffer = true or data.reason = "offer_ignored") and no dsar_sent follows it.',
    defaultPriority: 'today',
  },
  {
    code: 'ICOBS_INTEREST_CLAIM',
    title: 'Add ICOBS 8.2 interest (base + 4%) to the claim',
    basis: ['ICOBS 8.2.6R — three months to a reasoned offer or reply', 'ICOBS 8.2.9R–8.2.11R — interest at base + 4%', 'ICOBS 8.2.1R — territorial scope to be confirmed before asserting as of right (BLUEPRINT §10)'],
    trigger: 'icobs_8_2_6_three_months clock breached. Value = interest estimate on the outstanding balance.',
    defaultPriority: 'this_week',
  },
  {
    code: 'LETTER_BEFORE_CLAIM',
    title: 'Letter before claim (draft for the claimant as litigant in person)',
    basis: ['Practice Direction — Pre-Action Conduct paras 6, 13–16', 'Legal Services Act 2007 s.12 — CCGUK prepares; the claimant or an instructed solicitor signs and conducts', 'BLUEPRINT §7.6'],
    templateId: 'letter.letter_before_claim',
    trigger: 'Complaint window (DISP 8 weeks) passed, or final response received, without settlement, and no letter_before_claim_sent.',
    defaultPriority: 'this_week',
  },
  {
    code: 'PART36_OFFER',
    title: 'Part 36 offer at issue (draft for the claimant)',
    basis: ['CPR 36.5(1)(c) — relevant period not less than 21 days', 'CPR 36.17(4) — consequences for the defendant', 'BLUEPRINT §7.6', 'Legal Services Act 2007 s.12'],
    templateId: 'letter.part36_offer',
    trigger: 'proceedings_issued and no part36_sent.',
    defaultPriority: 'this_week',
  },
  {
    code: 'DEFAULT_JUDGMENT',
    title: 'Request default judgment (claimant / solicitor files; CCGUK prepares)',
    basis: ['CPR 12.3 — no acknowledgment of service or defence in time', 'CPR 10.3, 15.4', 'Legal Services Act 2007 s.12', 'BLUEPRINT §7.6'],
    trigger: 'default_judgment_14_days clock breached with no defence received.',
    defaultPriority: 'now',
  },
  {
    code: 'VENDOR_VERIFICATION_PACK',
    title: 'Send vendor-verification pack (bank letter, certificate of incorporation, registered office, director ID)',
    basis: [`BLUEPRINT §7.7 — account in the exact registered name "${REGISTERED_NAME}" (company ${COMPANY_NUMBER}) for a Confirmation of Payee full match`, 'Live File 1 — "bank details could not be validated"'],
    templateId: 'letter.vendor_verification_pack',
    trigger: 'A reduction_received / note event with data.reason "bank_validation", or no payment after the pack from an insurer that has never paid CCGUK before.',
    defaultPriority: 'today',
  },
  {
    code: 'REFER_INJURY',
    title: 'Refer the personal injury element out (no referral fee)',
    basis: ['LASPO 2012 ss.56–60 — referral-fee ban', 'FCA claims-management perimeter (RAO art 89G onwards)', 'BLUEPRINT §3.1 (lesson j)'],
    trigger: 'accident.injuries and no injuryReferral on the claim.',
    defaultPriority: 'today',
  },
  {
    code: 'FLAG_CONNECTED_WITNESS',
    title: 'Witness connected to the claimant — corroborate independently',
    basis: ['BLUEPRINT §3.9 (lesson g) — non-independent witness flagged; seek CCTV or the third party’s own admission'],
    trigger: 'An uncleared NON_INDEPENDENT_WITNESS flag.',
    defaultPriority: 'today',
  },
  {
    code: 'MONITOR_SUPPLIER',
    title: 'Supplier at high risk — qualify an alternative and expect invoice challenges',
    basis: ['BLUEPRINT §3.11 (lesson k) — CARFLEX LTD (12640635) strike-off; Companies House watch'],
    trigger: 'An uncleared SUPPLIER_HIGH_RISK flag.',
    defaultPriority: 'this_week',
  },
];

export const playbookRuleCodes: readonly string[] = defaultPlaybookRules.map((r) => r.code);

export function findRule(code: string, rules?: PlaybookRule[]): PlaybookRule {
  const injected = rules?.find((r) => r.code === code);
  if (injected) return injected;
  const def = defaultPlaybookRules.find((r) => r.code === code);
  if (!def) throw new Error(`playbook: no rule for code ${code}`);
  return def;
}

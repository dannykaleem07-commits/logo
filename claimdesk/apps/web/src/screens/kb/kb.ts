/**
 * Knowledge-base screen model (pure; unit-tested). BLUEPRINT §5 (cited, retrieval-based, human-approved) and §7
 * (get-paid-faster playbook). The search and advisor run server-side (@ccguk/kb via the API); this module only
 * labels things, orders the plan and tells unverified citations apart so they can be shown with a warning.
 *
 * TODO wire when @ccguk/api lands: GET /kb/advise may return `forumChecks`, `unverifiedCitations` and `perimeter`
 * alongside the contract's {summary, points, caveats}; `KbAdviceView` below reads them when present.
 */
import type { KbEntry, KbEntryType, Verification } from '@ccguk/domain';
import type { KbAdvice } from '../../api/client';

export const KB_TYPE_LABEL: Record<KbEntryType, string> = {
  case: 'Case',
  statute: 'Statute',
  cpr: 'CPR',
  practice_direction: 'Practice Direction',
  gta: 'GTA (benchmark)',
  fca_handbook: 'FCA Handbook',
  fos: 'FOS',
  guidance: 'Guidance',
  code_of_practice: 'Code of practice',
  fee: 'Fee'
};
export const KB_TYPES = Object.keys(KB_TYPE_LABEL) as KbEntryType[];

/** Topics as tagged in packages/kb/data (plus the advisor's composite topics). */
export const KB_TOPICS: Array<{ value: string; label: string }> = [
  { value: 'credit_hire', label: 'Credit hire (general)' },
  { value: 'need', label: 'Need for a replacement vehicle' },
  { value: 'period', label: 'Hire period' },
  { value: 'bhr', label: 'Rate / basic hire rate' },
  { value: 'impecuniosity', label: 'Impecuniosity' },
  { value: 'mitigation', label: 'Mitigation' },
  { value: 'intervention', label: 'Intervention offers' },
  { value: 'enforceability', label: 'Enforceability of the agreement' },
  { value: 'loss_of_use', label: 'Loss of use' },
  { value: 'pav', label: 'Pre-accident value' },
  { value: 'repair', label: 'Repair' },
  { value: 'salvage', label: 'Salvage' },
  { value: 'interest', label: 'Interest' },
  { value: 'costs', label: 'Costs' },
  { value: 'non_party_costs', label: 'Non-party costs (Tescher)' },
  { value: 'dishonesty', label: 'Fundamental dishonesty' },
  { value: 'liability', label: 'Liability' },
  { value: 'limitation', label: 'Limitation' },
  { value: 'complaints', label: 'Complaints (DISP / ICOBS)' },
  { value: 'dsar', label: 'DSAR' },
  { value: 'pcn', label: 'PCN / NIP / s.172' },
  { value: 'fleet', label: 'Fleet compliance' },
  { value: 'gta', label: 'GTA (industry benchmark)' }
];

export function topicLabel(value: string): string {
  return KB_TOPICS.find((t) => t.value === value)?.label ?? value.replace(/_/g, ' ');
}

export const GTA_BENCHMARK_NOTE = 'GTA terms are an industry benchmark only — CCGUK is not a subscriber and GTA 2.7(j) says they have no relevance in law for non-subscribers.';

export function isUnverified(v: Verification | undefined): boolean {
  return !v || v.status !== 'verified';
}

/** Citation chip data for a point: resolves ids against the returned entries when the API embeds them. */
export interface CitationChip {
  id: string;
  label: string;
  unverified: boolean;
  url?: string;
  title?: string;
}

export function citationChips(ids: string[], entries: KbEntry[] | undefined): CitationChip[] {
  return ids.map((id) => {
    const e = entries?.find((x) => x.id === id);
    return e ? { id, label: e.citation, unverified: isUnverified(e.verification), url: e.url, title: e.title } : { id, label: id, unverified: true, title: 'Not in the returned entries — verification unknown' };
  });
}

/** Distinct unverified citation ids across the advice (API-provided list first, else derived). */
export function unverifiedCitations(advice: KbAdviceView): string[] {
  if (advice.unverifiedCitations) return [...new Set(advice.unverifiedCitations)];
  const ids = new Set<string>();
  for (const p of advice.points) for (const c of p.citations) if (citationChips([c], advice.entries)[0]?.unverified) ids.add(c);
  return [...ids];
}

export interface ForumCheck {
  forum: string;
  open: boolean;
  basis: string;
}

export interface KbAdviceView extends KbAdvice {
  topic?: string;
  forumChecks?: ForumCheck[];
  unverifiedCitations?: string[];
  perimeter?: string[];
}

/**
 * Forum checks shown when the API does not return its own (ARCHITECTURE convention 8 / FORUM_NOT_OPEN).
 * Statements are deliberately narrow: which door is open to CCGUK's claimant against the at-fault insurer.
 */
export const DEFAULT_FORUM_CHECKS: ForumCheck[] = [
  { forum: 'Financial Ombudsman Service against the at-fault insurer', open: false, basis: 'DISP 2.7: a third-party claimant is not an eligible complainant against an insurer it has no policy with. Never name the FOS in a letter to the at-fault insurer.' },
  { forum: "Complaint to the at-fault insurer's own complaints process", open: true, basis: 'Write to the insurer citing ICOBS 8.1 (claims handled promptly and fairly) and ICOBS 8.2.6R; a written complaint on day 28 of the chaser cadence. The DISP eight-week final-response timetable is the insurer’s own benchmark here, not a route to the FOS.' },
  { forum: 'County Court (small claims / fast track)', open: true, basis: 'Limitation Act 1980 s.2: six years in tort. Letter before claim first (PD Pre-Action Conduct); interest under s.69 County Courts Act 1984.' },
  { forum: 'Claimant’s own insurer / FOS', open: true, basis: 'Only for the claimant about their own policy (e.g. excess, own-damage handling) — the claimant, not CCGUK, is the eligible complainant.' }
];

// ---------------------------------------------------------------------------
// Get-paid-faster plan (BLUEPRINT §7, mirrors packages/kb/data/playbook-rules.json)
// ---------------------------------------------------------------------------

export interface PlanStep {
  order: number;
  code: string;
  stage: string;
  title: string;
  why: string;
  templateId?: string;
  basis: string[];
  benchmarkOnly?: boolean;
}

export const PLAN_STAGE_LABEL: Record<string, string> = {
  day_1: 'Day 1',
  days_1_7: 'Days 1–7',
  sign_up: 'Sign-up',
  during_hire: 'During hire',
  hire_end: 'Hire ends',
  payment: 'Payment',
  chase: 'Chasers',
  escalation: 'Escalation',
  litigation: 'Litigation',
  onboarding: 'Vendor onboarding',
  perimeter: 'Perimeter'
};

/** TODO wire when @ccguk/kb lands an API route for playbook rules: replace this mirror with GET /kb/playbook. */
export const GET_PAID_FASTER_PLAN: PlanStep[] = [
  { order: 10, code: 'SEND_NCAF', stage: 'day_1', title: 'Send the New Claim Advice Form to the at-fault insurer', why: 'Within 1 working day of agreeing services (GTA 4.1 benchmark); starts the ICOBS 8.2.6R three-month clock to a reasoned offer or reply.', templateId: 'letter.ncaf', basis: ['GTA 4.1', 'ICOBS 8.2.6R', 'GTA 2.7(j)'], benchmarkOnly: true },
  { order: 20, code: 'REQUEST_HANDLING_REF', stage: 'day_1', title: 'Ask for the handling centre and claim reference', why: 'A payment pack sent to the wrong centre does not start the settlement month (GTA 4.2: 5 working days; GTA 6.7).', templateId: 'letter.handling_ref_request', basis: ['GTA 4.2', 'GTA 6.7'], benchmarkOnly: true },
  { order: 30, code: 'REQUEST_CCTV', stage: 'days_1_7', title: 'Request CCTV, dashcam, witness and police evidence', why: 'Council and TfL footage is overwritten within weeks; Met collision report £215.10 / third-party details £49.00 (2026 fee schedule).', templateId: 'letter.cctv_preservation', basis: ['Evidence gate: liability'] },
  { order: 40, code: 'REPLY_TO_INTERVENTION_OFFER', stage: 'during_hire', title: "Reply in writing to the insurer's replacement-vehicle offer", why: 'Within 1 working day of any offer; the register and the reply defeat "the offer was ignored" (lesson c).', templateId: 'letter.intervention_reply', basis: ['Copley v Lawn [2009] EWCA Civ 580', 'GTA Appendix C'], benchmarkOnly: true },
  { order: 50, code: 'COLLECT_IMPECUNIOSITY_EVIDENCE', stage: 'sign_up', title: 'Collect the Statement of Means and three months of bank statements', why: 'Impecuniosity must be pleaded and proved from day one (Diriye v Bojaj); a debarring order can cost rate and period (MIB v Houston).', templateId: 'form.statement_of_means', basis: ['Diriye v Bojaj [2020] EWCA Civ 1400', 'MIB v Houston [2025] EWHC 3178 (KB)'] },
  { order: 60, code: 'FIX_ENFORCEABILITY', stage: 'sign_up', title: 'Close the enforceability gap in the hire agreement', why: 'Cancellation information, Sch 3 form and the express request to start must be on file or the charges are irrecoverable.', templateId: 'form.cancellation_sch3', basis: ['CCR 2013 regs 29, 36, Sch 3', 'Dimond v Lovell [2002] 1 AC 384'] },
  { order: 70, code: 'SEND_COLLECT_OR_PAY', stage: 'during_hire', title: 'Collect-or-pay notice on engineer’s-report day', why: 'Insurers cap storage at report + 48 h (File 2); the notice makes further storage the insurer’s choice.', templateId: 'letter.collect_or_pay', basis: ['BLUEPRINT §3.4'] },
  { order: 80, code: 'SEND_DELAY_NOTICE', stage: 'during_hire', title: 'Send a repair-delay notice', why: 'Delay ≥ 2 working days or > 20% of the estimate: tell the insurer at the time, not in the pack (GTA 4.10–4.11 benchmark).', templateId: 'letter.delay_notice_gta_4_10', basis: ['GTA 4.10', 'GTA 4.11'], benchmarkOnly: true },
  { order: 90, code: 'END_HIRE_NOW', stage: 'hire_end', title: 'End the hire when an off-hire trigger fires', why: 'Repair complete → 24 h (GTA 4.8); TL payment → 5 WD (GTA 4.14); termination notice → 1 WD (GTA 4.9); cash in lieu → on receipt (GTA 4.7).', templateId: 'invoice.hire', basis: ['GTA 4.7', 'GTA 4.8', 'GTA 4.9', 'GTA 4.14'], benchmarkOnly: true },
  { order: 100, code: 'SEND_PAYMENT_PACK', stage: 'hire_end', title: 'Send the clean payment pack the day hire ends', why: 'Covering letter, Mitigation Questionnaire, Advice Form, Hire Period Validation Form, engineer’s report, storage and recovery accounts (GTA 6.1–6.3); settlement within one month of a clean pack (GTA 6.7).', templateId: 'pack.gta_payment', basis: ['GTA 6.1–6.3', 'GTA 6.7', 'GTA 6.8.6'], benchmarkOnly: true },
  { order: 110, code: 'SPLIT_HEADS_INTERIM', stage: 'payment', title: 'Split the heads: undisputed heads now, hire separately', why: 'PAV and recovery paid now; ask for an interim payment and apply under CPR 25.7 if litigated.', templateId: 'schedule.loss', basis: ['CPR 25.7'] },
  { order: 120, code: 'CHASER_7', stage: 'chase', title: 'Day 7 chaser to the handler', why: 'Cadence 7 / 14 / 21 → complaint at 28; every step logged on the ledger.', templateId: 'letter.chaser_7', basis: ['BLUEPRINT §7.8'] },
  { order: 130, code: 'CHASER_14', stage: 'chase', title: 'Day 14 chaser to the team leader', why: 'Escalate one level per week.', templateId: 'letter.chaser_14', basis: ['BLUEPRINT §7.8'] },
  { order: 140, code: 'CHASER_21', stage: 'chase', title: 'Day 21 chaser to the claims manager', why: 'Last chaser before the formal complaint.', templateId: 'letter.chaser_21', basis: ['BLUEPRINT §7.8'] },
  { order: 150, code: 'COMPLAINT_28', stage: 'escalation', title: 'Formal complaint to the insurer at day 28', why: 'Cite ICOBS 8.1 and 8.2; the insurer’s complaints process is open to us — the FOS is not (DISP 2.7).', templateId: 'letter.complaint_disp', basis: ['ICOBS 8.1', 'ICOBS 8.2.6R', 'DISP 1', 'DISP 2.7 (forum not open)'] },
  { order: 160, code: 'SEND_DSAR', stage: 'escalation', title: 'DSAR to the insurer for call recordings and claim notes', why: 'One month to respond (UK GDPR art 15 / DPA 2018); evidence for alleged intervention offers.', templateId: 'letter.dsar', basis: ['UK GDPR art 15', 'DPA 2018 s.45'] },
  { order: 170, code: 'ICOBS_INTEREST_CLAIM', stage: 'escalation', title: 'Add ICOBS 8.2.9R interest (base + 4%) to the schedule', why: 'From the end of the three-month period where the insurer has not made a reasoned reply (ICOBS 8.2.9R–8.2.11R; confirm 8.2.1R scope).', templateId: 'schedule.loss', basis: ['ICOBS 8.2.9R', 'ICOBS 8.2.10R', 'ICOBS 8.2.11R'] },
  { order: 180, code: 'LETTER_BEFORE_CLAIM', stage: 'litigation', title: 'Letter before claim', why: 'Practice Direction on Pre-Action Conduct; drafted for the claimant (litigant in person) or an instructed solicitor to sign.', templateId: 'letter.letter_before_claim', basis: ['PD Pre-Action Conduct paras 6, 13–16'] },
  { order: 190, code: 'PART36_OFFER', stage: 'litigation', title: 'Claimant’s Part 36 offer at issue', why: '21-day relevant period; costs consequences under CPR 36.17.', templateId: 'letter.part36_offer', basis: ['CPR 36.5', 'CPR 36.17'] },
  { order: 200, code: 'DEFAULT_JUDGMENT', stage: 'litigation', title: 'Request default judgment when no acknowledgment or defence is filed', why: '14 days after service of the particulars (CPR 12.3); interest under s.69 CCA 1984.', basis: ['CPR 12.3', 'County Courts Act 1984 s.69'] },
  { order: 210, code: 'VENDOR_VERIFICATION_PACK', stage: 'onboarding', title: 'Send the vendor verification pack so payment is not bounced', why: 'Bank letter on bank letterhead, certificate of incorporation (17430389), proof of registered office, director ID; account name exactly "Courtesy Cars Group UK Ltd" for Confirmation of Payee (File 1 lesson).', templateId: 'letter.vendor_verification_pack', basis: ['BLUEPRINT §7.7'] },
  { order: 220, code: 'REFER_INJURY', stage: 'perimeter', title: 'Refer any injury element to a solicitor, no fee', why: 'CCGUK handles damage-only; an injury referral is logged with no fee taken (lesson j).', basis: ['Perimeter: no regulated activity'] }
];

export function planByStage(plan: PlanStep[] = GET_PAID_FASTER_PLAN): Array<{ stage: string; label: string; steps: PlanStep[] }> {
  const order = Object.keys(PLAN_STAGE_LABEL);
  const groups = new Map<string, PlanStep[]>();
  for (const s of [...plan].sort((a, b) => a.order - b.order)) groups.set(s.stage, [...(groups.get(s.stage) ?? []), s]);
  return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([stage, steps]) => ({ stage, label: PLAN_STAGE_LABEL[stage] ?? stage, steps }));
}

/** Search results: verified first, then by citation, so an unverified hit never leads. */
export function sortResults(entries: KbEntry[]): KbEntry[] {
  return [...entries].sort((a, b) => Number(isUnverified(a.verification)) - Number(isUnverified(b.verification)));
}

export const LICENCE_NOTE: Record<NonNullable<KbEntry['licence']>, string> = {
  OGL: 'Open Government Licence — may be quoted.',
  'Open Justice Licence': 'Find Case Law — principle and link only unless a computational-analysis licence is recorded.',
  link_only: 'Link only (e.g. BAILII) — do not reproduce the text.',
  quote_only: 'Short quotes with a link only (CPR / FCA Handbook).'
};

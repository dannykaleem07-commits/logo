/**
 * Static definitions for every ClockKind: the label shown in the UI, the basis citation printed
 * in letters, and a plain-English description. The citations are written exactly as the
 * blueprint states them. GTA paragraphs are a benchmark for a non-subscriber (GTA 2.7(j)), never
 * law — the wording says so wherever a GTA clock could reach a letter.
 */
import type { ClockKind } from '../types.js';

export interface ClockDefinition {
  label: string;
  basis: string;
  description: string;
  /** Who the clock is on by default. */
  attributableTo: 'insurer' | 'ccguk' | 'client' | 'court' | 'other';
  /** True when the basis is a GTA paragraph (benchmark only). */
  gta: boolean;
}

export const GTA_BENCHMARK_SUFFIX = '(benchmark only, CCGUK is not a subscriber)';

export const clockDefinitions: Record<ClockKind, ClockDefinition> = {
  gta_4_1_ncaf_1wd: {
    label: 'Send New Claim Advice Form (1 WD)',
    basis: `GTA 4.1 (16 March 2026 wording) — CHO sends the New Claim Advice Form within 1 working day of agreeing services ${GTA_BENCHMARK_SUFFIX}`,
    description: 'Runs from the moment services are agreed (fallback: hire start, then FNOL). Met when the NCAF is sent. Starts the GTA 3.6 and ICOBS 8.2.6 clocks.',
    attributableTo: 'ccguk',
    gta: true,
  },
  gta_4_2_handling_ref_5wd: {
    label: 'Insurer handling centre and reference (5 WD)',
    basis: `GTA 4.2 — insurer provides the handling centre and claim reference within 5 working days of the NCAF ${GTA_BENCHMARK_SUFFIX}`,
    description: 'Runs from the NCAF. Met when the handling reference is received. Breach is an insurer-attributable delay for the chronology.',
    attributableTo: 'insurer',
    gta: true,
  },
  gta_3_6_first_notification_5wd: {
    label: 'Insurer first-notification window (5 WD)',
    basis: `GTA 3.6 — an insurer believing it was first notified must say so within 5 working days of the New Claim Advice Form ${GTA_BENCHMARK_SUFFIX}`,
    description: 'The insurer’s window to assert that it had the claim first. Expires silently: met when it passes with no first-notification dispute; stopped if the insurer asserts within the window.',
    attributableTo: 'insurer',
    gta: true,
  },
  gta_4_8_offhire_repair_24h: {
    label: 'Off-hire within 24 hours of repair completion',
    basis: `GTA 4.8 — hire ends within 24 hours of repair completion ${GTA_BENCHMARK_SUFFIX}`,
    description: 'Runs from repair completion. Met when the hire agreement ends on or before the deadline. Hire past the deadline is the live-file failure (lesson d).',
    attributableTo: 'ccguk',
    gta: true,
  },
  gta_4_9_termination_1wd: {
    label: 'Off-hire within 1 WD of insurer termination notice',
    basis: `GTA 4.9 — insurer termination notice: hire ends within 1 working day ${GTA_BENCHMARK_SUFFIX}`,
    description: 'Runs from receipt of the insurer’s termination notice. Met when the hire ends on or before the deadline.',
    attributableTo: 'ccguk',
    gta: true,
  },
  gta_4_14_offhire_tl_payment_5wd: {
    label: 'Off-hire within 5 WD of total-loss payment',
    basis: `GTA 4.14 table (CHO dealing, unroadworthy) — hire ends within 5 working days of receipt of the total-loss payment ${GTA_BENCHMARK_SUFFIX}`,
    description: 'Runs from receipt of the total-loss settlement. Met when the hire ends on or before the deadline.',
    attributableTo: 'ccguk',
    gta: true,
  },
  gta_4_10_authorisation_check_3wd: {
    label: 'Repair authorisation check (3 WD)',
    basis: `GTA 4.10 — repair authorisation check 3 working days after the estimate ${GTA_BENCHMARK_SUFFIX}`,
    description: 'Runs from the estimate (fallback: engineer’s report). Met when the repair is authorised. Insurer-attributable delay beyond this point goes on the chronology.',
    attributableTo: 'insurer',
    gta: true,
  },
  gta_4_11_monitoring_5wd: {
    label: 'Repair monitoring check (every 5 WD)',
    basis: `GTA 4.11 — monitoring check every 5 working days during repair ${GTA_BENCHMARK_SUFFIX}`,
    description: 'Recurs every 5 working days from repair start until completion; only the next due check is shown. Met by a logged monitoring touch (call, email, parts or delay event) in the window.',
    attributableTo: 'ccguk',
    gta: true,
  },
  gta_6_7_settlement_1_month: {
    label: 'Insurer settlement of clean payment pack (1 calendar month)',
    basis: `GTA 6.7 — insurer settles within one calendar month of a clean payment pack ${GTA_BENCHMARK_SUFFIX}`,
    description: 'Runs from the payment pack. Met when payment received covers the pack (ledger paid ≥ invoiced, or the payment event is flagged in full).',
    attributableTo: 'insurer',
    gta: true,
  },
  gta_6_8_late_payment_10pc_day31: {
    label: 'Late-payment addition 10% (day 31)',
    basis: 'GTA 6.8.6 — benchmark only, CCGUK is not a subscriber',
    description: 'From day 31 after a clean payment pack an unpaid balance attracts a 10% addition for subscribers (hires from 16 March 2026). Quoted as an industry benchmark, never as of right.',
    attributableTo: 'insurer',
    gta: true,
  },
  gta_6_8_late_payment_20pc_day61: {
    label: 'Late-payment addition 20% (day 61)',
    basis: 'GTA 6.8.6 — benchmark only, CCGUK is not a subscriber',
    description: 'From day 61 after a clean payment pack an unpaid balance attracts a 20% addition for subscribers (hires from 16 March 2026). Quoted as an industry benchmark, never as of right.',
    attributableTo: 'insurer',
    gta: true,
  },
  intervention_reply_1wd: {
    label: 'Written reply to intervention offer (1 WD)',
    basis: 'Intervention register (BLUEPRINT §3.6) — written reply to the insurer within 1 working day of every offer; Copley v Lawn mitigation',
    description: 'Runs from each logged intervention offer. Met when the written reply is sent. An unanswered offer is the live-file failure (lesson c): silence loses the mitigation argument that reasons would have won.',
    attributableTo: 'ccguk',
    gta: false,
  },
  storage_report_plus_48h: {
    label: 'Collect-or-pay notice: storage cap at report + 48h',
    basis: 'insurer practice (live File 2)',
    description: 'Insurers commonly cap storage at the engineer’s report plus 48 hours. Runs from the report while storage is open; met when the collect-or-pay notice is sent to insurer and client. Breached means any further storage must be shown to be insurer-caused.',
    attributableTo: 'ccguk',
    gta: false,
  },
  icobs_8_2_6_three_months: {
    label: 'ICOBS 8.2.6 three-month response',
    basis: 'ICOBS 8.2.6R; interest ICOBS 8.2.9R–8.2.11R base+4% — territorial scope 8.2.1R to be confirmed',
    description: 'Runs from first notification to the insurer (the NCAF). Met by a reasoned offer or reply (reduction, PAV offer or payment). On breach, interest at base + 4% may run — do not assert as of right until ICOBS 8.2.1R scope is confirmed.',
    attributableTo: 'insurer',
    gta: false,
  },
  chaser_day_7: {
    label: 'Chaser 1 (day 7)',
    basis: 'Get-paid-faster playbook (BLUEPRINT §7.8) — chaser cadence day 7, 14, 21 → complaint at day 28',
    description: 'First chaser 7 days after the payment pack (fallback: the invoice). Met by the first chaser sent; stopped by payment in full.',
    attributableTo: 'ccguk',
    gta: false,
  },
  chaser_day_14: {
    label: 'Chaser 2 — team leader (day 14)',
    basis: 'Get-paid-faster playbook (BLUEPRINT §7.8) — chaser cadence day 7, 14, 21 → complaint at day 28',
    description: 'Second chaser, escalated to team leader, 14 days after the payment pack. Met by the second chaser sent; stopped by payment in full.',
    attributableTo: 'ccguk',
    gta: false,
  },
  chaser_day_21: {
    label: 'Chaser 3 — claims manager (day 21)',
    basis: 'Get-paid-faster playbook (BLUEPRINT §7.8) — chaser cadence day 7, 14, 21 → complaint at day 28',
    description: 'Third chaser, escalated to claims manager, 21 days after the payment pack. Met by the third chaser sent; stopped by payment in full.',
    attributableTo: 'ccguk',
    gta: false,
  },
  complaint_day_28: {
    label: 'Formal complaint (day 28)',
    basis: 'Get-paid-faster playbook (BLUEPRINT §7.5, §7.8) — formal complaint to the insurer under DISP 1 at day 28, citing ICOBS 8.1 and 8.2',
    description: 'Complaint 28 days after the payment pack if unpaid. Met by the complaint sent; stopped by payment in full. Starts the DISP 8-week clock.',
    attributableTo: 'ccguk',
    gta: false,
  },
  disp_final_response_8_weeks: {
    label: 'Insurer final response (8 weeks)',
    basis: 'DISP 1.6.2R — final response within 8 weeks of the complaint',
    description: 'Runs from the complaint. Met when the final response is received. A third-party claimant may not be an eligible complainant (DISP 2.7); the complaint still creates a record and a cost for the insurer.',
    attributableTo: 'insurer',
    gta: false,
  },
  fos_referral_6_months: {
    label: 'FOS referral window (6 months)',
    basis: 'DISP 2.8.2R — referral to the Financial Ombudsman within 6 months of the final response; eligibility DISP 2.7',
    description: 'Runs from the final response. Not applicable where the complaint is against the at-fault insurer: a third-party claimant is not an eligible complainant (DISP 2.7). Applicable against the client’s own insurer.',
    attributableTo: 'ccguk',
    gta: false,
  },
  dsar_1_month: {
    label: 'DSAR response (1 calendar month)',
    basis: 'UK GDPR Art 12(3) / Art 15 — response within one calendar month of the request (extendable by two months where complex)',
    description: 'Runs from each DSAR sent (e.g. for call recordings of an alleged intervention offer). Met when the response is received. On breach: ICO complaint at day 31, as warned in the request.',
    attributableTo: 'insurer',
    gta: false,
  },
  cctv_preservation: {
    label: 'CCTV / dashcam preservation request (7 days)',
    basis: 'Get-paid-faster playbook (BLUEPRINT §7.2) — CCTV requests to council or TfL within days 1–7; footage is often overwritten within weeks',
    description: 'Runs from FNOL. Met when the preservation request is sent. The single highest-value action on a disputed-liability file.',
    attributableTo: 'ccguk',
    gta: false,
  },
  nip_14_days: {
    label: 'NIP served within 14 days of the offence',
    basis: 's.1 RTOA 1988 — the notice of intended prosecution must be served on the registered keeper within 14 days of the offence',
    description: 'Runs from the contravention. Met when the NIP is served (received) within 14 days. Breached means service was out of time — check the offence date against service, not the letter date (deemed service rules apply).',
    attributableTo: 'other',
    gta: false,
  },
  s172_28_days: {
    label: 's.172 driver identification (28 days)',
    basis: 's.172(7) RTA 1988 — the keeper must give the driver’s identity within 28 days beginning with the day the notice is served; s.172(4) reasonable-diligence defence',
    description: 'Runs from service of the s.172 notice. Met when the response is sent. Failure is an offence (6 points) — respond in time even where the driver cannot be identified, setting out the diligence made.',
    attributableTo: 'ccguk',
    gta: false,
  },
  pcn_discount_14_days: {
    label: 'PCN 50% discount period (14 days)',
    basis: 'Traffic Management Act 2004 and the Civil Enforcement regulations — discounted penalty if paid within 14 days beginning with the date of service (private parking: operator terms / BPA–IPC Code)',
    description: 'Runs from service of the PCN. The date printed on the notice governs; the computed date is a fallback. Met by payment; stopped by representations or liability transfer.',
    attributableTo: 'ccguk',
    gta: false,
  },
  pcn_representations_28_days: {
    label: 'PCN representations (28 days)',
    basis: 'Traffic Management Act 2004 — formal representations within 28 days beginning with the date of service of the Notice to Owner / PCN (private parking: appeal to the operator within 28 days)',
    description: 'Runs from service. Met when representations (or the hirer liability transfer under the Road Traffic (Owner Liability) Regulations 2000) are sent.',
    attributableTo: 'ccguk',
    gta: false,
  },
  pcn_appeal_28_days: {
    label: 'PCN tribunal appeal (28 days)',
    basis: 'Traffic Management Act 2004 — appeal to London Tribunals / the Traffic Penalty Tribunal within 28 days of the notice of rejection (private parking: POPLA / IAS within 28 days)',
    description: 'Runs from the notice of rejection. Met when the appeal is lodged.',
    attributableTo: 'ccguk',
    gta: false,
  },
  limitation_tort_6y: {
    label: 'Limitation — tort (6 years)',
    basis: 'Limitation Act 1980 s.2 — six years from the date the cause of action accrued (the accident)',
    description: 'Runs from the accident. Stopped when proceedings are issued or the claim settles. Diarise well before expiry; a letter of claim does not stop limitation.',
    attributableTo: 'ccguk',
    gta: false,
  },
  limitation_contract_6y: {
    label: 'Limitation — hire agreement contract (6 years)',
    basis: 'Limitation Act 1980 s.5 — six years from breach of the hire agreement',
    description: 'The claim against the hirer under the credit hire agreement. Runs from the agreement; stopped when proceedings are issued or the claim settles.',
    attributableTo: 'ccguk',
    gta: false,
  },
  limitation_pi_3y: {
    label: 'refer out — personal injury',
    basis: 'Limitation Act 1980 s.11 — three years for personal injury; CCGUK refers injury out and takes no fee (perimeter: FCA claims-management regulation)',
    description: 'Shown only where injuries were reported. CCGUK does not handle the injury element; the instructed solicitor owns this limitation date.',
    attributableTo: 'other',
    gta: false,
  },
  part36_relevant_period_21_days: {
    label: 'Part 36 relevant period (21 days)',
    basis: 'CPR 36.3(g), 36.5(1)(c) — a Part 36 offer specifies a relevant period of not less than 21 days',
    description: 'Runs from the offer. After expiry the offer may still be accepted but the costs consequences under CPR 36.13 and 36.17 bite. Litigation documents are drafts for the claimant or an instructed solicitor.',
    attributableTo: 'ccguk',
    gta: false,
  },
  default_judgment_14_days: {
    label: 'Acknowledgment of service / defence (14 days; 28 if AoS filed)',
    basis: 'CPR 10.3, 15.4 and 12.3 — acknowledgment of service or defence within 14 days of service of the particulars of claim; defence within 28 days where an acknowledgment is filed',
    description: 'Runs from service of the particulars (fallback: issue). Met when the defence is received. After expiry the claimant may request default judgment under CPR 12.3.',
    attributableTo: 'insurer',
    gta: false,
  },
  custom: {
    label: 'Custom clock',
    basis: 'user-defined',
    description: 'A clock set by a handler. Its status is re-evaluated against now.',
    attributableTo: 'ccguk',
    gta: false,
  },
};

export const clockKinds: readonly ClockKind[] = Object.keys(clockDefinitions) as ClockKind[];

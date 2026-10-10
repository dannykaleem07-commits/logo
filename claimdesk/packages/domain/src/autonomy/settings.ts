/**
 * Autonomy settings and the perimeter lists that settings can never change (docs/SUPREME-DESIGN.md §D.1, §D.2, §D.5).
 */
import type { EmailKind } from '../agents/types.js';

export interface AutonomySettings {
  mode: 'automatic' | 'shadow';
  /** Undo window before an automatic send leaves the PC (minutes). */
  holdMinutes: number;
  thresholds: { internal: number; external: number };
  autoSendEmailKinds: EmailKind[];
  autoSendTemplates: string[];
  /** Subset of autoSendTemplates that agents may approve (§D.5). */
  autoApproveTemplates: string[];
  limits: { perClaimPerDay: number; perHour: number; perDay: number };
  /** Europe/London HH:MM; null = no quiet hours. */
  quietHours: { start: string; end: string } | null;
  killSwitch: boolean;
}

export const DEFAULT_AUTO_SEND_EMAIL_KINDS: readonly EmailKind[] = [
  'ack',
  'info_provided',
  'doc_request_fulfil',
  'chaser',
  'handling_ref_request',
  'ncaf_cover',
  'cctv_request',
  'client_update',
  'supplier_instruction',
  'reply_general',
  // Autopilot (SUPREME-AUTOPILOT §0.6): hire_offer passes only with a commitment verified by code (§D.3).
  'booking_update',
  'insurer_notice',
  'hire_offer',
];

export const DEFAULT_AUTO_SEND_TEMPLATES: readonly string[] = [
  'letter.ncaf',
  'letter.handling_ref_request',
  'letter.cctv_preservation',
  'letter.chaser_7',
  'letter.chaser_14',
  'letter.chaser_21',
  'letter.client_update',
  'letter.delay_notice_gta_4_10',
  'letter.supplier_instruction_engineer',
  // Autopilot (SUPREME-AUTOPILOT §0.6); the templates are added by ap-paperwork.
  'letter.hire_start_notice',
  'letter.booking_confirmation',
  'letter.signature_chase',
];

/** The owner's choices (§D.1): fully automatic + daily log; everything sensitive asks. */
export const DEFAULT_AUTONOMY: AutonomySettings = {
  mode: 'automatic',
  holdMinutes: 10,
  thresholds: { internal: 0.85, external: 0.9 },
  autoSendEmailKinds: [...DEFAULT_AUTO_SEND_EMAIL_KINDS],
  autoSendTemplates: [...DEFAULT_AUTO_SEND_TEMPLATES],
  autoApproveTemplates: [...DEFAULT_AUTO_SEND_TEMPLATES],
  // 3 → 6 (SUPREME-AUTOPILOT §0.6): a booking day legitimately sends an acknowledgement, the NCAF, the offer, the
  // delivery confirmation and a reminder. Installs with a saved value keep it.
  limits: { perClaimPerDay: 6, perHour: 20, perDay: 100 },
  quietHours: { start: '20:00', end: '07:30' },
  killSwitch: false,
};

/** Templates that always ask regardless of settings (perimeter, not editable). Entries ending in '.' are prefixes. */
export const ALWAYS_ASK_TEMPLATES: readonly string[] = [
  'letter.letter_before_claim',
  'letter.part36_offer',
  'letter.complaint_disp',
  'letter.dsar',
  'letter.collect_or_pay',
  'letter.intervention_reply',
  'letter.pav_challenge',
  'letter.particularisation_demand',
  'letter.vendor_verification_pack',
  'pack.gta_payment',
  'invoice.',
  'bundle.litigation_index',
  'schedule.loss',
  'statement.',
  'agreement.',
  'form.',
  'notice.',
];

/** Email kinds that always ask (`doc_request` = missing information → prepared request + Needs-you). */
export const ALWAYS_ASK_EMAIL_KINDS: readonly EmailKind[] = ['offer_response', 'complaint', 'legal', 'doc_request'];

export function isAlwaysAskTemplate(templateId: string): boolean {
  return ALWAYS_ASK_TEMPLATES.some((t) => (t.endsWith('.') ? templateId.startsWith(t) : templateId === t));
}

export function isAlwaysAskEmailKind(kind: string): boolean {
  return (ALWAYS_ASK_EMAIL_KINDS as readonly string[]).includes(kind);
}

/** §D.5: may an automated actor approve a document of this template? (allow-listed and not always-ask). */
export function mayAutoApproveTemplate(settings: Pick<AutonomySettings, 'autoApproveTemplates'>, templateId: string): boolean {
  return settings.autoApproveTemplates.includes(templateId) && !isAlwaysAskTemplate(templateId);
}

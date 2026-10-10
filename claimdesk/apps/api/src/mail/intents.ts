// owned by mail
/**
 * Intent → what code does with a triaged email (docs/SUPREME-DESIGN.md §F.5, §C.5 step 2). The model only classifies;
 * this table decides the typed chronology event and the routing. Events with side effects that create records (an
 * `intervention_offer` without an offer id) are only appended with the offer id the offer register returned.
 */
import type { EventType, HeadOfLoss, MailIntent } from '@ccguk/domain';

export type IntentRoute =
  /** Record the offer (offer_record as agent:mail: intervention offers → intervention register, others → settlement-offer register) → Needs-you offer_decision + offer.analyse. */
  | 'offer'
  /** Legal / complaint matter: always the owner (Needs-you legal_review) plus a case review. */
  | 'legal'
  /** Filed, no reply, no review. */
  | 'file_only'
  /** Our email bounced: tell the owner. */
  | 'bounce'
  /** Normal: case review decides the next step. */
  | 'review';

export interface IntentRule {
  /** Typed event appended next to `email_in` (null = none). */
  event: EventType | null;
  route: IntentRoute;
  /** Head of loss for an offer. */
  head?: HeadOfLoss;
  label: string;
}

export const INTENT_RULES: Readonly<Record<MailIntent, IntentRule>> = {
  offer_settlement: { event: null, route: 'offer', head: 'misc', label: 'Settlement offer' },
  offer_pav: { event: 'pav_offer_received', route: 'offer', head: 'pav', label: 'Pre-accident value offer' },
  part36_offer: { event: 'part36_received', route: 'legal', label: 'Part 36 offer' },
  interim_payment: { event: null, route: 'offer', head: 'misc', label: 'Interim payment offer' },
  liability_admitted: { event: null, route: 'review', label: 'Liability admitted' },
  liability_denied: { event: null, route: 'review', label: 'Liability denied' },
  liability_split: { event: null, route: 'review', label: 'Split liability' },
  request_documents: { event: null, route: 'review', label: 'Documents requested' },
  request_information: { event: null, route: 'review', label: 'Information requested' },
  payment_remittance: { event: null, route: 'review', label: 'Payment remittance' },
  reduction_or_part_payment: { event: 'reduction_received', route: 'review', label: 'Reduction or part payment' },
  engineer_report: { event: null, route: 'review', label: 'Engineer report' },
  inspection_arrangement: { event: null, route: 'review', label: 'Inspection arrangement' },
  repair_authority: { event: null, route: 'review', label: 'Repair authority' },
  bodyshop_update: { event: null, route: 'review', label: 'Bodyshop update' },
  chaser: { event: null, route: 'review', label: 'Chaser' },
  acknowledgement: { event: null, route: 'review', label: 'Acknowledgement' },
  complaint: { event: null, route: 'legal', label: 'Complaint' },
  final_response: { event: 'final_response_received', route: 'legal', label: 'Final response' },
  fraud_allegation: { event: null, route: 'legal', label: 'Fraud allegation' },
  solicitor_letter: { event: null, route: 'legal', label: 'Solicitor letter' },
  letter_before_claim: { event: null, route: 'legal', label: 'Letter before claim' },
  court_document: { event: null, route: 'legal', label: 'Court document' },
  intervention_offer: { event: 'intervention_offer', route: 'offer', head: 'hire', label: 'Intervention (hire) offer' },
  dsar_response: { event: 'dsar_response', route: 'review', label: 'DSAR response' },
  client_message: { event: null, route: 'review', label: 'Message from the client' },
  auto_reply: { event: null, route: 'file_only', label: 'Automatic reply' },
  bounce: { event: null, route: 'bounce', label: 'Bounce' },
  spam_phishing: { event: null, route: 'file_only', label: 'Spam or phishing' },
  other: { event: null, route: 'review', label: 'Other' },
};

/** Case-review priority by urgency (§C.2: inbound reviews run at 1; urgent ahead of everything else). */
export const URGENCY_PRIORITY = { urgent: 0, high: 1, normal: 1, low: 3 } as const;

/** Acknowledgements that carry the insurer's reference are the GTA 4.2 handling reference. */
export function isHandlingRef(intent: MailIntent, theirRef: string | null): boolean {
  return intent === 'acknowledgement' && Boolean(theirRef && theirRef.trim().length >= 4);
}

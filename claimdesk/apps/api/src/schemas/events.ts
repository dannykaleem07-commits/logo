import { z } from 'zod';
import { id, isoDateTime } from './common.js';

export const eventType = z.enum([
  'fnol', 'services_agreed', 'ncaf_sent', 'handling_ref_received', 'first_notification_dispute', 'engineer_instructed', 'inspection',
  'report_issued', 'estimate_received', 'repair_authorised', 'parts_ordered', 'parts_arrived', 'repair_started', 'repair_delay',
  'repair_completed', 'vehicle_returned', 'hire_started', 'hire_ended', 'storage_started', 'storage_ended', 'recovery',
  'collect_or_pay_notice_sent', 'total_loss_confirmed', 'pav_offer_received', 'pav_agreed', 'tl_payment_received',
  'cash_in_lieu_received', 'insurer_termination_notice', 'intervention_offer', 'intervention_reply_sent', 'settlement_offer_received', 'payment_pack_sent',
  'payment_received', 'reduction_received', 'chaser_sent', 'complaint_sent', 'final_response_received', 'dsar_sent', 'dsar_response',
  'cctv_request_sent', 'letter_before_claim_sent', 'part36_sent', 'part36_received', 'proceedings_issued', 'defence_received',
  'judgment', 'settled', 'vehicle_collected', 'salvage_released', 'pcn_received', 'nip_received', 's172_response_sent',
  'pcn_liability_transferred', 'call', 'email_in', 'email_out', 'letter_in', 'letter_out', 'note',
]);

export const attributableTo = z.enum(['insurer', 'client', 'ccguk', 'repairer', 'engineer', 'third_party', 'none']);

export const eventBody = z.object({
  type: eventType,
  at: isoDateTime,
  summary: z.string().trim().min(1),
  data: z.record(z.unknown()).optional(),
  attributableTo: attributableTo.optional(),
  evidenceIds: z.array(id).optional(),
  documentId: id.optional(),
});

export const eventListQuery = z.object({
  type: z.string().optional(),
  since: isoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});

/**
 * Status → badge tone mapping. One place so the colour language stays consistent:
 * green = done/verified/clear, amber = attention, red = blocked/breached/failed, blue = active, grey = inert.
 */
import type { ClaimStatus, DocumentStatus, Verification, GateResult, Clock, ClaimFlag, PlaybookAction } from '@ccguk/domain';

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'navy' | 'grey';

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  fnol: 'FNOL',
  triage: 'Triage',
  declined: 'Declined',
  accepted: 'Accepted',
  hire_active: 'Hire active',
  repair: 'Repair',
  total_loss: 'Total loss',
  payment_pack: 'Payment pack',
  chasing: 'Chasing',
  disputed: 'Disputed',
  complaint: 'Complaint',
  pre_action: 'Pre-action',
  litigation: 'Litigation',
  settled: 'Settled',
  closed: 'Closed'
};

export const CLAIM_STATUSES = Object.keys(CLAIM_STATUS_LABEL) as ClaimStatus[];

export function claimStatusTone(status: ClaimStatus): Tone {
  switch (status) {
    case 'fnol':
    case 'triage':
      return 'amber';
    case 'declined':
      return 'red';
    case 'accepted':
    case 'hire_active':
    case 'repair':
    case 'total_loss':
    case 'payment_pack':
      return 'blue';
    case 'chasing':
    case 'disputed':
    case 'complaint':
    case 'pre_action':
    case 'litigation':
      return 'amber';
    case 'settled':
      return 'green';
    case 'closed':
      return 'grey';
  }
}

export function claimStatusLabel(status: ClaimStatus | string): string {
  return (CLAIM_STATUS_LABEL as Record<string, string>)[status] ?? status.replace(/_/g, ' ');
}

export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  draft: 'Draft',
  blocked: 'Blocked',
  approved: 'Approved',
  sent: 'Sent',
  signed: 'Signed',
  superseded: 'Superseded',
  void: 'Void'
};

export function documentStatusTone(status: DocumentStatus): Tone {
  switch (status) {
    case 'draft':
      return 'amber';
    case 'blocked':
      return 'red';
    case 'approved':
      return 'blue';
    case 'sent':
    case 'signed':
      return 'green';
    case 'superseded':
    case 'void':
      return 'grey';
  }
}

export function severityTone(severity: ClaimFlag['severity'] | 'block' | 'warn' | 'info'): Tone {
  switch (severity) {
    case 'block':
      return 'red';
    case 'warn':
      return 'amber';
    case 'info':
      return 'blue';
  }
}

export function verificationTone(v: Verification | Verification['status'] | undefined): Tone {
  const status = typeof v === 'string' ? v : v?.status;
  switch (status) {
    case 'verified':
      return 'green';
    case 'stale':
      return 'amber';
    case 'failed':
      return 'red';
    case 'unverified':
    default:
      return 'amber';
  }
}

export function verificationLabel(v: Verification | Verification['status'] | undefined): string {
  const status = typeof v === 'string' ? v : v?.status;
  switch (status) {
    case 'verified':
      return 'Verified';
    case 'stale':
      return 'Stale';
    case 'failed':
      return 'Failed';
    default:
      return 'Unverified';
  }
}

export function gateTone(status: GateResult['status']): Tone {
  return status; // green | amber | red map 1:1
}

export function clockStatusTone(status: Clock['status']): Tone {
  switch (status) {
    case 'running':
      return 'blue';
    case 'met':
      return 'green';
    case 'breached':
      return 'red';
    case 'stopped':
    case 'not_applicable':
      return 'grey';
  }
}

export function priorityTone(priority: PlaybookAction['priority']): Tone {
  switch (priority) {
    case 'now':
      return 'red';
    case 'today':
      return 'amber';
    case 'this_week':
      return 'blue';
    case 'scheduled':
      return 'grey';
  }
}

export const PRIORITY_LABEL: Record<PlaybookAction['priority'], string> = {
  now: 'Now',
  today: 'Today',
  this_week: 'This week',
  scheduled: 'Scheduled'
};

// owned by ap-paperwork
/** Pure helpers for the Packs panel and the approve_pack card (docs/SUPREME-AUTOPILOT.md §D.6, §I.7). */
import type { DocumentPack, PackStage } from '@ccguk/domain';
import type { Tone } from '../../../lib/status';
import type { PackItemView, PackView } from '../../../api/signingApi';

export const PACK_STATUS_LABEL: Record<DocumentPack['status'], string> = {
  preparing: 'Preparing',
  reviewing: 'Being reviewed',
  awaiting_approval: 'Needs your approval',
  approved: 'Approved',
  sent: 'Sent',
  signed: 'Signed',
  superseded: 'Replaced',
  cancelled: 'Cancelled',
};

export const PACK_STATUS_TONE: Record<DocumentPack['status'], Tone> = {
  preparing: 'grey',
  reviewing: 'blue',
  awaiting_approval: 'amber',
  approved: 'navy',
  sent: 'blue',
  signed: 'green',
  superseded: 'grey',
  cancelled: 'grey',
};

export const ITEM_STATUS_LABEL: Record<PackItemView['status'], string> = {
  pending: 'Not prepared',
  drafted: 'Drafted',
  reviewed: 'Reviewed',
  approved: 'Approved',
  sent: 'Sent',
  signed: 'Signed',
  not_needed: 'Not needed',
};

export const PURPOSE_LABEL: Record<PackItemView['purpose'], string> = {
  sign: 'To sign',
  give: 'To keep',
  send_insurer: 'To the insurer',
  internal: 'Office copy',
};

export const STAGE_OPTIONS: Array<{ value: PackStage; label: string; needsBooking: boolean }> = [
  { value: 'signup', label: 'Sign-up pack', needsBooking: false },
  { value: 'hire_offer', label: 'Hire offer pack', needsBooking: false },
  { value: 'hire_start', label: 'Hire-start pack', needsBooking: true },
  { value: 'off_hire', label: 'Off-hire pack', needsBooking: true },
  { value: 'billing', label: 'Billing pack', needsBooking: false },
  { value: 'payment', label: 'Payment pack', needsBooking: false },
  { value: 'closure', label: 'Closure', needsBooking: false },
];

export type PackAction = 'approve_send' | 'approve_only' | 'send' | 'kiosk' | 'reject' | 'restart';

/** What the owner can do with a pack now (human-only actions; the server checks again). */
export function packActions(p: Pick<PackView, 'status' | 'view' | 'sendTo'>): PackAction[] {
  const active = p.view.filter((i) => i.status !== 'not_needed');
  const unsigned = active.some((i) => i.purpose === 'sign' && i.status !== 'signed');
  const prepared = active.every((i) => Boolean(i.documentId));
  const out: PackAction[] = [];
  if ((p.status === 'awaiting_approval' || p.status === 'reviewing') && prepared) {
    if (p.sendTo.length) out.push('approve_send');
    out.push('approve_only');
  }
  if (p.status === 'approved' && p.sendTo.length) out.push('send');
  if ((p.status === 'approved' || p.status === 'sent') && unsigned) out.push('kiosk');
  if (p.status !== 'signed' && p.status !== 'superseded' && p.status !== 'cancelled') out.push('reject');
  if (p.status === 'preparing' || p.status === 'cancelled') out.push('restart');
  return out;
}

/** "3 to sign · 2 to keep · 1 signed". */
export function packCounts(view: readonly PackItemView[]): string {
  const active = view.filter((i) => i.status !== 'not_needed');
  const sign = active.filter((i) => i.purpose === 'sign').length;
  const give = active.filter((i) => i.purpose === 'give').length;
  const signed = active.filter((i) => i.status === 'signed').length;
  return [sign ? `${sign} to sign` : '', give ? `${give} to keep` : '', signed ? `${signed} signed` : ''].filter(Boolean).join(' · ') || `${active.length} document${active.length === 1 ? '' : 's'}`;
}

export function verdictTone(verdict: string | undefined): Tone {
  return verdict === 'pass' ? 'green' : verdict === 'repair' ? 'amber' : verdict === 'escalate' ? 'red' : 'grey';
}

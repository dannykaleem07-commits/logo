/**
 * Chronology helpers (pure). The dated events table is the hire-period defence, so the add-event form must be
 * fast and the "days attributable to" counter must be explainable in one sentence:
 *
 *   The file sits with the party named on each event from that event until the next one. Summing those gaps
 *   per party gives the days attributable to the insurer, the repairer, the client and CCGUK.
 */
import { correctedEventId, liveEvents, supersededEventIds, type ClaimEvent, type EventType, type ISODateTime } from '@ccguk/domain';
import type { CreateEventBody } from '../../../api/client';

export type Attributable = NonNullable<ClaimEvent['attributableTo']>;

export interface EventGroup {
  id: string;
  label: string;
  types: EventType[];
}

export const EVENT_GROUPS: EventGroup[] = [
  { id: 'intake', label: 'Intake & notification', types: ['fnol', 'services_agreed', 'ncaf_sent', 'handling_ref_received', 'first_notification_dispute'] },
  {
    id: 'engineering',
    label: 'Engineering & repair',
    types: ['engineer_instructed', 'inspection', 'report_issued', 'estimate_received', 'repair_authorised', 'parts_ordered', 'parts_arrived', 'repair_started', 'repair_delay', 'repair_completed', 'vehicle_returned']
  },
  { id: 'hire', label: 'Hire, storage & recovery', types: ['hire_started', 'hire_ended', 'storage_started', 'storage_ended', 'recovery', 'collect_or_pay_notice_sent', 'vehicle_collected', 'salvage_released'] },
  { id: 'total_loss', label: 'Total loss & PAV', types: ['total_loss_confirmed', 'pav_offer_received', 'pav_agreed', 'tl_payment_received', 'cash_in_lieu_received', 'insurer_termination_notice'] },
  { id: 'intervention', label: 'Intervention', types: ['intervention_offer', 'intervention_reply_sent'] },
  {
    id: 'payment',
    label: 'Payment, chasing & complaint',
    types: ['payment_pack_sent', 'payment_received', 'reduction_received', 'chaser_sent', 'complaint_sent', 'final_response_received', 'dsar_sent', 'dsar_response', 'cctv_request_sent']
  },
  { id: 'litigation', label: 'Pre-action & litigation', types: ['letter_before_claim_sent', 'part36_sent', 'part36_received', 'proceedings_issued', 'defence_received', 'judgment', 'settled'] },
  { id: 'penalties', label: 'PCN / NIP', types: ['pcn_received', 'nip_received', 's172_response_sent', 'pcn_liability_transferred'] },
  { id: 'contact', label: 'Contact & notes', types: ['call', 'email_in', 'email_out', 'letter_in', 'letter_out', 'note'] }
];

export const EVENT_LABEL: Record<EventType, string> = {
  fnol: 'FNOL taken',
  services_agreed: 'Services agreed',
  ncaf_sent: 'New Claim Advice Form sent',
  handling_ref_received: 'Handling reference received',
  first_notification_dispute: 'First-notification dispute (GTA 3.6)',
  engineer_instructed: 'Engineer instructed',
  inspection: 'Inspection',
  report_issued: "Engineer's report issued",
  estimate_received: 'Estimate received',
  repair_authorised: 'Repair authorised',
  parts_ordered: 'Parts ordered',
  parts_arrived: 'Parts arrived',
  repair_started: 'Repair started',
  repair_delay: 'Repair delay',
  repair_completed: 'Repair completed',
  vehicle_returned: 'Vehicle returned to client',
  hire_started: 'Hire started',
  hire_ended: 'Hire ended',
  storage_started: 'Storage started',
  storage_ended: 'Storage ended',
  recovery: 'Recovery',
  collect_or_pay_notice_sent: 'Collect-or-pay notice sent',
  total_loss_confirmed: 'Total loss confirmed',
  pav_offer_received: 'PAV offer received',
  pav_agreed: 'PAV agreed',
  tl_payment_received: 'Total-loss payment received',
  cash_in_lieu_received: 'Cash in lieu received',
  insurer_termination_notice: 'Insurer termination notice',
  intervention_offer: 'Intervention offer',
  intervention_reply_sent: 'Intervention reply sent',
  payment_pack_sent: 'Payment pack sent',
  payment_received: 'Payment received',
  reduction_received: 'Reduction received',
  chaser_sent: 'Chaser sent',
  complaint_sent: 'Complaint sent',
  final_response_received: 'Final response received',
  dsar_sent: 'DSAR sent',
  dsar_response: 'DSAR response',
  cctv_request_sent: 'CCTV request sent',
  letter_before_claim_sent: 'Letter before claim sent',
  part36_sent: 'Part 36 offer sent',
  part36_received: 'Part 36 offer received',
  proceedings_issued: 'Proceedings issued',
  defence_received: 'Defence received',
  judgment: 'Judgment',
  settled: 'Settled',
  vehicle_collected: 'Vehicle collected',
  salvage_released: 'Salvage released',
  pcn_received: 'PCN received',
  nip_received: 'NIP received',
  s172_response_sent: 's.172 response sent',
  pcn_liability_transferred: 'PCN liability transferred',
  call: 'Call',
  email_in: 'Email in',
  email_out: 'Email out',
  letter_in: 'Letter in',
  letter_out: 'Letter out',
  note: 'Note'
};

export const ATTRIBUTABLE_LABEL: Record<Attributable, string> = {
  insurer: 'Insurer',
  client: 'Client',
  ccguk: 'CCGUK',
  repairer: 'Repairer',
  engineer: 'Engineer',
  third_party: 'Third party',
  none: 'Nobody'
};

export const ATTRIBUTABLE_OPTIONS = (Object.keys(ATTRIBUTABLE_LABEL) as Attributable[]).map((value) => ({ value, label: ATTRIBUTABLE_LABEL[value] }));

export function eventLabel(type: EventType | string): string {
  return (EVENT_LABEL as Record<string, string>)[type] ?? type.replace(/_/g, ' ');
}

export function eventGroup(type: EventType | string): EventGroup | undefined {
  return EVENT_GROUPS.find((g) => (g.types as string[]).includes(type));
}

/** Default attribution for an event type, so the form pre-fills the obvious answer (still editable). */
export function defaultAttribution(type: EventType | ''): Attributable | '' {
  switch (type) {
    case 'handling_ref_received':
    case 'first_notification_dispute':
    case 'repair_authorised':
    case 'pav_offer_received':
    case 'tl_payment_received':
    case 'cash_in_lieu_received':
    case 'insurer_termination_notice':
    case 'intervention_offer':
    case 'payment_received':
    case 'reduction_received':
    case 'final_response_received':
    case 'dsar_response':
    case 'part36_received':
    case 'defence_received':
      return 'insurer';
    case 'parts_ordered':
    case 'parts_arrived':
    case 'repair_started':
    case 'repair_delay':
    case 'repair_completed':
      return 'repairer';
    case 'inspection':
    case 'report_issued':
    case 'estimate_received':
      return 'engineer';
    case 'fnol':
    case 'services_agreed':
    case 'vehicle_returned':
    case 'vehicle_collected':
      return 'client';
    case '':
      return '';
    default:
      return 'ccguk';
  }
}

export function sortEvents<T extends Pick<ClaimEvent, 'at' | 'recordedAt'>>(events: T[], dir: 'asc' | 'desc' = 'asc'): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...events].sort((a, b) => sign * (Date.parse(a.at) - Date.parse(b.at) || a.recordedAt.localeCompare(b.recordedAt)));
}

export interface ChronologyFilter {
  group?: string;
  attributableTo?: Attributable | '';
  q?: string;
}

export function filterEvents<T extends Pick<ClaimEvent, 'type' | 'summary' | 'attributableTo'>>(events: T[], f: ChronologyFilter): T[] {
  const q = (f.q ?? '').trim().toLowerCase();
  return events.filter((e) => {
    if (f.group && eventGroup(e.type)?.id !== f.group) return false;
    if (f.attributableTo && e.attributableTo !== f.attributableTo) return false;
    if (q && !`${eventLabel(e.type)} ${e.summary}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export interface AttributableDays {
  party: Attributable;
  /** Calendar days, one decimal. */
  days: number;
  /** Number of event-to-event gaps that were attributed to this party. */
  segments: number;
}

const MS_DAY = 86_400_000;

/**
 * Days the file sat with each party. Events are taken in `at` order; the gap from an event to the next event
 * (or to `until` for the last one) is attributed to the party named on that event. Events with no attribution
 * or 'none' leave a gap that counts for nobody. Pass the hire end as `until` once hire has ended so the counter
 * speaks to the hire period and nothing after it.
 */
export function attributableDays(events: Array<Pick<ClaimEvent, 'at' | 'attributableTo' | 'recordedAt'>>, until: ISODateTime): AttributableDays[] {
  const sorted = sortEvents(events, 'asc');
  const untilMs = Date.parse(until);
  const totals = new Map<Attributable, { ms: number; segments: number }>();
  sorted.forEach((e, i) => {
    const party = e.attributableTo;
    if (!party || party === 'none') return;
    const start = Date.parse(e.at);
    if (Number.isNaN(start) || start >= untilMs) return;
    const next = sorted[i + 1];
    const end = next ? Date.parse(next.at) : untilMs;
    const ms = Math.max(0, Math.min(end, untilMs) - start);
    if (Number.isNaN(ms)) return;
    const acc = totals.get(party) ?? { ms: 0, segments: 0 };
    acc.ms += ms;
    acc.segments += 1;
    totals.set(party, acc);
  });
  return [...totals.entries()]
    .map(([party, v]) => ({ party, days: Math.round((v.ms / MS_DAY) * 10) / 10, segments: v.segments }))
    .sort((a, b) => b.days - a.days);
}

/**
 * Days attributable from the live events only: an event replaced by a correcting entry (append-only correction,
 * `data.correctsEventId`) no longer counts, though the chronology still shows it struck through.
 */
export function liveAttributableDays(events: readonly ClaimEvent[], until: ISODateTime): AttributableDays[] {
  return attributableDays(liveEvents(events), until);
}

export interface SupersededMark {
  /** The entry that replaced this one (the newest correction pointing at it). */
  replacedBy?: ClaimEvent;
  /** "Replaced by the entry recorded 5 Oct 2026, 10:42". */
  title: string;
}

function recordedText(iso: string | undefined): string {
  if (!iso) return 'later';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
}

/**
 * Corrected events, keyed by id: shown struck through with a "Corrected" badge and a tooltip naming the entry that
 * replaced them. Nothing is edited or removed — events are append-only.
 */
export function supersededMarks(events: readonly ClaimEvent[]): Map<string, SupersededMark> {
  const ids = supersededEventIds(events);
  const out = new Map<string, SupersededMark>();
  if (ids.size === 0) return out;
  for (const id of ids) {
    const correctors = events.filter((e) => correctedEventId(e) === id && e.id !== id).sort((a, b) => (a.recordedAt ?? '').localeCompare(b.recordedAt ?? ''));
    const replacedBy = correctors[correctors.length - 1];
    out.set(id, { ...(replacedBy ? { replacedBy } : {}), title: `Replaced by the entry recorded ${recordedText(replacedBy?.recordedAt)}` });
  }
  return out;
}

export const ATTRIBUTION_EXPLANATION =
  'Counts the time the file sat with each party: from an event to the next event, attributed to the party named on it. Insurer-attributable days are the period defence; log every delay as it happens with the evidence attached.';

export interface EventForm {
  type: EventType | '';
  at: ISODateTime | '';
  summary: string;
  attributableTo: Attributable | '';
  evidenceIds: string[];
  documentId?: string;
}

export function emptyEventForm(nowIso: ISODateTime): EventForm {
  return { type: '', at: nowIso, summary: '', attributableTo: '', evidenceIds: [] };
}

export type FormResult<T> = { ok: true; body: T } | { ok: false; errors: Record<string, string> };

export function eventBodyFrom(form: EventForm, nowIso: ISODateTime): FormResult<CreateEventBody> {
  const errors: Record<string, string> = {};
  if (!form.type) errors.type = 'Choose the event type';
  if (!form.at) errors.at = 'When did it happen?';
  else if (Date.parse(form.at) > Date.parse(nowIso) + 5 * 60_000) errors.at = 'An event cannot be in the future';
  if (form.summary.trim().length < 3) errors.summary = 'Say what happened (at least 3 characters)';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      type: form.type as EventType,
      at: form.at,
      summary: form.summary.trim(),
      attributableTo: form.attributableTo || undefined,
      evidenceIds: form.evidenceIds.length ? form.evidenceIds : undefined,
      documentId: form.documentId || undefined
    }
  };
}

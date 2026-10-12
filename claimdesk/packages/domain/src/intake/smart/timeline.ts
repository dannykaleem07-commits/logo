/**
 * Chronology proposals from the documents (docs/SMART-INTAKE.md §4.10, improvement 8): letters, emails, police and
 * engineer reports, estimates, recovery and storage invoices — each with its sources. Record and clock events with
 * confidence ≥ 0.8 are ticked by default; documents dated more than a day before the accident are flagged and left
 * unticked; offers, settlements, payments, reports issued and hire dates are `owner_only` (never ticked: the owner
 * records them in Offers / Hire). The accident itself is not proposed (POST /claims writes the `fnol` event).
 */
import type { DocType, } from '../../agents/types.js';
import type { EventType } from '../../types.js';
import type { FieldSource, TimelineClass, TimelineProposal } from './types.js';
import { daysBetween, londonDayOf, sha1Hex } from './text.js';
import { DOC_TYPE_PLAIN } from './ranking.js';

export const TIMELINE_EVENT_CLASS: Readonly<Partial<Record<EventType, TimelineClass>>> = {
  letter_in: 'record', email_in: 'record', note: 'record', inspection: 'record', engineer_instructed: 'record', recovery: 'record',
  vehicle_collected: 'record', estimate_received: 'clock', handling_ref_received: 'clock', storage_started: 'clock',
  intervention_offer: 'owner_only', pav_offer_received: 'owner_only', settlement_offer_received: 'owner_only', part36_received: 'owner_only',
  report_issued: 'owner_only', hire_started: 'owner_only', hire_ended: 'owner_only', payment_received: 'owner_only',
  total_loss_confirmed: 'owner_only', defence_received: 'owner_only', final_response_received: 'owner_only',
};
export const TIMELINE_EVENT_TYPES: readonly string[] = Object.keys(TIMELINE_EVENT_CLASS);

export const TIMELINE_EVENT_LABEL: Readonly<Record<string, string>> = {
  letter_in: 'Letter received',
  email_in: 'Email received',
  note: 'Note',
  inspection: 'Inspection',
  engineer_instructed: 'Engineer instructed',
  recovery: 'Recovery',
  vehicle_collected: 'Vehicle collected',
  estimate_received: 'Estimate received',
  handling_ref_received: 'Handling reference received',
  storage_started: 'Storage started',
  intervention_offer: 'Intervention offer',
  pav_offer_received: 'Pre-accident value offer',
  settlement_offer_received: 'Settlement offer',
  part36_received: 'Part 36 offer',
  report_issued: 'Report issued',
  hire_started: 'Hire started',
  hire_ended: 'Hire ended',
  payment_received: 'Payment received',
  total_loss_confirmed: 'Total loss confirmed',
  defence_received: 'Defence received',
  final_response_received: 'Final response received',
};

export interface AiTimelineItem {
  at: string;
  eventType: string;
  summary: string;
  fileId: string;
  page: number | null;
  quote: string | null;
  confidence: number;
  source?: FieldSource;
}

export interface TimelineFile {
  fileId: string;
  docType: DocType | null;
  documentDate: string | null;
  emailDate: string | null;
  from: string | null;
  subject: string | null;
  facts: { insurerName?: string; insurerRef?: string; policeRef?: string; inspectionDate?: string; offerFound?: boolean; offerKind?: 'pav' | 'settlement' | 'part36' | 'intervention'; recovery?: boolean; storage?: boolean };
  source?: FieldSource;
}

export interface TimelineInput {
  files: TimelineFile[];
  aiItems: AiTimelineItem[];
  accidentAt: string | null;
  ticks: Record<string, boolean>;
  minAutoTick: number;
}

export function timelineId(type: string, at: string, fileId: string): string {
  return `t:${sha1Hex(`${type}|${londonDayOf(at) ?? at.slice(0, 10)}|${fileId}`, 12)}`;
}

const ATTRIBUTABLE: Record<string, string> = {
  letter_in: 'insurer', handling_ref_received: 'insurer', email_in: 'none', note: 'none', inspection: 'engineer', engineer_instructed: 'ccguk', recovery: 'none',
  estimate_received: 'repairer', storage_started: 'none', vehicle_collected: 'none',
};

function fallbackSource(fileId: string, docType: DocType | null): FieldSource {
  return { fileId, itemId: '', evidenceId: '', filename: '', docType, docTypeLabel: null, page: null, quote: null, confidence: 0.8, engine: 'rules', rank: 0, label: docType ? DOC_TYPE_PLAIN[docType] : 'document', quoteVerified: null };
}

export function proposeTimeline(input: TimelineInput): TimelineProposal[] {
  const out = new Map<string, TimelineProposal>();
  const accidentDay = input.accidentAt ? londonDayOf(input.accidentAt) : null;
  const add = (type: string, at: string | null, summary: string, file: { fileId: string; docType: DocType | null; source?: FieldSource }, confidence: number, extra: { quote?: string | null; page?: number | null; aiSource?: FieldSource; attributableTo?: string } = {}) => {
    if (!at) return;
    const cls = TIMELINE_EVENT_CLASS[type as EventType];
    if (!cls) return;
    const id = timelineId(type, at, file.fileId);
    const source = { ...(extra.aiSource ?? file.source ?? fallbackSource(file.fileId, file.docType)), ...(extra.page !== undefined ? { page: extra.page } : {}), ...(extra.quote !== undefined ? { quote: extra.quote } : {}) };
    const prev = out.get(id);
    if (prev) {
      // merged (rules + AI on the same file and day): keep the higher confidence and both sources
      prev.confidence = Math.max(prev.confidence, confidence);
      if (!prev.sources.some((s) => s.engine === source.engine && s.fileId === source.fileId)) prev.sources.push(source);
      if (prev.precision === 'date' && /T\d{2}:\d{2}/.test(at)) {
        prev.at = at;
        prev.precision = 'datetime';
      }
      return;
    }
    out.set(id, {
      id,
      at,
      precision: /T\d{2}:\d{2}/.test(at) ? 'datetime' : 'date',
      eventType: type,
      eventLabel: TIMELINE_EVENT_LABEL[type] ?? type,
      class: cls,
      summary: summary.slice(0, 300),
      attributableTo: extra.attributableTo ?? ATTRIBUTABLE[type] ?? 'none',
      sources: [source],
      confidence: Math.round(confidence * 100) / 100,
      ticked: false,
      tickedBy: 'default',
      note: null,
    });
  };

  let handlingSeen = false;
  const ordered = [...input.files].sort((a, b) => (a.emailDate ?? a.documentDate ?? '').localeCompare(b.emailDate ?? b.documentDate ?? '') || a.fileId.localeCompare(b.fileId));
  for (const f of ordered) {
    const insurer = f.facts.insurerName ?? 'the insurer';
    if (f.emailDate) {
      add('email_in', f.emailDate, `Email from ${f.from ?? 'unknown sender'}${f.subject ? `: ${f.subject}` : ''}`, f, 0.9);
    } else if (f.docType === 'insurer_letter' && f.documentDate) {
      add('letter_in', f.documentDate, `Letter from ${insurer}`, f, 0.85, { attributableTo: 'insurer' });
    }
    if ((f.docType === 'insurer_letter' || f.docType === 'correspondence') && f.facts.insurerRef && !handlingSeen && (f.documentDate || f.emailDate)) {
      handlingSeen = true;
      add('handling_ref_received', (f.documentDate ?? f.emailDate)!, `Handling reference ${f.facts.insurerRef} received from ${insurer}`, f, 0.85, { attributableTo: 'insurer' });
    }
    if (f.docType === 'police_report') {
      const at = f.documentDate ?? accidentDay;
      add('note', at, `Police report${f.facts.policeRef ? ` ${f.facts.policeRef}` : ''}`, f, f.documentDate ? 0.85 : 0.6, { attributableTo: 'none' });
    }
    if (f.docType === 'engineer_report') {
      add('note', f.documentDate, `Engineer report dated ${f.documentDate ?? ''}`.trim(), f, 0.85);
      if (f.facts.inspectionDate) add('inspection', f.facts.inspectionDate, 'Vehicle inspected by the engineer', f, 0.8);
    }
    if (f.docType === 'bodyshop_estimate' || f.docType === 'audatex_estimate') add('estimate_received', f.documentDate, 'Repair estimate received', f, 0.85);
    if (f.docType === 'invoice' && f.facts.recovery) add('recovery', f.documentDate, 'Vehicle recovered (recovery invoice)', f, 0.8);
    if (f.docType === 'invoice' && f.facts.storage) add('storage_started', f.documentDate, 'Vehicle in storage (storage invoice)', f, 0.8);
    if (f.facts.offerFound && (f.documentDate || f.emailDate)) {
      const type = f.facts.offerKind === 'pav' ? 'pav_offer_received' : f.facts.offerKind === 'part36' ? 'part36_received' : f.facts.offerKind === 'intervention' ? 'intervention_offer' : 'settlement_offer_received';
      add(type, (f.documentDate ?? f.emailDate)!, `${TIMELINE_EVENT_LABEL[type]} in a letter from ${insurer} — record it in Offers yourself`, f, 0.7, { attributableTo: 'insurer' });
    }
  }
  for (const a of input.aiItems) {
    const file = input.files.find((f) => f.fileId === a.fileId);
    add(a.eventType, a.at, a.summary, { fileId: a.fileId, docType: file?.docType ?? null, ...(file?.source ? { source: file.source } : {}) }, a.confidence, { quote: a.quote, page: a.page, ...(a.source ? { aiSource: a.source } : {}) });
  }

  const order = new Map([...out.keys()].map((k, i) => [k, i]));
  const list = [...out.values()];
  for (const p of list) {
    const before = accidentDay && daysBetween(accidentDay, londonDayOf(p.at) ?? p.at) !== null ? (daysBetween(accidentDay, londonDayOf(p.at)!) ?? 0) < -1 : false;
    if (before) p.note = 'Dated before the accident — check the date before adding it';
    if (p.class === 'owner_only') {
      p.ticked = false;
      p.note = p.note ?? 'You record this yourself (Offers / Hire)';
      continue;
    }
    p.ticked = !before && p.confidence >= input.minAutoTick;
    const owner = input.ticks[p.id];
    if (owner !== undefined) {
      p.ticked = owner;
      p.tickedBy = 'owner';
    }
  }
  return list.sort((a, b) => a.at.localeCompare(b.at) || order.get(a.id)! - order.get(b.id)!);
}

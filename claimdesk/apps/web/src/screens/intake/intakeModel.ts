// owned by intake
/** Intake screen model (docs/SUPREME-DESIGN.md §L.8): labels, tones and the field rows. Pure; unit-tested. */
import type { ExtractedField } from '@ccguk/domain';
import type { Tone } from '../../lib/status';
import type { IntakeItemDetail, IntakeItemRow, IntakeStatus, Proposal } from '../../api/intakeApi';

export const STATUS_LABEL: Record<IntakeStatus, string> = {
  queued: 'Waiting',
  normalising: 'Reading',
  extracting: 'Reading',
  proposed: 'Read',
  applied: 'Done',
  needs_you: 'Needs you',
  failed: 'Problem',
  quota_wait: 'Paused (AI limit)',
  skipped: 'Not read',
};

export const STATUS_TONE: Record<IntakeStatus, Tone> = {
  queued: 'grey',
  normalising: 'blue',
  extracting: 'blue',
  proposed: 'navy',
  applied: 'green',
  needs_you: 'amber',
  failed: 'red',
  quota_wait: 'amber',
  skipped: 'grey',
};

export type IntakeFilter = 'all' | 'needs_you' | 'no_claim' | 'problems';
export const FILTERS: Array<{ id: IntakeFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'needs_you', label: 'Needs you' },
  { id: 'no_claim', label: 'No claim' },
  { id: 'problems', label: 'Problems' },
];

export function filterItems(items: IntakeItemRow[], f: IntakeFilter): IntakeItemRow[] {
  switch (f) {
    case 'needs_you':
      return items.filter((i) => i.status === 'needs_you' || i.proposals.pending > 0);
    case 'no_claim':
      return items.filter((i) => !i.claimId);
    case 'problems':
      return items.filter((i) => i.status === 'failed' || i.status === 'skipped' || i.status === 'quota_wait');
    default:
      return items;
  }
}

/** ≥ 90 % green (fills automatically when empty), ≥ 70 % amber, else red. */
export function confidenceTone(c: number): Tone {
  return c >= 0.9 ? 'green' : c >= 0.7 ? 'amber' : 'red';
}

export const pct = (c: number): string => `${Math.round(Math.max(0, Math.min(1, c)) * 100)}%`;

export interface FieldRow {
  key: string;
  name: string;
  target: string | null;
  value: string | null;
  confidence: number;
  page: number | null;
  quote: string | null;
  /** The newest proposal for this target from this item, if any. */
  proposal?: Proposal;
}

/** The latest extraction's fields, each with its proposal (by target). */
export function fieldRows(detail: Pick<IntakeItemDetail, 'extractions' | 'proposalList'>): FieldRow[] {
  const latest = detail.extractions[detail.extractions.length - 1];
  const fields: ExtractedField[] = latest?.fields ?? [];
  const byTarget = new Map<string, Proposal>();
  for (const p of detail.proposalList) byTarget.set(p.target, p);
  const rows: FieldRow[] = fields.map((f, i) => ({
    key: `${i}:${f.name}`,
    name: f.name,
    target: f.target,
    value: f.value,
    confidence: f.confidence,
    page: f.page,
    quote: f.quote,
    ...(f.target && byTarget.has(f.target) ? { proposal: byTarget.get(f.target)! } : {}),
  }));
  // Proposals the model made with the tool but did not repeat in its result.
  const seen = new Set<string>(fields.map((f) => f.target).filter((t): t is NonNullable<typeof t> => Boolean(t)));
  for (const p of detail.proposalList) {
    if (seen.has(p.target)) continue;
    rows.push({ key: `p:${p.id}`, name: p.label, target: p.target, value: p.proposedValue, confidence: p.confidence, page: p.source.page ?? null, quote: p.source.quote ?? null, proposal: p });
  }
  return rows;
}

export const PROPOSAL_STATUS_LABEL: Record<Proposal['status'], string> = { pending: 'Waiting for you', applied: 'Applied', rejected: 'Rejected', superseded: 'Replaced' };

/** What happens / happened to a proposal, in plain words. */
export function proposalNote(p: Proposal): string {
  if (p.status === 'applied') return p.decidedBy?.startsWith('agent:') ? 'Filled automatically' : `Applied by ${p.decidedBy ?? 'you'}`;
  if (p.status === 'rejected') return p.policyDecision === 'never' ? `Not applied: ${p.validator?.decision?.reason ?? 'not applicable on this claim'}` : `Rejected${p.validator?.decision?.reason ? `: ${p.validator.decision.reason}` : ''}`;
  if (p.status === 'superseded') return 'Replaced by a newer value';
  const reasons = p.validator?.policy?.reasons ?? [];
  return reasons.length ? `Needs you: ${reasons.join('; ')}` : 'Needs you';
}

/** Items a new claim can be started from: read, no claim, not a child of another item. */
export function canStartClaim(i: IntakeItemRow): boolean {
  return !i.claimId && Boolean(i.extraction) && !i.parentItemId;
}

export function evidenceFileUrl(evidenceId: string, page?: number | null): string {
  return `/api/evidence/${encodeURIComponent(evidenceId)}/file${page ? `#page=${page}` : ''}`;
}

/** How to preview the file. */
export function previewKind(row: Pick<IntakeItemRow, 'doc' | 'evidence'>): 'pdf' | 'image' | 'text' | 'none' {
  const kind = row.doc?.kind;
  if (kind === 'pdf') return 'pdf';
  if (kind === 'image') return 'image';
  if (kind === 'docx' || kind === 'email' || kind === 'text') return 'text';
  return 'none';
}

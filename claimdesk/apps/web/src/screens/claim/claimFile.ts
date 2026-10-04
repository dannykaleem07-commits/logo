/**
 * Claim-file shell helpers (pure). The tab list, the API view shape and small selectors shared by every tab.
 *
 * GET /claims/:id returns the ClaimBundle plus derived views (apps/api services/claimView.ts `ClaimView`:
 * gates, actions, acceptance, ledger position, linked claims). Every extra is optional here so the tabs
 * also work against a bare bundle; the dedicated hooks (useClocks, useGates, useActions, useAcceptance)
 * stay the first choice and the view fields are the fallback.
 */
import type { CaseAcceptance, ClaimBundle, ClaimFlag, ClaimStatus, GateResult, HeadOfLoss, Id, Pence, PlaybookAction } from '@ccguk/domain';
import type { TabItem } from '../../components/Tabs';

export interface HeadPositionView {
  head: HeadOfLoss;
  claimedPence: Pence;
  invoicedPence?: Pence;
  offeredPence?: Pence;
  reducedPence?: Pence;
  paidPence: Pence;
  writtenOffPence?: Pence;
  adjustmentPence?: Pence;
  outstandingPence: Pence;
}

export interface ClaimView extends ClaimBundle {
  gates?: GateResult[];
  actions?: PlaybookAction[];
  acceptance?: CaseAcceptance;
  position?: { heads: HeadPositionView[]; totals: Omit<HeadPositionView, 'head'> };
  linkedClaims?: Array<{ id: Id; reference: string; status: ClaimStatus | string }>;
}

export type ClaimTabId = 'overview' | 'chronology' | 'ledger' | 'clocks' | 'gates' | 'hire' | 'offers' | 'evidence' | 'documents' | 'engineering' | 'vehicle' | 'actions' | 'flags';

export const CLAIM_TABS: Array<TabItem & { id: ClaimTabId }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'chronology', label: 'Chronology' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'clocks', label: 'Clocks' },
  { id: 'gates', label: 'Evidence gates' },
  { id: 'hire', label: 'Hire · Storage · Recovery' },
  { id: 'offers', label: 'Intervention register' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'documents', label: 'Documents' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'vehicle', label: 'Vehicle & lookups' },
  { id: 'actions', label: 'Next actions' },
  { id: 'flags', label: 'Flags' }
];

export function isClaimTab(id: string): id is ClaimTabId {
  return CLAIM_TABS.some((t) => t.id === id);
}

/** First list that has rows: the dedicated route's result, else the view's embedded copy, else empty. */
export function pickList<T>(primary: T[] | undefined, fallback: T[] | undefined): T[] {
  if (primary && primary.length > 0) return primary;
  return fallback ?? [];
}

/** Uncleared flags, hard stops first. The API may put flags on the view (`flags`) or only on the claim. */
export function openFlags(view: Pick<ClaimView, 'flags' | 'claim'>): ClaimFlag[] {
  const all = view.flags ?? view.claim.flags ?? [];
  const rank = { block: 0, warn: 1, info: 2 } as const;
  return all.filter((f) => !f.clearedAt).sort((a, b) => rank[a.severity] - rank[b.severity] || a.raisedAt.localeCompare(b.raisedAt));
}

export function hasHardStop(view: Pick<ClaimView, 'flags' | 'claim'>): boolean {
  return openFlags(view).some((f) => f.severity === 'block');
}

/** Statuses that need a written reason on POST /claims/:id/status (litigation documents are drafts for the claimant to sign). */
export const STATUS_REASON_REQUIRED: ReadonlySet<ClaimStatus> = new Set<ClaimStatus>(['pre_action', 'litigation', 'declined', 'closed']);

/** Short plain-English note shown under the status picker for the chosen target. */
export function statusChangeNote(status: ClaimStatus): string | undefined {
  switch (status) {
    case 'payment_pack':
      return 'Payment pack can only go once the evidence gates are green (BLUEPRINT principle 2).';
    case 'pre_action':
    case 'litigation':
      return 'Litigation documents are drafts for the claimant (litigant in person) or an instructed solicitor to sign — CCGUK does not conduct litigation (Legal Services Act 2007 s.12).';
    case 'declined':
      return 'Record why: liability score, costs exposure (Tescher) or a perimeter flag.';
    case 'closed':
      return 'Closing stops every running clock. Give the reason for the file note.';
    default:
      return undefined;
  }
}

export function partyName(view: ClaimView, partyId: Id | undefined): string | undefined {
  if (!partyId) return undefined;
  if (view.claimant.id === partyId) return view.claimant.name;
  if (view.driver?.id === partyId) return view.driver.name;
  if (view.atFaultInsurer?.id === partyId) return view.atFaultInsurer.name;
  return view.thirdParties.find((p) => p.id === partyId)?.name;
}

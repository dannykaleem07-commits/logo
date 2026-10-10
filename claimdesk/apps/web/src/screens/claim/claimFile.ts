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

export type ClaimTabId = 'overview' | 'chronology' | 'ledger' | 'clocks' | 'gates' | 'hire' | 'offers' | 'evidence' | 'documents' | 'engineering' | 'vehicle' | 'actions' | 'flags' | 'mailbox' | 'agent' | 'autopilot';

/**
 * Claim file tabs (0.3 §E1). The primary row holds the six used every day; the rest sit in the "More ▾" menu. Ids (and
 * so the URLs /claims/:id/<tab>) never change. `CLAIM_TABS` lists all 13 in display order: primary, then More.
 */
export const PRIMARY_TAB_IDS: readonly ClaimTabId[] = ['overview', 'hire', 'documents', 'evidence', 'vehicle', 'actions'];
export const MORE_TAB_IDS: readonly ClaimTabId[] = ['chronology', 'ledger', 'clocks', 'gates', 'offers', 'engineering', 'flags'];
/** ClaimDesk Supreme tabs (docs/SUPREME-DESIGN.md §L.5, §L.9): shown after the primary row. */
/** Autopilot (docs/SUPREME-AUTOPILOT.md §I.1) leads the group; the tab itself is built by ap-autopilot. */
export const AGENT_TAB_IDS: readonly ClaimTabId[] = ['autopilot', 'mailbox', 'agent'];

export const CLAIM_TABS: Array<TabItem & { id: ClaimTabId }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'hire', label: 'Hire' },
  { id: 'documents', label: 'Documents' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'vehicle', label: 'Vehicle' },
  { id: 'actions', label: 'Next actions' },
  { id: 'chronology', label: 'Chronology' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'clocks', label: 'Clocks' },
  { id: 'gates', label: 'Evidence gates' },
  { id: 'offers', label: 'Offers' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'flags', label: 'Flags' },
  { id: 'autopilot', label: 'Autopilot' },
  { id: 'mailbox', label: 'Mailbox' },
  { id: 'agent', label: 'Agent' }
];

/**
 * Split tab items (with their badges) into the primary row, the More menu and the Supreme agent tabs (Mailbox, Agent),
 * keeping CLAIM_TABS order. The claim file shows `agent` tabs right after `primary`.
 */
export function splitClaimTabs<T extends { id: string }>(tabs: readonly T[]): { primary: T[]; more: T[]; agent: T[] } {
  return {
    primary: tabs.filter((t) => (PRIMARY_TAB_IDS as readonly string[]).includes(t.id)),
    more: tabs.filter((t) => (MORE_TAB_IDS as readonly string[]).includes(t.id)),
    agent: tabs.filter((t) => (AGENT_TAB_IDS as readonly string[]).includes(t.id))
  };
}

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

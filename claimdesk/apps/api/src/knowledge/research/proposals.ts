// owned by knowledge-research
/**
 * Proposal checks for research findings (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.7, KR-9), all in code. A proposal from
 * `knowledge_propose` is refused (the tool returns an error) unless:
 *   - the kind is fact, precedent, procedure or contact (research never creates rule, strategy or template_snippet);
 *   - every provenance is a snapshot from an allowed, enabled domain (not withheld for injection flags), or a KB id —
 *     a bare `url` only in a web-research run, and then the item can never activate until a snapshot backs it;
 *   - every quote is found in our stored copy (`findQuote`: exact or whitespace-normalised, case-sensitive) and is at
 *     most the source's `maxQuoteWords` (25 when the source allows no extract);
 *   - `scrubForResearch` finds no personal data or claim identifier in the title, body or data;
 *   - `directiveLint(title + body)` finds no instruction-like text — such a proposal is stored REJECTED by KN-04 (audited)
 *     and the tool still returns an error.
 * Accepted proposals go through the store as `origin: 'researched'`, `verification: 'unverified'`; FOS-derived items are
 * tagged `fos` and business Fixmyfile only (KR-4); GTA-derived items carry `gta` / `benchmark_only` (KR-3). The store's
 * decideKnowledge() then auto-applies only low-risk items (KN-16: an internal procedure quoted exactly from an api /
 * code_fetch source); legal, quantum and precedent items always wait for the owner (KN-07, KN-08).
 */
import {
  containsPii,
  directiveLint,
  effectivePolicyKind,
  findQuote,
  isWithheld,
  policyFor,
  quoteWords,
  type ClaimDictionary,
  type KnowledgeArea,
  type KnowledgeData,
  type KnowledgeDecision,
  type KnowledgeKind,
  type KnowledgeProposal,
  type KnowledgeProvenance,
  type KnowledgeScope,
  type SourcePolicyKind,
} from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { getKnowledgeSettings } from '../settings.js';
import { proposeKnowledge } from '../store.js';
import { claimDictionaryFor } from './dictionary.js';
import { readSnapshotText } from './fetcher.js';
import { isOpenGap, setGapStatus } from './gaps.js';
import { extraPolicies, sourceRowFor } from './sources.js';

export const RESEARCH_KINDS: readonly KnowledgeKind[] = ['fact', 'precedent', 'procedure', 'contact'];

export type ResearchProvenanceInput =
  | { kind: 'snapshot'; snapshotId: string; quote: string; anchor: string | null }
  | { kind: 'kb'; entryId: string }
  | { kind: 'url'; url: string; note: string };

export interface ResearchProposalInput {
  gapId: string;
  kind: KnowledgeKind;
  area: KnowledgeArea;
  title: string;
  body: string;
  data: KnowledgeData;
  scope: KnowledgeScope;
  provenance: ResearchProvenanceInput[];
  confidence: number;
}

export class ResearchProposalRefused extends Error {
  readonly code = 'PROPOSAL_REFUSED';
  constructor(readonly problems: string[], readonly decision: KnowledgeDecision | null = null) {
    super(`The proposal was refused: ${problems.join('; ')}`);
  }
}

const POLICY_RANK: Record<SourcePolicyKind, number> = { api: 0, code_fetch: 1, agent_fetch: 2, link_only: 3, deny: 4 };

export interface ResearchProposalResult {
  itemId: string;
  decision: KnowledgeDecision['outcome'];
  status: string;
  reasons: string[];
  quoteChecks: { snapshotId: string; match: 'exact' | 'normalised' }[];
}

/** Check a researcher's proposal in code and hand it to the store (§7.7). Throws ResearchProposalRefused. */
export function proposeResearchFinding(ctx: AppContext, input: ResearchProposalInput, opts: { actor: Actor; runId?: string | null; jobId?: string | null; web?: boolean; dict?: ClaimDictionary }): ResearchProposalResult {
  const settings = getKnowledgeSettings(ctx);
  if (!settings.learningEnabled) throw new ResearchProposalRefused(['learning is paused']);
  const problems: string[] = [];
  const gap = ctx.repos.getKnowledgeGap(ctx.db, input.gapId);
  if (!gap) throw new ResearchProposalRefused([`gap ${input.gapId} not found`]);
  // A run may add several findings: a gap its own earlier finding answered stays open to that run.
  const answeredByThisRun = gap.status === 'answered' && Boolean(opts.runId) && ctx.repos.getKnowledgeItems(ctx.db, gap.answerItemIds).some((i) => i.originRunId === opts.runId);
  if (!isOpenGap(gap) && !answeredByThisRun) problems.push(`gap ${gap.id} is ${gap.status}`);
  if (!RESEARCH_KINDS.includes(input.kind)) problems.push(`research can only propose ${RESEARCH_KINDS.join(', ')} — never a ${input.kind}`);
  if (!input.provenance.length) problems.push('every finding needs a source: a fetched snapshot with an exact quote, or a KB entry');

  const extra = extraPolicies(ctx);
  const provenance: KnowledgeProvenance[] = [];
  const tags = new Set<string>([`gap:${gap.gapKey}`]);
  let fos = false;
  let weakest: SourcePolicyKind | null = null;
  let allExact = true;
  const quoteChecks: ResearchProposalResult['quoteChecks'] = [];
  const supporting = new Set<string>();
  for (const p of input.provenance) {
    if (p.kind === 'kb') {
      if (!ctx.kb.entries().some((e) => e.id === p.entryId)) problems.push(`KB entry ${p.entryId} does not exist`);
      else provenance.push({ kind: 'kb', entryId: p.entryId });
      continue;
    }
    if (p.kind === 'url') {
      if (!opts.web) {
        problems.push('a bare link is not a source: fetch the page with source_fetch and quote it');
        continue;
      }
      const pol = policyFor(p.url, extra);
      if (!pol || pol.policy === 'deny') problems.push(`${p.url} is not on the allow-list`);
      else provenance.push({ kind: 'url', url: p.url, seenAt: ctx.now(), note: p.note.slice(0, 500) });
      continue;
    }
    const snap = ctx.repos.getSourceSnapshot(ctx.db, p.snapshotId);
    if (!snap) {
      problems.push(`snapshot ${p.snapshotId} does not exist`);
      continue;
    }
    const pol = policyFor(snap.finalUrl, extra) ?? policyFor(snap.url, extra);
    const row = pol ? sourceRowFor(ctx, pol) : undefined;
    const kindOf = pol ? effectivePolicyKind(pol, settings) : 'deny';
    if (!pol || kindOf === 'deny' || kindOf === 'link_only') {
      problems.push(`snapshot ${snap.id} is from ${snap.domain}, which is not an allowed source`);
      continue;
    }
    if (row && !row.enabled) problems.push(`${snap.domain} is switched off`);
    if (isWithheld(snap.injectionFlags)) {
      problems.push(`snapshot ${snap.id} was withheld (possible instructions inside) and cannot be cited`);
      continue;
    }
    const text = readSnapshotText(ctx, snap);
    if (text === null) {
      problems.push(`snapshot ${snap.id} has no stored text (pruned)`);
      continue;
    }
    const quote = (p.quote ?? '').trim();
    const match = quote ? findQuote(text, quote) : 'not_found';
    if (match === 'not_found') {
      problems.push(`the quote from snapshot ${snap.id} is not in our stored copy of the page`);
      continue;
    }
    const maxWords = snap.extractAllowed ? pol.maxQuoteWords : Math.min(25, pol.maxQuoteWords);
    if (quoteWords(quote) > maxWords) problems.push(`a quote from ${snap.domain} may be at most ${maxWords} words`);
    if (match !== 'exact') allExact = false;
    quoteChecks.push({ snapshotId: snap.id, match });
    supporting.add(`${snap.id}\u0000${quote}`);
    weakest = weakest === null || POLICY_RANK[kindOf] > POLICY_RANK[weakest] ? kindOf : weakest;
    for (const t of pol.tags) if (t === 'gta' || t === 'benchmark_only' || t === 'fos') tags.add(t);
    if (pol.tags.includes('fos')) fos = true;
    provenance.push({ kind: 'snapshot', snapshotId: snap.id, url: snap.url, fetchedAt: snap.fetchedAt, quote, anchor: p.anchor ? p.anchor.slice(0, 200) : null, quoteMatch: match });
  }

  const dict = opts.dict ?? claimDictionaryFor(ctx);
  const pii = containsPii(`${input.title}\n${input.body}\n${JSON.stringify(input.data ?? {})}`, dict).filter((k) => k !== 'money' && k !== 'dob');
  if (pii.length) problems.push(`the finding carries personal data or a claim identifier (${pii.join(', ')})`);
  if (problems.length) throw new ResearchProposalRefused(problems);

  if (tags.has('gta')) tags.add('benchmark_only');
  const proposal: KnowledgeProposal = {
    kind: input.kind,
    area: input.area,
    title: input.title.trim().slice(0, 200),
    body: input.body,
    data: input.data,
    tags: [...tags],
    scope: input.scope,
    business: fos ? ['fixmyfile'] : ['ccguk'],
    // Legal / quantum points and precedents may become citable only after an owner check (§8.3); the rest stays internal.
    useLimit: input.kind === 'precedent' || input.area === 'legal' || input.area === 'quantum' ? 'outbound_ok' : 'internal',
    origin: 'researched',
    confidence: Math.max(0, Math.min(1, input.confidence)),
    supportN: Math.max(1, supporting.size),
    provenance,
    gapId: gap.id,
    createdBy: opts.actor.userId,
    originRunId: opts.runId ?? null,
    originJobId: opts.jobId ?? null,
  };
  const directive = directiveLint(`${proposal.title}\n${proposal.body}`);
  const r = proposeKnowledge(ctx, proposal, {
    actor: opts.actor,
    runId: opts.runId ?? null,
    jobId: opts.jobId ?? null,
    directiveFlags: directive,
    snapshot: weakest && (weakest === 'api' || weakest === 'code_fetch' || weakest === 'agent_fetch') ? { policy: weakest, quoteMatch: allExact ? 'exact' : 'normalised' } : null,
    group: { key: `knowledge_review:research:${gap.id}`, title: `Research answer: ${gap.question}`.slice(0, 200) },
  });
  if (r.decision.outcome === 'reject') throw new ResearchProposalRefused(r.decision.reasons.map((x) => `${r.decision.ruleIds.join(',')}: ${x}`), r.decision);
  // Link the answer to its gap (the store's onItemStatus hook closes it when the item becomes active).
  const fresh = ctx.repos.getKnowledgeGap(ctx.db, gap.id)!;
  if (!fresh.answerItemIds.includes(r.item.id)) {
    if (r.item.status === 'proposed' && isOpenGap(fresh)) setGapStatus(ctx, gap.id, fresh.status === 'needs_owner' ? 'needs_owner' : 'answered_pending', opts.actor, { answerItemIds: [r.item.id], runId: opts.runId ?? null, jobId: opts.jobId ?? null });
    else ctx.repos.updateKnowledgeGap(ctx.db, gap.id, { answerItemIds: [...fresh.answerItemIds, r.item.id], updatedAt: ctx.now() });
  }
  return { itemId: r.item.id, decision: r.decision.outcome, status: r.item.status, reasons: r.decision.reasons, quoteChecks };
}

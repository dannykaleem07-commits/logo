// owned by intake
/** Response shapes for the intake routes (§L.8): list rows stay small; the detail carries pages, extractions and proposals. */
import type { ClaimUpdateProposalRecord, IntakeItemRecord } from '@ccguk/db';
import type { ExtractedField } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { NormalisedDoc } from './normalise.js';
import { docTypeLabel } from './proposals.js';
import { targetLabel } from './targets.js';

/** Characters of page text returned per page in the detail view. */
export const DETAIL_PAGE_CHARS = 20_000;

export interface ProposalView extends ClaimUpdateProposalRecord {
  label: string;
}

export const proposalView = (p: ClaimUpdateProposalRecord): ProposalView => ({ ...p, label: targetLabel(p.target) });

function docSummary(doc: NormalisedDoc | undefined) {
  if (!doc) return null;
  return {
    kind: doc.kind,
    sniffed: doc.sniffed,
    mime: doc.mime,
    extensionMatches: doc.extensionMatches,
    pages: doc.pages ?? null,
    scanned: doc.scanned ?? false,
    textChars: doc.textChars ?? 0,
    textTruncated: doc.textTruncated ?? false,
    email: doc.email ?? null,
    attachments: doc.attachments ?? [],
    skipReason: doc.skipReason ?? null,
    fingerprint: doc.fingerprint ?? null,
    formTemplateId: doc.formTemplateId ?? null,
    newClaimDraftId: doc.newClaimDraftId ?? null,
  };
}

/**
 * Why an item that is being read is not moving: its intake.extract job is queued (or waiting) while the AI lane is
 * closed — agents switched off (the post-install default), the kill switch, or a usage / sign-in pause.
 */
export function itemWaiting(ctx: AppContext, item: IntakeItemRecord): { reason: 'agents_off' | 'kill_switch' | 'usage' | 'sign_in'; until?: string } | undefined {
  if (!['queued', 'normalising', 'extracting', 'quota_wait'].includes(item.status)) return undefined;
  const job = ctx.repos.listAgentJobs(ctx.db, { type: 'intake.extract', status: ['queued', 'waiting_usage'], limit: 1000 }).find((j) => (j.payload as { itemId?: string } | undefined)?.itemId === item.id);
  if (!job) return undefined;
  const settings = ctx.repos.getAgentSettings(ctx.db);
  if (settings.autonomy.killSwitch) return { reason: 'kill_switch' };
  if (!settings.agents.enabled) return { reason: 'agents_off' };
  const usage = ctx.repos.getAiUsageState(ctx.db);
  if (usage.pausedUntil && usage.pausedUntil > ctx.now()) return { reason: /auth|sign/i.test(usage.pauseReason ?? '') ? 'sign_in' : 'usage', until: usage.pausedUntil };
  return undefined;
}

export function itemRow(ctx: AppContext, item: IntakeItemRecord) {
  const ev = ctx.repos.getEvidence(ctx.db, item.evidenceId);
  const claim = item.claimId ? ctx.repos.getClaim(ctx.db, item.claimId) : undefined;
  const latest = ctx.repos.latestIntakeExtraction(ctx.db, item.id);
  const proposals = ctx.repos.listClaimUpdateProposals(ctx.db, { intakeItemId: item.id });
  const count = (s: ClaimUpdateProposalRecord['status']) => proposals.filter((p) => p.status === s).length;
  const { normalised, ...rest } = item;
  return {
    ...rest,
    docTypeLabel: item.docType ? docTypeLabel(item.docType) : null,
    claimReference: claim?.reference ?? null,
    evidence: ev ? { id: ev.id, filename: ev.filename, mime: ev.mime, bytes: ev.bytes, sha256: ev.sha256, claimId: ev.claimId ?? null, uploadedAt: ev.uploadedAt } : null,
    doc: docSummary(normalised as NormalisedDoc | undefined),
    extraction: latest ? { id: latest.id, runId: latest.runId ?? null, summary: latest.summary ?? null, fields: Array.isArray(latest.fields) ? latest.fields.length : 0, warnings: latest.warnings, createdAt: latest.createdAt } : null,
    proposals: { pending: count('pending'), applied: count('applied'), rejected: count('rejected'), superseded: count('superseded') },
    children: ctx.repos.listIntakeItems(ctx.db, { parentItemId: item.id }).length,
    waiting: itemWaiting(ctx, item) ?? null,
  };
}

export function itemDetail(ctx: AppContext, item: IntakeItemRecord) {
  const doc = item.normalised as NormalisedDoc | undefined;
  const extractions = ctx.repos.listIntakeExtractions(ctx.db, item.id).map((e) => ({ ...e, fields: (Array.isArray(e.fields) ? e.fields : []) as ExtractedField[] }));
  const proposals = ctx.repos.listClaimUpdateProposals(ctx.db, { intakeItemId: item.id }).map(proposalView);
  const openCards = [`confirm_fields:${item.id}`, `new_claim:${item.id}`, `intake:heic:${item.id}`]
    .map((k) => ctx.repos.findOpenNeedsYouByDedupeKey(ctx.db, k))
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .map((n) => ({ id: n.id, kind: n.kind, title: n.title }));
  return {
    ...itemRow(ctx, item),
    pageTexts: (doc?.pageTexts ?? []).map((t) => (t.length > DETAIL_PAGE_CHARS ? `${t.slice(0, DETAIL_PAGE_CHARS)}…` : t)),
    extractions,
    proposalList: proposals,
    childItems: ctx.repos.listIntakeItems(ctx.db, { parentItemId: item.id }).map((c) => itemRow(ctx, c)),
    parent: item.parentItemId ? (() => {
      const p = ctx.repos.getIntakeItem(ctx.db, item.parentItemId);
      return p ? { id: p.id, evidenceId: p.evidenceId } : null;
    })() : null,
    needsYou: openCards,
  };
}

// owned by casework
/**
 * The reviewer (docs/SUPREME-DESIGN.md §C.5 step 5, §E.3, §K.1 point 7): `review.check` on every outbound draft.
 *
 *   tier a (rules, deterministic)  checkDraft with the DraftContext (bundle, prior outgoing letters, template id,
 *                                  recipient role) — for letters the document's own stored consistency report (which is
 *                                  checkDraft + unusedExtraFlags + the system reconciliation) — the @ccguk/documents
 *                                  guards (legacy details, banned phrases), unresolved `{{fact:}}` placeholders, the
 *                                  sign-off, and the red lines of every active brain pack;
 *   tier b (facts, deterministic)  every amount, date and reference in the drafted text must come from a Case Brief
 *                                  fact or appear verbatim in the message being answered (FACT_UNSOURCED, block);
 *                                  citations must be KB entries: unverified → UNVERIFIED_CITATION (warn), failed or
 *                                  unknown → block;
 *   tier c (critic model)          only when tiers a+b found nothing blocking: a separate run of the reviewer agent
 *                                  that sees the brief, the draft and the incoming message — never the drafter's
 *                                  reasoning.
 *
 * The verdict is written as an append-only `reviews` row, then `outbox.after_review` (mail) or
 * `document.after_review` (here) decides. Max 2 repair loops, then escalate.
 */
import { checkDraft, extractAmounts, extractCitations, extractDates, isAlwaysAskTemplate, mayAutoApproveTemplate, MAX_REPAIR_LOOPS, type ReviewTargetKind, type ReviewVerdict } from '@ccguk/domain';
import { findProhibitedContent } from '@ccguk/documents';
import type { GeneratedDocument, RecipientRole } from '@ccguk/domain';
import type { OutboxRecord, ReviewRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import type { EnqueueInput, JobOutcome, JobRecord } from '../agent/contracts.js';
import { createNeedsYou } from '../agent/core.js';
import { agentUserId } from '../agent/principal.js';
import { runAgent } from '../agent/runAgent.js';
import { htmlToText } from '../agent/tools/core.js';
import { loadBundle } from '../services/claimView.js';
import { approveDocument } from '../services/documents.js';
import { kbCitations } from '../services/kb.js';
import { activeRedLines } from '../brain/search.js';
import { knowledgeReviewFlags } from '../knowledge/use/review.js';
import { buildCaseBrief, type CaseBrief } from './caseBrief.js';
import { insertedDisplays, londonIsoDate, PLACEHOLDER_RE } from './facts.js';
import { REVIEWER_SPEC } from './specs.js';
import { aiFailure, isAiOff } from './ai.js';
import { onPackDocumentReviewed } from '../signing/packs.js';

export const REVIEWER = agentUserId('reviewer');
export const SIGN_OFF = 'Claims Team, Courtesy Cars Group UK Ltd';

export type IssueSeverity = 'block' | 'warn' | 'info';
export interface ReviewIssue {
  code: string;
  severity: IssueSeverity;
  where: string;
  message: string;
  fix: string | null;
}
export type Touches = ReviewVerdict['touches'];
export const NO_TOUCHES: Touches = { money: false, liability: false, settlement: false, legal: false, newCommitment: false };

export interface ReviewTarget {
  kind: ReviewTargetKind;
  id: string;
  claimId: string;
  /** The words to review (plain text). */
  text: string;
  /** The drafter's free text only (for letters: the extras; for emails: subject + body). Tier b checks this. */
  freeText: string;
  templateId: string;
  recipientRole?: RecipientRole;
  /** The incoming message this answers (its text is quotable). */
  answering?: { id: string; text: string };
  document?: GeneratedDocument;
  outbox?: OutboxRecord;
  /** The draft was prepared because information is missing (draft.compose missingInfo). */
  missingInfo: boolean;
  /** The job that produced the draft (draft.compose / mail.reply), when known. */
  sourceJob?: JobRecord;
}

// ---------------------------------------------------------------------------
// Loading the target
// ---------------------------------------------------------------------------

const lc = (s: string): string => s.trim().toLowerCase();

function emailRole(ctx: AppContext, claimId: string, addresses: string[]): RecipientRole | undefined {
  const bundle = loadBundle(ctx, claimId);
  const insurerDomain = bundle.atFaultInsurer?.email?.split('@')[1]?.toLowerCase();
  for (const a of addresses.map(lc)) {
    if (bundle.claimant.email && lc(bundle.claimant.email) === a) return 'client';
    if (bundle.atFaultInsurer?.email && lc(bundle.atFaultInsurer.email) === a) return 'at_fault_insurer';
    if (insurerDomain && a.endsWith(`@${insurerDomain}`)) return 'at_fault_insurer';
  }
  return addresses.length ? 'other' : undefined;
}

function stringLeaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringLeaves(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringLeaves(x, out));
  return out;
}

/** The job that produced a draft: the parent of the review job (draft tools enqueue review.check as a follow-up). */
function sourceJobOf(ctx: AppContext, reviewJob: Pick<JobRecord, 'parentJobId'> | undefined, outbox?: OutboxRecord): JobRecord | undefined {
  const metaJob = (outbox?.policy as { draftMeta?: { jobId?: string } } | undefined)?.draftMeta?.jobId;
  const id = metaJob ?? reviewJob?.parentJobId;
  return id ? (ctx.repos.getAgentJob(ctx.db, id) as JobRecord | undefined) : undefined;
}

export function loadReviewTarget(ctx: AppContext, kind: ReviewTargetKind, id: string, reviewJob?: Pick<JobRecord, 'parentJobId'>): ReviewTarget {
  if (kind === 'outbox') {
    const o = ctx.repos.requireOutbox(ctx.db, id);
    if (!o.claimId) throw new Error(`outbox ${id} is not on a claim`);
    const sourceMessageId = (o.policy as { draftMeta?: { sourceMessageId?: string } } | undefined)?.draftMeta?.sourceMessageId;
    const answered = sourceMessageId ? ctx.repos.getMailMessage(ctx.db, sourceMessageId) : undefined;
    const job = sourceJobOf(ctx, reviewJob, o);
    const text = `${o.subject}\n\n${o.bodyText}`;
    return {
      kind,
      id,
      claimId: o.claimId,
      text,
      freeText: text,
      templateId: `email.${o.kind}`,
      ...(emailRole(ctx, o.claimId, [...o.toJson, ...o.ccJson]) ? { recipientRole: emailRole(ctx, o.claimId, [...o.toJson, ...o.ccJson])! } : {}),
      ...(answered ? { answering: { id: answered.id, text: `${answered.subject ?? ''}\n${answered.bodyText ?? ''}` } } : {}),
      outbox: o,
      missingInfo: o.kind === 'doc_request' || Boolean((job?.payload as { missingInfo?: boolean } | undefined)?.missingInfo),
      ...(job ? { sourceJob: job } : {}),
    };
  }
  const d = ctx.repos.requireDocument(ctx.db, id, { includeHtml: true });
  if (!d.claimId) throw new Error(`document ${id} is not on a claim`);
  const snapshot = (d.dataSnapshot ?? {}) as Record<string, unknown>;
  const extras = snapshot._handlerExtra ?? (snapshot._docx as { inputs?: unknown } | undefined)?.inputs;
  const job = sourceJobOf(ctx, reviewJob);
  const text = d.html ? htmlToText(d.html) : stringLeaves((snapshot._docx as { values?: unknown } | undefined)?.values ?? {}).join('\n');
  const replyTo = (job?.payload as { replyToMessageId?: string | null } | undefined)?.replyToMessageId;
  const answered = replyTo ? ctx.repos.getMailMessage(ctx.db, replyTo) : undefined;
  return {
    kind,
    id,
    claimId: d.claimId,
    text,
    freeText: stringLeaves(extras ?? {}).join('\n'),
    templateId: d.templateId,
    document: d,
    ...(answered ? { answering: { id: answered.id, text: `${answered.subject ?? ''}\n${answered.bodyText ?? ''}` } } : {}),
    missingInfo: Boolean((job?.payload as { missingInfo?: boolean } | undefined)?.missingInfo),
    ...(job ? { sourceJob: job } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tier a — rules
// ---------------------------------------------------------------------------

const issue = (code: string, severity: IssueSeverity, where: string, message: string, fix: string | null = null): ReviewIssue => ({ code, severity, where, message, fix });

export function rulesTier(ctx: AppContext, t: ReviewTarget): { issues: ReviewIssue[]; redLines: string[] } {
  const issues: ReviewIssue[] = [];
  if (t.document) {
    for (const f of t.document.consistency?.flags ?? []) {
      if (f.clearedAt) continue;
      issues.push(issue(f.code, f.severity, f.excerpt ?? 'document', f.message, null));
    }
    if (t.document.status === 'blocked' && !issues.some((i) => i.severity === 'block')) issues.push(issue('DOCUMENT_BLOCKED', 'block', 'document', 'The document is blocked by the consistency check'));
  } else {
    const bundle = loadBundle(ctx, t.claimId, true);
    const report = checkDraft(t.text, {
      bundle,
      priorOutgoing: ctx.repos.listDocuments(ctx.db, { claimId: t.claimId, status: ['approved', 'sent', 'signed'], includeHtml: true }),
      draftCreatedAt: t.outbox?.createdAt ?? ctx.now(),
      templateId: t.templateId,
      ...(t.recipientRole ? { recipientRole: t.recipientRole } : {}),
      kbCitations: kbCitations(ctx),
      registeredName: ctx.settings().companyName,
      now: ctx.now(),
    });
    for (const f of report.flags) issues.push(issue(f.code, f.severity, f.excerpt ?? 'email', f.message));
    if (!t.text.includes(SIGN_OFF)) issues.push(issue('SIGNOFF_MISSING', 'warn', 'sign-off', `Emails are signed "${SIGN_OFF}"`, `End the email with "${SIGN_OFF}"`));
  }
  for (const hit of findProhibitedContent(t.text)) {
    if (!issues.some((i) => i.code === (hit.kind === 'legacy' ? 'LEGACY_DETAIL' : 'BANNED_PHRASE') && i.where === hit.excerpt)) {
      issues.push(issue(hit.kind === 'legacy' ? 'LEGACY_DETAIL' : 'BANNED_PHRASE', 'block', hit.excerpt, `Prohibited ${hit.kind === 'legacy' ? 'legacy detail' : 'phrase'}: "${hit.needle}"`, 'Remove it'));
    }
  }
  const leftover = [...t.text.matchAll(new RegExp(PLACEHOLDER_RE.source, 'g'))].map((m) => m[1]!);
  for (const id of [...new Set(leftover)]) issues.push(issue('FACT_UNKNOWN', 'block', `{{fact:${id}}}`, `The placeholder {{fact:${id}}} is not a Case Brief fact`, 'Use a fact id from the Case Brief'));
  const redLines: string[] = [];
  for (const r of activeRedLines(ctx)) {
    if (!r.pattern) continue;
    let re: RegExp;
    try {
      re = new RegExp(r.pattern, 'i');
    } catch {
      continue;
    }
    const m = re.exec(t.text);
    if (!m) continue;
    redLines.push(r.ref);
    issues.push(issue(r.action === 'escalate' ? 'RED_LINE_ESCALATE' : 'RED_LINE', r.action === 'escalate' ? 'warn' : 'block', m[0].slice(0, 120), `${r.message} (${r.ref})`, r.action === 'block' ? 'Remove or reword this passage' : null));
  }
  if (t.missingInfo) issues.push(issue('MISSING_INFO_REQUEST', 'info', 'draft', 'Prepared because information is missing: the owner confirms before it is sent'));
  // Knowledge Builder §8.3 (knowledge-use): may this draft cite / state the knowledge it rests on?
  for (const f of knowledgeReviewFlags(ctx, { kind: t.kind, id: t.id, claimId: t.claimId, text: t.text, ...(t.recipientRole ? { recipientRole: t.recipientRole } : {}) })) issues.push(issue(f.code, f.severity, f.excerpt ?? 'knowledge', f.message));
  return { issues, redLines };
}

// ---------------------------------------------------------------------------
// Tier b — facts
// ---------------------------------------------------------------------------

export interface FactsTierResult {
  issues: ReviewIssue[];
  amounts: number;
  dates: number;
  references: number;
  citations: number;
}

const REFERENCE_RE = /\b(?:CCG-\d{4}-\d{5}|[A-Z]{2,6}[/-]\d{2,4}[/-][A-Z0-9]{3,})\b/g;
const norm = (s: string): string => s.toUpperCase().replace(/[\s/-]/g, '');

/** Tier b (§E.3): every amount, date and reference sourced; citations known and verified. */
export function factsTier(ctx: AppContext, t: ReviewTarget, brief: CaseBrief): FactsTierResult {
  const issues: ReviewIssue[] = [];
  const text = t.freeText;
  const quoted = t.answering?.text ?? '';
  const facts = Object.values(brief.facts);
  const factPence = new Set<number>();
  const factDates = new Set<string>();
  const factRefs = new Set<string>();
  for (const f of facts) {
    if (typeof f.value === 'number' && f.display.startsWith('£')) factPence.add(f.value);
    if (typeof f.value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(f.value)) factDates.add(londonIsoDate(f.value));
    if (typeof f.value === 'string') factRefs.add(norm(f.value));
  }
  for (const d of insertedDisplays(t.claimId)) {
    for (const a of extractAmounts(d)) factPence.add(a.pence);
    for (const x of extractDates(d)) factDates.add(x.iso);
  }
  const quotedPence = new Set(extractAmounts(quoted).map((a) => a.pence));
  const quotedDates = new Set(extractDates(quoted).map((d) => d.iso));
  const quotedRefs = new Set([...quoted.matchAll(REFERENCE_RE)].map((m) => norm(m[0])));

  const amounts = extractAmounts(text);
  for (const a of amounts) {
    if (factPence.has(a.pence) || quotedPence.has(a.pence)) continue;
    issues.push(issue('FACT_UNSOURCED', 'block', a.excerpt, `The amount £${(a.pence / 100).toFixed(2)} is not a Case Brief figure and is not quoted from the message being answered`, 'Write figures only as {{fact:<id>}} placeholders'));
  }
  const dates = extractDates(text);
  for (const d of dates) {
    if (factDates.has(d.iso) || quotedDates.has(d.iso)) continue;
    issues.push(issue('FACT_UNSOURCED', 'block', d.excerpt, `The date ${d.raw} is not a Case Brief date and is not quoted from the message being answered`, 'Write dates only as {{fact:<id>}} placeholders'));
  }
  const refs = [...text.matchAll(REFERENCE_RE)].map((m) => m[0]);
  for (const r of refs) {
    if (factRefs.has(norm(r)) || quotedRefs.has(norm(r))) continue;
    issues.push(issue('FACT_UNSOURCED', 'block', r, `The reference ${r} is not on the claim and is not quoted from the message being answered`, 'Use {{fact:claim.reference}} / {{fact:claim.atFaultInsurerRef}}'));
  }
  const kb = ctx.kb.entries();
  const citations = extractCitations(text);
  for (const c of citations) {
    const needle = (c.neutral ?? c.caseName ?? c.citation).toLowerCase();
    const entry = kb.find((e) => e.citation.toLowerCase().includes(needle) || (e.title ?? '').toLowerCase().includes(needle));
    const status = (entry?.verification as { status?: string } | undefined)?.status;
    if (!entry) issues.push(issue('CITATION_UNKNOWN', 'block', c.excerpt, `${c.citation} is not a knowledge-base entry`, 'Cite only KB or pack entries'));
    else if (status === 'failed') issues.push(issue('CITATION_FAILED', 'block', c.excerpt, `${c.citation} failed verification in the knowledge base (${entry.id})`, 'Remove the citation'));
    else if (status !== 'verified' && !/unverified/i.test(c.excerpt)) issues.push(issue('UNVERIFIED_CITATION', 'warn', c.excerpt, `${c.citation} is unverified in the knowledge base (${entry.id}); say so if you rely on it`, 'Word it as an unverified authority or remove it'));
  }
  return { issues, amounts: amounts.length, dates: dates.length, references: refs.length, citations: citations.length };
}

// ---------------------------------------------------------------------------
// Touches and verdict
// ---------------------------------------------------------------------------

/** Deterministic floor for the "touches" flags (the critic can only add to them). */
export function detTouches(text: string): Touches {
  return {
    money: /£\s?\d/.test(text) || /\b(payment|paid|invoice|remittance|balance)\b/i.test(text),
    liability: /\bliabilit(y|ies)\b|\bat fault\b|\bfault\b/i.test(text),
    settlement: /\b(offer|settle(ment)?|without prejudice|full and final|accept(ed|ance)?|counter[- ]?offer|part 36)\b/i.test(text),
    legal:
      /\b(proceedings|court|claim form|solicitor|letter before (claim|action)|litigation|pre-action|ombudsman|complaint|data subject access|dsar|injur(y|ies)|fraud(ulent)?|staged|induced|dishonest(y)?|fundamental dishonesty|insurance fraud bureau|investigators?|police)\b/i.test(text) ||
      /\b(IFB|CUE)\b/.test(text),
    newCommitment: /\b(we will|we undertake|we agree|we guarantee|we promise|we shall)\b/i.test(text),
  };
}

const orTouches = (a: Touches, b?: Partial<Touches>): Touches => ({
  money: a.money || Boolean(b?.money),
  liability: a.liability || Boolean(b?.liability),
  settlement: a.settlement || Boolean(b?.settlement),
  legal: a.legal || Boolean(b?.legal),
  newCommitment: a.newCommitment || Boolean(b?.newCommitment),
});

const RANK = { pass: 0, repair: 1, escalate: 2 } as const;
export type Verdict = keyof typeof RANK;

export function combineVerdict(det: Verdict, critic: Verdict | undefined, loop: number): Verdict {
  const v = critic && RANK[critic] > RANK[det] ? critic : det;
  return v === 'repair' && loop >= MAX_REPAIR_LOOPS ? 'escalate' : v;
}

export function detVerdict(issues: ReviewIssue[]): Verdict {
  if (issues.some((i) => i.code === 'RED_LINE_ESCALATE' || i.code === 'KNOWLEDGE_CONFLICTED')) return 'escalate';
  if (issues.some((i) => i.severity === 'block')) return 'repair';
  return 'pass';
}

// ---------------------------------------------------------------------------
// review.check
// ---------------------------------------------------------------------------

export interface ReviewCheckPayload {
  targetKind: ReviewTargetKind;
  targetId: string;
  claimId?: string;
  loop?: number;
}

export interface ReviewCheckResult {
  reviewId: string;
  verdict: Verdict;
  issues: number;
  critic: 'ran' | 'skipped' | 'unavailable';
}

/** Run the three tiers, write the review row and return the follow-up (after_review) job. */
export async function runReviewCheck(ctx: AppContext, job: JobRecord, payload: ReviewCheckPayload): Promise<JobOutcome<ReviewCheckResult>> {
  let target: ReviewTarget;
  try {
    target = loadReviewTarget(ctx, payload.targetKind, payload.targetId, job);
  } catch (err) {
    return { kind: 'fail', reason: err instanceof Error ? err.message : String(err) };
  }
  // A repaired draft is a new document/outbox whose own review starts at 0: the loop lives on the drafting job.
  const loop = Math.max(payload.loop ?? 0, Number((target.sourceJob?.payload as { loop?: unknown } | undefined)?.loop ?? 0) || 0);
  if (target.outbox && target.outbox.status !== 'reviewing' && target.outbox.status !== 'draft') return { kind: 'done', result: { reviewId: '', verdict: 'pass', issues: 0, critic: 'skipped' } as ReviewCheckResult };
  if (target.document && target.document.status !== 'draft' && target.document.status !== 'blocked') return { kind: 'done', result: { reviewId: '', verdict: 'pass', issues: 0, critic: 'skipped' } as ReviewCheckResult };

  const brief = buildCaseBrief(ctx, target.claimId, { mask: false });
  const a = rulesTier(ctx, target);
  const b = factsTier(ctx, target, brief);
  const detIssues = [...a.issues, ...b.issues];
  const det = detVerdict(detIssues);
  // Letters: the template's own wording is the owner's (allow-listed); only the drafter's free text and the critic count.
  let touches = detTouches(target.kind === 'outbox' ? target.text : target.freeText);

  let critic: ReviewVerdict | undefined;
  let criticState: ReviewCheckResult['critic'] = 'skipped';
  let runId: string | undefined;
  if (det === 'pass') {
    const run = await runAgent(ctx, REVIEWER_SPEC, job, {
      task: `Review the ${target.kind === 'outbox' ? 'email' : 'letter'} draft ${target.id} on claim ${brief.reference} (claimId ${target.claimId}) before it can leave. You did not write it and you do not see how it was written. Find what is wrong.`,
      brief: buildCaseBrief(ctx, target.claimId),
      untrusted: [
        { kind: 'document', id: `draft:${target.id}`, text: target.text.slice(0, 40_000) },
        ...(target.answering ? [{ kind: 'email' as const, id: target.answering.id, text: target.answering.text.slice(0, 20_000) }] : []),
      ],
      question: [
        `Template / kind: ${target.templateId}. Recipient role: ${target.recipientRole ?? 'unknown'}. Review loop ${loop}.`,
        `Deterministic checks already passed (rules, facts). Check tone, whether it answers what was asked, accuracy against the Case Brief, anything that touches money, liability, settlement, legal steps or a new commitment, and whether it is safe to send.`,
        'Return the ReviewVerdict JSON.',
      ].join('\n'),
    });
    runId = run.runId;
    const failure = aiFailure(ctx, run.outcome);
    if (failure && !isAiOff(run.outcome)) return failure as JobOutcome<ReviewCheckResult>;
    if (run.outcome.kind === 'ok' && run.result) {
      critic = run.result as ReviewVerdict;
      criticState = 'ran';
      touches = orTouches(touches, critic.touches);
    } else criticState = 'unavailable';
  }
  const verdict = combineVerdict(det, critic?.verdict, loop);
  const review: ReviewRecord = ctx.repos.appendReview(ctx.db, {
    targetKind: target.kind,
    targetId: target.id,
    claimId: target.claimId,
    loop,
    rules: { issues: a.issues, redLines: a.redLines, templateId: target.templateId, recipientRole: target.recipientRole ?? null, missingInfo: target.missingInfo },
    facts: { issues: b.issues, checked: { amounts: b.amounts, dates: b.dates, references: b.references, citations: b.citations } },
    ...(critic ? { critic } : criticState === 'unavailable' ? { critic: { unavailable: true, confidence: 0.5, issues: [] } } : {}),
    verdict,
    touches,
    ...(runId ? { runId } : {}),
    now: ctx.now(),
  });
  const followUp: EnqueueInput =
    target.kind === 'outbox'
      ? { type: 'outbox.after_review', payload: { outboxId: target.id, reviewId: review.id }, claimId: target.claimId, idempotencyKey: `outbox.after_review:${target.id}:${review.id}`, createdBy: REVIEWER }
      : { type: 'document.after_review', payload: { documentId: target.id, reviewId: review.id, targetKind: target.kind }, claimId: target.claimId, idempotencyKey: `document.after_review:${target.id}:${review.id}`, createdBy: REVIEWER };
  return { kind: 'done', result: { reviewId: review.id, verdict, issues: detIssues.length + (critic?.issues.length ?? 0), critic: criticState }, followUps: [followUp] };
}

// ---------------------------------------------------------------------------
// document.after_review
// ---------------------------------------------------------------------------

export interface DocumentAfterReviewResult {
  outcome: 'approved' | 'asked' | 'repair' | 'skipped';
  needsYouId?: string;
  jobId?: string;
  reason?: string;
}

const allIssues = (r: ReviewRecord): ReviewIssue[] =>
  [r.rules, r.facts, r.critic].flatMap((x) => {
    const list = (x as { issues?: unknown } | undefined)?.issues;
    return Array.isArray(list) ? (list as ReviewIssue[]) : [];
  });

const anyTouch = (t: Touches): boolean => t.money || t.liability || t.settlement || t.legal || t.newCommitment;

/**
 * §D.5 + §C.5 step 5 for a stand-alone letter / Word form: allow-listed template + zero open flags + pass review +
 * nothing missing or sensitive → approved by the automated path (`document.approve.auto`); a repair inside the loop
 * limit → the drafter again; everything else → Needs-you `approve_document` with the prepared document.
 */
export async function documentAfterReview(ctx: AppContext, job: JobRecord, payload: { documentId: string; reviewId: string }): Promise<JobOutcome<DocumentAfterReviewResult>> {
  const review = ctx.repos.getReview(ctx.db, payload.reviewId);
  if (!review || review.targetId !== payload.documentId) return { kind: 'fail', reason: `review ${payload.reviewId} is not a review of document ${payload.documentId}` };
  const doc = ctx.repos.getDocument(ctx.db, payload.documentId);
  if (!doc) return { kind: 'fail', reason: `document ${payload.documentId} not found` };
  if (doc.status !== 'draft' && doc.status !== 'blocked') return { kind: 'done', result: { outcome: 'skipped', reason: `document is ${doc.status}` } };
  // Autopilot stage packs (SUPREME-AUTOPILOT §D.6, ap-paperwork): a pack member is approved with its pack (approve_pack).
  if (onPackDocumentReviewed(ctx, doc, review)) return { kind: 'done', result: { outcome: 'skipped', reason: 'reviewed with its paperwork pack' } };
  const claimId = doc.claimId!;
  const issues = allIssues(review);
  const missingInfo = Boolean((review.rules as { missingInfo?: boolean } | undefined)?.missingInfo);
  const settings = ctx.repos.getAgentSettings(ctx.db).autonomy;
  const allowListed = mayAutoApproveTemplate(settings, doc.templateId) && !isAlwaysAskTemplate(doc.templateId);
  const openFlags = (doc.consistency?.flags ?? []).filter((f) => (f.severity === 'block' || f.severity === 'warn') && !f.clearedAt);
  const reasons: string[] = [];

  if (review.verdict === 'repair' && review.loop < MAX_REPAIR_LOOPS) {
    const source = sourceJobOf(ctx, job.parentJobId ? (ctx.repos.getAgentJob(ctx.db, job.parentJobId) as JobRecord | undefined) : undefined);
    if (source?.type === 'draft.compose') {
      const p = source.payload as Record<string, unknown>;
      return {
        kind: 'done',
        result: { outcome: 'repair' },
        followUps: [
          {
            type: 'draft.compose',
            payload: { ...p, repairOf: doc.id, loop: review.loop + 1, issues: issues.filter((i) => i.severity !== 'info').slice(0, 30) },
            claimId,
            idempotencyKey: `draft.compose:${claimId}:repair:${doc.id}:${review.loop + 1}`,
            createdBy: REVIEWER,
          },
        ],
      };
    }
    reasons.push('the reviewer asked for changes');
  }
  if (review.verdict === 'escalate' || (review.verdict === 'repair' && review.loop >= MAX_REPAIR_LOOPS)) reasons.push(review.verdict === 'escalate' ? 'the reviewer escalated it' : `still not right after ${review.loop} repair loop(s)`);
  if (!allowListed) reasons.push(`${doc.templateId} is not allow-listed for automatic approval`);
  if (openFlags.length || doc.status === 'blocked') reasons.push(`open consistency flags: ${openFlags.map((f) => f.code).join(', ') || 'blocked'}`);
  if (missingInfo) reasons.push('it asks for missing information');
  if (anyTouch(review.touches)) reasons.push(`it touches ${Object.entries(review.touches).filter(([, v]) => v).map(([k]) => k).join(', ')}`);
  const criticConfidence = (review.critic as { confidence?: number } | undefined)?.confidence;
  if (review.verdict === 'pass' && (typeof criticConfidence !== 'number' || criticConfidence < settings.thresholds.external)) reasons.push(`reviewer confidence ${typeof criticConfidence === 'number' ? criticConfidence.toFixed(2) : 'unknown'} is below ${settings.thresholds.external}`);
  if (settings.killSwitch) reasons.push('agents are stopped (kill switch)');

  if (!reasons.length && review.verdict === 'pass') {
    try {
      await approveDocument(ctx, doc.id, { userId: REVIEWER, ...(review.runId ? { runId: review.runId } : {}) }, 'Approved automatically: allow-listed template, zero flags, reviewer pass', undefined, { automated: { reviewId: review.id, ruleIds: ['allowlist', 'review_pass'] } });
      ctx.repos.appendAudit(ctx.db, { actor: { userId: REVIEWER, ...(review.runId ? { runId: review.runId } : {}) }, action: 'agent.policy', entity: 'documents', entityId: doc.id, after: { tool: 'document.approve', outcome: 'auto', ruleIds: ['allowlist', 'review_pass'], reviewId: review.id }, at: ctx.now() });
      return { kind: 'done', result: { outcome: 'approved' } };
    } catch (err) {
      reasons.push(`automatic approval refused: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const reference = ctx.repos.getClaim(ctx.db, claimId)?.reference ?? '';
  const ny = createNeedsYou(ctx, {
    kind: 'approve_document',
    claimId,
    title: `${missingInfo ? 'Missing information — prepared letter' : 'Approve letter'}${reference ? ` on ${reference}` : ''}: ${doc.title}`,
    summary: `${doc.title} is drafted and reviewed. It needs you because ${reasons.join('; ')}.`.slice(0, 2000),
    recommendation: {
      action: review.verdict === 'pass' ? 'Approve this letter' : 'Check and correct this letter',
      why: review.verdict === 'pass' ? 'It passed the reviewer; only the owner may approve it here.' : `Reviewer verdict: ${review.verdict}.`,
      confidence: typeof criticConfidence === 'number' ? criticConfidence : 0.5,
      basis: [{ kind: 'rule', id: `review:${review.id}`, label: `review ${review.verdict}` }],
    },
    options: [
      { id: 'approve', label: 'Approve', tone: 'primary' },
      { id: 'reject', label: 'Reject (void the draft)', tone: 'danger', requiresReason: true },
    ],
    payload: { documentId: doc.id, reviewId: review.id, templateId: doc.templateId, missingInfo, reasons, issues: issues.slice(0, 30) },
    priority: missingInfo ? 'high' : 'normal',
    createdBy: REVIEWER,
    dedupeKey: `approve_document:${doc.id}`,
    correlationId: job.correlationId,
    ...(review.runId ? { runId: review.runId } : {}),
  });
  return { kind: 'done', result: { outcome: 'asked', needsYouId: ny.id, reason: reasons.join('; ') } };
}

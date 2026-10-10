// owned by mail
/**
 * Outbound email (docs/SUPREME-DESIGN.md §D.2, §D.3, §D.5, §F.6–§F.8).
 *
 *   createEmailDraft   email_draft: placeholders resolved by code, subject tagged [CCG-YYYY-NNNNN], attachments only from
 *                      the claim, draft → reviewing, review.check queued
 *   describeOutbox     the ActionDescriptor the policy sees (recipient verified / on the claim / first contact,
 *                      disclosure allow-list, review verdict + touches, confidence)
 *   afterReview        outbox.after_review: decide() → auto_held (auto-approve allow-listed attached letters, hold,
 *                      toast with Undo, outbox.release at hold_until) | ask (approve_send / missing_info) |
 *                      repair (≤ 2 loops) | escalate (question)
 *   releaseOutbox      outbox.release: kill switch, pauses and rate limits re-checked → SMTP → only after acceptance:
 *                      sent copy as evidence, `sent`, APPEND to Sent, email_out, sendDocument, audit email.send
 *   undo / approve / retry / ownerCompose
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  decide,
  isAlwaysAskEmailKind,
  isAlwaysAskTemplate,
  MAX_REPAIR_LOOPS,
  EMAIL_KINDS,
  type ActionDescriptor,
  type Decision,
  type EmailKind,
  type EvidenceKind,
  type MailIntent,
  type RecipientRole,
} from '@ccguk/domain';
import type { Actor, MailAccountRecord, OutboxAttachmentRef, OutboxRecord, ReviewRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import type { JobRecord } from '../agent/contracts.js';
import { autonomyState, createNeedsYou, enqueueJob, getAutonomy, londonDayWindow, londonHhmm } from '../agent/core.js';
import { gatewayServices } from '../ai/prompts.js';
import { notifyOwner } from '../notify/index.js';
import { absoluteEvidencePath, stageBuffer, storeEvidence } from '../services/evidence.js';
import { approveDocument, resolvePdfPath, sendDocument } from '../services/documents.js';
import { STRICT_GATE } from '../services/override.js';
import { isAutomatedActor } from '../services/humanOnly.js';
import { badRequest, conflict } from '../errors.js';
import { MAIL_ACTOR, MAIL_AGENT, appendClaimEvent, fromHeader, mailAccount } from './common.js';
import { INTENT_RULES } from './intents.js';
import { directoryDomains } from './parse.js';
import { mailboxFor, newMessageId, smtpFor, MailTransportError } from './transport.js';

export const OWNER_UNDO_SECONDS = 30;
export const SEND_MAX_ATTEMPTS = 3;
/** Backoff before send attempt 2 and 3. */
export const SEND_BACKOFF_MS = [60_000, 5 * 60_000] as const;
export const KILL_SWITCH_RECHECK_MS = 5 * 60_000;
export const SENT_FOLDER = 'Sent';

/** transitionOutbox stamped with the app clock (tests freeze it). */
function transition(ctx: AppContext, id: string, to: Parameters<AppContext['repos']['transitionOutbox']>[2], actor: string, reason: string, opts: Parameters<AppContext['repos']['transitionOutbox']>[5] = {}): OutboxRecord {
  return ctx.repos.transitionOutbox(ctx.db, id, to, actor, reason, { now: ctx.now(), ...opts });
}

const isEmailKind = (k: string): k is EmailKind => (EMAIL_KINDS as readonly string[]).includes(k);

// ---------------------------------------------------------------------------
// Disclosure control (§F.7)
// ---------------------------------------------------------------------------

/** Evidence kinds that may go to the at-fault insurer automatically. */
export const INSURER_EVIDENCE_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['photo', 'video', 'dashcam', 'cctv', 'estimate', 'invoice', 'engineer_report', 'v5c', 'mot_certificate', 'correspondence', 'insurance_certificate', 'screenshot', 'witness_statement']);
/** Never automatically, to anyone but the client: statement of means, bank statements, payslips, licence images, medical. */
export const NEVER_AUTO_EVIDENCE_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['bank_statement', 'payslip', 'licence']);
const NEVER_AUTO_TEMPLATE_PREFIXES = ['statement.', 'form.statement_of_means', 'form.medical'];

export interface AttachmentCheck {
  allowed: boolean;
  reasons: string[];
}

/** Is every attachment allowed for every recipient role (§F.7)? */
export function checkAttachments(ctx: AppContext, claimId: string | undefined, attachments: OutboxAttachmentRef[], roles: RecipientRole[]): AttachmentCheck {
  const reasons: string[] = [];
  for (const a of attachments) {
    if (a.evidenceId) {
      const e = ctx.repos.getEvidence(ctx.db, a.evidenceId);
      if (!e || e.claimId !== claimId) {
        reasons.push(`evidence ${a.evidenceId} is not on this claim`);
        continue;
      }
      const text = `${e.filename} ${e.description ?? ''}`.toLowerCase();
      const medical = /\b(medical|gp|hospital|physio|injur)/.test(text);
      for (const role of roles) {
        if (role === 'client') continue;
        if (NEVER_AUTO_EVIDENCE_KINDS.has(e.kind) || medical) reasons.push(`${e.filename} (${medical ? 'medical' : e.kind}) is never sent automatically`);
        else if (role === 'at_fault_insurer' && !INSURER_EVIDENCE_KINDS.has(e.kind)) reasons.push(`${e.filename} (${e.kind}) is not on the at-fault insurer allow-list`);
        else if (role !== 'at_fault_insurer' && !['photo', 'correspondence'].includes(e.kind)) reasons.push(`${e.filename} (${e.kind}) is not sent automatically to ${role}`);
      }
    } else if (a.documentId) {
      const d = ctx.repos.getDocument(ctx.db, a.documentId, { includeHtml: false });
      if (!d || d.claimId !== claimId) {
        reasons.push(`document ${a.documentId} is not on this claim`);
        continue;
      }
      if (NEVER_AUTO_TEMPLATE_PREFIXES.some((p) => d.templateId.startsWith(p)) && roles.some((r) => r !== 'client')) reasons.push(`${d.title} is never sent automatically`);
      if (!['draft', 'approved', 'signed'].includes(d.status)) reasons.push(`${d.title} is ${d.status}`);
    } else {
      reasons.push('an attachment names neither evidence nor a document');
    }
  }
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

export interface RecipientInfo {
  address: string;
  role: RecipientRole;
  verified: boolean;
  firstContact: boolean;
  onClaim: boolean;
}

const lc = (s: string | undefined | null): string => (s ?? '').trim().toLowerCase();

/** Who an address is on this claim: a party email (verified), a directory-verified handler address, or a past sender. */
export function recipientInfo(ctx: AppContext, claimId: string | undefined, address: string, excludeOutboxId?: string): RecipientInfo {
  const addr = lc(address);
  const unknown: RecipientInfo = { address: addr, role: 'other', verified: false, firstContact: true, onClaim: false };
  if (!claimId) return unknown;
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  if (!claim) return unknown;
  const firstContact = ctx.repos.countSentOutboxTo(ctx.db, claimId, addr, excludeOutboxId) === 0;
  const roleOf: Array<[string | undefined, RecipientRole]> = [
    [claim.claimantId, 'client'],
    [claim.driverId, 'client'],
    [claim.atFaultInsurerId, 'at_fault_insurer'],
    [claim.clientInsurerId, 'own_insurer'],
    ...claim.thirdPartyIds.map((id) => [id, 'other'] as [string, RecipientRole]),
  ];
  for (const [pid, role] of roleOf) {
    if (!pid) continue;
    const p = ctx.repos.getParty(ctx.db, pid);
    if (p?.email && lc(p.email) === addr) return { address: addr, role, verified: true, firstContact, onClaim: true };
  }
  const insurer = claim.atFaultInsurerId ? ctx.repos.getParty(ctx.db, claim.atFaultInsurerId) : undefined;
  const entry = insurer ? ctx.kb.directory().find((e) => lc(e.name) === lc(insurer.name) || e.brands.some((b) => lc(b) === lc(insurer.name))) : undefined;
  if (entry) {
    const listed = [entry.claimsEmail, entry.thirdPartyEmail, entry.complaintsEmail].map(lc).filter(Boolean);
    if (listed.includes(addr)) return { address: addr, role: 'at_fault_insurer', verified: entry.verification?.status === 'verified', firstContact, onClaim: true };
  }
  const sender = ctx.repos.listMailMessages(ctx.db, { claimId, direction: 'in', limit: 1000 }).some((m) => lc(m.fromAddr) === addr || lc(m.replyTo) === addr);
  if (sender) {
    const domain = addr.split('@')[1] ?? '';
    const insurerDomain = (entry ? directoryDomains(entry) : []).includes(domain) || (insurer?.email ? lc(insurer.email).endsWith(`@${domain}`) : false);
    return { address: addr, role: insurerDomain ? 'at_fault_insurer' : 'other', verified: false, firstContact, onClaim: true };
  }
  return { ...unknown, firstContact };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface EmailDraftInput {
  claimId: string;
  kind: EmailKind;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  attach: Array<{ evidenceId: string | null; documentId: string | null }>;
  inReplyToMessageId: string | null;
}

export interface DraftMeta {
  loop: number;
  jobId?: string;
  sourceMessageId?: string;
  /** The agent run that drafted it (mail.reply / draft.compose): later agent audits on this outbox carry it (§K.5). */
  runId?: string;
}

const PLACEHOLDER_RE = /\{\{\s*fact:[^}]+\}\}/;

/** §F.4: every outbound subject carries the bracketed reference " [CCG-YYYY-NNNNN]" (a bare mention is not enough). */
export function tagSubject(subject: string, reference: string): string {
  const s = subject.trim();
  return s.toUpperCase().includes(`[${reference.toUpperCase()}]`) ? s : `${s} [${reference}]`;
}

/** Create an outbox draft from an agent (email_draft) and send it to review. */
export function createEmailDraft(ctx: AppContext, input: EmailDraftInput, actor: string, meta: DraftMeta & { correlationId?: string; parentJobId?: string }): { outbox: OutboxRecord; attachmentsAllowed: boolean; attachmentNotes: string[]; reviewJobId: string } {
  const claim = ctx.repos.requireClaim(ctx.db, input.claimId);
  const account = mailAccount(ctx);
  if (!account) throw conflict('MAIL_NOT_SET_UP', 'No mailbox is set up yet (Settings > Email); the email cannot be drafted');
  let subject = input.subject;
  let body = input.bodyText;
  if (PLACEHOLDER_RE.test(subject) || PLACEHOLDER_RE.test(body)) {
    const resolve = gatewayServices(ctx).resolvePlaceholders;
    if (!resolve) throw conflict('PLACEHOLDERS_UNRESOLVED', 'Figures and dates must come from {{fact:…}} placeholders, but no fact resolver is available yet; write the email without them or ask the owner');
    subject = resolve(ctx, claim.id, subject);
    body = resolve(ctx, claim.id, body);
    if (PLACEHOLDER_RE.test(subject) || PLACEHOLDER_RE.test(body)) throw conflict('PLACEHOLDERS_UNRESOLVED', 'Some {{fact:…}} placeholders could not be resolved');
  }
  const attachments: OutboxAttachmentRef[] = [];
  for (const a of input.attach) {
    if (a.evidenceId) {
      const e = ctx.repos.getEvidence(ctx.db, a.evidenceId);
      if (!e || e.claimId !== claim.id) throw conflict('WRONG_CLAIM', `Evidence ${a.evidenceId} is not on claim ${claim.reference}`);
      attachments.push({ evidenceId: e.id, filename: e.filename, mime: e.mime, role: e.kind });
    } else if (a.documentId) {
      const d = ctx.repos.getDocument(ctx.db, a.documentId, { includeHtml: false });
      if (!d || d.claimId !== claim.id) throw conflict('WRONG_CLAIM', `Document ${a.documentId} is not on claim ${claim.reference}`);
      attachments.push({ documentId: d.id, filename: `${d.title.replace(/[^A-Za-z0-9 ._-]+/g, '_').slice(0, 80) || d.id}.pdf`, mime: 'application/pdf', role: d.templateId });
    }
  }
  const signature = account.signatureText?.trim();
  if (signature && !body.includes(signature)) body = `${body.trimEnd()}\n\n${signature}`;
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  let threadKey: string | undefined;
  if (input.inReplyToMessageId) {
    const parent = ctx.repos.getMailMessage(ctx.db, input.inReplyToMessageId);
    if (!parent || parent.claimId !== claim.id) throw conflict('WRONG_CLAIM', `Message ${input.inReplyToMessageId} is not filed on claim ${claim.reference}`);
    if (parent.messageId) {
      inReplyTo = parent.messageId;
      references = [...(parent.referencesJson ?? []), parent.messageId].slice(-20);
    }
    threadKey = parent.threadKey;
  }
  const roles = [...input.to, ...input.cc].map((a) => recipientInfo(ctx, claim.id, a).role);
  const check = checkAttachments(ctx, claim.id, attachments, roles);
  const outbox = ctx.db.transaction(() => {
    const o = ctx.repos.createOutbox(ctx.db, {
      claimId: claim.id,
      accountId: account.id,
      kind: input.kind,
      to: input.to.map(lc),
      cc: input.cc.map(lc),
      subject: tagSubject(subject, claim.reference),
      bodyText: body,
      attachments,
      inReplyTo: inReplyTo ?? null,
      references: references ?? null,
      threadKey: threadKey ?? null,
      createdBy: actor,
      reason: 'drafted',
      now: ctx.now(),
    });
    return transition(ctx, o.id, 'reviewing', actor, 'sent to the reviewer', { patch: { policy: { draftMeta: { ...meta, ...(input.inReplyToMessageId ? { sourceMessageId: input.inReplyToMessageId } : {}) } } }, now: ctx.now() });
  });
  ctx.repos.appendAudit(ctx.db, { actor: { userId: actor, ...(meta.runId ? { runId: meta.runId } : {}) }, action: 'outbox.draft', entity: 'outbox', entityId: outbox.id, after: { claimId: claim.id, kind: input.kind, to: outbox.toJson, attachments: attachments.length, attachmentsAllowed: check.allowed }, at: ctx.now() });
  const review = enqueueJob(ctx, {
    type: 'review.check',
    payload: { targetKind: 'outbox', targetId: outbox.id, claimId: claim.id, loop: meta.loop },
    claimId: claim.id,
    idempotencyKey: `review.check:outbox:${outbox.id}:${meta.loop}`,
    createdBy: actor,
    ...(meta.parentJobId ? { parentJobId: meta.parentJobId } : {}),
    ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
  });
  return { outbox, attachmentsAllowed: check.allowed, attachmentNotes: check.reasons, reviewJobId: review.id };
}

// ---------------------------------------------------------------------------
// Policy descriptor
// ---------------------------------------------------------------------------

export function draftMetaOf(o: OutboxRecord): DraftMeta {
  const m = (o.policy as { draftMeta?: DraftMeta } | undefined)?.draftMeta;
  return { loop: Number(m?.loop ?? 0), ...(m?.jobId ? { jobId: m.jobId } : {}), ...(m?.sourceMessageId ? { sourceMessageId: m.sourceMessageId } : {}), ...(m?.runId ? { runId: m.runId } : {}) };
}

/** The mail agent as the actor of a write about this outbox row, with the run that drafted it (§K.5). */
function mailActorFor(o: OutboxRecord): Actor {
  const runId = draftMetaOf(o).runId;
  return runId ? { ...MAIL_ACTOR, runId } : MAIL_ACTOR;
}

function criticOf(review: ReviewRecord | undefined): { confidence?: number; issues: Array<{ code?: string; severity?: string; message?: string }> } {
  const c = (review?.critic ?? {}) as { confidence?: unknown; issues?: unknown };
  const rules = (review?.rules ?? {}) as { issues?: unknown };
  const facts = (review?.facts ?? {}) as { issues?: unknown };
  const issues = [c.issues, rules.issues, facts.issues].flatMap((x) => (Array.isArray(x) ? (x as Array<Record<string, string>>) : []));
  return { ...(typeof c.confidence === 'number' ? { confidence: c.confidence } : {}), issues };
}

/**
 * What the email being answered was about (its latest triage): a legal-route intent (fraud allegation, complaint,
 * solicitor, court…) makes the reply touch `legal`; an offer-route intent (settlement, PAV, interim payment,
 * intervention offer) makes it touch `settlement`. `ref` is a mail_messages id (draftMeta.sourceMessageId) or, as a
 * fallback, the RFC Message-ID the outbox replies to.
 */
export function sourceIntentTouches(ctx: AppContext, ref: string | undefined | null): { legal: boolean; settlement: boolean; intent?: string } {
  if (!ref) return { legal: false, settlement: false };
  let message = ctx.repos.getMailMessage(ctx.db, ref);
  if (!message && ref.includes('@')) {
    const row = ctx.handle.sqlite.prepare("SELECT id FROM mail_messages WHERE message_id = ? AND direction = 'in' ORDER BY received_at DESC LIMIT 1").get(ref) as { id: string } | undefined;
    if (row) message = ctx.repos.getMailMessage(ctx.db, row.id);
  }
  if (!message) return { legal: false, settlement: false };
  const c = ctx.repos.latestMailClassification(ctx.db, message.id);
  const intents = c ? [c.intent, ...(c.secondary ?? [])] : [];
  const routes = intents.map((i) => INTENT_RULES[i as MailIntent]?.route).filter(Boolean);
  return { legal: routes.includes('legal'), settlement: routes.includes('offer'), ...(c ? { intent: c.intent } : {}) };
}

/** The ActionDescriptor for sending an outbox row (§D.2). */
export function describeOutbox(ctx: AppContext, o: OutboxRecord, review: ReviewRecord | undefined): { descriptor: ActionDescriptor; recipients: RecipientInfo[]; attachments: AttachmentCheck } {
  const recipients = [...o.toJson, ...o.ccJson, ...o.bccJson].map((a) => recipientInfo(ctx, o.claimId, a, o.id));
  // The policy sees the weakest recipient.
  const worst = recipients.find((r) => !r.onClaim) ?? recipients.find((r) => !r.verified) ?? recipients.find((r) => r.firstContact) ?? recipients[0];
  const attachments = checkAttachments(ctx, o.claimId, o.attachmentsJson, recipients.map((r) => r.role));
  const docs = o.attachmentsJson.map((a) => (a.documentId ? ctx.repos.getDocument(ctx.db, a.documentId, { includeHtml: false }) : undefined)).filter((d): d is NonNullable<typeof d> => Boolean(d));
  const settings = getAutonomy(ctx);
  // One templateId reaches the policy: an attached template that would ask wins.
  const blockingDoc = docs.find((d) => isAlwaysAskTemplate(d.templateId) || !settings.autoSendTemplates.includes(d.templateId));
  const templateId = (blockingDoc ?? docs[0])?.templateId;
  const critic = criticOf(review);
  const confidence = Math.min(...[o.confidence, critic.confidence].filter((x): x is number => typeof x === 'number'), 1);
  const hasConfidence = typeof o.confidence === 'number' || typeof critic.confidence === 'number';
  const missingInfo = o.kind === 'doc_request' || critic.issues.some((i) => /MISSING/i.test(i.code ?? ''));
  const consistencyBlocked = docs.some((d) => d.status === 'blocked' || Boolean(d.consistency?.blocked)) || critic.issues.some((i) => i.severity === 'block');
  // §D.1: a reply to a legal matter or an offer always asks, whatever the wording of the reply.
  const sourceTouches = sourceIntentTouches(ctx, draftMetaOf(o).sourceMessageId ?? o.inReplyTo);
  const touches = review ? { ...review.touches, ...(sourceTouches.legal ? { legal: true } : {}), ...(sourceTouches.settlement ? { settlement: true } : {}) } : undefined;
  const descriptor: ActionDescriptor = {
    class: 'external_send',
    kind: `email.${o.kind}`,
    ...(o.claimId ? { claimId: o.claimId } : {}),
    ...(isEmailKind(o.kind) ? { emailKind: o.kind } : {}),
    ...(templateId ? { templateId } : {}),
    ...(worst ? { recipient: { address: worst.address, role: worst.role, verified: worst.verified, firstContact: worst.firstContact, onClaim: worst.onClaim } } : {}),
    confidence: hasConfidence ? confidence : 0,
    ...(review && touches ? { review: { verdict: review.verdict, touches } } : {}),
    consistencyBlocked,
    missingInfo,
    attachmentsAllowed: attachments.allowed,
  };
  return { descriptor, recipients, attachments };
}

// ---------------------------------------------------------------------------
// After review
// ---------------------------------------------------------------------------

const ownerOptions = [
  { id: 'approve', label: 'Approve and send', tone: 'primary' as const },
  { id: 'edit', label: 'Edit then send', tone: 'neutral' as const, requiresEdit: true },
  { id: 'reject', label: 'Do not send', tone: 'danger' as const, requiresReason: true },
];

function preparedEmail(o: OutboxRecord) {
  return { outboxId: o.id, email: { to: o.toJson, cc: o.ccJson, subject: o.subject, bodyText: o.bodyText, attachments: o.attachmentsJson, kind: o.kind } };
}

function askOwner(ctx: AppContext, o: OutboxRecord, decision: Decision, kind: 'approve_send' | 'missing_info' | 'question', job: Pick<JobRecord, 'correlationId'>, extra: { title?: string; summary?: string; issues?: unknown } = {}) {
  const reference = o.claimId ? ctx.repos.getClaim(ctx.db, o.claimId)?.reference : undefined;
  const title =
    extra.title ?? (kind === 'missing_info' ? `Missing information — prepared request${reference ? ` on ${reference}` : ''}` : `Approve email${reference ? ` on ${reference}` : ''}: ${o.subject}`);
  return createNeedsYou(ctx, {
    kind,
    ...(o.claimId ? { claimId: o.claimId } : {}),
    title: title.slice(0, 200),
    summary: (extra.summary ?? `To ${o.toJson.join(', ')}. ${decision.reasons.join('; ') || 'The policy asks you first.'}`).slice(0, 2000),
    recommendation: { action: 'Send this email', why: decision.reasons.join('; ') || 'Prepared by the agents and passed review', confidence: typeof o.confidence === 'number' ? o.confidence : 0.5, basis: [{ kind: 'rule', id: decision.ruleIds[0] ?? 'policy', label: decision.reasons[0] ?? null }] },
    options: ownerOptions,
    payload: { ...preparedEmail(o), decision: { outcome: decision.outcome, ruleIds: decision.ruleIds, reasons: decision.reasons }, ...(extra.issues ? { issues: extra.issues } : {}) },
    priority: kind === 'question' ? 'high' : 'normal',
    createdBy: MAIL_AGENT,
    dedupeKey: `${kind}:outbox:${o.id}`,
    correlationId: job.correlationId,
    ...(draftMetaOf(o).runId ? { runId: draftMetaOf(o).runId } : {}),
  });
}

export interface AfterReviewResult {
  outcome: 'held' | 'asked' | 'repair' | 'escalated' | 'skipped';
  outboxId: string;
  needsYouId?: string;
  holdUntil?: string;
  jobs: string[];
}

/** outbox.after_review (§C.5 step 5, §D.3). */
export async function afterReview(ctx: AppContext, outboxId: string, reviewId: string | undefined, job: Pick<JobRecord, 'id' | 'correlationId'>): Promise<AfterReviewResult> {
  const o = ctx.repos.requireOutbox(ctx.db, outboxId);
  if (o.status !== 'reviewing') return { outcome: 'skipped', outboxId, jobs: [] };
  const review = reviewId ? ctx.repos.getReview(ctx.db, reviewId) : ctx.repos.latestReviewFor(ctx.db, { kind: 'outbox', id: outboxId });
  if (!review || review.targetId !== outboxId) throw conflict('REVIEW_MISSING', `No review of outbox ${outboxId}`);
  const meta = draftMetaOf(o);
  const loop = Math.max(review.loop, meta.loop);
  const base = { createdBy: MAIL_AGENT, parentJobId: job.id, correlationId: job.correlationId };
  const keepMeta = { draftMeta: meta };

  // Repair (or a policy deny that the drafter can fix) — at most MAX_REPAIR_LOOPS times.
  const critic = criticOf(review);
  if (review.verdict === 'repair') {
    if (loop < MAX_REPAIR_LOOPS && meta.sourceMessageId && o.claimId) {
      transition(ctx, o.id, 'cancelled', MAIL_AGENT, `reviewer asked for a repair (loop ${loop + 1})`, { from: 'reviewing', patch: { reviewId: review.id } });
      const original = meta.jobId ? ctx.repos.getAgentJob(ctx.db, meta.jobId) : undefined;
      const p = (original?.payload ?? {}) as { plan?: string; keyPoints?: string[] };
      const j = enqueueJob(ctx, {
        type: 'mail.reply',
        payload: { claimId: o.claimId, messageId: meta.sourceMessageId, plan: p.plan ?? `Redraft the reply "${o.subject}"`, keyPoints: p.keyPoints ?? [], repairOf: o.id, issues: critic.issues.slice(0, 30), loop: loop + 1 },
        claimId: o.claimId,
        idempotencyKey: `mail.reply:${meta.sourceMessageId}:${loop + 1}`,
        ...base,
      });
      return { outcome: 'repair', outboxId, jobs: [j.id] };
    }
    const ny = askOwner(ctx, o, { outcome: 'ask', reasons: [`The reviewer still wants changes after ${loop} repair loop(s)`], ruleIds: ['repair_limit'] }, 'question', job, { title: `Email needs your help: ${o.subject}`, issues: critic.issues });
    transition(ctx, o.id, 'awaiting_approval', MAIL_AGENT, 'repair limit reached', { from: 'reviewing', patch: { reviewId: review.id, policy: { ...keepMeta, outcome: 'ask', ruleIds: ['repair_limit'] } } });
    return { outcome: 'escalated', outboxId, needsYouId: ny.id, jobs: [] };
  }
  if (review.verdict === 'escalate') {
    const ny = askOwner(ctx, o, { outcome: 'ask', reasons: ['The reviewer escalated this email to you'], ruleIds: ['review_escalate'] }, 'question', job, { title: `Reviewer escalated an email: ${o.subject}`, issues: critic.issues });
    transition(ctx, o.id, 'awaiting_approval', MAIL_AGENT, 'reviewer escalated', { from: 'reviewing', patch: { reviewId: review.id, policy: { ...keepMeta, outcome: 'ask', ruleIds: ['review_escalate'] } } });
    return { outcome: 'escalated', outboxId, needsYouId: ny.id, jobs: [] };
  }

  const { descriptor } = describeOutbox(ctx, o, review);
  const decision = decide(descriptor, getAutonomy(ctx), autonomyState(ctx, { ...(o.claimId ? { claimId: o.claimId } : {}), agent: 'mail' }));
  ctx.repos.appendAudit(ctx.db, { actor: mailActorFor(o), action: 'agent.policy', entity: 'outbox', entityId: o.id, after: { tool: 'send_request', outcome: decision.outcome, ruleIds: decision.ruleIds, reasons: decision.reasons, reviewId: review.id }, at: ctx.now() });

  if (decision.outcome === 'auto_held') {
    // §D.5: attached allow-listed draft letters are approved by the agent on the strength of their own pass review.
    for (const a of o.attachmentsJson) {
      if (!a.documentId) continue;
      const doc = ctx.repos.getDocument(ctx.db, a.documentId, { includeHtml: false });
      if (!doc || doc.status !== 'draft') continue;
      const docReview = ctx.repos.latestReviewFor(ctx.db, { kind: 'document', id: doc.id }) ?? ctx.repos.latestReviewFor(ctx.db, { kind: 'docx', id: doc.id });
      try {
        if (!docReview) throw conflict('HUMAN_REQUIRED', `${doc.title} has no review of its own`);
        await approveDocument(ctx, doc.id, MAIL_ACTOR, `Approved automatically with email ${o.id}`, STRICT_GATE, { automated: { reviewId: docReview.id, ruleIds: decision.ruleIds } });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        const asked: Decision = { outcome: 'ask', reasons: [`The attached ${doc.title} needs your approval: ${why}`], ruleIds: ['attachments'] };
        const ny = askOwner(ctx, o, asked, 'approve_send', job);
        transition(ctx, o.id, 'awaiting_approval', MAIL_AGENT, asked.reasons[0]!, { from: 'reviewing', patch: { reviewId: review.id, policy: { ...keepMeta, ...asked } } });
        return { outcome: 'asked', outboxId, needsYouId: ny.id, jobs: [] };
      }
    }
    const holdUntil = new Date(Date.parse(ctx.now()) + (decision.holdMinutes ?? getAutonomy(ctx).holdMinutes) * 60_000).toISOString();
    const held = transition(ctx, o.id, 'held', MAIL_AGENT, decision.reasons.join('; ') || 'allowed', { from: 'reviewing', patch: { reviewId: review.id, holdUntil, policy: { ...keepMeta, ...decision } } });
    const minutes = Math.round((Date.parse(holdUntil) - Date.parse(ctx.now())) / 60_000);
    const reference = held.claimId ? ctx.repos.getClaim(ctx.db, held.claimId)?.reference : undefined;
    try {
      notifyOwner(ctx, {
        level: 'normal',
        kind: 'held_send',
        title: `Sending in ${minutes} min — Undo`,
        body: `"${held.subject}" to ${held.toJson.join(', ')} is held until ${londonHhmm(holdUntil)}. Undo stops it; after it is sent it cannot be undone.`,
        link: `/outbox/${held.id}`,
        undoOutboxId: held.id,
        toastTitle: `Sending in ${minutes} min — Undo`,
        toastBody: `${reference ?? 'Email'} · ${held.kind.replace(/_/g, ' ')}`,
      });
    } catch (err) {
      ctx.logger.warn('held-send notification failed', { error: String(err) });
    }
    // Not a hand-off: the release keeps the correlation id but does not deepen the chain (loop guard, §C.4).
    const rel = enqueueJob(ctx, { type: 'outbox.release', payload: { outboxId: held.id }, ...(held.claimId ? { claimId: held.claimId } : {}), runAfter: holdUntil, idempotencyKey: `outbox.release:${held.id}:${holdUntil}`, createdBy: MAIL_AGENT, correlationId: job.correlationId });
    return { outcome: 'held', outboxId, holdUntil, jobs: [rel.id] };
  }

  if (decision.outcome === 'deny' && meta.sourceMessageId && loop < MAX_REPAIR_LOOPS && o.claimId) {
    // not_reviewed / consistency_blocked: back to the drafter with the reasons.
    transition(ctx, o.id, 'cancelled', MAIL_AGENT, `policy: ${decision.reasons.join('; ')}`, { from: 'reviewing', patch: { reviewId: review.id } });
    const j = enqueueJob(ctx, {
      type: 'mail.reply',
      payload: { claimId: o.claimId, messageId: meta.sourceMessageId, plan: `Redraft the reply "${o.subject}"`, keyPoints: [], repairOf: o.id, issues: [...decision.reasons.map((r) => ({ code: decision.ruleIds[0] ?? 'policy', severity: 'block', message: r })), ...critic.issues].slice(0, 30), loop: loop + 1 },
      claimId: o.claimId,
      idempotencyKey: `mail.reply:${meta.sourceMessageId}:${loop + 1}`,
      ...base,
    });
    return { outcome: 'repair', outboxId, jobs: [j.id] };
  }

  // ask (or a deny that cannot be repaired): the owner gets the prepared email.
  const kind = decision.outcome === 'deny' ? 'question' : descriptor.missingInfo ? 'missing_info' : 'approve_send';
  const ny = askOwner(ctx, o, decision, kind, job);
  transition(ctx, o.id, 'awaiting_approval', MAIL_AGENT, decision.reasons.join('; ') || 'owner approval needed', { from: 'reviewing', patch: { reviewId: review.id, policy: { ...keepMeta, ...decision } } });
  return { outcome: 'asked', outboxId, needsYouId: ny.id, jobs: [] };
}

// ---------------------------------------------------------------------------
// Owner actions
// ---------------------------------------------------------------------------

export interface OwnerEdits {
  to?: string[];
  cc?: string[];
  subject?: string;
  bodyText?: string;
}

export function parseOwnerEdits(edits: unknown): OwnerEdits | undefined {
  if (!edits || typeof edits !== 'object') return undefined;
  const e = edits as Record<string, unknown>;
  const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : typeof v === 'string' ? v.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : undefined);
  const out: OwnerEdits = {};
  const to = list(e.to);
  const cc = list(e.cc);
  if (to) out.to = to;
  if (cc) out.cc = cc;
  if (typeof e.subject === 'string') out.subject = e.subject;
  if (typeof e.bodyText === 'string') out.bodyText = e.bodyText;
  return Object.keys(out).length ? out : undefined;
}

const editPatch = (e: OwnerEdits | undefined) => (e ? { ...(e.to ? { to: e.to.map(lc) } : {}), ...(e.cc ? { cc: e.cc.map(lc) } : {}), ...(e.subject !== undefined ? { subject: e.subject } : {}), ...(e.bodyText !== undefined ? { bodyText: e.bodyText } : {}) } : {});

function assertPerson(actor: Actor, what: string): void {
  if (isAutomatedActor(actor)) throw conflict('HUMAN_REQUIRED', `A person must ${what}`);
}

/** The owner approves (optionally edited): straight to `queued` with approved_by — no hold (§D.3). */
export function approveOutbox(ctx: AppContext, id: string, actor: Actor, edits?: OwnerEdits, note?: string): OutboxRecord {
  assertPerson(actor, 'approve an email');
  const now = ctx.now();
  const o = transition(ctx, id, 'queued', actor.userId, note ? `approved: ${note}` : edits ? 'approved with edits' : 'approved', {
    from: ['awaiting_approval', 'held', 'draft'],
    patch: { ...editPatch(edits), approvedBy: actor.userId, approvedAt: now, holdUntil: null },
    now,
  });
  ctx.repos.appendAudit(ctx.db, { actor, action: 'outbox.approve', entity: 'outbox', entityId: id, after: { claimId: o.claimId ?? null, edited: Boolean(edits), note: note ?? null }, at: now });
  enqueueJob(ctx, { type: 'outbox.release', payload: { outboxId: id }, ...(o.claimId ? { claimId: o.claimId } : {}), idempotencyKey: `outbox.release:${id}:approved:${now}`, createdBy: actor.userId });
  return o;
}

/** Undo a held (or queued, not yet sending) email. After sending, Undo is impossible. */
export function undoOutbox(ctx: AppContext, id: string, actor: Actor): OutboxRecord {
  const cur = ctx.repos.requireOutbox(ctx.db, id);
  if (cur.status === 'sending' || cur.status === 'sent') throw conflict('OUTBOX_SENT', 'This email has already gone to the mail server; it cannot be undone');
  const o = transition(ctx, id, 'cancelled', actor.userId, 'undo', { from: ['held', 'queued', 'awaiting_approval'], now: ctx.now() });
  ctx.repos.appendAudit(ctx.db, { actor, action: 'outbox.undo', entity: 'outbox', entityId: id, after: { claimId: o.claimId ?? null, subject: o.subject }, at: ctx.now() });
  return o;
}

/** Owner: send a held email now (skips the rest of the hold). */
export function sendNowOutbox(ctx: AppContext, id: string, actor: Actor): OutboxRecord {
  return approveOutbox(ctx, id, actor, undefined, 'send now');
}

/** Owner: retry a failed email. */
export function retryOutbox(ctx: AppContext, id: string, actor: Actor): OutboxRecord {
  assertPerson(actor, 'retry an email');
  const o = transition(ctx, id, 'queued', actor.userId, 'retry', { from: 'failed', patch: { attempts: 0, lastError: null, approvedBy: actor.userId, approvedAt: ctx.now() } });
  enqueueJob(ctx, { type: 'outbox.release', payload: { outboxId: id }, ...(o.claimId ? { claimId: o.claimId } : {}), idempotencyKey: `outbox.release:${id}:retry:${ctx.now()}`, createdBy: actor.userId });
  return o;
}

export function rejectOutbox(ctx: AppContext, id: string, actor: Actor, reason: string): OutboxRecord {
  assertPerson(actor, 'reject an email');
  const o = transition(ctx, id, 'cancelled', actor.userId, `rejected: ${reason}`, { from: ['awaiting_approval', 'held', 'draft', 'reviewing'] });
  ctx.repos.appendAudit(ctx.db, { actor, action: 'outbox.reject', entity: 'outbox', entityId: id, after: { reason }, at: ctx.now() });
  return o;
}

export interface OwnerComposeInput {
  claimId?: string;
  kind?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  attach?: Array<{ evidenceId?: string | null; documentId?: string | null }>;
  inReplyToMessageId?: string | null;
  checkBeforeSending?: boolean;
}

/** The owner's own email: 30-second Undo and no review — unless "check before sending" is ticked (§L.5). */
export function ownerCompose(ctx: AppContext, input: OwnerComposeInput, actor: Actor): OutboxRecord {
  assertPerson(actor, 'compose an email');
  const account = mailAccount(ctx);
  if (!account) throw conflict('MAIL_NOT_SET_UP', 'Set up the mailbox in Settings > Email first');
  if (!input.to.length) throw badRequest('Add at least one recipient');
  const claim = input.claimId ? ctx.repos.requireClaim(ctx.db, input.claimId) : undefined;
  const attachments: OutboxAttachmentRef[] = [];
  for (const a of input.attach ?? []) {
    if (a.evidenceId) {
      const e = ctx.repos.getEvidence(ctx.db, a.evidenceId);
      if (!e || (claim && e.claimId !== claim.id)) throw conflict('WRONG_CLAIM', `Evidence ${a.evidenceId} is not on this claim`);
      attachments.push({ evidenceId: e.id, filename: e.filename, mime: e.mime, role: e.kind });
    } else if (a.documentId) {
      const d = ctx.repos.getDocument(ctx.db, a.documentId, { includeHtml: false });
      if (!d || (claim && d.claimId !== claim.id)) throw conflict('WRONG_CLAIM', `Document ${a.documentId} is not on this claim`);
      if (d.status !== 'approved' && d.status !== 'signed') throw conflict('DOCUMENT_STATE', `${d.title} must be approved before it is emailed`);
      attachments.push({ documentId: d.id, filename: `${d.title.replace(/[^A-Za-z0-9 ._-]+/g, '_').slice(0, 80) || d.id}.pdf`, mime: 'application/pdf', role: d.templateId });
    }
  }
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  let threadKey: string | undefined;
  if (input.inReplyToMessageId) {
    const parent = ctx.repos.getMailMessage(ctx.db, input.inReplyToMessageId);
    if (parent?.messageId) {
      inReplyTo = parent.messageId;
      references = [...(parent.referencesJson ?? []), parent.messageId].slice(-20);
      threadKey = parent.threadKey;
    }
  }
  const signature = account.signatureText?.trim();
  const body = signature && !input.bodyText.includes(signature) ? `${input.bodyText.trimEnd()}\n\n${signature}` : input.bodyText;
  const now = ctx.now();
  const created = ctx.repos.createOutbox(ctx.db, {
    claimId: claim?.id ?? null,
    accountId: account.id,
    kind: input.kind ?? 'reply_general',
    to: input.to.map(lc),
    cc: (input.cc ?? []).map(lc),
    bcc: (input.bcc ?? []).map(lc),
    subject: claim ? tagSubject(input.subject, claim.reference) : input.subject,
    bodyText: body,
    attachments,
    inReplyTo: inReplyTo ?? null,
    references: references ?? null,
    threadKey: threadKey ?? null,
    createdBy: actor.userId,
    reason: 'composed by the owner',
    now,
  });
  ctx.repos.appendAudit(ctx.db, { actor, action: 'outbox.compose', entity: 'outbox', entityId: created.id, after: { claimId: claim?.id ?? null, to: created.toJson, check: Boolean(input.checkBeforeSending) }, at: now });
  if (input.checkBeforeSending && claim) {
    const o = transition(ctx, created.id, 'reviewing', actor.userId, 'owner asked for a check before sending', { patch: { policy: { draftMeta: { loop: 0 }, owner: true } }, now });
    enqueueJob(ctx, { type: 'review.check', payload: { targetKind: 'outbox', targetId: o.id, claimId: claim.id, loop: 0 }, claimId: claim.id, idempotencyKey: `review.check:outbox:${o.id}:0`, createdBy: actor.userId });
    return o;
  }
  const holdUntil = new Date(Date.parse(now) + OWNER_UNDO_SECONDS * 1000).toISOString();
  const o = transition(ctx, created.id, 'held', actor.userId, `owner compose: ${OWNER_UNDO_SECONDS}-second undo`, { patch: { holdUntil, approvedBy: actor.userId, approvedAt: now, policy: { outcome: 'owner', ruleIds: ['owner_compose'], reasons: ['Written by the owner'] } }, now });
  enqueueJob(ctx, { type: 'outbox.release', payload: { outboxId: o.id }, ...(o.claimId ? { claimId: o.claimId } : {}), runAfter: holdUntil, idempotencyKey: `outbox.release:${o.id}:${holdUntil}`, createdBy: actor.userId });
  return o;
}

// ---------------------------------------------------------------------------
// Release + send
// ---------------------------------------------------------------------------

export interface ReleaseResult {
  outcome: 'sent' | 'deferred' | 'asked' | 'retrying' | 'failed' | 'skipped';
  outboxId: string;
  reason?: string;
  smtpMessageId?: string;
  needsYouId?: string;
  followUps: Array<{ type: 'outbox.release'; runAfter: string; key: string }>;
}

const isOwnerApproved = (o: OutboxRecord): boolean => Boolean(o.approvedBy && !isAutomatedActor({ userId: o.approvedBy }));

/** Rate limits re-checked at release, not counting this row itself (§F.8). */
function overRateLimit(ctx: AppContext, o: OutboxRecord): string | undefined {
  const s = getAutonomy(ctx);
  const st = autonomyState(ctx, { ...(o.claimId ? { claimId: o.claimId } : {}), agent: 'mail' });
  // This row is counted at the time it goes out (its hold end, else its creation) — subtract it only from the
  // windows that time falls in (automaticSendCounts).
  const auto = (o.policy as { outcome?: string } | undefined)?.outcome === 'auto_held';
  const outAt = Date.parse(o.holdUntil ?? o.createdAt);
  const { dayStart, dayEnd } = londonDayWindow(ctx.now());
  const selfToday = auto && outAt >= Date.parse(dayStart) && outAt < Date.parse(dayEnd) ? 1 : 0;
  const selfHour = auto && outAt >= Date.parse(ctx.now()) - 3_600_000 ? 1 : 0;
  if (st.sends.claimToday - selfToday >= s.limits.perClaimPerDay) return `${st.sends.claimToday - selfToday} automatic sends on this claim today (limit ${s.limits.perClaimPerDay})`;
  if (st.sends.lastHour - selfHour >= s.limits.perHour) return `${st.sends.lastHour - selfHour} automatic sends in the last hour (limit ${s.limits.perHour})`;
  if (st.sends.today - selfToday >= s.limits.perDay) return `${st.sends.today - selfToday} automatic sends today (limit ${s.limits.perDay})`;
  return undefined;
}

async function verifiedEvidencePath(ctx: AppContext, evidenceId: string): Promise<{ path: string; filename: string; mime: string }> {
  const e = ctx.repos.requireEvidence(ctx.db, evidenceId);
  const p = absoluteEvidencePath(ctx, e.storagePath);
  if (!existsSync(p)) throw new Error(`The file for ${e.filename} is missing from the evidence store`);
  const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
  if (sha !== e.sha256) throw new Error(`${e.filename} does not match its recorded hash; it was not sent`);
  return { path: p, filename: e.filename, mime: e.mime };
}

function documentPath(ctx: AppContext, documentId: string): { path: string; filename: string; mime: string } {
  const d = ctx.repos.requireDocument(ctx.db, documentId, { includeHtml: false });
  if (d.status !== 'approved' && d.status !== 'signed') throw new Error(`${d.title} is ${d.status}; only an approved document can be emailed`);
  if (!d.pdfPath) throw new Error(`${d.title} has no stored PDF`);
  const p = resolvePdfPath(ctx, d.pdfPath);
  if (!existsSync(p)) throw new Error(`The PDF of ${d.title} is missing`);
  const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
  if (d.sha256 && sha !== d.sha256) throw new Error(`The PDF of ${d.title} does not match its approved hash`);
  return { path: p, filename: `${d.title.replace(/[^A-Za-z0-9 ._-]+/g, '_').slice(0, 80) || d.id}.pdf`, mime: 'application/pdf' };
}

/** outbox.release (§D.3, §F.6, §F.8). Never throws for send failures: they are recorded on the row. */
export async function releaseOutbox(ctx: AppContext, outboxId: string, job: Pick<JobRecord, 'id' | 'correlationId'>): Promise<ReleaseResult> {
  let o = ctx.repos.requireOutbox(ctx.db, outboxId);
  const res = (r: Omit<ReleaseResult, 'outboxId' | 'followUps'> & { followUps?: ReleaseResult['followUps'] }): ReleaseResult => ({ outboxId, followUps: [], ...r });
  if (o.status !== 'held' && o.status !== 'queued') return res({ outcome: 'skipped', reason: `status ${o.status}` });
  if (o.status === 'held' && o.holdUntil && Date.parse(o.holdUntil) > Date.parse(ctx.now())) {
    return res({ outcome: 'deferred', reason: 'hold not over', followUps: [{ type: 'outbox.release', runAfter: o.holdUntil, key: `outbox.release:${o.id}:${o.holdUntil}:early:${ctx.now()}` }] });
  }
  const automatic = !isOwnerApproved(o);
  if (automatic) {
    const settings = getAutonomy(ctx);
    const st = autonomyState(ctx, { ...(o.claimId ? { claimId: o.claimId } : {}), agent: 'mail' });
    if (settings.killSwitch || st.killSwitch) {
      // Held items stay held while agents are stopped.
      const at = new Date(Date.parse(ctx.now()) + KILL_SWITCH_RECHECK_MS).toISOString();
      return res({ outcome: 'deferred', reason: 'kill switch', followUps: [{ type: 'outbox.release', runAfter: at, key: `outbox.release:${o.id}:ks:${at}` }] });
    }
    const why = st.claimPaused ? 'Agents are paused on this claim' : st.agentPaused ? 'The mail agent is paused' : overRateLimit(ctx, o);
    if (why) {
      const decision: Decision = { outcome: 'ask', reasons: [why], ruleIds: [st.claimPaused || st.agentPaused ? 'paused' : 'rate_limits'] };
      o = transition(ctx, o.id, 'awaiting_approval', MAIL_AGENT, why, { from: ['held', 'queued'], patch: { policy: { ...(o.policy as object), released: decision } } });
      const ny = askOwner(ctx, o, decision, 'approve_send', job);
      return res({ outcome: 'asked', reason: why, needsYouId: ny.id });
    }
  }
  if (o.status === 'held') o = transition(ctx, o.id, 'queued', MAIL_AGENT, 'hold over', { from: 'held' });
  const attempt = o.attempts + 1;
  o = transition(ctx, o.id, 'sending', MAIL_AGENT, `SMTP attempt ${attempt}`, { from: 'queued', patch: { attempts: attempt } });

  const account = ctx.repos.getMailAccount(ctx.db, o.accountId) ?? mailAccount(ctx);
  let accepted: { messageId: string; accepted: string[]; rejected: string[]; raw: Buffer };
  const messageId = newMessageId(account?.fromAddress ?? 'claims@claimdesk.local');
  try {
    if (!account) throw new MailTransportError('MAIL_CONNECT', 'No mailbox is set up');
    const files = [...(await Promise.all(o.attachmentsJson.filter((a) => a.evidenceId).map((a) => verifiedEvidencePath(ctx, a.evidenceId!)))), ...o.attachmentsJson.filter((a) => a.documentId).map((a) => documentPath(ctx, a.documentId!))];
    const smtp = await smtpFor(ctx, account);
    accepted = await smtp.send({
      from: fromHeader(account),
      to: o.toJson,
      cc: o.ccJson,
      bcc: o.bccJson,
      subject: o.subject,
      text: o.bodyText,
      ...(o.bodyHtml ? { html: o.bodyHtml } : {}),
      messageId,
      ...(o.inReplyTo ? { inReplyTo: o.inReplyTo } : {}),
      ...(o.referencesJson?.length ? { references: o.referencesJson } : {}),
      attachments: files.map((f) => ({ filename: f.filename, path: f.path, contentType: f.mime })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt < SEND_MAX_ATTEMPTS) {
      transition(ctx, o.id, 'queued', MAIL_AGENT, `SMTP attempt ${attempt} failed: ${message}`, { from: 'sending', patch: { lastError: message.slice(0, 1000) } });
      const at = new Date(Date.parse(ctx.now()) + SEND_BACKOFF_MS[attempt - 1]!).toISOString();
      return res({ outcome: 'retrying', reason: message, followUps: [{ type: 'outbox.release', runAfter: at, key: `outbox.release:${o.id}:attempt:${attempt + 1}` }] });
    }
    transition(ctx, o.id, 'failed', MAIL_AGENT, `SMTP failed ${attempt} times: ${message}`, { from: 'sending', patch: { lastError: message.slice(0, 1000) } });
    const ny = createNeedsYou(ctx, {
      kind: 'failure',
      ...(o.claimId ? { claimId: o.claimId } : {}),
      title: `Email not sent: ${o.subject}`.slice(0, 200),
      summary: `The mail server refused or could not be reached ${attempt} times (${message.slice(0, 300)}). Nothing was sent. Retry it from the Outbox once the problem is fixed.`,
      options: [{ id: 'ok', label: 'Done', tone: 'primary' }],
      payload: { outboxId: o.id, error: message.slice(0, 1000) },
      priority: 'high',
      createdBy: MAIL_AGENT,
      dedupeKey: `outbox.failed:${o.id}`,
      correlationId: job.correlationId,
    });
    return res({ outcome: 'failed', reason: message, needsYouId: ny.id });
  }

  // ---- accepted by SMTP: only now is anything recorded as sent ----
  const actor: Actor = o.approvedBy && isOwnerApproved(o) ? { userId: o.approvedBy } : mailActorFor(o);
  const now = ctx.now();
  let rawEvidenceId: string | undefined;
  try {
    const stored = await storeEvidence(ctx, {
      ...(o.claimId ? { claimId: o.claimId } : {}),
      staged: stageBuffer(ctx, accepted.raw),
      filename: `${o.subject.replace(/[^A-Za-z0-9 ._-]+/g, '_').slice(0, 80) || 'email'} (sent).eml`,
      mime: 'message/rfc822',
      fields: { kind: 'correspondence', description: `Email sent to ${o.toJson.join(', ')}: ${o.subject}`.slice(0, 2000) },
      actor,
    });
    rawEvidenceId = stored.evidence.id;
  } catch (err) {
    ctx.logger.error('could not store the sent copy as evidence', { outboxId: o.id, error: String(err) });
  }
  o = transition(ctx, o.id, 'sent', actor.userId, `accepted by SMTP for ${accepted.accepted.join(', ')}`, { from: 'sending', patch: { smtpMessageId: accepted.messageId, ...(rawEvidenceId ? { rawSentEvidenceId: rawEvidenceId } : {}), lastError: accepted.rejected.length ? `rejected: ${accepted.rejected.join(', ')}` : null } });
  ctx.repos.appendAudit(ctx.db, { actor, action: 'email.send', entity: 'outbox', entityId: o.id, after: { smtpMessageId: accepted.messageId, claimId: o.claimId ?? null, to: o.toJson, cc: o.ccJson, accepted: accepted.accepted, rejected: accepted.rejected, rawEvidenceId: rawEvidenceId ?? null, automatic, policy: (o.policy as { ruleIds?: unknown } | undefined)?.ruleIds ?? null }, at: now });

  // The sent copy in the thread (Mailbox tab) and in IONOS "Sent" (IONOS SMTP does not reliably keep one).
  if (rawEvidenceId && account) {
    try {
      ctx.repos.insertMailMessage(ctx.db, {
        accountId: account.id,
        folder: SENT_FOLDER,
        messageId: accepted.messageId,
        inReplyTo: o.inReplyTo ?? null,
        references: o.referencesJson ?? null,
        threadKey: o.threadKey ?? accepted.messageId.replace(/^<|>$/g, '').toLowerCase(),
        direction: 'out',
        fromAddr: account.fromAddress,
        fromName: account.fromName,
        to: o.toJson,
        cc: o.ccJson,
        subject: o.subject,
        sentAt: now,
        receivedAt: now,
        rawEvidenceId,
        rawSha256: createHash('sha256').update(accepted.raw).digest('hex'),
        bodyText: o.bodyText,
        hasAttachments: o.attachmentsJson.length > 0,
        status: 'processed',
        claimId: o.claimId ?? null,
        source: 'smtp',
        now,
      });
    } catch (err) {
      ctx.logger.warn('could not record the sent message in the thread', { error: String(err) });
    }
    try {
      const mailbox = await mailboxFor(ctx, account);
      await mailbox.connect();
      try {
        await mailbox.ensureFolder(SENT_FOLDER);
        await mailbox.append(SENT_FOLDER, accepted.raw, ['\\Seen']);
      } finally {
        if (ctx.config.mailTransport !== 'fake') await mailbox.close();
      }
    } catch (err) {
      ctx.logger.warn('APPEND to Sent failed (the email was sent)', { outboxId: o.id, error: String(err) });
    }
  }
  if (o.claimId) {
    const attachmentEvidence = o.attachmentsJson.map((a) => a.evidenceId).filter((x): x is string => Boolean(x));
    try {
      appendClaimEvent(
        ctx,
        o.claimId,
        { type: 'email_out', at: now, summary: `Email sent to ${o.toJson.join(', ')}: ${o.subject}`.slice(0, 2000), data: { outboxId: o.id, smtpMessageId: accepted.messageId, kind: o.kind, to: o.toJson, automatic }, evidenceIds: [...(rawEvidenceId ? [rawEvidenceId] : []), ...attachmentEvidence], attributableTo: 'ccguk' },
        actor,
      );
    } catch (err) {
      ctx.logger.error('email_out event failed after a send', { outboxId: o.id, error: String(err) });
    }
    for (const a of o.attachmentsJson) {
      if (!a.documentId) continue;
      try {
        await sendDocument(ctx, a.documentId, { via: 'email', to: o.toJson.join(', '), note: `Emailed with ${accepted.messageId}` }, actor);
      } catch (err) {
        ctx.logger.warn('sendDocument record failed after the email was sent', { documentId: a.documentId, error: String(err) });
      }
    }
  }
  return res({ outcome: 'sent', smtpMessageId: accepted.messageId });
}

/** Payload of the approve_send / missing_info items. */
export interface ApproveSendPayload {
  outboxId: string;
}

export { isAlwaysAskEmailKind };

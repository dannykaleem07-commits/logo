// owned by casework
/**
 * Hand-off validation (docs/SUPREME-DESIGN.md §C.4). Agents never call each other: the case manager returns typed
 * hand-offs and this code decides which become jobs. Rules: template ids exist (HTML registry or an active CCGUK Word
 * template) and are meant for the recipient's role; action codes are playbook codes or `CUSTOM` (custom always asks);
 * message / offer ids belong to the claim; the loop guard (depth) stops runaway chains.
 */
import { createHash } from 'node:crypto';
import { listTemplates } from '@ccguk/documents';
import { canonicalTemplateId, CUSTOM_ACTION_CODE, EMAIL_KINDS, MAX_HANDOFF_DEPTH, playbookRuleCodes, type EmailKind, type Handoff } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { EnqueueInput } from '../agent/contracts.js';
import { defaultRecipientRole } from '../services/documentData.js';
import { londonDay } from '../agent/core.js';

/** Codes the playbook engine can raise (engine triggers + the kb rule list) — the only codes agents may plan with. */
export const PLAYBOOK_ACTION_CODES: readonly string[] = [
  ...new Set([
    ...playbookRuleCodes,
    'CHASER_7', 'CHASER_14', 'CHASER_21', 'COLLECT_IMPECUNIOSITY_EVIDENCE', 'COMPLAINT_28', 'DEFAULT_JUDGMENT', 'END_HIRE_NOW', 'FIX_ENFORCEABILITY',
    'FLAG_CONNECTED_WITNESS', 'ICOBS_INTEREST_CLAIM', 'LETTER_BEFORE_CLAIM', 'MONITOR_SUPPLIER', 'PART36_OFFER', 'REFER_INJURY', 'REPLY_TO_INTERVENTION_OFFER',
    'REQUEST_CCTV', 'REQUEST_HANDLING_REF', 'SEND_COLLECT_OR_PAY', 'SEND_DELAY_NOTICE', 'SEND_DSAR', 'SEND_NCAF', 'SEND_PAYMENT_PACK', 'SPLIT_HEADS_INTERIM',
    'VENDOR_VERIFICATION_PACK',
  ]),
].sort();

export const isPlaybookCode = (c: string): boolean => PLAYBOOK_ACTION_CODES.includes(c);

export type RoleOfRecipient = 'at_fault_insurer' | 'client' | 'own_insurer' | 'supplier' | 'court' | 'other';

/** Role of a party on the claim (null party → unknown). */
export function recipientRoleOf(ctx: AppContext, claimId: string, partyId: string | null): RoleOfRecipient | undefined {
  if (!partyId) return undefined;
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  if (partyId === claim.claimantId || partyId === claim.driverId) return 'client';
  if (partyId === claim.atFaultInsurerId) return 'at_fault_insurer';
  if (partyId === claim.clientInsurerId) return 'own_insurer';
  const p = ctx.repos.getParty(ctx.db, partyId);
  if (!p) return undefined;
  if (p.roles.includes('insurer')) return 'at_fault_insurer';
  if (p.roles.some((r) => r === 'supplier' || r === 'repairer' || r === 'engineer' || r === 'recovery_agent' || r === 'storage_yard')) return 'supplier';
  if (p.roles.includes('claimant')) return 'client';
  return 'other';
}

export interface TemplateInfo {
  id: string;
  format: 'html' | 'docx';
  role: RoleOfRecipient;
}

/** The template registry: HTML templates + active CCGUK Word templates. */
export function templateInfo(ctx: AppContext, templateId: string): TemplateInfo | undefined {
  const html = listTemplates().find((t) => t.id === templateId);
  if (html) return { id: html.id, format: 'html', role: ((html.recipientRole as RoleOfRecipient | undefined) ?? defaultRecipientRole(canonicalTemplateId(html.id))) as RoleOfRecipient };
  const docx = ctx.repos.listDocumentTemplates(ctx.db).find((t) => t.id === templateId);
  if (docx) return { id: docx.id, format: 'docx', role: ((docx.recipientRole as RoleOfRecipient | undefined) ?? defaultRecipientRole(canonicalTemplateId(docx.id))) as RoleOfRecipient };
  return undefined;
}

const INSURERS = new Set<RoleOfRecipient>(['at_fault_insurer', 'own_insurer']);

/** Is a template meant for this recipient? `other` templates go to anyone; the two insurer roles are interchangeable. */
export function templateAllowedFor(t: TemplateInfo, role: RoleOfRecipient | undefined): boolean {
  if (!role || t.role === 'other') return true;
  if (t.role === role) return true;
  return INSURERS.has(t.role) && INSURERS.has(role);
}

export interface HandoffDecision {
  handoff: Handoff;
  ok: boolean;
  /** The follow-up job when ok. */
  job?: EnqueueInput;
  /** CUSTOM action code: the plan goes to the owner first. */
  ask?: boolean;
  reason?: string;
}

const short = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Validate one hand-off and build its follow-up job (§C.2 idempotency keys). */
export function validateHandoff(ctx: AppContext, claimId: string, h: Handoff, opts: { createdBy: string; missingInfo?: boolean; now?: string } = { createdBy: 'agent:case_manager' }): HandoffDecision {
  const day = londonDay(opts.now ?? ctx.now());
  switch (h.to) {
    case 'mail_reply': {
      const m = ctx.repos.getMailMessage(ctx.db, h.messageId);
      if (!m || m.claimId !== claimId) return { handoff: h, ok: false, reason: `message ${h.messageId} is not filed on this claim` };
      if (!h.plan.trim()) return { handoff: h, ok: false, reason: 'a reply hand-off needs a plan' };
      return { handoff: h, ok: true, job: { type: 'mail.reply', payload: { claimId, messageId: h.messageId, plan: h.plan.slice(0, 8000), keyPoints: h.keyPoints.slice(0, 30) }, claimId, idempotencyKey: `mail.reply:${h.messageId}:0`, createdBy: opts.createdBy } };
    }
    case 'drafter': {
      if (!h.templateId && !h.emailKind) return { handoff: h, ok: false, reason: 'a drafter hand-off needs a template or an email kind' };
      if (h.emailKind && !(EMAIL_KINDS as readonly string[]).includes(h.emailKind)) return { handoff: h, ok: false, reason: `unknown email kind ${h.emailKind}` };
      const role = recipientRoleOf(ctx, claimId, h.recipientPartyId);
      if (h.recipientPartyId && !role) return { handoff: h, ok: false, reason: `party ${h.recipientPartyId} is not on this claim` };
      if (h.templateId) {
        const t = templateInfo(ctx, h.templateId);
        if (!t) return { handoff: h, ok: false, reason: `template ${h.templateId} does not exist` };
        if (!templateAllowedFor(t, role)) return { handoff: h, ok: false, reason: `template ${h.templateId} is for the ${t.role.replace(/_/g, ' ')}, not the ${role?.replace(/_/g, ' ')}` };
      }
      if (h.replyToMessageId) {
        const m = ctx.repos.getMailMessage(ctx.db, h.replyToMessageId);
        if (!m || m.claimId !== claimId) return { handoff: h, ok: false, reason: `message ${h.replyToMessageId} is not filed on this claim` };
      }
      if (h.actionCode && h.actionCode !== CUSTOM_ACTION_CODE && !isPlaybookCode(h.actionCode)) return { handoff: h, ok: false, reason: `action code ${h.actionCode} is not a playbook code (use CUSTOM, which asks the owner)` };
      const purposeKey = h.actionCode && h.actionCode !== CUSTOM_ACTION_CODE ? h.actionCode : short(`${h.templateId ?? ''}|${h.emailKind ?? ''}|${h.purpose}`);
      const job: EnqueueInput = {
        type: 'draft.compose',
        payload: { claimId, templateId: h.templateId, emailKind: h.emailKind as EmailKind | null, purpose: h.purpose.slice(0, 4000), recipientPartyId: h.recipientPartyId, replyToMessageId: h.replyToMessageId, actionCode: h.actionCode, dueAt: h.dueAt, missingInfo: Boolean(opts.missingInfo), loop: 0 },
        claimId,
        idempotencyKey: `draft.compose:${claimId}:${purposeKey}:${day}`,
        createdBy: opts.createdBy,
      };
      if (h.actionCode === CUSTOM_ACTION_CODE) return { handoff: h, ok: true, ask: true, job, reason: 'custom action: the owner confirms first' };
      return { handoff: h, ok: true, job };
    }
    case 'researcher': {
      const q = h.question.trim();
      if (!q) return { handoff: h, ok: false, reason: 'empty research question' };
      return { handoff: h, ok: true, job: { type: 'research.ask', payload: { claimId, question: q.slice(0, 2000), scope: 'claim' }, claimId, idempotencyKey: `research.ask:${createHash('sha256').update(q).digest('hex')}:${claimId}`, createdBy: opts.createdBy } };
    }
    case 'offer_analyst': {
      const o = ctx.repos.getOffer(ctx.db, h.offerId);
      if (!o || o.claimId !== claimId) return { handoff: h, ok: false, reason: `offer ${h.offerId} is not on this claim` };
      return { handoff: h, ok: true, job: { type: 'offer.analyse', payload: { offerId: o.id, claimId }, claimId, priority: 0, idempotencyKey: `offer.analyse:${o.id}`, createdBy: opts.createdBy } };
    }
  }
}

/** Would follow-ups of a job at `depth` breach the loop guard (§C.4)? */
export const breachesLoopGuard = (depth: number): boolean => depth + 1 > MAX_HANDOFF_DEPTH;

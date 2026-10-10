// owned by mail
/**
 * Mail routes (docs/SUPREME-DESIGN.md §F, §L.5, §N.6), session auth (people only — agents never reach these):
 *
 *   GET  /mail/account                 the account (no secrets: only "password saved" flags) + IONOS presets + sync state
 *   PUT  /mail/account                 save the account; passwords go to the secret store (write-only), never SQLite
 *   POST /mail/test                    IMAP login + folder list + SMTP verify() — nothing is sent
 *   POST /mail/test-send               a test email to the mailbox itself (through the outbox, sent at once)
 *   POST /mail/sync-now                queue a sync
 *   GET  /mail/messages                ?status=&claimId=&limit=&offset=
 *   GET  /mail/messages/:id            message, attachments, matches ("matched because"), classifications, thread
 *   POST /mail/messages/:id/link       {claimId | null, reason?} — the owner files it (or "none of these")
 *   GET  /claims/:id/mailbox           threads on the claim + its outbox items
 *
 * When JOBS_ENABLED=true (the launcher; never in tests) onReady starts the persistent IDLE connection (§F.3).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MailAccountRecord, MailMessageRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../schemas/common.js';
import { params, requireClaim, requireRole } from './helpers.js';
import { jobsEnabled } from '../jobs.js';
import { connectionFailures, queueSyncNow, startIdleLoop, type IdleLoop } from '../mail/sync.js';
import { mailboxFor, smtpFor } from '../mail/transport.js';
import { FROM_NAME, mailAccount } from '../mail/common.js';
import { linkMessageToClaim } from '../mail/link.js';
import { ownerCompose, sendNowOutbox, describeOutbox } from '../mail/outbox.js';
import { INTENT_RULES } from '../mail/intents.js';
import type { MailIntent } from '@ccguk/domain';

/** IONOS presets (§F.1, §L.5). */
export const IONOS_PRESETS = {
  imap: { host: 'imap.ionos.co.uk', port: 993, tls: true },
  smtp: [
    { host: 'smtp.ionos.co.uk', port: 465, security: 'tls' as const, label: '465 — TLS' },
    { host: 'smtp.ionos.co.uk', port: 587, security: 'starttls' as const, label: '587 — STARTTLS' },
  ],
  folders: { processed: 'ClaimDesk-Processed', quarantine: 'ClaimDesk-Quarantine' },
} as const;

const hostname = z.string().trim().min(3).max(253).regex(/^[A-Za-z0-9.-]+$/, 'a host name');
const accountBody = z.object({
  imapHost: hostname.default(IONOS_PRESETS.imap.host),
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapTls: z.boolean().default(true),
  smtpHost: hostname.default('smtp.ionos.co.uk'),
  smtpPort: z.number().int().min(1).max(65535).default(465),
  smtpSecurity: z.enum(['tls', 'starttls']).default('tls'),
  username: z.string().trim().min(3).max(254),
  fromAddress: z.string().trim().email().max(254),
  /** Write-only. Saved to the secret store; omitted = unchanged. */
  password: z.string().min(1).max(500).optional(),
  /** Only when the SMTP password differs from the IMAP one. */
  smtpPassword: z.string().min(1).max(500).optional(),
  signatureText: z.string().max(4000).nullable().optional(),
  signatureHtml: z.string().max(20000).nullable().optional(),
  processedFolder: z.string().trim().min(1).max(200).optional(),
  quarantineFolder: z.string().trim().min(1).max(200).optional(),
  moveAfterIngest: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const listQuery = z.object({
  status: z.string().optional(),
  claimId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const linkBody = z.object({ claimId: z.string().min(1).nullable(), reason: z.string().max(1000).optional() });

const STATUSES = ['new', 'matched', 'needs_match', 'unmatched', 'quarantined', 'processed', 'ignored'] as const;

function accountView(ctx: AppContext, a: MailAccountRecord | undefined) {
  return {
    account: a ? { ...a, fromName: FROM_NAME } : null,
    passwordSaved: { imap: ctx.secrets.has('imap_password'), smtp: ctx.secrets.has('smtp_password') || ctx.secrets.has('imap_password') },
    presets: IONOS_PRESETS,
    transport: ctx.config.mailTransport,
    sync: a ? { folders: ctx.repos.listMailFolderStates(ctx.db, a.id), connectionFailures: connectionFailures(ctx, a.id) } : null,
  };
}

/**
 * Why an email was not acted on: instructions aimed at the agents (injection) or a bank / payment details change.
 * Links to the Needs-you spoof warning raised for it.
 */
function messageWarning(ctx: AppContext, m: MailMessageRecord, c: ReturnType<AppContext['repos']['latestMailClassification']>) {
  if (!c) return m.spoofSuspect ? { injection: false, injectionNotes: null, bankDetailsChange: false, spoofSuspect: true, needsYouId: null } : null;
  const inj = (c.injection ?? {}) as { suspected?: boolean; notes?: string | null; flags?: string[] };
  const det = (c.deterministic ?? {}) as { bankDetailsChange?: boolean };
  const ext = (c.extracted ?? {}) as { bankDetailsChange?: boolean };
  const injection = Boolean(inj.suspected || inj.flags?.length);
  const bankDetailsChange = Boolean(ext.bankDetailsChange || det.bankDetailsChange);
  if (!injection && !bankDetailsChange && !m.spoofSuspect) return null;
  const ny = ctx.handle.sqlite.prepare('SELECT id FROM needs_you WHERE dedupe_key = ? ORDER BY created_at DESC LIMIT 1').get(`spoof_warning:${m.id}`) as { id: string } | undefined;
  const notes = [inj.notes, ...(inj.flags ?? [])].filter((x): x is string => Boolean(x));
  return { injection, injectionNotes: notes.length ? notes.join('; ').slice(0, 500) : null, bankDetailsChange, spoofSuspect: m.spoofSuspect, needsYouId: ny?.id ?? null };
}

/** A message for lists: intent chip and "matched because". */
export function messageSummary(ctx: AppContext, m: MailMessageRecord) {
  const c = ctx.repos.latestMailClassification(ctx.db, m.id);
  const match = ctx.repos.latestMailMatch(ctx.db, m.id);
  const sig = (match?.signals ?? {}) as { because?: string[]; decision?: string; reason?: string; candidates?: Array<{ claimId: string; reference: string; score: number }> };
  return {
    id: m.id,
    direction: m.direction,
    threadKey: m.threadKey,
    from: m.fromAddr ?? null,
    fromName: m.fromName ?? null,
    to: m.toJson,
    cc: m.ccJson,
    subject: m.subject ?? null,
    at: m.sentAt ?? m.receivedAt,
    receivedAt: m.receivedAt,
    status: m.status,
    claimId: m.claimId ?? null,
    claimReference: m.claimId ? (ctx.repos.getClaim(ctx.db, m.claimId)?.reference ?? null) : null,
    hasAttachments: m.hasAttachments,
    spoofSuspect: m.spoofSuspect,
    source: m.source,
    snippet: (m.bodyText ?? '').replace(/\s+/g, ' ').slice(0, 240),
    intent: c ? { intent: c.intent, label: INTENT_RULES[c.intent as MailIntent]?.label ?? c.intent, confidence: c.confidence, summary: c.summary } : null,
    warning: messageWarning(ctx, m, c),
    match: match ? { decidedBy: match.decidedBy, score: match.score, because: sig.because ?? (sig.reason ? [sig.reason] : []), decision: sig.decision ?? null, candidates: (sig.candidates ?? []).slice(0, 3) } : null,
  };
}

export function messageDetail(ctx: AppContext, m: MailMessageRecord) {
  const thread = ctx.repos.listMailThread(ctx.db, m.threadKey).filter((x) => x.claimId === m.claimId || x.id === m.id);
  return {
    message: { ...messageSummary(ctx, m), bodyText: m.bodyText ?? '', replyTo: m.replyTo ?? null, auth: m.authJson ?? null, rawEvidenceId: m.rawEvidenceId, messageIdHeader: m.messageId ?? null },
    attachments: ctx.repos.listMailAttachments(ctx.db, m.id).map((a) => ({
      ...a,
      claimEvidenceId: m.claimId ? (ctx.repos.findEvidenceBySha256(ctx.db, a.sha256).find((e) => e.claimId === m.claimId)?.id ?? null) : null,
    })),
    matches: ctx.repos.listMailMatches(ctx.db, m.id),
    classifications: ctx.repos.listMailClassifications(ctx.db, m.id),
    thread: thread.map((x) => messageSummary(ctx, x)),
  };
}

export function outboxSummary(ctx: AppContext, o: ReturnType<AppContext['repos']['requireOutbox']>) {
  const policy = (o.policy ?? {}) as { outcome?: string; ruleIds?: string[]; reasons?: string[] };
  return {
    id: o.id,
    claimId: o.claimId ?? null,
    claimReference: o.claimId ? (ctx.repos.getClaim(ctx.db, o.claimId)?.reference ?? null) : null,
    kind: o.kind,
    status: o.status,
    to: o.toJson,
    cc: o.ccJson,
    subject: o.subject,
    bodyText: o.bodyText,
    attachments: o.attachmentsJson,
    holdUntil: o.holdUntil ?? null,
    approvedBy: o.approvedBy ?? null,
    smtpMessageId: o.smtpMessageId ?? null,
    rawSentEvidenceId: o.rawSentEvidenceId ?? null,
    attempts: o.attempts,
    lastError: o.lastError ?? null,
    policy: { outcome: policy.outcome ?? null, ruleIds: policy.ruleIds ?? [], reasons: policy.reasons ?? [] },
    createdBy: o.createdBy,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

let idle: IdleLoop | undefined;

export function registerMailRoutes(app: FastifyInstance, ctx: AppContext): void {
  if (jobsEnabled(ctx)) {
    app.addHook('onReady', async () => {
      idle = startIdleLoop(ctx);
    });
    app.addHook('onClose', async () => {
      await idle?.stop();
      idle = undefined;
    });
  }

  app.get('/mail/account', async () => accountView(ctx, mailAccount(ctx)));

  app.put('/mail/account', async (request) => {
    requireRole(request, ['admin', 'approver']);
    const body = parse(accountBody, request.body);
    const existing = mailAccount(ctx);
    const account = ctx.repos.upsertMailAccount(ctx.db, {
      ...(existing ? { id: existing.id } : {}),
      imapHost: body.imapHost,
      imapPort: body.imapPort,
      imapTls: body.imapTls,
      smtpHost: body.smtpHost,
      smtpPort: body.smtpPort,
      smtpSecurity: body.smtpSecurity,
      username: body.username,
      fromAddress: body.fromAddress,
      secretRef: 'imap_password',
      ...(body.signatureText !== undefined ? { signatureText: body.signatureText } : {}),
      ...(body.signatureHtml !== undefined ? { signatureHtml: body.signatureHtml } : {}),
      ...(body.processedFolder ? { processedFolder: body.processedFolder } : {}),
      ...(body.quarantineFolder ? { quarantineFolder: body.quarantineFolder } : {}),
      ...(body.moveAfterIngest !== undefined ? { moveAfterIngest: body.moveAfterIngest } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      now: ctx.now(),
    });
    if (body.password) {
      await ctx.secrets.set('imap_password', body.password);
      ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'secret.set', entity: 'secrets', entityId: 'imap_password', after: { name: 'imap_password' }, at: ctx.now() });
    }
    if (body.smtpPassword) {
      await ctx.secrets.set('smtp_password', body.smtpPassword);
      ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'secret.set', entity: 'secrets', entityId: 'smtp_password', after: { name: 'smtp_password' }, at: ctx.now() });
    }
    ctx.repos.appendAudit(ctx.db, {
      actor: request.actor,
      action: 'mail.account',
      entity: 'mail_accounts',
      entityId: account.id,
      ...(existing ? { before: { ...existing } } : {}),
      after: { imapHost: account.imapHost, imapPort: account.imapPort, smtpHost: account.smtpHost, smtpPort: account.smtpPort, smtpSecurity: account.smtpSecurity, username: account.username, fromAddress: account.fromAddress, moveAfterIngest: account.moveAfterIngest, enabled: account.enabled, passwordChanged: Boolean(body.password || body.smtpPassword) },
      at: ctx.now(),
    });
    return accountView(ctx, account);
  });

  app.post('/mail/test', async (request) => {
    requireRole(request, ['admin', 'approver']);
    const account = mailAccount(ctx);
    if (!account) throw conflict('MAIL_NOT_SET_UP', 'Save the mailbox settings first');
    const imap: { ok: boolean; folders?: string[]; error?: string } = { ok: false };
    const smtp: { ok: boolean; error?: string } = { ok: false };
    try {
      const mb = await mailboxFor(ctx, account);
      await mb.connect();
      try {
        imap.folders = await mb.listFolders();
        imap.ok = true;
      } finally {
        if (ctx.config.mailTransport !== 'fake') await mb.close().catch(() => undefined);
      }
    } catch (err) {
      imap.error = err instanceof Error ? err.message : String(err);
    }
    try {
      await (await smtpFor(ctx, account)).verify();
      smtp.ok = true;
    } catch (err) {
      smtp.error = err instanceof Error ? err.message : String(err);
    }
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'mail.test', entity: 'mail_accounts', entityId: account.id, after: { imap: imap.ok, smtp: smtp.ok }, at: ctx.now() });
    return { imap, smtp, sent: false };
  });

  app.post('/mail/test-send', async (request) => {
    requireRole(request, ['admin', 'approver']);
    const account = mailAccount(ctx);
    if (!account) throw conflict('MAIL_NOT_SET_UP', 'Save the mailbox settings first');
    const o = ownerCompose(ctx, { to: [account.fromAddress], subject: 'ClaimDesk test email', bodyText: `This is a test email from ClaimDesk, sent from ${account.fromAddress} through ${account.smtpHost}:${account.smtpPort}.\n\n${FROM_NAME}`, kind: 'test' }, request.actor);
    const sent = sendNowOutbox(ctx, o.id, request.actor);
    return { outboxId: sent.id, status: sent.status, to: account.fromAddress };
  });

  app.post('/mail/sync-now', async () => {
    const account = mailAccount(ctx);
    if (!account?.enabled) throw conflict('MAIL_NOT_ENABLED', 'The mailbox is not set up and switched on (Settings > Email)');
    return { jobId: queueSyncNow(ctx, account.id, 'owner') };
  });

  app.get('/mail/messages', async (request) => {
    const q = parse(listQuery, request.query);
    const status = q.status?.split(',').map((s) => s.trim()).filter(Boolean);
    if (status && !status.every((s) => (STATUSES as readonly string[]).includes(s))) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
    const filter = { ...(q.claimId ? { claimId: q.claimId } : {}), ...(status?.length ? { status: status as (typeof STATUSES)[number][] } : {}) };
    const items = ctx.repos.listMailMessages(ctx.db, { ...filter, limit: q.limit ?? 100, offset: q.offset ?? 0 });
    return { items: items.map((m) => messageSummary(ctx, m)), total: ctx.repos.countMailMessages(ctx.db, filter) };
  });

  app.get('/mail/messages/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const m = ctx.repos.getMailMessage(ctx.db, id);
    if (!m) throw notFound('mail message', id);
    return messageDetail(ctx, m);
  });

  app.post('/mail/messages/:id/link', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(linkBody, request.body);
    const m = ctx.repos.getMailMessage(ctx.db, id);
    if (!m) throw notFound('mail message', id);
    if (body.claimId) requireClaim(ctx, body.claimId);
    const r = await linkMessageToClaim(ctx, id, body.claimId, 'owner', request.actor, body.reason?.trim() || (body.claimId ? 'filed by the owner' : 'not for any claim'));
    // An open which_claim item for this message is answered by this.
    const open = ctx.handle.sqlite.prepare(`SELECT id FROM needs_you WHERE dedupe_key = ? AND status IN ('open','snoozed')`).all(`which_claim:${id}`) as Array<{ id: string }>;
    for (const row of open) ctx.repos.transitionNeedsYou(ctx.db, row.id, { to: 'superseded', actor: request.actor.userId, note: 'filed from the Mailbox', now: ctx.now() });
    return messageDetail(ctx, r.message);
  });

  app.get('/claims/:id/mailbox', async (request) => {
    const { id } = params<{ id: string }>(request);
    const claim = requireClaim(ctx, id);
    const messages = ctx.repos.listMailMessages(ctx.db, { claimId: claim.id, limit: 1000 });
    const threads = new Map<string, MailMessageRecord[]>();
    for (const m of messages) threads.set(m.threadKey, [...(threads.get(m.threadKey) ?? []), m]);
    const outbox = ctx.repos.listOutbox(ctx.db, { claimId: claim.id, limit: 500 });
    return {
      claimId: claim.id,
      reference: claim.reference,
      threads: [...threads.entries()]
        .map(([threadKey, ms]) => {
          const sorted = [...ms].sort((a, b) => (a.sentAt ?? a.receivedAt).localeCompare(b.sentAt ?? b.receivedAt));
          const last = sorted[sorted.length - 1]!;
          return { threadKey, subject: sorted[0]!.subject ?? '(no subject)', lastAt: last.sentAt ?? last.receivedAt, count: sorted.length, messages: sorted.map((m) => messageSummary(ctx, m)) };
        })
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
      outbox: outbox.map((o) => ({ ...outboxSummary(ctx, o), recipients: describeOutbox(ctx, o, undefined).recipients })),
    };
  });
}

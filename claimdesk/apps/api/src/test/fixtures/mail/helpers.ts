// owned by mail
/**
 * Shared helpers for the mail tests: invented RFC 822 messages, an invented insurer directory, extra claims for the
 * matcher, the IONOS account on the fake transports, and a minimal job runner (handler → done → follow-ups) so the
 * tests drive the real handlers without the background worker. All data here is invented.
 */
import { randomUUID } from 'node:crypto';
import type { InsurerDirectoryEntry } from '@ccguk/domain';
import type { JobType } from '@ccguk/domain';
import type { AppContext } from '../../../context.js';
import type { JobRecord } from '../../../agent/contracts.js';
import { enqueueJob } from '../../../agent/core.js';
import { getJobHandler } from '../../../agent/handlers/index.js';
import { enqueueFollowUps } from '../../../agent/queue.js';
import { FakeMailbox, FakeSmtp, setFakeTransports } from '../../../mail/transport.js';

export const MAILBOX = 'claims@ccguk-test.example';
export const INSURER_DOMAIN = 'example-insurer.test';
export const INSURER_EMAIL = `thirdparty.claims@${INSURER_DOMAIN}`;

/** An invented insurer directory: "Example Insurance Ltd" (file one's at-fault insurer) and a copycat domain. */
export const TEST_DIRECTORY: InsurerDirectoryEntry[] = [
  {
    id: 'example-insurance',
    name: 'Example Insurance Ltd',
    brands: ['Example Insurance'],
    claimsEmail: `claims@${INSURER_DOMAIN}`,
    thirdPartyEmail: INSURER_EMAIL,
    copycatDomains: ['examp1e-insurer.test'],
    copycatNumbers: [],
    verification: { status: 'unverified' } as InsurerDirectoryEntry['verification'],
  },
];

export interface EmlOptions {
  from?: string;
  fromName?: string;
  to?: string;
  subject?: string;
  body?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  date?: string;
  authResults?: string;
  attachments?: Array<{ filename: string; mime: string; content: Buffer | string }>;
}

/** Build a small RFC 822 message (text, optional HTML alternative, optional base64 attachments). */
export function eml(o: EmlOptions = {}): Buffer {
  const boundary = `b-${randomUUID()}`;
  const alt = `a-${randomUUID()}`;
  const headers = [
    ...(o.authResults ? [`Authentication-Results: ${o.authResults}`] : []),
    `From: ${o.fromName ? `"${o.fromName}" ` : ''}<${o.from ?? INSURER_EMAIL}>`,
    `To: ${o.to ?? MAILBOX}`,
    `Subject: ${o.subject ?? 'Your client'}`,
    `Date: ${o.date ?? 'Wed, 07 Oct 2026 08:30:00 +0000'}`,
    `Message-ID: ${o.messageId ?? `<${randomUUID()}@${INSURER_DOMAIN}>`}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    'MIME-Version: 1.0',
  ];
  const text = (o.body ?? 'Hello').replace(/\n/g, '\r\n');
  const textPart = o.html
    ? [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`, 'Content-Type: text/plain; charset=utf-8', '', text, `--${alt}`, 'Content-Type: text/html; charset=utf-8', '', o.html, `--${alt}--`].join('\r\n')
    : ['Content-Type: text/plain; charset=utf-8', '', text].join('\r\n');
  if (!o.attachments?.length) {
    const [ct, , ...rest] = textPart.split('\r\n');
    return Buffer.from([...headers, ct, '', ...rest].join('\r\n') + '\r\n');
  }
  const parts = [`--${boundary}`, textPart];
  for (const a of o.attachments) {
    const b64 = Buffer.from(a.content).toString('base64').replace(/(.{76})/g, '$1\r\n');
    parts.push(`--${boundary}`, `Content-Type: ${a.mime}; name="${a.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${a.filename}"`, '', b64);
  }
  parts.push(`--${boundary}--`);
  return Buffer.from([...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n') + '\r\n');
}

/** A small invented PDF-like attachment (content only needs to be stable bytes). */
export const PDF_BYTES = Buffer.from(`%PDF-1.4\n% invented test attachment\n${'0'.repeat(600)}\n%%EOF\n`);

/** Account on the fake transports (enabled, move after ingest), directory injected, fresh fakes. */
export async function setUpMail(ctx: AppContext, opts: { moveAfterIngest?: boolean; enabled?: boolean } = {}): Promise<{ mailbox: FakeMailbox; smtp: FakeSmtp; accountId: string }> {
  ctx.kb.directory = () => TEST_DIRECTORY;
  const mailbox = new FakeMailbox(['INBOX', 'Sent']);
  const smtp = new FakeSmtp();
  setFakeTransports(ctx, { mailbox, smtp });
  const a = ctx.repos.upsertMailAccount(ctx.db, {
    imapHost: 'imap.ionos.co.uk',
    imapPort: 993,
    smtpHost: 'smtp.ionos.co.uk',
    smtpPort: 465,
    smtpSecurity: 'tls',
    username: MAILBOX,
    fromAddress: MAILBOX,
    enabled: opts.enabled ?? true,
    moveAfterIngest: opts.moveAfterIngest ?? true,
    now: ctx.now(),
  });
  await ctx.secrets.set('imap_password', 'invented-test-password');
  return { mailbox, smtp, accountId: a.id };
}

/** An extra invented claim for the matcher. */
export function makeClaim(ctx: AppContext, o: { name: string; email?: string; registration: string; insurerRef?: string; occurredAt?: string; insurerName?: string; insurerEmail?: string }): { id: string; reference: string } {
  const claimant = ctx.repos.createParty(ctx.db, { kind: 'individual', name: o.name, roles: ['claimant'], ...(o.email ? { email: o.email } : {}) });
  const insurer = o.insurerName ? ctx.repos.createParty(ctx.db, { kind: 'company', name: o.insurerName, roles: ['insurer'], ...(o.insurerEmail ? { email: o.insurerEmail } : {}) }) : undefined;
  const vehicle = ctx.repos.upsertVehicle(ctx.db, { registration: o.registration, make: 'TEST', model: 'CAR', ownership: 'client' });
  const claim = ctx.repos.createClaim(ctx.db, {
    openedAt: '2026-09-01T09:00:00.000Z',
    accident: { occurredAt: o.occurredAt ?? '2026-08-20T10:00:00.000Z', location: 'Invented Road', circumstances: 'Invented test accident.' },
    liability: 'unknown',
    claimantId: claimant.id,
    clientVehicleId: vehicle.id,
    thirdPartyIds: [],
    ...(insurer ? { atFaultInsurerId: insurer.id } : {}),
    ...(o.insurerRef ? { atFaultInsurerRef: o.insurerRef } : {}),
  } as Parameters<AppContext['repos']['createClaim']>[1]);
  return { id: claim.id, reference: claim.reference };
}

export interface RunResult {
  job: JobRecord;
  outcome: { kind: string; result?: unknown; reason?: string; until?: string; afterMs?: number };
  followUps: JobRecord[];
}

/** Run one job through its registered handler (as the worker would for a `done` outcome). */
export async function runJob(ctx: AppContext, job: JobRecord): Promise<RunResult> {
  const handler = getJobHandler(job.type);
  if (!handler) throw new Error(`no handler for ${job.type}`);
  const payload = handler.payload.parse(job.payload);
  const outcome = await handler.run({ ctx, job, payload, signal: new AbortController().signal, log: ctx.logger });
  let followUps: JobRecord[] = [];
  if (outcome.kind === 'done') {
    ctx.repos.markAgentJobSucceeded(ctx.db, job.id, { result: outcome.result ?? null, now: ctx.now() });
    followUps = enqueueFollowUps(ctx, job, outcome.followUps);
  } else if (outcome.kind === 'fail') {
    ctx.repos.markAgentJobFailed(ctx.db, job.id, { error: outcome.reason, now: ctx.now() });
  }
  return { job, outcome: outcome as RunResult['outcome'], followUps };
}

/** Enqueue and run a job now. */
export async function run(ctx: AppContext, type: JobType, payload: unknown, extra: { claimId?: string; key?: string } = {}): Promise<RunResult> {
  const job = enqueueJob(ctx, { type, payload, createdBy: 'test', ...(extra.claimId ? { claimId: extra.claimId } : {}), idempotencyKey: extra.key ?? `test:${type}:${randomUUID()}` });
  return runJob(ctx, job);
}

/** Queued jobs of a type (oldest first). */
export function queued(ctx: AppContext, type: JobType): JobRecord[] {
  return (ctx.repos.listAgentJobs(ctx.db, { type, limit: 500 }) as JobRecord[]).filter((j) => j.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Run every queued job of `type` once. */
export async function drain(ctx: AppContext, type: JobType): Promise<RunResult[]> {
  const out: RunResult[] = [];
  for (const j of queued(ctx, type)) out.push(await runJob(ctx, j));
  return out;
}

export const TOUCHES_NONE = { money: false, liability: false, settlement: false, legal: false, newCommitment: false };

// owned by mail
/**
 * Mailbox sync (docs/SUPREME-DESIGN.md §F.3):
 *
 *   syncMailbox      per folder `{uidvalidity, last_uid}`; new UIDs are fetched (BODY.PEEK — \Seen is never set) and
 *                    ingested one by one; only after a message's rows are committed is it UID-MOVEd to
 *                    `ClaimDesk-Processed` (or `ClaimDesk-Quarantine` for a spoof suspect), unless "copy only" is
 *                    chosen. A UIDVALIDITY change rescans the folder from UID 1 and relies on the raw-sha256 and
 *                    Message-ID de-duplication. `last_uid` advances only past messages that are fully done, so a failed
 *                    move is retried on the next sync. A message that fails to ingest is handed to its own
 *                    `mail.ingest` job (retries with backoff) and the sync carries on.
 *   ingestOneUid     the `mail.ingest` job: fetch one UID again and ingest it
 *   queueStagedFiles `.eml` files dropped in `inbox\mail\` → `mail.ingest_file` jobs
 *   connection health: three consecutive failures → Needs-you "Email offline" (cleared state on the next success)
 *   startIdleLoop    one persistent IDLE connection on INBOX; `exists` → mail.sync; reconnect backoff 5 s → 5 min;
 *                    every (re)connect also queues a sync (IDLE drops silently)
 */
import type { MailAccountRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { createNeedsYou, enqueueJob } from '../agent/core.js';
import { listStagedImports } from '../services/imports.js';
import { MAIL_AGENT } from './common.js';
import { ingestRaw, type IngestResult } from './ingest.js';
import { mailboxFor, type MailboxClient } from './transport.js';

export const SYNC_FOLDERS = ['INBOX'] as const;
export const OFFLINE_AFTER_FAILURES = 3;

export interface SyncResult {
  folders: Array<{ folder: string; uidvalidity: number; rescanned: boolean; fetched: number; ingested: number; duplicates: number; moved: number; failed: number; lastUid: number }>;
  filesQueued: number;
}

// ---------------------------------------------------------------------------
// Connection health
// ---------------------------------------------------------------------------

const failures = new WeakMap<AppContext, Map<string, number>>();
const failMap = (ctx: AppContext): Map<string, number> => {
  let m = failures.get(ctx);
  if (!m) {
    m = new Map();
    failures.set(ctx, m);
  }
  return m;
};

export function connectionFailures(ctx: AppContext, accountId: string): number {
  return failMap(ctx).get(accountId) ?? 0;
}

/** Count a failed connection; the third in a row raises Needs-you "Email offline" (once while open). */
export function recordConnectionFailure(ctx: AppContext, account: MailAccountRecord, error: string): number {
  const n = connectionFailures(ctx, account.id) + 1;
  failMap(ctx).set(account.id, n);
  ctx.repos.saveMailFolderState(ctx.db, { accountId: account.id, folder: 'INBOX', lastError: error.slice(0, 500) });
  if (n >= OFFLINE_AFTER_FAILURES) {
    createNeedsYou(ctx, {
      kind: 'failure',
      title: 'Email offline',
      summary: `ClaimDesk could not reach the mailbox ${account.username} ${n} times in a row (${error.slice(0, 300)}). New email is not being read. Check the internet connection and the password in Settings > Email.`,
      options: [{ id: 'ok', label: 'Done', tone: 'primary' }],
      payload: { accountId: account.id, error: error.slice(0, 500), failures: n },
      priority: 'high',
      createdBy: MAIL_AGENT,
      dedupeKey: `mail.offline:${account.id}`,
    });
  }
  return n;
}

export function recordConnectionOk(ctx: AppContext, accountId: string): void {
  failMap(ctx).delete(accountId);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Move a committed message out of INBOX (spoof → quarantine; else processed unless copy-only). */
async function moveAfterCommit(ctx: AppContext, account: MailAccountRecord, mailbox: MailboxClient, folder: string, uid: number, r: IngestResult, ensured: Set<string>): Promise<boolean> {
  const target = r.spoof.suspect ? account.quarantineFolder : account.moveAfterIngest ? account.processedFolder : undefined;
  if (!target || target === folder) return false;
  if (!ensured.has(target)) {
    await mailbox.ensureFolder(target);
    ensured.add(target);
  }
  await mailbox.move(folder, uid, target);
  ctx.repos.updateMailMessageRouting(ctx.db, r.message.id, { folder: target, uid: null });
  return true;
}

export async function syncMailbox(ctx: AppContext, account: MailAccountRecord, mailbox: MailboxClient, opts: { parentJobId?: string; correlationId?: string } = {}): Promise<SyncResult> {
  const out: SyncResult = { folders: [], filesQueued: 0 };
  const ensured = new Set<string>();
  for (const folder of SYNC_FOLDERS) {
    const st = await mailbox.status(folder);
    const state = ctx.repos.getMailFolderState(ctx.db, account.id, folder);
    const rescanned = state?.uidvalidity !== undefined && state.uidvalidity !== st.uidValidity;
    let lastUid = rescanned || !state ? 0 : state.lastUid;
    const r = { folder, uidvalidity: st.uidValidity, rescanned, fetched: 0, ingested: 0, duplicates: 0, moved: 0, failed: 0, lastUid };
    if (rescanned) ctx.repos.saveMailFolderState(ctx.db, { accountId: account.id, folder, uidvalidity: st.uidValidity, lastUid: 0 });
    let blocked = false;
    if (rescanned || st.uidNext > lastUid + 1 || st.uidNext === 0) {
      for await (const m of mailbox.fetchSince(folder, lastUid + 1)) {
        r.fetched += 1;
        let done = false;
        try {
          const res = await ingestRaw(ctx, account.id, m.source, { source: 'imap', folder, uid: m.uid, uidvalidity: st.uidValidity, internalDate: m.internalDate.toISOString(), ...opts });
          if (res.duplicate) r.duplicates += 1;
          else r.ingested += 1;
          try {
            if (await moveAfterCommit(ctx, account, mailbox, folder, m.uid, res, ensured)) r.moved += 1;
            done = true;
          } catch (err) {
            ctx.logger.warn('mail move failed; it is retried on the next sync', { uid: m.uid, error: String(err) });
            ctx.repos.saveMailFolderState(ctx.db, { accountId: account.id, folder, lastError: `move ${m.uid}: ${String(err)}`.slice(0, 500) });
          }
        } catch (err) {
          r.failed += 1;
          ctx.logger.warn('mail ingest failed; queued for retry', { uid: m.uid, error: String(err) });
          enqueueJob(ctx, {
            type: 'mail.ingest',
            payload: { accountId: account.id, folder, uidvalidity: st.uidValidity, uid: m.uid },
            idempotencyKey: `mail.ingest:${account.id}:${folder}:${st.uidValidity}:${m.uid}`,
            createdBy: MAIL_AGENT,
            ...opts,
          });
          done = true; // the mail.ingest job owns this UID now
        }
        if (!done) blocked = true;
        if (done && !blocked && m.uid > lastUid) {
          lastUid = m.uid;
          ctx.repos.saveMailFolderState(ctx.db, { accountId: account.id, folder, uidvalidity: st.uidValidity, lastUid });
        }
      }
    }
    r.lastUid = lastUid;
    ctx.repos.saveMailFolderState(ctx.db, { accountId: account.id, folder, uidvalidity: st.uidValidity, lastUid, ...(st.highestModseq ? { highestModseq: st.highestModseq } : {}), lastSyncAt: ctx.now(), ...(blocked ? {} : { lastError: null }) });
    out.folders.push(r);
  }
  out.filesQueued = queueStagedFiles(ctx, opts);
  return out;
}

/** `.eml` files staged from `inbox\mail\` → mail.ingest_file jobs (idempotent on the file hash). */
export function queueStagedFiles(ctx: AppContext, opts: { parentJobId?: string; correlationId?: string } = {}): number {
  let n = 0;
  for (const imp of listStagedImports(ctx, { purpose: 'mail', status: 'staged' })) {
    const job = enqueueJob(ctx, { type: 'mail.ingest_file', payload: { importId: imp.id }, idempotencyKey: `mail.ingest_file:${imp.sha256}`, createdBy: MAIL_AGENT, ...opts });
    if (job.status === 'queued') n += 1;
  }
  return n;
}

/** The `mail.ingest` job: fetch one UID again and ingest + move it. */
export async function ingestOneUid(ctx: AppContext, account: MailAccountRecord, mailbox: MailboxClient, p: { folder: string; uidvalidity: number; uid: number }, opts: { parentJobId?: string; correlationId?: string } = {}): Promise<{ status: 'ingested' | 'duplicate' | 'gone' | 'stale'; messageId?: string }> {
  const st = await mailbox.status(p.folder);
  if (st.uidValidity !== p.uidvalidity) return { status: 'stale' };
  for await (const m of mailbox.fetchSince(p.folder, p.uid)) {
    if (m.uid !== p.uid) break;
    const res = await ingestRaw(ctx, account.id, m.source, { source: 'imap', folder: p.folder, uid: m.uid, uidvalidity: p.uidvalidity, internalDate: m.internalDate.toISOString(), ...opts });
    await moveAfterCommit(ctx, account, mailbox, p.folder, m.uid, res, new Set());
    return { status: res.duplicate ? 'duplicate' : 'ingested', messageId: res.message.id };
  }
  return { status: 'gone' };
}

// ---------------------------------------------------------------------------
// IDLE loop
// ---------------------------------------------------------------------------

export const IDLE_BACKOFF_MS = { min: 5_000, max: 5 * 60_000 } as const;
/** Re-issue IDLE well inside the 29-minute server limit. */
export const IDLE_RENEW_MS = 25 * 60_000;

export function nextBackoff(prev: number): number {
  return Math.min(IDLE_BACKOFF_MS.max, prev <= 0 ? IDLE_BACKOFF_MS.min : prev * 2);
}

/** Queue a sync now (idempotent per minute; a finished sync in the same minute gets a second key). */
export function queueSyncNow(ctx: AppContext, accountId: string, createdBy = MAIL_AGENT): string {
  const minute = ctx.now().slice(0, 16);
  let job = enqueueJob(ctx, { type: 'mail.sync', payload: { accountId }, idempotencyKey: `mail.sync:${accountId}:${minute}`, createdBy });
  if (job.status !== 'queued' && job.status !== 'leased') {
    job = enqueueJob(ctx, { type: 'mail.sync', payload: { accountId }, idempotencyKey: `mail.sync:${accountId}:${minute}:${Date.now()}`, createdBy });
  }
  return job.id;
}

export interface IdleLoop {
  stop(): Promise<void>;
  readonly running: boolean;
}

export interface IdleLoopOptions {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  renewMs?: number;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** The persistent IDLE connection (started by routes/mail.ts onReady when JOBS_ENABLED and an account is enabled). */
export function startIdleLoop(ctx: AppContext, opts: IdleLoopOptions = {}): IdleLoop {
  const stopper = new AbortController();
  const sleep = opts.sleep ?? defaultSleep;
  let running = true;
  const loop = (async () => {
    let backoff = 0;
    while (!stopper.signal.aborted) {
      const account = ctx.repos.getDefaultMailAccount(ctx.db);
      if (!account?.enabled) {
        await sleep(60_000, stopper.signal);
        continue;
      }
      let mailbox: MailboxClient | undefined;
      try {
        mailbox = await mailboxFor(ctx, account);
        await mailbox.connect();
        recordConnectionOk(ctx, account.id);
        backoff = 0;
        queueSyncNow(ctx, account.id);
        while (!stopper.signal.aborted) {
          const renew = AbortSignal.any([stopper.signal, AbortSignal.timeout(opts.renewMs ?? IDLE_RENEW_MS)]);
          await mailbox.idle(() => queueSyncNow(ctx, account.id), renew);
        }
      } catch (err) {
        if (stopper.signal.aborted) break;
        recordConnectionFailure(ctx, account, err instanceof Error ? err.message : String(err));
        backoff = nextBackoff(backoff);
        ctx.logger.warn('mail IDLE connection lost; reconnecting', { backoffMs: backoff, error: String(err) });
        await sleep(backoff, stopper.signal);
      } finally {
        if (mailbox && ctx.config.mailTransport !== 'fake') await mailbox.close().catch(() => undefined);
      }
    }
    running = false;
  })();
  return {
    get running() {
      return running;
    },
    async stop() {
      stopper.abort();
      await loop.catch(() => undefined);
    },
  };
}

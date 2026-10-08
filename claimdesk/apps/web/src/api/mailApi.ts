// owned by mail
/**
 * Mail and outbox client (docs/SUPREME-DESIGN.md §F, §L.5, §N.6). Web code never imports API code, so the HTTP shapes
 * of apps/api/src/routes/{mail,outbox}.ts are declared here.
 *
 *   GET/PUT /mail/account · POST /mail/test · POST /mail/test-send · POST /mail/sync-now
 *   GET /mail/messages · GET /mail/messages/:id · POST /mail/messages/:id/link · GET /claims/:id/mailbox
 *   GET /outbox · GET /outbox/:id · POST /outbox · POST /outbox/:id/{approve,undo,send-now,retry,reject}
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request, seg } from './client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MailAccount {
  id: string;
  label: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: 'tls' | 'starttls';
  username: string;
  fromName: string;
  fromAddress: string;
  signatureText?: string;
  signatureHtml?: string;
  processedFolder: string;
  quarantineFolder: string;
  moveAfterIngest: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MailPresets {
  imap: { host: string; port: number; tls: boolean };
  smtp: Array<{ host: string; port: number; security: 'tls' | 'starttls'; label: string }>;
  folders: { processed: string; quarantine: string };
}

export interface MailFolderState {
  accountId: string;
  folder: string;
  uidvalidity?: number;
  lastUid: number;
  lastSyncAt?: string;
  lastError?: string;
}

export interface MailAccountView {
  account: MailAccount | null;
  passwordSaved: { imap: boolean; smtp: boolean };
  presets: MailPresets;
  transport: 'real' | 'fake';
  sync: { folders: MailFolderState[]; connectionFailures: number } | null;
}

export interface MailAccountInput {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: 'tls' | 'starttls';
  username: string;
  fromAddress: string;
  password?: string;
  smtpPassword?: string;
  signatureText?: string | null;
  processedFolder?: string;
  quarantineFolder?: string;
  moveAfterIngest?: boolean;
  enabled?: boolean;
}

export interface MailTestResult {
  imap: { ok: boolean; folders?: string[]; error?: string };
  smtp: { ok: boolean; error?: string };
  sent: false;
}

export type MailStatus = 'new' | 'matched' | 'needs_match' | 'unmatched' | 'quarantined' | 'processed' | 'ignored';

export interface MailMessageSummary {
  id: string;
  direction: 'in' | 'out';
  threadKey: string;
  from: string | null;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  at: string;
  receivedAt: string;
  status: MailStatus;
  claimId: string | null;
  claimReference: string | null;
  hasAttachments: boolean;
  spoofSuspect: boolean;
  source: 'imap' | 'file' | 'smtp';
  snippet: string;
  intent: { intent: string; label: string; confidence: number; summary: string } | null;
  match: { decidedBy: 'auto' | 'agent' | 'owner'; score: number; because: string[]; decision: string | null; candidates: Array<{ claimId: string; reference: string; score: number }> } | null;
}

export interface MailAttachmentView {
  id: string;
  mailMessageId: string;
  evidenceId: string;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  inline: boolean;
  claimEvidenceId: string | null;
}

export interface MailMessageDetail {
  message: MailMessageSummary & { bodyText: string; replyTo: string | null; auth: unknown; rawEvidenceId: string; messageIdHeader: string | null };
  attachments: MailAttachmentView[];
  matches: Array<{ id: string; claimId?: string; score: number; decidedBy: string; decidedAt: string; signals: unknown }>;
  classifications: Array<{ id: string; intent: string; confidence: number; summary: string; createdAt: string }>;
  thread: MailMessageSummary[];
}

export type OutboxStatus = 'draft' | 'reviewing' | 'awaiting_approval' | 'held' | 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface OutboxAttachment {
  evidenceId?: string;
  documentId?: string;
  filename?: string;
  mime?: string;
  role?: string;
}

export interface OutboxItem {
  id: string;
  claimId: string | null;
  claimReference: string | null;
  kind: string;
  status: OutboxStatus;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  attachments: OutboxAttachment[];
  holdUntil: string | null;
  approvedBy: string | null;
  smtpMessageId: string | null;
  rawSentEvidenceId: string | null;
  attempts: number;
  lastError: string | null;
  policy: { outcome: string | null; ruleIds: string[]; reasons: string[] };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxEvent {
  id: string;
  fromStatus?: OutboxStatus;
  toStatus: OutboxStatus;
  actor: string;
  reason?: string;
  at: string;
}

export interface RecipientInfo {
  address: string;
  role: string;
  verified: boolean;
  firstContact: boolean;
  onClaim: boolean;
}

export interface OutboxDetail {
  item: OutboxItem;
  events: OutboxEvent[];
  review: { id: string; verdict: string; loop: number } | null;
  recipients: RecipientInfo[];
  attachmentsCheck: { allowed: boolean; reasons: string[] };
  now: string;
}

export interface OutboxList {
  items: OutboxItem[];
  counts: Record<OutboxStatus, number>;
  now: string;
}

export interface MailboxThread {
  threadKey: string;
  subject: string;
  lastAt: string;
  count: number;
  messages: MailMessageSummary[];
}

export interface ClaimMailbox {
  claimId: string;
  reference: string;
  threads: MailboxThread[];
  outbox: Array<OutboxItem & { recipients: RecipientInfo[] }>;
}

export interface ComposeInput {
  claimId?: string;
  kind?: string;
  to: string[];
  cc?: string[];
  subject: string;
  bodyText: string;
  attach?: Array<{ evidenceId?: string | null; documentId?: string | null }>;
  inReplyToMessageId?: string | null;
  checkBeforeSending?: boolean;
}

export interface OwnerEdits {
  to?: string[];
  cc?: string[];
  subject?: string;
  bodyText?: string;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const mailApi = {
  account: () => request<MailAccountView>('/mail/account'),
  saveAccount: (body: MailAccountInput) => request<MailAccountView>('/mail/account', { method: 'PUT', body }),
  test: () => request<MailTestResult>('/mail/test', { method: 'POST', body: {} }),
  testSend: () => request<{ outboxId: string; status: OutboxStatus; to: string }>('/mail/test-send', { method: 'POST', body: {} }),
  syncNow: () => request<{ jobId: string }>('/mail/sync-now', { method: 'POST', body: {} }),
  messages: (q: { status?: string; claimId?: string; limit?: number } = {}) => request<{ items: MailMessageSummary[]; total: number }>('/mail/messages', { query: q }),
  message: (id: string) => request<MailMessageDetail>(`/mail/messages/${seg(id)}`),
  link: (id: string, claimId: string | null, reason?: string) => request<MailMessageDetail>(`/mail/messages/${seg(id)}/link`, { method: 'POST', body: { claimId, ...(reason ? { reason } : {}) } }),
  claimMailbox: (claimId: string) => request<ClaimMailbox>(`/claims/${seg(claimId)}/mailbox`),
  outbox: (q: { status?: string; claimId?: string } = {}) => request<OutboxList>('/outbox', { query: q }),
  outboxItem: (id: string) => request<OutboxDetail>(`/outbox/${seg(id)}`),
  compose: (body: ComposeInput) => request<OutboxDetail>('/outbox', { method: 'POST', body }),
  approve: (id: string, edits?: OwnerEdits, note?: string) => request<OutboxDetail>(`/outbox/${seg(id)}/approve`, { method: 'POST', body: { ...(edits ? { edits } : {}), ...(note ? { note } : {}) } }),
  undo: (id: string) => request<OutboxDetail>(`/outbox/${seg(id)}/undo`, { method: 'POST', body: {} }),
  sendNow: (id: string) => request<OutboxDetail>(`/outbox/${seg(id)}/send-now`, { method: 'POST', body: {} }),
  retry: (id: string) => request<OutboxDetail>(`/outbox/${seg(id)}/retry`, { method: 'POST', body: {} }),
  reject: (id: string, reason: string) => request<OutboxDetail>(`/outbox/${seg(id)}/reject`, { method: 'POST', body: { reason } }),
};

export const mailQk = {
  all: ['mail'] as const,
  account: ['mail', 'account'] as const,
  messages: (q: object) => ['mail', 'messages', q] as const,
  message: (id: string) => ['mail', 'message', id] as const,
  claimMailbox: (claimId: string) => ['mail', 'claim', claimId] as const,
  outbox: (q: object) => ['mail', 'outbox', q] as const,
  outboxItem: (id: string) => ['mail', 'outbox', 'item', id] as const,
};

/** Held emails count down; lists refresh every 10 s. */
export const OUTBOX_POLL_MS = 10_000;

export function useMailAccount() {
  return useQuery({ queryKey: mailQk.account, queryFn: mailApi.account });
}

export function useClaimMailbox(claimId: string) {
  return useQuery({ queryKey: mailQk.claimMailbox(claimId), queryFn: () => mailApi.claimMailbox(claimId), refetchInterval: OUTBOX_POLL_MS });
}

export function useMailMessage(id: string | undefined) {
  return useQuery({ queryKey: mailQk.message(id ?? ''), queryFn: () => mailApi.message(id!), enabled: Boolean(id) });
}

export function useOutbox(q: { status?: string; claimId?: string } = {}) {
  return useQuery({ queryKey: mailQk.outbox(q), queryFn: () => mailApi.outbox(q), refetchInterval: OUTBOX_POLL_MS });
}

export function useOutboxItem(id: string | undefined) {
  return useQuery({ queryKey: mailQk.outboxItem(id ?? ''), queryFn: () => mailApi.outboxItem(id!), enabled: Boolean(id) });
}

/** Every mail mutation refreshes mail lists and the Needs-you badge (approvals supersede items). */
export function useMailMutation<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: mailQk.all });
      void qc.invalidateQueries({ queryKey: ['needs-you'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

/** Seconds left on a hold, given the server's "now" and the local time the response arrived (clock-skew safe). */
export function holdSecondsLeft(holdUntil: string | null, serverNow: string, receivedAtMs: number, nowMs: number): number {
  if (!holdUntil) return 0;
  const skew = Date.parse(serverNow) - receivedAtMs;
  return Math.max(0, Math.ceil((Date.parse(holdUntil) - (nowMs + skew)) / 1000));
}

/** "9:58" / "0:05" */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A comma/semicolon list of addresses → trimmed, non-empty, de-duplicated. */
export function parseAddresses(text: string): string[] {
  return [...new Set(text.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];
}

export const isEmailAddress = (s: string): boolean => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);

export const OUTBOX_STATUS_LABEL: Record<OutboxStatus, string> = {
  draft: 'Draft',
  reviewing: 'Being reviewed',
  awaiting_approval: 'Waiting for you',
  held: 'Held — Undo possible',
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const OUTBOX_STATUS_TONE: Record<OutboxStatus, 'green' | 'amber' | 'red' | 'blue' | 'navy' | 'grey'> = {
  draft: 'grey',
  reviewing: 'blue',
  awaiting_approval: 'amber',
  held: 'amber',
  queued: 'blue',
  sending: 'blue',
  sent: 'green',
  failed: 'red',
  cancelled: 'grey',
};

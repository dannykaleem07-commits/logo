// owned by mail
/**
 * Mail transports (docs/SUPREME-DESIGN.md §F.1, §F.2, §F.6).
 *
 *   MailboxClient / SmtpSender      the interfaces, verbatim from §F.2 — everything else codes against these
 *   ImapFlowMailbox                 imapflow 2.2.8: TLS IMAP, BODY.PEEK fetches (never sets \Seen), UID MOVE, APPEND,
 *                                   folder creation, IDLE (resolves when the server reports new mail or on abort)
 *   NodemailerSmtp                  nodemailer 10.0.16: 465 `secure:true`, 587 `requireTLS:true`; the message is
 *                                   built once with MailComposer so the raw bytes we store as evidence are exactly the
 *                                   bytes SMTP accepted
 *   FakeMailbox / FakeSmtp          in memory, used when `config.mailTransport === 'fake'` (tests, CI smoke runs)
 *
 * Passwords come only from the secret store (`imap_password`, `smtp_password`); they are never logged or stored in
 * SQLite.
 */
import { randomUUID } from 'node:crypto';
import type { MailAccountRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';

// ---------------------------------------------------------------------------
// Interfaces (§F.2, verbatim)
// ---------------------------------------------------------------------------

export interface MailboxClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  status(folder: string): Promise<{ uidValidity: number; uidNext: number; highestModseq?: string }>;
  fetchSince(folder: string, uidFrom: number): AsyncIterable<{ uid: number; source: Buffer; flags: string[]; internalDate: Date }>;
  move(folder: string, uid: number, to: string): Promise<void>;
  append(folder: string, raw: Buffer, flags: string[]): Promise<void>;
  ensureFolder(name: string): Promise<void>;
  idle(onExists: () => void, signal: AbortSignal): Promise<void>;
}

export interface SmtpSendInput {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments: { filename: string; path: string; contentType: string }[];
}

export interface SmtpSender {
  verify(): Promise<void>;
  send(msg: SmtpSendInput): Promise<{ messageId: string; accepted: string[]; rejected: string[]; raw: Buffer }>;
}

/** Extra, optional: folder listing for the connection test (both implementations provide it). */
export interface ListsFolders {
  listFolders(): Promise<string[]>;
}

export class MailTransportError extends Error {
  constructor(
    readonly code: 'MAIL_AUTH' | 'MAIL_CONNECT' | 'MAIL_NO_PASSWORD' | 'MAIL_REJECTED' | 'MAIL_PROTOCOL',
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// imapflow
// ---------------------------------------------------------------------------

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

type ImapFlowCtor = typeof import('imapflow').ImapFlow;
type ImapFlowInstance = InstanceType<ImapFlowCtor>;

export class ImapFlowMailbox implements MailboxClient, ListsFolders {
  private client: ImapFlowInstance | undefined;
  constructor(private readonly cfg: ImapConfig) {}

  private async make(): Promise<ImapFlowInstance> {
    const { ImapFlow } = await import('imapflow');
    return new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.secure,
      auth: { user: this.cfg.user, pass: this.cfg.pass },
      logger: false,
      // We drive IDLE ourselves (idle()); an automatic IDLE would race our own commands.
      disableAutoIdle: true,
      clientInfo: { name: 'ClaimDesk' },
    });
  }

  private c(): ImapFlowInstance {
    if (!this.client) throw new MailTransportError('MAIL_CONNECT', 'IMAP is not connected');
    return this.client;
  }

  async connect(): Promise<void> {
    this.client = await this.make();
    try {
      await this.client.connect();
    } catch (err) {
      const e = err as { authenticationFailed?: boolean; message?: string };
      this.client = undefined;
      if (e?.authenticationFailed) throw new MailTransportError('MAIL_AUTH', 'The IONOS mailbox refused the user name or password');
      throw new MailTransportError('MAIL_CONNECT', `Could not connect to ${this.cfg.host}:${this.cfg.port} (${e?.message ?? String(err)})`);
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    if (!c) return;
    try {
      await c.logout();
    } catch {
      c.close();
    }
  }

  async status(folder: string): Promise<{ uidValidity: number; uidNext: number; highestModseq?: string }> {
    const s = await this.c().status(folder, { uidValidity: true, uidNext: true, highestModseq: true });
    if (!s) throw new MailTransportError('MAIL_PROTOCOL', `STATUS ${folder} failed`);
    return { uidValidity: Number(s.uidValidity ?? 0), uidNext: Number(s.uidNext ?? 0), ...(s.highestModseq !== undefined ? { highestModseq: String(s.highestModseq) } : {}) };
  }

  async *fetchSince(folder: string, uidFrom: number): AsyncIterable<{ uid: number; source: Buffer; flags: string[]; internalDate: Date }> {
    const c = this.c();
    const lock = await c.getMailboxLock(folder);
    try {
      // `source: true` fetches BODY.PEEK[] — the message is never marked \Seen (§F.3).
      for await (const m of c.fetch(`${Math.max(1, uidFrom)}:*`, { uid: true, source: true, flags: true, internalDate: true }, { uid: true })) {
        // "n:*" always returns the last message even when its UID is below n.
        if (m.uid < uidFrom || !m.source) continue;
        yield { uid: m.uid, source: m.source, flags: [...(m.flags ?? [])], internalDate: m.internalDate instanceof Date ? m.internalDate : new Date(m.internalDate ?? Date.now()) };
      }
    } finally {
      lock.release();
    }
  }

  async move(folder: string, uid: number, to: string): Promise<void> {
    const c = this.c();
    const lock = await c.getMailboxLock(folder);
    try {
      const r = await c.messageMove(String(uid), to, { uid: true });
      if (r === false) throw new MailTransportError('MAIL_PROTOCOL', `UID MOVE ${uid} to ${to} failed`);
    } finally {
      lock.release();
    }
  }

  async append(folder: string, raw: Buffer, flags: string[]): Promise<void> {
    const r = await this.c().append(folder, raw, flags);
    if (r === false) throw new MailTransportError('MAIL_PROTOCOL', `APPEND to ${folder} failed`);
  }

  async ensureFolder(name: string): Promise<void> {
    const c = this.c();
    const list = await c.list();
    if (list.some((f) => f.path === name)) return;
    await c.mailboxCreate(name);
  }

  async listFolders(): Promise<string[]> {
    return (await this.c().list()).map((f) => f.path);
  }

  async idle(onExists: () => void, signal: AbortSignal): Promise<void> {
    const c = this.c();
    const lock = await c.getMailboxLock('INBOX');
    const onEx = (): void => {
      onExists();
    };
    c.on('exists', onEx);
    const stop = (): void => {
      // Any command breaks IDLE; NOOP is the cheapest.
      void c.noop().catch(() => undefined);
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (!signal.aborted) await c.idle();
    } finally {
      signal.removeEventListener('abort', stop);
      c.off('exists', onEx);
      lock.release();
    }
  }
}

// ---------------------------------------------------------------------------
// nodemailer
// ---------------------------------------------------------------------------

export interface SmtpConfig {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  user: string;
  pass: string;
}

/** Transport options for IONOS: 465 = implicit TLS, 587 = STARTTLS required (never plaintext). */
export function smtpTransportOptions(cfg: SmtpConfig): Record<string, unknown> {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.security === 'tls',
    ...(cfg.security === 'starttls' ? { requireTLS: true } : {}),
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  };
}

/** Build the exact RFC 5322 bytes once (MailComposer) — what we send is what we store. */
export async function buildRawMessage(msg: SmtpSendInput): Promise<Buffer> {
  const { default: MailComposer } = await import('nodemailer/lib/mail-composer');
  const composer = new MailComposer({
    from: msg.from,
    to: msg.to,
    cc: msg.cc.length ? msg.cc : undefined,
    bcc: msg.bcc.length ? msg.bcc : undefined,
    subject: msg.subject,
    text: msg.text,
    ...(msg.html ? { html: msg.html } : {}),
    messageId: msg.messageId,
    ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo } : {}),
    ...(msg.references?.length ? { references: msg.references } : {}),
    attachments: msg.attachments.map((a) => ({ filename: a.filename, path: a.path, contentType: a.contentType })),
  });
  // MimeNode leaves Bcc out of the generated headers by default (keepBcc false), so the stored copy never shows it.
  return await composer.compile().build();
}

export class NodemailerSmtp implements SmtpSender {
  constructor(private readonly cfg: SmtpConfig) {}

  private async transporter() {
    const nodemailer = await import('nodemailer');
    return nodemailer.createTransport(smtpTransportOptions(this.cfg) as Parameters<typeof nodemailer.createTransport>[0]);
  }

  async verify(): Promise<void> {
    const t = await this.transporter();
    try {
      await t.verify();
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === 'EAUTH') throw new MailTransportError('MAIL_AUTH', 'The IONOS SMTP server refused the user name or password');
      throw new MailTransportError('MAIL_CONNECT', `SMTP ${this.cfg.host}:${this.cfg.port}: ${e?.message ?? String(err)}`);
    } finally {
      t.close();
    }
  }

  async send(msg: SmtpSendInput): Promise<{ messageId: string; accepted: string[]; rejected: string[]; raw: Buffer }> {
    const raw = await buildRawMessage(msg);
    const t = await this.transporter();
    try {
      const info = (await t.sendMail({ envelope: { from: addressOnly(msg.from), to: [...msg.to, ...msg.cc, ...msg.bcc] }, raw })) as { messageId?: string; accepted?: unknown[]; rejected?: unknown[] };
      const accepted = (info.accepted ?? []).map(String);
      const rejected = (info.rejected ?? []).map(String);
      if (!accepted.length) throw new MailTransportError('MAIL_REJECTED', `The SMTP server accepted no recipient (rejected: ${rejected.join(', ') || 'all'})`);
      return { messageId: msg.messageId, accepted, rejected, raw };
    } catch (err) {
      if (err instanceof MailTransportError) throw err;
      const e = err as { code?: string; message?: string };
      if (e?.code === 'EAUTH') throw new MailTransportError('MAIL_AUTH', 'The IONOS SMTP server refused the user name or password');
      throw new MailTransportError('MAIL_CONNECT', `SMTP send failed: ${e?.message ?? String(err)}`);
    } finally {
      t.close();
    }
  }
}

/** `"Name" <a@b>` → `a@b`. */
export function addressOnly(v: string): string {
  const m = /<([^>]+)>/.exec(v);
  return (m ? m[1]! : v).trim();
}

// ---------------------------------------------------------------------------
// In-memory fakes (tests, CI)
// ---------------------------------------------------------------------------

interface FakeMessage {
  uid: number;
  source: Buffer;
  flags: string[];
  internalDate: Date;
}

/** An in-memory IMAP server: folders with UIDVALIDITY, monotonically increasing UIDs, MOVE, APPEND, IDLE. */
export class FakeMailbox implements MailboxClient, ListsFolders {
  folders = new Map<string, { uidValidity: number; uidNext: number; messages: FakeMessage[] }>();
  connected = false;
  /** Operations in order (tests assert ingest-before-move). */
  log: string[] = [];
  /** Throw on connect (offline tests). */
  failConnect: Error | undefined;
  /** Throw on the next move (move-failure tests). */
  failMove: Error | undefined;
  private existsListeners = new Set<() => void>();

  constructor(folders: string[] = ['INBOX', 'Sent']) {
    for (const f of folders) this.folders.set(f, { uidValidity: 1, uidNext: 1, messages: [] });
  }

  private folder(name: string) {
    const f = this.folders.get(name);
    if (!f) throw new MailTransportError('MAIL_PROTOCOL', `No folder ${name}`);
    return f;
  }

  /** Deliver a message (as the server would); fires IDLE listeners. */
  deliver(raw: Buffer | string, folder = 'INBOX', internalDate = new Date()): number {
    const f = this.folder(folder);
    const uid = f.uidNext++;
    f.messages.push({ uid, source: Buffer.isBuffer(raw) ? raw : Buffer.from(raw), flags: [], internalDate });
    for (const l of this.existsListeners) l();
    return uid;
  }

  /** Simulate a server-side UIDVALIDITY change: every message gets a new UID. */
  resetUidValidity(folder = 'INBOX'): void {
    const f = this.folder(folder);
    f.uidValidity += 1;
    f.uidNext = 1;
    for (const m of f.messages) m.uid = f.uidNext++;
  }

  async connect(): Promise<void> {
    if (this.failConnect) throw this.failConnect;
    this.connected = true;
    this.log.push('connect');
  }
  async close(): Promise<void> {
    this.connected = false;
    this.log.push('close');
  }
  async status(folder: string): Promise<{ uidValidity: number; uidNext: number }> {
    const f = this.folder(folder);
    return { uidValidity: f.uidValidity, uidNext: f.uidNext };
  }
  async *fetchSince(folder: string, uidFrom: number): AsyncIterable<FakeMessage> {
    const f = this.folder(folder);
    for (const m of [...f.messages].sort((a, b) => a.uid - b.uid)) {
      if (m.uid < uidFrom) continue;
      this.log.push(`fetch ${folder}:${m.uid}`);
      yield { uid: m.uid, source: m.source, flags: [...m.flags], internalDate: m.internalDate };
    }
  }
  async move(folder: string, uid: number, to: string): Promise<void> {
    if (this.failMove) {
      const e = this.failMove;
      this.failMove = undefined;
      throw e;
    }
    const f = this.folder(folder);
    const dest = this.folder(to);
    const i = f.messages.findIndex((m) => m.uid === uid);
    if (i < 0) throw new MailTransportError('MAIL_PROTOCOL', `No UID ${uid} in ${folder}`);
    const [m] = f.messages.splice(i, 1);
    dest.messages.push({ ...m!, uid: dest.uidNext++ });
    this.log.push(`move ${folder}:${uid}->${to}`);
  }
  async append(folder: string, raw: Buffer, flags: string[]): Promise<void> {
    const f = this.folder(folder);
    f.messages.push({ uid: f.uidNext++, source: raw, flags: [...flags], internalDate: new Date() });
    this.log.push(`append ${folder}`);
  }
  async ensureFolder(name: string): Promise<void> {
    if (!this.folders.has(name)) {
      this.folders.set(name, { uidValidity: 1, uidNext: 1, messages: [] });
      this.log.push(`create ${name}`);
    }
  }
  async listFolders(): Promise<string[]> {
    return [...this.folders.keys()];
  }
  async idle(onExists: () => void, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const l = (): void => {
        this.existsListeners.delete(l);
        onExists();
        resolve();
      };
      this.existsListeners.add(l);
      signal.addEventListener(
        'abort',
        () => {
          this.existsListeners.delete(l);
          resolve();
        },
        { once: true },
      );
    });
  }
  messages(folder: string): FakeMessage[] {
    return this.folder(folder).messages;
  }
}

/** An in-memory SMTP server: records every accepted message; can be told to fail. */
export class FakeSmtp implements SmtpSender {
  sent: Array<SmtpSendInput & { raw: Buffer }> = [];
  /** Fail the next N sends with this error. */
  failNext = 0;
  failWith: Error = new MailTransportError('MAIL_CONNECT', 'fake SMTP is down');
  verifyError: Error | undefined;

  async verify(): Promise<void> {
    if (this.verifyError) throw this.verifyError;
  }
  async send(msg: SmtpSendInput): Promise<{ messageId: string; accepted: string[]; rejected: string[]; raw: Buffer }> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw this.failWith;
    }
    const raw = await buildRawMessage(msg);
    this.sent.push({ ...msg, raw });
    return { messageId: msg.messageId, accepted: [...msg.to, ...msg.cc, ...msg.bcc].map(addressOnly), rejected: [], raw };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const fakes = new WeakMap<AppContext, { mailbox: FakeMailbox; smtp: FakeSmtp }>();

/** The process-wide fakes for this app (tests reach the same instances the handlers use). */
export function fakeTransports(ctx: AppContext): { mailbox: FakeMailbox; smtp: FakeSmtp } {
  let f = fakes.get(ctx);
  if (!f) {
    f = { mailbox: new FakeMailbox(), smtp: new FakeSmtp() };
    fakes.set(ctx, f);
  }
  return f;
}

/** Test hook: replace the transports for a context (e.g. a fresh FakeMailbox). */
export function setFakeTransports(ctx: AppContext, t: { mailbox?: FakeMailbox; smtp?: FakeSmtp }): void {
  const cur = fakeTransports(ctx);
  fakes.set(ctx, { mailbox: t.mailbox ?? cur.mailbox, smtp: t.smtp ?? cur.smtp });
}

async function password(ctx: AppContext, name: 'imap_password' | 'smtp_password'): Promise<string> {
  const v = (await ctx.secrets.get(name)) ?? (name === 'smtp_password' ? await ctx.secrets.get('imap_password') : undefined);
  if (!v) throw new MailTransportError('MAIL_NO_PASSWORD', 'The mailbox password has not been saved yet (Settings > Email)');
  return v;
}

/** A new IMAP client for the account (fake when MAIL_TRANSPORT=fake). The caller connects and closes it. */
export async function mailboxFor(ctx: AppContext, account: MailAccountRecord): Promise<MailboxClient & ListsFolders> {
  if (ctx.config.mailTransport === 'fake') return fakeTransports(ctx).mailbox;
  return new ImapFlowMailbox({ host: account.imapHost, port: account.imapPort, secure: account.imapTls, user: account.username, pass: await password(ctx, 'imap_password') });
}

/** The SMTP sender for the account (fake when MAIL_TRANSPORT=fake). SMTP uses `smtp_password`, else the IMAP one. */
export async function smtpFor(ctx: AppContext, account: MailAccountRecord): Promise<SmtpSender> {
  if (ctx.config.mailTransport === 'fake') return fakeTransports(ctx).smtp;
  return new NodemailerSmtp({ host: account.smtpHost, port: account.smtpPort, security: account.smtpSecurity, user: account.username, pass: await password(ctx, 'smtp_password') });
}

/** `<uuid@domain>` for an outgoing message (§F.6). */
export function newMessageId(fromAddress: string): string {
  const domain = addressOnly(fromAddress).split('@')[1]?.toLowerCase() || 'claimdesk.local';
  return `<${randomUUID()}@${domain}>`;
}

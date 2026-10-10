// owned by runtime
/**
 * Owner notifications (docs/SUPREME-DESIGN.md §J.1).
 *
 *   in-app  — always (the `notifications` row itself; the top bar and the Needs-you inbox read it)
 *   toast   — Needs-you `normal` and above (setting `toastMinPriority`), held sends (Open / Undo), AI paused, email
 *             offline; reference + kind only; quiet hours suppress toasts below `urgent`
 *   sms     — Phase 2 (Twilio); the channel interface exists and reports 'disabled'
 *
 * Other slices raise owner notifications through `notifyOwner()` (e.g. mail: a held send with Undo) or implicitly
 * through `createNeedsYou` (which queues `notify.dispatch {needsYouId}`).
 */
import type { ISODateTime, NeedsYouKind, NeedsYouPriority } from '@ccguk/domain';
import type { NotificationRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { enqueueJob, londonHhmm } from '../agent/core.js';
import { showToast, type ShowToastOptions, type ToastAction, type ToastResult } from './toast.js';

export type NotifyLevel = NeedsYouPriority;
export type NotifyKind = 'needs_you' | 'held_send' | 'ai_paused' | 'email_offline' | 'failure' | 'test' | 'info';
export type NotifyChannel = 'in_app' | 'toast' | 'sms';

const RANK: Record<NotifyLevel, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
/** Kinds that raise a toast whatever their level (§J.1). */
const ALWAYS_TOAST: ReadonlySet<NotifyKind> = new Set(['held_send', 'ai_paused', 'email_offline', 'test']);

export const NEEDS_YOU_KIND_LABEL: Record<NeedsYouKind, string> = {
  approve_send: 'Email waiting for approval',
  approve_document: 'Document waiting for approval',
  missing_info: 'Missing information',
  confirm_fields: 'Details to confirm',
  offer_decision: 'Offer received',
  money: 'Payment to confirm',
  legal_review: 'Legal matter to review',
  which_claim: 'Email to file',
  new_claim: 'Possible new claim',
  override_needed: 'Manager override needed',
  question: 'Question from the agents',
  spoof_warning: 'Suspicious email',
  ai_paused: 'AI paused — deadline due',
  setup: 'Setup needed',
  failure: 'Agent problem',
  // Autopilot (SUPREME-AUTOPILOT §H.3)
  choose_car: 'Choose a car for the client',
  approve_pack: 'Paperwork pack to approve',
  confirm_signed: 'Signed paperwork to confirm',
  clash_review: 'Booking clash to review',
  eligibility_review: 'Driver or need to review',
  autopilot_step: 'Autopilot step for you',
};

// ---------------------------------------------------------------------------
// SMS channel (Phase 2)
// ---------------------------------------------------------------------------

export interface SmsChannel {
  send(ctx: AppContext, n: NotificationRecord): Promise<{ status: 'sent' | 'disabled' | 'failed'; error?: string }>;
}

/** Phase 1: SMS is not built; the channel says so. */
export const disabledSmsChannel: SmsChannel = { send: async () => ({ status: 'disabled' }) };

// ---------------------------------------------------------------------------
// Creating notifications
// ---------------------------------------------------------------------------

export interface NotifyOwnerInput {
  level: NotifyLevel;
  title: string;
  body: string;
  /** In-app path (e.g. `/needs-you/<id>`, `/outbox/<id>`). */
  link?: string;
  kind?: NotifyKind;
  needsYouId?: string;
  /** Lock-screen text (reference + kind only). Defaults to a neutral line built from `kind`. */
  toastTitle?: string;
  toastBody?: string;
  /** Held send: the outbox id the Undo button acts on. */
  undoOutboxId?: string;
}

/** Stored in `channels` so `dispatch` can rebuild the toast without personal data. */
interface ToastSpec {
  kind: NotifyKind;
  title: string;
  body: string;
  undoOutboxId?: string;
}

const TOAST_PREFIX = 'toast:';

function channelsFor(ctx: AppContext, level: NotifyLevel, kind: NotifyKind): NotifyChannel[] {
  const s = ctx.repos.getAgentSettings(ctx.db).notifications;
  const out: NotifyChannel[] = ['in_app'];
  if (s.toasts && (ALWAYS_TOAST.has(kind) || RANK[level] <= RANK[s.toastMinPriority])) out.push('toast');
  if (s.sms.enabled && level === 'urgent') out.push('sms');
  return out;
}

/**
 * Raise an owner notification: the in-app row now, channels delivered by a `notify.dispatch` job (§C.2 key
 * `notify.dispatch:<notificationId>`). Returns the stored row.
 */
export function notifyOwner(ctx: AppContext, input: NotifyOwnerInput): NotificationRecord {
  const kind = input.kind ?? (input.needsYouId ? 'needs_you' : 'info');
  const channels = channelsFor(ctx, input.level, kind);
  const spec: ToastSpec = {
    kind,
    title: input.toastTitle ?? 'ClaimDesk',
    body: input.toastBody ?? defaultToastBody(kind),
    ...(input.undoOutboxId ? { undoOutboxId: input.undoOutboxId } : {}),
  };
  const row = ctx.repos.createNotification(ctx.db, {
    level: input.level,
    title: input.title,
    body: input.body,
    link: input.link,
    needsYouId: input.needsYouId,
    channels: [...channels, `${TOAST_PREFIX}${JSON.stringify(spec)}`],
    now: ctx.now(),
  });
  if (channels.length > 1) enqueueJob(ctx, { type: 'notify.dispatch', payload: { notificationId: row.id }, idempotencyKey: `notify.dispatch:${row.id}`, createdBy: 'agent:supervisor' });
  else ctx.repos.appendNotificationDelivery(ctx.db, row.id, { channel: 'in_app', at: ctx.now(), ok: true });
  return ctx.repos.getNotification(ctx.db, row.id) ?? row;
}

function defaultToastBody(kind: NotifyKind): string {
  switch (kind) {
    case 'held_send':
      return 'An email is held before sending. Open ClaimDesk to check it or undo.';
    case 'ai_paused':
      return 'AI is paused. Open ClaimDesk for details.';
    case 'email_offline':
      return 'The mailbox cannot be reached. Open ClaimDesk.';
    case 'test':
      return 'Test notification from ClaimDesk.';
    default:
      return 'Something needs you. Open ClaimDesk.';
  }
}

/** The notification row for a Needs-you item (created once; lock-screen text = kind + claim reference only). */
export function notificationForNeedsYou(ctx: AppContext, needsYouId: string): NotificationRecord | undefined {
  const existing = ctx.repos.listNotifications(ctx.db, { needsYouId, limit: 1 })[0];
  if (existing) return existing;
  const item = ctx.repos.getNeedsYouItem(ctx.db, needsYouId);
  if (!item) return undefined;
  const reference = item.claimId ? ctx.repos.getClaim(ctx.db, item.claimId)?.reference : undefined;
  const label = NEEDS_YOU_KIND_LABEL[item.kind] ?? 'Needs you';
  const kind: NotifyKind = item.kind === 'ai_paused' ? 'ai_paused' : item.kind === 'failure' ? 'failure' : 'needs_you';
  const channels = channelsFor(ctx, item.priority, kind);
  const spec: ToastSpec = { kind, title: 'ClaimDesk needs you', body: reference ? `${label} on ${reference}` : label };
  return ctx.repos.createNotification(ctx.db, {
    needsYouId,
    level: item.priority,
    title: item.title,
    body: item.summary.slice(0, 500),
    link: `/needs-you/${needsYouId}`,
    channels: [...channels, `${TOAST_PREFIX}${JSON.stringify(spec)}`],
    now: ctx.now(),
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchOptions extends ShowToastOptions {
  sms?: SmsChannel;
  now?: ISODateTime;
}

export interface DispatchResult {
  notificationId: string;
  deliveries: Array<{ channel: NotifyChannel; ok: boolean; status: string; error?: string }>;
}

/** Inside quiet hours (autonomy settings, London time)? */
export function inQuietHours(quiet: { start: string; end: string } | null | undefined, hhmm: string): boolean {
  if (!quiet) return false;
  const { start, end } = quiet;
  if (start === end) return false;
  return start < end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
}

function toastSpecOf(n: NotificationRecord): ToastSpec | undefined {
  const raw = n.channels.find((c) => c.startsWith(TOAST_PREFIX));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw.slice(TOAST_PREFIX.length)) as ToastSpec;
  } catch {
    return undefined;
  }
}

/** Deliver a notification on its channels (§J.1). Each attempt is recorded on the row. */
export async function dispatch(ctx: AppContext, notificationId: string, opts: DispatchOptions = {}): Promise<DispatchResult> {
  const n = ctx.repos.getNotification(ctx.db, notificationId);
  if (!n) throw new Error(`notification ${notificationId} not found`);
  const at = opts.now ?? ctx.now();
  const settings = ctx.repos.getAgentSettings(ctx.db);
  const done = new Set(n.deliveries.filter((d) => d.ok).map((d) => d.channel));
  const out: DispatchResult = { notificationId, deliveries: [] };
  const record = (channel: NotifyChannel, ok: boolean, status: string, error?: string): void => {
    ctx.repos.appendNotificationDelivery(ctx.db, notificationId, { channel, at, ok, ...(error || !ok ? { error: error ?? status } : {}) });
    out.deliveries.push({ channel, ok, status, ...(error ? { error } : {}) });
  };
  const channels = n.channels.filter((c): c is NotifyChannel => c === 'in_app' || c === 'toast' || c === 'sms');
  for (const channel of channels) {
    if (done.has(channel)) continue;
    if (channel === 'in_app') {
      record('in_app', true, 'shown');
      continue;
    }
    if (channel === 'toast') {
      const spec = toastSpecOf(n) ?? { kind: 'info' as NotifyKind, title: 'ClaimDesk', body: 'Open ClaimDesk.' };
      if (!settings.notifications.toasts && spec.kind !== 'test') {
        record('toast', true, 'disabled');
        continue;
      }
      if (n.level !== 'urgent' && spec.kind !== 'test' && settings.notifications.quietHoursSuppressToasts && inQuietHours(settings.autonomy.quietHours, londonHhmm(at))) {
        record('toast', true, 'quiet_hours');
        continue;
      }
      const launch = n.link ?? '/needs-you';
      const actions: ToastAction[] = [{ label: 'Open', url: launch }];
      if (spec.undoOutboxId) actions.push({ label: 'Undo', url: `outbox/${encodeURIComponent(spec.undoOutboxId)}?undo=1` });
      let res: ToastResult;
      try {
        res = await showToast({ title: spec.title, body: spec.body, launch, actions }, { ...opts, logger: opts.logger ?? ctx.logger });
      } catch (err) {
        res = { shown: false, reason: 'powershell_failed', error: String(err) };
      }
      // Off Windows the toast is a logged no-op: in-app only, not a failure.
      if (res.shown) record('toast', true, 'shown');
      else if (res.reason === 'not_windows') record('toast', true, 'not_windows');
      else record('toast', false, res.reason ?? 'failed', res.error);
      continue;
    }
    if (channel === 'sms') {
      const r = await (opts.sms ?? disabledSmsChannel).send(ctx, n);
      record('sms', r.status !== 'failed', r.status, r.error);
    }
  }
  return out;
}

/** Notification for a held send (mail slice): toast with Open and Undo. */
export function notifyHeldSend(ctx: AppContext, input: { outboxId: string; reference?: string; holdUntil: ISODateTime; title: string; body: string }): NotificationRecord {
  return notifyOwner(ctx, {
    level: 'normal',
    kind: 'held_send',
    title: input.title,
    body: input.body,
    link: `/outbox/${input.outboxId}`,
    toastTitle: 'Email held before sending',
    toastBody: `${input.reference ? `${input.reference}: ` : ''}sends at ${londonHhmm(input.holdUntil)} unless you undo it.`,
    undoOutboxId: input.outboxId,
  });
}

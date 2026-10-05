/**
 * Manager mode and the central override gate (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.4).
 *
 * State. Manager mode is a per-session flag `sessions.manager_mode_until` with a sliding idle expiry (Settings →
 * `managerModeIdleMinutes`, default 60). In header auth mode (tests only) there is no session, so an in-memory
 * `WeakMap<AppContext, Map<userId, until>>` gives the same semantics. An expired value is cleared the first time it is
 * read and audited once as `manager_mode.off {why:'expired'}`.
 *
 * Gate. Every class A/B guard refuses through `gateFor(ctx, request).refuse(error, target)`; class C guards keep
 * `throw`. A code that is not in `OVERRIDE_RULES` is always thrown unchanged. When the gate is active (manager role,
 * manager mode on, and the request carries `X-Manager-Override`) the refusal is recorded as an AppliedOverride and the
 * caller carries on; otherwise the error gains `override` (OverrideInfo) so the web can offer "Override as manager".
 *
 * Audit. The app's `onSend` hook (app.ts) writes one `override.<CODE>` audit row per applied override after a 2xx/3xx
 * response. Unlike route audits these rows are written right after the change commits, not inside its transaction —
 * a deliberate trade for having one writer for every guard (a crash between commit and audit is the only gap; §J.1).
 */
import type { FastifyRequest } from 'fastify';
import {
  DEFAULT_OVERRIDE_REASON,
  isManagerRole,
  MANAGER_MODE_DEFAULT_IDLE_MINUTES,
  MANAGER_OVERRIDE_HEADER,
  MANAGER_RELAXED_HEADER,
  OVERRIDE_REASON_MAX,
  overrideRule,
  type Id,
  type ISODateTime,
  type OverrideClass,
} from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { HttpError, type OverrideInfo } from '../errors.js';

/** What an override was about. With a claimId the audit row is keyed to the claim (shows in the claim's audit trail). */
export interface OverrideTarget { claimId?: Id; entity: string; entityId: Id }
/** Placeholder entityId for something created by this request (bindClaim fills it). */
export const NEW_ENTITY = '(new)';

export interface AppliedOverride { code: string; class: OverrideClass; label: string; message: string; details?: unknown; target: OverrideTarget; reason: string }

export interface ManagerModeState { allowed: boolean; on: boolean; until?: ISODateTime; idleMinutes: number }

export interface OverrideGate {
  /** The signed-in user may use manager mode (admin/approver, or the header-mode assumed dev user). */
  readonly allowed: boolean;
  /** allowed && manager mode is on for this session && the request carries X-Manager-Override. */
  readonly active: boolean;
  /** Decoded X-Manager-Override (trimmed, ≤ 500 chars) or 'Manager override'. */
  readonly reason: string;
  /**
   * The ONLY way a class A/B guard refuses. Code not in OVERRIDE_RULES → throws `error` unchanged (class C).
   * Overridable and active → records an AppliedOverride and returns (the caller carries on).
   * Overridable, not active → sets `error.override` (OverrideInfo) and throws.
   */
  refuse(error: HttpError, target: OverrideTarget): void;
  /** Point overrides recorded with entityId NEW_ENTITY (or no claimId) at the claim this request created. */
  bindClaim(claimId: Id): void;
  readonly applied: readonly AppliedOverride[];
}

/** Sliding-expiry writes happen at most this often per session (or per user in header mode). */
const EXTEND_THROTTLE_MS = 30_000;
/**
 * The stored expiry is the idle period plus this grace. The web app switches manager mode off itself (and says so)
 * when the idle period has passed; the server's expiry is only the backstop for a window that was closed, so it must
 * not win the race against the client's own idle switch-off.
 */
export const EXPIRY_GRACE_MS = 2 * 60_000;
const RELAXED_MAX_KEYS = 20;
const RELAXED_KEY_MAX = 80;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Header auth mode (tests only): manager mode per user, per app context. */
const headerModeStore = new WeakMap<AppContext, Map<string, ISODateTime>>();

function headerStore(ctx: AppContext): Map<string, ISODateTime> {
  let m = headerModeStore.get(ctx);
  if (!m) {
    m = new Map();
    headerModeStore.set(ctx, m);
  }
  return m;
}

function idleMinutesOf(ctx: AppContext): number {
  const v = ctx.settings().managerModeIdleMinutes;
  return Number.isInteger(v) && v > 0 ? v : MANAGER_MODE_DEFAULT_IDLE_MINUTES;
}

function userOf(request: FastifyRequest): FastifyRequest['user'] | undefined {
  return request.user as FastifyRequest['user'] | undefined;
}

function isAllowed(request: FastifyRequest): boolean {
  const u = userOf(request);
  return !!u && (u.assumed || isManagerRole(u.role));
}

/** Where this request's manager-mode flag lives: the session row, or the header-mode store. Undefined: nowhere. */
type Slot = { kind: 'session'; sessionId: string } | { kind: 'header'; userId: string };

function slotOf(ctx: AppContext, request: FastifyRequest): Slot | undefined {
  const u = userOf(request);
  if (!u) return undefined;
  if (request.sessionId) return { kind: 'session', sessionId: request.sessionId };
  if (ctx.config.authMode === 'header') return { kind: 'header', userId: u.id };
  return undefined;
}

function readUntil(ctx: AppContext, slot: Slot): ISODateTime | undefined {
  if (slot.kind === 'session') return ctx.repos.getSessionByTokenHash(ctx.db, slot.sessionId)?.managerModeUntil;
  return headerStore(ctx).get(slot.userId);
}

function writeUntil(ctx: AppContext, slot: Slot, until: ISODateTime | null): void {
  if (slot.kind === 'session') {
    ctx.repos.setSessionManagerMode(ctx.db, slot.sessionId, until);
    return;
  }
  if (until === null) headerStore(ctx).delete(slot.userId);
  else headerStore(ctx).set(slot.userId, until);
}

function auditMode(ctx: AppContext, request: FastifyRequest, action: 'manager_mode.on' | 'manager_mode.off', after: Record<string, unknown>): void {
  const u = userOf(request);
  ctx.repos.appendAudit(ctx.db, { actor: request.actor, action, entity: 'user', entityId: u?.id ?? 'anonymous', after, at: ctx.now() });
}

/**
 * Current manager-mode state for the signed-in user. An expired flag is cleared here and audited once
 * (`manager_mode.off {why:'expired'}`); a flag left on a user who is no longer a manager is cleared the same way.
 */
export function managerModeState(ctx: AppContext, request: FastifyRequest): ManagerModeState {
  const allowed = isAllowed(request);
  const idleMinutes = idleMinutesOf(ctx);
  const slot = slotOf(ctx, request);
  if (!slot) return { allowed, on: false, idleMinutes };
  const until = readUntil(ctx, slot);
  if (!until) return { allowed, on: false, idleMinutes };
  const nowMs = Date.parse(ctx.now());
  if (!(Date.parse(until) > nowMs) || !allowed) {
    writeUntil(ctx, slot, null);
    auditMode(ctx, request, 'manager_mode.off', { why: allowed ? 'expired' : 'not_allowed', until });
    return { allowed, on: false, idleMinutes };
  }
  return { allowed, on: true, until, idleMinutes };
}

/**
 * Turn manager mode on (sets/extends the sliding expiry; also the client heartbeat) or off. `on:true` needs a manager
 * role (403 FORBIDDEN). Audits `manager_mode.on {until, idleMinutes}` only on an off→on change and
 * `manager_mode.off {why}` only when it was on.
 */
export function setManagerMode(ctx: AppContext, request: FastifyRequest, on: boolean, why: 'user' | 'idle' | 'sign_out' = 'user'): ManagerModeState {
  const slot = slotOf(ctx, request);
  if (!on && why === 'idle' && slot && readUntil(ctx, slot)) {
    // The client's idle switch-off: record it as idle even when the stored value has just expired (the backstop),
    // so the audit says why it really went off.
    writeUntil(ctx, slot, null);
    auditMode(ctx, request, 'manager_mode.off', { why: 'idle' });
    return { allowed: isAllowed(request), on: false, idleMinutes: idleMinutesOf(ctx) };
  }
  const before = managerModeState(ctx, request);
  if (on) {
    if (!before.allowed) {
      const u = userOf(request);
      throw new HttpError(403, 'FORBIDDEN', `Only admin or approver users can use manager mode (you are signed in as ${u?.role ?? 'nobody'}).`);
    }
    if (!slot) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
    const until = new Date(Date.parse(ctx.now()) + before.idleMinutes * 60_000 + EXPIRY_GRACE_MS).toISOString();
    writeUntil(ctx, slot, until);
    if (!before.on) auditMode(ctx, request, 'manager_mode.on', { until, idleMinutes: before.idleMinutes });
    return { allowed: true, on: true, until, idleMinutes: before.idleMinutes };
  }
  if (slot && before.on) {
    writeUntil(ctx, slot, null);
    auditMode(ctx, request, 'manager_mode.off', { why });
  }
  return { allowed: before.allowed, on: false, idleMinutes: before.idleMinutes };
}

/** Sliding expiry on activity: at most one write per EXTEND_THROTTLE_MS. */
function extend(ctx: AppContext, request: FastifyRequest, state: ManagerModeState): void {
  const slot = slotOf(ctx, request);
  if (!slot || !state.on || !state.until) return;
  const nowMs = Date.parse(ctx.now());
  const lastSetMs = Date.parse(state.until) - state.idleMinutes * 60_000 - EXPIRY_GRACE_MS;
  if (nowMs - lastSetMs < EXTEND_THROTTLE_MS) return;
  writeUntil(ctx, slot, new Date(nowMs + state.idleMinutes * 60_000 + EXPIRY_GRACE_MS).toISOString());
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Decoded X-Manager-Override reason (trimmed, ≤ 500 characters), or the default. */
export function overrideReasonFrom(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_OVERRIDE_REASON;
  return decode(raw).trim().slice(0, OVERRIDE_REASON_MAX) || DEFAULT_OVERRIDE_REASON;
}

/** Decoded X-Manager-Relaxed rule keys (split on ',', trimmed, max 20 keys of max 80 characters). */
export function relaxedRulesFrom(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of decode(raw).split(',')) {
    const k = part.trim().slice(0, RELAXED_KEY_MAX);
    if (k && !out.includes(k)) out.push(k);
    if (out.length >= RELAXED_MAX_KEYS) break;
  }
  return out;
}

/** Route pattern under /api/claims/:id → the claim; otherwise the request itself. */
function defaultTarget(request: FastifyRequest): OverrideTarget {
  const route = request.routeOptions.url ?? request.url.split('?')[0] ?? request.url;
  const id = (request.params as Record<string, string> | undefined)?.id;
  if (id && (route === '/api/claims/:id' || route.startsWith('/api/claims/:id/'))) return { claimId: id, entity: 'claims', entityId: id };
  return { entity: 'request', entityId: route };
}

class RequestGate implements OverrideGate {
  readonly applied: AppliedOverride[] = [];
  private boundClaimId: Id | undefined;

  constructor(
    readonly allowed: boolean,
    readonly active: boolean,
    readonly reason: string,
    private readonly managerOn: boolean,
  ) {}

  refuse(error: HttpError, target: OverrideTarget): void {
    const rule = overrideRule(error.code);
    if (!rule) throw error;
    if (!this.active) {
      const info: OverrideInfo = { code: rule.code, class: rule.class, label: rule.label, allowed: this.allowed, managerMode: this.managerOn ? 'on' : 'off' };
      if (rule.warning) info.warning = rule.warning;
      error.override = info;
      throw error;
    }
    this.record(rule.code, error.message, error.details, target);
  }

  record(code: string, message: string, details: unknown, target: OverrideTarget): void {
    const rule = overrideRule(code);
    if (!rule) return;
    const t: OverrideTarget = { ...target };
    if (this.boundClaimId) this.bind(t, this.boundClaimId);
    const o: AppliedOverride = { code: rule.code, class: rule.class, label: rule.label, message, target: t, reason: this.reason };
    if (details !== undefined) o.details = details;
    this.applied.push(o);
  }

  bindClaim(claimId: Id): void {
    this.boundClaimId = claimId;
    for (const o of this.applied) this.bind(o.target, claimId);
  }

  private bind(t: OverrideTarget, claimId: Id): void {
    if (t.entityId === NEW_ENTITY) t.entityId = claimId;
    if (!t.claimId) t.claimId = claimId;
  }
}

class StrictGate implements OverrideGate {
  readonly allowed = false;
  readonly active = false;
  readonly reason = DEFAULT_OVERRIDE_REASON;
  readonly applied: readonly AppliedOverride[] = Object.freeze([]);
  refuse(error: HttpError): void {
    throw error;
  }
  bindClaim(): void {
    /* nothing to bind */
  }
}

/** Never active; refuse() always throws the error unchanged. For jobs, system callers and default arguments. */
export const STRICT_GATE: OverrideGate = new StrictGate();

const gates = new WeakMap<FastifyRequest, RequestGate>();

/** The gate of this request (memoised). Reads manager-mode state once, extends it when active (throttled). */
export function gateFor(ctx: AppContext, request: FastifyRequest): OverrideGate {
  const existing = gates.get(request);
  if (existing) return existing;
  const allowed = isAllowed(request);
  const overrideHeader = headerValue(request, MANAGER_OVERRIDE_HEADER);
  const requested = overrideHeader !== undefined;
  const reason = overrideReasonFrom(overrideHeader);
  const state = managerModeState(ctx, request);
  const active = allowed && state.on && requested;
  const gate = new RequestGate(allowed, active, reason, state.on);
  gates.set(request, gate);
  if (active) {
    extend(ctx, request, state);
    const rules = relaxedRulesFrom(headerValue(request, MANAGER_RELAXED_HEADER));
    if (rules.length) gate.record('WEB_VALIDATION', `On-screen checks relaxed: ${rules.join(', ')}`, { rules }, defaultTarget(request));
  }
  return gate;
}

/** The gate of this request if one was created (for the onSend hook). */
export function peekGate(request: FastifyRequest): OverrideGate | undefined {
  return gates.get(request);
}

/**
 * GET /claims response (docs/V03-MANAGER-MODE-HIRE-PRICING.md §E2). Each row is the claim plus what the claims list
 * shows without opening the file: claimant name, client registration, open-flag count, the at-fault insurer's name,
 * the handler's name, the outstanding amount from the ledger (the single source of truth) and the oldest overdue clock
 * from the clocks cache. Read-only: nothing here writes.
 */
import type { Claim, ClaimStatus, Clock, Id, ISODateTime, Pence } from '@ccguk/domain';
import type { AppContext } from '../context.js';

export interface OverdueClockSummary {
  id: Id;
  kind: Clock['kind'];
  label: string;
  basis: string;
  status: Clock['status'];
  dueAt: ISODateTime;
  /** Whole days past due at the time of the request (0 = due earlier today). */
  daysOverdue: number;
  /** Other overdue clocks on the same claim. */
  moreOverdue: number;
}

export interface ClaimListItem extends Claim {
  claimantName?: string;
  registration?: string;
  openFlags: number;
  insurerName?: string;
  handlerName?: string;
  outstandingPence: Pence;
  oldestOverdueClock?: OverdueClockSummary;
}

export interface ClaimListResponse {
  items: ClaimListItem[];
  total: number;
  byStatus: Array<{ status: ClaimStatus; count: number }>;
}

const MS_DAY = 86_400_000;

/** A clock is overdue when it breached, or is still running past its due time. */
export function isClockOverdue(c: Pick<Clock, 'status' | 'dueAt'>, nowMs: number): boolean {
  if (c.status === 'breached') return true;
  return c.status === 'running' && Date.parse(c.dueAt) < nowMs;
}

/** The overdue clock with the earliest due time, with how many others are overdue. */
export function oldestOverdue(clocks: readonly Clock[], now: ISODateTime): OverdueClockSummary | undefined {
  const nowMs = Date.parse(now);
  const overdue = clocks.filter((c) => isClockOverdue(c, nowMs)).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const first = overdue[0];
  if (!first) return undefined;
  return {
    id: first.id,
    kind: first.kind,
    label: first.label,
    basis: first.basis,
    status: first.status,
    dueAt: first.dueAt,
    daysOverdue: Math.max(0, Math.floor((nowMs - Date.parse(first.dueAt)) / MS_DAY)),
    moreOverdue: overdue.length - 1,
  };
}

export function listClaimsResponse(ctx: AppContext, items: Claim[], byStatus: Array<{ status: ClaimStatus; count: number }>): ClaimListResponse {
  const now = ctx.now();
  const partyIds = [...new Set(items.flatMap((c) => [c.claimantId, c.atFaultInsurerId]).filter((x): x is Id => Boolean(x)))];
  const parties = new Map(ctx.repos.getParties(ctx.db, partyIds).map((p) => [p.id, p]));
  const vehicleIds = [...new Set(items.map((c) => c.clientVehicleId).filter(Boolean))];
  const vehicles = new Map(vehicleIds.map((id) => [id, ctx.repos.getVehicle(ctx.db, id)]));
  const users = new Map(ctx.repos.listUsers(ctx.db).map((u) => [u.id, u.name]));
  return {
    items: items.map((c) => {
      const row: ClaimListItem = {
        ...c,
        claimantName: parties.get(c.claimantId)?.name,
        registration: vehicles.get(c.clientVehicleId)?.registration,
        openFlags: c.flags.filter((f) => !f.clearedAt).length,
        insurerName: c.atFaultInsurerId ? parties.get(c.atFaultInsurerId)?.name : undefined,
        handlerName: c.handlerId ? users.get(c.handlerId) : undefined,
        outstandingPence: ctx.repos.ledgerPosition(ctx.db, c.id).totals.outstandingPence,
      };
      const overdue = oldestOverdue(ctx.repos.listClocks(ctx.db, c.id), now);
      if (overdue) row.oldestOverdueClock = overdue;
      return row;
    }),
    total: items.length,
    byStatus,
  };
}

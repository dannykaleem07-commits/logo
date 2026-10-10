// owned by ap-booking
/**
 * Readiness, damage and turnaround (docs/SUPREME-AUTOPILOT.md §B.2). Pure.
 *
 * A car is ready when no open blocking readiness task and no unrepaired major/unroadworthy damage stands in the way.
 * Non-blocking open tasks (a valet) with a `readyByAt` make it "ready by" that time; a blocking task without an
 * estimate, or blocking damage without a repair task estimate, makes it "not ready".
 */
import type { Id, ISODateTime } from '../types.js';
import { isoToMs, msToUtcIso } from '../calendar/index.js';
import type { DamageSeverity, FleetDamage, ReadinessKind, ReadinessTask, UnitReadiness } from './types.js';

/** Kinds that block a hire by default (§B.2): MOT, tax and PHV licence; damage repair when the damage is major or unroadworthy. */
export function defaultBlocksHire(kind: ReadinessKind, severity?: DamageSeverity): boolean {
  if (kind === 'damage_repair') return severity === 'major' || severity === 'unroadworthy';
  return kind === 'mot' || kind === 'tax' || kind === 'phv_licence';
}

export function damageBlocksHire(d: Pick<FleetDamage, 'severity' | 'repairedAt'>): boolean {
  return !d.repairedAt && (d.severity === 'major' || d.severity === 'unroadworthy');
}

/**
 * Readiness of a unit at `at`:
 *  - not_ready: an open blocking task with no `readyByAt` (or one after `at`… see below), or blocking damage with no
 *    open repair task carrying an estimate;
 *  - ready_by: open tasks remain whose `readyByAt` is after `at` — the latest such time;
 *  - ready: nothing open, or every open task's estimate is at or before `at`.
 * An open task's `readyByAt` at or before `at` counts as done by then (an estimate, kept until someone ticks it).
 */
export function unitReadiness(tasks: readonly ReadinessTask[], damage: readonly FleetDamage[], at: ISODateTime): UnitReadiness {
  const atMs = isoToMs(at);
  const open = tasks.filter((t) => t.status === 'open');
  const blocking: Id[] = [];
  const later: Array<{ id: Id; ms: number }> = [];
  for (const t of open) {
    // A compliance task created ahead of its due date (fleet.compliance_watch, 30 days early) blocks only from then.
    if (t.blocksHire && !t.readyByAt && t.dueAt && isoToMs(t.dueAt) > atMs) continue;
    if (!t.readyByAt) {
      if (t.blocksHire) blocking.push(t.id);
      continue;
    }
    const ms = isoToMs(t.readyByAt);
    if (ms > atMs) later.push({ id: t.id, ms });
  }
  for (const d of damage) {
    if (!damageBlocksHire(d)) continue;
    const repair = open.find((t) => t.kind === 'damage_repair' && (t.damageId === d.id || (d.repairTaskId && t.id === d.repairTaskId)));
    if (!repair) blocking.push(d.id);
    // a repair task with an estimate is handled above; one without is already in `blocking`
  }
  if (blocking.length) return { state: 'not_ready', blocking };
  if (later.length) {
    const max = Math.max(...later.map((l) => l.ms));
    return { state: 'ready_by', at: msToUtcIso(max), tasks: later.map((l) => l.id) };
  }
  return { state: 'ready' };
}

/** When the unit is ready (ISO), or null when it is not ready with no estimate. `at` when ready now. */
export function readyByTime(r: UnitReadiness, at: ISODateTime): ISODateTime | null {
  if (r.state === 'ready') return at;
  if (r.state === 'ready_by') return r.at;
  return null;
}

export interface ReturnTaskPlan {
  kind: ReadinessKind;
  blocksHire: boolean;
  /** Absent for blocking damage repairs: a person sets the estimate. */
  readyByAt?: ISODateTime;
  damageIndex?: number;
  note: string;
}

/**
 * The readiness tasks created on every return (§B.2): valet + inspection ready at `collectedAt + turnaroundMinutes`,
 * plus one damage_repair per damage row (blocking when major/unroadworthy; no estimate for those — a person sets it).
 */
export function returnReadinessTasks(collectedAt: ISODateTime, turnaroundMinutes: number, damage: ReadonlyArray<{ severity: DamageSeverity; panel: string; description: string }>): ReturnTaskPlan[] {
  const readyBy = msToUtcIso(isoToMs(collectedAt) + Math.max(0, turnaroundMinutes) * 60_000);
  const out: ReturnTaskPlan[] = [
    { kind: 'valet', blocksHire: false, readyByAt: readyBy, note: 'Valet after return' },
    { kind: 'inspection', blocksHire: false, readyByAt: readyBy, note: 'Condition inspection after return' },
  ];
  damage.forEach((d, i) => {
    const blocks = defaultBlocksHire('damage_repair', d.severity);
    out.push({ kind: 'damage_repair', blocksHire: blocks, ...(blocks ? {} : { readyByAt: readyBy }), damageIndex: i, note: `Repair ${d.panel}: ${d.description}`.slice(0, 500) });
  });
  return out;
}

export const READINESS_KIND_TEXT: Readonly<Record<ReadinessKind, string>> = {
  valet: 'Valet',
  inspection: 'Inspection',
  service: 'Service',
  damage_repair: 'Damage repair',
  mot: 'MOT',
  tax: 'Vehicle tax',
  tyres: 'Tyres',
  keys: 'Keys',
  phv_licence: 'PHV licence',
  other: 'Other',
};

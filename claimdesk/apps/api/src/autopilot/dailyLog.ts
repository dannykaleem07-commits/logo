// owned by ap-autopilot
/**
 * Daily-log sections for the Autopilot (docs/SUPREME-AUTOPILOT.md §I.9): `autopilot` (steps done automatically, holds,
 * offers, bookings, packs, status changes), `fleet` (movements, returns, readiness, lapses ahead) and `clashes` (new /
 * overridden / resolved findings) — built from autopilot_log, fleet_reservation_events, clash_findings and audit rows.
 * Stub created by ap-foundation and already called by agent/dailyLog.ts: returns no sections until ap-autopilot fills it.
 */
import type { AppContext } from '../context.js';
import type { DailyLog } from '../agent/dailyLog.js';

export function autopilotDailyLogSections(_ctx: AppContext, _day: string, _bounds: { start: string; end: string }): Pick<DailyLog['sections'], 'autopilot' | 'fleet' | 'clashes'> {
  return {};
}

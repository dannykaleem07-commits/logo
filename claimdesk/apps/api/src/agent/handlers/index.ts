/**
 * Job handler and Needs-you resolver registry (docs/SUPREME-DESIGN.md §C.2, §C.7, §P.2) — owned by `foundation`.
 * Each slice fills its own arrays in its own file; this module only concatenates them.
 */
import type { JobType, NeedsYouKind } from '@ccguk/domain';
import type { JobHandler, NeedsYouResolver } from '../contracts.js';
import { systemJobHandlers, systemNeedsYouResolvers } from './system.js';
import { mailJobHandlers, mailNeedsYouResolvers } from './mail.js';
import { intakeJobHandlers, intakeNeedsYouResolvers } from './intake.js';
import { caseworkJobHandlers, caseworkNeedsYouResolvers } from './casework.js';
// Autopilot (docs/SUPREME-AUTOPILOT.md §K): stubs by ap-foundation, filled by each owning slice.
import { autopilotJobHandlers, autopilotNeedsYouResolvers } from './autopilot.js';
import { bookingJobHandlers, bookingNeedsYouResolvers } from './booking.js';
import { clashJobHandlers, clashNeedsYouResolvers } from './clash.js';
import { signingJobHandlers, signingNeedsYouResolvers } from './signing.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
type AnyHandler = JobHandler<any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
type AnyResolver = NeedsYouResolver<any>;

export function allJobHandlers(): AnyHandler[] {
  return [
    ...systemJobHandlers,
    ...mailJobHandlers,
    ...intakeJobHandlers,
    ...caseworkJobHandlers,
    ...autopilotJobHandlers,
    ...bookingJobHandlers,
    ...clashJobHandlers,
    ...signingJobHandlers,
  ];
}

export function allNeedsYouResolvers(): AnyResolver[] {
  return [
    ...systemNeedsYouResolvers,
    ...mailNeedsYouResolvers,
    ...intakeNeedsYouResolvers,
    ...caseworkNeedsYouResolvers,
    ...autopilotNeedsYouResolvers,
    ...bookingNeedsYouResolvers,
    ...clashNeedsYouResolvers,
    ...signingNeedsYouResolvers,
  ];
}

export function getJobHandler(type: JobType): AnyHandler | undefined {
  return allJobHandlers().find((h) => h.type === type);
}

export function getNeedsYouResolver(kind: NeedsYouKind): AnyResolver | undefined {
  return allNeedsYouResolvers().find((r) => r.kind === kind);
}

/** Registry problems (duplicate job types or resolver kinds) — the runtime asserts this is empty at boot; tests too. */
export function registryProblems(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of allJobHandlers()) {
    if (seen.has(h.type)) out.push(`duplicate job handler ${h.type}`);
    seen.add(h.type);
  }
  const kinds = new Set<string>();
  for (const r of allNeedsYouResolvers()) {
    if (kinds.has(r.kind)) out.push(`duplicate Needs-you resolver ${r.kind}`);
    kinds.add(r.kind);
  }
  return out;
}

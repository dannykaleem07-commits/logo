/**
 * Typed access to the @ccguk/domain engines the API wires. Several domain modules are still being built by the
 * domain agents (clocks, acceptance, playbook, intake, fleet, …): their `index.ts` currently exports nothing. This
 * shim resolves each engine by name at runtime so the API typechecks today and picks the real engine up the moment
 * it lands, falling back to the conservative implementations in `services/fallbacks.ts` until then.
 *
 * Signatures follow docs/ARCHITECTURE.md ("Key exports (names are the contract)").
 */
import * as domain from '@ccguk/domain';
import type {
  AccidentDetails,
  CaseAcceptance,
  Claim,
  ClaimBundle,
  ClaimEvent,
  Clock,
  FleetUnit,
  FleetUse,
  InsurancePolicy,
  ISODateTime,
  PlaybookAction,
} from '@ccguk/domain';

const registry = domain as unknown as Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => unknown;

function optional<T extends AnyFn>(name: string): T | undefined {
  const fn = registry[name];
  return typeof fn === 'function' ? (fn as T) : undefined;
}

export interface FnolValidation {
  ok: boolean;
  missing: string[];
  warnings?: string[];
}

export interface LiabilityScore {
  score: number;
  reasons: string[];
}

export interface InjuryRouting {
  refer: boolean;
  referredTo: string;
  message: string;
  feeTaken: false;
}

export interface AllocationCheck {
  ok: boolean;
  reasons: string[];
}

export type DeriveClocksFn = ((claim: Claim, events: ClaimEvent[], now: ISODateTime) => Clock[]) | ((bundle: ClaimBundle, now: ISODateTime) => Clock[]);

export interface DomainEngines {
  deriveClocks?: DeriveClocksFn;
  nextActions?: (bundle: ClaimBundle, now: ISODateTime, rules?: unknown) => PlaybookAction[];
  assessAcceptance?: (bundle: ClaimBundle, now?: ISODateTime) => CaseAcceptance;
  scoreLiability?: (accident: AccidentDetails, context?: unknown) => LiabilityScore | number;
  validateFnol?: (fnol: unknown) => FnolValidation;
  routeInjury?: (accident: AccidentDetails, opts?: unknown) => InjuryRouting | undefined;
  canAllocate?: (unit: FleetUnit, use: FleetUse, policies: InsurancePolicy[]) => AllocationCheck | boolean;
}

/** Resolve engines fresh each call so a hot-reloaded domain module is picked up. */
export function resolveEngines(): DomainEngines {
  return {
    deriveClocks: optional<DeriveClocksFn>('deriveClocks'),
    nextActions: optional<NonNullable<DomainEngines['nextActions']>>('nextActions'),
    assessAcceptance: optional<NonNullable<DomainEngines['assessAcceptance']>>('assessAcceptance'),
    scoreLiability: optional<NonNullable<DomainEngines['scoreLiability']>>('scoreLiability'),
    validateFnol: optional<NonNullable<DomainEngines['validateFnol']>>('validateFnol'),
    routeInjury: optional<NonNullable<DomainEngines['routeInjury']>>('routeInjury'),
    canAllocate: optional<NonNullable<DomainEngines['canAllocate']>>('canAllocate'),
  };
}

/** Call `deriveClocks` with either contract shape (3-arg claim/events/now per ARCHITECTURE, or bundle/now). */
export function callDeriveClocks(fn: DeriveClocksFn, bundle: ClaimBundle, now: ISODateTime): Clock[] {
  if (fn.length >= 3) return (fn as (c: Claim, e: ClaimEvent[], n: ISODateTime) => Clock[])(bundle.claim, bundle.events, now);
  return (fn as (b: ClaimBundle, n: ISODateTime) => Clock[])(bundle, now);
}

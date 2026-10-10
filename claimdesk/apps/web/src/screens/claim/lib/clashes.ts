// owned by ap-clash
/** Pure helpers for showing clash findings (docs/SUPREME-AUTOPILOT.md §C.5). */
import { CLASH_CATALOGUE, isClashCode, type ClashFinding, type ClashSeverity } from '@ccguk/domain';
import type { Tone } from '../../../lib/status';

export type ShownFinding = ClashFinding & { id?: string; status?: 'open' | 'acknowledged' | 'overridden' | 'resolved'; relatedClaims?: Array<{ id: string; reference: string }> };

export const SEVERITY_ORDER: Record<ClashSeverity, number> = { block: 0, warn: 1, info: 2 };
export const SEVERITY_TONE: Record<ClashSeverity, Tone> = { block: 'red', warn: 'amber', info: 'grey' };
export const SEVERITY_LABEL: Record<ClashSeverity, string> = { block: 'Blocks the booking', warn: 'Warning', info: 'For information' };

export function clashLabel(code: string): string {
  return isClashCode(code) ? CLASH_CATALOGUE[code].label : code.replace(/_/g, ' ').toLowerCase();
}

export function clashBasis(code: string): string | undefined {
  return isClashCode(code) ? CLASH_CATALOGUE[code].basis : undefined;
}

/** A block a manager may override (class A, or B relaxed in manager mode); class C never. */
export function isOverridable(f: Pick<ClashFinding, 'severity' | 'overrideClass'>): boolean {
  return f.severity === 'block' && (f.overrideClass === 'A' || f.overrideClass === 'B');
}

/** A warn that stops the autopilot acting alone until a person reads it. */
export function isGreenBlocking(f: Pick<ClashFinding, 'code' | 'severity'>): boolean {
  return f.severity === 'warn' && isClashCode(f.code) && CLASH_CATALOGUE[f.code].greenBlocking;
}

/** Live findings first (open, then acknowledged / overridden), most severe first; resolved last. */
export function sortFindings<T extends ShownFinding>(rows: readonly T[]): T[] {
  const live = (f: ShownFinding) => (f.status === 'resolved' ? 2 : f.status === 'acknowledged' || f.status === 'overridden' ? 1 : 0);
  return [...rows].sort((a, b) => live(a) - live(b) || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
}

export function countBySeverity(rows: readonly ShownFinding[]): Record<ClashSeverity, number> {
  const out: Record<ClashSeverity, number> = { block: 0, warn: 0, info: 0 };
  for (const f of rows) if (f.status !== 'resolved' && f.status !== 'overridden' && f.status !== 'acknowledged') out[f.severity] += 1;
  return out;
}

/** The override needs a reason of at least this length (the API keeps up to 500 characters). */
export const MIN_REASON = 3;

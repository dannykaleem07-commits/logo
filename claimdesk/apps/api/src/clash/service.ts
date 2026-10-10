// owned by ap-clash
/**
 * Clash service (docs/SUPREME-AUTOPILOT.md §C.3, §C.4): assembles the ClashWorld for a subject, runs the pure
 * `detectClashes`, and persists findings (upsert by dedupe key; resolved when no longer seen). Block findings are enforced
 * in the routes through the manager-mode gate. Stub created by ap-foundation: no findings, nothing persisted.
 */
import type { ClashFinding, ClashSubject } from '@ccguk/domain';
import type { Db } from '@ccguk/db';
import type { AppContext } from '../context.js';

export function checkClashes(_ctx: AppContext, _subject: ClashSubject): { findings: ClashFinding[]; blocks: ClashFinding[] } {
  return { findings: [], blocks: [] };
}

export function persistFindings(_ctx: AppContext, _tx: Db, _subject: ClashSubject, _findings: ClashFinding[]): void {
  // filled by ap-clash
}

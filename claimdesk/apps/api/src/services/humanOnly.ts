/**
 * Human-only steps (docs/SUPREME-DESIGN.md §1.2, §B.2 rule 5, §D.5). An automated actor — the system or any agent
 * principal (`agent:<name>`) — may never approve a document (except the allow-listed path in approveDocument), sign,
 * approve an estimate or PAV, issue an engineer report, verify a directory entry or record an offer decision.
 */
import type { Actor } from '@ccguk/db';
import { conflict } from '../errors.js';

export function isAutomatedActor(a: Pick<Actor, 'userId'> | undefined): boolean {
  const id = a?.userId;
  return id === 'system' || (typeof id === 'string' && id.startsWith('agent:'));
}

/** 409 HUMAN_REQUIRED unless a person is acting. `what` names the step for the message. */
export function assertHuman(actor: Pick<Actor, 'userId'> | undefined, what: string): void {
  if (isAutomatedActor(actor)) throw conflict('HUMAN_REQUIRED', `A person must ${what} — agents and the system cannot`, { actor: actor?.userId ?? null, step: what });
}

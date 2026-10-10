// owned by ap-autopilot
/**
 * Commitment verification (docs/SUPREME-AUTOPILOT.md §D.3): called at the end of the mail slice's `describeOutbox`, it
 * sets `descriptor.step` (from `outbox.autopilot_step_id`, else STEP_FOR_SEND and the claim's plan) and, for kinds
 * `hire_offer` / `booking_update`, `descriptor.commitment = { kind, refId, verified, reasons }` verified by code.
 * Stub created by ap-foundation: returns the descriptor unchanged (so every commitment still asks under rule 13).
 */
import type { ActionDescriptor } from '@ccguk/domain';
import type { OutboxRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';

export function applyAutopilotCommitment(_ctx: AppContext, _outbox: OutboxRecord, descriptor: ActionDescriptor): ActionDescriptor {
  return descriptor;
}

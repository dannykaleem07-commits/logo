// owned by claimai-server
/**
 * Boot wiring (docs/CLAIM-AI-INPUT.md §7.3, §8.2): the intake engine's catch-up hook and the gateway's standing
 * instructions block are late-bound so neither module imports claimai.
 */
import type { AppContext } from '../context.js';
import { registerClaimInstructionsProvider } from '../ai/prompts.js';
import { registerCatchUpHook } from '../intake/bundles/recompute.js';
import { catchUpAfterReconcile } from './catchUp.js';
import { claimInstructionsBlock } from './promptBlock.js';

export function installClaimAi(ctx: AppContext): void {
  registerCatchUpHook(catchUpAfterReconcile);
  registerClaimInstructionsProvider(ctx, claimInstructionsBlock);
}

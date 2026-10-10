// owned by ap-paperwork
/**
 * Optional LAN signing listener (docs/SUPREME-AUTOPILOT.md §E.3; SIGNING_LAN=1, off by default): a second Fastify
 * listener serving only the kiosk page and /api/kiosk/*. Called from server.ts. Stub created by ap-foundation: no-op.
 */
import type { AppContext } from '../context.js';

export async function startSigningLanServer(_ctx: AppContext): Promise<void> {
  // filled by ap-paperwork
}

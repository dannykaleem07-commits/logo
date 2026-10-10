// owned by ap-autopilot
/**
 * When the Autopilot starts (docs/SUPREME-AUTOPILOT.md §A.8, §K "enabled after upgrade"). The first time it runs it
 * writes one `autopilot.installed` audit row and pauses every claim that already exists — those files were run by
 * hand until now, so the owner resumes each from its Autopilot tab. Claims created afterwards start in the
 * Settings > Autopilot "new claims" mode (default on). No timestamps are compared, so the wall clock of a claim's
 * creation never matters.
 */
import { mergeAutopilotSettings, type ClaimAutopilotRecord } from '@ccguk/domain';
import type { AppContext } from '../context.js';

export const LEGACY_PAUSE_REASON = 'This claim was open before the Autopilot started. Resume it here when you want the Autopilot to take it over.';

/** Is the Autopilot installed (the audit marker exists)? */
export function autopilotInstalled(ctx: AppContext): boolean {
  return ctx.repos.listAudit(ctx.db, { action: 'autopilot.installed' }).length > 0;
}

/** Install once: pause every existing claim without an Autopilot row, then write the marker. Idempotent. */
export function ensureAutopilotInstalled(ctx: AppContext): void {
  if (autopilotInstalled(ctx)) return;
  const now = ctx.now();
  ctx.db.transaction((tx) => {
    const rows = ctx.handle.sqlite.prepare('SELECT c.id FROM claims c LEFT JOIN claim_autopilot a ON a.claim_id = c.id WHERE a.claim_id IS NULL').all() as Array<{ id: string }>;
    for (const r of rows) {
      ctx.repos.ensureClaimAutopilot(tx, r.id, 'paused', now);
      ctx.repos.setClaimAutopilotMode(tx, r.id, 'paused', { userId: 'system', reason: LEGACY_PAUSE_REASON }, now);
    }
    ctx.repos.appendAudit(tx, { actor: { userId: 'system' }, action: 'autopilot.installed', entity: 'claim_autopilot', entityId: 'install', after: { pausedExistingClaims: rows.length }, at: now });
  });
}

/** The claim's Autopilot row (created on first sight: new claims in the Settings mode, legacy ones paused). */
export function claimAutopilotFor(ctx: AppContext, claimId: string): ClaimAutopilotRecord {
  const existing = ctx.repos.getClaimAutopilot(ctx.db, claimId);
  if (existing) return existing;
  ensureAutopilotInstalled(ctx);
  const after = ctx.repos.getClaimAutopilot(ctx.db, claimId);
  if (after) return after;
  const settings = mergeAutopilotSettings(ctx.repos.getAgentSettings(ctx.db).autopilot);
  return ctx.repos.ensureClaimAutopilot(ctx.db, claimId, settings.newClaims, ctx.now());
}

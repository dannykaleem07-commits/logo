// owned by intake-server
/**
 * Damage observations (docs/SMART-INTAKE.md §6.7 step 8, improvement 7): the zones the AI saw in filed damage photos
 * (`ai_photo`) and the zones the repair estimate's lines name (`estimate_text`), recorded append-only on the claim
 * (idempotent unique index), and the aggregation `GET /claims/:id/damage-zones` the damage model reads.
 */
import { damageMapFromObservations, getZone, zonesFromEstimateText } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import type { BundleState } from './recompute.js';

export function recordDamageObservations(ctx: AppContext, state: BundleState, claimId: string, filed: Record<string, string>, actor: Actor, opts: { fileIds?: Set<string> } = {}): number {
  const now = ctx.now();
  let created = 0;
  for (const fc of state.main) {
    if (opts.fileIds && !opts.fileIds.has(fc.file.id)) continue;
    const evidenceId = filed[fc.file.id] ?? null;
    if (fc.isPhoto) {
      for (const z of fc.photo?.damageZones ?? []) {
        if (!getZone(z.zoneId)) continue;
        const severity = Math.min(3, Math.max(1, Math.round(z.severity)));
        const confidence = Math.max(0, Math.min(1, Number(z.confidence) || 0));
        const r = ctx.repos.insertDamageObservation(ctx.db, { claimId, evidenceId, zoneId: z.zoneId, severity, confidence, source: 'ai_photo', bundleId: state.bundle.id, createdBy: actor.userId, now });
        if (r.created) created += 1;
      }
    } else if (fc.docType === 'bodyshop_estimate' || fc.docType === 'audatex_estimate') {
      for (const z of zonesFromEstimateText(fc.text.split(/\r?\n/))) {
        const r = ctx.repos.insertDamageObservation(ctx.db, { claimId, evidenceId, zoneId: z.zoneId, severity: z.severity, confidence: 0.6, source: 'estimate_text', bundleId: state.bundle.id, createdBy: actor.userId, now });
        if (r.created) created += 1;
      }
    }
  }
  if (created) ctx.repos.appendAudit(ctx.db, { actor, action: 'intake.damage_observation', entity: 'claims', entityId: claimId, after: { claimId, bundleId: state.bundle.id, count: created }, at: now });
  return created;
}

export function damageZonesView(ctx: AppContext, claimId: string) {
  const obs = ctx.repos.listDamageObservations(ctx.db, claimId);
  return {
    zones: damageMapFromObservations(obs.map((o) => ({ zoneId: o.zoneId, severity: o.severity, confidence: o.confidence, source: o.source, createdAt: o.createdAt, evidenceId: o.evidenceId ?? null }))),
    observations: obs.map((o) => ({ id: o.id, zoneId: o.zoneId, severity: o.severity, confidence: o.confidence, source: o.source, evidenceId: o.evidenceId ?? null, createdAt: o.createdAt })),
  };
}

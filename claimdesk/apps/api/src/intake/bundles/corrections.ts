// owned by intake-server
/**
 * Owner corrections for the Knowledge Builder (docs/SMART-INTAKE.md §6.12). At register/attach, every key where the
 * owner's final value (a value they set, or a conflict choice different from the preselected one) differs from the top
 * reading becomes a correction through the casework callback (`recordCorrection`), which masks personal data into a
 * proposed memory item; the corrections learner turns it into an `intake_field` correction row (clustered by document
 * type, so repeated misreadings — e.g. VINs on V5Cs — queue a curation).
 */
import { compatible, type BundleFieldKey } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { runtimeServices } from '../../agent/needsYou.js';
import { topReading, type BundleState } from './recompute.js';

export function recordBundleCorrections(ctx: AppContext, state: BundleState, claimId: string, actor: Actor): number {
  const record = runtimeServices(ctx).recordCorrection;
  if (!record) return 0;
  const needsYouId = state.bundle.needsYouId ?? `intake-bundle:${state.bundle.id}`;
  let n = 0;
  for (const f of state.computed.draft.fields) {
    const key = f.key as BundleFieldKey;
    let before: { value: string; docType: string | null; engine: string | null } | null = null;
    let final: string | null = null;
    const conflict = state.computed.conflicts.find((c) => c.key === key);
    if (f.status === 'owner_set' && f.value) {
      const top = topReading(state, key);
      if (top && !compatible(key, top, { value: f.value }).same) {
        before = { value: top.value, docType: top.source.docType, engine: top.source.engine };
        final = f.value;
      }
    } else if (conflict?.status === 'resolved' && conflict.chosenValue) {
      const pre = conflict.options.find((o) => o.preselected);
      if (pre && !compatible(key, { value: pre.value }, { value: conflict.chosenValue }).same) {
        before = { value: pre.value, docType: pre.sources[0]?.docType ?? null, engine: pre.sources[0]?.engine ?? null };
        final = conflict.chosenValue;
      }
    }
    if (!before || final === null) continue;
    try {
      record(ctx, { needsYouId, kind: 'new_claim', claimId, optionId: 'register', before: { intakeField: { key, ...before } }, after: { intakeField: { key, value: final } }, actor });
      n += 1;
    } catch (err) {
      ctx.logger.warn('intake: a correction could not be recorded', { bundleId: state.bundle.id, key, error: String(err) });
    }
  }
  return n;
}

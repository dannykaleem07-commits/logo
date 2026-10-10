// owned by knowledge-use
/**
 * knowledge-use's late-bound hooks (docs/SUPREME-KNOWLEDGE-BUILDER.md §8.1, §10.4), registered at boot by
 * routes/knowledgeUse.ts (and again once the app is ready, after every slice registered) and defensively by the
 * knowledge-use job handlers:
 *
 *   knowledgeContext   the "# Knowledge" block after the Case Brief (never the cached prefix)
 *   onRunAssembled     knowledge_usage rows for the refs a run was given
 *   onReviewResolved   the owner answered an `alarm` card (rollback → resolved, acknowledge → acknowledged); every
 *                      other variant goes to whatever was registered before (research handles `gap`)
 *
 * It also installs the KB verification overlay on `ctx.kb.entries` and on the ranked KB search (§4.5).
 * Registration is idempotent; a wrapper re-wraps only when a later registration replaced it.
 */
import type { AppContext } from '../../context.js';
import { knowledgeHooks, registerKnowledgeHooks, type KnowledgeHooks } from '../hooks.js';
import { setKbSearchOverlay } from '../../services/kb.js';
import { acknowledgeAlarm } from '../evals/drift.js';
import { knowledgeContextFor, recordRunUsage } from './context.js';
import { applyKbOverlay, installKbOverlay } from './kbOverlay.js';

const MINE = Symbol.for('claimdesk.knowledge.useHook');
const mark = <F extends object>(f: F): F => Object.assign(f, { [MINE]: true });
const isMine = (f: unknown): boolean => Boolean(f && (f as Record<symbol, unknown>)[MINE]);

export function registerUseHooks(ctx: AppContext): void {
  installKbOverlay(ctx);
  setKbSearchOverlay((entries) => applyKbOverlay(ctx, entries));
  const current = knowledgeHooks(ctx);
  const hooks: Partial<KnowledgeHooks> = {};
  if (!isMine(current.knowledgeContext)) hooks.knowledgeContext = mark<NonNullable<KnowledgeHooks['knowledgeContext']>>((c, spec, input) => knowledgeContextFor(c, spec, input));
  if (!isMine(current.onRunAssembled)) hooks.onRunAssembled = mark<NonNullable<KnowledgeHooks['onRunAssembled']>>((c, runId, refs) => recordRunUsage(c, runId, refs));
  if (!isMine(current.onReviewResolved)) {
    const prev = current.onReviewResolved;
    hooks.onReviewResolved = mark<NonNullable<KnowledgeHooks['onReviewResolved']>>(async (c, payload, choice, actor, extra) => {
      if (payload.variant === 'alarm') {
        const alarm = c.repos.getKnowledgeAlarm(c.db, payload.alarmId);
        if (alarm && alarm.status !== 'resolved') acknowledgeAlarm(c, payload.alarmId, actor, extra.note ?? null, { rolledBackTo: choice === 'rollback' ? payload.suggestedRollbackTo : null, needsYouId: extra.needsYouId });
        return;
      }
      if (prev) return prev(c, payload, choice, actor, extra);
    });
  }
  if (Object.keys(hooks).length) registerKnowledgeHooks(ctx, hooks);
}

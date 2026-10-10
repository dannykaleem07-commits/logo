// owned by knowledge-research
/**
 * knowledge-research's late-bound hooks (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.4), registered at boot by
 * routes/knowledgeResearch.ts (again once the app is ready, after every slice registered) and defensively by the
 * research job handlers:
 *   webPolicyFor      the WebFetch policy for `knowledge.research_web` only (runAgent refuses it otherwise, KR-8)
 *   onItemStatus      an answer item became active → its gap is answered; all answers rejected → back to the queue
 *   onReviewResolved  the owner answered or dismissed a gap card (variant `gap`)
 * onItemStatus and onReviewResolved are shared with knowledge-use: this module wraps whatever is registered (calling it
 * for everything research does not own) and re-wraps if a later registration replaced its wrapper, so registration
 * order between the slices never matters.
 */
import type { AppContext } from '../../context.js';
import { knowledgeHooks, registerKnowledgeHooks, type KnowledgeHooks } from '../hooks.js';
import { gapItemStatusChanged, resolveGapCard } from './gaps.js';
import { webPolicyForGap } from './researcher.js';

const MINE = Symbol.for('claimdesk.knowledge.researchHook');
const mark = <F extends object>(f: F): F => Object.assign(f, { [MINE]: true });
const isMine = (f: unknown): boolean => Boolean(f && (f as Record<symbol, unknown>)[MINE]);

export function registerResearchHooks(ctx: AppContext): void {
  const current = knowledgeHooks(ctx);
  const hooks: Partial<KnowledgeHooks> = {};
  if (!isMine(current.webPolicyFor)) {
    const prev = current.webPolicyFor;
    hooks.webPolicyFor = mark<NonNullable<KnowledgeHooks['webPolicyFor']>>((c, spec, job) => webPolicyForGap(c, job.type) ?? prev?.(c, spec, job));
  }
  if (!isMine(current.onItemStatus)) {
    const prev = current.onItemStatus;
    hooks.onItemStatus = mark<NonNullable<KnowledgeHooks['onItemStatus']>>((c, item, from) => {
      try {
        gapItemStatusChanged(c, item);
      } finally {
        prev?.(c, item, from);
      }
    });
  }
  if (!isMine(current.onReviewResolved)) {
    const prev = current.onReviewResolved;
    hooks.onReviewResolved = mark<NonNullable<KnowledgeHooks['onReviewResolved']>>(async (c, payload, choice, actor, extra) => {
      if (payload.variant === 'gap') return resolveGapCard(c, payload, choice, actor, extra);
      if (prev) return prev(c, payload, choice, actor, extra);
    });
  }
  if (Object.keys(hooks).length) registerKnowledgeHooks(ctx, hooks);
}

// owned by knowledge-use
/**
 * Golden-replay cases (docs/SUPREME-KNOWLEDGE-BUILDER.md §12.1). Built from concluded claims and their `claim_outcomes`
 * (rebuilt nightly by knowledge-learners): one `after_pack_sent` decision point per claim, with the facts over
 * RULE_FACT_IDS as of the moment the pack was sent, what was historically done afterwards (playbook action codes from
 * the templates sent, and the raw steps) and the outcome (working days to pay, % of the claimed amount paid), plus the
 * outcome quartile per insurer. Cases are frozen once written (append-only table; re-runs insert only new ones).
 *
 * `on_docs_request`, `on_offer` and `at_stage` decision points need moment-in-time facts that `claim_outcomes` does
 * not carry; they are left for when Phase 3 records them (no case is invented).
 */
import { CONCLUDED_OUTCOME_STATUSES, percentileNearestRank, type EvalCase } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import { GET_PAID_FASTER } from '../../services/kb.js';
import { tableExists, rows } from '../use/sql.js';

interface OutcomeRow {
  claimId: string;
  head: string;
  insurerSlug: string | null;
  claimTypes: string[] | unknown;
  gtaSubscriber: boolean | null;
  claimedPence: number;
  paidPence: number;
  reducedPence: number;
  packSentAt: string | null;
  fullyPaidAt: string | null;
  workingDaysToPay: number | null;
  docsRequested: string[] | unknown;
  steps: { step: string; at: string }[];
  status: string;
}

/** template id → playbook action code (KB playbook rules, else the built-in ladder). */
export function templateCodes(ctx: AppContext): Map<string, string> {
  const out = new Map<string, string>();
  const rules = (() => {
    try {
      return ctx.kb.playbookRules() as Array<{ code?: unknown; templateId?: unknown }>;
    } catch {
      return [];
    }
  })();
  for (const r of rules) if (typeof r.code === 'string' && typeof r.templateId === 'string') out.set(r.templateId, r.code);
  for (const s of GET_PAID_FASTER) if (s.templateId && !out.has(s.templateId)) out.set(s.templateId, s.code);
  return out;
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Build the cases a set of outcome rows supports (pure apart from the code map). */
export function casesFromOutcomes(outcomes: readonly OutcomeRow[], claims: ReadonlyMap<string, { liability: string | null; track: string | null; status: string }>, codes: ReadonlyMap<string, string>): Omit<EvalCase, 'id'>[] {
  const byClaim = new Map<string, OutcomeRow[]>();
  for (const o of outcomes) byClaim.set(o.claimId, [...(byClaim.get(o.claimId) ?? []), o]);
  const out: Omit<EvalCase, 'id'>[] = [];
  for (const [claimId, list] of [...byClaim.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const claim = claims.get(claimId);
    const concluded = list.every((o) => CONCLUDED_OUTCOME_STATUSES.includes(o.status)) || claim?.status === 'settled' || claim?.status === 'closed';
    const packSentAt = list.find((o) => o.packSentAt)?.packSentAt ?? null;
    if (!concluded || !packSentAt) continue;
    const steps = list[0]!.steps.filter((s) => s.at >= packSentAt);
    const actionCodes = [...new Set(steps.flatMap((s) => (s.step.startsWith('tpl:') && codes.get(s.step.slice(4)) ? [codes.get(s.step.slice(4))!] : [])))].sort();
    const claimed = list.reduce((s, o) => s + (o.claimedPence ?? 0), 0);
    const paid = list.reduce((s, o) => s + (o.paidPence ?? 0), 0);
    const days = list.map((o) => o.workingDaysToPay).filter((x): x is number => typeof x === 'number');
    out.push({
      claimId,
      decisionPoint: 'after_pack_sent',
      at: packSentAt,
      facts: {
        'insurer.slug': list[0]!.insurerSlug,
        'claim.types': arr(list[0]!.claimTypes),
        'claim.liability': claim?.liability ?? null,
        'claim.gtaSubscriber': list[0]!.gtaSubscriber,
        'claim.track': claim?.track ?? null,
        'stage.current': 'pack_sent',
        'days.sincePackSent': 0,
        'days.sinceLastInbound': null,
        'count.chasersSent': 0,
        'last.inboundIntent': null,
        'docs.onFile': [],
        'docs.requestedOpen': [...new Set(list.flatMap((o) => arr(o.docsRequested)))].sort(),
        'heads.open': list.map((o) => o.head).sort(),
        'money.outstandingPence': claimed,
      },
      historic: { actionCodes, steps: [...new Set(steps.map((s) => s.step))].sort() },
      outcome: { workingDaysToPay: days.length === list.length && days.length ? Math.max(...days) : null, paidOfClaimedPct: claimed > 0 ? Math.round((paid / claimed) * 1000) / 10 : null },
      insurerSlug: list[0]!.insurerSlug,
      outcomeQuartile: null,
    });
  }
  // outcome quartile per insurer (1 = fastest quarter)
  const byInsurer = new Map<string, number[]>();
  for (const c of out) if (c.outcome.workingDaysToPay !== null) byInsurer.set(c.insurerSlug ?? '', [...(byInsurer.get(c.insurerSlug ?? '') ?? []), c.outcome.workingDaysToPay]);
  for (const c of out) {
    const vals = byInsurer.get(c.insurerSlug ?? '');
    const d = c.outcome.workingDaysToPay;
    if (!vals || d === null || vals.length < 4) continue;
    const q1 = percentileNearestRank(vals, 25);
    const q2 = percentileNearestRank(vals, 50);
    const q3 = percentileNearestRank(vals, 75);
    c.outcomeQuartile = d <= q1 ? 1 : d <= q2 ? 2 : d <= q3 ? 3 : 4;
  }
  return out;
}

/** Insert the cases the current outcomes support (frozen: existing cases are never changed). */
export function refreshEvalCases(ctx: AppContext): { total: number; created: number } {
  if (!tableExists(ctx, 'claim_outcomes')) return { total: ctx.repos.countEvalCases(ctx.db), created: 0 };
  const outcomes = ctx.repos.listClaimOutcomes(ctx.db) as unknown as OutcomeRow[];
  const claimRows = rows<{ id: string; liability: string | null; track: string | null; status: string }>(ctx, `SELECT id, liability, track, status FROM claims`);
  const claims = new Map(claimRows.map((c) => [c.id, c] as const));
  const now = ctx.now();
  let created = 0;
  ctx.db.transaction((tx) => {
    for (const c of casesFromOutcomes(outcomes, claims, templateCodes(ctx))) if (ctx.repos.insertEvalCase(tx, c, now).created) created += 1;
  });
  return { total: ctx.repos.countEvalCases(ctx.db), created };
}

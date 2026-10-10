// owned by knowledge-use
/**
 * Golden replay (docs/SUPREME-KNOWLEDGE-BUILDER.md §12.1): correlational evidence from the business's own history, not
 * proof. Pure.
 *
 * For each frozen case (a decision point of a settled or closed claim, with the facts as of that moment), the rule set
 * is evaluated with `evalRule`. Where a rule fires and one of its effects would change or gate the historic decision,
 * the case is "affected" and its historic path is either *consistent* with the rule (the path already did what the
 * rule asks) or not. The outcomes of the two groups are compared:
 *
 *   worse         consistent paths are worse by more than `tolerancePct` (slower to pay by more than tolerancePct %,
 *                 or paid share lower by more than tolerancePct points), with n ≥ minCases
 *   inconclusive  fewer than minCases affected cases, or one group is empty
 *   no_worse      otherwise
 *
 * Hard checks must be 0: an effect outside the restrictive / advisory sets, or an effect touching an offer or another
 * always-ask step other than `ask_owner`. Any hard violation makes the verdict `worse` (the owner still decides).
 */
import type { EvalCase, OutcomeStats, RuleData, RuleEffect } from './types.js';
import { ADVISORY_EFFECTS, RESTRICTIVE_EFFECTS, evalRule } from './ruleLogic.js';
import { percentileNearestRank } from './stats.js';

export interface ReplayResult {
  verdict: 'no_worse' | 'worse' | 'inconclusive';
  casesAffected: number;
  consistent: OutcomeStats;
  inconsistent: OutcomeStats;
  hardViolations: string[];
  perRule: { itemId: string; affected: number; deltaDaysMedian: number | null; deltaPaidPct: number | null }[];
}

/** Action codes and steps that are offers or other always-ask steps (only `ask_owner` may name them). */
export const ALWAYS_ASK_STEP_RE = /(OFFER|PART_?36|SETTLE|ACCEPT|COUNTER|LBC|LETTER_BEFORE|LITIGAT|PROCEEDINGS|COMPLAINT|FRAUD|INJUR|DSAR|SOLICITOR|COURT|LEDGER)/i;

/** The hard violations of one rule (empty = none). */
export function ruleHardViolations(itemId: string, data: RuleData): string[] {
  const out: string[] = [];
  for (const e of data.then ?? []) {
    const kind = (e as { kind?: string }).kind ?? '?';
    if (!RESTRICTIVE_EFFECTS.has(kind as RuleEffect['kind']) && !ADVISORY_EFFECTS.has(kind as RuleEffect['kind'])) {
      out.push(`${itemId}: effect "${kind}" is outside the restrictive and advisory sets`);
      continue;
    }
    if (e.kind === 'ask_owner') continue;
    const named = e.kind === 'require_document' ? e.beforeStep : e.kind === 'prefer_step' ? e.actionCode : null;
    if (named && ALWAYS_ASK_STEP_RE.test(named)) out.push(`${itemId}: effect "${e.kind}" touches the always-ask step ${named} (only ask_owner may)`);
  }
  return out;
}

type Judged = 'consistent' | 'inconsistent' | null;

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Is the historic path consistent with one effect? null when the effect does not change or gate the path. */
export function judgeEffect(e: RuleEffect, c: EvalCase): Judged {
  const codes = c.historic.actionCodes;
  switch (e.kind) {
    case 'require_document': {
      if (!codes.includes(e.beforeStep)) return null; // the gated step was never taken: nothing to gate
      const onFile = asList(c.facts['docs.onFile']).map((d) => d.toLowerCase());
      return onFile.includes(e.doc.toLowerCase()) ? 'consistent' : 'inconsistent';
    }
    case 'prefer_step':
      return codes.includes(e.actionCode) ? 'consistent' : 'inconsistent';
    case 'suggest_followup':
      return c.historic.steps.some((s) => /chaser|follow/i.test(s)) || codes.some((x) => /CHASER/i.test(x)) ? 'consistent' : 'inconsistent';
    case 'ask_owner':
    case 'add_check':
    case 'avoid_phrase':
      return null; // wording / asking: does not change the historic path
  }
}

/** Is the case's path consistent with the whole rule? null when the rule does not fire or changes nothing. */
export function judgeRule(data: RuleData, c: EvalCase): Judged {
  if (!evalRule(data.when, c.facts)) return null;
  let any = false;
  for (const e of data.then ?? []) {
    const j = judgeEffect(e, c);
    if (j === null) continue;
    any = true;
    if (j === 'inconsistent') return 'inconsistent';
  }
  return any ? 'consistent' : null;
}

function median(values: number[]): number | null {
  return values.length ? percentileNearestRank(values, 50) : null;
}

/** Outcome statistics of a group of cases (medians, nearest rank). */
export function outcomeStats(cases: readonly EvalCase[]): OutcomeStats {
  const days = cases.map((c) => c.outcome.workingDaysToPay).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const paid = cases.map((c) => c.outcome.paidOfClaimedPct).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return { n: cases.length, medianWorkingDaysToPay: median(days), medianPaidOfClaimedPct: median(paid) };
}

const delta = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : Math.round((a - b) * 100) / 100);

/** Is `a` (consistent) worse than `b` (inconsistent) beyond the tolerance? */
export function isWorse(a: OutcomeStats, b: OutcomeStats, tolerancePct: number): boolean {
  const slower = a.medianWorkingDaysToPay !== null && b.medianWorkingDaysToPay !== null && a.medianWorkingDaysToPay > b.medianWorkingDaysToPay * (1 + tolerancePct / 100) && a.medianWorkingDaysToPay - b.medianWorkingDaysToPay >= 1;
  const paidLess = a.medianPaidOfClaimedPct !== null && b.medianPaidOfClaimedPct !== null && b.medianPaidOfClaimedPct - a.medianPaidOfClaimedPct > tolerancePct;
  return slower || paidLess;
}

export function replayRules(cases: EvalCase[], rules: { itemId: string; data: RuleData }[], opts: { tolerancePct: number; minCases: number }): ReplayResult {
  const sortedCases = [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortedRules = [...rules].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  const hardViolations = sortedRules.flatMap((r) => ruleHardViolations(r.itemId, r.data));
  const consistent: EvalCase[] = [];
  const inconsistent: EvalCase[] = [];
  const perRule: ReplayResult['perRule'] = [];
  const perRuleGroups = new Map<string, { c: EvalCase[]; i: EvalCase[] }>(sortedRules.map((r) => [r.itemId, { c: [], i: [] }]));
  for (const c of sortedCases) {
    let any = false;
    let ok = true;
    for (const r of sortedRules) {
      const j = judgeRule(r.data, c);
      if (j === null) continue;
      any = true;
      const g = perRuleGroups.get(r.itemId)!;
      if (j === 'consistent') g.c.push(c);
      else {
        g.i.push(c);
        ok = false;
      }
    }
    if (!any) continue;
    (ok ? consistent : inconsistent).push(c);
  }
  for (const r of sortedRules) {
    const g = perRuleGroups.get(r.itemId)!;
    const a = outcomeStats(g.c);
    const b = outcomeStats(g.i);
    perRule.push({ itemId: r.itemId, affected: g.c.length + g.i.length, deltaDaysMedian: delta(a.medianWorkingDaysToPay, b.medianWorkingDaysToPay), deltaPaidPct: delta(a.medianPaidOfClaimedPct, b.medianPaidOfClaimedPct) });
  }
  const cs = outcomeStats(consistent);
  const is = outcomeStats(inconsistent);
  const casesAffected = consistent.length + inconsistent.length;
  let verdict: ReplayResult['verdict'];
  if (hardViolations.length) verdict = 'worse';
  else if (casesAffected < opts.minCases || !consistent.length || !inconsistent.length) verdict = 'inconclusive';
  else verdict = isWorse(cs, is, opts.tolerancePct) ? 'worse' : 'no_worse';
  return { verdict, casesAffected, consistent: cs, inconsistent: is, hardViolations, perRule };
}

/** One plain sentence for the Needs-you card and the daily log (n always shown, §12.1 honesty). */
export function describeReplay(r: ReplayResult, opts: { minCases: number }): string {
  if (r.hardViolations.length) return `Replay: the rule breaks a hard check (${r.hardViolations.length}) — ${r.hardViolations[0]}.`;
  if (r.verdict === 'inconclusive') return `Replay: inconclusive — ${r.casesAffected} past case(s) affected, fewer than ${opts.minCases} or no comparison group. Not evidence either way.`;
  const days = r.consistent.medianWorkingDaysToPay !== null && r.inconsistent.medianWorkingDaysToPay !== null ? ` Median days to pay ${r.consistent.medianWorkingDaysToPay} (followed the rule, n=${r.consistent.n}) vs ${r.inconsistent.medianWorkingDaysToPay} (did not, n=${r.inconsistent.n}).` : '';
  return `Replay: ${r.verdict === 'worse' ? 'WORSE — past cases that followed this rule ended worse' : 'no worse than past cases that did not follow it'} (${r.casesAffected} cases).${days} Correlation from our own history, not proof.`;
}

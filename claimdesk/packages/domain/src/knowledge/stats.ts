// owned by knowledge-learners
/**
 * L1 outcome statistics (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.1): nearest-rank percentiles, minimum n (3 by default)
 * for every figure, insurer profiles and step effectiveness ("followed by", never "caused"). Pure: the learner reads
 * the ledger, events and mail into `ClaimOutcomeInput` rows (one per claim × head, the `claim_outcomes` table) and
 * these functions turn them into figures that always carry their n. Below the minimum n a figure is `null` and the UI
 * says "too few claims".
 *
 * Step markers in `steps` (built by the learner, sorted by time):
 *   outbound  `tpl:<templateId>`, `email:<emailKind>`, `action:<code>`, `event:<type>` (chaser_sent, letter_out …)
 *   inbound   `in:reply` (any insurer email or letter), `in:handling_ref`, `in:payment`, `in:offer`,
 *             `in:first_notification_dispute` (GTA 3.6)
 */
import { addWorkingDays } from '../calendar/calendar.js';
import type { Dist, InsurerProfileData, StatFactData } from './types.js';
import type { HeadOfLoss, ISODateTime } from '../types.js';
import type { MailIntent } from '../agents/types.js';

/** One `claim_outcomes` row (claim × head), as the learner rebuilds it nightly. */
export interface ClaimOutcomeInput {
  claimId: string;
  head: HeadOfLoss;
  insurerSlug: string | null;
  claimTypes: string[];
  gtaSubscriber: boolean | null;
  claimedPence: number;
  firstOfferPence: number | null;
  paidPence: number;
  reducedPence: number;
  packSentAt: ISODateTime | null;
  firstPaidAt: ISODateTime | null;
  fullyPaidAt: ISODateTime | null;
  workingDaysToPay: number | null;
  chasersBeforePay: number;
  objections: MailIntent[];
  docsRequested: string[];
  steps: { step: string; at: ISODateTime }[];
  status: string;
}

/** Row statuses the learner writes (`claim_outcomes.status`). */
export type ClaimOutcomeStatus = 'open' | 'part_paid' | 'paid' | 'written_off';
export const CONCLUDED_OUTCOME_STATUSES: readonly string[] = ['paid', 'written_off'];

/** Inbound outcome markers and the StatFactData outcome each one evidences. */
export const STEP_OUTCOME_MARKERS: Readonly<Record<StatFactData['outcome'], string>> = {
  insurer_reply: 'in:reply',
  handling_ref: 'in:handling_ref',
  payment: 'in:payment',
  offer: 'in:offer',
};

/** Mail intents counted as objections in an insurer profile. */
export const OBJECTION_INTENTS: readonly MailIntent[] = ['liability_denied', 'liability_split', 'reduction_or_part_payment', 'fraud_allegation', 'request_documents', 'request_information', 'complaint'];

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Nearest-rank percentile (p in 0..100) of a non-empty list. */
export function percentileNearestRank(values: readonly number[], p: number): number {
  if (!values.length) throw new Error('percentileNearestRank needs at least one value');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

/** median / p25 / p75 with n, or null when n < minN. */
export function distOf(values: readonly number[], minN: number): Dist | null {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (v.length === 0 || v.length < minN) return null;
  return { median: percentileNearestRank(v, 50), p25: percentileNearestRank(v, 25), p75: percentileNearestRank(v, 75), n: v.length };
}

const medianOrNull = (values: readonly number[], minN: number): number | null => {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length && v.length >= minN ? percentileNearestRank(v, 50) : null;
};

/** The date that places a row in the 12-month window (latest of payment, pack sent or last step). */
export function outcomeReferenceAt(r: Pick<ClaimOutcomeInput, 'fullyPaidAt' | 'firstPaidAt' | 'packSentAt' | 'steps'>): ISODateTime | null {
  const last = r.steps.length ? r.steps.map((s) => s.at).sort().at(-1)! : null;
  return [r.fullyPaidAt, r.firstPaidAt, r.packSentAt, last].filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
}

/** Rows of the window: `all` keeps everything; `12m` keeps rows whose reference date is within 365 days of `computedAt`. */
export function rowsInWindow<T extends Pick<ClaimOutcomeInput, 'fullyPaidAt' | 'firstPaidAt' | 'packSentAt' | 'steps'>>(rows: readonly T[], window: '12m' | 'all', computedAt: ISODateTime): T[] {
  if (window === 'all') return [...rows];
  const from = Date.parse(computedAt) - 365 * 86_400_000;
  return rows.filter((r) => {
    const at = outcomeReferenceAt(r);
    return at !== null && Date.parse(at) >= from && Date.parse(at) <= Date.parse(computedAt);
  });
}

const byClaim = (rows: readonly ClaimOutcomeInput[]): Map<string, ClaimOutcomeInput[]> => {
  const m = new Map<string, ClaimOutcomeInput[]>();
  for (const r of rows) m.set(r.claimId, [...(m.get(r.claimId) ?? []), r]);
  return m;
};

const claimSettled = (rows: readonly ClaimOutcomeInput[]): boolean => {
  const owed = rows.filter((r) => r.claimedPence > 0);
  return owed.length > 0 && owed.every((r) => CONCLUDED_OUTCOME_STATUSES.includes(r.status));
};

export function buildInsurerProfile(insurerSlug: string, rows: readonly ClaimOutcomeInput[], opts: { window: '12m' | 'all'; minN: number; computedAt: ISODateTime }): InsurerProfileData {
  const minN = Math.max(1, opts.minN);
  const mine = rowsInWindow(rows.filter((r) => r.insurerSlug === insurerSlug), opts.window, opts.computedAt);
  const claims = byClaim(mine);
  const claimIds = [...claims.keys()].sort();
  const firstOf = (id: string): ClaimOutcomeInput => claims.get(id)![0]!;
  const settled = claimIds.filter((id) => claimSettled(claims.get(id)!));

  // Days to pay: per claim, the slowest head's working days from pack sent to payment.
  const daysPerClaim = claimIds
    .map((id) => claims.get(id)!.map((r) => r.workingDaysToPay).filter((x): x is number => typeof x === 'number' && x >= 0))
    .filter((v) => v.length > 0)
    .map((v) => Math.max(...v));
  const enoughDays = daysPerClaim.length >= minN && daysPerClaim.length > 0;

  // Heads.
  const heads: InsurerProfileData['heads'] = {};
  const headNames = [...new Set(mine.map((r) => r.head))].sort();
  for (const head of headNames) {
    const hr = mine.filter((r) => r.head === head && r.claimedPence > 0);
    if (!hr.length) continue;
    const concluded = hr.filter((r) => CONCLUDED_OUTCOME_STATUSES.includes(r.status) || r.paidPence > 0);
    const paidPct = concluded.map((r) => round1((r.paidPence / r.claimedPence) * 100));
    const offerPct = hr.filter((r) => r.firstOfferPence !== null).map((r) => round1(((r.firstOfferPence as number) / r.claimedPence) * 100));
    heads[head] = {
      paidOfClaimedPct: distOf(paidPct, minN),
      firstOfferOfClaimedPct: distOf(offerPct, minN),
      reductionRatePct: concluded.length >= minN ? round1((concluded.filter((r) => r.reducedPence > 0).length / concluded.length) * 100) : null,
      n: hr.length,
    };
  }

  // Objections and documents asked for (claims count; only with enough claims).
  const enoughClaims = claimIds.length >= minN;
  const objectionCounts = new Map<MailIntent, number>();
  const docCounts = new Map<string, number>();
  for (const id of claimIds) {
    const r = firstOf(id);
    for (const i of new Set(r.objections)) if (OBJECTION_INTENTS.includes(i)) objectionCounts.set(i, (objectionCounts.get(i) ?? 0) + 1);
    for (const d of new Set(r.docsRequested.map((x) => x.toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean))) docCounts.set(d, (docCounts.get(d) ?? 0) + 1);
  }
  const objections = enoughClaims
    ? [...objectionCounts.entries()].map(([intent, c]) => ({ intent, claims: c, pct: round1((c / claimIds.length) * 100) })).sort((a, b) => b.claims - a.claims || a.intent.localeCompare(b.intent))
    : [];
  const docsRequested = enoughClaims ? [...docCounts.entries()].map(([doc, c]) => ({ doc, claims: c })).sort((a, b) => b.claims - a.claims || a.doc.localeCompare(b.doc)).slice(0, 15) : [];

  // GTA (a benchmark only, KR-3).
  const gtaClaims = claimIds.filter((id) => firstOf(id).gtaSubscriber === true);
  const gtaHire = gtaClaims.map((id) => claims.get(id)!.find((r) => r.head === 'hire' && r.claimedPence > 0 && (CONCLUDED_OUTCOME_STATUSES.includes(r.status) || r.paidPence > 0))).filter((r): r is ClaimOutcomeInput => Boolean(r));
  const gta = {
    subscriberClaims: gtaClaims.length,
    hirePaidAtGtaRatePct: gtaHire.length >= minN ? round1((gtaHire.filter((r) => r.paidPence >= r.claimedPence * 0.99).length / gtaHire.length) * 100) : null,
    firstNotificationDisputePct: gtaClaims.length >= minN ? round1((gtaClaims.filter((id) => firstOf(id).steps.some((s) => s.step === 'in:first_notification_dispute')).length / gtaClaims.length) * 100) : null,
  };

  // Response hours: pack sent → the first insurer reply after it.
  const responses: number[] = [];
  for (const id of claimIds) {
    const r = firstOf(id);
    if (!r.packSentAt) continue;
    const reply = r.steps.filter((s) => s.step === 'in:reply' && s.at > r.packSentAt!).map((s) => s.at).sort()[0];
    if (reply) responses.push(Math.round(((Date.parse(reply) - Date.parse(r.packSentAt)) / 3_600_000) * 10) / 10);
  }
  const chasers = claimIds.filter((id) => claims.get(id)!.some((r) => r.firstPaidAt || r.fullyPaidAt)).map((id) => firstOf(id).chasersBeforePay);

  return {
    insurerSlug,
    window: opts.window,
    minN,
    computedAt: opts.computedAt,
    n: { claims: claimIds.length, settled: settled.length },
    daysToPay: { medianWorkingDays: enoughDays ? percentileNearestRank(daysPerClaim, 50) : null, p90WorkingDays: enoughDays ? percentileNearestRank(daysPerClaim, 90) : null, n: daysPerClaim.length },
    heads,
    objections,
    docsRequested,
    gta,
    responseHours: { median: medianOrNull(responses, minN), n: responses.length },
    chasersBeforePay: { median: medianOrNull(chasers, minN), n: chasers.length },
  };
}

/** The profile's figures without `computedAt` — a profile is superseded only when a figure changes (§6.1). */
export function profileFigures(p: InsurerProfileData): Omit<InsurerProfileData, 'computedAt'> {
  const { computedAt: _c, ...rest } = p;
  return rest;
}

const isOutbound = (step: string): boolean => !step.startsWith('in:');

/**
 * Step effectiveness: p(outcome within N working days) after each outbound step, per insurer when the insurer has at
 * least `minNPerInsurer` occurrences and globally otherwise (global needs n ≥ 3). One occurrence per claim (the first).
 * The baseline is the same rate after the OTHER outbound steps of the same insurer (or globally) — "followed by",
 * never "caused". Rows are expected to be in the window already; `window` only labels the result.
 */
export function stepEffectiveness(rows: readonly ClaimOutcomeInput[], opts: { withinWorkingDays: number; minNPerInsurer: number; window: '12m' | 'all' }): StatFactData[] {
  const k = Math.max(1, Math.round(opts.withinWorkingDays));
  const globalMin = Math.min(3, Math.max(1, opts.minNPerInsurer));
  const claims = byClaim(rows);
  // Per claim: first occurrence of every outbound step, plus the inbound markers.
  type Occ = { claimId: string; insurerSlug: string | null; step: string; at: string; inbound: { step: string; at: string }[] };
  const occs: Occ[] = [];
  for (const [claimId, list] of [...claims.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const r = list[0]!;
    const steps = [...r.steps].sort((a, b) => a.at.localeCompare(b.at) || a.step.localeCompare(b.step));
    const inbound = steps.filter((s) => !isOutbound(s.step));
    const seen = new Set<string>();
    for (const s of steps) {
      if (!isOutbound(s.step) || seen.has(s.step)) continue;
      seen.add(s.step);
      occs.push({ claimId, insurerSlug: r.insurerSlug, step: s.step, at: s.at, inbound });
    }
  }
  const hit = (o: Occ, outcome: StatFactData['outcome']): boolean => {
    const marker = STEP_OUTCOME_MARKERS[outcome];
    const until = addWorkingDays(o.at, k);
    return o.inbound.some((s) => s.step === marker && s.at > o.at && s.at <= until);
  };
  const outcomes = Object.keys(STEP_OUTCOME_MARKERS) as StatFactData['outcome'][];
  const out: StatFactData[] = [];
  const emit = (group: Occ[], others: Occ[], insurerSlug: string | null, step: string): void => {
    for (const outcome of outcomes) {
      const hits = group.filter((o) => hit(o, outcome)).length;
      const baseHits = others.filter((o) => hit(o, outcome)).length;
      out.push({ metric: 'step_effectiveness', step, outcome, withinWorkingDays: k, hits, n: group.length, baselinePct: others.length >= globalMin ? round1((baseHits / others.length) * 100) : null, insurerSlug, window: opts.window });
    }
  };
  const steps = [...new Set(occs.map((o) => o.step))].sort();
  const insurers = [...new Set(occs.map((o) => o.insurerSlug).filter((s): s is string => Boolean(s)))].sort();
  for (const step of steps) {
    const all = occs.filter((o) => o.step === step);
    for (const slug of insurers) {
      const group = all.filter((o) => o.insurerSlug === slug);
      if (group.length >= opts.minNPerInsurer) emit(group, occs.filter((o) => o.insurerSlug === slug && o.step !== step), slug, step);
    }
    if (all.length >= globalMin) emit(all, occs.filter((o) => o.step !== step), null, step);
  }
  return out;
}

/** "Followed by" wording for a step statistic (never "caused"). */
export function describeStepStat(s: StatFactData): string {
  const pct = s.n ? round1((s.hits / s.n) * 100) : 0;
  const base = s.baselinePct === null ? 'no baseline yet' : `baseline ${s.baselinePct}%`;
  const who = s.insurerSlug ? `with ${s.insurerSlug}` : 'across insurers';
  return `${s.step} was followed by ${s.outcome.replace(/_/g, ' ')} within ${s.withinWorkingDays} working days in ${s.hits} of ${s.n} claims ${who} (${pct}%; ${base}; ${s.window}). Correlation only.`;
}

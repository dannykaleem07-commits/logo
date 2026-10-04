/**
 * Analytics over the ledger and chronology: overview, debtor days by insurer, reductions by head, cycle times,
 * intervention statistics. Everything is derived — nothing is stored.
 */
import { addWorkingDays, type Claim, type ClaimStatus, type HeadOfLoss, type ISODateTime, type LedgerEntry, type Pence } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { acceptanceFor, actionsFor, gatesFor, loadBundle } from './claimView.js';
import { complianceAlerts } from './fleetFallbacks.js';
import { HEAD_LABELS } from './documentData.js';

const CLOSED: ReadonlySet<ClaimStatus> = new Set(['settled', 'closed', 'declined']);
const DAY = 86_400_000;
const days = (a: ISODateTime, b: ISODateTime): number => Math.round(((Date.parse(b) - Date.parse(a)) / DAY) * 10) / 10;

function stats(values: number[]): { median: number; p90: number; mean: number; n: number } {
  if (!values.length) return { median: 0, p90: 0, mean: 0, n: 0 };
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return { median: Math.round(median * 10) / 10, p90: Math.round(q(0.9) * 10) / 10, mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10, n: s.length };
}

function allClaims(ctx: AppContext): Claim[] {
  return ctx.repos.listClaims(ctx.db, { limit: 100_000 });
}

function insurerName(ctx: AppContext, claim: Claim): { id?: string; name: string } {
  const p = claim.atFaultInsurerId ? ctx.repos.getParty(ctx.db, claim.atFaultInsurerId) : undefined;
  return { id: p?.id, name: p?.name ?? 'Unknown insurer' };
}

// ---------------------------------------------------------------------------

export interface DebtorDays {
  asOf: ISODateTime;
  overallDays: number;
  outstandingPence: Pence;
  byInsurer: Array<{ insurerId?: string; insurerName: string; days: number; p90Days: number; payments: number; outstandingPence: Pence; claims: number; oldestUnpaidPackDays?: number }>;
  byHandler: Array<{ handlerId?: string; handlerName: string; days: number; outstandingPence: Pence; claims: number }>;
}

/** Days from payment_pack_sent to each payment_received (or paid ledger entry), averaged per insurer; outstanding by insurer. */
export function debtorDays(ctx: AppContext): DebtorDays {
  const now = ctx.now();
  const perInsurer = new Map<string, { insurerId?: string; insurerName: string; samples: number[]; outstanding: Pence; claims: Set<string>; oldestUnpaid?: number }>();
  const perHandler = new Map<string, { handlerId?: string; handlerName: string; samples: number[]; outstanding: Pence; claims: Set<string> }>();
  const all: number[] = [];
  let outstandingTotal = 0;
  for (const claim of allClaims(ctx)) {
    const events = ctx.repos.listEvents(ctx.db, claim.id);
    const pack = events.find((e) => e.type === 'payment_pack_sent');
    const position = ctx.repos.ledgerPosition(ctx.db, claim.id);
    const outstanding = Math.max(0, position.totals.outstandingPence);
    const ins = insurerName(ctx, claim);
    const bucket = perInsurer.get(ins.name) ?? { insurerId: ins.id, insurerName: ins.name, samples: [], outstanding: 0, claims: new Set<string>() };
    const handler = claim.handlerId ? ctx.repos.getUser(ctx.db, claim.handlerId) : undefined;
    const hb = perHandler.get(handler?.id ?? 'unassigned') ?? { handlerId: handler?.id, handlerName: handler?.name ?? 'Unassigned', samples: [], outstanding: 0, claims: new Set<string>() };
    if (pack) {
      const payments = events.filter((e) => e.type === 'payment_received' && e.at >= pack.at);
      const paidLedger = ctx.repos.listLedger(ctx.db, claim.id).filter((e) => e.kind === 'paid' || e.kind === 'interim_paid').filter((e) => `${e.date}T00:00:00.000Z` >= pack.at.slice(0, 10));
      const sampleDates = payments.length ? payments.map((p) => p.at) : paidLedger.map((p) => `${p.date}T12:00:00.000Z`);
      for (const d of sampleDates) {
        const n = days(pack.at, d);
        bucket.samples.push(n);
        hb.samples.push(n);
        all.push(n);
      }
      if (outstanding > 0 && !CLOSED.has(claim.status)) {
        const age = days(pack.at, now);
        bucket.oldestUnpaid = Math.max(bucket.oldestUnpaid ?? 0, age);
      }
    }
    if (!CLOSED.has(claim.status) || outstanding > 0) {
      bucket.outstanding += outstanding;
      hb.outstanding += outstanding;
      outstandingTotal += outstanding;
    }
    bucket.claims.add(claim.id);
    hb.claims.add(claim.id);
    perInsurer.set(ins.name, bucket);
    perHandler.set(handler?.id ?? 'unassigned', hb);
  }
  return {
    asOf: now,
    overallDays: stats(all).mean,
    outstandingPence: outstandingTotal,
    byInsurer: [...perInsurer.values()].map((b) => ({ insurerId: b.insurerId, insurerName: b.insurerName, days: stats(b.samples).mean, p90Days: stats(b.samples).p90, payments: b.samples.length, outstandingPence: b.outstanding, claims: b.claims.size, oldestUnpaidPackDays: b.oldestUnpaid })).sort((a, b) => b.outstandingPence - a.outstandingPence),
    byHandler: [...perHandler.values()].map((b) => ({ handlerId: b.handlerId, handlerName: b.handlerName, days: stats(b.samples).mean, outstandingPence: b.outstanding, claims: b.claims.size })),
  };
}

// ---------------------------------------------------------------------------

export interface Reductions {
  byHead: Array<{ head: HeadOfLoss; label: string; claimedPence: Pence; paidPence: Pence; reducedPence: Pence; outstandingPence: Pence; reductionPct: number; claims: number }>;
  byInsurer: Array<{ insurerName: string; claimedPence: Pence; paidPence: Pence; reducedPence: Pence; outstandingPence: Pence; reductionPct: number }>;
  totals: { claimedPence: Pence; paidPence: Pence; reducedPence: Pence; outstandingPence: Pence; reductionPct: number };
}

/**
 * Claimed (invoiced where an invoice exists, else our claimed position) vs paid, by head and by insurer.
 *
 * A *reduction* is what the insurer has actually taken off: explicit `reduced` ledger entries, plus a short payment
 * (claimed − paid) on a head the insurer has paid something against. A head nothing has been paid against is simply
 * *outstanding* — File 1's unpaid engineer's fee is a debtor-days problem, not an insurer reduction.
 */
export function reductions(ctx: AppContext): Reductions {
  type Acc = { claimed: Pence; paid: Pence; reduced: Pence; outstanding: Pence; claims: Set<string> };
  const empty = (): Acc => ({ claimed: 0, paid: 0, reduced: 0, outstanding: 0, claims: new Set<string>() });
  const heads = new Map<HeadOfLoss, Acc>();
  const insurers = new Map<string, Acc>();
  for (const claim of allClaims(ctx)) {
    const ledger = ctx.repos.listLedger(ctx.db, claim.id);
    const ins = insurerName(ctx, claim).name;
    const ib = insurers.get(ins) ?? empty();
    for (const head of new Set(ledger.map((e) => e.head))) {
      const rows = ledger.filter((e) => e.head === head);
      const sum = (kinds: LedgerEntry['kind'][]) => rows.filter((e) => kinds.includes(e.kind)).reduce((s, e) => s + e.amountPence, 0);
      const invoiced = sum(['invoiced']);
      const claimed = invoiced || sum(['claimed']);
      if (!claimed) continue;
      const paid = Math.min(sum(['paid', 'interim_paid']), claimed);
      const explicit = Math.min(sum(['reduced']), claimed - paid);
      const shortfall = paid > 0 ? Math.max(0, claimed - paid - explicit) : 0;
      const reduced = explicit + shortfall;
      const outstanding = Math.max(0, claimed - paid - reduced);
      for (const acc of [heads.get(head) ?? empty(), ib]) {
        acc.claimed += claimed;
        acc.paid += paid;
        acc.reduced += reduced;
        acc.outstanding += outstanding;
        acc.claims.add(claim.id);
        if (acc !== ib) heads.set(head, acc);
      }
    }
    insurers.set(ins, ib);
  }
  const pct = (c: number, r: number) => (c ? Math.round((r / c) * 1000) / 10 : 0);
  const byHead = [...heads.entries()]
    .map(([head, h]) => ({ head, label: HEAD_LABELS[head], claimedPence: h.claimed, paidPence: h.paid, reducedPence: h.reduced, outstandingPence: h.outstanding, reductionPct: pct(h.claimed, h.reduced), claims: h.claims.size }))
    .sort((a, b) => b.reducedPence - a.reducedPence);
  const totals = byHead.reduce(
    (t, h) => ({ claimedPence: t.claimedPence + h.claimedPence, paidPence: t.paidPence + h.paidPence, reducedPence: t.reducedPence + h.reducedPence, outstandingPence: t.outstandingPence + h.outstandingPence, reductionPct: 0 }),
    { claimedPence: 0, paidPence: 0, reducedPence: 0, outstandingPence: 0, reductionPct: 0 },
  );
  totals.reductionPct = pct(totals.claimedPence, totals.reducedPence);
  return {
    byHead,
    byInsurer: [...insurers.entries()].map(([insurerName, i]) => ({ insurerName, claimedPence: i.claimed, paidPence: i.paid, reducedPence: i.reduced, outstandingPence: i.outstanding, reductionPct: pct(i.claimed, i.reduced) })),
    totals,
  };
}

// ---------------------------------------------------------------------------

export interface CycleTimes {
  stages: Array<{ code: string; from: string; to: string; medianDays: number; p90Days: number; meanDays: number; claims: number }>;
}

const STAGES: Array<{ code: string; from: Claim['status'] | string; to: string; fromEvent: string; toEvent: string }> = [
  { code: 'fnol_to_ncaf', from: 'fnol', to: 'ncaf_sent', fromEvent: 'fnol', toEvent: 'ncaf_sent' },
  { code: 'hire_end_to_pack', from: 'hire_ended', to: 'payment_pack_sent', fromEvent: 'hire_ended', toEvent: 'payment_pack_sent' },
  { code: 'pack_to_payment', from: 'payment_pack_sent', to: 'payment_received', fromEvent: 'payment_pack_sent', toEvent: 'payment_received' },
  { code: 'report_to_collect_or_pay', from: 'report_issued', to: 'collect_or_pay_notice_sent', fromEvent: 'report_issued', toEvent: 'collect_or_pay_notice_sent' },
  { code: 'offer_to_reply', from: 'intervention_offer', to: 'intervention_reply_sent', fromEvent: 'intervention_offer', toEvent: 'intervention_reply_sent' },
];

export function cycleTimes(ctx: AppContext): CycleTimes {
  const samples = new Map<string, number[]>();
  for (const claim of allClaims(ctx)) {
    const events = ctx.repos.listEvents(ctx.db, claim.id);
    for (const st of STAGES) {
      const from = events.find((e) => e.type === st.fromEvent);
      if (!from) continue;
      const to = events.find((e) => e.type === st.toEvent && e.at >= from.at);
      if (!to) continue;
      const arr = samples.get(st.code) ?? [];
      arr.push(days(from.at, to.at));
      samples.set(st.code, arr);
    }
  }
  return { stages: STAGES.map((st) => { const s = stats(samples.get(st.code) ?? []); return { code: st.code, from: st.fromEvent, to: st.toEvent, medianDays: s.median, p90Days: s.p90, meanDays: s.mean, claims: s.n }; }) };
}

// ---------------------------------------------------------------------------

export interface Interventions {
  offers: number;
  accepted: number;
  declined: number;
  pending: number;
  suitable: number;
  unsuitable: number;
  replied: number;
  repliedWithin1Wd: number;
  averageReplyHours: number;
  averageOfferedDailyRatePence?: Pence;
  byInsurer: Array<{ insurerName: string; offers: number; accepted: number; declined: number; suitable: number; repliedWithin1Wd: number }>;
}

export function interventions(ctx: AppContext): Interventions {
  const out: Interventions = { offers: 0, accepted: 0, declined: 0, pending: 0, suitable: 0, unsuitable: 0, replied: 0, repliedWithin1Wd: 0, averageReplyHours: 0, byInsurer: [] };
  const byIns = new Map<string, Interventions['byInsurer'][number]>();
  const replyHours: number[] = [];
  const rates: number[] = [];
  for (const claim of allClaims(ctx)) {
    const ins = insurerName(ctx, claim).name;
    for (const o of ctx.repos.listOffers(ctx.db, claim.id)) {
      out.offers += 1;
      const b = byIns.get(ins) ?? { insurerName: ins, offers: 0, accepted: 0, declined: 0, suitable: 0, repliedWithin1Wd: 0 };
      b.offers += 1;
      if (o.clientDecision === 'accepted') (out.accepted += 1), (b.accepted += 1);
      else if (o.clientDecision === 'declined') (out.declined += 1), (b.declined += 1);
      else out.pending += 1;
      if (o.suitable === true) (out.suitable += 1), (b.suitable += 1);
      else if (o.suitable === false) out.unsuitable += 1;
      if (o.dailyRatePence) rates.push(o.dailyRatePence);
      if (o.replySentAt) {
        out.replied += 1;
        replyHours.push((Date.parse(o.replySentAt) - Date.parse(o.receivedAt)) / 3_600_000);
        if (o.replySentAt <= addWorkingDays(o.receivedAt, 1)) (out.repliedWithin1Wd += 1), (b.repliedWithin1Wd += 1);
      }
      byIns.set(ins, b);
    }
  }
  out.averageReplyHours = replyHours.length ? Math.round((replyHours.reduce((a, b) => a + b, 0) / replyHours.length) * 10) / 10 : 0;
  out.averageOfferedDailyRatePence = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : undefined;
  out.byInsurer = [...byIns.values()];
  return out;
}

// ---------------------------------------------------------------------------

export function overview(ctx: AppContext) {
  const now = ctx.now();
  const today = now.slice(0, 10);
  const claims = allClaims(ctx);
  const open = claims.filter((c) => !CLOSED.has(c.status));
  const byStatus = Object.fromEntries(ctx.repos.countClaimsByStatus(ctx.db).map((r) => [r.status, r.count])) as Partial<Record<ClaimStatus, number>>;
  const refs = new Map(claims.map((c) => [c.id, c]));
  const decorate = (c: { claimId: string }) => {
    const claim = refs.get(c.claimId);
    const claimant = claim ? ctx.repos.getParty(ctx.db, claim.claimantId) : undefined;
    return { ...c, claimReference: claim?.reference, claimantName: claimant?.name };
  };
  const running = ctx.repos.listDueClocks(ctx.db, { status: ['running'] }).filter((k) => refs.has(k.claimId) && !CLOSED.has(refs.get(k.claimId)!.status));
  const breached = ctx.repos.listDueClocks(ctx.db, { status: ['breached'] }).filter((k) => refs.has(k.claimId) && !CLOSED.has(refs.get(k.claimId)!.status));
  const dueToday = running.filter((k) => k.dueAt.slice(0, 10) === today).map(decorate);
  const upcoming = running.filter((k) => k.dueAt.slice(0, 10) > today).sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 25).map(decorate);
  const overdue = [...breached, ...running.filter((k) => k.dueAt < now)].map(decorate);
  const blocked = ctx.repos.listDocuments(ctx.db, { status: 'blocked', includeHtml: false }).map((d) => ({ id: d.id, claimId: d.claimId, claimReference: d.claimId ? refs.get(d.claimId)?.reference : undefined, templateId: d.templateId, title: d.title, status: d.status, blockedFlags: (d.consistency?.flags ?? []).filter((f) => f.severity === 'block' && !f.clearedAt).length, createdAt: d.createdAt }));
  const nextActions: Array<Record<string, unknown>> = [];
  for (const c of open.slice(0, 30)) {
    try {
      const bundle = loadBundle(ctx, c.id);
      const gates = gatesFor(bundle);
      for (const a of actionsFor(ctx, bundle, gates).slice(0, 3)) nextActions.push({ ...a, claimId: c.id, claimReference: c.reference });
    } catch (err) {
      ctx.logger.warn('overview: actions failed', { claimId: c.id, error: String(err) });
    }
  }
  const debtors = debtorDays(ctx);
  const inter = interventions(ctx);
  const units = ctx.repos.listFleetUnits(ctx.db);
  const fleetAlerts = complianceAlerts({ units, vehicles: units.map((u) => ctx.repos.getVehicle(ctx.db, u.vehicleId)).filter((v): v is NonNullable<typeof v> => Boolean(v)), policies: ctx.repos.listPolicies(ctx.db), penalties: ctx.repos.listPenalties(ctx.db, { open: true }), now });
  const watch = ctx.repos.listCompanyWatch(ctx.db, { riskLevel: 'high' });
  const acceptanceSample = open.slice(0, 5).map((c) => {
    const bundle = loadBundle(ctx, c.id);
    return { claimId: c.id, decision: acceptanceFor(ctx, bundle, gatesFor(bundle)).decision };
  });
  return {
    asOf: now,
    claims: { open: open.length, total: claims.length, byStatus },
    clocks: { dueToday, overdue, upcoming },
    blockedDocuments: blocked,
    nextActions: nextActions.sort((a, b) => String(a.dueAt ?? '9').localeCompare(String(b.dueAt ?? '9'))).slice(0, 40),
    debtorDays: debtors,
    outstandingPence: debtors.outstandingPence,
    fleetAlerts,
    interventions: { open: inter.pending + (inter.offers - inter.replied), repliesOverdue: inter.offers - inter.replied - inter.pending < 0 ? 0 : countOverdueReplies(ctx, now) },
    highRiskSuppliers: watch.map((w) => ({ companyNumber: w.companyNumber, name: w.name, riskReasons: w.riskReasons })),
    acceptanceSample,
  };
}

function countOverdueReplies(ctx: AppContext, now: ISODateTime): number {
  let n = 0;
  for (const claim of allClaims(ctx)) {
    if (CLOSED.has(claim.status)) continue;
    for (const o of ctx.repos.listOffers(ctx.db, claim.id)) if (!o.replySentAt && addWorkingDays(o.receivedAt, 1) < now) n += 1;
  }
  return n;
}

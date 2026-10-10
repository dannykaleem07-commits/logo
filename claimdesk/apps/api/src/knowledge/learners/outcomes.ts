// owned by knowledge-learners
/**
 * L1 outcome statistics (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.1) — `knowledge.learn_stats`, nightly 01:30. No AI.
 *
 *   1 insurer links      links.ts (exact name / brand / email domain; ambiguous → the owner)
 *   2 claim_outcomes     rebuilt per claim × head from the ledger (respecting supersedes_id), claim events, mail
 *                        classifications (objections, documents asked for) and offer observations
 *   3 insurer profiles   `insurer_profile` items for windows 12m and all; minimum n (statsMinN, 3) for every figure;
 *                        an insurer below it gets no profile item (the UI says "too few claims"); a profile is
 *                        superseded only when a figure changes
 *   4 step effectiveness `fact` items with `stat` ("followed by", never "caused"), per insurer when n ≥ 5, else global
 *   5 nightly stats-vs-note conflicts against owner-confirmed notes
 * Every figure carries its n and is internal (KR-10): computed items never appear in outbound text.
 */
import { buildInsurerProfile, claimTypeTagsFrom, describeStepStat, profileFigures, rowsInWindow, stepEffectiveness, OBJECTION_INTENTS, profileNoteConflicts, workingDaysBetween, type ClaimOutcomeInput, type FactData, type HeadOfLoss, type InsurerProfileData, type KnowledgeProposal, type MailIntent, type StatFactData } from '@ccguk/domain';
import type { ClaimOutcomeRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { getKnowledgeSettings } from '../settings.js';
import { proposeKnowledge, recordConflicts } from '../store.js';
import { LEARNER, all, directoryEntry, insurerSlugsByClaim, json } from './common.js';
import { effectiveLedger } from './offers.js';

const OUTBOUND_EVENTS = ['payment_pack_sent', 'chaser_sent', 'letter_out', 'email_out', 'letter_before_claim_sent', 'part36_sent', 'complaint_sent', 'dsar_sent', 'cctv_request_sent', 'ncaf_sent', 'intervention_reply_sent', 'collect_or_pay_notice_sent', 's172_response_sent'];
const PAYMENT_EVENTS = ['payment_received', 'tl_payment_received', 'cash_in_lieu_received'];
const OFFER_KINDS = new Set(['settlement', 'pav', 'part36']);

/** The outcome each step statistic measures and its window in working days (one per item key, §6.1.4). */
export const STAT_OUTCOME_DAYS: Readonly<Record<StatFactData['outcome'], number>> = { insurer_reply: 5, handling_ref: 5, offer: 10, payment: 20 };

const asInstant = (d: string): string => (d.length === 10 ? `${d}T12:00:00.000Z` : d);

interface LedgerRow {
  id: string;
  claim_id: string;
  head: string;
  kind: string;
  amount_pence: number;
  date: string;
  supersedes_id: string | null;
}

const groupBy = <T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
};

/** Rebuild every claim's `claim_outcomes` rows. Returns the rows as stats input. */
export function rebuildClaimOutcomes(ctx: AppContext): ClaimOutcomeInput[] {
  const now = ctx.now();
  const slugs = insurerSlugsByClaim(ctx);
  const claims = all<{ id: string; gta_subscriber: number; liability: string; track: string | null; injury_referral: string | null }>(ctx, `SELECT id, gta_subscriber, liability, track, injury_referral FROM claims ORDER BY id`);
  const ledger = groupBy(all<LedgerRow>(ctx, `SELECT id, claim_id, head, kind, amount_pence, date, supersedes_id FROM ledger_entries ORDER BY date, created_at, id`), (r) => r.claim_id);
  const events = groupBy(all<{ claim_id: string; type: string; at: string }>(ctx, `SELECT claim_id, type, at FROM claim_events ORDER BY at, id`), (r) => r.claim_id);
  const inbound = groupBy(all<{ id: string; claim_id: string; received_at: string }>(ctx, `SELECT id, claim_id, received_at FROM mail_messages WHERE direction = 'in' AND claim_id IS NOT NULL AND status <> 'quarantined' ORDER BY received_at, id`), (r) => r.claim_id);
  const classes = groupBy(
    all<{ claim_id: string; mail_message_id: string; intent: string; secondary: string; extracted: string; created_at: string }>(
      ctx,
      `SELECT m.claim_id AS claim_id, c.mail_message_id, c.intent, c.secondary, c.extracted, c.created_at FROM mail_classifications c JOIN mail_messages m ON m.id = c.mail_message_id WHERE m.claim_id IS NOT NULL ORDER BY c.created_at, c.id`,
    ),
    (r) => r.claim_id,
  );
  const docsSent = groupBy(all<{ claim_id: string; template_id: string; sent_at: string }>(ctx, `SELECT claim_id, template_id, sent_at FROM documents WHERE claim_id IS NOT NULL AND sent_at IS NOT NULL ORDER BY sent_at, id`), (r) => r.claim_id);
  const emailsSent = groupBy(
    all<{ claim_id: string; kind: string; at: string }>(ctx, `SELECT o.claim_id AS claim_id, o.kind AS kind, e.at AS at FROM outbox o JOIN outbox_events e ON e.outbox_id = o.id AND e.to_status = 'sent' WHERE o.claim_id IS NOT NULL ORDER BY e.at, o.id`),
    (r) => r.claim_id,
  );
  const offers = groupBy(ctx.repos.listOfferObservations(ctx.db, { limit: 100_000 }), (r) => r.claimId);
  const has = (table: string): Set<string> => new Set(all<{ claim_id: string }>(ctx, `SELECT DISTINCT claim_id FROM ${table}`).map((r) => r.claim_id));
  const withHire = has('hire_agreements');
  const withStorage = has('storage_records');
  const withRecovery = has('recovery_records');
  const withEstimate = has('estimates');
  const totalLoss = new Set(all<{ claim_id: string }>(ctx, `SELECT DISTINCT claim_id FROM engineer_reports WHERE total_loss IS NOT NULL`).map((r) => r.claim_id));

  const out: ClaimOutcomeInput[] = [];
  const kept: string[] = [];
  ctx.db.transaction((tx) => {
    for (const c of claims) {
      const led = effectiveLedger(ledger.get(c.id) ?? []);
      const ev = events.get(c.id) ?? [];
      const evTypes = new Set(ev.map((e) => e.type));
      const cls = classes.get(c.id) ?? [];
      // Latest classification per message.
      const latestCls = [...groupBy(cls, (r) => r.mail_message_id).values()].map((l) => l[l.length - 1]!);
      const intents = new Set<MailIntent>();
      const docs = new Set<string>();
      for (const k of latestCls) {
        for (const i of [k.intent, ...(json<string[]>(k.secondary) ?? [])]) if ((OBJECTION_INTENTS as readonly string[]).includes(i)) intents.add(i as MailIntent);
        for (const d of json<{ docsRequested?: string[] }>(k.extracted)?.docsRequested ?? []) if (typeof d === 'string' && d.trim()) docs.add(d.trim().slice(0, 120));
      }
      if (latestCls.some((k) => k.intent === 'fraud_allegation')) intents.add('fraud_allegation');
      const steps: { step: string; at: string }[] = [];
      for (const e of ev) {
        if (OUTBOUND_EVENTS.includes(e.type)) steps.push({ step: `event:${e.type}`, at: e.at });
        if (e.type === 'handling_ref_received') steps.push({ step: 'in:handling_ref', at: e.at });
        if (e.type === 'first_notification_dispute') steps.push({ step: 'in:first_notification_dispute', at: e.at });
        if (PAYMENT_EVENTS.includes(e.type)) steps.push({ step: 'in:payment', at: e.at });
        if (e.type === 'pav_offer_received' || e.type === 'part36_received' || e.type === 'settlement_offer_received') steps.push({ step: 'in:offer', at: e.at });
      }
      for (const d of docsSent.get(c.id) ?? []) steps.push({ step: `tpl:${d.template_id}`, at: d.sent_at });
      for (const o of emailsSent.get(c.id) ?? []) steps.push({ step: `email:${o.kind}`, at: o.at });
      for (const m of inbound.get(c.id) ?? []) steps.push({ step: 'in:reply', at: m.received_at });
      for (const r of led) if (r.kind === 'paid' || r.kind === 'interim_paid') steps.push({ step: 'in:payment', at: asInstant(r.date) });
      const offs = (offers.get(c.id) ?? []).filter((o) => OFFER_KINDS.has(o.offerKind) && o.decision === null);
      for (const o of offs) steps.push({ step: 'in:offer', at: o.receivedAt });
      const seen = new Set<string>();
      const uniqSteps = steps
        .sort((a, b) => a.at.localeCompare(b.at) || a.step.localeCompare(b.step))
        .filter((s) => {
          const k = `${s.step}|${s.at}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      const packSentAt = ev.find((e) => e.type === 'payment_pack_sent')?.at ?? null;
      const injury = json<{ referred?: boolean } | null>(c.injury_referral);
      const claimTypes = claimTypeTagsFrom({
        hasHire: withHire.has(c.id),
        hasRepair: withEstimate.has(c.id),
        totalLoss: totalLoss.has(c.id) || evTypes.has('total_loss_confirmed'),
        hasStorage: withStorage.has(c.id),
        hasRecovery: withRecovery.has(c.id),
        pcn: evTypes.has('pcn_received') || evTypes.has('nip_received'),
        injuries: Boolean(injury),
        liability: c.liability,
        fraudAllegation: intents.has('fraud_allegation'),
        track: c.track,
        litigation: evTypes.has('proceedings_issued'),
      });
      const heads = [...new Set(led.map((r) => r.head))].sort();
      const rows: Omit<ClaimOutcomeRecord, 'claimId'>[] = [];
      for (const head of heads) {
        const h = led.filter((r) => r.head === head);
        const sum = (kinds: string[]): number => h.filter((r) => kinds.includes(r.kind)).reduce((s, r) => s + r.amount_pence, 0);
        const claimed = sum(['claimed']) || sum(['invoiced']);
        const paid = sum(['paid', 'interim_paid']);
        const reduced = sum(['reduced']);
        const writtenOff = sum(['written_off']);
        const payments = h.filter((r) => r.kind === 'paid' || r.kind === 'interim_paid').sort((a, b) => a.date.localeCompare(b.date));
        const firstPaidAt = payments[0] ? asInstant(payments[0].date) : null;
        let fullyPaidAt: string | null = null;
        if (claimed > 0) {
          let cum = 0;
          for (const p of payments) {
            cum += p.amount_pence;
            if (cum >= claimed - reduced - writtenOff) {
              fullyPaidAt = asInstant(p.date);
              break;
            }
          }
        }
        const status = fullyPaidAt ? 'paid' : writtenOff > 0 && paid + reduced + writtenOff >= claimed ? 'written_off' : paid > 0 ? 'part_paid' : 'open';
        const firstOffer = offs.filter((o) => o.head === head && o.amountPence !== null).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))[0];
        const ledgerOffer = h.filter((r) => r.kind === 'offered').sort((a, b) => a.date.localeCompare(b.date))[0];
        const firstPayAt = firstPaidAt ?? '9999';
        const chasers = uniqSteps.filter((s) => (s.step === 'event:chaser_sent' || s.step === 'email:chaser') && (!packSentAt || s.at > packSentAt) && s.at < firstPayAt).length;
        rows.push({
          head,
          insurerSlug: slugs.get(c.id) ?? null,
          claimTypes,
          gtaSubscriber: Boolean(c.gta_subscriber),
          claimedPence: claimed,
          firstOfferPence: firstOffer?.amountPence ?? ledgerOffer?.amount_pence ?? null,
          paidPence: paid,
          reducedPence: reduced,
          packSentAt,
          firstPaidAt,
          fullyPaidAt,
          workingDaysToPay: packSentAt && fullyPaidAt && fullyPaidAt >= packSentAt ? workingDaysBetween(packSentAt, fullyPaidAt) : null,
          chasersBeforePay: chasers,
          objections: [...intents].sort(),
          docsRequested: [...docs].sort(),
          steps: uniqSteps,
          status,
          computedAt: now,
        });
      }
      ctx.repos.replaceClaimOutcomes(tx, c.id, rows);
      kept.push(c.id);
      for (const r of rows) out.push({ ...r, claimId: c.id, head: r.head as HeadOfLoss, objections: r.objections as MailIntent[], gtaSubscriber: r.gtaSubscriber });
    }
    ctx.repos.pruneClaimOutcomes(tx, kept);
  });
  return out;
}

/** ClaimOutcomeInput rows from the stored table (no rebuild). */
export function storedOutcomes(ctx: AppContext, f: { insurerSlug?: string } = {}): ClaimOutcomeInput[] {
  return ctx.repos.listClaimOutcomes(ctx.db, f).map((r) => ({ ...r, head: r.head as HeadOfLoss, objections: r.objections as MailIntent[], gtaSubscriber: r.gtaSubscriber === null ? null : Boolean(r.gtaSubscriber) }));
}

const pct = (x: number | null | undefined): string => (x === null || x === undefined ? 'too few claims' : `${x}%`);

/** Plain-English summary of a profile (no computedAt, so the body only changes when a figure does). */
export function profileBody(p: InsurerProfileData, name: string): string {
  const lines = [`${name}: ${p.n.claims} claims (${p.n.settled} settled), ${p.window === '12m' ? 'last 12 months' : 'all time'}. Computed from ClaimDesk's own records; internal only.`];
  lines.push(p.daysToPay.medianWorkingDays === null ? `Days to pay: too few claims (n=${p.daysToPay.n}).` : `Days to pay: median ${p.daysToPay.medianWorkingDays} working days, 90th percentile ${p.daysToPay.p90WorkingDays} (n=${p.daysToPay.n}).`);
  for (const [head, h] of Object.entries(p.heads)) {
    if (!h) continue;
    lines.push(`${head}: paid ${h.paidOfClaimedPct ? `median ${h.paidOfClaimedPct.median}% of claimed (IQR ${h.paidOfClaimedPct.p25}–${h.paidOfClaimedPct.p75}%)` : 'too few claims'}; first offer ${h.firstOfferOfClaimedPct ? `median ${h.firstOfferOfClaimedPct.median}%` : 'too few claims'}; reductions ${pct(h.reductionRatePct)} (n=${h.n}).`);
  }
  if (p.objections.length) lines.push(`Objections: ${p.objections.slice(0, 5).map((o) => `${o.intent.replace(/_/g, ' ')} ${o.pct}%`).join(', ')}.`);
  if (p.docsRequested.length) lines.push(`Documents asked for: ${p.docsRequested.slice(0, 5).map((d) => `${d.doc} (${d.claims})`).join(', ')}.`);
  if (p.gta.subscriberClaims) lines.push(`GTA (benchmark only): ${p.gta.subscriberClaims} subscriber claims; hire paid at the claimed rate ${pct(p.gta.hirePaidAtGtaRatePct)}; first-notification disputes ${pct(p.gta.firstNotificationDisputePct)}.`);
  return lines.join(' ').slice(0, 3900);
}

export interface LearnStatsResult {
  outcomeRows: number;
  claims: number;
  profiles: { insurerSlug: string; window: string; outcome: string; itemId: string }[];
  tooFewClaims: string[];
  stepFacts: number;
  conflicts: number;
}

export function learnStatistics(ctx: AppContext, opts: { runId?: string | null; jobId?: string | null } = {}): LearnStatsResult {
  const settings = getKnowledgeSettings(ctx);
  const minN = settings.thresholds.statsMinN;
  const now = ctx.now();
  const rows = rebuildClaimOutcomes(ctx);
  const result: LearnStatsResult = { outcomeRows: rows.length, claims: new Set(rows.map((r) => r.claimId)).size, profiles: [], tooFewClaims: [], stepFacts: 0, conflicts: 0 };
  const slugs = [...new Set(rows.map((r) => r.insurerSlug).filter((s): s is string => Boolean(s)))].sort();
  const propOpts = { runId: opts.runId ?? null, jobId: opts.jobId ?? null };

  for (const slug of slugs) {
    const name = directoryEntry(ctx, slug)?.name ?? slug;
    for (const window of ['12m', 'all'] as const) {
      const profile = buildInsurerProfile(slug, rows, { window, minN, computedAt: now });
      if (profile.n.claims < minN) {
        if (window === 'all') result.tooFewClaims.push(slug);
        continue;
      }
      const key = `profile:${slug}:${window}`;
      const active = ctx.repos.activeKnowledgeByKey(ctx.db, key);
      if (active && JSON.stringify(profileFigures(active.data as InsurerProfileData)) === JSON.stringify(profileFigures(profile))) continue;
      const claimIds = [...new Set(rowsInWindow(rows.filter((r) => r.insurerSlug === slug), window, now).map((r) => r.claimId))].sort();
      const proposal: KnowledgeProposal<InsurerProfileData> = {
        kind: 'insurer_profile',
        area: 'statistics',
        title: `${name} — insurer profile (${window === '12m' ? 'last 12 months' : 'all time'})`.slice(0, 200),
        body: profileBody(profile, name),
        data: profile,
        tags: ['statistics', 'computed'],
        scope: { kind: 'insurer', slug },
        business: ['ccguk'],
        useLimit: 'internal',
        origin: 'computed',
        confidence: 1,
        supportN: profile.n.claims,
        provenance: [{ kind: 'claim_stats', n: profile.n.claims, claimIds: claimIds.slice(0, 200), computedAt: now, method: `nearest-rank percentiles; minimum n ${minN}; window ${window}` }],
        itemKey: key,
        createdBy: LEARNER,
      };
      const r = proposeKnowledge(ctx, proposal, propOpts);
      result.profiles.push({ insurerSlug: slug, window, outcome: r.decision.outcome, itemId: r.item.id });
      if (r.item.status === 'active') {
        const notes = ctx.repos.listKnowledgeItems(ctx.db, { status: 'active', kind: 'fact', scopeKind: 'insurer', scopeValue: slug, limit: 500 }).items;
        const findings = profileNoteConflicts(`ki:${r.item.id}`, profile, notes);
        if (findings.length) result.conflicts += recordConflicts(ctx, findings, { detectedBy: LEARNER }).length;
      }
    }
  }

  // Step effectiveness ("followed by", never "caused").
  for (const window of ['12m', 'all'] as const) {
    const inWindow = rowsInWindow(rows, window, now);
    for (const [outcome, days] of Object.entries(STAT_OUTCOME_DAYS) as [StatFactData['outcome'], number][]) {
      const stats = stepEffectiveness(inWindow, { withinWorkingDays: days, minNPerInsurer: 5, window }).filter((s) => s.outcome === outcome && s.n >= minN);
      for (const s of stats) {
        const pctHit = Math.round((s.hits / s.n) * 1000) / 10;
        const statement = describeStepStat(s);
        const data: FactData = { statement, figure: { value: pctHit, unit: '%' }, asOf: null, benchmarkOnly: false, kbCheck: null, stat: s };
        const r = proposeKnowledge(
          ctx,
          {
            kind: 'fact',
            area: 'statistics',
            title: `${s.step} → ${s.outcome.replace(/_/g, ' ')} within ${s.withinWorkingDays} WD${s.insurerSlug ? ` (${s.insurerSlug})` : ''} [${window}]`.slice(0, 200),
            body: statement,
            data,
            tags: ['statistics', 'step_effectiveness', 'computed'],
            scope: s.insurerSlug ? { kind: 'insurer', slug: s.insurerSlug } : { kind: 'global' },
            business: ['ccguk'],
            useLimit: 'internal',
            origin: 'computed',
            confidence: 1,
            supportN: s.n,
            provenance: [{ kind: 'claim_stats', n: s.n, claimIds: [], computedAt: now, method: `first occurrence per claim; baseline = other steps of the same insurer; window ${window}` }],
            createdBy: LEARNER,
          },
          propOpts,
        );
        if (r.created) result.stepFacts += 1;
      }
    }
  }
  return result;
}

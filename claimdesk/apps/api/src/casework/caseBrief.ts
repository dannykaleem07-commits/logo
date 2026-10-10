// owned by casework
/**
 * The Case Brief (docs/SUPREME-DESIGN.md §E.2): everything an agent needs to reason about one claim, computed by code
 * from the engines — live events only (corrected events dropped by the bundle), derived clocks, gates, the playbook's
 * next actions, the ledger position, offers, hire, correspondence, recipients, open tasks and Needs-you items, and
 * approved memory. Facts (`facts`) are the only source of figures, dates and references for drafts (§E.3).
 *
 * Deterministic: every list is sorted by stable keys and the brief is byte-identical for identical state and clock
 * (cache-friendly, testable). Masked by default (§K.3); `mask: false` is for placeholder resolution only.
 */
import type { ClaimBundle, Clock, ClaimStatus, InsurerDirectoryEntry, ISODateTime, LiabilityPosition, Party, RecipientRole } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { actionsFor, deriveClocksFor, gatesFor, loadBundle } from '../services/claimView.js';
import { htmlToText } from '../agent/tools/core.js';
import { dateFact, moneyFact, numberFact, textFact, type FactId, type FactValue } from './facts.js';
import { fullAddress, maskAddress, maskEmail, maskPhone, maskText } from './mask.js';

export interface CaseBrief {
  version: 'brief/1';
  claimId: string;
  reference: string;
  generatedAt: ISODateTime;
  facts: Record<FactId, FactValue>;
  claim: { status: ClaimStatus; liability: LiabilityPosition; accident: { date: string; town: string; summary: string }; openFlags: { code: string; severity: string; message: string }[] };
  parties: { id: string; roles: string[]; name: string; contact: string }[];
  vehicles: { id: string; role: string; registration: string; make: string; model: string }[];
  clocks: { id: string; label: string; dueAt: string; status: string }[];
  gates: { id: string; met: boolean; missing: string[] }[];
  nextActions: { code: string; title: string; why: string; dueAt: string | null; blockedBy: string[]; templateId: string | null }[];
  money: { heads: { head: string; claimedPence: number; paidPence: number; outstandingPence: number }[] };
  offers: { id: string; head: string; amountPence: number; receivedAt: string; replyDueAt: string | null; clientDecision: string | null }[];
  hire?: { id: string; start: string; end: string | null; dailyRatePence: number; group: string | null };
  correspondence: { lastInbound?: { at: string; from: string; intent: string; summary: string }; priorLetters: { templateId: string; sentAt: string; keyFacts: FactId[] }[] };
  recipients: { partyId: string; role: RecipientRole; email: string | null; directoryId: string | null; verification: string; verifiedAt: string | null }[];
  openTasks: { id: string; kind: string; dueAt: string; note: string }[];
  openNeedsYou: { id: string; kind: string; title: string }[];
  memory: { id: string; text: string }[];
}

export interface CaseBriefOptions {
  /** PII masking for prompts (default true). */
  mask?: boolean;
}

const byStr = <T>(key: (x: T) => string) => (a: T, b: T): number => {
  const x = key(a);
  const y = key(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Stable fact-id segment from free text ("Example Insurance Ltd" → "example_insurance_ltd"). */
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

/** Offers recorded through `offer_record` carry their head and amount in the terms text ("Offer on hire of 640000 pence"). */
export function offerFigures(o: ClaimBundle['offers'][number]): { head: string; amountPence: number; perDay: boolean } {
  const terms = o.terms?.otherTerms ?? '';
  const head = /Offer on ([a-z_]+)/.exec(terms)?.[1] ?? 'hire';
  const amount = /of (\d+) pence/.exec(terms)?.[1];
  if (amount) return { head, amountPence: Number(amount), perDay: false };
  return { head, amountPence: o.dailyRatePence ?? 0, perDay: o.dailyRatePence !== undefined };
}

/** Clock ids: the clock kind, suffixed `_2`, `_3` … when a kind repeats (ordered by start). */
function clockIds(clocks: Array<Pick<Clock, 'kind' | 'startsAt' | 'dueAt'>>): string[] {
  const seen = new Map<string, number>();
  return clocks.map((c) => {
    const n = (seen.get(c.kind) ?? 0) + 1;
    seen.set(c.kind, n);
    return n === 1 ? c.kind : `${c.kind}_${n}`;
  });
}

function directoryFor(ctx: AppContext, insurer: Party | undefined): InsurerDirectoryEntry | undefined {
  if (!insurer) return undefined;
  let entries: InsurerDirectoryEntry[] = [];
  try {
    entries = ctx.kb.directory();
  } catch {
    entries = [];
  }
  const name = insurer.name.toLowerCase();
  const domain = insurer.email?.split('@')[1]?.toLowerCase();
  return [...entries]
    .sort(byStr((e) => e.id))
    .find(
      (e) =>
        e.name.toLowerCase() === name ||
        (e.brands ?? []).some((b) => b.toLowerCase() === name) ||
        Boolean(domain && [e.claimsEmail, e.thirdPartyEmail].some((x) => x?.toLowerCase().endsWith(`@${domain}`))),
    );
}

function contactOf(p: Party, mask: boolean): string {
  const parts: string[] = [];
  if (p.email) parts.push(mask && p.kind === 'individual' ? maskEmail(p.email) : p.email);
  if (p.phone) parts.push(mask && p.kind === 'individual' ? maskPhone(p.phone) : p.phone);
  if (p.address) parts.push(mask ? maskAddress(p.address) : fullAddress(p.address));
  return parts.filter(Boolean).join(' · ');
}

/** Build the Case Brief of a claim (§E.2). Throws NOT_FOUND for an unknown claim. */
export function buildCaseBrief(ctx: AppContext, claimId: string, opts: CaseBriefOptions = {}): CaseBrief {
  const mask = opts.mask ?? true;
  const now = ctx.now();
  const base = loadBundle(ctx, claimId);
  const derived = deriveClocksFor(ctx, base);
  const sortedClocks = [...derived].sort(byStr((c) => `${c.startsAt}|${c.dueAt}|${c.kind}`));
  const ids = clockIds(sortedClocks);
  const clocks: Clock[] = sortedClocks.map((c, i) => ({ ...c, id: ids[i]!, claimId }) as Clock);
  const bundle: ClaimBundle = { ...base, clocks };
  const claim = bundle.claim;
  const gates = gatesFor(bundle);
  const actions = actionsFor(ctx, bundle, gates);
  const position = ctx.repos.ledgerPosition(ctx.db, claimId);
  const facts: Record<FactId, FactValue> = {};
  const put = (id: FactId, f: FactValue): void => {
    facts[id] = f;
  };

  // --- claim ---------------------------------------------------------------
  put('claim.reference', textFact(claim.reference, 'claim'));
  put('claim.status', textFact(claim.status, 'claim'));
  put('claim.openedAt', dateFact(claim.openedAt, 'claim'));
  put('claim.accident.date', dateFact(claim.accident.occurredAt, 'claim'));
  put('claim.accident.location', textFact(mask ? claim.accident.location.split(',').slice(-1)[0]!.trim() : claim.accident.location, 'claim'));
  if (claim.atFaultInsurerRef) put('claim.atFaultInsurerRef', textFact(claim.atFaultInsurerRef, 'claim'));
  put('claim.liability', textFact(claim.liability, 'claim'));
  put('date.today', dateFact(now, 'clock'));

  // --- parties -------------------------------------------------------------
  const partyFacts = (prefix: string, p: Party | undefined): void => {
    if (!p) return;
    put(`party.${prefix}.name`, textFact(p.name, `party:${p.id}`));
    if (p.email) put(`party.${prefix}.email`, textFact(mask && p.kind === 'individual' ? maskEmail(p.email) : p.email, `party:${p.id}`));
    if (p.phone) put(`party.${prefix}.phone`, textFact(mask && p.kind === 'individual' ? maskPhone(p.phone) : p.phone, `party:${p.id}`));
    if (p.address) put(`party.${prefix}.address`, textFact(mask ? maskAddress(p.address) : fullAddress(p.address), `party:${p.id}`));
  };
  partyFacts('claimant', bundle.claimant);
  if (bundle.driver && bundle.driver.id !== bundle.claimant.id) partyFacts('driver', bundle.driver);
  partyFacts('atFaultInsurer', bundle.atFaultInsurer);
  const thirdParties = [...bundle.thirdParties].sort(byStr((p) => p.id));
  if (thirdParties[0]) partyFacts('thirdParty', thirdParties[0]);

  const partyMap = new Map<string, Party>();
  for (const p of [bundle.claimant, bundle.driver, bundle.atFaultInsurer, ...bundle.thirdParties]) if (p) partyMap.set(p.id, p);
  const parties = [...partyMap.values()].sort(byStr((p) => p.id)).map((p) => ({ id: p.id, roles: [...p.roles].sort(), name: p.name, contact: contactOf(p, mask) }));

  // --- vehicles ------------------------------------------------------------
  const vehicles = [
    { v: bundle.vehicle, role: 'client' },
    ...(bundle.thirdPartyVehicle ? [{ v: bundle.thirdPartyVehicle, role: 'third_party' }] : []),
  ].map(({ v, role }) => ({ id: v.id, role, registration: v.registration, make: v.make, model: v.model }));
  put('vehicle.client.registration', textFact(bundle.vehicle.registration, `vehicle:${bundle.vehicle.id}`));
  put('vehicle.client.makeModel', textFact(`${bundle.vehicle.make} ${bundle.vehicle.model}`.trim(), `vehicle:${bundle.vehicle.id}`));
  if (bundle.thirdPartyVehicle) put('vehicle.thirdParty.registration', textFact(bundle.thirdPartyVehicle.registration, `vehicle:${bundle.thirdPartyVehicle.id}`));

  // --- clocks --------------------------------------------------------------
  for (const c of clocks) {
    put(`clock.${c.id}.dueAt`, dateFact(c.dueAt, `clock:${c.kind}`));
    put(`clock.${c.id}.startsAt`, dateFact(c.startsAt, `clock:${c.kind}`));
  }

  // --- money ---------------------------------------------------------------
  const heads = [...position.heads].sort(byStr((h) => h.head)).map((h) => ({ head: h.head, claimedPence: h.claimedPence, paidPence: h.paidPence, outstandingPence: h.outstandingPence }));
  for (const h of position.heads) {
    put(`ledger.${h.head}.claimedPence`, moneyFact(h.claimedPence, 'ledger'));
    put(`ledger.${h.head}.paidPence`, moneyFact(h.paidPence, 'ledger'));
    put(`ledger.${h.head}.outstandingPence`, moneyFact(h.outstandingPence, 'ledger'));
    if (h.invoicedPence) put(`ledger.${h.head}.invoicedPence`, moneyFact(h.invoicedPence, 'ledger'));
  }
  put('ledger.total.claimedPence', moneyFact(position.totals.claimedPence, 'ledger'));
  put('ledger.total.paidPence', moneyFact(position.totals.paidPence, 'ledger'));
  put('ledger.total.outstandingPence', moneyFact(position.totals.outstandingPence, 'ledger'));
  const lastPaid = [...bundle.ledger].filter((e) => e.kind === 'paid' || e.kind === 'interim_paid').sort(byStr((e) => `${e.date}|${e.createdAt}|${e.id}`)).pop();
  if (lastPaid) {
    put('payment.last.amountPence', moneyFact(lastPaid.amountPence, `ledger:${lastPaid.id}`));
    put('payment.last.date', dateFact(lastPaid.date, `ledger:${lastPaid.id}`));
    if (lastPaid.reference) put('payment.last.reference', textFact(lastPaid.reference, `ledger:${lastPaid.id}`));
  }

  // --- offers --------------------------------------------------------------
  const replyClocks = clocks.filter((c) => c.kind === 'intervention_reply_1wd');
  const offers = [...bundle.offers].sort(byStr((o) => `${o.receivedAt}|${o.id}`)).map((o) => {
    const f = offerFigures(o);
    const clock = o.replySentAt ? undefined : replyClocks.find((c) => c.startsAt >= o.receivedAt.slice(0, 10) || c.startsAt === o.receivedAt) ?? replyClocks.find((c) => c.status === 'running');
    put(`offer.${o.id}.amountPence`, moneyFact(f.amountPence, `offer:${o.id}`));
    put(`offer.${o.id}.receivedAt`, dateFact(o.receivedAt, `offer:${o.id}`));
    put(`offer.${o.id}.offeror`, textFact(o.offerorName, `offer:${o.id}`));
    if (clock) put(`offer.${o.id}.replyDueAt`, dateFact(clock.dueAt, `clock:${clock.kind}`));
    return { id: o.id, head: f.head, amountPence: f.amountPence, receivedAt: o.receivedAt, replyDueAt: clock?.dueAt ?? null, clientDecision: o.clientDecision === 'pending' ? null : o.clientDecision };
  });

  // --- hire ----------------------------------------------------------------
  const hires = [...bundle.hire].sort(byStr((h) => `${h.startAt}|${h.id}`));
  const current = hires.filter((h) => !h.endAt).pop() ?? hires[hires.length - 1];
  let hire: CaseBrief['hire'];
  if (current) {
    hire = { id: current.id, start: current.startAt, end: current.endAt ?? null, dailyRatePence: current.dailyRatePence, group: current.gtaGroup ?? null };
    put('hire.current.dailyRatePence', moneyFact(current.dailyRatePence, `hire:${current.id}`));
    put('hire.current.startAt', dateFact(current.startAt, `hire:${current.id}`));
    if (current.endAt) put('hire.current.endAt', dateFact(current.endAt, `hire:${current.id}`));
    put('hire.current.agreementNumber', textFact(current.agreementNumber, `hire:${current.id}`));
    if (current.gtaGroup) put('hire.current.group', textFact(current.gtaGroup, `hire:${current.id}`));
    const end = current.endAt ?? now;
    const days = Math.max(0, Math.round((Date.parse(end.slice(0, 10)) - Date.parse(current.startAt.slice(0, 10))) / 86_400_000));
    put('hire.current.days', numberFact(days, `hire:${current.id}`, days === 1 ? 'day' : 'days'));
  }

  // --- correspondence --------------------------------------------------------
  let lastInbound: CaseBrief['correspondence']['lastInbound'];
  try {
    const m = ctx.repos.listMailMessages(ctx.db, { claimId, direction: 'in', limit: 1 })[0];
    if (m) {
      const c = ctx.repos.latestMailClassification(ctx.db, m.id);
      const from = m.fromName || m.fromAddr || 'unknown';
      lastInbound = { at: m.sentAt ?? m.receivedAt, from: mask ? maskText(from) : from, intent: c?.intent ?? 'unclassified', summary: mask ? maskText(c?.summary ?? m.subject ?? '') : (c?.summary ?? m.subject ?? '') };
    }
  } catch {
    lastInbound = undefined;
  }
  const factEntries = Object.entries(facts).filter(([id, f]) => f.display.length >= 4 && !id.startsWith('date.today') && (/£|\d/.test(f.display) || id.endsWith('Ref') || id.endsWith('reference')));
  const priorLetters = ctx.repos
    .listSentDocuments(ctx.db, claimId, true)
    .filter((d) => d.sentAt)
    .sort(byStr((d) => `${d.sentAt}|${d.id}`))
    .map((d) => {
      const text = htmlToText(d.html ?? '');
      return { templateId: d.templateId, sentAt: d.sentAt!, keyFacts: factEntries.filter(([, f]) => text.includes(f.display)).map(([id]) => id).sort() };
    });

  // --- recipients ------------------------------------------------------------
  const recipients: CaseBrief['recipients'] = [];
  const insurer = bundle.atFaultInsurer;
  if (insurer) {
    const dir = directoryFor(ctx, insurer);
    const email = insurer.email ?? dir?.thirdPartyEmail ?? dir?.claimsEmail ?? null;
    recipients.push({ partyId: insurer.id, role: 'at_fault_insurer', email, directoryId: dir?.id ?? null, verification: dir?.verification?.status ?? 'unverified', verifiedAt: (dir?.verification as { verifiedAt?: string } | undefined)?.verifiedAt ?? null });
  }
  recipients.push({ partyId: bundle.claimant.id, role: 'client', email: bundle.claimant.email ? (mask ? maskEmail(bundle.claimant.email) : bundle.claimant.email) : null, directoryId: null, verification: 'on_file', verifiedAt: null });
  recipients.sort(byStr((r) => `${r.role}|${r.partyId}`));

  // --- tasks, Needs-you, memory ----------------------------------------------
  const openTasks = ctx.repos
    .listTasks(ctx.db, { claimId, status: 'open', limit: 200 })
    .sort(byStr((t) => `${t.dueAt}|${t.id}`))
    .map((t) => ({ id: t.id, kind: t.kind, dueAt: t.dueAt, note: mask ? maskText(t.note ?? t.title) : (t.note ?? t.title) }));
  const openNeedsYou = ctx.repos
    .listNeedsYou(ctx.db, { claimId, status: ['open', 'snoozed'], limit: 200 })
    .sort(byStr((n) => `${n.createdAt}|${n.id}`))
    .map((n) => ({ id: n.id, kind: n.kind, title: n.title }));
  const scopes = [`claim:${claimId}`, ...(insurer ? [`insurer:${insurer.id}`] : []), ...(insurer && directoryFor(ctx, insurer) ? [`insurer:${directoryFor(ctx, insurer)!.id}`] : [])];
  const memory = ctx.repos
    .listMemoryItems(ctx.db, { scope: scopes, status: 'approved', limit: 100 })
    .sort(byStr((m) => `${m.createdAt}|${m.id}`))
    .map((m) => ({ id: m.id, text: mask ? maskText(m.text) : m.text }));

  const openFlags = [...(claim.flags ?? [])]
    .filter((f) => !f.clearedAt)
    .sort(byStr((f) => `${f.raisedAt}|${f.code}`))
    .map((f) => ({ code: f.code, severity: f.severity, message: f.message }));

  const sortedFacts: Record<FactId, FactValue> = {};
  for (const k of Object.keys(facts).sort()) sortedFacts[k] = facts[k]!;

  return {
    version: 'brief/1',
    claimId,
    reference: claim.reference,
    generatedAt: now,
    facts: sortedFacts,
    claim: {
      status: claim.status,
      liability: claim.liability,
      accident: { date: claim.accident.occurredAt, town: mask ? (claim.accident.location.split(',').slice(-1)[0] ?? '').trim() : claim.accident.location, summary: mask ? maskText(claim.accident.circumstances) : claim.accident.circumstances },
      openFlags,
    },
    parties,
    vehicles,
    clocks: clocks.map((c) => ({ id: c.id, label: c.label, dueAt: c.dueAt, status: c.status })),
    gates: [...gates].sort(byStr((g) => g.gate)).map((g) => ({ id: g.gate, met: g.status === 'green', missing: [...g.missing] })),
    nextActions: actions.map((a) => ({ code: a.code, title: a.title, why: a.why, dueAt: a.dueAt ?? null, blockedBy: [...(a.blockedBy ?? [])], templateId: a.templateId ?? null })),
    money: { heads },
    offers,
    ...(hire ? { hire } : {}),
    correspondence: { ...(lastInbound ? { lastInbound } : {}), priorLetters },
    recipients,
    openTasks,
    openNeedsYou,
    memory,
  };
}

/** Canonical JSON of a brief (sorted keys) — the byte-stable form prompts and tests use. */
export function briefJson(brief: CaseBrief): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(sort(brief));
}

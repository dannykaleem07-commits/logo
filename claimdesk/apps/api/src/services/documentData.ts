/**
 * Template data assembly — ARCHITECTURE convention 4 ("one source of truth").
 *
 * For every template id the data object is built from the claim bundle (ledger, events, offers, hire, storage,
 * recovery, PAV, estimate, engineer's report), the settings table and the recipient party. Handlers may supply only the
 * extra free-text fields a template declares; a supplied value for anything the ledger knows is refused
 * (`EXTRA_OVERRIDES_LEDGER`). The merged object becomes the document's `dataSnapshot`.
 */
import {
  addCalendarDays,
  addCalendarMonths,
  addWorkingDays,
  calculateHire,
  calendarDaysBetween,
  formatGBP,
  recoveryCharge,
  storageCharge,
  validatePaymentPack,
  type ClaimBundle,
  type ClaimEvent,
  type HeadOfLoss,
  type HireAgreement,
  type Id,
  type ISODate,
  type ISODateTime,
  type InterventionOffer,
  type LedgerEntry,
  type Party,
  type Pence,
} from '@ccguk/domain';
import type { Settings } from '@ccguk/db';
import { formatRegisteredOffice } from '@ccguk/documents';
import type { AppContext } from '../context.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { STRICT_GATE, type OverrideGate } from './override.js';
import { gtaRatesFor } from './kb.js';
import { absoluteEvidencePath } from './evidence.js';
import { existsSync, readFileSync } from 'node:fs';
import type { Evidence } from '@ccguk/domain';
import { litigationBuilders } from './builders/litigation.js';
import { correspondenceBuilders } from './builders/correspondence.js';
import { reservationHireData } from '../signing/reservationData.js';

export type RecipientRole = 'at_fault_insurer' | 'client' | 'own_insurer' | 'court' | 'supplier' | 'other';

export interface CompanySettingsData {
  registeredOffice: string;
  companyName: string;
  companyNumber?: string;
  vatNumber?: string;
  bank: { accountName: string; sortCode: string; accountNumber: string; bankName: string };
  icoRegistration?: string;
  signatoryName: string;
  signatoryRole: string;
}

export interface RecipientBlockData {
  name: string;
  addressLines: string[];
  attention?: string;
  email?: string;
  partyId?: Id;
}

export interface ClaimHeaderData {
  ourReference: string;
  theirReference?: string;
  claimantName: string;
  vehicleRegistration: string;
  vehicleDescription?: string;
  accidentDate: ISODateTime;
  insurerName?: string;
  thirdPartyName?: string;
  thirdPartyRegistration?: string;
  policyNumber?: string;
}

export interface HeadSummary {
  head: HeadOfLoss;
  label: string;
  claimedPence: Pence;
  invoicedPence: Pence;
  receivedPence: Pence;
  outstandingPence: Pence;
  reducedPence: Pence;
  invoiceReference?: string;
}

export interface BuildInput {
  ctx: AppContext;
  bundle: ClaimBundle;
  templateId: string;
  recipientRole: RecipientRole;
  recipientPartyId?: Id;
  user: { id: Id; name: string; role: string };
  now: ISODateTime;
  /** Handler-supplied extras (read-only here: selectors such as offerId; never amounts the ledger knows). */
  extra?: Record<string, unknown>;
  /** Manager-mode override gate of the request (absent = strict). */
  gate?: OverrideGate;
}

/** Refuse a class A guard of a builder through the override gate (keyed to the claim and the template). */
function refuseIn(b: Pick<BuildInput, 'gate' | 'bundle' | 'templateId'>, error: HttpError): void {
  (b.gate ?? STRICT_GATE).refuse(error, { claimId: b.bundle.claim.id, entity: 'templates', entityId: b.templateId });
}

export interface AssembledData {
  data: Record<string, unknown>;
  recipientRole: RecipientRole;
  recipientPartyId?: Id;
  /** Dot paths the API derived (anything else came from the handler's extra fields). */
  derivedKeys: string[];
}

export const HEAD_LABELS: Record<HeadOfLoss, string> = {
  hire: 'Hire',
  recovery: 'Recovery',
  storage: 'Storage',
  engineer_fee: 'Engineer’s fee',
  pav: 'Pre-accident value',
  repair: 'Repair',
  salvage: 'Salvage',
  excess: 'Excess',
  loss_of_use: 'Loss of use',
  diminution: 'Diminution in value',
  personal_effects: 'Personal effects',
  loss_of_earnings: 'Loss of earnings',
  travel: 'Travel',
  misc: 'Miscellaneous',
  interest: 'Interest',
  court_fee: 'Court fee',
  fixed_costs: 'Fixed costs',
};

const USER_ROLE_LABEL: Record<string, string> = { handler: 'Claims Handler', approver: 'Claims Manager', engineer: 'Engineer', admin: 'Director' };

export const datePart = (iso: ISODateTime | ISODate): ISODate => iso.slice(0, 10);

export function addressLines(p: Party | undefined, fallback = '[address to be confirmed]'): string[] {
  const a = p?.address;
  if (!a) return [fallback];
  return [a.line1, a.line2, a.town, a.county, a.postcode, a.country].filter((x): x is string => Boolean(x && x.trim()));
}

export function companySettings(settings: Settings, user: BuildInput['user']): CompanySettingsData {
  // Settings fall back to the real registered office (44 Syon Lane…); never a placeholder.
  const registeredOffice = formatRegisteredOffice(settings.registeredOffice);
  return {
    registeredOffice,
    companyName: settings.companyName,
    companyNumber: settings.companyNumber,
    vatNumber: settings.vatNumber,
    bank: {
      accountName: settings.bank?.accountName ?? settings.companyName,
      sortCode: settings.bank?.sortCode ?? '',
      accountNumber: settings.bank?.accountNumber ?? '',
      bankName: settings.bank?.bankName ?? '',
    },
    icoRegistration: settings.icoRegistration,
    signatoryName: user.name,
    signatoryRole: USER_ROLE_LABEL[user.role] ?? 'Claims Handler',
  };
}

export function vehicleDescription(v: ClaimBundle['vehicle'] | undefined): string | undefined {
  if (!v) return undefined;
  const s = [v.make, v.model, v.variant].filter(Boolean).join(' ').trim();
  return s || undefined;
}

export function claimHeader(bundle: ClaimBundle): ClaimHeaderData {
  const { claim, claimant, vehicle, thirdParties, thirdPartyVehicle, atFaultInsurer } = bundle;
  return {
    ourReference: claim.reference,
    theirReference: claim.atFaultInsurerRef,
    claimantName: claimant.name,
    vehicleRegistration: vehicle.registration,
    vehicleDescription: vehicleDescription(vehicle),
    accidentDate: claim.accident.occurredAt,
    insurerName: atFaultInsurer?.name,
    thirdPartyName: thirdParties[0]?.name,
    thirdPartyRegistration: thirdPartyVehicle?.registration,
    policyNumber: claim.clientPolicyNumber,
  };
}

export function recipientBlock(p: Party | undefined, attention?: string): RecipientBlockData | undefined {
  if (!p) return undefined;
  return { partyId: p.id, name: p.name, addressLines: addressLines(p), attention, email: p.email };
}

export function resolveRecipient(ctx: AppContext, bundle: ClaimBundle, role: RecipientRole, recipientPartyId?: Id): RecipientBlockData | undefined {
  if (recipientPartyId) {
    const p = ctx.repos.getParty(ctx.db, recipientPartyId);
    if (!p) throw badRequest(`recipientPartyId ${recipientPartyId} not found`);
    return recipientBlock(p, p.roles.includes('insurer') ? 'Third Party Claims Team' : undefined);
  }
  switch (role) {
    case 'at_fault_insurer':
      return recipientBlock(bundle.atFaultInsurer, 'Third Party Claims Team');
    case 'client':
      return recipientBlock(bundle.claimant);
    case 'own_insurer':
      return recipientBlock(bundle.claim.clientInsurerId ? ctx.repos.getParty(ctx.db, bundle.claim.clientInsurerId) : undefined, 'Claims Department');
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Ledger / chronology derived blocks
// ---------------------------------------------------------------------------

const sum = (entries: LedgerEntry[], f: (e: LedgerEntry) => number = (e) => e.amountPence): Pence => entries.reduce((s, e) => s + f(e), 0);

export function headSummaries(bundle: ClaimBundle): HeadSummary[] {
  const heads = [...new Set(bundle.ledger.map((e) => e.head))];
  return heads.map((head) => {
    const rows = bundle.ledger.filter((e) => e.head === head);
    const claimed = sum(rows.filter((e) => e.kind === 'claimed'));
    const invoiced = sum(rows.filter((e) => e.kind === 'invoiced'));
    const received = sum(rows.filter((e) => e.kind === 'paid' || e.kind === 'interim_paid'));
    const reduced = sum(rows.filter((e) => e.kind === 'reduced'));
    const position = invoiced || claimed;
    const invoiceReference = rows.find((e) => e.kind === 'invoiced' && e.reference)?.reference;
    return { head, label: HEAD_LABELS[head], claimedPence: position, invoicedPence: invoiced, receivedPence: received, outstandingPence: Math.max(0, position - received), reducedPence: reduced, invoiceReference };
  });
}

export function payments(bundle: ClaimBundle): Array<{ date: ISODate; amountPence: Pence; reference?: string; head: HeadOfLoss }> {
  return bundle.ledger
    .filter((e) => e.kind === 'paid' || e.kind === 'interim_paid')
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({ date: e.date, amountPence: e.amountPence, reference: e.reference, head: e.head }));
}

export function firstEvent(bundle: ClaimBundle, type: ClaimEvent['type']): ClaimEvent | undefined {
  return [...bundle.events].filter((e) => e.type === type).sort((a, b) => a.at.localeCompare(b.at))[0];
}
export function latestEvent(bundle: ClaimBundle, type: ClaimEvent['type']): ClaimEvent | undefined {
  return [...bundle.events].filter((e) => e.type === type).sort((a, b) => b.at.localeCompare(a.at))[0];
}

export function latestHire(bundle: ClaimBundle): HireAgreement | undefined {
  return [...bundle.hire].sort((a, b) => b.startAt.localeCompare(a.startAt))[0];
}

export function hireBlock(ctx: AppContext, bundle: ClaimBundle, now: ISODateTime) {
  const h = latestHire(bundle);
  if (!h) return undefined;
  const calc = calculateHire(h, undefined, { asOf: now, rates: gtaRatesFor(ctx) });
  const unit = ctx.repos.getFleetUnit(ctx.db, h.fleetUnitId);
  const vehicle = unit ? ctx.repos.getVehicle(ctx.db, unit.vehicleId) : undefined;
  const endEvent = h.endTrigger ? latestEvent(bundle, 'hire_ended') : undefined;
  return {
    agreementId: h.id,
    agreementNumber: h.agreementNumber,
    signedAt: h.signedAt,
    startAt: h.startAt,
    endAt: h.endAt ?? now,
    open: !h.endAt,
    days: calc.days,
    dailyRatePence: h.dailyRatePence,
    hirePence: calc.hirePence,
    netPence: calc.netPence,
    vatRate: h.vatRate,
    vatPence: calc.vatPence,
    grossPence: calc.grossPence,
    gtaGroup: h.gtaGroup,
    endTrigger: h.endTrigger,
    endReason: endEvent?.summary,
    vehicleDescription: vehicleDescription(vehicle) ?? `GTA group ${h.gtaGroup} replacement vehicle`,
    vehicleRegistration: vehicle?.registration,
    vehicle: vehicle ? { registration: vehicle.registration, make: vehicle.make, model: vehicle.model, variant: vehicle.variant, gtaGroup: h.gtaGroup } : undefined,
    benchmark: calc.benchmark,
    additionalDriverPence: calc.additionalDriverPence,
    excessWaiverPence: calc.excessWaiverPence,
  };
}

export function storageBlock(bundle: ClaimBundle, now: ISODateTime) {
  const s = [...bundle.storage].sort((a, b) => b.startAt.localeCompare(a.startAt))[0];
  if (!s) return undefined;
  const calc = storageCharge(s, s.endAt ?? now);
  const endEvent = latestEvent(bundle, 'storage_ended');
  return {
    storageId: s.id,
    location: s.location,
    startAt: s.startAt,
    endAt: s.endAt ?? now,
    open: !s.endAt,
    days: calc.days,
    daysToDate: calc.days,
    dailyRatePence: s.dailyRatePence,
    amountPence: calc.netPence,
    accruedToDatePence: calc.netPence,
    vatRate: s.vatRate,
    vatPence: calc.vatPence,
    grossPence: calc.grossPence,
    endTrigger: s.endTrigger,
    endReason: endEvent?.summary,
  };
}

export function recoveryBlock(bundle: ClaimBundle) {
  const r = [...bundle.recovery].sort((a, b) => a.at.localeCompare(b.at))[0];
  if (!r) return undefined;
  const calc = recoveryCharge(r);
  return {
    recoveryId: r.id,
    at: r.at,
    fromLocation: r.fromLocation,
    toLocation: r.toLocation,
    calloutPence: r.calloutPence,
    loadedMiles: r.loadedMiles,
    perLoadedMilePence: r.perLoadedMilePence,
    mileagePence: calc.mileagePence,
    adminPence: r.adminPence,
    netPence: calc.netPence,
    vatRate: r.vatRate,
    vatPence: calc.vatPence,
    grossPence: calc.grossPence,
  };
}

export function reportBlock(ctx: AppContext, bundle: ClaimBundle) {
  const r = bundle.report;
  if (!r) return undefined;
  const engineer = ctx.repos.getParty(ctx.db, r.engineerPartyId);
  const outcome = r.totalLoss?.decision === 'total_loss' || bundle.events.some((e) => e.type === 'total_loss_confirmed') ? 'total_loss' : r.totalLoss?.decision === 'borderline' ? 'uneconomic_repair' : 'repairable';
  return {
    reportId: r.id,
    issuedAt: r.issuedAt,
    engineerName: engineer?.name ?? '[engineer]',
    engineerQualifications: r.engineerQualifications,
    instructedAt: r.instructedAt,
    instructedBy: r.instructedBy,
    inspectionAt: r.inspectionAt,
    inspectionPlace: r.inspectionPlace,
    inspectionBasis: r.inspectionBasis,
    outcome,
    roadworthy: r.roadworthy,
    roadworthyReason: r.roadworthyReason,
    repairDurationWorkingDays: r.repairDurationWorkingDays,
    pavPence: bundle.pav?.pavPence,
    salvageCategory: r.salvageCategory,
    salvageValuePence: r.salvageValuePence,
    feePence: r.feePence,
    forCourt: r.forCourt,
    reference: r.id.slice(0, 8).toUpperCase(),
  };
}

export function packBlock(bundle: ClaimBundle) {
  const doc = bundle.documents.filter((d) => d.templateId === 'pack.gta_payment' && (d.status === 'sent' || d.status === 'approved' || d.status === 'signed')).sort((a, b) => (b.sentAt ?? b.createdAt).localeCompare(a.sentAt ?? a.createdAt))[0];
  const ev = latestEvent(bundle, 'payment_pack_sent');
  const sentAtIso = doc?.sentAt ?? ev?.at;
  if (!sentAtIso) return undefined;
  const contents = (Array.isArray(doc?.dataSnapshot?.contents) ? (doc?.dataSnapshot?.contents as string[]) : undefined) ?? bundle.documents.filter((d) => d.status === 'sent' && d.id !== doc?.id && d.sentAt && d.sentAt <= sentAtIso).map((d) => d.title);
  return {
    documentId: doc?.id,
    sentAt: datePart(sentAtIso),
    sentAtIso,
    sentBy: doc?.sentVia ?? (typeof ev?.data?.via === 'string' ? ev.data.via : 'email'),
    sentTo: bundle.atFaultInsurer?.email,
    contents: contents.length ? contents : ['Covering letter', 'Hire account', "Engineer's report"],
  };
}

export function ncafBlock(bundle: ClaimBundle) {
  const doc = bundle.documents.filter((d) => d.templateId === 'letter.ncaf' && d.sentAt).sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''))[0];
  const ev = firstEvent(bundle, 'ncaf_sent');
  const sentAtIso = doc?.sentAt ?? ev?.at;
  if (!sentAtIso) return undefined;
  return { documentId: doc?.id, sentAt: datePart(sentAtIso), sentAtIso, sentBy: doc?.sentVia ?? 'email', sentTo: bundle.atFaultInsurer?.email ?? bundle.atFaultInsurer?.name ?? '[insurer]' };
}

export function chronology(bundle: ClaimBundle) {
  return [...bundle.events].sort((a, b) => a.at.localeCompare(b.at)).map((e) => ({ date: e.at, description: e.summary, attributableTo: e.attributableTo, type: e.type }));
}

export function offerDetails(offer: InterventionOffer, insurerName: string | undefined) {
  return {
    offerId: offer.id,
    receivedAt: offer.receivedAt,
    channel: offer.channel,
    offerorName: offer.offerorName || insurerName || '[offeror]',
    madeTo: offer.channel === 'via_client' ? 'claimant' : 'ccguk',
    vehicleClassOffered: offer.vehicleClassOffered,
    dailyRatePence: offer.dailyRatePence,
    rateIncludesVat: offer.rateIncludesVat,
    terms: offer.terms ?? {},
    suitable: offer.suitable ?? false,
    suitabilityReasons: offer.suitabilityReasons ?? [],
    clientDecision: offer.clientDecision,
    clientReasons: offer.clientReasons ?? '',
    clientDecisionAt: offer.clientDecisionAt,
  };
}

export function runningClockDue(bundle: ClaimBundle, kinds: string[]): ISODate | undefined {
  const c = bundle.clocks.filter((k) => k.status === 'running' && kinds.includes(k.kind)).sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
  return c ? datePart(c.dueAt) : undefined;
}

/** A deadline we may state: never earlier than the governing running clock. */
export function deadline(bundle: ClaimBundle, today: ISODate, days: number, clockKinds: string[], working = false): ISODate {
  const base = working ? datePart(addWorkingDays(today, days)) : datePart(addCalendarDays(today, days));
  const clock = runningClockDue(bundle, clockKinds);
  return clock && clock > base ? clock : base;
}

/** Small images are embedded as data URLs so the engineer's report PDF carries the photographs (≤ 2 MB each). */
export function evidenceDataUrl(ctx: AppContext, e: Evidence): string | undefined {
  if (!e.mime.startsWith('image/') || e.bytes > 2 * 1024 * 1024) return undefined;
  const abs = absoluteEvidencePath(ctx, e.storagePath);
  if (!existsSync(abs)) return undefined;
  return `data:${e.mime};base64,${readFileSync(abs).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export type Builder = (b: BuildInput, base: Record<string, unknown>) => Record<string, unknown>;

function hireLabel(h: NonNullable<ReturnType<typeof hireBlock>>, head: HeadSummary): string {
  return `Hire, ${h.days} day${h.days === 1 ? '' : 's'} at ${formatGBP(h.dailyRatePence)} per day${head.invoiceReference ? ` (invoice ${head.invoiceReference})` : ''}`;
}

/** Pack facts typed by the handler (`data.pack`) when no pack is on the file — used only after a manager override. */
function typedPack(extra: Record<string, unknown> | undefined): { sentAt: ISODate; sentBy: string; sentTo?: string; contents: string[] } | undefined {
  const p = extra?.pack;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
  const o = p as Record<string, unknown>;
  if (typeof o.sentAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(o.sentAt)) return undefined;
  const contents = Array.isArray(o.contents) ? o.contents.filter((c): c is string => typeof c === 'string') : [];
  return {
    sentAt: o.sentAt.slice(0, 10),
    sentBy: typeof o.sentBy === 'string' ? o.sentBy : 'email',
    ...(typeof o.sentTo === 'string' ? { sentTo: o.sentTo } : {}),
    contents: contents.length ? contents : ['Covering letter', 'Hire account', "Engineer's report"],
  };
}

function chaserBuilder(rung: 7 | 14 | 21): Builder {
  return (b, base) => {
    const { bundle, ctx, now } = b;
    const today = datePart(now);
    let pack: { sentAt: ISODate; sentBy: string; sentTo?: string; contents: string[] } | undefined = packBlock(bundle);
    if (!pack) {
      // Manager mode (0.3 §A.6 B25): a chaser before the pack. The pack facts must then be typed (data.pack); without
      // them the template reports what is missing.
      refuseIn(b, conflict('NO_PAYMENT_PACK', 'No payment pack has been sent on this claim — the chaser ladder starts after the pack'));
      pack = typedPack(b.extra);
    }
    const hire = hireBlock(ctx, bundle, now);
    const storage = storageBlock(bundle, now);
    const heads = headSummaries(bundle)
      .filter((h) => h.claimedPence > 0)
      .map((h) => ({
        label:
          h.head === 'hire' && hire ? hireLabel(hire, h) : h.head === 'storage' && storage ? `Storage, ${storage.days} day${storage.days === 1 ? '' : 's'} at ${formatGBP(storage.dailyRatePence)} per day${h.invoiceReference ? ` (invoice ${h.invoiceReference})` : ''}` : `${h.label}${h.invoiceReference ? ` (invoice ${h.invoiceReference})` : ''}`,
        head: h.head,
        claimedPence: h.claimedPence,
        receivedPence: h.receivedPence,
        outstandingPence: h.outstandingPence,
      }));
    const totals = heads.reduce((t, h) => ({ claimedPence: t.claimedPence + h.claimedPence, receivedPence: t.receivedPence + h.receivedPence, outstandingPence: t.outstandingPence + h.outstandingPence }), { claimedPence: 0, receivedPence: 0, outstandingPence: 0 });
    const ncaf = ncafBlock(bundle);
    const claimNotifiedAt = ncaf?.sentAt ?? datePart(bundle.claim.openedAt);
    const previousLetters = bundle.documents.filter((d) => d.templateId.startsWith('letter.chaser_') && d.sentAt).map((d) => datePart(d.sentAt!)).sort();
    const clockKinds = [`chaser_day_${rung}`];
    const responseDeadline = deadline(bundle, today, 7, clockKinds);
    const data: Record<string, unknown> = {
      ...base,
      pack: pack ? { sentAt: pack.sentAt, sentBy: pack.sentBy, sentTo: pack.sentTo, contents: pack.contents } : undefined,
      hire: hire ? { startAt: hire.startAt, endAt: hire.endAt, days: hire.days, dailyRatePence: hire.dailyRatePence, gtaGroup: hire.gtaGroup } : undefined,
      heads,
      totals,
      payments: payments(bundle).map((p) => ({ date: p.date, amountPence: p.amountPence, reference: p.reference })),
      daysSincePack: pack ? calendarDaysBetween(pack.sentAt, today) : undefined,
      benchmarkDueAt: pack ? datePart(addCalendarMonths(pack.sentAt, 1)) : undefined,
      claimNotifiedAt,
      icobsReplyDueAt: datePart(addCalendarMonths(claimNotifiedAt, 3)),
      previousLetters: previousLetters.length ? previousLetters : undefined,
      responseDeadline,
    };
    if (rung === 21) {
      data.complaintDate = datePart(addWorkingDays(responseDeadline, 1));
      data.interestFromAt = data.benchmarkDueAt;
    }
    return data;
  };
}

const builders: Record<string, Builder> = {
  'letter.chaser_7': chaserBuilder(7),
  'letter.chaser_14': chaserBuilder(14),
  'letter.chaser_21': chaserBuilder(21),

  'letter.ncaf': (b, base) => {
    const { bundle, ctx, now } = b;
    const hire = hireBlock(ctx, bundle, now);
    const services: Array<{ kind: string; agreedAt: ISODateTime; startAt?: ISODateTime; detail?: string }> = [];
    const agreed = firstEvent(bundle, 'services_agreed')?.at ?? bundle.claim.openedAt;
    if (bundle.hire.length || bundle.claim.status === 'hire_active') services.push({ kind: 'hire', agreedAt: agreed, startAt: latestHire(bundle)?.startAt, detail: hire ? `${hire.vehicleDescription}, GTA group ${hire.gtaGroup} (industry benchmark)` : undefined });
    if (bundle.recovery.length) services.push({ kind: 'recovery', agreedAt: agreed, startAt: bundle.recovery[0]?.at, detail: bundle.recovery[0] ? `${bundle.recovery[0].fromLocation} to ${bundle.recovery[0].toLocation}` : undefined });
    if (bundle.storage.length) services.push({ kind: 'storage', agreedAt: agreed, startAt: bundle.storage[0]?.startAt, detail: bundle.storage[0]?.location });
    if (bundle.report || firstEvent(bundle, 'engineer_instructed')) services.push({ kind: 'engineer', agreedAt: agreed, startAt: firstEvent(bundle, 'engineer_instructed')?.at });
    const tp = bundle.thirdParties[0];
    return {
      ...base,
      claimant: { name: bundle.claimant.name, addressLines: addressLines(bundle.claimant), phone: bundle.claimant.phone, email: bundle.claimant.email },
      vehicle: { roadworthy: bundle.claim.accident.roadworthyAfter ?? bundle.claim.accident.driveable ?? false, location: bundle.storage[0]?.location },
      accident: { at: bundle.claim.accident.occurredAt, place: bundle.claim.accident.location, circumstances: bundle.claim.accident.circumstances, policeReference: bundle.claim.accident.policeReference },
      thirdParty: { driverName: tp?.name ?? '[third-party driver — name not yet known]', vehicleRegistration: bundle.thirdPartyVehicle?.registration ?? '[registration not yet known]', vehicleDescription: vehicleDescription(bundle.thirdPartyVehicle), insurerName: bundle.atFaultInsurer?.name ?? '[insurer]', policyNumber: bundle.claim.atFaultInsurerRef },
      services,
      gtaGroup: hire?.gtaGroup ?? bundle.vehicle.gtaGroup ?? 'S1',
      dailyRatePence: hire?.dailyRatePence ?? 0,
      hireVehicleDescription: hire?.vehicleDescription,
      handlingRefDueAt: deadline(bundle, datePart(now), 5, ['gta_4_2_handling_ref_5wd'], true),
    };
  },

  'letter.handling_ref_request': (b, base) => {
    const ncaf = ncafBlock(b.bundle);
    if (!ncaf) throw conflict('NO_NCAF', 'The New Claim Advice Form has not been sent yet');
    return { ...base, ncaf: { sentAt: ncaf.sentAt, sentBy: ncaf.sentBy, sentTo: ncaf.sentTo }, handlingRefDueAt: datePart(addWorkingDays(ncaf.sentAtIso, 5)), responseDeadline: deadline(b.bundle, datePart(b.now), 5, ['gta_4_2_handling_ref_5wd'], true) };
  },

  'letter.intervention_reply': (b, base) => {
    const { bundle, ctx, now } = b;
    // Newest first by instant (receivedAt strings may carry different offsets, so never sort them as text).
    const byNewest = [...bundle.offers].sort((x, y) => Date.parse(y.receivedAt) - Date.parse(x.receivedAt));
    const requested = typeof b.extra?.offerId === 'string' ? b.extra.offerId : undefined;
    if (requested && !bundle.offers.some((o) => o.id === requested)) throw notFound('intervention offer', requested);
    const offer = requested ? bundle.offers.find((o) => o.id === requested) : (byNewest.find((o) => !o.replySentAt) ?? byNewest[0]);
    if (!offer) throw conflict('NO_OFFER', 'No intervention offer is logged on this claim');
    if (offer.clientDecision === 'pending') throw conflict('OFFER_DECISION_PENDING', 'Record the client decision (accepted/declined with reasons) on the offer before replying');
    const supplied = (b.extra?.offer as { termsExplained?: unknown } | undefined)?.termsExplained;
    if (typeof supplied !== 'boolean') {
      throw badRequest('State whether the insurer explained the cost and terms of its offer to the claimant: data.offer.termsExplained = true or false (Copley v Lawn [2009] EWCA Civ 580). The letter states it as fact, so it must come from the handler, not be assumed.', { code: 'OFFER_TERMS_EXPLAINED_REQUIRED', field: 'offer.termsExplained' });
    }
    const hire = hireBlock(ctx, bundle, now);
    if (!hire) throw conflict('NO_HIRE', 'No hire agreement on this claim');
    return {
      ...base,
      offer: offerDetails(offer, bundle.atFaultInsurer?.name),
      hire: { vehicleDescription: hire.vehicleDescription, gtaGroup: hire.gtaGroup, dailyRatePence: hire.dailyRatePence, startAt: hire.startAt },
      responseDeadline: deadline(bundle, datePart(now), 5, ['intervention_reply_1wd'], true),
    };
  },

  'letter.collect_or_pay': (b, base) => {
    const { bundle, ctx, now } = b;
    const report = reportBlock(ctx, bundle);
    if (!report?.issuedAt) throw conflict('NO_REPORT', 'The engineer’s report has not been issued — the collect-or-pay notice goes on the day it issues');
    const storage = storageBlock(bundle, now);
    if (!storage) throw conflict('NO_STORAGE', 'No storage record on this claim');
    const collectBy = new Date(Date.parse(now) + 48 * 3_600_000).toISOString();
    return {
      ...base,
      report: { issuedAt: datePart(report.issuedAt), engineerName: report.engineerName, reference: report.reference, outcome: report.outcome, pavPence: report.pavPence },
      storage: { location: storage.location, startAt: storage.startAt, dailyRatePence: storage.dailyRatePence, daysToDate: storage.daysToDate, accruedToDatePence: storage.accruedToDatePence, addressLines: [storage.location] },
      collectBy,
      collectionContact: { name: (base.settings as CompanySettingsData).signatoryName, hours: 'Monday to Friday, 09:00 to 17:00' },
      copyToClaimant: true,
    };
  },

  'letter.delay_notice_gta_4_10': (b, base) => {
    const { bundle, ctx, now } = b;
    const hire = hireBlock(ctx, bundle, now);
    return { ...base, hire, chronology: chronology(bundle).filter((e) => ['repair_authorised', 'parts_ordered', 'parts_arrived', 'repair_started', 'repair_delay', 'estimate_received', 'report_issued'].includes(e.type)), responseDeadline: deadline(bundle, datePart(now), 3, ['gta_4_10_authorisation_check_3wd', 'gta_4_11_monitoring_5wd'], true) };
  },

  'invoice.hire': (b, base) => {
    const hire = hireBlock(b.ctx, b.bundle, b.now);
    if (!hire) throw conflict('NO_HIRE', 'No hire agreement on this claim');
    // Overridden: hireBlock already costs an open hire to now, so this is an interim invoice dated today.
    if (hire.open) refuseIn(b, conflict('HIRE_OPEN', 'Hire is still running — end the hire with its trigger before invoicing'));
    const head = headSummaries(b.bundle).find((h) => h.head === 'hire');
    return {
      ...base,
      invoiceNumber: head?.invoiceReference ?? `INV-H-${hire.agreementNumber.replace(/\D/g, '').slice(-6).padStart(6, '0')}`,
      taxPointDate: datePart(hire.endAt),
      vatRate: hire.vatRate,
      totals: { netPence: hire.netPence, vatPence: hire.vatPence, grossPence: hire.grossPence },
      receivedPence: head?.receivedPence,
      balancePence: head ? Math.max(0, hire.grossPence - head.receivedPence) : undefined,
      agreement: { agreementNumber: hire.agreementNumber, signedAt: hire.signedAt },
      vehicle: hire.vehicle ?? { registration: hire.vehicleRegistration ?? '[fleet vehicle]', make: '[make]', model: '[model]', gtaGroup: hire.gtaGroup },
      hire: { startAt: hire.startAt, endAt: hire.endAt, days: hire.days, dailyRatePence: hire.dailyRatePence, hirePence: hire.hirePence, endReason: hire.endReason },
    };
  },

  'invoice.storage': (b, base) => {
    const storage = storageBlock(b.bundle, b.now);
    if (!storage) throw conflict('NO_STORAGE', 'No storage record on this claim');
    if (storage.open) refuseIn(b, conflict('STORAGE_OPEN', 'Storage is still running — end it with its trigger before invoicing'));
    const head = headSummaries(b.bundle).find((h) => h.head === 'storage');
    const report = reportBlock(b.ctx, b.bundle);
    const notice = latestEvent(b.bundle, 'collect_or_pay_notice_sent');
    return {
      ...base,
      invoiceNumber: head?.invoiceReference ?? `INV-S-${b.bundle.claim.reference.slice(-5)}`,
      taxPointDate: datePart(storage.endAt),
      vatRate: storage.vatRate,
      totals: { netPence: storage.amountPence, vatPence: storage.vatPence, grossPence: storage.grossPence },
      receivedPence: head?.receivedPence,
      balancePence: head ? Math.max(0, storage.grossPence - head.receivedPence) : undefined,
      storage: { location: storage.location, startAt: storage.startAt, endAt: storage.endAt, days: storage.days, dailyRatePence: storage.dailyRatePence, amountPence: storage.amountPence, endReason: storage.endReason },
      reportIssuedAt: report?.issuedAt,
      collectOrPayNoticeSentAt: notice?.at,
      collectByAt: notice ? new Date(Date.parse(notice.at) + 48 * 3_600_000).toISOString() : undefined,
    };
  },

  'invoice.recovery': (b, base) => {
    const r = recoveryBlock(b.bundle);
    if (!r) throw conflict('NO_RECOVERY', 'No recovery record on this claim');
    const head = headSummaries(b.bundle).find((h) => h.head === 'recovery');
    return {
      ...base,
      invoiceNumber: head?.invoiceReference ?? `INV-R-${b.bundle.claim.reference.slice(-5)}`,
      taxPointDate: datePart(r.at),
      vatRate: r.vatRate,
      totals: { netPence: r.netPence, vatPence: r.vatPence, grossPence: r.grossPence },
      receivedPence: head?.receivedPence,
      balancePence: head ? Math.max(0, r.grossPence - head.receivedPence) : undefined,
      recovery: { at: r.at, fromLocation: r.fromLocation, toLocation: r.toLocation, calloutPence: r.calloutPence, loadedMiles: r.loadedMiles, perLoadedMilePence: r.perLoadedMilePence, mileagePence: r.mileagePence, adminPence: r.adminPence },
    };
  },

  'invoice.engineer_fee': (b, base) => {
    const report = reportBlock(b.ctx, b.bundle);
    if (!report?.issuedAt) throw conflict('NO_REPORT', 'The engineer’s report has not been issued');
    const head = headSummaries(b.bundle).find((h) => h.head === 'engineer_fee');
    const vat = b.ctx.settings().rateCard.vatRate;
    const vatPence = Math.round(report.feePence * vat);
    return {
      ...base,
      invoiceNumber: head?.invoiceReference ?? `INV-E-${b.bundle.claim.reference.slice(-5)}`,
      taxPointDate: datePart(report.issuedAt),
      vatRate: vat,
      totals: { netPence: report.feePence, vatPence, grossPence: report.feePence + vatPence },
      receivedPence: head?.receivedPence,
      engineer: { name: report.engineerName, qualifications: report.engineerQualifications },
      instruction: { instructedAt: report.instructedAt, instructedBy: report.instructedBy },
      inspection: { basis: report.inspectionBasis, at: report.inspectionAt, place: report.inspectionPlace },
      report: { issuedAt: report.issuedAt, reference: report.reference, outcome: report.outcome === 'total_loss' ? `Total loss${report.pavPence ? `; PAV ${formatGBP(report.pavPence)}` : ''}` : report.roadworthy ? 'Repairable; roadworthy' : 'Repairable; unroadworthy' },
      feePence: report.feePence,
      forCourt: report.forCourt,
    };
  },

  'pack.gta_payment': (b, base) => {
    const { bundle, ctx, now } = b;
    const validation = validatePaymentPack(bundle);
    const final = bundle.documents.filter((d) => (d.status === 'approved' || d.status === 'sent' || d.status === 'signed') && d.templateId !== 'pack.gta_payment');
    const has = (prefix: string) => final.some((d) => d.templateId.startsWith(prefix));
    const present: string[] = ['covering_letter'];
    if (has('invoice.hire')) present.push('hire_invoice');
    if (has('form.mitigation_questionnaire')) present.push('mitigation_questionnaire');
    if (has('letter.ncaf') || bundle.events.some((e) => e.type === 'ncaf_sent')) present.push('advice_form');
    if (has('form.hire_period_validation')) present.push('hire_period_validation');
    if (has('report.engineer') || bundle.evidence.some((e) => e.kind === 'engineer_report')) present.push('engineer_report');
    if (has('invoice.storage')) present.push('storage_account');
    if (has('invoice.recovery')) present.push('recovery_account');
    if (has('form.statement_of_need')) present.push('statement_of_need');
    if (bundle.evidence.some((e) => e.kind === 'photo')) present.push('photographs');
    const notApplicable: string[] = [];
    if (!bundle.storage.length) notApplicable.push('storage_account');
    if (!bundle.recovery.length) notApplicable.push('recovery_account');
    if (!bundle.estimate && !bundle.ledger.some((e) => e.head === 'repair')) notApplicable.push('repair_account');
    const hire = hireBlock(ctx, bundle, now);
    if (!hire) throw conflict('NO_HIRE', 'No hire agreement on this claim — the payment pack is built around the hire account');
    const storage = storageBlock(bundle, now);
    const recovery = recoveryBlock(bundle);
    const report = reportBlock(ctx, bundle);
    const summaries = headSummaries(bundle);
    const vatOf = (head: HeadOfLoss) => bundle.ledger.filter((e) => e.head === head && (e.kind === 'invoiced' || e.kind === 'claimed')).sort((x, y) => (x.kind === 'invoiced' ? -1 : 1) - (y.kind === 'invoiced' ? -1 : 1))[0]?.vatPence ?? 0;
    const kindOf = (head: HeadOfLoss): string => (['hire', 'recovery', 'storage', 'engineer_fee', 'repair', 'excess'].includes(head) ? head : 'other');
    const heads = summaries
      .filter((h) => h.claimedPence > 0 && h.head !== 'pav')
      .map((h) => {
        const vat = vatOf(h.head);
        const detail = h.head === 'hire' ? `${hire.days} day${hire.days === 1 ? '' : 's'} at ${formatGBP(hire.dailyRatePence)} per day, GTA group ${hire.gtaGroup} (industry benchmark)` : h.head === 'storage' && storage ? `${storage.days} day${storage.days === 1 ? '' : 's'} at ${formatGBP(storage.dailyRatePence)} per day` : h.head === 'recovery' && recovery ? `${recovery.loadedMiles} loaded miles at ${formatGBP(recovery.perLoadedMilePence)} per mile plus call-out and administration` : undefined;
        return { kind: kindOf(h.head), label: h.label, detail, invoiceNumber: h.invoiceReference ?? `${h.label} account`, netPence: h.claimedPence, vatPence: vat, grossPence: h.claimedPence + vat };
      });
    const totals = heads.reduce((t, h) => ({ netPence: t.netPence + h.netPence, vatPence: t.vatPence + h.vatPence, grossPence: t.grossPence + h.grossPence }), { netPence: 0, vatPence: 0, grossPence: 0 });
    const route: 'repair' | 'total_loss' = report?.outcome === 'total_loss' || bundle.events.some((e) => e.type === 'total_loss_confirmed') ? 'total_loss' : 'repair';
    const milestoneTypes: Array<ClaimEvent['type']> = ['fnol', 'services_agreed', 'recovery', 'hire_started', 'ncaf_sent', 'engineer_instructed', 'inspection', 'report_issued', 'estimate_received', 'repair_authorised', 'parts_ordered', 'parts_arrived', 'repair_started', 'repair_completed', 'total_loss_confirmed', 'pav_agreed', 'tl_payment_received', 'vehicle_returned', 'hire_ended', 'storage_ended'];
    const milestones = [...bundle.events].filter((e) => milestoneTypes.includes(e.type)).sort((x, y) => x.at.localeCompare(y.at)).map((e) => ({ label: e.summary, date: e.at, source: `event ${e.id.slice(0, 8)}` }));
    const monitoringCalls = [...bundle.events].filter((e) => e.type === 'call' || e.type === 'repair_delay').sort((x, y) => x.at.localeCompare(y.at)).map((e) => ({ at: e.at, spokeTo: e.attributableTo ?? 'repairer', outcome: e.summary }));
    const delayNotices = bundle.documents.filter((d) => d.templateId === 'letter.delay_notice_gta_4_10' && d.sentAt).map((d) => datePart(d.sentAt!));
    return {
      ...base,
      present,
      notApplicable: notApplicable.filter((x) => !present.includes(x)),
      heads,
      totals,
      settlementDueBy: datePart(addCalendarMonths(now, 1)),
      hire: { vehicleDescription: hire.vehicleDescription, registration: hire.vehicleRegistration ?? '[fleet vehicle]', gtaGroup: hire.gtaGroup, startAt: hire.startAt, endAt: hire.endAt, days: hire.days, dailyRatePence: hire.dailyRatePence, endTrigger: hire.endTrigger ?? 'manual', odometerOut: latestHire(bundle)?.odometerOut, odometerIn: latestHire(bundle)?.odometerIn },
      validation: { claimantVehicleRoadworthy: bundle.claim.accident.roadworthyAfter ?? false, claimantVehicleLocation: bundle.storage[0]?.location, route, milestones, monitoringCalls, delayNoticesSentAt: delayNotices.length ? delayNotices : undefined },
      components: final.filter((d) => d.pdfPath).map((d) => ({ documentId: d.id, templateId: d.templateId, title: d.title })),
      contents: final.map((d) => d.title),
      packValidation: { complete: validation.complete, missing: validation.missing, draftOnly: validation.draftOnly },
      pav: bundle.pav ? { pavPence: bundle.pav.pavPence, medianPence: bundle.pav.medianPence } : undefined,
    };
  },

  'report.engineer': (b, base) => {
    const { bundle, ctx } = b;
    const r = bundle.report;
    if (!r) throw conflict('NO_REPORT', 'No engineer’s report on this claim');
    const engineer = ctx.repos.getParty(ctx.db, r.engineerPartyId);
    const v = bundle.vehicle;
    const estimate = r.estimateId ? ctx.repos.getEstimate(ctx.db, r.estimateId) ?? bundle.estimate : bundle.estimate;
    const pav = r.pavAssessmentId ? ctx.repos.getPav(ctx.db, r.pavAssessmentId) ?? bundle.pav : bundle.pav;
    const latestOdo = [...v.odometer].sort((x, y) => y.date.localeCompare(x.date))[0];
    const lastMot = v.motHistory?.slice().sort((x, y) => y.completedDate.localeCompare(x.completedDate))[0];
    const photos = bundle.evidence.filter((e) => r.photoEvidenceIds.includes(e.id)).map((e) => ({ src: evidenceDataUrl(ctx, e) ?? `evidence/${e.id}`, caption: e.description ?? e.captureShot?.replace(/_/g, ' ') ?? e.filename, sha256: e.sha256, capturedAt: e.capturedAt, evidenceId: e.id }));
    const isTl = r.totalLoss?.decision === 'total_loss' || bundle.events.some((e) => e.type === 'total_loss_confirmed');
    return {
      ...base,
      report: { reference: `ENG-${bundle.claim.reference.slice(-5)}-${r.id.slice(0, 4).toUpperCase()}`, issuedAt: r.issuedAt ?? b.now, forCourt: r.forCourt, feePence: r.feePence },
      instructions: { instructedBy: r.instructedBy, instructedAt: r.instructedAt, purpose: 'To inspect the vehicle and report on the damage, its consistency with the stated circumstances, roadworthiness, the repair method and cost or, where the vehicle is beyond economic repair, the pre-accident value and salvage category.' },
      engineer: { name: engineer?.name ?? '[engineer]', qualifications: r.engineerQualifications, independence: `Instructed by ${r.instructedBy}; the engineer’s fee is not contingent on the outcome.` },
      inspection: { basis: r.inspectionBasis, at: r.inspectionAt, place: r.inspectionPlace, conditions: r.inspectionConditions },
      vehicle: {
        registration: v.registration,
        vin: v.vin,
        make: v.make,
        model: v.model,
        variant: v.variant,
        colour: v.colour,
        fuelType: v.fuelType,
        transmission: v.transmission,
        firstRegistered: v.monthOfFirstRegistration,
        yearOfManufacture: v.yearOfManufacture,
        engineCapacityCc: v.engineCapacityCc,
        odometer: { miles: r.odometerMiles ?? latestOdo?.miles ?? 0, source: r.odometerMiles !== undefined ? 'engineer' : latestOdo?.source ?? 'manual', date: r.odometerMiles !== undefined ? r.inspectionAt : latestOdo?.date },
        mot: { status: v.motStatus ?? (v.motExpiryDate ? (v.motExpiryDate >= datePart(b.now) ? 'Valid' : 'Expired') : 'Not known'), expiryDate: v.motExpiryDate, lastTest: lastMot ? { date: lastMot.completedDate, result: lastMot.result, odometerMiles: lastMot.odometerMiles } : undefined },
        previousWriteOffCategory: v.previousWriteOffCategory,
      },
      circumstances: bundle.claim.accident.circumstances,
      preAccidentCondition: r.preAccidentCondition,
      damage: { description: r.damageDescription, consistentWithCircumstances: r.consistentWithCircumstances, consistencyNote: r.consistencyNote },
      photos,
      repair: {
        method: r.repairMethod,
        estimate: estimate ? { ...estimate, lines: estimate.lines, reference: `EST-${estimate.id.slice(0, 8).toUpperCase()}`, basis: estimate.lines.some((l) => l.source === 'import') ? 'Imported bodyshop estimate reconciled line by line; pre-existing damage separated.' : 'Manual estimate; labour times from CCGUK’s own labour library (medians of approved estimates).' } : undefined,
        roadworthy: r.roadworthy,
        roadworthyReason: r.roadworthyReason,
        durationWorkingDays: r.repairDurationWorkingDays,
      },
      totalLoss: r.totalLoss,
      pav: pav ? { pavPence: pav.pavPence, medianPence: pav.medianPence, iqrLowPence: pav.iqrLowPence, iqrHighPence: pav.iqrHighPence, comparablesUsed: pav.comparables.filter((c) => !c.excluded).length, comparablesExcluded: pav.comparables.filter((c) => c.excluded).length, tradeGuidePence: pav.tradeGuidePence, tradeGuideSource: pav.tradeGuideSource, overrideReason: pav.overrideReason } : undefined,
      salvage: r.salvageCategory && r.salvageValuePence !== undefined ? { category: r.salvageCategory, valuePence: r.salvageValuePence, source: r.totalLoss?.salvageSource ?? 'estimate' } : undefined,
      adasNotes: r.adasNotes,
      evNotes: r.evNotes,
      diagnosticFaultCodes: r.diagnosticFaultCodes,
      opinion: [
        r.damageDescription ? `The damage described above is ${r.consistentWithCircumstances ? 'consistent' : 'not consistent'} with the circumstances reported.` : undefined,
        isTl ? `The vehicle is beyond economic repair${pav ? `; pre-accident value ${formatGBP(pav.pavPence)}` : ''}${r.salvageCategory ? `, salvage category ${r.salvageCategory}` : ''}.` : estimate ? `The vehicle is repairable at a net cost of ${formatGBP(estimate.totals.netPence)}${r.repairDurationWorkingDays ? ` over ${r.repairDurationWorkingDays} working days` : ''}.` : undefined,
        `The vehicle is ${r.roadworthy ? 'roadworthy' : 'not roadworthy'}: ${r.roadworthyReason}`,
      ].filter(Boolean).join(' '),
    };
  },

  'report.pav': (b, base) => {
    const pav = b.bundle.pav;
    if (!pav) throw conflict('NO_PAV', 'No PAV assessment on this claim');
    const approver = pav.approvedBy ? b.ctx.repos.getUser(b.ctx.db, pav.approvedBy) ?? undefined : undefined;
    const approverParty = !approver && pav.approvedBy ? b.ctx.repos.getParty(b.ctx.db, pav.approvedBy) : undefined;
    return {
      ...base,
      report: { reference: `PAV-${b.bundle.claim.reference.slice(-5)}-${pav.id.slice(0, 4).toUpperCase()}`, issuedAt: pav.approvedAt ?? pav.createdAt },
      subject: { ...pav.subject, vin: b.bundle.vehicle.vin, firstRegistered: b.bundle.vehicle.monthOfFirstRegistration ? `${b.bundle.vehicle.monthOfFirstRegistration}-01` : undefined },
      criteria: { yearTolerance: 1, mileageTolerancePct: 25, radiusMiles: 50, minimumComparables: 3 },
      comparables: pav.comparables,
      perMilePence: pav.perMilePence,
      perMileSource: pav.perMileSource,
      medianPence: pav.medianPence,
      iqrLowPence: pav.iqrLowPence,
      iqrHighPence: pav.iqrHighPence,
      tradeGuidePence: pav.tradeGuidePence,
      tradeGuideSource: pav.tradeGuideSource,
      pavPence: pav.pavPence,
      overrideReason: pav.overrideReason,
      reasoning: pav.reasoning,
      auditTrail: [
        { at: pav.createdAt, action: 'Assessment computed', detail: `${pav.comparables.length} comparables; ${pav.comparables.filter((c) => c.excluded).length} excluded` },
        ...(pav.approvedAt ? [{ at: pav.approvedAt, action: 'Approved by the engineer', by: approver?.name ?? approverParty?.name ?? pav.approvedBy }] : []),
      ],
      approver: { name: approver?.name ?? approverParty?.name ?? '[engineer]', role: 'Engineer', approvedAt: pav.approvedAt ?? pav.createdAt },
    };
  },

  'letter.pav_challenge': (b, base) => {
    const pav = b.bundle.pav;
    if (!pav) throw conflict('NO_PAV', 'No PAV assessment on this claim');
    const offer = latestEvent(b.bundle, 'pav_offer_received');
    return {
      ...base,
      ourPav: { pavPence: pav.pavPence, medianPence: pav.medianPence, iqrLowPence: pav.iqrLowPence, iqrHighPence: pav.iqrHighPence, perMilePence: pav.perMilePence, perMileSource: pav.perMileSource, reasoning: pav.reasoning },
      comparables: pav.comparables.map((c) => ({ source: c.source, capturedAt: c.capturedAt, year: c.year, mileage: c.mileage, pricePence: c.pricePence, normalisedPricePence: c.normalisedPricePence, excluded: c.excluded, exclusionReason: c.exclusionReason, seller: c.seller, distanceMiles: c.distanceMiles })),
      insurerOffer: offer ? { receivedAt: offer.at, amountPence: typeof offer.data?.amountPence === 'number' ? offer.data.amountPence : undefined, summary: offer.summary } : undefined,
      responseDeadline: deadline(b.bundle, datePart(b.now), 14, []),
    };
  },

  'agreement.credit_hire': (b, base) => {
    const hire = hireBlock(b.ctx, b.bundle, b.now);
    if (!hire) throw conflict('NO_HIRE', 'No hire agreement on this claim');
    const h = latestHire(b.bundle)!;
    const c = b.bundle.claimant;
    const drivers = h.additionalDrivers.map((d) => { const p = b.ctx.repos.getParty(b.ctx.db, d.partyId); return { name: p?.name ?? d.partyId, dateOfBirth: p?.dateOfBirth, nonStandardRisk: d.nonStandardRisk }; });
    return {
      ...base,
      recipient: recipientBlock(c),
      agreementNumber: h.agreementNumber,
      createdAt: b.now,
      hirer: { name: c.name, addressLines: addressLines(c), dateOfBirth: c.dateOfBirth, email: c.email, phone: c.phone, licence: c.drivingLicenceNumber ? { number: c.drivingLicenceNumber, countryOfIssue: 'United Kingdom' } : undefined },
      vehicle: { registration: hire.vehicleRegistration ?? '[fleet vehicle]', makeModel: hire.vehicleDescription, gtaGroup: h.gtaGroup, odometerOut: h.odometerOut },
      hire: { startAt: h.startAt, deliveryAddressLines: addressLines(c) },
      charges: { dailyRatePence: h.dailyRatePence, vatRate: h.vatRate, excessPence: h.excessPence, excessWaiverDailyPence: h.excessWaiverDailyPence },
      credit: { maxInstalments: 12, finalPaymentDueBy: datePart(addCalendarDays(addCalendarMonths(b.now, 12), -1)) },
      additionalDrivers: drivers,
      cancellation: { informationProvidedAt: h.enforceability.cancellationInfoProvidedAt ?? b.now, sch3FormProvidedAt: h.enforceability.schedule3FormProvidedAt },
    };
  },

  'form.cancellation_sch3': (b, base) => {
    const hire = hireBlock(b.ctx, b.bundle, b.now);
    const c = b.bundle.claimant;
    // Hire-start pack before the handover (SUPREME-AUTOPILOT §D.6, ap-paperwork): the confirmed booking fixes these facts.
    const booked = hire ? undefined : reservationHireData(b.ctx, b.extra?.reservationId, b.bundle.claim.id);
    if (booked) return { ...base, recipient: recipientBlock(c), agreementNumber: booked.agreementNumber, agreementDate: datePart(b.now), hirer: { name: c.name, addressLines: addressLines(c) }, vehicle: { registration: booked.vehicleRegistration, makeModel: booked.vehicleDescription } };
    if (!hire) throw conflict('NO_HIRE', 'No hire agreement on this claim');
    return { ...base, recipient: recipientBlock(c), agreementNumber: hire.agreementNumber, agreementDate: datePart(hire.signedAt ?? hire.startAt), hirer: { name: c.name, addressLines: addressLines(c) }, vehicle: { registration: hire.vehicleRegistration ?? '[fleet vehicle]', makeModel: hire.vehicleDescription } };
  },

  'form.express_request_to_start': (b, base) => {
    const hire = hireBlock(b.ctx, b.bundle, b.now);
    // Hire-start pack before the handover (SUPREME-AUTOPILOT §D.6, ap-paperwork): the confirmed booking fixes these facts.
    const booked = hire ? undefined : reservationHireData(b.ctx, b.extra?.reservationId, b.bundle.claim.id);
    if (booked) {
      const c = b.bundle.claimant;
      return { ...base, recipient: recipientBlock(c), agreementNumber: booked.agreementNumber, createdAt: b.now, hirer: { name: c.name, addressLines: addressLines(c) }, vehicle: { registration: booked.vehicleRegistration, makeModel: booked.vehicleDescription }, hire: { startAt: booked.startAt }, charges: { dailyRatePence: booked.dailyRatePence, vatRate: booked.vatRate }, cancellationInfoProvidedAt: b.now };
    }
    if (!hire) throw conflict('NO_HIRE', 'No hire agreement on this claim');
    const h = latestHire(b.bundle)!;
    const c = b.bundle.claimant;
    return { ...base, recipient: recipientBlock(c), agreementNumber: h.agreementNumber, createdAt: b.now, hirer: { name: c.name, addressLines: addressLines(c) }, vehicle: { registration: hire.vehicleRegistration ?? '[fleet vehicle]', makeModel: hire.vehicleDescription }, hire: { startAt: h.startAt }, charges: { dailyRatePence: h.dailyRatePence, vatRate: h.vatRate }, cancellationInfoProvidedAt: h.enforceability.cancellationInfoProvidedAt ?? b.now };
  },

  'form.mitigation_questionnaire': (b, base) => {
    const hire = hireBlock(b.ctx, b.bundle, b.now);
    if (!hire) throw conflict('NO_HIRE', 'No hire agreement on this claim');
    const c = b.bundle.claimant;
    return { ...base, recipient: recipientBlock(c), createdAt: b.now, hirer: { name: c.name, addressLines: addressLines(c) }, hire: { agreementNumber: hire.agreementNumber, agreedAt: firstEvent(b.bundle, 'services_agreed')?.at ?? b.bundle.claim.openedAt, startAt: hire.startAt, vehicleDescription: hire.vehicleDescription, registration: hire.vehicleRegistration ?? '[fleet vehicle]', gtaGroup: hire.gtaGroup }, offers: b.bundle.offers.map((o) => offerDetails(o, b.bundle.atFaultInsurer?.name)) };
  },

  'form.statement_of_means': (b, base) => {
    const c = b.bundle.claimant;
    return { ...base, recipient: recipientBlock(c), createdAt: b.now, claimant: { name: c.name, addressLines: addressLines(c) } };
  },

  'form.statement_of_need': (b, base) => {
    const c = b.bundle.claimant;
    return { ...base, recipient: recipientBlock(c), createdAt: b.now, claimant: { name: c.name, addressLines: addressLines(c) }, ownVehicleRoadworthy: b.bundle.claim.accident.roadworthyAfter ?? false };
  },

  'schedule.loss': (b, base) => {
    const summaries = headSummaries(b.bundle);
    const hire = hireBlock(b.ctx, b.bundle, b.now);
    const storage = storageBlock(b.bundle, b.now);
    const recovery = recoveryBlock(b.bundle);
    const vatOf = (head: HeadOfLoss) => b.bundle.ledger.filter((e) => e.head === head && (e.kind === 'invoiced' || e.kind === 'claimed')).sort((x, y) => (x.kind === 'invoiced' ? -1 : 1) - (y.kind === 'invoiced' ? -1 : 1))[0]?.vatPence ?? 0;
    const heads = summaries.filter((h) => h.claimedPence > 0).map((h) => {
      const claimedRow = b.bundle.ledger.find((e) => e.head === h.head && e.kind === 'claimed');
      const detail = h.head === 'hire' && hire ? `${hire.days} days at ${formatGBP(hire.dailyRatePence)} per day` : h.head === 'storage' && storage ? `${storage.days} days at ${formatGBP(storage.dailyRatePence)} per day` : h.head === 'recovery' && recovery ? `${recovery.loadedMiles} loaded miles at ${formatGBP(recovery.perLoadedMilePence)} per mile` : undefined;
      return { head: h.head, description: claimedRow?.description ?? h.label, detail, netPence: h.claimedPence, vatPence: vatOf(h.head), sourceDocument: h.invoiceReference ?? (h.head === 'pav' ? 'Engineer’s report / PAV assessment' : h.head === 'hire' && hire ? `Hire agreement ${hire.agreementNumber}` : `${h.label} account`), status: h.outstandingPence === 0 ? 'paid' : h.receivedPence > 0 ? 'offered' : 'claimed' as const };
    });
    const net = heads.reduce((t, h) => t + h.netPence, 0);
    const vat = heads.reduce((t, h) => t + (h.vatPence ?? 0), 0);
    const received = summaries.reduce((t, h) => t + h.receivedPence, 0);
    return { ...base, schedule: { asAt: b.now, purpose: 'Pre-action' }, heads, payments: payments(b.bundle), totals: { netPence: net, vatPence: vat, grossPence: net + vat, receivedPence: received, interestPence: 0, totalPence: net + vat - received } };
  },
};

/** Generic blocks every other template can read (free-text fields come from the handler). */
export function genericBuilder(b: BuildInput, base: Record<string, unknown>): Record<string, unknown> {
  const { bundle, ctx, now } = b;
  const heads = headSummaries(bundle);
  const pack = packBlock(bundle);
  const ncaf = ncafBlock(bundle);
  return {
    ...base,
    heads,
    totals: heads.reduce((t, h) => ({ claimedPence: t.claimedPence + h.claimedPence, receivedPence: t.receivedPence + h.receivedPence, outstandingPence: t.outstandingPence + h.outstandingPence }), { claimedPence: 0, receivedPence: 0, outstandingPence: 0 }),
    payments: payments(bundle),
    hire: hireBlock(ctx, bundle, now),
    storage: storageBlock(bundle, now),
    recovery: recoveryBlock(bundle),
    report: reportBlock(ctx, bundle),
    pav: bundle.pav ? { pavPence: bundle.pav.pavPence, medianPence: bundle.pav.medianPence } : undefined,
    pack: pack ? { sentAt: pack.sentAt, sentBy: pack.sentBy, contents: pack.contents } : undefined,
    ncaf: ncaf ? { sentAt: ncaf.sentAt, sentBy: ncaf.sentBy, sentTo: ncaf.sentTo } : undefined,
    offers: bundle.offers.map((o) => offerDetails(o, bundle.atFaultInsurer?.name)),
    chronology: chronology(bundle),
    claimant: { name: bundle.claimant.name, addressLines: addressLines(bundle.claimant), phone: bundle.claimant.phone, email: bundle.claimant.email },
    accident: bundle.claim.accident,
    responseDeadline: deadline(bundle, datePart(now), 14, []),
  };
}

// ---------------------------------------------------------------------------
// Merge with the handler's extra fields (derived wins; conflicts are refused)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function leafPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) out.push(...leafPaths(v, p));
    else out.push(p);
  }
  return out;
}

function mergeExtra(extra: Record<string, unknown>, derived: Record<string, unknown>, path: string, conflicts: string[], preferExtra = false): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extra };
  for (const [k, dv] of Object.entries(derived)) {
    const p = path ? `${path}.${k}` : k;
    const ev = extra[k];
    if (dv === undefined) {
      if (ev !== undefined) out[k] = ev;
      continue;
    }
    if (ev === undefined) {
      out[k] = dv;
      continue;
    }
    if (isPlainObject(dv) && isPlainObject(ev)) {
      out[k] = mergeExtra(ev, dv, p, conflicts, preferExtra);
      continue;
    }
    const differs = JSON.stringify(ev) !== JSON.stringify(dv);
    if (differs) conflicts.push(p);
    out[k] = differs && preferExtra ? ev : dv;
  }
  return out;
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v);
    return out as T;
  }
  return value;
}

export interface AssembleOptions {
  extra?: Record<string, unknown>;
  recipientPartyId?: Id;
  recipientRole?: RecipientRole;
  /** Manager-mode override gate of the request (absent = strict). */
  gate?: OverrideGate;
}

/**
 * Build the data object a template renders from. Refuses 400 EXTRA_OVERRIDES_LEDGER (through the override gate) when
 * extra fields collide with derived ones; overridden in manager mode, the typed values win.
 */
export function assembleTemplateData(ctx: AppContext, bundle: ClaimBundle, templateId: string, templateRole: RecipientRole | undefined, user: BuildInput['user'], opts: AssembleOptions = {}): AssembledData {
  const now = ctx.now();
  const recipientRole: RecipientRole = opts.recipientRole ?? templateRole ?? 'other';
  const recipient = resolveRecipient(ctx, bundle, recipientRole, opts.recipientPartyId);
  const settings = companySettings(ctx.settings(), user);
  const base: Record<string, unknown> = {
    settings,
    date: now,
    claim: claimHeader(bundle),
    recipient,
    signatory: { name: settings.signatoryName, role: settings.signatoryRole },
    claimId: bundle.claim.id,
    templateId,
  };
  const builder = builders[templateId] ?? litigationBuilders[templateId] ?? correspondenceBuilders[templateId] ?? genericBuilder;
  const derived = stripUndefined(builder({ ctx, bundle, templateId, recipientRole, recipientPartyId: opts.recipientPartyId, user, now, extra: opts.extra, ...(opts.gate ? { gate: opts.gate } : {}) }, base));
  const conflicts: string[] = [];
  const extra = stripUndefined(opts.extra ?? {});
  let merged = mergeExtra(extra, derived, '', conflicts);
  if (conflicts.length) {
    // details.code is kept for callers written against the 0.2 shape (VALIDATION + details.code).
    refuseIn(
      { gate: opts.gate, bundle, templateId },
      new HttpError(400, 'EXTRA_OVERRIDES_LEDGER', `These fields are taken from the ledger/chronology and cannot be supplied by hand: ${conflicts.join(', ')}`, { code: 'EXTRA_OVERRIDES_LEDGER', fields: conflicts }),
    );
    merged = mergeExtra(extra, derived, '', [], true);
  }
  return { data: merged, recipientRole, recipientPartyId: recipient?.partyId ?? opts.recipientPartyId, derivedKeys: leafPaths(derived) };
}

/** Templates addressed to the at-fault insurer when the registry gives no recipientRole. */
export function defaultRecipientRole(templateId: string): RecipientRole {
  if (templateId.startsWith('invoice.') || templateId.startsWith('pack.') || templateId === 'schedule.loss') return 'at_fault_insurer';
  if (templateId.startsWith('agreement.') || templateId.startsWith('form.') || templateId === 'letter.client_update') return 'client';
  if (templateId.startsWith('notice.') || templateId.startsWith('certificate.') || templateId === 'letter.cctv_preservation') return 'other';
  if (templateId.startsWith('letter.supplier')) return 'supplier';
  return 'at_fault_insurer';
}

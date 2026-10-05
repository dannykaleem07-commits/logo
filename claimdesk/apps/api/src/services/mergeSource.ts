/**
 * buildMergeSource — the MergeSource (TEMPLATES-VEHICLES-DESKTOP §B.2) the DOCX field resolvers read, built from the
 * claim bundle plus the repo look-ups the bundle does not carry: the client's own insurer, users, the hire fleet unit /
 * vehicle / policy, merged GTA rates (KB + manual rows), the recipient and a response deadline.
 *
 * Pure data out (no functions), so the values used can be snapshotted with the generated document. Nothing here
 * invents a value: absent data stays absent and the resolvers leave the box blank.
 */
import { canonicalTemplateId, type ClaimBundle, type Evidence, type GeneratedDocument, type Id, type Party } from '@ccguk/domain';
import { brand, formatRegisteredOffice, type MergeCompany, type MergeDocumentRef, type MergeEvidenceRef, type MergeHire, type MergeRecipient, type MergeSource, type MergeUser } from '@ccguk/documents';
import type { UserRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { companySettings, datePart, deadline, headSummaries, latestHire, resolveRecipient, type RecipientRole } from './documentData.js';
import { loadBundle } from './claimView.js';
import { gtaRatesFor } from './kb.js';

export interface MergeSubject {
  witnessPartyId?: string;
  offerId?: string;
  hireAgreementId?: string;
  recipientPartyId?: string;
  exhibitEvidenceIds?: string[];
}

export interface DocUserLike {
  id: Id;
  name: string;
  role: string;
}

export interface BuildMergeSourceOptions {
  /** The template's recipient role (letters): the recipient is resolved from it unless subject.recipientPartyId names one. */
  recipientRole?: RecipientRole;
  /** Clock kinds that bound the response deadline (TEMPLATE_CLOCKS of the canonical template id). */
  deadlineClockKinds?: string[];
  /** Days allowed for a reply (default 14 calendar days, never before a running clock). */
  deadlineDays?: number;
  /** Re-generation of an existing document (post-event fields). */
  thisDocument?: GeneratedDocument;
  /** A bundle already loaded (with HTML) by the caller. */
  bundle?: ClaimBundle;
}

function mergeUser(ctx: AppContext, u: Pick<UserRecord, 'id' | 'name' | 'role' | 'email'> | DocUserLike | undefined): MergeUser | undefined {
  if (!u) return undefined;
  const roleLabel = companySettings(ctx.settings(), { id: u.id, name: u.name, role: u.role }).signatoryRole;
  const out: MergeUser = { id: u.id, name: u.name, roleLabel };
  const email = (u as { email?: string }).email;
  if (email) out.email = email;
  return out;
}

/** Settings + brand → the company block. Bank details only ever come from Settings (never invented, §B.5 rule 4). */
export function mergeCompany(ctx: AppContext): MergeCompany {
  const s = ctx.settings();
  const c = brand.company;
  const out: MergeCompany = {
    registeredName: s.companyName || c.registeredName,
    tradingName: c.tradingName,
    companyNumber: s.companyNumber || c.companyNumber,
    registeredOffice: formatRegisteredOffice(s.registeredOffice),
    caseHandlerPhone: c.caseHandlerPhone,
    officePhone: c.officePhone,
    email: c.claimsEmail,
    website: c.website,
    director: { name: c.director.name, role: c.director.role },
    rateCard: { ...s.rateCard },
  };
  if (s.vatNumber) out.vatNumber = s.vatNumber;
  if (s.icoRegistration) out.icoRegistration = s.icoRegistration;
  if (s.bank && s.bank.sortCode && s.bank.accountNumber) {
    out.bank = { accountName: s.bank.accountName, sortCode: s.bank.sortCode, accountNumber: s.bank.accountNumber, ...(s.bank.bankName ? { bankName: s.bank.bankName } : {}) };
  }
  return out;
}

function evidenceRef(e: Evidence): MergeEvidenceRef {
  const out: MergeEvidenceRef = { id: e.id, kind: e.kind, filename: e.filename, uploadedAt: e.uploadedAt };
  if (e.description) out.description = e.description;
  if (e.capturedAt) out.capturedAt = e.capturedAt;
  if (e.sourceUrl) out.sourceUrl = e.sourceUrl;
  if (e.exif && (e.exif.make || e.exif.model || e.exif.dateTimeOriginal)) {
    out.exif = { ...(e.exif.make ? { make: e.exif.make } : {}), ...(e.exif.model ? { model: e.exif.model } : {}), ...(e.exif.dateTimeOriginal ? { dateTimeOriginal: e.exif.dateTimeOriginal } : {}) };
  }
  return out;
}

function snapshotSubject(d: GeneratedDocument): MergeSubject | undefined {
  const docx = d.dataSnapshot?._docx as { subject?: MergeSubject } | undefined;
  return docx?.subject;
}

export function documentRef(ctx: AppContext, d: GeneratedDocument, userNames: Map<string, string>): MergeDocumentRef {
  const out: MergeDocumentRef = { id: d.id, templateId: d.templateId, canonicalTemplateId: canonicalTemplateId(d.templateId), title: d.title, status: d.status, createdAt: d.createdAt };
  if (d.approvedAt) out.approvedAt = d.approvedAt;
  if (d.sentAt) out.sentAt = d.sentAt;
  if (d.recipientPartyId) out.recipientPartyId = d.recipientPartyId;
  if (d.signature?.signedAt) out.signedAt = d.signature.signedAt;
  const subjectParty = snapshotSubject(d)?.witnessPartyId;
  if (subjectParty) out.subjectPartyId = subjectParty;
  if (d.approvedBy) {
    const name = userNames.get(d.approvedBy) ?? ctx.repos.getUser(ctx.db, d.approvedBy)?.name;
    if (name) out.approvedByName = name;
  }
  return out;
}

function withRole(parties: Array<Party | undefined>, role: Party['roles'][number]): Party | undefined {
  return parties.find((p): p is Party => Boolean(p && p.roles.includes(role)));
}

/**
 * Build the merge source for a claim. `subject` picks the witness (04), offer (08; default the latest offer), hire (03/06/07; default the latest
 * hire), recipient (letters) and exhibits (04). Unknown subject ids are refused (400) rather than silently ignored.
 */
export function buildMergeSource(ctx: AppContext, claimId: string, user: DocUserLike, subject: MergeSubject = {}, opts: BuildMergeSourceOptions = {}): MergeSource {
  const bundle = opts.bundle ?? loadBundle(ctx, claimId, true);
  const now = ctx.now();
  const users = ctx.repos.listUsers(ctx.db);
  const userNames = new Map(users.map((u) => [u.id, u.name]));
  const others = bundle.thirdParties;
  const witnesses = others.filter((p) => p.roles.includes('witness'));
  const thirdPartyDrivers = others.filter((p) => !p.roles.includes('witness') && (p.roles.includes('third_party_driver') || p.roles.includes('third_party')));

  let witness: Party | undefined;
  if (subject.witnessPartyId) {
    witness = witnesses.find((p) => p.id === subject.witnessPartyId) ?? (subject.witnessPartyId === bundle.claimant.id ? bundle.claimant : undefined) ?? ctx.repos.getParty(ctx.db, subject.witnessPartyId);
    if (!witness) throw badRequest(`witnessPartyId ${subject.witnessPartyId} not found`);
  }

  const evidence = bundle.evidence.map(evidenceRef);
  const exhibits: MergeEvidenceRef[] = [];
  for (const id of subject.exhibitEvidenceIds ?? []) {
    const e = evidence.find((x) => x.id === id);
    if (!e) throw badRequest(`exhibit evidence ${id} is not on this claim`);
    exhibits.push(e);
  }

  const agreement = subject.hireAgreementId ? bundle.hire.find((h) => h.id === subject.hireAgreementId) : latestHire(bundle);
  if (subject.hireAgreementId && !agreement) throw badRequest(`hireAgreementId ${subject.hireAgreementId} is not on this claim`);
  let hire: MergeHire | undefined;
  if (agreement) {
    hire = { agreement };
    const unit = ctx.repos.getFleetUnit(ctx.db, agreement.fleetUnitId);
    if (unit) {
      hire.fleetUnit = unit;
      const v = ctx.repos.getVehicle(ctx.db, unit.vehicleId);
      if (v) hire.vehicle = v;
      const pol = unit.policyId ? ctx.repos.getPolicy(ctx.db, unit.policyId) : undefined;
      if (pol) hire.policy = pol;
    }
  }

  let offer = undefined as MergeSource['offer'];
  if (subject.offerId) {
    offer = bundle.offers.find((o) => o.id === subject.offerId);
    if (!offer) throw badRequest(`offerId ${subject.offerId} is not on this claim`);
  } else if (bundle.offers.length) {
    // like the hire, the offer defaults to the latest one on the claim: a claim with an offer never prints a
    // mitigation record with neither "offer made" nor "no offer made" ticked
    offer = [...bundle.offers].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
  }

  const ownInsurer = bundle.claim.clientInsurerId ? ctx.repos.getParty(ctx.db, bundle.claim.clientInsurerId) : undefined;
  const engineer = bundle.report?.engineerPartyId ? ctx.repos.getParty(ctx.db, bundle.report.engineerPartyId) : withRole(others, 'engineer');
  const keeper = withRole([bundle.claimant, bundle.driver, ...others], 'keeper');
  const recoveryAgent = withRole(others, 'recovery_agent');

  let recipient: MergeRecipient | undefined;
  if (opts.recipientRole || subject.recipientPartyId) {
    const role: RecipientRole = subject.recipientPartyId && bundle.claim.clientInsurerId === subject.recipientPartyId ? 'own_insurer' : (opts.recipientRole ?? 'other');
    const block = resolveRecipient(ctx, bundle, role, subject.recipientPartyId);
    if (block) {
      recipient = { name: block.name, addressLines: block.addressLines.filter((l) => l && l !== '[address to be confirmed]'), role };
      if (block.partyId) recipient.partyId = block.partyId;
      if (block.attention) recipient.attention = block.attention;
      if (block.email) recipient.email = block.email;
      const isAtFault = block.partyId !== undefined && block.partyId === bundle.claim.atFaultInsurerId;
      if (isAtFault && bundle.claim.atFaultInsurerRef) recipient.theirReference = bundle.claim.atFaultInsurerRef;
    }
  }

  const handler = bundle.claim.handlerId ? users.find((u) => u.id === bundle.claim.handlerId) : undefined;
  const userMerge = mergeUser(ctx, users.find((u) => u.id === user.id) ?? user)!;

  const source: MergeSource = {
    now,
    timeZone: 'Europe/London',
    company: mergeCompany(ctx),
    user: userMerge,
    claim: bundle.claim,
    claimant: bundle.claimant,
    vehicle: bundle.vehicle,
    thirdPartyDrivers,
    witnesses,
    exhibits,
    hires: bundle.hire,
    storage: bundle.storage,
    recovery: bundle.recovery,
    offers: bundle.offers,
    events: bundle.events,
    clocks: bundle.clocks,
    ledger: bundle.ledger,
    heads: headSummaries(bundle).map(({ reducedPence: _r, ...h }) => h),
    evidence,
    documents: bundle.documents.map((d) => documentRef(ctx, d, userNames)),
    gtaRates: gtaRatesFor(ctx),
    responseDeadline: deadline(bundle, datePart(now), opts.deadlineDays ?? 14, opts.deadlineClockKinds ?? []),
  };
  const caseHandler = mergeUser(ctx, handler);
  if (caseHandler) source.caseHandler = caseHandler;
  if (bundle.driver) source.driver = bundle.driver;
  if (keeper) source.keeper = keeper;
  if (bundle.thirdPartyVehicle) source.thirdPartyVehicle = bundle.thirdPartyVehicle;
  if (bundle.atFaultInsurer) source.atFaultInsurer = bundle.atFaultInsurer;
  if (ownInsurer) source.ownInsurer = ownInsurer;
  if (witness) source.witness = witness;
  if (hire) source.hire = hire;
  if (bundle.report) source.report = bundle.report;
  if (engineer) source.engineer = engineer;
  if (bundle.estimate) source.estimate = bundle.estimate;
  if (bundle.pav) source.pav = bundle.pav;
  if (offer) source.offer = offer;
  if (recipient) source.recipient = recipient;
  if (recoveryAgent) source.recoveryAgent = recoveryAgent;
  if (opts.thisDocument) source.thisDocument = documentRef(ctx, opts.thisDocument, userNames);
  return source;
}

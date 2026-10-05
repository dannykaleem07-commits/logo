/**
 * FIELD_DEFS — every merge field of design doc Appendix 1 (plus a few keys the built-in mappings need for blanks the
 * appendix describes without naming: option blanks, address lines, exhibit sub-fields). Each non-handler field has a
 * pure resolver over the MergeSource (§B.3 rules in derive.ts).
 */
import { gtaRate, londonDate } from '@ccguk/domain';
import { slugify } from '../text.js';
import {
  addressNoPostcode,
  addressOneLine,
  agreementOf,
  bool,
  byTime,
  choice,
  dataList,
  dataString,
  dateOf,
  dateTimeOf,
  engineFuel,
  eventsOfType,
  eventTo,
  firstRecovery,
  initials,
  initialsSurname,
  int,
  latestDocument,
  latestStorage,
  ledgerReference,
  list,
  longDate,
  makeModel,
  makeModelReg,
  money,
  notAfterNow,
  openStorage,
  ordinal,
  partyName,
  recoveryNet,
  regOf,
  rows,
  signedDocument,
  storageDays,
  subjectHire,
  thousands,
  timeOf,
  titleCase,
  transmissionCode,
  txt,
  userName,
  verbatim,
  yesIf
} from './derive.js';
import type { MergeSource } from './source.js';
import type { FieldDef, FieldGroup, FieldType, FieldValue, FillPolicy } from './types.js';

type Resolver = (src: MergeSource) => FieldValue | undefined;
type Choices = NonNullable<FieldDef['choices']>;

interface Opts {
  syn?: string[];
  choices?: Choices;
  aliases?: string[];
  overridable?: boolean;
  gta?: boolean;
  columns?: Record<string, string[]>;
}

function f(key: string, group: FieldGroup, type: FieldType, policy: FillPolicy, label: string, sourcePath: string, resolve?: Resolver, o: Opts = {}): FieldDef {
  const def: FieldDef = { key, group, label, type, policy, synonyms: [label.toLowerCase(), ...(o.syn ?? [])], sourcePath };
  if (resolve) def.resolve = resolve;
  if (o.choices) def.choices = o.choices;
  if (o.aliases) def.aliases = o.aliases;
  if (o.overridable === false) def.overridable = false;
  if (o.gta) def.requiresConfirmationUnlessVerified = true;
  if (o.columns) def.columns = o.columns;
  return def;
}

/** Handler-only field (no resolver; only a value typed by the handler ever prints). */
function h(key: string, group: FieldGroup, type: FieldType, label: string, o: Opts = {}): FieldDef {
  return f(key, group, type, 'handler', label, 'handler', undefined, o);
}

/** `ch(['yes', 'Yes'], ['no', 'No', 'none'])` — code, label, extra option-slug prefixes (the code's slug is implied). */
function ch(...items: Array<[string, string, ...string[]]>): Choices {
  const out: Choices = {};
  for (const [code, label, ...matches] of items) out[code] = { label, matches: matches.length ? matches : [slugify(code.replace(/_/g, '-'))] };
  return out;
}

const YES_NO = ch(['yes', 'Yes', 'yes'], ['no', 'No', 'no']);
const YES_NO_NA = ch(['yes', 'Yes', 'yes'], ['no', 'No', 'no'], ['na', 'N/A', 'n-a']);

// ---------------------------------------------------------------------------
// Small resolver helpers
// ---------------------------------------------------------------------------

const hireOf = (src: MergeSource) => agreementOf(src);
const hireVehicle = (src: MergeSource) => subjectHire(src)?.vehicle;
const accidentAt = (src: MergeSource) => src.claim.accident?.occurredAt;

function storageNet(src: MergeSource): number | undefined {
  const rec = latestStorage(src);
  const days = storageDays(rec);
  return rec && days !== undefined ? days * rec.dailyRatePence : undefined;
}

function firstInstructed(src: MergeSource): string | undefined {
  return eventsOfType(src, (t) => t === 'services_agreed')[0]?.at ?? src.claim.openedAt;
}

function mileageAtAccident(src: MergeSource): number | undefined {
  const at = accidentAt(src);
  if (!at) return undefined;
  const day = londonDate(at);
  const before = src.vehicle.odometer.filter((r) => r.date <= day && Number.isFinite(r.miles));
  const pick = (source?: string) => byTime(source ? before.filter((r) => r.source === source) : before, (r) => r.date).pop();
  return (pick('accident_report') ?? pick('client') ?? pick())?.miles;
}

function servicesFromFnol(src: MergeSource): string[] {
  return dataList(eventsOfType(src, (t) => t === 'fnol')[0], 'services');
}

function evidenceOfKinds(src: MergeSource, kinds: string[]) {
  return src.evidence.filter((e) => kinds.includes(e.kind));
}

function photos(src: MergeSource) {
  return src.evidence.filter((e) => e.kind === 'photo');
}

function tagged(src: MergeSource, tag: string) {
  return photos(src).filter((e) => (e.tags ?? []).includes(tag));
}

function evidenceStore(src: MergeSource): string {
  return `ClaimDesk evidence store, claim ${src.claim.reference}`;
}

function tpDriver(src: MergeSource) {
  const people = src.thirdPartyDrivers.filter((p) => !p.roles.includes('witness') || p.roles.includes('third_party_driver') || p.roles.includes('third_party'));
  return people.find((p) => p.roles.includes('third_party_driver')) ?? people.find((p) => p.roles.includes('third_party'));
}

function keeperCode(src: MergeSource): string | undefined {
  if (src.keeper) return src.keeper.id === src.claimant.id ? 'client' : 'other';
  return src.vehicle.ownership === 'client' ? 'client' : undefined;
}

function gtaRateValue(group: string | undefined, start: string | undefined, src: MergeSource): FieldValue | undefined {
  if (!group || !start) return undefined;
  const rate = gtaRate(group, londonDate(start), src.gtaRates);
  return rate ? money(rate.dailyRatePence, rate.verification.status) : undefined;
}

function headPresent(src: MergeSource, heads: string[]): boolean {
  return src.heads.some((h) => heads.includes(h.head)) || src.ledger.some((l) => heads.includes(l.head));
}

const OTHER_HEADS = ['loss_of_use', 'diminution', 'personal_effects', 'loss_of_earnings', 'travel', 'misc'];

function engineerDecision(src: MergeSource): string | undefined {
  const r = src.report;
  if (!r) return undefined;
  if (r.totalLoss?.decision === 'total_loss') return 'total_loss';
  if (r.totalLoss?.decision === 'repair') return 'repairable';
  if (r.salvageCategory) return 'total_loss';
  return undefined;
}

function reportSentTo(src: MergeSource, partyId: string | undefined, role: string): FieldValue | undefined {
  const docId = src.report?.documentId;
  if (!docId) return undefined;
  const e = eventsOfType(src, (t) => t === 'letter_out' || t === 'email_out').find((x) => x.documentId === docId && eventTo(x, partyId, role));
  return dateOf(e?.at);
}

function thisDocEvent(src: MergeSource, types: string[], partyId: string | undefined, role: string): FieldValue | undefined {
  const doc = src.thisDocument;
  if (!doc) return undefined;
  const e = eventsOfType(src, (t) => types.includes(t)).find((x) => x.documentId === doc.id && eventTo(x, partyId, role));
  return dateOf(e?.at);
}

function exhibitRows(src: MergeSource): Array<Record<string, string>> {
  const ini = initials(src.witness?.name);
  const total = src.exhibits.length;
  return src.exhibits.map((e, i) => {
    const captured = e.exif?.dateTimeOriginal ?? e.capturedAt;
    const device = [e.exif?.make, e.exif?.model].filter(Boolean).join(' ') || e.sourceUrl || '';
    const row: Record<string, string> = {
      ref: ini ? `${ini}${i + 1}` : '',
      item: (e.description ?? e.filename ?? '').trim(),
      pageOfTotal: `${i + 1} of ${total}`,
      capturedAt: captured ? (/T/.test(captured) ? `${longDate(captured)}, ${timeOf(captured)!.v}` : longDate(captured)) : '',
      deviceSource: device,
      originalHeldBy: `${src.company.registeredName} — claim file ${src.claim.reference}`
    };
    return row;
  });
}

function exhibitField(src: MergeSource, i: number, field: string): FieldValue | undefined {
  const e = src.exhibits[i];
  if (!e) return undefined;
  if (field === 'capturedAt') return dateTimeOf(e.exif?.dateTimeOriginal ?? e.capturedAt);
  if (field === 'ref') {
    const ini = initials(src.witness?.name);
    return ini ? txt(`${ini}${i + 1}`) : undefined;
  }
  if (field === 'pageOfTotal') return txt('1 of 1');
  return txt(exhibitRows(src)[i]?.[field]);
}

/** C1.5 evidence rows: (held, first date, reference). */
function evidenceRow(src: MergeSource, which: string): { date?: string; ref?: string } | undefined {
  const firstOf = (items: Array<{ at?: string; ref?: string }>) => byTime(items, (x) => x.at)[0] ?? items[0];
  switch (which) {
    case 'signedPack': {
      const d = signedDocument(src, 'agreement.ccguk_02_recovery_storage_engineering');
      return d ? { date: d.signedAt, ref: d.title } : undefined;
    }
    case 'recoveryJobSheet': {
      const ids = new Set(src.recovery.flatMap((r) => r.evidenceIds));
      const items = src.evidence.filter((e) => ids.has(e.id) || /job sheet|tracker/i.test(`${e.description ?? ''} ${e.filename}`));
      const x = firstOf(items.map((e) => ({ at: e.capturedAt ?? e.uploadedAt, ref: e.filename })));
      return x ? { date: x.at, ref: x.ref } : undefined;
    }
    case 'storageLog': {
      const ev = eventsOfType(src, (t) => t === 'storage_reason');
      return ev.length ? { date: ev[0]!.at, ref: `${ev.length} storage log entr${ev.length === 1 ? 'y' : 'ies'}` } : undefined;
    }
    case 'photos': {
      const p = byTime(photos(src), (e) => e.capturedAt ?? e.uploadedAt);
      return p.length ? { date: p[0]!.capturedAt ?? p[0]!.uploadedAt, ref: `${p.length} photograph${p.length === 1 ? '' : 's'}` } : undefined;
    }
    case 'engineerReport': {
      const e = evidenceOfKinds(src, ['engineer_report'])[0];
      if (e) return { date: e.uploadedAt, ref: e.filename };
      return src.report?.issuedAt ? { date: src.report.issuedAt } : undefined;
    }
    case 'insurerCorrespondence': {
      const items = byTime(evidenceOfKinds(src, ['correspondence']), (e) => e.uploadedAt);
      return items.length ? { date: items[0]!.uploadedAt, ref: items[0]!.filename } : undefined;
    }
    case 'invoices': {
      const inv = byTime(src.ledger.filter((l) => l.kind === 'invoiced'), (l) => l.date);
      return inv.length ? { date: inv[0]!.date, ref: inv.map((l) => l.reference).filter(Boolean).join(', ') || undefined } : undefined;
    }
    case 'remittance': {
      const paid = byTime(src.ledger.filter((l) => l.kind === 'paid' || l.kind === 'interim_paid'), (l) => l.date);
      return paid.length ? { date: paid[0]!.date, ref: paid[0]!.reference } : undefined;
    }
    default:
      return undefined;
  }
}

const EVIDENCE_ROWS: Array<[string, string]> = [
  ['signedPack', 'This pack, signed by the Client'],
  ['recoveryJobSheet', 'Recovery job sheet / tracker record'],
  ['storageLog', 'Storage intake, reasons and release log'],
  ['photos', 'Photographs (collection, entry, release)'],
  ['engineerReport', "Engineer's report"],
  ['insurerCorrespondence', 'Insurer correspondence'],
  ['invoices', 'Invoices and final account'],
  ['remittance', 'Remittance / settlement advice']
];

const CCTV_SOURCES: Array<[string, string]> = [
  ['client_dashcam', 'Client dashcam'],
  ['tp_dashcam', 'Third-party dashcam'],
  ['council', 'Council / traffic cameras'],
  ['bus_operator', 'Bus or coach operator'],
  ['shops', 'Shops and businesses at the scene'],
  ['petrol_station', 'Petrol station'],
  ['doorbell', 'Residential doorbell cameras'],
  ['other', 'Other']
];

/** 06 condition matrix panels as printed (slug → camelCase key part). */
export const CONDITION_PANELS: Array<[string, string]> = [
  ['frontBumper', 'Front bumper'],
  ['bonnet', 'Bonnet'],
  ['nearsideFrontWing', 'Nearside front wing'],
  ['offsideFrontWing', 'Offside front wing'],
  ['nearsideFrontDoor', 'Nearside front door'],
  ['offsideFrontDoor', 'Offside front door'],
  ['nearsideRearDoor', 'Nearside rear door'],
  ['offsideRearDoor', 'Offside rear door'],
  ['nearsideRearQuarter', 'Nearside rear quarter'],
  ['offsideRearQuarter', 'Offside rear quarter'],
  ['rearBumper', 'Rear bumper'],
  ['bootTailgate', 'Boot / tailgate'],
  ['roof', 'Roof'],
  ['windscreen', 'Windscreen'],
  ['rearScreen', 'Rear screen'],
  ['nearsideMirror', 'Nearside mirror'],
  ['offsideMirror', 'Offside mirror'],
  ['lightsAndLenses', 'Lights & lenses'],
  ['wheelTyreNsf', 'Wheel / tyre — NSF'],
  ['wheelTyreOsf', 'Wheel / tyre — OSF'],
  ['wheelTyreNsr', 'Wheel / tyre — NSR'],
  ['wheelTyreOsr', 'Wheel / tyre — OSR'],
  ['spareWheelKit', 'Spare wheel / kit'],
  ['interiorTrim', 'Interior trim'],
  ['seatsAndUpholstery', 'Seats & upholstery'],
  ['loadAreaBootFloor', 'Load area / boot floor']
];

const MEANS_INCOME: Array<[string, string]> = [
  ['employedNetPay', 'Employed net pay'],
  ['selfEmployedDrawings', 'Self-employed net drawings'],
  ['universalCredit', 'Universal Credit'],
  ['pipDla', 'PIP / DLA'],
  ['childBenefit', 'Child Benefit'],
  ['housingBenefit', 'Housing Benefit / housing element'],
  ['pension', 'Pension'],
  ['other', 'Other income']
];

const MEANS_OUTGOINGS: Array<[string, string]> = [
  ['rentMortgage', 'Rent or mortgage'],
  ['councilTax', 'Council tax'],
  ['utilities', 'Gas, electricity and water'],
  ['foodHousehold', 'Food and household'],
  ['telecoms', 'Telephone, broadband and TV'],
  ['vehicleInsurance', 'Vehicle insurance'],
  ['fuelTravel', 'Fuel and travel'],
  ['loans', 'Loan repayments'],
  ['cardRepayments', 'Credit and store card repayments'],
  ['childcare', 'Childcare'],
  ['other', 'Other essential outgoings']
];

const MEANS_DOCS: Array<[string, string, string[]]> = [
  ['bankStatements', 'Bank statements (three months, every account)', ['bank_statement']],
  ['payslips', 'Payslips (three months)', ['payslip']],
  ['benefitLetters', 'Benefit award letters / Universal Credit statements', ['benefit_letter', 'universal_credit_statement']],
  ['creditCardStatements', 'Credit card statements', ['credit_card_statement']],
  ['overdraftEvidence', 'Evidence of any overdraft limit', ['overdraft_evidence']],
  ['rentCouncilTaxEvidence', 'Evidence of rent or mortgage and council tax', ['rent_evidence', 'council_tax_evidence', 'mortgage_statement']]
];

// ---------------------------------------------------------------------------
// The dictionary
// ---------------------------------------------------------------------------

const C = 'Company';
const D = 'Document';
const HD = 'Handler';

const defs: FieldDef[] = [
  // A1.1 Company
  f('company.registeredName', C, 'text', 'auto', 'Company registered name', 'brand.company.registeredName', (s) => txt(s.company.registeredName), { syn: ['company name', 'registered name', 'lessor', 'credit hire provider', 'company'] }),
  f('company.tradingName', C, 'text', 'auto', 'Trading name', 'brand.company.tradingName', (s) => txt(s.company.tradingName), { syn: ['trading as', 'trading name'] }),
  f('company.number', C, 'text', 'auto', 'Company number', 'settings.companyNumber ?? brand.company.companyNumber', (s) => txt(s.company.companyNumber), { syn: ['company no', 'company number', 'company registration number'] }),
  f('company.registeredOffice', C, 'text', 'auto', 'Registered office', 'formatRegisteredOffice(settings.registeredOffice)', (s) => txt(s.company.registeredOffice), { syn: ['registered office', 'company address', 'our address'] }),
  f('company.caseHandlerPhone', C, 'text', 'auto', 'Case handler telephone', 'brand.company.caseHandlerPhone', (s) => txt(s.company.caseHandlerPhone), { syn: ['case handler telephone', 'our mobile'] }),
  f('company.officePhone', C, 'text', 'auto', 'Office telephone', 'brand.company.officePhone', (s) => txt(s.company.officePhone), { syn: ['office', 'office telephone', 'our telephone'] }),
  f('company.email', C, 'text', 'auto', 'Claims email', 'brand.company.claimsEmail', (s) => txt(s.company.email), { syn: ['our email', 'claims email'] }),
  f('company.website', C, 'text', 'auto', 'Website', 'brand.company.website', (s) => txt(s.company.website), { syn: ['website', 'web'] }),
  f('company.director', C, 'text', 'never', 'Authorised signatory', 'brand.company.director (checks only)', (s) => txt(`${s.company.director.name} — ${s.company.director.role}`), { syn: ['director', 'authorised signatory'] }),
  f('company.vatNumber', C, 'text', 'auto-if-known', 'VAT number', 'settings.vatNumber', (s) => txt(s.company.vatNumber), { syn: ['vat number', 'vat registration'] }),
  f('company.icoRegistration', C, 'text', 'auto-if-known', 'ICO registration', 'settings.icoRegistration', (s) => txt(s.company.icoRegistration), { syn: ['ico', 'ico registration'] }),
  f('company.bank.accountName', C, 'text', 'auto', 'Account name', 'settings.bank.accountName', (s) => txt(s.company.bank?.accountName), { syn: ['account name', 'payee'], overridable: false }),
  f('company.bank.bankName', C, 'text', 'auto', 'Bank', 'settings.bank.bankName', (s) => txt(s.company.bank?.bankName), { syn: ['bank', 'bank name'], overridable: false }),
  f('company.bank.sortCode', C, 'text', 'auto', 'Sort code', 'settings.bank.sortCode', (s) => txt(s.company.bank?.sortCode), { syn: ['sort code'], overridable: false }),
  f('company.bank.accountNumber', C, 'text', 'auto', 'Account number', 'settings.bank.accountNumber', (s) => txt(s.company.bank?.accountNumber), { syn: ['account number', 'account no'], overridable: false }),

  // Document
  f('doc.date', D, 'date', 'suggest', 'Document date (today)', 'src.now', (s) => dateOf(s.now), { syn: ['date', 'document date', 'today', 'date of form'] }),
  f('doc.dateToday', D, 'date', 'auto', 'Date completed (today)', 'src.now', (s) => dateOf(s.now), { syn: ['date completed', 'position recorded as at'] }),
  f('doc.dateLong', D, 'date', 'auto', 'Letter date', 'src.now', (s) => dateOf(s.now), { syn: ['date of letter'] }),
  f('doc.agreementRef', D, 'text', 'auto', 'Agreement reference', 'bundle.claim.reference (no separate series yet)', (s) => txt(s.claim.reference), { syn: ['agreement ref', 'agreement reference'] }),
  h('doc.subject', D, 'text', 'Subject line', { syn: ['subject', 're', 'subject of this letter'] }),
  h('doc.body.paragraphs', D, 'list', 'Letter paragraphs', { syn: ['paragraphs', 'body'] }),
  f('doc.replyByDate', D, 'date', 'suggest', 'Reply by', 'src.responseDeadline', (s) => (s.responseDeadline ? { t: 'date', v: s.responseDeadline } : undefined), { syn: ['reply by', 'respond by', 'deadline'] }),
  f('doc.valediction', D, 'text', 'auto', 'Yours …', 'faithfully when the salutation is "Sir or Madam", else sincerely', (s) => txt(s.recipient ? 'faithfully' : undefined), { syn: ['yours', 'sincerely faithfully'] }),
  h('doc.enclosures', D, 'list', 'Enclosures', { syn: ['enc', 'enclosures'] }),
  h('doc.cc', D, 'list', 'Copies to', { syn: ['cc', 'copies'] }),
  f('doc.signedDate', D, 'date', 'post-event', 'Date the form was signed', 'SignatureRecord.signedAt of this document (re-generation only)', (s) => dateOf(s.thisDocument?.signedAt), { syn: ['date taken'] }),
  h('doc.copyToClientAt', D, 'date', 'Copy given to client on', { syn: ['copy given to client on'] }),
  h('doc.copyToClientMethod', D, 'choice', 'Copy given by', { syn: ['method'], choices: ch(['in_person', 'In person', 'in-person'], ['email', 'Email', 'email'], ['post', 'Post', 'post']) }),
  f('doc.sentToTpInsurerAt', D, 'date', 'post-event', 'Sent to third-party insurer on', 'letter_out/email_out of this document to the at-fault insurer', (s) => thisDocEvent(s, ['letter_out', 'email_out'], s.atFaultInsurer?.id, 'at_fault_insurer'), { syn: ['sent to third party insurer on'] }),
  f('doc.sentToOwnInsurerAt', D, 'date', 'post-event', 'Sent to own insurer on', 'letter_out/email_out of this document to the own insurer', (s) => thisDocEvent(s, ['letter_out', 'email_out'], s.ownInsurer?.id, 'own_insurer'), { syn: ['sent to own insurer on'] }),
  f('doc.insurerAcknowledgedAt', D, 'date', 'post-event', 'Acknowledged by insurer on', 'letter_in/email_in acknowledging this document', (s) => {
    const doc = s.thisDocument;
    if (!doc) return undefined;
    const e = eventsOfType(s, (t) => t === 'letter_in' || t === 'email_in').find((x) => x.documentId === doc.id || dataString(x, 'acknowledgesDocumentId') === doc.id);
    return dateOf(e?.at);
  }, { syn: ['acknowledged by insurer on'] }),
  f('doc.reviewedBy', D, 'text', 'post-event', 'Reviewed by', 'approvedBy of this document (re-generation only)', (s) => txt(s.thisDocument?.approvedByName), { syn: ['reviewed by'] }),
  f('doc.reviewedOn', D, 'date', 'post-event', 'Reviewed on', 'approvedAt of this document (re-generation only)', (s) => dateOf(s.thisDocument?.approvedAt), { syn: ['reviewed on'] }),

  // Handler
  f('handler.name', HD, 'text', 'auto', 'Your name (person producing the document)', 'src.user.name', (s) => txt(s.user.name), { syn: ['form completed by', 'recorded by', 'form taken by', 'full name ccguk', 'released by', 'checked by'] }),
  f('handler.position', HD, 'text', 'auto', 'Your position', 'src.user.roleLabel', (s) => txt(s.user.roleLabel), { syn: ['position', 'role'] }),
  f('handler.caseHandler', HD, 'text', 'auto', 'Case handler', 'src.caseHandler?.name ?? src.user.name', (s) => txt(s.caseHandler?.name ?? s.user.name), { syn: ['case handler'] }),
  f('handler.contact', HD, 'text', 'auto', 'Case handler contact', '`${company.caseHandlerPhone} · ${company.email}`', (s) => txt(`${s.company.caseHandlerPhone} · ${s.company.email}`), { syn: ['contact'] }),

  // A1.2 Claim
  f('claim.reference', 'Claim', 'text', 'auto', 'Our reference', 'bundle.claim.reference', (s) => txt(s.claim.reference), { syn: ['reference', 'our ref', 'ccguk reference', 'claim ref', 'file ref', 'ccguk reference allocated'] }),
  f('claim.openedAt', 'Claim', 'date', 'auto-if-known', 'File opened', 'bundle.claim.openedAt', (s) => dateOf(s.claim.openedAt), { syn: ['file opened', 'date opened'] }),
  f('claim.firstInstructedAt', 'Claim', 'date', 'auto-if-known', 'First instructed on', "first services_agreed event, else claim.openedAt", (s) => dateOf(firstInstructed(s)), { syn: ['first appointed', 'instructed on'] }),
  f('claim.retrospectiveAppointment', 'Claim', 'bool', 'suggest', 'Signed after CCGUK began acting', 'date(src.now) > date(claim.firstInstructedAt)', (s) => {
    const first = firstInstructed(s);
    return first ? bool(londonDate(s.now) > londonDate(first)) : undefined;
  }, { syn: ['signed after ccguk began acting'] }),
  f('claim.liability', 'Claim', 'choice', 'auto-if-known', 'Liability', 'bundle.claim.liability (split → none)', (s) => {
    const l = s.claim.liability;
    if (l === 'admitted') return choice('admitted');
    if (l === 'denied' || l === 'disputed') return choice('disputed');
    if (l === 'unknown') return choice('awaited');
    return undefined;
  }, { syn: ['liability'], choices: ch(['admitted', 'Admitted', 'admitted'], ['disputed', 'Disputed', 'disputed'], ['awaited', 'Awaited', 'awaited']) }),
  f('claim.liabilityDate', 'Claim', 'date', 'auto-if-known', 'Liability decided on', "latest event whose type starts 'liability_'", (s) => dateOf(eventsOfType(s, (t) => t.startsWith('liability_')).pop()?.at), { syn: ['liability date'] }),
  h('claim.settlementAuthority', 'Claim', 'choice', 'Settlement authority', { syn: ['settlement authority'], choices: ch(['standard', 'Standard authority', 'standard-authority', 'standard'], ['full', 'Full settlement authority', 'full-settlement-authority', 'full']) }),
  h('claim.agreementMadeAt', 'Claim', 'choice', 'How the agreement was made', { syn: ['how this agreement was made'], choices: ch(['premises', 'At CCGUK premises', 'at-ccguks-premises', 'this-agreement-was-concluded-at-ccguks', 'not-applicable'], ['away', 'Away from CCGUK premises', 'away-from', 'this-agreement-was-concluded-away'], ['distance', 'At a distance', 'at-a-distance', 'this-agreement-was-concluded-at-a-distance']) }),
  f('claim.clientAuthoritySigned', 'Claim', 'bool', 'auto-if-known', 'Signed client authority held', "documents[] agreement.ccguk_01_customer_loa with status 'signed'", (s) => yesIf(!!signedDocument(s, 'agreement.ccguk_01_customer_loa')), { syn: ['signed client authority held'] }),
  f('claim.clientAuthoritySignedOn', 'Claim', 'date', 'auto-if-known', 'Client authority signed on', 'that document’s signedAt', (s) => dateOf(signedDocument(s, 'agreement.ccguk_01_customer_loa')?.signedAt), { syn: ['dated'] }),
  f('claim.ledgerOpened', 'Claim', 'bool', 'auto', 'Ledger opened', 'true (every ClaimDesk claim has a ledger)', () => bool(true), { syn: ['ledger opened'] }),

  // Client
  f('claimant.name', 'Client', 'text', 'auto', 'Client full name', 'bundle.claimant.name', (s) => txt(s.claimant.name), { syn: ['customer full name', 'client full name', 'client', 'full name', 'hirer full name', 'title and full name', 'name', 'full name of client'], aliases: ['claimant.fullName'] }),
  f('claimant.initialsSurname', 'Client', 'text', 'auto', 'Client initials and surname', 'derived from bundle.claimant.name', (s) => txt(initialsSurname(s.claimant.name)), { syn: ['initials and surname'] }),
  f('claimant.dateOfBirth', 'Client', 'date', 'auto-if-known', 'Date of birth', 'bundle.claimant.dateOfBirth', (s) => (s.claimant.dateOfBirth ? { t: 'date', v: londonDate(s.claimant.dateOfBirth) } : undefined), { syn: ['date of birth', 'dob'] }),
  f('claimant.address', 'Client', 'text', 'auto-if-known', 'Address with postcode', 'formatAddressInline(bundle.claimant.address)', (s) => txt(addressOneLine(s.claimant.address)), { syn: ['address', 'address and postcode', 'home address', 'hirer address'], aliases: ['claimant.addressFull', 'claimant.addressInline'] }),
  f('claimant.addressNoPostcode', 'Client', 'text', 'auto-if-known', 'Address without postcode', 'address lines without postcode', (s) => txt(addressNoPostcode(s.claimant.address)), { syn: ['address when a postcode cell follows'] }),
  f('claimant.postcode', 'Client', 'text', 'auto-if-known', 'Postcode', 'bundle.claimant.address.postcode (upper case)', (s) => txt(s.claimant.address?.postcode?.toUpperCase()), { syn: ['postcode'] }),
  f('claimant.phone', 'Client', 'text', 'auto-if-known', 'Telephone', 'bundle.claimant.phone', (s) => txt(s.claimant.phone), { syn: ['telephone', 'mobile', 'phone', 'tel'] }),
  f('claimant.email', 'Client', 'text', 'auto-if-known', 'Email', 'bundle.claimant.email', (s) => txt(s.claimant.email), { syn: ['email', 'e-mail'] }),
  f('claimant.drivingLicenceNumber', 'Client', 'text', 'auto-if-known', 'Driving licence number', 'bundle.claimant.drivingLicenceNumber', (s) => txt(s.claimant.drivingLicenceNumber), { syn: ['driving licence no', 'licence number', 'licence no'] }),
  h('claimant.licenceType', 'Client', 'text', 'Licence type', { syn: ['licence type'] }),
  h('claimant.licenceHeldYears', 'Client', 'int', 'Licence held for (years)', { syn: ['licence held for'] }),
  h('claimant.licenceHeldSince', 'Client', 'date', 'Licence held since', { syn: ['licence held since'] }),
  h('claimant.occupation', 'Client', 'text', 'Occupation', { syn: ['occupation'] }),
  h('claimant.isPcoDriver', 'Client', 'bool', 'PCO / private hire driver', { syn: ['pco', 'private hire driver'] }),
  h('claimant.pcoBadgeNumber', 'Client', 'text', 'PCO badge number', { syn: ['badge no'] }),
  h('claimant.idSeen', 'Client', 'choice', 'ID seen', { syn: ['id seen'], choices: ch(['driving_licence', 'Driving licence', 'driving-licence'], ['passport', 'Passport', 'passport']) }),
  f('claimant.photoIdVerified', 'Client', 'bool', 'auto-if-known', 'Photo ID verified', "true only when a licence/passport/photo ID evidence item is verified; never false", (s) => yesIf(s.evidence.some((e) => ['licence', 'passport', 'photo_id', 'driving_licence'].includes(e.kind) && e.verification?.status === 'verified')), { syn: ['photo id verified'] }),
  h('claimant.consentDisputeReferral', 'Client', 'bool', 'Consents to dispute referral', { syn: ['i consent to ccguk sharing'] }),

  // A1.3 Client vehicle
  f('vehicle.registration', 'Client vehicle', 'text', 'auto', 'Registration', 'formatRegistration(bundle.vehicle.registration)', (s) => txt(regOf(s.vehicle)), { syn: ['registration', 'reg', 'vehicle reg', 'reg no', 'registration number', 'vrm'] }),
  f('vehicle.make', 'Client vehicle', 'text', 'auto', 'Make', 'bundle.vehicle.make', (s) => txt(s.vehicle.make), { syn: ['make'] }),
  f('vehicle.model', 'Client vehicle', 'text', 'auto', 'Model', 'bundle.vehicle.model', (s) => txt(s.vehicle.model), { syn: ['model'] }),
  f('vehicle.makeModel', 'Client vehicle', 'text', 'auto', 'Make & model', 'make + model (+ variant when ≤ 20 chars)', (s) => txt(makeModel(s.vehicle)), { syn: ['make and model', 'vehicle make model', 'vehicle', 'make model'] }),
  f('vehicle.makeModelReg', 'Client vehicle', 'text', 'auto', 'Vehicle and registration', 'make model — REG', (s) => txt(makeModelReg(s.vehicle)), { syn: ['vehicle registration', 'claimant vehicle', 'make model reg'] }),
  f('vehicle.vin', 'Client vehicle', 'text', 'auto-if-known', 'VIN', 'bundle.vehicle.vin', (s) => txt(s.vehicle.vin?.toUpperCase()), { syn: ['vin', 'chassis number'] }),
  f('vehicle.colour', 'Client vehicle', 'text', 'auto-if-known', 'Colour', 'bundle.vehicle.colour (title case)', (s) => txt(s.vehicle.colour ? titleCase(s.vehicle.colour) : undefined), { syn: ['colour', 'color'] }),
  f('vehicle.fuelType', 'Client vehicle', 'choice', 'auto-if-known', 'Fuel', 'bundle.vehicle.fuelType', (s) => choice(s.vehicle.fuelType), {
    syn: ['fuel', 'fuel type'],
    choices: ch(['petrol', 'Petrol', 'petrol'], ['diesel', 'Diesel', 'diesel'], ['hybrid', 'Hybrid', 'hybrid'], ['plugin_hybrid', 'Plug-in hybrid', 'hybrid', 'plug-in', 'phev'], ['electric', 'Electric', 'ev', 'electric'], ['lpg', 'LPG', 'lpg'], ['other', 'Other', 'other'])
  }),
  f('vehicle.transmission', 'Client vehicle', 'choice', 'auto-if-known', 'Transmission', 'bundle.vehicle.transmission (unknown → none)', (s) => choice(transmissionCode(s.vehicle)), { syn: ['transmission', 'gearbox', 'transmission required'], choices: ch(['manual', 'Manual', 'manual'], ['automatic', 'Automatic', 'automatic']) }),
  f('vehicle.engineFuel', 'Client vehicle', 'text', 'auto-if-known', 'Engine / fuel', 'engineCapacityCc + fuel label', (s) => txt(engineFuel(s.vehicle)), { syn: ['engine fuel', 'engine'] }),
  f('vehicle.firstRegistered', 'Client vehicle', 'date', 'auto-if-known', 'First registered', 'bundle.vehicle.monthOfFirstRegistration (month precision)', (s) => (/^\d{4}-\d{2}$/.test(s.vehicle.monthOfFirstRegistration ?? '') ? { t: 'date', v: s.vehicle.monthOfFirstRegistration!, precision: 'month' } : undefined), { syn: ['first registered', 'date of first registration'] }),
  f('vehicle.yearOfManufacture', 'Client vehicle', 'int', 'auto-if-known', 'Year', 'bundle.vehicle.yearOfManufacture', (s) => int(s.vehicle.yearOfManufacture), { syn: ['year', 'year of manufacture'] }),
  f('vehicle.mileageAtAccident', 'Client vehicle', 'int', 'auto-if-known', 'Mileage', 'latest odometer reading on/before the accident (accident_report, then client); never a later reading', (s) => int(mileageAtAccident(s), 'miles'), { syn: ['mileage', 'odometer'], aliases: ['vehicle.mileage', 'vehicle.odometerAtInstruction'] }),
  f('vehicle.yearMileage', 'Client vehicle', 'text', 'auto-if-known', 'Year / mileage', '`2019 / 48,210 miles`', (s) => {
    const y = s.vehicle.yearOfManufacture;
    const m = mileageAtAccident(s);
    const parts = [y ? String(y) : undefined, m !== undefined ? `${thousands(m)} miles` : undefined].filter(Boolean);
    return parts.length ? txt(parts.join(' / ')) : undefined;
  }, { syn: ['year mileage'] }),
  f('vehicle.gtaGroup', 'Client vehicle', 'text', 'auto-if-known', 'GTA group (own class)', 'bundle.vehicle.gtaGroup', (s) => txt(s.vehicle.gtaGroup), { syn: ['gta group', 'gta comparator group', 'own vehicle class'] }),
  f('vehicle.classDescription', 'Client vehicle', 'text', 'suggest', 'Class of damaged vehicle', '`Group <gtaGroup> <bodyType>`', (s) => (s.vehicle.gtaGroup ? txt(`Group ${s.vehicle.gtaGroup}${s.vehicle.bodyType ? ` ${s.vehicle.bodyType}` : ''}`) : undefined), { syn: ['my damaged vehicle is'] }),
  f('vehicle.registeredKeeper', 'Client vehicle', 'choice', 'auto-if-known', 'Registered keeper', 'keeper party = claimant or ownership client → client; other keeper → other', (s) => choice(keeperCode(s)), { syn: ['registered keeper'], choices: ch(['client', 'Client', 'client'], ['other', 'Other', 'other']) }),
  f('vehicle.registeredKeeperName', 'Client vehicle', 'text', 'auto-if-known', 'Registered keeper name', 'keeper party name, else claimant name when ownership is client', (s) => txt(s.keeper?.name ?? (s.vehicle.ownership === 'client' ? s.claimant.name : undefined)), { syn: ['registered keeper name'] }),
  h('vehicle.keeperNameRelationship', 'Client vehicle', 'text', 'Keeper name and relationship', { syn: ['other name and relationship'] }),
  h('vehicle.financeOrLease', 'Client vehicle', 'bool', 'Finance or lease', { syn: ['finance', 'finance or lease'], choices: ch(['yes', 'Yes', 'yes'], ['no', 'No', 'no', 'none']) }),
  h('vehicle.financeLender', 'Client vehicle', 'text', 'Finance lender', { syn: ['lender', 'provider'] }),
  h('vehicle.financeOutstandingPence', 'Client vehicle', 'money', 'Finance outstanding balance', { syn: ['outstanding balance'] }),
  h('vehicle.ownerIfDifferent', 'Client vehicle', 'text', 'Owner if different', { syn: ['owner if different'] }),
  h('vehicle.preExistingDamage', 'Client vehicle', 'bool', 'Pre-existing damage', { syn: ['any pre-existing damage'] }),
  f('vehicle.panelsDamaged', 'Client vehicle', 'text', 'suggest', 'Panels damaged', 'bundle.report.damageDescription', (s) => txt(s.report?.damageDescription), { syn: ['panels damaged'] }),

  // A1.4 Accident
  f('accident.date', 'Accident', 'date', 'auto', 'Date of accident', 'bundle.claim.accident.occurredAt', (s) => dateOf(accidentAt(s)), { syn: ['date of accident', 'accident date', 'date of collision', 'date of incident'] }),
  f('accident.time', 'Accident', 'time', 'auto', 'Time of accident', 'bundle.claim.accident.occurredAt', (s) => timeOf(accidentAt(s)), { syn: ['time'] }),
  f('accident.dateTime', 'Accident', 'datetime', 'auto', 'Date & time of accident', 'bundle.claim.accident.occurredAt', (s) => dateTimeOf(accidentAt(s)), { syn: ['date and time'] }),
  f('accident.dateLong', 'Accident', 'date', 'auto', 'Date of accident (long)', 'bundle.claim.accident.occurredAt', (s) => dateOf(accidentAt(s)), { syn: ['road traffic collision'] }),
  f('accident.dateTimeApprox', 'Accident', 'text', 'auto', 'Date & approximate time', '`9 August 2026, about 14:30`', (s) => {
    const at = accidentAt(s);
    if (!at) return undefined;
    return txt(/T/.test(at) ? `${longDate(at)}, about ${timeOf(at)!.v}` : longDate(at));
  }, { syn: ['date and approximate time'] }),
  f('accident.location', 'Accident', 'text', 'auto', 'Accident location', 'bundle.claim.accident.location (+ postcode when not already in it)', (s) => {
    const loc = s.claim.accident?.location?.trim();
    if (!loc) return undefined;
    const pc = s.claim.accident.postcode?.trim().toUpperCase();
    return txt(pc && !loc.toUpperCase().replace(/\s/g, '').includes(pc.replace(/\s/g, '')) ? `${loc}, ${pc}` : loc);
  }, { syn: ['location', 'accident location', 'road junction', 'location of collision'] }),
  f('accident.postcode', 'Accident', 'text', 'auto-if-known', 'Accident postcode', 'bundle.claim.accident.postcode', (s) => txt(s.claim.accident?.postcode?.toUpperCase()), { syn: ['postcode of accident'] }),
  f('accident.townPostcode', 'Accident', 'text', 'auto-if-known', 'Town & postcode', 'bundle.claim.accident.postcode', (s) => txt(s.claim.accident?.postcode?.toUpperCase()), { syn: ['town and postcode'] }),
  f('accident.circumstances', 'Accident', 'multiline', 'auto-if-known', "Client's account (verbatim)", 'bundle.claim.accident.circumstances exactly as stored', (s) => verbatim(s.claim.accident?.circumstances), { syn: ['what happened', 'clients account', 'circumstances'] }),
  f('accident.policeAttended', 'Accident', 'bool', 'auto-if-known', 'Police attended', 'bundle.claim.accident.policeAttended', (s) => bool(s.claim.accident?.policeAttended), { syn: ['police attended'] }),
  f('accident.policeReference', 'Accident', 'text', 'auto-if-known', 'Police reference', 'bundle.claim.accident.policeReference', (s) => txt(s.claim.accident?.policeReference), { syn: ['police ref', 'police reference'] }),
  f('accident.driveable', 'Accident', 'bool', 'auto-if-known', 'Vehicle driveable', 'bundle.claim.accident.driveable (tri-state)', (s) => bool(s.claim.accident?.driveable), { syn: ['vehicle driveable', 'vehicle condition'], choices: ch(['yes', 'Driveable', 'yes', 'driveable'], ['no', 'Not driveable', 'no', 'not-driveable']) }),
  f('accident.airbagsDeployed', 'Accident', 'bool', 'auto-if-known', 'Airbags deployed', 'bundle.claim.accident.airbagsDeployed', (s) => bool(s.claim.accident?.airbagsDeployed), { syn: ['airbags deployed'] }),
  f('accident.injuries', 'Accident', 'bool', 'auto-if-known', 'Anyone injured', 'bundle.claim.accident.injuries', (s) => bool(s.claim.accident?.injuries), { syn: ['was anyone injured'] }),
  f('accident.witnesses', 'Accident', 'rows', 'auto-if-known', 'Witnesses', 'src.witnesses → { name, contact: phone ?? email }', (s) => rows(s.witnesses.map((w) => ({ name: w.name, contact: w.phone ?? w.email ?? '' }))), { syn: ['witnesses'] }),
  f('accident.accountTakenBy', 'Accident', 'text', 'auto-if-known', 'Account taken by', "the fnol event's recording user", (s) => txt(userName(s, String(eventsOfType(s, (t) => t === 'fnol')[0]?.createdBy ?? ''))), { syn: ['account taken by'] }),
  f('accident.accountTakenAt', 'Accident', 'datetime', 'auto-if-known', 'Account taken at', "the fnol event's recordedAt", (s) => dateTimeOf(eventsOfType(s, (t) => t === 'fnol')[0]?.recordedAt), { syn: ['date and time taken'] }),
  ...CCTV_SOURCES.flatMap(([code, label]) => [
    f(`accident.cctv.${code}.requestSentOn`, 'Accident', 'date', 'auto-if-known', `CCTV request sent — ${label}`, `first cctv_request_sent event with data.source = ${code}`, (s) => dateOf(eventsOfType(s, (t) => t === 'cctv_request_sent').find((e) => dataString(e, 'source') === code)?.at), { syn: ['request sent'] }),
    h(`accident.cctv.${code}.contact`, 'Accident', 'text', `CCTV contact — ${label}`, { syn: ['contact address'] }),
    h(`accident.cctv.${code}.overwriteDate`, 'Accident', 'date', `CCTV overwrite date — ${label}`, { syn: ['overwrite date'] })
  ]),
  h('accident.directionOfTravel', 'Accident', 'text', 'Direction of travel', { syn: ['direction of travel'] }),
  h('accident.weather', 'Accident', 'text', 'Weather', { syn: ['weather'] }),
  h('accident.light', 'Accident', 'choice', 'Light', { syn: ['light'], choices: ch(['daylight', 'Daylight', 'daylight'], ['dark', 'Dark', 'dark'], ['dusk_dawn', 'Dusk / dawn', 'dusk']) }),
  h('accident.roadSurface', 'Accident', 'choice', 'Road surface', { syn: ['road surface'], choices: ch(['dry', 'Dry', 'dry'], ['wet', 'Wet', 'wet'], ['ice_snow', 'Ice / snow', 'ice']) }),
  h('accident.speedLimitMph', 'Accident', 'int', 'Speed limit (mph)', { syn: ['speed limit'] }),
  h('accident.numberOfLanes', 'Accident', 'text', 'Number of lanes', { syn: ['number of lanes'] }),
  h('accident.clientLane', 'Accident', 'text', "Client's lane", { syn: ['clients lane'] }),
  h('accident.busLanePresent', 'Accident', 'bool', 'Bus lane present', { syn: ['bus lane present'] }),
  h('accident.busLaneHours', 'Accident', 'text', 'Bus lane hours of operation', { syn: ['hours of operation'] }),
  h('accident.laneMarkings', 'Accident', 'text', 'Lane markings, merges or lane endings', { syn: ['lane markings'] }),
  h('accident.clientSpeedMph', 'Accident', 'int', "Client's approximate speed (mph)", { syn: ['clients approximate speed'] }),
  h('accident.otherVehicleSpeedMph', 'Accident', 'int', "Other vehicle's speed (mph)", { syn: ['other vehicles speed'] }),
  h('accident.clientVehicleOccupied', 'Accident', 'bool', "Anyone in the client's vehicle", { syn: ['anyone in the clients vehicle'] }),
  h('accident.clientPassengers', 'Accident', 'text', 'Passengers — names and seats', { syn: ['passengers'] }),
  h('accident.sceneStatements', 'Accident', 'multiline', 'Statements or apologies at the scene', { syn: ['did anyone apologise'] }),
  h('accident.pointOfFirstImpact', 'Accident', 'text', 'Point of first impact', { syn: ['point of first impact'] }),
  h('accident.directionOfForce', 'Accident', 'text', 'Direction of force', { syn: ['direction of force'] }),
  h('accident.policeForceStation', 'Accident', 'text', 'Police force & station', { syn: ['force and station'] }),
  h('accident.reportedToPoliceWithin24h', 'Accident', 'choice', 'Reported to police within 24 hours', { syn: ['reported within 24 hours'], choices: YES_NO_NA }),
  h('accident.breathTest', 'Accident', 'bool', 'Breath test carried out', { syn: ['breath test carried out'] }),
  h('accident.breathTestResult', 'Accident', 'text', 'Breath test result', { syn: ['result'] }),
  h('accident.reportedForOffence', 'Accident', 'bool', 'Anyone reported for an offence', { syn: ['anyone reported for an offence'] }),
  h('accident.injuryAdviceGivenOn', 'Accident', 'date', 'Injury advice given on', { syn: ['client told on'] }),
  h('accident.injuryAdviceChannel', 'Accident', 'choice', 'Injury advice given by', { choices: ch(['telephone', 'Telephone', 'telephone'], ['email', 'Email', 'email'], ['in_person', 'In person', 'in-person']) }),
  h('accident.injuryAdviceConfirmedInWriting', 'Accident', 'bool', 'Injury advice confirmed in writing', { syn: ['confirmed in writing'] }),

  // Third party
  f('tp.driverName', 'Third party', 'text', 'auto-if-known', 'Other driver', 'first third_party_driver, else first third_party (never a witness)', (s) => txt(tpDriver(s)?.name), { syn: ['other driver', 'driver name', 'third party driver'] }),
  f('tp.driverAddress', 'Third party', 'text', 'auto-if-known', 'Other driver address', 'that party', (s) => txt(addressOneLine(tpDriver(s)?.address)), { syn: ['driver address'] }),
  f('tp.driverPhone', 'Third party', 'text', 'auto-if-known', 'Other driver telephone', 'that party', (s) => txt(tpDriver(s)?.phone), { syn: ['driver telephone'] }),
  f('tp.vehicleRegistration', 'Third party', 'text', 'auto-if-known', 'Other vehicle registration', 'bundle.thirdPartyVehicle.registration', (s) => txt(regOf(s.thirdPartyVehicle)), { syn: ['other vehicle reg', 'registration other vehicle'], aliases: ['tp.registration'] }),
  f('tp.vehicleDescription', 'Third party', 'text', 'auto-if-known', 'Third-party vehicle', 'bundle.thirdPartyVehicle', (s) => {
    const v = s.thirdPartyVehicle;
    if (!v) return undefined;
    const mm = [makeModel(v), v.colour ? v.colour.toLowerCase() : undefined].filter(Boolean).join(', ');
    const reg = regOf(v);
    return txt(mm && reg ? `${mm} — ${reg}` : mm || reg);
  }, { syn: ['third party vehicle', 'other vehicle'] }),
  f('tp.vehicleMakeModelReg', 'Third party', 'text', 'auto-if-known', 'Other vehicle and registration', 'bundle.thirdPartyVehicle', (s) => txt(makeModelReg(s.thirdPartyVehicle)), { syn: ['other vehicle'] }),
  f('tp.vehicleMakeModelColour', 'Third party', 'text', 'auto-if-known', 'Other vehicle make, model & colour', 'bundle.thirdPartyVehicle', (s) => {
    const v = s.thirdPartyVehicle;
    const parts = [makeModel(v), v?.colour ? titleCase(v.colour) : undefined].filter(Boolean);
    return parts.length ? txt(parts.join(', ')) : undefined;
  }, { syn: ['make model and colour'] }),
  f('tp.policyNumber', 'Third party', 'text', 'auto-if-known', "Third party's policy number", 'fnol event data.thirdPartyPolicyNumber', (s) => txt(dataString(eventsOfType(s, (t) => t === 'fnol').find((e) => dataString(e, 'thirdPartyPolicyNumber')), 'thirdPartyPolicyNumber')), { syn: ['policy number third party'] }),
  h('tp.detailsSource', 'Third party', 'choice', 'Details obtained how', { syn: ['details obtained how'], choices: ch(['at_scene', 'At scene', 'at-scene'], ['police', 'Police', 'police'], ['insurer', 'Insurer', 'insurer'], ['askmid', 'askMID', 'askmid']) }),
  h('tp.askMidCheckedOn', 'Third party', 'date', 'askMID checked on', { syn: ['askmid checked on'] }),
  h('tp.askMidResult', 'Third party', 'text', 'askMID result', { syn: ['askmid result'] }),
  h('tp.vehicleDamage', 'Third party', 'text', 'Damage to other vehicle', { syn: ['damage to other vehicle'] }),
  h('tp.passengers', 'Third party', 'text', 'Passengers in other vehicle', { syn: ['passengers in other vehicle'] }),

  // Insurers
  f('tpInsurer.name', 'Insurers', 'text', 'auto-if-known', 'Third-party insurer', 'bundle.atFaultInsurer.name', (s) => txt(s.atFaultInsurer?.name), { syn: ['third party insurer', 'payable by', 'at fault insurer'] }),
  f('tpInsurer.claimRef', 'Insurers', 'text', 'auto-if-known', 'Third-party claim reference', 'bundle.claim.atFaultInsurerRef', (s) => txt(s.claim.atFaultInsurerRef), { syn: ['third party claim ref', 'third party ref', 'claim no', 'their ref'], aliases: ['tpInsurer.reference'] }),
  f('tpInsurer.firstContactedOn', 'Insurers', 'date', 'auto-if-known', 'Insurer contacted on', 'earliest ncaf_sent / letter_out / email_out to the at-fault insurer', (s) => dateOf(eventsOfType(s, (t) => t === 'ncaf_sent' || t === 'letter_out' || t === 'email_out').find((e) => e.type === 'ncaf_sent' || eventTo(e, s.atFaultInsurer?.id, 'at_fault_insurer'))?.at), { syn: ['insurer contacted on'] }),
  f('ownInsurer.name', 'Insurers', 'text', 'auto-if-known', 'Own insurer', 'src.ownInsurer.name', (s) => txt(s.ownInsurer?.name), { syn: ['own insurer'] }),
  f('ownInsurer.policyNumber', 'Insurers', 'text', 'auto-if-known', 'Own policy number', 'bundle.claim.clientPolicyNumber', (s) => txt(s.claim.clientPolicyNumber), { syn: ['policy number'] }),
  f('ownInsurer.namePolicy', 'Insurers', 'text', 'auto-if-known', 'Own insurer / policy', '`Aviva / POL123`', (s) => {
    const parts = [s.ownInsurer?.name, s.claim.clientPolicyNumber].map((x) => x?.trim()).filter(Boolean);
    return parts.length ? txt(parts.join(' / ')) : undefined;
  }, { syn: ['own insurer policy'] }),
  h('ownInsurer.claimRef', 'Insurers', 'text', 'Own insurer claim reference', { syn: ['own claim ref', 'own insurer ref'] }),
  h('ownInsurer.cover', 'Insurers', 'choice', 'Own insurance cover', { syn: ['cover'], choices: ch(['comprehensive', 'Comprehensive', 'comprehensive'], ['tpft', 'TPFT', 'tpft'], ['tpo', 'TPO', 'tpo']) }),
  h('ownInsurer.excessPence', 'Insurers', 'money', 'Own policy excess', { syn: ['policy excess'] }),
  h('ownInsurer.reportedOn', 'Insurers', 'date', 'Reported to own insurer on', { syn: ['reported to own insurer on'] }),

  // A1.5 Hire
  f('hire.agreementNumber', 'Hire', 'text', 'auto', 'Hire agreement number', 'agreement.agreementNumber', (s) => txt(hireOf(s)?.agreementNumber), { syn: ['agreement ref', 'hire agreement ref'] }),
  f('hire.startAt', 'Hire', 'datetime', 'auto-if-known', 'Hire start', 'agreement.startAt', (s) => dateTimeOf(hireOf(s)?.startAt), { syn: ['agreement hire start', 'hire start', 'date hire began'], aliases: ['hire.startDate'] }),
  f('hire.endDate', 'Hire', 'date', 'auto-if-known', 'Hire ended on', 'agreement.endAt (only when set)', (s) => dateOf(hireOf(s)?.endAt), { syn: ['hire ended on'] }),
  f('hire.dailyRatePence', 'Hire', 'money', 'auto', 'Daily hire rate', 'agreement.dailyRatePence (no VAT added)', (s) => money(hireOf(s)?.dailyRatePence), { syn: ['daily credit hire', 'per hire day', 'daily hire rate', 'rate charged'] }),
  f('hire.gtaGroup', 'Hire', 'text', 'auto-if-known', 'Replacement GTA group', 'agreement.gtaGroup ?? fleetUnit.gtaGroup', (s) => txt(hireOf(s)?.gtaGroup || subjectHire(s)?.fleetUnit?.gtaGroup), { syn: ['replacement vehicle class'] }),
  f('hire.excessPence', 'Hire', 'money', 'auto-if-known', 'Hire vehicle excess', 'agreement.excessPence', (s) => money(hireOf(s)?.excessPence), { syn: ['excess'] }),
  f('hire.odometerOut', 'Hire', 'int', 'auto-if-known', 'Odometer out', 'agreement.odometerOut', (s) => int(hireOf(s)?.odometerOut, 'miles'), { syn: ['odometer out', 'recorded mileage'] }),
  f('hire.odometerIn', 'Hire', 'int', 'auto-if-known', 'Odometer in', 'agreement.odometerIn', (s) => int(hireOf(s)?.odometerIn, 'miles'), { syn: ['odometer in'] }),
  f('hire.milesCovered', 'Hire', 'int', 'auto-if-known', 'Miles covered', 'in − out when both present and in ≥ out', (s) => {
    const a = hireOf(s);
    return a?.odometerIn !== undefined && a.odometerOut !== undefined && a.odometerIn >= a.odometerOut ? int(a.odometerIn - a.odometerOut, 'miles') : undefined;
  }, { syn: ['miles covered'] }),
  f('hire.releasedAt', 'Hire', 'datetime', 'auto-if-known', 'Released (date & time out)', 'agreement.deliveredAt ?? agreement.startAt when ≤ now', (s) => {
    const a = hireOf(s);
    const at = a?.deliveredAt ?? a?.startAt;
    return at && notAfterNow(s, at) ? dateTimeOf(at) : undefined;
  }, { syn: ['date and time out', 'handover date and time'] }),
  f('hire.releaseDate', 'Hire', 'date', 'auto-if-known', 'Release date', 'date of hire.releasedAt', (s) => {
    const a = hireOf(s);
    const at = a?.deliveredAt ?? a?.startAt;
    return at && notAfterNow(s, at) ? dateOf(at) : undefined;
  }, { syn: ['release date'] }),
  f('hire.returnedAt', 'Hire', 'datetime', 'auto-if-known', 'Returned (date & time in)', 'agreement.collectedAt ?? agreement.endAt, only when endAt is set', (s) => {
    const a = hireOf(s);
    return a?.endAt ? dateTimeOf(a.collectedAt ?? a.endAt) : undefined;
  }, { syn: ['date and time in'] }),
  f('hire.hirerName', 'Hire', 'text', 'auto', 'Hirer full name', 'bundle.claimant.name', (s) => txt(s.claimant.name), { syn: ['hirer full name', 'hirer'] }),
  f('hire.cancellationInfoGiven', 'Hire', 'choice', 'auto-if-known', 'Cancellation information given', 'yes when enforceability.cancellationInfoProvidedAt is set', (s) => (hireOf(s)?.enforceability?.cancellationInfoProvidedAt ? choice('yes') : undefined), { syn: ['cancellation information given'], choices: YES_NO }),
  f('hire.cancellationInfoDate', 'Hire', 'date', 'auto-if-known', 'Cancellation information given on', 'enforceability.cancellationInfoProvidedAt', (s) => dateOf(hireOf(s)?.enforceability?.cancellationInfoProvidedAt), { syn: ['on'] }),
  f('hire.gta.ownClassGroup', 'Hire', 'text', 'auto-if-known', 'GTA group, own vehicle class', 'vehicle.gtaGroup', (s) => txt(s.vehicle.gtaGroup), { syn: ['hirers own vehicle class'] }),
  f('hire.gta.ownClassRatePence', 'Hire', 'money', 'auto-if-known', 'GTA rate, own vehicle class (benchmark)', 'gtaRate(vehicle.gtaGroup, date(hire.startAt), src.gtaRates)', (s) => gtaRateValue(s.vehicle.gtaGroup, hireOf(s)?.startAt, s), { syn: ['rate'], gta: true }),
  f('hire.gta.replacementClassGroup', 'Hire', 'text', 'auto-if-known', 'GTA group, replacement class', 'hire.gtaGroup', (s) => txt(hireOf(s)?.gtaGroup || subjectHire(s)?.fleetUnit?.gtaGroup), { syn: ['replacement vehicle class'] }),
  f('hire.gta.replacementClassRatePence', 'Hire', 'money', 'auto-if-known', 'GTA rate, replacement class (benchmark)', 'gtaRate(hire.gtaGroup, date(hire.startAt), src.gtaRates)', (s) => gtaRateValue(hireOf(s)?.gtaGroup || subjectHire(s)?.fleetUnit?.gtaGroup, hireOf(s)?.startAt, s), { syn: ['rate'], gta: true }),
  f('hire.insuranceBasis', 'Hire', 'choice', 'suggest', 'Basis of cover', 'ccguk_arranged when policy.coveredUses includes credit_hire', (s) => (subjectHire(s)?.policy?.coveredUses.includes('credit_hire') ? choice('ccguk_arranged') : undefined), { syn: ['basis of cover'], choices: ch(['ccguk_arranged', 'CCGUK arranged', 'ccguk-arranged'], ['hirers_own', "Hirer's own", 'hirers-own'], ['other', 'Other', 'other']) }),
  f('hire.collectionMethod', 'Hire', 'choice', 'suggest', 'Collected or delivered', 'delivered when agreement.deliveredAt is set (never from collectedAt)', (s) => (hireOf(s)?.deliveredAt ? choice('delivered') : undefined), { syn: ['vehicle collected from', 'collection', 'collected or delivered'], aliases: ['hire.releaseMethod'], choices: ch(['collected', 'Collected', 'collected', 'ccguk-premises'], ['delivered', 'Delivered', 'delivered']) }),
  f('hire.deliveryAddress', 'Hire', 'text', 'suggest', 'Delivered to', 'claimant.address', (s) => txt(addressOneLine(s.claimant.address)), { syn: ['delivered to hirer at', 'delivered to'] }),
  f('hire.releasedBy', 'Hire', 'text', 'suggest', 'Released by', 'handler.name', (s) => txt(s.user.name), { syn: ['released by'] }),
  f('hire.required', 'Hire', 'bool', 'auto-if-known', 'Credit hire required', 'a HireAgreement exists on the claim', (s) => yesIf(s.hires.length > 0 || !!s.hire), { syn: ['replacement vehicle on credit hire'] }),
  f('hire.conditionReportRef', 'Hire', 'text', 'auto-if-known', 'Condition report ref.', 'latest form.ccguk_06_handover_condition document (`<title> <id first 8>`)', (s) => {
    const d = latestDocument(s, 'form.ccguk_06_handover_condition');
    return d ? txt(`${d.title} ${d.id.slice(0, 8)}`) : undefined;
  }, { syn: ['condition report ref'] }),
  f('hire.agreementSignedOn', 'Hire', 'date', 'auto-if-known', 'Hire agreement signed on', 'agreement.signedAt', (s) => dateOf(hireOf(s)?.signedAt), { syn: ['agreement signed on'] }),
  h('hire.deliveryChargePence', 'Hire', 'money', 'Vehicle delivery charge', { syn: ['vehicle delivery'] }),
  h('hire.adminFeePence', 'Hire', 'money', 'Administration & setup fee', { syn: ['administration and setup fee'] }),
  h('hire.driverDecl.moreThan3Accidents3y', 'Hire', 'choice', 'More than 3 accidents or claims in 3 years', { choices: YES_NO }),
  h('hire.driverDecl.disqualified3y', 'Hire', 'choice', 'Disqualified within 3 years', { choices: YES_NO }),
  h('hire.driverDecl.majorConviction', 'Hire', 'choice', 'Major vehicle-related conviction', { choices: YES_NO }),
  h('hire.driverDecl.fullValidLicence', 'Hire', 'choice', 'Holds a full valid licence', { choices: YES_NO }),
  h('hire.contractChannel', 'Hire', 'choice', 'How the hire agreement was concluded', { choices: ch(['premises', "At CCGUK's business premises", 'this-agreement-was-concluded-at-ccguks', 'at-ccguks-premises'], ['away', "Away from CCGUK's premises", 'this-agreement-was-concluded-away', 'away-from'], ['distance', 'At a distance', 'this-agreement-was-concluded-at-a-distance', 'at-a-distance']) }),
  h('hire.signedPlace', 'Hire', 'text', 'Place where signed', { syn: ['place where signed'] }),
  h('hire.cancellationInfoMedium', 'Hire', 'choice', 'Cancellation information given by', { choices: ch(['paper', 'Paper', 'paper'], ['email', 'Email', 'email']) }),
  h('hire.substitutionReason', 'Hire', 'multiline', 'Why a direct equivalent was not supplied', { syn: ['why a direct equivalent was not supplied'] }),
  h('hire.selectionReason', 'Hire', 'multiline', 'Vehicle actually supplied, and why', { syn: ['vehicle actually supplied and why'] }),
  h('hire.ratePositionStatement', 'Hire', 'multiline', 'Rate position statement'),
  h('hire.fuelOutPercent', 'Hire', 'int', 'Fuel level out (%)', { syn: ['fuel level'] }),
  h('hire.chargeOutPercent', 'Hire', 'int', 'Battery / charge out (%)', { syn: ['battery charge'] }),
  h('hire.keysSupplied', 'Hire', 'choice', 'Keys supplied', { choices: ch(['1', '1 set', '1-set'], ['2', '2 sets', '2-sets']) }),
  h('hire.gta.ownClassAutoGroup', 'Hire', 'text', 'GTA group, own class + automatic uplift'),
  h('hire.gta.ownClassAutoRatePence', 'Hire', 'money', 'GTA rate, own class + automatic uplift (benchmark)'),
  ...(
    [
      ['signedAndDated', 'Agreement signed and dated by the Hirer'],
      ['signatureDateActual', 'Signature date is the actual date of signing'],
      ['chargesStated', 'Daily rate, admin fee and contingent charges stated'],
      ['channelRecorded', 'On-premises / off-premises / distance recorded'],
      ['cancellationInfoDurable', 'Cancellation information on a durable medium'],
      ['needStatementOwnWords', "Statement of need in the Hirer's own words"],
      ['handoverReportCompleted', 'Handover & Condition Report completed'],
      ['copyGiven', 'Copy of the signed agreement given'],
      ['statementOfMeans', 'Statement of Means completed where needed'],
      ['gtaComparatorRecorded', 'GTA comparator recorded']
    ] as Array<[string, string]>
  ).map(([k, label]) => h(`hire.enfCheck.${k}`, 'Hire', 'choice', `Enforceability check — ${label}`, { choices: YES_NO })),
  h('hire.enfCheck.checkedBy', 'Hire', 'text', 'Enforceability check — checked by'),
  h('hire.enfCheck.checkedDate', 'Hire', 'date', 'Enforceability check — date'),
  h('hire.enfCheck.defects', 'Hire', 'multiline', 'Enforceability check — defects found & action taken'),
  ...(['release', 'return'] as const).flatMap((stage) => [
    h(`hire.${stage}.keys`, 'Hire', 'choice', `Keys (${stage})`, { choices: ch(['1', '1 set', '1-set'], ['2', '2 sets', '2-sets']) }),
    h(`hire.${stage}.documentPack`, 'Hire', 'choice', `Document pack (${stage})`, { choices: YES_NO }),
    h(`hire.${stage}.chargingCables`, 'Hire', 'choice', `Charging cable(s) (${stage})`, { choices: ch(['na', 'N/A', 'n-a'], ['1', '1', '1'], ['2', '2', '2']) }),
    h(`hire.${stage}.lockingWheelNut`, 'Hire', 'choice', `Locking wheel nut key (${stage})`, { choices: YES_NO }),
    h(`hire.${stage}.parcelShelf`, 'Hire', 'choice', `Parcel shelf / load cover (${stage})`, { choices: YES_NO_NA }),
    h(`hire.${stage}.spareWheel`, 'Hire', 'choice', `Spare wheel or repair kit (${stage})`, { choices: YES_NO })
  ]),
  h('hire.release.insuranceCertificate', 'Hire', 'choice', 'Insurance certificate / cover note handed over', { choices: YES_NO }),
  h('hire.release.warningTriangle', 'Hire', 'choice', 'Warning triangle / hi-vis handed over', { choices: YES_NO }),
  h('hire.return.personalItemsRemoved', 'Hire', 'choice', 'Personal items removed by hirer', { choices: YES_NO }),
  h('hire.return.cleanliness', 'Hire', 'choice', 'Vehicle cleanliness at return', { choices: ch(['acceptable', 'Acceptable', 'acceptable'], ['excessive_soiling', 'Excessive soiling', 'excessive-soiling']) }),
  ...CONDITION_PANELS.flatMap(([k, label]) => [h(`hire.condition.${k}.out`, 'Hire', 'text', `Condition at release — ${label}`), h(`hire.condition.${k}.in`, 'Hire', 'text', `Condition at return — ${label}`)]),
  h('hire.releaseDamage', 'Hire', 'rows', 'Damage noted at release', { columns: { panel: ['panel'], code: ['code'], description: ['description'], photoRef: ['photo'] } }),
  h('hire.returnDamage', 'Hire', 'rows', 'New damage at return', { columns: { panel: ['panel'], code: ['code'], description: ['description'], photoRef: ['photo'] } }),
  h('hire.receivedBy', 'Hire', 'text', 'Received by (return)', { syn: ['received by'] }),
  h('hire.returnedBy', 'Hire', 'text', 'Returned by', { syn: ['returned by'] }),
  h('hire.returnLocation', 'Hire', 'text', 'Location of return', { syn: ['location of return'] }),
  h('hire.fuelOut', 'Hire', 'text', 'Fuel out (eighths)', { syn: ['fuel out'] }),
  h('hire.fuelIn', 'Hire', 'text', 'Fuel in (eighths)', { syn: ['fuel in'] }),
  h('hire.fuelInPercent', 'Hire', 'int', 'Fuel / charge in (%)'),
  h('hire.batteryOutPercent', 'Hire', 'int', 'Battery charge out (%)', { syn: ['battery charge out'] }),
  h('hire.batteryInPercent', 'Hire', 'int', 'Battery charge in (%)', { syn: ['battery charge in'] }),
  h('hire.return.newDamage', 'Hire', 'bool', 'New damage identified at return', { syn: ['new damage identified'] }),
  h('hire.return.damageNotifiedDate', 'Hire', 'date', 'New damage notified to the hirer on'),
  h('hire.return.fuelShortfall', 'Hire', 'bool', 'Fuel / charge shortfall', { syn: ['fuel charge shortfall'] }),
  h('hire.return.fuelShortfallAmount', 'Hire', 'text', 'Fuel / charge shortfall amount'),
  h('hire.return.fuelChargePence', 'Hire', 'money', 'Fuel / charge — charge raised'),
  h('hire.return.cleaningRequired', 'Hire', 'bool', 'Cleaning required beyond normal', { syn: ['cleaning required beyond normal'] }),
  h('hire.return.cleaningChargePence', 'Hire', 'money', 'Cleaning — charge raised'),
  ...(['release', 'return'] as const).flatMap((stage) => [
    f(`hire.${stage}.photoCount`, 'Hire', 'int', 'auto-if-known', `Photographs taken at ${stage} (count)`, `evidence photos tagged ${stage}`, (s) => {
      const n = tagged(s, stage).length;
      return n > 0 ? int(n) : undefined;
    }, { syn: ['number taken'] }),
    f(`hire.${stage}.photoStore`, 'Hire', 'text', 'auto-if-known', `Photographs stored at (${stage})`, '`ClaimDesk evidence store, claim <reference>`', (s) => (tagged(s, stage).length > 0 ? txt(evidenceStore(s)) : undefined), { syn: ['stored at'] })
  ]),

  // Hire vehicle
  f('hireVehicle.registration', 'Hire vehicle', 'text', 'auto-if-known', 'Replacement vehicle registration', 'src.hire.vehicle.registration', (s) => txt(regOf(hireVehicle(s))), { syn: ['registration replacement', 'replacement vehicle'] }),
  f('hireVehicle.makeModel', 'Hire vehicle', 'text', 'auto-if-known', 'Replacement vehicle make & model', 'src.hire.vehicle', (s) => txt(makeModel(hireVehicle(s))), { syn: ['make and model replacement'] }),
  f('hireVehicle.makeModelReg', 'Hire vehicle', 'text', 'auto-if-known', 'Replacement vehicle and registration', 'src.hire.vehicle', (s) => txt(makeModelReg(hireVehicle(s)))),
  f('hireVehicle.colour', 'Hire vehicle', 'text', 'auto-if-known', 'Replacement vehicle colour', 'src.hire.vehicle.colour', (s) => txt(hireVehicle(s)?.colour ? titleCase(hireVehicle(s)!.colour!) : undefined)),
  f('hireVehicle.vin', 'Hire vehicle', 'text', 'auto-if-known', 'Replacement vehicle VIN', 'src.hire.vehicle.vin', (s) => txt(hireVehicle(s)?.vin?.toUpperCase())),
  f('hireVehicle.engineFuel', 'Hire vehicle', 'text', 'auto-if-known', 'Replacement vehicle engine / fuel', 'src.hire.vehicle', (s) => txt(engineFuel(hireVehicle(s)))),
  f('hireVehicle.transmission', 'Hire vehicle', 'choice', 'auto-if-known', 'Replacement vehicle transmission', 'src.hire.vehicle.transmission', (s) => choice(transmissionCode(hireVehicle(s))), { choices: ch(['manual', 'Manual', 'manual'], ['automatic', 'Automatic', 'automatic']) }),
  f('hireVehicle.insurerName', 'Hire vehicle', 'text', 'auto-if-known', 'Replacement vehicle insurer', 'src.hire.policy.insurerName', (s) => txt(subjectHire(s)?.policy?.insurerName), { syn: ['insurance provider'] }),
  f('hireVehicle.policyNumber', 'Hire vehicle', 'text', 'auto-if-known', 'Replacement vehicle policy / fleet ref.', 'src.hire.policy.policyNumber', (s) => txt(subjectHire(s)?.policy?.policyNumber), { syn: ['policy fleet ref'] }),

  // A1.6 Storage
  f('storage.currentLocation', 'Storage', 'text', 'auto-if-known', 'Vehicle now at', 'open storage location, else latest recovery toLocation', (s) => txt(openStorage(s)?.location ?? byTime(s.recovery, (r) => r.at).pop()?.toLocation), { syn: ['vehicle now at', 'current location of vehicle'] }),
  f('storage.facility', 'Storage', 'choice', 'auto-if-known', 'Storage facility', 'carflex when the location matches CarFlex/Stanwell/TW19 7PD, else other', (s) => {
    const loc = latestStorage(s)?.location;
    if (!loc) return undefined;
    return choice(/carflex|stanwell|tw19\s?7pd/i.test(loc) ? 'carflex' : 'other');
  }, { syn: ['facility'], choices: ch(['carflex', 'CarFlex Secure Storage, Stanwell', 'carflex'], ['other', 'Other', 'other']) }),
  f('storage.facilityOther', 'Storage', 'text', 'auto-if-known', 'Storage facility (other)', 'storage location when not the CarFlex yard', (s) => {
    const loc = latestStorage(s)?.location;
    return loc && !/carflex|stanwell|tw19\s?7pd/i.test(loc) ? txt(loc) : undefined;
  }),
  f('storage.enteredAt', 'Storage', 'datetime', 'auto-if-known', 'Entered storage', 'latest record startAt', (s) => dateTimeOf(latestStorage(s)?.startAt), { syn: ['entered storage'] }),
  f('storage.startDate', 'Storage', 'date', 'auto-if-known', 'Storage start date', 'latest record startAt', (s) => dateOf(latestStorage(s)?.startAt)),
  f('storage.releasedAt', 'Storage', 'datetime', 'auto-if-known', 'Released from storage', 'endAt only (open → blank)', (s) => dateTimeOf(latestStorage(s)?.endAt), { syn: ['released'] }),
  f('storage.endDate', 'Storage', 'date', 'auto-if-known', 'Storage end date', 'endAt only (open → blank)', (s) => dateOf(latestStorage(s)?.endAt)),
  f('storage.days', 'Storage', 'int', 'auto-if-known', 'Storage days (inclusive)', 'closed records only: inclusive day count', (s) => int(storageDays(latestStorage(s)), 'days'), { syn: ['days'] }),
  f('storage.dailyRatePence', 'Storage', 'money', 'auto-if-known', 'Daily storage rate', 'record dailyRatePence', (s) => money(latestStorage(s)?.dailyRatePence), { syn: ['daily storage rate'] }),
  f('storage.netPence', 'Storage', 'money', 'auto-if-known', 'Storage charge (net)', 'closed only: days × daily rate, no VAT', (s) => money(storageNet(s)), { syn: ['storage charge'] }),
  f('storage.instructedDate', 'Storage', 'date', 'auto-if-known', 'Storage instructed', 'storage instruction event, else startAt', (s) => {
    const ev = eventsOfType(s, (t) => t === 'services_agreed').find((e) => dataList(e, 'services').includes('storage'));
    return dateOf(ev?.at ?? latestStorage(s)?.startAt);
  }),
  f('storage.odometerOnEntry', 'Storage', 'int', 'auto-if-known', 'Odometer on entry', "odometer reading with source 'collection'", (s) => int(byTime(s.vehicle.odometer.filter((r) => r.source === 'collection'), (r) => r.date).pop()?.miles, 'miles'), { syn: ['odometer on entry'] }),
  f('storage.required', 'Storage', 'bool', 'auto-if-known', 'Storage required', 'a storage record exists', (s) => yesIf(s.storage.length > 0), { syn: ['storage required'] }),
  f('storage.carriedOut', 'Storage', 'bool', 'auto-if-known', 'Storage carried out', 'a storage record exists', (s) => yesIf(s.storage.length > 0)),
  f('storage.log', 'Storage', 'rows', 'auto-if-known', 'Storage log', 'storage_reason events (from/to/days/reason/evidence)', (s) =>
    rows(
      eventsOfType(s, (t) => t === 'storage_reason').map((e) => {
        const from = dataString(e, 'from');
        const to = dataString(e, 'to');
        const fmt = (d?: string) => (d ? londonDate(d).split('-').reverse().join('/') : '');
        const days = from && to ? String(Math.round((Date.parse(londonDate(to)) - Date.parse(londonDate(from))) / 86_400_000) + 1) : '';
        return { from: fmt(from), to: fmt(to), days, reason: dataString(e, 'reason') ?? '', evidence: dataString(e, 'evidence') ?? '' };
      })
    ), { columns: { from: ['from'], to: ['to'], days: ['days'], reason: ['why', 'reason'], evidence: ['evidence'] } }),
  f('storage.invoiceRef', 'Storage', 'text', 'auto-if-known', 'Storage invoice', 'ledger invoiced entry, head storage', (s) => txt(ledgerReference(s, 'storage'))),
  f('storage.part3SignedOn', 'Storage', 'date', 'auto-if-known', 'Part 3 signed on', 'signed date of the 02 pack', (s) => dateOf(signedDocument(s, 'agreement.ccguk_02_recovery_storage_engineering')?.signedAt)),
  h('storage.conditionOnEntry', 'Storage', 'text', 'Condition on entry', { syn: ['condition on entry'] }),
  h('storage.keys', 'Storage', 'choice', 'Keys (storage)', { choices: ch(['1', '1 set', '1-set'], ['2', '2 sets', '2-sets'], ['none', 'None', 'none']) }),
  h('storage.personalItems', 'Storage', 'choice', 'Personal items', { choices: ch(['none', 'None found', 'none-found'], ['listed', 'Listed', 'listed']) }),
  h('storage.personalItemsList', 'Storage', 'text', 'Personal items listed'),
  h('storage.releasedTo', 'Storage', 'text', 'Released to', { syn: ['released to'] }),
  h('storage.releaseCapacity', 'Storage', 'choice', 'Release capacity', { choices: ch(['client', 'Client', 'client'], ['authorised', 'Authorised person', 'authorised'], ['salvage', 'Salvage agent', 'salvage']) }),
  h('storage.releaseIdChecked', 'Storage', 'choice', 'ID checked at release', { choices: ch(['driving_licence', 'Driving licence', 'driving-licence'], ['passport', 'Passport', 'passport'], ['other', 'Other', 'other']) }),
  h('storage.releaseAuthority', 'Storage', 'text', 'Release authority', { syn: ['release authority'] }),

  // Recovery
  f('recovery.date', 'Recovery', 'datetime', 'auto-if-known', 'Recovered on / attended', 'first bundle.recovery[].at', (s) => dateTimeOf(firstRecovery(s)?.at), { syn: ['recovered on', 'attended'], aliases: ['recovery.attendedAt'] }),
  f('recovery.fromLocation', 'Recovery', 'text', 'auto-if-known', 'Recovered from', 'record fromLocation', (s) => txt(firstRecovery(s)?.fromLocation), { syn: ['from'] }),
  f('recovery.toLocation', 'Recovery', 'text', 'auto-if-known', 'Recovered to', 'record toLocation', (s) => txt(firstRecovery(s)?.toLocation), { syn: ['to'] }),
  f('recovery.loadedMiles', 'Recovery', 'int', 'auto-if-known', 'Loaded miles', 'record loadedMiles', (s) => int(firstRecovery(s)?.loadedMiles, 'miles'), { syn: ['loaded miles'] }),
  f('recovery.mileagePence', 'Recovery', 'money', 'auto-if-known', 'Mileage charge', 'loadedMiles × perLoadedMilePence', (s) => {
    const r = firstRecovery(s);
    return r ? money(r.loadedMiles * r.perLoadedMilePence) : undefined;
  }),
  f('recovery.netPence', 'Recovery', 'money', 'auto-if-known', 'Recovery charge (net)', 'callout + mileage + admin', (s) => money(recoveryNet(firstRecovery(s)))),
  f('recovery.basisText', 'Recovery', 'text', 'auto-if-known', 'Recovery basis', '`£90 + 12 mi × £3 + £25`', (s) => {
    const r = firstRecovery(s);
    if (!r) return undefined;
    const g = (p: number) => `£${p % 100 === 0 ? thousands(p / 100) : (p / 100).toFixed(2)}`;
    return txt(`${g(r.calloutPence)} + ${r.loadedMiles} mi × ${g(r.perLoadedMilePence)} + ${g(r.adminPence)}`);
  }),
  f('recovery.instructedDate', 'Recovery', 'date', 'auto-if-known', 'Recovery instructed', 'instruction event, else record at', (s) => {
    const ev = eventsOfType(s, (t) => t === 'services_agreed').find((e) => dataList(e, 'services').includes('recovery'));
    return dateOf(ev?.at ?? firstRecovery(s)?.at);
  }),
  f('recovery.outcome', 'Recovery', 'choice', 'auto-if-known', 'Recovery outcome', 'carried_out when a record exists', (s) => (firstRecovery(s) ? choice('carried_out') : undefined), { choices: ch(['carried_out', 'Carried out', 'carried-out'], ['not_carried_out', 'Not carried out', 'not-carried-out'], ['cancelled', 'Cancelled by client', 'cancelled']) }),
  f('recovery.carriedOut', 'Recovery', 'bool', 'auto-if-known', 'Recovery carried out', 'a record exists', (s) => yesIf(s.recovery.length > 0)),
  f('recovery.required', 'Recovery', 'bool', 'auto-if-known', 'Recovery required', 'a record exists or the FNOL services include recovery', (s) => yesIf(s.recovery.length > 0 || servicesFromFnol(s).includes('recovery')), { syn: ['recovery required'] }),
  f('recovery.notCharged', 'Recovery', 'bool', 'auto-if-known', 'Recovery not charged', 'a record whose charge is nil', (s) => {
    const r = firstRecovery(s);
    return r && recoveryNet(r) === 0 ? bool(true) : undefined;
  }, { syn: ['not charged'] }),
  f('recovery.agentName', 'Recovery', 'text', 'auto-if-known', 'Recovered by', 'party with role recovery_agent, else company registered name', (s) => (s.recovery.length ? txt(s.recoveryAgent?.name ?? s.company.registeredName) : undefined), { syn: ['recovered by'] }),
  f('recovery.invoiceRef', 'Recovery', 'text', 'auto-if-known', 'Recovery invoice', 'ledger invoiced entry, head recovery', (s) => txt(ledgerReference(s, 'recovery'))),
  f('recovery.part2SignedOn', 'Recovery', 'date', 'auto-if-known', 'Part 2 signed on', 'signed date of the 02 pack', (s) => dateOf(signedDocument(s, 'agreement.ccguk_02_recovery_storage_engineering')?.signedAt)),
  h('recovery.provider', 'Recovery', 'choice', 'Recovery carried out by', { choices: ch(['ccguk', 'CCGUK', 'ccguk'], ['carflex', 'CarFlex (on CCGUK’s instruction)', 'carflex'], ['other', 'Other', 'other']) }),
  h('recovery.providerOther', 'Recovery', 'text', 'Recovery carried out by (other)'),
  h('recovery.deliveredAt', 'Recovery', 'datetime', 'Recovery delivered', { syn: ['delivered'] }),
  h('recovery.jobRef', 'Recovery', 'text', 'Recovery job ref', { syn: ['job ref'] }),

  // Engineer
  f('engineer.instructedDate', 'Engineer', 'date', 'auto-if-known', 'Engineer instructed', 'bundle.report.instructedAt', (s) => dateOf(s.report?.instructedAt)),
  f('engineer.inspectionAt', 'Engineer', 'datetime', 'auto-if-known', 'Inspected', 'bundle.report.inspectionAt', (s) => dateTimeOf(s.report?.inspectionAt), { syn: ['inspected'] }),
  f('engineer.inspectionBasis', 'Engineer', 'choice', 'auto-if-known', 'Inspection type', 'bundle.report.inspectionBasis (desktop → image_based)', (s) => (s.report ? choice(s.report.inspectionBasis === 'desktop' ? 'image_based' : 'physical') : undefined), { syn: ['inspection type'], choices: ch(['physical', 'Physical', 'physical'], ['image_based', 'Image-based', 'image-based']) }),
  f('engineer.inspectionPlace', 'Engineer', 'text', 'auto-if-known', 'Inspection location', 'bundle.report.inspectionPlace', (s) => txt(s.report?.inspectionPlace)),
  f('engineer.name', 'Engineer', 'text', 'auto-if-known', 'Assessor', 'engineer party name + engineerQualifications', (s) => {
    const n = s.engineer?.name;
    if (!n) return undefined;
    return txt(s.report?.engineerQualifications ? `${n}, ${s.report.engineerQualifications}` : n);
  }, { syn: ['assessor', 'engineer'] }),
  f('engineer.reportRef', 'Engineer', 'text', 'auto-if-known', 'Report ref', 'the report document (`<title> <id first 8>`)', (s) => {
    const d = s.documents.find((x) => x.id === s.report?.documentId);
    return d ? txt(`${d.title} ${d.id.slice(0, 8)}`) : undefined;
  }, { syn: ['report ref'] }),
  f('engineer.issuedDate', 'Engineer', 'date', 'auto-if-known', 'Report dated', 'bundle.report.issuedAt', (s) => dateOf(s.report?.issuedAt), { syn: ['report dated'] }),
  f('engineer.roadworthy', 'Engineer', 'bool', 'auto-if-known', 'Roadworthy', 'bundle.report.roadworthy', (s) => bool(s.report?.roadworthy), { syn: ['roadworthy'] }),
  f('engineer.odometerMiles', 'Engineer', 'int', 'auto-if-known', 'Odometer at inspection', 'bundle.report.odometerMiles', (s) => int(s.report?.odometerMiles, 'miles')),
  f('engineer.repairCostPence', 'Engineer', 'money', 'auto-if-known', 'Repair cost', 'bundle.estimate.totals.netPence', (s) => money(s.estimate?.totals?.netPence), { syn: ['repair cost'] }),
  f('engineer.repairCostVatBasis', 'Engineer', 'choice', 'auto-if-known', 'Repair cost VAT basis', 'ex (estimate net figure)', (s) => (s.estimate ? choice('ex') : undefined), { choices: ch(['inc', 'inc. VAT', 'inc'], ['ex', 'ex. VAT', 'ex']) }),
  f('engineer.pavPence', 'Engineer', 'money', 'auto-if-known', 'Pre-accident value', 'bundle.pav.pavPence', (s) => money(s.pav?.pavPence), { syn: ['pre accident value', 'pav'] }),
  f('engineer.decision', 'Engineer', 'choice', 'auto-if-known', 'Decision', 'report.totalLoss decision', (s) => choice(engineerDecision(s)), { choices: ch(['repairable', 'Repairable', 'repairable'], ['total_loss', 'Total loss', 'total-loss']) }),
  f('engineer.salvageCategory', 'Engineer', 'choice', 'auto-if-known', 'Salvage category', 'report.salvageCategory (na when repairable)', (s) => {
    if (s.report?.salvageCategory) return choice(s.report.salvageCategory);
    return engineerDecision(s) === 'repairable' ? choice('na') : undefined;
  }, { choices: ch(['N', 'N', 'n$'], ['S', 'S', 's$'], ['B', 'B', 'b$'], ['A', 'A', 'a$'], ['na', 'n/a', 'n-a']) }),
  f('engineer.salvageValuePence', 'Engineer', 'money', 'auto-if-known', 'Salvage value', 'report.salvageValuePence', (s) => money(s.report?.salvageValuePence)),
  f('engineer.feePence', 'Engineer', 'money', 'auto-if-known', 'Engineer fee', 'report.feePence', (s) => money(s.report?.feePence)),
  f('engineer.feeCharged', 'Engineer', 'choice', 'auto-if-known', 'Engineer fee charged', 'report.feePence > 0 → charged', (s) => (s.report ? choice(s.report.feePence > 0 ? 'charged' : 'not_charged') : undefined), { choices: ch(['charged', 'Fixed fee charged', 'fixed-fee', 'charged'], ['not_charged', 'Not charged', 'not-charged']) }),
  f('engineer.reportSentToClientDate', 'Engineer', 'date', 'auto-if-known', 'Report sent to client', 'letter_out/email_out of the report to the claimant', (s) => reportSentTo(s, s.claimant.id, 'client')),
  f('engineer.reportSentToInsurerDate', 'Engineer', 'date', 'auto-if-known', 'Report sent to insurer', 'letter_out/email_out of the report to the at-fault insurer', (s) => reportSentTo(s, s.atFaultInsurer?.id, 'at_fault_insurer')),
  f('engineer.outcome', 'Engineer', 'choice', 'auto-if-known', 'Engineering outcome', 'report exists', (s) => (s.report ? choice('carried_out') : undefined), { choices: ch(['carried_out', 'Assessment carried out', 'assessment-carried-out', 'carried-out'], ['not_carried_out', 'Not carried out', 'not-carried-out']) }),
  h('engineer.outcomeReason', 'Engineer', 'text', 'Engineering not carried out — reason'),
  f('engineer.carriedOut', 'Engineer', 'bool', 'auto-if-known', 'Engineering carried out', 'report issuedAt', (s) => yesIf(!!s.report?.issuedAt)),
  f('engineer.required', 'Engineer', 'bool', 'auto-if-known', 'Engineering assessment required', 'report exists or engineer instructed', (s) => yesIf(!!s.report || s.events.some((e) => e.type === 'engineer_instructed') || servicesFromFnol(s).includes('engineering')), { syn: ['engineering assessment'] }),
  f('engineer.part4SignedOn', 'Engineer', 'date', 'auto-if-known', 'Part 4 signed on', 'signed date of the 02 pack', (s) => dateOf(signedDocument(s, 'agreement.ccguk_02_recovery_storage_engineering')?.signedAt)),
  f('engineer.invoiceRef', 'Engineer', 'text', 'auto-if-known', 'Engineer invoice', 'ledger invoiced entry, head engineer_fee', (s) => txt(ledgerReference(s, 'engineer_fee'))),

  // Payment
  f('payment.reference', 'Payment', 'text', 'auto', 'Payment reference', 'bundle.claim.reference', (s) => txt(s.claim.reference), { syn: ['payment reference'] }),
  ...(
    [
      ['hire', 'Credit hire charges', ['hire']],
      ['recovery', 'Recovery charges', ['recovery']],
      ['storage', 'Storage charges', ['storage']],
      ['engineering', 'Engineering fees', ['engineer_fee']],
      ['repair', 'Repair costs', ['repair']],
      ['pav', 'Pre-accident value', ['pav']],
      ['excess', 'Policy excess', ['excess']],
      ['other', 'Other vehicle losses', OTHER_HEADS]
    ] as Array<[string, string, string[]]>
  ).map(([k, label, heads]) => f(`payment.directs.${k}`, 'Payment', 'bool', 'suggest', `Directed to CCGUK — ${label}`, `ledger heads present (${heads.join(', ')})`, (s) => yesIf(headPresent(s, heads)), { syn: [label.toLowerCase()] })),
  f('payment.totalPence', 'Payment', 'money', 'auto-if-known', 'Account total', 'recovery.netPence + storage.netPence + engineer.feePence (blank while any service is open)', (s) => {
    const parts: number[] = [];
    if (s.recovery.length) {
      const r = recoveryNet(firstRecovery(s));
      if (r === undefined) return undefined;
      parts.push(r);
    }
    if (s.storage.length) {
      const n = storageNet(s);
      if (n === undefined) return undefined;
      parts.push(n);
    }
    if (s.report) parts.push(s.report.feePence);
    return parts.length ? money(parts.reduce((a, b) => a + b, 0)) : undefined;
  }, { syn: ['total'] }),
  h('payment.additionalDescription', 'Payment', 'text', 'Additional charge — description'),
  h('payment.additionalInvoiceRef', 'Payment', 'text', 'Additional charge — invoice'),
  h('payment.additionalPence', 'Payment', 'money', 'Additional charge — amount'),
  f('services.recovery', 'Payment', 'bool', 'suggest', 'Service authorised — recovery', 'recovery records or fnol.data.services', (s) => yesIf(s.recovery.length > 0 || servicesFromFnol(s).includes('recovery'))),
  f('services.storage', 'Payment', 'bool', 'suggest', 'Service authorised — storage', 'storage records or fnol.data.services', (s) => yesIf(s.storage.length > 0 || servicesFromFnol(s).includes('storage'))),
  f('services.engineering', 'Payment', 'bool', 'suggest', 'Service authorised — engineering', 'engineer instruction / report', (s) => yesIf(!!s.report || s.events.some((e) => e.type === 'engineer_instructed') || servicesFromFnol(s).includes('engineering'))),
  f('services.creditHire', 'Payment', 'bool', 'suggest', 'Service authorised — credit hire', "hire exists or status hire_active", (s) => yesIf(s.hires.length > 0 || !!s.hire || s.claim.status === 'hire_active')),
  h('services.diagnostics', 'Payment', 'bool', 'Service authorised — diagnostics'),
  h('services.repairCoordination', 'Payment', 'bool', 'Service authorised — repair coordination'),

  // A1.7 Witness
  f('witness.fullName', 'Witness', 'text', 'auto', 'Witness full name', 'src.witness.name', (s) => txt(s.witness?.name), { syn: ['witness', 'full name of witness'] }),
  f('witness.initialsSurname', 'Witness', 'text', 'auto', 'Witness initials and surname', 'src.witness.name', (s) => txt(initialsSurname(s.witness?.name)), { syn: ['initials and surname of witness'] }),
  f('witness.dateOfBirth', 'Witness', 'date', 'auto-if-known', 'Witness date of birth', 'src.witness.dateOfBirth', (s) => (s.witness?.dateOfBirth ? { t: 'date', v: londonDate(s.witness.dateOfBirth) } : undefined)),
  f('witness.address', 'Witness', 'text', 'auto-if-known', 'Witness address', 'src.witness.address', (s) => txt(addressOneLine(s.witness?.address)), { syn: ['full address including postcode'] }),
  f('witness.phone', 'Witness', 'text', 'auto-if-known', 'Witness telephone', 'src.witness.phone', (s) => txt(s.witness?.phone)),
  f('witness.email', 'Witness', 'text', 'auto-if-known', 'Witness email', 'src.witness.email', (s) => txt(s.witness?.email)),
  f('witness.onBehalfOf', 'Witness', 'text', 'auto-if-known', 'Party on whose behalf made', "'Claimant'", (s) => (s.witness ? txt('Claimant') : undefined), { syn: ['party on whose behalf made'] }),
  f('witness.statementNumber', 'Witness', 'text', 'auto-if-known', 'Number of this statement', '1 + earlier non-void statement.witness documents for this witness', (s) => {
    const w = s.witness;
    if (!w) return undefined;
    const earlier = s.documents.filter((d) => (d.canonicalTemplateId === 'statement.witness' || d.canonicalTemplateId === 'statement.ccguk_04_witness') && d.status !== 'void' && d.subjectPartyId === w.id).length;
    return txt(ordinal(earlier + 1));
  }, { syn: ['number of this statement'] }),
  f('witness.exhibitRefsList', 'Witness', 'text', 'auto-if-known', 'Exhibits referred to', '`JS1–JS3` from initials + running numbers; `None` when empty', (s) => {
    if (!s.witness) return undefined;
    const ini = initials(s.witness.name);
    const n = s.exhibits.length;
    if (n === 0) return txt('None');
    if (!ini) return undefined;
    return txt(n === 1 ? `${ini}1` : `${ini}1–${ini}${n}`);
  }, { syn: ['exhibits referred to'] }),
  f('witness.exhibits', 'Witness', 'rows', 'auto-if-known', 'Exhibits', 'src.exhibits (capturedAt = EXIF original ?? capturedAt; never uploadedAt)', (s) => rows(exhibitRows(s)), {
    columns: { ref: ['ref', 'exhibit'], item: ['item'], pageOfTotal: ['page'], capturedAt: ['date'], deviceSource: ['device'], originalHeldBy: ['original'] }
  }),
  ...(
    [
      ['ref', 'Exhibit reference', 'text'],
      ['item', 'Exhibit item', 'text'],
      ['pageOfTotal', 'Exhibit page', 'text'],
      ['capturedAt', 'Exhibit date & time', 'datetime'],
      ['deviceSource', 'Exhibit device / source', 'text'],
      ['originalHeldBy', 'Original held by', 'text']
    ] as Array<[string, string, FieldType]>
  ).map(([k, label, type]) => f(`witness.exhibits[0].${k}`, 'Witness', type, 'auto-if-known', label, `src.exhibits[0] → ${k}`, (s) => exhibitField(s, 0, k))),
  h('witness.relationshipToClaimant', 'Witness', 'text', 'Relationship to claimant', { syn: ['relationship to claimant'] }),
  h('witness.paragraphs', 'Witness', 'list', 'Statement paragraphs (own words)'),

  // Intervention
  f('intervention.offerMade', 'Intervention', 'bool', 'auto-if-known', 'Offer made', 'subject offer present', (s) => yesIf(!!s.offer), { syn: ['offer made'] }),
  f('intervention.noOfferMade', 'Intervention', 'bool', 'suggest', 'No offer made', 'no offers on file (handler confirms)', (s) => yesIf(!s.offer && s.offers.length === 0), { syn: ['no offer made'] }),
  f('intervention.receivedAt', 'Intervention', 'datetime', 'auto-if-known', 'Date & time offer made', 'offer.receivedAt', (s) => dateTimeOf(s.offer?.receivedAt), { syn: ['date and time offer made'] }),
  f('intervention.channel', 'Intervention', 'choice', 'auto-if-known', 'Method', 'offer.channel (phone → telephone; sms/whatsapp/via_client → none)', (s) => {
    const c = s.offer?.channel;
    return choice(c === 'phone' ? 'telephone' : c === 'email' || c === 'letter' || c === 'portal' ? c : undefined);
  }, { choices: ch(['letter', 'Letter', 'letter'], ['email', 'Email', 'email'], ['telephone', 'Telephone', 'telephone'], ['portal', 'Portal', 'portal']) }),
  f('intervention.offerorName', 'Intervention', 'text', 'auto-if-known', 'Made by — name', 'offer.offerorName', (s) => txt(s.offer?.offerorName), { syn: ['made by name'] }),
  f('intervention.offerorOrganisation', 'Intervention', 'text', 'auto-if-known', 'Made by — organisation', 'party name of offer.offerorPartyId', (s) => txt(partyName(s, s.offer?.offerorPartyId)), { syn: ['organisation'] }),
  f('intervention.madeTo', 'Intervention', 'choice', 'auto-if-known', 'Made to', 'via_client → client, else ccguk', (s) => (s.offer ? choice(s.offer.channel === 'via_client' ? 'client' : 'ccguk') : undefined), { choices: ch(['client', 'Client directly', 'client'], ['ccguk', 'CCGUK', 'ccguk']) }),
  f('intervention.writtenOfferLocation', 'Intervention', 'text', 'auto-if-known', 'Where the written offer is filed', 'filenames of offer.evidenceIds', (s) => {
    const ids = s.offer?.evidenceIds ?? [];
    const names = s.evidence.filter((e) => ids.includes(e.id)).map((e) => e.filename);
    return names.length ? txt(`${names.join(', ')} (claim file ${s.claim.reference})`) : undefined;
  }, { syn: ['where the written offer is filed'] }),
  f('intervention.vehicleClassOffered', 'Intervention', 'text', 'auto-if-known', 'Group / class offered', 'offer.vehicleClassOffered', (s) => txt(s.offer?.vehicleClassOffered), { syn: ['group class'] }),
  f('intervention.suitable', 'Intervention', 'bool', 'auto-if-known', "Suitable for client's use", 'offer.suitable (tri-state)', (s) => bool(s.offer?.suitable), { syn: ['suitable for clients use'] }),
  f('intervention.terms.excessPence', 'Intervention', 'money', 'auto-if-known', 'Offer — insurance excess', 'offer.terms.excessPence', (s) => money(s.offer?.terms?.excessPence), { syn: ['insurance excess payable by client'] }),
  f('intervention.terms.mileageLimit', 'Intervention', 'text', 'auto-if-known', 'Offer — mileage limit', '`N miles per day`', (s) => (s.offer?.terms?.mileageLimitPerDay !== undefined ? txt(`${thousands(s.offer.terms.mileageLimitPerDay)} miles per day`) : undefined), { syn: ['mileage limit'] }),
  f('intervention.terms.durationStated', 'Intervention', 'text', 'auto-if-known', 'Offer — duration', 'offer.terms.durationStated', (s) => txt(s.offer?.terms?.durationStated), { syn: ['duration offered'] }),
  f('intervention.terms.otherTerms', 'Intervention', 'text', 'auto-if-known', 'Offer — conditions attached', 'offer.terms.otherTerms', (s) => txt(s.offer?.terms?.otherTerms), { syn: ['any condition attached'] }),
  f('intervention.clientDecision', 'Intervention', 'choice', 'auto-if-known', "Client's decision", 'offer.clientDecision (pending → none)', (s) => {
    const d = s.offer?.clientDecision;
    return choice(d === 'accepted' || d === 'declined' ? d : undefined);
  }, { choices: ch(['accepted', 'Accepted', 'accepted'], ['declined', 'Declined', 'declined']) }),
  f('intervention.replySentAt', 'Intervention', 'date', 'auto-if-known', 'Insurer notified of decision on', 'offer.replySentAt', (s) => dateOf(s.offer?.replySentAt), { syn: ['insurer notified of decision on'] }),
  f('intervention.clientReasons', 'Intervention', 'multiline', 'auto-if-known', "Client's reasons (own words)", 'offer.clientReasons verbatim (never suitabilityReasons)', (s) => verbatim(s.offer?.clientReasons), { syn: ['clients reasons'] }),
  f('intervention.chronology', 'Intervention', 'rows', 'auto-if-known', 'Chronology', 'events with a verbatim data.quote', (s) =>
    rows(
      eventsOfType(s, () => true)
        .filter((e) => dataString(e, 'quote'))
        .map((e) => ({ date: londonDate(e.at).split('-').reverse().join('/'), who: dataString(e, 'who') ?? partyName(s, dataString(e, 'partyId')) ?? '', text: `"${dataString(e, 'quote')}"`, daysLost: '' }))
    ), { columns: { date: ['date'], who: ['who'], text: ['what', 'text'], daysLost: ['days-lost'] } }),
  ...(
    [
      ['writtenTermsReceived', 'Written terms received', 'bool'],
      ['vehicleOffered', 'Vehicle offered — make & model', 'text'],
      ['transmissionOffered', 'Transmission offered', 'choice'],
      ['matchesClientVehicle', "Matches client's own vehicle", 'bool'],
      ['fuelTypeOffered', 'Fuel type offered', 'text'],
      ['terms.depositPence', 'Deposit or payment required', 'money'],
      ['terms.depositNone', 'No deposit', 'bool'],
      ['terms.excessNotStated', 'Excess not stated', 'bool'],
      ['permittedDrivers', 'Permitted drivers', 'text'],
      ['minimumDriverAge', 'Minimum driver age', 'text'],
      ['excessMileageCharge', 'Charge for excess mileage', 'text'],
      ['onExpiry', 'What happens when it expires', 'text'],
      ['deliveryAt', 'Delivery date and time offered', 'datetime'],
      ['deliveryAddress', 'Delivery address offered', 'text'],
      ['repairOffered', 'Repair offered as part of it', 'bool'],
      ['repairerOffered', 'Repairer offered', 'text'],
      ['courtesyCarForFullRepair', 'Courtesy car for full repair', 'bool'],
      ['costToClient', 'Any cost at all to the client', 'text'],
      ['termsPutToClientAt', 'Terms put to client on', 'datetime'],
      ['termsPutToClientBy', 'Terms put to client by', 'choice'],
      ['confirmedToClientOn', 'Confirmed to client in writing on', 'date'],
      ['hireEndedAsResult', 'Hire ended as a result', 'bool'],
      ['daysSaved', 'Days saved', 'int'],
      ['valueOfDaysSaved', 'Value of days saved', 'money'],
      ['calculatedBy', 'Calculated by', 'text']
    ] as Array<[string, string, FieldType]>
  ).map(([k, label, type]) =>
    h(`intervention.${k}`, 'Intervention', type, label, {
      syn: [label.toLowerCase()],
      ...(k === 'transmissionOffered' ? { choices: ch(['automatic', 'Automatic', 'automatic'], ['manual', 'Manual', 'manual'], ['not_stated', 'Not stated', 'not-stated']) } : {}),
      ...(k === 'termsPutToClientBy' ? { choices: ch(['telephone', 'Telephone', 'telephone'], ['email', 'Email', 'email'], ['in_person', 'In person', 'in-person']) } : {})
    })
  ),

  // Means (every figure and answer is the client's — handler only)
  h('means.employmentStatus', 'Means', 'text', 'Employment status', { syn: ['employment status'] }),
  h('means.dependants', 'Means', 'text', 'Number of dependants', { syn: ['number of dependants'] }),
  h('means.householdAdults', 'Means', 'text', 'Household adults', { syn: ['household adults'] }),
  ...MEANS_INCOME.flatMap(([k, label]) => [h(`means.income.${k}.amount`, 'Means', 'money', `Income — ${label} (amount)`), h(`means.income.${k}.frequency`, 'Means', 'text', `Income — ${label} (frequency)`)]),
  h('means.income.totalMonthly', 'Means', 'money', 'Total monthly income', { syn: ['total monthly income'] }),
  ...MEANS_OUTGOINGS.flatMap(([k, label]) => [h(`means.outgoings.${k}.amount`, 'Means', 'money', `Outgoings — ${label} (amount)`), h(`means.outgoings.${k}.frequency`, 'Means', 'text', `Outgoings — ${label} (frequency)`)]),
  h('means.outgoings.totalMonthly', 'Means', 'money', 'Total monthly outgoings', { syn: ['total monthly outgoings'] }),
  h('means.currentAccountBalance', 'Means', 'money', 'Current account balance on the day hire began'),
  h('means.savingsTotal', 'Means', 'money', 'Savings, ISAs or other accounts — total'),
  h('means.overdraftLimit', 'Means', 'money', 'Overdraft facility'),
  h('means.overdraftUsed', 'Means', 'money', 'Overdraft already used'),
  ...[0, 1].flatMap((i) => [
    h(`means.creditCards[${i}].provider`, 'Means', 'text', `Credit card ${i + 1} — provider`),
    h(`means.creditCards[${i}].limitBalance`, 'Means', 'text', `Credit card ${i + 1} — limit / balance`),
    h(`means.creditCards[${i}].limit`, 'Means', 'money', `Credit card ${i + 1} — limit`),
    h(`means.creditCards[${i}].balance`, 'Means', 'money', `Credit card ${i + 1} — balance`)
  ]),
  h('means.otherCredit', 'Means', 'text', 'Any other credit facility available'),
  h('means.couldPay500Upfront', 'Means', 'bool', 'Could have paid roughly £500 upfront'),
  h('means.sacrificesNarrative', 'Means', 'multiline', 'What the client would have had to go without'),
  h('means.otherVehicleInHousehold', 'Means', 'bool', 'Any other vehicle in the household'),
  h('means.otherVehicleDetails', 'Means', 'text', 'Other vehicle — make, model and who uses it'),
  h('means.otherVehicleAvailable', 'Means', 'bool', 'Other vehicle available to the client'),
  h('means.otherVehicleExplanation', 'Means', 'multiline', 'Other vehicle — explanation'),
  h('means.publicTransportSuitable', 'Means', 'bool', 'Public transport could have covered the journeys'),
  h('means.publicTransportExplanation', 'Means', 'multiline', 'Public transport — explanation'),
  h('means.docsReceivedOn', 'Means', 'date', 'Documents received on'),
  h('means.docsReceivedBy', 'Means', 'text', 'Documents received by'),
  h('means.docsOutstanding', 'Means', 'text', 'Documents outstanding'),
  h('means.docsChasedOn', 'Means', 'date', 'Documents chased on'),
  h('means.completedWithClientBy', 'Means', 'text', 'Completed with client by'),
  h('means.completedWithClientOn', 'Means', 'date', 'Completed with client on'),
  h('means.figuresCrossChecked', 'Means', 'bool', 'Figures cross-checked against bank statements'),
  h('means.checkedBy', 'Means', 'text', 'Means checked by'),
  h('means.discrepancies', 'Means', 'multiline', 'Discrepancies found'),
  h('means.impecuniosityReliedOn', 'Means', 'choice', 'Impecuniosity to be relied on', { syn: ['impecuniosity to be relied on'], choices: ch(['yes', 'Yes', 'yes'], ['no', 'No', 'no'], ['alternative', 'In the alternative', 'in-the-alternative']) }),
  h('means.decisionBy', 'Means', 'text', 'Impecuniosity decision by'),
  f('means.statementCompletedOn', 'Means', 'date', 'auto-if-known', 'Statement of Means completed on', 'signed date of the 07 document', (s) => dateOf((signedDocument(s, 'form.ccguk_07_statement_of_means') ?? signedDocument(s, 'form.statement_of_means'))?.signedAt)),
  ...MEANS_DOCS.map(([k, label, kinds]) => f(`means.docs.${k}`, 'Means', 'bool', 'suggest', `Supplied — ${label}`, `evidence kinds ${kinds.join(', ')}`, (s) => yesIf(evidenceOfKinds(s, kinds).length > 0))),

  // Evidence
  f('evidence.photosTaken', 'Evidence', 'bool', 'auto-if-known', 'Photographs taken', "evidence of kind 'photo'", (s) => yesIf(photos(s).length > 0), { syn: ['photographs taken'] }),
  f('evidence.photoCount', 'Evidence', 'int', 'auto-if-known', 'Number of photographs', "evidence of kind 'photo'", (s) => (photos(s).length ? int(photos(s).length) : undefined), { syn: ['number'] }),
  f('evidence.photosStoredAt', 'Evidence', 'text', 'suggest', 'Photographs stored at', '`ClaimDesk evidence store, claim <reference>`', (s) => (photos(s).length ? txt(evidenceStore(s)) : undefined), { syn: ['stored at'] }),
  ...EVIDENCE_ROWS.flatMap(([k, label]) => [
    f(`evidence.${k}`, 'Evidence', 'rows', 'suggest', `Evidence held — ${label}`, 'matching evidence kinds / documents (first date, filename)', (s) => {
      const r = evidenceRow(s, k);
      return r ? rows([{ held: 'Yes', date: r.date ? londonDate(r.date).split('-').reverse().join('/') : '', ref: r.ref ?? '' }]) : undefined;
    }, { columns: { held: ['held'], date: ['date'], ref: ['reference', 'ref'] } }),
    f(`evidence.${k}.held`, 'Evidence', 'choice', 'suggest', `Evidence held — ${label}`, 'matching evidence kinds / documents', (s) => (evidenceRow(s, k) ? choice('yes') : undefined), { choices: ch(['yes', 'Yes', 'yes'], ['na', 'N/A', 'n-a']) }),
    f(`evidence.${k}.date`, 'Evidence', 'date', 'suggest', `Evidence date — ${label}`, 'first matching date', (s) => dateOf(evidenceRow(s, k)?.date)),
    f(`evidence.${k}.ref`, 'Evidence', 'text', 'suggest', `Evidence reference — ${label}`, 'filename / reference', (s) => txt(evidenceRow(s, k)?.ref))
  ]),

  // Diary
  f('clocks.cctvPreservation.startDate', 'Diary', 'date', 'auto-if-known', 'CCTV preservation requests sent — day 1', 'clock cctv_preservation startsAt', (s) => dateOf(s.clocks.find((c) => c.kind === 'cctv_preservation')?.startsAt)),
  f('clocks.cctvPreservation.followUpDate', 'Diary', 'date', 'auto-if-known', 'CCTV follow-up', 'clock cctv_preservation dueAt', (s) => dateOf(s.clocks.find((c) => c.kind === 'cctv_preservation')?.dueAt)),
  f('clocks.chaser1.dueDate', 'Diary', 'date', 'auto-if-known', 'Third-party insurer first chaser', 'clock chaser_day_7 dueAt', (s) => dateOf(s.clocks.find((c) => c.kind === 'chaser_day_7')?.dueAt)),
  f('clocks.chaser2.dueDate', 'Diary', 'date', 'auto-if-known', 'Second chaser', 'clock chaser_day_14 dueAt', (s) => dateOf(s.clocks.find((c) => c.kind === 'chaser_day_14')?.dueAt)),
  f('clocks.icobs3Months.dueDate', 'Diary', 'date', 'auto-if-known', 'Three-month point for a reasoned reply', 'clock icobs_8_2_6_three_months dueAt', (s) => dateOf(s.clocks.find((c) => c.kind === 'icobs_8_2_6_three_months')?.dueAt)),
  f('clocks.limitation.dueDate', 'Diary', 'date', 'auto-if-known', 'Limitation date', 'clock limitation_tort_6y dueAt', (s) => dateOf(s.clocks.find((c) => c.kind === 'limitation_tort_6y')?.dueAt)),

  // Recipient
  f('recipient.name', 'Recipient', 'text', 'auto', 'Recipient name', 'src.recipient.name', (s) => txt(s.recipient?.name), { syn: ['insurer or company name', 'recipient'] }),
  h('recipient.attentionName', 'Recipient', 'text', 'For the attention of (person)', { syn: ['name of handler', 'for the attention of'] }),
  f('recipient.department', 'Recipient', 'text', 'auto-if-known', 'Department / team', 'src.recipient.attention', (s) => txt(s.recipient?.attention), { syn: ['department team'] }),
  f('recipient.addressLines', 'Recipient', 'list', 'auto-if-known', 'Address lines', 'src.recipient.addressLines (all but last)', (s) => list((s.recipient?.addressLines ?? []).slice(0, -1))),
  f('recipient.addressLine1', 'Recipient', 'text', 'auto-if-known', 'Address line 1', 'src.recipient.addressLines[0] (when more than one line)', (s) => {
    const l = s.recipient?.addressLines ?? [];
    return l.length > 1 ? txt(l[0]) : undefined;
  }, { syn: ['address line 1'] }),
  f('recipient.addressLine2', 'Recipient', 'text', 'auto-if-known', 'Address line 2', 'src.recipient.addressLines between the first and the last', (s) => {
    const l = s.recipient?.addressLines ?? [];
    return l.length > 2 ? txt(l.slice(1, -1).join(', ')) : undefined;
  }, { syn: ['address line 2'] }),
  f('recipient.townPostcode', 'Recipient', 'text', 'auto-if-known', 'Town, POSTCODE', 'last address line', (s) => txt((s.recipient?.addressLines ?? []).slice(-1)[0]), { syn: ['town postcode'] }),
  f('recipient.email', 'Recipient', 'text', 'auto-if-known', 'By email', 'src.recipient.email', (s) => txt(s.recipient?.email), { syn: ['by email', 'recipient insurer co uk'] }),
  f('recipient.theirReference', 'Recipient', 'text', 'auto-if-known', 'Your ref', 'src.recipient.theirReference', (s) => txt(s.recipient?.theirReference), { syn: ['your ref', 'insurer reference'] }),
  f('recipient.salutation', 'Recipient', 'text', 'auto-if-known', 'Salutation', "'Sir or Madam' unless a named addressee is entered", (s) => (s.recipient ? txt('Sir or Madam') : undefined), { syn: ['sir or madam', 'dear'] })
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export const FIELD_DEFS: readonly FieldDef[] = Object.freeze(defs);

const BY_KEY = new Map<string, FieldDef>();
for (const d of FIELD_DEFS) {
  if (BY_KEY.has(d.key)) throw new Error(`duplicate field key ${d.key}`);
  BY_KEY.set(d.key, d);
}
for (const d of FIELD_DEFS) for (const a of d.aliases ?? []) BY_KEY.set(a, d);

/** The FieldDef for a key or one of its aliases (Appendix 1). */
export function getFieldDef(key: string): FieldDef | undefined {
  return BY_KEY.get(key);
}

/** Groups in dictionary order, each with its fields (for the mapping editor). */
export function listFieldGroups(): Array<{ group: FieldGroup; fields: FieldDef[] }> {
  const out = new Map<FieldGroup, FieldDef[]>();
  for (const d of FIELD_DEFS) {
    const list = out.get(d.group) ?? [];
    list.push(d);
    out.set(d.group, list);
  }
  return [...out.entries()].map(([group, fields]) => ({ group, fields }));
}


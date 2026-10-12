/**
 * Missing-documents checklist per case kind and the prepared request to the client (docs/SMART-INTAKE.md §4.9,
 * improvement 4). The request is plain English: what we still need and what is acceptable — no figures and nothing
 * about insurers' offers (copy guard). It is sent only through the outbox approval (doc_request always asks).
 */
import type { DocType } from '../../agents/types.js';
import { BANNED_INTAKE_WORDS, type BundleFieldKey, type CaseKind, type ChecklistItem, type PhotoScene } from './types.js';
import { daysBetween } from './text.js';

export function caseKindOf(d: { hireNeeded: boolean | null; totalLoss: boolean; repair: boolean; tpRegistrationUnknown: boolean }): CaseKind {
  if (d.tpRegistrationUnknown) return 'untraced';
  if (d.totalLoss) return 'total_loss';
  if (d.hireNeeded === true) return 'non_fault_credit_hire';
  if (d.hireNeeded === false) return 'non_fault_repair_only';
  return d.repair ? 'non_fault_repair_only' : 'unknown';
}

export interface ChecklistInput {
  caseKind: CaseKind;
  files: Array<{ fileId: string; docType: DocType | null; docSide: 'front' | 'back' | null; formTemplateId: string | null; scene: PhotoScene | null; excluded: boolean; platesVisible?: boolean }>;
  fields: Partial<Record<BundleFieldKey, string | null>>;
  witnesses: number;
  accidentDate: string | null;
  firstRegistered: string | null;
  policeAttended: boolean | null;
  /** The licence and the V5C show different addresses. */
  addressesDiffer?: boolean;
}

export const CHECKLIST_LABELS: Readonly<Record<string, string>> = {
  v5c: 'V5C (logbook) for the client’s car',
  licence_front: 'Driving licence, front (the driver’s)',
  licence_back: 'Driving licence, back (the driver’s)',
  insurance_certificate: 'Client’s insurance certificate',
  damage_photos: 'Photos of the damage (at least 4, one showing the number plate)',
  tp_details: 'Other side’s details (registration and insurer, or name and phone)',
  accident_account: 'Client’s own account of the accident',
  estimate_or_report: 'Repair estimate or engineer’s report',
  bank_details: 'Bank details for payment (payment direction form or statement header)',
  signed_hire_docs: 'Signed hire paperwork (letter of authority, credit hire agreement)',
  police_report: 'Police report / reference',
  mot_certificate: 'MOT certificate',
  witness_statements: 'Witness statements',
  proof_of_address: 'Proof of address',
};

/** What the client can send for each item (used in the request email). */
const ACCEPTABLE: Readonly<Record<string, string>> = {
  v5c: 'a photo or scan of the V5C logbook (all pages with writing on them)',
  licence_front: 'a clear photo of the front of the driver’s licence',
  licence_back: 'a clear photo of the back of the driver’s licence',
  insurance_certificate: 'your motor insurance certificate (the PDF from your insurer is fine)',
  damage_photos: 'at least four photos of the damage, with one showing the number plate',
  tp_details: 'anything you have about the other driver: their registration, insurer, name or phone number',
  accident_account: 'a few lines in your own words about how the accident happened',
  estimate_or_report: 'the repair estimate or engineer’s report, if you have one',
  bank_details: 'your bank details for payment (we can send you our payment form)',
  signed_hire_docs: 'the signed hire paperwork we sent you',
  police_report: 'the police reference number or report',
  mot_certificate: 'the current MOT certificate',
  witness_statements: 'the witness’s contact details or written statement',
  proof_of_address: 'a recent utility or council tax bill showing your address',
};

const PHOTO_TYPES = new Set<DocType>(['damage_photo', 'vehicle_photo_other']);

export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const files = input.files.filter((f) => !f.excluded);
  const of = (...types: DocType[]) => files.filter((f) => f.docType && types.includes(f.docType));
  const ids = (fs: Array<{ fileId: string }>) => fs.map((f) => f.fileId);
  const items: ChecklistItem[] = [];
  const add = (id: string, status: ChecklistItem['status'], why: string, fileIds: string[] = []) => items.push({ id, label: CHECKLIST_LABELS[id] ?? id, status, why, fileIds });
  const field = (k: BundleFieldKey) => (input.fields[k] ?? '').trim() || null;

  // V5C
  const v5c = of('v5c');
  add('v5c', v5c.length ? 'have' : 'missing', v5c.length ? 'Received' : 'Proves who keeps the car and its VIN', ids(v5c));

  // Licence front / back
  const licences = of('driving_licence');
  const fronts = licences.filter((f) => f.docSide !== 'back');
  const backs = licences.filter((f) => f.docSide === 'back');
  add('licence_front', fronts.length ? 'have' : 'missing', fronts.length ? 'Received' : 'Needed to confirm the driver can drive a hire car', ids(fronts));
  const unknownSide = licences.some((f) => f.docSide === null);
  add('licence_back', backs.length ? 'have' : unknownSide ? 'partial' : 'missing', backs.length ? 'Received' : unknownSide ? 'A licence was received but the back (entitlements and endorsements) cannot be confirmed' : 'Shows entitlements and endorsements', ids(backs.length ? backs : unknownSide ? licences : []));

  // Insurance certificate
  const ins = of('insurance_certificate');
  add('insurance_certificate', ins.length ? 'have' : 'missing', ins.length ? 'Received' : 'Shows the client’s cover on the accident date', ids(ins));

  // Damage photos
  const photos = files.filter((f) => (f.scene === 'damage' || (f.scene === null && f.docType !== null && PHOTO_TYPES.has(f.docType))) && (f.docType === null || PHOTO_TYPES.has(f.docType)));
  const plate = files.some((f) => f.scene === 'number_plate' || f.platesVisible === true);
  const n = photos.length;
  add('damage_photos', n === 0 ? 'missing' : n >= 4 && plate ? 'have' : 'partial', n === 0 ? 'No photos of the damage yet' : n >= 4 && plate ? `${n} photos received` : n < 4 ? `${n} photo${n === 1 ? '' : 's'} received; at least 4 are needed` : 'No photo shows the number plate', ids(photos));

  // Other side's details
  if (input.caseKind === 'untraced') add('tp_details', 'not_needed', 'The other driver was not traced');
  else {
    const reg = field('tp.registration');
    const insurer = field('tp.insurerName') || field('tp.policyNumber');
    const contact = field('tp.name') && field('tp.phone');
    add('tp_details', reg && (insurer || contact) ? 'have' : reg || insurer || contact ? 'partial' : 'missing', reg && (insurer || contact) ? 'Registration and insurer or contact known' : reg ? 'Registration known; insurer or contact details still needed' : 'Needed to notify the other side’s insurer');
  }

  // Client's account
  const forms = files.filter((f) => f.docType === 'fnol_form' || (f.docType === 'signed_ccguk_form' && f.formTemplateId === 'form.ccguk_09_accident_report'));
  add('accident_account', forms.length ? 'have' : 'missing', forms.length ? 'The client’s own account is in the documents' : 'Not in the documents — take it on the call (in the client’s own words)', ids(forms));

  // Estimate / report
  const est = of('bodyshop_estimate', 'audatex_estimate', 'engineer_report');
  add('estimate_or_report', est.length ? 'have' : 'missing', est.length ? 'Received' : 'Needed to value the repair', ids(est));

  // Bank details
  const bank = files.filter((f) => f.docType === 'bank_statement' || f.formTemplateId === 'form.ccguk_05_payment_direction');
  add('bank_details', bank.length ? 'have' : 'missing', bank.length ? 'Received' : 'Needed before any payment to the client', ids(bank));

  // Signed hire docs
  if (input.caseKind !== 'non_fault_credit_hire') add('signed_hire_docs', 'not_needed', 'No replacement car is needed (yet)');
  else {
    const loa = files.filter((f) => f.formTemplateId === 'agreement.ccguk_01_customer_loa');
    const cha = files.filter((f) => f.formTemplateId === 'agreement.ccguk_03_credit_hire');
    add('signed_hire_docs', loa.length && cha.length ? 'have' : loa.length || cha.length ? 'partial' : 'missing', loa.length && cha.length ? 'Both signed' : loa.length ? 'The credit hire agreement is still to be signed' : cha.length ? 'The letter of authority is still to be signed' : 'Prepared by the Autopilot after the claim is registered', ids([...loa, ...cha]));
  }

  // Police
  if (input.policeAttended === true || input.caseKind === 'untraced') {
    const pol = of('police_report');
    const ref = field('accident.policeReference');
    add('police_report', pol.length || ref ? 'have' : 'missing', pol.length ? 'Received' : ref ? `Police reference ${ref} recorded` : 'The police attended; their reference is needed', ids(pol));
  } else add('police_report', 'not_needed', input.policeAttended === false ? 'The police did not attend' : 'Not known whether the police attended');

  // MOT (car more than 3 years old at the accident)
  const firstReg = input.firstRegistered ? `${input.firstRegistered.slice(0, 7)}-01` : null;
  const age = firstReg && input.accidentDate ? daysBetween(firstReg, input.accidentDate.slice(0, 10)) : null;
  if (age !== null && age > 3 * 365.25) {
    const mot = of('mot_certificate');
    add('mot_certificate', mot.length ? 'have' : 'missing', mot.length ? 'Received' : 'The car is over three years old', ids(mot));
  } else add('mot_certificate', 'not_needed', age === null ? 'The car’s age is not known yet' : 'The car is under three years old');

  // Witness statements
  if (input.witnesses > 0) {
    const ws = files.filter((f) => f.docType === 'witness_statement' || f.formTemplateId === 'statement.ccguk_04_witness');
    add('witness_statements', ws.length >= input.witnesses ? 'have' : ws.length ? 'partial' : 'missing', `${ws.length} of ${input.witnesses} witness statement${input.witnesses === 1 ? '' : 's'}`, ids(ws));
  } else add('witness_statements', 'not_needed', 'No witnesses listed');

  // Proof of address
  if (input.addressesDiffer) {
    const poa = of('proof_of_address');
    add('proof_of_address', poa.length ? 'have' : 'missing', poa.length ? 'Received' : 'The licence and the V5C show different addresses', ids(poa));
  } else add('proof_of_address', 'not_needed', 'Addresses agree');

  return items;
}

/** The prepared request to the client for the missing and partial items (plain English; no figures, no advice). */
export function requestEmailText(items: ChecklistItem[], clientFirstName: string | null, reference: string | null): { subject: string; body: string } {
  const wanted = items.filter((i) => i.status === 'missing' || i.status === 'partial').filter((i) => i.id !== 'signed_hire_docs');
  const subject = `${reference ? `${reference}: ` : ''}Documents we still need for your claim`;
  const lines = [
    `Dear ${clientFirstName?.trim() || 'Sir or Madam'},`,
    '',
    'Thank you for sending your documents. To deal with your claim we still need:',
    '',
    ...wanted.map((i) => `- ${CHECKLIST_LABELS[i.id] ?? i.label}: ${ACCEPTABLE[i.id] ?? 'a copy'}`),
    '',
    'You can reply to this email with photos or scans — a clear phone photo is fine.',
  ];
  const body = lines.join('\n');
  if (BANNED_INTAKE_WORDS.test(body)) throw new Error('request text failed the wording check');
  return { subject, body };
}

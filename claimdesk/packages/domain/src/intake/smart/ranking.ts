/**
 * Source ranking (docs/SMART-INTAKE.md §4.6, improvement 2): which document a person would trust for each detail —
 * the V5C for the VIN, the licence for the date of birth, the police report for the accident time. 0–100 per document
 * type; unlisted types 30; photos / EXIF 20; the bundle-name hint 10; the owner 1000. Ties: owner > ai > ai_reasoning
 * > rules > plate > exif > name_hint.
 */
import type { DocType } from '../../agents/types.js';
import type { BundleFieldKey, CandidateEngine } from './types.js';

type Ranks = Partial<Record<DocType, number>>;

const PHOTOS: DocType[] = ['damage_photo', 'vehicle_photo_other'];
const FORMS: DocType[] = ['fnol_form', 'signed_ccguk_form'];
const LETTERS: DocType[] = ['insurer_letter', 'correspondence'];
const ESTIMATES: DocType[] = ['bodyshop_estimate', 'audatex_estimate'];

function r(...pairs: Array<[DocType | DocType[], number]>): Ranks {
  const out: Ranks = {};
  for (const [t, n] of pairs) for (const x of Array.isArray(t) ? t : [t]) out[x] = n;
  return out;
}

const VIN = r(['v5c', 100], ['engineer_report', 85], ['audatex_estimate', 80], ['bodyshop_estimate', 75], ['mot_certificate', 70], ['insurance_certificate', 60], [PHOTOS, 50], [FORMS, 40], [LETTERS, 30]);
const VRM = r(['v5c', 100], ['insurance_certificate', 90], ['mot_certificate', 85], ['engineer_report', 80], [ESTIMATES, 75], ['police_report', 70], [FORMS, 60], [PHOTOS, 50], [LETTERS, 50]);
const VEHICLE = r(['v5c', 100], ['engineer_report', 80], [ESTIMATES, 75], ['mot_certificate', 70], ['insurance_certificate', 60], [FORMS, 40]);
const IDENTITY = r(['driving_licence', 100], ['insurance_certificate', 70], ['signed_ccguk_form', 60], ['fnol_form', 50]);
const NAME = r(['driving_licence', 95], ['insurance_certificate', 85], ['v5c', 80], ['signed_ccguk_form', 80], ['fnol_form', 70], [LETTERS, 40]);
const ADDRESS = r(['proof_of_address', 95], ['driving_licence', 85], ['v5c', 80], ['insurance_certificate', 75], [FORMS, 60], [LETTERS, 50]);
const CONTACT = r(['signed_ccguk_form', 90], ['fnol_form', 85], ['correspondence', 80], ['insurer_letter', 40]);
const WHEN = r(['police_report', 100], ['fnol_form', 90], ['signed_ccguk_form', 88], ['insurer_letter', 70], ['engineer_report', 60], [ESTIMATES, 40], ['correspondence', 40], [PHOTOS, 20]);
const WHERE = r(['police_report', 100], ['fnol_form', 90], ['signed_ccguk_form', 88], ['insurer_letter', 60], [PHOTOS, 30]);
const ACCOUNT = r(['fnol_form', 100], ['signed_ccguk_form', 100], ['police_report', 70], ['witness_statement', 60], ['insurer_letter', 30]);
const TP = r(['police_report', 95], ['insurer_letter', 90], [FORMS, 70], [PHOTOS, 40], ['correspondence', 60]);
const TP_INSURER = r(['insurer_letter', 100], ['correspondence', 80], ['police_report', 70], [FORMS, 60]);
const POLICE = r(['police_report', 100], [FORMS, 70], [LETTERS, 60]);
const CLIENT_INSURER = r(['insurance_certificate', 100], [FORMS, 70], [LETTERS, 40]);
const TP_CONTACT = r(['police_report', 95], [FORMS, 70], ['insurer_letter', 60], ['correspondence', 50]);
const ANSWERS = r([FORMS, 100], ['police_report', 70], ['engineer_report', 60], [LETTERS, 40]);
const DRIVEABLE = r([FORMS, 100], ['engineer_report', 80], ['police_report', 70], [LETTERS, 40]);
const REPAIRER = r([ESTIMATES, 100], ['invoice', 80], [FORMS, 60], [LETTERS, 50]);
const ENGINEER = r(['engineer_report', 100], [LETTERS, 50], [FORMS, 60]);

/** Source ranks per bundle key (every key listed). */
export const SOURCE_RANKS: Readonly<Record<BundleFieldKey, Ranks>> = {
  'client.name': NAME,
  'client.dateOfBirth': IDENTITY,
  'client.address': ADDRESS,
  'client.phone': CONTACT,
  'client.email': CONTACT,
  'client.drivingLicenceNumber': IDENTITY,
  'driver.name': NAME,
  'driver.dateOfBirth': IDENTITY,
  'driver.address': ADDRESS,
  'driver.phone': CONTACT,
  'driver.drivingLicenceNumber': IDENTITY,
  'vehicle.registration': VRM,
  'vehicle.vin': VIN,
  'vehicle.make': VEHICLE,
  'vehicle.model': VEHICLE,
  'vehicle.colour': VEHICLE,
  'vehicle.firstRegistered': VEHICLE,
  'clientInsurer.name': CLIENT_INSURER,
  'clientInsurer.policyNumber': CLIENT_INSURER,
  'tp.name': TP,
  'tp.phone': TP_CONTACT,
  'tp.address': TP_CONTACT,
  'tp.registration': TP,
  'tp.make': TP,
  'tp.model': TP,
  'tp.insurerName': TP_INSURER,
  'tp.policyNumber': TP_INSURER,
  'tp.insurerRef': TP_INSURER,
  'accident.occurredAt': WHEN,
  'accident.location': WHERE,
  'accident.postcode': WHERE,
  'accident.circumstances': ACCOUNT,
  'accident.policeAttended': POLICE,
  'accident.policeReference': POLICE,
  'accident.injuries': ANSWERS,
  'accident.driveable': DRIVEABLE,
  'hire.needed': ANSWERS,
  'repairer.name': REPAIRER,
  'repairer.phone': REPAIRER,
  'engineer.name': ENGINEER,
  'engineer.reference': ENGINEER,
};

export const DEFAULT_RANK = 30;
export const PHOTO_RANK = 20;
export const NAME_HINT_RANK = 10;
export const OWNER_RANK = 1000;

/** Engine order for ties (higher first). */
export const ENGINE_ORDER: Readonly<Record<CandidateEngine, number>> = { owner: 7, ai: 6, ai_reasoning: 5, rules: 4, plate: 3, exif: 2, name_hint: 1 };

/** How much a person would trust `docType` (read by `engine`) for `key`. */
export function sourceRank(key: BundleFieldKey, docType: DocType | null, engine: CandidateEngine): number {
  if (engine === 'owner') return OWNER_RANK;
  if (engine === 'name_hint') return NAME_HINT_RANK;
  const table = SOURCE_RANKS[key];
  if (engine === 'exif') return table.damage_photo !== undefined ? Math.min(table.damage_photo, PHOTO_RANK) : PHOTO_RANK;
  if (engine === 'plate') return table.damage_photo ?? PHOTO_RANK;
  if (!docType) return DEFAULT_RANK;
  const v = table[docType];
  if (v !== undefined) return v;
  return PHOTOS.includes(docType) ? PHOTO_RANK : DEFAULT_RANK;
}

/** Plain names of document types for explanations ("the bodyshop estimate"). */
export const DOC_TYPE_PLAIN: Readonly<Record<DocType, string>> = {
  v5c: 'V5C',
  driving_licence: 'driving licence',
  insurance_certificate: 'insurance certificate',
  police_report: 'police report',
  fnol_form: 'accident report form',
  insurer_letter: 'insurer’s letter',
  engineer_report: 'engineer’s report',
  bodyshop_estimate: 'bodyshop estimate',
  audatex_estimate: 'Audatex estimate',
  invoice: 'invoice',
  damage_photo: 'damage photo',
  vehicle_photo_other: 'photo',
  signed_ccguk_form: 'signed CCGUK form',
  bank_statement: 'bank statement',
  payslip: 'payslip',
  mot_certificate: 'MOT certificate',
  correspondence: 'email',
  witness_statement: 'witness statement',
  proof_of_address: 'proof of address',
  other: 'document',
};

const KEY_PLAIN: Partial<Record<BundleFieldKey, string>> = {
  'vehicle.vin': 'the VIN',
  'vehicle.registration': 'the registration',
  'client.dateOfBirth': 'the date of birth',
  'client.name': 'the client’s name',
  'accident.occurredAt': 'the accident time',
  'accident.location': 'the accident location',
  'accident.circumstances': 'what happened',
};

function who(s: { docType: DocType | null; engine: CandidateEngine }): string {
  if (s.engine === 'owner') return 'Your own entry';
  if (s.engine === 'name_hint') return 'The bundle name';
  if (s.engine === 'exif') return 'The photo’s camera data';
  if (s.engine === 'plate') return 'A plate read in a photo';
  const t = s.docType ? DOC_TYPE_PLAIN[s.docType] : 'document';
  return t === 'V5C' ? 'The V5C' : `The ${t}`;
}

/** "The V5C outranks the bodyshop estimate for the VIN". */
export function rankWhy(key: BundleFieldKey, winner: { docType: DocType | null; engine: CandidateEngine }, loser: { docType: DocType | null; engine: CandidateEngine }): string {
  const what = KEY_PLAIN[key] ?? `the ${key.split('.').pop()!.replace(/([A-Z])/g, ' $1').toLowerCase()}`;
  const w = who(winner);
  const l = who(loser);
  if (w === l) return `${w} gives two different readings for ${what}; the clearer reading is preselected`;
  return `${w} outranks ${l.charAt(0).toLowerCase()}${l.slice(1)} for ${what}`;
}

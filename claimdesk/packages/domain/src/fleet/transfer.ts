/**
 * Owner-liability transfer and s.172 driver identification (BLUEPRINT §3.12, §5.2; playbooks.md §8;
 * perimeter.md "Nominating a driver who was not driving").
 *
 * liabilityTransferParticulars — the Road Traffic (Owner Liability) Regulations 2000 Sch 2 particulars
 * a vehicle-hire firm gives the enforcement authority (hirer's full name, permanent address, date of birth,
 * driving licence number, hire start and end, registration mark, agreement number) with the hirer's signed
 * statement of liability, and the list of anything missing. London councils require a signed hire agreement
 * holding those fields; company hirers are excepted from date of birth and licence number.
 *
 * s172ResponseData — the data for a s.172 RTA 1988 response (28 days): the driver identified from the hire
 * records, or the hirer as the person in possession where several permitted drivers exist, or, where the
 * records genuinely cannot say who was driving, the s.172(4) reasonable-diligence evidence checklist.
 * Never a nomination of someone who was not driving.
 */
import type { Address, FleetUnit, HireAgreement, ISODate, ISODateTime, Party, PenaltyNotice, Vehicle } from '../types.js';
import { calendarDaysBetween, compareIso, londonParts } from '../calendar/index.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "14:12 on 25 September 2026" — London wall-clock, for wording that goes into a notice (never a raw ISO stamp). */
export function formatLondonDateTime(iso: ISODateTime): string {
  const p = londonParts(iso);
  return `${pad2(p.hour)}:${pad2(p.minute)} on ${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

export const HIRE_FIRM_NAME = 'Courtesy Cars Group UK Ltd';
export const HIRE_FIRM_COMPANY_NUMBER = '17430389';

export const OWNER_LIABILITY_BASIS = [
  'Road Traffic (Owner Liability) Regulations 2000, Sch 2 — particulars to be given by a vehicle-hire firm, with the hirer’s signed statement of liability',
  'Road Traffic Offenders Act 1988 s.66 / Traffic Management Act 2004 — hirer liable in place of the owner where the particulars and statement are given',
  'Civil Enforcement of Road Traffic Contraventions (Representations and Appeals) (England) Regulations 2022 — ground of representation: the vehicle was hired under a hiring agreement and the hirer signed a statement of liability (BLUEPRINT §5.2 "the 2022 England ... Regulations"; confirm the exact regulation before it is cited in a letter)',
  'Protection of Freedoms Act 2012 Sch 4 paras 13–14 — private parking: hire agreement and statement of liability passed to the creditor',
  'London councils require a signed hire agreement showing the hirer’s full name, permanent address, date of birth and driving licence details (company hirers excepted) — BLUEPRINT §5.2',
];

export function formatAddress(a: Address | undefined): string | undefined {
  if (!a) return undefined;
  return [a.line1, a.line2, a.town, a.county, a.postcode, a.country].filter((x): x is string => !!x && x.trim().length > 0).join(', ');
}

export interface TransferParticulars {
  hirerFullName?: string;
  hirerPermanentAddress?: string;
  hirerDateOfBirth?: ISODate;
  hirerDrivingLicenceNumber?: string;
  companyHirer: boolean;
  hirerCompanyNumber?: string;
  hireStartAt?: ISODateTime;
  hireEndAt?: ISODateTime;
  vehicleRegistration?: string;
  agreementNumber?: string;
  noticeNumber: string;
  issuer: string;
  contraventionAt: ISODateTime;
  hireFirm: { name: string; companyNumber: string };
}

export interface LiabilityTransfer {
  particulars: TransferParticulars;
  statementOfLiability: string;
  /** Sch 2 items (and prerequisites) that are not on file. Empty means the notice can be transferred. */
  missing: string[];
  complete: boolean;
  contraventionWithinHire: boolean;
  basis: string[];
  notes: string[];
}

export function hireCovers(hire: HireAgreement, at: ISODateTime): boolean {
  if (compareIso(at, hire.startAt) < 0) return false;
  const end = hire.collectedAt ?? hire.endAt;
  return !end || compareIso(at, end) <= 0;
}

export function liabilityTransferParticulars(notice: PenaltyNotice, hire: HireAgreement, hirer: Party, unit: FleetUnit, vehicle: Vehicle): LiabilityTransfer {
  const companyHirer = hirer.kind === 'company' || hirer.kind === 'public_body';
  const particulars: TransferParticulars = {
    companyHirer,
    noticeNumber: notice.noticeNumber,
    issuer: notice.issuer,
    contraventionAt: notice.contraventionAt,
    hireFirm: { name: HIRE_FIRM_NAME, companyNumber: HIRE_FIRM_COMPANY_NUMBER },
  };
  if (hirer.name?.trim()) particulars.hirerFullName = hirer.name.trim();
  const address = formatAddress(hirer.address);
  if (address) particulars.hirerPermanentAddress = address;
  if (hirer.dateOfBirth) particulars.hirerDateOfBirth = hirer.dateOfBirth;
  if (hirer.drivingLicenceNumber) particulars.hirerDrivingLicenceNumber = hirer.drivingLicenceNumber;
  if (companyHirer && hirer.companyNumber) particulars.hirerCompanyNumber = hirer.companyNumber;
  if (hire.startAt) particulars.hireStartAt = hire.startAt;
  const end = hire.collectedAt ?? hire.endAt;
  if (end) particulars.hireEndAt = end;
  if (vehicle.registration) particulars.vehicleRegistration = vehicle.registration;
  if (hire.agreementNumber) particulars.agreementNumber = hire.agreementNumber;

  const missing: string[] = [];
  const notes: string[] = [];
  if (!particulars.hirerFullName) missing.push('hirer’s full name');
  if (!particulars.hirerPermanentAddress) missing.push('hirer’s permanent address');
  if (!companyHirer) {
    if (!particulars.hirerDateOfBirth) missing.push('hirer’s date of birth');
    if (!particulars.hirerDrivingLicenceNumber) missing.push('hirer’s driving licence number');
  } else {
    notes.push('Company hirer: date of birth and driving licence number are not required (company number given where known).');
    if (!particulars.hirerCompanyNumber) notes.push('Company number not on record — add it so the authority can identify the hirer.');
  }
  if (!particulars.hireStartAt) missing.push('hire start date and time');
  if (!particulars.hireEndAt) notes.push('Hire is open-ended: state the start and "continuing" — the authority needs to see the hire covered the contravention.');
  if (!particulars.vehicleRegistration) missing.push('vehicle registration mark');
  if (!particulars.agreementNumber) missing.push('hire agreement number');
  if (!hire.signedAt) missing.push('signed hire agreement (London councils require the hirer’s signature on the agreement with these particulars)');

  const contraventionWithinHire = hireCovers(hire, notice.contraventionAt);
  if (!contraventionWithinHire) missing.push(`contravention at ${notice.contraventionAt} falls outside the hire period (${hire.startAt} – ${end ?? 'continuing'}): liability cannot be transferred to this hirer`);
  if (unit.vehicleId !== vehicle.id) missing.push(`vehicle ${vehicle.registration} is not the fleet unit’s vehicle (${unit.vehicleId})`);
  if (hire.fleetUnitId !== unit.id) missing.push(`hire agreement ${hire.agreementNumber} is for fleet unit ${hire.fleetUnitId}, not ${unit.id}`);
  if (notice.fleetUnitId !== unit.id) missing.push(`notice ${notice.noticeNumber} is recorded against fleet unit ${notice.fleetUnitId}, not ${unit.id}`);
  if (notice.kind === 'nip_s172') notes.push('This is a NIP / s.172 notice: use s172ResponseData — the keeper identifies the driver, it does not transfer civil liability.');

  const name = particulars.hirerFullName ?? '[hirer name]';
  const reg = particulars.vehicleRegistration ?? '[registration]';
  const period = `${particulars.hireStartAt ? formatLondonDateTime(particulars.hireStartAt) : '[start]'} to ${particulars.hireEndAt ? formatLondonDateTime(particulars.hireEndAt) : 'continuing'}`;
  const statementOfLiability =
    `I, ${name}, of ${particulars.hirerPermanentAddress ?? '[permanent address]'}, confirm that I hired vehicle ${reg} from ${HIRE_FIRM_NAME} (company ${HIRE_FIRM_COMPANY_NUMBER}) under hire agreement ${particulars.agreementNumber ?? '[agreement number]'} for the period ${period}, ` +
    `that the vehicle was in my possession at ${formatLondonDateTime(notice.contraventionAt)}, and that I accept liability for ${notice.kind === 'pcn_private' ? 'parking charge' : 'penalty charge'} notice ${notice.noticeNumber} issued by ${notice.issuer} in respect of that vehicle during the period of hire, ` +
    'in accordance with the Road Traffic (Owner Liability) Regulations 2000. I understand that the notice may be re-served on me at the address above. ' +
    `Signed: ______________________  Date: ____________  ${companyHirer ? `(for and on behalf of ${name}${particulars.hirerCompanyNumber ? `, company ${particulars.hirerCompanyNumber}` : ''})` : `Date of birth: ${particulars.hirerDateOfBirth ?? '[dob]'}  Driving licence no: ${particulars.hirerDrivingLicenceNumber ?? '[licence]'}`}`;

  return { particulars, statementOfLiability, missing, complete: missing.length === 0, contraventionWithinHire, basis: OWNER_LIABILITY_BASIS, notes };
}

// ---------------------------------------------------------------------------------------------

export const S172_BASIS = [
  'Road Traffic Act 1988 s.172(2)(a) — the keeper must give such information as to the identity of the driver as may be required',
  'Road Traffic Act 1988 s.172(2)(b) — any other person must give such information as it is in their power to give',
  'Road Traffic Act 1988 s.172(4) — no offence where the keeper did not know and could not with reasonable diligence have ascertained who the driver was',
  'Road Traffic Act 1988 s.172(7) — 28 days beginning with the day the notice is served',
  'Road Traffic Offenders Act 1988 s.1 — NIP served on the registered keeper within 14 days of the offence',
];

export const NEVER_NOMINATE = 'Never name a person the records do not show was driving. A nomination of convenience — however well papered — is perverting the course of justice; the honest route (s.172(4) diligence, or naming the hirer as the person in possession) is stronger and survives disclosure (perimeter.md).';

export const S172_DILIGENCE_CHECKLIST = [
  'Hire register: which agreement, if any, covered the vehicle at the date and time of the offence',
  'Signed hire agreement and additional-driver declarations for that period',
  'Key log / handover and collection records (who took and returned the keys, when)',
  'Tracker / telematics data for the vehicle around the time of the offence',
  'Agency driver timesheets or rota where agency drivers are used',
  'Fuel card, toll or congestion-charge records around the time',
  'Job sheets, booking or delivery records placing a driver with the vehicle',
  'Written enquiries made of each possible driver and their replies (dated)',
];

export interface S172PersonData {
  name: string;
  address?: string;
  dateOfBirth?: ISODate;
  drivingLicenceNumber?: string;
  partyId: string;
}

export interface S172ResponseData {
  route: 'driver_identified' | 'hirer_identified' | 'reasonable_diligence';
  noticeNumber: string;
  issuer: string;
  offenceAt: ISODateTime;
  servedAt: ISODateTime;
  deadline: ISODate;
  deadlineBasis: string;
  /** s.1 RTOA 1988: days from the offence to service of the notice, and whether it was within 14. */
  nipServiceDays: number;
  nipServedWithin14Days: boolean;
  driver?: S172PersonData;
  hirer?: S172PersonData;
  hireAgreement?: { agreementNumber: string; startAt: ISODateTime; endAt?: ISODateTime; permittedDrivers: number };
  basisOfKnowledge: string;
  diligenceChecklist?: string[];
  missing: string[];
  statement: string;
  neverNominate: string;
  basis: string[];
}

export interface S172Options {
  /** The driver the records identify (must be the hirer or an additional driver on the agreement). */
  driver?: Party;
  /** Records already checked, for the diligence statement. */
  recordsChecked?: string[];
}

function person(p: Party): S172PersonData {
  const out: S172PersonData = { name: p.name, partyId: p.id };
  const address = formatAddress(p.address);
  if (address) out.address = address;
  if (p.dateOfBirth) out.dateOfBirth = p.dateOfBirth;
  if (p.drivingLicenceNumber) out.drivingLicenceNumber = p.drivingLicenceNumber;
  return out;
}

export function s172ResponseData(notice: PenaltyNotice, hire?: HireAgreement, hirer?: Party, opts: S172Options = {}): S172ResponseData {
  const nipServiceDays = Math.max(0, calendarDaysBetween(notice.contraventionAt, notice.receivedAt));
  const nipServedWithin14Days = nipServiceDays <= 14;
  const base = {
    noticeNumber: notice.noticeNumber,
    issuer: notice.issuer,
    offenceAt: notice.contraventionAt,
    servedAt: notice.receivedAt,
    deadline: notice.responseDeadline,
    deadlineBasis: 'RTA 1988 s.172(7) — 28 days beginning with the day the notice is served; failure is an offence (6 points) even where the driver cannot be identified, so respond in time on every route',
    nipServiceDays,
    nipServedWithin14Days,
    neverNominate: NEVER_NOMINATE,
    basis: S172_BASIS,
  };
  const missing: string[] = [];
  if (!nipServedWithin14Days) missing.push(`check service: the notice was received ${nipServiceDays} days after the offence; a NIP must be served on the registered keeper within 14 days (s.1 RTOA 1988) — compare the offence date with the date of service, allowing for deemed service, before responding`);

  const covers = hire && hirer ? hireCovers(hire, notice.contraventionAt) : false;
  if (!hire || !hirer || !covers) {
    if (hire && hirer && !covers) missing.push(`hire agreement ${hire.agreementNumber} does not cover ${notice.contraventionAt} (${hire.startAt} – ${hire.collectedAt ?? hire.endAt ?? 'continuing'})`);
    else missing.push('a hire agreement covering the date and time of the offence');
    const checked = opts.recordsChecked ?? [];
    return {
      ...base,
      route: 'reasonable_diligence',
      basisOfKnowledge: 'No record places an identified driver in the vehicle at the time of the offence.',
      diligenceChecklist: S172_DILIGENCE_CHECKLIST,
      missing,
      statement:
        `${HIRE_FIRM_NAME} (company ${HIRE_FIRM_COMPANY_NUMBER}), registered keeper, responds to notice ${notice.noticeNumber} issued by ${notice.issuer}. ` +
        `Having checked ${checked.length > 0 ? checked.join(', ') : 'the records listed below'}, the keeper did not know and has not been able, with reasonable diligence, to ascertain who was driving at ${formatLondonDateTime(notice.contraventionAt)} (RTA 1988 s.172(4)). ` +
        'The records held, the enquiries made and their results are set out honestly below, including the limits of those records. ' +
        'This response does not name any person as driver because no record establishes it.',
    };
  }

  const permitted = [hirer.id, ...hire.additionalDrivers.map((d) => d.partyId)];
  const hireAgreement = { agreementNumber: hire.agreementNumber, startAt: hire.startAt, permittedDrivers: permitted.length, ...(hire.collectedAt ?? hire.endAt ? { endAt: (hire.collectedAt ?? hire.endAt)! } : {}) };

  if (opts.driver) {
    if (!permitted.includes(opts.driver.id)) {
      missing.push(`${opts.driver.name} is not the hirer or an additional driver on agreement ${hire.agreementNumber}: do not nominate — identify the driver from the records`);
      return {
        ...base,
        route: 'hirer_identified',
        hirer: person(hirer),
        hireAgreement,
        basisOfKnowledge: `Hire agreement ${hire.agreementNumber}: ${hirer.name} was the hirer in possession of the vehicle; the proposed driver is not on the agreement.`,
        missing,
        statement: hirerStatement(notice, hire, hirer, 'unlisted_driver'),
      };
    }
    const d = person(opts.driver);
    if (!d.address) missing.push('driver’s address');
    if (!d.dateOfBirth) missing.push('driver’s date of birth');
    if (!d.drivingLicenceNumber) missing.push('driver’s driving licence number');
    return {
      ...base,
      route: 'driver_identified',
      driver: d,
      hirer: person(hirer),
      hireAgreement,
      basisOfKnowledge: `Hire agreement ${hire.agreementNumber} and its driver records identify ${opts.driver.name} as the ${opts.driver.id === hirer.id ? 'hirer and ' : 'additional '}driver in charge at ${notice.contraventionAt}.`,
      missing,
      statement: driverStatement(notice, hire, opts.driver, hirer),
    };
  }

  if (permitted.length === 1) {
    const d = person(hirer);
    if (!d.address) missing.push('driver’s address');
    if (!d.dateOfBirth) missing.push('driver’s date of birth');
    if (!d.drivingLicenceNumber) missing.push('driver’s driving licence number');
    return {
      ...base,
      route: 'driver_identified',
      driver: d,
      hirer: d,
      hireAgreement,
      basisOfKnowledge: `Hire agreement ${hire.agreementNumber}: ${hirer.name} was the hirer and the sole permitted driver for ${hire.startAt} – ${hireAgreement.endAt ?? 'continuing'}.`,
      missing,
      statement: driverStatement(notice, hire, hirer, hirer),
    };
  }

  missing.push(`driver identity — ${permitted.length} permitted drivers on agreement ${hire.agreementNumber}; the hirer must confirm from their own knowledge which of them was driving`);
  return {
    ...base,
    route: 'hirer_identified',
    hirer: person(hirer),
    hireAgreement,
    basisOfKnowledge: `Hire agreement ${hire.agreementNumber}: ${hirer.name} was the hirer in possession; ${permitted.length - 1} additional driver${permitted.length - 1 === 1 ? '' : 's'} were permitted, so the keeper names the hirer as the person able to identify the driver (s.172(2)(b)).`,
    missing,
    statement: hirerStatement(notice, hire, hirer, 'several_drivers'),
  };
}

function hirePeriodText(hire: HireAgreement): string {
  const end = hire.collectedAt ?? hire.endAt;
  return `${formatLondonDateTime(hire.startAt)} to ${end ? formatLondonDateTime(end) : 'continuing'}`;
}

function driverStatement(notice: PenaltyNotice, hire: HireAgreement, driver: Party, hirer: Party): string {
  return (
    `${HIRE_FIRM_NAME} (company ${HIRE_FIRM_COMPANY_NUMBER}), registered keeper of the vehicle, responds to notice ${notice.noticeNumber} issued by ${notice.issuer}. ` +
    `At ${formatLondonDateTime(notice.contraventionAt)} the vehicle was on hire under agreement ${hire.agreementNumber} (${hirePeriodText(hire)}) to ${hirer.name}. ` +
    `The hire records identify the driver as ${driver.name}${formatAddress(driver.address) ? ` of ${formatAddress(driver.address)}` : ''}${driver.dateOfBirth ? `, date of birth ${driver.dateOfBirth}` : ''}${driver.drivingLicenceNumber ? `, driving licence ${driver.drivingLicenceNumber}` : ''}. ` +
    'This identification is made from the hire agreement and driver records held by the keeper, copies of which are enclosed (RTA 1988 s.172(2)(a)).'
  );
}

function hirerStatement(notice: PenaltyNotice, hire: HireAgreement, hirer: Party, reason: 'several_drivers' | 'unlisted_driver'): string {
  const why =
    reason === 'several_drivers'
      ? 'The agreement permits more than one driver and the keeper’s records do not establish which of them was driving; the hirer is the person able to identify the driver and should be served under s.172(2)(b). '
      : 'The keeper has been told that a person not named on the agreement may have been driving. Its records cannot confirm that and it does not name anyone they do not identify; the hirer, as the person in possession, is the person able to identify the driver and should be served under s.172(2)(b). ';
  return (
    `${HIRE_FIRM_NAME} (company ${HIRE_FIRM_COMPANY_NUMBER}), registered keeper of the vehicle, responds to notice ${notice.noticeNumber} issued by ${notice.issuer}. ` +
    `At ${formatLondonDateTime(notice.contraventionAt)} the vehicle was on hire under agreement ${hire.agreementNumber} (${hirePeriodText(hire)}) to ${hirer.name}${formatAddress(hirer.address) ? ` of ${formatAddress(hirer.address)}` : ''}, who was in possession of it. ` +
    why +
    'The keeper does not name a driver it cannot identify from its records (RTA 1988 s.172(2)(a), s.172(4)).'
  );
}

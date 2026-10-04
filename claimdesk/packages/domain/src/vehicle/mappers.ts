/**
 * Pure mappers from the DVLA Vehicle Enquiry Service and DVSA MOT History API (v1) payloads to domain types.
 * Field lists per BLUEPRINT §4.1. The raw payload is kept verbatim in LookupRecord.raw by the caller.
 */
import type { FuelType, ISODate, MotTest, OdometerReading, Vehicle } from '../types.js';
import { KM_PER_MILE } from './mileage.js';
import { normaliseRegistration } from './registration.js';

/** DVLA VES response (https://developer-portal.driver-vehicle-licensing.api.gov.uk). All fields optional in practice. */
export interface DvlaVesPayload {
  registrationNumber?: string;
  taxStatus?: string;
  taxDueDate?: string;
  artEndDate?: string;
  motStatus?: string;
  motExpiryDate?: string;
  make?: string;
  yearOfManufacture?: number;
  monthOfFirstRegistration?: string; // YYYY-MM
  monthOfFirstDvlaRegistration?: string;
  engineCapacity?: number;
  co2Emissions?: number;
  fuelType?: string;
  colour?: string;
  markedForExport?: boolean;
  typeApproval?: string;
  wheelplan?: string;
  dateOfLastV5CIssued?: string;
  euroStatus?: string;
  revenueWeight?: number;
  realDrivingEmissions?: string;
  automatedVehicle?: boolean;
  [key: string]: unknown;
}

export function mapVesFuelType(raw: string | undefined): FuelType | undefined {
  if (!raw) return undefined;
  const f = raw.trim().toUpperCase();
  if (f === 'PETROL') return 'petrol';
  if (f === 'DIESEL') return 'diesel';
  if (f === 'ELECTRICITY' || f === 'ELECTRIC') return 'electric';
  if (f.includes('PLUG')) return 'plugin_hybrid';
  if (f.includes('HYBRID') || f === 'ELECTRIC DIESEL' || f.includes('ELECTRIC/')) return 'hybrid';
  if (f.includes('GAS') || f.includes('LPG')) return 'lpg';
  return 'other';
}

function isoDateOrUndefined(v: unknown): ISODate | undefined {
  if (typeof v !== 'string') return undefined;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
}

/** DVLA VES → Partial<Vehicle>. VES does not return the model; the caller fills it from MOT history or a spec decode. */
export function mapDvlaVes(payload: DvlaVesPayload): Partial<Vehicle> {
  const out: Partial<Vehicle> = {};
  if (payload.registrationNumber) out.registration = normaliseRegistration(payload.registrationNumber);
  if (payload.make) out.make = payload.make.trim();
  if (typeof payload.yearOfManufacture === 'number') out.yearOfManufacture = payload.yearOfManufacture;
  if (payload.monthOfFirstRegistration) out.monthOfFirstRegistration = payload.monthOfFirstRegistration.slice(0, 7);
  const fuel = mapVesFuelType(payload.fuelType);
  if (fuel) out.fuelType = fuel;
  if (payload.colour) out.colour = payload.colour.trim();
  if (typeof payload.engineCapacity === 'number') out.engineCapacityCc = payload.engineCapacity;
  if (typeof payload.co2Emissions === 'number') out.co2Gkm = payload.co2Emissions;
  if (payload.euroStatus) out.euroStatus = payload.euroStatus;
  if (payload.taxStatus) out.taxStatus = payload.taxStatus;
  const taxDue = isoDateOrUndefined(payload.taxDueDate);
  if (taxDue) out.taxDueDate = taxDue;
  if (payload.motStatus) out.motStatus = payload.motStatus;
  const motExpiry = isoDateOrUndefined(payload.motExpiryDate);
  if (motExpiry) out.motExpiryDate = motExpiry;
  if (typeof payload.markedForExport === 'boolean') out.markedForExport = payload.markedForExport;
  const v5c = isoDateOrUndefined(payload.dateOfLastV5CIssued);
  if (v5c) out.dateOfLastV5CIssued = v5c;
  return out;
}

/** VES fields with no Vehicle column (kept for the lookup record / engineer's report). */
export interface DvlaVesExtras {
  typeApproval?: string;
  wheelplan?: string;
  revenueWeightKg?: number;
  realDrivingEmissions?: string;
  automatedVehicle?: boolean;
  artEndDate?: ISODate;
}

export function dvlaVesExtras(payload: DvlaVesPayload): DvlaVesExtras {
  const out: DvlaVesExtras = {};
  if (payload.typeApproval) out.typeApproval = payload.typeApproval;
  if (payload.wheelplan) out.wheelplan = payload.wheelplan;
  if (typeof payload.revenueWeight === 'number') out.revenueWeightKg = payload.revenueWeight;
  if (payload.realDrivingEmissions) out.realDrivingEmissions = payload.realDrivingEmissions;
  if (typeof payload.automatedVehicle === 'boolean') out.automatedVehicle = payload.automatedVehicle;
  const art = isoDateOrUndefined(payload.artEndDate);
  if (art) out.artEndDate = art;
  return out;
}

/** DVSA MOT History API v1 shapes (https://documentation.history.mot.api.gov.uk). */
export interface DvsaMotDefect {
  text?: string;
  type?: string; // ADVISORY | MINOR | MAJOR | DANGEROUS | FAIL | PRS | USER ENTERED
  dangerous?: boolean;
}

export interface DvsaMotTest {
  completedDate?: string; // ISO date-time
  testResult?: string; // PASSED | FAILED
  expiryDate?: string; // ISO date
  odometerValue?: string | number;
  odometerUnit?: string; // MI | KM
  odometerResultType?: string; // READ | UNREADABLE | NO_ODOMETER
  motTestNumber?: string;
  dataSource?: string;
  defects?: DvsaMotDefect[];
  rfrAndComments?: DvsaMotDefect[]; // legacy field name
  [key: string]: unknown;
}

export interface DvsaMotVehicle {
  registration?: string;
  make?: string;
  model?: string;
  firstUsedDate?: string;
  fuelType?: string;
  primaryColour?: string;
  registrationDate?: string;
  manufactureDate?: string;
  engineSize?: string | number;
  hasOutstandingRecall?: string | boolean;
  motTests?: DvsaMotTest[];
  [key: string]: unknown;
}

export interface MappedMotHistory {
  registration?: string;
  make?: string;
  model?: string;
  motHistory: MotTest[];
  odometer: OdometerReading[];
}

export function kmToMiles(km: number): number {
  return Math.round(km / KM_PER_MILE);
}

function mapResult(raw: string | undefined): MotTest['result'] {
  const r = (raw ?? '').toUpperCase();
  if (r === 'PASSED' || r === 'PASS') return 'PASSED';
  if (r === 'FAILED' || r === 'FAIL') return 'FAILED';
  if (r === 'PRS') return 'PRS';
  if (r === 'ABANDONED') return 'ABANDONED';
  return 'UNKNOWN';
}

/**
 * DVSA MOT history → MotTest[] (newest first, as the API returns) plus odometer readings in miles.
 * Kilometre readings are converted (km ÷ 1.609344, rounded) and the original unit is kept on the test.
 * Accepts the single-vehicle object or the array form returned by some endpoints (first vehicle used).
 */
export function mapDvsaMotHistory(payload: DvsaMotVehicle | DvsaMotVehicle[]): MappedMotHistory {
  const vehicle: DvsaMotVehicle | undefined = Array.isArray(payload) ? payload[0] : payload;
  const tests = vehicle?.motTests ?? [];
  const motHistory: MotTest[] = [];
  const odometer: OdometerReading[] = [];

  for (const t of tests) {
    const completed = isoDateOrUndefined(t.completedDate);
    if (!completed) continue;
    const unitRaw = (t.odometerUnit ?? '').toLowerCase();
    const unit: MotTest['odometerUnit'] = unitRaw === 'km' ? 'km' : unitRaw === 'mi' || unitRaw === 'miles' ? 'mi' : undefined;
    const resultType = (t.odometerResultType ?? 'READ').toUpperCase();
    const valueNum = t.odometerValue === undefined || t.odometerValue === null || t.odometerValue === '' ? NaN : Number(t.odometerValue);
    const readable = resultType === 'READ' && Number.isFinite(valueNum);
    const miles = readable ? (unit === 'km' ? kmToMiles(valueNum) : Math.round(valueNum)) : undefined;

    const defectsRaw = t.defects ?? t.rfrAndComments ?? [];
    const defects: MotTest['defects'] = defectsRaw.map((d) => ({
      type: (d.type ?? 'ADVISORY').toUpperCase(),
      text: d.text ?? '',
      ...(typeof d.dangerous === 'boolean' ? { dangerous: d.dangerous } : {})
    }));

    const test: MotTest = { completedDate: completed, result: mapResult(t.testResult), defects };
    const expiry = isoDateOrUndefined(t.expiryDate);
    if (expiry) test.expiryDate = expiry;
    if (miles !== undefined) test.odometerMiles = miles;
    if (unit) test.odometerUnit = unit;
    if (t.motTestNumber) test.testNumber = String(t.motTestNumber);
    motHistory.push(test);

    if (miles !== undefined) {
      odometer.push({
        source: 'mot',
        date: completed,
        miles,
        note: `MOT test${t.motTestNumber ? ` ${t.motTestNumber}` : ''}${unit === 'km' ? ` (recorded ${valueNum.toLocaleString('en-GB')} km, converted to miles)` : ''}`
      });
    }
  }

  const out: MappedMotHistory = { motHistory, odometer };
  if (vehicle?.registration) out.registration = normaliseRegistration(vehicle.registration);
  if (vehicle?.make) out.make = vehicle.make;
  if (vehicle?.model) out.model = vehicle.model;
  return out;
}

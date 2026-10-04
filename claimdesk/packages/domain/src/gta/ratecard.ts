/**
 * CCGUK recovery and storage rate card (BLUEPRINT §3.4): £90 call-out + £3 per loaded mile +
 * £25 admin; storage £45/day. All ex VAT, VAT added at the record's rate.
 */
import type { ISODateTime, Pence, RecoveryRecord, StorageRecord } from '../types.js';
import { vatOn } from '../money.js';
import { MS_PER_DAY, calendarDaysBetween, isoToLondonWallMs } from '../calendar/index.js';

export const defaultRateCard = {
  recoveryCalloutPence: 9000 as Pence,
  recoveryPerLoadedMilePence: 300 as Pence,
  recoveryAdminPence: 2500 as Pence,
  storageDailyPence: 4500 as Pence,
  vatRate: 0.2,
} as const;

export interface ChargeLine {
  code: string;
  description: string;
  quantity: number;
  unitPence: Pence;
  amountPence: Pence;
}

export interface RecoveryCharge {
  calloutPence: Pence;
  loadedMiles: number;
  perLoadedMilePence: Pence;
  mileagePence: Pence;
  adminPence: Pence;
  netPence: Pence;
  vatRate: number;
  vatPence: Pence;
  grossPence: Pence;
  breakdown: ChargeLine[];
}

type RecoveryInput = Partial<Pick<RecoveryRecord, 'calloutPence' | 'perLoadedMilePence' | 'adminPence' | 'vatRate'>> & Pick<RecoveryRecord, 'loadedMiles'>;

/** recovery = call-out + loadedMiles × perMile + admin, plus VAT. Missing fields take the rate card. */
export function recoveryCharge(record: RecoveryInput): RecoveryCharge {
  const callout = record.calloutPence ?? defaultRateCard.recoveryCalloutPence;
  const perMile = record.perLoadedMilePence ?? defaultRateCard.recoveryPerLoadedMilePence;
  const admin = record.adminPence ?? defaultRateCard.recoveryAdminPence;
  const vatRate = record.vatRate ?? defaultRateCard.vatRate;
  const miles = Math.max(0, record.loadedMiles);
  const mileage = Math.round(miles * perMile);
  const net = callout + mileage + admin;
  const vat = vatOn(net, vatRate);
  return {
    calloutPence: callout,
    loadedMiles: miles,
    perLoadedMilePence: perMile,
    mileagePence: mileage,
    adminPence: admin,
    netPence: net,
    vatRate,
    vatPence: vat,
    grossPence: net + vat,
    breakdown: [
      { code: 'callout', description: 'Recovery call-out', quantity: 1, unitPence: callout, amountPence: callout },
      { code: 'loaded_miles', description: `Loaded mileage (${miles} miles)`, quantity: miles, unitPence: perMile, amountPence: mileage },
      { code: 'admin', description: 'Administration', quantity: 1, unitPence: admin, amountPence: admin },
    ],
  };
}

export type StorageDayConvention = 'periods_24h' | 'calendar_days';

/**
 * Storage days between two instants.
 *  - 'periods_24h' (default): the number of 24-hour periods started on the London wall clock (any
 *    part of a period counts; a clock change inside the period neither adds nor removes a day).
 *  - 'calendar_days': every London calendar date touched, inclusive of start and end dates.
 */
export function storageDays(startAt: ISODateTime, endAt: ISODateTime, convention: StorageDayConvention = 'periods_24h'): number {
  if (convention === 'calendar_days') return Math.max(0, calendarDaysBetween(startAt, endAt) + 1);
  const ms = isoToLondonWallMs(endAt) - isoToLondonWallMs(startAt);
  return Math.max(0, Math.ceil(ms / MS_PER_DAY));
}

export interface StorageCharge {
  days: number;
  convention: StorageDayConvention;
  dailyRatePence: Pence;
  netPence: Pence;
  vatRate: number;
  vatPence: Pence;
  grossPence: Pence;
  startAt: ISODateTime;
  endAt: ISODateTime;
  breakdown: ChargeLine[];
}

type StorageInput = Partial<Pick<StorageRecord, 'dailyRatePence' | 'vatRate' | 'endAt'>> & Pick<StorageRecord, 'startAt'>;

/** storage = days × daily rate, plus VAT. `endAt` overrides the record's end; one of them is required. */
export function storageCharge(record: StorageInput, endAt?: ISODateTime, opts: { convention?: StorageDayConvention } = {}): StorageCharge {
  const end = endAt ?? record.endAt;
  if (!end) throw new Error('storageCharge: storage has no end date; pass endAt (e.g. the report+48h cap or now)');
  const convention = opts.convention ?? 'periods_24h';
  const daily = record.dailyRatePence ?? defaultRateCard.storageDailyPence;
  const vatRate = record.vatRate ?? defaultRateCard.vatRate;
  const days = storageDays(record.startAt, end, convention);
  const net = days * daily;
  const vat = vatOn(net, vatRate);
  return {
    days,
    convention,
    dailyRatePence: daily,
    netPence: net,
    vatRate,
    vatPence: vat,
    grossPence: net + vat,
    startAt: record.startAt,
    endAt: end,
    breakdown: [{ code: 'storage', description: `Storage (${days} day${days === 1 ? '' : 's'})`, quantity: days, unitPence: daily, amountPence: net }],
  };
}

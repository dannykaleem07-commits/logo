/**
 * Hire charge calculation and off-hire triggers.
 *
 * HIRE DAY CONVENTION: a hire day is each 24-hour period STARTED, measured from `startAt` to the
 * end instant. 10:00 Monday → 10:00 Thursday is exactly 3 periods = 3 days; 10:00 Monday → 10:01
 * Thursday has started a fourth period = 4 days. A hire that ends at the instant it starts is 0
 * days. This matches the way hire agreements and GTA payment packs count "days on hire".
 *
 * ADDITIONAL DRIVERS (GTA 5.4, benchmark): £5.50 per day for each qualifying non-standard-risk
 * additional driver, capped at £110 per driver. Standard-risk additional drivers attract no charge.
 */
import type { GtaRate, HireAgreement, HireEndTrigger, ISODateTime, Pence, Verification } from '../types.js';
import { vatOn } from '../money.js';
import { MS_PER_DAY, MS_PER_HOUR, addWorkingDays, isoToMs, londonDate, msToLondonIso, toLondonIso } from '../calendar/index.js';
import { GTA_NON_SUBSCRIBER_NOTE, defaultGtaRates, gtaRate } from './rates.js';

export const GTA_ADDITIONAL_DRIVER_DAILY_PENCE: Pence = 550;
export const GTA_ADDITIONAL_DRIVER_CAP_PENCE: Pence = 11000;
export const HIRE_DAY_CONVENTION = 'Each 24-hour period started from the hire start instant counts as one day.';

/** Number of 24-hour periods started between two instants (0 when end ≤ start). */
export function hireDays(startAt: ISODateTime, endAt: ISODateTime): number {
  const ms = isoToMs(endAt) - isoToMs(startAt);
  return Math.max(0, Math.ceil(ms / MS_PER_DAY));
}

export interface HireBreakdownLine {
  code: 'hire' | 'additional_driver' | 'excess_waiver';
  description: string;
  quantity: number;
  unitPence: Pence;
  amountPence: Pence;
  partyId?: string;
}

export interface HireBenchmark {
  group: string;
  period: string;
  gtaDailyRatePence: Pence;
  hireAtGtaRatePence: Pence;
  /** Agreement hire charge minus the hire charge at the GTA daily rate (positive = above benchmark). */
  differencePence: Pence;
  verification: Verification;
  note: string;
}

export interface HireCalculation {
  agreementId: string;
  startAt: ISODateTime;
  endAt: ISODateTime;
  days: number;
  convention: string;
  dailyRatePence: Pence;
  hirePence: Pence;
  additionalDriverPence: Pence;
  excessWaiverPence: Pence;
  netPence: Pence;
  vatRate: number;
  vatPence: Pence;
  grossPence: Pence;
  breakdown: HireBreakdownLine[];
  warnings: string[];
  benchmark?: HireBenchmark;
}

export interface HireCalculationOptions {
  /** End instant for a hire that is still running (used when neither `endAt` nor the agreement's end is set). */
  asOf?: ISODateTime;
  additionalDriverDailyPence?: Pence;
  additionalDriverCapPence?: Pence;
  /** Override the agreement's VAT rate. */
  vatRate?: number;
  /** Rate table for the benchmark line; pass [] to suppress the benchmark. */
  rates?: GtaRate[];
}

export function calculateHire(agreement: HireAgreement, endAt?: ISODateTime, opts: HireCalculationOptions = {}): HireCalculation {
  const end = endAt ?? agreement.endAt ?? opts.asOf;
  if (!end) throw new Error(`calculateHire: hire ${agreement.agreementNumber} has no end; pass endAt or opts.asOf for a running hire`);
  const warnings: string[] = [];
  const days = hireDays(agreement.startAt, end);
  if (isoToMs(end) < isoToMs(agreement.startAt)) warnings.push('end is before start; charged as 0 days');

  const daily = agreement.dailyRatePence;
  const hirePence = days * daily;
  const breakdown: HireBreakdownLine[] = [
    { code: 'hire', description: `Hire ${days} day${days === 1 ? '' : 's'} × ${pounds(daily)} (group ${agreement.gtaGroup})`, quantity: days, unitPence: daily, amountPence: hirePence },
  ];

  const adDaily = opts.additionalDriverDailyPence ?? GTA_ADDITIONAL_DRIVER_DAILY_PENCE;
  const adCap = opts.additionalDriverCapPence ?? GTA_ADDITIONAL_DRIVER_CAP_PENCE;
  let additionalDriverPence = 0;
  for (const d of agreement.additionalDrivers) {
    if (!d.nonStandardRisk) continue; // standard-risk additional drivers: no charge
    const uncapped = days * adDaily;
    const amount = Math.min(uncapped, adCap);
    additionalDriverPence += amount;
    if (d.evidenceIds.length === 0) warnings.push(`non-standard-risk additional driver ${d.partyId} has no supporting evidence (GTA 5.4 charge is recoverable only when evidenced)`);
    breakdown.push({
      code: 'additional_driver',
      description: `Non-standard-risk additional driver: ${days} day${days === 1 ? '' : 's'} × ${pounds(adDaily)}${uncapped > adCap ? ` capped at ${pounds(adCap)}` : ''} (GTA 5.4 benchmark)`,
      quantity: days,
      unitPence: adDaily,
      amountPence: amount,
      partyId: d.partyId,
    });
  }

  let excessWaiverPence = 0;
  if (agreement.excessWaiverDailyPence && agreement.excessWaiverDailyPence > 0) {
    excessWaiverPence = days * agreement.excessWaiverDailyPence;
    breakdown.push({
      code: 'excess_waiver',
      description: `Excess waiver ${days} day${days === 1 ? '' : 's'} × ${pounds(agreement.excessWaiverDailyPence)}`,
      quantity: days,
      unitPence: agreement.excessWaiverDailyPence,
      amountPence: excessWaiverPence,
    });
  }

  const netPence = hirePence + additionalDriverPence + excessWaiverPence;
  const vatRate = opts.vatRate ?? agreement.vatRate;
  const vatPence = vatOn(netPence, vatRate);

  const rates = opts.rates ?? defaultGtaRates;
  const rate = rates.length ? gtaRate(agreement.gtaGroup, londonDate(agreement.startAt), rates) : undefined;
  const benchmark: HireBenchmark | undefined = rate
    ? {
        group: rate.group,
        period: rate.period,
        gtaDailyRatePence: rate.dailyRatePence,
        hireAtGtaRatePence: days * rate.dailyRatePence,
        differencePence: hirePence - days * rate.dailyRatePence,
        verification: rate.verification,
        note: GTA_NON_SUBSCRIBER_NOTE,
      }
    : undefined;
  if (rate && rate.verification.status !== 'verified') warnings.push(`GTA benchmark rate for ${rate.group} (${rate.period}) is ${rate.verification.status}`);

  const result: HireCalculation = {
    agreementId: agreement.id,
    startAt: toLondonIso(agreement.startAt),
    endAt: toLondonIso(end),
    days,
    convention: HIRE_DAY_CONVENTION,
    dailyRatePence: daily,
    hirePence,
    additionalDriverPence,
    excessWaiverPence,
    netPence,
    vatRate,
    vatPence,
    grossPence: netPence + vatPence,
    breakdown,
    warnings,
  };
  if (benchmark) result.benchmark = benchmark;
  return result;
}

function pounds(pence: Pence): string {
  const abs = Math.abs(pence);
  return `${pence < 0 ? '-' : ''}£${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export interface OffHireDeadline {
  trigger: HireEndTrigger;
  /** Instant by which the hire must end. Equal to `at` for triggers that stop hire immediately. */
  dueAt: ISODateTime;
  basis: string;
  /** True when the basis is a GTA paragraph (benchmark only for a non-subscriber). */
  gta: boolean;
}

/** When the hire must end after a trigger event at `at` (BLUEPRINT §3.3 end triggers, lesson d). */
export function offHireDeadline(trigger: HireEndTrigger, at: ISODateTime): OffHireDeadline {
  switch (trigger) {
    case 'repair_complete_24h':
      return { trigger, dueAt: msToLondonIso(isoToMs(at) + 24 * MS_PER_HOUR), basis: 'GTA 4.8 — off-hire within 24 hours of repair completion (benchmark only, CCGUK is not a subscriber)', gta: true };
    case 'tl_payment_5wd':
      return { trigger, dueAt: addWorkingDays(at, 5), basis: 'GTA 4.14 table (CHO dealing, unroadworthy) — off-hire within 5 working days of receipt of the total-loss payment (benchmark only, CCGUK is not a subscriber)', gta: true };
    case 'insurer_termination_1wd':
      return { trigger, dueAt: addWorkingDays(at, 1), basis: 'GTA 4.9 — insurer termination notice: hire ends within 1 working day (benchmark only, CCGUK is not a subscriber)', gta: true };
    case 'cash_in_lieu':
      return { trigger, dueAt: toLondonIso(at), basis: 'GTA 4.7 — hire stops on receipt of cash in lieu (benchmark only, CCGUK is not a subscriber)', gta: true };
    case 'client_returned':
      return { trigger, dueAt: toLondonIso(at), basis: 'Vehicle returned by the client — need ended', gta: false };
    case 'replacement_purchased':
      return { trigger, dueAt: toLondonIso(at), basis: 'Replacement vehicle acquired — need ended (mitigation)', gta: false };
    case 'manual':
      return { trigger, dueAt: toLondonIso(at), basis: 'Manual off-hire — reason must be recorded on the file', gta: false };
  }
}

// owned by ap-paperwork
/**
 * The hire facts a confirmed booking already fixes, for paperwork prepared BEFORE the hire record exists
 * (docs/SUPREME-AUTOPILOT.md §D.5, §D.6: the hire-start pack — CCR 2013 Sch 3 form, express request — is emailed to the
 * client before the handover, and the hire record is created at the handover from the reservation). The document
 * builders use this when a pack passes `reservationId` and the claim has no hire yet.
 */
import type { Id } from '@ccguk/domain';
import type { AppContext } from '../context.js';

export interface ReservationHireData {
  reservationId: Id;
  agreementNumber: string;
  startAt: string;
  vehicleRegistration: string;
  vehicleDescription: string;
  dailyRatePence: number;
  vatRate: number;
}

const DEFAULT_VAT_RATE = 0.2;

export function reservationHireData(ctx: AppContext, reservationId: unknown, claimId: Id): ReservationHireData | undefined {
  if (typeof reservationId !== 'string' || !reservationId) return undefined;
  const r = ctx.repos.getReservation(ctx.db, reservationId);
  if (!r || r.claimId !== claimId || !r.agreementNumber) return undefined;
  const unit = ctx.repos.getFleetUnit(ctx.db, r.fleetUnitId);
  const v = unit ? ctx.repos.getVehicle(ctx.db, unit.vehicleId) : undefined;
  return {
    reservationId: r.id,
    agreementNumber: r.agreementNumber,
    startAt: r.startAt,
    vehicleRegistration: v?.registration ?? '[fleet vehicle]',
    vehicleDescription: v ? [v.make, v.model, v.variant].filter(Boolean).join(' ') : `GTA group ${r.gtaGroup} replacement vehicle`,
    dailyRatePence: r.dailyRatePence,
    vatRate: DEFAULT_VAT_RATE,
  };
}

// owned by ap-booking
/**
 * Projected hire period (docs/SUPREME-AUTOPILOT.md §B.6). Pure.
 *
 * start = needs.neededFrom ?? (driveable → the repair start if booked, else now + 1 business day; not driveable or
 *         unknown → now rounded up to the next delivery slot)
 * end   = total loss (predicted or confirmed) → start + totalLossDays (21)
 *         engineer report repair days → start + (repair working days + partsBuffer (2) working days)
 *         acceptance projection days (when supplied) → start + days
 *         else start + defaultHireDays (14)
 * The autopilot moves the expected end as the report, repair booking or off-hire trigger arrives
 * (`booking_update_period`, clash re-check).
 */
import type { ClaimBundle, ISODateTime } from '../types.js';
import { addCalendarDays, addWorkingDays, isoToMs, msToUtcIso } from '../calendar/index.js';
import type { AutopilotSettings } from '../autopilot/settings.js';
import type { RoadworthinessAssessment } from '../eligibility/types.js';
import { DEFAULT_BUSINESS_HOURS, proposeSlots } from './delivery.js';
import type { HireNeeds } from './types.js';

export type ProjectionBasis = 'needed_from' | 'repair_start' | 'next_business_day' | 'next_slot' | 'report' | 'acceptance' | 'default' | 'total_loss';

export interface ProjectedPeriod {
  startAt: ISODateTime;
  expectedEndAt: ISODateTime;
  startBasis: ProjectionBasis;
  endBasis: ProjectionBasis;
  /** Plain English: why these dates. */
  why: string[];
}

type ProjectionSettings = { projection: AutopilotSettings['projection']; booking?: Pick<AutopilotSettings['booking'], 'businessHours' | 'windowMinutes' | 'leadMinutes'> };

export interface ProjectionBundle {
  claim?: Pick<ClaimBundle['claim'], 'status'>;
  report?: Pick<NonNullable<ClaimBundle['report']>, 'repairDurationWorkingDays' | 'totalLoss'>;
  /** acceptanceHireProjection() days when the caller has them. */
  acceptanceHireDays?: number | null;
  /** True when a total loss is predicted (PAV/estimate) even without a report. */
  totalLossPredicted?: boolean;
}

export function projectHirePeriod(bundle: ProjectionBundle, needs: Pick<HireNeeds, 'neededFrom'> | null, roadworthiness: Pick<RoadworthinessAssessment, 'driveable' | 'repairStartAt'> | null, settings: ProjectionSettings, now: ISODateTime): ProjectedPeriod {
  const why: string[] = [];
  let startAt: ISODateTime;
  let startBasis: ProjectionBasis;
  if (needs?.neededFrom) {
    startAt = msToUtcIso(Math.max(isoToMs(needs.neededFrom), isoToMs(now)));
    startBasis = 'needed_from';
    why.push('Starts when the client needs the car.');
  } else if (roadworthiness?.driveable === true) {
    if (roadworthiness.repairStartAt) {
      startAt = msToUtcIso(isoToMs(roadworthiness.repairStartAt));
      startBasis = 'repair_start';
      why.push('The client can still drive their car: the hire starts when it goes in for repair.');
    } else {
      startAt = msToUtcIso(isoToMs(addWorkingDays(now, 1)));
      startBasis = 'next_business_day';
      why.push('The client can still drive their car and no repair date is booked: the hire starts the next business day.');
    }
  } else {
    const b = settings.booking;
    const slot = proposeSlots({ earliest: now, readyBy: now, businessHours: b?.businessHours ?? DEFAULT_BUSINESS_HOURS, windowMinutes: b?.windowMinutes ?? 120, leadMinutes: 0, existing: [], maxPerWindow: Number.MAX_SAFE_INTEGER }, 1)[0];
    startAt = slot ? slot.windowStart : msToUtcIso(isoToMs(now));
    startBasis = 'next_slot';
    why.push(roadworthiness?.driveable === false ? "The client's car cannot be driven: the hire starts at the next delivery slot." : 'Whether the client can drive their car is not known: the hire starts at the next delivery slot.');
  }

  const p = settings.projection;
  const totalLoss = bundle.claim?.status === 'total_loss' || bundle.report?.totalLoss?.decision === 'total_loss' || bundle.totalLossPredicted === true;
  let expectedEndAt: ISODateTime;
  let endBasis: ProjectionBasis;
  const repairWd = bundle.report?.repairDurationWorkingDays;
  if (totalLoss) {
    expectedEndAt = msToUtcIso(isoToMs(addCalendarDays(startAt, p.totalLossDays)));
    endBasis = 'total_loss';
    why.push(`A total loss: ${p.totalLossDays} days is allowed for the settlement.`);
  } else if (repairWd && repairWd > 0) {
    expectedEndAt = msToUtcIso(isoToMs(addWorkingDays(startAt, repairWd + p.partsBufferWorkingDays)));
    endBasis = 'report';
    why.push(`The engineer estimates ${repairWd} working days of repair, plus ${p.partsBufferWorkingDays} working days for parts.`);
  } else if (bundle.acceptanceHireDays && bundle.acceptanceHireDays > 0) {
    expectedEndAt = msToUtcIso(isoToMs(addCalendarDays(startAt, bundle.acceptanceHireDays)));
    endBasis = 'acceptance';
    why.push(`${bundle.acceptanceHireDays} days, as projected when the claim was accepted.`);
  } else {
    expectedEndAt = msToUtcIso(isoToMs(addCalendarDays(startAt, p.defaultHireDays)));
    endBasis = 'default';
    why.push(`No repair estimate yet: the usual ${p.defaultHireDays} days is assumed.`);
  }
  return { startAt, expectedEndAt, startBasis, endBasis, why };
}

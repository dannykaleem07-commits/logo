/**
 * Class-of-use allocation guard (BLUEPRINT §3.12): "The fleet register must hold the declared use per unit
 * and per policy, and block allocation outside cover." Collingwood will not cover credit hire and
 * self-drive together, so a unit may only go out for a use that is both declared on the unit and covered
 * by a policy in force — and never with an expired MOT or tax.
 */
import type { FleetUnit, FleetUse, InsurancePolicy, ISODateTime, Vehicle } from '../types.js';
import { londonDate } from '../calendar/index.js';

export interface AllocationCheck {
  ok: boolean;
  /** Hard blocks, in plain English. */
  reasons: string[];
  /** Soft issues that do not block (stale keeper address, overdue service). */
  warnings: string[];
}

export const COLLINGWOOD_NOTE = 'Collingwood will not cover credit hire and self-drive together — one policy per class of use (BLUEPRINT §3.12)';

export function canAllocate(unit: FleetUnit, use: FleetUse, policy: InsurancePolicy | undefined, now: ISODateTime, vehicle?: Vehicle): AllocationCheck {
  const today = londonDate(now);
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (unit.status !== 'available') reasons.push(`Unit is ${unit.status.replace('_', ' ')}, not available.`);
  if (!unit.declaredUses.includes(use)) reasons.push(`Use "${use}" is not a declared use for this unit (declared: ${unit.declaredUses.join(', ') || 'none'}).`);

  if (!policy) {
    reasons.push('No insurance policy is linked to the unit.');
  } else {
    if (policy.startDate > today) reasons.push(`Policy ${policy.policyNumber} (${policy.insurerName}) is not in force until ${policy.startDate}.`);
    if (policy.endDate < today) reasons.push(`Policy ${policy.policyNumber} (${policy.insurerName}) expired ${policy.endDate}.`);
    if (!policy.coveredUses.includes(use)) {
      reasons.push(`Policy ${policy.policyNumber} (${policy.insurerName}) covers ${policy.coveredUses.join(', ') || 'no uses'} only, not "${use}" — ${COLLINGWOOD_NOTE}.`);
    }
  }

  if (vehicle) {
    if (vehicle.motExpiryDate && vehicle.motExpiryDate < today) reasons.push(`MOT expired ${vehicle.motExpiryDate}.`);
    else if (!vehicle.motExpiryDate && vehicle.motStatus && /not valid|expired/i.test(vehicle.motStatus)) reasons.push(`MOT status "${vehicle.motStatus}".`);
    if (vehicle.taxStatus && /untaxed|sorn/i.test(vehicle.taxStatus)) reasons.push(`Tax status "${vehicle.taxStatus}".`);
    else if (vehicle.taxDueDate && vehicle.taxDueDate < today) reasons.push(`Vehicle tax expired ${vehicle.taxDueDate}.`);
  }

  if (!unit.keeperAddressCurrent) warnings.push('V5C keeper address is not current: penalty notices for this hire will go to the old address.');
  if (unit.serviceDueDate && unit.serviceDueDate < today) warnings.push(`Service overdue since ${unit.serviceDueDate}.`);

  return { ok: reasons.length === 0, reasons, warnings };
}

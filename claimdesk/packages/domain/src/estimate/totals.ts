/**
 * Estimate totals and reconciliation (BLUEPRINT §4.5).
 *
 * Heads:
 *   labour          Σ hours × rate (line.ratePence ?? estimate.labourRatePence) on labour lines
 *                   (hours keyed on a part line are labour too)
 *   parts           Σ quantity × unit price on part lines
 *   paint labour    Σ paint hours × (line.ratePence ?? estimate.paintRatePence)
 *   paint materials per the estimate's stated method — 'per_hour': paint hours × paintMaterialsPerHourPence;
 *                   'paint_system' or 'fixed': Σ line.materialsPence — plus any explicit 'materials' lines
 *   other           adas / diagnostic / sundry / specialist lines (hours × rate + quantity × unit + materials)
 *
 * Lines marked preExisting are totalled separately in preExistingExcludedPence and NEVER enter the
 * net (perimeter.md, "inflating heads of loss": separate old damage explicitly and claim only the
 * accident-related items). VAT is charged on the net at the estimate's rate.
 *
 * Hours on a labour or paint line are the total for that line; `quantity` is not applied to hours.
 */
import type { Estimate, EstimateLine, EstimateLineKind, EstimateTotals, Pence } from '../types.js';
import { formatGBP, vatOn } from '../money.js';

export type EstimateInput = Omit<Estimate, 'totals'> & { totals?: EstimateTotals };
export type EstimateBasis = Pick<Estimate, 'labourRatePence' | 'paintRatePence' | 'paintMaterialsMethod' | 'paintMaterialsPerHourPence'>;

export interface LineAmount {
  lineId: string;
  kind: EstimateLineKind;
  preExisting: boolean;
  hours: number;
  ratePence?: Pence;
  labourPence: Pence;
  partsPence: Pence;
  paintLabourPence: Pence;
  paintMaterialsPence: Pence;
  otherPence: Pence;
  /** Sum of the components above — the line's value whether or not it is claimable. */
  amountPence: Pence;
  warnings: string[];
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const hoursTimesRate = (hours: number | undefined, rate: Pence): Pence => (hours ? Math.round(hours * rate) : 0);
const qtyTimesUnit = (line: EstimateLine): Pence => (line.unitPence ? Math.round(line.quantity * line.unitPence) : 0);

/** Components of one line, every head shown. */
export function lineAmount(line: EstimateLine, basis: EstimateBasis): LineAmount {
  const warnings: string[] = [];
  const out: LineAmount = {
    lineId: line.id,
    kind: line.kind,
    preExisting: line.preExisting === true,
    hours: line.hours ?? 0,
    ratePence: undefined,
    labourPence: 0,
    partsPence: 0,
    paintLabourPence: 0,
    paintMaterialsPence: 0,
    otherPence: 0,
    amountPence: 0,
    warnings,
  };
  switch (line.kind) {
    case 'labour': {
      const rate = line.ratePence ?? basis.labourRatePence;
      out.ratePence = rate;
      out.labourPence = hoursTimesRate(line.hours, rate) + qtyTimesUnit(line);
      if (!line.hours && !line.unitPence) warnings.push(`Labour line ${line.id} has no hours.`);
      break;
    }
    case 'part': {
      out.partsPence = qtyTimesUnit(line) + (line.materialsPence ?? 0);
      if (line.hours) {
        const rate = line.ratePence ?? basis.labourRatePence;
        out.ratePence = rate;
        out.labourPence = hoursTimesRate(line.hours, rate);
      }
      if (!line.unitPence) warnings.push(`Part line ${line.id} has no unit price.`);
      break;
    }
    case 'paint': {
      const rate = line.ratePence ?? basis.paintRatePence;
      out.ratePence = rate;
      out.paintLabourPence = hoursTimesRate(line.hours, rate);
      if (basis.paintMaterialsMethod === 'per_hour') {
        if (basis.paintMaterialsPerHourPence === undefined) {
          warnings.push(`Paint materials method is per hour but no per-hour materials rate is set; materials for ${line.id} counted as ${formatGBP(line.materialsPence ?? 0)}.`);
          out.paintMaterialsPence = line.materialsPence ?? 0;
        } else {
          out.paintMaterialsPence = hoursTimesRate(line.hours, basis.paintMaterialsPerHourPence);
          if (line.materialsPence) warnings.push(`Paint line ${line.id} carries a materials figure (${formatGBP(line.materialsPence)}) but the method is per hour; the per-hour figure was used.`);
        }
      } else {
        out.paintMaterialsPence = line.materialsPence ?? 0;
      }
      out.paintMaterialsPence += qtyTimesUnit(line);
      break;
    }
    case 'materials': {
      out.paintMaterialsPence = (line.materialsPence ?? 0) + qtyTimesUnit(line);
      break;
    }
    case 'adas':
    case 'diagnostic':
    case 'sundry':
    case 'specialist': {
      const rate = line.ratePence ?? basis.labourRatePence;
      if (line.hours) out.ratePence = rate;
      out.otherPence = hoursTimesRate(line.hours, rate) + qtyTimesUnit(line) + (line.materialsPence ?? 0);
      break;
    }
  }
  out.amountPence = out.labourPence + out.partsPence + out.paintLabourPence + out.paintMaterialsPence + out.otherPence;
  return out;
}

export interface TotalsDetail {
  totals: EstimateTotals;
  lines: LineAmount[];
  warnings: string[];
}

export function computeTotalsDetailed(estimate: EstimateInput): TotalsDetail {
  const lines = estimate.lines.map((l) => lineAmount(l, estimate));
  const warnings: string[] = [];
  const totals: EstimateTotals = {
    labourPence: 0,
    partsPence: 0,
    paintLabourPence: 0,
    paintMaterialsPence: 0,
    otherPence: 0,
    preExistingExcludedPence: 0,
    netPence: 0,
    vatPence: 0,
    grossPence: 0,
    labourHours: 0,
    paintHours: 0,
  };
  let labourHours = 0;
  let paintHours = 0;
  for (const la of lines) {
    warnings.push(...la.warnings);
    if (la.preExisting) {
      totals.preExistingExcludedPence += la.amountPence;
      continue;
    }
    totals.labourPence += la.labourPence;
    totals.partsPence += la.partsPence;
    totals.paintLabourPence += la.paintLabourPence;
    totals.paintMaterialsPence += la.paintMaterialsPence;
    totals.otherPence += la.otherPence;
    if (la.kind === 'paint') paintHours += la.hours;
    else if (la.kind === 'labour' || la.kind === 'part') labourHours += la.hours;
  }
  totals.labourHours = round2(labourHours);
  totals.paintHours = round2(paintHours);
  totals.netPence = totals.labourPence + totals.partsPence + totals.paintLabourPence + totals.paintMaterialsPence + totals.otherPence;
  totals.vatPence = vatOn(totals.netPence, estimate.vatRate);
  totals.grossPence = totals.netPence + totals.vatPence;
  if (totals.preExistingExcludedPence > 0) {
    warnings.push(`${formatGBP(totals.preExistingExcludedPence)} of pre-existing damage is shown separately and is not claimed.`);
  }
  return { totals, lines, warnings };
}

export function computeTotals(estimate: EstimateInput): EstimateTotals {
  return computeTotalsDetailed(estimate).totals;
}

export type ReconcileBasis = 'net' | 'net_all_lines' | 'gross' | 'gross_all_lines';

export interface ReconcileResult {
  reconciled: boolean;
  /** Computed figure on the basis used minus the imported total (positive = we total more). */
  differencePence: Pence;
  basis: ReconcileBasis;
  computedPence: Pence;
  importedTotalPence: Pence;
  tolerancePence: Pence;
  message: string;
}

const BASIS_LABEL: Record<ReconcileBasis, string> = {
  net: 'net of VAT (claimable lines)',
  net_all_lines: 'net of VAT including pre-existing lines',
  gross: 'including VAT (claimable lines)',
  gross_all_lines: 'including VAT and pre-existing lines',
};

/**
 * Does the imported total match our line totals? Tries the net claimable figure first, then the
 * net including pre-existing lines (the bodyshop priced everything), then the same two gross.
 * Default tolerance is £1.00 (100 pence) to absorb per-line rounding.
 */
export function reconcile(estimate: EstimateInput, importedTotalPence: Pence, tolerancePence: Pence = 100): ReconcileResult {
  if (!Number.isFinite(importedTotalPence)) throw new RangeError(`importedTotalPence must be a finite number of pence (got ${String(importedTotalPence)})`);
  if (!Number.isFinite(tolerancePence) || tolerancePence < 0) throw new RangeError(`tolerancePence must be a non-negative finite number of pence (got ${String(tolerancePence)})`);
  // Always recompute from the lines: a stored `totals` may be stale against edited lines, and the
  // reconciliation must test what the lines actually add up to (one source of truth).
  const totals = computeTotals(estimate);
  const vatRate = estimate.vatRate;
  const netAll = totals.netPence + totals.preExistingExcludedPence;
  const candidates: Array<{ basis: ReconcileBasis; value: Pence }> = [
    { basis: 'net', value: totals.netPence },
    { basis: 'net_all_lines', value: netAll },
    { basis: 'gross', value: totals.grossPence },
    { basis: 'gross_all_lines', value: netAll + vatOn(netAll, vatRate) },
  ];
  for (const c of candidates) {
    const diff = c.value - importedTotalPence;
    if (Math.abs(diff) <= tolerancePence) {
      const extra = c.basis === 'net' ? '' : ` The match is on the ${BASIS_LABEL[c.basis]} figure, so the imported total appears to be stated on that basis.`;
      return {
        reconciled: true,
        differencePence: diff,
        basis: c.basis,
        computedPence: c.value,
        importedTotalPence,
        tolerancePence,
        message: `Reconciled: imported total ${formatGBP(importedTotalPence)} agrees with our ${BASIS_LABEL[c.basis]} total ${formatGBP(c.value)} (difference ${formatGBP(diff)}, tolerance ${formatGBP(tolerancePence)}).${extra}`,
      };
    }
  }
  const primary = candidates[0]!;
  const diff = primary.value - importedTotalPence;
  return {
    reconciled: false,
    differencePence: diff,
    basis: 'net',
    computedPence: primary.value,
    importedTotalPence,
    tolerancePence,
    message: `Not reconciled: imported total ${formatGBP(importedTotalPence)} differs from our net total ${formatGBP(primary.value)} by ${formatGBP(diff)} (tolerance ${formatGBP(tolerancePence)}); gross would be ${formatGBP(totals.grossPence)}${totals.preExistingExcludedPence > 0 ? `, net including pre-existing lines ${formatGBP(netAll)}` : ''}. Check for lines missed or duplicated in the import before the estimate is approved.`,
  };
}

/**
 * Report-ready summary of an estimate: every line with its computed amount, the heads, the
 * pre-existing lines shown separately, and a basis statement ("the basis is always stated on the
 * report", BLUEPRINT §4.5).
 */
import type { EstimateLine, EstimateLineKind, EstimateTotals, Pence } from '../types.js';
import { formatGBP } from '../money.js';
import { computeTotalsDetailed, type EstimateInput } from './totals.js';

export interface EstimateLineSummary {
  id: string;
  kind: EstimateLineKind;
  operation: string;
  panel?: string;
  description: string;
  partNumber?: string;
  partSource?: EstimateLine['partSource'];
  quantity: number;
  hours?: number;
  ratePence?: Pence;
  unitPence?: Pence;
  materialsPence?: Pence;
  amountPence: Pence;
  preExisting: boolean;
  confirmedByEngineer: boolean;
  source: EstimateLine['source'];
}

export interface EstimateSummary {
  /** Claimable lines (pre-existing excluded), in estimate order. */
  lines: EstimateLineSummary[];
  /** Lines separated as pre-existing damage; shown on the report and never claimed. */
  preExistingLines: EstimateLineSummary[];
  totals: EstimateTotals;
  byKind: Record<EstimateLineKind, Pence>;
  unconfirmedCount: number;
  importedCount: number;
  basisStatement: string;
  preExistingStatement: string;
  warnings: string[];
}

const KINDS: EstimateLineKind[] = ['labour', 'part', 'paint', 'materials', 'adas', 'diagnostic', 'sundry', 'specialist'];

export function paintMaterialsBasis(estimate: Pick<EstimateInput, 'paintMaterialsMethod' | 'paintMaterialsPerHourPence'>): string {
  switch (estimate.paintMaterialsMethod) {
    case 'per_hour':
      return estimate.paintMaterialsPerHourPence !== undefined
        ? `paint materials at ${formatGBP(estimate.paintMaterialsPerHourPence)} per paint hour`
        : 'paint materials per paint hour (rate not set)';
    case 'paint_system':
      return 'paint materials per the paint-maker system figure on each line';
    case 'fixed':
      return 'paint materials as fixed figures on each line';
  }
}

export function summariseLines(estimate: EstimateInput): EstimateSummary {
  const detail = computeTotalsDetailed(estimate);
  const byId = new Map(detail.lines.map((l) => [l.lineId, l]));
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<EstimateLineKind, Pence>;
  const lines: EstimateLineSummary[] = [];
  const preExistingLines: EstimateLineSummary[] = [];
  let unconfirmedCount = 0;
  let importedCount = 0;
  for (const line of estimate.lines) {
    const la = byId.get(line.id)!;
    const s: EstimateLineSummary = {
      id: line.id,
      kind: line.kind,
      operation: line.operation,
      panel: line.panel,
      description: line.description,
      partNumber: line.partNumber,
      partSource: line.partSource,
      quantity: line.quantity,
      hours: line.hours,
      ratePence: la.ratePence,
      unitPence: line.unitPence,
      materialsPence: line.materialsPence,
      amountPence: la.amountPence,
      preExisting: line.preExisting === true,
      confirmedByEngineer: line.confirmedByEngineer,
      source: line.source,
    };
    if (line.source === 'import') importedCount += 1;
    if (!line.confirmedByEngineer) unconfirmedCount += 1;
    if (s.preExisting) preExistingLines.push(s);
    else {
      lines.push(s);
      byKind[line.kind] += la.amountPence;
    }
  }
  const t = detail.totals;
  // A line may carry its own rate (imported "@ £55.00" or a specialist rate). The basis statement must
  // not then claim every hour was charged at the estimate rate: the arithmetic would not agree with it.
  const claimable = estimate.lines.filter((l) => l.preExisting !== true);
  const labourRateOverrides = claimable.filter((l) => (l.kind === 'labour' || l.kind === 'part') && l.hours && l.ratePence !== undefined && l.ratePence !== estimate.labourRatePence).length;
  const paintRateOverrides = claimable.filter((l) => l.kind === 'paint' && l.hours && l.ratePence !== undefined && l.ratePence !== estimate.paintRatePence).length;
  const labourBasis =
    labourRateOverrides > 0
      ? `Labour ${t.labourHours.toFixed(2)} hrs at ${formatGBP(estimate.labourRatePence)} per hour except ${labourRateOverrides} line(s) at the rate stated on the line`
      : `Labour ${t.labourHours.toFixed(2)} hrs at ${formatGBP(estimate.labourRatePence)} per hour`;
  const paintBasis =
    paintRateOverrides > 0
      ? `paint ${t.paintHours.toFixed(2)} hrs at ${formatGBP(estimate.paintRatePence)} per hour except ${paintRateOverrides} line(s) at the rate stated on the line`
      : `paint ${t.paintHours.toFixed(2)} hrs at ${formatGBP(estimate.paintRatePence)} per hour`;
  const basisStatement = `${labourBasis}; ${paintBasis}; ${paintMaterialsBasis(estimate)}; VAT at ${Math.round(estimate.vatRate * 100)}% on the net.`;
  const preExistingStatement =
    preExistingLines.length === 0
      ? 'No pre-existing damage was identified on this estimate.'
      : `${preExistingLines.length} line(s) totalling ${formatGBP(t.preExistingExcludedPence)} relate to pre-existing damage; they are shown separately and are not claimed.`;
  const warnings = [...detail.warnings];
  if (unconfirmedCount > 0) warnings.push(`${unconfirmedCount} line(s) have not been confirmed by the engineer.`);
  return { lines, preExistingLines, totals: t, byKind, unconfirmedCount, importedCount, basisStatement, preExistingStatement, warnings };
}

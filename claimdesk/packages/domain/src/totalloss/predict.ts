/**
 * First-notification total-loss prediction (BLUEPRINT §4.8, §2 "Intelligent Triage").
 *
 * Rules-first logistic score. The weights below are CCGUK's starting assumptions, not fitted
 * coefficients: `calibrated` is false until the model is re-fitted on at least 100 CCGUK files with
 * known outcomes. Every contribution is listed in `factors` so the handler can see why.
 */
import type { TotalLossPrediction, TotalLossPredictionInput } from '../types.js';
import { formatGBP } from '../money.js';

export const TL_PREDICTOR_WEIGHTS = {
  intercept: -2.0,
  repairRatioOver60: 1.2,
  repairRatioOver90: 2.0,
  airbags: 0.8,
  structuralEach: 1.0,
  structuralCap: 2.5,
  multipleZones: 0.6,
  notDriveable: 0.7,
  fluidLeaks: 0.5,
  ageOver10: 0.6,
  ageOver7: 0.3,
  pavUnder3000: 0.8,
  evFrontOrUnderside: 0.5,
} as const;

export const TL_PREDICTOR_BANDS = { lowBelow: 0.35, mediumBelow: 0.65 } as const;
export const TL_PREDICTOR_MIN_OUTCOMES = 100;
export const TL_PREDICTOR_CALIBRATION_NOTE = `Uncalibrated rules-first score: calibrate on CCGUK outcomes once ≥${TL_PREDICTOR_MIN_OUTCOMES} files have known repair/total-loss results.`;

export interface TotalLossPredictionResult extends TotalLossPrediction {
  /** Log-odds before the sigmoid. */
  score: number;
  note: string;
}

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

export function predictTotalLoss(input: TotalLossPredictionInput): TotalLossPredictionResult {
  const w = TL_PREDICTOR_WEIGHTS;
  const factors: TotalLossPrediction['factors'] = [];
  let score = 0;
  const add = (factor: string, weight: number, note: string): void => {
    factors.push({ factor, weight, note });
    score += weight;
  };

  add('intercept', w.intercept, 'Base rate before any damage indicator.');

  if (input.roughRepairPence !== undefined && input.pavBandPence > 0) {
    const ratio = input.roughRepairPence / input.pavBandPence;
    const pct = Math.round(ratio * 100);
    if (ratio > 0.9) add('repair_to_pav_ratio', w.repairRatioOver90, `Rough repair ${formatGBP(input.roughRepairPence)} is ${pct}% of PAV ${formatGBP(input.pavBandPence)} (over 90%).`);
    else if (ratio > 0.6) add('repair_to_pav_ratio', w.repairRatioOver60, `Rough repair ${formatGBP(input.roughRepairPence)} is ${pct}% of PAV ${formatGBP(input.pavBandPence)} (over 60%).`);
    else add('repair_to_pav_ratio', 0, `Rough repair ${formatGBP(input.roughRepairPence)} is ${pct}% of PAV ${formatGBP(input.pavBandPence)} (60% or below).`);
  } else {
    add('repair_to_pav_ratio', 0, 'No rough repair estimate yet; the repair-to-PAV ratio is not scored.');
  }

  if (input.airbagsDeployed) add('airbags_deployed', w.airbags, 'Airbags deployed: airbag, pretensioner and trim replacement adds materially to the repair.');

  const structural = Array.from(new Set(input.structuralIndicators.filter((s) => s !== 'none')));
  if (structural.length > 0) {
    const raw = structural.length * w.structuralEach;
    const weight = Math.min(raw, w.structuralCap);
    add(
      'structural_indicators',
      weight,
      `${structural.length} structural indicator(s): ${structural.join(', ')} (${w.structuralEach} each${raw > w.structuralCap ? `, capped at ${w.structuralCap}` : ''}).`,
    );
  }

  const zones = Array.from(new Set(input.damageZones));
  if (zones.includes('multiple') || zones.length >= 2) add('multiple_zones', w.multipleZones, `Damage to more than one zone: ${zones.join(', ')}.`);

  if (!input.driveable) add('not_driveable', w.notDriveable, 'Vehicle is not driveable.');
  if (input.fluidLeaks) add('fluid_leaks', w.fluidLeaks, 'Fluid leaks reported: possible radiator, cooling or drivetrain damage.');

  if (input.vehicleAgeYears > 10) add('vehicle_age', w.ageOver10, `Vehicle is ${input.vehicleAgeYears} years old (over 10).`);
  else if (input.vehicleAgeYears > 7) add('vehicle_age', w.ageOver7, `Vehicle is ${input.vehicleAgeYears} years old (over 7).`);

  if (input.pavBandPence < 300_000) add('low_pav_band', w.pavUnder3000, `Rough PAV ${formatGBP(input.pavBandPence)} is under £3,000: little repair spend before the value is exceeded.`);

  if (input.isEvOrHybrid && (zones.includes('front') || zones.includes('underside'))) {
    add('ev_battery_exposure', w.evFrontOrUnderside, 'EV/hybrid with front or underside damage: high-voltage battery and cabling at risk; specialist assessment needed.');
  }

  const probability = round4(sigmoid(score));
  const band: TotalLossPrediction['band'] = probability < TL_PREDICTOR_BANDS.lowBelow ? 'low' : probability < TL_PREDICTOR_BANDS.mediumBelow ? 'medium' : 'high';
  return {
    probability,
    band,
    factors,
    calibrated: false,
    score: Math.round(score * 1000) / 1000,
    note: TL_PREDICTOR_CALIBRATION_NOTE,
  };
}

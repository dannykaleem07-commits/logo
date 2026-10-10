// owned by ap-foundation
/**
 * Autopilot settings (docs/SUPREME-AUTOPILOT.md §A.11, §L), stored in `agent_settings.autopilot` and merged over these
 * defaults on every read, so new keys never need a migration. Step floors are perimeter: a stored or patched mode below
 * a step's floor is raised on read and refused on PATCH (`autopilotSettingsProblems`).
 */
import { mergeDefaults } from '../agents/settings.js';
import { DEFAULT_RANKING_WEIGHTS, type BusinessHours, type RankingWeights } from '../booking/types.js';
import { DEFAULT_DRIVER_CRITERIA, type DriverCriteria } from '../eligibility/types.js';
import { AUTOPILOT_STEP_IDS, STEP_MODE_RANK, STEP_MODES, isAutopilotStepId, type AutopilotStepId, type StepMode } from './types.js';

export type { BusinessHours, RankingWeights };

export interface AutopilotSettings {
  enabled: boolean;
  newClaims: 'on' | 'paused';
  stepModes: Partial<Record<AutopilotStepId, StepMode>>;
  maxActionsPerTick: number;
  loopGuard: { repeats: number; hours: number };
  green: { minLikeForLike: number; clearWinnerGap: number; maxAutoOffersPerDay: number; protectiveHold: boolean };
  booking: {
    holdHours: number;
    offerReminderHours: number;
    turnaroundMinutes: number;
    leadMinutes: number;
    windowMinutes: number;
    maxPerWindow: number;
    businessHours: BusinessHours;
    lookAheadDays: number;
    reminderAtLocal: string;
    alternativesShown: number;
  };
  ranking: RankingWeights;
  projection: { defaultHireDays: number; partsBufferWorkingDays: number; totalLossDays: number };
  signing: {
    otpDelivery: 'email' | 'handler';
    chaseAfterDays: number[];
    callAfterDays: number;
    lanKiosk: boolean;
    kioskTtlMinutes: number;
    dvlaCheckMaxAgeDays: number;
  };
  eligibility: { requireMeansBeforeOffer: boolean; defaultCriteria: DriverCriteria; duplicateClaimWindowDays: number };
  billing: { prepareWithinWorkingDays: number; paymentPackTargetWorkingDays: number };
  schedules: { sweepEveryMinutes: number; clashSweepAtLocal: string; complianceWatchAtLocal: string; signingChaseAtLocal: string };
}

export const DEFAULT_AUTOPILOT_SETTINGS: AutopilotSettings = {
  enabled: true,
  newClaims: 'on',
  stepModes: {},
  maxActionsPerTick: 5,
  loopGuard: { repeats: 3, hours: 24 },
  green: { minLikeForLike: 0.8, clearWinnerGap: 8, maxAutoOffersPerDay: 10, protectiveHold: true },
  booking: {
    holdHours: 24,
    offerReminderHours: 4,
    turnaroundMinutes: 120,
    leadMinutes: 120,
    windowMinutes: 120,
    maxPerWindow: 2,
    businessHours: { days: [1, 2, 3, 4, 5, 6], start: '08:00', end: '18:00', skipBankHolidays: true },
    lookAheadDays: 3,
    reminderAtLocal: '16:00',
    alternativesShown: 2,
  },
  ranking: DEFAULT_RANKING_WEIGHTS,
  projection: { defaultHireDays: 14, partsBufferWorkingDays: 2, totalLossDays: 21 },
  signing: { otpDelivery: 'email', chaseAfterDays: [2, 5], callAfterDays: 7, lanKiosk: false, kioskTtlMinutes: 30, dvlaCheckMaxAgeDays: 14 },
  eligibility: { requireMeansBeforeOffer: false, defaultCriteria: DEFAULT_DRIVER_CRITERIA, duplicateClaimWindowDays: 30 },
  billing: { prepareWithinWorkingDays: 1, paymentPackTargetWorkingDays: 2 },
  schedules: { sweepEveryMinutes: 5, clashSweepAtLocal: '02:30', complianceWatchAtLocal: '06:30', signingChaseAtLocal: '09:15' },
};

/**
 * Step floors from the §A.3 catalogue (perimeter, not editable). The catalogue in steps.ts (ap-autopilot) must carry
 * the same floors — its integrity test compares them with this table.
 */
export const STEP_FLOORS: Readonly<Record<AutopilotStepId, StepMode>> = Object.freeze({
  'intake.new_claim': 'owner',
  'intake.acknowledge': 'auto',
  'intake.complete_fnol': 'auto',
  'intake.cross_file': 'auto',
  'intake.injury_referral': 'confirm',
  'intake.cctv': 'auto',
  'qualify.acceptance': 'auto',
  'qualify.decline': 'owner',
  'qualify.driver': 'auto',
  'qualify.need': 'auto',
  'qualify.means': 'auto',
  'qualify.roadworthiness': 'auto',
  'signup.pack': 'confirm',
  'signup.signed': 'owner',
  'notify.ncaf': 'auto',
  'notify.handling_ref': 'auto',
  'notify.intervention': 'confirm',
  'vehicle.recovery': 'confirm',
  'vehicle.storage': 'auto',
  'vehicle.engineer': 'auto',
  'vehicle.inspection': 'auto',
  'vehicle.report': 'owner',
  'vehicle.repair_track': 'auto',
  'vehicle.total_loss_track': 'auto',
  'hire.search': 'auto',
  'hire.choose': 'auto',
  'hire.hold': 'auto',
  'hire.offer': 'auto',
  'hire.acceptance': 'auto',
  'hire.confirm': 'auto',
  'hire.delivery': 'auto',
  'hire.pack': 'confirm',
  'hire.handover': 'owner',
  'hire.start_notice': 'auto',
  'hire.monitor': 'auto',
  'hire.offhire': 'auto',
  'hire.return': 'owner',
  'money.invoices': 'confirm',
  'money.payment_pack': 'confirm',
  'money.chasers': 'auto',
  'money.complaint': 'confirm',
  'money.offer': 'owner',
  'money.payment': 'confirm',
  'money.client_payout': 'owner',
  'close.readiness': 'owner',
  'status.sync': 'auto',
});

/** Floors explained in owner terms (Settings > Autopilot greys the lower modes with this reason). */
export function floorReason(step: AutopilotStepId): string | null {
  const floor = STEP_FLOORS[step];
  if (floor === 'auto') return null;
  if (step.startsWith('money.')) return 'Money and offers always need you';
  if (step === 'signup.pack' || step === 'hire.pack') return 'Agreements and forms always need you';
  if (floor === 'owner') return 'A person does this step';
  return 'This step always asks you first';
}

/** Problems with a stored or patched settings object: unknown step ids, unknown modes and modes below a step's floor. */
export function autopilotSettingsProblems(value: unknown): string[] {
  const out: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const modes = (value as { stepModes?: unknown }).stepModes;
  if (modes === undefined || modes === null) return out;
  if (typeof modes !== 'object' || Array.isArray(modes)) return ['stepModes must be an object of step id → mode'];
  for (const [id, mode] of Object.entries(modes as Record<string, unknown>)) {
    if (mode === null || mode === undefined) continue;
    if (!isAutopilotStepId(id)) {
      out.push(`Unknown autopilot step ${id}`);
      continue;
    }
    if (typeof mode !== 'string' || !(STEP_MODES as readonly string[]).includes(mode)) {
      out.push(`${id}: unknown mode ${String(mode)}`);
      continue;
    }
    const floor = STEP_FLOORS[id];
    if (STEP_MODE_RANK[mode as StepMode] < STEP_MODE_RANK[floor]) out.push(`${id} cannot be set to ${mode}: ${floorReason(id) ?? 'below its floor'} (lowest allowed: ${floor})`);
  }
  return out;
}

/** Defaults ← stored (deep merge; arrays and scalars replace); unknown step ids dropped; modes below a floor raised. */
export function mergeAutopilotSettings(stored: unknown): AutopilotSettings {
  const merged = mergeDefaults(DEFAULT_AUTOPILOT_SETTINGS, stored);
  const stepModes: Partial<Record<AutopilotStepId, StepMode>> = {};
  const raw = merged.stepModes && typeof merged.stepModes === 'object' && !Array.isArray(merged.stepModes) ? (merged.stepModes as Record<string, unknown>) : {};
  for (const id of AUTOPILOT_STEP_IDS) {
    const mode = raw[id];
    if (typeof mode !== 'string' || !(STEP_MODES as readonly string[]).includes(mode)) continue;
    const floor = STEP_FLOORS[id];
    stepModes[id] = STEP_MODE_RANK[mode as StepMode] < STEP_MODE_RANK[floor] ? floor : (mode as StepMode);
  }
  return { ...merged, stepModes };
}

/** The configured mode of a step before claim overrides and green gating: max(floor, settings ?? default). */
export function configuredStepMode(settings: Pick<AutopilotSettings, 'stepModes'>, step: AutopilotStepId, defaultMode: StepMode = STEP_FLOORS[step]): StepMode {
  const floor = STEP_FLOORS[step];
  const chosen = settings.stepModes[step] ?? defaultMode;
  return STEP_MODE_RANK[chosen] < STEP_MODE_RANK[floor] ? floor : chosen;
}

// owned by ap-foundation
/**
 * Settings > Autopilot (docs/SUPREME-AUTOPILOT.md §A.11, §H.4, §I.8):
 *   GET   /settings/autopilot   the effective settings, the defaults, every step's floor (with the owner-facing reason)
 *   PATCH /settings/autopilot   admin/approver; human-only for agents (perimeter); deep-merged over the current value;
 *                               a step mode below its floor is refused (400 STEP_FLOOR); audited 'autopilot.settings'
 * Stored in `agent_settings.autopilot` and merged over DEFAULT_AUTOPILOT_SETTINGS on every read (new keys never need a
 * migration). The Settings > Autopilot screen is ap-autopilot's.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AUTOPILOT_STEP_IDS,
  DEFAULT_AUTOPILOT_SETTINGS,
  STEP_FLOORS,
  autopilotSettingsProblems,
  floorReason,
  mergeAutopilotSettings,
  mergeDefaults,
  type AutopilotSettings,
} from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { parse } from '../schemas/common.js';
import { requireRole } from './helpers.js';
import { isHhmm } from '../agent/scheduler.js';

const hhmm = z.string().refine(isHhmm, 'expected HH:MM');
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const mode = z.enum(['auto', 'confirm', 'owner']);
const country = z.enum(['GB', 'NI', 'EU_EEA', 'OTHER', 'unknown']);

/** A full AutopilotSettings, field by field (the PATCH accepts any deep subset). */
export const autopilotSettingsSchema = z
  .object({
    enabled: z.boolean(),
    newClaims: z.enum(['on', 'paused']),
    stepModes: z.record(z.string(), mode),
    maxActionsPerTick: int(1, 20),
    loopGuard: z.object({ repeats: int(1, 20), hours: int(1, 168) }).strict(),
    green: z.object({ minLikeForLike: z.number().min(0).max(1), clearWinnerGap: z.number().min(0).max(100), maxAutoOffersPerDay: int(0, 200), protectiveHold: z.boolean() }).strict(),
    booking: z
      .object({
        holdHours: int(1, 168),
        offerReminderHours: int(0, 168),
        turnaroundMinutes: int(0, 24 * 60),
        leadMinutes: int(0, 24 * 60),
        windowMinutes: int(15, 12 * 60),
        maxPerWindow: int(1, 50),
        businessHours: z.object({ days: z.array(int(1, 7)).max(7), start: hhmm, end: hhmm, skipBankHolidays: z.boolean() }).strict(),
        lookAheadDays: int(0, 60),
        reminderAtLocal: hhmm,
        alternativesShown: int(0, 5),
      })
      .strict(),
    ranking: z.object({ likeForLike: z.number().min(0).max(100), needsFit: z.number().min(0).max(100), readiness: z.number().min(0).max(100), compliance: z.number().min(0).max(100), cost: z.number().min(0).max(100), location: z.number().min(0).max(100) }).strict(),
    projection: z.object({ defaultHireDays: int(1, 365), partsBufferWorkingDays: int(0, 60), totalLossDays: int(1, 365) }).strict(),
    signing: z
      .object({
        otpDelivery: z.enum(['email', 'handler']),
        chaseAfterDays: z.array(int(1, 60)).max(10),
        callAfterDays: int(1, 60),
        lanKiosk: z.boolean(),
        kioskTtlMinutes: int(5, 240),
        dvlaCheckMaxAgeDays: int(1, 90),
      })
      .strict(),
    eligibility: z
      .object({
        requireMeansBeforeOffer: z.boolean(),
        defaultCriteria: z
          .object({
            minAge: int(16, 100),
            referBelowAge: int(16, 100),
            maxAge: int(16, 120),
            referAboveAge: int(16, 120),
            minYearsFullLicence: z.number().min(0).max(80),
            referBelowYearsFullLicence: z.number().min(0).max(80),
            maxPointsEligible: int(0, 50),
            maxPointsRefer: int(0, 50),
            excludedEndorsementPrefixes: z.array(z.string().min(1).max(8)).max(100),
            excludedLookbackYears: int(0, 20),
            referEndorsementPrefixes: z.array(z.string().min(1).max(8)).max(100),
            maxFaultAccidents3yEligible: int(0, 20),
            maxFaultAccidents3yRefer: int(0, 20),
            disqualificationLookbackYears: int(0, 20),
            licenceCountriesEligible: z.array(country).max(5),
            licenceCountriesRefer: z.array(country).max(5),
            provisionalAllowed: z.literal(false),
            requireDvlaCheckWithinDays: int(1, 90),
            unspentConvictionsRefer: z.boolean(),
            youngDriverExcessPence: z.number().int().min(0).nullable(),
          })
          .strict(),
        duplicateClaimWindowDays: int(0, 365),
      })
      .strict(),
    billing: z.object({ prepareWithinWorkingDays: int(0, 30), paymentPackTargetWorkingDays: int(0, 30) }).strict(),
    schedules: z.object({ sweepEveryMinutes: int(1, 60), clashSweepAtLocal: hhmm, complianceWatchAtLocal: hhmm, signingChaseAtLocal: hhmm }).strict(),
  })
  .strict();

/** Every step with its floor and the owner-facing reason (Settings > Autopilot greys the lower modes). */
export function stepFloors(): Array<{ id: string; floor: string; reason: string | null }> {
  return AUTOPILOT_STEP_IDS.map((id) => ({ id, floor: STEP_FLOORS[id], reason: floorReason(id) }));
}

export function registerAutopilotSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/settings/autopilot', async () => ({
    settings: ctx.repos.getAgentSettings(ctx.db).autopilot,
    defaults: DEFAULT_AUTOPILOT_SETTINGS,
    floors: stepFloors(),
  }));

  app.patch('/settings/autopilot', async (request) => {
    requireRole(request);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'VALIDATION', 'Send the settings to change as a JSON object');
    // The perimeter floors first, with the owner-facing reason (a mode below a floor is refused, never silently raised).
    const problems = autopilotSettingsProblems(body);
    if (problems.length) throw new HttpError(400, 'STEP_FLOOR', problems[0]!, { problems });
    const before = ctx.repos.getAgentSettings(ctx.db).autopilot;
    const merged: AutopilotSettings = mergeAutopilotSettings(mergeDefaults(before, body));
    parse(autopilotSettingsSchema, merged);
    // The repo deep-merges the patch itself (so a null step mode clears it back to the catalogue default).
    const next = ctx.repos.patchAgentSettings(ctx.db, { autopilot: body as Parameters<AppContext['repos']['patchAgentSettings']>[1]['autopilot'] }, request.actor, ctx.now());
    return { settings: next.autopilot };
  });
}

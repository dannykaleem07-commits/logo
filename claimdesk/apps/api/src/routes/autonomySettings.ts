// owned by runtime
/**
 * Settings > Autonomy (docs/SUPREME-DESIGN.md §D.1, §D.2, §D.5, §L.7, §N.6):
 *   GET   /settings/autonomy   current settings, defaults, the always-ask perimeter and the template list
 *   PATCH /settings/autonomy   admin/approver; validated against the domain AutonomySettings; always-ask templates and
 *                              email kinds can never be added to an allow-list; audited 'autonomy.settings' (and
 *                              'agents.kill_switch' when the kill switch changes)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ALWAYS_ASK_EMAIL_KINDS,
  ALWAYS_ASK_TEMPLATES,
  DEFAULT_AUTONOMY,
  DEFAULT_AUTO_SEND_TEMPLATES,
  EMAIL_KINDS,
  isAlwaysAskEmailKind,
  isAlwaysAskTemplate,
  type AutonomySettings,
  type EmailKind,
} from '@ccguk/domain';
import { listTemplates } from '@ccguk/documents';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { parse } from '../schemas/common.js';
import { requireRole } from './helpers.js';
import { isHhmm } from '../agent/scheduler.js';

const hhmm = z.string().refine(isHhmm, 'expected HH:MM');
const unit = z.number().min(0).max(1);
const emailKind = z.enum(EMAIL_KINDS as unknown as [EmailKind, ...EmailKind[]]);

/** A full AutonomySettings, field by field (the PATCH accepts any subset). */
export const autonomySettingsSchema = z
  .object({
    mode: z.enum(['automatic', 'shadow']),
    holdMinutes: z.number().int().min(1).max(24 * 60),
    thresholds: z.object({ internal: unit, external: unit }).strict(),
    autoSendEmailKinds: z.array(emailKind).max(EMAIL_KINDS.length),
    autoSendTemplates: z.array(z.string().min(1).max(120)).max(200),
    autoApproveTemplates: z.array(z.string().min(1).max(120)).max(200),
    limits: z.object({ perClaimPerDay: z.number().int().min(0).max(50), perHour: z.number().int().min(0).max(500), perDay: z.number().int().min(0).max(2000) }).strict(),
    quietHours: z.object({ start: hhmm, end: hhmm }).strict().nullable(),
    killSwitch: z.boolean(),
  })
  .strict() satisfies z.ZodType<AutonomySettings>;

const patchSchema = autonomySettingsSchema
  .extend({ thresholds: autonomySettingsSchema.shape.thresholds.partial(), limits: autonomySettingsSchema.shape.limits.partial() })
  .partial()
  .strict();

/** Problems with a would-be settings value (always-ask perimeter, unknown templates, approve ⊆ send). */
export function autonomyProblems(s: AutonomySettings, knownTemplates: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const k of s.autoSendEmailKinds) if (isAlwaysAskEmailKind(k)) out.push(`Email kind "${k}" always asks the owner and cannot be sent automatically.`);
  for (const list of ['autoSendTemplates', 'autoApproveTemplates'] as const) {
    for (const t of s[list]) {
      if (isAlwaysAskTemplate(t)) out.push(`Template "${t}" always asks the owner and cannot be added to ${list}.`);
      // The built-in defaults are trusted even before their template lands (SUPREME-AUTOPILOT §0.6 adds three that
      // ap-paperwork registers), so an unrelated PATCH never fails on them.
      else if (knownTemplates.size && !knownTemplates.has(t) && !DEFAULT_AUTO_SEND_TEMPLATES.includes(t)) out.push(`Unknown template "${t}".`);
    }
  }
  for (const t of s.autoApproveTemplates) if (!s.autoSendTemplates.includes(t)) out.push(`Template "${t}" can only be auto-approved when it is also allowed to be sent automatically.`);
  return out;
}

function templateCatalogue() {
  try {
    return listTemplates().map((t) => ({ id: t.id, title: t.title, kind: t.kind, alwaysAsk: isAlwaysAskTemplate(t.id) }));
  } catch {
    return [];
  }
}

export function registerAutonomySettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/settings/autonomy', async () => ({
    settings: ctx.repos.getAgentSettings(ctx.db).autonomy,
    defaults: DEFAULT_AUTONOMY,
    alwaysAsk: { templates: ALWAYS_ASK_TEMPLATES, emailKinds: ALWAYS_ASK_EMAIL_KINDS, classes: ['money', 'settlement', 'legal'], deny: ['destructive'] },
    emailKinds: EMAIL_KINDS,
    templates: templateCatalogue(),
  }));

  app.patch('/settings/autonomy', async (request) => {
    requireRole(request);
    const patch = parse(patchSchema, request.body);
    const before = ctx.repos.getAgentSettings(ctx.db).autonomy;
    const merged: AutonomySettings = {
      ...before,
      ...patch,
      thresholds: { ...before.thresholds, ...(patch.thresholds ?? {}) },
      limits: { ...before.limits, ...(patch.limits ?? {}) },
      quietHours: patch.quietHours === undefined ? before.quietHours : patch.quietHours,
    } as AutonomySettings;
    // Re-validate the whole value, then the perimeter.
    parse(autonomySettingsSchema, merged);
    const problems = autonomyProblems(merged, new Set(templateCatalogue().map((t) => t.id)));
    if (problems.length) throw new HttpError(400, 'ALWAYS_ASK', problems[0]!, { problems });
    const now = ctx.now();
    // Arrays replace (patchAgentSettings merges objects key by key).
    const next = ctx.repos.patchAgentSettings(ctx.db, { autonomy: merged }, request.actor, now);
    if (before.killSwitch !== merged.killSwitch) {
      ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'agents.kill_switch', entity: 'agent_settings', entityId: 'default', before: { killSwitch: before.killSwitch }, after: { killSwitch: merged.killSwitch }, at: now });
    }
    return { settings: next.autonomy };
  });
}

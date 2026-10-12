// owned by intake-server
/**
 * The one-glance case brief after register/attach (docs/SMART-INTAKE.md §6.13, improvement 10): summary (verified AI
 * summary or the template), key facts with their sources, the liability guide (never a decision), what is missing and
 * the request's state, the FNOL call reminder, the Autopilot's first steps, the next actions, the owner-only signals
 * and what was filed. Computed on demand, never stored.
 */
import { caseSummaryTemplate, type BundleComputed, type ChecklistItem } from '@ccguk/domain';
import type { IntakeBundleRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { HttpError, notFound } from '../../errors.js';
import { autopilotView } from '../../autopilot/service.js';
import { buildCaseBrief } from '../../casework/caseBrief.js';
import { computeBundle, LIABILITY_NOTE } from './recompute.js';
import { checklistAgainstClaim } from './attach.js';

export const CALL_REMINDER = 'Call the client: confirm their account in their own words (it was taken from documents), read the call-recording disclosure and ask the script questions.';

function lastOutcome(ctx: AppContext, bundleId: string): { request?: { outboxId: string | null; needsYouId: string | null; reason: string | null }; events?: number; duplicatesSkipped?: number; claimId?: string } {
  const d = ctx.repos.listBundleDecisions(ctx.db, bundleId).reverse().find((x) => x.kind === 'register' || x.kind === 'attach');
  return (d?.after ?? {}) as ReturnType<typeof lastOutcome>;
}

export function briefFor(ctx: AppContext, bundle: IntakeBundleRecord, claimId: string) {
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  const c = (bundle.computed && typeof bundle.computed === 'object' ? bundle.computed : computeBundle(ctx, bundle.id).computed) as BundleComputed;
  const values = Object.fromEntries(c.draft.fields.map((f) => [f.key, f.value]));
  const missing: ChecklistItem[] = checklistAgainstClaim(ctx, claimId, c.checklist.items).filter((i) => i.status === 'missing' || i.status === 'partial');
  const statement = c.liability.statements[0]?.text ?? null;
  const summary = c.aiSummary ?? caseSummaryTemplate({ values, missingDocs: missing.length, liabilityStatement: statement });
  const outcome = lastOutcome(ctx, bundle.id);
  const req = outcome.request ?? { outboxId: null, needsYouId: null, reason: null };
  const outbox = req.outboxId ? ctx.repos.getOutbox(ctx.db, req.outboxId) : undefined;
  const requestStatus = outbox ? (outbox.status === 'sent' ? 'sent' : 'waiting_for_you') : req.needsYouId ? 'prepared_no_email' : 'not_prepared';

  let autopilot: { stopped: string | null; firstSteps: Array<{ id: string; title: string; mode: string; status: string; sentence: string }> } = { stopped: null, firstSteps: [] };
  try {
    const v = autopilotView(ctx, claim.id);
    const title = new Map(v.catalogue.map((s) => [s.id, s.title]));
    autopilot = {
      stopped: v.stopped,
      firstSteps: v.plan.due.slice(0, 5).map((id) => {
        const s = v.plan.steps.find((x) => x.id === id)!;
        return { id, title: title.get(id) ?? id, mode: s.mode, status: s.status, sentence: s.next };
      }),
    };
  } catch (err) {
    autopilot = { stopped: `The Autopilot plan could not be read (${err instanceof HttpError ? err.message : 'error'})`, firstSteps: [] };
  }
  let nextActions: Array<{ code: string; title: string; why: string; dueAt: string | null }> = [];
  try {
    nextActions = buildCaseBrief(ctx, claim.id, { mask: false }).nextActions.slice(0, 5).map((a) => ({ code: a.code, title: a.title, why: a.why, dueAt: a.dueAt }));
  } catch {
    nextActions = [];
  }
  const filedFiles = ctx.repos.listBundleFiles(ctx.db, bundle.id).filter((f) => f.filedClaimId === claim.id);
  const photos = filedFiles.filter((f) => f.filedKind === 'photo').length;
  const events = ctx.repos.listEvents(ctx.db, claim.id).filter((e) => (e.data as { intakeBundleId?: string } | undefined)?.intakeBundleId === bundle.id).length;
  // parts of the car with damage recorded (several photos and estimates of one part count once)
  const zones = new Set(ctx.repos.listDamageObservations(ctx.db, claim.id).filter((o) => o.bundleId === bundle.id).map((o) => o.zoneId)).size;
  return {
    claim: { id: claim.id, reference: claim.reference, status: claim.status, createdAt: claim.openedAt },
    bundle: { id: bundle.id, name: bundle.name },
    generatedAt: ctx.now(),
    summary,
    summarySource: (c.aiSummary ? 'ai' : 'template') as 'ai' | 'template',
    facts: c.draft.fields.filter((f) => f.value && (f.keyField || f.status === 'owner_set' || ['client.phone', 'client.email', 'vehicle.vin', 'tp.insurerName', 'tp.insurerRef', 'accident.policeReference'].includes(f.key))).map((f) => ({ label: f.label, value: f.display ?? f.value ?? '', source: f.source?.label ?? null })),
    liability: {
      position: claim.liability ?? 'unknown',
      score: c.liability.score,
      band: c.liability.band,
      reasons: c.liability.reasons,
      statements: c.liability.statements.map((s) => ({ text: s.text, source: s.source.label })),
      note: LIABILITY_NOTE,
    },
    missing,
    request: { status: requestStatus as 'waiting_for_you' | 'sent' | 'not_prepared' | 'prepared_no_email', outboxId: req.outboxId, needsYouId: req.needsYouId, reason: req.reason },
    callReminder: c.register.fnolWarnings.length ? CALL_REMINDER : null,
    autopilot,
    nextActions,
    signals: c.signals,
    filed: { documents: filedFiles.length - photos, photos, duplicatesSkipped: outcome.duplicatesSkipped ?? 0, events, damageZones: zones },
  };
}
export type CaseBriefView = ReturnType<typeof briefFor>;

export function bundleBrief(ctx: AppContext, bundleId: string): CaseBriefView {
  const b = ctx.repos.getIntakeBundle(ctx.db, bundleId);
  if (!b) throw notFound('intake bundle', bundleId);
  if ((b.status !== 'registered' && b.status !== 'attached') || !b.claimId) throw notFound('case brief for bundle', bundleId);
  return briefFor(ctx, b, b.claimId);
}

export function claimIntakeBrief(ctx: AppContext, claimId: string): CaseBriefView {
  ctx.repos.requireClaim(ctx.db, claimId);
  const b = ctx.repos.listIntakeBundles(ctx.db, { claimId, status: ['registered', 'attached'], limit: 1 })[0];
  if (!b) throw new HttpError(404, 'NO_INTAKE_BUNDLE', 'This claim was not opened or added to from an intake bundle');
  return briefFor(ctx, b, claimId);
}

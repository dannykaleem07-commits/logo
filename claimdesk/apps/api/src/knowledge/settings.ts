// owned by knowledge-core
/**
 * Knowledge settings and the kill switch (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.4, §12.3, KR-8, KR-13). One row in
 * `knowledge_settings`, merged over DEFAULT_KNOWLEDGE_SETTINGS (so a new key never needs a migration). Every change is
 * human-only (`assertHuman`) and audited `knowledge.settings` (+ a knowledge_changes row); switching web research on
 * needs `acknowledge: true` (the honest notice). Agents have no route to these.
 */
import path from 'node:path';
import { DEFAULT_KNOWLEDGE_SETTINGS, mergeDefaults, type KnowledgeSettings, type KnowledgeSettingsPatch } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict } from '../errors.js';
import { assertHuman } from '../services/humanOnly.js';

/** DATA_DIR\knowledge-store\ — snapshots, exports. Never inside the repo (KR-7, §5 Files). */
export function knowledgeStoreDir(ctx: AppContext): string {
  return path.join(ctx.config.dataDir, 'knowledge-store');
}

export function getKnowledgeSettings(ctx: AppContext): KnowledgeSettings {
  const stored = ctx.repos.getStoredKnowledgeSettings(ctx.db);
  return mergeDefaults(DEFAULT_KNOWLEDGE_SETTINGS, stored?.settings);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Range checks on the merged result (numbers stay sane whatever the owner types). */
export function settingsProblems(s: KnowledgeSettings): string[] {
  const out: string[] = [];
  const range = (v: number, lo: number, hi: number, name: string): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) out.push(`${name} must be between ${lo} and ${hi}`);
  };
  range(s.thresholds.autoApplyConfidence, 0.5, 1, 'thresholds.autoApplyConfidence');
  range(s.thresholds.contactObservations, 2, 20, 'thresholds.contactObservations');
  range(s.thresholds.engineeringMinN, 3, 1000, 'thresholds.engineeringMinN');
  range(s.thresholds.statsMinN, 3, 1000, 'thresholds.statsMinN');
  range(s.thresholds.styleSupport, 3, 100, 'thresholds.styleSupport');
  range(s.budgets.researchRunsPerDay, 0, 50, 'budgets.researchRunsPerDay');
  range(s.budgets.curateRunsPerDay, 0, 20, 'budgets.curateRunsPerDay');
  range(s.budgets.webRunsPerDay, 0, 10, 'budgets.webRunsPerDay');
  range(s.budgets.replayDraftsPerWeek, 0, 7, 'budgets.replayDraftsPerWeek');
  range(s.budgets.fetchesPerDay, 0, 2000, 'budgets.fetchesPerDay');
  range(s.budgets.perDomainPerMinute, 1, 60, 'budgets.perDomainPerMinute');
  range(s.budgets.gapMaxAttempts, 1, 10, 'budgets.gapMaxAttempts');
  range(s.budgets.apiUsdPerDay, 0, 50, 'budgets.apiUsdPerDay');
  range(s.needsYouPerDay, 0, 50, 'needsYouPerDay');
  range(s.replay.worseTolerancePct, 0, 50, 'replay.worseTolerancePct');
  range(s.replay.minCases, 3, 1000, 'replay.minCases');
  range(s.drift.windowDays, 3, 90, 'drift.windowDays');
  range(s.drift.baselineDays, 7, 365, 'drift.baselineDays');
  range(s.drift.minN, 3, 1000, 'drift.minN');
  range(s.drift.dropPctPoints, 1, 100, 'drift.dropPctPoints');
  if (s.userAgentContact !== null && (typeof s.userAgentContact !== 'string' || s.userAgentContact.length > 200)) out.push('userAgentContact must be short text or null');
  return out;
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_KNOWLEDGE_SETTINGS));

/**
 * Apply an owner patch (human only). Unknown keys are refused; `fclTransactionalLicence.recorded = true` stamps who and
 * when; switching web research on requires `acknowledge: true`. Writes the row, `knowledge.settings` audit and a
 * knowledge_changes row with before/after.
 */
export function patchKnowledgeSettings(ctx: AppContext, patch: KnowledgeSettingsPatch, actor: Actor): KnowledgeSettings {
  assertHuman(actor, 'change knowledge settings');
  if (!isObj(patch)) throw badRequest('settings patch must be an object');
  const { acknowledge, ...rest } = patch as KnowledgeSettingsPatch & { acknowledge?: boolean };
  const unknown = Object.keys(rest).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) throw badRequest(`unknown knowledge settings: ${unknown.join(', ')}`);
  const before = getKnowledgeSettings(ctx);
  const now = ctx.now();
  const merged = mergeDefaults(before, rest);
  if (merged.webResearchEnabled && !before.webResearchEnabled && acknowledge !== true) {
    throw conflict('ACKNOWLEDGE_REQUIRED', 'Web research fetches pages from this PC’s internet connection, has pages summarised by Claude Code’s fetch model and uses your Claude usage. Confirm you have read this (acknowledge: true) to switch it on.');
  }
  if (merged.fclTransactionalLicence.recorded && !before.fclTransactionalLicence.recorded) {
    if (!merged.fclTransactionalLicence.reference?.trim()) throw badRequest('Record the Find Case Law licence reference');
    merged.fclTransactionalLicence = { ...merged.fclTransactionalLicence, at: now, by: actor.userId };
  }
  if (!merged.fclTransactionalLicence.recorded) merged.fclTransactionalLicence = { recorded: false, reference: merged.fclTransactionalLicence.reference ?? null, at: null, by: null };
  const problems = settingsProblems(merged);
  if (problems.length) throw badRequest(problems.join('; '), { problems });
  ctx.db.transaction((tx) => {
    ctx.repos.putStoredKnowledgeSettings(tx, merged, actor.userId, now);
    ctx.repos.appendAudit(tx, { actor, action: 'knowledge.settings', entity: 'knowledge_settings', entityId: 'default', before, after: merged, at: now });
    ctx.repos.appendKnowledgeChange(tx, { at: now, actor: actor.userId, action: 'knowledge.settings', before, after: merged, reason: acknowledge ? 'acknowledged the web research notice' : null });
  });
  return merged;
}

/** Kill-switch shortcuts (POST /knowledge/learning/pause|resume). Human only, audited. */
export function setLearningEnabled(ctx: AppContext, enabled: boolean, actor: Actor, reason: string | null = null): KnowledgeSettings {
  assertHuman(actor, enabled ? 'resume learning' : 'pause learning');
  const before = getKnowledgeSettings(ctx);
  const now = ctx.now();
  const after: KnowledgeSettings = { ...before, learningEnabled: enabled };
  const action = enabled ? 'knowledge.learning.resume' : 'knowledge.learning.pause';
  ctx.db.transaction((tx) => {
    ctx.repos.putStoredKnowledgeSettings(tx, after, actor.userId, now);
    ctx.repos.appendAudit(tx, { actor, action, entity: 'knowledge_settings', entityId: 'default', before: { learningEnabled: before.learningEnabled }, after: { learningEnabled: enabled, reason }, at: now });
    ctx.repos.appendKnowledgeChange(tx, { at: now, actor: actor.userId, action, before: { learningEnabled: before.learningEnabled }, after: { learningEnabled: enabled }, reason });
  });
  return after;
}

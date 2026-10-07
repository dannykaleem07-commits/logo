/**
 * Agent settings (one row, id 'default'): stored JSON is merged over the @ccguk/domain defaults on every read, so new
 * keys never need a migration. Patches are audited: autonomy → 'autonomy.settings', notifications →
 * 'notifications.settings', AI / agents / checklist → 'ai.settings' (§K.5).
 */
import { eq } from 'drizzle-orm';
import {
  DEFAULT_AGENTS_SETTINGS,
  DEFAULT_AI_SETTINGS,
  DEFAULT_AUTONOMY,
  DEFAULT_CHECKLIST,
  DEFAULT_NOTIFICATION_SETTINGS,
  mergeDefaults,
  type AgentsSettings,
  type AiSettings,
  type AutonomySettings,
  type ChecklistState,
  type ISODateTime,
  type NotificationSettings,
} from '@ccguk/domain';
import type { Db } from '../client.js';
import { agentSettings } from '../schema.js';
import { nowIso } from '../util.js';
import { appendAudit, type Actor } from './audit.js';

export const AGENT_SETTINGS_ID = 'default';

export interface AgentSettingsRecord {
  ai: AiSettings;
  autonomy: AutonomySettings;
  notifications: NotificationSettings;
  agents: AgentsSettings;
  checklist: ChecklistState;
  updatedAt?: ISODateTime;
  updatedBy?: string;
}

/** Deep-partial patch: objects merge key by key, arrays and scalars replace. */
export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T;

export interface AgentSettingsPatch {
  ai?: DeepPartial<AiSettings>;
  autonomy?: DeepPartial<AutonomySettings>;
  notifications?: DeepPartial<NotificationSettings>;
  agents?: DeepPartial<AgentsSettings>;
  checklist?: DeepPartial<ChecklistState>;
}

type Section = keyof AgentSettingsPatch;
const SECTIONS: readonly Section[] = ['ai', 'autonomy', 'notifications', 'agents', 'checklist'];
const AUDIT_ACTION: Record<Section, string> = { ai: 'ai.settings', agents: 'ai.settings', checklist: 'ai.settings', autonomy: 'autonomy.settings', notifications: 'notifications.settings' };

const DEFAULTS: Omit<AgentSettingsRecord, 'updatedAt' | 'updatedBy'> = {
  ai: DEFAULT_AI_SETTINGS,
  autonomy: DEFAULT_AUTONOMY,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  agents: DEFAULT_AGENTS_SETTINGS,
  checklist: DEFAULT_CHECKLIST,
};

/** Current settings (defaults when no row exists yet). */
export function getAgentSettings(db: Db): AgentSettingsRecord {
  const row = db.select().from(agentSettings).where(eq(agentSettings.id, AGENT_SETTINGS_ID)).get();
  const out: AgentSettingsRecord = {
    ai: mergeDefaults(DEFAULTS.ai, row?.ai),
    autonomy: mergeDefaults(DEFAULTS.autonomy, row?.autonomy),
    notifications: mergeDefaults(DEFAULTS.notifications, row?.notifications),
    agents: mergeDefaults(DEFAULTS.agents, row?.agents),
    checklist: mergeDefaults(DEFAULTS.checklist, row?.checklist),
  };
  if (row) {
    out.updatedAt = row.updatedAt;
    out.updatedBy = row.updatedBy;
  }
  return out;
}

/** Merge `patch` over the current settings, store the effective values and audit each changed section. */
export function patchAgentSettings(db: Db, patch: AgentSettingsPatch, actor: Actor, at: ISODateTime = nowIso()): AgentSettingsRecord {
  const before = getAgentSettings(db);
  const next = { ...before } as AgentSettingsRecord;
  const changed: Section[] = [];
  for (const s of SECTIONS) {
    if (patch[s] === undefined) continue;
    const merged = mergeDefaults(before[s] as unknown, patch[s]);
    if (JSON.stringify(merged) !== JSON.stringify(before[s])) {
      (next as unknown as Record<Section, unknown>)[s] = merged;
      changed.push(s);
    }
  }
  if (!changed.length) return before;
  const values = { ai: next.ai, autonomy: next.autonomy, notifications: next.notifications, agents: next.agents, checklist: next.checklist, updatedAt: at, updatedBy: actor.userId };
  db.insert(agentSettings)
    .values({ id: AGENT_SETTINGS_ID, ...values })
    .onConflictDoUpdate({ target: agentSettings.id, set: values })
    .run();
  const actions = new Map<string, Section[]>();
  for (const s of changed) actions.set(AUDIT_ACTION[s], [...(actions.get(AUDIT_ACTION[s]) ?? []), s]);
  for (const [action, sections] of actions) {
    appendAudit(db, {
      actor,
      action,
      entity: 'agent_settings',
      entityId: AGENT_SETTINGS_ID,
      before: Object.fromEntries(sections.map((s) => [s, before[s]])),
      after: Object.fromEntries(sections.map((s) => [s, next[s]])),
      at,
    });
  }
  return { ...next, updatedAt: at, updatedBy: actor.userId };
}

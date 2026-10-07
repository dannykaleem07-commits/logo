// owned by runtime
/**
 * Pure helpers for Settings > Autonomy (docs/SUPREME-DESIGN.md §D.1, §D.2, §L.7): the class table, toggling
 * allow-list entries (always-ask entries can never be switched on; un-sending a template also stops auto-approval),
 * client-side problems, and the PATCH body. Unit-tested in autonomy.test.ts.
 */
import type { AutonomySettings, EmailKind } from '@ccguk/domain';

export interface ClassRow {
  id: string;
  label: string;
  examples: string;
  automatic: string;
  shadow: string;
  editable: boolean;
}

export const CLASS_ROWS: ClassRow[] = [
  { id: 'read', label: 'Read', examples: 'Looking at claims, documents, the knowledge base', automatic: 'Automatic', shadow: 'Automatic', editable: false },
  { id: 'draft', label: 'Draft', examples: 'Drafts, tasks, Needs-you items', automatic: 'Automatic', shadow: 'Automatic', editable: false },
  { id: 'internal', label: 'Internal', examples: 'Events, filing mail on a claim, filling empty fields', automatic: 'Automatic + daily log; asks when sensitive, overwriting or below the confidence threshold', shadow: 'Asks you', editable: true },
  { id: 'external_send', label: 'Sending', examples: 'Emails and letters', automatic: 'After a reviewer pass and the hold window, when allow-listed and nothing is missing; otherwise asks you', shadow: 'Asks you', editable: true },
  { id: 'money', label: 'Money', examples: 'Payments received, ledger figures', automatic: 'Always asks you', shadow: 'Always asks you', editable: false },
  { id: 'settlement', label: 'Settlement', examples: 'Offers, interim payments, Part 36', automatic: 'Always asks you — the agents analyse and recommend only', shadow: 'Always asks you', editable: false },
  { id: 'legal', label: 'Legal', examples: 'Letters before claim, complaints, solicitors, court, injury, DSAR', automatic: 'Always asks you', shadow: 'Always asks you', editable: false },
  { id: 'destructive', label: 'Delete / void', examples: 'Removing records', automatic: 'Never', shadow: 'Never', editable: false },
];

export function isAlwaysAsk(templateId: string, alwaysAsk: readonly string[]): boolean {
  return alwaysAsk.some((t) => (t.endsWith('.') ? templateId.startsWith(t) : templateId === t));
}

const toggle = <T,>(list: readonly T[], v: T, on: boolean): T[] => (on ? (list.includes(v) ? [...list] : [...list, v]) : list.filter((x) => x !== v));

/** Switch an email kind on/off for automatic sending (always-ask kinds stay off). */
export function toggleEmailKind(s: AutonomySettings, kind: EmailKind, on: boolean, alwaysAskKinds: readonly string[]): AutonomySettings {
  if (on && alwaysAskKinds.includes(kind)) return s;
  return { ...s, autoSendEmailKinds: toggle(s.autoSendEmailKinds, kind, on) };
}

/** Switch a template on/off for automatic sending; switching it off also removes it from auto-approval. */
export function toggleSendTemplate(s: AutonomySettings, id: string, on: boolean, alwaysAsk: readonly string[]): AutonomySettings {
  if (on && isAlwaysAsk(id, alwaysAsk)) return s;
  return { ...s, autoSendTemplates: toggle(s.autoSendTemplates, id, on), autoApproveTemplates: on ? s.autoApproveTemplates : s.autoApproveTemplates.filter((x) => x !== id) };
}

/** Switch auto-approval of a template (only for templates allowed to be sent automatically). */
export function toggleApproveTemplate(s: AutonomySettings, id: string, on: boolean, alwaysAsk: readonly string[]): AutonomySettings {
  if (on && (isAlwaysAsk(id, alwaysAsk) || !s.autoSendTemplates.includes(id))) return s;
  return { ...s, autoApproveTemplates: toggle(s.autoApproveTemplates, id, on) };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Problems the server would refuse (shown before saving). */
export function autonomyProblems(s: AutonomySettings, alwaysAsk: readonly string[], alwaysAskKinds: readonly string[]): string[] {
  const out: string[] = [];
  if (!(s.holdMinutes >= 1 && s.holdMinutes <= 1440)) out.push('The hold window must be between 1 and 1440 minutes.');
  for (const [k, v] of Object.entries(s.thresholds)) if (!(v >= 0 && v <= 1)) out.push(`The ${k} threshold must be between 0 and 1.`);
  for (const [k, v] of Object.entries(s.limits)) if (!(Number.isInteger(v) && v >= 0)) out.push(`The ${k} limit must be a whole number.`);
  if (s.quietHours && (!HHMM.test(s.quietHours.start) || !HHMM.test(s.quietHours.end))) out.push('Quiet hours need times as HH:MM.');
  for (const k of s.autoSendEmailKinds) if (alwaysAskKinds.includes(k)) out.push(`"${k}" always asks you.`);
  for (const t of [...s.autoSendTemplates, ...s.autoApproveTemplates]) if (isAlwaysAsk(t, alwaysAsk)) out.push(`"${t}" always asks you.`);
  for (const t of s.autoApproveTemplates) if (!s.autoSendTemplates.includes(t)) out.push(`"${t}" can only be auto-approved when it may be sent automatically.`);
  return [...new Set(out)];
}

/** Only the changed top-level keys (arrays replace; objects whole). */
export function autonomyPatch(before: AutonomySettings, after: AutonomySettings): Partial<AutonomySettings> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(after) as Array<keyof AutonomySettings>) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = after[k];
  }
  return out as Partial<AutonomySettings>;
}

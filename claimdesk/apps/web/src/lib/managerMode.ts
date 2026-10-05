/**
 * Manager-mode relaxations for web-only checks (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.5.1). Pure; unit-tested.
 *
 * In manager mode a client-side validation error becomes an amber warning ("Allowed in manager mode: …") unless its key is
 * one of the form's hard keys (a value the user simply has to type). The relaxed rule keys travel to the server in the
 * X-Manager-Relaxed header (see `withRelaxed` in api/client.ts) and are audited as `override.WEB_VALIDATION`.
 */

import { beforeAfterText, fieldsText, ruleKeyLabel } from './auditText';
import { plainText } from './plainText';

export interface RelaxedResult {
  errors: Record<string, string>;
  warnings: Record<string, string>;
}

/** Prefix shown before a relaxed message: "Allowed in manager mode: ". */
export const MANAGER_WARNING_PREFIX = 'Allowed in manager mode: ';

/** In manager mode every error whose key is not in `hardKeys` becomes a warning; otherwise unchanged (warnings = {}). */
export function relaxErrors(errors: Record<string, string>, managerOn: boolean, hardKeys: readonly string[] = []): RelaxedResult {
  if (!managerOn) return { errors: { ...errors }, warnings: {} };
  const hard = new Set(hardKeys);
  const out: RelaxedResult = { errors: {}, warnings: {} };
  for (const [key, message] of Object.entries(errors)) {
    if (hard.has(key)) out.errors[key] = message;
    else out.warnings[key] = message;
  }
  return out;
}

/** Rule keys for the X-Manager-Relaxed header: `${form}.${key}` for each warning key. */
export function relaxedKeys(form: string, warnings: Record<string, string>): string[] {
  return Object.keys(warnings).map((key) => `${form}.${key}`);
}

/** A relaxed message as shown under a field: "Allowed in manager mode: <message>" (never doubled). */
export function managerWarning(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return message.startsWith(MANAGER_WARNING_PREFIX) ? message : `${MANAGER_WARNING_PREFIX}${message}`;
}

// ---------------------------------------------------------------------------
// Audit rows in plain English (Settings → Manager mode, Flags tab → Audit trail; 0.3 §A.8)
// ---------------------------------------------------------------------------

/** The rule code of an `override.<CODE>` audit action, or undefined for any other action. */
export function overrideCodeOf(action: string): string | undefined {
  return action.startsWith('override.') ? action.slice('override.'.length) : undefined;
}

const ACTION_LABELS: Record<string, string> = {
  'hire.correct': 'Hire dates corrected',
  'hire.create': 'Hire started',
  'hire.end': 'Hire ended',
  'hire.expected_end': 'Expected hire end set',
  'manager_mode.on': 'Manager mode switched on',
  'manager_mode.off': 'Manager mode switched off',
  'claim.create': 'Claim opened',
  'claim.status': 'Status changed',
  'claim.flag.raise': 'Flag raised',
  'claim.flag.clear': 'Flag cleared',
  'document.flag.clear': 'Document flag cleared',
  'document.create': 'Document drafted',
  'document.approve': 'Document approved',
  'document.send': 'Document sent',
  'ledger.append': 'Ledger entry added',
  'event.append': 'Chronology entry added',
};

/** "claim.flag.raise" → "Claim flag raise" (first letter capitalised, separators as spaces). */
export function humaniseAction(action: string): string {
  const text = action.replace(/[._]+/g, ' ').trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : action;
}

/** What an audit row did, e.g. "Override: Uncleared hard-stop flag on the claim", "Hire dates corrected". */
export function auditActionLabel(action: string, ruleLabel?: (code: string) => string | undefined): string {
  const code = overrideCodeOf(action);
  if (code !== undefined) return `Override: ${ruleLabel?.(code) ?? humaniseAction(code.toLowerCase())}`;
  return ACTION_LABELS[action] ?? humaniseAction(action);
}

function field(o: unknown, key: string): unknown {
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>)[key] : undefined;
}

function short(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/**
 * The reason and a short detail for an audit row: the override reason and the refusal message; the correction reason;
 * the flag-clearing reason; the manager-mode "why". Unknown shapes → the row's `after` scalar fields, briefly.
 */
export function auditReasonText(entry: { action: string; before?: unknown; after?: unknown }): string {
  const parts: string[] = [];
  const reason = short(field(entry.after, 'reason')) ?? short(field(entry.after, 'clearedReason')) ?? short(field(entry.after, 'overrideReason'));
  if (reason) parts.push(reason);
  const code = overrideCodeOf(entry.action);
  if (code === 'WEB_VALIDATION') {
    const rules = field(field(entry.before, 'details'), 'rules');
    if (Array.isArray(rules) && rules.length) parts.push(`On-screen checks relaxed: ${rules.map((r) => ruleKeyLabel(String(r))).join(', ')}`);
    else {
      const message = short(field(entry.before, 'message'));
      if (message) parts.push(message);
    }
  } else if (code !== undefined) {
    const message = short(field(entry.before, 'message'));
    if (message) parts.push(plainText(message));
  } else if (entry.action === 'hire.correct') {
    const changes = beforeAfterText(entry.before, entry.after);
    if (changes) parts.push(changes);
  } else if (entry.action.startsWith('manager_mode.')) {
    const why = short(field(entry.after, 'why')) ?? short(field(entry.before, 'why'));
    if (why) parts.push(why === 'idle' ? 'switched off after no activity' : why === 'sign_out' ? 'signed out' : why === 'expired' ? 'expired' : why === 'user' ? 'by the user' : why);
  } else if (!reason) {
    const scalars = fieldsText(entry.after);
    if (scalars) parts.push(scalars);
  }
  const text = parts.join(' — ');
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}

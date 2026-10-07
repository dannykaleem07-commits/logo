/**
 * Pure helpers for Settings > AI (docs/SUPREME-DESIGN.md §A.6, §A.7, §L.6): option lists, the setup checklist text
 * (with the honest terms notice and the "Help improve Claude" item), the model table, the Economy / Best quality
 * switches, usage bars and the wizard steps. No React here, so it is unit-tested in node.
 */
import type { AiEffort, AiJobModel, AiQuality, AiStatus, ChecklistItemId, RateLimitSnapshot } from '../../../api/aiApi';

export const DRIVER_OPTIONS = [
  { value: 'subscription_cli', label: 'Subscription — Claude Code on this PC (Claude Max)' },
  { value: 'api_key', label: 'Anthropic API key (pay per use)' },
  { value: 'off', label: 'Off — agents do nothing' },
] as const;

export const MODEL_OPTIONS = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5 (best)' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (economy)' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5 (cheapest)' },
] as const;

export const EFFORT_OPTIONS: ReadonlyArray<{ value: AiEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

export const JOB_LABELS: Record<string, string> = {
  'mail.triage': 'Sort incoming email',
  'mail.reply': 'Draft email replies',
  'intake.extract': 'Read uploaded documents',
  'case.review': 'Review a claim (next step)',
  'offer.analyse': 'Analyse an offer',
  'draft.compose': 'Draft letters and forms',
  'review.check': 'Check drafts before they go',
  'research.ask': 'Answer research questions',
  'dailylog.compile': 'Write the daily log summary',
};

export const CLAUDE_PRIVACY_FALLBACK_URL = 'https://claude.ai/settings/data-privacy-controls';

export interface ChecklistItemView {
  id: ChecklistItemId;
  label: string;
  detail: string;
  link?: { href: string; text: string };
}

/** The four checklist items (§A.7); every one must be ticked before agents can be switched on. */
export function checklistItems(status: Pick<AiStatus, 'notices'> | undefined): ChecklistItemView[] {
  const privacyUrl = status?.notices.privacyUrl || CLAUDE_PRIVACY_FALLBACK_URL;
  return [
    {
      id: 'training_opt_out',
      label: 'I turned off “Help improve Claude” in claude.ai → Settings → Privacy',
      detail: status?.notices.training ?? 'Consumer Claude accounts may use chats to improve Claude unless you turn it off.',
      link: { href: privacyUrl, text: 'Open claude.ai privacy settings' },
    },
    {
      id: 'subscription_terms',
      label: 'I understand subscription sign-in is meant for ordinary individual use; for heavy 24/7 business automation Anthropic’s API is the intended route, and I can switch below',
      detail: status?.notices.terms ?? 'Running agents around the clock for the business is heavy automation; the API is the intended route for that.',
    },
    { id: 'mailbox_connected', label: 'The IONOS mailbox is connected (Settings > Email)', detail: 'Agents read and file your email, so the mailbox must be connected and tested first.' },
    { id: 'background_running', label: 'Background running is on', detail: 'ClaimDesk keeps working when the window is closed (installer option “Keep ClaimDesk running in the background”).' },
  ];
}

export interface WizardStep {
  n: number;
  title: string;
  done: boolean;
  detail: string;
}

/** The subscription set-up steps with what is done (§A.7). */
export function wizardSteps(status: AiStatus): WizardStep[] {
  const cli = status.cli;
  const installed = Boolean(cli.path && cli.version);
  return [
    { n: 1, title: 'Install Claude Code', done: installed && cli.minVersionOk, detail: installed ? `Found Claude Code ${cli.version} at ${cli.path}${cli.minVersionOk ? '' : ` — update it (ClaimDesk is tested with ${cli.minVersion} or newer)`}` : 'Run `winget install Anthropic.ClaudeCode` in a Command Prompt (or use the native installer), then press Check.' },
    { n: 2, title: 'Open the sign-in window', done: status.secrets.claudeToken, detail: 'A console runs `claude setup-token`; sign in with your Claude Max account in the browser and copy the token it prints.' },
    { n: 3, title: 'Paste the sign-in token', done: status.secrets.claudeToken, detail: status.secrets.claudeToken ? 'A token is saved (encrypted on this PC; it is never shown again).' : 'Paste the token below. It is stored encrypted on this PC and never shown again.' },
    { n: 4, title: 'Check', done: cli.authMethod === 'oauth_token' && cli.loggedIn !== false, detail: cli.authMethod ? `Claude Code reports sign-in method “${cli.authMethod}”${cli.authMethod === 'oauth_token' ? ' — good.' : ' — expected the setup token.'}` : 'Press Check: ClaimDesk asks Claude Code who is signed in (no AI call).' },
    { n: 5, title: 'Optional test run', done: false, detail: status.realAiForbidden ? 'Test runs are disabled in this copy of ClaimDesk (test mode).' : 'One tiny real request to confirm everything works end to end.' },
  ];
}

export interface JobRow {
  jobType: string;
  label: string;
  agent: string;
  effective: AiJobModel;
  defaults: AiJobModel;
  overridden: boolean;
}

export function jobRows(status: Pick<AiStatus, 'jobModels' | 'settings'>): JobRow[] {
  return status.jobModels.map((j) => ({ jobType: j.jobType, label: JOB_LABELS[j.jobType] ?? j.jobType, agent: j.agent, effective: j.effective, defaults: j.defaults, overridden: Boolean(status.settings.perJob[j.jobType] && Object.keys(status.settings.perJob[j.jobType]!).length) }));
}

/**
 * The per-job patch to send: only the fields the owner changed that differ from what the job uses now. (Stored
 * overrides merge key by key on the server, so untouched jobs and fields are left as they are.)
 */
export function perJobPatch(edits: Record<string, Partial<AiJobModel>>, rows: Array<Pick<JobRow, 'jobType' | 'effective'>>): Record<string, Partial<AiJobModel>> {
  const out: Record<string, Partial<AiJobModel>> = {};
  for (const r of rows) {
    const e = edits[r.jobType];
    if (!e) continue;
    const diff: Partial<AiJobModel> = {};
    for (const k of ['model', 'effort', 'maxTurns', 'timeoutMs'] as const) {
      if (e[k] !== undefined && e[k] !== r.effective[k]) (diff as Record<string, unknown>)[k] = e[k];
    }
    if (Object.keys(diff).length) out[r.jobType] = diff;
  }
  return out;
}

export const QUALITY_LABEL: Record<AiQuality, string> = { standard: 'Standard', economy: 'Economy (every Opus job uses Sonnet)', best: 'Best quality (every Sonnet job uses Opus)' };

export interface UsageBar {
  label: string;
  percent: number | null;
  tone: 'green' | 'amber' | 'red' | 'grey';
  resets: string | null;
  status: RateLimitSnapshot['status'] | 'unknown';
}

/** "14:05" or "Thu 9 Oct 14:05" in Europe/London. */
export function londonTime(iso: string | undefined | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameDay = d.toLocaleDateString('en-GB', { timeZone: 'Europe/London' }) === now.toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

export function usageBar(label: string, s: RateLimitSnapshot | undefined, reservePercent: number, now?: Date): UsageBar {
  if (!s) return { label, percent: null, tone: 'grey', resets: null, status: 'unknown' };
  const percent = s.utilization === undefined ? null : Math.round(s.utilization * 100);
  const tone = s.status === 'rejected' ? 'red' : s.status === 'allowed_warning' || (percent !== null && percent >= 100 - reservePercent) ? 'amber' : 'green';
  return { label, percent, tone, resets: londonTime(s.resetsAt, now), status: s.status };
}

export function usageBars(status: Pick<AiStatus, 'usage' | 'settings'>, now?: Date): UsageBar[] {
  return [usageBar('Five-hour window', status.usage.fiveHour, status.settings.reservePercent, now), usageBar('Seven-day window', status.usage.sevenDay, status.settings.reservePercent, now)];
}

/** The banner text when AI is paused (usage window, auth failure or the daily cap). */
export function pausedText(status: Pick<AiStatus, 'usage'>, now?: Date): string | null {
  if (!status.usage.paused) return null;
  const until = londonTime(status.usage.pausedUntil, now);
  const reason = status.usage.pauseReason ?? '';
  const why = reason.startsWith('usage_limited') ? 'the Claude usage limit was reached' : reason === 'daily_cap' ? 'the daily API spend cap was reached' : reason ? reason.replace(/_/g, ' ') : 'AI is paused';
  return `AI paused until ${until ?? 'later'} — ${why}. Queued work resumes by itself; mail, sends and deadlines keep running.`;
}

/** Concurrency limits for the AI lane by driver (§C.3). */
export function aiLaneMax(driver: string): number {
  return driver === 'subscription_cli' ? 3 : 6;
}

/** Minutes ↔ milliseconds for the timeout column. */
export const msToMinutes = (ms: number): number => Math.round(ms / 60_000);
export const minutesToMs = (m: number): number => Math.max(1, Math.round(m)) * 60_000;

/** Plain-English agent status line for the header badge. */
export function agentsLine(status: Pick<AiStatus, 'agents' | 'driver' | 'usage'>): { text: string; tone: 'green' | 'amber' | 'red' | 'grey' } {
  if (!status.agents.enabled) return { text: 'Agents off', tone: 'grey' };
  if (status.usage.paused) return { text: 'Agents paused', tone: 'amber' };
  if (!status.driver.health.ready) return { text: 'Agents on — driver not ready', tone: 'red' };
  return { text: 'Agents on', tone: 'green' };
}

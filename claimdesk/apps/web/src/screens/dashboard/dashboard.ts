/**
 * Dashboard model (0.3 §E11; pure, unit-tested): identical next actions grouped into one line, and one clock row per
 * claim showing its worst clock with "+n more".
 */
import type { DashboardAction, DashboardClock } from '../../api/client';
import { groupByClaim } from '../../lib/clocks';

const PRIORITY_RANK: Record<DashboardAction['priority'], number> = { now: 0, today: 1, this_week: 2, scheduled: 3 };

export interface ActionGroup {
  key: string;
  title: string;
  /** The actions in the group, in the order they came (most urgent first). */
  items: DashboardAction[];
  /** The most urgent priority in the group. */
  priority: DashboardAction['priority'];
  /** The earliest due date in the group. */
  dueAt?: string;
  /** Sum of what the actions protect (pence), when any says. */
  protectedPence?: number;
}

/** Actions with the same title (and code) form one line: "Collect the Statement of Means — 3 claims". Order follows the first of each group. */
export function groupActions(actions: readonly DashboardAction[]): ActionGroup[] {
  const groups = new Map<string, ActionGroup>();
  for (const a of actions) {
    const key = `${a.code}|${a.title.trim().toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, title: a.title, items: [], priority: a.priority };
      groups.set(key, g);
    }
    g.items.push(a);
    if (PRIORITY_RANK[a.priority] < PRIORITY_RANK[g.priority]) g.priority = a.priority;
    if (a.dueAt && (!g.dueAt || Date.parse(a.dueAt) < Date.parse(g.dueAt))) g.dueAt = a.dueAt;
    if (typeof a.valuePence === 'number' && a.valuePence > 0) g.protectedPence = (g.protectedPence ?? 0) + a.valuePence;
  }
  return [...groups.values()];
}

/** "Collect the Statement of Means — 3 claims" for a group of several claims; the plain title for one. */
export function actionGroupTitle(g: Pick<ActionGroup, 'title' | 'items'>): string {
  const claims = new Set(g.items.map((i) => i.claimId)).size;
  return claims > 1 ? `${g.title} — ${claims} claims` : g.title;
}

export interface ClockRow {
  claimId: string;
  /** The clock to show: the most overdue one, else the one due soonest today. */
  worst: DashboardClock;
  /** How many other open clocks this claim has due today or overdue. */
  more: number;
  tone: 'red' | 'amber';
}

/** One row per claim with its worst clock; overdue claims first (most overdue first), then those due today. */
export function clockRowsByClaim(overdue: readonly DashboardClock[], dueToday: readonly DashboardClock[]): ClockRow[] {
  const byDue = (a: DashboardClock, b: DashboardClock) => Date.parse(a.dueAt) - Date.parse(b.dueAt);
  const over = groupByClaim([...overdue]);
  const today = groupByClaim([...dueToday]);
  const rows: ClockRow[] = [];
  for (const [claimId, clocks] of over) {
    const sorted = [...clocks].sort(byDue);
    const alsoToday = today.get(claimId)?.length ?? 0;
    rows.push({ claimId, worst: sorted[0]!, more: sorted.length - 1 + alsoToday, tone: 'red' });
  }
  for (const [claimId, clocks] of today) {
    if (over.has(claimId)) continue;
    const sorted = [...clocks].sort(byDue);
    rows.push({ claimId, worst: sorted[0]!, more: sorted.length - 1, tone: 'amber' });
  }
  return rows.sort((a, b) => (a.tone === b.tone ? byDue(a.worst, b.worst) : a.tone === 'red' ? -1 : 1));
}

/** Claim statuses that no longer count as "in progress" on the Today overview. */
export const CLOSED_STATUSES: ReadonlySet<string> = new Set(['settled', 'closed', 'declined']);

export interface TodayInput {
  clockRows: readonly ClockRow[];
  actionGroups: readonly ActionGroup[];
  blockedDocuments: readonly unknown[];
  claims: readonly { status: string }[];
}

export interface TodaySummary {
  /** Overdue clocks (one per claim) + blocked documents + action groups marked "now". */
  needsYou: number;
  overdueClaims: number;
  blocked: number;
  urgentActions: number;
  /** Clocks due today (one per claim, not already overdue) + action groups marked "today". */
  dueToday: number;
  /** Open claims (anything not settled, closed or declined). */
  inProgress: number;
}

/** The four numbers on the Today overview. Pure: the page passes what useDashboardData returned. */
export function todaySummary({ clockRows, actionGroups, blockedDocuments, claims }: TodayInput): TodaySummary {
  const overdueClaims = clockRows.filter((r) => r.tone === 'red').length;
  const todayClaims = clockRows.filter((r) => r.tone === 'amber').length;
  const urgentActions = actionGroups.filter((g) => g.priority === 'now').length;
  const todayActions = actionGroups.filter((g) => g.priority === 'today').length;
  return {
    needsYou: overdueClaims + blockedDocuments.length + urgentActions,
    overdueClaims,
    blocked: blockedDocuments.length,
    urgentActions,
    dueToday: todayClaims + todayActions,
    inProgress: claims.filter((c) => !CLOSED_STATUSES.has(c.status)).length
  };
}

/** Action groups split for the Today overview: "now" → Needs you, "today" → Due today, the rest → Coming up. */
export function splitActionGroups(groups: readonly ActionGroup[]): { now: ActionGroup[]; today: ActionGroup[]; later: ActionGroup[] } {
  return {
    now: groups.filter((g) => g.priority === 'now'),
    today: groups.filter((g) => g.priority === 'today'),
    later: groups.filter((g) => g.priority !== 'now' && g.priority !== 'today')
  };
}

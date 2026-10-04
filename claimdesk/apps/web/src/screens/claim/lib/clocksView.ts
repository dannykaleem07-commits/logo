/**
 * Clocks tab helpers (pure). Clocks are derived by the API (@ccguk/domain clocks); the web only filters, sorts
 * and labels them. GTA clocks are an industry benchmark for a non-subscriber (GTA 2.7(j)).
 */
import type { Clock, ClockKind, ISODateTime } from '@ccguk/domain';
import { dueState } from '../../../lib/clocks';

export type ClockStatusFilter = 'open' | 'overdue' | 'met' | 'stopped' | 'all';

export const CLOCK_STATUS_FILTERS: Array<{ value: ClockStatusFilter; label: string }> = [
  { value: 'open', label: 'Open (running or breached)' },
  { value: 'overdue', label: 'Overdue only' },
  { value: 'met', label: 'Met' },
  { value: 'stopped', label: 'Stopped / not applicable' },
  { value: 'all', label: 'Everything' }
];

export const CLOCK_ATTRIBUTABLE_LABEL: Record<NonNullable<Clock['attributableTo']>, string> = {
  insurer: 'Insurer',
  ccguk: 'CCGUK',
  client: 'Client',
  court: 'Court',
  other: 'Other'
};

export interface ClocksFilter {
  status: ClockStatusFilter;
  attributableTo?: Clock['attributableTo'] | '';
  q?: string;
  gtaOnly?: boolean;
}

export function isGtaBasis(basis: string): boolean {
  return /\bGTA\b/.test(basis);
}

export function isOpenClock(c: Pick<Clock, 'status'>): boolean {
  return c.status === 'running' || c.status === 'breached';
}

export function filterClocks(clocks: Clock[], f: ClocksFilter, now: Date | ISODateTime = new Date()): Clock[] {
  const q = (f.q ?? '').trim().toLowerCase();
  return clocks.filter((c) => {
    switch (f.status) {
      case 'open':
        if (!isOpenClock(c)) return false;
        break;
      case 'overdue':
        if (!isOpenClock(c) || dueState(c, now) !== 'overdue') return false;
        break;
      case 'met':
        if (c.status !== 'met') return false;
        break;
      case 'stopped':
        if (c.status !== 'stopped' && c.status !== 'not_applicable') return false;
        break;
      case 'all':
        break;
    }
    if (f.attributableTo && c.attributableTo !== f.attributableTo) return false;
    if (f.gtaOnly && !isGtaBasis(c.basis)) return false;
    if (q && !`${c.label} ${c.basis} ${c.kind}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const STATUS_RANK: Record<Clock['status'], number> = { breached: 0, running: 1, met: 2, stopped: 3, not_applicable: 4 };

/** Open clocks first (soonest due first), then met (latest first), then stopped. */
export function sortClocks(clocks: Clock[]): Clock[] {
  return [...clocks].sort((a, b) => {
    const openA = isOpenClock(a) ? 0 : 1;
    const openB = isOpenClock(b) ? 0 : 1;
    if (openA !== openB) return openA - openB;
    if (openA === 0) return Date.parse(a.dueAt) - Date.parse(b.dueAt);
    if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    return Date.parse(b.dueAt) - Date.parse(a.dueAt);
  });
}

export const OFF_HIRE_CLOCK_KINDS: ClockKind[] = ['gta_4_8_offhire_repair_24h', 'gta_4_9_termination_1wd', 'gta_4_14_offhire_tl_payment_5wd'];

/** The off-hire deadlines the clocks engine has derived (BLUEPRINT §3.3 end triggers, lesson d). */
export function offHireClocks(clocks: Clock[]): Clock[] {
  return sortClocks(clocks.filter((c) => OFF_HIRE_CLOCK_KINDS.includes(c.kind)));
}

export function storageCapClock(clocks: Clock[]): Clock | undefined {
  return sortClocks(clocks.filter((c) => c.kind === 'storage_report_plus_48h'))[0];
}

export interface ClockCounts {
  open: number;
  overdue: number;
  dueToday: number;
  met: number;
}

export function clockCounts(clocks: Clock[], now: Date | ISODateTime = new Date()): ClockCounts {
  const out: ClockCounts = { open: 0, overdue: 0, dueToday: 0, met: 0 };
  for (const c of clocks) {
    if (c.status === 'met') out.met += 1;
    if (!isOpenClock(c)) continue;
    out.open += 1;
    const s = dueState(c, now);
    if (s === 'overdue') out.overdue += 1;
    if (s === 'today') out.dueToday += 1;
  }
  return out;
}

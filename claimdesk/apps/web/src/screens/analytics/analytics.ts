/**
 * Analytics presentation helpers (pure; unit-tested). Every number is computed by the API from the ledger and
 * the chronology; this module only picks ranges, labels stages and scales bars. No chart library — inline SVG.
 */
import type { HeadOfLoss, ISODate } from '@ccguk/domain';
import type { Tone } from '../../lib/status';

export interface DateRange {
  from?: ISODate;
  to?: ISODate;
}

export type RangePreset = '30d' | '90d' | 'ytd' | '12m' | 'all' | 'custom';

export const RANGE_PRESETS: Array<{ value: RangePreset; label: string }> = [
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'ytd', label: 'This year' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' }
];

function shiftDays(iso: ISODate, days: number): ISODate {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Range for a preset, anchored on `today` (ISODate). `all` → no bounds. */
export function presetRange(preset: RangePreset, today: ISODate): DateRange {
  switch (preset) {
    case '30d':
      return { from: shiftDays(today, -30), to: today };
    case '90d':
      return { from: shiftDays(today, -90), to: today };
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case '12m': {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCFullYear(d.getUTCFullYear() - 1);
      return { from: d.toISOString().slice(0, 10), to: today };
    }
    case 'all':
    case 'custom':
      return {};
  }
}

/** Read `from`/`to`/`range` search params into a range; a preset wins over stray dates. */
export function rangeFromParams(params: URLSearchParams, today: ISODate): { preset: RangePreset; range: DateRange } {
  const preset = (params.get('range') ?? '90d') as RangePreset;
  if (preset === 'custom') {
    const from = params.get('from') ?? undefined;
    const to = params.get('to') ?? undefined;
    return { preset, range: { from: from || undefined, to: to || undefined } };
  }
  if (!RANGE_PRESETS.some((p) => p.value === preset)) return { preset: '90d', range: presetRange('90d', today) };
  return { preset, range: presetRange(preset, today) };
}

export function describeRange(range: DateRange): string {
  if (!range.from && !range.to) return 'all time';
  if (range.from && range.to) return `${range.from} → ${range.to}`;
  if (range.from) return `from ${range.from}`;
  return `to ${range.to}`;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const HEAD_LABEL: Record<HeadOfLoss, string> = {
  hire: 'Hire',
  recovery: 'Recovery',
  storage: 'Storage',
  engineer_fee: 'Engineer fee',
  pav: 'PAV',
  repair: 'Repair',
  salvage: 'Salvage',
  excess: 'Excess',
  loss_of_use: 'Loss of use',
  diminution: 'Diminution',
  personal_effects: 'Personal effects',
  loss_of_earnings: 'Loss of earnings',
  travel: 'Travel',
  misc: 'Misc',
  interest: 'Interest',
  court_fee: 'Court fee',
  fixed_costs: 'Fixed costs'
};

export function headLabel(head: string): string {
  return (HEAD_LABEL as Record<string, string>)[head] ?? head.replace(/_/g, ' ');
}

const STAGE_LABEL: Record<string, string> = {
  fnol: 'FNOL',
  services_agreed: 'Services agreed',
  ncaf: 'NCAF',
  ncaf_sent: 'NCAF',
  hire_start: 'Hire start',
  hire_started: 'Hire start',
  hire_end: 'Hire end',
  hire_ended: 'Hire end',
  pack: 'Payment pack',
  payment_pack: 'Payment pack',
  payment_pack_sent: 'Payment pack',
  payment: 'Payment',
  payment_received: 'Payment',
  report_issued: 'Engineer report',
  settled: 'Settled'
};

export function stageLabel(s: string): string {
  return STAGE_LABEL[s] ?? s.replace(/_/g, ' ');
}

export function cycleLabel(from: string, to: string): string {
  return `${stageLabel(from)} → ${stageLabel(to)}`;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

export function formatPct(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

/** A pleasant axis maximum (1, 2, 5 × 10^n) at or above the data maximum. */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  for (const m of [1, 2, 5, 10]) if (m * base >= max) return m * base;
  return 10 * base;
}

/** Debtor-day tone: ≤ 30 days green (GTA 6.7 month), ≤ 60 amber, over red. */
export function debtorDaysTone(days: number): Tone {
  if (days <= 30) return 'green';
  if (days <= 60) return 'amber';
  return 'red';
}

export function reductionTone(reductionPct: number): Tone {
  if (reductionPct <= 5) return 'green';
  if (reductionPct <= 20) return 'amber';
  return 'red';
}

export interface BarItem {
  key: string;
  label: string;
  value: number;
  /** Text shown at the end of the bar (defaults to the value). */
  display?: string;
  warn?: boolean;
  title?: string;
}

/** Sort bars biggest first and cap the count, folding the remainder into "Other" when `fold` is set. */
export function topBars(items: BarItem[], limit = 12, fold = false): BarItem[] {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  if (sorted.length <= limit) return sorted;
  const head = sorted.slice(0, limit - (fold ? 1 : 0));
  if (!fold) return head;
  const rest = sorted.slice(limit - 1);
  const value = rest.reduce((s, b) => s + b.value, 0);
  return [...head, { key: 'other', label: `Other (${rest.length})`, value }];
}

// owned by ap-booking
/**
 * Delivery and collection scheduling (docs/SUPREME-AUTOPILOT.md §B.8). Pure.
 *
 * Slots are inside business hours (default Mon–Sat 08:00–18:00 Europe/London, no bank holidays), `windowMinutes`
 * long (2 h), at least `leadMinutes` (2 h) after `earliest` and not before the car is ready, with at most
 * `maxPerWindow` movements across the fleet in an overlapping window. A preferred date and/or part of day (from the
 * client's reply) is honoured first; otherwise the earliest slots are offered.
 */
import type { ISODate, ISODateTime } from '../types.js';
import { isBankHoliday, isoToMs, londonDate, londonDateTime, londonParts, msToUtcIso, addCalendarDays } from '../calendar/index.js';
import type { BusinessHours, DeliveryPartOfDay, Movement, SlotWindow } from './types.js';

export const DEFAULT_BUSINESS_HOURS: BusinessHours = { days: [1, 2, 3, 4, 5, 6], start: '08:00', end: '18:00', skipBankHolidays: true };

const MAX_SEARCH_DAYS = 60;

function hm(s: string): { h: number; m: number } {
  const [h, m] = s.split(':').map((x) => Number(x));
  return { h: Number.isFinite(h) ? h! : 0, m: Number.isFinite(m) ? m! : 0 };
}

/** ISO weekday of a London date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: ISODate): number {
  const w = londonParts(londonDateTime(date, 12)).weekday; // 0 = Sunday
  return w === 0 ? 7 : w;
}

export function isBusinessDay(date: ISODate, hours: BusinessHours): boolean {
  if (!hours.days.includes(isoWeekday(date))) return false;
  return !(hours.skipBankHolidays && isBankHoliday(date));
}

/** True when the whole window [start, end) is inside business hours on one business day. */
export function windowInBusinessHours(w: SlotWindow, hours: BusinessHours): boolean {
  const day = londonDate(w.windowStart);
  if (londonDate(msToUtcIso(isoToMs(w.windowEnd) - 1)) !== day || !isBusinessDay(day, hours)) return false;
  const open = hm(hours.start);
  const close = hm(hours.end);
  return isoToMs(w.windowStart) >= isoToMs(londonDateTime(day, open.h, open.m)) && isoToMs(w.windowEnd) <= isoToMs(londonDateTime(day, close.h, close.m));
}

const PART_RANGES: Record<DeliveryPartOfDay, [number, number]> = { morning: [0, 12], afternoon: [12, 17], evening: [17, 24] };

function inPart(windowStart: ISODateTime, part: DeliveryPartOfDay): boolean {
  const h = londonParts(windowStart).hour;
  const [a, b] = PART_RANGES[part];
  return h >= a && h < b;
}

/** Movements (not cancelled/failed) whose window overlaps [start, end). */
export function movementsInWindow(existing: readonly Pick<Movement, 'windowStart' | 'windowEnd' | 'status'>[], w: SlotWindow): number {
  const s = isoToMs(w.windowStart);
  const e = isoToMs(w.windowEnd);
  return existing.filter((m) => m.status !== 'cancelled' && m.status !== 'failed' && isoToMs(m.windowStart) < e && s < isoToMs(m.windowEnd)).length;
}

export interface ProposeSlotsInput {
  earliest: ISODateTime;
  readyBy: ISODateTime;
  businessHours: BusinessHours;
  windowMinutes: number;
  leadMinutes: number;
  existing: Movement[];
  maxPerWindow: number;
  preferred?: { date: ISODate | null; part: DeliveryPartOfDay | null };
}

/**
 * Up to `n` slots. Windows start on the hour grid from opening time in steps of `windowMinutes` (08:00, 10:00, …),
 * never before max(earliest + lead, readyBy). Full windows (≥ maxPerWindow movements) are skipped. With a preferred
 * date/part, matching slots come first, then the rest in time order.
 */
export function proposeSlots(input: ProposeSlotsInput, n: number): SlotWindow[] {
  const windowMs = Math.max(15, input.windowMinutes) * 60_000;
  const notBefore = Math.max(isoToMs(input.earliest) + Math.max(0, input.leadMinutes) * 60_000, isoToMs(input.readyBy));
  const open = hm(input.businessHours.start);
  const close = hm(input.businessHours.end);
  const all: SlotWindow[] = [];
  const want = Math.max(0, n);
  const pref = input.preferred;
  let day = londonDate(msToUtcIso(notBefore));
  // Collect enough candidates: when a preference is set, keep scanning until enough preferred ones (or the horizon).
  for (let i = 0; i < MAX_SEARCH_DAYS && want > 0; i += 1, day = addCalendarDays(day, 1)) {
    if (!isBusinessDay(day, input.businessHours)) continue;
    const openMs = isoToMs(londonDateTime(day, open.h, open.m));
    const closeMs = isoToMs(londonDateTime(day, close.h, close.m));
    for (let s = openMs; s + windowMs <= closeMs; s += windowMs) {
      if (s < notBefore) continue;
      const w: SlotWindow = { windowStart: msToUtcIso(s), windowEnd: msToUtcIso(s + windowMs) };
      if (movementsInWindow(input.existing, w) >= input.maxPerWindow) continue;
      all.push(w);
    }
    const preferredCount = pref && (pref.date || pref.part) ? all.filter((w) => matchesPreference(w, pref)).length : all.length;
    if (preferredCount >= want && all.length >= want) break;
    if (pref?.date && day > pref.date && all.length >= want) break;
  }
  if (!pref || (!pref.date && !pref.part)) return all.slice(0, want);
  const preferred = all.filter((w) => matchesPreference(w, pref));
  const rest = all.filter((w) => !matchesPreference(w, pref));
  return [...preferred, ...rest].slice(0, want);
}

function matchesPreference(w: SlotWindow, pref: { date: ISODate | null; part: DeliveryPartOfDay | null }): boolean {
  if (pref.date && londonDate(w.windowStart) !== pref.date) return false;
  if (pref.part && !inPart(w.windowStart, pref.part)) return false;
  return true;
}

/** "Tue 13 Oct, 10:00–12:00" (Europe/London) — owner and client wording. */
export function slotLabel(w: SlotWindow): string {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const a = londonParts(w.windowStart);
  const b = londonParts(w.windowEnd);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${DAYS[a.weekday]} ${a.day} ${MONTHS[a.month - 1]}, ${p(a.hour)}:${p(a.minute)}–${p(b.hour)}:${p(b.minute)}`;
}

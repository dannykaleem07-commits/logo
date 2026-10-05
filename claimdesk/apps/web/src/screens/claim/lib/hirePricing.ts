/**
 * Hire pricing guide presentation (pure; docs/V03-MANAGER-MODE-HIRE-PRICING.md §B.1). When a fleet car is chosen for a
 * hire, the screen shows its own daily rate next to the GTA guide for the car we give and for the client's
 * accident-damaged car, the difference, and one-click chips for the agreed rate. GTA rates are an industry benchmark
 * only (CCGUK is not a GTA subscriber); the legal citation stays in a tooltip, never in the visible text.
 */
import { formatGBP, formatRegistration, type HireBenchmark, type HireCalculation, type Pence } from '@ccguk/domain';
import type { FleetUnitRow } from '../../../api/client';
import type { ClientGroupSource, HirePricingGuideResponse, HirePricingSnapshot, PricingGuideLine, PricingSuggestion } from '../../../api/hireApi';

/** "£74.68/day". */
export function perDay(pence: Pence): string {
  return `${formatGBP(pence)}/day`;
}

/** Signed money: "+£32.36", "−£5.00", "£0.00". */
export function signedGBP(pence: Pence): string {
  if (pence > 0) return `+${formatGBP(pence)}`;
  if (pence < 0) return `−${formatGBP(-pence)}`;
  return formatGBP(0);
}

/** "+£32.36 / day" (car we give − client's car); "—" without both guides. */
export function differenceText(pence: Pence | null | undefined): string {
  if (pence === null || pence === undefined) return '—';
  return `${signedGBP(pence)} / day`;
}

export interface PricingChip {
  id: PricingSuggestion['id'];
  label: string;
  dailyRatePence: Pence;
}

/**
 * Chips under the agreed rate, in the server's order: "Fleet rate £74.68", "Car we give — guide £74.68",
 * "Client's car — guide £42.32 (like for like)".
 */
export function pricingChips(suggestions: readonly PricingSuggestion[] | undefined): PricingChip[] {
  return (suggestions ?? []).map((s) => {
    const money = formatGBP(s.dailyRatePence);
    const m = /^(.*?)\s*(\([^)]*\))$/.exec(s.label);
    const label = m ? `${m[1]} ${money} ${m[2]}` : `${s.label} ${money}`;
    return { id: s.id, label, dailyRatePence: s.dailyRatePence };
  });
}

export type NoticeTone = 'warn' | 'info';

/** A higher group than the damaged car is the one notice shown in amber; the others are information. */
export function noticeTone(notice: string): NoticeTone {
  return /^Higher group/i.test(notice.trim()) ? 'warn' : 'info';
}

/** Notices with their tone, the amber ones first (the server already orders them, most important first). */
export function pricingNotices(notices: readonly string[] | undefined): Array<{ text: string; tone: NoticeTone }> {
  const out = (notices ?? []).map((text) => ({ text, tone: noticeTone(text) }));
  return [...out.filter((n) => n.tone === 'warn'), ...out.filter((n) => n.tone !== 'warn')];
}

/** "Group M2 · GTA guide £74.68", or the reason there is no guide. */
export function guideLineText(line: PricingGuideLine | undefined): string {
  if (!line) return '—';
  if (line.dailyRatePence === null || line.dailyRatePence === undefined) return line.group ? `Group ${line.group} · ${line.missingReason ?? 'no guide rate'}` : (line.missingReason ?? 'No GTA group');
  return `${line.group ? `Group ${line.group} · ` : ''}GTA guide ${formatGBP(line.dailyRatePence)}`;
}

/** Where the client's group came from, in plain words. */
export function clientSourceText(source: ClientGroupSource | undefined): string {
  switch (source) {
    case 'recorded':
      return 'group recorded on the car';
    case 'manual':
      return 'group chosen here';
    case 'suggested':
      return 'suggested group — confirm it';
    default:
      return 'no group yet';
  }
}

/**
 * The benchmark caveat as visible text: the server's note without its legal citation (a sentence or clause naming a
 * GTA clause number), e.g. "GTA terms are an industry benchmark only. CCGUK is not a GTA subscriber." The full note goes
 * in the tooltip.
 */
export function benchmarkCaveat(note: string | undefined): string {
  const fallback = 'GTA rates are an industry benchmark only. CCGUK is not a GTA subscriber.';
  if (!note) return fallback;
  const parts = note
    .split(/(?<=\.)\s+/)
    .map((s) => s.split(/;\s*/)[0]!.trim())
    .filter((s) => s && !/\bGTA\s+\d/.test(s))
    .map((s) => (/[.!?]$/.test(s) ? s : `${s}.`));
  const text = parts.join(' ').trim();
  return text && /benchmark/i.test(text) ? text : fallback;
}

/** "NISSAN QASHQAI" → "Nissan Qashqai" (short all-capital words such as VW and BMW are kept). */
export function niceName(text: string | undefined): string {
  if (!text) return '';
  return text
    .trim()
    .split(/\s+/)
    .map((w) => (w.length > 3 && w === w.toUpperCase() && /[A-Z]/.test(w) ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/** "FL33EET" → "FL33 EET" (display form); anything that is not a registration is shown as it is. */
export function displayRegistration(reg: string | undefined): string {
  if (!reg) return '';
  try {
    return formatRegistration(reg);
  } catch {
    return reg;
  }
}

export function unitRegistration(u: Pick<FleetUnitRow, 'id' | 'registration' | 'vehicle'>): string {
  const reg = u.registration ?? u.vehicle?.registration;
  return reg ? displayRegistration(reg) : u.id;
}

const STATUS_SUFFIX: Partial<Record<FleetUnitRow['status'], string>> = { on_hire: 'on hire', off_road: 'off road' };

/** "FL33 EET · VW Golf · S1 · £49.80/day" (+ " · on hire" / " · off road"). */
export function fleetOptionLabel(u: Pick<FleetUnitRow, 'id' | 'registration' | 'vehicle' | 'gtaGroup' | 'dailyRatePence' | 'status'>): string {
  const name = niceName([u.vehicle?.make, u.vehicle?.model].filter(Boolean).join(' '));
  const parts = [unitRegistration(u), name, u.gtaGroup, perDay(u.dailyRatePence)].filter((p) => p !== '');
  const suffix = STATUS_SUFFIX[u.status];
  return `${parts.join(' · ')}${suffix ? ` · ${suffix}` : ''}`;
}

/** Fleet select options: disposed cars hidden; on-hire and off-road cars disabled unless manager mode is on. */
export function fleetOptions(units: readonly FleetUnitRow[], managerOn: boolean): Array<{ value: string; label: string; disabled?: boolean }> {
  return units
    .filter((u) => u.status !== 'disposed')
    .map((u) => {
      // A car on hire now can still take an earlier (forgotten) hire: the server's overlap check decides on the dates.
      const blocked = u.status === 'off_road';
      return blocked && !managerOn ? { value: u.id, label: fleetOptionLabel(u), disabled: true } : { value: u.id, label: fleetOptionLabel(u) };
    });
}

/** "Agreed £74.68/day · Car we give M2 guide £74.68 · Client's car S1 guide £42.32 · +£32.36/day". */
export function snapshotSummary(p: HirePricingSnapshot): string {
  const parts = [`Agreed ${perDay(p.agreedDailyRatePence)}`];
  parts.push(p.hireGtaDailyRatePence !== null ? `Car we give ${p.hireGroup} guide ${formatGBP(p.hireGtaDailyRatePence)}` : `Car we give ${p.hireGroup} (no guide rate)`);
  if (p.clientGtaGroup) parts.push(p.clientGtaDailyRatePence !== null ? `Client's car ${p.clientGtaGroup} guide ${formatGBP(p.clientGtaDailyRatePence)}` : `Client's car ${p.clientGtaGroup} (no guide rate)`);
  else parts.push("Client's car: no group");
  if (p.differencePerDayPence !== null) parts.push(`${signedGBP(p.differencePerDayPence)}/day`);
  return parts.join(' · ');
}

/** The amber notice for a card whose car is in a higher group than the client's damaged car. */
export function higherGroupNotice(p: Pick<HirePricingSnapshot, 'higherGroup' | 'notices'>): string | undefined {
  if (!p.higherGroup) return undefined;
  return p.notices.find((n) => noticeTone(n) === 'warn') ?? 'Higher group than the damaged car.';
}

/** "At the like-for-like guide (S1): £296.24, difference £226.52". */
export function likeForLikeText(b: Pick<HireBenchmark, 'group' | 'hireAtGtaRatePence' | 'differencePence'> | undefined): string | undefined {
  if (!b) return undefined;
  return `At the like-for-like guide (${b.group}): ${formatGBP(b.hireAtGtaRatePence)}, difference ${signedGBP(b.differencePence)}`;
}

/** Like-for-like line from a card's calculation, when the server worked it out. */
export function likeForLikeLine(calc: Pick<HireCalculation, 'likeForLike'> | undefined): string | undefined {
  return likeForLikeText(calc?.likeForLike);
}

/** The guide heading: "Pricing guide (hire starting 5 Oct 2026)". */
export function pricingHeading(date: string | undefined): string {
  if (!date) return 'Pricing guide';
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'Pricing guide';
  return `Pricing guide (hire starting ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })})`;
}

/** Group choices for the "change" select: the groups in force on the date, plus the current one if it is not listed. */
export function groupChoices(guide: Pick<HirePricingGuideResponse, 'groupsOnDate' | 'clientCar'> | undefined): string[] {
  const groups = [...(guide?.groupsOnDate ?? [])];
  const current = guide?.clientCar.group;
  if (current && !groups.includes(current)) groups.unshift(current);
  return groups;
}

/**
 * Photo intelligence helpers (docs/SMART-INTAKE.md §4.15, improvement 7): plates read in photos matched to the case's
 * registrations, distances between photo locations, outliers, and damage zones from estimate lines (the claim's damage
 * model zones — `VEHICLE_ZONES` from engineering/panels.ts).
 */
import { zoneForPanelName, type VehicleBodyType } from '../../engineering/panels.js';
import type { PhotoScene } from './types.js';
import { displayPlate, normVrm } from './text.js';

export type { PhotoScene };

export function plateMatches(plates: string[], vrms: { client: string | null; tp: string | null }): Array<{ text: string; normalised: string; matches: 'client' | 'third_party' | null }> {
  const c = vrms.client ? normVrm(vrms.client) : null;
  const t = vrms.tp ? normVrm(vrms.tp) : null;
  const seen = new Set<string>();
  const out: Array<{ text: string; normalised: string; matches: 'client' | 'third_party' | null }> = [];
  for (const p of plates) {
    const n = normVrm(p);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push({ text: displayPlate(n), normalised: n, matches: n === c ? 'client' : n === t ? 'third_party' : null });
  }
  return out;
}

/** Great-circle distance (haversine), km. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Photos more than `km` from the median of the others (only with at least 3 located photos). */
export function gpsOutliers(points: Array<{ fileId: string; lat: number; lon: number }>, km: number): string[] {
  if (points.length < 3) return [];
  const out: string[] = [];
  for (const p of points) {
    const others = points.filter((o) => o.fileId !== p.fileId);
    const med = { lat: median(others.map((o) => o.lat)), lon: median(others.map((o) => o.lon)) };
    if (distanceKm(p, med) > km) out.push(p.fileId);
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const SEVERITY_WORDS: Array<{ re: RegExp; severity: 1 | 2 | 3 }> = [
  { re: /\b(structural|chassis|airbag|srs|pretensioner|section(?:ing)?|pull(?:ed)? on jig|jig)\b/i, severity: 3 },
  { re: /\b(replace|replacement|renew|new)\b/i, severity: 2 },
  { re: /\b(repair|paint|refinish|blend|polish|smart repair)\b/i, severity: 1 },
];

/** Damage zones from estimate / engineer-report lines ("O/S/F wing — replace"): zone id, severity 1–3, the line. */
export function zonesFromEstimateText(lines: string[], body?: VehicleBodyType): Array<{ zoneId: string; severity: 1 | 2 | 3; line: string }> {
  const best = new Map<string, { zoneId: string; severity: 1 | 2 | 3; line: string }>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.length > 200) continue;
    const sev = SEVERITY_WORDS.find((s) => s.re.test(line))?.severity;
    if (!sev) continue;
    const zone = zoneForPanelName(line, body);
    if (!zone) continue;
    const prev = best.get(zone);
    if (!prev || sev > prev.severity) best.set(zone, { zoneId: zone, severity: sev, line });
  }
  return [...best.values()];
}

/** The claim's damage map from observations: owner rows win, then the highest severity; every source evidence listed. */
export function damageMapFromObservations(obs: Array<{ zoneId: string; severity: number; confidence: number; source: string; createdAt: string; evidenceId?: string | null }>): Record<string, { severity: 0 | 1 | 2 | 3; confidence: number; source: 'ai'; evidenceIds: string[] }> {
  const out: Record<string, { severity: 0 | 1 | 2 | 3; confidence: number; source: 'ai'; evidenceIds: string[]; owner?: boolean; at?: string }> = {};
  for (const o of [...obs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const sev = Math.max(0, Math.min(3, Math.round(o.severity))) as 0 | 1 | 2 | 3;
    const cur = out[o.zoneId];
    const isOwner = o.source === 'owner';
    const evidenceIds = [...new Set([...(cur?.evidenceIds ?? []), ...(o.evidenceId ? [o.evidenceId] : [])])];
    if (!cur) {
      out[o.zoneId] = { severity: sev, confidence: o.confidence, source: 'ai', evidenceIds, ...(isOwner ? { owner: true } : {}) };
      continue;
    }
    if (isOwner) out[o.zoneId] = { severity: sev, confidence: 1, source: 'ai', evidenceIds, owner: true };
    else if (!cur.owner && sev > cur.severity) out[o.zoneId] = { severity: sev, confidence: Math.max(cur.confidence, o.confidence), source: 'ai', evidenceIds };
    else out[o.zoneId] = { ...cur, confidence: cur.owner ? cur.confidence : Math.max(cur.confidence, o.confidence), evidenceIds };
  }
  const clean: Record<string, { severity: 0 | 1 | 2 | 3; confidence: number; source: 'ai'; evidenceIds: string[] }> = {};
  for (const [k, v] of Object.entries(out)) clean[k] = { severity: v.severity, confidence: Math.round(v.confidence * 100) / 100, source: 'ai', evidenceIds: v.evidenceIds };
  return clean;
}

/** Photo scenes counted as photos of the damage. */
export const isDamageScene = (s: PhotoScene | null): boolean => s === 'damage';

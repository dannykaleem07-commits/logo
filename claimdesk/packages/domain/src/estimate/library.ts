/**
 * In-house labour-time library (BLUEPRINT §4.5 (c)): statistical medians of CCGUK's OWN approved
 * estimates by make, model, panel and operation. It is not a copy of any third-party times table
 * and only approved estimates feed it. A median is only offered once three or more approved
 * observations exist.
 */
import type { Estimate, EstimateLine, ISODateTime } from '../types.js';

export interface LabourLibraryEntry {
  make: string;
  model: string;
  panel: string;
  operation: string;
  hours: number;
  /** The approved estimate the observation came from. */
  estimateId?: string;
  lineId?: string;
  /** Who approved the estimate — required; unapproved estimates never enter the library. */
  approvedBy: string;
  approvedAt?: ISODateTime;
}

export interface LabourLibraryJson {
  version: 1;
  entries: LabourLibraryEntry[];
}

export interface LabourMedian {
  hours: number;
  n: number;
}

export interface LabourSuggestion {
  lineId: string;
  panel?: string;
  operation: string;
  currentHours?: number;
  suggestedHours: number | null;
  n: number;
  /** currentHours − suggestedHours (positive = line above the library median). */
  differenceHours?: number;
  note: string;
}

export interface AddResult {
  added: boolean;
  reason?: string;
}

export const LIBRARY_MIN_OBSERVATIONS = 3;

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
const round2 = (v: number): number => Math.round(v * 100) / 100;

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export class LabourLibrary {
  private readonly store: LabourLibraryEntry[] = [];

  get size(): number {
    return this.store.length;
  }

  /** A copy: the store can only be changed through `add`, which enforces the approval rule. */
  entries(): readonly LabourLibraryEntry[] {
    return this.store.map((e) => ({ ...e }));
  }

  /** Add one observation. Refused unless it carries an approver and positive hours. */
  add(entry: LabourLibraryEntry): AddResult {
    if (!entry.approvedBy || !entry.approvedBy.trim()) return { added: false, reason: 'only approved estimates feed the labour library (approvedBy missing)' };
    if (!(entry.hours > 0) || !Number.isFinite(entry.hours)) return { added: false, reason: 'hours must be a positive number' };
    for (const k of ['make', 'model', 'panel', 'operation'] as const) {
      if (!entry[k] || !entry[k].trim()) return { added: false, reason: `${k} is required` };
    }
    this.store.push({
      ...entry,
      make: entry.make.trim(),
      model: entry.model.trim(),
      panel: entry.panel.trim(),
      operation: entry.operation.trim(),
      hours: round2(entry.hours),
    });
    return { added: true };
  }

  /**
   * Add every engineer-confirmed labour and paint line with hours and a panel from an APPROVED
   * estimate. Pre-existing lines are skipped (they are not accident repair times).
   */
  addFromEstimate(estimate: Estimate, vehicle: { make: string; model: string }, approvedAt?: ISODateTime): { added: number; skipped: number; reason?: string } {
    if (!estimate.approvedBy) return { added: 0, skipped: estimate.lines.length, reason: 'estimate is not approved' };
    let added = 0;
    let skipped = 0;
    for (const line of estimate.lines) {
      const eligible = (line.kind === 'labour' || line.kind === 'paint') && line.hours !== undefined && line.hours > 0 && line.panel && line.confirmedByEngineer && !line.preExisting;
      if (!eligible) {
        skipped += 1;
        continue;
      }
      const r = this.add({
        make: vehicle.make,
        model: vehicle.model,
        panel: line.panel!,
        operation: line.operation,
        hours: line.hours!,
        estimateId: estimate.id,
        lineId: line.id,
        approvedBy: estimate.approvedBy,
        approvedAt,
      });
      if (r.added) added += 1;
      else skipped += 1;
    }
    return { added, skipped };
  }

  private matching(make: string, model: string, panel: string, operation: string): LabourLibraryEntry[] {
    const m = norm(make);
    const mo = norm(model);
    const p = norm(panel);
    const o = norm(operation);
    return this.store.filter((e) => norm(e.make) === m && norm(e.model) === mo && norm(e.panel) === p && norm(e.operation) === o);
  }

  /** Median hours for make/model/panel/operation, or null when fewer than three observations. */
  median(make: string, model: string, panel: string, operation: string): LabourMedian | null {
    const hits = this.matching(make, model, panel, operation);
    if (hits.length < LIBRARY_MIN_OBSERVATIONS) return null;
    return { hours: round2(medianOf(hits.map((h) => h.hours))), n: hits.length };
  }

  /** Suggested hours for each labour/paint line of an estimate for this make and model. */
  suggest(make: string, model: string, lines: EstimateLine[]): LabourSuggestion[] {
    const out: LabourSuggestion[] = [];
    for (const line of lines) {
      if (line.kind !== 'labour' && line.kind !== 'paint') continue;
      if (!line.panel) {
        out.push({ lineId: line.id, panel: undefined, operation: line.operation, currentHours: line.hours, suggestedHours: null, n: 0, note: 'No panel on the line; nothing to look up.' });
        continue;
      }
      const med = this.median(make, model, line.panel, line.operation);
      if (!med) {
        const n = this.matching(make, model, line.panel, line.operation).length;
        out.push({
          lineId: line.id,
          panel: line.panel,
          operation: line.operation,
          currentHours: line.hours,
          suggestedHours: null,
          n,
          note: `Only ${n} approved observation(s) for ${make} ${model} / ${line.panel} / ${line.operation}; ${LIBRARY_MIN_OBSERVATIONS} are needed before the library suggests a time.`,
        });
        continue;
      }
      const diff = line.hours !== undefined ? round2(line.hours - med.hours) : undefined;
      out.push({
        lineId: line.id,
        panel: line.panel,
        operation: line.operation,
        currentHours: line.hours,
        suggestedHours: med.hours,
        n: med.n,
        differenceHours: diff,
        note:
          diff === undefined
            ? `Library median ${med.hours} hrs from ${med.n} approved CCGUK estimates.`
            : `Library median ${med.hours} hrs from ${med.n} approved CCGUK estimates; this line is ${diff >= 0 ? `${diff} hrs above` : `${Math.abs(diff)} hrs below`} the median.`,
      });
    }
    return out;
  }

  toJSON(): LabourLibraryJson {
    return { version: 1, entries: [...this.store] };
  }

  export(): string {
    return JSON.stringify(this.toJSON());
  }

  /** Merge entries from an exported library. Returns the number added (unapproved entries are refused). */
  import(json: string | LabourLibraryJson): number {
    const data: LabourLibraryJson = typeof json === 'string' ? (JSON.parse(json) as LabourLibraryJson) : json;
    if (!data || data.version !== 1 || !Array.isArray(data.entries)) throw new Error('Unrecognised labour library export');
    let added = 0;
    for (const e of data.entries) if (this.add(e).added) added += 1;
    return added;
  }

  static fromJSON(json: string | LabourLibraryJson): LabourLibrary {
    const lib = new LabourLibrary();
    lib.import(json);
    return lib;
  }
}

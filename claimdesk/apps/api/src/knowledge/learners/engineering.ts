// owned by knowledge-learners
/**
 * L5 engineer figures (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.5). Code only.
 *
 * Inputs: estimates approved by a person, lines an engineer confirmed (not pre-existing damage), and issued engineer
 * reports. Output: `engineering_figure` items (median, p25, p75; n ≥ thresholds.engineeringMinN) per make, model
 * family, panel, operation and metric — labour hours, paint hours, repair working days and the ADAS-calibration rate.
 * Any input of Audatex provenance (an imported estimate or an imported line) makes the item `code_only`, so it never
 * reaches a prompt (SD §H.2.7). Nothing is written to labour_library, packages/kb/data/engineering/** or
 * packages/domain/src/engineering/**; Thatcham and Audatex times are never copied into text.
 *
 * Phase 2's `engineer_learning` / confirmed-report labour rows are read only when those tables exist (hasTable);
 * Phase 2 is not built, so today the learner reads estimates and reports only.
 */
import { distOf, type EngineeringFigureData, type KnowledgeProposal } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import { getKnowledgeSettings } from '../settings.js';
import { proposeKnowledge } from '../store.js';
import { LEARNER, all, hasTable, isPerson, json } from './common.js';

interface Sample {
  make: string;
  family: string | null;
  panel: string;
  operation: string;
  metric: EngineeringFigureData['metric'];
  value: number;
  audatex: boolean;
  source: 'approved_estimate' | 'confirmed_report';
  id: string;
}

const title = (s: string): string => s.trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const familyOf = (model: string | null | undefined): string | null => (model ? (model.trim().split(/\s+/)[0] ?? null) : null);

export interface EngineeringResult {
  samples: number;
  groups: number;
  proposed: number;
  phase2Tables: boolean;
}

export function learnEngineering(ctx: AppContext, opts: { runId?: string | null; jobId?: string | null } = {}): EngineeringResult {
  const minN = getKnowledgeSettings(ctx).thresholds.engineeringMinN;
  const samples: Sample[] = [];
  const estimates = all<{ id: string; lines: string; approved_by: string | null; imported_from_evidence_id: string | null; make: string | null; model: string | null }>(
    ctx,
    `SELECT e.id, e.lines, e.approved_by, e.imported_from_evidence_id, v.make, v.model FROM estimates e LEFT JOIN vehicles v ON v.id = e.vehicle_id WHERE e.approved_by IS NOT NULL ORDER BY e.id`,
  );
  const adasByVehicle = new Map<string, { make: string; family: string | null; values: number[]; audatex: boolean; ids: string[] }>();
  for (const e of estimates) {
    if (!isPerson(e.approved_by) || !e.make) continue;
    const imported = Boolean(e.imported_from_evidence_id);
    const lines = json<Array<{ kind: string; operation: string; panel?: string; hours?: number; confirmedByEngineer?: boolean; preExisting?: boolean; source?: string }>>(e.lines) ?? [];
    const make = title(e.make);
    const family = familyOf(e.model);
    let adas = 0;
    for (const l of lines) {
      if (l.kind === 'adas') adas = 1;
      if (!l.confirmedByEngineer || l.preExisting || typeof l.hours !== 'number' || !(l.hours > 0)) continue;
      const metric = l.kind === 'labour' ? 'labour_hours' : l.kind === 'paint' ? 'paint_hours' : null;
      if (!metric) continue;
      samples.push({ make, family, panel: title(l.panel ?? 'unspecified'), operation: title(l.operation || 'unspecified'), metric, value: l.hours, audatex: imported || l.source === 'import', source: 'approved_estimate', id: e.id });
    }
    const k = `${make}|${family ?? ''}`;
    const cur = adasByVehicle.get(k) ?? { make, family, values: [], audatex: false, ids: [] };
    cur.values.push(adas);
    cur.audatex = cur.audatex || imported;
    cur.ids.push(e.id);
    adasByVehicle.set(k, cur);
  }
  for (const [, v] of adasByVehicle) for (let i = 0; i < v.values.length; i++) samples.push({ make: v.make, family: v.family, panel: 'All', operation: 'Calibrate', metric: 'adas_calibration_rate', value: v.values[i]!, audatex: v.audatex, source: 'approved_estimate', id: v.ids[i]! });
  const reports = all<{ id: string; repair_duration_working_days: number | null; make: string | null; model: string | null }>(
    ctx,
    `SELECT r.id, r.repair_duration_working_days, v.make, v.model FROM engineer_reports r LEFT JOIN vehicles v ON v.id = r.vehicle_id WHERE r.issued_at IS NOT NULL AND r.repair_duration_working_days IS NOT NULL ORDER BY r.id`,
  );
  for (const r of reports) {
    if (!r.make || r.repair_duration_working_days === null) continue;
    samples.push({ make: title(r.make), family: familyOf(r.model), panel: 'All', operation: 'Repair', metric: 'repair_working_days', value: r.repair_duration_working_days, audatex: false, source: 'confirmed_report', id: r.id });
  }

  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    const k = [s.make, s.family ?? '', s.panel, s.operation, s.metric].join('|');
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const result: EngineeringResult = { samples: samples.length, groups: groups.size, proposed: 0, phase2Tables: hasTable(ctx, 'engineer_learning') };
  for (const [, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dist = distOf(g.map((s) => s.value), minN);
    if (!dist) continue;
    const s0 = g[0]!;
    const audatex = g.some((s) => s.audatex);
    const data: EngineeringFigureData = { vehicle: { make: s0.make, modelFamily: s0.family, yearFrom: null, yearTo: null }, panel: s0.panel, operation: s0.operation, metric: s0.metric, median: dist.median, p25: dist.p25, p75: dist.p75, n: dist.n };
    const unit = s0.metric === 'repair_working_days' ? 'working days' : s0.metric === 'adas_calibration_rate' ? '(share of estimates)' : 'hours';
    const proposal: KnowledgeProposal<EngineeringFigureData> = {
      kind: 'engineering_figure',
      area: 'engineering',
      title: `${s0.make}${s0.family ? ` ${s0.family}` : ''} — ${s0.panel} ${s0.operation.toLowerCase()} (${s0.metric.replace(/_/g, ' ')})`.slice(0, 200),
      body: `Median ${dist.median} ${unit} (IQR ${dist.p25}–${dist.p75}, n=${dist.n}) from engineer-confirmed figures. A suggestion only: an engineer still confirms every line.`,
      data,
      tags: ['engineering', 'computed', ...(audatex ? ['audatex_derived'] : [])],
      scope: { kind: 'global' },
      business: ['ccguk'],
      useLimit: audatex ? 'code_only' : 'internal',
      origin: 'computed',
      confidence: 1,
      supportN: dist.n,
      provenance: [{ kind: 'engineering', source: s0.source, ids: [...new Set(g.map((s) => s.id))].slice(0, 100), n: dist.n }],
      createdBy: LEARNER,
    };
    const r = proposeKnowledge(ctx, proposal, { runId: opts.runId ?? null, jobId: opts.jobId ?? null });
    if (r.created) result.proposed += 1;
  }
  return result;
}

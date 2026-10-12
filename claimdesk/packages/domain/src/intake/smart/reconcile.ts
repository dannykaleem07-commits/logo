/**
 * One draft from many readings (docs/SMART-INTAKE.md §4.8, improvements 2 and 3). Per detail: invalid readings are kept
 * only as alternatives; the rest are clustered by `compatible`; the winning cluster is the one with the best source
 * (rank, engine order, confidence). Two clusters each read with confidence ≥ 0.5 make a **conflict** — the best is
 * preselected but never silently final: the owner chooses (or accepts every preselected value). The owner's own value
 * always wins and resolves the conflict. AI reasoning readings add a "why" next to the options and never resolve one.
 */
import { BUNDLE_FIELD_KEYS, BUNDLE_FIELD_META, KEY_FIELDS, SENSITIVE_BUNDLE_KEYS, type Attribution, type BundleFieldKey, type Candidate, type Conflict, type ConflictOption, type DecisionView, type DraftField, type FieldSource, type WitnessDraft } from './types.js';
import { compatible } from './compat.js';
import { DOC_TYPE_PLAIN, ENGINE_ORDER, rankWhy } from './ranking.js';
import { normaliseQuoteText } from '../../knowledge/quotes.js';

export interface WitnessReading {
  /** 'none' = the document says there were no witnesses. */
  witnesses: WitnessDraft[] | 'none';
  source: FieldSource;
  /** Written by the client (accident report form, signed CCGUK form). */
  clientAuthored: boolean;
}

export interface ReconcileInput {
  candidates: Candidate[];
  decisions: DecisionView[];
  minConflictConfidence: number;
  lowConfidence: number;
  witnessReadings?: WitnessReading[];
}

export interface ReconcileResult {
  fields: DraftField[];
  conflicts: Conflict[];
  witnesses: WitnessDraft[];
  witnessesAnswered: boolean;
  /** Who wrote the winning account of what happened. */
  circumstances: { attribution: Attribution | null; fromFileId: string | null };
}

export function ownerSource(at: string | null = null): FieldSource {
  return { fileId: '', itemId: '', evidenceId: '', filename: '', docType: null, docTypeLabel: null, page: null, quote: null, confidence: 1, engine: 'owner', rank: 1000, label: at ? 'Set by you' : 'Set by you', quoteVerified: null };
}

interface Cluster {
  value: string;
  display: string;
  members: Candidate[];
  best: Candidate;
  bestOfValue: Candidate;
  maxConfidence: number;
  aiWhy: string | null;
}

const better = (a: Candidate, b: Candidate): number =>
  b.source.rank - a.source.rank || ENGINE_ORDER[b.source.engine] - ENGINE_ORDER[a.source.engine] || b.source.confidence - a.source.confidence || a.source.fileId.localeCompare(b.source.fileId);

function clusterize(key: BundleFieldKey, cands: Candidate[]): Cluster[] {
  const sorted = [...cands].sort((a, b) => -better(b, a));
  const clusters: Cluster[] = [];
  for (const c of sorted) {
    let placed = false;
    for (const cl of clusters) {
      const r = compatible(key, { value: cl.value }, c);
      if (!r.same) continue;
      cl.members.push(c);
      if (r.prefer === 'b') {
        cl.value = c.value;
        cl.display = c.display;
        cl.bestOfValue = c;
      }
      cl.maxConfidence = Math.max(cl.maxConfidence, c.source.confidence);
      if (!cl.aiWhy && c.aiWhy) cl.aiWhy = c.aiWhy;
      placed = true;
      break;
    }
    if (!placed) clusters.push({ value: c.value, display: c.display, members: [c], best: c, bestOfValue: c, maxConfidence: c.source.confidence, aiWhy: c.aiWhy ?? null });
  }
  // the source shown is the best-ranked reading of the kept value
  for (const cl of clusters) {
    const sameValue = cl.members.filter((m) => compatible(key, { value: cl.value }, m).same && (m.value === cl.value || m.display === cl.display));
    cl.bestOfValue = [...(sameValue.length ? sameValue : cl.members)].sort(better)[0]!;
    cl.best = [...cl.members].sort(better)[0]!;
  }
  return clusters.sort((a, b) => better(a.best, b.best));
}

const conflictIdOf = (key: BundleFieldKey): string => `c:${key}`;

/** The owner's current value per key from the decisions (latest wins; clear removes). */
function ownerValues(decisions: DecisionView[]): Map<string, { value: string; display: string; by: string; at: string; note: string | null }> {
  const out = new Map<string, { value: string; display: string; by: string; at: string; note: string | null }>();
  for (const d of decisions) {
    if (!d.subject) continue;
    if (d.kind === 'set_field') {
      const a = (d.after ?? {}) as { value?: unknown; display?: unknown };
      if (typeof a.value === 'string') out.set(d.subject, { value: a.value, display: typeof a.display === 'string' ? a.display : a.value, by: d.actor, at: d.at, note: d.note });
    } else if (d.kind === 'clear_field') out.delete(d.subject);
  }
  return out;
}

/** Owner conflict choices: conflictId → chosen value (choose_conflict, or accept_preselected's recorded values). */
function conflictChoices(decisions: DecisionView[]): Map<string, { value: string; by: string; at: string }> {
  const out = new Map<string, { value: string; by: string; at: string }>();
  for (const d of decisions) {
    if (d.kind === 'choose_conflict' && d.subject) {
      const v = (d.after as { value?: unknown } | null)?.value;
      if (typeof v === 'string') out.set(d.subject, { value: v, by: d.actor, at: d.at });
    } else if (d.kind === 'accept_preselected') {
      const list = ((d.after as { conflicts?: unknown } | null)?.conflicts ?? []) as Array<{ id?: unknown; value?: unknown }>;
      for (const c of Array.isArray(list) ? list : []) if (typeof c.id === 'string' && typeof c.value === 'string' && !out.has(c.id)) out.set(c.id, { value: c.value, by: d.actor, at: d.at });
    }
  }
  return out;
}

const authoredLabel = (s: FieldSource): string => (s.docType ? DOC_TYPE_PLAIN[s.docType] : 'a document');

export function reconcile(input: ReconcileInput): ReconcileResult {
  const owner = ownerValues(input.decisions);
  const choices = conflictChoices(input.decisions);
  const fields: DraftField[] = [];
  const conflicts: Conflict[] = [];
  let circumstances: ReconcileResult['circumstances'] = { attribution: null, fromFileId: null };

  for (const key of BUNDLE_FIELD_KEYS) {
    const meta = BUNDLE_FIELD_META[key];
    const all = input.candidates.filter((c) => c.key === key);
    const invalid = all.filter((c) => !c.validatorOk);
    const valid = all.filter((c) => c.validatorOk);
    const clusters = clusterize(key, valid);
    const qualifying = clusters.filter((cl) => cl.members.some((m) => m.source.confidence >= input.minConflictConfidence));
    const ownerSet = owner.get(key);

    let conflict: Conflict | null = null;
    if (qualifying.length >= 2) {
      const winner = qualifying[0]!;
      const runnerUp = qualifying[1]!;
      const options: ConflictOption[] = qualifying.map((cl, i) => ({
        value: cl.value,
        display: cl.display,
        sources: [...cl.members].sort(better).map((m) => m.source),
        rank: cl.best.source.rank,
        preselected: i === 0,
        aiWhy: cl.aiWhy,
      }));
      const id = conflictIdOf(key);
      const choice = choices.get(id);
      const chosen = choice ? options.find((o) => o.value === choice.value || compatible(key, { value: o.value }, { value: choice.value }).same) : undefined;
      conflict = {
        id,
        key,
        label: meta.label,
        status: 'open',
        options,
        why: rankWhy(key, winner.best.source, runnerUp.best.source),
        chosenValue: null,
        resolvedBy: null,
        resolvedAt: null,
      };
      if (ownerSet) {
        conflict.status = 'resolved';
        conflict.chosenValue = ownerSet.value;
        conflict.resolvedBy = ownerSet.by;
        conflict.resolvedAt = ownerSet.at;
      } else if (chosen && choice) {
        conflict.status = 'resolved';
        conflict.chosenValue = chosen.value;
        conflict.resolvedBy = choice.by;
        conflict.resolvedAt = choice.at;
      }
      conflicts.push(conflict);
    }

    const alternativesOf = (exclude: Cluster | null): DraftField['alternatives'] => [
      ...clusters.filter((cl) => cl !== exclude).map((cl) => ({ value: cl.value, display: cl.display, sources: [...cl.members].sort(better).map((m) => m.source) })),
      ...invalid.map((c) => ({ value: c.value, display: c.display, sources: [c.source] })),
    ];

    let field: DraftField;
    const base = { key, label: meta.label, section: meta.section, sensitive: SENSITIVE_BUNDLE_KEYS.has(key), required: meta.required, keyField: KEY_FIELDS.includes(key), conflictId: conflict?.id ?? null };
    if (ownerSet) {
      field = {
        ...base,
        value: ownerSet.value,
        display: ownerSet.display,
        confidence: 1,
        status: 'owner_set',
        validator: { ok: true, message: null },
        source: ownerSource(ownerSet.at),
        alternatives: alternativesOf(null).filter((a) => !compatible(key, { value: a.value }, { value: ownerSet.value }).same || a.value !== ownerSet.value),
        note: ownerSet.note,
      };
    } else if (!clusters.length) {
      field = {
        ...base,
        value: null,
        display: null,
        confidence: 0,
        status: invalid.length ? 'invalid' : 'missing',
        validator: invalid.length ? { ok: false, message: invalid[0]!.validatorMessage ?? 'failed its check' } : { ok: true, message: null },
        source: invalid.length ? [...invalid].sort(better)[0]!.source : null,
        alternatives: alternativesOf(null),
        note: null,
      };
    } else {
      let pick = clusters[0]!;
      if (conflict?.status === 'resolved' && conflict.chosenValue !== null) pick = clusters.find((cl) => cl.value === conflict!.chosenValue) ?? pick;
      const confidence = Math.round(pick.maxConfidence * 100) / 100;
      const status: DraftField['status'] = conflict?.status === 'open' ? 'conflict' : confidence < input.lowConfidence && conflict?.status !== 'resolved' ? 'low_confidence' : 'ok';
      field = {
        ...base,
        value: pick.value,
        display: pick.display,
        confidence,
        status,
        validator: { ok: true, message: null },
        source: pick.bestOfValue.source,
        alternatives: alternativesOf(pick),
        note: null,
      };
      if (key === 'accident.circumstances') {
        const by = pick.bestOfValue.authoredBy ?? (pick.bestOfValue.source.docType === 'fnol_form' || pick.bestOfValue.source.docType === 'signed_ccguk_form' ? 'client' : pick.bestOfValue.source.docType === 'police_report' ? 'police' : pick.bestOfValue.source.docType === 'insurer_letter' ? 'insurer' : pick.bestOfValue.source.docType === 'witness_statement' ? 'witness' : 'other');
        circumstances = { attribution: by, fromFileId: pick.bestOfValue.source.fileId || null };
        field.note =
          by === 'client'
            ? `Client’s own words — ${authoredLabel(pick.bestOfValue.source)}${pick.bestOfValue.source.page ? `, page ${pick.bestOfValue.source.page}` : ''}`
            : `From the ${authoredLabel(pick.bestOfValue.source)} — not the client’s own account: please confirm`;
      }
    }
    if (key === 'accident.circumstances' && ownerSet) circumstances = { attribution: 'owner', fromFileId: null };
    fields.push(field);
  }

  // Witnesses
  let witnesses: WitnessDraft[] = [];
  let witnessesAnswered = false;
  const ownerW = [...input.decisions].reverse().find((d) => d.kind === 'set_field' && d.subject === 'witnesses');
  if (ownerW) {
    const a = (ownerW.after ?? {}) as { witnesses?: WitnessDraft[]; answered?: boolean };
    witnesses = (a.witnesses ?? []).map((w) => ({ name: w.name, phone: w.phone ?? null, relationship: w.relationship ?? null, source: ownerSource(ownerW.at) }));
    witnessesAnswered = a.answered ?? true;
  } else {
    const byName = new Map<string, WitnessDraft>();
    for (const r of input.witnessReadings ?? []) {
      if (r.clientAuthored) witnessesAnswered = true;
      if (r.witnesses === 'none') continue;
      for (const w of r.witnesses) {
        const k = normaliseQuoteText(w.name).toLowerCase();
        const prev = byName.get(k);
        if (!prev) byName.set(k, { ...w, source: w.source ?? r.source });
        else byName.set(k, { ...prev, phone: prev.phone ?? w.phone, relationship: prev.relationship ?? w.relationship });
      }
    }
    witnesses = [...byName.values()];
  }
  return { fields, conflicts, witnesses, witnessesAnswered, circumstances };
}

/** The open conflicts and their preselected values (what "accept all preselected" records). */
export function preselectedChoices(conflicts: Conflict[]): Array<{ id: string; value: string }> {
  return conflicts.filter((c) => c.status === 'open').map((c) => ({ id: c.id, value: c.options.find((o) => o.preselected)!.value }));
}

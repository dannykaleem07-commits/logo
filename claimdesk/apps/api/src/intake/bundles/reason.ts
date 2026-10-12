// owned by intake-server
/**
 * The AI reading of a whole bundle (docs/SMART-INTAKE.md §6.2, §7.1): every document of the main group read together
 * to reconcile one claim. The model decides nothing — code checks every value:
 *
 *  - every file it cites must be in the bundle (by id or `fileRef` "<position>:<filename>"), else the item is dropped;
 *  - every quote must be found in that file's text (`findQuote`), else the confidence is capped at 0.5 and the source
 *    marked unverified;
 *  - values pass the same validators as the per-file readings; timeline event types must be known;
 *  - the case summary is used only if every registration, date, figure and reference in it is in the draft;
 *  - file advice only suggests (a file leaves `unsure` only when no strong key contradicts);
 *  - `injectionSuspected` becomes the owner-only signal INSTRUCTIONS_IN_DOCUMENT.
 * AI field choices become candidates (engine `ai_reasoning`, the cited file's rank); they never override the owner and
 * never resolve a conflict. No tools, no read access; never sees other claims, signals or settings.
 */
import { BUNDLE_FIELD_KEYS, TIMELINE_EVENT_CLASS, TIMELINE_EVENT_TYPES, findQuote, isBundleFieldKey, type AiTimelineItem, type Candidate, type FieldSource, type IntakeBundleReasoning, type WitnessDraft, type WitnessReading } from '@ccguk/domain';
import type { IntakeBundleRecord } from '@ccguk/db';
import type { AgentInput, AgentSpec } from '../../agent/contracts.js';
import { docTypeLabel } from '../proposals.js';
import { normaliseForKey, sourceOf, type FileContext } from './candidates.js';

export const INTAKE_BUNDLE_SPEC: AgentSpec = {
  name: 'intake',
  jobType: 'intake.bundle_reason',
  title: 'Intake: read the case bundle together',
  promptFiles: ['intake-bundle.md'],
  tools: [],
  allowRead: false,
  resultSchemaId: 'intake_bundle_reasoning',
  defaults: { model: 'claude-opus-5-5', effort: 'medium', maxTurns: 1, timeoutMs: 8 * 60_000 },
};

/** Characters of text per file and in total given to the model. */
export const REASON_FILE_CHARS = 20_000;
export const REASON_TOTAL_CHARS = 150_000;

/** "<position>:<filename>" — how the brief names a file (fixtures cite this; ids are generated at run time). */
export const fileRefOf = (fc: FileContext): string => `${fc.file.position}:${fc.evidence.filename}`;

const PRIORITY: Record<string, number> = { fnol_form: 0, signed_ccguk_form: 0, police_report: 1, insurer_letter: 2, engineer_report: 3, correspondence: 4 };

export interface ReasoningBriefInput {
  bundle: IntakeBundleRecord;
  files: Array<{ fc: FileContext; groupKey: string }>;
  groups: Array<{ key: string; label: string; reasons: string[]; fileIds: string[] }>;
  draft: Array<{ key: string; value: string | null; status: string }>;
  conflicts: Array<{ key: string; options: string[] }>;
  today: string;
}

/** The AgentInput for `intake.bundle_reason`. */
export function bundleReasoningInput(i: ReasoningBriefInput): AgentInput {
  const main = i.files.filter((f) => f.groupKey === 'main');
  const untrusted: NonNullable<AgentInput['untrusted']> = [];
  let total = 0;
  for (const f of [...main].filter((x) => !x.fc.isPhoto && x.fc.text.trim()).sort((a, b) => (PRIORITY[a.fc.docType ?? ''] ?? 9) - (PRIORITY[b.fc.docType ?? ''] ?? 9) || a.fc.file.position - b.fc.file.position)) {
    if (total >= REASON_TOTAL_CHARS) break;
    const text = f.fc.text.slice(0, Math.min(REASON_FILE_CHARS, REASON_TOTAL_CHARS - total));
    total += text.length;
    untrusted.push({ kind: 'document', id: fileRefOf(f.fc), text });
  }
  return {
    task: `Read these documents together and reconcile one claim [intake-bundle] — ${i.bundle.name}`,
    brief: {
      bundleId: i.bundle.id,
      name: i.bundle.name,
      files: i.files.map((f) => ({
        fileId: f.fc.file.id,
        fileRef: fileRefOf(f.fc),
        filename: f.fc.evidence.filename,
        docType: f.fc.docType,
        docTypeLabel: f.fc.docType ? docTypeLabel(f.fc.docType) : null,
        documentDate: f.fc.documentDate,
        summary: f.fc.best?.summary ?? null,
        fields: f.fc.fields.filter((x) => x.value).slice(0, 60).map((x) => ({ name: x.name, target: x.target, value: x.value, page: x.page, confidence: x.confidence })),
        photo: f.fc.photo ? { scene: f.fc.photo.scene, plates: f.fc.photo.plates.map((p) => p.text), zones: f.fc.photo.damageZones.map((z) => z.zoneId) } : null,
        groupKey: f.groupKey,
      })),
      groups: i.groups,
      deterministicDraft: { fields: i.draft.filter((d) => d.value !== null), openConflicts: i.conflicts },
      allowedKeys: BUNDLE_FIELD_KEYS,
      timelineEventTypes: TIMELINE_EVENT_TYPES,
      today: i.today,
    },
    untrusted,
    question: [
      'Read every document together. Return the IntakeBundleReasoning JSON only.',
      'Cite fileId (or the fileRef shown in the brief), page and the exact quote for every value; never invent a value.',
      'Prefer the source a person would trust (the V5C for the VIN, the licence for the date of birth, the police report for the accident time).',
      'The client’s account must be quoted from a document the client wrote; otherwise set circumstances.authoredBy to who wrote it.',
      'Never comment on honesty or credibility; say only what the documents say. Never decide liability, money or offers.',
    ].join('\n'),
  };
}

export interface ReasoningChecks {
  droppedFileRefs: number;
  cappedQuotes: number;
  droppedValues: number;
  droppedTimeline: number;
  unverifiedQuotes: Array<{ key: string; fileId: string | null }>;
}

/** The checked contributions of a stored reasoning to the current bundle. */
export interface ReasoningContribution {
  candidates: Candidate[];
  witnessReadings: WitnessReading[];
  witnessesAnswered: boolean;
  timeline: AiTimelineItem[];
  liability: Array<{ text: string; party: string; source: FieldSource }>;
  advice: Record<string, { groupKey: string; why: string }>;
  injection: boolean;
  summary: string | null;
  hireWhy: string | null;
  checks: ReasoningChecks;
}

/** Resolve a cited file (id or fileRef). */
export function resolveFile(files: FileContext[], ref: string | null | undefined): FileContext | undefined {
  if (!ref) return undefined;
  const exact = files.find((f) => f.file.id === ref) ?? files.find((f) => fileRefOf(f) === ref);
  if (exact) return exact;
  // "<position>:<filename>" with a stale position, or a bare filename: accept it when the filename is unique
  const name = /^[^:]*:(.+)$/.exec(ref)?.[1] ?? ref;
  const byName = files.filter((f) => f.evidence.filename === name);
  return byName.length === 1 ? byName[0] : undefined;
}

/**
 * Check a reasoning result against the bundle's files (`files` = the main group's readable files). Deterministic: the
 * same stored result gives the same contribution on every recompute.
 */
export function validateReasoning(result: IntakeBundleReasoning, files: FileContext[], now: string): ReasoningContribution {
  const checks: ReasoningChecks = { droppedFileRefs: 0, cappedQuotes: 0, droppedValues: 0, droppedTimeline: 0, unverifiedQuotes: [] };
  const out: ReasoningContribution = { candidates: [], witnessReadings: [], witnessesAnswered: Boolean(result.witnessesAnswered), timeline: [], liability: [], advice: {}, injection: Boolean(result.injectionSuspected), summary: typeof result.caseSummary === 'string' && result.caseSummary.trim() ? result.caseSummary.trim() : null, hireWhy: null, checks };
  const verify = (fc: FileContext, quote: string | null | undefined): boolean => Boolean(quote && quote.trim() && fc.text && findQuote(fc.text, quote) !== 'not_found');

  for (const c of result.fieldChoices ?? []) {
    if (!isBundleFieldKey(c.key) || c.value === null || !String(c.value).trim()) continue;
    const fc = resolveFile(files, c.fileId);
    if (!fc) {
      checks.droppedFileRefs += 1;
      continue;
    }
    const n = normaliseForKey(c.key, String(c.value), now);
    if (!n.ok) {
      checks.droppedValues += 1;
      continue;
    }
    const verified = verify(fc, c.quote);
    let confidence = Math.max(0, Math.min(1, Number(c.confidence) || 0));
    if (!verified) {
      checks.cappedQuotes += 1;
      checks.unverifiedQuotes.push({ key: c.key, fileId: fc.file.id });
      confidence = Math.min(confidence, 0.5);
    }
    out.candidates.push({ key: c.key, value: n.value, display: n.display, source: sourceOf(fc, { page: c.page ?? null, quote: c.quote ?? null, confidence, engine: 'ai_reasoning', key: c.key, quoteVerified: verified }), validatorOk: true, validatorMessage: null, aiWhy: c.why?.slice(0, 500) ?? null });
  }

  const circ = result.circumstances;
  if (circ?.text && circ.text.trim()) {
    const fc = resolveFile(files, circ.fileId);
    if (fc) {
      const verified = verify(fc, circ.text);
      if (!verified) checks.cappedQuotes += 1;
      const n = normaliseForKey('accident.circumstances', circ.text, now);
      if (n.ok) out.candidates.push({ key: 'accident.circumstances', value: n.value, display: n.display, source: sourceOf(fc, { page: circ.page ?? null, quote: circ.text.slice(0, 400), confidence: verified ? 0.85 : 0.5, engine: 'ai_reasoning', key: 'accident.circumstances', quoteVerified: verified }), validatorOk: true, validatorMessage: null, authoredBy: circ.authoredBy ?? 'other', aiWhy: null });
    } else checks.droppedFileRefs += 1;
  }

  const hire = result.hireNeed;
  if (hire && (hire.needed === 'yes' || hire.needed === 'no')) {
    const fc = resolveFile(files, hire.fileId);
    if (fc) {
      const verified = verify(fc, hire.quote);
      if (!verified) checks.cappedQuotes += 1;
      out.candidates.push({ key: 'hire.needed', value: hire.needed, display: hire.needed === 'yes' ? 'Yes' : 'No', source: sourceOf(fc, { page: hire.page ?? null, quote: hire.quote ?? null, confidence: verified ? 0.8 : 0.5, engine: 'ai_reasoning', key: 'hire.needed', quoteVerified: verified }), validatorOk: true, validatorMessage: null, aiWhy: hire.why?.slice(0, 500) ?? null });
      out.hireWhy = hire.why ?? null;
    }
  }

  const byFile = new Map<string, WitnessDraft[]>();
  for (const w of result.witnesses ?? []) {
    const fc = resolveFile(files, w.fileId);
    if (!fc || !w.name?.trim()) {
      checks.droppedFileRefs += fc ? 0 : 1;
      continue;
    }
    const source = sourceOf(fc, { page: w.page ?? null, quote: w.quote ?? null, confidence: verify(fc, w.quote) ? 0.8 : 0.5, engine: 'ai_reasoning', key: 'accident.circumstances' });
    byFile.set(fc.file.id, [...(byFile.get(fc.file.id) ?? []), { name: w.name.trim(), phone: w.phone ?? null, relationship: w.relationship ?? null, source }]);
  }
  for (const [fileId, ws] of byFile) {
    const fc = files.find((f) => f.file.id === fileId)!;
    out.witnessReadings.push({ witnesses: ws, source: ws[0]!.source!, clientAuthored: fc.docType === 'fnol_form' || fc.docType === 'signed_ccguk_form' });
  }

  for (const l of result.liabilityStatements ?? []) {
    const fc = resolveFile(files, l.fileId);
    if (!fc || !verify(fc, l.quote)) {
      checks.cappedQuotes += fc ? 1 : 0;
      checks.droppedFileRefs += fc ? 0 : 1;
      continue; // only verified quotes are shown as statements
    }
    out.liability.push({ text: l.text.slice(0, 400), party: l.party, source: sourceOf(fc, { page: l.page ?? null, quote: l.quote, confidence: 0.9, engine: 'ai_reasoning', key: 'accident.circumstances', quoteVerified: true }) });
  }

  for (const t of result.timeline ?? []) {
    const fc = resolveFile(files, t.fileId);
    if (!fc || !(t.eventType in TIMELINE_EVENT_CLASS) || !/^\d{4}-\d{2}-\d{2}/.test(t.at ?? '')) {
      checks.droppedTimeline += 1;
      continue;
    }
    const verified = verify(fc, t.quote);
    out.timeline.push({ at: t.at, eventType: t.eventType, summary: t.summary.slice(0, 300), fileId: fc.file.id, page: t.page ?? null, quote: t.quote ?? null, confidence: verified ? Math.max(0, Math.min(1, t.confidence)) : Math.min(0.5, t.confidence), source: sourceOf(fc, { page: t.page ?? null, quote: t.quote ?? null, confidence: t.confidence, engine: 'ai_reasoning', key: 'accident.occurredAt', quoteVerified: verified }) });
  }

  for (const a of result.fileAdvice ?? []) {
    const fc = resolveFile(files, a.fileId);
    if (!fc) continue;
    if (a.group === 'main') out.advice[fc.file.id] = { groupKey: 'main', why: a.why };
  }
  return out;
}

/** The fileset the reasoning reads: the main group's files and the engine of each one's reading. */
export function filesetOf(files: Array<{ fc: FileContext; groupKey: string }>): string {
  return files
    .filter((f) => f.groupKey === 'main')
    .map((f) => `${f.fc.file.id}:${f.fc.engine ?? 'none'}`)
    .sort()
    .join('|');
}

// owned by intake-server
/**
 * Readings → candidates (docs/SMART-INTAKE.md §6.4). For each bundle file: its best extraction (AI, else rules) gives
 * one candidate per field, mapped to a bundle key by its target or its rule name and validated + normalised exactly
 * like a proposal (`targetDef(target).validate`), so comparisons are on normalised values. Photos add their EXIF date
 * (engine `exif`, date only) and plates that match nothing yet (engine `plate`); the bundle name adds the client's
 * name (engine `name_hint`, 0.3); a verified AI reasoning adds `ai_reasoning` choices with the cited file's rank.
 */
import {
  BUNDLE_FIELD_META,
  BUNDLE_KEY_TARGET,
  DOC_TYPE_PLAIN,
  RULE_FIELD_NAMES,
  bundleKeyForTarget,
  displayPlate,
  isBundleFieldKey,
  londonDayOf,
  normVrm,
  sourceRank,
  type Attribution,
  type BundleFieldKey,
  type Candidate,
  type CandidateEngine,
  type DocType,
  type ExtractedField,
  type FieldSource,
  type KeyKind,
  type KeyRole,
  type PhotoScene,
  type WitnessDraft,
  type WitnessReading,
} from '@ccguk/domain';
import type { IntakeBundleFileRecord, IntakeExtractionRecord, IntakeItemRecord } from '@ccguk/db';
import type { Evidence } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { NormalisedDoc } from '../normalise.js';
import { docTypeLabel } from '../proposals.js';
import type { ExtractionExtras } from '../rules.js';
import { targetDef } from '../targets.js';
import { displayVrm, formatAddress, parseUkAddress, validateDateTime, validateEmail, validateIsoDate, validateName, validatePostcode, validateUkPhone } from '../validators.js';

/** Everything known about one bundle file (loaded once per recompute). */
export interface FileContext {
  file: IntakeBundleFileRecord;
  item: IntakeItemRecord;
  evidence: Evidence;
  doc: NormalisedDoc | undefined;
  best: IntakeExtractionRecord | undefined;
  rules: IntakeExtractionRecord | undefined;
  engine: 'ai' | 'rules' | null;
  extras: ExtractionExtras | null;
  docType: DocType | null;
  docTypeConfidence: number | null;
  documentDate: string | null;
  docSide: 'front' | 'back' | null;
  photo: ExtractionExtras['photo'];
  fields: ExtractedField[];
  isPhoto: boolean;
  text: string;
  label: string;
}

const extrasOf = (e: IntakeExtractionRecord | undefined): ExtractionExtras | null => (e?.extras && typeof e.extras === 'object' ? (e.extras as ExtractionExtras) : null);

export function loadFileContext(ctx: AppContext, file: IntakeBundleFileRecord): FileContext | undefined {
  const item = ctx.repos.getIntakeItem(ctx.db, file.intakeItemId);
  const evidence = ctx.repos.getEvidence(ctx.db, file.evidenceId);
  if (!item || !evidence) return undefined;
  const doc = item.normalised as NormalisedDoc | undefined;
  const all = ctx.repos.listIntakeExtractions(ctx.db, item.id);
  const engineOf = (e: IntakeExtractionRecord) => ctx.repos.extractionEngine(e);
  const ai = [...all].reverse().find((e) => engineOf(e) === 'ai');
  const rules = [...all].reverse().find((e) => engineOf(e) === 'rules');
  const best = ai ?? rules;
  const bx = extrasOf(best);
  const rx = extrasOf(rules);
  const docType = (item.docType ?? bx?.docType ?? null) as DocType | null;
  const isPhoto = doc?.kind === 'image' || evidence.mime.startsWith('image/');
  return {
    file,
    item,
    evidence,
    doc,
    best,
    rules,
    engine: best ? engineOf(best) : null,
    extras: bx,
    docType,
    docTypeConfidence: item.docTypeConfidence ?? bx?.docTypeConfidence ?? null,
    documentDate: bx?.documentDate ?? rx?.documentDate ?? null,
    docSide: bx?.docSide ?? rx?.docSide ?? null,
    photo: bx?.photo ?? null,
    fields: (Array.isArray(best?.fields) ? best!.fields : []) as ExtractedField[],
    isPhoto,
    text: (doc?.pageTexts ?? []).join('\n\n'),
    label: docType && docType !== 'other' ? DOC_TYPE_PLAIN[docType].replace(/^./, (c) => c.toUpperCase()) : evidence.filename,
  };
}

export function sourceOf(fc: FileContext, opts: { page: number | null; quote: string | null; confidence: number; engine: CandidateEngine; key: BundleFieldKey; quoteVerified?: boolean | null }): FieldSource {
  const label = `${fc.docType ? docTypeLabel(fc.docType) : fc.evidence.filename}${opts.page ? `, page ${opts.page}` : ''}`;
  return {
    fileId: fc.file.id,
    itemId: fc.item.id,
    evidenceId: fc.evidence.id,
    filename: fc.evidence.filename,
    docType: fc.docType,
    docTypeLabel: fc.docType ? docTypeLabel(fc.docType) : null,
    page: opts.page,
    quote: opts.quote,
    confidence: Math.round(Math.max(0, Math.min(1, opts.confidence)) * 100) / 100,
    engine: opts.engine,
    rank: sourceRank(opts.key, fc.docType, opts.engine),
    label,
    quoteVerified: opts.quoteVerified ?? null,
  };
}

const yesNo = (v: string): string | null => {
  const t = v.trim().toLowerCase();
  if (/^(yes|y|true|ticked)\b/.test(t)) return 'yes';
  if (/^(no|n|false|none|not)\b/.test(t)) return 'no';
  return null;
};

/** Validate + normalise a raw value for a bundle key. */
export function normaliseForKey(key: BundleFieldKey, raw: string, now: string, holder?: { name?: string; dateOfBirth?: string }): { ok: boolean; value: string; display: string; message: string | null } {
  const text = raw.replace(/\s+/g, ' ').trim();
  const meta = BUNDLE_FIELD_META[key];
  // accident date without a time stays a date (compared by day; the owner adds the time)
  if (key === 'accident.occurredAt' && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const r = validateIsoDate(text, { notAfter: now });
    return { ok: r.ok, value: r.value ?? text, display: r.value ?? text, message: r.ok ? null : r.errors.join('; ') };
  }
  const target = BUNDLE_KEY_TARGET[key];
  const def = target ? targetDef(target) : undefined;
  if (def) {
    const r = def.validate(text, { now, ...(holder ? { holder } : {}) });
    const value = (r.value ?? text).slice(0, 4000);
    let display = value;
    if (meta.kind === 'vrm') display = displayVrm(value);
    if (meta.kind === 'datetime' && r.ok) display = londonDisplay(value);
    return { ok: r.ok, value, display, message: r.ok ? (r.notes?.join('; ') || null) : r.errors.join('; ') };
  }
  switch (meta.kind) {
    case 'bool':
    case 'yes_no': {
      const v = yesNo(text);
      return v ? { ok: true, value: v, display: v === 'yes' ? 'Yes' : 'No', message: null } : { ok: false, value: text, display: text, message: `"${text.slice(0, 20)}" is not yes or no` };
    }
    case 'phone': {
      const r = validateUkPhone(text);
      return { ok: r.ok, value: r.value ?? text, display: r.value ?? text, message: r.ok ? null : r.errors.join('; ') };
    }
    case 'postcode': {
      const r = validatePostcode(text);
      return { ok: r.ok, value: r.value ?? text, display: r.value ?? text, message: r.ok ? null : r.errors.join('; ') };
    }
    case 'name': {
      const r = validateName(text);
      return { ok: r.ok, value: r.value ?? text, display: r.value ?? text, message: r.ok ? null : r.errors.join('; ') };
    }
    case 'email': {
      const r = validateEmail(text);
      return { ok: r.ok, value: r.value ?? text, display: r.value ?? text, message: r.ok ? null : r.errors.join('; ') };
    }
    case 'address': {
      const r = parseUkAddress(text);
      const v = r.ok ? formatAddress(r.value)! : text;
      return { ok: r.ok, value: v, display: v, message: r.ok ? null : r.errors.join('; ') };
    }
    case 'datetime': {
      const r = validateDateTime(text, { notAfter: now });
      return { ok: r.ok, value: r.value ?? text, display: r.ok ? londonDisplay(r.value!) : text, message: r.ok ? null : r.errors.join('; ') };
    }
    default: {
      const ok = text.length > 0 && text.length <= (meta.kind === 'ref' ? 60 : 4000);
      return { ok, value: text.slice(0, 4000), display: text.slice(0, 4000), message: ok ? null : 'too long or empty' };
    }
  }
}

export function londonDisplay(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const day = d.toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

const AUTHORED: Partial<Record<DocType, Attribution>> = { fnol_form: 'client', signed_ccguk_form: 'client', police_report: 'police', insurer_letter: 'insurer', witness_statement: 'witness' };

/** Parse a witnesses reading ("none" or "Name, phone, relationship; Name …"). */
export function parseWitnesses(raw: string, source: FieldSource): WitnessDraft[] | 'none' {
  if (/^(none|no|nil|n\/a|no witnesses)$/i.test(raw.trim())) return 'none';
  return raw
    .split(/;|\n/)
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => {
      const parts = w.split(',').map((p) => p.trim());
      const name = parts[0] ?? w;
      const phone = parts.find((p) => /\d{6,}/.test(p.replace(/\s/g, ''))) ?? null;
      const relationship = parts.slice(1).find((p) => p !== phone) ?? null;
      return { name, phone, relationship, source };
    })
    .filter((w) => /\p{L}/u.test(w.name));
}

export interface FileReadings {
  candidates: Candidate[];
  witnessReadings: WitnessReading[];
  /** Target-less identifiers for grouping keys (CCG references, unassigned registrations, letterhead phones …). */
  otherKeys: Array<{ kind: KeyKind; value: string; role?: KeyRole; display?: string }>;
  /** Facts for checks, the timeline and signals. */
  facts: { keeperSince?: string; validFrom?: string; validTo?: string; licenceValidTo?: string; motExpiry?: string; inspectionDate?: string; offerFound?: boolean; liability: Array<{ text: string; page: number | null; quote: string | null }>; sortCode?: string; accountNumber?: string };
}

/** Candidates and facts of one file from its best reading. */
export function readingsOf(fc: FileContext, now: string): FileReadings {
  const out: FileReadings = { candidates: [], witnessReadings: [], otherKeys: [], facts: { liability: [] } };
  const engine: CandidateEngine = fc.engine === 'ai' ? 'ai' : 'rules';
  // holder hints for licence cross-checks (the same person's name / DOB in this document)
  const holderName = fc.fields.find((f) => f.target === 'party:client.name' && f.value)?.value ?? undefined;
  // (the date of birth is not used to check a licence number here: a different date of birth on another line of the
  // same document is a conflict to show the owner, not a reason to drop the licence reading)
  for (const f of fc.fields) {
    if (f.value === null || f.value === undefined || !String(f.value).trim()) continue;
    const raw = String(f.value);
    const named = RULE_FIELD_NAMES[f.name];
    const confidence = Number.isFinite(f.confidence) ? f.confidence : 0;
    if (!f.target) {
      switch (f.name) {
        case 'ClaimDesk reference':
          out.otherKeys.push({ kind: 'ccg_ref', value: raw, display: raw.toUpperCase() });
          continue;
        case 'Registration (unassigned)':
          out.otherKeys.push({ kind: 'vrm', value: raw, display: displayPlate(raw) });
          continue;
        case 'VIN (unassigned)':
          out.otherKeys.push({ kind: 'vin', value: raw, display: raw });
          continue;
        case 'Licence number (unassigned)':
          out.otherKeys.push({ kind: 'licence', value: raw, display: raw });
          continue;
        case 'Phone (unassigned)':
          out.otherKeys.push({ kind: 'phone', value: raw, display: raw });
          continue;
        case 'Email (unassigned)':
          out.otherKeys.push({ kind: 'email', value: raw, display: raw });
          continue;
        case 'Keeper since':
          out.facts.keeperSince = raw;
          continue;
        case 'Valid from':
          out.facts.validFrom = raw;
          continue;
        case 'Valid until':
          out.facts.validTo = raw;
          continue;
        case 'Licence valid until':
          out.facts.licenceValidTo = raw;
          continue;
        case 'MOT expiry':
          out.facts.motExpiry = raw;
          continue;
        case 'Inspection date':
          out.facts.inspectionDate = raw;
          continue;
        case 'Offer made':
          out.facts.offerFound = true;
          continue;
        case 'Liability statement':
          out.facts.liability.push({ text: raw, page: f.page ?? null, quote: f.quote ?? null });
          continue;
        case 'Sort code':
          out.facts.sortCode = raw;
          continue;
        case 'Account number':
          out.facts.accountNumber = raw;
          continue;
        default:
          break;
      }
      if (named === 'witnesses') {
        const source = sourceOf(fc, { page: f.page ?? null, quote: f.quote ?? null, confidence, engine, key: 'accident.circumstances' });
        out.witnessReadings.push({ witnesses: parseWitnesses(raw, source), source, clientAuthored: fc.docType === 'fnol_form' || fc.docType === 'signed_ccguk_form' });
        continue;
      }
    }
    const key = f.target ? bundleKeyForTarget(f.target) : named && named !== 'witnesses' && isBundleFieldKey(named) ? named : null;
    if (!key) continue;
    const n = normaliseForKey(key, raw, now, key.endsWith('drivingLicenceNumber') && holderName ? { name: holderName } : undefined);
    const source = sourceOf(fc, { page: f.page ?? null, quote: f.quote ?? null, confidence, engine, key });
    out.candidates.push({ key, value: n.value, display: n.display, source, validatorOk: n.ok, validatorMessage: n.message, ...(key === 'accident.circumstances' ? { authoredBy: fc.docType ? (AUTHORED[fc.docType] ?? 'other') : 'other' } : {}) });
  }
  // photo plates for grouping keys are returned by `platesOf`; EXIF / plate candidates by `photoCandidates`
  return out;
}

/** The plates read in a photo (AI), as printed. */
export function platesOf(fc: FileContext): Array<{ text: string; confidence: number }> {
  return (fc.photo?.plates ?? []).filter((p) => p.text && normVrm(p.text).length >= 2);
}

/** The photo's scene (AI), or null when not read by the AI. */
export function sceneOf(fc: FileContext): PhotoScene | null {
  return (fc.photo?.scene as PhotoScene | undefined) ?? null;
}

/** EXIF date (damage photos) and plate candidates for a photo. */
export function photoCandidates(fc: FileContext, known: { client: string | null; tp: string | null }, now: string): Candidate[] {
  const out: Candidate[] = [];
  if (!fc.isPhoto) return out;
  const scene = sceneOf(fc);
  const taken = fc.evidence.exif?.dateTimeOriginal ?? fc.evidence.capturedAt;
  if (taken && (scene === null || scene === 'damage' || scene === 'vehicle_whole' || scene === 'scene')) {
    const day = londonDayOf(taken);
    if (day) out.push({ key: 'accident.occurredAt', value: day, display: day, source: sourceOf(fc, { page: null, quote: null, confidence: 0.3, engine: 'exif', key: 'accident.occurredAt' }), validatorOk: true, validatorMessage: null });
  }
  const client = known.client ? normVrm(known.client) : null;
  const tp = known.tp ? normVrm(known.tp) : null;
  for (const p of platesOf(fc)) {
    const n = normVrm(p.text);
    if (n === client || n === tp) continue;
    const key: BundleFieldKey | null = !client ? 'vehicle.registration' : !tp ? 'tp.registration' : null;
    if (!key) continue;
    const v = normaliseForKey(key, n, now);
    out.push({ key, value: v.value, display: v.display, source: sourceOf(fc, { page: null, quote: `Plate ${displayPlate(n)} in the photo`, confidence: p.confidence * 0.8, engine: 'plate', key }), validatorOk: v.ok, validatorMessage: v.message });
  }
  return out;
}

/** The client's name from the bundle name ("Jane Doe – Corsa crash" → Jane Doe), engine name_hint 0.3. */
export function nameHintCandidate(bundleName: string, now: string): Candidate | null {
  const head = bundleName.split(/\s[–—-]\s|\s[–—-]|[–—-]\s/)[0]?.trim() ?? '';
  if (!/^\p{L}[\p{L}'’.-]*(\s+\p{L}[\p{L}'’.-]*){1,3}$/u.test(head)) return null;
  const words = head.split(/\s+/);
  if (words.some((w) => /^(crash|accident|claim|car|van|the|new|case|bundle|docs?)$/i.test(w))) return null;
  const n = normaliseForKey('client.name', head, now);
  if (!n.ok) return null;
  const source: FieldSource = { fileId: '', itemId: '', evidenceId: '', filename: '', docType: null, docTypeLabel: null, page: null, quote: bundleName, confidence: 0.3, engine: 'name_hint', rank: sourceRank('client.name', null, 'name_hint'), label: 'Bundle name', quoteVerified: null };
  return { key: 'client.name', value: n.value, display: n.display, source, validatorOk: true, validatorMessage: null };
}

/**
 * Identifiers the deterministic reading found that the AI reading may have named differently (CCG references,
 * unassigned registrations, letterhead phones): kept for grouping when the AI reading is the best one.
 */
export function rulesOtherKeys(fc: FileContext, now: string): FileReadings['otherKeys'] {
  if (fc.engine !== 'ai' || !fc.rules || !Array.isArray(fc.rules.fields)) return [];
  return readingsOf({ ...fc, engine: 'rules', fields: fc.rules.fields as ExtractedField[] }, now).otherKeys;
}

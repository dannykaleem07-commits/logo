// owned by claimai-server
/**
 * The catch-up plan (docs/CLAIM-AI-INPUT.md §3.8): for each file of a catch-up bundle — file it? (already on file,
 * another claim, not sure), who sent it, its real date (never the upload date), what kind of letter, whether that
 * letter is already recorded — and the actions: file the evidence, record the correspondence with its back-dated
 * chronology event, add the extra events the documents show, ask about the rest. Pure.
 *
 * Action keys are stable across re-plans (`f<pos>`, `r<pos>`, `e<pos>-<n>` by bundle file position) so the apply log
 * keeps matching its lines when files are added later.
 */
import type { DocType } from '../agents/types.js';
import type { BundleFileRole } from '../intake/smart/types.js';
import { BANNED_INTAKE_WORDS } from '../intake/smart/types.js';
import { findDates } from '../intake/smart/text.js';
import type { EventType, ISODateTime } from '../types.js';
import { eventAtFor, fmtDay, fmtDayShort, londonDayIso, londonWallIso } from './dates.js';
import { directionOf, type DirectionInput, type DirectionResult, type Identity, type PartyHints } from './direction.js';
import { CONTACT_LABEL } from './instructions.js';
import { CORRESPONDENCE_KIND_LABEL, kindResultFor, recogniseCorrespondence, type CorrespondenceKind, type KindResult } from './outbound.js';
import { buildAction } from './parse.js';
import { COPY, eventLabel } from './copy.js';
import { ACCUSATION_WORDS, type ContactRole, type PlannedAction } from './types.js';

export interface CatchUpFileInput {
  fileId: string;
  itemId: string;
  evidenceId: string;
  filename: string;
  mime: string;
  role: BundleFileRole;
  isPhoto: boolean;
  docType: DocType | null;
  docTypeConfidence: number | null;
  groupKey: string;
  excluded: boolean;
  duplicateOf: string | null;
  sha256: string;
  textSha256: string | null;
  documentDate: string | null;
  emailDate: string | null;
  pdfCreatedAt: string | null;
  subject: string | null;
  head: string;
  tail: string;
  text: string;
  email: DirectionInput['email'];
  formTemplateId: string | null;
  signed: boolean | null;
  insurerRefNew: boolean;
  override: { direction?: 'out' | 'in' | 'none'; date?: string; kind?: CorrespondenceKind; notThisClaim?: boolean } | null;
  // --- additions (derived by the API) ---
  /** Stable bundle position (action keys). */
  position?: number;
  /** The claim-side evidence id once filed. */
  filedEvidenceId?: string | null;
  /** The other claim's reference for `claim:<id>` groups. */
  otherClaimRef?: string | null;
  /** Evidence kind the file is filed as. */
  evidenceKind?: string;
  /** Still being read (not settled): no record yet. */
  settled?: boolean;
}

export interface CatchUpClaimFacts {
  claimId: string;
  reference: string;
  accidentAt: string;
  openedAt: string;
  evidence: Array<{ id: string; sha256: string; textSha256: string | null; kind: string; filename: string }>;
  /** Live events (not made by this input). */
  events: Array<{ id: string; type: EventType; at: string; data?: Record<string, unknown>; evidenceIds?: string[] }>;
  outboxSent: Array<{ id: string; kind: string; sentAt: string }>;
  sentDocuments: Array<{ id: string; templateId: string; sentAt: string }>;
  /** Live records (not made by this input). */
  correspondence: Array<{ id: string; direction: 'out' | 'in'; kind: string; at: string; evidenceId: string | null }>;
  hasPaymentPack: boolean;
}

export interface CatchUpFilePlan {
  fileId: string;
  plan: 'file_and_record' | 'file_only' | 'already_on_file' | 'other_claim' | 'excluded' | 'ask';
  alreadyOnFile: { evidenceId: string; how: 'same_file' | 'same_text' } | null;
  evidenceKind: string;
  direction: DirectionResult;
  realDate: { at: string | null; source: 'document' | 'email_header' | 'owner' | 'file_metadata' | null; why: string };
  kind: KindResult | null;
  alreadyRecorded: { how: 'event' | 'outbox' | 'document' | 'correspondence'; at: string; ref: string } | null;
  /** "check the date" flag. */
  dateFlag: string | null;
}

export interface CatchUpPlan {
  files: CatchUpFilePlan[];
  actions: PlannedAction[];
  willDo: string[];
  blockers: Array<{ code: string; text: string; fileId?: string }>;
}

export interface CatchUpTimelineItem {
  id: string;
  at: string;
  precision: 'date' | 'datetime';
  eventType: string;
  summary: string;
  fileId: string | null;
  confidence: number;
  ticked: boolean;
}

/** Extra inbound events the documents show (not correspondence). */
const EXTRA_EVENT_TYPES = new Set(['estimate_received', 'inspection', 'recovery', 'storage_started', 'note', 'vehicle_collected', 'engineer_instructed']);

const DAY = 86_400_000;
const near = (a: string, b: string, days: number): boolean => Math.abs(Date.parse(a) - Date.parse(b)) <= days * DAY + 1;

/** "12 October 2026" / "12/10/2026" within the first 20 lines → YYYY-MM-DD. */
function headDate(head: string): string | null {
  const top = head.split(/\r?\n/).slice(0, 20).join('\n');
  return findDates(top)[0] ?? null;
}

function realDateOf(f: CatchUpFileInput): CatchUpFilePlan['realDate'] {
  if (f.override?.date) return { at: f.override.date, source: 'owner', why: 'set by you' };
  if (f.emailDate && !Number.isNaN(Date.parse(f.emailDate))) return { at: new Date(Date.parse(f.emailDate)).toISOString(), source: 'email_header', why: 'the email date' };
  if (f.documentDate) return { at: f.documentDate, source: 'document', why: 'from the letter' };
  const h = headDate(f.head);
  if (h) return { at: h, source: 'document', why: 'from the letter' };
  if (f.pdfCreatedAt && !Number.isNaN(Date.parse(f.pdfCreatedAt))) return { at: new Date(Date.parse(f.pdfCreatedAt)).toISOString(), source: 'file_metadata', why: 'when the PDF was made (no date in the text)' };
  return { at: null, source: null, why: 'no date found — set it' };
}

/** The instant a record / event is written for a real date (a calendar day → London noon, never after now). */
export function recordAt(at: string, now: ISODateTime): ISODateTime {
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) {
    const [y, m, d] = at.split('-').map(Number) as [number, number, number];
    return eventAtFor(londonWallIso({ y, m, d }), 'date', now);
  }
  return new Date(Date.parse(at)).toISOString();
}

function channelOf(f: CatchUpFileInput): 'email' | 'post' | 'unknown' {
  if (f.email || f.role === 'email' || /\.eml$/i.test(f.filename)) return 'email';
  if (f.docType === 'insurer_letter' || f.docType === 'correspondence' || /^application\/pdf$/.test(f.mime)) return 'post';
  return 'unknown';
}

function alreadyRecorded(f: CatchUpFileInput, dir: 'out' | 'in', kind: KindResult, at: string | null, claim: CatchUpClaimFacts, alreadyOn: CatchUpFilePlan['alreadyOnFile']): CatchUpFilePlan['alreadyRecorded'] {
  const evIds = new Set([f.filedEvidenceId, alreadyOn?.evidenceId].filter((x): x is string => Boolean(x)));
  const shaIds = new Set(claim.evidence.filter((e) => e.sha256 === f.sha256).map((e) => e.id));
  for (const id of shaIds) evIds.add(id);
  const corr = claim.correspondence.find((c) => c.evidenceId && evIds.has(c.evidenceId) && c.direction === dir);
  if (corr) return { how: 'correspondence', at: corr.at, ref: corr.id };
  if (!at) return null;
  const inst = recordAt(at, '9999-12-31T00:00:00.000Z');
  if (dir === 'out') {
    const ev = claim.events.find((e) => e.type === kind.eventType && e.type !== 'letter_out' && e.type !== 'email_out' && near(e.at, inst, 1));
    if (ev) return { how: 'event', at: ev.at, ref: ev.id };
    const ob = kind.emailKind ? claim.outboxSent.find((o) => o.kind === kind.emailKind && near(o.sentAt, inst, 2)) : undefined;
    if (ob) return { how: 'outbox', at: ob.sentAt, ref: ob.id };
    const doc = kind.templateId ? claim.sentDocuments.find((d) => d.templateId === kind.templateId && near(d.sentAt, inst, 2)) : undefined;
    if (doc) return { how: 'document', at: doc.sentAt, ref: doc.id };
    const same = claim.correspondence.find((c) => c.direction === 'out' && c.kind === kind.kind && londonDayIso(c.at) === londonDayIso(inst));
    if (same) return { how: 'correspondence', at: same.at, ref: same.id };
    return null;
  }
  const ev = claim.events.find((e) => (e.type === 'letter_in' || e.type === 'email_in') && near(e.at, inst, 1) && (e.evidenceIds ?? []).some((id) => evIds.has(id)));
  if (ev) return { how: 'event', at: ev.at, ref: ev.id };
  return null;
}

function counterpartyText(d: DirectionResult, dir: 'out' | 'in'): string {
  const who = d.counterparty.name ?? (d.counterparty.role ? CONTACT_LABEL[d.counterparty.role as ContactRole] : null);
  return who ? `${dir === 'out' ? 'sent to' : 'from'} ${who}` : dir === 'out' ? 'sent' : 'received';
}

function asConfirm(a: PlannedAction, why: string, tickable = true): PlannedAction {
  return { ...a, tier: 'confirm', ticked: false, tickable, why };
}

export function planCatchUp(
  files: CatchUpFileInput[],
  claim: CatchUpClaimFacts,
  id: Identity,
  parties: PartyHints,
  templateTitles: Array<{ templateId: string; title: string }>,
  opts: { now: ISODateTime; autoMinConfidence: number; timeline?: CatchUpTimelineItem[] },
): CatchUpPlan {
  const out: CatchUpFilePlan[] = [];
  const actions: PlannedAction[] = [];
  const blockers: CatchUpPlan['blockers'] = [];
  const posOf = (f: CatchUpFileInput, i: number) => f.position ?? i + 1;
  const accidentMs = Date.parse(claim.accidentAt);
  const nowMs = Date.parse(opts.now);
  const counts = { filed: 0, photos: 0, already: 0, out: [] as string[], in: [] as string[], events: 0, ask: 0 };

  files.forEach((f, i) => {
    const pos = posOf(f, i);
    const evidenceKind = f.evidenceKind ?? (f.isPhoto ? 'photo' : 'document');
    const base = { fileId: f.fileId, evidenceKind, alreadyOnFile: null, kind: null, alreadyRecorded: null, dateFlag: null } as const;
    const realDate = realDateOf(f);
    if (f.excluded || f.override?.notThisClaim) {
      out.push({ ...base, plan: 'excluded', direction: { direction: 'none', confidence: 1, why: 'Not filed', counterparty: { role: null, name: null } }, realDate });
      return;
    }
    if (f.groupKey.startsWith('claim:')) {
      out.push({ ...base, plan: 'other_claim', direction: { direction: 'none', confidence: 1, why: 'Belongs to another claim', counterparty: { role: null, name: null } }, realDate });
      blockers.push({ code: 'OTHER_CLAIM', text: `'${f.filename}' looks like ${f.otherClaimRef ?? 'another claim'} — open its AI input to file it there`, fileId: f.fileId });
      return;
    }
    if (f.role === 'archive') {
      out.push({ ...base, plan: 'file_only', direction: { direction: 'none', confidence: 1, why: 'A ZIP file: its contents are filed', counterparty: { role: null, name: null } }, realDate });
      return;
    }
    // Already on file?
    const sameFile = claim.evidence.find((e) => e.sha256 === f.sha256);
    const sameText = !sameFile && f.textSha256 ? claim.evidence.find((e) => e.textSha256 && e.textSha256 === f.textSha256) : undefined;
    const alreadyOnFile: CatchUpFilePlan['alreadyOnFile'] = f.filedEvidenceId && sameFile?.id === f.filedEvidenceId ? null : sameFile ? { evidenceId: sameFile.id, how: 'same_file' } : sameText ? { evidenceId: sameText.id, how: 'same_text' } : null;
    const isDup = Boolean(f.duplicateOf);
    const direction = directionOf(
      { docType: f.docType, role: f.role, isPhoto: f.isPhoto, email: f.email, head: f.head, tail: f.tail, formTemplateId: f.formTemplateId, signed: f.signed, override: f.override?.direction ?? null },
      id,
      parties,
    );
    let dateFlag: string | null = null;
    // Only a letter or email's date dates a record; a V5C, an MOT or a photo carries its own (older) dates by nature.
    if (realDate.at && direction.direction !== 'none') {
      const ms = Date.parse(recordAt(realDate.at, opts.now));
      if (ms > nowMs + 3_600_000) dateFlag = 'This date is in the future — check the date';
      else if (Number.isFinite(accidentMs) && ms < accidentMs - 30 * DAY) dateFlag = 'More than 30 days before the accident — check the date';
    }
    const unsure = f.groupKey === 'unsure';
    let plan: CatchUpFilePlan['plan'] = unsure ? 'ask' : direction.direction === 'none' ? 'file_only' : direction.direction === 'unknown' ? 'ask' : 'file_and_record';
    if (alreadyOnFile && plan !== 'ask') plan = 'already_on_file';
    let kind: KindResult | null = null;
    let recorded: CatchUpFilePlan['alreadyRecorded'] = null;
    if (direction.direction === 'out' || direction.direction === 'in') {
      kind = f.override?.kind
        ? kindResultFor(f.override.kind, direction.direction, channelOf(f) === 'email', claim.hasPaymentPack)
        : recogniseCorrespondence({ direction: direction.direction, docType: f.docType, text: f.text, subject: f.subject, isEmail: channelOf(f) === 'email', templateTitles, hasPaymentPack: claim.hasPaymentPack, insurerRefNew: f.insurerRefNew });
      recorded = alreadyRecorded(f, direction.direction, kind, realDate.at, claim, alreadyOnFile);
    }
    out.push({ fileId: f.fileId, plan, alreadyOnFile, evidenceKind, direction, realDate, kind, alreadyRecorded: recorded, dateFlag });

    // --- actions ---
    const fileLater = f.settled === false;
    if (!alreadyOnFile && !isDup && !fileLater) {
      const fa = buildAction({
        key: `f${pos}`,
        type: 'file_evidence',
        params: { bundleFileId: f.fileId, filename: f.filename, evidenceKind },
        quote: null,
        source: 'catch_up',
        from: 'document',
        confidence: 1,
      });
      actions.push(unsure ? asConfirm(fa, `It shares nothing with ${claim.reference} — tick to file it here anyway`) : fa);
      if (!unsure) {
        counts.filed += 1;
        if (f.isPhoto) counts.photos += 1;
      }
    } else if (alreadyOnFile || isDup) counts.already += 1;

    if (plan === 'ask' && !unsure) {
      counts.ask += 1;
      blockers.push({ code: 'WHO_SENT', text: `Who sent '${f.filename}'?`, fileId: f.fileId });
      actions.push(
        asConfirm(
          buildAction({ key: `r${pos}`, type: 'record_correspondence', params: { bundleFileId: f.fileId, filename: f.filename, summary: `Who sent '${f.filename}'?` }, quote: null, source: 'catch_up', from: 'document', confidence: 0.3, title: `Who sent '${f.filename}'? — Sent by us / Received / Just file it` }),
          direction.why,
          false,
        ),
      );
      return;
    }
    if (!kind || recorded || fileLater || (direction.direction !== 'out' && direction.direction !== 'in')) return;
    const dir = direction.direction;
    const at = realDate.at ? recordAt(realDate.at, opts.now) : null;
    const summary = `${kind.label} ${counterpartyText(direction, dir)}${at ? ` on ${fmtDay(at)}` : ''} — ${COPY.recordedLate(f.filename)}`;
    const params = {
      bundleFileId: f.fileId,
      direction: dir,
      kind: kind.kind,
      channel: channelOf(f),
      ...(at ? { at, precision: 'date' as const } : {}),
      dateSource: realDate.source ?? undefined,
      eventType: kind.eventType,
      alsoEventType: kind.alsoEvent ?? null,
      templateId: kind.templateId,
      emailKind: kind.emailKind,
      counterpartyRole: direction.counterparty.role,
      counterpartyName: direction.counterparty.name,
      summary,
      filename: f.filename,
      label: kind.label,
      evidenceId: f.filedEvidenceId ?? alreadyOnFile?.evidenceId ?? null,
      ...(f.subject ? { purpose: f.subject } : {}),
    };
    let ra = buildAction({ key: `r${pos}`, type: 'record_correspondence', params, quote: null, source: 'catch_up', from: 'document', confidence: Math.min(direction.confidence, kind.confidence), title: actionTitleFor(params.summary) });
    if (kind.cls === 'owner_only') {
      ra = dir === 'in'
        ? { ...ra, tier: 'open_screen', ticked: false, tickable: false, why: kind.kind === 'remittance' ? 'Money is yours to record — open the ledger' : 'Offers are yours to record and decide — open Offers', link: null }
        : asConfirm(ra, 'A legal step we sent — tick to record it');
    } else if (!at) ra = asConfirm(ra, 'No date found — set the date, then tick');
    else if (dateFlag) ra = asConfirm(ra, dateFlag);
    else if (f.override?.direction || f.override?.date || f.override?.kind) ra = asConfirm(ra, 'You set this — tick to record it');
    else if (direction.confidence < opts.autoMinConfidence || kind.confidence < opts.autoMinConfidence) ra = asConfirm(ra, `Not sure (${direction.why}) — tick to record it`);
    actions.push(ra);
    const line = `${kind.label}${at ? ` (${fmtDayShort(at)})` : ''}`;
    if (dir === 'out') counts.out.push(line);
    else counts.in.push(`${kind.kind === 'client_message' ? 'email' : 'letter'} from ${direction.counterparty.name ?? 'the sender'}${at ? ` (${fmtDayShort(at)})` : ''}`);
  });

  // Extra events the documents show (estimates, inspections, recovery, storage, police notes).
  const posById = new Map(files.map((f, i) => [f.fileId, posOf(f, i)]));
  const skipFiles = new Set(out.filter((p) => p.plan === 'other_claim' || p.plan === 'excluded' || p.plan === 'ask').map((p) => p.fileId));
  const perFile = new Map<string, number>();
  for (const t of opts.timeline ?? []) {
    if (!t.ticked || !EXTRA_EVENT_TYPES.has(t.eventType)) continue;
    if (t.fileId && skipFiles.has(t.fileId)) continue;
    if (BANNED_INTAKE_WORDS.test(t.summary) || ACCUSATION_WORDS.test(t.summary)) continue;
    const at = recordAt(t.at, opts.now);
    if (claim.events.some((e) => e.type === t.eventType && near(e.at, at, 1))) continue;
    if (Date.parse(at) > nowMs + 3_600_000) continue;
    const pos = t.fileId ? (posById.get(t.fileId) ?? 0) : 0;
    const n = (perFile.get(String(pos)) ?? 0) + 1;
    perFile.set(String(pos), n);
    const file = files.find((f) => f.fileId === t.fileId);
    const a = buildAction({
      key: `e${pos}-${n}`,
      type: 'event',
      params: { eventType: t.eventType, at, precision: t.precision, summary: `${t.summary} — ${COPY.recordedLate(file?.filename ?? 'the documents')}`, bundleFileId: t.fileId ?? undefined, filename: file?.filename },
      quote: null,
      source: 'catch_up',
      from: 'document',
      confidence: t.confidence,
      title: `Add to chronology: ${eventLabel(t.eventType)} — ${fmtDay(at)} (recorded late)`,
    });
    actions.push(t.confidence < opts.autoMinConfidence ? asConfirm(a, 'Not sure of this date — tick it if it is right') : a);
    counts.events += 1;
  }

  const willDo: string[] = [];
  if (counts.filed) {
    const docs = counts.filed - counts.photos;
    const parts = [docs ? `${docs} document${docs === 1 ? '' : 's'}` : null, counts.photos ? `${counts.photos} photo${counts.photos === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');
    willDo.push(`File ${parts} on ${claim.reference}${counts.already ? ` (${counts.already} already on file)` : ''}`);
  } else if (counts.already) willDo.push(`${counts.already} already on file — not filed twice`);
  if (counts.out.length) willDo.push(`Record ${counts.out.length} letter${counts.out.length === 1 ? '' : 's'} we sent outside ClaimDesk: ${counts.out.join(', ')}`);
  if (counts.in.length) willDo.push(`Record ${counts.in.length} received: ${counts.in.join(', ')}`);
  const backdated = actions.filter((a) => a.type === 'record_correspondence' && a.params.direction).length + counts.events;
  if (backdated) willDo.push(`Back-date ${backdated} chronology entr${backdated === 1 ? 'y' : 'ies'} (marked 'recorded late')`);
  if (counts.ask) willDo.push(`Ask you who sent ${counts.ask} file${counts.ask === 1 ? '' : 's'}`);
  if (actions.length) willDo.push('Ask the Autopilot and the case manager to re-plan');
  for (const p of out) if (p.dateFlag) blockers.push({ code: 'CHECK_DATE', text: `${files.find((f) => f.fileId === p.fileId)?.filename ?? 'A file'}: ${p.dateFlag}`, fileId: p.fileId });
  return { files: out, actions, willDo, blockers };
}

function actionTitleFor(summary: string): string {
  return `Record: ${summary}`;
}

export { CORRESPONDENCE_KIND_LABEL };

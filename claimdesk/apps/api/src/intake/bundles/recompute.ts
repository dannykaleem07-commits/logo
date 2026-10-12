// owned by intake-server
/**
 * The bundle pipeline (docs/SMART-INTAKE.md §6, §6.1): files + readings + owner decisions → `BundleComputed`.
 *
 *   duplicates → readings → keys → groups → reconcile (main group) → checklist → timeline → signals → liability →
 *   body + FNOL preview → registrable → willDo
 *
 * Everything is re-derived on every run (nothing is learned from the previous computed state), so the same files,
 * readings and decisions always give the same result. `recomputeBundle` stores it on the bundle (`computed`,
 * `computed_revision`, `auto_eligible`, status). `afterReconcile` (job path only) queues the AI reasoning when the
 * files have settled, queues automatic registration when everything allows it, or raises the owner's Needs-you card.
 */
import {
  BUNDLE_FIELD_META,
  KEY_FIELDS,
  TIMELINE_EVENT_CLASS,
  buildChecklist,
  caseKindOf,
  CASE_KIND_LABELS,
  compatible,
  decide,
  findDuplicates,
  getZone,
  groupFiles,
  keysFromCandidates,
  personMatch,
  plateMatches,
  proposeTimeline,
  reconcileBundle,
  registrable,
  requestEmailText,
  riskSignals,
  sha1Hex,
  verifySummary,
  type Blocker,
  type BundleComputed,
  type BundleFieldKey,
  type Candidate,
  type DecisionView,
  type FieldSource,
  type FileComputed,
  type FileKeys,
  type IntakeBundleReasoning,
  type IntakeSettings,
  type LiabilityPreview,
  type RiskSignal,
  type TimelineFile,
  type WitnessReading,
} from '@ccguk/domain';
import { bankKey, type IntakeBundleFileRecord, type IntakeBundleRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { autonomyState, createNeedsYou, enqueueJob, getAutonomy, londonDay } from '../../agent/core.js';
import { effectiveAgentSettings } from '../../agent/queue.js';
import type { NeedsYouItem } from '../../agent/contracts.js';
import { scoreLiabilityFor, type FnolValidation } from '../../engines.js';
import { previewFnolValidation } from '../../routes/claims.js';
import type { CreateClaimBody } from '../../schemas/claims.js';
import { buildCreateClaimBody } from './body.js';
import { loadFileContext, nameHintCandidate, photoCandidates, platesOf, readingsOf, rulesOtherKeys, sceneOf, sourceOf, type FileContext, type FileReadings } from './candidates.js';
import { buildClaimIndex, buildStopList } from './claimIndex.js';
import { BUNDLE_AGENT, CLOSED_STATUSES, filesInProgress } from './hooks.js';
import { filesetOf, validateReasoning, type ReasoningContribution } from './reason.js';
import { buildSignalsInput } from './signalsInput.js';

/** Readings below this are "low confidence" in the draft; conflicts need two readings at ≥ 0.5. */
export const LOW_CONFIDENCE = 0.75;
export const MIN_CONFLICT_CONFIDENCE = 0.5;
/** Timeline proposals at or above this are ticked by default (owner-only types never). */
export const MIN_AUTO_TICK = 0.8;
export const LIABILITY_NOTE = 'A guide from the documents only. Liability is your decision — intake never sets it.';
export const AI_PAUSED_WARNING = 'Agents are paused — this draft is from the documents’ text; the AI will check it when they are back.';

// ---------------------------------------------------------------------------
// Decisions → owner state
// ---------------------------------------------------------------------------

export interface OwnerState {
  pins: Record<string, string>;
  excluded: Set<string>;
  excludedReason: Record<string, string>;
  unsplit: Set<string>;
  splitOff: Record<string, { bundleId: string; name: string }>;
  ticks: Record<string, boolean>;
  acks: Record<string, { by: string; note: string | null; at: string }>;
  confirmNew: boolean;
  linkPartyId: string | null;
  fileCopies: Set<string>;
}

export function decisionViews(ctx: AppContext, bundleId: string): DecisionView[] {
  return ctx.repos.listBundleDecisions(ctx.db, bundleId).map((d) => ({ id: d.id, kind: d.kind, subject: d.subject ?? null, before: d.before ?? null, after: d.after ?? null, note: d.note ?? null, actor: d.actor, at: d.at }));
}

export function ownerState(decisions: DecisionView[]): OwnerState {
  const s: OwnerState = { pins: {}, excluded: new Set(), excludedReason: {}, unsplit: new Set(), splitOff: {}, ticks: {}, acks: {}, confirmNew: false, linkPartyId: null, fileCopies: new Set() };
  for (const d of decisions) {
    const after = (d.after ?? {}) as Record<string, unknown>;
    switch (d.kind) {
      case 'move_file':
        if (d.subject && typeof after.groupKey === 'string') {
          s.pins[d.subject] = after.groupKey;
          s.excluded.delete(d.subject);
        }
        break;
      case 'exclude_file':
        if (d.subject) {
          s.excluded.add(d.subject);
          s.excludedReason[d.subject] = d.note ?? 'Excluded by you';
          delete s.pins[d.subject];
        }
        break;
      case 'include_file':
        if (d.subject) {
          s.excluded.delete(d.subject);
          delete s.excludedReason[d.subject];
        }
        break;
      case 'unsplit':
        if (d.subject) s.unsplit.add(d.subject);
        break;
      case 'split_off':
        for (const id of Array.isArray(after.fileIds) ? (after.fileIds as string[]) : []) s.splitOff[id] = { bundleId: String(after.bundleId ?? ''), name: String(after.name ?? '') };
        break;
      case 'tick_timeline':
        if (d.subject) s.ticks[d.subject] = true;
        break;
      case 'untick_timeline':
        if (d.subject) s.ticks[d.subject] = false;
        break;
      case 'ack_signal':
        if (d.subject) s.acks[d.subject] = { by: d.actor, note: d.note, at: d.at };
        break;
      case 'confirm_new':
        s.confirmNew = true;
        break;
      case 'link_party':
        s.linkPartyId = typeof after.partyId === 'string' && after.partyId ? after.partyId : null;
        break;
      case 'attach':
        // a group other than the main case attached to an existing claim: its files leave this bundle
        if (after.groupKey && after.groupKey !== 'main') for (const id of Array.isArray(after.fileIds) ? (after.fileIds as string[]) : []) s.splitOff[id] = { bundleId: '', name: `attached to ${String(after.reference ?? 'a claim')}` };
        break;
      case 'reopen':
        break;
      default:
        break;
    }
    if (d.kind === 'add_files' && after.fileCopy && d.subject) s.fileCopies.add(d.subject);
  }
  return s;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export interface BundleState {
  bundle: IntakeBundleRecord;
  files: IntakeBundleFileRecord[];
  fcs: Map<string, FileContext>;
  decisions: DecisionView[];
  owner: OwnerState;
  contribution: ReasoningContribution | null;
  reasoningId: string | null;
  readings: Map<string, FileReadings>;
  /** Main-group files read for the draft (no duplicates, no containers, not excluded). */
  main: FileContext[];
  /** Every file id in the main group (duplicates included). */
  mainAll: string[];
  candidates: Candidate[];
  body: CreateClaimBody | null;
  bodyMissing: string[];
  fnol: FnolValidation | null;
  inProgress: string[];
  settings: IntakeSettings;
  computed: BundleComputed;
}

const CONTAINER_ROLES = new Set(['archive']);
const yesNo = (v: string | null | undefined): boolean | null => (v === 'yes' || v === 'true' ? true : v === 'no' || v === 'false' ? false : null);

function emailDate(fc: FileContext): string | null {
  const d = fc.doc?.email?.date;
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Has the pack active segment children (then the segments are read, not the pack)? */
function packIsSplit(fc: FileContext, files: IntakeBundleFileRecord[], owner: OwnerState): boolean {
  if (owner.unsplit.has(fc.file.id)) return false;
  return files.some((f) => f.parentFileId === fc.file.id && f.role === 'segment');
}

/** The AI's view of who keeps the bundle busy (for views and the reasoning status). */
export function aiWaiting(ctx: AppContext): { reason: 'agents_off' | 'kill_switch' | 'usage' | 'sign_in'; until?: string } | null {
  const settings = effectiveAgentSettings(ctx);
  if (settings.autonomy.killSwitch) return { reason: 'kill_switch' };
  if (!settings.agents.enabled || settings.ai.driver === 'off') return { reason: 'agents_off' };
  const usage = ctx.repos.getAiUsageState(ctx.db);
  if (usage.pausedUntil && usage.pausedUntil > ctx.now()) return { reason: /auth|sign/i.test(usage.pauseReason ?? '') ? 'sign_in' : 'usage', until: usage.pausedUntil };
  return null;
}

function claimsOfParty(ctx: AppContext, partyId: string): Array<{ id: string; reference: string }> {
  return ctx.handle.sqlite.prepare(`SELECT id, reference FROM claims WHERE claimant_id = ? OR driver_id = ? ORDER BY reference`).all(partyId, partyId) as Array<{ id: string; reference: string }>;
}

/** Compute the bundle's state from files + readings + decisions (reads the database; writes nothing). */
export function computeBundle(ctx: AppContext, bundleId: string): BundleState {
  const bundle = ctx.repos.requireIntakeBundle(ctx.db, bundleId);
  const now = ctx.now();
  const settings = ctx.repos.getAgentSettings(ctx.db).intake;
  const files = ctx.repos.listBundleFiles(ctx.db, bundle.id);
  const decisions = decisionViews(ctx, bundle.id);
  const owner = ownerState(decisions);

  const fcs = new Map<string, FileContext>();
  for (const f of files) {
    const fc = loadFileContext(ctx, f);
    if (fc) fcs.set(f.id, fc);
  }
  // excluded: by the owner, split off to another bundle, or segments of an unsplit pack
  const excluded = new Set<string>(owner.excluded);
  for (const id of Object.keys(owner.splitOff)) excluded.add(id);
  for (const f of files) if (f.role === 'segment' && f.parentFileId && owner.unsplit.has(f.parentFileId)) excluded.add(f.id);
  for (const [id, fc] of fcs) if (fc.item.status === 'skipped' && fc.file.role !== 'archive' && !fc.text.trim() && !fc.isPhoto) excluded.add(id);
  const live = [...fcs.values()].filter((fc) => !excluded.has(fc.file.id));

  // 1. duplicates
  const dup = findDuplicates({
    files: live.map((fc) => ({
      fileId: fc.file.id,
      position: fc.file.position,
      sha256: fc.evidence.sha256,
      textSha256: fc.item.textSha256 ?? null,
      text: fc.isPhoto ? null : fc.text || null,
      phash: fc.file.phash ?? fc.doc?.phash ?? null,
      pixels: fc.doc?.pixels ?? ((fc.file.facts as { pixels?: number } | undefined)?.pixels ?? null),
      role: fc.file.role === 'pack' && !packIsSplit(fc, files, owner) ? 'document' : fc.file.role,
      parentFileId: fc.file.parentFileId ?? null,
    })),
    nearMaxDistance: settings.duplicates.nearPhotoMaxDistance,
    shingleMin: settings.duplicates.nearTextMinJaccard,
  });
  const duplicateOf: Record<string, string> = {};
  const dupInfo: Record<string, { of: string; kind: 'same_file' | 'same_text' | 'near_photo' | 'near_text'; similarity: number }> = {};
  for (const l of dup.links) {
    duplicateOf[l.fileId] = l.of;
    dupInfo[l.fileId] = { of: l.of, kind: l.kind, similarity: l.similarity };
  }

  // 2. readings (containers and split packs are not read; their children are)
  const readable = (fc: FileContext) => !CONTAINER_ROLES.has(fc.file.role) && !(fc.file.role === 'pack' && packIsSplit(fc, files, owner));
  const readings = new Map<string, FileReadings>();
  for (const fc of live) if (readable(fc)) readings.set(fc.file.id, readingsOf(fc, now));

  // the registrations the documents already hold (to place plates read in photos)
  const topOf = (key: BundleFieldKey): string | null => {
    const all = [...readings.values()].flatMap((r) => r.candidates).filter((c) => c.key === key && c.validatorOk);
    all.sort((a, b) => b.source.rank - a.source.rank || b.source.confidence - a.source.confidence);
    return all[0]?.value ?? null;
  };
  const known = { client: topOf('vehicle.registration'), tp: topOf('tp.registration') };
  const photoCands = new Map<string, Candidate[]>();
  for (const fc of live) if (fc.isPhoto && readable(fc)) photoCands.set(fc.file.id, photoCandidates(fc, known, now));

  // 3. the stored AI reasoning (checked against the bundle's current files)
  const latest = ctx.repos.latestBundleReasoning(ctx.db, bundle.id);
  const contribution = latest ? validateReasoning(latest.result as IntakeBundleReasoning, live.filter(readable), now) : null;

  // 4. keys + groups
  const stop = buildStopList(ctx);
  const own = bundle.claimId ? [bundle.claimId] : [];
  const index = buildClaimIndex(ctx, { excludeClaimIds: own });
  const keyFiles: FileKeys[] = [...fcs.values()].map((fc) => {
    const r = readings.get(fc.file.id);
    const shaOnClaims = [...new Set(ctx.repos.findEvidenceBySha256(ctx.db, fc.evidence.sha256).map((e) => e.claimId).filter((x): x is string => Boolean(x) && !own.includes(x!)))];
    return keysFromCandidates(fc.file.id, [...(r?.candidates ?? []), ...(photoCands.get(fc.file.id) ?? [])], {
      shaOnClaims,
      plates: platesOf(fc).map((p) => p.text),
      takenAt: fc.isPhoto ? (fc.evidence.exif?.dateTimeOriginal ?? fc.evidence.capturedAt ?? null) : null,
      position: fc.file.position,
      parentFileId: fc.file.parentFileId ?? null,
      role: fc.file.role,
      isPhoto: fc.isPhoto,
      label: fc.label,
      otherKeys: [...(r?.otherKeys ?? []), ...rulesOtherKeys(fc, now)],
    }, stop);
  });
  const words: Record<string, string[]> = {};
  for (const [id, r] of readings) words[id] = r.candidates.filter((c) => c.key === 'vehicle.make' || c.key === 'vehicle.model').flatMap((c) => c.display.split(/\s+/));
  const grouping = groupFiles({ files: keyFiles, index, nameHint: bundle.name, pins: owner.pins, excluded: [...excluded], duplicateOf, words, advice: contribution?.advice ?? {} });
  const groupOf = (id: string) => grouping.fileGroup[id] ?? (excluded.has(id) ? 'excluded' : 'unsure');
  // reasons for files the owner did not exclude themselves
  const exGroup = grouping.groups.find((g) => g.key === 'excluded');
  if (exGroup) {
    for (const id of exGroup.fileIds) {
      const so = owner.splitOff[id];
      const fc = fcs.get(id);
      const text = so ? (so.bundleId ? `${fc?.evidence.filename ?? 'A file'} moved to the bundle “${so.name}”` : `${fc?.evidence.filename ?? 'A file'} ${so.name}`) : owner.excluded.has(id) ? `${fc?.evidence.filename ?? 'A file'}: ${owner.excludedReason[id] ?? 'excluded by you'}` : `${fc?.evidence.filename ?? 'A file'}: part of a pack you asked to keep whole`;
      exGroup.reasons.push({ code: 'moved_by_owner', text, fileId: id });
    }
    exGroup.reasons = exGroup.reasons.slice(0, 10);
  }

  // 5. main group → candidates → draft
  const mainAll = [...fcs.keys()].filter((id) => groupOf(id) === 'main');
  const main = mainAll.map((id) => fcs.get(id)!).filter((fc) => !duplicateOf[fc.file.id] && readable(fc));
  const mainIds = new Set(main.map((fc) => fc.file.id));
  const candidates: Candidate[] = [];
  const witnessReadings: WitnessReading[] = [];
  for (const fc of main) {
    const r = readings.get(fc.file.id);
    if (r) {
      candidates.push(...r.candidates);
      witnessReadings.push(...r.witnessReadings);
    }
    candidates.push(...(photoCands.get(fc.file.id) ?? []));
  }
  const hint = nameHintCandidate(bundle.name, now);
  if (hint) candidates.push(hint);
  if (contribution) {
    candidates.push(...contribution.candidates.filter((c) => mainIds.has(c.source.fileId)));
    witnessReadings.push(...contribution.witnessReadings.filter((w) => mainIds.has(w.source.fileId)));
  }
  const rec = reconcileBundle({ candidates, decisions, minConflictConfidence: MIN_CONFLICT_CONFIDENCE, lowConfidence: LOW_CONFIDENCE, witnessReadings });
  const values: Record<string, string | null> = Object.fromEntries(rec.fields.map((f) => [f.key, f.value]));
  const field = (k: BundleFieldKey) => rec.fields.find((f) => f.key === k)!;

  // 6. checklist
  const hireNeeded = yesNo(values['hire.needed']);
  const repair = main.some((fc) => fc.docType === 'bodyshop_estimate' || fc.docType === 'audatex_estimate' || fc.docType === 'engineer_report');
  const caseKind = caseKindOf({ hireNeeded, totalLoss: false, repair, tpRegistrationUnknown: false });
  const addressOn = (dt: string) => candidates.find((c) => c.key === 'client.address' && c.validatorOk && c.source.docType === dt);
  const lic = addressOn('driving_licence');
  const v5 = addressOn('v5c');
  const addressesDiffer = Boolean(lic && v5 && !compatible('client.address', lic, v5).same);
  const policeAttended = yesNo(values['accident.policeAttended']) ?? (values['accident.policeReference'] ? true : null);
  const items = buildChecklist({
    caseKind,
    files: main.map((fc) => ({ fileId: fc.file.id, docType: fc.docType, docSide: fc.docSide, formTemplateId: fc.doc?.formTemplateId ?? null, scene: sceneOf(fc), excluded: false, platesVisible: platesOf(fc).length > 0 })),
    fields: values,
    witnesses: rec.witnesses.length,
    accidentDate: values['accident.occurredAt'] ?? null,
    firstRegistered: values['vehicle.firstRegistered'] ?? null,
    policeAttended,
    addressesDiffer,
  });
  const wanted = items.filter((i) => i.status === 'missing' || i.status === 'partial');
  const firstName = values['client.name']?.split(/\s+/)[0] ?? null;
  const request = wanted.filter((i) => i.id !== 'signed_hire_docs').length ? { to: values['client.email'] ?? null, ...requestEmailText(items, firstName, null) } : null;

  // 7. timeline
  const tFiles: TimelineFile[] = main
    .filter((fc) => !fc.isPhoto)
    .map((fc) => {
      const r = readings.get(fc.file.id);
      const own = (k: BundleFieldKey) => r?.candidates.find((c) => c.key === k && c.validatorOk)?.display;
      const lower = fc.text.toLowerCase();
      const insurerName = own('tp.insurerName');
      const insurerRef = own('tp.insurerRef');
      const policeRef = own('accident.policeReference');
      return {
        fileId: fc.file.id,
        docType: fc.docType,
        documentDate: fc.documentDate,
        emailDate: emailDate(fc),
        from: fc.doc?.email?.from ?? null,
        subject: fc.doc?.email?.subject ?? null,
        facts: {
          ...(insurerName ? { insurerName } : {}),
          ...(insurerRef ? { insurerRef } : {}),
          ...(policeRef ? { policeRef } : {}),
          ...(r?.facts.inspectionDate ? { inspectionDate: r.facts.inspectionDate } : {}),
          ...(r?.facts.offerFound ? { offerFound: true } : {}),
          ...(fc.docType === 'invoice' && /recovery/.test(lower) ? { recovery: true } : {}),
          ...(fc.docType === 'invoice' && /storage/.test(lower) ? { storage: true } : {}),
        },
        source: sourceOf(fc, { page: fc.documentDate ? 1 : null, quote: null, confidence: 0.85, engine: fc.engine === 'ai' ? 'ai' : 'rules', key: 'accident.occurredAt' }),
      };
    });
  const timeline = proposeTimeline({ files: tFiles, aiItems: (contribution?.timeline ?? []).filter((t) => mainIds.has(t.fileId)), accidentAt: values['accident.occurredAt'] ?? null, ticks: owner.ticks, minAutoTick: MIN_AUTO_TICK });

  // 8. signals (owner-only)
  const facts = main.map((fc) => readings.get(fc.file.id)?.facts).filter(Boolean);
  const bank = facts.find((f) => f?.sortCode && f.accountNumber);
  const docInjection = main.some((fc) => Boolean(fc.doc?.injectionFlags?.length));
  const signalsInput = buildSignalsInput(ctx, { main, values, acks: owner.acks, settings, bankKey: bank ? (bankKey({ sortCode: bank.sortCode, accountNumber: bank.accountNumber }) ?? null) : null, bundleInjection: Boolean(contribution?.injection), excludeClaimId: bundle.claimId ?? null });
  const signals: RiskSignal[] = riskSignals(signalsInput);

  // 9. liability preview (a guide; never written)
  const statements: LiabilityPreview['statements'] = [...(contribution?.liability ?? []).filter((l) => mainIds.has(l.source.fileId))];
  for (const fc of main) {
    for (const l of readings.get(fc.file.id)?.facts.liability ?? []) {
      // the same sentence already given by the AI's bundle reading (its quote is part of this line, or the other way round)
      const lt = l.text.toLowerCase();
      const lq = (l.quote ?? l.text).toLowerCase();
      const same = (s: LiabilityPreview['statements'][number]): boolean => {
        if (s.text.toLowerCase() === lt) return true;
        if (s.source.fileId !== fc.file.id || (s.source.page ?? null) !== (l.page ?? null)) return false;
        const sq = (s.source.quote ?? s.text).toLowerCase();
        return Boolean(sq) && (lq.includes(sq) || sq.includes(lq));
      };
      if (statements.some(same)) continue;
      statements.push({ text: l.text, party: fc.docType === 'insurer_letter' ? 'insurer' : fc.docType === 'police_report' ? 'police' : 'other', source: sourceOf(fc, { page: l.page, quote: l.quote, confidence: 0.8, engine: 'rules', key: 'accident.circumstances' }) });
    }
  }
  let liability: LiabilityPreview = { score: null, band: null, reasons: [], statements, note: LIABILITY_NOTE };
  if (values['accident.occurredAt'] && values['accident.location'] && values['accident.circumstances']) {
    const s = scoreLiabilityFor(
      {
        occurredAt: values['accident.occurredAt'],
        location: values['accident.location'],
        circumstances: values['accident.circumstances'],
        ...(policeAttended !== null ? { policeAttended } : {}),
        ...(yesNo(values['accident.injuries']) !== null ? { injuries: yesNo(values['accident.injuries'])! } : {}),
        ...(rec.witnessesAnswered && rec.witnesses.some((w) => /^(none|independent|stranger)$/i.test(w.relationship ?? '')) ? { independentWitness: true } : {}),
      },
      { liability: 'unknown', priorClaimsOnRegistration: signalsInput.otherClaims.vehicle.filter((v) => v.how === 'registration').length },
    );
    liability = { ...liability, score: s.score, band: s.band, reasons: s.reasons };
  }

  // 10. existing client record (licence, or name + date of birth)
  let existingParty: BundleComputed['draft']['existingParty'] = null;
  if (values['client.name'] && (values['client.drivingLicenceNumber'] || values['client.dateOfBirth'])) {
    const me = { id: '', name: values['client.name'], dateOfBirth: values['client.dateOfBirth'] ?? undefined, drivingLicenceNumber: values['client.drivingLicenceNumber'] ?? undefined };
    for (const p of ctx.repos.listParties(ctx.db, { kind: 'individual', limit: 5000 })) {
      const how = personMatch(me, { id: p.id, name: p.name, dateOfBirth: p.dateOfBirth, drivingLicenceNumber: p.drivingLicenceNumber });
      if (how !== 'licence' && how !== 'name_dob') continue;
      existingParty = { partyId: p.id, name: p.name, claims: claimsOfParty(ctx, p.id), how };
      if (how === 'licence') break;
    }
  }

  // 11. body + FNOL preview
  const built = buildCreateClaimBody(ctx, { fields: rec.fields, witnesses: rec.witnesses, witnessesAnswered: rec.witnessesAnswered, bundleName: bundle.name, documents: mainAll.length, now, linkPartyId: owner.linkPartyId });
  const fnol = built.body ? previewFnolValidation(ctx, built.body) : null;

  // 12. registrable
  const inProgress = filesInProgress(ctx, files.filter((f) => !excluded.has(f.id)));
  const open = rec.conflicts.filter((c) => c.status === 'open');
  const missingKey = KEY_FIELDS.filter((k) => !values[k] || (k === 'accident.occurredAt' && /^\d{4}-\d{2}-\d{2}$/.test(values[k] ?? '')));
  const lowKey = KEY_FIELDS.filter((k) => values[k] && field(k).status !== 'owner_set' && field(k).confidence < settings.bundles.autoRegisterMinConfidence);
  const minKeyConfidence = Math.min(1, ...KEY_FIELDS.map((k) => (field(k).status === 'owner_set' ? 1 : field(k).confidence)));
  const mainGroup = grouping.groups.find((g) => g.key === 'main');
  const unsureFiles = grouping.groups.find((g) => g.key === 'unsure')?.fileIds.length ?? 0;
  const otherGroups = grouping.groups.filter((g) => g.kind === 'new_case' || g.kind === 'existing_claim').length;
  const fileset = filesetOf(main.map((fc) => ({ fc, groupKey: 'main' })));
  const reasoningDone = bundle.reasoningStatus === 'done' && bundle.reasoningFileset === fileset && fileset !== '';
  const policy = decide({ class: 'internal', kind: 'intake.register', confidence: minKeyConfidence, sensitive: false, overwrites: false }, getAutonomy(ctx), autonomyState(ctx, { agent: 'intake' }));
  const circ = rec.circumstances;
  const witnessesWithoutRelationship = rec.witnessesAnswered ? rec.witnesses.filter((w) => !w.relationship?.trim()).length : 0;
  const reg = registrable({
    filesInProgress: inProgress.length,
    conflictsOpen: open.length,
    missingKey,
    lowKey,
    contactMissing: !values['client.phone'] && !values['client.email'],
    fnolErrors: fnol ? fnol.errors.map((e) => plainFnolText(e.message)) : !missingKey.length && built.missing.length ? built.missing : [],
    fnolWarnings: fnol ? [...fnol.warnings, ...fnol.incomplete.map((i) => i.message)].map(plainFnolText) : [],
    mainMatchesClaim: mainGroup?.claim ? { reference: mainGroup.claim.reference } : null,
    confirmedNew: owner.confirmNew,
    signalsWarn: signals.filter((s) => s.severity === 'warn' && !s.acknowledged).length,
    signalsOpen: signals.filter((s) => !s.acknowledged).length,
    unsureFiles,
    otherGroups,
    reasoningDone,
    injection: docInjection || Boolean(contribution?.injection),
    duplicateOpenClaim: signalsInput.otherClaims.claimant.some((c) => c.open) || signalsInput.otherClaims.vehicle.some((v) => v.open),
    settingOn: settings.bundles.autoRegister,
    minConfidence: settings.bundles.autoRegisterMinConfidence,
    policy: { outcome: policy.outcome, reasons: policy.reasons },
    circumstancesUnconfirmed: Boolean(values['accident.circumstances']) && circ.attribution !== 'client' && circ.attribution !== 'owner',
    witnessesWithoutRelationship,
  });
  const fnolWarnings = fnol ? [...fnol.warnings, ...fnol.incomplete.map((i) => i.message)].map(plainFnolText) : [];

  // 13. willDo
  const filedDocs = mainAll.filter((id) => !duplicateOf[id] && fcs.get(id) && !CONTAINER_ROLES.has(fcs.get(id)!.file.role));
  const photos = filedDocs.filter((id) => fcs.get(id)!.isPhoto).length;
  const dupCount = mainAll.filter((id) => duplicateOf[id]).length;
  const ticked = timeline.filter((t) => t.ticked).length;
  const zones = main.reduce((n, fc) => n + (fc.photo?.damageZones?.length ?? 0), 0);
  const willDo: string[] = [];
  const who = [values['client.name'], values['vehicle.registration'] ? field('vehicle.registration').display : null].filter(Boolean).join(', ');
  willDo.push(`Open a new claim${who ? ` for ${who}` : ''} with the details above (liability stays unknown — your decision)`);
  willDo.push(`File ${filedDocs.length - photos} document${filedDocs.length - photos === 1 ? '' : 's'} and ${photos} photo${photos === 1 ? '' : 's'} on the claim${dupCount ? ` (${dupCount} cop${dupCount === 1 ? 'y' : 'ies'} not filed twice)` : ''}`);
  if (ticked) willDo.push(`Add ${ticked} ticked chronology entr${ticked === 1 ? 'y' : 'ies'}`);
  if (zones) willDo.push('Record the damage the photos show on the claim’s damage model');
  // the signed hire paperwork is prepared by the Autopilot, never asked of the client (requestEmailText)
  const askN = wanted.filter((i) => i.id !== 'signed_hire_docs').length;
  if (askN && settings.bundles.prepareMissingDocsRequest) willDo.push(`Prepare a request to the client for ${askN} missing document${askN === 1 ? '' : 's'} — you approve it before anything is sent`);
  const newCases = grouping.groups.filter((g) => g.kind === 'new_case').length;
  if (newCases || unsureFiles) willDo.push(`Move ${newCases ? `${newCases} other case${newCases === 1 ? '' : 's'}` : ''}${newCases && unsureFiles ? ' and ' : ''}${unsureFiles ? `${unsureFiles} unplaced file${unsureFiles === 1 ? '' : 's'}` : ''} into ${newCases + unsureFiles === 1 ? 'a new bundle' : 'new bundles'} (nothing is lost)`);
  for (const g of grouping.groups.filter((x) => x.kind === 'existing_claim')) willDo.push(`Leave ${g.fileIds.length} file${g.fileIds.length === 1 ? '' : 's'} for ${g.claim?.reference ?? 'the other claim'} — attach them when you register, or later`);
  if (fnolWarnings.length) willDo.push('Put “Call the client” first on the claim: confirm their account, read the recording disclosure, ask the script questions');
  willDo.push('Check for hire-car clashes and wake the Autopilot');

  // 14. per-file computed facts
  const filesOut: Record<string, FileComputed> = {};
  for (const f of files) {
    const fc = fcs.get(f.id);
    const exif = fc?.evidence.exif;
    filesOut[f.id] = {
      fileId: f.id,
      groupKey: excluded.has(f.id) ? 'excluded' : groupOf(f.id),
      pinned: Boolean(owner.pins[f.id]) && !excluded.has(f.id),
      excluded: excluded.has(f.id),
      duplicate: dupInfo[f.id] ?? null,
      docType: fc?.docType ?? null,
      docSide: fc?.docSide ?? null,
      documentDate: fc?.documentDate ?? null,
      engine: fc?.engine ?? null,
      photo: fc?.isPhoto
        ? {
            takenAt: exif?.dateTimeOriginal ?? fc.evidence.capturedAt ?? null,
            gps: exif?.gps ? { lat: exif.gps.lat, lon: exif.gps.lon } : (fc.doc?.gps ?? null),
            software: exif?.software ?? null,
            scene: sceneOf(fc),
            plates: plateMatches(platesOf(fc).map((p) => p.text), { client: values['vehicle.registration'] ?? null, tp: values['tp.registration'] ?? null }).map((p, i) => ({ ...p, confidence: platesOf(fc)[i]?.confidence ?? 0 })),
            zones: (fc.photo?.damageZones ?? []).filter((z) => getZone(z.zoneId)).map((z) => ({ zoneId: z.zoneId, label: getZone(z.zoneId)!.label, severity: Math.min(3, Math.max(1, Math.round(z.severity))) as 1 | 2 | 3, confidence: z.confidence })),
          }
        : null,
    };
  }

  // 15. summary + warnings
  const aiSummary = contribution?.summary && verifySummary(contribution.summary, values) ? contribution.summary : null;
  const warnings = [...grouping.warnings];
  if (contribution?.checks.cappedQuotes) warnings.push(`${contribution.checks.cappedQuotes} AI reading${contribution.checks.cappedQuotes === 1 ? '' : 's'} quoted text that is not in the document — ${contribution.checks.cappedQuotes === 1 ? 'it is' : 'they are'} shown with low confidence`);
  if (aiWaiting(ctx) && (bundle.reasoningStatus !== 'done' || main.some((fc) => fc.engine !== 'ai' && (fc.isPhoto || !fc.text.trim() || fc.engine === 'rules')))) warnings.push(AI_PAUSED_WARNING);

  const computed: BundleComputed = {
    revision: bundle.revision,
    computedAt: now,
    files: filesOut,
    groups: grouping.groups,
    draft: { fields: rec.fields, witnesses: rec.witnesses, witnessesAnswered: rec.witnessesAnswered, circumstances: rec.circumstances, existingParty },
    conflicts: rec.conflicts,
    checklist: { caseKind, caseKindLabel: CASE_KIND_LABELS[caseKind], items, request },
    timeline,
    signals,
    liability,
    register: { canRegister: reg.canRegister, blockers: reg.blockers.filter((b) => b.for === 'owner'), fnolWarnings, willDo },
    auto: { eligible: reg.autoEligible, blockers: reg.blockers },
    aiSummary,
    fileset,
    warnings,
  };
  return { bundle, files, fcs, decisions, owner, contribution, reasoningId: latest?.id ?? null, readings, main, mainAll, candidates, body: built.body, bodyMissing: built.missing, fnol, inProgress, settings, computed };
}

// ---------------------------------------------------------------------------
// Store + follow-ups
// ---------------------------------------------------------------------------

export function openCard(ctx: AppContext, bundle: IntakeBundleRecord): NeedsYouItem | undefined {
  if (!bundle.needsYouId) return undefined;
  const item = ctx.repos.getNeedsYouItem(ctx.db, bundle.needsYouId);
  return item && (item.status === 'open' || item.status === 'snoozed') ? (item as unknown as NeedsYouItem) : undefined;
}

/** FNOL checks read "accident.postcode: No postcode: …"; the owner sees the sentence without the field path. */
export function plainFnolText(message: string): string {
  return message.replace(/^[A-Za-z][\w.[\]]*:\s+/, '');
}

/** Recompute and store (`computed`, `computed_revision`, `auto_eligible`, status). */
export function recomputeBundle(ctx: AppContext, bundleId: string): BundleState {
  const state = computeBundle(ctx, bundleId);
  const b = state.bundle;
  const now = ctx.now();
  let status = b.status;
  if (!CLOSED_STATUSES.has(b.status) && b.status !== 'registering') {
    status = state.inProgress.length ? 'reading' : openCard(ctx, b) ? 'needs_you' : 'ready';
  }
  state.bundle = ctx.repos.updateIntakeBundle(ctx.db, b.id, { computed: state.computed, computedRevision: b.revision, autoEligible: state.computed.auto.eligible, status }, now);
  return state;
}

/** A London-day count of AI reasoning runs on the bundle (the owner's "Think again" is exempt from the cap). */
function reasoningRunsToday(ctx: AppContext, bundleId: string): number {
  const today = londonDay(ctx.now());
  const jobs = ctx.repos.listAgentJobs(ctx.db, { type: 'intake.bundle_reason', limit: 2000 }).filter((j) => (j.payload as { bundleId?: string; owner?: boolean } | undefined)?.bundleId === bundleId && !(j.payload as { owner?: boolean }).owner);
  return jobs.filter((j) => londonDay(j.createdAt) === today).length;
}

export const filesetKey = (fileset: string): string => sha1Hex(fileset, 16);

/** Queue the AI reasoning for the bundle's current main fileset. */
export function queueReasoning(ctx: AppContext, bundle: IntakeBundleRecord, fileset: string, opts: { owner?: boolean; createdBy?: string } = {}): boolean {
  const suffix = opts.owner ? `:o${Date.parse(ctx.now())}` : '';
  enqueueJob(ctx, {
    type: 'intake.bundle_reason',
    payload: { bundleId: bundle.id, fileset, ...(opts.owner ? { owner: true } : {}) },
    idempotencyKey: `intake.bundle_reason:${bundle.id}:${filesetKey(fileset)}${suffix}`,
    createdBy: opts.createdBy ?? BUNDLE_AGENT,
  });
  ctx.repos.updateIntakeBundle(ctx.db, bundle.id, { reasoningStatus: 'queued', reasoningFileset: fileset }, ctx.now());
  return true;
}

/** Every main file has finished being read (a reading stored, or skipped / failed / waiting for the AI). */
function allSettled(ctx: AppContext, state: BundleState): boolean {
  if (state.inProgress.length) return false;
  // with the AI available, wait for each file's own AI reading first (the bundle reading builds on them)
  const aiAvailable = !aiWaiting(ctx);
  const done = aiAvailable ? ['skipped', 'failed', 'proposed', 'applied', 'needs_you'] : ['skipped', 'failed', 'quota_wait', 'extracting', 'proposed', 'applied', 'needs_you'];
  return state.main.every((fc) => done.includes(fc.item.status) || (!aiAvailable && Boolean(fc.best)));
}

/** The bundle variant of the `new_claim` card (§9). */
export function raiseBundleCard(ctx: AppContext, state: BundleState): NeedsYouItem {
  const b = state.bundle;
  const c = state.computed;
  const keyFields = c.draft.fields.filter((f) => f.keyField && f.value).map((f) => ({ label: f.label, value: f.sensitive ? 'given' : (f.display ?? f.value ?? '') }));
  const conflicts = c.conflicts.filter((x) => x.status === 'open').length;
  const missing = c.checklist.items.filter((i) => i.status === 'missing' || i.status === 'partial').length;
  const signalsWarn = c.signals.filter((s) => s.severity === 'warn' && !s.acknowledged).length;
  const lines = [
    ...keyFields.map((k) => `${k.label}: ${k.value}`),
    conflicts ? `${conflicts} conflict${conflicts === 1 ? '' : 's'} to check` : null,
    missing ? `${missing} document${missing === 1 ? '' : 's'} missing` : null,
    signalsWarn ? `${signalsWarn} thing${signalsWarn === 1 ? '' : 's'} worth a look` : null,
  ].filter(Boolean);
  const item = createNeedsYou(ctx, {
    kind: 'new_claim',
    title: `Documents for '${b.name}' are ready — register the claim?`,
    summary: lines.join('\n') || `${state.mainAll.length} files read.`,
    recommendation: {
      action: c.register.canRegister ? 'Check the draft and register the claim' : 'Check the draft, settle what is open, then register',
      why: c.register.canRegister ? 'Every key detail was found in the documents. Opening a claim is always your decision.' : c.register.blockers.map((x) => x.text).join('; ').slice(0, 400),
      confidence: c.register.canRegister ? 0.7 : 0.5,
      basis: [],
    },
    options: [
      { id: 'register', label: 'Register the claim', tone: 'primary' },
      { id: 'attach', label: 'Attach to a claim…', tone: 'neutral', requiresEdit: true },
      { id: 'cancel', label: 'Not a claim', tone: 'danger', requiresReason: true },
    ],
    payload: { bundleId: b.id, name: b.name, revision: b.revision, keyFields, counts: { files: state.mainAll.length, conflicts, missing, signalsWarn }, blockers: c.register.blockers },
    priority: 'normal',
    createdBy: BUNDLE_AGENT,
    dedupeKey: `new_claim:bundle:${b.id}`,
  });
  return item;
}

/** Job-path follow-ups of a reconcile (§6.1). */
export function afterReconcile(ctx: AppContext, state: BundleState): { reasoningQueued: boolean; autoQueued: boolean; needsYouId: string | null } {
  let b = state.bundle;
  const now = ctx.now();
  let reasoningQueued = false;
  let autoQueued = false;
  const fileset = state.computed.fileset;
  if (!CLOSED_STATUSES.has(b.status) && b.status !== 'registering' && allSettled(ctx, state) && fileset && fileset !== b.reasoningFileset) {
    const cap = state.settings.bundles.aiReasoningRunsPerBundlePerDay;
    if (reasoningRunsToday(ctx, b.id) < cap) {
      reasoningQueued = queueReasoning(ctx, b, fileset);
    } else if (b.reasoningStatus !== 'skipped') {
      ctx.repos.updateIntakeBundle(ctx.db, b.id, { reasoningStatus: 'skipped' }, now);
    }
    b = ctx.repos.requireIntakeBundle(ctx.db, b.id);
  }
  let needsYouId = openCard(ctx, b)?.id ?? null;
  if (b.status === 'ready' || b.status === 'needs_you') {
    if (state.computed.auto.eligible && state.settings.bundles.autoRegister) {
      enqueueJob(ctx, { type: 'intake.bundle_register', payload: { bundleId: b.id, revision: b.revision }, idempotencyKey: `intake.bundle_register:${b.id}:r${b.revision}`, createdBy: BUNDLE_AGENT });
      autoQueued = true;
    } else if (!needsYouId && !(state.settings.bundles.autoRegister && !aiWaiting(ctx) && !['done', 'failed', 'skipped'].includes(b.reasoningStatus))) {
      // (with automatic registration on and the AI available, the card waits for the AI check first)
      const card = raiseBundleCard(ctx, { ...state, bundle: b });
      needsYouId = card.id;
      ctx.repos.updateIntakeBundle(ctx.db, b.id, { needsYouId: card.id, status: 'needs_you' }, now);
    } else if (needsYouId && b.status !== 'needs_you') {
      ctx.repos.updateIntakeBundle(ctx.db, b.id, { status: 'needs_you' }, now);
    }
  }
  const c = state.computed;
  ctx.repos.appendAudit(ctx.db, {
    actor: { userId: BUNDLE_AGENT },
    action: 'intake.bundle.reconcile',
    entity: 'intake_bundles',
    entityId: b.id,
    after: {
      bundleId: b.id,
      revision: c.revision,
      files: state.files.length,
      groups: c.groups.map((g) => g.key),
      conflicts: c.conflicts.filter((x) => x.status === 'open').length,
      missing: c.checklist.items.filter((i) => i.status === 'missing' || i.status === 'partial').length,
      signals: c.signals.map((s) => s.code),
      reasoningQueued,
      autoQueued,
    },
    at: now,
  });
  return { reasoningQueued, autoQueued, needsYouId };
}

/** Blockers for a register attempt in a mode (owner: owner blockers; auto: all). */
export function blockersFor(computed: BundleComputed, mode: 'owner' | 'auto'): Blocker[] {
  return mode === 'owner' ? computed.register.blockers : computed.auto.blockers;
}

/** The candidate with the best reading of a key (for corrections: the top reading before the owner's change). */
export function topReading(state: BundleState, key: BundleFieldKey): Candidate | undefined {
  const all = state.candidates.filter((c) => c.key === key && c.validatorOk && c.source.engine !== 'owner');
  all.sort((a, b) => b.source.rank - a.source.rank || b.source.confidence - a.source.confidence);
  return all[0];
}

export const fieldLabel = (key: BundleFieldKey): string => BUNDLE_FIELD_META[key].label;
export const isTimelineType = (t: string): boolean => t in TIMELINE_EVENT_CLASS;
export type { FieldSource };

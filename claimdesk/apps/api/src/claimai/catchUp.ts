// owned by claimai-server
/**
 * Catch-up (docs/CLAIM-AI-INPUT.md §8): a smart-intake bundle in `catch_up` mode with its claim fixed. After every
 * reconcile (late-bound hook from intake/bundles/recompute.ts) the files are planned — already on file, who sent it,
 * the real date, what kind of letter, already recorded — field lines are added from the bundle's reconciled draft,
 * and, with "Apply automatically" on and the files settled, `claim.catch_up_apply` files and records the routine lines
 * as `agent:intake`. Owner overrides are read from the append-only log.
 */
import {
  BUNDLE_KEY_TARGET,
  CLAIM_AI_DEFAULTS,
  buildAction,
  liveEvents,
  planCatchUp,
  type BundleFieldKey,
  type CatchUpClaimFacts,
  type CatchUpFileInput,
  type CatchUpTimelineItem,
  type Identity,
  type PartyHints,
  type PlannedAction,
} from '@ccguk/domain';
import { brand, listTemplates } from '@ccguk/documents';
import type { ClaimAiInputRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { enqueueJob } from '../agent/core.js';
import { evidenceKindFor } from '../intake/bundles/file.js';
import { catchUpSettled, computeBundle, type BundleState } from '../intake/bundles/recompute.js';
import { loadClaimSnapshot, sameValue, targetDef } from '../intake/targets.js';
import { INTAKE_AGENT, fileOverrides, interpretationOf, logInput, type StoredInterpretation } from './service.js';
import { lineResults } from './apply.js';

const lines = (s: string): string[] => s.split(/\r?\n/);
const splitAddrs = (s: string | undefined): string[] => (s ? s.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : []);
const domainOf = (a: string): string | null => {
  const m = /@([^>\s]+)/.exec(a);
  return m ? m[1]!.toLowerCase() : null;
};

/** Who we are (letterhead, sign-off, our mailbox). */
export function identityFor(ctx: AppContext): Identity {
  const names = new Set<string>(['Courtesy Cars Group UK Ltd', 'CCGUK']);
  const emails = new Set<string>();
  const postcodes = new Set<string>();
  const phones = new Set<string>();
  try {
    const s = ctx.settings();
    if (s.companyName) names.add(s.companyName);
    if (s.registeredOffice?.postcode) postcodes.add(s.registeredOffice.postcode);
  } catch {
    /* settings unreadable */
  }
  names.add(brand.company.registeredName);
  names.add(brand.company.tradingName);
  emails.add(brand.company.claimsEmail.toLowerCase());
  phones.add(brand.company.officePhone);
  phones.add(brand.company.caseHandlerPhone);
  postcodes.add(brand.company.registeredOfficeAddress.postcode);
  const account = ctx.repos.getDefaultMailAccount(ctx.db);
  if (account?.fromAddress) emails.add(account.fromAddress.toLowerCase());
  const domains = new Set([...emails].map(domainOf).filter((d): d is string => Boolean(d)));
  return { companyNames: [...names], ourEmails: [...emails], ourDomains: [...domains], ourPostcodes: [...postcodes], ourPhones: [...phones], ourRefPattern: /CCG-\d{4}-\d{5}/ };
}

/** The claim's people (client, insurer, engineer / repairer / solicitor / supplier parties). */
export function partyHintsFor(ctx: AppContext, claimId: string): PartyHints {
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  const claimant = ctx.repos.getParty(ctx.db, claim.claimantId);
  const driver = claim.driverId ? ctx.repos.getParty(ctx.db, claim.driverId) : undefined;
  const insurer = claim.atFaultInsurerId ? ctx.repos.getParty(ctx.db, claim.atFaultInsurerId) : undefined;
  const lc = (s: string | undefined) => (s ? s.toLowerCase() : undefined);
  const entry = insurer ? ctx.kb.directory().find((e) => e.name.toLowerCase() === insurer.name.toLowerCase() || e.brands.some((b) => b.toLowerCase() === insurer.name.toLowerCase())) : undefined;
  const insurerEmails = [insurer?.email, entry?.claimsEmail, entry?.thirdPartyEmail].map(lc).filter((x): x is string => Boolean(x));
  const others: PartyHints['others'] = [];
  for (const pid of claim.thirdPartyIds) {
    const p = ctx.repos.getParty(ctx.db, pid);
    const role = p?.roles.find((r) => r === 'engineer' || r === 'repairer' || r === 'solicitor' || r === 'supplier');
    if (p && role) others.push({ role: role as never, names: [p.name], emails: p.email ? [p.email.toLowerCase()] : [] });
  }
  return {
    client: { names: [claimant?.name, driver?.name].filter((x): x is string => Boolean(x)), emails: [claimant?.email, driver?.email].map(lc).filter((x): x is string => Boolean(x)) },
    insurer: insurer ? { names: [insurer.name, ...(entry ? [entry.name, ...entry.brands] : [])], emails: insurerEmails, domains: [...new Set(insurerEmails.map(domainOf).filter((d): d is string => Boolean(d)))], postcodes: insurer.address?.postcode ? [insurer.address.postcode] : [] } : null,
    others,
  };
}

/** What the claim already holds (records made by this input itself are excluded: they are its own lines). */
export function claimFactsFor(ctx: AppContext, claimId: string, inputId: string): CatchUpClaimFacts {
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  const textSha = new Map<string, string>();
  for (const it of ctx.repos.listIntakeItems(ctx.db, { claimId, limit: 5000 })) if (it.textSha256) textSha.set(it.evidenceId, it.textSha256);
  const evidence = ctx.repos.listEvidenceForClaim(ctx.db, claimId).map((e) => ({ id: e.id, sha256: e.sha256, textSha256: textSha.get(e.id) ?? null, kind: e.kind, filename: e.filename }));
  const events = liveEvents(ctx.repos.listEvents(ctx.db, claimId)).filter((e) => (e.data as { aiInputId?: string } | undefined)?.aiInputId !== inputId);
  const outboxSent = ctx.repos.listOutbox(ctx.db, { claimId }).filter((o) => o.status === 'sent').map((o) => ({ id: o.id, kind: o.kind, sentAt: o.updatedAt }));
  const sentDocuments = ctx.repos.listSentDocuments(ctx.db, claimId, false).filter((d) => d.sentAt).map((d) => ({ id: d.id, templateId: d.templateId, sentAt: d.sentAt! }));
  const correspondence = ctx.repos
    .listCorrespondence(ctx.db, claimId)
    .filter((r) => r.inputId !== inputId)
    .map((r) => ({ id: r.id, direction: r.direction, kind: r.kind, at: r.at, evidenceId: r.evidenceId ?? null }));
  const hasPaymentPack = events.some((e) => e.type === 'payment_pack_sent') || sentDocuments.some((d) => d.templateId === 'pack.gta_payment');
  return { claimId, reference: claim.reference, accidentAt: claim.accident.occurredAt, openedAt: claim.openedAt, evidence, events: events.map((e) => ({ id: e.id, type: e.type, at: e.at, data: e.data, evidenceIds: e.evidenceIds })), outboxSent, sentDocuments, correspondence, hasPaymentPack };
}

const SIGNED_RE = /^\s*signed\s*:\s*\S+/im;

/** Per-file inputs for the pure planner, from the bundle state (§8.4). */
export function catchUpFiles(ctx: AppContext, state: BundleState, input: ClaimAiInputRecord): CatchUpFileInput[] {
  const claim = ctx.repos.requireClaim(ctx.db, input.claimId);
  const overrides = fileOverrides(ctx, input.id);
  const inProgress = new Set(state.inProgress);
  // the first dated file carrying a new insurer reference → also handling_ref_received
  const refFiles = state.files
    .filter((f) => (state.readings.get(f.id)?.candidates ?? []).some((c) => c.key === 'tp.insurerRef' && c.validatorOk && (!claim.atFaultInsurerRef || !sameValue(claim.atFaultInsurerRef, c.value))))
    .map((f) => ({ id: f.id, date: state.fcs.get(f.id)?.documentDate ?? '9999' }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const firstRefFile = refFiles[0]?.id ?? null;
  const out: CatchUpFileInput[] = [];
  for (const f of state.files) {
    const fc = state.fcs.get(f.id);
    if (!fc) continue;
    const c = state.computed.files[f.id];
    const group = state.computed.groups.find((g) => g.key === (c?.groupKey ?? 'unsure'));
    const text = fc.text ?? '';
    const ls = lines(text);
    const email = fc.doc?.email;
    const isContainer = f.role === 'pack' && state.files.some((x) => x.parentFileId === f.id && x.role === 'segment');
    const ov = overrides[f.id];
    out.push({
      fileId: f.id,
      itemId: f.intakeItemId,
      evidenceId: f.evidenceId,
      filename: fc.evidence.filename,
      mime: fc.evidence.mime,
      role: f.role,
      isPhoto: fc.isPhoto,
      docType: isContainer ? null : fc.docType,
      docTypeConfidence: fc.docTypeConfidence,
      groupKey: c?.groupKey ?? 'unsure',
      excluded: Boolean(c?.excluded),
      duplicateOf: c?.duplicate?.of ?? null,
      sha256: fc.evidence.sha256,
      textSha256: fc.item.textSha256 ?? null,
      documentDate: fc.documentDate,
      emailDate: email?.date ?? null,
      pdfCreatedAt: fc.doc?.pdfMeta?.createdAt ?? null,
      subject: email?.subject ?? null,
      head: ls.slice(0, 40).join('\n'),
      tail: ls.slice(-25).join('\n'),
      text: text.slice(0, 20_000),
      email: email || f.role === 'email' ? { from: email?.from ?? null, to: splitAddrs(email?.to), cc: splitAddrs(email?.cc) } : null,
      formTemplateId: fc.doc?.formTemplateId ?? fc.doc?.fingerprint?.templateId ?? null,
      signed: fc.fields.some((x) => /signed|signature/i.test(x.name) && Boolean(x.value)) || SIGNED_RE.test(text) ? true : fc.doc?.formTemplateId || fc.doc?.fingerprint ? false : null,
      insurerRefNew: f.id === firstRefFile,
      override: ov ? { ...(ov.direction ? { direction: ov.direction } : {}), ...(ov.date ? { date: ov.date } : {}), ...(ov.kind ? { kind: ov.kind } : {}), ...(ov.notThisClaim !== undefined ? { notThisClaim: ov.notThisClaim } : {}) } : isContainer ? { direction: 'none' } : null,
      position: f.position,
      filedEvidenceId: f.filedClaimId === input.claimId ? (f.filedEvidenceId ?? null) : null,
      otherClaimRef: group?.kind === 'existing_claim' ? (group.claim?.reference ?? null) : null,
      evidenceKind: evidenceKindFor(isContainer ? null : fc.docType, fc.evidence.mime, f.role),
      settled: !inProgress.has(f.id),
    });
  }
  return out;
}

/** Field lines from the bundle's reconciled draft (§8.5): empty on the claim → apply; differs → confirm; same → none. */
export function fieldLines(ctx: AppContext, state: BundleState, claimId: string): PlannedAction[] {
  const snapshot = loadClaimSnapshot(ctx, claimId);
  const out: PlannedAction[] = [];
  // A plate already on the claim for the other vehicle is never proposed as this one's (a letter that names "Vehicle:
  // DK18 WRE" is about our client's car, not the other side's) — the swap would be a wrong overwrite to tick.
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  const plate = (id: string | undefined | null) => (id ? (ctx.repos.getVehicle(ctx.db, id)?.registration ?? '') : '').replace(/\s+/g, '').toUpperCase();
  const otherPlate: Partial<Record<string, string>> = { 'tp.registration': plate(claim?.clientVehicleId), 'vehicle.registration': plate(claim?.thirdPartyVehicleId) };
  for (const f of state.computed.draft.fields) {
    const target = BUNDLE_KEY_TARGET[f.key as BundleFieldKey];
    if (!target || !f.value) continue;
    const other = otherPlate[f.key];
    if (other && String(f.value).replace(/\s+/g, '').toUpperCase() === other) continue;
    const def = targetDef(target);
    if (!def) continue;
    const conflict = state.computed.conflicts.find((c) => c.key === f.key && c.status === 'open');
    const value = conflict ? (conflict.options.find((o) => o.preselected)?.value ?? f.value) : f.value;
    if (f.status === 'invalid') continue;
    const insp = def.inspect(snapshot, value);
    if (insp.unavailable) continue;
    if (insp.current && sameValue(insp.current, value)) continue;
    const a = buildAction({
      key: `d-${f.key}`,
      type: 'field_update',
      params: { target, value, current: insp.current ?? null },
      quote: f.source?.quote ?? null,
      source: 'catch_up',
      from: 'document',
      confidence: f.status === 'owner_set' ? 1 : f.confidence,
      detail: f.source ? `from ${f.source.label}` : null,
      tier: { overwrites: Boolean(insp.current) || insp.createsRecord, sensitive: def.sensitive, validatorOk: f.validator.ok, quoteVerified: null, confidence: f.confidence },
    });
    out.push(conflict ? { ...a, tier: 'confirm', ticked: false, why: `The documents disagree: ${conflict.options.map((o) => o.display).join(' / ')} — tick to use ${value}` } : a);
  }
  return out;
}

/** Plan the catch-up from the bundle state and store it on the input (+ per-file facts on the bundle files). */
export function planInput(ctx: AppContext, input: ClaimAiInputRecord, state?: BundleState): StoredInterpretation {
  if (!input.bundleId) throw new Error('not a catch-up input');
  const st = state ?? computeBundle(ctx, input.bundleId);
  const files = catchUpFiles(ctx, st, input);
  const timeline: CatchUpTimelineItem[] = st.computed.timeline.map((t) => ({ id: t.id, at: t.at, precision: t.precision, eventType: t.eventType, summary: t.summary, fileId: t.sources[0]?.fileId ?? null, confidence: t.confidence, ticked: t.ticked }));
  const plan = planCatchUp(files, claimFactsFor(ctx, input.claimId, input.id), identityFor(ctx), partyHintsFor(ctx, input.claimId), letterTitles(), { now: ctx.now(), autoMinConfidence: CLAIM_AI_DEFAULTS.catchUpAutoMinConfidence, timeline });
  const settled = files.every((f) => f.settled !== false) && catchUpSettled(ctx, st);
  const fields = settled ? fieldLines(ctx, st, input.claimId) : [];
  const now = ctx.now();
  for (const p of plan.files) {
    const f = st.files.find((x) => x.id === p.fileId);
    if (f) ctx.repos.updateBundleFile(ctx.db, f.id, { catchUp: p }, now);
  }
  const willDo = [...plan.willDo];
  if (fields.length) {
    const differ = fields.filter((a) => a.tier === 'confirm').length;
    willDo.splice(Math.max(0, willDo.length - 1), 0, `Check ${fields.length} detail${fields.length === 1 ? '' : 's'} against the claim${differ ? ` (${differ} differ${differ === 1 ? 's' : ''} — you decide)` : ''}`);
  }
  const prev = interpretationOf(input);
  // lines applied earlier stay visible even when the plan no longer proposes them
  const results = lineResults(ctx.repos.listAiInputLog(ctx.db, input.id));
  const actions = [...plan.actions, ...fields];
  for (const [key, r] of results) if (!actions.some((a) => a.key === key) && r.action) actions.push(r.action);
  return {
    ...prev,
    understood: input.text ? input.text.slice(0, 300) : null,
    actions,
    questions: [],
    pendingText: settled ? [] : ['files still being read'],
    catchUp: { files: plan.files, willDo, blockers: plan.blockers, bundleRevision: st.bundle.revision, settled },
  };
}

let titles: Array<{ templateId: string; title: string }> | null = null;
/** Template titles the outbound recogniser looks for ("New Claim Advice Form", …). */
function letterTitles(): Array<{ templateId: string; title: string }> {
  titles ??= listTemplates().map((t) => ({ templateId: t.id, title: t.title }));
  return titles;
}

/** The intake hook: after every reconcile of a catch-up bundle (§8.2, §8.7). */
export function catchUpAfterReconcile(ctx: AppContext, state: BundleState): void {
  const input = ctx.repos.findAiInputByBundle(ctx.db, state.bundle.id);
  if (!input || input.status === 'cancelled') return;
  const interp = planInput(ctx, input, state);
  const now = ctx.now();
  const settled = interp.catchUp?.settled ?? false;
  let status = input.status;
  if (input.status === 'reading' && settled && state.files.length) status = 'preview';
  if ((input.status === 'applied' || input.status === 'undone') && hasOpenLines(ctx, input.id, interp)) status = 'partly_applied';
  ctx.repos.updateAiInput(ctx.db, input.id, { interpretation: interp, status }, now);
  if (!settled || !input.autoApply || !['reading', 'preview'].includes(status)) return;
  const lastAdded = state.files.reduce((m, f) => (f.addedAt > m ? f.addedAt : m), '');
  const quietSince = Date.parse(now) - Date.parse(lastAdded || now) >= CLAIM_AI_DEFAULTS.filesDoneQuietMinutes * 60_000;
  if (input.filesDone || quietSince) {
    enqueueJob(ctx, { type: 'claim.catch_up_apply', payload: { inputId: input.id, bundleRevision: state.bundle.revision }, claimId: input.claimId, priority: 2, idempotencyKey: `claim.catch_up_apply:${input.id}:r${state.bundle.revision}`, createdBy: INTAKE_AGENT });
  } else {
    // re-check once the uploads have been quiet long enough
    const runAfter = new Date(Date.parse(lastAdded || now) + CLAIM_AI_DEFAULTS.filesDoneQuietMinutes * 60_000 + 1000).toISOString();
    enqueueJob(ctx, { type: 'intake.bundle_reconcile', payload: { bundleId: state.bundle.id, revision: state.bundle.revision }, runAfter, idempotencyKey: `intake.bundle_reconcile:${state.bundle.id}:r${state.bundle.revision}:quiet`, createdBy: INTAKE_AGENT });
  }
}

function hasOpenLines(ctx: AppContext, inputId: string, interp: StoredInterpretation): boolean {
  const results = lineResults(ctx.repos.listAiInputLog(ctx.db, inputId));
  return interp.actions.some((a) => !results.has(a.key) && (a.tier === 'apply' || a.tier === 'confirm'));
}

/** Re-plan now (owner overrides, files-done) without waiting for the next reconcile. */
export function replanNow(ctx: AppContext, input: ClaimAiInputRecord): ClaimAiInputRecord {
  if (!input.bundleId) return input;
  const state = computeBundle(ctx, input.bundleId);
  catchUpAfterReconcile(ctx, state);
  return ctx.repos.requireAiInput(ctx.db, input.id);
}

/** Owner: the upload queue is drained (§8.1). */
export function filesDone(ctx: AppContext, input: ClaimAiInputRecord, actorId: string): ClaimAiInputRecord {
  if (!input.filesDone) {
    ctx.repos.updateAiInput(ctx.db, input.id, { filesDone: true }, ctx.now());
    logInput(ctx, input, 'files_done', actorId);
  }
  return replanNow(ctx, ctx.repos.requireAiInput(ctx.db, input.id));
}

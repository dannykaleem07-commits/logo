// owned by intake-server
/**
 * Filing a group's files on a claim (docs/SMART-INTAKE.md §6.8). The originals stay claimless; the claim gets copies
 * through the evidence store (same sha on the claim → the existing row), with the kind its document type implies and a
 * plain description. Duplicates (same file / same text / near-same photo or letter) are linked, not filed twice —
 * unless the owner asks to file a copy; ZIP containers are not filed (their entries are); excluded files never.
 */
import type { DocType, EvidenceKind } from '@ccguk/domain';
import type { Actor, IntakeBundleFileRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { copyEvidenceToClaim } from '../../mail/common.js';
import { kindFromMime } from '../../services/imports.js';
import { docTypeLabel } from '../proposals.js';
import type { BundleState } from './recompute.js';

const KIND_BY_DOCTYPE: Partial<Record<DocType, EvidenceKind>> = {
  v5c: 'v5c',
  driving_licence: 'licence',
  insurance_certificate: 'insurance_certificate',
  police_report: 'document',
  fnol_form: 'document',
  proof_of_address: 'document',
  insurer_letter: 'correspondence',
  correspondence: 'correspondence',
  engineer_report: 'engineer_report',
  bodyshop_estimate: 'estimate',
  audatex_estimate: 'estimate',
  invoice: 'invoice',
  damage_photo: 'photo',
  vehicle_photo_other: 'photo',
  signed_ccguk_form: 'signed_document',
  bank_statement: 'bank_statement',
  payslip: 'payslip',
  mot_certificate: 'mot_certificate',
  witness_statement: 'witness_statement',
};

export function evidenceKindFor(docType: string | null, mime: string, role: IntakeBundleFileRecord['role']): EvidenceKind {
  if (role === 'email') return 'correspondence';
  if (role === 'pack') return 'pdf';
  const k = docType ? KIND_BY_DOCTYPE[docType as DocType] : undefined;
  if (k) return k;
  return kindFromMime(mime);
}

export interface FilingResult {
  evidence: number;
  duplicatesSkipped: number;
  /** bundle file id → claim-side evidence id */
  filed: Record<string, string>;
}

/**
 * File the given bundle files on the claim (idempotent: a file already filed there is counted, not copied again).
 * `copies` = duplicate file ids the owner asked to file too.
 */
export async function fileBundleEvidence(ctx: AppContext, state: BundleState, claimId: string, fileIds: string[], actor: Actor, opts: { copies?: Set<string> } = {}): Promise<FilingResult> {
  const out: FilingResult = { evidence: 0, duplicatesSkipped: 0, filed: {} };
  const name = state.bundle.name;
  const files = fileIds.map((id) => state.files.find((f) => f.id === id)).filter((f): f is IntakeBundleFileRecord => Boolean(f)).sort((a, b) => a.position - b.position);
  for (const f of files) {
    const c = state.computed.files[f.id];
    if (!c || c.excluded) continue;
    if (f.role === 'archive') continue;
    if (f.filedClaimId === claimId && f.filedEvidenceId) {
      out.filed[f.id] = f.filedEvidenceId;
      out.evidence += 1;
      continue;
    }
    const fc = state.fcs.get(f.id);
    if (!fc) continue;
    let description = `${c.docType ? docTypeLabel(c.docType) : fc.evidence.filename} — read by intake (bundle '${name}')`;
    if (c.duplicate) {
      if (!opts.copies?.has(f.id)) {
        out.duplicatesSkipped += 1;
        continue;
      }
      description += ` — copy of ${state.fcs.get(c.duplicate.of)?.evidence.filename ?? 'another file'}`;
    }
    if (f.role === 'segment' && f.pageFrom && f.pageTo) {
      const pack = f.parentFileId ? state.fcs.get(f.parentFileId) : undefined;
      description += ` — pages ${f.pageFrom}–${f.pageTo} of ${pack?.evidence.filename ?? 'the scanned pack'}`;
    }
    if (f.role === 'pack') {
      const n = state.files.filter((x) => x.parentFileId === f.id && x.role === 'segment').length;
      description = `${fc.evidence.filename} — original scanned pack${n ? `, split into ${n} documents` : ''} (bundle '${name}')`;
    }
    const kind = evidenceKindFor(c.docType, fc.evidence.mime, f.role);
    const ev = await copyEvidenceToClaim(ctx, f.evidenceId, claimId, actor, description.slice(0, 500), kind);
    ctx.repos.updateBundleFile(ctx.db, f.id, { filedEvidenceId: ev.id, filedClaimId: claimId, filedKind: ev.kind, filedAt: ctx.now() }, ctx.now());
    out.filed[f.id] = ev.id;
    out.evidence += 1;
  }
  return out;
}

/** Link the files' intake items to the claim (audited; no `intake.apply` re-run for bundle items). */
export function linkItemsToClaim(ctx: AppContext, state: BundleState, claimId: string, fileIds: string[], actor: Actor): number {
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  const now = ctx.now();
  let n = 0;
  for (const id of fileIds) {
    const f = state.files.find((x) => x.id === id);
    if (!f || state.computed.files[id]?.excluded) continue;
    const item = ctx.repos.getIntakeItem(ctx.db, f.intakeItemId);
    if (!item || item.claimId === claim.id) continue;
    if (item.claimId) continue; // already on another claim: left alone
    ctx.repos.updateIntakeItem(ctx.db, item.id, { claimId: claim.id }, now);
    ctx.repos.appendAudit(ctx.db, { actor, action: 'intake.attach_claim', entity: 'intake_items', entityId: item.id, after: { claimId: claim.id, claimRef: claim.reference, bundleId: state.bundle.id }, at: now });
    n += 1;
  }
  return n;
}

/**
 * Signature-date sanity (live-file lesson b, BLUEPRINT §3.8):
 *  - a document is never signed before it was created (creation-timestamp floor);
 *  - two agreements on one file signed on the same date raise an alert;
 *  - re-executed documents carry the actual signing date and a "re-executed on [date], supersedes version [n]" line.
 */
import type { ConsistencyFlag, GeneratedDocument, ISODate, ISODateTime } from '../types.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatLongDate(iso: ISODate | ISODateTime): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return `${d} ${MONTHS[mo - 1] ?? ''} ${y}`;
}

export function formatLongDateTime(iso: ISODateTime): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${formatLongDate(d.toISOString())} ${hh}:${mm} UTC`;
}

export function datePart(iso: ISODateTime | ISODate): ISODate {
  return iso.slice(0, 10);
}

/** Agreement-type templates: duplicate signature dates among these are suspicious. */
export function isAgreementTemplate(templateId: string): boolean {
  return templateId.startsWith('agreement.');
}

/**
 * DATE_BEFORE_CREATION (block) when a document's signature time precedes its creation time.
 * DUPLICATE_SIGNATURE_DATE (warn) when two agreement.* documents on the claim share a signing date
 * (one flag per date, listing the documents).
 */
export function signatureDateChecks(documents: GeneratedDocument[], claimId: string): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  const onFile = documents.filter((d) => d.claimId === claimId || (d.claimId === undefined && claimId === ''));

  for (const d of onFile) {
    const signedAt = d.signature?.signedAt;
    if (!signedAt) continue;
    if (Date.parse(signedAt) < Date.parse(d.createdAt)) {
      flags.push({
        code: 'DATE_BEFORE_CREATION',
        severity: 'block',
        message: `${d.title} (${d.id}) is recorded as signed on ${formatLongDateTime(signedAt)} but was created on ${formatLongDateTime(d.createdAt)}. A document cannot be signed before it exists.`,
        draftValue: signedAt,
        ledgerValue: d.createdAt,
        excerpt: d.id
      });
    }
  }

  const byDate = new Map<ISODate, GeneratedDocument[]>();
  for (const d of onFile) {
    if (!isAgreementTemplate(d.templateId) || !d.signature?.signedAt) continue;
    if (d.status === 'void' || d.status === 'superseded') continue;
    const day = datePart(d.signature.signedAt);
    const list = byDate.get(day) ?? [];
    list.push(d);
    byDate.set(day, list);
  }
  for (const [day, docs] of byDate) {
    if (docs.length < 2) continue;
    flags.push({
      code: 'DUPLICATE_SIGNATURE_DATE',
      severity: 'warn',
      message: `${docs.length} agreements on this file are signed on ${formatLongDate(day)}: ${docs.map((d) => `${d.title} (${d.templateId}, ${d.id})`).join('; ')}. Confirm each was genuinely signed that day; re-executed documents must carry the actual signing date and a re-execution line.`,
      draftValue: day,
      excerpt: docs.map((d) => d.id).join(',')
    });
  }

  return flags;
}

/** 're-executed on 4 October 2026, supersedes version 1.2.0' */
export function reExecutionLine(previous: Pick<GeneratedDocument, 'templateVersion'> & Partial<Pick<GeneratedDocument, 'id'>>, reExecutedOn: ISODate | ISODateTime, versionLabel?: string): string {
  const version = versionLabel ?? previous.templateVersion;
  return `re-executed on ${formatLongDate(reExecutedOn)}, supersedes version ${version}`;
}

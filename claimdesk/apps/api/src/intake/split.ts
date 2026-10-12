// owned by intake-server
/**
 * Scanned-pack splitting (docs/SMART-INTAKE.md §5.4, improvement 6). One PDF holding several documents is cut into
 * page ranges with pdf-lib (`copyPages`), each range stored as its own claimless (or same-claim) evidence and read as a
 * child intake item through the normal pipeline. The pack stays as it is (evidence is write-once); in its bundles it
 * becomes role `pack` and the children role `segment` with their page ranges. Encrypted PDFs are never split.
 *
 *   text PDFs     processItem builds page signals (per-page rules classification, "Page n of m", header, size) →
 *                 `splitPages` → follow-up `intake.split {source:'rules'}`
 *   scanned PDFs  the AI reading's `segments` (validated) → follow-up `intake.split {source:'ai'}`
 */
import { headerKeyOf, pageOfTotal, scoreText, sha1Hex, splitPages, topTypeOf, validateSegments, type DocType, type PageSignal, type Segment } from '@ccguk/domain';
import type { IntakeItemRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import type { EnqueueInput, JobOutcome, JobRecord } from '../agent/contracts.js';
import { readEvidenceVerified, stageBuffer } from '../services/evidence.js';
import { createItemFromStaged } from './items.js';
import type { NormalisedDoc } from './normalise.js';
import { insurerNames } from './rules.js';
import { childrenAdded, itemSettled } from './bundles/hooks.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const INTAKE_ACTOR = { userId: 'agent:intake' };

/** Page signals of a text PDF (rules classification per page). */
export function pageSignalsOf(doc: NormalisedDoc, insurers: string[]): PageSignal[] {
  const texts = doc.pageTexts ?? [];
  return texts.map((text, i) => {
    const scores = scoreText(text, { insurerNames: insurers, fingerprintTemplateId: null });
    const top = topTypeOf(scores);
    const size = doc.pageSizes?.[i] ?? { w: 595, h: 842 };
    return { index: i + 1, chars: text.trim().length, text, widthPt: size.w, heightPt: size.h, topType: top.type, topScore: top.top, secondScore: top.second, pageOfTotal: pageOfTotal(text), headerKey: headerKeyOf(text) };
  });
}

/** Segments of a text PDF by the rules ([] when it is one document). */
export function ruleSegments(ctx: AppContext, doc: NormalisedDoc, minPages: number): Segment[] {
  if (doc.kind !== 'pdf' || doc.scanned || (doc.pageTexts?.length ?? 0) < Math.max(2, minPages)) return [];
  return splitPages(pageSignalsOf(doc, insurerNames(ctx)), { minPages, minMargin: 2 });
}

/** AI segments of a scanned PDF, validated (null when not usable). */
export function aiSegments(raw: unknown, pageCount: number): Segment[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const segs: Segment[] = raw
    .filter((s): s is { fromPage: number; toPage: number; docType: string; confidence: number; title: string } => Boolean(s) && typeof s === 'object')
    .map((s) => ({ fromPage: Number(s.fromPage), toPage: Number(s.toPage), docType: s.docType as DocType, confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0)), title: String(s.title ?? '').slice(0, 200), why: 'read by the AI' }));
  return validateSegments(segs, pageCount);
}

export function splitFollowUp(item: IntakeItemRecord, job: JobRecord, segments: Segment[], source: 'rules' | 'ai'): EnqueueInput {
  const key = sha1Hex(JSON.stringify(segments.map((s) => [s.fromPage, s.toPage])), 12);
  return {
    type: 'intake.split',
    payload: { itemId: item.id, segments, source },
    ...(item.claimId ? { claimId: item.claimId } : {}),
    idempotencyKey: `intake.split:${item.id}:${key}`,
    parentJobId: job.id,
    createdBy: INTAKE_ACTOR.userId,
  };
}

interface PdfLibModule {
  PDFDocument: {
    load(bytes: Uint8Array, opts?: { ignoreEncryption?: boolean; updateMetadata?: boolean }): Promise<{ getPageCount(): number; isEncrypted: boolean }>;
    create(): Promise<{ copyPages(src: unknown, idx: number[]): Promise<unknown[]>; addPage(p: unknown): void; save(opts?: { useObjectStreams?: boolean }): Promise<Uint8Array> }>;
  };
}

let pdfLib: PdfLibModule | undefined;
function loadPdfLib(): PdfLibModule {
  if (!pdfLib) pdfLib = createRequire(import.meta.url)('pdf-lib') as PdfLibModule;
  return pdfLib;
}

const pagesLabel = (s: Segment) => (s.fromPage === s.toPage ? `page ${s.fromPage}` : `pages ${s.fromPage}-${s.toPage}`);

/** intake.split: cut the pack into its segments and read each as a child item. Idempotent per segment set. */
export async function splitItem(ctx: AppContext, item: IntakeItemRecord, job: JobRecord, segments: Segment[], source: 'rules' | 'ai'): Promise<JobOutcome> {
  const ev = ctx.repos.requireEvidence(ctx.db, item.evidenceId);
  const read = await readEvidenceVerified(ctx, ev);
  if (!read?.intact) return { kind: 'fail', reason: 'evidence tampered or missing', deadLetter: true };
  const bytes = await readFile(read.absolutePath);
  const { PDFDocument } = loadPdfLib();
  let src: Awaited<ReturnType<PdfLibModule['PDFDocument']['load']>>;
  try {
    src = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: false, updateMetadata: false });
  } catch (err) {
    itemSettled(ctx, item.id);
    return { kind: 'done', result: { split: false, reason: `not split: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) } };
  }
  if (src.isEncrypted) {
    itemSettled(ctx, item.id);
    return { kind: 'done', result: { split: false, reason: 'encrypted PDF' } };
  }
  const pageCount = src.getPageCount();
  const valid = validateSegments(segments, pageCount);
  if (!valid) {
    itemSettled(ctx, item.id);
    return { kind: 'done', result: { split: false, reason: 'segments do not cover the pack' } };
  }
  const existing = ctx.repos.listIntakeItems(ctx.db, { parentItemId: item.id, limit: 1000 });
  const base = ev.filename.replace(/\.pdf$/i, '');
  const children: Array<{ itemId: string; evidenceId: string; pageFrom: number; pageTo: number }> = [];
  for (const seg of valid) {
    const out = await PDFDocument.create();
    const idx = Array.from({ length: seg.toPage - seg.fromPage + 1 }, (_, i) => seg.fromPage - 1 + i);
    const pages = await out.copyPages(src, idx);
    for (const p of pages) out.addPage(p);
    const buf = Buffer.from(await out.save());
    const filename = `${base} (${pagesLabel(seg)}).pdf`;
    const already = existing.find((c) => ctx.repos.getEvidence(ctx.db, c.evidenceId)?.filename === filename);
    if (already) {
      children.push({ itemId: already.id, evidenceId: already.evidenceId, pageFrom: seg.fromPage, pageTo: seg.toPage });
      continue;
    }
    const { item: child } = await createItemFromStaged(ctx, {
      source: item.source,
      ...(item.claimId ? { claimId: item.claimId } : {}),
      parentItemId: item.id,
      staged: stageBuffer(ctx, buf),
      filename,
      mime: 'application/pdf',
      actor: INTAKE_ACTOR,
      description: seg.fromPage === seg.toPage ? `Page ${seg.fromPage} of ${ev.filename}` : `Pages ${seg.fromPage}–${seg.toPage} of ${ev.filename}`,
    });
    children.push({ itemId: child.id, evidenceId: child.evidenceId, pageFrom: seg.fromPage, pageTo: seg.toPage });
  }
  childrenAdded(ctx, item, children.map((c) => ({ ...c, role: 'segment' as const })));
  ctx.repos.appendAudit(ctx.db, {
    actor: INTAKE_ACTOR,
    action: 'intake.split_pack',
    entity: 'intake_items',
    entityId: item.id,
    after: { source, segments: valid.map((s) => ({ fromPage: s.fromPage, toPage: s.toPage, docType: s.docType })), children: children.map((c) => c.itemId) },
    at: ctx.now(),
  });
  itemSettled(ctx, item.id);
  return { kind: 'done', result: { split: true, segments: valid.length, children: children.map((c) => c.itemId) } };
}

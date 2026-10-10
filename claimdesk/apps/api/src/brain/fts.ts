// owned by casework
/**
 * The librarian (docs/SUPREME-DESIGN.md §C.1, §E.4): keeps the claim corpus `search_docs` current (`index.fts`) and
 * brings staged brain packs in (`brain.import`). `brain_fts` itself is kept in sync by the 0011 triggers; this module
 * only rebuilds it on request.
 *
 *   index.fts {sourceKind, sourceId}   one source: email | document | evidence_text | transcript | note
 *   index.fts {sourceKind: 'sweep'}    the 10-minute schedule: recent emails / documents / memory notes not yet indexed,
 *                                      and a brain.import job for every staged file in the brain-packs import folder
 */
import { readFileSync } from 'node:fs';
import type { SearchDocKind } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { htmlToText } from '../agent/tools/core.js';
import { enqueueJob } from '../agent/core.js';
import { readEvidenceVerified } from '../services/evidence.js';
import { listStagedImports } from '../services/imports.js';

export const SEARCH_DOC_KINDS: readonly SearchDocKind[] = ['email', 'document', 'evidence_text', 'transcript', 'note'];
const MAX_BODY = 200_000;

export interface IndexResult {
  indexed: boolean;
  reason?: string;
}

async function pdfPlainText(bytes: Buffer, maxPages = 60): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push((content.items as Array<{ str?: string }>).map((it) => it.str ?? '').join(' '));
      page.cleanup();
    }
    return pages.join('\n').replace(/[ \t]+/g, ' ').trim();
  } finally {
    await task.destroy();
  }
}

/** Index one source (re-indexing replaces its row). Never throws for a missing source: it reports why. */
export async function indexSource(ctx: AppContext, sourceKind: SearchDocKind, sourceId: string): Promise<IndexResult> {
  switch (sourceKind) {
    case 'email': {
      const m = ctx.repos.getMailMessage(ctx.db, sourceId);
      if (!m) return { indexed: false, reason: 'message not found' };
      ctx.repos.upsertSearchDoc(ctx.db, { sourceKind, sourceId, claimId: m.claimId ?? null, title: m.subject ?? '(no subject)', body: `${m.fromName ?? ''} ${m.fromAddr ?? ''}\n${m.bodyText ?? ''}`.slice(0, MAX_BODY), at: m.sentAt ?? m.receivedAt });
      return { indexed: true };
    }
    case 'document': {
      const d = ctx.repos.getDocument(ctx.db, sourceId, { includeHtml: true });
      if (!d) return { indexed: false, reason: 'document not found' };
      ctx.repos.upsertSearchDoc(ctx.db, { sourceKind, sourceId, claimId: d.claimId ?? null, title: d.title, body: htmlToText(d.html ?? '').slice(0, MAX_BODY), at: d.createdAt });
      return { indexed: true };
    }
    case 'evidence_text': {
      const e = ctx.repos.getEvidence(ctx.db, sourceId);
      if (!e) return { indexed: false, reason: 'evidence not found' };
      const read = await readEvidenceVerified(ctx, e);
      if (!read?.intact) return { indexed: false, reason: 'evidence file missing or does not match its hash' };
      let text = '';
      if (/^text\//.test(e.mime) || /\.(txt|md|csv)$/i.test(e.filename)) text = readFileSync(read.absolutePath, 'utf8');
      else if (e.mime === 'application/pdf' || /\.pdf$/i.test(e.filename)) {
        try {
          text = await pdfPlainText(readFileSync(read.absolutePath));
        } catch (err) {
          return { indexed: false, reason: `PDF text not readable: ${err instanceof Error ? err.message : String(err)}` };
        }
      } else return { indexed: false, reason: `no text layer for ${e.mime}` };
      if (!text.trim()) return { indexed: false, reason: 'no text (scanned image without a text layer)' };
      ctx.repos.upsertSearchDoc(ctx.db, { sourceKind, sourceId, claimId: e.claimId ?? null, title: e.filename, body: text.slice(0, MAX_BODY), at: e.capturedAt ?? e.uploadedAt });
      return { indexed: true };
    }
    case 'note': {
      const ev = ctx.repos.getEvent(ctx.db, sourceId);
      if (ev) {
        ctx.repos.upsertSearchDoc(ctx.db, { sourceKind, sourceId, claimId: ev.claimId, title: `${ev.type.replace(/_/g, ' ')} note`, body: ev.summary.slice(0, MAX_BODY), at: ev.at });
        return { indexed: true };
      }
      const m = ctx.repos.getMemoryItem(ctx.db, sourceId);
      if (m) {
        const claimId = m.scope.startsWith('claim:') ? m.scope.slice('claim:'.length) : null;
        ctx.repos.upsertSearchDoc(ctx.db, { sourceKind, sourceId, claimId, title: `${m.kind} note`, body: m.text.slice(0, MAX_BODY), at: m.createdAt });
        return { indexed: true };
      }
      return { indexed: false, reason: 'note not found' };
    }
    case 'transcript':
      return { indexed: false, reason: 'call transcripts arrive in Phase 2' };
  }
}

export interface SweepResult {
  indexed: number;
  skipped: number;
  brainImports: string[];
}

/** The scheduled sweep: index what is missing (bounded per pass) and queue staged brain packs. */
export async function sweepIndex(ctx: AppContext, opts: { limit?: number; parentJobId?: string; correlationId?: string } = {}): Promise<SweepResult> {
  const limit = opts.limit ?? 200;
  let indexed = 0;
  let skipped = 0;
  const todo: Array<[SearchDocKind, string]> = [];
  for (const m of ctx.repos.listMailMessages(ctx.db, { limit: 500 })) if (m.claimId && !ctx.repos.hasSearchDoc(ctx.db, 'email', m.id)) todo.push(['email', m.id]);
  for (const d of ctx.repos.listDocuments(ctx.db, { limit: 500 })) if (d.claimId && !ctx.repos.hasSearchDoc(ctx.db, 'document', d.id)) todo.push(['document', d.id]);
  for (const n of ctx.repos.listMemoryItems(ctx.db, { status: 'approved', limit: 500 })) if (!ctx.repos.hasSearchDoc(ctx.db, 'note', n.id)) todo.push(['note', n.id]);
  for (const [kind, id] of todo.slice(0, limit)) {
    const r = await indexSource(ctx, kind, id);
    if (r.indexed) indexed += 1;
    else skipped += 1;
  }
  const brainImports: string[] = [];
  try {
    for (const imp of listStagedImports(ctx, { purpose: 'brain-packs', status: 'staged' })) {
      const job = enqueueJob(ctx, { type: 'brain.import', payload: { importId: imp.id }, idempotencyKey: `brain.import:${imp.sha256}`, createdBy: 'system', ...(opts.parentJobId ? { parentJobId: opts.parentJobId } : {}), ...(opts.correlationId ? { correlationId: opts.correlationId } : {}) });
      brainImports.push(job.id);
    }
  } catch (err) {
    ctx.logger.warn('brain.import: could not list staged packs', { error: String(err) });
  }
  return { indexed, skipped, brainImports };
}

/** Queue indexing of one source (deduplicated by the §C.2 key). */
export function queueIndex(ctx: AppContext, sourceKind: SearchDocKind, sourceId: string, extra: { claimId?: string; createdBy?: string; parentJobId?: string; correlationId?: string } = {}): void {
  try {
    enqueueJob(ctx, { type: 'index.fts', payload: { sourceKind, sourceId }, idempotencyKey: `index.fts:${sourceKind}:${sourceId}`, createdBy: extra.createdBy ?? 'system', ...(extra.parentJobId ? { parentJobId: extra.parentJobId } : {}), ...(extra.correlationId ? { correlationId: extra.correlationId } : {}) });
  } catch (err) {
    ctx.logger.warn('index.fts not queued', { error: String(err), sourceKind, sourceId });
  }
}

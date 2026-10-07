// owned by intake
/**
 * Normalisation (docs/SUPREME-DESIGN.md §G.2 step 2): the sniffed bytes → what the extractor needs.
 *
 *  - PDF: per-page text with pdfjs-dist 6.4.299 (legacy build — the one that runs in Node; Apache-2.0). A PDF with no
 *    text layer is marked `scanned` and goes to the model as the PDF itself.
 *  - Images: JPEG, PNG, GIF and WebP pass through to the model as they are. HEIC/HEIF cannot be read in Phase 1: the
 *    owner is asked to export it as JPEG (Phase 2 converts it with Windows WIC).
 *  - DOCX: plain text through the existing scanner in @ccguk/documents (`docxToPlainText`).
 *  - EML: the message (headers + text body) plus its attachments, each of which becomes a child intake item.
 *  - Plain text: as it is.
 *  - Audio (Calls), CAB/Jet/SQLite (engineer data), MSG, ZIP and the rest: skipped with the reason (Phase 2 or never).
 */
import { createHash } from 'node:crypto';
import { docxToPlainText } from '@ccguk/documents';
import { MODEL_IMAGE_KINDS, sniff, type SniffedKind, type SniffedType } from './sniff.js';

/** Cap on the text kept per item (the model sees at most this). */
export const MAX_TEXT_CHARS = 200_000;
/** Below this many characters per page on average a PDF counts as scanned (no usable text layer). */
export const SCANNED_CHARS_PER_PAGE = 20;
/** Pages read for text (a longer PDF keeps its page count; text stops here). */
export const MAX_TEXT_PAGES = 200;

export interface EmailMeta {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  messageId?: string;
}

export interface NormalisedAttachment {
  filename: string;
  mime: string;
  bytes: number;
}

/** What is stored on the intake item (`normalised` JSON). Raw attachment bytes are not part of it. */
export interface NormalisedDoc {
  kind: 'pdf' | 'image' | 'docx' | 'email' | 'text' | 'heic' | 'skipped';
  sniffed: SniffedKind;
  mime: string;
  extensionMatches: boolean;
  pages?: number;
  /** Per-page text (PDF), or one entry for other text sources. */
  pageTexts?: string[];
  /** PDF without a usable text layer: the model reads the PDF itself. */
  scanned?: boolean;
  textChars?: number;
  textTruncated?: boolean;
  email?: EmailMeta;
  attachments?: NormalisedAttachment[];
  /** Why the item was skipped (Phase 2 or not a document). */
  skipReason?: string;
  /** Built-in CCGUK form detected by its printed labels (intake/fingerprint.ts). */
  fingerprint?: { templateId: string; title: string; score: number; matched: number; total: number } | null;
  /** Set by the new-claim resolver when a draft was prepared from this item. */
  newClaimDraftId?: string;
  /** Built-in form id the extractor reported. */
  formTemplateId?: string | null;
}

export interface NormaliseResult {
  doc: NormalisedDoc;
  /** Attachments of an email, to become child items (bytes kept in memory only). */
  attachments: Array<NormalisedAttachment & { content: Buffer }>;
  /** sha256 of the extracted text (undefined when there is none). */
  textSha256?: string;
}

const SKIP_REASONS: Partial<Record<SniffedKind, string>> = {
  wav: 'Audio goes to Calls (Phase 2), not intake',
  mp3: 'Audio goes to Calls (Phase 2), not intake',
  m4a: 'Audio goes to Calls (Phase 2), not intake',
  ogg: 'Audio goes to Calls (Phase 2), not intake',
  webm: 'Audio/video goes to Calls (Phase 2), not intake',
  mp4: 'Video is kept as evidence; intake does not read video',
  cab: 'A CAB file is engineer data (Phase 2 import), never intake',
  jet: 'An Access database is engineer data (Phase 2 import), never intake',
  sqlite: 'A database file is not a document intake can read',
  msg: 'Outlook .msg files are read in Phase 2 — save the message as .eml (File → Save As) or forward it to the claims mailbox',
  ole: 'Old Office (.doc/.xls) files cannot be read yet — save as .docx or PDF',
  xlsx: 'Spreadsheets are not read by intake',
  zip: 'A ZIP archive is not unpacked by intake — extract it and add the files',
  unknown: 'The file type was not recognised',
};

const clean = (s: string): string => s.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function capPages(pages: string[]): { pages: string[]; truncated: boolean; chars: number } {
  let left = MAX_TEXT_CHARS;
  let truncated = false;
  const out: string[] = [];
  for (const p of pages) {
    if (left <= 0) {
      truncated = true;
      out.push('');
      continue;
    }
    if (p.length > left) {
      out.push(p.slice(0, left));
      truncated = true;
      left = 0;
    } else {
      out.push(p);
      left -= p.length;
    }
  }
  return { pages: out, truncated, chars: out.reduce((n, p) => n + p.length, 0) };
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Per-page text of a PDF with pdfjs-dist (legacy build). Throws on an unreadable / encrypted PDF. */
export async function pdfText(bytes: Buffer, maxPages = MAX_TEXT_PAGES): Promise<{ numPages: number; pages: string[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs transfers the buffer it is given: hand it a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== 'string') continue;
        text += item.str + (item.hasEOL ? '\n' : item.str && !item.str.endsWith(' ') ? ' ' : '');
      }
      pages.push(clean(text));
      page.cleanup();
    }
    return { numPages: doc.numPages, pages };
  } finally {
    await task.destroy();
  }
}

function emailText(meta: EmailMeta, body: string, attachments: NormalisedAttachment[]): string {
  const lines = [
    meta.from ? `From: ${meta.from}` : '',
    meta.to ? `To: ${meta.to}` : '',
    meta.cc ? `Cc: ${meta.cc}` : '',
    meta.date ? `Date: ${meta.date}` : '',
    meta.subject ? `Subject: ${meta.subject}` : '',
    attachments.length ? `Attachments: ${attachments.map((a) => a.filename).join(', ')}` : '',
  ].filter(Boolean);
  return clean(`${lines.join('\n')}\n\n${body}`);
}

/** Plain text of an HTML body (no tags, scripts or styles; entities decoded for the common cases). */
export function htmlToPlain(html: string): string {
  return clean(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

/** Parse an RFC 822 message with mailparser (MIT). */
export async function parseEmail(bytes: Buffer): Promise<{ meta: EmailMeta; body: string; attachments: Array<NormalisedAttachment & { content: Buffer }> }> {
  const { simpleParser } = await import('mailparser');
  const parsed = await simpleParser(bytes, { skipImageLinks: true, skipTextToHtml: true });
  const addr = (v: unknown): string | undefined => {
    if (!v) return undefined;
    const list = Array.isArray(v) ? v : [v];
    const text = list.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text: string }).text) : '')).filter(Boolean).join(', ');
    return text || undefined;
  };
  const meta: EmailMeta = {
    ...(addr(parsed.from) ? { from: addr(parsed.from) } : {}),
    ...(addr(parsed.to) ? { to: addr(parsed.to) } : {}),
    ...(addr(parsed.cc) ? { cc: addr(parsed.cc) } : {}),
    ...(parsed.subject ? { subject: parsed.subject } : {}),
    ...(parsed.date ? { date: parsed.date.toISOString() } : {}),
    ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
  };
  const body = parsed.text?.trim() ? parsed.text : typeof parsed.html === 'string' ? htmlToPlain(parsed.html) : '';
  const attachments = (parsed.attachments ?? [])
    .filter((a) => a.content && a.content.length > 0 && !(a.related && a.contentDisposition === 'inline' && /^image\//.test(a.contentType ?? '') && (a.size ?? 0) < 10_000))
    .map((a, i) => ({ filename: a.filename || `attachment-${i + 1}`, mime: a.contentType || 'application/octet-stream', bytes: a.content.length, content: Buffer.from(a.content) }));
  return { meta, body, attachments };
}

/** Normalise one file. Never throws for unsupported types (they come back `skipped`); throws for a corrupt PDF/DOCX. */
export async function normalise(bytes: Buffer, filename: string, sniffed: SniffedType = sniff(bytes, filename)): Promise<NormaliseResult> {
  const base = { sniffed: sniffed.kind, mime: sniffed.mime, extensionMatches: sniffed.extensionMatches };
  switch (sniffed.kind) {
    case 'pdf': {
      const { numPages, pages } = await pdfText(bytes);
      const capped = capPages(pages);
      const scanned = capped.chars / Math.max(pages.length, 1) < SCANNED_CHARS_PER_PAGE;
      const joined = capped.pages.join('\n\f\n');
      return {
        doc: { ...base, kind: 'pdf', pages: numPages, pageTexts: scanned ? [] : capped.pages, scanned, textChars: scanned ? 0 : capped.chars, ...(capped.truncated || numPages > pages.length ? { textTruncated: true } : {}) },
        attachments: [],
        ...(scanned ? {} : { textSha256: sha(joined) }),
      };
    }
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'webp':
      return { doc: { ...base, kind: 'image', pages: 1 }, attachments: [] };
    case 'heic':
      return { doc: { ...base, kind: 'heic', pages: 1, skipReason: 'HEIC/HEIF photos are not read in Phase 1 — export the photo as JPEG and add it again' }, attachments: [] };
    case 'docx': {
      const text = clean(docxToPlainText(new Uint8Array(bytes)));
      const capped = capPages([text]);
      return { doc: { ...base, kind: 'docx', pages: 1, pageTexts: capped.pages, textChars: capped.chars, ...(capped.truncated ? { textTruncated: true } : {}) }, attachments: [], ...(text ? { textSha256: sha(text) } : {}) };
    }
    case 'eml': {
      const { meta, body, attachments } = await parseEmail(bytes);
      const metaAttachments = attachments.map(({ filename: f, mime, bytes: n }) => ({ filename: f, mime, bytes: n }));
      const text = emailText(meta, body, metaAttachments);
      const capped = capPages([text]);
      return {
        doc: { ...base, kind: 'email', pages: 1, pageTexts: capped.pages, textChars: capped.chars, email: meta, attachments: metaAttachments, ...(capped.truncated ? { textTruncated: true } : {}) },
        attachments,
        ...(text ? { textSha256: sha(text) } : {}),
      };
    }
    case 'text': {
      const text = clean(bytes.toString('utf8').replace(/^﻿/, ''));
      const capped = capPages([text]);
      return { doc: { ...base, kind: 'text', pages: 1, pageTexts: capped.pages, textChars: capped.chars, ...(capped.truncated ? { textTruncated: true } : {}) }, attachments: [], ...(text ? { textSha256: sha(text) } : {}) };
    }
    default:
      return { doc: { ...base, kind: 'skipped', skipReason: SKIP_REASONS[sniffed.kind] ?? 'Not a document intake can read' }, attachments: [] };
  }
}

/** Whether the model gets the file itself (scanned PDF, image) rather than (or as well as) its text. */
export function needsFileAttachment(doc: NormalisedDoc): 'pdf' | 'image' | undefined {
  if (doc.kind === 'pdf' && doc.scanned) return 'pdf';
  if (doc.kind === 'image' && MODEL_IMAGE_KINDS.has(doc.sniffed)) return 'image';
  return undefined;
}

/** The document text with page markers, as the extractor sees it inside <untrusted_document>. */
export function documentText(doc: NormalisedDoc): string {
  const pages = doc.pageTexts ?? [];
  if (!pages.length) return '';
  if (pages.length === 1) return pages[0]!;
  return pages.map((t, i) => `--- page ${i + 1} ---\n${t}`).join('\n\n');
}

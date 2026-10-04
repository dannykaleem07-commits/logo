/**
 * stampPdfMetadata() (§A.11.1, §A.12): every PDF ClaimDesk produces carries Author 'Courtesy Cars Group UK Ltd',
 * Creator 'ClaimDesk', Producer 'ClaimDesk — Courtesy Cars Group UK Ltd', Title/Subject/Keywords and Language en-GB.
 * Callers stamp BEFORE hashing. pdf-lib writes the strings as UTF-16 hex; read them back with PDFDocument getters.
 */
import { PDFDocument } from 'pdf-lib';
import { DOCX_APPLICATION_NAME, DOCX_COMPANY_NAME, DOCX_PDF_PRODUCER, type PdfMetadata } from './types.js';

export interface StampMetadata extends PdfMetadata {
  creator?: string;
  producer?: string;
  language?: string;
}

export async function stampPdfMetadata(pdf: Uint8Array, meta: StampMetadata): Promise<{ pdf: Buffer; pages: number }> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  doc.setTitle(meta.title, { showInWindowTitleBar: true });
  doc.setAuthor(meta.author ?? DOCX_COMPANY_NAME);
  if (meta.subject) doc.setSubject(meta.subject);
  if (meta.keywords?.length) doc.setKeywords(meta.keywords);
  doc.setCreator(meta.creator ?? DOCX_APPLICATION_NAME);
  doc.setProducer(meta.producer ?? DOCX_PDF_PRODUCER);
  doc.setLanguage(meta.language ?? 'en-GB');
  const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { pdf: Buffer.from(out), pages: doc.getPageCount() };
}

/**
 * DOCX template engine — public surface (design doc §A). Re-exported from packages/documents/src/index.ts.
 *
 *   const scan = scanDocx(bytes);                                   // slots, blocks, outline, warnings, text
 *   const { docx, sha256, report } = fillDocx(bytes, instructions, { coreProps, now });
 *   const { pdf, sha256, converter } = await convertDocxToPdf(docx, { workDir, metadata });
 *
 * The engine fills blanks in place; it never rewrites printed wording. DOCX templates are NOT registered in the HTML
 * template registry.
 */
export {
  DEFAULT_DOCX_LIMITS,
  DOCX_APPLICATION_NAME,
  DOCX_COMPANY_NAME,
  DOCX_PDF_PRODUCER,
  DocxError,
  SCANNER_VERSION,
  SIGNATURE_RE,
  type BlankPattern,
  type ConvertDocxOptions,
  type ConvertDocxResult,
  type ConverterStatus,
  type CorePropsInput,
  type DocxBlock,
  type DocxIssue,
  type DocxLimits,
  type DocxPackage,
  type DocxPdfConverter,
  type DocxPdfConverterId,
  type DocxPdfPreference,
  type DocxSafetyReport,
  type DocxScan,
  type DocxSlot,
  type FillInstruction,
  type FillOptions,
  type FillReport,
  type FillResult,
  type FillSkipReason,
  type HeaderFooterText,
  type LetterContent,
  type PdfMetadata,
  type RunStyle,
  type SlotKind,
  type SlotValue
} from './types.js';
export { openDocx, writeDocx } from './zip.js';
export { listParts, partDom } from './xml.js';
export { checkDocxSafety } from './safety.js';
export { normaliseText, paragraphText, replaceRange, slugify, type ParaText, type RunPiece } from './text.js';
export { scanDocx } from './scan.js';
export { fillDocx, MAX_VALUE_LENGTH } from './fill.js';
export { setDocxProperties } from './props.js';
export { docxToPlainText, docxToPreviewHtml, extractHeaderFooter } from './preview.js';
export { stampPdfMetadata, type StampMetadata } from './pdfmeta.js';
export { convertDocxToPdf, detectDocxConverters, DocxConversionError, CONVERTER_ORDER } from './convert/index.js';

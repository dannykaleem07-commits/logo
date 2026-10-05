/**
 * DOCX template engine — every public type (design doc §A).
 *
 * The engine fills blanks in the user's Word files in place; it never rewrites printed wording. Types here are the
 * contract other slices (fields, templates-api, templates-web) code against, so names and shapes follow the design
 * document exactly. Engine-internal extras are marked as such.
 */
import type { Document } from '@xmldom/xmldom';

/** Registered company name stamped into document properties and PDF metadata. */
export const DOCX_COMPANY_NAME = 'Courtesy Cars Group UK Ltd';
/** Application name written to docProps/app.xml and the PDF Creator. */
export const DOCX_APPLICATION_NAME = 'ClaimDesk';
/** PDF Producer string (§A.11.1). */
export const DOCX_PDF_PRODUCER = 'ClaimDesk — Courtesy Cars Group UK Ltd';

// ---------------------------------------------------------------------------
// Package model (§A.2)
// ---------------------------------------------------------------------------

export interface DocxPackage {
  /** Every zip entry, in original order. XML parts are kept as bytes until first parsed. */
  entries: Map<string, Uint8Array>;
  order: string[];
  /** Parsed DOM cache (part name → Document); written back by writeDocx. */
  dom: Map<string, Document>;
  /** Engine-internal: parts whose DOM was changed and must be re-serialised (others are written byte-identical). */
  dirty?: Set<string>;
}

// ---------------------------------------------------------------------------
// Safety (§A.3)
// ---------------------------------------------------------------------------

export interface DocxLimits {
  /** 15 MiB (upload route limit). */
  maxCompressedBytes: number;
  /** 1000. */
  maxEntries: number;
  /** 60 MiB. */
  maxTotalUncompressed: number;
  /** 30 MiB. */
  maxEntryUncompressed: number;
  /** 100 (only checked for entries whose uncompressed size > 1 MiB). */
  maxRatio: number;
  /** 50 000 (scan guard). */
  maxParagraphs: number;
}

export const DEFAULT_DOCX_LIMITS: DocxLimits = Object.freeze({
  maxCompressedBytes: 15 * 1024 * 1024,
  maxEntries: 1000,
  maxTotalUncompressed: 60 * 1024 * 1024,
  maxEntryUncompressed: 30 * 1024 * 1024,
  maxRatio: 100,
  maxParagraphs: 50_000
});

export interface DocxIssue {
  code: string;
  message: string;
  part?: string;
}

export interface DocxSafetyReport {
  ok: boolean;
  errors: DocxIssue[];
  warnings: DocxIssue[];
}

export class DocxError extends Error {
  readonly code: string;
  readonly part?: string;
  constructor(code: string, message?: string, part?: string) {
    super(message ?? (part ? `${code} (${part})` : code));
    this.name = 'DocxError';
    this.code = code;
    if (part !== undefined) this.part = part;
  }
}

// ---------------------------------------------------------------------------
// Scan (§A.5, §A.6)
// ---------------------------------------------------------------------------

export type SlotKind =
  | 'cell' // label cell → value cell (empty run, run-less paragraph, or empty cell)
  | 'inline' // label run + empty value run in the same paragraph (03 Parties / Vehicle particulars)
  | 'line' // bottom-bordered paragraph after a label paragraph (signature-style blocks)
  | 'blank' // underscore/space pattern inside a run (date, money, reference, number+unit, text)
  | 'bracket' // [placeholder] text
  | 'token' // {{key}} or {{key|format}} (uploaded templates)
  | 'control' // w:sdt content control (text) with w:tag / w:alias
  | 'mergefield' // MERGEFIELD (simple or complex field)
  | 'checkbox' // one ☐ that is a yes/no on its own (paragraph checkbox, single inline glyph, w14:checkbox)
  | 'choice' // several ☐ options that belong together (one paragraph / one run)
  | 'block' // single-cell box with a label (free text, big tcMar)
  | 'table' // repeating rows: header row + ≥ 2 empty data rows (witnesses, damage log, chronology)
  | 'paragraphs'; // repeating numbered paragraphs (witness statement body, letterhead body)

export type BlankPattern =
  | 'date'
  | 'datetime'
  | 'time'
  | 'month-year'
  | 'money'
  | 'reference'
  | 'number'
  | 'percent'
  | 'eighths'
  | 'page-of'
  | 'text';

export interface DocxSlot {
  id: string;
  kind: SlotKind;
  /** 'word/document.xml' | 'word/header1.xml' … */
  part: string;
  /** Same slot found in several byte-identical header/footer parts (02 header1/3/4). */
  parts?: string[];
  /** Slugs, outer → inner. */
  sectionPath: string[];
  /** Human titles. */
  sectionTitles: string[];
  /** Column / cell-heading slug. */
  qualifier?: string;
  qualifierTitle?: string;
  /** Decoded human label. */
  label: string;
  labelSlug: string;
  /** 1-based among slots with the same (sectionPath, qualifier, labelSlug). */
  ordinal: number;
  /** '1', '2' … for several blanks in one paragraph. */
  sub?: string;
  /** Current text of the target ('' when empty). */
  preview: string;
  blank?: { pattern: BlankPattern; text: string; hasCurrency: boolean; prefix?: string; unit?: string };
  options?: Array<{ slug: string; label: string; checked: boolean; blank?: { pattern: BlankPattern; text: string } }>;
  /** 'table'. */
  columns?: Array<{ slug: string; label: string }>;
  /** 'table' | 'paragraphs': template rows present. */
  rowCount?: number;
  /** 'paragraphs': fixed text before the bracket in item 1 (letterhead opening sentence). */
  fixedLead?: string;
  /** 'token'. */
  token?: { key: string; format?: string };
  /** Label/heading matches SIGNATURE_RE → the engine never fills it. */
  signature: boolean;
  /** Grey-italic placeholder styling (restyle on fill). */
  hint: boolean;
  /** Value cell width (UI uses it to warn about long values). */
  widthTwips?: number;
  /** 'block', gridSpan ≥ 3 cells, 'paragraphs'. */
  multiline: boolean;
  /** DocxBlock the slot sits in. */
  blockId?: string;
}

export interface DocxBlock {
  id: string;
  title: string;
  part: string;
  /** Index of the first body child (w:body element children) in the block. */
  startIndex: number;
  /** Index one past the last body child in the block (exclusive). */
  endIndex: number;
}

export interface DocxScan {
  /** SCANNER_VERSION, bump when ids could change. */
  scannerVersion: number;
  sha256: string;
  slots: DocxSlot[];
  blocks: DocxBlock[];
  outline: Array<{ level: 1 | 2; title: string; slug: string }>;
  warnings: DocxIssue[];
  /** Plain text of the unfilled template (baseline for consistency checks, §C.6). */
  text: string;
  stats: { paragraphs: number; tables: number; parts: number; ms: number };
}

export const SCANNER_VERSION = 1;

export const SIGNATURE_RE = /\b(signature|signed|sign here|initials?|initial here)\b/i;

// ---------------------------------------------------------------------------
// Fill (§A.7)
// ---------------------------------------------------------------------------

export type SlotValue =
  | { type: 'text'; text: string } // '\n' → <w:br/>
  | { type: 'check'; checked: boolean }
  | { type: 'choice'; selected: string[]; blanks?: Record<string, string> } // option slugs; text for blanks inside options
  | { type: 'rows'; rows: Array<Record<string, string>> } // keys = column slugs
  | { type: 'paragraphs'; items: string[]; replaceFixedLead?: boolean; headings?: number[]; tables?: ParagraphTable[] }
  | { type: 'remove'; scope: 'paragraph' | 'row' }; // remove the containing paragraph / table row

/**
 * A table in a numbered-paragraphs body (an HTML letter's figures table): printed as a real Word table in place of
 * item `index`, unnumbered. `rows` are cell texts; the first `headerRows` rows print bold.
 */
export interface ParagraphTable {
  index: number;
  rows: string[][];
  headerRows?: number;
}

export interface FillInstruction {
  slotId: string;
  value: SlotValue;
}

export interface RunStyle {
  font?: string;
  sizeHalfPoints?: number;
  color?: string;
  bold?: boolean;
}

export interface CorePropsInput {
  title: string;
  subject?: string;
  keywords?: string[];
  description?: string;
  created: Date;
  modified: Date;
}

export interface FillOptions {
  /** DocxBlock ids (prefix match). */
  removeBlocks?: string[];
  /** §A.8. */
  coreProps: CorePropsInput;
  /** Zip mtime + dcterms:modified. */
  now: Date;
  /** Default style for inserted runs (mapping 'style.valueRun'). */
  valueRunStyle?: RunStyle;
  /**
   * A user's own template: a value put into an empty paragraph with no style of its own inherits the document's
   * font and size (no run properties) instead of the CCGUK built-ins' Calibri 9 pt.
   */
  inheritValueStyle?: boolean;
  /** Type-level guarantee: signature slots are never filled. */
  allowSignatureSlots?: false;
}

export type FillSkipReason = 'NOT_FOUND' | 'SIGNATURE_SLOT' | 'TYPE_MISMATCH' | 'OPTION_NOT_FOUND' | 'EMPTY_VALUE';

export interface FillReport {
  filled: string[];
  removed: string[];
  skipped: Array<{ slotId: string; reason: FillSkipReason }>;
}

export interface FillResult {
  docx: Uint8Array;
  sha256: string;
  report: FillReport;
}

// ---------------------------------------------------------------------------
// Letterhead composition (§A.10 — implemented by the fields slice in docx/fields/letterhead.ts)
// ---------------------------------------------------------------------------

export interface LetterContent {
  /** Default true (template prints it). */
  privateAndConfidential?: boolean;
  recipient: { attention?: string; department?: string; name: string; addressLines: string[]; email?: string };
  /** Display strings. */
  refs: { ourRef: string; yourRef?: string; claimNo?: string; client?: string; vehicle?: string; dateOfAccident?: string; date: string };
  /** 'Sir or Madam' | 'Ms Patel'. */
  salutation: string;
  subject: string;
  subjectClient?: string;
  subjectReg?: string;
  /** Numbered automatically (except the headings and tables below). */
  paragraphs: string[];
  /** Indexes into `paragraphs` printed as unnumbered bold headings (h2, a box title, a table caption). */
  headings?: number[];
  /** Items printed as real Word tables, unnumbered (the item text is the tab-joined fallback). */
  tables?: ParagraphTable[];
  /** True when the paragraphs already contain an opening (HTML letters). */
  replaceFixedOpening: boolean;
  /** Display date; sentence removed when absent. */
  replyBy?: string;
  /** Derived from salutation when absent. */
  valediction?: 'sincerely' | 'faithfully';
  /** `role` as signed in the HTML letter; replaces the letterhead's printed "Claims Manager" when it differs. */
  signatory: { name: string; role?: string };
  enclosures?: string[];
  cc?: string[];
}

// ---------------------------------------------------------------------------
// Preview (§A.9)
// ---------------------------------------------------------------------------

export interface HeaderFooterText {
  firstHeader?: string;
  header?: string;
  firstFooter?: string;
  footer?: string;
  titlePage: boolean;
  hasPageFields: boolean;
}

// ---------------------------------------------------------------------------
// DOCX → PDF (§A.11)
// ---------------------------------------------------------------------------

export type DocxPdfConverterId = 'word' | 'libreoffice' | 'browser';
export type DocxPdfPreference = 'auto' | DocxPdfConverterId;

export interface ConverterStatus {
  ok: boolean;
  detail?: string;
  path?: string;
}

export interface DocxPdfConverter {
  id: DocxPdfConverterId;
  detect(): Promise<ConverterStatus>;
  convert(input: { docxPath: string; outDir: string; header: HeaderFooterText; timeoutMs: number }): Promise<string /* pdf path */>;
}

export interface PdfMetadata {
  title: string;
  subject?: string;
  keywords?: string[];
  /** Default registered name. */
  author?: string;
}

export interface ConvertDocxOptions {
  /** Default from env DOCX_PDF_CONVERTER, else 'auto'. */
  preference?: DocxPdfPreference;
  /** Temp dir under DATA_DIR (API passes <DATA_DIR>/tmp/convert). */
  workDir: string;
  /** Per attempt; default word 90 000, libreoffice 90 000, browser 60 000. */
  timeoutMs?: number;
  metadata: PdfMetadata;
  /** Test injection. */
  converters?: DocxPdfConverter[];
}

export interface ConvertDocxResult {
  pdf: Buffer;
  sha256: string;
  pages: number;
  converter: DocxPdfConverterId;
  attempts: Array<{ id: DocxPdfConverterId; ok: boolean; ms: number; error?: string }>;
}

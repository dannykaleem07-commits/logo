/**
 * Tiny synthetic .docx builders for unit tests (built in-test with fflate; no binary fixtures).
 *
 *   const bytes = docx(body(p(r('01', { b: true }), r('     '), r('Customer details', { b: true })), tbl(...)));
 */
import { strToU8, zipSync, type Zippable } from 'fflate';

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';
export const NS_ATTRS = `xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:w14="${W14_NS}"`;
export const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface RunOpts {
  b?: boolean;
  i?: boolean;
  caps?: boolean;
  color?: string;
  sz?: number;
  font?: string;
}

export function rPr(o: RunOpts = {}): string {
  const parts: string[] = [];
  if (o.font) parts.push(`<w:rFonts w:ascii="${o.font}" w:hAnsi="${o.font}"/>`);
  if (o.b) parts.push('<w:b/>');
  if (o.i) parts.push('<w:i/>');
  if (o.caps) parts.push('<w:caps/>');
  if (o.color) parts.push(`<w:color w:val="${o.color}"/>`);
  if (o.sz) parts.push(`<w:sz w:val="${o.sz}"/>`);
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

/** A run with text (tabs as <w:tab/>, newlines as <w:br/>). */
export function r(text: string, o: RunOpts = {}): string {
  const inner = text
    .split(/(\t|\n)/)
    .map((seg) => (seg === '\t' ? '<w:tab/>' : seg === '\n' ? '<w:br/>' : seg.length ? `<w:t xml:space="preserve">${esc(seg)}</w:t>` : ''))
    .join('');
  return `<w:r>${rPr(o)}${inner}</w:r>`;
}

/** An empty run (empty w:t) — the CCGUK value-run shape. */
export function emptyRun(o: RunOpts = {}): string {
  return `<w:r>${rPr(o)}<w:t xml:space="preserve"></w:t></w:r>`;
}

export interface ParaOpts {
  style?: string;
  pageBreakBefore?: boolean;
  bottomBorder?: boolean;
  markRPr?: RunOpts;
  sectPr?: string;
}

export function p(content: string | string[] = '', o: ParaOpts = {}): string {
  const pPr: string[] = [];
  if (o.style) pPr.push(`<w:pStyle w:val="${o.style}"/>`);
  if (o.pageBreakBefore) pPr.push('<w:pageBreakBefore/>');
  if (o.bottomBorder) pPr.push('<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="C6CBD6"/></w:pBdr>');
  if (o.markRPr) pPr.push(rPr(o.markRPr));
  if (o.sectPr) pPr.push(o.sectPr);
  const body = Array.isArray(content) ? content.join('') : content;
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${body}</w:p>`;
}

/** Shorthand: paragraph of one plain run. */
export function pt(text: string, o: RunOpts = {}, po: ParaOpts = {}): string {
  return p(text ? r(text, o) : '', po);
}

export interface CellOpts {
  w?: number;
  fill?: string;
  span?: number;
  vMerge?: 'restart' | 'continue';
  bottomOnly?: boolean;
  mar?: { top: number; bottom: number };
}

export function tc(content: string | string[], o: CellOpts = {}): string {
  const tcPr: string[] = [`<w:tcW w:w="${o.w ?? 2400}" w:type="dxa"/>`];
  if (o.span) tcPr.push(`<w:gridSpan w:val="${o.span}"/>`);
  if (o.vMerge) tcPr.push(o.vMerge === 'restart' ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>');
  if (o.bottomOnly) tcPr.push('<w:tcBorders><w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="none"/></w:tcBorders>');
  if (o.fill) tcPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>`);
  if (o.mar) tcPr.push(`<w:tcMar><w:top w:w="${o.mar.top}" w:type="dxa"/><w:bottom w:w="${o.mar.bottom}" w:type="dxa"/></w:tcMar>`);
  const body = Array.isArray(content) ? content.join('') : content;
  return `<w:tc><w:tcPr>${tcPr.join('')}</w:tcPr>${body || '<w:p/>'}</w:tc>`;
}

export function tr(cells: string[], o: { header?: boolean; height?: number } = {}): string {
  const trPr: string[] = [];
  if (o.header) trPr.push('<w:tblHeader/>');
  if (o.height !== undefined) trPr.push(`<w:trHeight w:val="${o.height}"/>`);
  return `<w:tr>${trPr.length ? `<w:trPr>${trPr.join('')}</w:trPr>` : ''}${cells.join('')}</w:tr>`;
}

export function tbl(rows: string[], grid: number[]): string {
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${grid.map((g) => `<w:gridCol w:w="${g}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;
}

/** Label cell (grey bold label on a tint) → value cell, the CCGUK form shape. */
export function labelCell(label: string, w = 2300): string {
  return tc(p(r(label, { b: true, color: '8A8F9B', sz: 14 })), { w, fill: 'F4F6FA' });
}

export function valueCell(content = '', w = 2500): string {
  return tc(p(content ? r(content, { color: '3F4552', sz: 19 }) : emptyRun({ color: '3F4552', sz: 19 })), { w });
}

/** Numbered section heading `01     Title` (CCGUK shape). */
export function heading(num: string, title: string): string {
  return p([r(num, { b: true, color: '04347F', sz: 26 }), r('     ', { sz: 20 }), r(title, { b: true, color: '0D1C50', sz: 21 })], { bottomBorder: true });
}

export const SECT_PR =
  '<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:footerReference w:type="default" r:id="rIdF1"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';

export function documentXml(bodyXml: string, sectPr = SECT_PR): string {
  return `${DECL}<w:document ${NS_ATTRS}><w:body>${bodyXml}${sectPr}</w:body></w:document>`;
}

export function hdrXml(content: string, kind: 'hdr' | 'ftr' = 'hdr'): string {
  return `${DECL}<w:${kind} ${NS_ATTRS}>${content}</w:${kind}>`;
}

export const STYLES_XML = `${DECL}<w:styles ${NS_ATTRS}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>`;

export const MAIN_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

export interface DocxSpec {
  body: string;
  sectPr?: string;
  /** header/footer part name (e.g. 'word/header1.xml') → inner XML. */
  headers?: Record<string, string>;
  footers?: Record<string, string>;
  /** Content type of word/document.xml (to test .docm refusal). */
  mainContentType?: string;
  /** Extra document relationships (raw <Relationship/> elements). */
  extraRels?: string;
  /** Extra parts (name → content). */
  extraParts?: Record<string, string | Uint8Array>;
  /** Omit a standard part. */
  omit?: string[];
  mtime?: Date;
}

export function buildDocx(spec: DocxSpec): Uint8Array {
  const headers = spec.headers ?? { 'word/header1.xml': p(r('COURTESY CARS GROUP UK LTD')) };
  const footers = spec.footers ?? { 'word/footer1.xml': p(r('Courtesy Cars Group UK Ltd · Registered in England & Wales No. 17430389')) };
  const overrides: string[] = [
    `<Override PartName="/word/document.xml" ContentType="${spec.mainContentType ?? MAIN_CT}"/>`,
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  ];
  const rels: string[] = ['<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'];
  let hi = 1;
  for (const name of Object.keys(headers)) {
    overrides.push(`<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`);
    rels.push(`<Relationship Id="rIdH${hi++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="${name.replace('word/', '')}"/>`);
  }
  let fi = 1;
  for (const name of Object.keys(footers)) {
    overrides.push(`<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`);
    rels.push(`<Relationship Id="rIdF${fi++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="${name.replace('word/', '')}"/>`);
  }
  if (spec.extraRels) rels.push(spec.extraRels);
  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${overrides.join('')}</Types>`,
    '_rels/.rels': `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    'word/document.xml': documentXml(spec.body, spec.sectPr ?? SECT_PR),
    'word/_rels/document.xml.rels': `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
    'word/styles.xml': STYLES_XML,
    'docProps/core.xml': `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Template</dc:title><dc:creator>Someone Else</dc:creator><cp:lastModifiedBy>Un-named</cp:lastModifiedBy><cp:revision>3</cp:revision></cp:coreProperties>`
  };
  for (const [name, inner] of Object.entries(headers)) files[name] = hdrXml(inner, 'hdr');
  for (const [name, inner] of Object.entries(footers)) files[name] = hdrXml(inner, 'ftr');
  for (const [name, content] of Object.entries(spec.extraParts ?? {})) files[name] = content;
  for (const name of spec.omit ?? []) delete files[name];
  const zippable: Zippable = {};
  for (const [name, content] of Object.entries(files)) zippable[name] = [typeof content === 'string' ? strToU8(content) : content, { level: 6, mtime: spec.mtime ?? new Date(2026, 0, 1) }];
  return zipSync(zippable);
}

/** Convenience: a document from body XML only. */
export function docx(bodyXml: string, extra: Omit<DocxSpec, 'body'> = {}): Uint8Array {
  return buildDocx({ ...extra, body: bodyXml });
}

/** Raw zip from name → content (for zip/safety tests). */
export function rawZip(files: Record<string, string | Uint8Array>, level = 6): Uint8Array {
  const z: Zippable = {};
  for (const [name, content] of Object.entries(files)) z[name] = [typeof content === 'string' ? strToU8(content) : content, { level: level as 6, mtime: new Date(2026, 0, 1) }];
  return zipSync(z);
}

/** URL of a real asset (tests read packages/documents/assets/docx). */
export function assetUrl(file: string): URL {
  return new URL(`../../../assets/docx/${file}`, import.meta.url);
}

export const ASSETS = {
  '01': 'CCGUK-01-Customer-Agreement-and-Letter-of-Authority.docx',
  '02': 'CCGUK-02_Recovery_Storage_Engineering_Pack_TEMPLATE_v5.docx',
  '03': 'CCGUK-03-Vehicle-Credit-Hire-Agreement.docx',
  '04': 'CCGUK-04-Witness-Statement.docx',
  '05': 'CCGUK-05-Payment-Authorisation-and-Settlement-Direction.docx',
  '06': 'CCGUK-06-Vehicle-Handover-and-Condition-Report.docx',
  '07': 'CCGUK-07-Statement-of-Means.docx',
  '08': 'CCGUK-08-Intervention-and-Mitigation-Record.docx',
  '09': 'CCGUK-09-Accident-Report-Form.docx',
  letterhead: 'CCGUK-Letterhead-Formal.docx'
} as const;

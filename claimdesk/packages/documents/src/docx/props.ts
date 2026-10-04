/**
 * Document properties (§A.8): docProps/core.xml and docProps/app.xml.
 *
 * core.xml: dc:creator = cp:lastModifiedBy = 'Courtesy Cars Group UK Ltd', dc:title, dc:subject, cp:keywords,
 * dc:description, dcterms:created/modified (W3CDTF); cp:revision and cp:lastPrinted are dropped.
 * app.xml: <Application>ClaimDesk</Application><Company>Courtesy Cars Group UK Ltd</Company> (no AppVersion).
 * Either part, its [Content_Types].xml override and its _rels/.rels relationship are created when missing.
 */
import type { Element } from '@xmldom/xmldom';
import { DOCX_APPLICATION_NAME, DOCX_COMPANY_NAME, type CorePropsInput, type DocxPackage } from './types.js';
import { hasPart, markDirty, NS, parseXml, partDom, setPartDom, XML_DECLARATION } from './xml.js';

const CORE = 'docProps/core.xml';
const APP = 'docProps/app.xml';
const CT_CORE = 'application/vnd.openxmlformats-package.core-properties+xml';
const CT_APP = 'application/vnd.openxmlformats-officedocument.extended-properties+xml';
const REL_CORE = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
const REL_APP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties';

function xmlEscape(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** W3CDTF (ISO 8601, seconds precision, UTC). */
export function w3cdtf(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function setDocxProperties(pkg: DocxPackage, input: CorePropsInput): void {
  const parts: string[] = [];
  parts.push(`<dc:title>${xmlEscape(input.title)}</dc:title>`);
  if (input.subject) parts.push(`<dc:subject>${xmlEscape(input.subject)}</dc:subject>`);
  parts.push(`<dc:creator>${xmlEscape(DOCX_COMPANY_NAME)}</dc:creator>`);
  if (input.keywords?.length) parts.push(`<cp:keywords>${xmlEscape(input.keywords.join('; '))}</cp:keywords>`);
  if (input.description) parts.push(`<dc:description>${xmlEscape(input.description)}</dc:description>`);
  parts.push(`<cp:lastModifiedBy>${xmlEscape(DOCX_COMPANY_NAME)}</cp:lastModifiedBy>`);
  parts.push(`<dcterms:created xsi:type="dcterms:W3CDTF">${w3cdtf(input.created)}</dcterms:created>`);
  parts.push(`<dcterms:modified xsi:type="dcterms:W3CDTF">${w3cdtf(input.modified)}</dcterms:modified>`);
  const core =
    `${XML_DECLARATION}\n<cp:coreProperties xmlns:cp="${NS.cp}" xmlns:dc="${NS.dc}" xmlns:dcterms="${NS.dcterms}" xmlns:dcmitype="${NS.dcmitype}" xmlns:xsi="${NS.xsi}">` +
    `${parts.join('')}</cp:coreProperties>`;
  setPartDom(pkg, CORE, parseXml(core, CORE));

  const app =
    `${XML_DECLARATION}\n<Properties xmlns="${NS.ep}" xmlns:vt="${NS.vt}">` +
    `<Application>${xmlEscape(DOCX_APPLICATION_NAME)}</Application><Company>${xmlEscape(DOCX_COMPANY_NAME)}</Company></Properties>`;
  setPartDom(pkg, APP, parseXml(app, APP));

  ensureContentTypeOverride(pkg, `/${CORE}`, CT_CORE);
  ensureContentTypeOverride(pkg, `/${APP}`, CT_APP);
  ensurePackageRel(pkg, REL_CORE, CORE);
  ensurePackageRel(pkg, REL_APP, APP);
}

function ensureContentTypeOverride(pkg: DocxPackage, partName: string, contentType: string): void {
  const ct = partDom(pkg, '[Content_Types].xml');
  const root = ct.documentElement as unknown as Element;
  const overrides = root.getElementsByTagNameNS(NS.ct, 'Override');
  for (let i = 0; i < overrides.length; i++) {
    const o = overrides[i]!;
    if ((o.getAttribute('PartName') ?? '').toLowerCase() === partName.toLowerCase()) {
      if (o.getAttribute('ContentType') !== contentType) {
        o.setAttribute('ContentType', contentType);
        markDirty(pkg, '[Content_Types].xml');
      }
      return;
    }
  }
  const el = ct.createElementNS(NS.ct, 'Override');
  el.setAttribute('PartName', partName);
  el.setAttribute('ContentType', contentType);
  root.appendChild(el);
  markDirty(pkg, '[Content_Types].xml');
}

function ensurePackageRel(pkg: DocxPackage, type: string, target: string): void {
  const relsPart = '_rels/.rels';
  if (!hasPart(pkg, relsPart)) {
    setPartDom(pkg, relsPart, parseXml(`${XML_DECLARATION}\n<Relationships xmlns="${NS.rels}"/>`, relsPart));
  }
  const doc = partDom(pkg, relsPart);
  const root = doc.documentElement as unknown as Element;
  const rels = root.getElementsByTagNameNS(NS.rels, 'Relationship');
  const ids = new Set<string>();
  for (let i = 0; i < rels.length; i++) {
    const r = rels[i]!;
    ids.add(r.getAttribute('Id') ?? '');
    if (r.getAttribute('Type') === type) return;
  }
  let n = 1;
  while (ids.has(`rId${n}`)) n++;
  const el = doc.createElementNS(NS.rels, 'Relationship');
  el.setAttribute('Id', `rId${n}`);
  el.setAttribute('Type', type);
  el.setAttribute('Target', target);
  root.appendChild(el);
  markDirty(pkg, relsPart);
}

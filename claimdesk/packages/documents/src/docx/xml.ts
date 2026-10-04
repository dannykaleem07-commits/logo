/**
 * XML parse/serialise (@xmldom/xmldom), namespace helpers and small WordprocessingML utilities (§A.2).
 *
 * Rules: DTDs/entities are refused before parsing; any parser error is `DocxError('INVALID_XML', part)`; only parts
 * that were touched are re-serialised (`markDirty`); values are inserted as DOM text nodes (the serialiser escapes).
 */
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom';
import { DocxError, type DocxPackage } from './types.js';

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  xml: 'http://www.w3.org/XML/1998/namespace',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  dcmitype: 'http://purl.org/dc/dcmitype/',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  ep: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  vt: 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'
} as const;

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/** XML-illegal control characters (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F). */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function stripControlChars(s: string): string {
  return s.replace(ILLEGAL_XML_CHARS, '');
}

export function decodeUtf8(bytes: Uint8Array): string {
  let s = decoder.decode(bytes);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

export function encodeUtf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** True when the XML text declares a DTD or an entity (refused: XXE / billion laughs). */
export function hasDtd(xml: string): boolean {
  return /<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml);
}

export function parseXml(xml: string, part: string): Document {
  if (hasDtd(xml)) throw new DocxError('XML_DTD_REFUSED', `DTDs and entities are not allowed (${part})`, part);
  let failure: string | undefined;
  let doc: Document;
  try {
    doc = new DOMParser({
      onError: (level: string, message: string) => {
        if (level === 'error' || level === 'fatalError') failure ??= String(message);
      }
    }).parseFromString(xml, 'text/xml');
  } catch (err) {
    throw new DocxError('INVALID_XML', `Invalid XML in ${part}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`, part);
  }
  if (failure !== undefined) throw new DocxError('INVALID_XML', `Invalid XML in ${part}: ${failure.split('\n')[0]}`, part);
  if (!doc.documentElement) throw new DocxError('INVALID_XML', `Empty XML part ${part}`, part);
  return doc;
}

export function serializeXml(doc: Document): string {
  let s = new XMLSerializer().serializeToString(doc);
  if (!s.startsWith('<?xml')) s = `${XML_DECLARATION}\n${s}`;
  return s;
}

/** Parsed DOM for a part (cached on the package). Throws DocxError('PART_MISSING') when the entry does not exist. */
export function partDom(pkg: DocxPackage, part: string): Document {
  const cached = pkg.dom.get(part);
  if (cached) return cached;
  const bytes = pkg.entries.get(part);
  if (!bytes) throw new DocxError('PART_MISSING', `Missing part ${part}`, part);
  const doc = parseXml(decodeUtf8(bytes), part);
  pkg.dom.set(part, doc);
  return doc;
}

export function hasPart(pkg: DocxPackage, part: string): boolean {
  return pkg.entries.has(part);
}

/** Entry names matching `re`, in package order (e.g. /^word\/(header|footer)\d+\.xml$/). */
export function listParts(pkg: DocxPackage, re: RegExp): string[] {
  return pkg.order.filter((name) => {
    re.lastIndex = 0;
    return re.test(name);
  });
}

/** Mark a part as changed so writeDocx re-serialises it. */
export function markDirty(pkg: DocxPackage, part: string): void {
  if (!pkg.dirty) pkg.dirty = new Set();
  pkg.dirty.add(part);
}

/** Replace a part with a new DOM (creating the entry when missing). */
export function setPartDom(pkg: DocxPackage, part: string, doc: Document): void {
  if (!pkg.entries.has(part)) {
    pkg.entries.set(part, new Uint8Array(0));
    pkg.order.push(part);
  }
  pkg.dom.set(part, doc);
  markDirty(pkg, part);
}

// ---------------------------------------------------------------------------
// Element helpers
// ---------------------------------------------------------------------------

export function isElement(n: Node | null | undefined): n is Element {
  return !!n && n.nodeType === ELEMENT_NODE;
}

export function isText(n: Node | null | undefined): boolean {
  return !!n && n.nodeType === TEXT_NODE;
}

/** Local name of an element ('p' for w:p). */
export function ln(el: Node): string {
  const e = el as Element;
  return e.localName ?? (e.nodeName.includes(':') ? e.nodeName.slice(e.nodeName.indexOf(':') + 1) : e.nodeName);
}

/** True when `el` is a WordprocessingML element with local name `name`. */
export function isW(el: Node | null | undefined, name: string): el is Element {
  return isElement(el) && el.namespaceURI === NS.w && ln(el) === name;
}

export function childElements(el: Element | Document): Element[] {
  const out: Element[] = [];
  for (let c = el.firstChild; c; c = c.nextSibling) if (isElement(c)) out.push(c);
  return out;
}

export function wChildren(el: Element, name?: string): Element[] {
  const out: Element[] = [];
  for (let c = el.firstChild; c; c = c.nextSibling) if (isElement(c) && c.namespaceURI === NS.w && (name === undefined || ln(c) === name)) out.push(c);
  return out;
}

export function wChild(el: Element | null | undefined, name: string): Element | undefined {
  if (!el) return undefined;
  for (let c = el.firstChild; c; c = c.nextSibling) if (isElement(c) && c.namespaceURI === NS.w && ln(c) === name) return c;
  return undefined;
}

/** First descendant w:<name> (depth-first), optionally not descending into elements matched by `stop`. */
export function wDescendant(el: Element, name: string): Element | undefined {
  const list = el.getElementsByTagNameNS(NS.w, name);
  return list.length > 0 ? (list[0] as Element) : undefined;
}

export function wDescendants(el: Element | Document, name: string): Element[] {
  const list = el.getElementsByTagNameNS(NS.w, name);
  const out: Element[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i] as Element);
  return out;
}

/** w:val (or another w: attribute) of an element. */
export function wAttr(el: Element | null | undefined, name = 'val'): string | undefined {
  if (!el) return undefined;
  const v = el.getAttributeNS(NS.w, name);
  if (v !== null && v !== '') return v;
  const q = el.getAttribute(`w:${name}`);
  return q === null || q === '' ? undefined : q;
}

export function setWAttr(el: Element, name: string, value: string): void {
  el.setAttributeNS(NS.w, `w:${name}`, value);
}

/** On/off property (w:b, w:i, w:caps …): present and not val=false/0/off. */
export function onOff(prop: Element | undefined): boolean | undefined {
  if (!prop) return undefined;
  const v = wAttr(prop);
  if (v === undefined) return true;
  return !(v === 'false' || v === '0' || v === 'off');
}

export function createW(doc: Document, name: string): Element {
  return doc.createElementNS(NS.w, `w:${name}`);
}

/** New <w:t xml:space="preserve">text</w:t>. Control characters are stripped. */
export function createT(doc: Document, text: string): Element {
  const t = createW(doc, 't');
  t.setAttributeNS(NS.xml, 'xml:space', 'preserve');
  t.appendChild(doc.createTextNode(stripControlChars(text)));
  return t;
}

/** Set the text of a w:t element (DOM text node, xml:space="preserve"). */
export function setTText(t: Element, text: string): void {
  while (t.firstChild) t.removeChild(t.firstChild);
  t.appendChild(t.ownerDocument!.createTextNode(stripControlChars(text)));
  t.setAttributeNS(NS.xml, 'xml:space', 'preserve');
}

export function textContent(el: Node): string {
  return (el as Element).textContent ?? '';
}

export function insertAfter(newNode: Node, ref: Node): void {
  const parent = ref.parentNode;
  if (!parent) return;
  if (ref.nextSibling) parent.insertBefore(newNode, ref.nextSibling);
  else parent.appendChild(newNode);
}

export function removeNode(n: Node | null | undefined): void {
  if (n && n.parentNode) n.parentNode.removeChild(n);
}

/** Nearest ancestor (or self) w:<name>. */
export function closestW(el: Node | null, name: string): Element | undefined {
  for (let cur: Node | null = el; cur; cur = cur.parentNode) if (isW(cur, name)) return cur;
  return undefined;
}

/** Document order of all w:p in a part (used as a stable paragraph address). */
export function allParagraphs(doc: Document): Element[] {
  return wDescendants(doc, 'p');
}

/** w:body of word/document.xml. */
export function bodyOf(doc: Document): Element {
  const body = wDescendant(doc.documentElement as unknown as Element, 'body');
  if (!body) throw new DocxError('INVALID_DOCX', 'word/document.xml has no w:body', 'word/document.xml');
  return body;
}

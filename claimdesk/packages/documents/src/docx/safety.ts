/**
 * checkDocxSafety() — the upload gate (§A.3). Shares its limits with zip.ts.
 *
 * Errors (refused): not a zip, bad entry names, duplicates, size/ratio/count limits, missing main parts, a main part
 * that is not a plain document/template (macro-enabled .docm/.dotm), vbaProject.bin, ActiveX parts, altChunk
 * relationships, external attachedTemplate/oleObject/frame/subDocument relationships, links other than http/https/
 * mailto (relationships and HYPERLINK fields), XML parts that are not UTF-8 (a UTF-16 part would hide a DTD), DTDs/
 * entities, and any XML part that does not parse.
 * Warnings: external images, embedded OLE objects, legacy form fields, tracked changes, comments.
 */
import { DocxError, type DocxIssue, type DocxLimits, type DocxSafetyReport } from './types.js';
import { unzipChecked } from './zip.js';
import { decodeUtf8, hasDtd, NS, parseXml } from './xml.js';

export const MAIN_CONTENT_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'
] as const;

const REFUSED_EXTERNAL = ['attachedTemplate', 'oleObject', 'frame', 'subDocument'];

/** Why raw XML bytes are not plain UTF-8 (a UTF-16/32 byte-order mark, NUL bytes, another declared encoding). */
export function xmlEncodingProblem(bytes: Uint8Array): string | undefined {
  const b0 = bytes[0];
  const b1 = bytes[1];
  if ((b0 === 0xfe && b1 === 0xff) || (b0 === 0xff && b1 === 0xfe)) return 'is UTF-16 encoded';
  if (b0 === 0x00 && b1 === 0x00) return 'is UTF-32 encoded';
  if (bytes.includes(0)) return 'contains NUL bytes';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const decl = /^(?:\uFEFF|\u00EF\u00BB\u00BF)?\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(head);
  if (decl && !/^utf-?8$/i.test(decl[1]!.trim())) return `declares the encoding ${decl[1]}`;
  return undefined;
}

/** The URL scheme of a link target, after removing what browsers ignore (whitespace and control characters). */
export function linkScheme(target: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const t = target.replace(/[\u0000-\u0020]+/g, '');
  return /^([a-z][a-z0-9+.-]*):/i.exec(t)?.[1]?.toLowerCase();
}

/** http, https and mailto links, and plain relative or #bookmark targets, are safe to keep in a document. */
export function safeLinkTarget(target: string): boolean {
  const scheme = linkScheme(target);
  if (scheme) return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
  // a relative target with a colon before any path character could still be read as a scheme by some viewer
  // eslint-disable-next-line no-control-regex
  const t = target.replace(/[\u0000-\u0020]+/g, '');
  const colon = t.indexOf(':');
  return colon < 0 || /[/?#]/.test(t.slice(0, colon));
}

function relType(type: string): string {
  const i = type.lastIndexOf('/');
  return i >= 0 ? type.slice(i + 1) : type;
}

export function checkDocxSafety(bytes: Uint8Array, limits?: Partial<DocxLimits>): DocxSafetyReport {
  const errors: DocxIssue[] = [];
  const warnings: DocxIssue[] = [];
  const done = (): DocxSafetyReport => ({ ok: errors.length === 0, errors, warnings });

  let entries: Map<string, Uint8Array>;
  let order: string[];
  try {
    ({ entries, order } = unzipChecked(bytes, limits));
  } catch (err) {
    if (err instanceof DocxError) errors.push({ code: err.code, message: err.message, ...(err.part ? { part: err.part } : {}) });
    else errors.push({ code: 'BAD_ZIP', message: String(err) });
    return done();
  }

  if (!entries.has('[Content_Types].xml')) errors.push({ code: 'MISSING_CONTENT_TYPES', message: 'The package has no [Content_Types].xml', part: '[Content_Types].xml' });
  if (!entries.has('word/document.xml')) errors.push({ code: 'MISSING_DOCUMENT', message: 'The package has no word/document.xml', part: 'word/document.xml' });

  // Every XML part: encoding first (a UTF-16 part would hide a DTD from the text checks), then DTD/entity refusal
  // (never parse a DTD).
  const xmlText = new Map<string, string>();
  for (const name of order) {
    if (!/\.(xml|rels)$/i.test(name)) continue;
    const raw = entries.get(name)!;
    const encoding = xmlEncodingProblem(raw);
    if (encoding) {
      errors.push({ code: 'XML_ENCODING_REFUSED', message: `${name} ${encoding}; only UTF-8 XML parts are accepted`, part: name });
      continue;
    }
    const text = decodeUtf8(raw);
    if (hasDtd(text)) {
      errors.push({ code: 'XML_DTD_REFUSED', message: `${name} declares a DTD or entity`, part: name });
      continue;
    }
    xmlText.set(name, text);
  }

  for (const name of order) {
    const lower = name.toLowerCase();
    if (lower.endsWith('vbaproject.bin') || lower.endsWith('vbadata.xml')) errors.push({ code: 'MACROS_REFUSED', message: 'The document contains macros (vbaProject.bin)', part: name });
    if (/(^|\/)activex\//i.test(name) || /activex\d*\.(xml|bin)$/i.test(name)) errors.push({ code: 'ACTIVEX_REFUSED', message: 'The document contains ActiveX controls', part: name });
    if (/^word\/embeddings\//i.test(name)) warnings.push({ code: 'EMBEDDED_OBJECT', message: `Embedded object ${name.slice('word/embeddings/'.length)}`, part: name });
  }

  // Content types: the main part must be a plain document or template.
  const ct = xmlText.get('[Content_Types].xml');
  if (ct !== undefined) {
    try {
      const doc = parseXml(ct, '[Content_Types].xml');
      let main: string | undefined;
      const overrides = doc.getElementsByTagNameNS(NS.ct, 'Override');
      for (let i = 0; i < overrides.length; i++) {
        const o = overrides[i]!;
        if ((o.getAttribute('PartName') ?? '').toLowerCase() === '/word/document.xml') main = o.getAttribute('ContentType') ?? undefined;
        const type = o.getAttribute('ContentType') ?? '';
        if (/macroEnabled/i.test(type) || /vbaProject/i.test(type)) {
          errors.push({ code: 'MACROS_REFUSED', message: `Macro-enabled content type ${type}`, part: o.getAttribute('PartName') ?? '[Content_Types].xml' });
        }
      }
      if (main === undefined) errors.push({ code: 'MAIN_PART_TYPE', message: 'word/document.xml has no content type override', part: '[Content_Types].xml' });
      else if (!(MAIN_CONTENT_TYPES as readonly string[]).includes(main)) {
        errors.push({ code: /macroEnabled/i.test(main) ? 'MACROS_REFUSED' : 'MAIN_PART_TYPE', message: `Unsupported main document type ${main} (.docm/.dotm are refused)`, part: 'word/document.xml' });
      }
    } catch (err) {
      errors.push({ code: err instanceof DocxError ? err.code : 'INVALID_XML', message: err instanceof Error ? err.message : String(err), part: '[Content_Types].xml' });
    }
  }

  // Relationships.
  for (const [name, text] of xmlText) {
    if (!name.endsWith('.rels')) continue;
    let doc;
    try {
      doc = parseXml(text, name);
    } catch (err) {
      errors.push({ code: err instanceof DocxError ? err.code : 'INVALID_XML', message: err instanceof Error ? err.message : String(err), part: name });
      continue;
    }
    const rels = doc.getElementsByTagNameNS(NS.rels, 'Relationship');
    for (let i = 0; i < rels.length; i++) {
      const r = rels[i]!;
      const type = relType(r.getAttribute('Type') ?? '');
      const external = (r.getAttribute('TargetMode') ?? '').toLowerCase() === 'external';
      const target = r.getAttribute('Target') ?? '';
      if (type === 'aFChunk') errors.push({ code: 'ALTCHUNK_REFUSED', message: `Imported content (altChunk) ${target}`, part: name });
      if (external && REFUSED_EXTERNAL.includes(type)) errors.push({ code: 'EXTERNAL_REFUSED', message: `External ${type} relationship to ${target}`, part: name });
      if (external && type === 'image') warnings.push({ code: 'EXTERNAL_IMAGE', message: `External image ${target}`, part: name });
      if (!external && type === 'oleObject') warnings.push({ code: 'EMBEDDED_OBJECT', message: `Embedded OLE object ${target}`, part: name });
      if (type === 'vbaProject') errors.push({ code: 'MACROS_REFUSED', message: 'The document references a macro project', part: name });
      if (type === 'hyperlink' && !safeLinkTarget(target)) errors.push({ code: 'HYPERLINK_REFUSED', message: `A link points to a ${linkScheme(target) ?? 'non-web'} address (${target.slice(0, 60)}); only http, https and mailto links are accepted`, part: name });
    }
  }

  // Every XML part must parse (whatever its name: a header reached through the relationships, a theme, customXml).
  const parsed = new Set<string>();
  for (const [name, text] of xmlText) {
    if (name.endsWith('.rels') || name === '[Content_Types].xml') continue;
    try {
      parseXml(text, name);
      parsed.add(name);
    } catch (err) {
      errors.push({ code: err instanceof DocxError ? err.code : 'INVALID_XML', message: err instanceof Error ? err.message : String(err), part: name });
    }
  }

  // Main content parts: warnings for legacy fields, tracked changes, comments; HYPERLINK field codes are links too.
  for (const [name, text] of xmlText) {
    if (!parsed.has(name) || !/^word\/.*\.xml$/.test(name) || name.includes('/_rels/')) continue;
    for (const m of text.matchAll(/HYPERLINK\s+(?:&quot;|")([^"&]*)(?:&quot;|")/g)) {
      if (!safeLinkTarget(m[1] ?? '')) errors.push({ code: 'HYPERLINK_REFUSED', message: `A link field points to a ${linkScheme(m[1] ?? '') ?? 'non-web'} address; only http, https and mailto links are accepted`, part: name });
    }
    if (!/^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments|styles|numbering|settings)\.xml$/.test(name)) continue;
    if (name === 'word/comments.xml') {
      if (/<w:comment\b/.test(text)) warnings.push({ code: 'COMMENTS', message: 'The document contains comments; they are kept in the filled copy', part: name });
      continue;
    }
    if (/<w:ffData\b/.test(text)) warnings.push({ code: 'LEGACY_FORM_FIELDS', message: 'The document contains legacy form fields', part: name });
    if (/<w:(ins|del|moveFrom|moveTo)\b/.test(text)) {
      warnings.push({ code: 'TRACKED_CHANGES', message: 'The document contains tracked changes; accept or reject them in Word first', part: name });
    }
  }

  return done();
}

/**
 * checkDocxSafety() — the upload gate (§A.3). Shares its limits with zip.ts.
 *
 * Errors (refused): not a zip, bad entry names, duplicates, size/ratio/count limits, missing main parts, a main part
 * that is not a plain document/template (macro-enabled .docm/.dotm), vbaProject.bin, ActiveX parts, altChunk
 * relationships, external attachedTemplate/oleObject/frame/subDocument relationships, DTDs/entities, invalid XML.
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

  // Every XML part: DTD/entity refusal first (never parse a DTD).
  const xmlText = new Map<string, string>();
  for (const name of order) {
    if (!/\.(xml|rels)$/i.test(name)) continue;
    const text = decodeUtf8(entries.get(name)!);
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
    }
  }

  // Main content parts: must parse; warnings for legacy fields, tracked changes, comments.
  for (const [name, text] of xmlText) {
    if (!/^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments|styles|numbering|settings)\.xml$/.test(name)) continue;
    try {
      parseXml(text, name);
    } catch (err) {
      errors.push({ code: err instanceof DocxError ? err.code : 'INVALID_XML', message: err instanceof Error ? err.message : String(err), part: name });
      continue;
    }
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

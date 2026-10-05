import { describe, expect, it } from 'vitest';
import { unzipSync, strToU8 } from 'fflate';
import { checkDocxSafety } from './safety.js';
import { fillDocx } from './fill.js';
import { scanDocx } from './scan.js';
import { DocxError } from './types.js';
import { openDocx, writeDocx } from './zip.js';
import { markDirty, partDom } from './xml.js';
import { DECL, docx, heading, labelCell, p, r, rawZip, tbl, tr, valueCell } from './__fixtures__/build.js';

const now = new Date('2026-10-04T09:30:00Z');
const coreProps = { title: 'Test', created: now, modified: now };

function sample(): Uint8Array {
  return docx(heading('01', 'Customer details') + tbl([tr([labelCell('Full name'), valueCell()])], [2300, 2500]));
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof DocxError ? err.code : 'OTHER';
  }
  return undefined;
}

/** Rename an entry in a zip (local header + central directory), creating duplicates or bad names. */
function renameEntry(zip: Uint8Array, from: string, to: string): Uint8Array {
  expect(to.length).toBe(from.length);
  const out = new Uint8Array(zip);
  const f = strToU8(from);
  const t = strToU8(to);
  for (let i = 0; i + f.length <= out.length; i++) {
    let hit = true;
    for (let j = 0; j < f.length; j++) if (out[i + j] !== f[j]) {
      hit = false;
      break;
    }
    if (hit) out.set(t, i);
  }
  return out;
}

describe('openDocx / writeDocx', () => {
  it('refuses non-zips and missing main parts', () => {
    expect(codeOf(() => openDocx(strToU8('hello world')))).toBe('NOT_A_ZIP');
    expect(codeOf(() => openDocx(docx('', { omit: ['word/document.xml'] })))).toBe('MISSING_DOCUMENT');
    expect(codeOf(() => openDocx(docx('', { omit: ['[Content_Types].xml'] })))).toBe('MISSING_CONTENT_TYPES');
  });

  it('refuses a ratio bomb in the filter, before inflating', () => {
    const bomb = rawZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>', 'word/media/zeros.bin': new Uint8Array(4 * 1024 * 1024) }, 9);
    expect(codeOf(() => openDocx(bomb))).toBe('COMPRESSION_RATIO');
    const r1 = checkDocxSafety(bomb);
    expect(r1.ok).toBe(false);
    expect(r1.errors.map((e) => e.code)).toContain('COMPRESSION_RATIO');
  });

  it('enforces entry count, entry size and total size limits', () => {
    const files: Record<string, string> = { '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' };
    for (let i = 0; i < 6; i++) files[`word/extra${i}.xml`] = '<x/>';
    expect(codeOf(() => openDocx(rawZip(files), { maxEntries: 5 }))).toBe('TOO_MANY_ENTRIES');
    expect(codeOf(() => openDocx(rawZip(files), { maxEntryUncompressed: 5 }))).toBe('ENTRY_TOO_LARGE');
    expect(codeOf(() => openDocx(rawZip(files), { maxTotalUncompressed: 40 }))).toBe('TOTAL_TOO_LARGE');
    expect(codeOf(() => openDocx(rawZip(files), { maxCompressedBytes: 100 }))).toBe('TOO_LARGE');
  });

  it('refuses path traversal, absolute names, backslashes and duplicate entries', () => {
    const base = rawZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>', 'word/aaaaa.xml': '<x/>' });
    expect(codeOf(() => openDocx(renameEntry(base, 'word/aaaaa.xml', '../../evil.xml')))).toBe('BAD_ENTRY_NAME');
    expect(codeOf(() => openDocx(renameEntry(base, 'word/aaaaa.xml', '/etc/aaaaa.xml')))).toBe('BAD_ENTRY_NAME');
    expect(codeOf(() => openDocx(renameEntry(base, 'word/aaaaa.xml', 'word\\aaaaa.xml')))).toBe('BAD_ENTRY_NAME');
    const dup = rawZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>', 'word/documenX.xml': '<x/>' });
    expect(codeOf(() => openDocx(renameEntry(dup, 'word/documenX.xml', 'word/document.xml')))).toBe('DUPLICATE_ENTRY');
  });

  it('writes deterministically: same input and mtime → same bytes', () => {
    const a = writeDocx(openDocx(sample()), { mtime: now });
    const b = writeDocx(openDocx(sample()), { mtime: now });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const f1 = fillDocx(sample(), [{ slotId: '01-customer-details/full-name', value: { type: 'text', text: 'Jane Smith' } }], { coreProps, now });
    const f2 = fillDocx(sample(), [{ slotId: '01-customer-details/full-name', value: { type: 'text', text: 'Jane Smith' } }], { coreProps, now });
    expect(f1.sha256).toBe(f2.sha256);
    expect(f1.report.filled).toEqual(['01-customer-details/full-name']);
  });

  it('keeps entry order ([Content_Types].xml first) and writes untouched parts byte-identical', () => {
    const src = sample();
    const pkg = openDocx(src);
    const doc = partDom(pkg, 'word/document.xml');
    doc.documentElement!.setAttribute('data-touched', '1');
    markDirty(pkg, 'word/document.xml');
    const out = writeDocx(pkg, { mtime: now });
    const before = unzipSync(src);
    const after = unzipSync(out);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(Object.keys(after)[0]).toBe('[Content_Types].xml');
    for (const name of Object.keys(before)) {
      if (name === 'word/document.xml') continue;
      expect(Buffer.from(after[name]!).equals(Buffer.from(before[name]!)), name).toBe(true);
    }
    expect(new TextDecoder().decode(after['word/document.xml'])).toMatch(/^<\?xml version="1.0" encoding="UTF-8" standalone="yes"\?>/);
  });

  it('fill leaves every part it does not touch byte-identical', () => {
    const src = sample();
    const filled = fillDocx(src, [{ slotId: '01-customer-details/full-name', value: { type: 'text', text: 'Jane' } }], { coreProps, now });
    const before = unzipSync(src);
    const after = unzipSync(filled.docx);
    const changed = Object.keys(after).filter((n) => !before[n] || !Buffer.from(after[n]!).equals(Buffer.from(before[n]!)));
    // The fixture has no app.xml: it is created with its content-type override and package relationship.
    expect(changed.sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml', 'word/document.xml'].sort());
  });
});

describe('checkDocxSafety', () => {
  it('accepts a plain document and every real asset', () => {
    expect(checkDocxSafety(sample())).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('refuses DTDs and entities before parsing', () => {
    const evil = docx('', { extraParts: { 'word/settings.xml': `${DECL}<!DOCTYPE x [<!ENTITY a "aaaa">]><w:settings/>` } });
    const res = checkDocxSafety(evil);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain('XML_DTD_REFUSED');
    const evilDoc = rawZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': `${DECL}<!DOCTYPE w:document SYSTEM "file:///etc/passwd"><w:document/>` });
    expect(codeOf(() => scanDocx(evilDoc))).toBe('XML_DTD_REFUSED');
  });

  it('refuses a UTF-16 (or otherwise non-UTF-8) XML part, so a DTD cannot hide from the text checks', () => {
    const utf16 = (text: string) => {
      const out = new Uint8Array(2 + text.length * 2);
      out[0] = 0xff;
      out[1] = 0xfe;
      for (let i = 0; i < text.length; i++) out[2 + i * 2] = text.charCodeAt(i);
      return out;
    };
    const hidden = docx('', { extraParts: { 'word/theme/theme1.xml': utf16('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE a [<!ELEMENT a ANY>]><a/>') } });
    const res = checkDocxSafety(hidden);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain('XML_ENCODING_REFUSED');
    const declared = docx('', { extraParts: { 'customXml/item1.xml': '<?xml version="1.0" encoding="ISO-8859-1"?><a/>' } });
    expect(checkDocxSafety(declared).errors.map((e) => e.code)).toContain('XML_ENCODING_REFUSED');
    // any XML part must parse, whatever its name
    const broken = docx('', { extraParts: { 'word/theme/theme1.xml': `${DECL}<a><b></a>` } });
    expect(checkDocxSafety(broken).errors.map((e) => e.code)).toContain('INVALID_XML');
    expect(checkDocxSafety(docx('')).ok).toBe(true);
  });

  it('refuses links that are not http, https or mailto (javascript: in a relationship or a HYPERLINK field); fill neutralises them', () => {
    const rel = (id: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/>`;
    const bad = docx('', { extraRels: rel('rIdX', 'javascript:fetch(1)') });
    expect(checkDocxSafety(bad).errors.map((e) => e.code)).toContain('HYPERLINK_REFUSED');
    const sneaky = docx('', { extraRels: rel('rIdX', ' java&#9;script:alert(1)') });
    expect(checkDocxSafety(sneaky).errors.map((e) => e.code)).toContain('HYPERLINK_REFUSED');
    const field = docx('<w:p><w:r><w:instrText xml:space="preserve"> HYPERLINK "javascript:alert(1)" </w:instrText></w:r></w:p>');
    expect(checkDocxSafety(field).errors.map((e) => e.code)).toContain('HYPERLINK_REFUSED');
    const ok = docx('', { extraRels: `${rel('rIdA', 'https://www.courtesycars.net')}${rel('rIdB', 'mailto:claims@courtesycars.net')}` });
    expect(checkDocxSafety(ok).ok).toBe(true);
    const filled = fillDocx(bad, [], { coreProps, now });
    const rels = new TextDecoder().decode(unzipSync(filled.docx)['word/_rels/document.xml.rels']!);
    expect(rels).not.toContain('javascript:');
    expect(rels).toContain('Target="#"');
  });

  it('refuses macros: vbaProject.bin and a macro-enabled main part (.docm)', () => {
    const vba = docx('', { extraParts: { 'word/vbaProject.bin': new Uint8Array([1, 2, 3]) } });
    expect(checkDocxSafety(vba).errors.map((e) => e.code)).toContain('MACROS_REFUSED');
    const docm = docx('', { mainContentType: 'application/vnd.ms-word.document.macroEnabled.main+xml' });
    expect(checkDocxSafety(docm).errors.map((e) => e.code)).toContain('MACROS_REFUSED');
    const template = docx('', { mainContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml' });
    expect(checkDocxSafety(template).ok).toBe(true);
  });

  it('refuses ActiveX, altChunk and external attachedTemplate relationships; warns on external images', () => {
    const ax = docx('', { extraParts: { 'word/activeX/activeX1.xml': '<ax/>' } });
    expect(checkDocxSafety(ax).errors.map((e) => e.code)).toContain('ACTIVEX_REFUSED');
    const alt = docx('', { extraRels: '<Relationship Id="rIdA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/>' });
    expect(checkDocxSafety(alt).errors.map((e) => e.code)).toContain('ALTCHUNK_REFUSED');
    const tpl = docx('', { extraRels: '<Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="http://evil.example/t.dotm" TargetMode="External"/>' });
    expect(checkDocxSafety(tpl).errors.map((e) => e.code)).toContain('EXTERNAL_REFUSED');
    const img = docx('', { extraRels: '<Relationship Id="rIdI" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://example.com/a.png" TargetMode="External"/>' });
    const ri = checkDocxSafety(img);
    expect(ri.ok).toBe(true);
    expect(ri.warnings.map((w) => w.code)).toContain('EXTERNAL_IMAGE');
  });

  it('warns about tracked changes, legacy form fields and comments', () => {
    const tracked = docx(p('<w:ins w:id="1" w:author="x"><w:r><w:t>new</w:t></w:r></w:ins>') + p(r('a')));
    expect(checkDocxSafety(tracked).warnings.map((w) => w.code)).toContain('TRACKED_CHANGES');
    const ff = docx(p('<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="Text1"/></w:ffData></w:fldChar></w:r>'));
    expect(checkDocxSafety(ff).warnings.map((w) => w.code)).toContain('LEGACY_FORM_FIELDS');
    const comments = docx('', { extraParts: { 'word/comments.xml': `${DECL}<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0"><w:p/></w:comment></w:comments>` } });
    expect(checkDocxSafety(comments).warnings.map((w) => w.code)).toContain('COMMENTS');
  });
});

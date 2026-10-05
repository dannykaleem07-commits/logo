/**
 * composeLetterheadDocx — a letter on the CCGUK formal letterhead (design doc §A.10), implemented as a fill of the
 * built-in letterhead mapping with values taken from LetterContent (display strings) instead of the claim.
 *
 * Address lines map in order to [Address line 1], [Address line 2], [Town, POSTCODE] (the last line always goes to
 * the town/postcode slot; extra middle lines join line 2); unused lines, BY EMAIL, the Your Ref / Claim No. rows, the
 * reply-by sentence, Enc. and Cc. are removed. Paragraphs are numbered 1..n by the engine; headings and tables from
 * the HTML letter print unnumbered (a table as a real Word table). The pre-printed signatory role "Claims Manager" is
 * replaced only by the role the HTML letter was signed in.
 */
import { fillDocx } from '../fill.js';
import { scanDocx } from '../scan.js';
import type { FillInstruction, FillResult, LetterContent, SlotValue } from '../types.js';
import { builtinMapping, LETTERHEAD_TEMPLATE_ID } from './builtin/index.js';
import { resolveSelectors } from './mapping.js';
import { sha256Hex } from '../../hash.js';
import { openDocx, writeDocx } from '../zip.js';
import { markDirty, partDom, setTText, stripControlChars, wDescendants } from '../xml.js';
import { PRINTED_LETTER_ROLE } from './guards.js';

/** Rows of the reference panel removed when their value is absent (besides the mapping's own removeIfEmpty rows). */
const REMOVE_ROW_WHEN_EMPTY = new Set(['claimant.name#ref', 'vehicle.makeModelReg', 'accident.dateLong']);

function clean(s: string | undefined | null): string | undefined {
  const t = (s ?? '').trim();
  return t ? t : undefined;
}

export function composeLetterheadDocx(letterhead: Uint8Array, content: LetterContent, opts: { now: Date; reference: string; title: string }): FillResult {
  const scan = scanDocx(letterhead);
  const mapping = builtinMapping(LETTERHEAD_TEMPLATE_ID);
  const { bySlot } = resolveSelectors(mapping, scan);

  const lines = content.recipient.addressLines.map((l) => l.trim()).filter(Boolean);
  const town = lines.length ? lines[lines.length - 1] : undefined;
  const line1 = lines.length >= 2 ? lines[0] : undefined;
  const line2 = lines.length >= 3 ? lines.slice(1, -1).join(', ') : undefined;
  const salutation = clean(content.salutation) ?? 'Sir or Madam';
  const valediction = content.valediction ?? (/^sir or madam$/i.test(salutation) ? 'faithfully' : 'sincerely');
  const numbered = (items: string[] | undefined, sep: string) => {
    const list = (items ?? []).map((x) => x.trim()).filter(Boolean);
    return list.length ? list.map((x, i) => `${i + 1}. ${x}`).join(sep) : undefined;
  };

  const byKey: Record<string, string | undefined> = {
    'recipient.attentionName': clean(content.recipient.attention),
    'recipient.department': clean(content.recipient.department),
    'recipient.name': clean(content.recipient.name),
    'recipient.addressLine1': line1,
    'recipient.addressLine2': line2,
    'recipient.townPostcode': town,
    'recipient.email': clean(content.recipient.email),
    'claim.reference': clean(content.refs.ourRef) ?? clean(opts.reference),
    'recipient.theirReference': clean(content.refs.yourRef),
    'tpInsurer.claimRef': clean(content.refs.claimNo),
    'claimant.name#ref': clean(content.refs.client),
    'claimant.name#subject': clean(content.subjectClient) ?? clean(content.refs.client),
    'vehicle.makeModelReg': clean(content.refs.vehicle),
    'accident.dateLong': clean(content.refs.dateOfAccident),
    'doc.dateLong': clean(content.refs.date),
    'recipient.salutation': salutation,
    'doc.subject': clean(content.subject),
    'vehicle.registration': clean(content.subjectReg),
    'doc.replyByDate': clean(content.replyBy),
    'doc.valediction': valediction,
    'handler.name': clean(content.signatory.name),
    'doc.enclosures': numbered(content.enclosures, '; '),
    'doc.cc': (content.cc ?? []).map((x) => x.trim()).filter(Boolean).join('; ') || undefined
  };

  const instructions: FillInstruction[] = [];
  for (const slot of scan.slots) {
    const entry = bySlot.get(slot.id);
    if (!entry?.key || slot.signature) continue;
    let value: SlotValue | undefined;
    let lookup = entry.key;
    if (entry.key === 'claimant.name') lookup = slot.labelSlug === 'client' ? 'claimant.name#subject' : 'claimant.name#ref';
    if (entry.key === 'doc.body.paragraphs') {
      const items = content.paragraphs.map((p) => p.trim()).filter(Boolean);
      // keep indexes aligned with content.paragraphs: blank items are not dropped here (they never come from extraction)
      if (items.length === content.paragraphs.length && items.length) value = { type: 'paragraphs', items, replaceFixedLead: content.replaceFixedOpening, ...(content.headings?.length ? { headings: content.headings } : {}), ...(content.tables?.length ? { tables: content.tables } : {}) };
      else if (items.length) value = { type: 'paragraphs', items, replaceFixedLead: content.replaceFixedOpening };
    } else {
      const text = byKey[lookup];
      if (text !== undefined) value = { type: 'text', text };
    }
    if (value) instructions.push({ slotId: slot.id, value });
    else if (entry.removeIfEmpty) instructions.push({ slotId: slot.id, value: { type: 'remove', scope: entry.removeIfEmpty } });
    else if (REMOVE_ROW_WHEN_EMPTY.has(lookup)) instructions.push({ slotId: slot.id, value: { type: 'remove', scope: 'row' } });
  }

  const filled = fillDocx(letterhead, instructions, {
    coreProps: { title: opts.title, subject: clean(content.subject) ?? opts.title, keywords: [opts.reference, LETTERHEAD_TEMPLATE_ID], created: opts.now, modified: opts.now },
    now: opts.now,
    ...(mapping.style?.valueRun ? { valueRunStyle: mapping.style.valueRun } : {})
  });
  const role = clean(content.signatory.role);
  return role && role !== PRINTED_LETTER_ROLE ? withSignatoryRole(filled, role, opts.now) : filled;
}

/**
 * The letterhead prints "Claims Manager" under the signatory's name. A letter signed in another role (e.g. a
 * director) keeps that role: the printed line is replaced, in its own run style, nothing else changes.
 */
function withSignatoryRole(filled: FillResult, role: string, now: Date): FillResult {
  const pkg = openDocx(filled.docx);
  const doc = partDom(pkg, 'word/document.xml');
  const t = wDescendants(doc, 't').find((x) => (x.textContent ?? '').trim() === PRINTED_LETTER_ROLE);
  if (!t) return filled;
  setTText(t, stripControlChars(role).slice(0, 200));
  markDirty(pkg, 'word/document.xml');
  const docx = writeDocx(pkg, { mtime: now });
  return { ...filled, docx, sha256: sha256Hex(docx) };
}

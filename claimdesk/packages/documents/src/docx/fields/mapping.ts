/**
 * Template mappings (design doc §B.6): selectors → slots, merging a user override layer onto a built-in mapping, and
 * validation against a scan.
 *
 * Precedence when two entries address the same slot: an entry that names the slot by exact id (a string, or a
 * selector with `id`) beats one that found it through section/qualifier/label (that is how a stored override layer of
 * exact ids replaces curated built-in selectors); two entries of the same specificity are a DUPLICATE_SLOT issue (the
 * later one wins). The same rule applies between entries and `ignore` selectors.
 */
import type { DocxScan, DocxSlot, SlotKind } from '../types.js';
import { getFieldDef } from './dictionary.js';
import type { FieldType, FillPolicy, MappingEntry, MappingIssue, SlotSelector, TemplateMapping } from './types.js';

/** Strictness order (§B.6): a mapping entry may only be as strict or stricter than the field default. */
export const POLICY_RANK: Record<FillPolicy, number> = { auto: 0, 'auto-if-known': 1, suggest: 2, handler: 3, 'post-event': 4, never: 5, signature: 5 };

export function isStricterOrEqual(entry: FillPolicy, def: FillPolicy): boolean {
  return POLICY_RANK[entry] >= POLICY_RANK[def];
}

function partOf(slot: DocxSlot): 'header' | 'footer' | 'body' {
  if (slot.part.includes('/header')) return 'header';
  if (slot.part.includes('/footer')) return 'footer';
  return 'body';
}

/** Slots a selector matches (before `nth`). */
export function matchSelector(sel: SlotSelector | string, scan: DocxScan): DocxSlot[] {
  if (typeof sel === 'string') return scan.slots.filter((s) => s.id === sel);
  return scan.slots.filter((s) => {
    if (sel.id !== undefined && s.id !== sel.id) return false;
    if (sel.section !== undefined && !s.sectionPath.some((p) => p.startsWith(sel.section!))) return false;
    if (sel.qualifier !== undefined && !(s.qualifier ?? '').startsWith(sel.qualifier)) return false;
    if (sel.label !== undefined && s.labelSlug !== sel.label) return false;
    if (sel.kind !== undefined && s.kind !== sel.kind) return false;
    if (sel.part !== undefined && partOf(s) !== sel.part) return false;
    return true;
  });
}

function exact(sel: SlotSelector | string): boolean {
  return typeof sel === 'string' || sel.id !== undefined;
}

function describe(sel: SlotSelector | string): string {
  return typeof sel === 'string' ? sel : JSON.stringify(sel);
}

/** Resolve one selector to a single slot (or an issue). */
function resolveOne(sel: SlotSelector | string, scan: DocxScan): { slot?: DocxSlot; code?: 'SELECTOR_NO_MATCH' | 'SELECTOR_AMBIGUOUS'; count: number } {
  const all = matchSelector(sel, scan);
  const nth = typeof sel === 'string' ? undefined : sel.nth;
  if (nth !== undefined) {
    const slot = all[nth - 1];
    return slot ? { slot, count: all.length } : { code: 'SELECTOR_NO_MATCH', count: all.length };
  }
  if (all.length === 0) return { code: 'SELECTOR_NO_MATCH', count: 0 };
  if (all.length > 1) return { code: 'SELECTOR_AMBIGUOUS', count: all.length };
  return { slot: all[0]!, count: 1 };
}

/** Field types a slot kind can take. */
export function kindAccepts(kind: SlotKind, type: FieldType, when: string | undefined): boolean {
  switch (kind) {
    case 'checkbox':
      return when !== undefined ? type !== 'rows' && type !== 'list' : type === 'bool' || type === 'int';
    case 'choice':
      return type === 'choice' || type === 'bool';
    case 'table':
      return type === 'rows';
    case 'paragraphs':
      return type === 'list' || type === 'multiline' || type === 'text';
    default:
      return type !== 'rows';
  }
}

export function resolveSelectors(mapping: TemplateMapping, scan: DocxScan): { bySlot: Map<string, MappingEntry>; ignored: Set<string>; issues: MappingIssue[] } {
  const issues: MappingIssue[] = [];
  const bySlot = new Map<string, MappingEntry>();
  const exactBy = new Map<string, boolean>();
  const ignored = new Set<string>();

  mapping.entries.forEach((entry, i) => {
    const r = resolveOne(entry.slot, scan);
    if (!r.slot) {
      issues.push({ code: r.code!, entry: i, detail: `${describe(entry.slot)} matched ${r.count} slot(s)` });
      return;
    }
    const slot = r.slot;
    const isExact = exact(entry.slot);
    if (entry.key !== undefined) {
      const def = getFieldDef(entry.key);
      if (!def) issues.push({ code: 'UNKNOWN_KEY', entry: i, detail: `${entry.key} (slot ${slot.id})` });
      else {
        if (!kindAccepts(slot.kind, def.type, entry.when)) issues.push({ code: 'KIND_MISMATCH', entry: i, detail: `${entry.key} (${def.type}) cannot fill ${slot.kind} slot ${slot.id}` });
        if (entry.policy && !isStricterOrEqual(entry.policy, def.policy)) issues.push({ code: 'POLICY_LAXER', entry: i, detail: `${entry.key}: ${entry.policy} is laxer than the field default ${def.policy}` });
      }
    }
    for (const [prefix, ob] of Object.entries(entry.optionBlanks ?? {})) {
      const opt = (slot.options ?? []).find((o) => o.slug.startsWith(prefix) && o.blank);
      if (!opt) issues.push({ code: 'SELECTOR_NO_MATCH', entry: i, detail: `option blank ${prefix} not found in ${slot.id}` });
      if (ob.key !== undefined) {
        const def = getFieldDef(ob.key);
        if (!def) issues.push({ code: 'UNKNOWN_KEY', entry: i, detail: `${ob.key} (option blank ${prefix} of ${slot.id})` });
        else if (ob.policy && !isStricterOrEqual(ob.policy, def.policy)) issues.push({ code: 'POLICY_LAXER', entry: i, detail: `${ob.key}: ${ob.policy} is laxer than ${def.policy}` });
      }
    }
    for (const k of [entry.onlyIf?.key, ...Object.values(entry.optionBlanks ?? {}).map((o) => o.onlyIf?.key)]) {
      if (k !== undefined && !getFieldDef(k)) issues.push({ code: 'UNKNOWN_KEY', entry: i, detail: `onlyIf ${k}` });
    }
    const prev = exactBy.get(slot.id);
    if (prev !== undefined) {
      if (prev === isExact) {
        issues.push({ code: 'DUPLICATE_SLOT', entry: i, detail: `${slot.id} is mapped twice` });
        bySlot.set(slot.id, entry);
      } else if (isExact) {
        bySlot.set(slot.id, entry);
        exactBy.set(slot.id, true);
      }
      return;
    }
    bySlot.set(slot.id, entry);
    exactBy.set(slot.id, isExact);
  });

  for (const sel of mapping.ignore ?? []) {
    // An ignore selector may match several slots unless it names an id; `nth` narrows it to one.
    const all = matchSelector(sel, scan);
    const nth = typeof sel === 'string' ? undefined : sel.nth;
    const slots = nth !== undefined ? (all[nth - 1] ? [all[nth - 1]!] : []) : all;
    if (slots.length === 0) {
      issues.push({ code: 'SELECTOR_NO_MATCH', entry: -1, detail: `ignore ${describe(sel)} matched no slot` });
      continue;
    }
    for (const s of slots) {
      const isExact = exact(sel);
      const mappedExact = exactBy.get(s.id);
      if (mappedExact !== undefined) {
        if (mappedExact === isExact) issues.push({ code: 'DUPLICATE_SLOT', entry: -1, detail: `${s.id} is both mapped and ignored` });
        if (mappedExact && !isExact) continue; // exact entry beats a selector ignore
        bySlot.delete(s.id);
        exactBy.delete(s.id);
      }
      ignored.add(s.id);
    }
  }

  // Variants and block rules must name blocks that exist.
  const blockExists = (prefix: string) => scan.blocks.some((b) => b.id.startsWith(prefix));
  for (const v of mapping.variants ?? []) for (const b of v.removeBlocks ?? []) if (!blockExists(b)) issues.push({ code: 'SELECTOR_NO_MATCH', entry: -1, detail: `variant ${v.id}: block ${b} not found` });
  for (const rule of mapping.blocks ?? []) {
    if (!blockExists(rule.block)) issues.push({ code: 'SELECTOR_NO_MATCH', entry: -1, detail: `block rule: block ${rule.block} not found` });
    if (!getFieldDef(rule.removeWhen.key)) issues.push({ code: 'UNKNOWN_KEY', entry: -1, detail: `block rule ${rule.removeWhen.key}` });
  }
  const variantIds = new Set((mapping.variants ?? []).map((v) => v.id));
  mapping.entries.forEach((e, i) => {
    for (const v of e.variants ?? []) if (!variantIds.has(v)) issues.push({ code: 'SELECTOR_NO_MATCH', entry: i, detail: `unknown variant ${v}` });
  });
  return { bySlot, ignored, issues };
}

/** Override entries replace base entries for the same slot id; override metadata replaces base metadata when given. */
export function mergeMappings(base: TemplateMapping, override: Partial<TemplateMapping>): TemplateMapping {
  const overrideIds = new Set((override.entries ?? []).map((e) => (typeof e.slot === 'string' ? e.slot : e.slot.id)).filter((x): x is string => !!x));
  const baseEntries = base.entries.filter((e) => {
    const id = typeof e.slot === 'string' ? e.slot : e.slot.id;
    return !(id && overrideIds.has(id));
  });
  const merged: TemplateMapping = {
    ...base,
    entries: [...baseEntries, ...(override.entries ?? [])],
    ignore: [...(base.ignore ?? []), ...(override.ignore ?? [])]
  };
  if (override.variants) merged.variants = override.variants;
  if (override.blocks) merged.blocks = override.blocks;
  if (override.guards) merged.guards = override.guards;
  if (override.subjects) merged.subjects = override.subjects;
  if (override.style) merged.style = override.style;
  if (override.sourceSha256) merged.sourceSha256 = override.sourceSha256;
  return merged;
}

export function validateMapping(mapping: TemplateMapping, scan: DocxScan): MappingIssue[] {
  return resolveSelectors(mapping, scan).issues;
}

/** Slots neither mapped nor ignored. */
export function unmappedSlots(mapping: TemplateMapping, scan: DocxScan): string[] {
  const { bySlot, ignored } = resolveSelectors(mapping, scan);
  return scan.slots.filter((s) => !bySlot.has(s.id) && !ignored.has(s.id)).map((s) => s.id);
}

/**
 * buildFillPlan — one function for the values form, the preview and generation (design doc §B.9).
 *
 * Precedence per slot: handler input (only when the policy allows input: not signature/never, not a non-overridable
 * field such as bank details) → resolver value (auto, auto-if-known, and suggest once confirmed; GTA benchmark money
 * only when verified or confirmed) → blank. Never-auto-fill rules (§B.5) are enforced here; the signature rule is
 * enforced again by fillDocx.
 */
import { parseGBP } from '@ccguk/domain';
import type { DocxScan, DocxSlot, FillInstruction, SlotValue } from '../types.js';
import { getFieldDef, personalSalutation } from './dictionary.js';
import { formatForSlot, optionMatches, slotValueDisplay, valueText } from './format.js';
import { runTemplateGuards } from './guards.js';
import { isStricterOrEqual, resolveSelectors } from './mapping.js';
import { resolveField } from './resolve.js';
import type { MergeSource } from './source.js';
import type { FieldDef, FieldValue, FillPlan, FillPlanIssue, FillPolicy, MappingEntry, OptionBlankEntry, PlanInputType, PlanInputs, PlanOrigin, PlanRow, SlotInput, TemplateMapping } from './types.js';

export const DOCX_GTA_BENCHMARK_NOTE = 'GTA rates are an industry benchmark only. Courtesy Cars Group UK Ltd is not a GTA subscriber.';
/** Separator between a choice slot id and an option slug for the blank printed inside that option. */
export const OPTION_BLANK_SEPARATOR = '|';

const NO_INPUT: FillPolicy[] = ['signature', 'never'];

function inputTypeOf(slot: DocxSlot, def: FieldDef | undefined): PlanInputType {
  switch (slot.kind) {
    case 'checkbox':
      return 'checkbox';
    case 'choice':
      return 'choice';
    case 'table':
      return 'rows';
    case 'paragraphs':
      return 'paragraphs';
    default:
      break;
  }
  if (def) {
    switch (def.type) {
      case 'date':
      case 'datetime':
      case 'time':
      case 'money':
      case 'int':
      case 'multiline':
        return def.type;
      case 'list':
        return 'multiline';
      default:
        return slot.multiline || slot.kind === 'block' ? 'multiline' : 'text';
    }
  }
  switch (slot.blank?.pattern) {
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'time':
      return 'time';
    case 'money':
      return 'money';
    case 'number':
    case 'percent':
      return 'int';
    default:
      return slot.multiline || slot.kind === 'block' ? 'multiline' : 'text';
  }
}

function inputTypeOfBlank(pattern: string | undefined, def: FieldDef | undefined): PlanInputType {
  if (def && ['date', 'datetime', 'time', 'money', 'int'].includes(def.type)) return def.type as PlanInputType;
  switch (pattern) {
    case 'date':
      return 'date';
    case 'money':
      return 'money';
    default:
      return 'text';
  }
}

function realCalendarDate(y: string, m: string, d: string): boolean {
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() === Number(m) - 1 && dt.getUTCDate() === Number(d);
}

/** Line items that make up the C1.4 account total (the total is what these print, not what the records say). */
const ACCOUNT_LINE_KEYS = ['recovery.netPence', 'storage.netPence', 'engineer.feePence', 'payment.additionalPence'];
const ACCOUNT_TOTAL_KEY = 'payment.totalPence';

/** Handler input → FieldValue for text-like rows; undefined when it cannot be read. */
function inputToValue(raw: SlotInput, inputType: PlanInputType, def: FieldDef | undefined): FieldValue | undefined {
  if (raw === null) return undefined;
  switch (inputType) {
    case 'date': {
      if (typeof raw !== 'string') return undefined;
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
      const uk = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
      const ymd: [string, string, string] | undefined = iso ? [iso[1]!, iso[2]!, iso[3]!] : uk ? [uk[3]!, uk[2]!.padStart(2, '0'), uk[1]!.padStart(2, '0')] : undefined;
      // a calendar date only: 31/02 or month 13 is refused (INVALID_INPUT), never printed
      return ymd && realCalendarDate(ymd[0], ymd[1], ymd[2]) ? { t: 'date', v: `${ymd[0]}-${ymd[1]}-${ymd[2]}` } : undefined;
    }
    case 'datetime':
      return typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? { t: 'datetime', v: raw } : undefined;
    case 'time':
      return typeof raw === 'string' && /^\d{1,2}:\d{2}$/.test(raw.trim()) ? { t: 'time', v: raw.trim() } : undefined;
    case 'money': {
      if (typeof raw === 'number' && Number.isFinite(raw)) return { t: 'money', v: Math.round(raw) };
      if (typeof raw === 'string') {
        const p = parseGBP(raw);
        return p === null ? undefined : { t: 'money', v: p };
      }
      return undefined;
    }
    case 'int': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?[\d,]+$/.test(raw.trim()) ? Number(raw.replace(/,/g, '')) : NaN;
      return Number.isFinite(n) ? { t: 'int', v: Math.trunc(n) } : undefined;
    }
    case 'paragraphs':
      return Array.isArray(raw) ? { t: 'list', v: (raw as unknown[]).filter((x): x is string => typeof x === 'string') } : typeof raw === 'string' ? { t: 'text', v: raw } : undefined;
    default: {
      if (typeof raw === 'string') return raw.trim() ? { t: 'text', v: raw } : undefined;
      if (typeof raw === 'number') return { t: 'text', v: String(raw) };
      if (typeof raw === 'boolean') return { t: 'bool', v: raw };
      if (Array.isArray(raw)) {
        const items = (raw as unknown[]).filter((x): x is string => typeof x === 'string');
        return def?.type === 'list' ? { t: 'list', v: items } : { t: 'text', v: items.join('\n') };
      }
      return undefined;
    }
  }
}

/** FieldValue → the raw value a PlanRow carries. */
function rawOf(value: FieldValue | undefined, slotValue: SlotValue | undefined, slot: DocxSlot): SlotInput {
  if (slot.kind === 'choice') return slotValue?.type === 'choice' ? slotValue.selected : null;
  if (slot.kind === 'checkbox') return slotValue?.type === 'check' ? slotValue.checked : value?.t === 'bool' ? value.v : null;
  if (!value) return null;
  switch (value.t) {
    case 'text':
    case 'date':
    case 'datetime':
    case 'time':
      return value.v;
    case 'money':
    case 'int':
      return value.v;
    case 'bool':
      return value.v;
    case 'choice':
    case 'list':
      return value.v;
    case 'rows':
      return value.v;
  }
}

/** Codes a choice-slot selection stands for (reverse of FieldDef.choices matching). */
function codesFromSelection(selected: string[], def: FieldDef | undefined): FieldValue | undefined {
  if (selected.length === 0) return undefined;
  if (!def?.choices) {
    if (def?.type === 'bool') return { t: 'bool', v: selected.some((s) => s.startsWith('yes')) };
    return { t: 'choice', v: selected };
  }
  const codes = Object.entries(def.choices)
    .filter(([, c]) => selected.some((s) => c.matches.some((m) => optionMatches(s, m))))
    .map(([code]) => code);
  if (def.type === 'bool') {
    if (codes.includes('yes')) return { t: 'bool', v: true };
    if (codes.includes('no')) return { t: 'bool', v: false };
    return undefined;
  }
  return codes.length ? { t: 'choice', v: codes } : { t: 'choice', v: selected };
}

function conditionHolds(v: FieldValue | undefined, equals: string | boolean | undefined): boolean {
  if (!v) return false;
  if (equals === undefined) {
    if (v.t === 'bool') return v.v;
    return v.t === 'text' ? v.v.trim() !== '' : true;
  }
  if (typeof equals === 'boolean') return v.t === 'bool' ? v.v === equals : false;
  switch (v.t) {
    case 'choice':
    case 'list':
      return v.v.includes(equals);
    case 'text':
      return v.v === equals;
    case 'bool':
      return String(v.v) === equals || (v.v ? 'yes' : 'no') === equals;
    default:
      return String(v.v) === equals;
  }
}

interface Work {
  row: PlanRow;
  slot: DocxSlot;
  entry?: MappingEntry;
  def?: FieldDef;
  value?: FieldValue;
  slotValue?: SlotValue;
  fromInput: boolean;
  onlyIf?: { key: string; equals?: string | boolean };
  /** Option-blank rows: parent choice slot id and option slug. */
  option?: { parent: string; slug: string };
}

export function buildFillPlan(scan: DocxScan, mapping: TemplateMapping, source: MergeSource, inputs: PlanInputs): FillPlan {
  const issues: FillPlanIssue[] = [];
  const { bySlot, ignored, issues: mapIssues } = resolveSelectors(mapping, scan);
  for (const i of mapIssues) issues.push({ code: i.code, severity: 'warn', message: i.detail });
  const values = inputs.values ?? {};
  const confirmSet = new Set(inputs.confirm ?? []);

  // Variant
  const variants = mapping.variants ?? [];
  const fallbackVariant = variants.find((v) => v.default)?.id ?? variants[0]?.id;
  let variantId = inputs.variant ?? fallbackVariant;
  if (inputs.variant !== undefined && !variants.some((v) => v.id === inputs.variant)) {
    issues.push({ code: 'UNKNOWN_VARIANT', severity: 'block', message: `Unknown variant "${inputs.variant}"` });
    variantId = fallbackVariant;
  }
  const variant = variants.find((v) => v.id === variantId);

  const works: Work[] = [];
  const handlerKeys = new Set<string>();

  const makeRow = (slot: DocxSlot, slotId: string, label: string, inputType: PlanInputType, policy: FillPolicy, editable: boolean, def: FieldDef | undefined, key: string | undefined, note: string | undefined): PlanRow => ({
    slotId,
    section: slot.sectionPath.join('/'),
    sectionTitle: slot.sectionTitles.join(' › '),
    label,
    kind: slot.kind,
    inputType,
    ...(slot.kind === 'choice' && inputType === 'choice' ? { options: (slot.options ?? []).map((o) => ({ value: o.slug, label: o.label })), multiple: !def || (def.type !== 'choice' && def.type !== 'bool') } : {}),
    ...(slot.kind === 'table' ? { columns: (slot.columns ?? []).map((c) => ({ id: c.slug, label: c.label })) } : {}),
    ...(key ? { key } : {}),
    policy,
    editable,
    value: null,
    display: '',
    origin: 'none',
    ...(def ? { sourcePath: def.sourcePath } : {}),
    needsConfirmation: false,
    confirmed: confirmSet.has(slotId),
    required: false,
    missing: false,
    ...(note ? { note } : {}),
    ...(slot.widthTwips !== undefined ? { widthTwips: slot.widthTwips } : {}),
    preview: slot.preview
  });

  const originOf = (key: string | undefined, policy: FillPolicy): PlanOrigin => {
    if (policy === 'suggest') return 'suggested';
    if (!key) return 'derived';
    if (key.startsWith('company.')) return 'settings';
    if (key.startsWith('doc.') || key.startsWith('handler.')) return 'derived';
    return 'claim';
  };

  /** Resolve one row's value (input → resolver → blank). */
  const fill = (w: Work, key: string | undefined, policy: FillPolicy, inputAllowed: boolean, inVariant: boolean, format: MappingEntry['format'], when: string | undefined, blankSlot: DocxSlot): void => {
    const row = w.row;
    const raw = values[row.slotId];
    if (raw !== undefined) {
      if (!inputAllowed) {
        issues.push({ code: 'SLOT_NOT_FILLABLE', severity: 'block', message: `${row.label}: this box is ${policy === 'signature' ? 'signed by hand' : w.def?.overridable === false ? 'filled from Settings only' : 'left as printed'} and cannot be typed into.`, slotId: row.slotId });
      } else if (raw !== null) {
        if (blankSlot.kind === 'checkbox' && !w.option) {
          if (typeof raw === 'boolean') {
            w.fromInput = true;
            if (raw) {
              w.slotValue = { type: 'check', checked: true };
              w.value = when !== undefined ? (w.def?.type === 'bool' ? { t: 'bool', v: /^(yes|true)$/i.test(when) } : { t: 'choice', v: [when] }) : { t: 'bool', v: true };
            }
          } else issues.push({ code: 'INVALID_INPUT', severity: 'warn', message: `${row.label}: expected true or false`, slotId: row.slotId });
        } else if (blankSlot.kind === 'choice' && !w.option) {
          const sel = Array.isArray(raw) ? (raw as unknown[]).filter((x): x is string => typeof x === 'string') : typeof raw === 'string' ? [raw] : typeof raw === 'boolean' && w.def ? [] : [];
          const known = new Set((blankSlot.options ?? []).map((o) => o.slug));
          if (typeof raw === 'boolean' && w.def) {
            const fv: FieldValue = { t: 'bool', v: raw };
            w.value = fv;
            w.slotValue = formatForSlot(fv, blankSlot, w.def);
            w.fromInput = true;
          } else if (sel.every((s) => known.has(s))) {
            w.fromInput = true;
            if (sel.length) {
              w.slotValue = { type: 'choice', selected: sel };
              w.value = codesFromSelection(sel, w.def);
            }
          } else issues.push({ code: 'INVALID_INPUT', severity: 'warn', message: `${row.label}: unknown option ${sel.filter((s) => !known.has(s)).join(', ')}`, slotId: row.slotId });
        } else if (blankSlot.kind === 'table') {
          if (Array.isArray(raw) && (raw as unknown[]).every((r) => r && typeof r === 'object')) {
            const rowsIn = (raw as Array<Record<string, string>>).filter((r) => Object.values(r).some((c) => String(c ?? '').trim() !== ''));
            w.fromInput = true;
            if (rowsIn.length) {
              w.slotValue = { type: 'rows', rows: rowsIn };
              w.value = { t: 'rows', v: rowsIn };
            }
          } else issues.push({ code: 'INVALID_INPUT', severity: 'warn', message: `${row.label}: expected table rows`, slotId: row.slotId });
        } else {
          const fv = inputToValue(raw, row.inputType, w.def);
          if (fv === undefined && !(typeof raw === 'string' && raw.trim() === '')) issues.push({ code: 'INVALID_INPUT', severity: 'warn', message: `${row.label}: could not read "${String(raw)}"`, slotId: row.slotId });
          w.fromInput = true;
          if (fv) {
            w.value = fv;
            w.slotValue = formatForSlot(fv, blankSlot, w.def, format, when);
          }
        }
        if (w.fromInput) {
          row.origin = 'handler';
          if (key) handlerKeys.add(key);
        }
      } else {
        w.fromInput = true; // explicit null: leave blank
      }
    }
    if (!w.fromInput && key && inVariant && !NO_INPUT.includes(policy)) {
      const resolved = resolveField(key, source);
      if (resolved) {
        const gtaUnverified = !!w.def?.requiresConfirmationUnlessVerified && resolved.t === 'money' && resolved.verification !== 'verified';
        const sv = formatForSlot(resolved, blankSlot, w.def, format, when);
        row.origin = originOf(key, policy);
        if (resolved.t === 'money' && resolved.verification) row.verification = resolved.verification;
        if (policy === 'auto' || policy === 'auto-if-known' || policy === 'suggest') {
          const needsConfirm = policy === 'suggest' || gtaUnverified;
          row.needsConfirmation = needsConfirm;
          // A confirmation carried over from an earlier generation stands only while the figure is unchanged.
          const before = inputs.confirmedDisplay?.[row.slotId];
          if (needsConfirm && row.confirmed && before !== undefined) {
            const now = w.option ? (sv?.type === 'text' ? sv.text : '') : slotValueDisplay(sv, blankSlot);
            if (now !== before) {
              row.confirmed = false;
              row.note = [row.note, `Previously confirmed as "${before}"; the value has changed since — check it and confirm again.`].filter(Boolean).join(' ');
              issues.push({ code: 'CONFIRMATION_STALE', severity: 'warn', message: `${row.label}: the confirmed value "${before}" has changed to "${now}"; it is left blank until confirmed again.`, slotId: row.slotId });
            }
          }
          if (!needsConfirm || row.confirmed) {
            w.value = resolved;
            w.slotValue = sv;
          } else {
            row.value = rawOf(resolved, sv, blankSlot);
          }
        }
      }
    }
  };

  for (const slot of scan.slots) {
    const removedBlock = !!slot.blockId && (variant?.removeBlocks ?? []).some((p) => slot.blockId!.startsWith(p));
    if (removedBlock) continue;
    const entry = bySlot.get(slot.id);
    const isIgnored = ignored.has(slot.id);
    const def = entry?.key ? getFieldDef(entry.key) : undefined;
    let policy: FillPolicy = isIgnored ? 'never' : entry?.policy ?? def?.policy ?? 'handler';
    if (entry?.policy && def && !isStricterOrEqual(entry.policy, def.policy)) policy = def.policy;
    if (slot.signature) policy = 'signature';
    const inVariant = !entry?.variants || (variantId !== undefined && entry.variants.includes(variantId));
    const overridable = def?.overridable !== false;
    const inputAllowed = !NO_INPUT.includes(policy) && overridable && inVariant && !isIgnored;
    const label = entry?.label ?? (slot.qualifierTitle ? `${slot.qualifierTitle} — ${slot.label}` : slot.label);
    const notes = [entry?.note, def?.requiresConfirmationUnlessVerified ? DOCX_GTA_BENCHMARK_NOTE : undefined, !inVariant ? `Not used in the ${variantId ?? 'selected'} copy` : undefined].filter(Boolean).join(' ');
    const row = makeRow(slot, slot.id, label, inputTypeOf(slot, def), policy, inputAllowed, def, entry?.key, notes || undefined);
    row.required = !!entry?.required;
    const w: Work = { row, slot, ...(entry ? { entry } : {}), ...(def ? { def } : {}), fromInput: false, ...(entry?.onlyIf ? { onlyIf: entry.onlyIf } : {}) };
    if (!isIgnored) fill(w, entry?.key, policy, inputAllowed, inVariant, entry?.format, entry?.when, slot);
    works.push(w);

    // Blanks printed inside a choice option (☐ Other: ______).
    if (slot.kind === 'choice' && !isIgnored && policy !== 'signature' && policy !== 'never') {
      for (const opt of slot.options ?? []) {
        if (!opt.blank) continue;
        const obEntry: OptionBlankEntry | undefined = Object.entries(entry?.optionBlanks ?? {}).find(([prefix]) => opt.slug.startsWith(prefix))?.[1];
        const obDef = obEntry?.key ? getFieldDef(obEntry.key) : undefined;
        let obPolicy: FillPolicy = obEntry?.policy ?? obDef?.policy ?? 'handler';
        if (obEntry?.policy && obDef && !isStricterOrEqual(obEntry.policy, obDef.policy)) obPolicy = obDef.policy;
        const obAllowed = !NO_INPUT.includes(obPolicy) && obDef?.overridable !== false && inVariant;
        const blankSlot: DocxSlot = { ...slot, kind: 'blank', blank: { pattern: opt.blank.pattern, text: opt.blank.text, hasCurrency: false }, options: undefined };
        const subId = `${slot.id}${OPTION_BLANK_SEPARATOR}${opt.slug}`;
        const sub = makeRow(blankSlot, subId, obEntry?.label ?? `${label} — ${opt.label}`, inputTypeOfBlank(opt.blank.pattern, obDef), obPolicy, obAllowed, obDef, obEntry?.key, obEntry?.note);
        sub.kind = 'choice';
        const sw: Work = { row: sub, slot: blankSlot, ...(obDef ? { def: obDef } : {}), fromInput: false, option: { parent: slot.id, slug: opt.slug }, ...(obEntry?.onlyIf ? { onlyIf: obEntry.onlyIf } : {}) };
        fill(sw, obEntry?.key, obPolicy, obAllowed, inVariant, obEntry?.format, undefined, blankSlot);
        works.push(sw);
      }
    }
  }

  // Printed value per key (handler input or printed resolver value; first slot wins) — for onlyIf, blocks, guards.
  const printed = new Map<string, FieldValue | undefined>();
  const keyValue = (key: string): FieldValue | undefined => {
    if (printed.has(key)) return printed.get(key);
    return resolveField(key, source);
  };
  const collect = (): void => {
    printed.clear();
    // A key mapped in this template counts as what it prints (blank when nothing prints, e.g. an unconfirmed
    // suggestion); the first slot that prints a value wins.
    for (const w of works) {
      const key = w.row.key;
      if (!key) continue;
      if (w.slotValue && w.value && printed.get(key) === undefined) printed.set(key, w.value);
      else if (!printed.has(key)) printed.set(key, undefined);
    }
  };
  collect();

  // onlyIf
  let changed = false;
  for (const w of works) {
    if (!w.onlyIf || (!w.slotValue && !w.value)) continue;
    if (!conditionHolds(keyValue(w.onlyIf.key), w.onlyIf.equals)) {
      delete w.value;
      delete w.slotValue;
      w.row.note = [w.row.note, `Only filled when ${getFieldDef(w.onlyIf.key)?.label ?? w.onlyIf.key} is ${String(w.onlyIf.equals ?? 'set')}.`].filter(Boolean).join(' ');
      changed = true;
    }
  }
  if (changed) collect();

  // The account total adds up what the account lines print (a typed line or the Additional charge included),
  // unless the handler typed the total. While a service is still open (no record total) and nothing was typed,
  // the total stays blank.
  for (const tw of works) {
    if (tw.row.key !== ACCOUNT_TOTAL_KEY || tw.fromInput || tw.option) continue;
    const section = tw.slot.sectionPath.join('/');
    const lines = works.filter((w) => !w.option && w.row.key && ACCOUNT_LINE_KEYS.includes(w.row.key) && w.slot.sectionPath.join('/') === section);
    if (!lines.length) continue;
    const typed = lines.some((w) => w.fromInput);
    if (!tw.value && !typed) continue;
    const amounts = lines.map((w) => (w.slotValue && w.value?.t === 'money' ? w.value.v : undefined));
    // a service on the record whose line prints nothing: the total cannot be stated
    const unstated = lines.some((w, i) => amounts[i] === undefined && !w.fromInput && w.row.key !== 'payment.additionalPence' && resolveField(w.row.key!, source) !== undefined);
    if (unstated || amounts.every((a) => a === undefined)) continue;
    const total: FieldValue = { t: 'money', v: amounts.reduce<number>((a, b) => a + (b ?? 0), 0) };
    if (tw.value?.t === 'money' && tw.value.v === total.v) continue;
    tw.value = total;
    tw.slotValue = formatForSlot(total, tw.slot, tw.def, tw.entry?.format, tw.entry?.when);
    tw.row.note = [tw.row.note, 'Worked out from the account lines as printed.'].filter(Boolean).join(' ');
    changed = true;
  }
  if (changed) collect();

  // A named person typed "for the attention of" is greeted by name (unless the salutation itself was typed).
  const attention = printed.get('recipient.attentionName');
  const named = attention?.t === 'text' ? personalSalutation(attention.v) : undefined;
  if (named) {
    for (const w of works) {
      if (w.row.key !== 'recipient.salutation' || w.fromInput || !w.slotValue) continue;
      const v: FieldValue = { t: 'text', v: named };
      w.value = v;
      w.slotValue = formatForSlot(v, w.slot, w.def, w.entry?.format, w.entry?.when);
      changed = true;
    }
    if (changed) collect();
  }

  // Valediction follows the salutation actually printed.
  const salutation = keyValue('recipient.salutation');
  for (const w of works) {
    if (w.row.key !== 'doc.valediction' || w.fromInput || !w.slotValue) continue;
    const named = salutation?.t === 'text' && !/^sir or madam$/i.test(salutation.v.trim());
    const v: FieldValue = { t: 'text', v: named ? 'sincerely' : 'faithfully' };
    w.value = v;
    w.slotValue = formatForSlot(v, w.slot, w.def);
  }

  // Block rules
  const removeBlocks = [...(variant?.removeBlocks ?? [])];
  for (const rule of mapping.blocks ?? []) {
    const v = keyValue(rule.removeWhen.key);
    const empty = !v || (v.t === 'text' && v.v.trim() === '') || ((v.t === 'list' || v.t === 'rows' || v.t === 'choice') && v.v.length === 0);
    const hit = rule.removeWhen.empty ? empty : rule.removeWhen.equals !== undefined ? conditionHolds(v, rule.removeWhen.equals) : false;
    if (hit && !removeBlocks.includes(rule.block)) removeBlocks.push(rule.block);
  }
  const inRemoved = (slot: DocxSlot): boolean => !!slot.blockId && removeBlocks.some((p) => slot.blockId!.startsWith(p));

  // Rows, instructions
  const instructions: FillInstruction[] = [];
  const rows: PlanRow[] = [];
  const choiceBlanks = new Map<string, Record<string, string>>();
  for (const w of works) {
    if (inRemoved(w.slot)) continue;
    if (w.option && w.slotValue?.type === 'text') {
      const b = choiceBlanks.get(w.option.parent) ?? {};
      b[w.option.slug] = w.slotValue.text;
      choiceBlanks.set(w.option.parent, b);
    }
  }
  for (const w of works) {
    if (inRemoved(w.slot)) continue;
    const row = w.row;
    let sv = w.slotValue;
    if (!w.option && w.slot.kind === 'choice' && choiceBlanks.has(w.slot.id)) {
      sv = sv?.type === 'choice' ? { ...sv, blanks: choiceBlanks.get(w.slot.id)! } : { type: 'choice', selected: [], blanks: choiceBlanks.get(w.slot.id)! };
    }
    if (w.value || w.slotValue) row.value = rawOf(w.value, w.slotValue, w.slot);
    if (w.value && !w.slotValue && w.slot.kind === 'choice' && !w.option) issues.push({ code: 'OPTION_NOT_MATCHED', severity: 'warn', message: `${row.label}: "${valueText(w.value, w.slot, w.def) ?? ''}" matches none of the printed options`, slotId: row.slotId });
    row.display = w.option ? (w.slotValue?.type === 'text' ? w.slotValue.text : '') : slotValueDisplay(w.slotValue, w.slot);
    row.missing = row.required && row.display === '';
    if (row.missing) issues.push({ code: 'VALUES_REQUIRED', severity: 'block', message: `${row.label} is required.`, slotId: row.slotId });
    if (w.entry?.requiredBeforeSigning && row.display === '') issues.push({ code: 'REQUIRED_BEFORE_SIGNING', severity: 'warn', message: `${row.label} must be filled in before the client signs.`, slotId: row.slotId });
    rows.push(row);
    if (w.option) continue;
    if (sv) instructions.push({ slotId: w.slot.id, value: sv });
    else if (w.entry?.removeIfEmpty && row.policy !== 'signature') instructions.push({ slotId: w.slot.id, value: { type: 'remove', scope: w.entry.removeIfEmpty } });
  }

  // Guards over what will print
  const guardValues = new Map<string, FieldValue | undefined>();
  for (const w of works) {
    if (inRemoved(w.slot) || !w.row.key || guardValues.has(w.row.key)) continue;
    if (w.slotValue) guardValues.set(w.row.key, w.value);
  }
  const slotIdsByKey = new Map<string, string>();
  for (const w of works) if (!inRemoved(w.slot) && w.row.key && !slotIdsByKey.has(w.row.key)) slotIdsByKey.set(w.row.key, w.row.slotId);
  issues.push(...runTemplateGuards(mapping.guards ?? [], { scan, source, values: guardValues, ...(variantId !== undefined ? { variant: variantId } : {}), templateId: mapping.templateId, handlerKeys, slotIdsByKey }));

  return { templateId: mapping.templateId, ...(variantId !== undefined ? { variant: variantId } : {}), rows, instructions, removeBlocks, issues };
}

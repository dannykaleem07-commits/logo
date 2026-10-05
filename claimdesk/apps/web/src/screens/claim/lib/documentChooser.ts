/**
 * "New document" chooser for the Documents tab (pure; unit-tested) — docs/V03-MANAGER-MODE-HIRE-PRICING.md §E9.
 *
 * One button, one chooser: the CCGUK Word templates first (choosing one opens the Fill dialog), then the built-in
 * templates in sections by template-id prefix — Letters · Invoices · Forms · Reports & packs. Recipients are listed
 * once per party (a party can hold several roles) with plain-English roles.
 */
import type { Party } from '@ccguk/domain';
import type { TemplateMeta } from '../../../api/client';

export type ChooserSection = 'letters' | 'invoices' | 'forms' | 'reports';

export const CHOOSER_SECTION_LABEL: Record<ChooserSection, string> = {
  letters: 'Letters',
  invoices: 'Invoices',
  forms: 'Forms',
  reports: 'Reports & packs'
};
export const CHOOSER_SECTION_ORDER: readonly ChooserSection[] = ['letters', 'invoices', 'forms', 'reports'];
export const WORD_SECTION_LABEL = 'CCGUK Word templates';

/** Prefix of a chooser value that opens the Fill dialog (`docx:<id>`; `docx:` alone = choose inside the dialog). */
export const DOCX_PREFIX = 'docx:';

const PREFIX_SECTION: Record<string, ChooserSection> = {
  letter: 'letters',
  notice: 'letters',
  invoice: 'invoices',
  form: 'forms',
  agreement: 'forms',
  statement: 'forms',
  report: 'reports',
  pack: 'reports',
  bundle: 'reports',
  schedule: 'reports',
  certificate: 'reports'
};

/** 'letter.ncaf_chaser' → 'letters'; an unknown prefix goes to Reports & packs (never hidden). */
export function sectionForTemplateId(templateId: string): ChooserSection {
  const prefix = templateId.split('.')[0]?.toLowerCase() ?? '';
  return PREFIX_SECTION[prefix] ?? 'reports';
}

export interface ChooserOption {
  value: string;
  label: string;
}
export interface ChooserGroup {
  label: string;
  options: ChooserOption[];
}

/**
 * Optgroups for the chooser: Word templates (active ones; when none are loaded, a single "choose in the Fill dialog"
 * entry so the route is always one click away), then the built-in sections that have templates, titles sorted.
 */
export function chooserGroups(builtIn: readonly Pick<TemplateMeta, 'id' | 'title'>[], word: readonly { id: string; title: string; active?: boolean }[] = []): ChooserGroup[] {
  const groups: ChooserGroup[] = [];
  const activeWord = word.filter((w) => w.active !== false).sort((a, b) => a.title.localeCompare(b.title));
  groups.push({
    label: WORD_SECTION_LABEL,
    options: activeWord.length ? activeWord.map((w) => ({ value: `${DOCX_PREFIX}${w.id}`, label: `${w.title} (Word)` })) : [{ value: DOCX_PREFIX, label: 'Fill a CCGUK Word template…' }]
  });
  for (const section of CHOOSER_SECTION_ORDER) {
    const options = builtIn
      .filter((t) => sectionForTemplateId(t.id) === section)
      .map((t) => ({ value: t.id, label: t.title }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (options.length) groups.push({ label: CHOOSER_SECTION_LABEL[section], options });
  }
  return groups;
}

/** A chooser value that opens the Fill dialog: the Word template id ('' = let the user pick there), else null. */
export function wordTemplateOf(value: string): string | null {
  return value.startsWith(DOCX_PREFIX) ? value.slice(DOCX_PREFIX.length) : null;
}

/** 'third_party_driver' → 'third party driver'; 'at_fault_insurer' → 'at-fault insurer'. */
export function humaniseRole(role: string): string {
  return role
    .replace(/_/g, ' ')
    .replace(/\bat fault\b/g, 'at-fault')
    .replace(/\btp\b/gi, 'third party')
    .trim();
}

/**
 * Recipient options: each party once (by id), in the order given (the at-fault insurer first), with its roles in
 * plain English and de-duplicated: "Example Insurance plc (insurer)", "Amina Yusuf (claimant, driver)".
 */
export function recipientOptions(parties: ReadonlyArray<Pick<Party, 'id' | 'name' | 'roles'> | null | undefined>): ChooserOption[] {
  const byId = new Map<string, { name: string; roles: string[] }>();
  for (const p of parties) {
    if (!p) continue;
    const entry = byId.get(p.id) ?? { name: p.name, roles: [] };
    for (const r of p.roles ?? []) {
      const h = humaniseRole(r);
      if (h && !entry.roles.includes(h)) entry.roles.push(h);
    }
    byId.set(p.id, entry);
  }
  return [...byId.entries()].map(([id, e]) => ({ value: id, label: e.roles.length ? `${e.name} (${e.roles.join(', ')})` : e.name }));
}

/** A user id shown as the user's name (the id only when the name is unknown, never blank). */
export function userLabel(id: string | undefined, users: ReadonlyArray<{ id: string; name: string }> | undefined): string {
  if (!id) return '';
  return users?.find((u) => u.id === id)?.name ?? (id === 'system' ? 'ClaimDesk' : id);
}

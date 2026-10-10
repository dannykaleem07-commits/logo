// owned by casework
/** Pure helpers for Settings > Brain packs (docs/SUPREME-DESIGN.md §L.10). */
import type { Business, PackPreview } from '../../../api/brainApi';

/** Default precedence by pack kind (lower = higher authority: CCGUK rules before the playbook, §E.1). */
export const DEFAULT_PRECEDENCE: Record<PackPreview['kind'], number> = { ccguk: 30, playbook: 40, learned: 50, other: 60 };

export interface ActivateForm {
  business: Business[];
  precedence: string;
  useForCcguk: boolean;
}

export function initialForm(p: Pick<PackPreview, 'business' | 'precedence' | 'kind'>, useForCcguk = false): ActivateForm {
  return { business: p.business.filter((b): b is Business => b === 'ccguk' || b === 'fixmyfile'), precedence: String(p.precedence ?? DEFAULT_PRECEDENCE[p.kind]), useForCcguk };
}

export function formErrors(f: ActivateForm): { business?: string; precedence?: string } {
  const out: { business?: string; precedence?: string } = {};
  if (!f.business.length) out.business = 'Choose at least one business this pack is for';
  const n = Number(f.precedence);
  if (!/^\d+$/.test(f.precedence.trim()) || n > 1000) out.precedence = 'A whole number from 0 to 1000 (lower wins)';
  return out;
}

/** Only a pack tagged Fixmyfile alone needs the "use for CCGUK claims" tick to reach CCGUK work (§E.1). */
export const needsCcgukTick = (business: Business[]): boolean => !business.includes('ccguk') && business.includes('fixmyfile');

export const kindSummary = (byKind: Record<string, number>): string =>
  Object.entries(byKind)
    .map(([k, n]) => `${n} ${k}`)
    .join(' · ');

/** The import source from what the owner typed or picked. */
export function pathError(p: string): string | undefined {
  const t = p.trim();
  if (!t) return 'Type the full path of a .ccbrain file, a pack folder or a skill folder';
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(t)) return 'Use the full path, for example C:\\Users\\you\\Documents\\my-pack';
  return undefined;
}

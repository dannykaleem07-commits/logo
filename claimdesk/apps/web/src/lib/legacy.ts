/**
 * Legacy-detail guard for free-text settings fields (BLUEPRINT §3.10, lesson i; ARCHITECTURE convention 9).
 * The authoritative list lives in packages/documents/src/brand.ts (`brand.legacy`); it is mirrored here because
 * the web app does not depend on @ccguk/documents. The consistency engine blocks these in drafts; this helper
 * stops them being saved into settings in the first place (registered office, bank name, notes).
 *
 * TODO wire when @ccguk/api lands: the API should reject these on PATCH /settings too; this is the first line.
 */

export interface LegacyHit {
  detail: string;
  /** The exact text found (so the person sees what to remove). */
  found: string;
}

/** Blocked strings. "Carflex Ltd" is blocked in every case except the exact registered style `CARFLEX LTD`. */
export const LEGACY_DETAILS: readonly string[] = ['Car Flex', 'Carflex Ltd', '17360033', '66 Paul Street', 'EC2A 4PX', 'courtesycarsuk.co.uk'];
export const LEGACY_ALLOWED_EXACT: readonly string[] = ['CARFLEX LTD'];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive scan. Spaces inside a detail must be present ("Car Flex" is the two-word legacy trading name;
 * the registered "CARFLEX" is a different string), except in the postcode where "EC2A4PX" is also caught.
 * Returns one hit per legacy detail found.
 */
export function findLegacyDetails(text: string | undefined | null): LegacyHit[] {
  if (!text) return [];
  const hits: LegacyHit[] = [];
  for (const detail of LEGACY_DETAILS) {
    const pattern = new RegExp(escapeRegExp(detail).replace(/\s+/g, detail === 'EC2A 4PX' ? '\\s*' : '\\s+'), 'gi');
    for (const m of text.matchAll(pattern)) {
      const found = m[0];
      if (LEGACY_ALLOWED_EXACT.includes(found)) continue;
      hits.push({ detail, found });
      break;
    }
  }
  return hits;
}

export function hasLegacyDetail(text: string | undefined | null): boolean {
  return findLegacyDetails(text).length > 0;
}

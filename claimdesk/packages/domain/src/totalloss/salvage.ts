/**
 * ABI Code of Practice for the Categorisation of Motorised Vehicle Salvage, 28 May 2025
 * (BLUEPRINT §4.7, Key Finding 7). A (scrap), B (break for parts), S (structurally damaged,
 * repairable), N (non-structurally damaged, repairable). Since 2017 the categories turn on the type
 * of damage, not the cost of repair: a vehicle can be Cat N even where repair exceeds value.
 * Categorisation is by an Appropriately Qualified Person (AQP) and recorded on MIAFTR with the AQP
 * ID. CCGUK records the category and its source; it does not write to MIAFTR.
 *
 * The descriptions and EV notes are operating guidance drawn from the brief; `verification` is
 * 'unverified' until a human records the ABI source URL. Code never upgrades it.
 */
import type { SalvageCategory, Verification } from '../types.js';

export interface SalvageCategoryInfo {
  code: SalvageCategory;
  name: string;
  description: string;
  repairable: boolean;
  /** Whether the vehicle may return to the road after repair. */
  canReturnToRoad: boolean;
  evNote: string;
}

export const SALVAGE_CODE_TITLE = 'ABI Code of Practice for the Categorisation of Motorised Vehicle Salvage';
export const SALVAGE_CODE_DATE = '2025-05-28';

export const SALVAGE_CODE_VERIFICATION: Verification = {
  status: 'unverified',
  sourceNote: `${SALVAGE_CODE_TITLE} dated 28 May 2025, as summarised in the research brief (BLUEPRINT §4.7). Record the ABI publication URL to verify.`,
};

/** What the Code itself provides (as summarised in BLUEPRINT §4.7 / Key Finding 7; unverified until sourced). */
export const SALVAGE_CODE_PRINCIPLES: readonly string[] = [
  'Categorisation is carried out by an Appropriately Qualified Person (AQP) and input to MIAFTR with the AQP ID.',
  'Since 2017 the categories are based on structural versus non-structural damage, not on the cost of repair.',
  'A vehicle can be Cat N where the repair cost exceeds its value but the damage is non-structural.',
  'The 2025 Code adds dedicated rules for EV and hybrid high-voltage batteries.',
];

/** CCGUK's own operating rules around salvage. These are NOT provisions of the ABI Code and must not be cited as such. */
export const SALVAGE_OPERATING_RULES: readonly string[] = [
  'Salvage values vary by category and age; use actual bids or offers, never a fixed percentage of PAV (BLUEPRINT §4.7).',
  'CCGUK records the category and its source on the file; it does not write to MIAFTR.',
];

export const salvageCategories: Record<SalvageCategory, SalvageCategoryInfo> = {
  A: {
    code: 'A',
    name: 'Scrap',
    description:
      'Scrap only. The whole vehicle must be crushed; no parts may be removed for reuse. Applied where the vehicle is burnt out, flood damaged, severely crushed or otherwise unfit for any component salvage.',
    repairable: false,
    canReturnToRoad: false,
    evNote:
      'EV/hybrid: the high-voltage battery must be made safe and decommissioned by qualified handlers before destruction; thermal-event risk persists after fire or flood damage. No battery or HV components may be reused.',
  },
  B: {
    code: 'B',
    name: 'Break',
    description:
      'Break for parts. The body shell must be crushed and the vehicle must never return to the road, but serviceable parts may be removed and reused. Applied to vehicles with extensive structural damage.',
    repairable: false,
    canReturnToRoad: false,
    evNote:
      'EV/hybrid: the battery pack and HV components may be recovered for reuse or recycling only by qualified handlers with the pack assessed for impact or thermal damage; the shell is still destroyed.',
  },
  S: {
    code: 'S',
    name: 'Structurally damaged, repairable',
    description:
      'Structural damage (for example to chassis legs, pillars, floor, suspension mountings or crumple zones) that can be professionally repaired. The vehicle may return to the road once repaired to the manufacturer method; DVLA is notified of the write-off and the category remains on the vehicle history.',
    repairable: true,
    canReturnToRoad: true,
    evNote:
      'EV/hybrid: structural repair near the battery enclosure or HV cabling requires HV isolation, the manufacturer repair method and a post-repair battery integrity check; a damaged pack can turn an economic Cat S repair into a total loss.',
  },
  N: {
    code: 'N',
    name: 'Non-structurally damaged, repairable',
    description:
      'Non-structural damage only (panels, bumpers, lights, glass, interior, electronics, steering or braking components) that can be repaired. The category is about the type of damage, not cost: a Cat N repair may still exceed the vehicle\'s value. The vehicle may return to the road after repair.',
    repairable: true,
    canReturnToRoad: true,
    evNote:
      'EV/hybrid: check the battery casing and underside for impact damage even where the visible damage is non-structural; an undamaged-looking pack can carry a thermal-event risk and should be inspected by a qualified technician.',
  },
};

export const SALVAGE_CATEGORY_ORDER: readonly SalvageCategory[] = ['A', 'B', 'S', 'N'];

export function describeSalvageCategory(code: SalvageCategory, isEvOrHybrid = false): string {
  const c = salvageCategories[code];
  return `Cat ${c.code} (${c.name}): ${c.description}${isEvOrHybrid ? ` ${c.evNote}` : ''}`;
}

/** Previous Cat S/N history is a recognised PAV dispute point (BLUEPRINT §4.3); Cat A/B cannot be on the road. */
export function salvageCategoryAffectsPav(code: SalvageCategory | undefined): boolean {
  return code === 'S' || code === 'N';
}

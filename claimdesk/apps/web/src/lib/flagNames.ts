/** Plain names for claim flag codes (shown instead of the code in toasts; the Flags tab lists their meaning). */
export const FLAG_MEANING: Array<{ code: string; name: string; meaning: string }> = [
  { code: 'FLEET_UNIT_AS_CLIENT_VEHICLE', name: 'Fleet car entered as the client’s car', meaning: 'A CCGUK fleet registration was entered as the client vehicle. Hard stop until corrected.' },
  { code: 'DUPLICATE_REGISTRATION', name: 'Registration on another claim', meaning: 'Another claim exists on this registration. Linked but separate files: own ledger, documents and insurer.' },
  { code: 'NON_INDEPENDENT_WITNESS', name: 'Witness connected to the claimant', meaning: 'A witness is connected to the claimant. Corroborate with CCTV or the third party’s own account.' },
  { code: 'LEGACY_DETAIL', name: 'Old company details', meaning: 'An old company name, number or address was found. Never let it reach a letter.' },
  { code: 'INJURY_REFERRAL', name: 'Injury referred out', meaning: 'Injury reported: the injury element is referred out with no fee; CCGUK continues the damage-only claim.' },
  { code: 'INTAKE_INCOMPLETE', name: 'Intake answers missing', meaning: 'Some intake answers were not taken when the claim was opened. Get them from the client and record them.' },
  { code: 'HIRE_ENFORCEABILITY_GAP', name: 'Hire paperwork missing', meaning: 'Cancellation information, the cancellation form, the express request or the art 60F statement is not recorded (W v Veolia risk).' },
  { code: 'HIRE_DATES_INVALID', name: 'Hire ends before it starts', meaning: 'A hire ends before it starts. It is charged as 0 days until the dates are corrected.' },
  { code: 'MILEAGE_CONFLICT', name: 'Mileage readings disagree', meaning: 'Odometer readings disagree across documents. Resolve before the engineer’s report issues.' },
  { code: 'SUPPLIER_RISK', name: 'Supplier at risk', meaning: 'A counterparty is in strike-off or has overdue filings. Expect challenges to its invoices.' }
];

/** "Intake answers missing" for INTAKE_INCOMPLETE; an unknown code becomes "Some code" (never the raw code). */
export function flagName(code: string): string {
  const known = FLAG_MEANING.find((f) => f.code === code);
  if (known) return known.name;
  const words = code.toLowerCase().replace(/_/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
}

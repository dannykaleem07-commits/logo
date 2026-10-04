/**
 * Counterparty watch presentation (pure; unit-tested). BLUEPRINT §3.11 (lesson k): Companies House status,
 * filing deadlines, gazette (strike-off) notices and officer changes for CARFLEX LTD (12640635) and every
 * supplier and insurer counterparty. Risk level and reasons come from the API; this module labels and sorts.
 */
import type { CompanyWatch } from '@ccguk/domain';
import type { Tone } from '../../lib/status';

export const WATCH_ROLES: Array<{ value: CompanyWatch['role']; label: string }> = [
  { value: 'supplier', label: 'Supplier' },
  { value: 'insurer', label: 'Insurer' },
  { value: 'repairer', label: 'Repairer' },
  { value: 'engineer', label: 'Engineer' },
  { value: 'client', label: 'Client (company)' },
  { value: 'other', label: 'Other' }
];

/** Companies House numbers are 8 characters: 8 digits, or a 2-letter prefix (SC, NI, OC, …) + 6 digits. Digit-only input is zero-padded. */
export function normaliseCompanyNumber(input: string): string {
  const s = input.replace(/\s+/g, '').toUpperCase();
  if (/^\d{1,8}$/.test(s)) return s.padStart(8, '0');
  return s;
}

export function isCompanyNumber(input: string): boolean {
  const s = normaliseCompanyNumber(input);
  return /^(\d{8}|[A-Z]{2}\d{6})$/.test(s);
}

export function companiesHouseUrl(companyNumber: string): string {
  return `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(normaliseCompanyNumber(companyNumber))}`;
}

export function riskTone(level: CompanyWatch['riskLevel']): Tone {
  switch (level) {
    case 'high':
      return 'red';
    case 'medium':
      return 'amber';
    case 'low':
      return 'green';
  }
}

/** Companies House status strings → tone. Anything with strike-off, dissolved, liquidation or administration is red. */
export function companyStatusTone(status: string | undefined): Tone {
  if (!status) return 'grey';
  const s = status.toLowerCase();
  if (/strike|dissolv|liquidat|administrat|insolven|receiver|closed|converted/.test(s)) return 'red';
  if (s === 'active') return 'green';
  return 'amber';
}

export function companyStatusLabel(status: string | undefined): string {
  if (!status) return 'not polled';
  return status.replace(/-/g, ' ');
}

/** Strike-off related gazette notices (first Gazette notice, proposal to strike off, suspension…). */
export function strikeOffNotices(w: Pick<CompanyWatch, 'gazetteNotices'>): CompanyWatch['gazetteNotices'] {
  return (w.gazetteNotices ?? []).filter((n) => /strike|gazette|dissol/i.test(`${n.type} ${n.note}`));
}

/** High risk first, then medium, then low; alphabetical within a band. */
export function sortWatch(rows: CompanyWatch[]): CompanyWatch[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return [...rows].sort((a, b) => rank[a.riskLevel] - rank[b.riskLevel] || a.name.localeCompare(b.name));
}

/** The supplier-risk banner text (BLUEPRINT §3.11): insurers checking the vendor will see the same thing. */
export function supplierRiskBanner(rows: CompanyWatch[]): string | undefined {
  const risky = rows.filter((w) => w.riskLevel === 'high' && (w.role === 'supplier' || w.role === 'repairer' || w.role === 'engineer'));
  if (risky.length === 0) return undefined;
  const names = risky.map((w) => `${w.name} (${w.companyNumber})`).join(', ');
  return `High-risk supplier${risky.length === 1 ? '' : 's'}: ${names}. Insurers checking the vendor will see the same Companies House record — expect challenges to invoices from ${risky.length === 1 ? 'this supplier' : 'these suppliers'} and keep the vendor verification pack ready.`;
}

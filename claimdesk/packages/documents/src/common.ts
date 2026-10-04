/**
 * Shared data shapes for templates. Every template's data object is assembled by the API from the ledger,
 * events and settings; these are the pieces that appear in (almost) every document.
 *
 * Fixtures (`sample*()`) are used by `Template.sample()` implementations and by tests. They never contain a
 * legacy address, number or domain (brand.legacy.blockedStrings).
 */
import type { ISODate, ISODateTime, Pence } from '@ccguk/domain';

/** Document kinds (ARCHITECTURE.md "Documents"). Drives default layout choices (e.g. invoices show the company block). */
export type TemplateKind =
  | 'letter'
  | 'invoice'
  | 'report'
  | 'notice'
  | 'agreement'
  | 'form'
  | 'statement'
  | 'pack'
  | 'bundle'
  | 'schedule'
  | 'certificate';

export type RecipientRole = 'at_fault_insurer' | 'client' | 'own_insurer' | 'court' | 'supplier' | 'other';

/**
 * Printed in the same paragraph wherever a GTA paragraph is cited, so the benchmark status is never left to inference
 * (perimeter.md: the GTA is an industry benchmark for a non-subscriber, never an entitlement).
 */
export const GTA_BENCHMARK_SENTENCE = 'We are not a GTA subscriber and refer to the GTA as an industry benchmark only.';

/** Company-level settings held in the API settings table (never hard-coded in templates). */
export interface CompanySettings {
  /** Registered office as it should print. Placeholder "[registered office]" until set. */
  registeredOffice: string;
  vatNumber?: string;
  bank: {
    /** Must equal the exact registered name so Confirmation of Payee returns a full match. */
    accountName: string;
    sortCode: string;
    accountNumber: string;
    bankName: string;
  };
  icoRegistration?: string;
  /** Default signatory for outgoing letters (the handler or director approving the document). */
  signatoryName: string;
  signatoryRole: string;
}

/** The addressee block of a letter, notice or invoice. */
export interface RecipientBlock {
  name: string;
  addressLines: string[];
  /** "Claims Department", "Third Party Claims Team" — printed as an attention line. */
  attention?: string;
  /** When set, the letter shows "By email: …" above the address. */
  email?: string;
}

/** The facts that identify the claim on every document. */
export interface ClaimHeader {
  ourReference: string; // e.g. CCG-2026-00012
  theirReference?: string; // insurer / handling reference
  claimantName: string;
  vehicleRegistration: string; // normalised; formatted for display by formatRegistration
  vehicleDescription?: string; // "Volkswagen Golf 1.5 TSI Life"
  accidentDate: ISODate | ISODateTime;
  insurerName?: string; // at-fault insurer
  thirdPartyName?: string; // the insured driver / policyholder
  thirdPartyRegistration?: string;
  policyNumber?: string;
}

export interface Signatory {
  name: string;
  role: string;
}

/** Fields every template data object carries. Extend this for a template's own data. */
export interface BaseDocumentData {
  settings: CompanySettings;
  /** The document date, supplied by the API (templates never read the clock). */
  date: ISODate | ISODateTime;
  claim: ClaimHeader;
  recipient?: RecipientBlock;
  signatory?: Signatory;
}

/** A labelled money or text row for figures tables. */
export interface FigureRow {
  label: string;
  valuePence?: Pence;
  text?: string;
  note?: string;
  /** Bold with a rule above — totals. */
  emphasis?: boolean;
}

// ---------------------------------------------------------------------------
// Fixtures — placeholder values only; nothing here is a real client or a legacy detail
// ---------------------------------------------------------------------------

export function sampleSettings(overrides: Partial<CompanySettings> = {}): CompanySettings {
  return {
    registeredOffice: '[registered office]',
    bank: {
      accountName: 'Courtesy Cars Group UK Ltd',
      sortCode: '00-00-00',
      accountNumber: '00000000',
      bankName: '[bank name]'
    },
    signatoryName: 'D. Kaleem',
    signatoryRole: 'Claims Manager',
    ...overrides
  };
}

export function sampleRecipient(overrides: Partial<RecipientBlock> = {}): RecipientBlock {
  return {
    name: 'Example Insurance plc',
    attention: 'Third Party Claims Team',
    addressLines: ['PO Box 100', 'Example Town', 'EX1 1AA'],
    email: 'thirdpartyclaims@example-insurer.test',
    ...overrides
  };
}

export function sampleClaim(overrides: Partial<ClaimHeader> = {}): ClaimHeader {
  return {
    ourReference: 'CCG-2026-00012',
    theirReference: 'EXI/TP/4471920',
    claimantName: 'Ms Jane Example',
    vehicleRegistration: 'AB12CDE',
    vehicleDescription: 'Volkswagen Golf 1.5 TSI Life',
    accidentDate: '2026-08-09',
    insurerName: 'Example Insurance plc',
    thirdPartyName: 'Mr John Sample',
    thirdPartyRegistration: 'XY65ZZZ',
    ...overrides
  };
}

export function sampleSignatory(overrides: Partial<Signatory> = {}): Signatory {
  return { name: 'D. Kaleem', role: 'Claims Manager', ...overrides };
}

/** A complete base data object; spread it into a template's sample() and add the template's own fields. */
export function sampleBaseData(overrides: Partial<BaseDocumentData> = {}): BaseDocumentData {
  return {
    settings: sampleSettings(),
    date: '2026-10-04',
    claim: sampleClaim(),
    recipient: sampleRecipient(),
    signatory: sampleSignatory(),
    ...overrides
  };
}

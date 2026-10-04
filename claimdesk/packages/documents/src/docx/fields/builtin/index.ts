/**
 * The ten CCGUK Word templates that ship with ClaimDesk (design doc §C.1) and their curated mappings (Appendix 2).
 *
 * Mappings are JSON data next to this file, written with selectors against the scan of the asset whose sha256 they
 * record. DOCX templates are not registered in the HTML template registry.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BuiltinDocxTemplate, TemplateMapping } from '../types.js';

const BRAND_CLAIM_IMAGE = {
  code: 'BRAND_CLAIM_IMAGE' as const,
  message: 'The first-page footer carries an accreditation strip image. Check that every mark on it is one CCGUK is entitled to use before sending.'
};

export const BUILTIN_DOCX_TEMPLATES: readonly BuiltinDocxTemplate[] = Object.freeze([
  {
    id: 'agreement.ccguk_01_customer_loa',
    file: 'CCGUK-01-Customer-Agreement-and-Letter-of-Authority.docx',
    kind: 'agreement',
    title: 'Customer Agreement & Letter of Authority',
    recipientRole: 'client',
    subjects: [],
    variants: [],
    knownWarnings: [
      { code: 'LEGACY_DETAIL', message: 'The printed wording names the former storage partner (CarFlex). Confirm the wording is current before sending.' },
      BRAND_CLAIM_IMAGE
    ]
  },
  {
    id: 'agreement.ccguk_02_recovery_storage_engineering',
    file: 'CCGUK-02_Recovery_Storage_Engineering_Pack_TEMPLATE_v5.docx',
    kind: 'agreement',
    title: 'Recovery, Storage & Engineering Pack',
    recipientRole: 'client',
    subjects: [],
    variants: [
      { id: 'instruction', label: 'Instruction (cover, A1, A2)', default: true },
      { id: 'submission', label: 'Submission (+ C1 service record)' }
    ],
    knownWarnings: [{ code: 'LEGACY_DETAIL', message: 'The printed wording names "CarFlex" (recovery and storage yard). Confirm the wording is current before sending.' }]
  },
  {
    id: 'agreement.ccguk_03_credit_hire',
    file: 'CCGUK-03-Vehicle-Credit-Hire-Agreement.docx',
    kind: 'agreement',
    title: 'Vehicle Credit Hire Agreement',
    recipientRole: 'client',
    subjects: ['hire'],
    variants: [
      { id: 'hirer', label: "Hirer's copy (without the internal enforceability check)", removeBlocks: ['enforceability-check'], default: true },
      { id: 'office', label: 'Office copy (full)' }
    ],
    knownWarnings: [BRAND_CLAIM_IMAGE]
  },
  {
    id: 'statement.ccguk_04_witness',
    file: 'CCGUK-04-Witness-Statement.docx',
    kind: 'statement',
    title: 'Witness Statement',
    recipientRole: 'client',
    subjects: ['witness'],
    variants: [],
    knownWarnings: []
  },
  {
    id: 'form.ccguk_05_payment_direction',
    file: 'CCGUK-05-Payment-Authorisation-and-Settlement-Direction.docx',
    kind: 'form',
    title: 'Payment Authorisation & Settlement Direction',
    recipientRole: 'client',
    subjects: [],
    variants: [],
    knownWarnings: [BRAND_CLAIM_IMAGE]
  },
  {
    id: 'form.ccguk_06_handover_condition',
    file: 'CCGUK-06-Vehicle-Handover-and-Condition-Report.docx',
    kind: 'form',
    title: 'Vehicle Handover & Condition Report',
    recipientRole: 'client',
    subjects: ['hire'],
    variants: [
      { id: 'release', label: 'Release (vehicle out)', default: true },
      { id: 'return', label: 'Return (vehicle in)' }
    ],
    knownWarnings: []
  },
  {
    id: 'form.ccguk_07_statement_of_means',
    file: 'CCGUK-07-Statement-of-Means.docx',
    kind: 'form',
    title: 'Statement of Means',
    recipientRole: 'client',
    subjects: ['hire'],
    variants: [],
    knownWarnings: []
  },
  {
    id: 'form.ccguk_08_intervention_mitigation',
    file: 'CCGUK-08-Intervention-and-Mitigation-Record.docx',
    kind: 'form',
    title: 'Intervention & Mitigation Record',
    recipientRole: 'client',
    subjects: ['offer'],
    variants: [],
    knownWarnings: []
  },
  {
    id: 'form.ccguk_09_accident_report',
    file: 'CCGUK-09-Accident-Report-Form.docx',
    kind: 'form',
    title: 'Accident Report Form',
    recipientRole: 'client',
    subjects: [],
    variants: [],
    knownWarnings: [BRAND_CLAIM_IMAGE]
  },
  {
    id: 'letter.ccguk_letterhead_formal',
    file: 'CCGUK-Letterhead-Formal.docx',
    kind: 'letter',
    title: 'Letter on CCGUK letterhead',
    recipientRole: 'at_fault_insurer',
    subjects: ['recipient'],
    variants: [],
    knownWarnings: [{ code: 'REGULATED_STATUS', message: 'The printed opening says "We act on behalf of our client". CCGUK is not a firm of solicitors; keep the wording to claims handling and do not imply regulated legal representation.' }]
  }
] satisfies BuiltinDocxTemplate[]);

export const LETTERHEAD_TEMPLATE_ID = 'letter.ccguk_letterhead_formal';

function builtin(id: string): BuiltinDocxTemplate {
  const t = BUILTIN_DOCX_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown built-in DOCX template ${id}`);
  return t;
}

export function isBuiltinDocxTemplate(id: string): boolean {
  return BUILTIN_DOCX_TEMPLATES.some((x) => x.id === id);
}

const mappingCache = new Map<string, TemplateMapping>();

/** The curated mapping (a fresh deep copy each call). */
export function builtinMapping(id: string): TemplateMapping {
  builtin(id);
  let m = mappingCache.get(id);
  if (!m) {
    m = JSON.parse(readFileSync(new URL(`./${id}.mapping.json`, import.meta.url), 'utf8')) as TemplateMapping;
    mappingCache.set(id, m);
  }
  return JSON.parse(JSON.stringify(m)) as TemplateMapping;
}

/** Absolute path of the shipped .docx (works from source and from the packaged app/packages/documents). */
export function builtinAssetPath(id: string): string {
  return fileURLToPath(new URL(`../../../../assets/docx/${builtin(id).file}`, import.meta.url));
}

export function builtinAssetBytes(id: string): Uint8Array {
  return new Uint8Array(readFileSync(builtinAssetPath(id)));
}

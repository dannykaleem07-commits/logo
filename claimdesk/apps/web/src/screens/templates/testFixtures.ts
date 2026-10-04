/**
 * Test fixtures for the Word template screens (templates.test.ts, fillValues.test.ts and the smoke tests). Shapes
 * follow docs/TEMPLATES-VEHICLES-DESKTOP.md §C.5; the values mirror the CCGUK-01 mapping in Appendix 2.
 * Not imported by application code.
 */
import type { ClaimDocument } from '../../api/client';
import type { ClaimTemplateValues, DocxTemplateDetail, DocxTemplateSummary, PlanRow } from '../../api/templatesApi';
import type { ClaimView } from '../claim/claimFile';

export const T01 = 'agreement.ccguk_01_customer_loa';
export const T03 = 'agreement.ccguk_03_credit_hire';
export const T04 = 'statement.ccguk_04_witness';
export const TLH = 'letter.ccguk_letterhead_formal';

export function summary(over: Partial<DocxTemplateSummary> & Pick<DocxTemplateSummary, 'id' | 'title' | 'kind'>): DocxTemplateSummary {
  return {
    format: 'docx',
    source: 'builtin',
    fileName: `${over.id}.docx`,
    fileVersion: 1,
    mappingRevision: 0,
    sha256: 'a'.repeat(64),
    bytes: 48_000,
    slotCount: 40,
    mappedCount: 30,
    ignoredCount: 10,
    unmappedCount: 0,
    warnings: [],
    warningsAcknowledged: true,
    active: true,
    subjects: [],
    variants: [],
    updatedAt: '2026-10-04T09:00:00.000Z',
    ...over
  };
}

export const TEMPLATE_LIST: DocxTemplateSummary[] = [
  summary({ id: TLH, title: 'Letter on CCGUK letterhead', kind: 'letter', subjects: ['recipient'], recipientRole: 'at_fault_insurer', warnings: [{ code: 'REGULATED_STATUS', message: 'The letter says "our client"', excerpt: 'on behalf of our client' }], warningsAcknowledged: false }),
  summary({ id: T04, title: 'Witness Statement', kind: 'statement', subjects: ['witness'] }),
  summary({
    id: T03,
    title: 'Vehicle Credit Hire Agreement',
    kind: 'agreement',
    subjects: ['hire'],
    variants: [
      { id: 'hirer', label: 'Hirer copy (without the internal enforceability page)', default: true },
      { id: 'office', label: 'Office copy' }
    ]
  }),
  summary({ id: T01, title: 'Customer Agreement & Letter of Authority', kind: 'agreement', description: 'Client agreement and authority to act', unmappedCount: 2, mappedCount: 28 }),
  summary({ id: 'form.ccguk_09_accident_report', title: 'Accident Report Form', kind: 'form' }),
  summary({ id: 'letter.user_chaser_1a2b', title: 'Chaser letter', kind: 'letter', source: 'uploaded' }),
  summary({ id: 'form.user_old_9f9f', title: 'Old form', kind: 'form', source: 'uploaded', active: false })
];

export function row(over: Partial<PlanRow> & Pick<PlanRow, 'slotId' | 'label'>): PlanRow {
  return {
    section: over.slotId.split('/')[0] ?? '',
    sectionTitle: '',
    kind: 'cell',
    inputType: 'text',
    policy: 'auto',
    editable: true,
    value: null,
    display: '',
    origin: 'none',
    needsConfirmation: false,
    confirmed: false,
    required: false,
    missing: false,
    preview: '',
    ...over
  };
}

const S01 = '01-customer-and-claim-details';

/** GET /claims/claim-1/docx-templates/agreement.ccguk_01_customer_loa/values */
export function values01(): ClaimTemplateValues {
  const title = [
    row({ slotId: 'title/reference', section: 'title', sectionTitle: 'Title block', label: 'Reference', key: 'claim.reference', value: 'CCG-2026-00012', display: 'CCG-2026-00012', origin: 'claim', sourcePath: 'bundle.claim.reference', kind: 'blank' }),
    row({ slotId: 'title/date', section: 'title', sectionTitle: 'Title block', label: 'Date', key: 'doc.date', policy: 'suggest', inputType: 'date', value: '2026-10-04', display: '04 / 10 / 2026', origin: 'suggested', needsConfirmation: true, kind: 'blank' })
  ];
  const s01 = [
    row({ slotId: `${S01}/customer-full-name`, section: S01, sectionTitle: '01 Customer and claim details', label: 'Customer full name', key: 'claimant.name', value: 'Amelia Hart', display: 'Amelia Hart', origin: 'claim', sourcePath: 'bundle.claimant.name' }),
    row({ slotId: `${S01}/date-of-birth`, section: S01, sectionTitle: '01 Customer and claim details', label: 'Date of birth', key: 'claimant.dateOfBirth', policy: 'auto-if-known', inputType: 'date', value: null, display: '' }),
    row({ slotId: `${S01}/registration`, section: S01, sectionTitle: '01 Customer and claim details', label: 'Registration', key: 'vehicle.registration', value: 'AB12 CDE', display: 'AB12 CDE', origin: 'claim', widthTwips: 1134 }),
    row({ slotId: `${S01}/mileage`, section: S01, sectionTitle: '01 Customer and claim details', label: 'Mileage', key: 'vehicle.mileageAtAccident', policy: 'auto-if-known', inputType: 'int', value: null }),
    row({ slotId: `${S01}/own-claim-ref`, section: S01, sectionTitle: '01 Customer and claim details', label: 'Own claim ref.', key: 'ownInsurer.claimRef', policy: 'handler', value: null, widthTwips: 1134 })
  ];
  const s08 = [
    row({ slotId: '08-settlement-authority/standard-authority', section: '08-settlement-authority', sectionTitle: '08 Settlement authority', label: 'STANDARD AUTHORITY', key: 'claim.settlementAuthority', policy: 'handler', inputType: 'checkbox', kind: 'checkbox', value: null, note: 'If neither box is ticked, Standard Authority applies' })
  ];
  const s13 = [
    row({ slotId: '13-client-authorisation/@client/full-name', section: '13-client-authorisation', sectionTitle: '13 Client authorisation', label: 'Full name', key: 'claimant.name', policy: 'auto-if-known', value: 'Amelia Hart', display: 'Amelia Hart', origin: 'claim' }),
    row({ slotId: '13-client-authorisation/@client/signature', section: '13-client-authorisation', sectionTitle: '13 Client authorisation', label: 'Signature', policy: 'signature', editable: false, kind: 'line' }),
    row({ slotId: '13-client-authorisation/@client/date-signed', section: '13-client-authorisation', sectionTitle: '13 Client authorisation', label: 'Date signed', policy: 'signature', editable: false, kind: 'line' })
  ];
  return {
    template: TEMPLATE_LIST.find((t) => t.id === T01)!,
    claimId: 'claim-1',
    subjects: {},
    groups: [
      { section: 'title', title: 'Title block', rows: title },
      { section: S01, title: '01 Customer and claim details', rows: s01 },
      { section: '08-settlement-authority', title: '08 Settlement authority', rows: s08 },
      { section: '13-client-authorisation', title: '13 Client authorisation', rows: s13 }
    ],
    issues: [{ code: 'printedRates', severity: 'warn', message: 'The records use rates that differ from the printed contract' }],
    summary: { fromClaim: 4, toConfirm: 1, toEnter: 4, leftForSigning: 2, leftAsPrinted: 0 }
  };
}

/** A credit hire agreement plan with a GTA figure that is not verified. */
export function values03(): ClaimTemplateValues {
  return {
    template: TEMPLATE_LIST.find((t) => t.id === T03)!,
    claimId: 'claim-1',
    variant: 'hirer',
    subjects: { hires: [{ id: 'hire-1', label: 'CCG-H-000123 — from 2026-09-01' }] },
    groups: [
      {
        section: '04-charges',
        title: '04 Charges',
        rows: [
          row({ slotId: '04-charges/gta-daily-rate', section: '04-charges', label: 'GTA daily rate', key: 'hire.gtaDailyRatePence', inputType: 'money', policy: 'suggest', value: 8650, display: '£86.50', origin: 'suggested', needsConfirmation: true, verification: 'unverified', sourcePath: 'gtaRates' }),
          row({ slotId: '04-charges/hire-reference', section: '04-charges', label: 'Hire reference', policy: 'handler', required: true, value: null })
        ]
      }
    ],
    issues: [{ code: 'VALUES_REQUIRED', severity: 'block', message: 'Hire reference is required', slotId: '04-charges/hire-reference' }],
    summary: { fromClaim: 0, toConfirm: 1, toEnter: 1, leftForSigning: 0, leftAsPrinted: 0 }
  };
}

export function claimView(): ClaimView {
  const party = (id: string, name: string, roles: string[]) => ({ id, kind: 'individual', name, roles, createdAt: '2026-09-01T09:00:00.000Z' });
  return {
    claim: { id: 'claim-1', reference: 'CCG-2026-00012' },
    claimant: party('p-client', 'Amelia Hart', ['claimant']),
    vehicle: { id: 'v-1', registration: 'AB12CDE' },
    thirdParties: [party('p-tp', 'Tom Driver', ['third_party_driver']), party('p-w1', 'Wendy Witness', ['witness'])],
    atFaultInsurer: party('p-ins', 'Example Insurance plc', ['at_fault_insurer']),
    events: [],
    ledger: [],
    offers: [],
    hire: [{ id: 'hire-1', agreementNumber: 'CCG-H-000123', startAt: '2026-09-01T09:00:00.000Z' }],
    storage: [],
    recovery: [],
    evidence: [{ id: 'ev-1', filename: 'dashcam.mp4', description: 'Dashcam clip' }],
    documents: [],
    clocks: []
  } as unknown as ClaimView;
}

export function docxDocument(over: Partial<ClaimDocument> = {}): ClaimDocument {
  return {
    id: 'doc-1',
    claimId: 'claim-1',
    templateId: T01,
    templateVersion: '1',
    title: 'Customer Agreement & Letter of Authority',
    status: 'draft',
    html: '<!DOCTYPE html><html><body><p>Preview</p></body></html>',
    sha256: 'b'.repeat(64),
    createdAt: '2026-10-04T10:00:00.000Z',
    createdBy: 'courtesycars',
    format: 'docx',
    docxSha256: 'b'.repeat(64),
    dataSnapshot: {
      _docx: {
        templateId: T01,
        templateSha256: 'a'.repeat(64),
        fileVersion: 1,
        mappingRevision: 0,
        scannerVersion: 1,
        inputs: {},
        confirm: ['title/date'],
        values: [
          { slotId: 'title/reference', key: 'claim.reference', display: 'CCG-2026-00012', origin: 'claim' },
          { slotId: '13-client-authorisation/@client/full-name', key: 'claimant.name', display: 'Amelia Hart', origin: 'claim' },
          { slotId: '01-customer-and-claim-details/own-claim-ref', display: 'OWN-123', origin: 'handler' }
        ],
        removedBlocks: [],
        docxSha256: 'b'.repeat(64)
      }
    },
    ...over
  } as ClaimDocument;
}

export function detail01(): DocxTemplateDetail {
  const base = TEMPLATE_LIST.find((t) => t.id === T01)!;
  return {
    ...base,
    warnings: [{ code: 'LEGACY_DETAIL', message: 'The storage clause names a former supplier', excerpt: 'former supplier wording' }],
    warningsAcknowledged: false,
    slots: [
      { id: 'header/ref', kind: 'cell', part: 'word/header1.xml', sectionPath: ['header'], sectionTitles: [], label: 'Ref', labelSlug: 'ref', ordinal: 1, preview: '', signature: false, hint: false, multiline: false },
      { id: 'title/reference', kind: 'blank', part: 'word/document.xml', sectionPath: ['title'], sectionTitles: [], label: 'Reference', labelSlug: 'reference', ordinal: 1, preview: 'CCG-', signature: false, hint: false, multiline: false },
      { id: `${S01}/registration`, kind: 'cell', part: 'word/document.xml', sectionPath: [S01], sectionTitles: ['01 Customer and claim details'], label: 'Registration', labelSlug: 'registration', ordinal: 1, preview: '', signature: false, hint: false, multiline: false },
      { id: `${S01}/own-claim-ref`, kind: 'cell', part: 'word/document.xml', sectionPath: [S01], sectionTitles: ['01 Customer and claim details'], label: 'Own claim ref.', labelSlug: 'own-claim-ref', ordinal: 1, preview: '', signature: false, hint: false, multiline: false },
      { id: `${S01}/notes`, kind: 'block', part: 'word/document.xml', sectionPath: [S01], sectionTitles: ['01 Customer and claim details'], label: 'Notes', labelSlug: 'notes', ordinal: 1, preview: '', signature: false, hint: false, multiline: true },
      { id: '13-client-authorisation/@client/signature', kind: 'line', part: 'word/document.xml', sectionPath: ['13-client-authorisation'], sectionTitles: ['13 Client authorisation'], qualifier: 'client', qualifierTitle: 'Client', label: 'Signature', labelSlug: 'signature', ordinal: 1, preview: '', signature: true, hint: false, multiline: false },
      { id: '05-services/recovery', kind: 'checkbox', part: 'word/document.xml', sectionPath: ['05-services'], sectionTitles: ['05 Services'], label: 'Recovery', labelSlug: 'recovery', ordinal: 1, preview: '☐', signature: false, hint: false, multiline: false }
    ],
    blocks: [],
    outline: [
      { level: 1, title: '01 Customer and claim details', slug: S01 },
      { level: 1, title: '05 Services', slug: '05-services' },
      { level: 1, title: '13 Client authorisation', slug: '13-client-authorisation' }
    ],
    mapping: [
      { slotId: 'header/ref', policy: 'never', origin: 'builtin', ignored: true },
      { slotId: 'title/reference', key: 'claim.reference', policy: 'auto', origin: 'builtin', ignored: false },
      { slotId: `${S01}/registration`, key: 'vehicle.registration', policy: 'auto', origin: 'saved', ignored: false },
      { slotId: `${S01}/own-claim-ref`, key: 'ownInsurer.claimRef', policy: 'handler', origin: 'suggested', score: 0.82, ignored: false },
      { slotId: `${S01}/notes`, policy: 'handler', origin: 'none', ignored: false },
      { slotId: '13-client-authorisation/@client/signature', policy: 'signature', origin: 'builtin', ignored: false },
      { slotId: '05-services/recovery', key: 'services.recovery', policy: 'suggest', when: 'yes', origin: 'builtin', ignored: false }
    ],
    mappingIssues: [],
    fields: [
      { key: 'claim.reference', group: 'Claim', label: 'Claim reference', type: 'text', policy: 'auto' },
      { key: 'vehicle.registration', group: 'Client vehicle', label: 'Registration', type: 'text', policy: 'auto' },
      { key: 'ownInsurer.claimRef', group: 'Insurers', label: 'Own insurer claim reference', type: 'text', policy: 'handler' },
      { key: 'services.recovery', group: 'Claim', label: 'Recovery service', type: 'bool', policy: 'suggest' }
    ]
  };
}

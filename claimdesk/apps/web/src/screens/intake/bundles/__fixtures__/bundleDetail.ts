// owned by intake-web
/**
 * Synthetic BundleDetail for the web tests (docs/SMART-INTAKE.md §16.5). Invented people ("Jane Doe", "Ali Example"),
 * invented references and plates already used in the synthetic fixtures. This typed object is the source of
 * `bundleDetail.json` (a test checks the two are identical, so the JSON type-checks against bundlesApi.ts).
 */
import { signalCounts, type BundleDetail, type BundleSummary, type CaseBriefView, type FieldSource, type RegisterResult } from '../../../../api/bundlesApi';

const T = '2026-10-07T09:00:00.000Z';

function src(fileId: string, filename: string, docType: string | null, docTypeLabel: string | null, page: number | null, quote: string | null, confidence: number, rank: number, engine: FieldSource['engine'] = 'ai'): FieldSource {
  return { fileId, itemId: `item-${fileId}`, evidenceId: `ev-${fileId}`, filename, docType, docTypeLabel, page, quote, confidence, engine, rank, label: docTypeLabel ? `${docTypeLabel}${page ? `, page ${page}` : ''}` : filename, quoteVerified: quote ? true : null };
}

const V5C = (page: number, quote: string, c = 0.97) => src('f1', 'SMART-A-V5C.pdf', 'v5c', 'V5C', page, quote, c, 100);
const FORM = (page: number, quote: string, c = 0.9) => src('f2', 'claim-form.pdf', 'signed_ccguk_form', 'Signed accident report', page, quote, c, 88);
const EST = (page: number, quote: string | null, c = 0.8) => src('f8', 'pack.pdf (pages 3-4).pdf', 'bodyshop_estimate', 'Bodyshop estimate', page, quote, c, 75);
const LIC = (quote: string) => src('f13', 'licence-front.png', 'driving_licence', 'Driving licence', 1, quote, 0.93, 100);

const fileBase = {
  sha256: 'a'.repeat(64),
  addedAt: T,
  parentFileId: null,
  segment: null,
  waiting: null,
  error: null,
  docSide: null,
  documentDate: null,
  pages: 1,
  summary: null,
  pinned: false,
  excluded: false,
  duplicate: null,
  photo: null,
  pdfMeta: null,
  archive: null,
  filed: null,
} as const;

function file(id: string, position: number, filename: string, mime: string, groupKey: string, extra: Partial<BundleDetail['files'][number]> = {}): BundleDetail['files'][number] {
  return {
    ...fileBase,
    id,
    itemId: `item-${id}`,
    evidenceId: `ev-${id}`,
    filename,
    mime,
    bytes: 20_480,
    position,
    role: 'document',
    stage: 'read',
    stageLabel: 'Read',
    docType: null,
    docTypeLabel: null,
    docTypeConfidence: null,
    engine: 'ai',
    groupKey,
    fileUrl: `/api/evidence/ev-${id}/file`,
    ...extra,
  };
}

export const BUNDLE_DETAIL: BundleDetail = {
  id: 'b1',
  name: 'Jane Doe – Corsa crash',
  status: 'needs_you',
  readiness: 'needs_review',
  source: 'upload',
  folderKey: null,
  parentBundleId: null,
  revision: 7,
  computedRevision: 7,
  createdAt: T,
  updatedAt: T,
  createdBy: 'courtesycars',
  fileCounts: { total: 13, read: 12, inProgress: 0, waitingAi: 1, failed: 0, skipped: 0, duplicates: 1 },
  groupCount: 4,
  conflictsOpen: 2,
  missingDocs: 3,
  reasoning: { status: 'waiting_ai', at: null, waiting: { reason: 'agents_off' } },
  autoRegister: { settingOn: false, eligible: false, blockers: [{ code: 'SETTING_OFF', text: 'Automatic registration is off (Settings > Intake).', for: 'auto' }] },
  claim: null,
  needsYouId: 'ny-bundle-1',
  error: null,
  files: [
    file('f1', 1, 'SMART-A-V5C.pdf', 'application/pdf', 'main', { docType: 'v5c', docTypeLabel: 'V5C', docTypeConfidence: 0.97, summary: 'Registration certificate for KX21 ABC' }),
    file('f2', 2, 'claim-form.pdf', 'application/pdf', 'main', { docType: 'signed_ccguk_form', docTypeLabel: 'Signed accident report', docTypeConfidence: 0.92, pages: 2, engine: 'rules', stage: 'read_rules_only', stageLabel: 'Read without AI' }),
    file('f3', 3, 'IMG_2041.png', 'image/png', 'main', {
      docType: 'damage_photo',
      docTypeLabel: 'Damage photo',
      docTypeConfidence: 0.9,
      pages: null,
      photo: { takenAt: '2026-10-07T14:40:00.000Z', gps: { lat: 51.5, lon: -0.12 }, software: null, scene: 'damage', plates: [{ text: 'KX21 ABC', normalised: 'KX21ABC', confidence: 0.95, matches: 'client' }], zones: [{ zoneId: 'front_bumper', label: 'Front bumper', severity: 2, confidence: 0.86 }] },
    }),
    file('f4', 4, 'IMG_2041 (1).png', 'image/png', 'main', { docType: 'damage_photo', docTypeLabel: 'Damage photo', pages: null, duplicate: { of: 'f3', kind: 'near_photo', similarity: 0.97 }, photo: { takenAt: '2026-10-07T14:40:00.000Z', gps: null, software: null, scene: 'damage', plates: [], zones: [] } }),
    file('f5', 5, 'IMG_1999.png', 'image/png', 'main', {
      docType: 'damage_photo',
      docTypeLabel: 'Damage photo',
      pages: null,
      photo: { takenAt: '2026-10-04T10:00:00.000Z', gps: null, software: 'Snapseed', scene: 'damage', plates: [{ text: 'AB12 CDE', normalised: 'AB12CDE', confidence: 0.7, matches: null }], zones: [{ zoneId: 'bonnet', label: 'Bonnet', severity: 1, confidence: 0.7 }] },
    }),
    file('f6', 6, 'pack.pdf', 'application/pdf', 'main', { role: 'pack', pages: 4, docTypeLabel: 'Scanned pack', summary: 'Split into 2 documents', pdfMeta: { producer: 'iLovePDF', creator: null, createdAt: '2026-09-01T09:00:00.000Z', modifiedAt: '2026-10-01T09:00:00.000Z', incrementalUpdates: 2 } }),
    file('f7', 7, 'pack.pdf (pages 1-2).pdf', 'application/pdf', 'main', { role: 'segment', parentFileId: 'f6', segment: { fromPage: 1, toPage: 2 }, docType: 'police_report', docTypeLabel: 'Police report', pages: 2 }),
    file('f8', 8, 'pack.pdf (pages 3-4).pdf', 'application/pdf', 'main', { role: 'segment', parentFileId: 'f6', segment: { fromPage: 3, toPage: 4 }, docType: 'bodyshop_estimate', docTypeLabel: 'Bodyshop estimate', pages: 2 }),
    file('f9', 9, 'SMART-B-V5C.pdf', 'application/pdf', 'case:B', { docType: 'v5c', docTypeLabel: 'V5C', docTypeConfidence: 0.95 }),
    file('f10', 10, 'letter-ccg-00001.pdf', 'application/pdf', 'claim:c-old', { docType: 'insurer_letter', docTypeLabel: 'Insurer letter', documentDate: '2026-10-05' }),
    file('f11', 11, 'IMG_3000.png', 'image/png', 'unsure', { docType: 'vehicle_photo_other', docTypeLabel: 'Vehicle photo', pages: null, stage: 'waiting_ai', stageLabel: 'Waiting for the AI', waiting: { reason: 'agents_off' }, engine: null, photo: { takenAt: null, gps: null, software: null, scene: null, plates: [], zones: [] } }),
    file('f12', 12, 'notes.txt', 'text/plain', 'excluded', { excluded: true, pinned: true, docType: 'other', docTypeLabel: 'Other' }),
    file('f13', 13, 'licence-front.png', 'image/png', 'main', { docType: 'driving_licence', docTypeLabel: 'Driving licence', docSide: 'front', pages: null }),
  ],
  groups: [
    { key: 'main', kind: 'main', label: 'This case', claim: null, fileIds: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f13'], reasons: [{ code: 'shared_vrm', text: 'Same registration KX21 ABC as the V5C', fileId: 'f1' }, { code: 'name_hint', text: 'Bundle name matches Jane Doe' }], confidence: 0.9, suggestedName: 'Jane Doe KX21 ABC', warnings: [], defaultAction: 'register' },
    { key: 'case:B', kind: 'new_case', label: 'New case B — Ali Example', claim: null, fileIds: ['f9'], reasons: [{ code: 'shared_vrm', text: 'Registration YB68 KDL is on no other file here' }], confidence: 0.6, suggestedName: 'Ali Example YB68 KDL', warnings: [], defaultAction: 'split_off' },
    { key: 'claim:c-old', kind: 'existing_claim', label: 'CCG-2026-00001 — Sam Sample', claim: { id: 'c-old', reference: 'CCG-2026-00001', clientName: 'Sam Sample', status: 'open' }, fileIds: ['f10'], reasons: [{ code: 'shared_ccg_ref', text: 'The letter quotes CCG-2026-00001' }], confidence: 1, suggestedName: null, warnings: [], defaultAction: 'attach' },
    { key: 'unsure', kind: 'unsure', label: 'Not sure', claim: null, fileIds: ['f11'], reasons: [{ code: 'no_identifiers', text: 'No registration, name or date to go on', fileId: 'f11' }], confidence: 0, suggestedName: null, warnings: [], defaultAction: 'decide' },
    { key: 'excluded', kind: 'excluded', label: 'Excluded', claim: null, fileIds: ['f12'], reasons: [{ code: 'moved_by_owner', text: 'You left this out' }], confidence: 1, suggestedName: null, warnings: [], defaultAction: 'exclude' },
  ],
  draft: {
    fields: [
      { key: 'client.name', label: 'Name', section: 'client', value: 'Jane Doe', display: 'Jane Doe', confidence: 0.95, sensitive: false, required: true, keyField: true, status: 'ok', validator: { ok: true, message: null }, source: LIC('1. DOE 2. JANE'), alternatives: [{ value: 'J Doe', display: 'J Doe', sources: [FORM(1, 'Name: J Doe')] }], conflictId: null, note: null },
      { key: 'client.dateOfBirth', label: 'Date of birth', section: 'client', value: '1990-04-12', display: '12 Apr 1990', confidence: 0.93, sensitive: true, required: false, keyField: false, status: 'conflict', validator: { ok: true, message: null }, source: LIC('3. 12.04.1990'), alternatives: [{ value: '1990-12-04', display: '4 Dec 1990', sources: [FORM(1, 'Date of birth 04/12/1990', 0.8)] }], conflictId: 'c:client.dateOfBirth', note: null },
      { key: 'client.phone', label: 'Phone', section: 'client', value: '07700900123', display: '07700 900123', confidence: 0.62, sensitive: false, required: false, keyField: false, status: 'low_confidence', validator: { ok: true, message: null }, source: FORM(1, 'Tel 07700 900123', 0.62), alternatives: [], conflictId: null, note: null },
      { key: 'vehicle.registration', label: 'Registration', section: 'vehicle', value: 'KX21ABC', display: 'KX21 ABC', confidence: 0.97, sensitive: false, required: true, keyField: true, status: 'ok', validator: { ok: true, message: null }, source: V5C(1, 'Registration mark KX21 ABC'), alternatives: [], conflictId: null, note: null },
      { key: 'vehicle.vin', label: 'VIN', section: 'vehicle', value: 'WVWZZZ1JZXW000001', display: 'WVWZZZ1JZXW000001', confidence: 0.97, sensitive: false, required: false, keyField: false, status: 'conflict', validator: { ok: true, message: null }, source: V5C(1, 'VIN WVWZZZ1JZXW000001'), alternatives: [{ value: 'WVWZZZ1JZXW000007', display: 'WVWZZZ1JZXW000007', sources: [EST(3, 'Chassis WVWZZZ1JZXW000007')] }], conflictId: 'c:vehicle.vin', note: null },
      { key: 'tp.registration', label: 'Registration', section: 'third_party', value: 'LM19XYZ', display: 'LM19 XYZ', confidence: 0.92, sensitive: false, required: true, keyField: true, status: 'ok', validator: { ok: true, message: null }, source: src('f7', 'pack.pdf (pages 1-2).pdf', 'police_report', 'Police report', 1, 'Vehicle 2: LM19 XYZ', 0.92, 95), alternatives: [], conflictId: null, note: null },
      { key: 'accident.occurredAt', label: 'Date and time', section: 'accident', value: '2026-10-07T14:20:00.000Z', display: '7 Oct 2026, 15:20', confidence: 0.94, sensitive: false, required: true, keyField: true, status: 'ok', validator: { ok: true, message: null }, source: src('f7', 'pack.pdf (pages 1-2).pdf', 'police_report', 'Police report', 1, 'Time of collision 15:20 on 07/10/2026', 0.94, 100), alternatives: [], conflictId: null, note: null },
      { key: 'accident.location', label: 'Place', section: 'accident', value: 'High Street, Exampleton', display: 'High Street, Exampleton', confidence: 0.9, sensitive: false, required: true, keyField: true, status: 'ok', validator: { ok: true, message: null }, source: FORM(2, 'Location: High Street, Exampleton'), alternatives: [], conflictId: null, note: null },
      { key: 'accident.circumstances', label: 'What happened', section: 'accident', value: 'I was waiting at the lights when the other car drove into the back of mine.', display: 'I was waiting at the lights when the other car drove into the back of mine.', confidence: 0.9, sensitive: true, required: true, keyField: true, status: 'ok', validator: { ok: true, message: null }, source: FORM(2, 'I was waiting at the lights when the other car drove into the back of mine.'), alternatives: [], conflictId: null, note: null },
      { key: 'tp.insurerName', label: 'Other side’s insurer', section: 'insurers', value: 'Example Insurance plc', display: 'Example Insurance plc', confidence: 0.88, sensitive: false, required: false, keyField: false, status: 'ok', validator: { ok: true, message: null }, source: src('f10', 'letter-ccg-00001.pdf', 'insurer_letter', 'Insurer letter', 1, 'Example Insurance plc', 0.88, 100), alternatives: [], conflictId: null, note: null },
      { key: 'hire.needed', label: 'Needs a replacement car', section: 'hire_repair', value: null, display: null, confidence: 0, sensitive: false, required: false, keyField: false, status: 'missing', validator: { ok: true, message: null }, source: null, alternatives: [], conflictId: null, note: null },
    ],
    witnesses: [],
    witnessesAnswered: true,
    circumstances: { attribution: 'client', fromFileId: 'f2' },
    existingParty: null,
  },
  conflicts: [
    {
      id: 'c:vehicle.vin',
      key: 'vehicle.vin',
      label: 'VIN',
      status: 'open',
      options: [
        { value: 'WVWZZZ1JZXW000007', display: 'WVWZZZ1JZXW000007', sources: [EST(3, 'Chassis WVWZZZ1JZXW000007')], rank: 75, preselected: false, aiWhy: null },
        { value: 'WVWZZZ1JZXW000001', display: 'WVWZZZ1JZXW000001', sources: [V5C(1, 'VIN WVWZZZ1JZXW000001')], rank: 100, preselected: true, aiWhy: 'The V5C is the DVLA record of the car.' },
      ],
      why: 'The V5C outranks the bodyshop estimate for the VIN',
      chosenValue: null,
      resolvedBy: null,
      resolvedAt: null,
    },
    {
      id: 'c:client.dateOfBirth',
      key: 'client.dateOfBirth',
      label: 'Date of birth',
      status: 'open',
      options: [
        { value: '1990-04-12', display: '12 Apr 1990', sources: [LIC('3. 12.04.1990')], rank: 100, preselected: true, aiWhy: null },
        { value: '1990-12-04', display: '4 Dec 1990', sources: [FORM(1, 'Date of birth 04/12/1990', 0.8)], rank: 60, preselected: false, aiWhy: null },
      ],
      why: 'The driving licence outranks the accident report for the date of birth',
      chosenValue: null,
      resolvedBy: null,
      resolvedAt: null,
    },
  ],
  checklist: {
    caseKind: 'non_fault_credit_hire',
    caseKindLabel: 'Non-fault credit hire',
    items: [
      { id: 'v5c', label: 'V5C (logbook) for the client’s car', status: 'have', why: 'SMART-A-V5C.pdf', fileIds: ['f1'] },
      { id: 'licence_front', label: 'Driving licence, front', status: 'have', why: 'licence-front.png', fileIds: ['f13'] },
      { id: 'licence_back', label: 'Driving licence, back', status: 'missing', why: 'Only the front was sent', fileIds: [] },
      { id: 'insurance_certificate', label: 'Client’s insurance certificate', status: 'missing', why: 'Not in the files', fileIds: [] },
      { id: 'damage_photos', label: 'Photos of the damage (at least 4, one showing the number plate)', status: 'partial', why: '3 photos', fileIds: ['f3', 'f5'] },
    ],
    request: { to: 'jane.doe@example.test', subject: 'Your claim: documents we still need', body: 'Dear Jane,\n\nTo deal with your claim we still need:\n- the back of your driving licence\n- your insurance certificate\n\nPlease reply to this email with photos or scans.' },
  },
  timeline: [
    { id: 't:aaa', at: '2026-10-08', precision: 'date', eventType: 'letter_in', eventLabel: 'Letter received', class: 'record', summary: 'Letter from Example Insurance plc', attributableTo: 'third_party_insurer', sources: [src('f10', 'letter-ccg-00001.pdf', 'insurer_letter', 'Insurer letter', 1, null, 0.9, 100)], confidence: 0.9, ticked: true, tickedBy: 'default', note: null },
    { id: 't:bbb', at: '2026-10-09', precision: 'date', eventType: 'estimate_received', eventLabel: 'Estimate received', class: 'clock', summary: 'Bodyshop estimate', attributableTo: 'repairer', sources: [EST(3, null)], confidence: 0.85, ticked: true, tickedBy: 'default', note: null },
    { id: 't:ccc', at: '2026-10-10', precision: 'date', eventType: 'intervention_offer', eventLabel: 'Insurer offered a car', class: 'owner_only', summary: 'Letter offers a replacement car', attributableTo: 'third_party_insurer', sources: [], confidence: 0.8, ticked: false, tickedBy: 'default', note: 'Record it in Offers yourself' },
  ],
  signals: [
    { id: 's:1', code: 'PHOTO_BEFORE_ACCIDENT', severity: 'warn', title: 'Photo taken before the accident date', message: 'Photo taken on 4 Oct 2026, before the accident date. Camera clocks are often wrong — worth checking with the client.', fileIds: ['f5'], claims: [], basis: [{ fileId: 'f5', page: null, quote: null }], acknowledged: null },
    { id: 's:2', code: 'CONTACT_ON_OTHER_CLAIM', severity: 'warn', title: 'Same phone as another claim', message: 'Same phone as a party on CCG-2026-00002.', fileIds: ['f2'], claims: [{ id: 'c-2', reference: 'CCG-2026-00002' }], basis: [], acknowledged: null },
    { id: 's:3', code: 'PDF_EDITOR_PRODUCER', severity: 'info', title: 'Saved with an editing tool', message: 'Last saved with iLovePDF.', fileIds: ['f6'], claims: [], basis: [], acknowledged: { by: 'courtesycars', at: T, note: 'Their bodyshop always uses it' } },
  ],
  liability: { score: 82, band: 'strong', reasons: ['Rear-end collision while stationary'], statements: [{ text: 'Our insured accepts responsibility', party: 'insurer', source: src('f10', 'letter-ccg-00001.pdf', 'insurer_letter', 'Insurer letter', 1, 'Our insured accepts responsibility', 0.9, 100) }], note: 'A guide only — liability is your decision.' },
  register: {
    canRegister: false,
    blockers: [
      { code: 'OPEN_CONFLICTS', text: '2 details conflict — choose which is right.', for: 'owner' },
      { code: 'SETTING_OFF', text: 'Automatic registration is off (Settings > Intake).', for: 'auto' },
    ],
    fnolWarnings: ['The account was not taken on a call (taken cold).'],
    willDo: ['Creates the claim with 11 details', 'Files 8 documents (1 copy not filed twice)', 'Adds 2 chronology entries', 'Records damage on 2 parts', 'Prepares a request for 3 documents (you approve it before it is sent)', 'New case B — Ali Example becomes its own bundle', '1 file goes to CCG-2026-00001'],
  },
  aiSummary: null,
  decisions: [],
};

export const CASE_BRIEF: CaseBriefView = {
  claim: { id: 'c-new', reference: 'CCG-2026-00042', status: 'open', createdAt: T },
  bundle: { id: 'b1', name: 'Jane Doe – Corsa crash' },
  generatedAt: T,
  summary: 'Jane Doe’s Vauxhall Corsa (KX21 ABC) was hit by LM19 XYZ on 7 October 2026. 3 documents are still needed.',
  summarySource: 'template',
  facts: [
    { label: 'Client', value: 'Jane Doe', source: 'Driving licence' },
    { label: 'Registration', value: 'KX21 ABC', source: 'V5C, page 1' },
  ],
  liability: { position: 'unknown', score: 82, band: 'strong', reasons: ['Rear-end collision while stationary'], statements: [{ text: 'Our insured accepts responsibility', source: 'Insurer letter, page 1' }], note: 'A guide only — liability is your decision.' },
  missing: [{ id: 'licence_back', label: 'Driving licence, back', status: 'missing', why: 'Only the front was sent', fileIds: [] }],
  request: { status: 'waiting_for_you', outboxId: 'ob-1', needsYouId: 'ny-req-1', reason: null },
  callReminder: 'Call the client: confirm their account (taken cold), read the recording disclosure, ask the script questions.',
  autopilot: { stopped: null, firstSteps: [{ id: 'hire.offer', title: 'Offer a replacement car', mode: 'confirm', status: 'due', sentence: 'Prepares the hire offer for you to approve.' }] },
  nextActions: [{ code: 'CALL_CLIENT', title: 'Call the client', why: 'The account came from documents', dueAt: null }],
  signals: [],
  filed: { documents: 8, photos: 2, duplicatesSkipped: 1, events: 3, damageZones: 2 },
};

/** The BundleSummary part of a detail. */
export function summaryOf(d: BundleDetail): BundleSummary {
  const { files: _f, groups: _g, draft: _d, conflicts: _c, checklist: _k, timeline: _t, signals, liability: _l, register: _r, aiSummary: _a, decisions: _x, ...summary } = d;
  return { ...summary, signals: signalCounts(signals) };
}

export const REGISTER_RESULT: RegisterResult = {
  claim: { id: 'c-new', reference: 'CCG-2026-00042' },
  bundle: { ...summaryOf(BUNDLE_DETAIL), status: 'registered', readiness: 'registered', claim: { id: 'c-new', reference: 'CCG-2026-00042' } },
  filed: { evidence: 8, duplicatesSkipped: 1 },
  events: 3,
  proposals: { applied: 0, pending: 0, needsYouId: null },
  request: { outboxId: 'ob-1', needsYouId: 'ny-req-1', reason: null },
  splitOff: [],
  attached: [{ claimId: 'c-old', reference: 'CCG-2026-00001', files: 1 }],
  brief: CASE_BRIEF,
  error: null,
};

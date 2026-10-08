// @vitest-environment jsdom
// owned by intake
/** The Intake screen (docs/SUPREME-DESIGN.md §L.8) renders items, the detail with fields/quotes/confidence and the actions. */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '../../test/harness';
import { IntakePage } from './IntakePage';
import { intakeKeys, type IntakeItemDetail, type IntakeItemRow } from '../../api/intakeApi';

const base: IntakeItemRow = {
  id: 'item-1',
  source: 'upload',
  evidenceId: 'ev-1',
  claimId: 'claim-1',
  status: 'needs_you',
  sniffedType: 'pdf',
  docType: 'v5c',
  docTypeConfidence: 0.98,
  docTypeLabel: 'V5C',
  createdBy: 'owner',
  createdAt: '2026-10-07T09:00:00.000Z',
  updatedAt: '2026-10-07T09:00:00.000Z',
  claimReference: 'CCG-2026-00001',
  evidence: { id: 'ev-1', filename: 'V5C.pdf', mime: 'application/pdf', bytes: 2048, sha256: 'a'.repeat(64), claimId: 'claim-1', uploadedAt: '2026-10-07T09:00:00.000Z' },
  doc: { kind: 'pdf', sniffed: 'pdf', mime: 'application/pdf', extensionMatches: true, pages: 1, scanned: false, textChars: 200, textTruncated: false, email: null, attachments: [], skipReason: null, fingerprint: null, formTemplateId: null, newClaimDraftId: null },
  extraction: { id: 'x1', runId: 'r1', summary: 'Invented V5C', fields: 2, warnings: [], createdAt: '2026-10-07T09:00:00.000Z' },
  proposals: { pending: 1, applied: 1, rejected: 0, superseded: 0 },
  children: 0,
};
const noClaim: IntakeItemRow = { ...base, id: 'item-2', claimId: undefined, claimReference: null, status: 'proposed', docType: 'fnol_form', docTypeLabel: 'Accident report form', evidence: { ...base.evidence!, id: 'ev-2', filename: 'form.pdf', claimId: null }, proposals: { pending: 0, applied: 0, rejected: 0, superseded: 0 } };

const detail: IntakeItemDetail = {
  ...base,
  pageTexts: ['Registration mark KX21 ABC'],
  extractions: [
    {
      id: 'x1',
      schemaId: 'intake_extraction',
      warnings: [],
      createdAt: '2026-10-07T09:00:00.000Z',
      summary: 'Invented V5C summary for the test',
      fields: [
        { name: 'VIN', target: 'vehicle:client.vin', value: 'WVWZZZ1JZXW000001', confidence: 0.97, page: 1, quote: 'VIN WVWZZZ1JZXW000001' },
        { name: 'Model', target: 'vehicle:client.model', value: 'Yaris Icon', confidence: 0.93, page: 1, quote: 'Model YARIS ICON' },
      ],
    },
  ],
  proposalList: [
    { id: 'p1', claimId: 'claim-1', target: 'vehicle:client.vin', label: 'Client vehicle VIN', proposedValue: 'WVWZZZ1JZXW000001', confidence: 0.97, sensitive: false, source: { page: 1, quote: 'VIN …' }, policyDecision: 'auto', status: 'applied', decidedBy: 'agent:intake', createdAt: '' },
    { id: 'p2', claimId: 'claim-1', target: 'vehicle:client.model', label: 'Client vehicle model', currentValue: 'Yaris', proposedValue: 'Yaris Icon', confidence: 0.93, sensitive: false, source: { page: 1, quote: 'Model YARIS ICON' }, policyDecision: 'confirm', status: 'pending', validator: { policy: { ruleIds: ['internal_sensitive'], reasons: ['the claim already holds a different value'] } }, createdAt: '' },
  ],
  childItems: [],
  parent: null,
  needsYou: [{ id: 'ny-1', kind: 'confirm_fields', title: 'V5C: 1 field filled, 1 needs you' }],
};

afterEach(() => vi.restoreAllMocks());

describe('IntakePage', () => {
  it('lists items and shows a document’s fields with confidence, quotes and Apply/Reject', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = renderWithProviders(<IntakePage />, {
      route: '/intake',
      queryData: [
        [intakeKeys.list({}), { items: [base, noClaim], total: 2 }],
        [intakeKeys.item('item-1'), detail],
      ],
    });
    expect(screen.getByText('V5C.pdf')).toBeTruthy();
    expect(screen.getByText('form.pdf')).toBeTruthy();
    // Only the read document with no claim can start a claim.
    expect(screen.getByLabelText('Use form.pdf for a new claim')).toBeTruthy();
    expect(screen.queryByLabelText('Use V5C.pdf for a new claim')).toBeNull();
    const start = screen.getByRole('button', { name: /Start a claim from these/ });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    await r.user.click(screen.getByLabelText('Use form.pdf for a new claim'));
    expect((screen.getByRole('button', { name: /Start a claim from these \(1\)/ }) as HTMLButtonElement).disabled).toBe(false);

    await r.user.click(screen.getByText('V5C.pdf'));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Client vehicle VIN')).toBeTruthy();
    expect(within(table).getByText('Filled automatically')).toBeTruthy();
    expect(within(table).getByText('On file: Yaris')).toBeTruthy();
    expect(within(table).getByText('“Model YARIS ICON”')).toBeTruthy();
    expect(within(table).getAllByTitle('Confidence 97%').length).toBe(1);
    expect(within(table).getByRole('button', { name: 'Apply' })).toBeTruthy();
    expect(within(table).getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.getByText('Invented V5C summary for the test')).toBeTruthy();
    expect(screen.getByText(/V5C: 1 field filled, 1 needs you/)).toBeTruthy();
  });
});

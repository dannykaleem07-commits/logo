// owned by intake
/** Intake screen model and the New Claim prefill (docs/SUPREME-DESIGN.md §G.3, §L.8). Synthetic data only. */
import { describe, expect, it } from 'vitest';
import type { IntakeItemDetail, IntakeItemRow, NewClaimDraft, Proposal } from '../../api/intakeApi';
import { initialFnolState } from '../claims/new/fnol';
import { intakeDraftIdFrom, prefillFromDraft } from '../claims/new/intakePrefill';
import { waitingText, canStartClaim, confidenceTone, evidenceFileUrl, fieldRows, filterItems, pct, previewKind, proposalNote } from './intakeModel';

const row = (over: Partial<IntakeItemRow>): IntakeItemRow => ({
  id: 'i1',
  source: 'upload',
  evidenceId: 'e1',
  status: 'proposed',
  docTypeLabel: 'V5C',
  createdBy: 'owner',
  createdAt: '2026-10-07T09:00:00.000Z',
  updatedAt: '2026-10-07T09:00:00.000Z',
  claimReference: null,
  evidence: null,
  doc: null,
  extraction: { id: 'x1', runId: 'r1', summary: 's', fields: 3, warnings: [], createdAt: '2026-10-07T09:00:00.000Z' },
  proposals: { pending: 0, applied: 0, rejected: 0, superseded: 0 },
  children: 0,
  ...over,
});

const proposal = (over: Partial<Proposal>): Proposal => ({
  id: 'p1',
  claimId: 'c1',
  target: 'vehicle:client.vin',
  label: 'Client vehicle VIN',
  proposedValue: 'WVWZZZ1JZXW000001',
  confidence: 0.97,
  sensitive: false,
  source: { page: 1, quote: 'VIN WVWZZZ1JZXW000001' },
  policyDecision: 'auto',
  status: 'pending',
  createdAt: '2026-10-07T09:00:00.000Z',
  ...over,
});

describe('intake waiting reason', () => {
  it('says why a document is not being read instead of "Reading…"', () => {
    expect(waitingText(null)).toBeUndefined();
    expect(waitingText({ reason: 'agents_off' })).toMatchObject({ text: 'Waiting — agents are switched off (Settings > AI)', link: '/settings/ai' });
    expect(waitingText({ reason: 'kill_switch' })?.link).toBe('/agents');
    expect(waitingText({ reason: 'usage', until: '2026-10-10T16:05:00.000Z' })?.text).toBe('Waiting — the AI usage limit resets at 17:05');
  });
});

describe('intake model', () => {
  it('filters, tones and labels', () => {
    const items = [row({ id: 'a', status: 'needs_you', claimId: 'c1' }), row({ id: 'b', status: 'failed' }), row({ id: 'c', status: 'applied', claimId: 'c1', proposals: { pending: 1, applied: 0, rejected: 0, superseded: 0 } })];
    expect(filterItems(items, 'needs_you').map((i) => i.id)).toEqual(['a', 'c']);
    expect(filterItems(items, 'no_claim').map((i) => i.id)).toEqual(['b']);
    expect(filterItems(items, 'problems').map((i) => i.id)).toEqual(['b']);
    expect(confidenceTone(0.95)).toBe('green');
    expect(confidenceTone(0.75)).toBe('amber');
    expect(confidenceTone(0.4)).toBe('red');
    expect(pct(0.934)).toBe('93%');
    expect(evidenceFileUrl('e 1', 2)).toBe('/api/evidence/e%201/file#page=2');
    expect(previewKind({ doc: { kind: 'pdf' } as IntakeItemRow['doc'], evidence: null })).toBe('pdf');
    expect(previewKind({ doc: null, evidence: null })).toBe('none');
  });

  it('a new claim can be started only from read documents with no claim', () => {
    expect(canStartClaim(row({}))).toBe(true);
    expect(canStartClaim(row({ claimId: 'c1' }))).toBe(false);
    expect(canStartClaim(row({ extraction: null }))).toBe(false);
    expect(canStartClaim(row({ parentItemId: 'p' }))).toBe(false);
  });

  it('field rows pair each extracted field with its proposal and keep tool-only proposals', () => {
    const detail = {
      extractions: [
        { id: 'x0', schemaId: 'intake_extraction', fields: [], warnings: [], createdAt: '' },
        {
          id: 'x1',
          schemaId: 'intake_extraction',
          warnings: [],
          createdAt: '',
          fields: [
            { name: 'VIN', target: 'vehicle:client.vin', value: 'WVWZZZ1JZXW000001', confidence: 0.97, page: 1, quote: 'VIN …' },
            { name: 'Taxation class', target: null, value: 'Petrol car', confidence: 0.9, page: 1, quote: null },
          ],
        },
      ],
      proposalList: [proposal({}), proposal({ id: 'p2', target: 'party:client.dateOfBirth', label: 'Client date of birth', proposedValue: '1990-04-12', sensitive: true, policyDecision: 'confirm' })],
    } as unknown as Pick<IntakeItemDetail, 'extractions' | 'proposalList'>;
    const rows = fieldRows(detail);
    expect(rows.map((r) => [r.name, r.proposal?.id ?? null])).toEqual([
      ['VIN', 'p1'],
      ['Taxation class', null],
      ['Client date of birth', 'p2'],
    ]);
  });

  it('proposal notes say what happened in plain words', () => {
    expect(proposalNote(proposal({ status: 'applied', decidedBy: 'agent:intake' }))).toBe('Filled automatically');
    expect(proposalNote(proposal({ status: 'applied', decidedBy: 'owner' }))).toBe('Applied by owner');
    expect(proposalNote(proposal({ status: 'rejected', validator: { decision: { reason: 'old address' } } }))).toBe('Rejected: old address');
    expect(proposalNote(proposal({ status: 'rejected', policyDecision: 'never', validator: { decision: { reason: 'registration on file differs' } } }))).toMatch(/^Not applied: registration/);
    expect(proposalNote(proposal({ policyDecision: 'confirm', validator: { policy: { ruleIds: ['internal_sensitive'], reasons: ['sensitive field'] } } }))).toBe('Needs you: sensitive field');
  });
});

describe('New Claim prefill from an intake draft', () => {
  const draft: NewClaimDraft = {
    id: '6d1f6c2e-1111-4222-8333-944455556666',
    createdAt: '2026-10-07T09:00:00.000Z',
    createdBy: 'owner',
    itemIds: ['i1'],
    body: {
      claimant: { kind: 'individual', name: 'Daniel Okafor', phone: '07700 900456', email: 'd.okafor@example.test', dateOfBirth: '1985-07-30', drivingLicenceNumber: 'OKAFO807305D99XY', address: { line1: '4 Mill Lane', town: 'Bristol', postcode: 'BS1 4XY' }, roles: ['claimant', 'driver'] },
      vehicle: { registration: 'AB19CDE', make: 'Ford', model: 'Focus', vin: 'WVWZZZ1JZXW000001', ownership: 'client' },
      accident: { occurredAt: '2026-10-05T13:30:00.000Z', location: 'Station Road, Bristol' },
      thirdParty: { registration: 'GH70JKL', driverName: 'Peter Lane', insurerPolicyNumber: 'POL12345678' },
      atFaultInsurerRef: 'EXI/2026/0042',
    },
    sources: {
      'claimant.name': { itemId: 'i1', evidenceId: 'e1', page: 1, quote: 'Full name: Daniel Okafor', confidence: 0.97, docType: 'fnol_form', label: 'from Accident report form, page 1' },
      'vehicle.registration': { itemId: 'i2', evidenceId: 'e2', page: 1, quote: 'AB19 CDE', confidence: 0.99, docType: 'v5c', label: 'from V5C, page 1' },
      'claimant.address': { itemId: 'i1', evidenceId: 'e1', page: 1, quote: '4 Mill Lane', confidence: 0.93, docType: 'fnol_form', label: 'from Accident report form, page 1' },
      atFaultInsurerRef: { itemId: 'i3', evidenceId: 'e3', page: 1, quote: 'Our ref', confidence: 0.95, docType: 'insurer_letter', label: 'from Insurer letter, page 1' },
    },
    conflicts: [],
    rejected: [],
    stillNeeded: [],
  };

  it('fills the wizard state from the documents and leaves the owner’s questions alone', () => {
    const initial = initialFnolState();
    const p = prefillFromDraft(initial, draft);
    expect(p.state.claimant).toMatchObject({ name: 'Daniel Okafor', phone: '07700 900456', email: 'd.okafor@example.test', dateOfBirth: '1985-07-30', line1: '4 Mill Lane', town: 'Bristol', postcode: 'BS1 4XY', drivingLicenceNumber: 'OKAFO807305D99XY' });
    expect(p.state.driverSameAsClaimant).toBe(true);
    expect(p.state.vehicle.registration).toBe('AB19CDE');
    expect(p.state.vehicle.lookupState).toBe('idle'); // the owner still searches the registration
    expect(p.state.vehicle.picker).toMatchObject({ make: 'Ford', model: 'Focus', vin: 'WVWZZZ1JZXW000001' });
    expect(p.state.accident).toMatchObject({ occurredAt: '2026-10-05T13:30:00.000Z', location: 'Station Road, Bristol', circumstances: '', takenCold: false, injuries: undefined });
    expect(p.state.thirdParty).toMatchObject({ registration: 'GH70JKL', driverName: 'Peter Lane', insurerPolicyNumber: 'POL12345678' });
    expect(p.state.disclosure.acknowledged).toBe(false);
    expect(p.state.offer.offered).toBeUndefined();
    expect(p.badges.map((b) => `${b.label}: ${b.source}`)).toEqual(['Claimant name: from Accident report form, page 1', 'Claimant address: from Accident report form, page 1', 'Registration: from V5C, page 1']);
    expect(p.badges[1]!.value).toBe('4 Mill Lane, Bristol, BS1 4XY');
    expect(p.notInWizard.map((b) => b.field)).toEqual(['atFaultInsurerRef']);
    // the initial state is not mutated
    expect(initial.claimant.name).toBe('');
  });

  it('a separate driver unticks "driver is the claimant"', () => {
    const p = prefillFromDraft(initialFnolState(), { ...draft, body: { ...draft.body, driver: { kind: 'individual', name: 'Sam Driver', roles: ['driver'] } } });
    expect(p.state.driverSameAsClaimant).toBe(false);
    expect(p.state.driver.name).toBe('Sam Driver');
  });

  it('reads ?intakeDraft= safely', () => {
    expect(intakeDraftIdFrom('?intakeDraft=6d1f6c2e-1111-4222-8333-944455556666')).toBe('6d1f6c2e-1111-4222-8333-944455556666');
    expect(intakeDraftIdFrom('?intakeDraft=../../etc')).toBeUndefined();
    expect(intakeDraftIdFrom('')).toBeUndefined();
  });
});

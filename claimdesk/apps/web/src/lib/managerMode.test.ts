import { describe, expect, it } from 'vitest';
import { auditActionLabel, auditReasonText, humaniseAction, MANAGER_WARNING_PREFIX, managerWarning, overrideCodeOf, relaxedKeys, relaxErrors } from './managerMode';

describe('relaxErrors', () => {
  const errors = { 'claimant.name': 'Full legal name is required.', 'claimant.contact': 'A phone number or email address is required.', 'vehicle.fleet': 'Fleet unit (hard stop).' };
  it('leaves errors unchanged when manager mode is off', () => {
    const r = relaxErrors(errors, false, ['claimant.name']);
    expect(r).toEqual({ errors, warnings: {} });
    expect(r.errors).not.toBe(errors); // a copy, never the caller's object
  });
  it('turns every non-hard error into a warning in manager mode', () => {
    expect(relaxErrors(errors, true, ['claimant.name'])).toEqual({
      errors: { 'claimant.name': 'Full legal name is required.' },
      warnings: { 'claimant.contact': 'A phone number or email address is required.', 'vehicle.fleet': 'Fleet unit (hard stop).' }
    });
  });
  it('relaxes everything without hard keys, and handles no errors', () => {
    expect(relaxErrors(errors, true).errors).toEqual({});
    expect(Object.keys(relaxErrors(errors, true).warnings)).toHaveLength(3);
    expect(relaxErrors({}, true, ['x'])).toEqual({ errors: {}, warnings: {} });
  });
});

describe('relaxedKeys and the warning prefix', () => {
  it('prefixes each warning key with the form name', () => {
    expect(relaxedKeys('fnol', { 'claimant.contact': 'x', 'vehicle.fleet': 'y' })).toEqual(['fnol.claimant.contact', 'fnol.vehicle.fleet']);
    expect(relaxedKeys('fleet', {})).toEqual([]);
  });
  it('the prefix is exact and never doubled', () => {
    expect(MANAGER_WARNING_PREFIX).toBe('Allowed in manager mode: ');
    expect(managerWarning('Postcode looks wrong.')).toBe('Allowed in manager mode: Postcode looks wrong.');
    expect(managerWarning('Allowed in manager mode: x')).toBe('Allowed in manager mode: x');
    expect(managerWarning(undefined)).toBeUndefined();
  });
});

describe('audit rows in plain English', () => {
  it('labels overrides, hire corrections and other actions', () => {
    expect(overrideCodeOf('override.HARD_STOP')).toBe('HARD_STOP');
    expect(overrideCodeOf('hire.correct')).toBeUndefined();
    expect(auditActionLabel('override.HARD_STOP', (c) => (c === 'HARD_STOP' ? 'Uncleared hard-stop flag' : undefined))).toBe('Override: Uncleared hard-stop flag');
    expect(auditActionLabel('override.SOMETHING_NEW')).toBe('Override: Something new');
    expect(auditActionLabel('hire.correct')).toBe('Hire dates corrected');
    expect(auditActionLabel('manager_mode.off')).toBe('Manager mode switched off');
    expect(auditActionLabel('fleet_unit.dispose')).toBe('Fleet unit dispose');
    expect(humaniseAction('claim.flag.raise')).toBe('Claim flag raise');
  });
  it('gives the reason and the refused message of an override', () => {
    expect(auditReasonText({ action: 'override.HARD_STOP', before: { code: 'HARD_STOP', message: 'Claim has an uncleared hard stop' }, after: { reason: 'Verify test' } })).toBe('Verify test — Claim has an uncleared hard stop');
  });
  it('gives the correction reason, the manager-mode why and a short fallback', () => {
    expect(auditReasonText({ action: 'hire.correct', after: { reason: 'Agent forgot to upload', claimId: 'c1' } })).toBe('Agent forgot to upload');
    expect(
      auditReasonText({
        action: 'hire.correct',
        before: { startAt: '2026-09-25T08:00:00.000Z', days: 7, netPence: 34993 },
        after: { startAt: '2026-09-27T08:00:00.000Z', days: 5, netPence: 24995, reason: 'agent forgot to upload', claimId: 'c1', ledger: 'superseded', ledgerEntryId: 'e1' }
      })
    ).toBe('agent forgot to upload — start 25 Sept 2026, 09:00 → 27 Sept 2026, 09:00; days 7 → 5; net £349.93 → £249.95');
    expect(auditReasonText({ action: 'hire.correct', before: { endTrigger: 'client_returned' }, after: { endTrigger: null, reason: 'r' } })).toBe('r — what ended it Client returned the vehicle → —');
    // the generic fallback: £, London dates and labels, no ids
    expect(auditReasonText({ action: 'hire.create', after: { use: 'credit_hire', lateEntry: true, endAt: '2026-10-02T08:00:00.000Z', endTrigger: 'client_returned', fleetUnitId: 'u1' } })).toBe(
      'use: credit hire · late entry: yes · end: 2 Oct 2026, 09:00 · what ended it: Client returned the vehicle'
    );
    expect(auditReasonText({ action: 'ledger.append', after: { head: 'hire', kind: 'claimed', amountPence: 34993, vatPence: 0 } })).toBe('head: hire · kind: claimed · amount: £349.93 · VAT: £0.00');
    // relaxed on-screen checks by name, not rule id
    expect(
      auditReasonText({ action: 'override.WEB_VALIDATION', before: { code: 'WEB_VALIDATION', message: 'On-screen checks relaxed: fnol.disclosure, fnol.claimant.contact, editHire.endAt', details: { rules: ['fnol.disclosure', 'fnol.claimant.contact', 'editHire.endAt', 'fleet.gtaGroup'] } }, after: { reason: 'Manager override' } })
    ).toBe("Manager override — On-screen checks relaxed: call-recording disclosure, client's phone or email, end, GTA group");
    expect(auditReasonText({ action: 'manager_mode.off', after: { why: 'idle' } })).toBe('switched off after no activity');
    expect(auditReasonText({ action: 'claim.status', before: { status: 'fnol' }, after: { status: 'accepted', claimId: 'c1' } })).toBe('status: accepted');
    expect(auditReasonText({ action: 'x.y' })).toBe('');
    expect(auditReasonText({ action: 'x.y', after: { reason: 'r'.repeat(400) } })).toHaveLength(298);
  });
});

// @vitest-environment jsdom
// owned by ap-clash
/** Clash panel, clash helpers, driver-criteria and driver-profile forms, Needs-you panels (docs/SUPREME-AUTOPILOT.md §C.5, §F, §I.7, §I.8). */
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRIVER_CRITERIA, type ClashFinding } from '@ccguk/domain';
import { ClashPanel } from '../screens/claim/components/ClashPanel';
import { countBySeverity, isGreenBlocking, isOverridable, sortFindings, type ShownFinding } from '../screens/claim/lib/clashes';
import { CRITERIA_NOTICE, fromForm, summarise, toForm } from '../screens/settings/fleet/criteria';
import { formToBody, profileToForm } from '../screens/claim/components/DriverProfileForm';
import { ClashReviewPanel } from '../screens/needsYou/panels/ClashReviewPanel';
import { EligibilityReviewPanel } from '../screens/needsYou/panels/EligibilityReviewPanel';
import type { NeedsYouItem } from '../api/needsYouApi';
import { clashQk } from '../api/clashApi';
import { renderWithProviders } from './harness';

const f = (code: ClashFinding['code'], severity: ClashFinding['severity'], overrideClass: ClashFinding['overrideClass'], extra: Partial<ShownFinding> = {}): ShownFinding => ({
  code,
  severity,
  overrideClass,
  message: `${code} message`,
  related: { claimIds: [], reservationIds: [], hireIds: [], fleetUnitIds: [], partyIds: [] },
  dedupeKey: code,
  ...extra,
});

describe('clash helpers', () => {
  it('sorts live findings by severity and counts open ones', () => {
    const rows = sortFindings([f('NEED_WEAK', 'warn', 'C'), f('UNIT_DISPOSED', 'block', 'C'), f('INJURY_NOT_REFERRED', 'info', 'C'), f('UNIT_NOT_READY', 'block', 'A', { status: 'overridden' })]);
    expect(rows.map((r) => r.code)).toEqual(['UNIT_DISPOSED', 'NEED_WEAK', 'INJURY_NOT_REFERRED', 'UNIT_NOT_READY']);
    expect(countBySeverity(rows)).toEqual({ block: 1, warn: 1, info: 1 });
  });
  it('overridable = class A/B blocks only; green-blocking warns from the catalogue', () => {
    expect(isOverridable({ severity: 'block', overrideClass: 'A' })).toBe(true);
    expect(isOverridable({ severity: 'block', overrideClass: 'C' })).toBe(false);
    expect(isOverridable({ severity: 'warn', overrideClass: 'C' })).toBe(false);
    expect(isGreenBlocking({ code: 'NEED_WEAK', severity: 'warn' })).toBe(true);
    expect(isGreenBlocking({ code: 'KEEPER_ADDRESS_STALE', severity: 'warn' })).toBe(false);
  });
});

describe('ClashPanel', () => {
  it('offers "Override as manager" for class A blocks only in manager mode, and passes the reason', async () => {
    const onOverride = vi.fn();
    const { user, rerender } = renderWithProviders(<ClashPanel findings={[f('UNIT_NOT_READY', 'block', 'A')]} managerMode={false} onAcknowledge={() => undefined} onOverride={onOverride} />);
    expect(screen.queryByRole('button', { name: /Override as manager/ })).toBeNull();
    expect(screen.getByText(/A manager can override/)).toBeTruthy();
    rerender(<ClashPanel findings={[f('UNIT_NOT_READY', 'block', 'A')]} managerMode onAcknowledge={() => undefined} onOverride={onOverride} />);
    await user.click(screen.getByRole('button', { name: /Override as manager/ }));
    await user.type(screen.getByLabelText(/Reason for the override/), 'Valet done, checked myself');
    await user.click(screen.getByRole('button', { name: /Override and continue/ }));
    expect(onOverride).toHaveBeenCalledWith('Valet done, checked myself');
  });
  it('never offers an override when a class C block is present', () => {
    renderWithProviders(<ClashPanel findings={[f('UNIT_DISPOSED', 'block', 'C'), f('UNIT_NOT_READY', 'block', 'A')]} managerMode onAcknowledge={() => undefined} onOverride={() => undefined} />);
    expect(screen.queryByRole('button', { name: /Override as manager/ })).toBeNull();
    expect(screen.getByText(/cannot be overridden/)).toBeTruthy();
    expect(screen.getByText('Never overridable')).toBeTruthy();
  });
  it('acknowledges a stored warning with a reason', async () => {
    const onAck = vi.fn();
    const { user } = renderWithProviders(<ClashPanel findings={[f('NEED_WEAK', 'warn', 'C', { id: 'f1', status: 'open' })]} managerMode={false} onAcknowledge={onAck} onOverride={() => undefined} />);
    expect(screen.getByText('Autopilot asks you first')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /I've read this/ }));
    await user.type(screen.getByLabelText(/Why is this fine/), 'Partner works nights');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onAck).toHaveBeenCalledWith('f1', 'Partner works nights');
  });
});

describe('driver criteria form', () => {
  it('round-trips the defaults and refuses inconsistent bands', () => {
    const form = toForm(DEFAULT_DRIVER_CRITERIA);
    expect(fromForm(form)).toEqual({ criteria: DEFAULT_DRIVER_CRITERIA, problems: [] });
    expect(fromForm({ ...form, minAge: '30' }).problems[0]).toMatch(/Ages must go/);
    expect(fromForm({ ...form, maxPointsEligible: 'x' }).problems[0]).toMatch(/whole number/);
    expect(fromForm({ ...form, youngDriverExcessPounds: '250' }).criteria!.youngDriverExcessPence).toBe(25000);
    expect(summarise(DEFAULT_DRIVER_CRITERIA)).toContain('Ages 25–75');
    expect(CRITERIA_NOTICE).toMatch(/Check them against your fleet insurance policy/);
  });
});

describe('driver profile form', () => {
  it('builds the PUT body (restriction 78, endorsements, DVLA check) and reports bad lines', () => {
    const form = { ...profileToForm(null, 'HUSSA804128AH9IJ'), fullLicenceSince: '2014-01-01', points: '3', endorsements: 'sp30 2024-03-01 3', restriction78: true, dvlaCheckedOn: '2026-10-12', dvlaSummary: 'Clean apart from SP30' };
    const r = formToBody(form);
    expect(r.problems).toEqual([]);
    expect(r.body).toMatchObject({ licenceNumber: 'HUSSA804128AH9IJ', restrictionCodes: ['78'], points: 3, endorsements: [{ code: 'SP30', offenceDate: '2024-03-01', points: 3 }], source: 'dvla_check', dvlaCheck: { summary: 'Clean apart from SP30' } });
    expect(formToBody({ ...form, endorsements: 'speeding' }).problems[0]).toMatch(/should look like/);
    expect(formToBody({ ...form, dvlaSummary: '' }).problems[0]).toMatch(/what the DVLA check showed/);
  });
});

describe('Needs-you panels', () => {
  const item = (kind: string, payload: unknown, claimId = 'c1') => ({ id: 'n1', kind, claimId, title: 't', summary: 's', options: [], payload, priority: 'high', status: 'open', createdBy: 'agent:autopilot', createdAt: '2026-10-12T09:00:00Z' }) as unknown as NeedsYouItem;
  it('clash_review shows the finding, its basis, the related claim and the override rule', () => {
    renderWithProviders(<ClashReviewPanel item={item('clash_review', { findingId: 'f1', code: 'SAME_REG_ON_HIRE', severity: 'block', overrideClass: 'A', message: 'The client car is on another claim', reservationId: 'r1' })} closed={false} />, {
      queryData: [[clashQk.claim('c1'), { findings: [{ ...f('SAME_REG_ON_HIRE', 'block', 'A'), id: 'f1', status: 'open', relatedClaims: [{ id: 'c2', reference: 'CCG-2026-00002' }] }], counts: { block: 1, warn: 0, info: 0 } }]],
    });
    expect(screen.getByText("Client's car already has a hire on another claim")).toBeTruthy();
    expect(screen.getByText('CCG-2026-00002')).toBeTruthy();
    expect(screen.getByText(/a manager can override it there/)).toBeTruthy();
  });
  it('eligibility_review shows the reasons, labels default criteria and needs evidence to record the acceptance', () => {
    renderWithProviders(
      <EligibilityReviewPanel item={item('eligibility_review', { partyId: 'p1', outcome: 'refer', reasons: [{ code: 'POINTS_REFER', outcome: 'refer', message: '8 penalty points' }], criteria: DEFAULT_DRIVER_CRITERIA, criteriaSource: 'settings_default' })} closed={false} />,
      { queryData: [[['claim', 'c1'], { evidence: [] }]] },
    );
    expect(screen.getByText('Refer to the insurer')).toBeTruthy();
    expect(screen.getByText(/8 penalty points/)).toBeTruthy();
    expect(screen.getByText(/Default criteria — check against your policy/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Record the insurer's acceptance/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

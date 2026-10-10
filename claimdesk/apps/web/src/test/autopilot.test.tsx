// @vitest-environment jsdom
// owned by ap-autopilot
/** Autopilot tab, Settings > Autopilot, choose_car / autopilot_step panels and helpers (docs/SUPREME-AUTOPILOT.md §I). */
import { screen } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DEFAULT_AUTOPILOT_SETTINGS, STEP_CATALOGUE, type AutopilotPlan, type StepState } from '@ccguk/domain';
import { AutopilotTab } from '../screens/claim/tabs/AutopilotTab';
import { ChooseCarPanel } from '../screens/needsYou/panels/ChooseCarPanel';
import { AutopilotStepPanel } from '../screens/needsYou/panels/AutopilotStepPanel';
import { AutopilotSettingsPage, normalisedWeights, settingsPatch } from '../screens/settings/autopilot/AutopilotSettingsPage';
import { autopilotQk, type AutopilotView } from '../api/autopilotApi';
import { clashQk } from '../api/clashApi';
import { countdown, groupByTrack, nextCard, stageIndex, waitingChips } from '../screens/claim/lib/autopilot';
import type { NeedsYouItem } from '../api/needsYouApi';
import type { ClaimView } from '../screens/claim/claimFile';
import { renderWithProviders } from './harness';

const NOW = '2026-10-12T09:00:00.000Z';
const st = (id: string, status: StepState['status'], extra: Partial<StepState> = {}): StepState => ({ id: id as StepState['id'], status, mode: 'auto', modeReasons: [], green: true, overdue: false, missing: [], blockedBy: [], refs: {}, next: `${id}: ${status}`, ...extra });

const plan: AutopilotPlan = {
  version: 'autopilot/1',
  claimId: 'c1',
  evaluatedAt: NOW,
  stage: 'hire_offer',
  stageIndex: 7,
  mode: 'on',
  steps: [
    st('intake.acknowledge', 'done'),
    st('hire.search', 'done'),
    st('hire.offer', 'done'),
    st('hire.acceptance', 'waiting', { waitingOn: 'client', next: 'Get the client’s answer: waiting on the client.' }),
    st('hire.pack', 'due', { mode: 'confirm', modeReasons: ['Agreements and forms always need you'], next: 'Next: prepare the hire-start paperwork — prepared for you to confirm.', dueAt: '2026-10-12T12:00:00.000Z' }),
    st('money.offer', 'not_applicable', { mode: 'owner' }),
  ],
  due: ['hire.pack'],
  waiting: ['hire.acceptance'],
  done: ['intake.acknowledge', 'hire.search', 'hire.offer'],
  nextCheckAt: NOW,
  planHash: 'x',
};
const catalogue = STEP_CATALOGUE.map((s) => ({ id: s.id, title: s.title, track: s.track, stage: s.stage, performer: s.performer, floor: s.floor, defaultMode: s.defaultMode }));
const view: AutopilotView = {
  claimId: 'c1',
  record: { claimId: 'c1', mode: 'on', stepOverrides: {}, updatedAt: NOW },
  plan,
  catalogue,
  log: [{ id: 'l1', claimId: 'c1', stepId: 'hire.acceptance', toStatus: 'waiting', actor: 'agent:autopilot', refs: {}, at: '2026-10-12T07:00:00.000Z' }],
  stopped: null,
};

describe('autopilot helpers', () => {
  it('groups steps per track with done collapsed, finds the next step, the waiting chips and countdowns', () => {
    const groups = groupByTrack(plan, catalogue);
    const hire = groups.find((g) => g.id === 'hire')!;
    expect(hire.open.map((r) => r.state.id)).toEqual(['hire.acceptance', 'hire.pack']);
    expect(hire.done.map((r) => r.state.id)).toEqual(['hire.search', 'hire.offer']);
    expect(groups.find((g) => g.id === 'money')).toBeUndefined();
    expect(nextCard(plan, catalogue)).toMatchObject({ stepId: 'hire.pack', mode: 'confirm' });
    // the plan's sentence carries its own "Next:"; the card prints the label once
    const withPrefix = { ...plan, steps: plan.steps.map((st) => (st.id === 'hire.pack' ? { ...st, next: 'Next: prepare the hire-start paperwork — prepared for you to confirm.' } : st)) };
    expect(nextCard(withPrefix, catalogue)!.text).toBe('prepare the hire-start paperwork — prepared for you to confirm.');
    expect(waitingChips(plan, view.log)).toEqual([{ who: 'client', since: '2026-10-12T07:00:00.000Z', stepId: 'hire.acceptance' }]);
    expect(countdown('2026-10-12T12:00:00.000Z', Date.parse(NOW))).toEqual({ text: 'in 3 h', overdue: false });
    expect(countdown('2026-10-12T08:30:00.000Z', Date.parse(NOW))).toEqual({ text: '30 min overdue', overdue: true });
    expect(stageIndex('hire_offer')).toBe(6);
    expect(stageIndex('legal')).toBe(-1);
  });

  it('settings: weights normalise to 100 and the patch carries step-mode changes as a diff (null clears)', () => {
    const w = normalisedWeights({ a: 1, b: 1, c: 2 });
    expect(w).toEqual({ a: 25, b: 25, c: 50 });
    const before = { ...DEFAULT_AUTOPILOT_SETTINGS, stepModes: { 'hire.offer': 'confirm' as const } };
    const draft = { ...DEFAULT_AUTOPILOT_SETTINGS, stepModes: { 'intake.cctv': 'confirm' as const } };
    expect(settingsPatch(before, draft).stepModes).toEqual({ 'hire.offer': null, 'intake.cctv': 'confirm' });
    expect(settingsPatch(before, before).stepModes).toBeUndefined();
  });
});

describe('AutopilotTab', () => {
  it('shows the stage, the mode, the Next card, the waiting chips and the step rows with modes and actions', () => {
    // The tab reads the wall clock for "since …": pin it to the fixture's time (only Date, timers stay real).
    vi.useFakeTimers({ now: Date.parse(NOW), toFake: ['Date'] });
    onTestFinished(() => void vi.useRealTimers());
    renderWithProviders(<AutopilotTab view={{ claim: { id: 'c1' } } as unknown as ClaimView} />, {
      queryData: [
        [autopilotQk.view('c1'), view],
        [autopilotQk.offers('c1'), { offers: [] }],
        [clashQk.claim('c1'), { findings: [], counts: { block: 0, warn: 0, info: 0 } }],
      ],
    });
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pause autopilot on this claim/ })).toBeTruthy();
    expect(screen.getByTestId('ap-next').textContent).toMatch(/prepare the hire-start paperwork/);
    expect(screen.getByText(/client since 2 h/)).toBeTruthy();
    const row = screen.getByTestId('ap-step-hire.pack');
    expect(row.textContent).toMatch(/Ask me/);
    expect(row.textContent).toMatch(/Agreements and forms always need you/);
    expect(screen.getAllByRole('button', { name: 'Run now' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Done \(2\)/ })).toBeTruthy();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('Offer');
  });
});

describe('Needs-you panels', () => {
  it('choose_car lists the ranked cars with factors, why it asks, and the cars not available', () => {
    const item = {
      id: 'n1',
      kind: 'choose_car',
      claimId: 'c1',
      options: [],
      recommendation: { action: 'Offer AB12 CDE', why: 'x', confidence: 0.7, basis: [] },
      payload: {
        ranked: [
          { fleetUnitId: 'u1', registration: 'AB12 CDE', label: 'Ford Focus auto', score: 88, likeForLike: 'Same hire group as your own car (C2).', factors: { likeForLike: { score: 1, weight: 35, note: 'same group' } }, driverOutcome: 'eligible', warnings: [] },
          { fleetUnitId: 'u2', registration: 'CD34 EFG', label: 'Kia Niro auto', score: 85, likeForLike: 'One group higher.', driverOutcome: 'refer', warnings: ['Higher group'] },
        ],
        reasons: ['The scores were close.'],
        excluded: [{ registration: 'MN12 OPQ', reasons: [{ message: 'manual gearbox; the driver is automatic-only (code 78)' }] }],
        protectiveHoldId: 'r1',
        period: { startAt: NOW, expectedEndAt: '2026-10-26T09:00:00.000Z' },
      },
    } as unknown as NeedsYouItem;
    renderWithProviders(<ChooseCarPanel item={item} closed={false} />);
    expect(screen.getByText(/The scores were close/)).toBeTruthy();
    expect(screen.getByText('Recommended')).toBeTruthy();
    expect(screen.getByText(/Driver: refer/)).toBeTruthy();
    expect(screen.getByText(/Not available \(1\)/)).toBeTruthy();
    expect(screen.getByText(/benchmark only/)).toBeTruthy();
  });

  it('autopilot_step explains the purpose and what each option does', () => {
    const item = { id: 'n2', kind: 'autopilot_step', claimId: 'c1', options: [{ id: 'accepted_by_phone', label: 'Client accepted by phone' }, { id: 'search_again', label: 'Search again' }], payload: { stepId: 'hire.acceptance', purpose: 'offer_expired', hireOfferId: 'o1' } } as unknown as NeedsYouItem;
    renderWithProviders(<AutopilotStepPanel item={item} closed={false} />);
    expect(screen.getByText(/expired without an answer/)).toBeTruthy();
    expect(screen.getByText(/re-held if it is still free/)).toBeTruthy();
  });
});

describe('Settings > Autopilot', () => {
  it('greys the modes below a floor and shows the reason; warns when the per-claim send limit is below 6', () => {
    renderWithProviders(<AutopilotSettingsPage />, {
      queryData: [
        [['settings', 'autopilot'], { settings: DEFAULT_AUTOPILOT_SETTINGS, defaults: DEFAULT_AUTOPILOT_SETTINGS, floors: [{ id: 'hire.pack', floor: 'confirm', reason: 'Agreements and forms always need you' }] }],
        [['settings', 'autonomy'], { settings: { limits: { perClaimPerDay: 3 } } }],
      ],
    });
    const select = screen.getByLabelText('Mode for Prepare the hire-start paperwork') as HTMLSelectElement;
    const auto = Array.from(select.options).find((o) => o.value === 'auto')!;
    expect(auto.disabled).toBe(true);
    expect(select.value).toBe('confirm');
    expect(screen.getAllByText('Agreements and forms always need you').length).toBeGreaterThan(0);
    expect(screen.getByText(/Automatic sends per claim per day is 3/)).toBeTruthy();
  });
});

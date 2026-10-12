// @vitest-environment jsdom
// owned by intake-web
/** Daily log: the optional Intake section (docs/SMART-INTAKE.md §12) renders like the other optional sections. */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import type { DailyLog, DailyLogResponse } from '../../api/agentsApi';
import { DailyLogPage, londonToday } from './DailyLogPage';
import { mockApi } from '../intake/bundles/__fixtures__/mockApi';

function log(intake?: DailyLog['sections']['intake']): DailyLogResponse {
  const day = londonToday();
  const counts = Object.fromEntries(
    ['emailsIn', 'emailsSent', 'autoSent', 'undone', 'drafts', 'fieldsPrefilled', 'needsYouOpened', 'needsYouResolved', 'tasksDone', 'deadlinesMet', 'deadlinesAtRisk', 'aiRuns', 'aiFailures', 'usagePausedMinutes'].map((k) => [k, 0]),
  ) as DailyLog['counts'];
  return {
    day,
    stored: true,
    compiledAt: `${day}T17:00:00.000Z`,
    log: {
      day,
      generatedAt: `${day}T17:00:00.000Z`,
      headline: 'A quiet day.',
      counts,
      sections: { sentAutomatically: [], waitingForYou: [], updatedRecords: [], deadlines: [], problems: [], usage: { driver: 'fake' }, ...(intake ? { intake } : {}) },
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Daily log — Intake section', () => {
  it('lists the intake lines with their links', async () => {
    const lines = [
      { at: `${londonToday()}T10:00:00.000Z`, agent: 'intake' as const, text: "Read 12 files for bundle 'Jane Doe – Corsa crash': 2 cases found, 1 file belongs to CCG-2026-00031.", link: '/intake/bundles/b1' },
      { at: `${londonToday()}T11:00:00.000Z`, agent: 'intake' as const, claimId: 'c-new', reference: 'CCG-2026-00042', text: "Registered CCG-2026-00042 from 'Jane Doe – Corsa crash' (9 documents filed).", why: 'you pressed Register', link: '/claims/c-new' },
    ];
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /daily-log': () => log(lines) }).fetch));
    renderWithProviders(<DailyLogPage />, { route: '/daily-log' });
    const card = (await screen.findByText('Intake (2)')).closest('section')!;
    expect(within(card).getByText(/2 cases found/)).toBeTruthy();
    expect(within(card).getByText(/why: you pressed Register/)).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open Intake' }).getAttribute('href')).toBe('/intake');
  });

  it('is absent on logs without intake activity', async () => {
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /daily-log': () => log() }).fetch));
    renderWithProviders(<DailyLogPage />, { route: '/daily-log' });
    expect(await screen.findByText('A quiet day.')).toBeTruthy();
    expect(screen.queryByText(/^Intake \(/)).toBeNull();
  });
});

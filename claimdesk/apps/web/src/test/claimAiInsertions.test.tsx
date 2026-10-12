// @vitest-environment jsdom
// owned by claimai-web
/**
 * AI input insertions elsewhere (docs/CLAIM-AI-INPUT.md §14.3): the chronology chips "recorded late" (title "source:
 * <file>") and "from your update", and the daily log's "Updates and catch-ups" section.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaimEvent } from '@ccguk/domain';
import { eventChips } from '../screens/claim/lib/chronology';
import { ChronologyTab } from '../screens/claim/tabs/ChronologyTab';
import type { ClaimView } from '../screens/claim/claimFile';
import { DailyLogPage, londonToday } from '../screens/dailyLog/DailyLogPage';
import type { DailyLog, DailyLogResponse } from '../api/agentsApi';
import { mockApi } from '../screens/intake/bundles/__fixtures__/mockApi';
import { renderWithProviders } from './harness';

afterEach(() => vi.unstubAllGlobals());

const ev = (id: string, type: ClaimEvent['type'], at: string, summary: string, data?: Record<string, unknown>): ClaimEvent => ({
  id,
  claimId: 'c1',
  type,
  at,
  recordedAt: '2026-10-12T09:00:00.000Z',
  summary,
  evidenceIds: [],
  createdBy: 'user-owner',
  ...(data ? { data } : {}),
});

const late = ev('e1', 'ncaf_sent', '2026-10-02T11:00:00.000Z', 'New Claim Advice Form sent to Example Mutual — recorded late, source: CATCHUP-NCAF-SENT.pdf', {
  recordedLate: true,
  lateSource: { inputId: 'cu1', bundleFileId: 'f1', filename: 'CATCHUP-NCAF-SENT.pdf', evidenceId: 'ev-f1' },
  kind: 'ncaf',
});
const fromUpdate = ev('e2', 'repair_completed', '2026-10-11T11:00:00.000Z', 'Repair completed', { source: 'ai_input', aiInputId: 'u1', actionKey: 'a2', quote: 'car repaired' });
const plain = ev('e3', 'note', '2026-10-12T08:00:00.000Z', 'Typed in the chronology');

describe('chronology chips', () => {
  it('eventChips', () => {
    expect(eventChips(late)).toEqual([{ key: 'recorded_late', label: 'recorded late', title: 'source: CATCHUP-NCAF-SENT.pdf' }]);
    expect(eventChips(fromUpdate)).toEqual([{ key: 'ai_input', label: 'from your update', title: 'Your words: “car repaired”' }]);
    expect(eventChips(plain)).toEqual([]);
    expect(eventChips({ data: { recordedLate: true } })[0]!.title).toMatch(/Recorded after the event/);
  });

  it('the Chronology tab shows them on the right rows', async () => {
    const events = [late, fromUpdate, plain];
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /claims/:id/events': () => events }).fetch));
    const view = { claim: { id: 'c1' }, events, evidence: [], hire: [] } as unknown as ClaimView;
    renderWithProviders(<ChronologyTab view={view} />);
    const chip = await screen.findByText('recorded late');
    expect(chip.getAttribute('title')).toBe('source: CATCHUP-NCAF-SENT.pdf');
    expect(chip.closest('tr')!.textContent).toContain('New Claim Advice Form sent');
    expect(screen.getByText('from your update').closest('tr')!.textContent).toContain('Repair completed');
    expect(within(screen.getByText('Typed in the chronology').closest('tr')!).queryByText(/recorded late|from your update/)).toBeNull();
  });
});

function log(claimAi?: DailyLog['sections']['claimAi']): DailyLogResponse {
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
      sections: { sentAutomatically: [], waitingForYou: [], updatedRecords: [], deadlines: [], problems: [], usage: { driver: 'fake' }, ...(claimAi ? { claimAi } : {}) },
    },
  };
}

describe('daily log — Updates and catch-ups', () => {
  it('lists the AI input lines with their links', async () => {
    const lines = [
      {
        at: `${londonToday()}T09:02:00.000Z`,
        agent: 'case_manager' as const,
        claimId: 'c1',
        reference: 'CCG-2026-00001',
        text: 'Your update on CCG-2026-00001: hire HA-0042 ended 11 Oct, repair completed 11 Oct, call noted.',
        why: 'you pressed Do it',
        link: '/claims/c1/ai',
      },
      { at: `${londonToday()}T10:00:00.000Z`, agent: 'intake' as const, claimId: 'c1', reference: 'CCG-2026-00001', text: 'Caught up CCG-2026-00001: filed 6 documents (1 already on file).', link: '/claims/c1/ai' },
    ];
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /daily-log': () => log(lines) }).fetch));
    renderWithProviders(<DailyLogPage />, { route: '/daily-log' });
    const card = (await screen.findByText('Updates and catch-ups (2)')).closest('section')!;
    expect(within(card).getByText(/hire HA-0042 ended 11 Oct/)).toBeTruthy();
    expect(within(card).getByText(/why: you pressed Do it/)).toBeTruthy();
    expect(within(card).getAllByRole('link', { name: 'open' })[0]!.getAttribute('href')).toBe('/claims/c1/ai');
  });

  it('is absent on logs without AI input', async () => {
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /daily-log': () => log() }).fetch));
    renderWithProviders(<DailyLogPage />, { route: '/daily-log' });
    expect(await screen.findByText('A quiet day.')).toBeTruthy();
    expect(screen.queryByText(/^Updates and catch-ups/)).toBeNull();
  });
});

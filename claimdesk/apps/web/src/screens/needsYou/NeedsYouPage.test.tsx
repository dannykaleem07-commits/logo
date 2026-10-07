// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '../../test/harness';
import { NeedsYouPage } from './NeedsYouPage';
import { SupremeTopbar } from '../../app/SupremeTopbar';
import { needsYouQk, type NeedsYouCount, type NeedsYouDetail, type NeedsYouItem } from '../../api/needsYouApi';
import { agentsQk } from '../../api/agentsApi';

const COUNT: NeedsYouCount = { total: 2, urgent: 1, byPriority: { urgent: 1, high: 0, normal: 1, low: 0 }, snoozed: 0 };
const ITEMS: NeedsYouItem[] = [
  {
    id: 'n1',
    kind: 'approve_send',
    claimId: 'c1',
    claimReference: 'CCG-2026-00012',
    title: 'Approve the acknowledgement to Example Insurance',
    summary: 'The insurer asked for our handling reference.',
    recommendation: { action: 'Approve', why: 'Allow-listed acknowledgement', confidence: 0.92, basis: [{ kind: 'rule', id: 'external_ok', label: 'Allow-listed kind' }] },
    options: [
      { id: 'approve', label: 'Approve and send', tone: 'primary' },
      { id: 'edit', label: 'Edit then approve', tone: 'neutral', requiresEdit: true },
      { id: 'reject', label: 'Do not send', tone: 'danger', requiresReason: true },
    ],
    payload: { email: { to: ['handler@insurer.example'], subject: 'Re: CCG-2026-00012', bodyText: 'Thank you for your email.' } },
    priority: 'urgent',
    status: 'open',
    createdBy: 'agent:mail',
    createdAt: '2026-10-05T08:00:00.000Z',
  },
  { id: 'n2', kind: 'question', title: 'Which address?', summary: 'Two on file', options: [], payload: {}, priority: 'normal', status: 'open', createdBy: 'agent:case_manager', createdAt: '2026-10-01T08:00:00.000Z' },
];
const DETAIL: NeedsYouDetail = { item: ITEMS[0]!, events: [], resolverRegistered: true };

describe('Needs-you inbox', () => {
  it('lists items grouped and shows the selected item with its email preview, basis chips and options', () => {
    renderWithProviders(
      <Routes>
        <Route path="/needs-you/:id" element={<NeedsYouPage />} />
      </Routes>,
      {
        route: '/needs-you/n1',
        queryData: [
          [needsYouQk.list({ status: 'open', kind: '', claimId: undefined }), { items: ITEMS, count: COUNT }],
          [needsYouQk.detail('n1'), DETAIL],
        ],
      },
    );
    expect(screen.getByText('Urgent')).toBeTruthy();
    expect(screen.getAllByText('Approve the acknowledgement to Example Insurance').length).toBeGreaterThan(0);
    expect(screen.getByText('Thank you for your email.')).toBeTruthy();
    expect(screen.getByText('Allow-listed kind')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Do not send' })).toBeTruthy();
    expect(screen.getByText(/confidence 92 %/)).toBeTruthy();
  });

  it('top bar shows the agents pill and the Needs-you badge with the urgent count', () => {
    renderWithProviders(<SupremeTopbar />, {
      queryData: [
        [needsYouQk.count, COUNT],
        [agentsQk.status, { pill: { state: 'paused', label: 'Paused — usage resets 14:05' } }],
      ],
    });
    expect(screen.getByTestId('agents-pill').textContent).toContain('Paused — usage resets 14:05');
    expect(screen.getByTestId('needs-you-badge').textContent).toContain('2 · 1 urgent');
  });
});

// @vitest-environment jsdom
// owned by mail
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '../../test/harness';
import { OutboxPage } from './OutboxPage';
import { mailQk, type OutboxItem, type OutboxList } from '../../api/mailApi';

const NOW = '2026-10-07T09:00:00.000Z';
const item = (id: string, status: OutboxItem['status'], extra: Partial<OutboxItem> = {}): OutboxItem => ({
  id,
  claimId: 'c1',
  claimReference: 'CCG-2026-00012',
  kind: 'ack',
  status,
  to: ['handler@insurer.example'],
  cc: [],
  subject: `Subject ${id}`,
  bodyText: 'Thank you.\n\nClaims Team, Courtesy Cars Group UK Ltd',
  attachments: [],
  holdUntil: status === 'held' ? '2026-10-07T09:10:00.000Z' : null,
  approvedBy: null,
  smtpMessageId: null,
  rawSentEvidenceId: null,
  attempts: 0,
  lastError: null,
  policy: { outcome: status === 'held' ? 'auto_held' : 'ask', ruleIds: [], reasons: status === 'awaiting_approval' ? ['First contact with handler@insurer.example'] : [] },
  createdBy: 'agent:mail',
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});
const LIST: OutboxList = { items: [item('o1', 'held'), item('o2', 'awaiting_approval'), item('o3', 'failed', { lastError: 'SMTP down' }), item('o4', 'sent')], counts: {} as OutboxList['counts'], now: NOW };

afterEach(() => vi.unstubAllGlobals());

describe('Outbox', () => {
  it('groups held (countdown + Undo), awaiting approval, failed (retry) and sent', () => {
    renderWithProviders(<OutboxPage />, { route: '/outbox', queryData: [[mailQk.outbox({}), LIST]] });
    expect(screen.getByText('Held — sending soon (1)')).toBeTruthy();
    expect(screen.getByText('Waiting for your approval (1)')).toBeTruthy();
    expect(screen.getByText('First contact with handler@insurer.example')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByText(/Sending in \d+:\d\d|Sending now/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
  });

  it('the ?undo=1 deep link undoes the held email after one click', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        return new Response(JSON.stringify({ item: { ...LIST.items[0], status: 'cancelled' }, events: [], review: null, recipients: [], attachmentsCheck: { allowed: true, reasons: [] }, now: NOW }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const { user } = renderWithProviders(
      <Routes>
        <Route path="/outbox/:id" element={<OutboxPage />} />
      </Routes>,
      { route: '/outbox/o1?undo=1', queryData: [[mailQk.outbox({}), LIST]] },
    );
    expect(screen.getByText('Stop this email?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo — do not send' }));
    expect(calls).toContain('POST /api/outbox/o1/undo');
  });
});

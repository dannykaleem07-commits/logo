// @vitest-environment jsdom
// owned by ap-paperwork
/** The signing kiosk screen (docs/SUPREME-AUTOPILOT.md §I.6): one document at a time, then the sign step; token errors. */
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { KioskPage } from './KioskPage';

const TOKEN = 'kiosk-token-kiosk-token-kiosk-token-12345';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SUMMARY = {
  sessionId: 's1',
  packLabel: 'Hire agreement and handover documents',
  signer: { name: 'Jane Example' },
  documents: [
    { id: 'd1', title: 'Express request to begin the hire', purpose: 'sign', read: false, signed: false },
    { id: 'd2', title: 'Cancellation form', purpose: 'give', read: false, signed: false },
  ],
  otp: { delivery: 'handler' },
  expiresAt: '2026-10-12T08:30:00.000Z',
  completed: false,
};

function renderKiosk() {
  return renderWithProviders(
    <Routes>
      <Route path="/sign/kiosk/:token" element={<KioskPage />} />
    </Routes>,
    { route: `/sign/kiosk/${TOKEN}` },
  );
}

/** The "scrolled to the end" sentinel becomes visible at once (jsdom has no layout). */
class SeenObserver {
  constructor(private readonly cb: (entries: Array<{ isIntersecting: boolean }>) => void) {}
  observe(): void {
    this.cb([{ isIntersecting: true }]);
  }
  disconnect(): void {}
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('KioskPage', () => {
  it('shows each document in turn, then the sign step with the handler code', async () => {
    vi.stubGlobal('IntersectionObserver', SeenObserver);
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith(`/kiosk/${TOKEN}`)) return json(SUMMARY);
      if (url.endsWith('/read')) return json({ read: ['d1'] });
      if (url.endsWith('/otp/start')) return json({ channel: 'handler', expiresAt: '2026-10-12T08:40:00.000Z', handlerCode: '123456' });
      return json({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404);
    });
    const { user } = renderKiosk();
    expect(await screen.findByText('Document 1 of 2')).toBeTruthy();
    expect(screen.getByTitle('Express request to begin the hire')).toBeTruthy(); // the PDF frame
    await user.click(await screen.findByRole('button', { name: 'I have read this' }));
    expect(await screen.findByText('Document 2 of 2')).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'I have read this' }));
    expect(await screen.findByRole('heading', { name: 'Sign your documents' })).toBeTruthy();
    await user.type(screen.getByLabelText('Your full name'), 'Jane Example');
    await user.click(screen.getByRole('button', { name: 'Get my code' }));
    expect(await screen.findByText(/ask the Claims Team member for your 6-digit code/i)).toBeTruthy();
    expect(screen.getByText('123456')).toBeTruthy();
    // no signature drawn yet: Sign stays disabled and says why
    expect((screen.getByRole('button', { name: 'Sign' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Draw your signature')).toBeTruthy();
    expect(calls.filter((c) => c.includes('/read'))).toHaveLength(2);
    // only kiosk routes are called
    expect(calls.every((c) => c.includes(`/api/kiosk/${TOKEN}`))).toBe(true);
  });

  it('shows a plain message for an expired link and no documents', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: { code: 'KIOSK_EXPIRED', message: 'expired' } }, 401));
    renderKiosk();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/expired/i));
    expect(screen.queryByText(/Document 1/)).toBeNull();
  });
});

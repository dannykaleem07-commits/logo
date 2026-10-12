// @vitest-environment jsdom
// owned by claimai-web
/**
 * Typing guard for the AI input tab (docs/CLAIM-AI-INPUT.md §14.2: "typing never loses focus"): every keystroke in the
 * update box and in the pasted call note keeps the focus in the field and the value comes out exactly as typed, while
 * poll answers land underneath (the panel and the open input are refetched every few milliseconds, each answer a little
 * different, the AI flipping between paused and back).
 */
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, typeAndExpectFocus } from '../../../test/harness';
import { mockApi } from '../../intake/bundles/__fixtures__/mockApi';
import { resetUploadQueues } from '../../intake/bundles/uploadQueue';
import type { ClaimView } from '../claimFile';
import { AiInputTab } from './AiInputTab';
import { catchUpDetail, panelFixture, updatePreview } from './__fixtures__/fixtures';

const view = { claim: { id: 'c1', reference: 'CCG-2026-00001', status: 'hire_active' } } as unknown as ClaimView;

let n = 0;
function churningApi() {
  const api = mockApi({
    'GET /claims/:id/ai-input': () => {
      n += 1;
      const p = panelFixture();
      p.ai.available = n % 2 === 0;
      p.history.total = 3 + n;
      return p;
    },
    'GET /claims/:id/ai-input/inputs': () => ({ items: panelFixture().history.items, total: 3 + n }),
    'GET /claims/:id/ai-input/u1': () => ({ ...updatePreview(), headline: `poll ${n}` }),
    'GET /claims/:id/ai-input/cu1': () => catchUpDetail(),
  });
  // Answers land a little later, while the next key is typed.
  return (input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => setTimeout(() => resolve(api.fetch(input, init)), 5));
}

beforeEach(() => {
  resetUploadQueues();
  n = 0;
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  vi.stubGlobal('fetch', vi.fn(churningApi()));
});
afterEach(() => vi.unstubAllGlobals());

describe('AI input tab — typing never loses focus', () => {
  it('update box and call note keep focus and value while poll answers land', async () => {
    const { user, queryClient } = renderWithProviders(<AiInputTab view={view} />, { route: '/claims/c1/ai' });
    await screen.findByText(/^I understood/);
    const timer = setInterval(() => {
      void queryClient.invalidateQueries();
    }, 15);
    try {
      const box = screen.getByLabelText('What happened, or what should ClaimDesk do?') as HTMLTextAreaElement;
      await typeAndExpectFocus(user, box, "Client called, car repaired; don't chase {them} until Monday.");
      await user.click(screen.getByRole('button', { name: 'Paste a call note or voice-note transcript' }));
      const note = screen.getByLabelText('Call note') as HTMLTextAreaElement;
      await typeAndExpectFocus(user, note, 'Garage: parts [due] Thursday.');
      expect(box.value).toBe("Client called, car repaired; don't chase {them} until Monday.");
    } finally {
      clearInterval(timer);
    }
    expect(n).toBeGreaterThan(3);
    // the draft survives a reload of the tab
    expect(window.localStorage.getItem('claimdesk.aiInput.draft.c1')).toContain('Garage: parts');
  });

  it('opens with the update box focused from the header button (?focus=update)', async () => {
    renderWithProviders(<AiInputTab view={view} />, { route: '/claims/c1/ai?focus=update' });
    const box = (await screen.findByLabelText('What happened, or what should ClaimDesk do?')) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(box);
    // the preview arriving afterwards never steals the focus from the box
    await screen.findByText(/^I understood/);
    expect(document.activeElement).toBe(box);
  });
});

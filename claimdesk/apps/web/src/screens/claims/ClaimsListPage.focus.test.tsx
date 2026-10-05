// @vitest-environment jsdom
/**
 * Claims list Search (0.3 #6): the box keeps its own text and the URL (?q=) follows after a pause, so typing fast or in
 * the middle of the text never loses letters or moves the cursor. The fetch is stubbed; the list is empty.
 */
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { ClaimsListPage } from './ClaimsListPage';

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="search">{loc.search}</span>;
}

function renderList(route = '/claims') {
  return renderWithProviders(
    <>
      <ClaimsListPage />
      <LocationProbe />
    </>,
    { route }
  );
}

const box = () => screen.getByLabelText('Search') as HTMLInputElement;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } }))
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Claims list Search', () => {
  it('typing fast keeps every letter and the focus; the URL follows after a pause', async () => {
    renderList();
    const el = box();
    // no pause at all between keys (faster than any person types)
    const fast = userEvent.setup({ delay: null });
    await fast.click(el);
    await fast.type(el, 'Whitfield');
    expect(el.value).toBe('Whitfield');
    expect(document.activeElement).toBe(el);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(screen.getByTestId('search').textContent).toBe('?q=Whitfield');
    expect(el.value).toBe('Whitfield');
    expect(document.activeElement).toBe(el);
  });

  it('typing in the middle keeps the cursor where it is', async () => {
    const r = renderList('/claims?q=Whitfield');
    const el = box();
    expect(el.value).toBe('Whitfield');
    await r.user.click(el);
    el.setSelectionRange(2, 2);
    await r.user.keyboard('xy');
    expect(el.value).toBe('Whxyitfield');
    expect(el.selectionStart).toBe(4);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    // the URL catching up does not redraw the box under the cursor
    expect(screen.getByTestId('search').textContent).toBe('?q=Whxyitfield');
    expect(el.value).toBe('Whxyitfield');
    expect(el.selectionStart).toBe(4);
  });

  it('a change to ?q= from elsewhere shows in the box when it is not being typed in', async () => {
    renderList('/claims?q=abc');
    const el = box();
    expect(el.value).toBe('abc');
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    expect(el.value).toBe('abc');
  });
});

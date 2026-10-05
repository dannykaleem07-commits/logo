/**
 * DOM test harness (docs/V03-MANAGER-MODE-HIRE-PRICING.md §D.3). Test files that use it start with
 * `// @vitest-environment jsdom`; the default vitest environment stays `node`, so the renderToString tests are untouched.
 * Vitest globals are off, so this module registers `afterEach(cleanup)` itself — no global setup file is needed.
 */
import type { ReactElement } from 'react';
import { cleanup, render, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect } from 'vitest';
import { ToastProvider } from '../components/Toast';

export type UserEvent = ReturnType<typeof userEvent.setup>;

afterEach(() => {
  cleanup();
});

/** Render with QueryClient (retry off), MemoryRouter, ToastProvider and optional pre-seeded query data. */
export function renderWithProviders(
  ui: ReactElement,
  opts: { route?: string; queryData?: Array<[QueryKey, unknown]> } = {},
): RenderResult & { queryClient: QueryClient; user: UserEvent } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  for (const [key, data] of opts.queryData ?? []) queryClient.setQueryData(key, data);
  const user = userEvent.setup();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[opts.route ?? '/']}>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return Object.assign(result, { queryClient, user });
}

/** Click `el`, type `text` one key at a time; after EVERY key assert document.activeElement === el; finally assert el.value === expected (default text). */
export async function typeAndExpectFocus(user: UserEvent, el: HTMLInputElement | HTMLTextAreaElement, text: string, expected: string = text): Promise<void> {
  await user.click(el);
  expect(document.activeElement, 'focus after click').toBe(el);
  for (const ch of text) {
    // user-event treats `{` and `[` as key descriptors; escape them so every character is typed literally.
    const key = ch === '{' ? '{{' : ch === '[' ? '[[' : ch;
    await user.keyboard(key);
    if (document.activeElement !== el) {
      const active = document.activeElement;
      const where = active ? `${active.tagName.toLowerCase()}${active.id ? `#${active.id}` : ''}${active.className ? `.${String(active.className).split(' ').join('.')}` : ''}` : 'nothing';
      throw new Error(`Focus left the field after typing "${ch}" (value so far "${el.value}"); focus is on ${where}`);
    }
  }
  expect(el.value).toBe(expected);
}

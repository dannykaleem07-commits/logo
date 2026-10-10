// @vitest-environment jsdom
// /claims/:id?tab=<tab> links (Needs-you cards, the Autopilot tab, the daily log) open that tab of the claim file.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

afterEach(cleanup);
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { TabFromQuery } from '../screens/claim/ClaimFilePage';

function Tab() {
  return <p data-testid="tab-page">{useParams().tab}</p>;
}

function at(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/claims/:id">
          <Route index element={<TabFromQuery />} />
          <Route path=":tab" element={<Tab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('claim file ?tab= links', () => {
  it('opens the named tab', () => {
    at('/claims/c1?tab=autopilot');
    expect(screen.getByTestId('tab-page').textContent).toBe('autopilot');
  });
  it('falls back to Overview for an unknown or missing tab', () => {
    at('/claims/c1?tab=nope');
    expect(screen.getByTestId('tab-page').textContent).toBe('overview');
  });
});

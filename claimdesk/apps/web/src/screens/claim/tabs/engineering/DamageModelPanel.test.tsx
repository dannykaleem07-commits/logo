// @vitest-environment jsdom
/**
 * The claim Engineering tab's damage model: the client vehicle goes to the (lazy) damage model, which fetches its
 * dimensions from GET /api/catalogue/dimensions and, in jsdom (no WebGL), shows the 2D views.
 */
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaimView } from '../../claimFile';
import { renderWithProviders } from '../../../../test/harness';
import { DamageModelPanel } from './DamageModelPanel';

const view = {
  claim: { id: 'c1' },
  vehicle: { id: 'v1', registration: 'KX14ABC', make: 'FORD', model: 'FIESTA', bodyType: 'HATCHBACK', colour: 'BLUE', yearOfManufacture: 2019, spec: { doors: 5 } }
} as unknown as ClaimView;

function respond(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => JSON.parse(text) as unknown,
    text: async () => text
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DamageModelPanel', () => {
  it('passes the client vehicle and shows the dimensions on file', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      if (url.pathname === '/api/catalogue/dimensions') return respond({ dims: { lengthMm: 4040, widthMm: 1735, heightMm: 1476, wheelbaseMm: 2493, profile: 'hatch', doors: 5 }, source: 'file' });
      return respond({});
    });
    vi.stubGlobal('fetch', fetch);
    renderWithProviders(<DamageModelPanel view={view} />);
    expect(await screen.findByText('FORD FIESTA')).toBeTruthy();
    expect(await screen.findByText(/4040 × 1735 × 1476 mm/)).toBeTruthy();
    expect(screen.getByTestId('damage-2d')).toBeTruthy();
    const called = fetch.mock.calls.map(([u]) => new URL(String(u), 'http://localhost')).find((u) => u.pathname === '/api/catalogue/dimensions')!;
    expect(Object.fromEntries(called.searchParams)).toMatchObject({ make: 'FORD', model: 'FIESTA', body: 'HATCHBACK', doors: '5', year: '2019' });
  });

  it('uses typical body proportions when only body-type defaults are on file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ dims: { lengthMm: 4200, widthMm: 1800, heightMm: 1450, wheelbaseMm: 2600 }, source: 'default' })));
    renderWithProviders(<DamageModelPanel view={view} />);
    expect(await screen.findByText(/Typical .* proportions/)).toBeTruthy();
  });
});

// @vitest-environment jsdom
// owned by intake-web
/** Attach to an existing claim (docs/SMART-INTAKE.md §6.9, §11.4): search keeps focus; on-file vs documents; ticks → apply. */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, typeAndExpectFocus } from '../../../test/harness';
import { AttachDialog, onFileValue } from './AttachDialog';
import { bundleDetail, mockApi } from './__fixtures__/mockApi';

const CLAIM = {
  claim: { id: 'c-old', reference: 'CCG-2026-00001', accident: { occurredAt: '2026-10-07T14:20:00.000Z', location: 'High Street, Exampleton' } },
  claimant: { name: 'Jane Doe', phone: '' },
  vehicle: { registration: 'KX21ABC' },
  thirdParties: [],
};

afterEach(() => vi.unstubAllGlobals());

describe('AttachDialog', () => {
  it('reads on-file values defensively', () => {
    expect(onFileValue(CLAIM, 'client.name')).toBe('Jane Doe');
    expect(onFileValue(CLAIM, 'accident.location')).toBe('High Street, Exampleton');
    expect(onFileValue(CLAIM, 'tp.registration')).toBeNull();
    expect(onFileValue(CLAIM, 'hire.needed')).toBeNull();
    expect(onFileValue(null, 'client.name')).toBeNull();
  });

  it('finds the claim, compares, and attaches with the ticked details', async () => {
    const api = mockApi({
      'GET /claims': () => ({ items: [{ id: 'c-old', reference: 'CCG-2026-00001', claimantName: 'Jane Doe', registration: 'KX21ABC' }] }),
      'GET /claims/:id': () => CLAIM,
    });
    vi.stubGlobal('fetch', vi.fn(api.fetch));
    const onAttach = vi.fn(async () => ({}) as never);
    const { user } = renderWithProviders(<AttachDialog open detail={bundleDetail()} onClose={() => undefined} onAttach={onAttach} />);
    const dialog = screen.getByRole('dialog', { name: 'Attach to an existing claim' });
    await typeAndExpectFocus(user, within(dialog).getByLabelText('Find the claim') as HTMLInputElement, 'KX21');
    await user.click(await within(within(dialog).getByRole('listbox', { name: 'Claims' })).findByRole('option', { name: /CCG-2026-00001/ }));
    // same values on file are greyed and not ticked; values the claim lacks are ticked
    const reg = (await within(dialog).findByLabelText('Apply Client’s car Registration')) as HTMLInputElement;
    await vi.waitFor(() => expect(reg.disabled).toBe(true));
    const vin = within(dialog).getByLabelText('Apply Client’s car VIN') as HTMLInputElement;
    expect(vin.checked).toBe(true);
    await user.click(vin);
    await user.click(within(dialog).getByRole('button', { name: 'Attach' }));
    expect(onAttach).toHaveBeenCalledTimes(1);
    const body = (onAttach.mock.calls[0] as unknown as [{ claimId: string; groupKey: string; apply: string[] }])[0];
    expect(body.claimId).toBe('c-old');
    expect(body.groupKey).toBe('main');
    expect(body.apply).toContain('client.phone');
    expect(body.apply).not.toContain('vehicle.vin');
    expect(body.apply).not.toContain('vehicle.registration');
    expect(api.calls.find((c) => c.path === '/claims' && c.query.q === 'KX21')).toBeTruthy();
  });
});

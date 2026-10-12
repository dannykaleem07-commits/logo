// @vitest-environment jsdom
// owned by intake-web
/** Settings > Intake (docs/SMART-INTAKE.md §4.17, §14): plain-words settings; PATCH sends only what changed. */
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, typeAndExpectFocus } from '../../../test/harness';
import type { IntakeSettings } from '../../../api/bundlesApi';
import { IntakeSettingsPage, settingsDiff } from './IntakeSettingsPage';
import { mockApi } from '../../intake/bundles/__fixtures__/mockApi';

const DEFAULTS: IntakeSettings = {
  bundles: { autoRegister: false, autoRegisterMinConfidence: 0.9, prepareMissingDocsRequest: true, quietSeconds: 20, folderBundles: true, aiReasoningRunsPerBundlePerDay: 3 },
  split: { enabled: true, minPages: 2 },
  duplicates: { nearPhotoMaxDistance: 6, nearTextMinJaccard: 0.9 },
  photos: { beforeAccidentToleranceHours: 2, gpsOutlierKm: 2 },
  archives: { maxEntries: 200, maxTotalBytes: 2 * 1024 ** 3, maxDepth: 2, maxRatio: 200 },
};

afterEach(() => vi.unstubAllGlobals());

describe('settingsDiff', () => {
  it('sends only the changed values, grouped', () => {
    const after = structuredClone(DEFAULTS);
    after.bundles.autoRegister = true;
    after.photos.gpsOutlierKm = 5;
    expect(settingsDiff(DEFAULTS, after)).toEqual({ bundles: { autoRegister: true }, photos: { gpsOutlierKm: 5 } });
    expect(settingsDiff(DEFAULTS, structuredClone(DEFAULTS))).toEqual({});
  });
});

describe('IntakeSettingsPage', () => {
  it('auto-register is off by default with its explanation; Save patches only what changed', async () => {
    const api = mockApi({
      'GET /settings/intake': () => ({ settings: DEFAULTS, defaults: DEFAULTS }),
      'PATCH /settings/intake': (c) => {
        const p = c.body as { bundles?: Partial<IntakeSettings['bundles']> };
        return { settings: { ...DEFAULTS, bundles: { ...DEFAULTS.bundles, ...p.bundles } }, defaults: DEFAULTS };
      },
    });
    vi.stubGlobal('fetch', vi.fn(api.fetch));
    const { user } = renderWithProviders(<IntakeSettingsPage />, { route: '/settings/intake' });
    const toggle = (await screen.findByLabelText(/Register automatically when there are no conflicts/)) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/Only when every key detail is confident, nothing conflicts, the AI has checked the bundle and nothing is worth a look/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(toggle);
    const conf = screen.getByLabelText(/Confidence needed for automatic registration/) as HTMLInputElement;
    expect(conf.value).toBe('90');
    await user.clear(conf);
    await typeAndExpectFocus(user, conf, '95');
    await user.click(save);
    await vi.waitFor(() => expect(api.find('PATCH', '/settings/intake')).toHaveLength(1));
    expect(api.find('PATCH', '/settings/intake')[0]!.body).toEqual({ bundles: { autoRegister: true, autoRegisterMinConfidence: 0.95 } });
  });

  it('a value out of range is not saved', async () => {
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /settings/intake': () => ({ settings: DEFAULTS, defaults: DEFAULTS }) }).fetch));
    const { user } = renderWithProviders(<IntakeSettingsPage />, { route: '/settings/intake' });
    const conf = (await screen.findByLabelText(/Confidence needed for automatic registration/)) as HTMLInputElement;
    await user.clear(conf);
    await user.type(conf, '50');
    expect(screen.getByText('Between 80 and 100')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

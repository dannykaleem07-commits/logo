// @vitest-environment jsdom
/**
 * The tagging tool without WebGL (jsdom): pick a part in the list, choose its zone, save → PUT /tags with only the
 * edits; read-only users see no editing controls; the Settings card renders on the server (no API).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/Toast';
import { models3dApi, type Model3dView } from '../../engineer/damage3d/exact/exactApi';
import { ModelEditor } from './ModelEditor';
import { Models3dCard } from './Models3dCard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MODEL: Model3dView = {
  id: '00000000-0000-4000-8000-000000000002',
  title: 'Fiesta Mk7 5dr',
  fileName: 'fiesta.glb',
  sourceFormat: 'glb',
  bytes: 1_234_567,
  sha256: 'a'.repeat(64),
  assignment: { makeSlug: 'ford', make: 'Ford', modelSlug: 'fiesta', model: 'Fiesta', generationId: 'ford-fiesta-mk7-2008-2017', generation: 'Mk7 (2008–2017)', bodyType: 'hatchback' },
  licence: { confirmed: true, confirmedBy: 'boss', confirmedAt: '2026-10-05T09:00:00.000Z', note: 'ref 1' },
  active: true,
  stats: { triangles: 48, nodes: 4, meshes: 4, materials: 1, textures: 0, parts: 4, extensionsUsed: [] },
  warnings: [],
  frame: { forward: '+z', mirror: false, source: 'auto' },
  parts: [
    { key: 'n0p0', node: 0, primitive: 0, name: 'Door_FL', materialName: 'CarPaint', material: 0, parents: [], triangles: 12 },
    { key: 'n1p0', node: 1, primitive: 0, name: 'Object_17', material: 0, parents: [], triangles: 12 },
    { key: 'n2p0', node: 2, primitive: 0, name: 'Body_Shell', material: 0, parents: [], triangles: 12 },
    { key: 'n3p0', node: 3, primitive: 0, name: 'Bolt', parents: [], triangles: 12 },
  ],
  materials: [{ index: 0, name: 'CarPaint', role: 'paint' }],
  paintMaterials: [0],
  plateParts: [],
  autoZones: { n0p0: { zone: 'front_door_l', source: 'name', confidence: 0.95, rule: 'door' }, n1p0: { zone: 'sill_l', source: 'position', confidence: 0.35, rule: 'position' } },
  tags: {},
  zones: { n0p0: 'front_door_l', n1p0: 'sill_l' },
  fileUrl: '/models3d/00000000-0000-4000-8000-000000000002/model.glb',
  thumbnail: true,
  createdAt: '2026-10-05T09:00:00.000Z',
  createdBy: 'boss',
  updatedAt: '2026-10-05T09:00:00.000Z',
};

function renderEditor(canEdit: boolean, onChanged = vi.fn()) {
  return render(
    <ToastProvider>
      <ModelEditor model={MODEL} canEdit={canEdit} onChanged={onChanged} onClose={() => {}} />
    </ToastProvider>
  );
}

describe('ModelEditor', () => {
  it('tags a part and saves only the edits', async () => {
    const saved = { ...MODEL, tags: { n2p0: 'roof' }, zones: { ...MODEL.zones, n2p0: 'roof' }, updatedAt: '2026-10-05T09:01:00.000Z' };
    const spy = vi.spyOn(models3dApi, 'saveTags').mockResolvedValue(saved);
    const onChanged = vi.fn();
    renderEditor(true, onChanged);
    expect(document.querySelector('.m3d-summary')?.textContent).toMatch(/2 of 4 parts mapped/);
    const list = screen.getByRole('complementary', { name: 'Parts' });
    fireEvent.click(within(list).getByText('Body_Shell'));
    const select = screen.getByLabelText('Damage zone for Body_Shell') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'roof' } });
    expect(screen.getByText('1 unsaved change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save tags' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(MODEL.id, { tags: { n2p0: 'roof' }, clear: [] }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(saved));
  });

  it('marks a part as not a damage part and can discard', () => {
    renderEditor(true);
    fireEvent.click(screen.getByText('Bolt'));
    fireEvent.change(screen.getByLabelText('Damage zone for Bolt'), { target: { value: '__none' } });
    expect(screen.getByText('1 unsaved change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText('1 unsaved change')).toBeNull();
  });

  it('is read-only for users who are not managers', () => {
    renderEditor(false);
    fireEvent.click(screen.getByText('Door_FL'));
    expect(screen.queryByLabelText('Damage zone for Door_FL')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save tags' })).toBeNull();
    expect(screen.queryByText(/Orientation, paint, plates/)).toBeNull();
  });
});

describe('Models3dCard', () => {
  it('renders on the server with the licence notice', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    const html = renderToString(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <Models3dCard />
        </ToastProvider>
      </QueryClientProvider>
    );
    expect(html).toContain('3D vehicle models');
    expect(html).toContain('Audatex/Qapter models cannot be imported');
    expect(html).toContain('Manage 3D models');
  });
});

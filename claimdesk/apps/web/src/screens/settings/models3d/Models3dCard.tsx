/**
 * The Settings card for 3D vehicle models (one line in SettingsPage). Collapsed, it shows how many licensed models
 * are imported; opened, it holds the whole manager (list, upload, zone-tagging editor), so no extra route is needed.
 * `Models3dSettingsPage` is the same manager as a page, for a `/settings/models3d` route if one is added.
 */
import { lazy, Suspense, useState } from 'react';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { Loading } from '../../../components/Spinner';
import { LICENCE_NOTICE } from '../../engineer/damage3d/exact/exactApi';
import { useModels3d } from './models3dQueries';

const Manager = lazy(() => import('./Models3dManager').then((m) => ({ default: m.Models3dManager })));

export function Models3dCard({ id = 'models3d' }: { id?: string }) {
  const [open, setOpen] = useState(false);
  const list = useModels3d();
  const n = list.data?.items.length;
  const active = list.data?.items.filter((m) => m.active).length;
  return (
    <Card
      id={id}
      title="3D vehicle models"
      actions={
        <Button size="sm" variant={open ? 'ghost' : 'secondary'} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Close' : 'Manage 3D models'}
        </Button>
      }
    >
      {open ? (
        <Suspense fallback={<Loading label="Loading…" />}>
          <Manager />
        </Suspense>
      ) : (
        <p className="xs muted" style={{ margin: 0 }}>
          {n === undefined ? 'Generated models for every vehicle; import exact models you hold a licence for.' : n === 0 ? 'No licensed models imported: every claim uses the generated model built from the vehicle’s real proportions.' : `${n} licensed ${n === 1 ? 'model' : 'models'} imported (${active} in use).`}{' '}
          {LICENCE_NOTICE}
        </p>
      )}
    </Card>
  );
}

/**
 * Settings → 3D models: the imported (licensed) models, upload, and the zone-tagging editor. Managers (admin /
 * approver) upload, edit and delete; everyone else can look.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isManagerRole } from '@ccguk/domain';
import { isApiError } from '../../../api/client';
import { useMe } from '../../../api/hooks';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { EmptyState } from '../../../components/EmptyState';
import { Modal } from '../../../components/Modal';
import { Loading } from '../../../components/Spinner';
import { useToast } from '../../../components/Toast';
import { apiUrl, LICENCE_NOTICE, models3dApi, type Model3dSummary, type Model3dView } from '../../engineer/damage3d/exact/exactApi';
import { formatBytes } from '../../engineer/damage3d/exact/exactModel';
import { clearExactModelCache } from '../../engineer/damage3d/exact/useExactModel';
import { ModelEditor } from './ModelEditor';
import { assignmentLabel } from './models3dSettings';
import { m3k, useModels3d } from './models3dQueries';
import { UploadModelForm } from './UploadModelForm';
import './models3d.css';

export function Models3dManager() {
  const me = useMe();
  const canEdit = isManagerRole(me.data?.role);
  const qc = useQueryClient();
  const toast = useToast();
  const list = useModels3d();
  const limits = useQuery({ queryKey: m3k.limits, queryFn: ({ signal }) => models3dApi.limits(signal), staleTime: 300_000 });
  const [mode, setMode] = useState<'list' | 'upload' | { edit: string }>('list');
  const editId = typeof mode === 'object' ? mode.edit : undefined;
  const one = useQuery({ queryKey: m3k.one(editId ?? ''), queryFn: ({ signal }) => models3dApi.get(editId!, signal), enabled: Boolean(editId) });
  const [deleting, setDeleting] = useState<Model3dSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const changed = (view: Model3dView) => {
    qc.setQueryData(m3k.one(view.id), view);
    void qc.invalidateQueries({ queryKey: m3k.list });
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await models3dApi.remove(deleting.id);
      clearExactModelCache();
      toast.success(`${deleting.title} deleted`);
      setDeleting(null);
      if (editId === deleting.id) setMode('list');
      void qc.invalidateQueries({ queryKey: m3k.list });
    } catch (e) {
      toast.error(isApiError(e) ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (editId) {
    if (one.isLoading) return <Loading label="Loading model…" />;
    if (one.error) return <ApiErrorNotice error={one.error} what="load the model" />;
    if (one.data) return <ModelEditor model={one.data} canEdit={canEdit} onChanged={changed} onClose={() => setMode('list')} />;
  }

  if (mode === 'upload') {
    return (
      <UploadModelForm
        {...(limits.data ? { maxBytes: limits.data.maxBytes } : {})}
        onCancel={() => setMode('list')}
        onUploaded={(view) => {
          clearExactModelCache();
          changed(view);
          const mapped = Object.keys(view.zones).length;
          toast.success(`Uploaded. ${mapped} of ${view.stats.parts} parts were mapped automatically — check them now.`);
          setMode({ edit: view.id });
        }}
      />
    );
  }

  const items = list.data?.items ?? [];
  return (
    <div className="m3d-manager stack">
      <div className="m3d-intro">
        <p className="xs muted">
          ClaimDesk builds a 3D model of every vehicle from its real proportions. When you hold a licence for an exact model of a make, model and generation (a .glb or .gltf from a 3D model supplier), import it here: claims for that vehicle then show it instead, in the vehicle&apos;s own colour and registration, with damage zones mapped from the part names.
        </p>
        <div className="notice notice-info xs" role="note">
          <strong>{LICENCE_NOTICE}</strong>
        </div>
      </div>
      {canEdit && (
        <div className="row">
          <Button variant="primary" onClick={() => setMode('upload')}>
            Import a 3D model
          </Button>
          {limits.data && (
            <span className="xs muted">
              up to {formatBytes(limits.data.maxBytes)} · {limits.data.maxTriangles.toLocaleString('en-GB')} triangles
            </span>
          )}
        </div>
      )}
      {list.isLoading ? (
        <Loading label="Loading 3D models…" />
      ) : list.error ? (
        <ApiErrorNotice error={list.error} what="load the 3D models" />
      ) : items.length === 0 ? (
        <EmptyState title="No imported models">Claims use the generated model for every vehicle until a licensed model is imported.</EmptyState>
      ) : (
        <ul className="m3d-list">
          {items.map((m) => (
            <li key={m.id} className={m.active ? undefined : 'is-off'}>
              <div className="m3d-thumb">{m.thumbnail ? <img src={`${apiUrl(`/models3d/${m.id}/thumbnail.png`)}?v=${encodeURIComponent(m.updatedAt)}`} alt="" loading="lazy" /> : <span aria-hidden="true">3D</span>}</div>
              <div className="m3d-item-main">
                <div className="m3d-item-title">
                  {m.title} {!m.active && <Badge tone="amber">off</Badge>}
                </div>
                <div className="xs muted">{assignmentLabel(m.assignment)}</div>
                <div className="xs muted">
                  {m.mappedParts} of {m.stats.parts} parts mapped · {m.stats.triangles.toLocaleString('en-GB')} triangles · {formatBytes(m.bytes)}
                </div>
              </div>
              <div className="row">
                <Button size="sm" onClick={() => setMode({ edit: m.id })}>
                  {canEdit ? 'Map parts' : 'View'}
                </Button>
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(m)} aria-label={`Delete ${m.title}`}>
                    Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={Boolean(deleting)}
        title="Delete this 3D model?"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void remove()}>
              Delete
            </Button>
          </>
        }
      >
        <p>
          {deleting?.title} and its zone tags are removed from this computer. Claims for {deleting ? assignmentLabel(deleting.assignment) : ''} go back to the generated model. The deletion is recorded in the audit trail.
        </p>
      </Modal>
    </div>
  );
}

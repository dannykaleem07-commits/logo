// owned by intake-web
/**
 * New case bundle (docs/SMART-INTAKE.md §11.3): type a temporary name ("Jane Doe – Corsa crash"), drop any number of
 * files or a whole folder. On the first drop the bundle is created and you go to its page, where the upload carries on
 * with per-file progress while every file is read and then all of them are read together.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { TextInput } from '../../../components/Form';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useQueryClient } from '@tanstack/react-query';
import { bundleKeys, bundlesApi } from '../../../api/bundlesApi';
import { DropArea } from './UploadPanel';
import { importFolderHint, uploadQueueFor } from './uploadQueue';
import './bundles.css';

export function NewBundlePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [pending, setPending] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [nameError, setNameError] = useState<string | undefined>();

  const start = async (files: File[]) => {
    const n = name.trim();
    if (!n) {
      setPending(files);
      setNameError('Type a temporary name first — for example the client and the car.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bundle = await bundlesApi.create(n);
      void qc.invalidateQueries({ queryKey: bundleKeys.all });
      const queue = uploadQueueFor(bundle.id, bundle.name);
      if (files.length) void queue.add(files);
      navigate(`/intake/bundles/${encodeURIComponent(bundle.id)}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <div className="page bdl-page">
      <PageHeader title="New case bundle" crumbs={[{ label: 'Intake', to: '/intake' }, { label: 'New bundle' }]} subtitle="Drop everything you have for one case — or a mixed pile; the files are sorted into cases for you." />
      <Card>
        <div className="stack">
          <TextInput
            label="Temporary name"
            placeholder="e.g. Jane Doe – Corsa crash"
            value={name}
            onChange={(v) => {
              setName(v);
              if (v.trim()) setNameError(undefined);
            }}
            required
            maxLength={120}
            error={nameError}
            hint="Only for you — the claim gets its own reference when you register it."
            autoFocus
          />
          <DropArea onFiles={(files) => void start(files)} disabled={busy}>
            {pending.length > 0 && (
              <div className="notice notice-info">
                {pending.length} {pending.length === 1 ? 'file is' : 'files are'} ready.{' '}
                <Button size="sm" variant="primary" disabled={!name.trim() || busy} onClick={() => void start(pending)}>
                  Create the bundle and upload
                </Button>
              </div>
            )}
          </DropArea>
          <div className="row">
            <Button variant="ghost" disabled={!name.trim() || busy} loading={busy} onClick={() => void start([])}>
              Create an empty bundle
            </Button>
          </div>
          <p className="small muted">
            Very large files, or a folder you would rather copy: put them in the import folder {name.trim() ? importFolderHint(name) : 'inbox\\intake\\<bundle name>\\'} and they become a bundle on their own.
          </p>
          <ApiErrorNotice error={error} what="create the bundle" />
          <Link to="/intake" className="small">
            Back to the bundles
          </Link>
        </div>
      </Card>
    </div>
  );
}

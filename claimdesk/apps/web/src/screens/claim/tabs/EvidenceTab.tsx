import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Evidence, EvidenceKind, GuidedShot } from '@ccguk/domain';
import { api, type EvidenceUploadFields } from '../../../api/client';
import { useInvalidateClaim } from '../../../api/hooks';
import { DEFAULT_LIMITS, getUploadLimits, planUpload, progressText, sizeText, uploadInChunks } from '../../../api/uploads';
import { Card } from '../../../components/Card';
import { Table, type Column } from '../../../components/Table';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { DateText } from '../../../components/DateText';
import { Checkbox, DateTimeInput, Field, Select, TextArea, TextInput } from '../../../components/Form';
import { EmptyState } from '../../../components/EmptyState';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { intakeApi } from '../../../api/intakeApi';
import type { ClaimView } from '../claimFile';
import { bytesLabel, emptyUploadForm, EVIDENCE_KIND_OPTIONS, evidenceKindLabel, exifSummary, filterEvidence, GUIDED_SHOT_LABEL, GUIDED_SHOT_OPTIONS, guessKind, isImage, sha256HexOf, shortHash, sortEvidence, uploadFieldsFrom, type EvidenceFilter, type UploadForm } from '../lib/evidence';

/**
 * Write-once evidence: grid or list, filters, upload with a progress bar. Files up to the chunk threshold go as one
 * multipart upload; bigger ones are sent in resumable parts (SUPREME-DESIGN §0.3). A Web Crypto SHA-256 is worked out
 * before upload for files up to 256 MiB; above that ClaimDesk's own hash is shown after the upload.
 */
export function EvidenceTab({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const [mode, setMode] = useState<'grid' | 'list'>('grid');
  const [filter, setFilter] = useState<EvidenceFilter>({});
  const [uploading, setUploading] = useState(false);
  const items = useMemo(() => sortEvidence(filterEvidence(view.evidence, filter)), [view.evidence, filter]);
  const guided = view.evidence.filter((e) => e.captureShot).length;

  const columns: Column<Evidence>[] = [
    { key: 'kind', header: 'Kind', render: (e) => <Badge tone="grey">{evidenceKindLabel(e.kind)}</Badge> },
    {
      key: 'file',
      header: 'File',
      className: 'wrap',
      render: (e) => (
        <div>
          <a href={api.evidenceFileUrl(e.id)} target="_blank" rel="noreferrer" className="strong">
            {e.filename}
          </a>
          <div className="xs muted">
            {e.mime} · {bytesLabel(e.bytes)}
            {e.description ? ` · ${e.description}` : ''}
          </div>
          {e.sourceUrl && (
            <a className="xs" href={e.sourceUrl} target="_blank" rel="noreferrer">
              {e.sourceUrl}
            </a>
          )}
        </div>
      )
    },
    { key: 'captured', header: 'Captured', render: (e) => <DateText value={e.capturedAt} time /> },
    { key: 'uploaded', header: 'Uploaded', render: (e) => <span><DateText value={e.uploadedAt} time /><div className="xs muted">{e.uploadedBy}</div></span> },
    { key: 'sha', header: 'SHA-256', render: (e) => <span className="hash" title={e.sha256}>{shortHash(e.sha256)}</span> },
    { key: 'exif', header: 'EXIF', className: 'wrap', render: (e) => <span className="xs">{exifSummary(e.exif) || <span className="muted">—</span>}</span> },
    { key: 'shot', header: 'Guided shot', render: (e) => (e.captureShot ? <Badge tone="blue">{GUIDED_SHOT_LABEL[e.captureShot]}</Badge> : <span className="muted">—</span>) }
  ];

  return (
    <div className="stack">
      <Card
        title="Evidence"
        flush
        actions={
          <>
            <Link className="btn btn-secondary btn-sm" to={`/capture/${claimId}`}>
              Guided capture
            </Link>
            <Button size="sm" variant="primary" onClick={() => setUploading(true)}>
              Upload
            </Button>
          </>
        }
      >
        <div className="row" style={{ padding: '10px 20px', borderBottom: '1px solid var(--line)' }}>
          <Select<EvidenceKind> label="Kind" value={filter.kind ?? ''} onChange={(v) => setFilter((f) => ({ ...f, kind: v }))} options={EVIDENCE_KIND_OPTIONS} placeholder="All kinds" />
          <TextInput label="Search" type="search" value={filter.q ?? ''} onChange={(v) => setFilter((f) => ({ ...f, q: v }))} placeholder="Filename, description or hash" />
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <Checkbox label={`Guided-capture shots only (${guided})`} checked={Boolean(filter.guidedOnly)} onChange={(v) => setFilter((f) => ({ ...f, guidedOnly: v }))} />
          </div>
          <div className="field" style={{ justifyContent: 'flex-end', marginLeft: 'auto' }}>
            <div className="yesno" role="group" aria-label="View">
              <button type="button" aria-pressed={mode === 'grid'} onClick={() => setMode('grid')}>
                Grid
              </button>
              <button type="button" aria-pressed={mode === 'list'} onClick={() => setMode('list')}>
                List
              </button>
            </div>
          </div>
        </div>
        {items.length === 0 ? (
          <EmptyState title={view.evidence.length ? 'Nothing matches the filters' : 'No evidence on the file yet'} action={<Link className="btn btn-primary btn-sm" to={`/capture/${claimId}`}>Start guided capture</Link>}>
            {view.evidence.length ? '' : 'Photos, documents, adverts, bank statements and call recordings. Every file is hashed and stored write-once.'}
          </EmptyState>
        ) : mode === 'grid' ? (
          <div className="evidence-grid">
            {items.map((e) => (
              <EvidenceCard key={e.id} e={e} />
            ))}
          </div>
        ) : (
          <Table columns={columns} rows={items} rowKey={(e) => e.id} caption="Evidence" />
        )}
        <div className="card-footer xs muted">Evidence is never edited or deleted. A wrong file is superseded by uploading the right one and noting it on the chronology.</div>
      </Card>
      {uploading && <UploadDialog claimId={claimId} onClose={() => setUploading(false)} />}
    </div>
  );
}

function EvidenceCard({ e }: { e: Evidence }) {
  const url = api.evidenceFileUrl(e.id);
  return (
    <div className="evidence-card">
      <a className="evidence-thumb" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${e.filename}`}>
        {isImage(e.mime) ? <img src={url} alt={e.description ?? e.filename} loading="lazy" /> : <span>{e.mime.split('/')[1] ?? e.kind}</span>}
      </a>
      <div className="evidence-meta">
        <div className="row" style={{ gap: 6 }}>
          <Badge tone="grey">{evidenceKindLabel(e.kind)}</Badge>
          {e.captureShot && <Badge tone="blue">{GUIDED_SHOT_LABEL[e.captureShot]}</Badge>}
        </div>
        <div className="name">{e.filename}</div>
        {e.description && <div>{e.description}</div>}
        <div className="muted">
          {e.capturedAt ? (
            <>
              captured <DateText value={e.capturedAt} time /> ·{' '}
            </>
          ) : null}
          uploaded <DateText value={e.uploadedAt} time />
        </div>
        <div className="muted">
          <span className="hash" title={e.sha256}>
            {shortHash(e.sha256)}
          </span>{' '}
          · {bytesLabel(e.bytes)}
        </div>
        {exifSummary(e.exif) && <div className="muted">{exifSummary(e.exif)}</div>}
        {e.sourceUrl && (
          <a href={e.sourceUrl} target="_blank" rel="noreferrer">
            source
          </a>
        )}
      </div>
    </div>
  );
}

function UploadDialog({ claimId, onClose }: { claimId: string; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState<UploadForm>(emptyUploadForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hashing, setHashing] = useState(false);
  const [hash, setHash] = useState<string | undefined>();
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  // §G.1: "also read this file" — the agents read the stored file and propose details for the claim (Intake).
  const [alsoRead, setAlsoRead] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pickId = useRef(0);
  const limitsQuery = useQuery({ queryKey: ['upload-limits'], queryFn: ({ signal }) => getUploadLimits(signal), staleTime: 5 * 60_000 });
  const limits = limitsQuery.data ?? DEFAULT_LIMITS;
  const plan = file ? planUpload(file.size, limits) : undefined;
  const invalidate = useInvalidateClaim();
  const toast = useToast();

  const upload = useMutation({
    mutationFn: async ({ file: f, fields }: { file: File; fields: EvidenceUploadFields }) => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const onProgress = (sent: number, total: number) => setProgress({ sent, total });
      setProgress({ sent: 0, total: f.size });
      if (planUpload(f.size, limits).mode === 'chunked') {
        const r = await uploadInChunks(f, { purpose: 'evidence', claimId, fields: { ...fields } as Record<string, string | undefined>, onProgress, signal: ctrl.signal });
        return r.evidence as Evidence;
      }
      return api.uploadEvidence(claimId, f, fields, onProgress, ctrl.signal);
    },
    onSuccess: () => invalidate(claimId),
    onSettled: () => {
      abortRef.current = null;
    }
  });

  const pick = async (f: File | null) => {
    const mine = ++pickId.current;
    setFile(f);
    setHash(undefined);
    setProgress(null);
    upload.reset();
    if (!f) return;
    setForm((prev) => ({ ...prev, kind: prev.kind || guessKind(f), capturedAt: prev.capturedAt || (f.lastModified ? new Date(f.lastModified).toISOString() : '') }));
    const p = planUpload(f.size, limits);
    // Above 256 MiB the browser does not read the whole file to hash it: ClaimDesk's own hash is shown after upload.
    if (!p.deviceHash || p.mode === 'too-large') return;
    try {
      setHashing(true);
      const h = await sha256HexOf(await f.arrayBuffer());
      if (pickId.current === mine) setHash(h);
    } catch {
      if (pickId.current === mine) setHash(undefined);
    } finally {
      if (pickId.current === mine) setHashing(false);
    }
  };

  const submit = () => {
    const r = uploadFieldsFrom(form, file, hash);
    if (!r.ok) return setErrors(r.errors);
    if (plan?.mode === 'too-large') return setErrors({ file: plan.message });
    setErrors({});
    upload.mutate(
      { file: file as File, fields: r.body },
      {
        onSuccess: (ev) => {
          toast.success(`Stored ${ev.filename} · SHA-256 ${shortHash(ev.sha256)}${hash ? '' : ' (worked out by ClaimDesk)'}`);
          if (alsoRead) {
            intakeApi
              .fromEvidence(ev.id, claimId)
              .then(() => toast.success(`${ev.filename} is queued for reading — see Intake`))
              .catch((e: unknown) => toast.error(`Stored, but it could not be queued for reading: ${e instanceof Error ? e.message : String(e)}`));
          }
          onClose();
        }
      }
    );
  };

  const cancel = () => {
    if (upload.isPending) abortRef.current?.abort();
    onClose();
  };

  const fileHint = !file
    ? `One file per upload. Photos keep their EXIF. Bigger files are sent in parts; anything over ${sizeText(limits.maxEvidenceBytes)} goes in the import folder (Settings → Import folder).`
    : [plan && plan.mode !== 'too-large' ? plan.message : '', hash ? `SHA-256 ${shortHash(hash, 16)} worked out on this computer; ClaimDesk refuses the upload if the bytes differ.` : hashing ? 'Working out the SHA-256 fingerprint…' : '']
        .filter(Boolean)
        .join(' ');
  const pct = progress && progress.total > 0 ? Math.min(100, Math.floor((progress.sent / progress.total) * 100)) : 0;

  return (
    <Modal
      open
      title="Upload evidence"
      onClose={cancel}
      footer={
        <>
          <Button onClick={cancel}>{upload.isPending ? 'Stop upload' : 'Cancel'}</Button>
          <Button variant="primary" loading={upload.isPending || hashing} onClick={submit} disabled={!file || plan?.mode === 'too-large'}>
            Upload
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="File" required error={errors.file ?? (plan?.mode === 'too-large' ? plan.message : undefined)} hint={fileHint}>
          <input ref={inputRef} className="input" type="file" disabled={upload.isPending} onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
        </Field>
        {progress && (upload.isPending || upload.isSuccess) && (
          <div className="stack-sm" aria-live="polite">
            <div role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} style={{ height: 8, background: 'var(--neutral-bg)', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--green)', transition: 'width 0.2s ease' }} />
            </div>
            <div className="xs muted">
              {progressText(progress.sent, progress.total)}
              {plan?.mode === 'chunked' ? ' · sent in parts; a dropped connection carries on where it stopped' : ''}
              {pct >= 100 && upload.isPending ? ' · checking and storing…' : ''}
            </div>
          </div>
        )}
        <div className="form-grid">
          <Select<EvidenceKind> label="Kind" required value={form.kind} onChange={(v) => setForm((f) => ({ ...f, kind: v }))} options={EVIDENCE_KIND_OPTIONS} placeholder="What is it?" error={errors.kind} />
          <DateTimeInput label="Captured / dated" value={form.capturedAt} onChange={(v) => setForm((f) => ({ ...f, capturedAt: v }))} hint="EXIF time wins where present" />
          <Select<GuidedShot> label="Guided-shot tag" value={form.captureShot} onChange={(v) => setForm((f) => ({ ...f, captureShot: v }))} options={GUIDED_SHOT_OPTIONS} placeholder="— (not a guided shot)" />
          <TextInput label="Source URL" type="url" value={form.sourceUrl} onChange={(v) => setForm((f) => ({ ...f, sourceUrl: v }))} error={errors.sourceUrl} placeholder="Required for comparable adverts" />
        </div>
        <TextArea label="Description" value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v }))} rows={2} placeholder="What it shows and why it matters (e.g. odometer at delivery, 41,212 miles)" />
        <Checkbox label="Also read this file" checked={alsoRead} onChange={setAlsoRead} disabled={upload.isPending} hint="The agents read it and propose details for this claim; you confirm anything they are not sure of (Intake)." />
        {!(upload.error instanceof DOMException && upload.error.name === 'AbortError') && <ApiErrorNotice error={upload.error} what="upload the file" />}
      </form>
    </Modal>
  );
}

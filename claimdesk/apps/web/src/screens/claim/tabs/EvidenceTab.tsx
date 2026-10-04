import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Evidence, EvidenceKind, GuidedShot } from '@ccguk/domain';
import { api } from '../../../api/client';
import { useUploadEvidence } from '../../../api/hooks';
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
import type { ClaimView } from '../claimFile';
import { bytesLabel, emptyUploadForm, EVIDENCE_KIND_OPTIONS, evidenceKindLabel, exifSummary, filterEvidence, GUIDED_SHOT_LABEL, GUIDED_SHOT_OPTIONS, guessKind, isImage, sha256HexOf, shortHash, sortEvidence, uploadFieldsFrom, type EvidenceFilter, type UploadForm } from '../lib/evidence';

/** Write-once evidence: grid or list, filters, multipart upload with a Web Crypto SHA-256 computed before upload. */
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
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadEvidence(claimId);
  const toast = useToast();

  const pick = async (f: File | null) => {
    setFile(f);
    setHash(undefined);
    if (!f) return;
    setForm((prev) => ({ ...prev, kind: prev.kind || guessKind(f), capturedAt: prev.capturedAt || (f.lastModified ? new Date(f.lastModified).toISOString() : '') }));
    try {
      setHashing(true);
      setHash(await sha256HexOf(await f.arrayBuffer()));
    } catch {
      setHash(undefined);
    } finally {
      setHashing(false);
    }
  };

  const submit = () => {
    const r = uploadFieldsFrom(form, file, hash);
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    upload.mutate(
      { file: file as File, fields: r.body },
      {
        onSuccess: (ev) => {
          toast.success(`Stored ${ev.filename} · ${shortHash(ev.sha256)}`);
          onClose();
        }
      }
    );
  };

  return (
    <Modal
      open
      title="Upload evidence"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={upload.isPending || hashing} onClick={submit} disabled={!file}>
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
        <Field label="File" required error={errors.file} hint={hash ? `SHA-256 ${shortHash(hash, 16)} computed on this device; the API refuses the upload if the bytes differ.` : hashing ? 'Hashing…' : 'One file per upload. Photos keep their EXIF.'}>
          <input ref={inputRef} className="input" type="file" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
        </Field>
        <div className="form-grid">
          <Select<EvidenceKind> label="Kind" required value={form.kind} onChange={(v) => setForm((f) => ({ ...f, kind: v }))} options={EVIDENCE_KIND_OPTIONS} placeholder="What is it?" error={errors.kind} />
          <DateTimeInput label="Captured / dated" value={form.capturedAt} onChange={(v) => setForm((f) => ({ ...f, capturedAt: v }))} hint="EXIF time wins where present" />
          <Select<GuidedShot> label="Guided-shot tag" value={form.captureShot} onChange={(v) => setForm((f) => ({ ...f, captureShot: v }))} options={GUIDED_SHOT_OPTIONS} placeholder="— (not a guided shot)" />
          <TextInput label="Source URL" type="url" value={form.sourceUrl} onChange={(v) => setForm((f) => ({ ...f, sourceUrl: v }))} error={errors.sourceUrl} placeholder="Required for comparable adverts" />
        </div>
        <TextArea label="Description" value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v }))} rows={2} placeholder="What it shows and why it matters (e.g. odometer at delivery, 41,212 miles)" />
        <ApiErrorNotice error={upload.error} what="upload the file" />
      </form>
    </Modal>
  );
}

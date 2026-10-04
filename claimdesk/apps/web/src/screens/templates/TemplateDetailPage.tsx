import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import '../../styles/screens.css';
import './templates.css';
import { useClaims } from '../../api/hooks';
import {
  saveBlob,
  templatesApi,
  useAcknowledgeDocxTemplate,
  useDocxTemplate,
  usePatchDocxTemplate,
  useReplaceDocxTemplateFile,
  useTestFillDocxTemplate,
  type DocxTemplateDetail
} from '../../api/templatesApi';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox, Select, TextArea, TextInput } from '../../components/Form';
import { DateText } from '../../components/DateText';
import { EmptyState } from '../../components/EmptyState';
import { Loading } from '../../components/Spinner';
import { Modal } from '../../components/Modal';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { useToast } from '../../components/Toast';
import { MappingTable } from './MappingTable';
import { formatBytes, MAX_TEMPLATE_BYTES, RECIPIENT_ROLE_OPTIONS, shortSha, sourceBadge, templateKindName, templateStatusBadge, warningCodeLabel } from './templates';

/** Settings → Document templates → one template: details, wording warnings, test copy and the mapping editor. */
export function TemplateDetailPage() {
  const { id } = useParams();
  const q = useDocxTemplate(id);
  const detail = q.data;

  if (!id) return <EmptyState title="No template selected" />;
  return (
    <div className="page">
      <PageHeader
        title={detail?.title ?? 'Document template'}
        crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Document templates', to: '/settings/templates' }, { label: detail?.title ?? id }]}
        subtitle={
          detail ? (
            <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span>{templateKindName(detail.kind)}</span>
              <span>· version {detail.fileVersion}</span>
              <span className="mono xs" title={detail.sha256}>
                · sha256 {shortSha(detail.sha256)}
              </span>
              <span className="xs">· {formatBytes(detail.bytes)}</span>
              <Badge tone={sourceBadge(detail.source).tone}>{sourceBadge(detail.source).label}</Badge>
              <Badge tone={templateStatusBadge(detail).tone} title={templateStatusBadge(detail).title}>
                {templateStatusBadge(detail).label}
              </Badge>
            </span>
          ) : undefined
        }
        actions={detail ? <HeaderActions detail={detail} /> : undefined}
      />
      <div className="stack">
        <ApiErrorNotice error={q.error} what="load the template" />
        {q.isLoading && <Loading label="Loading the template…" />}
        {!q.isLoading && !detail && !q.error && (
          <EmptyState title="Template not found" action={<Link className="btn btn-secondary btn-sm" to="/settings/templates">Back to the templates</Link>} />
        )}
        {detail && (
          <>
            <WarningsCard detail={detail} />
            <DetailsCard detail={detail} />
            <MappingTable detail={detail} />
          </>
        )}
      </div>
    </div>
  );
}

function HeaderActions({ detail }: { detail: DocxTemplateDetail }) {
  const [testing, setTesting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const replace = useReplaceDocxTemplateFile(detail.id);
  const toast = useToast();
  return (
    <>
      <a className="btn btn-secondary" href={templatesApi.docxTemplateFileUrl(detail.id)} download>
        Download original
      </a>
      {detail.source === 'uploaded' && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".docx,.dotx"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              if (!/\.(docx|dotx)$/i.test(f.name)) return toast.error('Only Word .docx or .dotx files can be used as templates');
              if (f.size > MAX_TEMPLATE_BYTES) return toast.error('The file is larger than 15 MB');
              replace.mutate(
                { file: f, fileName: f.name },
                {
                  onSuccess: (d) => {
                    const dropped = d.dropped?.length ?? 0;
                    if (dropped > 0) toast.warn(`Version ${d.fileVersion} uploaded — ${dropped} mapped blank${dropped === 1 ? ' is' : 's are'} no longer in the file`);
                    else toast.success(`Version ${d.fileVersion} uploaded — the mapping was carried over`);
                  },
                  onError: (err) => toast.error(err instanceof Error ? err.message : 'Upload failed')
                }
              );
            }}
          />
          <Button loading={replace.isPending} onClick={() => fileRef.current?.click()}>
            Upload new version
          </Button>
        </>
      )}
      <Button variant="primary" onClick={() => setTesting(true)}>
        Download a test copy
      </Button>
      {testing && <TestCopyDialog detail={detail} onClose={() => setTesting(false)} />}
    </>
  );
}

const SAMPLE = '__sample';

function TestCopyDialog({ detail, onClose }: { detail: DocxTemplateDetail; onClose: () => void }) {
  const claims = useClaims({ limit: 25 });
  const [claimId, setClaimId] = useState<string>(SAMPLE);
  const [variant, setVariant] = useState<string>(() => (detail.variants.find((v) => v.default) ?? detail.variants[0])?.id ?? '');
  const testFill = useTestFillDocxTemplate(detail.id);
  const toast = useToast();
  const options = [{ value: SAMPLE, label: 'Sample data (claim CCG-2026-00012, not a real file)' }, ...(claims.data ?? []).slice(0, 25).map((c) => ({ value: c.id, label: `${c.reference}${c.claimantName ? ` — ${c.claimantName}` : ''}` }))];
  const run = () =>
    testFill.mutate(
      { claimId: claimId === SAMPLE ? undefined : claimId, variant: variant || undefined },
      {
        onSuccess: ({ blob, fileName }) => {
          saveBlob(blob, fileName ?? `${detail.title} (test copy).docx`);
          toast.success('Test copy downloaded — it is not stored on any claim');
          onClose();
        }
      }
    );
  return (
    <Modal
      open
      title="Download a test copy"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={testFill.isPending} onClick={run}>
            Download
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          Fills the template with a claim's values (or sample data) so you can check the result in Word. Nothing is saved to the claim.
        </p>
        <Select label="Fill from" value={claimId} onChange={(v) => setClaimId(v || SAMPLE)} options={options} />
        {detail.variants.length > 0 && <Select label="Version" value={variant} onChange={(v) => setVariant(v)} options={detail.variants.map((v) => ({ value: v.id, label: v.label }))} />}
        <ApiErrorNotice error={claims.error} what="load recent claims" />
        <ApiErrorNotice error={testFill.error} what="make the test copy" />
      </div>
    </Modal>
  );
}

function WarningsCard({ detail }: { detail: DocxTemplateDetail }) {
  const ack = useAcknowledgeDocxTemplate(detail.id);
  const toast = useToast();
  if (detail.warnings.length === 0) return null;
  return (
    <Card
      title="Wording to review"
      flush
      actions={
        detail.warningsAcknowledged ? (
          <Badge tone="green">Reviewed</Badge>
        ) : (
          <Button size="sm" variant="primary" loading={ack.isPending} onClick={() => ack.mutate(undefined, { onSuccess: () => toast.success('Recorded as reviewed — documents can now be made from this template') })}>
            I have reviewed this wording
          </Button>
        )
      }
    >
      {!detail.warningsAcknowledged && (
        <div className="notice notice-warn small" style={{ margin: 12 }}>
          Documents cannot be made from this template until someone reviews the wording below. Your name and the time are recorded with the review.
        </div>
      )}
      {detail.warnings.map((w, i) => (
        <div key={`${w.code}-${i}`} className="tpl-warning">
          <div className="row" style={{ gap: 6 }}>
            <Badge tone={detail.warningsAcknowledged ? 'grey' : 'amber'}>{warningCodeLabel(w.code)}</Badge>
            <span>{w.message}</span>
          </div>
          {w.excerpt && <div className="excerpt">“{w.excerpt}”</div>}
        </div>
      ))}
      <div style={{ padding: '0 12px' }}>
        <ApiErrorNotice error={ack.error} what="record the review" />
      </div>
    </Card>
  );
}

function DetailsCard({ detail }: { detail: DocxTemplateDetail }) {
  const patch = usePatchDocxTemplate(detail.id);
  const toast = useToast();
  const [form, setForm] = useState({ title: detail.title, description: detail.description ?? '', recipientRole: detail.recipientRole ?? '', active: detail.active });
  useEffect(() => {
    setForm({ title: detail.title, description: detail.description ?? '', recipientRole: detail.recipientRole ?? '', active: detail.active });
  }, [detail.id, detail.title, detail.description, detail.recipientRole, detail.active]);
  const dirty = form.title !== detail.title || form.description !== (detail.description ?? '') || form.recipientRole !== (detail.recipientRole ?? '') || form.active !== detail.active;
  const save = () => {
    if (!form.title.trim()) return toast.error('The title cannot be empty');
    patch.mutate(
      {
        title: form.title.trim(),
        // send the description only when it changed, so an empty box clears it
        description: form.description !== (detail.description ?? '') ? form.description.trim() : undefined,
        recipientRole: form.recipientRole || null,
        active: form.active
      },
      { onSuccess: () => toast.success('Template details saved') }
    );
  };
  return (
    <Card
      title="Details"
      actions={
        <Button size="sm" variant="primary" disabled={!dirty} loading={patch.isPending} onClick={save}>
          Save details
        </Button>
      }
    >
      <div className="form-grid">
        <TextInput label="Title" required value={form.title} onChange={(v) => setForm((f) => ({ ...f, title: v }))} maxLength={200} />
        <Select label="Usual recipient" value={form.recipientRole} onChange={(v) => setForm((f) => ({ ...f, recipientRole: v }))} options={RECIPIENT_ROLE_OPTIONS} placeholder="— none —" />
      </div>
      <TextArea label="Description" value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v }))} rows={2} />
      <Checkbox label="Offer this template when filling documents on a claim" checked={form.active} onChange={(v) => setForm((f) => ({ ...f, active: v }))} />
      <div className="xs muted" style={{ marginTop: 8 }}>
        File <span className="mono">{detail.fileName}</span> · {detail.slotCount} blanks · mapping revision {detail.mappingRevision} · updated <DateText value={detail.updatedAt} time />
        {detail.variants.length > 0 && <> · versions: {detail.variants.map((v) => v.label).join(', ')}</>}
      </div>
      <ApiErrorNotice error={patch.error} what="save the details" />
    </Card>
  );
}

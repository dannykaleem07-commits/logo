import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GeneratedDocument } from '@ccguk/domain';
import type { TemplateMeta } from '../../../api/client';
import { useCreateDocument, useTemplates } from '../../../api/hooks';
import { Card } from '../../../components/Card';
import { Table, type Column } from '../../../components/Table';
import { Badge, DocumentStatusBadge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { DateText } from '../../../components/DateText';
import { DateInput, Select, TextInput } from '../../../components/Form';
import { EmptyState } from '../../../components/EmptyState';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import type { ClaimView } from '../claimFile';
import { GroupedSelect } from '../components/GroupedSelect';
import { shortHash } from '../lib/evidence';
import { extraDataBody, extraDataFields, flagCounts, groupTemplates, isDocx, sortDocuments } from '../lib/documents';
import { FillTemplateDialog } from './FillTemplateDialog';

/** Generated documents: draft → consistency check → approve (human) → send. Nothing leaves without a person. */
export function DocumentsTab({ view }: { view: ClaimView }) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [filling, setFilling] = useState(false);
  const docs = useMemo(() => sortDocuments(view.documents), [view.documents]);
  const open = (d: GeneratedDocument) => navigate(`/claims/${view.claim.id}/documents/${d.id}`);

  const columns: Column<GeneratedDocument>[] = [
    {
      key: 'title',
      header: 'Document',
      className: 'wrap',
      render: (d) => (
        <div>
          <div className="row" style={{ gap: 6 }}>
            <span className="strong">{d.title}</span>
            {isDocx(d) && (
              <Badge tone="blue" title="Made from a Word template; the PDF is made when it is approved">
                Word
              </Badge>
            )}
          </div>
          <div className="xs muted mono">
            {d.templateId} v{d.templateVersion}
            {d.supersedesId ? ' · re-executed' : ''}
          </div>
        </div>
      )
    },
    { key: 'status', header: 'Status', render: (d) => <DocumentStatusBadge status={d.status} /> },
    { key: 'created', header: 'Created', render: (d) => <span><DateText value={d.createdAt} time /><div className="xs muted">{d.createdBy}</div></span> },
    { key: 'approved', header: 'Approved', render: (d) => (d.approvedAt ? <span><DateText value={d.approvedAt} time /><div className="xs muted">{d.approvedBy}</div></span> : <span className="muted">—</span>) },
    { key: 'sent', header: 'Sent', render: (d) => (d.sentAt ? <span><DateText value={d.sentAt} time />{d.sentVia && <div className="xs muted">via {d.sentVia}</div>}</span> : <span className="muted">—</span>) },
    { key: 'hash', header: 'Hash', render: (d) => <span className="hash" title={d.sha256}>{shortHash(d.sha256)}</span> },
    {
      key: 'flags',
      header: 'Consistency',
      render: (d) => {
        const c = flagCounts(d.consistency);
        if (!d.consistency) return <span className="muted xs">not checked</span>;
        return (
          <span className="row" style={{ gap: 4 }}>
            {c.blocking > 0 && <Badge tone="red" dot>{c.blocking} block</Badge>}
            {c.warn > 0 && <Badge tone="amber">{c.warn} warn</Badge>}
            {c.info > 0 && <Badge tone="blue">{c.info} info</Badge>}
            {c.cleared > 0 && <Badge tone="grey">{c.cleared} cleared</Badge>}
            {c.total === 0 && <Badge tone="green">clean</Badge>}
          </span>
        );
      }
    },
    { key: 'sig', header: 'Signed', render: (d) => (d.signature ? <span className="xs">{d.signature.signerName} · <DateText value={d.signature.signedAt} time /></span> : <span className="muted">—</span>) }
  ];

  return (
    <div className="stack">
      <Card
        title="Documents"
        flush
        actions={
          <>
            <Button size="sm" variant="primary" onClick={() => setFilling(true)}>
              Fill a CCGUK template
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              New document
            </Button>
          </>
        }
      >
        <Table columns={columns} rows={docs} rowKey={(d) => d.id} onRowClick={open} caption="Documents" empty={<EmptyState title="No documents yet" action={<Button size="sm" variant="primary" onClick={() => setCreating(true)}>Draft the first document</Button>}>Letters, invoices, forms and reports render from the ledger, events, offers and clocks — never from retyped figures.</EmptyState>} />
        <div className="card-footer xs muted">Draft → consistency check → approved by a person → sent. A block flag stops approval until someone clears it with a reason, and the reason is logged.</div>
      </Card>
      {creating && <NewDocumentDialog view={view} onClose={() => setCreating(false)} />}
      {filling && <FillTemplateDialog view={view} onClose={() => setFilling(false)} />}
    </div>
  );
}

export function NewDocumentDialog({ view, onClose, initialTemplateId, extraData }: { view: ClaimView; onClose: () => void; initialTemplateId?: string; extraData?: Record<string, unknown> }) {
  const templatesQ = useTemplates();
  const [templateId, setTemplateId] = useState(initialTemplateId ?? '');
  const [recipientPartyId, setRecipientPartyId] = useState(view.atFaultInsurer?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const create = useCreateDocument(view.claim.id);
  const navigate = useNavigate();
  const toast = useToast();
  const templates = templatesQ.data ?? [];
  const groups = useMemo(() => groupTemplates(templates).map((g) => ({ label: g.label, options: g.templates.map((t) => ({ value: t.id, label: t.title })) })), [templates]);
  const template: TemplateMeta | undefined = templates.find((t) => t.id === templateId);
  const fields = template ? extraDataFields(template.requiredData) : [];
  const extras = fields.filter((f) => f.kind !== 'supplied');
  const supplied = fields.filter((f) => f.kind === 'supplied');
  const parties = [view.atFaultInsurer, view.claimant, view.driver, ...view.thirdParties].filter((p): p is NonNullable<typeof p> => Boolean(p));

  const submit = () => {
    if (!templateId) return;
    const data = { ...(extraDataBody(fields, values) ?? {}), ...(extraData ?? {}) };
    create.mutate(
      { templateId, data: Object.keys(data).length ? data : undefined, recipientPartyId: recipientPartyId || undefined },
      {
        onSuccess: (doc) => {
          const c = flagCounts(doc.consistency);
          if (c.blocking > 0) toast.warn(`${doc.title} drafted with ${c.blocking} block flag${c.blocking === 1 ? '' : 's'} — clear each with a reason before approval`);
          else toast.success(`${doc.title} drafted`);
          onClose();
          navigate(`/claims/${view.claim.id}/documents/${doc.id}`);
        }
      }
    );
  };

  return (
    <Modal
      open
      size="lg"
      title="New document"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!templateId} onClick={submit}>
            Create draft
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
        <ApiErrorNotice error={templatesQ.error} what="load the templates" />
        {templatesQ.isLoading ? (
          <Loading label="Loading templates…" />
        ) : (
          <GroupedSelect label="Template" required value={templateId} onChange={(v) => { setTemplateId(v); setValues({}); }} groups={groups} placeholder="Choose a template…" autoFocus />
        )}
        {template && (
          <div className="notice notice-info small">
            <strong>{template.title}</strong> <span className="mono xs">v{template.version}</span>
            {template.description ? <div>{template.description}</div> : null}
            {template.recipientRole ? <div className="xs">Recipient role: {template.recipientRole.replace(/_/g, ' ')}</div> : null}
          </div>
        )}
        <Select label="Recipient" value={recipientPartyId} onChange={setRecipientPartyId} options={parties.map((p) => ({ value: p.id, label: `${p.name}${p.roles.length ? ` (${p.roles.join(', ')})` : ''}` }))} placeholder="— (template default)" />
        {extras.length > 0 && (
          <fieldset className="fieldset">
            <legend>Extra details this template asks for (optional)</legend>
            <div className="form-grid">
              {extras.map((f) =>
                f.kind === 'date' ? (
                  <DateInput key={f.key} label={f.label} value={values[f.key] ?? ''} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} hint={f.key} />
                ) : (
                  <TextInput key={f.key} label={f.label} value={values[f.key] ?? ''} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} hint={f.key} />
                )
              )}
            </div>
            <p className="xs muted" style={{ margin: '8px 0 0' }}>Leave blank to let the API fill it from the file. Amounts and dates the ledger knows cannot be typed here (convention 4).</p>
          </fieldset>
        )}
        {supplied.length > 0 && (
          <details>
            <summary className="xs muted" style={{ cursor: 'pointer' }}>
              {supplied.length} fields supplied from the file (ledger, events, offers, clocks, settings)
            </summary>
            <div className="xs mono" style={{ columns: 2, marginTop: 6 }}>
              {supplied.map((f) => (
                <div key={f.key}>{f.key}</div>
              ))}
            </div>
          </details>
        )}
        <ApiErrorNotice error={create.error} what="create the draft" />
      </form>
    </Modal>
  );
}

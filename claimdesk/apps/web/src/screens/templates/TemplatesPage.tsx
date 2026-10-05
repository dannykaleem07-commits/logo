import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../../styles/screens.css';
import './templates.css';
import { useDocxTemplates, useSetDocxTemplateActive, type DocxTemplateSummary } from '../../api/templatesApi';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Form';
import { DateText } from '../../components/DateText';
import { EmptyState } from '../../components/EmptyState';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Table, type Column } from '../../components/Table';
import { useToast } from '../../components/Toast';
import { ConvertersCard } from './ConvertersCard';
import { UploadTemplateModal } from './UploadTemplateModal';
import { mappedBadge, sortTemplates, sourceBadge, templateCounts, templateKindName, warningsBadge } from './templates';

/** Settings → Document templates: the Word template library (built-in CCGUK templates and uploads). */
export function TemplatesPage() {
  const q = useDocxTemplates();
  const setActive = useSetDocxTemplateActive();
  const [uploading, setUploading] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const list = sortTemplates(q.data ?? []);
  const counts = templateCounts(list);
  const open = (t: DocxTemplateSummary) => navigate(`/settings/templates/${encodeURIComponent(t.id)}`);

  const columns: Column<DocxTemplateSummary>[] = [
    {
      key: 'title',
      header: 'Title',
      className: 'wrap',
      render: (t) => (
        <div>
          <div className="strong">{t.title}</div>
          <div className="xs muted mono">{t.fileName}</div>
        </div>
      )
    },
    { key: 'kind', header: 'Kind', className: 'col-hide-phone', render: (t) => templateKindName(t.kind) },
    {
      key: 'source',
      header: 'Source',
      className: 'col-hide-phone',
      render: (t) => {
        const b = sourceBadge(t.source);
        return <Badge tone={b.tone}>{b.label}</Badge>;
      }
    },
    { key: 'version', header: 'Version', className: 'col-hide-phone', render: (t) => <span className="mono xs" title={`Mapping revision ${t.mappingRevision}`}>v{t.fileVersion}</span> },
    {
      key: 'mapped',
      header: 'Mapped',
      className: 'col-hide-phone',
      render: (t) => {
        const b = mappedBadge(t);
        return (
          <Badge tone={b.tone} title={b.title}>
            {b.label}
          </Badge>
        );
      }
    },
    {
      key: 'warnings',
      header: 'Warnings',
      render: (t) => {
        const b = warningsBadge(t);
        return b ? (
          <Badge tone={b.tone} title={b.title}>
            {b.label}
          </Badge>
        ) : (
          <span className="muted">—</span>
        );
      }
    },
    {
      key: 'active',
      header: 'Active',
      render: (t) => (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Checkbox
            label={<span className="sr-only">Offer {t.title} when filling a template</span>}
            checked={t.active}
            disabled={setActive.isPending}
            onChange={(active) =>
              setActive.mutate(
                { id: t.id, active },
                { onSuccess: () => toast.success(active ? `${t.title} is offered again` : `${t.title} is no longer offered`) }
              )
            }
          />
        </span>
      )
    },
    { key: 'updated', header: 'Updated', className: 'col-hide-phone', render: (t) => <DateText value={t.updatedAt} /> }
  ];

  return (
    <div className="page">
      <PageHeader
        title="Document templates"
        crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Document templates' }]}
        subtitle="Word templates filled from the claim file. Signature and date-signed boxes are always left blank, and printed wording is never changed."
        actions={
          <Button variant="primary" onClick={() => setUploading(true)}>
            Upload a Word template
          </Button>
        }
      />
      <div className="stack">
        <ApiErrorNotice error={q.error} what="load the document templates" />
        <ApiErrorNotice error={setActive.error} what="change the template" />
        <Card
          title="Library"
          flush
          actions={
            q.data ? (
              <span className="row" style={{ gap: 4 }}>
                <Badge tone="navy">{counts.builtin} built-in</Badge>
                <Badge tone="blue">{counts.uploaded} uploaded</Badge>
                {counts.needsReview > 0 && <Badge tone="amber">{counts.needsReview} need review</Badge>}
              </span>
            ) : undefined
          }
        >
          {q.isPending && !q.error ? (
            <Loading label="Loading the templates…" />
          ) : (
            <Table
              columns={columns}
              rows={list}
              rowKey={(t) => t.id}
              onRowClick={open}
              caption="Document templates"
              empty={
                <EmptyState title="No Word templates yet" action={<Button size="sm" variant="primary" onClick={() => setUploading(true)}>Upload a Word template</Button>}>
                  The CCGUK templates appear here once the API has loaded them.
                </EmptyState>
              }
            />
          )}
          <div className="card-footer xs muted">A template whose wording has warnings cannot be used until someone reviews it. Turning a template off hides it from the claim's Documents tab; documents already made from it are not affected.</div>
        </Card>
        <ConvertersCard />
      </div>
      {uploading && (
        <UploadTemplateModal
          onClose={() => setUploading(false)}
          onUploaded={(d) => {
            setUploading(false);
            navigate(`/settings/templates/${encodeURIComponent(d.id)}`);
          }}
        />
      )}
    </div>
  );
}

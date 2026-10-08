// owned by intake
/**
 * Intake (docs/SUPREME-DESIGN.md §L.8, §G): drop any file (> 64 MiB goes up in parts), see what the agents read —
 * document type, page preview, fields with confidence bars and the exact quotes — apply or reject what waits for you,
 * start a new claim from several documents ("Start a claim from these") or link a document to a claim ("Apply to
 * claim …"). Nothing about liability, money or the claim status is ever proposed.
 */
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { Select } from '../../components/Form';
import { useToast } from '../../components/Toast';
import { useClaims } from '../../api/hooks';
import { addIntakeFiles, IN_PROGRESS, useIntakeItem, useIntakeList, useIntakeMutations, type IntakeItemDetail, type IntakeItemRow, type Proposal } from '../../api/intakeApi';
import { sizeText } from '../../api/uploads';
import { canStartClaim, confidenceTone, evidenceFileUrl, fieldRows, FILTERS, filterItems, pct, previewKind, PROPOSAL_STATUS_LABEL, proposalNote, STATUS_LABEL, STATUS_TONE, type FieldRow, type IntakeFilter } from './intakeModel';
import './intake.css';

function ConfidenceBar({ value }: { value: number }) {
  const tone = confidenceTone(value);
  return (
    <span className="intake-conf" title={`Confidence ${pct(value)}`}>
      <span className="intake-conf-track">
        <span className={`intake-conf-bar intake-conf-${tone}`} style={{ width: pct(value) }} />
      </span>
      <span className="intake-conf-text">{pct(value)}</span>
    </span>
  );
}

function DropZone({ claimId, onAdded }: { claimId: string; onAdded: (ids: string[]) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const add = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const r = await addIntakeFiles(files, { ...(claimId ? { claimId } : {}), onProgress: (name, sent, total) => setProgress(`${name}: ${sizeText(sent)} of ${sizeText(total)}`) });
      if (r.items.length) toast.success(`${r.items.length} file${r.items.length === 1 ? '' : 's'} added — the agents are reading ${r.items.length === 1 ? 'it' : 'them'}.`);
      for (const msg of r.refused) toast.warn(msg);
      onAdded(r.items.map((i) => i.id));
    } catch (e) {
      toast.error(`Could not add the files: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    void add(Array.from(e.dataTransfer.files ?? []));
  };

  return (
    <div
      className={`intake-drop ${over ? 'over' : ''}`.trim()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      aria-busy={busy || undefined}
    >
      <div className="intake-drop-title">Drop files here</div>
      <div className="small">PDFs, photos, Word documents, emails (.eml). Large files upload in parts; very large ones go in the import folder.</div>
      <input ref={input} type="file" multiple hidden onChange={(e) => void add(Array.from(e.target.files ?? []))} aria-label="Choose files" />
      <Button variant="primary" onClick={() => input.current?.click()} loading={busy}>
        Choose files
      </Button>
      {progress && <div className="small intake-progress">{progress}</div>}
    </div>
  );
}

function Preview({ item, page }: { item: IntakeItemDetail; page: number | null }) {
  const kind = previewKind(item);
  if (!item.evidence) return null;
  if (kind === 'image') return <img className="intake-preview-img" src={evidenceFileUrl(item.evidence.id)} alt={item.evidence.filename} />;
  if (kind === 'pdf')
    return (
      <div>
        <iframe key={page ?? 0} className="intake-preview-pdf" title={`Preview of ${item.evidence.filename}`} src={evidenceFileUrl(item.evidence.id, page)} />
        {item.doc?.scanned && <div className="small">This PDF has no text layer (a scan): the agent read the pages as images.</div>}
      </div>
    );
  if (kind === 'text') {
    const text = item.pageTexts.join('\n\n');
    return <pre className="intake-preview-text">{text || '(no text)'}</pre>;
  }
  return <div className="small">{item.doc?.skipReason ?? 'No preview for this file.'}</div>;
}

function ProposalActions({ p, onApply, onReject, busy }: { p: Proposal; onApply: (p: Proposal) => void; onReject: (p: Proposal) => void; busy: boolean }) {
  if (p.status !== 'pending') return <span className="small">{proposalNote(p)}</span>;
  return (
    <span className="row intake-actions">
      <Button size="sm" variant="primary" onClick={() => onApply(p)} disabled={busy}>
        Apply
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onReject(p)} disabled={busy}>
        Reject
      </Button>
    </span>
  );
}

function FieldsTable({ rows, onPage, onApply, onReject, busy }: { rows: FieldRow[]; onPage: (n: number) => void; onApply: (p: Proposal) => void; onReject: (p: Proposal) => void; busy: boolean }) {
  if (!rows.length) return <div className="small">No fields were read from this document.</div>;
  return (
    <table className="table intake-fields">
      <thead>
        <tr>
          <th>Field</th>
          <th>Value</th>
          <th>Confidence</th>
          <th>Source</th>
          <th>On the claim</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              <div>{r.proposal?.label ?? r.name}</div>
              {r.proposal?.sensitive && <Badge tone="amber">Sensitive</Badge>}
            </td>
            <td>
              <div className="intake-value">{r.proposal?.proposedValue ?? r.value ?? '—'}</div>
              {r.proposal?.currentValue && <div className="small">On file: {r.proposal.currentValue}</div>}
            </td>
            <td>
              <ConfidenceBar value={r.confidence} />
            </td>
            <td>
              {r.page ? (
                <button type="button" className="link-button" onClick={() => onPage(r.page!)}>
                  page {r.page}
                </button>
              ) : null}
              {r.quote && <div className="small intake-quote">“{r.quote}”</div>}
            </td>
            <td>{r.proposal ? <ProposalActions p={r.proposal} onApply={onApply} onReject={onReject} busy={busy} /> : <span className="small">{r.target ? 'Already on file' : 'Not a claim field'}</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ItemDetail({ id, claims }: { id: string; claims: Array<{ value: string; label: string }> }) {
  const toast = useToast();
  const { data: item, isLoading, error } = useIntakeItem(id);
  const m = useIntakeMutations();
  const [page, setPage] = useState<number | null>(null);
  const [claimId, setClaimId] = useState('');
  const rows = useMemo(() => (item ? fieldRows(item) : []), [item]);
  if (isLoading) return <Card>Loading…</Card>;
  if (error || !item) return <Card>Could not load this item.</Card>;
  const busy = m.apply.isPending || m.reject.isPending;
  const pending = item.proposalList.filter((p) => p.status === 'pending');

  const apply = (ids: string[]) =>
    m.apply.mutate(
      { ids },
      {
        onSuccess: (r) => {
          const failed = r.results.filter((x) => !x.ok);
          if (failed.length) toast.warn(`${r.results.length - failed.length} applied; ${failed.length} not: ${failed.map((f) => f.error?.message).join('; ')}`);
          else toast.success(`${r.results.length} value${r.results.length === 1 ? '' : 's'} applied to the claim.`);
        },
        onError: (e) => toast.error((e as Error).message),
      },
    );
  const reject = (ids: string[]) => {
    const reason = window.prompt('Why is this wrong? (kept with the record)');
    if (!reason || reason.trim().length < 3) return;
    m.reject.mutate({ ids, reason: reason.trim() }, { onError: (e) => toast.error((e as Error).message) });
  };
  const latest = item.extractions[item.extractions.length - 1];

  return (
    <Card
      title={item.evidence?.filename ?? 'Document'}
      actions={
        <span className="row">
          <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
          {item.docTypeLabel && <Badge tone="navy">{item.docTypeLabel}{item.docTypeConfidence !== undefined ? ` · ${pct(item.docTypeConfidence)}` : ''}</Badge>}
        </span>
      }
    >
      <div className="intake-detail">
        <div className="intake-meta small">
          {item.claimId ? (
            <span>
              Claim <Link to={`/claims/${item.claimId}`}>{item.claimReference ?? item.claimId}</Link>
            </span>
          ) : (
            <span>No claim yet</span>
          )}
          {item.evidence && <span> · {sizeText(item.evidence.bytes)}</span>}
          {item.doc && !item.doc.extensionMatches && <span> · the file name says one type but the file is {item.doc.sniffed.toUpperCase()}</span>}
          {item.doc?.fingerprint && <span> · looks like the CCGUK form “{item.doc.fingerprint.title}”</span>}
          {item.error && <div className="notice notice-warn">{item.error}</div>}
        </div>
        {latest?.summary && <p>{latest.summary}</p>}
        {latest?.warnings.length ? (
          <div className="notice notice-warn">
            {latest.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        ) : null}
        {item.needsYou.length > 0 && (
          <div className="notice notice-info">
            {item.needsYou.map((n) => (
              <div key={n.id}>
                Waiting in <Link to={`/needs-you?item=${n.id}`}>Needs you</Link>: {n.title}
              </div>
            ))}
          </div>
        )}
        {item.doc?.newClaimDraftId && (
          <div className="notice notice-info">
            A new claim was prepared from this document. <Link to={`/claims/new?intakeDraft=${item.doc.newClaimDraftId}`}>Open it in the New claim form</Link>
          </div>
        )}

        <div className="intake-columns">
          <div className="intake-preview">
            <Preview item={item} page={page} />
          </div>
          <div>
            <FieldsTable rows={rows} onPage={setPage} onApply={(p) => apply([p.id])} onReject={(p) => reject([p.id])} busy={busy} />
            {pending.length > 1 && (
              <div className="row intake-actions">
                <Button variant="primary" onClick={() => apply(pending.map((p) => p.id))} disabled={busy}>
                  Apply all {pending.length}
                </Button>
                <Button variant="ghost" onClick={() => reject(pending.map((p) => p.id))} disabled={busy}>
                  Reject all
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="row intake-actions">
          <Select label="Apply to claim" value={claimId} onChange={(v) => setClaimId(v)} options={claims} placeholder="Choose a claim…" />
          <Button
            onClick={() =>
              claimId &&
              m.retry.mutate(
                { id: item.id, claimId },
                { onSuccess: () => toast.success('Linked — the fields will be compared with that claim.'), onError: (e) => toast.error((e as Error).message) },
              )
            }
            disabled={!claimId || claimId === item.claimId || m.retry.isPending}
          >
            Apply to claim
          </Button>
          {(item.status === 'failed' || item.status === 'skipped' || item.status === 'quota_wait') && (
            <Button onClick={() => m.retry.mutate({ id: item.id }, { onError: (e) => toast.error((e as Error).message) })} loading={m.retry.isPending}>
              Try again
            </Button>
          )}
        </div>
        {item.childItems.length > 0 && (
          <div className="small">
            Attachments read separately: {item.childItems.map((c) => c.evidence?.filename ?? c.id).join(', ')}
          </div>
        )}
        <div className="small">
          Proposals: {Object.entries(PROPOSAL_STATUS_LABEL)
            .map(([k, label]) => `${label} ${item.proposalList.filter((p) => p.status === k).length}`)
            .join(' · ')}
        </div>
      </div>
    </Card>
  );
}

function ItemList({ items, selected, onSelect, checked, onCheck }: { items: IntakeItemRow[]; selected: string | undefined; onSelect: (id: string) => void; checked: Set<string>; onCheck: (id: string, on: boolean) => void }) {
  if (!items.length) return <EmptyState title="Nothing here">Files you add, and files the agents take from email or the import folder, appear here.</EmptyState>;
  return (
    <ul className="intake-items">
      {items.map((i) => (
        <li key={i.id} className={`intake-item ${selected === i.id ? 'selected' : ''}`.trim()}>
          {canStartClaim(i) && <input type="checkbox" aria-label={`Use ${i.evidence?.filename ?? 'this file'} for a new claim`} checked={checked.has(i.id)} onChange={(e) => onCheck(i.id, e.target.checked)} />}
          <button type="button" className="intake-item-button" onClick={() => onSelect(i.id)}>
            <span className="intake-item-top">
              <span className="intake-item-title">{i.evidence?.filename ?? i.id}</span>
              <Badge tone={STATUS_TONE[i.status]}>{IN_PROGRESS.has(i.status) ? `${STATUS_LABEL[i.status]}…` : STATUS_LABEL[i.status]}</Badge>
            </span>
            <span className="small">
              {i.docTypeLabel ?? (i.sniffedType ? i.sniffedType.toUpperCase() : '—')}
              {i.claimReference ? ` · ${i.claimReference}` : ' · no claim'}
              {i.proposals.pending ? ` · ${i.proposals.pending} waiting` : ''}
              {i.source !== 'upload' ? ` · from ${i.source === 'email' ? 'email' : i.source === 'folder' ? 'the import folder' : i.source}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function IntakePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [filter, setFilter] = useState<IntakeFilter>('all');
  const [selected, setSelected] = useState<string | undefined>();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [claimForUpload, setClaimForUpload] = useState('');
  const list = useIntakeList();
  const claims = useClaims({ limit: 200 }, { retry: 1 });
  const m = useIntakeMutations();
  const claimOptions = useMemo(() => (claims.data ?? []).map((c) => ({ value: c.id, label: `${c.reference}${c.claimantName ? ` — ${c.claimantName}` : ''}` })), [claims.data]);
  const items = filterItems(list.data?.items ?? [], filter);

  const startClaim = () =>
    m.newClaimDraft.mutate([...checked], {
      onSuccess: (d) => navigate(`/claims/new?intakeDraft=${encodeURIComponent(d.id)}`),
      onError: (e) => toast.error(`Could not prepare the claim: ${(e as Error).message}`),
    });

  return (
    <div className="page">
      <PageHeader title="Intake" subtitle="Files read by the agents and the details they found" />
      <div className="intake-layout">
        <div>
          <Card>
            <Select label="Claim (optional)" value={claimForUpload} onChange={(v) => setClaimForUpload(v)} options={claimOptions} placeholder="No claim — read it first" />
            <DropZone
              claimId={claimForUpload}
              onAdded={(ids) => {
                void m.refresh();
                if (ids[0]) setSelected(ids[0]);
              }}
            />
          </Card>
          <Card
            title="Items"
            actions={
              <Button size="sm" variant="primary" disabled={!checked.size || m.newClaimDraft.isPending} onClick={startClaim}>
                Start a claim from these{checked.size ? ` (${checked.size})` : ''}
              </Button>
            }
          >
            <div className="intake-filters" role="tablist" aria-label="Filter">
              {FILTERS.map((f) => (
                <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`chip ${filter === f.id ? 'chip-on' : ''}`.trim()} onClick={() => setFilter(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>
            {list.isLoading ? (
              <div>Loading…</div>
            ) : (
              <ItemList
                items={items}
                selected={selected}
                onSelect={setSelected}
                checked={checked}
                onCheck={(id, on) =>
                  setChecked((s) => {
                    const n = new Set(s);
                    if (on) n.add(id);
                    else n.delete(id);
                    return n;
                  })
                }
              />
            )}
          </Card>
        </div>
        <div>{selected ? <ItemDetail id={selected} claims={claimOptions} /> : <Card><EmptyState title="Choose a file">Pick a file on the left to see what was read from it.</EmptyState></Card>}</div>
      </div>
    </div>
  );
}

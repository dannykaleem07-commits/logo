// owned by runtime
/**
 * Needs-you inbox (docs/SUPREME-DESIGN.md §L.2). Two panes: the list grouped Urgent / Today / Later with kind and
 * claim filters; the selected item with its claim link, summary, recommendation (confidence + "Based on" chips), the
 * prepared item (email preview, document link, field diff, offer analysis or a generic view) and the options:
 * Approve, Edit then approve (edits are saved as a correction), Reject (reason), Snooze. Keyboard: j/k move, a approve,
 * e edit, r reject. Deep link /needs-you/:id (Windows toasts open it).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { NeedsYouKind, NeedsYouOption } from '@ccguk/domain';
import { NEEDS_YOU_KINDS } from '@ccguk/domain';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { useToast } from '../../components/Toast';
import { useNeedsYouDetail, useNeedsYouList, useResolveNeedsYou, useSnoozeNeedsYou, type NeedsYouItem } from '../../api/needsYouApi';
import {
  confirmFieldEdits,
  payloadLink,
  documentRef,
  emailPreview,
  fieldDiff,
  groupNeedsYou,
  inboxKey,
  canEditThenApprove,
  cardWarnings,
  isTicked,
  initialEdits,
  KIND_LABEL,
  moveSelection,
  offerRows,
  optionForKey,
  optionsOf,
  orderedNeedsYou,
  rendererFor,
  SNOOZE_CHOICES,
} from './needsYou';
import './needsYou.css';

const PRIORITY_TONE = { urgent: 'red', high: 'amber', normal: 'blue', low: 'grey' } as const;

function when(iso: string | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function NeedsYouPage() {
  const { id: routeId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const [kind, setKind] = useState<NeedsYouKind | ''>('');
  const [claim, setClaim] = useState('');
  const list = useNeedsYouList({ status: 'open', kind, claimId: claim || undefined });
  const items = list.data?.items ?? [];
  const groups = useMemo(() => groupNeedsYou(items, new Date().toISOString()), [items]);
  const ordered = useMemo(() => orderedNeedsYou(groups), [groups]);
  const selectedId = routeId ?? ordered[0]?.id;
  const select = (id: string | undefined) => id && navigate(`/needs-you/${encodeURIComponent(id)}`, { replace: Boolean(routeId) });
  const [command, setCommand] = useState<{ key: 'approve' | 'edit' | 'reject'; n: number } | undefined>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = inboxKey(e);
      if (!k) return;
      if (k === 'next' || k === 'prev') {
        e.preventDefault();
        select(moveSelection(ordered.map((i) => i.id), selectedId, k === 'next' ? 1 : -1));
        return;
      }
      e.preventDefault();
      setCommand((c) => ({ key: k, n: (c?.n ?? 0) + 1 }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, selectedId]);

  const claims = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) if (i.claimId) m.set(i.claimId, i.claimReference ?? i.claimId);
    return [...m.entries()];
  }, [items]);

  return (
    <div className="page needs-you-page">
      <PageHeader title="Needs you" subtitle="Decisions and confirmations the agents prepared for you. Keys: j / k to move, a approve, e edit, r reject." />
      <div className="ny-layout">
        <section className="ny-list card" aria-label="Items needing you">
          <div className="ny-filters">
            <select className="select" aria-label="Filter by kind" value={kind} onChange={(e) => setKind(e.target.value as NeedsYouKind | '')}>
              <option value="">All kinds</option>
              {NEEDS_YOU_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <select className="select" aria-label="Filter by claim" value={claim} onChange={(e) => setClaim(e.target.value)}>
              <option value="">All claims</option>
              {claims.map(([id, ref]) => (
                <option key={id} value={id}>
                  {ref}
                </option>
              ))}
            </select>
          </div>
          {list.isLoading && <Loading />}
          {list.error && <ApiErrorNotice error={list.error} />}
          {!list.isLoading && !items.length && <EmptyState title="Nothing needs you">The agents will put anything that needs your decision here.</EmptyState>}
          {(['urgent', 'today', 'later'] as const).map((g) =>
            groups[g].length ? (
              <div key={g} className="ny-group">
                <h4 className="ny-group-title">
                  {g === 'urgent' ? 'Urgent' : g === 'today' ? 'Today' : 'Later'} <span className="muted">({groups[g].length})</span>
                </h4>
                <ul className="ny-items">
                  {groups[g].map((i) => (
                    <li key={i.id}>
                      <button type="button" className={`ny-item ${i.id === selectedId ? 'selected' : ''}`} onClick={() => select(i.id)} aria-current={i.id === selectedId ? 'true' : undefined}>
                        <span className="ny-item-top">
                          <Badge tone={PRIORITY_TONE[i.priority]}>{KIND_LABEL[i.kind] ?? i.kind}</Badge>
                          {i.claimReference && <span className="small muted">{i.claimReference}</span>}
                        </span>
                        <span className="ny-item-title">{i.title}</span>
                        <span className="small muted">{when(i.createdAt)}{i.dueAt ? ` · due ${when(i.dueAt)}` : ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </section>
        <section className="ny-detail" aria-label="Selected item">
          {selectedId ? (
            <NeedsYouDetailPane
              id={selectedId}
              command={command}
              onDone={() => {
                const ids = ordered.map((i) => i.id).filter((x) => x !== selectedId);
                const next = moveSelection(ids, undefined, 0);
                if (next) select(next);
                else navigate('/needs-you', { replace: true });
              }}
            />
          ) : (
            <Card>
              <EmptyState title="Select an item">Pick an item on the left to see what the agents prepared.</EmptyState>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}

function NeedsYouDetailPane({ id, command, onDone }: { id: string; command?: { key: 'approve' | 'edit' | 'reject'; n: number }; onDone: () => void }) {
  const detail = useNeedsYouDetail(id);
  const resolve = useResolveNeedsYou();
  const snooze = useSnoozeNeedsYou();
  const toast = useToast();
  const [editing, setEditing] = useState<NeedsYouOption | undefined>();
  const [rejecting, setRejecting] = useState<NeedsYouOption | undefined>();
  // "Add a note" for items that are not edited (questions, warnings, offers): the note goes with the chosen option.
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [editText, setEditText] = useState('');
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  // confirm_fields: which proposals the owner ticks (all by default)
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const item = detail.data?.item;

  useEffect(() => {
    setEditing(undefined);
    setRejecting(undefined);
    setNoting(false);
    setNote('');
    setTicked({});
  }, [id]);

  const startEdit = (o: NeedsYouOption) => {
    if (!item) return;
    if (!canEditThenApprove(item)) {
      // Nothing editable here (no raw JSON editor): add a note instead.
      setRejecting(undefined);
      setNoting(true);
      return;
    }
    const init = initialEdits(item);
    setEditText(init.text);
    setEditFields(init.fields ?? {});
    setRejecting(undefined);
    setEditing(o);
  };

  const submit = (o: NeedsYouOption, withEdits = false) => {
    if (!item) return;
    if (o.requiresReason && !note.trim()) {
      setRejecting(o);
      return;
    }
    let edits: unknown;
    // confirm_fields: the primary option applies only the ticked proposals (the resolver's {apply, values} shape)
    // (always the explicit list: some rows start unticked — personal details, low confidence, another vehicle)
    if (!withEdits && item.kind === 'confirm_fields' && o.tone === 'primary') edits = confirmFieldEdits(item.payload, ticked, {});
    if (withEdits) {
      const init = initialEdits(item);
      if (init.mode === 'email') edits = { bodyText: editText };
      else if (init.mode === 'fields') edits = item.kind === 'confirm_fields' ? confirmFieldEdits(item.payload, ticked, editFields) : { fields: editFields };
      else {
        try {
          edits = JSON.parse(editText);
        } catch {
          toast.error('The edits are not valid JSON.');
          return;
        }
      }
    }
    resolve.mutate(
      { id: item.id, body: { optionId: o.id, ...(edits !== undefined ? { edits } : {}), ...(note.trim() ? { note: note.trim() } : {}) } },
      {
        onSuccess: () => {
          toast.success(`${o.label} — done`);
          onDone();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  useEffect(() => {
    if (!command || !item) return;
    const o = optionForKey(item, command.key);
    if (!o) return;
    if (command.key === 'edit') startEdit(o);
    else if (command.key === 'reject') setRejecting(o);
    else submit(o);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command?.n]);

  if (detail.isLoading) return <Loading />;
  if (detail.error) return <ApiErrorNotice error={detail.error} />;
  if (!item) return null;
  const closed = item.status !== 'open' && item.status !== 'snoozed';
  const options = optionsOf(item);

  return (
    <Card
      title={item.title}
      actions={
        <>
          <Badge tone={PRIORITY_TONE[item.priority]}>{item.priority}</Badge>
          <Badge tone="grey">{KIND_LABEL[item.kind] ?? item.kind}</Badge>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          {item.claimId ? (
            <>
              Claim <Link to={`/claims/${encodeURIComponent(item.claimId)}`}>{item.claimReference ?? item.claimId}</Link> ·{' '}
            </>
          ) : null}
          raised by {item.createdBy.replace(/^agent:/, '')} · {when(item.createdAt)}
          {item.dueAt ? ` · due ${when(item.dueAt)}` : ''}
          {item.status === 'snoozed' && item.snoozedUntil ? ` · snoozed until ${when(item.snoozedUntil)}` : ''}
        </div>
        <p className="ny-summary">{item.summary}</p>
        {item.recommendation && (
          <div className="ny-recommendation">
            <div className="row-between">
              <strong>Recommendation: {item.recommendation.action}</strong>
              <span className="small">confidence {Math.round(item.recommendation.confidence * 100)} %</span>
            </div>
            <p>{item.recommendation.why}</p>
            {item.recommendation.dissent && <p className="small muted">Dissent: {item.recommendation.dissent}</p>}
            {item.recommendation.basis.length > 0 && (
              <div className="ny-chips" aria-label="Based on">
                <span className="small muted">Based on</span>
                {item.recommendation.basis.map((b) => (
                  <span key={`${b.kind}:${b.id}`} className="ny-chip" title={`${b.kind} ${b.id}`}>
                    {b.label ?? `${b.kind} ${b.id}`}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <PreparedItem item={item} {...(item.kind === 'confirm_fields' && !closed ? { ticked, onTick: (key: string, on: boolean) => setTicked((x) => ({ ...x, [key]: on })) } : {})} />
        {editing && (
          <div className="ny-editor">
            <h4>Edit then approve</h4>
            <p className="small muted">Your changes are kept as a correction so the agents learn from them.</p>
            {initialEdits(item).mode === 'fields' ? (
              <table className="table">
                <tbody>
                  {fieldDiff(item.payload).map((f) => (
                    <tr key={f.key}>
                      <th scope="row">{f.label}</th>
                      <td>
                        <input className="input" aria-label={f.label} value={editFields[f.key] ?? ''} onChange={(e) => setEditFields((x) => ({ ...x, [f.key]: e.target.value }))} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <textarea className="textarea ny-edit-text" aria-label="Edited text" value={editText} onChange={(e) => setEditText(e.target.value)} rows={12} />
            )}
            <div className="row">
              <Button variant="primary" loading={resolve.isPending} onClick={() => submit(editing, true)}>
                {editing.label}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(undefined)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {noting && !rejecting && !closed && (
          <div className="ny-editor">
            <label className="field-label" htmlFor="ny-note">
              Your note (kept with your answer)
            </label>
            <textarea id="ny-note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} rows={3} autoFocus />
            <div className="row">
              {options
                .filter((o) => !o.requiresEdit)
                .map((o) => (
                  <Button key={o.id} variant={o.tone === 'primary' ? 'primary' : o.tone === 'danger' ? 'danger' : 'secondary'} disabled={!note.trim()} loading={resolve.isPending && resolve.variables?.body.optionId === o.id} onClick={() => submit(o)}>
                    {o.label} with this note
                  </Button>
                ))}
              <Button variant="ghost" onClick={() => (setNoting(false), setNote(''))}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {rejecting && (
          <div className="ny-editor">
            <label className="field-label" htmlFor="ny-reason">
              Reason for “{rejecting.label}”
            </label>
            <textarea id="ny-reason" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} rows={3} autoFocus />
            <div className="row">
              <Button variant={rejecting.tone === 'danger' ? 'danger' : 'primary'} disabled={!note.trim()} loading={resolve.isPending} onClick={() => submit(rejecting)}>
                {rejecting.label}
              </Button>
              <Button variant="ghost" onClick={() => setRejecting(undefined)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {closed ? (
          <p className="muted">This item is {item.status}{item.resolvedBy ? ` by ${item.resolvedBy}` : ''}.</p>
        ) : (
          <div className="ny-actions row">
            {options.map((o) => (
              <Button
                key={o.id}
                variant={o.tone === 'primary' ? 'primary' : o.tone === 'danger' ? 'danger' : 'secondary'}
                loading={resolve.isPending && resolve.variables?.body.optionId === o.id}
                onClick={() => (o.requiresEdit ? startEdit(o) : o.requiresReason ? setRejecting(o) : submit(o))}
              >
                {o.label}
              </Button>
            ))}
            {!options.some((o) => o.requiresEdit) && canEditThenApprove(item) && (
              <Button variant="ghost" onClick={() => startEdit({ id: options.find((o) => o.tone === 'primary')?.id ?? 'acknowledge', label: 'Approve with my edits', tone: 'primary' })}>
                Edit then approve
              </Button>
            )}
            {!canEditThenApprove(item) && !noting && (
              <Button variant="ghost" onClick={() => (setRejecting(undefined), setNoting(true))}>
                Add a note
              </Button>
            )}
            <select
              className="select ny-snooze"
              aria-label="Snooze"
              value=""
              onChange={(e) => {
                const minutes = Number(e.target.value);
                if (minutes) snooze.mutate({ id: item.id, minutes }, { onSuccess: () => (toast.success('Snoozed'), onDone()), onError: (err) => toast.error(err instanceof Error ? err.message : String(err)) });
              }}
            >
              <option value="">Snooze…</option>
              {SNOOZE_CHOICES.map((c) => (
                <option key={c.minutes} value={c.minutes}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {detail.data!.events.length > 1 && (
          <details className="small">
            <summary>History</summary>
            <ul>
              {detail.data!.events.map((e) => (
                <li key={e.id}>
                  {when(e.at)} — {e.fromStatus ?? 'new'} → {e.toStatus} by {e.actor}
                  {e.optionId ? ` (${e.optionId})` : ''}
                  {e.note ? `: ${e.note}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

/** The prepared item, by kind (§L.2). */
export function PreparedItem({ item, ticked, onTick }: { item: NeedsYouItem; ticked?: Record<string, boolean>; onTick?: (key: string, on: boolean) => void }) {
  const link = payloadLink(item.payload);
  return (
    <>
      <PreparedBody item={item} {...(ticked && onTick ? { ticked, onTick } : {})} />
      {link && (
        <p className="small">
          <Link to={link}>Open {linkLabel(link)}</Link>
        </p>
      )}
    </>
  );
}

function linkLabel(link: string): string {
  if (/\/ledger$/.test(link)) return 'the ledger';
  if (/\/offers$/.test(link)) return 'the offers screen';
  if (link.startsWith('/settings/ai')) return 'Settings > AI';
  if (link.startsWith('/settings/email')) return 'Settings > Email';
  if (link.startsWith('/outbox')) return 'the outbox';
  if (link.startsWith('/intake')) return 'Intake';
  return 'the page';
}

function PreparedBody({ item, ticked, onTick }: { item: NeedsYouItem; ticked?: Record<string, boolean>; onTick?: (key: string, on: boolean) => void }) {
  const kind = rendererFor(item.kind, item.payload);
  if (kind === 'email') {
    const e = emailPreview(item.payload)!;
    return (
      <div className="ny-email" aria-label="Email preview">
        <div className="kv">
          <div>
            <span className="muted">To</span> {e.to.join(', ') || '—'}
          </div>
          {e.cc.length > 0 && (
            <div>
              <span className="muted">Cc</span> {e.cc.join(', ')}
            </div>
          )}
          <div>
            <span className="muted">Subject</span> {e.subject}
          </div>
        </div>
        <pre className="ny-email-body">{e.bodyText}</pre>
        {e.attachments.length > 0 && <div className="small">Attachments: {e.attachments.join(', ')}</div>}
        {e.outboxId && (
          <div className="small">
            <Link to={`/outbox/${encodeURIComponent(e.outboxId)}`}>Open in the outbox</Link>
          </div>
        )}
      </div>
    );
  }
  if (kind === 'document') {
    const docId = documentRef(item.payload)!;
    return (
      <div className="ny-document">
        <a className="btn btn-secondary" href={`/api/documents/${encodeURIComponent(docId)}/pdf`} target="_blank" rel="noreferrer">
          Open the document (PDF)
        </a>
        {item.claimId && (
          <Link className="small" to={`/claims/${encodeURIComponent(item.claimId)}/documents`}>
            Documents on this claim
          </Link>
        )}
      </div>
    );
  }
  if (kind === 'fields') {
    const warnings = cardWarnings(item.payload);
    return (
      <div className="table-wrap">
        {warnings.length > 0 && (
          <div className="notice notice-danger" role="alert">
            {warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}
        <table className="table" aria-label="Field changes">
          <thead>
            <tr>
              {onTick && <th scope="col">Apply</th>}
              <th scope="col">Field</th>
              <th scope="col">On file</th>
              <th scope="col">Proposed</th>
              <th scope="col">Confidence</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {fieldDiff(item.payload).map((f) => (
              <tr key={f.key}>
                {onTick && (
                  <td>
                    <input type="checkbox" aria-label={`Apply ${f.label}`} checked={isTicked(f, ticked ?? {})} onChange={(e) => onTick(f.key, e.target.checked)} />
                  </td>
                )}
                <td>{f.label}</td>
                <td>{f.current}</td>
                <td>
                  <strong>{f.proposed}</strong>
                </td>
                <td>{f.confidence !== undefined ? `${Math.round(f.confidence * 100)} %` : '—'}</td>
                <td className="small">{f.source ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (kind === 'offer') {
    return (
      <div className="table-wrap">
        <table className="table" aria-label="Offer analysis">
          <tbody>
            {offerRows(item.payload).map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td>{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {item.claimId && !payloadLink(item.payload) && (
          <p className="small">
            The decision is recorded on the claim’s <Link to={`/claims/${encodeURIComponent(item.claimId)}/offers`}>offers screen</Link>.
          </p>
        )}
      </div>
    );
  }
  const payload = item.payload && typeof item.payload === 'object' ? (item.payload as Record<string, unknown>) : {};
  const entries = Object.entries(payload).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return null;
  return (
    <details className="ny-generic">
      <summary className="small">Details</summary>
      <pre>{JSON.stringify(payload, null, 2)}</pre>
    </details>
  );
}

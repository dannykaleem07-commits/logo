// owned by knowledge-ui
/**
 * Knowledge ▸ Approve (docs/SUPREME-KNOWLEDGE-BUILDER.md §11 tab 2): what waits for the owner, grouped by insurer
 * contacts, rules, legal points, KB checks and the rest, plus open conflicts and anything held while learning was
 * paused. The selected card shows the proposal, the diff against the current version (and the insurer directory for a
 * contact), provenance chips, our stored source copy with the quote highlighted, the replay verdict for rules and any
 * conflicts. Approve · Approve as source-verified (only when every quote matched) · Edit then approve · Reject (reason) ·
 * Snooze. Bulk approve within a group. Keys j / k / a / e / r as in Needs-you.
 */
import { useEffect, useMemo, useState } from 'react';
import type { KnowledgeConflict, KnowledgeItemView, KnowledgeQueueGroup } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { TextArea, TextInput } from '../../components/Form';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { useToast } from '../../components/Toast';
import { inboxKey, moveSelection } from '../needsYou/needsYou';
import { knowledgeApi, useInsurerProfile, useKnowledgeItem, useKnowledgeMutation, useKnowledgeQueue } from '../../api/knowledgeApi';
import { DiffView, KnowledgeBadges, ProvenanceChips, QueryGate, ReasonForm, ReplayVerdict, SourceSideBySide } from './parts';
import {
  AREA_LABEL,
  CONFLICT_KIND_LABEL,
  KIND_LABEL,
  actorText,
  allQuotesMatched,
  conflictTone,
  currentVersionOf,
  dataRows,
  editApproveEdits,
  firstSnapshot,
  itemIdOfRef,
  loadSnoozed,
  saveSnoozed,
  scopeLabel,
  whenText,
} from './knowledgeView';

const DAY_MS = 86_400_000;

export function ApproveTab({ onOpenItem }: { onOpenItem: (id: string) => void }) {
  const q = useKnowledgeQueue();
  const toast = useToast();
  const [snoozed, setSnoozed] = useState<Record<string, number>>(() => loadSnoozed());
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();
  const [command, setCommand] = useState<{ key: 'approve' | 'edit' | 'reject'; n: number } | undefined>();
  const bulk = useKnowledgeMutation(async (ids: string[]) => {
    for (const id of ids) await knowledgeApi.approve(id, { note: 'bulk approve from Knowledge ▸ Approve' });
    return ids.length;
  });

  const data = q.data;
  const byId = useMemo(() => new Map((data?.items ?? []).map((i) => [i.id, i])), [data]);
  const visible = (id: string) => showSnoozed || !snoozed[id];
  const groups = useMemo(() => (data?.groups ?? []).map((g) => ({ ...g, itemIds: g.itemIds.filter((id) => byId.has(id) && visible(id)) })).filter((g) => g.itemIds.length), [data, byId, snoozed, showSnoozed]); // eslint-disable-line react-hooks/exhaustive-deps
  const order = useMemo(() => groups.flatMap((g) => g.itemIds), [groups]);
  const current = selected && order.includes(selected) ? selected : order[0];
  const snoozedCount = (data?.items ?? []).filter((i) => snoozed[i.id]).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.modal')) return;
      const k = inboxKey(e);
      if (!k) return;
      e.preventDefault();
      if (k === 'next' || k === 'prev') setSelected(moveSelection(order, current, k === 'next' ? 1 : -1));
      else setCommand((c) => ({ key: k, n: (c?.n ?? 0) + 1 }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, current]);

  const snooze = (id: string) => {
    const next = { ...snoozed, [id]: Date.now() + DAY_MS };
    setSnoozed(next);
    saveSnoozed(next);
    setSelected(moveSelection(order.filter((x) => x !== id), undefined, 0));
    toast.success('Snoozed until tomorrow');
  };

  return (
    <QueryGate q={q} what="The approval queue">
      {data && (
        <div className="stack">
          <p className="small muted">
            Keys: j / k to move, a approve, e edit, r reject. Nothing here is used by the agents until you approve it.
            {snoozedCount > 0 && (
              <>
                {' '}
                {snoozedCount} snoozed ·{' '}
                <button type="button" className="kn-link" onClick={() => setShowSnoozed((v) => !v)}>
                  {showSnoozed ? 'hide them' : 'show them'}
                </button>
              </>
            )}
          </p>
          {data.conflicts.length > 0 && <ConflictsCard conflicts={data.conflicts} onOpenItem={onOpenItem} />}
          {!order.length && !data.conflicts.length && <EmptyState title="Nothing waits for you">New proposals from the learners and the researcher appear here.</EmptyState>}
          {order.length > 0 && (
            <div className="kn-approve">
              <section className="card kn-queue" aria-label="Waiting for you">
                {groups.map((g) => (
                  <QueueGroup
                    key={g.key}
                    group={g}
                    items={g.itemIds.map((id) => byId.get(id)!)}
                    selected={current}
                    onSelect={setSelected}
                    busy={bulk.isPending && bulk.variables?.[0] === g.itemIds[0]}
                    onBulk={() =>
                      bulk.mutate(g.itemIds, {
                        onSuccess: (n) => toast.success(`Approved ${n} item${n === 1 ? '' : 's'}`),
                        onError: (e) => toast.error((e as Error).message),
                      })
                    }
                  />
                ))}
              </section>
              <section aria-label="Selected proposal">{current && byId.get(current) && <ApproveCard item={byId.get(current)!} conflicts={data.conflicts} command={command} onSnooze={() => snooze(current)} onOpenItem={onOpenItem} />}</section>
            </div>
          )}
          {bulk.error ? <ApiErrorNotice error={bulk.error} what="approve the group" /> : null}
          {data.held.length > 0 && (
            <Card title={`Held while learning was paused (${data.held.length})`}>
              <p className="small muted">These were stored while learning was off. They are decided again when learning resumes; you can still open them.</p>
              <ul className="kn-lines">
                {data.held.map((i) => (
                  <li key={i.id}>
                    <button type="button" className="kn-link" onClick={() => onOpenItem(i.id)}>
                      {i.title}
                    </button>{' '}
                    <span className="small muted">
                      {KIND_LABEL[i.kind]} · {whenText(i.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </QueryGate>
  );
}

function QueueGroup({ group, items, selected, onSelect, onBulk, busy }: { group: KnowledgeQueueGroup; items: KnowledgeItemView[]; selected: string | undefined; onSelect: (id: string) => void; onBulk: () => void; busy: boolean }) {
  return (
    <div className="kn-group">
      <div className="row-between kn-group-head">
        <h4 className="kn-group-title">
          {group.title} <span className="muted">({items.length})</span>
        </h4>
        {items.length > 1 && (
          <Button size="sm" variant="ghost" loading={busy} onClick={onBulk}>
            Approve all {items.length}
          </Button>
        )}
      </div>
      <ul className="kn-qitems">
        {items.map((i) => (
          <li key={i.id}>
            <button type="button" className={`kn-qitem${i.id === selected ? ' selected' : ''}`} aria-current={i.id === selected ? 'true' : undefined} onClick={() => onSelect(i.id)}>
              <span className="kn-qitem-title">{i.title}</span>
              <span className="small muted">
                {KIND_LABEL[i.kind]} · {scopeLabel(i.scope)} · {whenText(i.createdAt)}
              </span>
              <KnowledgeBadges badges={i.badges} supportN={i.supportN} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One proposal with everything needed to decide it. Also used by the Needs-you knowledge card. */
export function ApproveCard({
  item,
  conflicts,
  command,
  onSnooze,
  onOpenItem,
  onDecided,
}: {
  item: KnowledgeItemView;
  conflicts: readonly KnowledgeConflict[];
  command?: { key: 'approve' | 'edit' | 'reject'; n: number };
  onSnooze?: () => void;
  onOpenItem?: (id: string) => void;
  onDecided?: () => void;
}) {
  const toast = useToast();
  const detail = useKnowledgeItem(item.id);
  const [mode, setMode] = useState<'none' | 'edit' | 'reject'>('none');
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [dataJson, setDataJson] = useState(JSON.stringify(item.data ?? {}, null, 2));
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | undefined>();
  const approve = useKnowledgeMutation((sv: boolean) => {
    const s = firstSnapshot(item);
    return knowledgeApi.approve(item.id, sv && s ? { verification: 'source_verified', snapshotId: s.snapshotId, sourceUrl: s.url, ...(note.trim() ? { note: note.trim() } : {}) } : note.trim() ? { note: note.trim() } : {});
  });
  const editApprove = useKnowledgeMutation((edits: { title: string; body: string; data: Record<string, unknown> }) => knowledgeApi.editApprove(item.id, { ...edits, data: edits.data as never, scope: item.scope, ...(note.trim() ? { note: note.trim() } : {}) }));
  const reject = useKnowledgeMutation((reason: string) => knowledgeApi.reject(item.id, reason));
  const quotesOk = allQuotesMatched(item);
  const urlOnly = item.provenance.some((p) => p.kind === 'url') && !item.provenance.some((p) => p.kind === 'snapshot');

  useEffect(() => {
    setMode('none');
    setTitle(item.title);
    setBody(item.body);
    setDataJson(JSON.stringify(item.data ?? {}, null, 2));
    setNote('');
    setFormError(undefined);
  }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const done = (msg: string) => () => {
    toast.success(msg);
    setMode('none');
    onDecided?.();
  };
  const fail = (e: unknown) => toast.error((e as Error).message);

  useEffect(() => {
    if (!command) return;
    if (command.key === 'approve') approve.mutate(false, { onSuccess: done('Approved — agents can use it now'), onError: fail });
    else if (command.key === 'edit') setMode('edit');
    else setMode('reject');
  }, [command?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const versions = detail.data?.versions ?? [];
  const cur = currentVersionOf(item, versions);
  const mine = conflicts.filter((c) => c.leftRef === `ki:${item.id}` || c.rightRef === `ki:${item.id}`);
  const busy = approve.isPending || editApprove.isPending || reject.isPending;

  return (
    <Card
      title={item.title}
      actions={
        <>
          <Badge tone={item.autonomy?.priority === 'high' || item.autonomy?.priority === 'urgent' ? 'amber' : 'grey'}>{KIND_LABEL[item.kind]}</Badge>
          <KnowledgeBadges badges={item.badges} supportN={item.supportN} />
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          {AREA_LABEL[item.area]} · {scopeLabel(item.scope)} · proposed by {actorText(item.createdBy)} {whenText(item.createdAt)} · confidence {Math.round(item.confidence * 100)} % · support {item.supportN}
        </div>
        {item.autonomy?.reasons?.length ? (
          <div className="kn-why">
            <strong>Why it waits:</strong> {item.autonomy.reasons.join('; ')}
            {item.autonomy.ruleIds.length ? <span className="small muted"> ({item.autonomy.ruleIds.join(', ')})</span> : null}
          </div>
        ) : null}
        {cur ? (
          <div>
            <h4 className="kn-h">Change from the version in use (v{cur.version})</h4>
            <DiffView before={`${cur.title}\n${cur.body}`} after={`${item.title}\n${item.body}`} />
          </div>
        ) : (
          <p className="kn-pre">{item.body}</p>
        )}
        {dataRows(item.data).length > 0 && (
          <table className="table kn-data">
            <tbody>
              {dataRows(item.data).map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {item.kind === 'contact' && item.scope.kind === 'insurer' && <DirectoryCompare slug={item.scope.slug} data={item.data as unknown as Record<string, unknown>} />}
        <ProvenanceChips provenance={item.provenance} />
        <SourceSideBySide item={item} />
        {urlOnly && <div className="notice notice-warn">Found on the web but no copy is stored yet, so it cannot be approved. The researcher fetches a copy first.</div>}
        {(item.kind === 'rule' || item.kind === 'strategy') && <ReplayVerdict itemId={item.id} kind={item.kind} />}
        {mine.length > 0 && (
          <div className="stack-sm">
            {mine.map((c) => (
              <div key={c.id} className="kn-conflict-line">
                <Badge tone={conflictTone(c)}>{CONFLICT_KIND_LABEL[c.kind]}</Badge> {c.detail}
                {onOpenItem && itemIdOfRef(c.leftRef === `ki:${item.id}` ? c.rightRef : c.leftRef) && (
                  <>
                    {' '}
                    <button type="button" className="kn-link" onClick={() => onOpenItem(itemIdOfRef(c.leftRef === `ki:${item.id}` ? c.rightRef : c.leftRef)!)}>
                      see the other one
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {mode === 'edit' && (
          <div className="kn-form" aria-label="Edit then approve">
            <TextInput label="Title" value={title} onChange={setTitle} />
            <TextArea label="Text" value={body} onChange={setBody} rows={5} />
            <TextArea label="Details (JSON)" value={dataJson} onChange={setDataJson} rows={8} className="kn-json" />
            <TextInput label="Note (optional)" value={note} onChange={setNote} />
            {formError && <div className="field-error">{formError}</div>}
            <div className="row">
              <Button
                variant="primary"
                loading={editApprove.isPending}
                onClick={() => {
                  const r = editApproveEdits(item, { title, body, dataJson });
                  if (!r.ok) return setFormError(r.error);
                  setFormError(undefined);
                  editApprove.mutate({ title: r.edits.title, body: r.edits.body, data: r.edits.data }, { onSuccess: (res) => done(res.waitingForReplay ? 'Saved as a new version. It is being replayed against past claims; approve it once the verdict shows' : 'Saved as a new version and approved')(), onError: fail });
                }}
              >
                Approve my version
              </Button>
              <Button variant="ghost" onClick={() => setMode('none')}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {mode === 'reject' && <ReasonForm label="Why reject it? (the learners use your reason)" action="Reject" busy={reject.isPending} onCancel={() => setMode('none')} onSubmit={(reason) => reject.mutate(reason, { onSuccess: done('Rejected'), onError: fail })} />}
        <ApiErrorNotice error={approve.error ?? editApprove.error ?? reject.error} what="decide this proposal" />
        {mode === 'none' && (
          <div className="row kn-actions">
            <Button variant="primary" disabled={urlOnly || busy} loading={approve.isPending && approve.variables === false} onClick={() => approve.mutate(false, { onSuccess: done('Approved — agents can use it now'), onError: fail })}>
              Approve
            </Button>
            <Button
              disabled={!quotesOk || busy}
              title={quotesOk ? 'Every quote was found exactly in our stored copy' : 'Enabled only when every quote matched our stored copy exactly'}
              loading={approve.isPending && approve.variables === true}
              onClick={() => approve.mutate(true, { onSuccess: done('Approved as source-verified'), onError: fail })}
            >
              Approve as source-verified
            </Button>
            <Button disabled={busy} onClick={() => setMode('edit')}>
              Edit then approve
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => setMode('reject')}>
              Reject
            </Button>
            {onSnooze && (
              <Button variant="ghost" onClick={onSnooze}>
                Snooze
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function DirectoryCompare({ slug, data }: { slug: string; data: Record<string, unknown> }) {
  const q = useInsurerProfile(slug);
  const dir = q.data?.contacts.find((c) => c.directory)?.directory;
  if (!dir) return null;
  const rows = (['phone', 'email', 'ivr', 'hours'] as const).filter((k) => data[k] || dir[k]);
  if (!rows.length) return null;
  return (
    <table className="table kn-data" aria-label="Against the insurer directory">
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Insurer directory</th>
          <th scope="col">Learned</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((k) => {
          const a = String(dir[k] ?? '—');
          const b = String(data[k] ?? '—');
          return (
            <tr key={k} className={a !== b && dir[k] && data[k] ? 'kn-differs' : undefined}>
              <th scope="row">{k === 'ivr' ? 'Phone menu path' : k[0]!.toUpperCase() + k.slice(1)}</th>
              <td>{a}</td>
              <td>{b}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const KEEP_LABEL: Record<'left' | 'right' | 'both' | 'retire_both' | 'dismiss', string> = { left: 'Keep the new one', right: 'Keep the existing one', both: 'Keep both', retire_both: 'Retire both', dismiss: 'Not a conflict' };

export function ConflictsCard({ conflicts, onOpenItem }: { conflicts: readonly KnowledgeConflict[]; onOpenItem: (id: string) => void }) {
  const toast = useToast();
  const resolve = useKnowledgeMutation((v: { id: string; keep: keyof typeof KEEP_LABEL }) => knowledgeApi.resolveConflict(v.id, { keep: v.keep }));
  const ref = (r: string) => {
    const id = itemIdOfRef(r);
    return id ? (
      <button type="button" className="kn-link" onClick={() => onOpenItem(id)}>
        {r}
      </button>
    ) : (
      <span className="mono small">{r}</span>
    );
  };
  return (
    <Card title={`Conflicts (${conflicts.length})`}>
      <ul className="kn-lines">
        {conflicts.map((c) => (
          <li key={c.id} className="kn-conflict">
            <div className="row">
              <Badge tone={conflictTone(c)}>{CONFLICT_KIND_LABEL[c.kind]}</Badge>
              <span>{c.detail}</span>
            </div>
            <div className="small muted">
              New: {ref(c.leftRef)} · existing: {ref(c.rightRef)} · found by {actorText(c.detectedBy)} {whenText(c.createdAt)}
            </div>
            <div className="row">
              {(Object.keys(KEEP_LABEL) as (keyof typeof KEEP_LABEL)[]).map((k) => (
                <Button
                  key={k}
                  size="sm"
                  variant={k === 'retire_both' ? 'danger' : k === 'left' ? 'primary' : 'secondary'}
                  disabled={resolve.isPending}
                  loading={resolve.isPending && resolve.variables?.id === c.id && resolve.variables.keep === k}
                  onClick={() => resolve.mutate({ id: c.id, keep: k }, { onSuccess: () => toast.success('Conflict resolved'), onError: (e) => toast.error((e as Error).message) })}
                >
                  {KEEP_LABEL[k]}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

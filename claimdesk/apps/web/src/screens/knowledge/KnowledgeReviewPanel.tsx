// owned by knowledge-ui
/**
 * Needs-you `knowledge_review` preview (docs/SUPREME-KNOWLEDGE-BUILDER.md §9.3, §11 Elsewhere). Four variants:
 *   items    the proposed items: text, diff against the version in use, provenance, our stored source copy with the
 *            quote highlighted; "Edit then approve" opens an editor here and resolves with {itemId, title, body, data, scope}
 *   conflict both sides of the conflict
 *   alarm    the drift alarm and the suggested rollback
 *   gap      the question, where the researcher looked, any prepared answer; "I know the answer" resolves with {answer}
 * The card's own options (Approve, Reject, Keep…, Roll back…, Dismiss) stay on the Needs-you page and go through the
 * resolver, which runs as the signed-in owner.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { KnowledgeItemView, NeedsYouOption } from '@ccguk/domain';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { TextArea, TextInput } from '../../components/Form';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { useToast } from '../../components/Toast';
import { useResolveNeedsYou, type NeedsYouItem } from '../../api/needsYouApi';
import { knowledgeQk, useKnowledgeAlarms, useKnowledgeConflicts, useKnowledgeItem } from '../../api/knowledgeApi';
import { DiffView, ItemDrawer, KnowledgeBadges, NotBuilt, ProvenanceChips, QueryGate, ReplayVerdict, SourceSideBySide } from './parts';
import { CONFLICT_KIND_LABEL, KIND_LABEL, conflictTone, currentVersionOf, dataRows, editApproveEdits, humanise, itemIdOfRef, knowledgeHref, reviewPayload, scopeLabel, whenText } from './knowledgeView';
import './knowledge.css';

export interface KnowledgeReviewPanelProps {
  item: NeedsYouItem;
  closed: boolean;
  /** Bumped by the Needs-you page when the owner picks an option that needs edits (button or the `e` key); only a change after mount opens the editor. */
  editRequest?: number;
  onResolved?: () => void;
}

export function KnowledgeReviewPanel({ item, closed, editRequest = 0, onResolved }: KnowledgeReviewPanelProps) {
  const payload = reviewPayload(item.payload);
  const [drawer, setDrawer] = useState<string | undefined>();
  if (!payload) return null;
  const editOption = item.options.find((o) => o.requiresEdit);
  return (
    <div className="kn-review" aria-label="Knowledge to check">
      {payload.variant === 'items' && <ItemsPreview ids={payload.itemIds} item={item} closed={closed} editRequest={editRequest} editOption={editOption} onResolved={onResolved} onOpen={setDrawer} />}
      {payload.variant === 'conflict' && <ConflictPreview id={payload.conflictId} onOpen={setDrawer} />}
      {payload.variant === 'alarm' && <AlarmPreview id={payload.alarmId} rollbackTo={payload.suggestedRollbackTo} />}
      {payload.variant === 'gap' && <GapPreview payload={payload} item={item} closed={closed} editRequest={editRequest} editOption={editOption} onResolved={onResolved} onOpen={setDrawer} />}
      <div className="small">
        <Link to={payload.variant === 'gap' ? knowledgeHref('gaps', { gap: payload.gapId }) : payload.variant === 'alarm' ? knowledgeHref('safety', { alarm: payload.alarmId }) : knowledgeHref('approve')}>Open in Knowledge</Link>
      </div>
      <ItemDrawer itemId={drawer} onClose={() => setDrawer(undefined)} onOpenItem={setDrawer} />
    </div>
  );
}

function useResolve(item: NeedsYouItem, onResolved?: () => void) {
  const resolve = useResolveNeedsYou();
  const qc = useQueryClient();
  const toast = useToast();
  const run = (option: NeedsYouOption, edits: unknown, note?: string) =>
    resolve.mutate(
      { id: item.id, body: { optionId: option.id, edits, ...(note?.trim() ? { note: note.trim() } : {}) } },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: knowledgeQk.all });
          toast.success(`${option.label} — done`);
          onResolved?.();
        },
        onError: (e) => toast.error((e as Error).message),
      },
    );
  return { resolve, run };
}

function ItemsPreview({ ids, item, closed, editRequest, editOption, onResolved, onOpen }: { ids: string[]; item: NeedsYouItem; closed: boolean; editRequest: number; editOption?: NeedsYouOption; onResolved?: () => void; onOpen: (id: string) => void }) {
  const [editing, setEditing] = useState<string | undefined>();
  const seen = useRef(editRequest);
  useEffect(() => {
    if (editRequest !== seen.current && !closed && ids.length) setEditing(ids[0]);
    seen.current = editRequest;
  }, [editRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <div className="small muted">
        {ids.length} item{ids.length === 1 ? '' : 's'} to check. Approve applies to all of them; to decide one at a time use Knowledge ▸ Approve.
      </div>
      {ids.map((id) => (
        <ItemPreview key={id} id={id} item={item} closed={closed} editing={editing === id} editOption={editOption} onEdit={() => setEditing(id)} onCancel={() => setEditing(undefined)} onResolved={onResolved} onOpen={onOpen} />
      ))}
    </div>
  );
}

function ItemPreview({ id, item, closed, editing, editOption, onEdit, onCancel, onResolved, onOpen }: { id: string; item: NeedsYouItem; closed: boolean; editing: boolean; editOption?: NeedsYouOption; onEdit: () => void; onCancel: () => void; onResolved?: () => void; onOpen: (id: string) => void }) {
  const q = useKnowledgeItem(id);
  const k = q.data?.item;
  return (
    <QueryGate q={q} what="This item">
      {k && q.data && (
        <div className="stack-sm">
          <div className="row">
            <button type="button" className="kn-link" onClick={() => onOpen(k.id)}>
              <strong>{k.title}</strong>
            </button>
            <Badge tone="grey">{KIND_LABEL[k.kind]}</Badge>
            <KnowledgeBadges badges={k.badges} supportN={k.supportN} />
            <span className="small muted">{scopeLabel(k.scope)}</span>
            {k.status !== 'proposed' && <Badge tone="grey">{humanise(k.status)}</Badge>}
          </div>
          {(() => {
            const cur = currentVersionOf(k, q.data.versions);
            return cur ? <DiffView before={`${cur.title}\n${cur.body}`} after={`${k.title}\n${k.body}`} /> : <p className="kn-pre">{k.body}</p>;
          })()}
          {dataRows(k.data).length > 0 && (
            <table className="table kn-data">
              <tbody>
                {dataRows(k.data).map((r) => (
                  <tr key={r.label}>
                    <th scope="row">{r.label}</th>
                    <td>{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ProvenanceChips provenance={k.provenance} />
          <SourceSideBySide item={k} />
          {k.kind === 'rule' && k.status === 'proposed' && <ReplayVerdict itemId={k.id} kind={k.kind} />}
          {editing && editOption && !closed ? <ItemEditor k={k} item={item} option={editOption} onCancel={onCancel} onResolved={onResolved} /> : null}
          {!editing && editOption && !closed && k.status === 'proposed' && (
            <div>
              <Button size="sm" variant="ghost" onClick={onEdit}>
                Edit this one, then approve
              </Button>
            </div>
          )}
        </div>
      )}
    </QueryGate>
  );
}

function ItemEditor({ k, item, option, onCancel, onResolved }: { k: KnowledgeItemView; item: NeedsYouItem; option: NeedsYouOption; onCancel: () => void; onResolved?: () => void }) {
  const [title, setTitle] = useState(k.title);
  const [body, setBody] = useState(k.body);
  const [dataJson, setDataJson] = useState(JSON.stringify(k.data ?? {}, null, 2));
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const { resolve, run } = useResolve(item, onResolved);
  return (
    <div className="kn-form" aria-label="Edit then approve">
      <TextInput label="Title" value={title} onChange={setTitle} />
      <TextArea label="Text" value={body} onChange={setBody} rows={5} />
      <TextArea label="Details (JSON)" value={dataJson} onChange={setDataJson} rows={6} className="kn-json" />
      <TextInput label="Note (optional)" value={note} onChange={setNote} />
      {err && <div className="field-error">{err}</div>}
      <div className="row">
        <Button
          variant="primary"
          loading={resolve.isPending}
          onClick={() => {
            const r = editApproveEdits(k, { title, body, dataJson });
            if (!r.ok) return setErr(r.error);
            setErr(undefined);
            run(option, r.edits, note);
          }}
        >
          Approve my version
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <ApiErrorNotice error={resolve.error} what="approve your version" />
    </div>
  );
}

function ConflictPreview({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const q = useKnowledgeConflicts('all');
  const c = q.data?.conflicts.find((x) => x.id === id);
  return (
    <QueryGate q={q} what="This conflict">
      {c ? (
        <div className="stack-sm">
          <div className="row">
            <Badge tone={conflictTone(c)}>{CONFLICT_KIND_LABEL[c.kind]}</Badge>
            <span className="small muted">
              found {whenText(c.createdAt)} · {c.status}
            </span>
          </div>
          <p className="kn-pre">{c.detail}</p>
          <div className="kn-side">
            <ConflictSide label="New (left)" refId={c.leftRef} onOpen={onOpen} />
            <ConflictSide label="Existing (right)" refId={c.rightRef} onOpen={onOpen} />
          </div>
        </div>
      ) : (
        <p className="small muted">This conflict is no longer open.</p>
      )}
    </QueryGate>
  );
}

function ConflictSide({ label, refId, onOpen }: { label: string; refId: string; onOpen: (id: string) => void }) {
  const itemId = itemIdOfRef(refId);
  const q = useKnowledgeItem(itemId ?? undefined);
  const k = q.data?.item;
  return (
    <div className="kn-side-col">
      <div className="kn-side-head">{label}</div>
      {k ? (
        <>
          <button type="button" className="kn-link" onClick={() => onOpen(k.id)}>
            <strong>{k.title}</strong>
          </button>{' '}
          <KnowledgeBadges badges={k.badges} supportN={k.supportN} />
          <p className="kn-pre small">{k.body}</p>
        </>
      ) : (
        <span className="mono small">{refId}</span>
      )}
    </div>
  );
}

function AlarmPreview({ id, rollbackTo }: { id: string; rollbackTo: number | null }) {
  const q = useKnowledgeAlarms('all');
  const a = q.data?.alarms.find((x) => x.id === id);
  return (
    <div className="stack-sm">
      {q.error ? (
        <NotBuilt what="The alarm detail" />
      ) : a ? (
        <div>
          <Badge tone={a.severity === 'severe' ? 'red' : 'amber'}>{a.severity}</Badge> {humanise(a.metric)} moved from {a.baseline ?? '—'} to {a.current ?? '—'} (n {a.n}, threshold {a.threshold})
          {a.packVersion !== null ? ` after learned v${a.packVersion}` : ''}.
        </div>
      ) : null}
      <p className="small">{rollbackTo !== null ? `Suggested: roll back to learned v${rollbackTo}. Rolling back creates a new version; nothing is deleted.` : 'No rollback is suggested.'}</p>
    </div>
  );
}

function GapPreview({ payload, item, closed, editRequest, editOption, onResolved, onOpen }: { payload: { gapId: string; question: string; preparedItemId: string | null; looked: { domain: string; url: string | null }[] }; item: NeedsYouItem; closed: boolean; editRequest: number; editOption?: NeedsYouOption; onResolved?: () => void; onOpen: (id: string) => void }) {
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState('');
  const [title, setTitle] = useState('');
  const { resolve, run } = useResolve(item, onResolved);
  const prepared = useKnowledgeItem(payload.preparedItemId ?? undefined);
  const seen = useRef(editRequest);
  useEffect(() => {
    if (editRequest !== seen.current && !closed) setAnswering(true);
    seen.current = editRequest;
  }, [editRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  const domains = [...new Set(payload.looked.map((l) => l.domain))];
  return (
    <div className="stack-sm">
      <div>
        <strong>{payload.question}</strong>
      </div>
      <div className="small muted">{domains.length ? `Where the researcher looked: ${domains.join(', ')}.` : 'Nothing official was found to look at.'}</div>
      {prepared.data?.item && (
        <div className="kn-side-col">
          <div className="kn-side-head">Prepared answer</div>
          <button type="button" className="kn-link" onClick={() => onOpen(prepared.data!.item.id)}>
            {prepared.data.item.title}
          </button>{' '}
          <KnowledgeBadges badges={prepared.data.item.badges} supportN={prepared.data.item.supportN} />
          <p className="kn-pre small">{prepared.data.item.body}</p>
          {editOption && !closed && (
            <Button size="sm" loading={resolve.isPending} onClick={() => run(editOption, { usePrepared: true })}>
              Use the prepared answer
            </Button>
          )}
        </div>
      )}
      {answering && editOption && !closed && (
        <div className="kn-form" aria-label="Answer the gap">
          <TextInput label="Title (optional)" value={title} onChange={setTitle} />
          <TextArea label="Your answer" value={answer} onChange={setAnswer} rows={4} hint="Saved as knowledge you confirmed. No names or references needed." autoFocus />
          <div className="row">
            <Button variant="primary" disabled={answer.trim().length < 3} loading={resolve.isPending} onClick={() => run(editOption, { answer: answer.trim(), ...(title.trim() ? { title: title.trim() } : {}) })}>
              Save my answer
            </Button>
            <Button variant="ghost" onClick={() => setAnswering(false)}>
              Cancel
            </Button>
          </div>
          <ApiErrorNotice error={resolve.error} what="save your answer" />
        </div>
      )}
    </div>
  );
}

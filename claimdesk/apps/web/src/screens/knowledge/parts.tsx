// owned by knowledge-ui
/**
 * Shared pieces of the Knowledge screen (docs/SUPREME-KNOWLEDGE-BUILDER.md §11): text badges, provenance chips, word
 * diffs, the stored source copy with the quote highlighted, the "not built yet" notice and the item drawer (version
 * chain, provenance, check history, usage, conflicts; Retire and Record a check).
 */
import { useState, type ReactNode } from 'react';
import type { KnowledgeBadge, KnowledgeCheckMethod, KnowledgeCheckResult, KnowledgeItemView, KnowledgeProvenance } from '@ccguk/domain';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Select, TextArea, TextInput } from '../../components/Form';
import { useToast } from '../../components/Toast';
import { isNotBuilt, knowledgeApi, useKnowledgeItem, useKnowledgeMutation, useKnowledgeSnapshot, useReplayRunsForItem } from '../../api/knowledgeApi';
import {
  BADGE_TONE,
  CONFLICT_KIND_LABEL,
  KIND_LABEL,
  AREA_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  actorText,
  aroundQuote,
  badgeHint,
  badgeText,
  conflictTone,
  dataRows,
  firstSnapshot,
  highlightQuote,
  humanise,
  provenanceChips,
  scopeLabel,
  whenText,
  wordDiff,
} from './knowledgeView';

export function KnowledgeBadges({ badges, supportN }: { badges: readonly KnowledgeBadge[]; supportN?: number | null }) {
  if (!badges.length) return null;
  return (
    <span className="kn-badges">
      {badges.map((b) => (
        <Badge key={b} tone={BADGE_TONE[b] ?? 'grey'} title={badgeHint(b)} className="kn-badge">
          {badgeText(b, supportN)}
        </Badge>
      ))}
    </span>
  );
}

export function ProvenanceChips({ provenance }: { provenance: readonly KnowledgeProvenance[] }) {
  const chips = provenanceChips(provenance);
  if (!chips.length) return null;
  return (
    <div className="kn-chips" aria-label="Where it came from">
      <span className="small muted">From</span>
      {chips.map((c, i) =>
        c.href ? (
          <a key={i} className="kn-chip" href={c.href} target="_blank" rel="noreferrer noopener" title={c.title}>
            {c.label}
          </a>
        ) : (
          <span key={i} className="kn-chip" title={c.title}>
            {c.label}
          </span>
        ),
      )}
    </div>
  );
}

/** Word diff: removed words struck through, added words marked. */
export function DiffView({ before, after, label = 'Changes' }: { before: string; after: string; label?: string }) {
  const pieces = wordDiff(before, after);
  return (
    <div className="kn-diff" aria-label={label}>
      {pieces.map((p, i) =>
        p.op === 'eq' ? (
          <span key={i}>{p.text} </span>
        ) : p.op === 'ins' ? (
          <ins key={i} className="kn-ins">
            {p.text}{' '}
          </ins>
        ) : (
          <del key={i} className="kn-del">
            {p.text}{' '}
          </del>
        ),
      )}
    </div>
  );
}

/** Small muted line for a route its slice has not built yet. */
/**
 * The gate replay verdict for a proposed rule (§12.1), with n and the plain summary ("inconclusive: only 4 past cases,
 * fewer than 10"). Until the replay has run, approving the rule is refused by the server, so this says so.
 */
export function ReplayVerdict({ itemId, kind }: { itemId: string; kind: KnowledgeItemView['kind'] }) {
  const q = useReplayRunsForItem(itemId);
  if (q.isLoading) return null;
  if (q.error) return isNotBuilt(q.error) ? <p className="small muted">Replay check: not available yet in this version.</p> : null;
  const run = (q.data ?? [])[0];
  if (!run) {
    return kind === 'rule' ? (
      <p className="small" role="status">
        <Badge tone="amber">Replay running</Badge> This rule is being replayed against past claims (a few minutes). You can approve it once the verdict shows.
      </p>
    ) : (
      <p className="small muted">Replay check: not run for this item.</p>
    );
  }
  const tone = run.verdict === 'no_worse' ? 'green' : run.verdict === 'worse' ? 'red' : 'amber';
  const summary = typeof (run.details as { summary?: unknown } | null)?.summary === 'string' ? (run.details as { summary: string }).summary : null;
  return (
    <div className="small" aria-label="Replay verdict">
      <p>
        Replay against {run.cases} past case{run.cases === 1 ? '' : 's'}: <Badge tone={tone}>{run.verdict.replace(/_/g, ' ')}</Badge> <span className="muted">{whenText(run.finishedAt ?? run.startedAt)}</span>
      </p>
      {summary && <p className="muted">{summary}</p>}
      {run.verdict === 'worse' && <p>Past claims that followed this rule ended worse. You decide.</p>}
    </div>
  );
}

export function NotBuilt({ what }: { what: string }) {
  return <p className="small muted kn-not-built">{what} is not available yet in this version.</p>;
}

/** Loading / not-built / error for a query, else the children. */
export function QueryGate({ q, what, children }: { q: { isLoading: boolean; error: unknown }; what: string; children: ReactNode }) {
  if (q.isLoading) return <Loading />;
  if (q.error) return isNotBuilt(q.error) ? <NotBuilt what={what} /> : <ApiErrorNotice error={q.error} what={`load ${what.toLowerCase()}`} />;
  return <>{children}</>;
}

/** The proposed text beside our stored copy of the source, the quote highlighted (§11 Approve). */
export function SourceSideBySide({ item }: { item: Pick<KnowledgeItemView, 'body' | 'provenance'> }) {
  const snap = firstSnapshot(item);
  const q = useKnowledgeSnapshot(snap?.snapshotId);
  if (!snap) return null;
  const s = q.data?.snapshot;
  const text = s?.text ?? '';
  const hl = highlightQuote(aroundQuote(text, snap.quote), snap.quote);
  return (
    <div className="kn-side" aria-label="Source comparison">
      <div className="kn-side-col">
        <div className="kn-side-head">Proposed</div>
        <p className="kn-pre">{item.body}</p>
        <p className="small muted">
          Quote: “{snap.quote}”
        </p>
      </div>
      <div className="kn-side-col">
        <div className="kn-side-head">
          Our stored copy ·{' '}
          <a href={snap.url} target="_blank" rel="noreferrer noopener">
            {s?.title ?? snap.url}
          </a>
          {s ? ` · fetched ${whenText(s.fetchedAt)}` : ''}
        </div>
        <QueryGate q={q} what="The stored copy">
          {s && !s.extractAllowed ? (
            <p className="small muted">This source allows no stored extract. Open the page and compare the quote yourself.</p>
          ) : s?.pruned ? (
            <p className="small muted">The stored copy was pruned.</p>
          ) : (
            <>
              <p className="kn-pre kn-source">
                {hl.segments.map((g, i) =>
                  g.hit ? (
                    <mark key={i} className="kn-mark">
                      {g.text}
                    </mark>
                  ) : (
                    <span key={i}>{g.text}</span>
                  ),
                )}
              </p>
              {!hl.found && text && <p className="small kn-warn-text">The quote was not found in the stored copy.</p>}
            </>
          )}
        </QueryGate>
      </div>
    </div>
  );
}

const CHECK_RESULTS: { value: KnowledgeCheckResult; label: string }[] = [
  { value: 'owner_confirmed', label: 'Confirmed by me' },
  { value: 'source_verified', label: 'Checked against the source' },
  { value: 'unverified', label: 'Not checked (downgrade to unverified)' },
  { value: 'failed', label: 'Wrong (retires it)' },
];
const CHECK_METHODS: { value: Exclude<KnowledgeCheckMethod, 'downgrade'>; label: string }[] = [
  { value: 'owner_review', label: 'I reviewed it' },
  { value: 'source_compare', label: 'I compared it with the source' },
  { value: 'owner_answer', label: 'I know the answer' },
];

/** Record a check form (item or KB entry). Source-verified needs a link or a stored copy. */
export function RecordCheckForm({ onSubmit, busy, defaultUrl, defaultSnapshotId, onCancel }: { onSubmit: (body: Parameters<typeof knowledgeApi.check>[1]) => void; busy: boolean; defaultUrl?: string; defaultSnapshotId?: string; onCancel: () => void }) {
  const [result, setResult] = useState<KnowledgeCheckResult | ''>('owner_confirmed');
  const [method, setMethod] = useState<Exclude<KnowledgeCheckMethod, 'downgrade'> | ''>('owner_review');
  const [url, setUrl] = useState(defaultUrl ?? '');
  const [quote, setQuote] = useState('');
  const [note, setNote] = useState('');
  const needsSource = result === 'source_verified';
  const ok = Boolean(result && method) && (!needsSource || Boolean(url.trim() || defaultSnapshotId));
  return (
    <div className="kn-form">
      <div className="grid-2">
        <Select label="Result" value={result} onChange={setResult} options={CHECK_RESULTS} />
        <Select label="How" value={method} onChange={setMethod} options={CHECK_METHODS} />
      </div>
      {needsSource && <TextInput label="Source link" type="url" value={url} onChange={setUrl} hint={defaultSnapshotId ? 'Our stored copy is attached as well.' : 'Needed for source-verified.'} />}
      {needsSource && <TextInput label="Quote from the source (optional)" value={quote} onChange={setQuote} />}
      <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} />
      <div className="row">
        <Button
          variant="primary"
          disabled={!ok}
          loading={busy}
          onClick={() =>
            result &&
            method &&
            onSubmit({
              result,
              method,
              ...(url.trim() ? { sourceUrl: url.trim() } : {}),
              ...(needsSource && defaultSnapshotId ? { snapshotId: defaultSnapshotId } : {}),
              ...(quote.trim() ? { quote: quote.trim() } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
            })
          }
        >
          Record the check
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Retire with a reason (also what the daily log's Undo does). */
export function ReasonForm({ label, action, onSubmit, busy, onCancel, danger = true }: { label: string; action: string; onSubmit: (reason: string) => void; busy: boolean; onCancel: () => void; danger?: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <div className="kn-form">
      <TextArea label={label} value={reason} onChange={setReason} rows={2} autoFocus />
      <div className="row">
        <Button variant={danger ? 'danger' : 'primary'} disabled={!reason.trim()} loading={busy} onClick={() => onSubmit(reason.trim())}>
          {action}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The item drawer (Library ▸ item, digest links `?item=`): everything about one item and its history. */
export function ItemDrawer({ itemId, onClose, onOpenItem }: { itemId: string | undefined; onClose: () => void; onOpenItem?: (id: string) => void }) {
  const q = useKnowledgeItem(itemId);
  const toast = useToast();
  const [mode, setMode] = useState<'none' | 'retire' | 'check'>('none');
  const retire = useKnowledgeMutation((reason: string) => knowledgeApi.retire(itemId!, reason));
  const check = useKnowledgeMutation((body: Parameters<typeof knowledgeApi.check>[1]) => knowledgeApi.check(itemId!, body));
  const d = q.data;
  const item = d?.item;
  const snap = item ? firstSnapshot(item) : null;
  return (
    <Modal open={Boolean(itemId)} title={item ? item.title : 'Knowledge item'} onClose={() => (setMode('none'), onClose())} size="lg">
      <QueryGate q={q} what="This item">
        {item && d && (
          <div className="stack kn-drawer">
            <div className="row">
              <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
              <KnowledgeBadges badges={item.badges} supportN={item.supportN} />
              <span className="small muted">
                {KIND_LABEL[item.kind]} · {AREA_LABEL[item.area]} · {scopeLabel(item.scope)} · v{item.version}
                {d.inActiveVersion ? ' · in the active learned pack' : ''}
              </span>
            </div>
            <p className="kn-pre">{item.body}</p>
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
            <ProvenanceChips provenance={item.provenance} />
            <div className="small muted">
              Use: {item.useLimit === 'outbound_ok' ? 'may be cited in letters once checked' : item.useLimit === 'internal' ? 'agents may reason with it; never stated in letters' : 'code only'} · confidence {Math.round(item.confidence * 100)} % · support {item.supportN}
              {item.decidedBy ? ` · decided by ${actorText(item.decidedBy)} ${whenText(item.decidedAt)}` : ''}
              {item.autonomy?.ruleIds?.length ? ` · rules ${item.autonomy.ruleIds.join(', ')}` : ''}
            </div>
            {item.autonomy?.reasons?.length ? <div className="small">Why: {item.autonomy.reasons.join('; ')}</div> : null}

            {item.status === 'active' && mode === 'none' && (
              <div className="row">
                <Button variant="danger" onClick={() => setMode('retire')}>
                  Retire
                </Button>
                <Button onClick={() => setMode('check')}>Record a check</Button>
              </div>
            )}
            {item.status !== 'active' && item.status !== 'proposed' && mode === 'none' && (
              <div className="row">
                <Button onClick={() => setMode('check')}>Record a check</Button>
              </div>
            )}
            {mode === 'retire' && (
              <ReasonForm
                label="Why retire it?"
                action="Retire"
                busy={retire.isPending}
                onCancel={() => setMode('none')}
                onSubmit={(reason) => retire.mutate(reason, { onSuccess: () => (toast.success('Retired — agents stop using it'), setMode('none')), onError: (e) => toast.error((e as Error).message) })}
              />
            )}
            {mode === 'check' && (
              <RecordCheckForm
                busy={check.isPending}
                defaultUrl={snap?.url}
                defaultSnapshotId={snap?.snapshotId}
                onCancel={() => setMode('none')}
                onSubmit={(body) => check.mutate(body, { onSuccess: () => (toast.success('Check recorded'), setMode('none')), onError: (e) => toast.error((e as Error).message) })}
              />
            )}
            <ApiErrorNotice error={retire.error ?? check.error} what="change this item" />

            {d.conflicts.length > 0 && (
              <section>
                <h4 className="kn-h">Conflicts</h4>
                <ul className="kn-lines">
                  {d.conflicts.map((c) => (
                    <li key={c.id}>
                      <Badge tone={conflictTone(c)}>{CONFLICT_KIND_LABEL[c.kind]}</Badge> {c.detail} <span className="small muted">({c.status})</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h4 className="kn-h">Versions</h4>
              <ul className="kn-lines">
                {d.versions.map((v) => (
                  <li key={v.id}>
                    {v.id === item.id ? <strong>v{v.version}</strong> : onOpenItem ? (
                      <button type="button" className="kn-link" onClick={() => onOpenItem(v.id)}>
                        v{v.version}
                      </button>
                    ) : (
                      `v${v.version}`
                    )}{' '}
                    <Badge tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status]}</Badge> <span className="small muted">{v.title} · {whenText(v.createdAt)} by {actorText(v.createdBy)}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h4 className="kn-h">Checks</h4>
              {d.checks.length ? (
                <ul className="kn-lines">
                  {d.checks.map((c) => (
                    <li key={c.id}>
                      <strong>{humanise(c.result)}</strong> <span className="small muted">({humanise(c.method)}) by {actorText(c.checkedBy)} · {whenText(c.checkedAt)}</span>
                      {c.quote ? <div className="small">“{c.quote}” · quote {humanise(c.quoteMatch)}</div> : null}
                      {c.note ? <div className="small muted">{c.note}</div> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">Nobody has checked it yet.</p>
              )}
            </section>

            <section>
              <h4 className="kn-h">Used by agents</h4>
              {d.usage.length ? (
                <ul className="kn-lines">
                  {d.usage.slice(0, 20).map((u) => (
                    <li key={u.id} className="small">
                      {whenText(u.at)} · run {u.runId.slice(0, 8)} · rank {u.rank}
                      {u.cited ? ' · cited' : u.injected ? ' · shown to the agent' : ''}
                      {u.targetKind ? ` · in ${u.targetKind}` : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">Not used yet.</p>
              )}
            </section>

            <details>
              <summary className="small">History ({d.changes.length})</summary>
              <ul className="kn-lines">
                {d.changes.map((c) => (
                  <li key={c.id} className="small">
                    {whenText(c.at)} · {humanise(c.action.replace(/^knowledge\./, ''))} by {actorText(c.actor)}
                    {c.reason ? ` — ${c.reason}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </QueryGate>
    </Modal>
  );
}

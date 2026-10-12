// owned by claimai-web
/**
 * History (docs/CLAIM-AI-INPUT.md §14.2): every AI input on the claim, newest first, 20 a page — when, who, update or
 * catch-up, the excerpt (expand to the owner's full original words), status and what it did; Open shows its detail.
 */
import { useState } from 'react';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { HISTORY_PAGE_SIZE, useAiInput, useAiInputHistory, type AiInputSummary } from '../../../api/claimAiApi';
import { headlineOf, KIND_LABEL, STATUS_TONE, statusLabel, whenText } from './aiInputModel';

function FullText({ claimId, inputId }: { claimId: string; inputId: string }) {
  const q = useAiInput(claimId, inputId);
  if (q.isLoading) return <p className="small muted">Loading…</p>;
  if (q.error || !q.data) return <ApiErrorNotice error={q.error} what="load the full text" />;
  return (
    <div className="aiin-fulltext">
      {q.data.text && <blockquote className="aiin-owner-text">{q.data.text}</blockquote>}
      {q.data.extraText && (
        <>
          <div className="xs muted">Pasted note (facts only)</div>
          <blockquote className="aiin-owner-text">{q.data.extraText}</blockquote>
        </>
      )}
      {!q.data.text && !q.data.extraText && <p className="small muted">{q.data.catchUp ? `${q.data.catchUp.files.length} file(s)` : 'No text'}</p>}
    </div>
  );
}

function HistoryItem({ claimId, item, onOpen }: { claimId: string; item: AiInputSummary; onOpen: (i: AiInputSummary) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="aiin-history-item">
      <div className="aiin-history-head">
        <span className="small muted">{whenText(item.createdAt, 'datetime')}</span>
        <Badge tone={item.kind === 'catch_up' ? 'navy' : 'blue'}>{KIND_LABEL[item.kind]}</Badge>
        <Badge tone={STATUS_TONE[item.status] ?? 'grey'}>{statusLabel(item)}</Badge>
        <span className="xs muted">{item.createdByName ?? item.createdBy}</span>
      </div>
      <div className="aiin-history-excerpt">{item.excerpt || <span className="muted">{item.kind === 'catch_up' ? 'Documents' : 'No text'}</span>}</div>
      {headlineOf(item) && <div className="small">{headlineOf(item)}</div>}
      {expanded && <FullText claimId={claimId} inputId={item.id} />}
      <div className="row">
        <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Hide the full text' : 'Full text'}
        </Button>
        <Button size="sm" onClick={() => onOpen(item)}>
          Open
        </Button>
      </div>
    </li>
  );
}

export function HistoryCard({ claimId, onOpen }: { claimId: string; onOpen: (i: AiInputSummary) => void }) {
  const [offset, setOffset] = useState(0);
  const q = useAiInputHistory(claimId, offset);
  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const from = total ? offset + 1 : 0;
  const to = offset + items.length;
  return (
    <Card title="History" className="aiin-history" actions={total > 0 ? <span className="small muted">{`${from}–${to} of ${total}`}</span> : undefined}>
      <div className="stack-sm">
        <ApiErrorNotice error={q.error} what="load the history" />
        {q.isLoading && <p className="small muted">Loading…</p>}
        {!q.isLoading && items.length === 0 && !q.error && <p className="small muted">Nothing yet. Every update and catch-up on this claim is listed here with what it did.</p>}
        {items.length > 0 && (
          <ul className="aiin-history-list">
            {items.map((i) => (
              <HistoryItem key={i.id} claimId={claimId} item={i} onOpen={onOpen} />
            ))}
          </ul>
        )}
        {total > HISTORY_PAGE_SIZE && (
          <div className="row">
            <Button size="sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - HISTORY_PAGE_SIZE))}>
              Newer
            </Button>
            <Button size="sm" disabled={offset + HISTORY_PAGE_SIZE >= total} onClick={() => setOffset((o) => o + HISTORY_PAGE_SIZE)}>
              Older
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

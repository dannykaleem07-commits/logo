// owned by casework
import { Card } from '../../../components/Card';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { DateText } from '../../../components/DateText';
import { EmptyState } from '../../../components/EmptyState';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { brainApi, useBrainMutation, useMemory, type MemoryItem } from '../../../api/brainApi';

function MemoryRow({ item }: { item: MemoryItem }) {
  const approve = useBrainMutation(() => brainApi.approveMemory(item.id));
  const retire = useBrainMutation(() => brainApi.retireMemory(item.id));
  return (
    <li>
      <div className="list-main stack-sm">
        <div className="row">
          <Badge tone="blue">{item.kind}</Badge>
          <span className="small muted">{item.scope}</span>
        </div>
        <div className="small">{item.text}</div>
        <div className="list-sub">
          {item.createdBy.replace(/^agent:/, 'agent ')} · <DateText value={item.createdAt} time />
        </div>
        <ApiErrorNotice error={approve.error ?? retire.error} what="decide this memory item" />
      </div>
      <div className="row">
        <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => void approve.mutateAsync(undefined).catch(() => undefined)}>
          Approve
        </Button>
        <Button size="sm" variant="ghost" loading={retire.isPending} onClick={() => void retire.mutateAsync(undefined).catch(() => undefined)}>
          Retire
        </Button>
      </div>
    </li>
  );
}

/** Memory items awaiting approval (§E.6): only approved items ever reach the agents. */
export function MemoryCard() {
  const q = useMemory('proposed');
  const items = q.data?.items ?? [];
  return (
    <Card title={`Memory awaiting approval (${items.length})`} actions={q.data ? <span className="small muted">{q.data.counts.approved} approved</span> : undefined} flush>
      <ApiErrorNotice error={q.error} what="load memory" />
      {items.length ? (
        <ul className="list">
          {items.map((m) => (
            <MemoryRow key={m.id} item={m} />
          ))}
        </ul>
      ) : (
        <EmptyState title="Nothing to approve">Your edits to prepared items and the agents’ notes appear here as proposals.</EmptyState>
      )}
    </Card>
  );
}

// owned by casework
import { useState } from 'react';
import { Card } from '../../../../components/Card';
import { Badge } from '../../../../components/Badge';
import { Button } from '../../../../components/Button';
import { DateText } from '../../../../components/DateText';
import { EmptyState } from '../../../../components/EmptyState';
import { ApiErrorNotice } from '../../../../components/ApiErrorNotice';
import { DateTimeInput } from '../../../../components/Form';
import { caseworkApi, useCaseworkMutation, type ClaimTask } from '../../../../api/caseworkApi';

function TaskRow({ claimId, task }: { claimId: string; task: ClaimTask }) {
  const [editing, setEditing] = useState(false);
  const [dueAt, setDueAt] = useState(task.dueAt);
  const complete = useCaseworkMutation(claimId, () => caseworkApi.completeTask(task.id));
  const reschedule = useCaseworkMutation(claimId, (d: string) => caseworkApi.rescheduleTask(task.id, d));
  const overdue = task.dueAt < new Date().toISOString();
  return (
    <li>
      <div className="list-main stack-sm">
        <div className="row">
          <span className="list-title">{task.title}</span>
          <Badge tone={overdue ? 'red' : 'grey'}>{task.kind.replace(/_/g, ' ')}</Badge>
          {task.actionCode && <Badge tone="blue">{task.actionCode}</Badge>}
        </div>
        <div className="list-sub">
          Due <DateText value={task.dueAt} time /> · by {task.createdBy.replace(/^agent:/, 'agent ')}
          {task.note && task.note !== task.title ? ` · ${task.note}` : ''}
        </div>
        {editing && (
          <div className="row">
            <DateTimeInput label="New due date" value={dueAt} onChange={setDueAt} />
            <Button size="sm" variant="primary" disabled={!dueAt} loading={reschedule.isPending} onClick={() => void reschedule.mutateAsync(dueAt).then(() => setEditing(false)).catch(() => undefined)}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        )}
        <ApiErrorNotice error={complete.error ?? reschedule.error} what="update the task" />
      </div>
      <div className="row">
        <Button size="sm" loading={complete.isPending} onClick={() => void complete.mutateAsync(undefined).catch(() => undefined)}>
          Done
        </Button>
        {!editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Reschedule
          </Button>
        )}
      </div>
    </li>
  );
}

/** Open tasks and follow-ups (complete, reschedule). */
export function TasksCard({ claimId, tasks }: { claimId: string; tasks: ClaimTask[] }) {
  return (
    <Card title={`Tasks and follow-ups (${tasks.length})`} flush>
      {tasks.length ? (
        <ul className="list">
          {tasks.map((t) => (
            <TaskRow key={t.id} claimId={claimId} task={t} />
          ))}
        </ul>
      ) : (
        <EmptyState title="No open tasks">Follow-ups the case manager schedules appear here; when one falls due the claim is reviewed again.</EmptyState>
      )}
    </Card>
  );
}

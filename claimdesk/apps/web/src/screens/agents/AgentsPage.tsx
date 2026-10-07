// owned by runtime
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';

/** Agents (docs/SUPREME-DESIGN.md §L). Stub created by foundation; the runtime slice builds the screen. */
export function AgentsPage() {
  return (
    <div className="page">
      <PageHeader title="Agents" subtitle="What the agents are doing, their runs and schedules" />
      <Card>
        <EmptyState title="Coming in 0.4">Agents arrives with ClaimDesk Supreme.</EmptyState>
      </Card>
    </div>
  );
}

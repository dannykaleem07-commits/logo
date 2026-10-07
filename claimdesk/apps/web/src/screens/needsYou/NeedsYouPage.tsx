// owned by runtime
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';

/** Needs you (docs/SUPREME-DESIGN.md §L). Stub created by foundation; the runtime slice builds the screen. */
export function NeedsYouPage() {
  return (
    <div className="page">
      <PageHeader title="Needs you" subtitle="Decisions and confirmations waiting for you" />
      <Card>
        <EmptyState title="Coming in 0.4">Needs you arrives with ClaimDesk Supreme.</EmptyState>
      </Card>
    </div>
  );
}

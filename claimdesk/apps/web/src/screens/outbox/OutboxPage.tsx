// owned by mail
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';

/** Outbox (docs/SUPREME-DESIGN.md §L). Stub created by foundation; the mail slice builds the screen. */
export function OutboxPage() {
  return (
    <div className="page">
      <PageHeader title="Outbox" subtitle="Emails held, waiting for approval and sent" />
      <Card>
        <EmptyState title="Coming in 0.4">Outbox arrives with ClaimDesk Supreme.</EmptyState>
      </Card>
    </div>
  );
}
